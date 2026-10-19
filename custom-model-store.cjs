/* custom-model-store.cjs — 用户自定义 / 端点探测到的模型 ID
 *
 * 目的：设置页的"配置页明明比较自由，选项却只有 DeepSeek"缺口。
 *   · 官方白名单仍是官方白名单（model-registry.js 唯一来源，不篡改其语义）；
 *   · 本 store 只存"用户自己确认 / 从用户配置的 baseUrl 探测到"的 ID，给注册表的
 *     selectableModels(opts)/isSelectable(id,opts) 当输入，从而支持第三方服务商。
 *
 * 边界（硬）：
 *   · **绝不保存密钥**（apiKey 永不入本文件；探测时由调用方从 llmApiPref 现取）；
 *   · 纯 I/O、零网络；读写失败不抛错，最坏退化为"只有官方白名单"；
 *   · 原子写入 + 尺寸上限 + 字段白名单（损坏/超限一律退化为空，不静默半边可用）；
 *   · 按 baseUrl 分组，切换服务商不影响另一家的记录。
 */
'use strict'

const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 1
const MAX_ENDPOINTS = 12
const MAX_IDS_PER_ENDPOINT = 200
const MAX_CONFIRMED = 40
const MAX_SELECTED = 20
const MAX_ID_LEN = 256
const MAX_BYTES = 512 * 1024
const PURPOSES = ['character', 'diary', 'expression', 'vision', 'work']

function isValidId(id) {
  const s = typeof id === 'string' ? id.trim() : ''
  if (!s || s.length > MAX_ID_LEN) return false
  if (/[\s\x00-\x1f\x7f]/.test(s)) return false
  return true
}

function uniq(ids, max) {
  const out = []
  for (const x of (Array.isArray(ids) ? ids : [])) {
    const s = typeof x === 'string' ? x.trim() : ''
    if (!isValidId(s)) continue
    if (out.indexOf(s) >= 0) continue
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

function defaultState() {
  return { schemaVersion: SCHEMA_VERSION, endpoints: {}, confirmed: [], selected: {}, updatedAt: 0 }
}

function createCustomModelStore(options) {
  const o = options || {}
  const file = o.file
  if (!file || typeof file !== 'string') throw new Error('custom-model-store: file required')
  let cache = null

  function normalize(raw) {
    const s = defaultState()
    const j = raw && typeof raw === 'object' ? raw : {}
    try {
      const eps = j.endpoints && typeof j.endpoints === 'object' ? j.endpoints : {}
      for (const key of Object.keys(eps)) {
        if (Object.keys(s.endpoints).length >= MAX_ENDPOINTS) break
        const base = String(key == null ? '' : key).trim().slice(0, 200)
        if (!base) continue
        const e = eps[key] && typeof eps[key] === 'object' ? eps[key] : {}
        const listed = uniq(e.listed, MAX_IDS_PER_ENDPOINT)
        s.endpoints[base] = {
          listed,
          okAt: Number(e.okAt) || 0,
          error: typeof e.error === 'string' ? e.error.slice(0, 40) : null,
        }
      }
      s.confirmed = uniq(j.confirmed, MAX_CONFIRMED)
      const sel = j.selected && typeof j.selected === 'object' ? j.selected : {}
      for (const p of PURPOSES) {
        const v = typeof sel[p] === 'string' ? sel[p].trim() : ''
        if (isValidId(v)) s.selected[p] = v
      }
      s.updatedAt = Number(j.updatedAt) || 0
    } catch (err) { return defaultState() }
    return s
  }

  function load() {
    if (cache) return cache
    try {
      const st = fs.statSync(file)
      if (st.size > MAX_BYTES) { cache = defaultState(); return cache }
      cache = normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (err) { cache = defaultState() }
    return cache
  }

  function save(state) {
    const next = normalize(state)
    next.schemaVersion = SCHEMA_VERSION
    next.updatedAt = Date.now()
    const text = JSON.stringify(next, null, 2)
    if (text.length > MAX_BYTES) return { ok: false, error: 'too_large' }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
      cache = next
      return { ok: true }
    } catch (err) { return { ok: false, error: String((err && err.code) || 'write_failed') } }
  }

  /* 视图：给注册表当 opts 用（纯数据，不含密钥） */
  function view(baseUrl) {
    const s = load()
    const base = String(baseUrl == null ? '' : baseUrl).trim()
    const ep = (base && s.endpoints[base]) || null
    return {
      endpoints: Object.keys(s.endpoints),
      endpointModels: ep ? ep.listed.slice() : [],
      endpointOkAt: ep ? ep.okAt : 0,
      endpointError: ep ? ep.error : null,
      confirmed: s.confirmed.slice(),
      selected: Object.assign({}, s.selected),
    }
  }

  function setEndpointList(baseUrl, listed, error) {
    const s = JSON.parse(JSON.stringify(load()))
    const base = String(baseUrl == null ? '' : baseUrl).trim()
    if (!base) return { ok: false, error: 'no_base_url' }
    const ids = uniq(listed, MAX_IDS_PER_ENDPOINT)
    const ok = !error && ids.length > 0
    if (!ok && ids.length === 0 && !error) return { ok: false, error: 'empty_list' }
    s.endpoints[base] = { listed: ids, okAt: ok ? Date.now() : 0, error: error ? String(error).slice(0, 40) : null }
    /* 端点数量上限：超了丢最旧的（按 okAt） */
    const keys = Object.keys(s.endpoints)
    if (keys.length > MAX_ENDPOINTS) {
      keys.sort((a, b) => (s.endpoints[a].okAt || 0) - (s.endpoints[b].okAt || 0))
      for (const k of keys.slice(0, keys.length - MAX_ENDPOINTS)) delete s.endpoints[k]
    }
    const r = save(s)
    return r.ok ? { ok: true, count: ids.length } : r
  }

  function confirm(id) {
    const v = typeof id === 'string' ? id.trim() : ''
    if (!isValidId(v)) return { ok: false, error: 'invalid_id' }
    const s = JSON.parse(JSON.stringify(load()))
    if (s.confirmed.indexOf(v) < 0) {
      s.confirmed.push(v)
      if (s.confirmed.length > MAX_CONFIRMED) s.confirmed = s.confirmed.slice(-MAX_CONFIRMED)
    }
    const r = save(s)
    return r.ok ? { ok: true, confirmed: s.confirmed.slice() } : r
  }

  function setSelected(purpose, id) {
    const p = PURPOSES.indexOf(purpose) >= 0 ? purpose : ''
    if (!p) return { ok: false, error: 'bad_purpose' }
    const v = typeof id === 'string' ? id.trim() : ''
    const s = JSON.parse(JSON.stringify(load()))
    if (!v) delete s.selected[p]
    else if (isValidId(v)) s.selected[p] = v
    else return { ok: false, error: 'invalid_id' }
    if (Object.keys(s.selected).length > MAX_SELECTED) return { ok: false, error: 'too_many_selected' }
    const r = save(s)
    return r.ok ? { ok: true } : r
  }

  return { load, save, view, setEndpointList, confirm, setSelected, file: file, _normalize: normalize, _defaultState: defaultState }
}

module.exports = { createCustomModelStore, isValidId, SCHEMA_VERSION, MAX_ENDPOINTS, MAX_IDS_PER_ENDPOINT }
