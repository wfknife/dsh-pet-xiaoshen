'use strict'
/**
 * K5 能力注册表与授权。
 *
 * 关键：**manifest 只是描述，不是授权**（总规 §17.1）。
 *  - 授权来自宿主掌握的主人许可（scopes）与本轮上下文，插件/模型不能自报；
 *  - 输入输出校验集中在本文件，不在每个 adapter 里各写一份；
 *  - 失败熔断按能力统计（3 次失败 / 10 分钟 → 冷却 5 分钟）。
 *
 * 偏差（记录在 DECISIONS.md）：本仓库没有可用的 JSON Schema 库且本轮禁止安装依赖，
 * 因此这里实现 JSON Schema 的**受限子集**（type/properties/required/additionalProperties/
 * minLength/maxLength/minimum/maximum），未支持的关键字会被显式忽略并在 validate 结果里列出。
 */

const { validateCapabilityManifest } = require('../contracts.cjs')

const SUPPORTED_SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'items', 'minItems', 'maxItems'])

function validateAgainstSchema (schema, value, path = '$') {
  const errors = []
  const ignored = []
  if (!schema || typeof schema !== 'object') return { errors: ['schema_missing'], ignored }
  for (const key of Object.keys(schema)) if (!SUPPORTED_SCHEMA_KEYS.has(key)) ignored.push(path + '.' + key)

  if (schema.type) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    const expected = ['number','integer'].includes(schema.type) ? ['number'] : [schema.type]
    if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(path + ':expected_integer')
    else if (!expected.includes(actual)) errors.push(path + ':expected_' + schema.type + '_got_' + actual)
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(path + ':not_in_enum')
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(path + ':too_short')
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(path + ':too_long')
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(path + ':not_finite')
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(path + ':below_minimum')
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(path + ':above_maximum')
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (value[key] === undefined) errors.push(path + '.' + key + ':required')
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (value[key] === undefined) continue
      const nested = validateAgainstSchema(childSchema, value[key], path + '.' + key)
      errors.push(...nested.errors)
      ignored.push(...nested.ignored)
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(path + '.' + key + ':unexpected')
    }
  }
  if (Array.isArray(value) && schema.items) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(path + ':too_few_items')
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(path + ':too_many_items')
    value.forEach((item, index) => {
      const nested = validateAgainstSchema(schema.items, item, path + '[' + index + ']')
      errors.push(...nested.errors)
      ignored.push(...nested.ignored)
    })
  }
  return { errors, ignored }
}

/**
 * @param {{config: object, now?: Function}} deps
 */
function createRegistry (deps) {
  const config = deps.config
  const clock = typeof deps.now === 'function' ? deps.now : Date.now
  const manifests = new Map()
  const outcomes = new Map()
  const disabled = new Set()

  const key = (id, version) => id + '@' + version

  function register (manifest) {
    const validation = validateCapabilityManifest(manifest)
    if (!validation.ok) return { ok: false, code: 'manifest_invalid', detail: validation.detail }
    const existing = manifests.get(key(manifest.id, manifest.version))
    if (existing && existing.packageHash !== manifest.packageHash) {
      // 同版本不同内容 → 拒绝，避免“版本号不变但行为换了”导致在途操作错乱。
      return { ok: false, code: 'manifest_conflict', detail: { id: manifest.id, version: manifest.version } }
    }
    manifests.set(key(manifest.id, manifest.version), manifest)
    disabled.delete(key(manifest.id, manifest.version))
    return { ok: true, manifest }
  }

  function registerAll (list) {
    const results = []
    for (const item of list || []) results.push({ id: item && item.id, ...register(item) })
    return results
  }

  function get (id, version) {
    if (version !== undefined && version !== null) return manifests.get(key(id, version)) || null
    // 未指定版本时取最高版本，但调用方必须在 operation 里固定具体版本。
    let best = null
    for (const item of manifests.values()) if (item.id === id && !disabled.has(key(item.id, item.version)) && (!best || item.version > best.version)) best = item
    return best
  }

  function list () {
    return Array.from(manifests.values())
  }

  /** 只有宿主给定的 scopes 才有效；external-* 还需显式的 allowExternal。 */
  function authorize (id, options = {}) {
    const manifest = get(id, options.version)
    if (!manifest) return { ok: false, code: 'capability_missing' }
    if (disabled.has(key(manifest.id, manifest.version))) return { ok: false, code: 'capability_draining' }
    const granted = options.grantedScopes instanceof Set ? options.grantedScopes : new Set(options.grantedScopes || [])
    const missing = manifest.scopes.filter(scope => !granted.has(scope))
    if (missing.length) return { ok: false, code: 'not_authorized', detail: { missingScopes: missing } }
    if (manifest.effect.startsWith('external-') && options.allowExternal !== true) {
      return { ok: false, code: 'external_not_allowed', detail: { capabilityId: manifest.id } }
    }
    if (isCircuitOpen(manifest.id, options.now || clock())) {
      return { ok: false, code: 'circuit_open', detail: { capabilityId: manifest.id } }
    }
    return { ok: true, manifest }
  }

  function validateInput (manifest, input) {
    const size = Buffer.byteLength(JSON.stringify(input === undefined ? null : input), 'utf8')
    if (size > manifest.maxInputBytes) return { ok: false, code: 'input_too_large', size }
    const result = validateAgainstSchema(manifest.inputSchema, input)
    if (result.errors.length) return { ok: false, code: 'input_schema_invalid', detail: result.errors.slice(0, 10) }
    return { ok: true, ignoredKeywords: result.ignored }
  }

  function validateOutput (manifest, output) {
    const size = Buffer.byteLength(JSON.stringify(output === undefined ? null : output), 'utf8')
    if (size > manifest.maxOutputBytes) return { ok: false, code: 'output_too_large', size }
    const result = validateAgainstSchema(manifest.outputSchema, output)
    if (result.errors.length) return { ok: false, code: 'output_schema_invalid', detail: result.errors.slice(0, 10) }
    return { ok: true }
  }

  function recordOutcome (id, ok, now) {
    const at = Number(now) || clock()
    const entry = outcomes.get(id) || { failures: [], lastSuccessAt: null, openedUntil: null }
    if (ok) {
      entry.failures = []
      entry.lastSuccessAt = at
      entry.openedUntil = null
    } else {
      entry.failures.push(at)
      const window = config.capability.circuitWindowMs
      entry.failures = entry.failures.filter(ts => at - ts <= window)
      if (entry.failures.length >= config.capability.circuitFailureThreshold) {
        entry.openedUntil = at + config.capability.circuitCooldownMs
      }
    }
    outcomes.set(id, entry)
    return entry
  }

  function isCircuitOpen (id, now) {
    const entry = outcomes.get(id)
    if (!entry || !entry.openedUntil) return false
    if (now >= entry.openedUntil) {
      entry.openedUntil = null
      entry.failures = []
      return false
    }
    return true
  }

  function health () {
    return list().map(item => ({
      id: item.id,
      version: item.version,
      effect: item.effect,
      circuit: outcomes.get(item.id) || null,
    }))
  }

  const disable = (id, version) => { for (const manifest of list()) if (manifest.id === id && (version == null || manifest.version === version)) disabled.add(key(id, manifest.version)) }
  return { register, registerAll, get, list, authorize, disable, validateInput, validateOutput, recordOutcome, isCircuitOpen, health }
}

module.exports = { createRegistry, validateAgainstSchema, SUPPORTED_SCHEMA_KEYS }
