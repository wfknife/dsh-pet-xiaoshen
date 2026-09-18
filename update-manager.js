'use strict'
/*
 * DeskPet Update & Compatibility Manager — P0-A（只读可见性 + 模型状态基础）
 *
 * 职责（全部只读 / 不阻塞 / 不抛异常）：
 *   1) DeepSeek /models 只读探测：timeout + 缓存 + 频率限制；key 永不进日志
 *   2) update-state.json：原子写入、失败不阻塞、可恢复、绝不保存凭据
 *   3) recordModelUse()：只记录 model 与结果分类（不记录 prompt/content）
 *   4) DSH 运行时信息：版本优先读 runtime package.json（不 spawn、不安装、不重启）
 *
 * 依赖全部可注入（fs/path/now/fetch/readKey/log），便于隔离测试；
 * 构造与 require 阶段**不发起任何网络或写盘动作**（不阻塞桌宠启动）。
 */
const ModelRegistry = require('./model-registry.js')
const ModelCandidate = require('./model-candidate.js')
const ModelValidator = require('./model-validator.js')
const ModelValidatorReal = require('./model-validator-real.js')
const VersionCompare = require('./build/version-compare.js')

const DEFAULT_MODELS_URL = 'https://api.deepseek.com/models'
/* B2：DSH 版本发现源**固定**为 npm registry 上的 @deepseek-ai/dsh
   （与 dshInstallInto 的安装源一致）。只读 GET，不安装、不查询其它第三方渠道。
   使用 npm 的"精简 packument"媒体类型，避免拉取 readme 等大字段。 */
const DEFAULTS = {
  modelsUrl: DEFAULT_MODELS_URL,
  timeoutMs: 6000,
  cacheTtlMs: 6 * 60 * 60 * 1000,
  minIntervalMs: 60 * 1000,
  saveDebounceMs: 800,
  maxUseRecords: 20,
  maxCountKeys: 40,
  maxListedIds: 200,
  maxAudit: 50,
  maxConflicts: 10,
  maxDiscovered: 100,
  maxLifecycle: 64,
  maxValidations: 32,
  maxCandidatesPerPurpose: 16,
  validationMinIntervalMs: 60 * 1000,
  validationModelMinIntervalMs: 10 * 1000,
  validationWindowMs: 5 * 60 * 1000,
  validationWindowMax: 10,
  maxValidationRatePairs: 64,
  /* P1-B：real tier 专用（成本远高于 mock，独立参数） */
  realPairIntervalMs: 30 * 60 * 1000,
  realModelIntervalMs: 10 * 60 * 1000,
  realHourWindowMs: 60 * 60 * 1000,
  realHourMax: 5,
  realDayMax: 20,
  realCooldownMs: 10 * 60 * 1000,
  realAuthCooldownMs: 60 * 60 * 1000,
  maxRealNonces: 32,
  maxRealCooldowns: 64,
}

function classifyHttp(status) {
  const s = Number(status)
  if (s === 401 || s === 403) return 'auth'
  if (s === 429) return 'rate_limited_remote'
  return 'http_' + s
}
function toNum(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : dflt
}
/* epoch ms 专用：null/'' 保持 null（Number(null)===0 会把"没有计划"误判为 1970） */
function toMsOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}


/* B3：纯计算——官方目录里出现、但本地元数据未收录的模型（discovered）。
   一律 verified=false、recommended=null、migration=null、actionRequired='none'：
   发现 ≠ 兼容 ≠ 推荐 ≠ 自动切换。firstSeenAt 跨探测保留，lastSeenAt 每次刷新。 */
function deriveDiscoveredModels(input) {
  const i = input || {}
  const listed = Array.isArray(i.listed) ? i.listed.filter((x) => typeof x === 'string') : []
  const isKnown = typeof i.isKnown === 'function' ? i.isKnown : () => false
  const prev = Array.isArray(i.prev) ? i.prev : []
  const at = Number.isFinite(Number(i.at)) ? Number(i.at) : 0
  const n = Number(i.max)
  const max = Number.isFinite(n) && n > 0 ? Math.floor(n) : 100
  const prevById = new Map()
  for (const p of prev) if (p && typeof p.id === 'string') prevById.set(p.id, p)
  const out = []
  for (const rawId of listed) {
    const id = String(rawId).slice(0, 64)
    if (isKnown(id)) continue
    const p = prevById.get(id)
    const first = Number(p && p.firstSeenAt)
    out.push({
      id,
      known: false,
      lifecycle: 'unknown',
      state: 'listed-unverified',
      verified: false,
      trusted: false,
      listed: true,
      listedButUnverified: true,
      recommended: null,
      migration: null,
      actionRequired: 'none',
      firstSeenAt: Number.isFinite(first) && first > 0 ? first : at,
      lastSeenAt: at,
    })
    if (out.length >= max) break
  }
  return out
}

/* B3：纯计算——API 目录 × 本地元数据 的**显式冲突**（不含任何 I/O、不产生动作）。
   kind: catalog-empty | catalog-missing | retired-still-listed | route-after-passed
         | declared-unknown | declared-alias | declared-routed
   仅在"确实有过成功探测"（listedAt > 0）时才做目录对账；网络/鉴权失败不得产生
   "所有模型都消失"的假冲突（由调用方保证不重算）。 */
function computeModelConflicts(input) {
  const i = input || {}
  const listed = Array.isArray(i.listed) ? i.listed.filter((x) => typeof x === 'string') : []
  const lifecycle = i.lifecycle && typeof i.lifecycle === 'object' ? i.lifecycle : {}
  const declaredMap = i.declared && typeof i.declared === 'object' ? i.declared : {}
  const at = Number.isFinite(Number(i.at)) ? Number(i.at) : 0
  const n = Number(i.max)
  const max = Number.isFinite(n) && n > 0 ? Math.floor(n) : 10
  const hasListing = Number(i.listedAt) > 0
  const out = []
  const ids = Object.keys(lifecycle)
  if (hasListing) {
    if (!listed.length) {
      out.push({ kind: 'catalog-empty', id: null, detail: '官方目录为空（探测成功但 0 个 ID），需人工确认', at })
    } else {
      for (const id of ids) {
        const st = lifecycle[id] || {}
        if (st.known !== true) continue
        if (st.listed === false) {
          out.push({ kind: 'catalog-missing', id, detail: id + ' 未出现在官方目录（本地 lifecycle=' + (st.lifecycle || 'unknown') + '）', at })
        }
        if (st.lifecycle === 'retired' && st.listed === true) {
          out.push({ kind: 'retired-still-listed', id, detail: id + ' 本地标记 retired，但官方目录仍列出（元数据与 API 冲突）', at })
        }
      }
    }
    for (const id of ids) {
      const st = lifecycle[id] || {}
      if (st.routeState === 'passed') {
        out.push({ kind: 'route-after-passed', id, detail: id + ' 的 routeAfter 已过（' + (st.routeAfter || '-') + '），本地元数据需刷新', at })
      }
    }
  }
  for (const purpose of Object.keys(declaredMap)) {
    const id = typeof declaredMap[purpose] === 'string' ? declaredMap[purpose] : null
    if (!id) continue
    const st = lifecycle[id]
    if (!st) continue
    if (st.known !== true) {
      out.push({ kind: 'declared-unknown', id, detail: purpose + ' 声明的模型无本地元数据（不自动切换）', at })
    } else if (st.lifecycle === 'alias') {
      out.push({ kind: 'declared-alias', id, detail: purpose + ' 正在使用兼容别名 ' + id + '（实际路由到 ' + (st.recommended || '新模型') + '）', at })
    } else if (st.lifecycle === 'routed') {
      out.push({ kind: 'declared-routed', id, detail: purpose + ' 使用的模型有官方路由计划（' + (st.routeAfter || '-') + '）', at })
    }
  }
  const seen = new Set()
  const uniq = []
  for (const c of out) {
    const k = c.kind + '|' + (c.id || '')
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(c)
  }
  return uniq.slice(-max)
}

/* B3：纯计算——路由计划聚合（绝对时间）。
   优先"声明模型"里最早的路由计划；声明模型都没有计划时，退化为全部已知模型里最早的。
   routeState 由 ModelRegistry.routeStateFor（Date.parse → epoch ms 比较）得到。 */
function aggregateModelRoute(input) {
  const i = input || {}
  const entries = Array.isArray(i.entries) ? i.entries : []
  const declaredIds = Array.isArray(i.declaredIds) ? i.declaredIds : []
  const n = Number(i.nowMs)
  const nowMs = Number.isFinite(n) ? n : Date.now()
  const hasPlan = (e) => e && e.routeDue !== null && e.routeDue !== undefined && Number.isFinite(Number(e.routeDue))
  const pick = (arr) => arr.filter(hasPlan).sort((a, b) => Number(a.routeDue) - Number(b.routeDue))[0] || null
  const chosen = pick(entries.filter((e) => e && declaredIds.indexOf(e.id) >= 0)) || pick(entries)
  if (!chosen) return { routeId: null, routeDue: null, routeState: null }
  const r = ModelRegistry.routeStateFor(chosen.routeAfter, nowMs)
  return { routeId: chosen.id, routeDue: r.routeDue, routeState: r.routeState }
}

function maxActionLevel(list) {
  const arr = Array.isArray(list) ? list : []
  if (arr.indexOf('required') >= 0) return 'required'
  if (arr.indexOf('recommended') >= 0) return 'recommended'
  return 'none'
}

function createUpdateManager(options) {
  const o = options || {}
  const fs = o.fs || require('fs')
  const pathMod = o.path || require('path')
  const now = typeof o.now === 'function' ? o.now : () => Date.now()
  const fetchImpl = o.fetch || (typeof fetch === 'function' ? fetch : null)
  const log = typeof o.log === 'function' ? o.log : () => {}
  const readKey = typeof o.readKey === 'function' ? o.readKey : () => ''
  const compatInfo = typeof o.compatInfo === 'function' ? o.compatInfo : () => null
  /* P1-A.1：运行时自证（edition / dataDir / userDataSource）——由 main.js 注入，只读回显 */
  const runtimeInfoFn = typeof o.runtimeInfo === 'function' ? o.runtimeInfo : () => null
  const stateFile = o.stateFile || null
  const modelsUrl = o.modelsUrl || DEFAULTS.modelsUrl
  const timeoutMs = toNum(o.timeoutMs, DEFAULTS.timeoutMs) || DEFAULTS.timeoutMs
  const cacheTtlMs = toNum(o.cacheTtlMs, DEFAULTS.cacheTtlMs)
  const minIntervalMs = toNum(o.minIntervalMs, DEFAULTS.minIntervalMs)
  const maxAudit = toNum(o.maxAudit, DEFAULTS.maxAudit)
  const maxConflicts = toNum(o.maxConflicts, DEFAULTS.maxConflicts)
  const saveDebounceMs = toNum(o.saveDebounceMs, DEFAULTS.saveDebounceMs)
  const maxUseRecords = toNum(o.maxUseRecords, DEFAULTS.maxUseRecords)
  const maxCountKeys = toNum(o.maxCountKeys, DEFAULTS.maxCountKeys)
  const maxDiscovered = toNum(o.maxDiscovered, DEFAULTS.maxDiscovered)
  const maxLifecycle = toNum(o.maxLifecycle, DEFAULTS.maxLifecycle)
  const maxValidations = toNum(o.maxValidations, DEFAULTS.maxValidations)
  const maxCandidatesPerPurpose = toNum(o.maxCandidatesPerPurpose, DEFAULTS.maxCandidatesPerPurpose)
  const validationMinIntervalMs = toNum(o.validationMinIntervalMs, DEFAULTS.validationMinIntervalMs)
  const validationModelMinIntervalMs = toNum(o.validationModelMinIntervalMs, DEFAULTS.validationModelMinIntervalMs)
  const validationWindowMs = toNum(o.validationWindowMs, DEFAULTS.validationWindowMs)
  const validationWindowMax = toNum(o.validationWindowMax, DEFAULTS.validationWindowMax)
  const maxValidationRatePairs = toNum(o.maxValidationRatePairs, DEFAULTS.maxValidationRatePairs)
  const realPairIntervalMs = toNum(o.realPairIntervalMs, DEFAULTS.realPairIntervalMs)
  const realModelIntervalMs = toNum(o.realModelIntervalMs, DEFAULTS.realModelIntervalMs)
  const realHourWindowMs = toNum(o.realHourWindowMs, DEFAULTS.realHourWindowMs)
  const realHourMax = toNum(o.realHourMax, DEFAULTS.realHourMax)
  const realDayMax = toNum(o.realDayMax, DEFAULTS.realDayMax)
  const realCooldownMs = toNum(o.realCooldownMs, DEFAULTS.realCooldownMs)
  const realAuthCooldownMs = toNum(o.realAuthCooldownMs, DEFAULTS.realAuthCooldownMs)
  const maxRealNonces = toNum(o.maxRealNonces, DEFAULTS.maxRealNonces)
  const maxRealCooldowns = toNum(o.maxRealCooldowns, DEFAULTS.maxRealCooldowns)
  /* P1-B 注入点（组合根 = main.js；manager 自身不接触 key / 不发请求） */
  const productionTierEnabled = typeof o.productionTierEnabled === 'function' ? o.productionTierEnabled : null
  const realRunner = typeof o.realRunner === 'function' ? o.realRunner : null
  const envProvider = typeof o.envProvider === 'function' ? o.envProvider : null

  let state = null
  let lastAttemptAt = 0
  /* P1-A：验证写路径的限流/单飞（纯内存、有界、不落盘） */
  const validationRatePairs = new Map()
  const validationRateModels = new Map()
  const validationWindow = []
  const validationInFlight = new Set()
  let saveTimer = null
  let saves = 0
  let saveFailures = 0

  /* B1：state v2（增量）。v1 的 probe/usage/dsh 原样保留语义；
     新增 channels.dsh（版本发现）与有界 audit。 */
  function defaultState() {
    return {
      schemaVersion: 2,
      updatedAt: 0,
      probe: { attemptedAt: 0, fetchedAt: 0, ok: false, error: null, listed: [], url: modelsUrl },
      usage: { last: [], counts: {} },
      models: defaultModels(),
      audit: [],
    }
  }

  /* B3：state v2 的 models 段（增量）。declared 永远以 registry 为准（state 只是快照），
     listed/discovered/lifecycle/conflicts 为最近一次**成功**对账的结果，均已白名单化 + 有界。
     B4：只新增 `validations`（**持久事实**：验证证据记录）；推荐/迁移资格等派生值**不落盘**。 */
  function defaultModels() {
    return {
      declared: ModelRegistry.declared(),
      listed: [],
      listedAt: 0,
      discovered: [],
      conflicts: [],
      lifecycle: {},
      validations: {},
      realRuns: { usedNonces: [], usage: {}, cooldowns: {}, lastPairAt: {}, lastModelAt: {}, providerRevisionHash8: null },
      routeId: null,
      routeDue: null,
      routeState: null,
      actionRequired: 'none',
      checkedAt: 0,
      lastError: null,
    }
  }

  function sanitizeConflict(c) {
    if (!c || typeof c !== 'object') return null
    const out = {
      kind: typeof c.kind === 'string' ? c.kind.slice(0, 48) : 'unknown',
      detail: typeof c.detail === 'string' ? c.detail.slice(0, 120) : '',
    }
    if (typeof c.id === 'string' && c.id) out.id = c.id.slice(0, 64)
    if (Number.isFinite(Number(c.at))) out.at = Number(c.at)
    return out
  }
  function sanitizeEvidence(e) {
    if (!e || typeof e !== 'object') return null
    return {
      kind: typeof e.kind === 'string' ? e.kind.slice(0, 48) : 'unknown',
      detail: typeof e.detail === 'string' ? e.detail.slice(0, 160) : '',
      at: toNum(e.at, 0),
    }
  }

  /* P1-C：dshUpdate 段白名单（路径只作为字符串保存；不解释、不执行） */

  /* B3：models 段的只读白名单（凭据/内容不可能进 state，也读不回） */
  function sanitizeMigration(mig) {
    if (!mig || typeof mig !== 'object') return null
    return {
      from: typeof mig.from === 'string' ? mig.from.slice(0, 64) : null,
      to: typeof mig.to === 'string' ? mig.to.slice(0, 64) : null,
      mode: mig.mode === 'required' ? 'required' : 'recommended',
      autoApply: false,
      requiresUserAction: true,
    }
  }
  function sanitizeDiscoveredModel(d) {
    if (!d || typeof d !== 'object') return null
    const id = typeof d.id === 'string' ? d.id.slice(0, 64) : ''
    if (!id) return null
    return {
      id,
      known: false,
      lifecycle: 'unknown',
      state: d.state === 'listed-unverified' ? 'listed-unverified' : 'unknown',
      verified: false,
      trusted: false,
      listed: true,
      listedButUnverified: true,
      recommended: null,
      migration: null,
      actionRequired: 'none',
      firstSeenAt: toNum(d.firstSeenAt, 0),
      lastSeenAt: toNum(d.lastSeenAt, 0),
    }
  }
  function sanitizeLifecycleEntry(e) {
    if (!e || typeof e !== 'object') return null
    const id = typeof e.id === 'string' ? e.id.slice(0, 64) : ''
    if (!id) return null
    return {
      id,
      known: e.known === true,
      lifecycle: typeof e.lifecycle === 'string' ? e.lifecycle.slice(0, 16) : 'unknown',
      state: typeof e.state === 'string' ? e.state.slice(0, 24) : 'unknown',
      verified: e.verified === true,
      trusted: e.trusted === true,
      listed: e.listed === null || e.listed === undefined ? null : e.listed === true,
      listedButUnverified: e.listedButUnverified === true,
      recommended: typeof e.recommended === 'string' ? e.recommended.slice(0, 64) : null,
      migration: sanitizeMigration(e.migration),
      routeAfter: typeof e.routeAfter === 'string' ? e.routeAfter.slice(0, 40) : null,
      routeDue: toMsOrNull(e.routeDue),
      routeState: ['scheduled', 'due', 'passed', 'invalid'].indexOf(e.routeState) >= 0 ? e.routeState : null,
      source: typeof e.source === 'string' ? e.source.slice(0, 80) : null,
      actionRequired: ['none', 'recommended', 'required'].indexOf(e.actionRequired) >= 0 ? e.actionRequired : 'none',
    }
  }
  /* B4：验证证据（持久事实）的白名单准入。
     结构不合法/伪装 passed 的记录一律降级（wellFormed=false ⇒ malformed ⇒ 绝不计入 validated），
     且只保留 ModelCandidate 的规范化字段。 */
  function sanitizeValidations(raw) {
    const out = {}
    if (!raw || typeof raw !== 'object') return out
    let models = 0
    for (const rawId of Object.keys(raw).slice(0, maxValidations)) {
      const modelId = typeof rawId === 'string' ? rawId.slice(0, 64) : ''
      if (!modelId) continue
      const per = raw[rawId]
      if (!per || typeof per !== 'object') continue
      const rec = {}
      for (const purpose of Object.keys(per).slice(0, 4)) {
        if (ModelCandidate.PURPOSES.indexOf(purpose) < 0) continue
        const r = ModelCandidate.sanitizeValidationRecord(per[purpose], { purpose })
        if (r) rec[purpose] = r
      }
      if (Object.keys(rec).length) { out[modelId] = rec; models++ }
      if (models >= maxValidations) break
    }
    return out
  }

  /* P1-B：realRuns 白名单 + 有界（nonce 环 ≤maxRealNonces、冷却/时间戳表 ≤maxRealCooldowns） */
  function sanitizeRealRuns(r) {
    const d = { usedNonces: [], usage: {}, cooldowns: {}, lastPairAt: {}, lastModelAt: {}, providerRevisionHash8: null }
    if (!r || typeof r !== 'object') return d
    if (Array.isArray(r.usedNonces)) {
      d.usedNonces = r.usedNonces.slice(-maxRealNonces).map((x) => {
        if (!x || typeof x !== 'object' || typeof x.nonce !== 'string') return null
        return { nonce: x.nonce.slice(0, 32), validationId: typeof x.validationId === 'string' ? x.validationId.slice(0, 48) : '', at: toNum(x.at, 0) }
      }).filter(Boolean)
    }
    if (r.usage && typeof r.usage === 'object') {
      d.usage = {
        hourKey: typeof r.usage.hourKey === 'string' ? r.usage.hourKey.slice(0, 16) : null,
        hourCount: toNum(r.usage.hourCount, 0),
        dayKey: typeof r.usage.dayKey === 'string' ? r.usage.dayKey.slice(0, 12) : null,
        dayCount: toNum(r.usage.dayCount, 0),
        lastAt: toNum(r.usage.lastAt, 0),
        lastOk: r.usage.lastOk === true,
      }
    }
    const mapOf = (src) => {
      const out = {}
      if (src && typeof src === 'object') {
        for (const k of Object.keys(src).slice(0, maxRealCooldowns)) out[String(k).slice(0, 80)] = toNum(src[k], 0)
      }
      return out
    }
    d.cooldowns = mapOf(r.cooldowns)
    d.lastPairAt = mapOf(r.lastPairAt)
    d.lastModelAt = mapOf(r.lastModelAt)
    d.providerRevisionHash8 = typeof r.providerRevisionHash8 === 'string' ? r.providerRevisionHash8.slice(0, 16) : null
    return d
  }

  function sanitizeModels(mm) {
    const d = defaultModels()
    if (!mm || typeof mm !== 'object') return d
    d.declared = ModelRegistry.declared() // 永远以 registry 为准：state 里的 declared 只是快照
    d.listed = Array.isArray(mm.listed)
      ? mm.listed.filter((x) => typeof x === 'string').map((x) => x.slice(0, 64)).slice(0, DEFAULTS.maxListedIds)
      : []
    d.listedAt = toNum(mm.listedAt, 0)
    d.discovered = Array.isArray(mm.discovered)
      ? mm.discovered.map(sanitizeDiscoveredModel).filter(Boolean).slice(0, maxDiscovered)
      : []
    d.conflicts = Array.isArray(mm.conflicts) ? mm.conflicts.map(sanitizeConflict).filter(Boolean).slice(-maxConflicts) : []
    const life = {}
    if (mm.lifecycle && typeof mm.lifecycle === 'object') {
      for (const k of Object.keys(mm.lifecycle).slice(0, maxLifecycle)) {
        const e = sanitizeLifecycleEntry(mm.lifecycle[k])
        if (e) life[e.id] = e
      }
    }
    d.lifecycle = life
    d.validations = sanitizeValidations(mm.validations)
    d.realRuns = sanitizeRealRuns(mm.realRuns)
    d.routeId = typeof mm.routeId === 'string' ? mm.routeId.slice(0, 64) : null
    d.routeDue = toMsOrNull(mm.routeDue)
    d.routeState = ['scheduled', 'due', 'passed', 'invalid'].indexOf(mm.routeState) >= 0 ? mm.routeState : null
    d.actionRequired = ['none', 'recommended', 'required'].indexOf(mm.actionRequired) >= 0 ? mm.actionRequired : 'none'
    d.checkedAt = toNum(mm.checkedAt, 0)
    d.lastError = typeof mm.lastError === 'string' ? mm.lastError.slice(0, 40) : null
    return d
  }
  function sanitizeAudit(a) {
    if (!a || typeof a !== 'object') return null
    return {
      at: toNum(a.at, 0),
      channel: typeof a.channel === 'string' ? a.channel.slice(0, 16) : 'unknown',
      action: typeof a.action === 'string' ? a.action.slice(0, 32) : 'unknown',
      detail: typeof a.detail === 'string' ? a.detail.slice(0, 160) : '',
      actor: a.actor === 'user' ? 'user' : 'auto',
    }
  }

  /* 只接受白名单字段 → 任何误入的凭据/prompt 都不可能落盘或被读回 */
  function sanitizeUsageRecord(r) {
    if (!r || typeof r !== 'object') return null
    return {
      purpose: typeof r.purpose === 'string' ? r.purpose.slice(0, 32) : 'unknown',
      model: typeof r.model === 'string' ? r.model.slice(0, 64) : '',
      ok: r.ok === true,
      error: typeof r.error === 'string' ? r.error.slice(0, 32) : null,
      ts: toNum(r.ts, 0),
    }
  }
  function sanitizeCounts(c) {
    const out = {}
    if (!c || typeof c !== 'object') return out
    for (const k of Object.keys(c).slice(0, maxCountKeys)) {
      if (typeof k !== 'string' || k.length > 160) continue
      out[k] = toNum(c[k], 0)
    }
    return out
  }
  function sanitizeState(j) {
    const s = defaultState()
    if (!j || typeof j !== 'object') return s
    if (j.probe && typeof j.probe === 'object') {
      s.probe.attemptedAt = toNum(j.probe.attemptedAt, 0)
      s.probe.fetchedAt = toNum(j.probe.fetchedAt, 0)
      s.probe.ok = j.probe.ok === true
      s.probe.error = typeof j.probe.error === 'string' ? j.probe.error.slice(0, 40) : null
      s.probe.listed = Array.isArray(j.probe.listed)
        ? j.probe.listed.filter((x) => typeof x === 'string').slice(0, DEFAULTS.maxListedIds)
        : []
      s.probe.url = typeof j.probe.url === 'string' ? j.probe.url : modelsUrl
    }
    if (j.usage && typeof j.usage === 'object') {
      s.usage.last = Array.isArray(j.usage.last) ? j.usage.last.map(sanitizeUsageRecord).filter(Boolean).slice(-maxUseRecords) : []
      s.usage.counts = sanitizeCounts(j.usage.counts)
    }
    // 兼容：v1 没有 channels/models；旧文件里的多余字段一律忽略（只读白名单）
    s.models = sanitizeModels(j.models)
    if (!Number(s.models.listedAt) && s.probe.ok && Number(s.probe.fetchedAt) > 0 && Array.isArray(s.probe.listed)) {
      // B1/B2 之后、B3 之前的 state：把已有探测结果迁移进 models.listed（派生数据由视图惰性计算）
      s.models.listed = s.probe.listed.slice(0, DEFAULTS.maxListedIds)
      s.models.listedAt = toNum(s.probe.fetchedAt, 0)
      s.models.checkedAt = toNum(s.probe.fetchedAt, 0)
    }
    s.audit = Array.isArray(j.audit) ? j.audit.map(sanitizeAudit).filter(Boolean).slice(-maxAudit) : []
    s.updatedAt = toNum(j.updatedAt, 0)
    return s
  }

  /* 可恢复：文件缺失/损坏 → 回到默认状态，不抛错、不阻塞 */
  function load() {
    if (state) return state
    if (!stateFile) { state = defaultState(); return state }
    try {
      state = sanitizeState(JSON.parse(fs.readFileSync(stateFile, 'utf8')))
    } catch (err) {
      state = defaultState()
    }
    return state
  }

  /* 原子写入（tmp + rename）；任何失败只记日志，绝不抛错 */
  function saveNow() {
    if (!stateFile) return false
    try {
      const dir = pathMod.dirname(stateFile)
      try { fs.mkdirSync(dir, { recursive: true }) } catch (err) { /* ignore */ }
      const tmp = stateFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8')
      fs.renameSync(tmp, stateFile)
      saves++
      return true
    } catch (err) {
      saveFailures++
      try { log('update-state save failed', (err && err.code) || (err && err.message) || 'unknown') } catch (e) { /* ignore */ }
      return false
    }
  }
  function scheduleSave() {
    if (!stateFile) return
    if (saveTimer) return
    try {
      saveTimer = setTimeout(() => { saveTimer = null; saveNow() }, saveDebounceMs)
      if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref()
    } catch (err) { saveTimer = null }
  }
  function flush() {
    if (saveTimer) { try { clearTimeout(saveTimer) } catch (e) { /* ignore */ } ; saveTimer = null }
    return saveNow()
  }

  function readState() {
    const s = load()
    return JSON.parse(JSON.stringify(s))
  }

  /* 只记录 model 与结果分类；prompt/content/凭据一律被白名单丢弃 */
  function recordModelUse(entry) {
    const s = load()
    const rec = sanitizeUsageRecord(Object.assign({}, entry || {}, { ts: now() }))
    s.usage.last.push(rec)
    if (s.usage.last.length > maxUseRecords) s.usage.last = s.usage.last.slice(-maxUseRecords)
    const key = rec.model + '|' + (rec.ok ? 'ok' : 'err') + '|' + (rec.error || '')
    if (Object.prototype.hasOwnProperty.call(s.usage.counts, key) || Object.keys(s.usage.counts).length < maxCountKeys) {
      s.usage.counts[key] = (s.usage.counts[key] || 0) + 1
    }
    s.updatedAt = now()
    scheduleSave()
    return Object.assign({}, rec)
  }

  async function fetchListedIds(apiKey) {
    if (typeof fetchImpl !== 'function') return { ok: false, error: 'no_fetch' }
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { ctl.abort() } catch (e) { /* ignore */ } }, timeoutMs)
    try {
      const res = await fetchImpl(modelsUrl, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
        signal: ctl.signal,
      })
      if (!res || typeof res.status !== 'number') return { ok: false, error: 'network' }
      if (!res.ok) return { ok: false, error: classifyHttp(res.status) }
      let j = null
      try { j = await res.json() } catch (err) { return { ok: false, error: 'invalid_json' } }
      if (!j || !Array.isArray(j.data)) return { ok: false, error: 'bad_shape' }
      const listed = j.data.map((x) => (x && typeof x.id === 'string' ? x.id : null)).filter(Boolean)
      return { ok: true, listed: listed.slice(0, DEFAULTS.maxListedIds) }
    } catch (err) {
      return { ok: false, error: timedOut ? 'timeout' : 'network' }
    } finally {
      try { clearTimeout(timer) } catch (e) { /* ignore */ }
    }
  }

  function probeView(extra) {
    const s = load()
    const stale = !!(s.probe.fetchedAt && now() - s.probe.fetchedAt >= cacheTtlMs)
    return Object.assign({
      ok: s.probe.ok,
      error: s.probe.error,
      attemptedAt: s.probe.attemptedAt,
      fetchedAt: s.probe.fetchedAt,
      listed: s.probe.listed.slice(),
      stale,
      cached: false,
      rateLimited: false,
      url: s.probe.url,
    }, extra || {})
  }

  /* /models 只读探测：永不抛错、永不阻塞（timeout 兜底）、有缓存与频率限制 */
  async function probeModels(opts) {
    const oo = opts || {}
    const force = oo.force === true
    const s = load()
    const ts = now()
    const fresh = s.probe.ok && s.probe.fetchedAt && ts - s.probe.fetchedAt < cacheTtlMs
    if (!force && fresh) return probeView({ cached: true, registry: registryView(true), models: modelsView({ cached: true }) })
    const lastAt = Math.max(lastAttemptAt, s.probe.attemptedAt || 0)
    if (!force && lastAt && ts - lastAt < minIntervalMs) {
      return s.probe.ok
        ? probeView({ cached: true, stale: true, rateLimited: true, registry: registryView(true), models: modelsView({ cached: true, stale: true, rateLimited: true }) })
        : { ok: false, error: 'rate_limited', rateLimited: true, cached: false, listed: null, registry: registryView(false), models: modelsView({ cached: true, stale: true, rateLimited: true }) }
    }
    const key = typeof oo.apiKey === 'string' ? oo.apiKey : String(readKey() || '')
    lastAttemptAt = ts
    if (!key) {
      s.probe.attemptedAt = ts
      s.probe.error = 'no_key'
      s.models.lastError = 'no_key'
      s.models.checkedAt = ts
      s.updatedAt = ts
      scheduleSave()
      return { ok: false, error: 'no_key', rateLimited: false, cached: false, listed: null, registry: registryView(false), models: modelsView() }
    }
    const res = await fetchListedIds(key)
    s.probe.attemptedAt = ts
    s.probe.url = modelsUrl
    if (res.ok) {
      s.probe.ok = true
      s.probe.error = null
      s.probe.fetchedAt = now()
      s.probe.listed = res.listed
      s.updatedAt = s.probe.fetchedAt
      /* B3：只有成功探测才做对账（失败绝不会造成"模型全都消失"的假冲突） */
      reconcileModels(res.listed, { listedAt: s.probe.fetchedAt })
    } else {
      s.probe.ok = false
      s.probe.error = res.error
      s.models.lastError = res.error
      s.models.checkedAt = now()
      s.updatedAt = now()
    }
    scheduleSave()
    try {
      log('deepseek models probe', JSON.stringify({ ok: !!res.ok, error: res.error || null, count: res.ok ? res.listed.length : 0 }))
    } catch (e) { /* ignore */ }
    return res.ok
      ? probeView({ cached: false, registry: registryView(true), models: modelsView() })
      : { ok: false, error: res.error, rateLimited: false, cached: false, stale: s.probe.listed.length > 0, listed: s.probe.listed.slice(), registry: registryView(s.probe.listed.length > 0), models: modelsView() }
  }

  function registryView(useListed) {
    const s = load()
    const listedIds = useListed && s.probe.ok ? s.probe.listed : null
    return ModelRegistry.statusForAll({ listedIds, nowMs: now() })
  }

  /* B3：把 registry 的单模型状态收敛成 state/models 里能落盘的白名单子集 */
  function summarizeModelStatus(st) {
    return {
      id: st.id,
      known: st.known === true,
      lifecycle: st.lifecycle,
      state: st.state,
      verified: st.verified === true,
      trusted: st.trusted === true,
      listed: st.listed === null ? null : st.listed === true,
      listedButUnverified: st.listedButUnverified === true,
      recommended: typeof st.recommended === 'string' ? st.recommended : null,
      migration: st.migration
        ? { from: st.migration.from, to: st.migration.to, mode: st.migration.mode, autoApply: false, requiresUserAction: true }
        : null,
      routeAfter: typeof st.routeAfter === 'string' ? st.routeAfter : null,
      routeDue: toMsOrNull(st.routeDue),
      routeState: typeof st.routeState === 'string' ? st.routeState : null,
      source: typeof st.source === 'string' ? st.source : null,
      actionRequired: ['none', 'recommended', 'required'].indexOf(st.actionRequired) >= 0 ? st.actionRequired : 'none',
    }
  }

  /* B3：/models 结果 × 本地 registry 对账（纯计算 + 落 state；不发网络请求）。
     只在**成功探测**后调用；网络/鉴权失败绝不能走到这里（否则会造出"所有模型消失"的假冲突）。 */
  function reconcileModels(listedIds, opts) {
    const oo = opts || {}
    const s = load()
    const m = s.models
    const ts = now()
    const listed = (Array.isArray(listedIds) ? listedIds : [])
      .filter((x) => typeof x === 'string')
      .map((x) => x.slice(0, 64))
      .slice(0, DEFAULTS.maxListedIds)
    m.declared = ModelRegistry.declared()
    m.listed = listed
    m.listedAt = toNum(oo.listedAt, ts) || ts
    m.checkedAt = ts
    m.lastError = null
    m.discovered = deriveDiscoveredModels({
      listed,
      isKnown: ModelRegistry.isKnown,
      prev: m.discovered,
      at: m.listedAt,
      max: maxDiscovered,
    })
    const ids = new Set(ModelRegistry.allKnownIds())
    for (const p of Object.keys(m.declared)) ids.add(m.declared[p])
    const lifecycle = {}
    for (const id of Array.from(ids).slice(0, maxLifecycle)) {
      lifecycle[id] = summarizeModelStatus(ModelRegistry.statusFor(id, { listedIds: listed, nowMs: ts }))
    }
    m.lifecycle = lifecycle
    m.conflicts = computeModelConflicts({
      listed,
      listedAt: m.listedAt,
      lifecycle,
      declared: m.declared,
      at: ts,
      max: maxConflicts,
    })
    const agg = aggregateModelRoute({
      entries: Object.keys(lifecycle).map((id) => lifecycle[id]),
      declaredIds: Object.keys(m.declared).map((p) => m.declared[p]),
      nowMs: ts,
    })
    m.routeId = agg.routeId
    m.routeDue = agg.routeDue
    m.routeState = agg.routeState
    m.actionRequired = maxActionLevel(Object.keys(lifecycle).map((id) => lifecycle[id].actionRequired))
    s.updatedAt = ts
    scheduleSave()
    try {
      log('deepseek models reconcile', JSON.stringify({
        listed: listed.length,
        discovered: m.discovered.length,
        conflicts: m.conflicts.length,
        routeState: m.routeState,
        actionRequired: m.actionRequired,
      }))
    } catch (e) { /* ignore */ }
    return m
  }

  /* B3：models 视图（同步、无网络、无写盘）。routeState 一律按当前时间**重算**（绝对时间比较），
     保证即使很久没有探测，快照也不会撒谎。 */
  function modelsView(extra) {
    const s = load()
    const m = s.models
    const ts = now()
    const stored = m.lifecycle && Object.keys(m.lifecycle).length ? m.lifecycle : null
    const fallback = stored
      ? null
      : ModelRegistry.statusForAll({ listedIds: m.listedAt > 0 ? m.listed : null, nowMs: ts }).lifecycle
    const lifecycle = {}
    for (const id of Object.keys(stored || fallback || {})) {
      const e = stored ? stored[id] : summarizeModelStatus(fallback[id])
      const r = ModelRegistry.routeStateFor(e.routeAfter, ts)
      lifecycle[id] = Object.assign({}, e, {
        routeDue: r.routeDue,
        routeState: r.routeState,
        routeInvalid: r.routeInvalid,
      })
    }
    const declaredIds = Object.keys(m.declared || {}).map((p) => m.declared[p])
    const agg = aggregateModelRoute({ entries: Object.keys(lifecycle).map((id) => lifecycle[id]), declaredIds, nowMs: ts })
    const age = m.listedAt ? ts - m.listedAt : null
    return Object.assign({
      declared: Object.assign({}, m.declared),
      listed: m.listed.slice(),
      listedAt: m.listedAt,
      discovered: m.discovered.map((d) => Object.assign({}, d)),
      conflicts: m.conflicts.map((c) => Object.assign({}, c)),
      lifecycle,
      routeId: agg.routeId,
      routeDue: agg.routeDue,
      routeState: agg.routeState,
      actionRequired: m.actionRequired,
      checkedAt: m.checkedAt,
      lastError: m.lastError,
      ageMs: age,
      stale: !!(age !== null && age >= cacheTtlMs),
      autoMigrationEnabled: ModelRegistry.AUTO_MIGRATION_ENABLED,
      cached: false,
    }, extra || {})
  }

  /* B3：只读模型发现快照（供设置页/IPC 消费；不联网、不写盘、不切换模型） */
  function modelDiscovery() {
    return modelsView({ cached: true })
  }

  /* ======================================================================
   * B4：候选验证与推荐资格（Model Candidate Validation & Recommendation Gate）
   *  - 派生值（recommended / migrationEligible / blockers）**只在 view 中计算**，不落盘
   *  - recordValidation() 是 ValidationRecord 的**正式写契约**：调用方只能给草稿
   *    （checks/evidenceRefs），status 由纯函数按 required 检查重算，无法伪造
   *  - 无网络、无 LLM、无迁移、无重启；构造函数/读路径零副作用
   * ====================================================================== */

  function validationRecordFor(modelId, purpose) {
    const s = load()
    const per = s.models.validations && s.models.validations[modelId]
    return (per && per[purpose]) || null
  }

  /* 写契约：落一条验证证据（事实）。永不抛错、永不联网、永不触发迁移。 */
  function recordValidation(draft) {
    try {
      const d = draft || {}
      const modelId = typeof d.modelId === 'string' ? d.modelId.slice(0, 64) : ''
      const purpose = ModelCandidate.PURPOSES.indexOf(d.purpose) >= 0 ? d.purpose : null
      if (!modelId || !purpose) return { ok: false, error: 'invalid_input', record: null }
      const ts = now()
      if (d.mode !== undefined && ModelCandidate.MODES.indexOf(d.mode) < 0) {
        return { ok: false, error: 'invalid_mode', record: null }
      }
      const built = ModelCandidate.buildValidationRecord({
        modelId,
        purpose,
        checks: d.checks,
        evidenceRefs: d.evidenceRefs,
        actor: d.actor === 'user' ? 'user' : 'auto',
        error: d.error,
        nowMs: ts,
        /* P1-B：production 记录用更短的 7 天 TTL（与 gate 的 production TTL 一致） */
        ttlMs: d.ttlMs || (d.profile === 'production' ? ModelCandidate.PRODUCTION_TTL_MS : undefined),
        /* P1-B：real 证据必须随记录落盘（否则 real 记录一律 malformed） */
        provenance: d.provenance,
        validationId: d.validationId,
        nonce: d.nonce,
        providerRevisionHash8: d.providerRevisionHash8,
        validatorVersion: d.validatorVersion,
        mode: d.mode,
        implementationVersion: d.implementationVersion,
        profile: d.profile,
      })
      const rec = ModelCandidate.sanitizeValidationRecord(built, { purpose })
      if (!rec) return { ok: false, error: 'invalid_record', record: null }
      const s = load()
      const per = s.models.validations[modelId] || null
      const existing = per && per[purpose] ? per[purpose] : null
      /* 不完整（unknown）的验证结果**不得**抹掉已有的有效证据；
         但 failed 记录必须能覆盖旧记录（失败即撤销，防止失败被"通过"掩盖）。 */
      if (existing && rec.status === 'unknown') {
        const prev = ModelCandidate.validationStateFor(existing, { nowMs: ts })
        if (prev.valid) {
          return { ok: false, error: 'would-downgrade-known-good', record: JSON.parse(JSON.stringify(existing)) }
        }
      }
      if (!s.models.validations[modelId]) s.models.validations[modelId] = {}
      s.models.validations[modelId][purpose] = rec
      // 有界：超出上限时淘汰"最旧 checkedAt"的模型条目（保留最近事实）
      const ids = Object.keys(s.models.validations)
      if (ids.length > maxValidations) {
        const ordered = ids.slice().sort((a, b) => {
          const ta = oldestCheckedAt(s.models.validations[a])
          const tb = oldestCheckedAt(s.models.validations[b])
          return ta - tb
        })
        for (const drop of ordered.slice(0, ids.length - maxValidations)) delete s.models.validations[drop]
      }
      s.updatedAt = ts
      recordAudit({ channel: 'models', action: 'validation-recorded', detail: modelId + '|' + purpose + '|' + rec.status + '|' + (rec.wellFormed ? 'well-formed' : 'malformed'), actor: rec.actor })
      scheduleSave()
      return { ok: true, error: null, record: JSON.parse(JSON.stringify(rec)) }
    } catch (err) {
      try { log('model validation record failed', (err && err.message) || 'unknown') } catch (e) { /* ignore */ }
      return { ok: false, error: 'record_failed', record: null }
    }
  }

  /* ======================================================================
   * P1-A：用户显式触发的 offline/mock 验证（写路径）
   *   参数校验 → 限流 → 单飞 → ModelValidator.runValidation()
   *   → buildValidationRecord()（引擎内）→ sanitize → recordValidation()（唯一落盘）
   *   → audit → 结构化结果
   * 不允许：自由文本 / checks / scenario / mode / status / evidenceRefs / plan
   * ====================================================================== */
  const FORBIDDEN_VALIDATE_KEYS = ['checks', 'scenario', 'mode', 'status', 'evidenceRefs', 'evidence', 'plan', 'result', 'runner', 'command', 'text', 'prompt', 'content', 'apiKey', 'authorization', 'executor', 'provenance', 'endpoint', 'key', 'token', 'tier', 'validationId', 'nonce', 'providerRevisionHash8']

  function isValidationCandidateId(id) {
    const s = load()
    const declared = Object.values(s.models.declared || {})
    if (declared.indexOf(id) >= 0) return true
    if (ModelRegistry.isKnown(id)) return true
    if ((s.models.listed || []).indexOf(id) >= 0) return true
    for (const d of s.models.discovered || []) if (d && d.id === id) return true
    return false
  }

  function pruneValidationWindow(ts) {
    while (validationWindow.length && ts - validationWindow[0] >= validationWindowMs) validationWindow.shift()
  }

  function validationLimitsView(ts, retryAfterMs) {
    pruneValidationWindow(ts)
    return {
      minIntervalMs: validationMinIntervalMs,
      modelMinIntervalMs: validationModelMinIntervalMs,
      windowMs: validationWindowMs,
      windowMax: validationWindowMax,
      windowUsed: validationWindow.length,
      retryAfterMs: toNum(retryAfterMs, 0),
    }
  }

  function validationRefuse(modelId, purpose, error, detail, retryAfterMs) {
    try {
      recordAudit({
        channel: 'models',
        action: error === 'rate_limited' ? 'validation-rate-limited' : 'validation-refused',
        detail: String(modelId || '-') + '|' + String(purpose || '-') + '|' + error + (detail ? '|' + detail : ''),
        actor: 'user',
      })
    } catch (e) { /* ignore */ }
    return {
      ok: false,
      error,
      detail: detail || null,
      applied: false,
      modelId: modelId || null,
      purpose: purpose || null,
      limits: validationLimitsView(now(), retryAfterMs),
    }
  }

  /* 用户显式触发的模型验证（offline/mock）。永不联网、永不迁移、永不改 declared。 */
  function runModelValidation(opts, env) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const e = env && typeof env === 'object' ? env : {}
    const modelId = typeof o.modelId === 'string' ? o.modelId.trim().slice(0, 64) : ''
    const purpose = ModelCandidate.PURPOSES.indexOf(o.purpose) >= 0 ? o.purpose : null
    const profile = o.profile === undefined ? 'default' : (ModelCandidate.PROFILES.indexOf(o.profile) >= 0 ? o.profile : null)
    const requestedTier = o.requestedTier === undefined ? 'compatibility'
      : (o.requestedTier === 'compatibility' || o.requestedTier === 'production' ? o.requestedTier : null)

    for (const k of FORBIDDEN_VALIDATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        return validationRefuse(modelId, purpose, 'forbidden_param', k, 0)
      }
    }
    if (!modelId) return validationRefuse('', purpose, 'invalid_input', 'modelId', 0)
    if (!purpose) return validationRefuse(modelId, null, 'invalid_input', 'purpose', 0)
    if (profile === null) return validationRefuse(modelId, purpose, 'invalid_input', 'profile', 0)
    if (!isValidationCandidateId(modelId)) return validationRefuse(modelId, purpose, 'not_a_candidate', 'unknown-model', 0)
    if (requestedTier === null) return validationRefuse(modelId, purpose, 'invalid_input', 'requestedTier', 0)
    if (requestedTier === 'production') return validationRefuse(modelId, purpose, 'production_requires_async_path', 'use-runProductionValidation', 0)

    const ts = now()
    const key = modelId + '|' + purpose
    if (validationInFlight.has(key)) return validationRefuse(modelId, purpose, 'busy', 'single-flight', 0)

    /* 持久化守卫（跨重启）：最近一条同 (model,purpose) 记录太新 ⇒ 限流 */
    const s0 = load()
    const existing = (s0.models.validations[modelId] || {})[purpose] || null
    if (existing && ts - toNum(existing.checkedAt, 0) < validationMinIntervalMs) {
      return validationRefuse(modelId, purpose, 'rate_limited', 'persisted-guard', validationMinIntervalMs - (ts - toNum(existing.checkedAt, 0)))
    }
    const pairLast = validationRatePairs.get(key)
    if (pairLast && ts - pairLast < validationMinIntervalMs) {
      return validationRefuse(modelId, purpose, 'rate_limited', 'pair-interval', validationMinIntervalMs - (ts - pairLast))
    }
    const modelLast = validationRateModels.get(modelId)
    if (modelLast && ts - modelLast < validationModelMinIntervalMs) {
      return validationRefuse(modelId, purpose, 'rate_limited', 'model-interval', validationModelMinIntervalMs - (ts - modelLast))
    }
    pruneValidationWindow(ts)
    if (validationWindow.length >= validationWindowMax) {
      const oldest = validationWindow[0]
      return validationRefuse(modelId, purpose, 'rate_limited', 'window-budget', Math.max(0, validationWindowMs - (ts - oldest)))
    }

    validationInFlight.add(key)
    let engine
    try {
      engine = ModelValidator.runValidation({
        modelId,
        purpose,
        profile,
        nowMs: ts,
        listing: { listedIds: s0.models.listedAt > 0 ? s0.models.listed : null },
        conflicts: Array.isArray(s0.models.conflicts) ? s0.models.conflicts : [],
        declaredMap: ModelRegistry.declared(),
        actor: e.actor === 'auto' ? 'auto' : 'user',
        adapters: { classifyHttp: classifyHttp },
      })
    } catch (err) {
      validationInFlight.delete(key)
      return validationRefuse(modelId, purpose, 'engine_failed', (err && err.message) || 'unknown', 0)
    }
    validationInFlight.delete(key)

    if (!engine || engine.ok !== true) {
      return validationRefuse(modelId, purpose, (engine && engine.error) || 'engine_failed', (engine && engine.detail) || null, 0)
    }

    /* 记账（仅在实际运行了引擎之后） */
    validationRatePairs.set(key, ts)
    validationRateModels.set(modelId, ts)
    validationWindow.push(ts)
    if (validationRatePairs.size > maxValidationRatePairs) {
      const firstKey = validationRatePairs.keys().next().value
      validationRatePairs.delete(firstKey)
    }
    if (validationRateModels.size > maxValidationRatePairs) {
      const firstModel = validationRateModels.keys().next().value
      validationRateModels.delete(firstModel)
    }
    if (validationWindow.length > maxValidationRatePairs) validationWindow.splice(0, validationWindow.length - maxValidationRatePairs)

    /* 唯一持久化入口（sanitize + 覆盖规则 + 原子保存都在里面） */
    const written = recordValidation(engine.draft)
    try {
      recordAudit({
        channel: 'models',
        action: written.ok ? 'validation-run' : 'validation-write-refused',
        detail: modelId + '|' + purpose + '|' + engine.mode + '|' + engine.status + '|' + (written.ok ? 'applied' : written.error),
        actor: 'user',
      })
    } catch (err) { /* ignore */ }

    return {
      ok: true,
      error: written.ok ? null : written.error,
      applied: written.ok === true,
      modelId,
      purpose,
      profile: engine.profile,
      mode: engine.mode,
      status: engine.status,
      trust: engine.trust,
      productionCompatible: engine.productionCompatible === true,
      validatorVersion: engine.validatorVersion,
      implementationVersion: engine.implementationVersion,
      schemaVersion: engine.schemaVersion,
      checkSetHash: engine.checkSetHash,
      checks: engine.checks,
      warnings: engine.warnings,
      evidenceRefs: engine.evidenceRefs,
      record: written.record || null,
      limits: validationLimitsView(ts, 0),
    }
  }

  /* P1-B：real tier 拒绝（审计动作区分于 mock 层） */
  function productionRefuse(modelId, purpose, error, detail, retryAfterMs) {
    const rateErr = error === 'production_rate_limited' || error === 'production_budget_exhausted'
    try {
      recordAudit({
        channel: 'models',
        action: rateErr ? 'production-validation-rate-limited'
          : (error === 'busy' ? 'production-validation-busy' : 'production-validation-refused'),
        detail: String(modelId || '-') + '|' + String(purpose || '-') + '|' + error + (detail ? '|' + detail : ''),
        actor: 'user',
      })
    } catch (e) { /* ignore */ }
    const ts = now()
    const b = realBudgetState(ts)
    return {
      ok: false,
      error,
      detail: detail || null,
      applied: false,
      modelId: modelId || null,
      purpose: purpose || null,
      profile: 'production',
      productionEligible: false,
      productionReasons: [error],
      retryAfterMs: toNum(retryAfterMs, 0),
      realLimits: realLimitsView(ts, retryAfterMs),
      limits: validationLimitsView(ts, retryAfterMs),
    }
  }

  function realLimitsView(ts, retryAfterMs) {
    const b = realBudgetState(ts)
    return {
      pairIntervalMs: realPairIntervalMs,
      modelIntervalMs: realModelIntervalMs,
      hourWindowMs: realHourWindowMs,
      hourMax: realHourMax,
      dayMax: realDayMax,
      hourUsed: b.hourCount,
      dayUsed: b.dayCount,
      hourLeft: b.hourLeft,
      dayLeft: b.dayLeft,
      retryAfterMs: toNum(retryAfterMs, 0),
    }
  }

  /* P1-B：real tier 编排（**异步唯一入口**）。任何"成功"都必须落一条 real 记录；
     绝不接受调用方提供的 checks / mode / provenance / endpoint / key。 */
  async function runProductionValidation(opts, env) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const e = env && typeof env === 'object' ? env : {}
    const modelId = typeof o.modelId === 'string' ? o.modelId.trim().slice(0, 64) : ''
    const purpose = ModelCandidate.PURPOSES.indexOf(o.purpose) >= 0 ? o.purpose : null

    for (const k of FORBIDDEN_VALIDATE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(o, k)) return productionRefuse(modelId, purpose, 'forbidden_param', k, 0)
    }
    if (o.requestedTier !== undefined && o.requestedTier !== 'production') return productionRefuse(modelId, purpose, 'invalid_input', 'requestedTier', 0)
    if (o.profile !== undefined && o.profile !== 'production') return productionRefuse(modelId, purpose, 'invalid_input', 'profile', 0)
    if (!modelId) return productionRefuse('', purpose, 'invalid_input', 'modelId', 0)
    if (!purpose) return productionRefuse(modelId, null, 'invalid_input', 'purpose', 0)
    if (purpose === 'work') return productionRefuse(modelId, purpose, 'production_tier_unsupported_purpose', 'work-has-no-directllm-path', 0)

    /* 双层开关（运行期 provider 由组合根注入：构建常量 && 运行期 flag && !test edition） */
    if (!productionTierOn()) return productionRefuse(modelId, purpose, 'production_tier_disabled', 'runtime-gate-off', 0)
    if (typeof realRunner !== 'function') return productionRefuse(modelId, purpose, 'production_runner_missing', 'no-injected-runner', 0)

    const envInfo = typeof envProvider === 'function' ? (envProvider() || {}) : {}
    if (!envInfo.keyIdHash8) return productionRefuse(modelId, purpose, 'production_no_key', 'no-key-bound', 0)
    if (!isValidationCandidateId(modelId)) return productionRefuse(modelId, purpose, 'not_a_candidate', 'unknown-model', 0)

    const ts = now()
    const key = modelId + '|' + purpose
    if (validationInFlight.has(key) || realInFlight.has(key)) return productionRefuse(modelId, purpose, 'busy', 'pair-single-flight', 0)
    if (realInFlight.size > 0) return productionRefuse(modelId, purpose, 'busy', 'global-single-flight', 0)
    const rate = realRateGate(modelId, purpose, ts)
    if (rate) return productionRefuse(modelId, purpose, rate.error, rate.detail, rate.retryAfterMs)

    /* P1-B：production 记录 = **完整证据阶梯**（offline + mock + real）。
       先跑零成本本地阶梯：本地 required 未全通过 ⇒ 直接拒绝，
       **不消耗真实请求、不消耗预算、不打时间戳**（避免为注定 failed/unknown 的证据付费）。 */
    const s0 = load()
    let local = null
    try {
      local = ModelValidator.runValidation({
        modelId,
        purpose,
        profile: 'default',
        nowMs: ts,
        listing: { listedIds: s0.models.listedAt > 0 ? s0.models.listed : null },
        conflicts: Array.isArray(s0.models.conflicts) ? s0.models.conflicts : [],
        declaredMap: ModelRegistry.declared(),
        actor: e.actor === 'auto' ? 'auto' : 'user',
        adapters: { classifyHttp: classifyHttp },
      })
    } catch (errLocal) { local = null }
    if (!local || local.ok !== true || local.status !== 'passed') {
      return productionRefuse(
        modelId,
        purpose,
        'production_local_evidence_incomplete',
        'local:' + ((local && local.status) || (local && local.error) || 'engine_failed'),
        0
      )
    }

    /* 占位：进入即消耗一次预算并打时间戳；失败走冷却，不允许立即重试 */
    realInFlight.add(key)
    validationInFlight.add(key)
    stampRealRun(modelId, purpose, ts)
    reserveRealBudget(ts)
    scheduleSave()
    try {
      recordAudit({ channel: 'models', action: 'production-validation-started', detail: modelId + '|' + purpose + '|production|real|1-request', actor: e.actor === 'auto' ? 'auto' : 'user' })
    } catch (err0) { /* ignore */ }

    let real = null
    try {
      real = await realRunner({ modelId, purpose, timeoutMs: ModelValidatorReal.TIMEOUT_MS })
    } catch (err) {
      real = { ok: false, error: 'runner_threw', detail: (err && err.message) || 'unknown', checks: null, provenance: null }
    } finally {
      realInFlight.delete(key)
      validationInFlight.delete(key)
    }

    if (!real || !real.checks || typeof real.checks !== 'object') {
      const err = (real && real.error) || 'runner_failed'
      const cls = (real && real.errorClass) || null
      const severe = cls === 'auth' || cls === 'quota' || err === 'auth' || err === 'quota'
      const cool = severe ? realAuthCooldownMs : realCooldownMs
      setRealCooldown(key, now() + cool)
      markRealBudget(false)
      scheduleSave()
      try {
        recordAudit({ channel: 'models', action: 'production-validation-failed', detail: modelId + '|' + purpose + '|' + err + (cls ? '|' + cls : ''), actor: 'user' })
      } catch (err1) { /* ignore */ }
      return {
        ok: false,
        error: err,
        detail: (real && real.detail) || null,
        applied: false,
        modelId,
        purpose,
        profile: 'production',
        mode: null,
        status: 'failed',
        trust: 'none',
        productionEligible: false,
        productionReasons: [severe ? 'provider-' + cls + '-cooldown' : 'real-run-failed'],
        failedChecks: (real && real.failedChecks) || null,
        errorClass: cls,
        cooldownMs: cool,
        retryAfterMs: cool,
        realLimits: realLimitsView(now(), cool),
        limits: validationLimitsView(now(), cool),
      }
    }

    const s1 = load()
    const merged = {}
    for (const c of local.checks) merged[c.id] = { status: c.status, detail: c.detail }
    for (const k of Object.keys(real.checks)) merged[k] = real.checks[k]
    const engine = ModelValidator.runValidation({
      modelId,
      purpose,
      profile: 'production',
      nowMs: ts,
      listing: { listedIds: s1.models.listedAt > 0 ? s1.models.listed : null },
      conflicts: Array.isArray(s1.models.conflicts) ? s1.models.conflicts : [],
      declaredMap: ModelRegistry.declared(),
      actor: e.actor === 'auto' ? 'auto' : 'user',
      adapters: { classifyHttp: classifyHttp },
      /* P1-B：合并本地阶梯（offline+mock）与真实阶梯（real）的检查结果；
         调用方仍无法注入 checks（real.checks 来自注入的 realRunner，非 IPC 输入） */
      checkResults: merged,
      recordMode: 'real',
      validationId: real.validationId,
      nonce: real.nonce,
      providerRevisionHash8: real.providerRevisionHash8,
      provenance: Object.assign({}, real.provenance || {}, {
        endpoint: envInfo.endpoint || ModelValidatorReal.LOCKED_ENDPOINT,
        keyIdHash8: envInfo.keyIdHash8,
        appVersion: envInfo.appVersion,
        dshCompatVersion: envInfo.dshCompatVersion,
      }),
    })
    if (!engine || engine.ok !== true || !engine.draft) {
      setRealCooldown(key, now() + realCooldownMs)
      markRealBudget(false)
      scheduleSave()
      try {
        recordAudit({ channel: 'models', action: 'production-validation-failed', detail: modelId + '|' + purpose + '|engine:' + ((engine && engine.error) || 'unknown'), actor: 'user' })
      } catch (err2) { /* ignore */ }
      return productionRefuse(modelId, purpose, (engine && engine.error) || 'engine_failed', (engine && engine.detail) || null, realCooldownMs)
    }

    /* env 指纹：由**记录自身的 required 检查集合**推导（与 gate 复算路径完全一致） */
    const expHash = ModelCandidate.checkSetHashFor(engine.draft.checks, purpose, 'production')
    const fingerprint = ModelCandidate.envFingerprintFor({
      endpoint: envInfo.endpoint || ModelValidatorReal.LOCKED_ENDPOINT,
      purpose,
      modelId,
      keyIdHash8: envInfo.keyIdHash8,
      appVersion: envInfo.appVersion,
      dshCompatVersion: envInfo.dshCompatVersion,
      checkSetHash: expHash,
      providerRevisionHash8: engine.draft.providerRevisionHash8,
    })
    engine.draft.provenance = Object.assign({}, engine.draft.provenance, { envFingerprint: fingerprint })

    /* 唯一持久化入口 */
    const written = recordValidation(engine.draft)
    if (written.ok) {
      const runs = load().models.realRuns
      if (engine.draft.providerRevisionHash8) runs.providerRevisionHash8 = engine.draft.providerRevisionHash8
      recordRealNonce(engine.draft.nonce, engine.draft.validationId, ts)
      markRealBudget(true)
      scheduleSave()
    }
    try {
      recordAudit({
        channel: 'models',
        action: written.ok ? 'production-validation-recorded' : 'production-validation-write-refused',
        detail: modelId + '|' + purpose + '|real|' + engine.status + '|' + (written.ok ? 'applied' : written.error),
        actor: 'user',
      })
    } catch (err3) { /* ignore */ }

    const stored = written.ok ? latestRecordFor(modelId, purpose) : null
    const gate = stored
      ? ModelCandidate.productionTrustFor(stored, trustCtxFor(modelId, purpose, now()))
      : { eligible: false, reasons: [written.error || 'not-written'] }

    return {
      ok: true,
      error: written.ok ? null : written.error,
      applied: written.ok === true,
      modelId,
      purpose,
      profile: 'production',
      mode: engine.mode,
      status: engine.status,
      trust: gate.eligible ? 'production' : 'compatibility',
      productionEligible: gate.eligible === true,
      productionReasons: (gate.reasons || []).slice(0, 6),
      validatorVersion: engine.validatorVersion,
      schemaVersion: engine.schemaVersion,
      checkSetHash: engine.checkSetHash,
      providerRevisionHash8: engine.draft.providerRevisionHash8 || null,
      validationId: engine.draft.validationId || null,
      checks: engine.checks,
      warnings: engine.warnings,
      evidenceRefs: engine.evidenceRefs,
      provenance: written.record ? written.record.provenance : null,
      record: written.record || null,
      realLimits: realLimitsView(ts, 0),
      limits: validationLimitsView(ts, 0),
    }
  }

  /* ======================================================================
   * P1-B：Production Validation Gate（real tier 编排）
   *   - 双层开关：构建期 PRODUCTION_TIER_ENABLED（model-validator-real.js，默认 false）
   *               + 运行期 productionTierEnabled()（由 main.js 注入；test edition 恒 false）
   *   - real 专用限流/预算/冷却（30min / 10min / 5h / 20day / 全局单飞 / 10min·60min 冷却）
   *   - 成本硬约束：1 真实请求、0 重试、output ≤8 tokens、timeout ≤20s
   *   - 只读 plan；真实执行一律经注入的 realRunner（main.js 组合根），manager 不接触 key
   * ====================================================================== */
  const realInFlight = new Set()

  function realRunsView() {
    const s = load()
    const r = s.models.realRuns || { usedNonces: [], usage: {}, cooldowns: {}, providerRevisionHash8: null }
    return {
      usedNonces: (r.usedNonces || []).slice(),
      usage: Object.assign({}, r.usage || {}),
      cooldowns: Object.assign({}, r.cooldowns || {}),
      providerRevisionHash8: r.providerRevisionHash8 || null,
    }
  }

  function dayKeyOf(ts) {
    const d = new Date(toNum(ts, now()))
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  }
  function hourKeyOf(ts) {
    const d = new Date(toNum(ts, now()))
    return dayKeyOf(ts) + 'T' + String(d.getHours()).padStart(2, '0')
  }

  function realBudgetState(ts) {
    const r = load().models.realRuns
    const usage = r.usage && typeof r.usage === 'object' ? r.usage : {}
    const hourKey = hourKeyOf(ts)
    const dayKey = dayKeyOf(ts)
    const hourCount = usage.hourKey === hourKey ? toNum(usage.hourCount, 0) : 0
    const dayCount = usage.dayKey === dayKey ? toNum(usage.dayCount, 0) : 0
    return {
      hourKey, dayKey, hourCount, dayCount,
      hourLeft: Math.max(0, realHourMax - hourCount),
      dayLeft: Math.max(0, realDayMax - dayCount),
    }
  }

  /* 进入即消耗一次预算（无论成败），避免"失败不计费"被用来刷请求 */
  function reserveRealBudget(ts) {
    const r = load().models.realRuns
    const b = realBudgetState(ts)
    r.usage = {
      hourKey: b.hourKey, hourCount: b.hourCount + 1,
      dayKey: b.dayKey, dayCount: b.dayCount + 1,
      lastAt: ts, lastOk: false,
    }
  }

  /* 只更新结果标记，绝不重复计数 */
  function markRealBudget(ok) {
    const r = load().models.realRuns
    if (!r.usage || typeof r.usage !== 'object') return
    r.usage.lastOk = ok === true
  }

  function recordRealNonce(nonce, validationId, ts) {
    if (typeof nonce !== 'string' || !nonce) return
    const r = load().models.realRuns
    r.usedNonces.push({ nonce: nonce.slice(0, 32), validationId: String(validationId || '').slice(0, 48), at: ts })
    if (r.usedNonces.length > maxRealNonces) r.usedNonces = r.usedNonces.slice(-maxRealNonces)
  }

  function setRealCooldown(key, until) {
    const r = load().models.realRuns
    r.cooldowns[key] = toNum(until, 0)
    const keys = Object.keys(r.cooldowns)
    if (keys.length > maxRealCooldowns) {
      const ordered = keys.sort((a, b) => toNum(r.cooldowns[a], 0) - toNum(r.cooldowns[b], 0))
      for (const k of ordered.slice(0, keys.length - maxRealCooldowns)) delete r.cooldowns[k]
    }
  }

  function realCooldownRemaining(modelId, purpose, ts) {
    const r = load().models.realRuns
    const until = toNum(r.cooldowns[modelId + '|' + purpose], 0)
    return until > ts ? until - ts : 0
  }

  /* real tier 限流（内存 + 持久双保险）；返回 null=通过，否则 {error, retryAfterMs, detail} */
  function realRateGate(modelId, purpose, ts) {
    const key = modelId + '|' + purpose
    const cool = realCooldownRemaining(modelId, purpose, ts)
    if (cool > 0) return { error: 'production_cooldown', retryAfterMs: cool, detail: 'cooldown' }
    const runs = load().models.realRuns
    const lastPair = toNum(runs.lastPairAt && runs.lastPairAt[key], 0)
    if (lastPair && ts - lastPair < realPairIntervalMs) return { error: 'production_rate_limited', retryAfterMs: realPairIntervalMs - (ts - lastPair), detail: 'pair-interval' }
    const lastModel = toNum(runs.lastModelAt && runs.lastModelAt[modelId], 0)
    if (lastModel && ts - lastModel < realModelIntervalMs) return { error: 'production_rate_limited', retryAfterMs: realModelIntervalMs - (ts - lastModel), detail: 'model-interval' }
    const b = realBudgetState(ts)
    if (b.hourCount >= realHourMax) return { error: 'production_budget_exhausted', retryAfterMs: realHourWindowMs, detail: 'hour-budget' }
    if (b.dayCount >= realDayMax) return { error: 'production_budget_exhausted', retryAfterMs: 24 * 60 * 60 * 1000, detail: 'day-budget' }
    return null
  }

  function stampRealRun(modelId, purpose, ts) {
    const r = load().models.realRuns
    const key = modelId + '|' + purpose
    if (!r.lastPairAt) r.lastPairAt = {}
    if (!r.lastModelAt) r.lastModelAt = {}
    r.lastPairAt[key] = ts
    r.lastModelAt[modelId] = ts
    const pairKeys = Object.keys(r.lastPairAt)
    if (pairKeys.length > maxRealCooldowns) {
      const ordered = pairKeys.sort((a, b) => toNum(r.lastPairAt[a], 0) - toNum(r.lastPairAt[b], 0))
      for (const k of ordered.slice(0, pairKeys.length - maxRealCooldowns)) delete r.lastPairAt[k]
    }
    const modelKeys = Object.keys(r.lastModelAt)
    if (modelKeys.length > maxRealCooldowns) {
      const ordered = modelKeys.sort((a, b) => toNum(r.lastModelAt[a], 0) - toNum(r.lastModelAt[b], 0))
      for (const k of ordered.slice(0, modelKeys.length - maxRealCooldowns)) delete r.lastModelAt[k]
    }
  }

  function latestRecordFor(modelId, purpose) {
    const per = load().models.validations[modelId]
    return (per && per[purpose]) || null
  }

  /* production trust 上下文（纯数据；不含 secret） */
  function trustCtxFor(modelId, purpose, ts) {
    const env = typeof envProvider === 'function' ? (envProvider() || {}) : {}
    const runs = load().models.realRuns
    return {
      nowMs: ts,
      env: {
        endpoint: env.endpoint || null,
        appVersion: env.appVersion || null,
        dshCompatVersion: env.dshCompatVersion || null,
        keyIdHash8: env.keyIdHash8 || null,
        providerRevisionHash8: runs.providerRevisionHash8 || null,
      },
      currentRecord: latestRecordFor(modelId, purpose),
      /* 必须携带 validationId，使 gate 能查出"nonce 复用 / validationId 复用"（只传 nonce 会让对一致性检查失效） */
      usedNonces: (runs.usedNonces || [])
        .map((x) => ({ nonce: x && x.nonce, validationId: x && x.validationId }))
        .filter((x) => !!x.nonce),
    }
  }

  function productionTierOn() {
    if (typeof productionTierEnabled !== 'function') return false
    try { return productionTierEnabled() === true } catch (e) { return false }
  }

  /* 只读计划（零网络、零写盘、不产生记录/迁移） */
  function productionValidationPlan(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const modelId = typeof o.modelId === 'string' ? o.modelId.trim().slice(0, 64) : ''
    const purpose = ModelCandidate.PURPOSES.indexOf(o.purpose) >= 0 ? o.purpose : null
    const ts = now()
    const keyBound = typeof envProvider === 'function' && !!(envProvider() || {}).keyIdHash8
    const plan = {
      ok: true,
      modelId: modelId || null,
      purpose,
      tierEnabled: productionTierOn(),
      keyBound,
      requests: 1,
      retries: 0,
      estimatedTokens: { input: ModelValidatorReal.MAX_INPUT_TOKENS_EST, output: ModelValidatorReal.MAX_OUTPUT_TOKENS },
      timeoutMs: ModelValidatorReal.TIMEOUT_MS,
      ttlMs: ModelCandidate.PRODUCTION_TTL_MS,
      cooldownMs: realCooldownMs,
      pairIntervalMs: realPairIntervalMs,
      modelIntervalMs: realModelIntervalMs,
      hourMax: realHourMax,
      dayMax: realDayMax,
      budgetLeft: { hour: realBudgetState(ts).hourLeft, day: realBudgetState(ts).dayLeft },
      cooldownRemainingMs: modelId && purpose ? realCooldownRemaining(modelId, purpose, ts) : 0,
      endpoint: ModelValidatorReal.LOCKED_ENDPOINT,
      providerRevisionHash8: realRunsView().providerRevisionHash8,
      eligible: false,
      reason: 'not-evaluated',
      envFingerprint: null,
    }
    if (!modelId || !purpose) { plan.reason = 'invalid_input'; return plan }
    if (purpose === 'work') { plan.reason = 'production_tier_unsupported_purpose'; return plan }
    if (!plan.tierEnabled) { plan.reason = 'production_tier_disabled'; return plan }
    if (!keyBound) { plan.reason = 'production_no_key'; return plan }
    if (plan.cooldownRemainingMs > 0) { plan.reason = 'production_cooldown'; return plan }
    if (!isValidationCandidateId(modelId)) { plan.reason = 'not_a_candidate'; return plan }
    const rate = realRateGate(modelId, purpose, ts)
    if (rate) { plan.reason = rate.error; plan.retryAfterMs = rate.retryAfterMs; return plan }
    const env = typeof envProvider === 'function' ? (envProvider() || {}) : {}
    plan.envFingerprint = ModelCandidate.envFingerprintFor({
      endpoint: env.endpoint, purpose, modelId, keyIdHash8: env.keyIdHash8,
      appVersion: env.appVersion, dshCompatVersion: env.dshCompatVersion,
      checkSetHash: ModelCandidate.checkSetHashFor(
        ModelCandidate.checksForPurpose(purpose, 'production').map((c) => ({ id: c.id, status: 'pass' })), purpose, 'production'),
      providerRevisionHash8: realRunsView().providerRevisionHash8,
    })
    plan.eligible = true
    plan.reason = 'ok'
    return plan
  }

  function oldestCheckedAt(per) {
    let oldest = Infinity
    if (!per || typeof per !== 'object') return 0
    for (const p of Object.keys(per)) {
      const t = toNum(per[p] && per[p].checkedAt, 0)
      if (t && t < oldest) oldest = t
    }
    return oldest === Infinity ? 0 : oldest
  }

  /* 候选集合（按 purpose）：declared 优先，其次 registry 已知，最后 discovered（最近见到的优先） */
  function candidateIdsFor(s, purpose) {
    const ids = []
    const declaredId = s.models.declared[purpose]
    if (declaredId) ids.push(declaredId)
    for (const id of ModelRegistry.allKnownIds()) if (ids.indexOf(id) < 0) ids.push(id)
    const discovered = (s.models.discovered || []).slice().sort((a, b) => toNum(b.lastSeenAt, 0) - toNum(a.lastSeenAt, 0))
    for (const d of discovered) if (d && typeof d.id === 'string' && ids.indexOf(d.id) < 0) ids.push(d.id)
    return ids
  }

  function discoveredMetaFor(s, id) {
    for (const d of s.models.discovered || []) if (d && d.id === id) return d
    return null
  }

  /* B4 只读候选视图（纯派生；不写盘、不联网、不迁移） */
  function candidatesView(opts) {
    const oo = opts || {}
    const s = load()
    const ts = now()
    const listedIds = s.models.listedAt > 0 ? s.models.listed : null
    const conflicts = Array.isArray(s.models.conflicts) ? s.models.conflicts : []
    const declaredMap = ModelRegistry.declared()
    const perPurposeCandidates = maxCandidatesPerPurpose
    const purposes = {}
    let totalCandidates = 0
    const truncatedPurposes = []

    for (const purpose of ModelCandidate.PURPOSES) {
      const declaredId = declaredMap[purpose] || null
      const ids = candidateIdsFor(s, purpose)
      const truncated = ids.length > perPurposeCandidates
      if (truncated) truncatedPurposes.push(purpose)
      const picked = ids.slice(0, perPurposeCandidates)
      const cands = picked.map((id) => {
        const meta = discoveredMetaFor(s, id)
        const facts = ModelCandidate.buildCandidateFacts({
          modelId: id,
          purpose,
          listedIds,
          declaredMap,
          conflicts,
          nowMs: ts,
          firstSeenAt: meta ? meta.firstSeenAt : 0,
          lastSeenAt: meta ? meta.lastSeenAt : 0,
        })
        return { facts, validation: { record: validationRecordFor(id, purpose) } }
      })
      const incumbent = cands.map((c) => c.facts).find((f) => f && f.modelId === declaredId) || null
      const incWrap = incumbent ? { facts: incumbent } : null
      const res = ModelCandidate.deriveRecommendations({
        purpose,
        declaredId,
        incumbent: incWrap,
        candidates: cands,
        nowMs: ts,
        /* P1-B：逐 (model,purpose) 解析 gate 上下文（函数形态） */
        trustCtx: (mid, p) => trustCtxFor(mid, p, ts),
      })
      const ranked = ModelCandidate.rankCandidates(cands.map((c) => ModelCandidate.evaluateCandidate({ candidate: c, purpose, nowMs: ts })))
      const rankOf = new Map(ranked.map((e, idx) => [e.modelId, idx + 1]))
      const recOf = new Map((res.recommendations || []).map((r) => [r.modelId, r]))
      const assessed = cands.map((c) => {
        const a = ModelCandidate.assessCandidate({
          purpose,
          facts: c.facts,
          validationRecord: c.validation.record,
          declaredId,
          incumbent: incWrap,
          nowMs: ts,
          supersededBy: res.winnerId && res.winnerId !== c.facts.modelId ? res.winnerId : null,
          trustCtx: (mid, p) => trustCtxFor(mid, p, ts),
        })
        const r = recOf.get(a.modelId)
        a.rank = rankOf.get(a.modelId) || null
        a.recommended = !!(r && r.recommended)
        a.recommendationReason = r ? r.reason : a.recommendationReason
        a.recommendationDetail = r ? r.reasonDetail : a.recommendationDetail
        a.recommendationWarnings = r ? r.warnings : []
        a.recommendationPolicyVersion = ModelCandidate.RECOMMENDATION_POLICY_VERSION
        return a
      })
      totalCandidates += assessed.length
      purposes[purpose] = {
        purpose,
        declaredId,
        outcome: res.outcome,
        winnerId: res.winnerId,
        recommendationReason: res.recommendationReason,
        recommendationPolicyVersion: ModelCandidate.RECOMMENDATION_POLICY_VERSION,
        migrationPolicyVersion: ModelCandidate.MIGRATION_POLICY_VERSION,
        candidates: assessed,
        truncated,
      }
    }

    return Object.assign({
      ok: true,
      evaluatedAt: ts,
      validatorVersion: ModelCandidate.VALIDATOR_VERSION,
      compatSurfaces: ModelCandidate.COMPAT_SURFACES.slice(),
      recommendationPolicyVersion: ModelCandidate.RECOMMENDATION_POLICY_VERSION,
      migrationPolicyVersion: ModelCandidate.MIGRATION_POLICY_VERSION,
      validationSchemaVersion: ModelCandidate.VALIDATION_SCHEMA_VERSION,
      autoMigrationEnabled: ModelCandidate.AUTO_MIGRATION_ENABLED,
      purposes,
      stats: {
        candidates: totalCandidates,
        discovered: (s.models.discovered || []).length,
        validatedRecords: countValidationRecords(s),
        truncatedPurposes,
      },
      cached: true,
    }, oo.extra || {})
  }

  function countValidationRecords(s) {
    let n = 0
    const v = s.models.validations || {}
    for (const id of Object.keys(v)) n += Object.keys(v[id] || {}).length
    return n
  }

  /* B4 只读验证证据视图（事实；含派生 state，便于审计） */
  function validationView() {
    const s = load()
    const ts = now()
    const records = []
    const v = s.models.validations || {}
    for (const modelId of Object.keys(v)) {
      const per = v[modelId] || {}
      for (const purpose of Object.keys(per)) {
        const rec = per[purpose]
        const st = ModelCandidate.validationStateFor(rec, { nowMs: ts })
        /* P1-B：real 的 production 判定必须走 gate（env/revision/TTL/当前记录/nonce）——
           视图不得"声明即信任"；无 ctx 时 trustOf 一律降级 compatibility */
        const gate = rec.mode === 'real' ? ModelCandidate.productionTrustFor(rec, trustCtxFor(modelId, purpose, ts)) : null
        const trust = st.valid ? (gate ? (gate.eligible ? 'production' : 'compatibility') : ModelCandidate.trustOf(rec)) : 'none'
        records.push({
          modelId,
          purpose,
          status: rec.status,
          wellFormed: rec.wellFormed === true,
          state: st.state,
          valid: st.valid === true,
          mode: ModelCandidate.MODES.indexOf(rec.mode) >= 0 ? rec.mode : null,
          trust,
          productionCompatible: trust === 'production',
          productionEligible: gate ? gate.eligible === true : trust === 'production',
          productionReasons: gate ? (gate.reasons || []).slice(0, 6) : [],
          implementationVersion: typeof rec.implementationVersion === 'string' ? rec.implementationVersion : null,
          checkSetHash: typeof rec.checkSetHash === 'string' ? rec.checkSetHash : null,
          profile: typeof rec.profile === 'string' ? rec.profile : null,
          ageMs: st.ageMs,
          checkedAt: rec.checkedAt,
          expiresAt: rec.expiresAt,
          ttlMs: rec.ttlMs,
          validatorVersion: rec.validatorVersion,
          schemaVersion: rec.schemaVersion,
          actor: rec.actor,
          error: rec.error,
          warnings: (rec.warnings || []).slice(),
          checks: (rec.checks || []).map((c) => Object.assign({}, c)),
          evidenceRefs: (rec.evidenceRefs || []).map((r) => Object.assign({}, r)),
        })
      }
    }
    records.sort((a, b) => (a.modelId < b.modelId ? -1 : (a.modelId > b.modelId ? 1 : (a.purpose < b.purpose ? -1 : 1))))
    return {
      ok: true,
      evaluatedAt: ts,
      validatorVersion: ModelCandidate.VALIDATOR_VERSION,
      compatSurfaces: ModelCandidate.COMPAT_SURFACES.slice(),
      validationSchemaVersion: ModelCandidate.VALIDATION_SCHEMA_VERSION,
      ttlMs: ModelCandidate.VALIDATION_TTL_MS,
      staleRatio: ModelCandidate.VALIDATION_STALE_RATIO,
      checkVocabulary: Object.keys(ModelCandidate.CHECK_VOCABULARY).map((id) => ({
        id,
        scope: ModelCandidate.CHECK_VOCABULARY[id].scope,
        required: ModelCandidate.CHECK_VOCABULARY[id].required,
      })),
      records,
      modes: ModelCandidate.MODES.slice(),
      trustLevels: ModelCandidate.TRUST_LEVELS.slice(),
      recommendationMinTrust: ModelCandidate.RECOMMENDATION_MIN_TRUST,
      migrationMinTrust: ModelCandidate.MIGRATION_MIN_TRUST,
      stats: {
        models: Object.keys(v).length,
        records: records.length,
        passed: records.filter((r) => r.state === 'passed').length,
        stale: records.filter((r) => r.state === 'stale').length,
        blocked: records.filter((r) => !r.valid).length,
        productionCompatible: records.filter((r) => r.productionCompatible).length,
      },
      cached: true,
    }
  }


  function compatView() {
    try {
      const c = compatInfo()
      if (!c || typeof c !== 'object') return null
      return {
        mode: typeof c.mode === 'string' ? c.mode : null,
        usable: c.usable === true,
        capabilities: c.capabilities && typeof c.capabilities === 'object' ? Object.assign({}, c.capabilities) : null,
      }
    } catch (err) { return null }
  }

  /* B1：有界审计（只记通道/动作/摘要/操作者，不记任何内容或凭据） */
  function recordAudit(entry) {
    const s = load()
    const rec = {
      at: toNum(entry && entry.at, 0) || now(),
      channel: String((entry && entry.channel) || 'unknown').slice(0, 16),
      action: String((entry && entry.action) || 'unknown').slice(0, 32),
      detail: String((entry && entry.detail) || '').slice(0, 160),
      actor: entry && entry.actor === 'user' ? 'user' : 'auto',
    }
    s.audit.push(rec)
    if (s.audit.length > maxAudit) s.audit = s.audit.slice(-maxAudit)
    s.updatedAt = now()
    scheduleSave()
    return rec
  }


  function dshRecordAudit(action, detail) {
    try {
      recordAudit({ channel: 'dsh', action: String(action || 'unknown').slice(0, 32), detail: String(detail || '').slice(0, 160), actor: 'user' })
    } catch (e) { /* ignore */ }
    return { ok: true }
  }

  /* ---------------- P1-G：DSH 生命周期持久状态（复用同一 state 文件，不新建状态系统） ---------------- */
  /** 用户是否显式停止过 DSH（显式停止后启动/向导不再自动拉起） */
  function dshUserStopped() {
    const u = load().dshRuntime
    return !!(u && u.userStopped === true)
  }
  function setDshUserStopped(v) {
    const st = load()
    const cur = st.dshRuntime && typeof st.dshRuntime === 'object' ? st.dshRuntime : {}
    st.dshRuntime = Object.assign({}, cur, { userStopped: v === true, updatedAt: now() })
    st.updatedAt = now()
    scheduleSave()
    return { ok: true, userStopped: st.dshRuntime.userStopped }
  }
  /** 本应用亲手 spawn 的 DSH 指纹（有界 8 条）：让 identity 判定可以到达 exact（含 DSH_HOME 比对） */
  function dshSpawnedRecords() {
    const u = load().dshRuntime
    const s = u && u.spawned && typeof u.spawned === 'object' ? u.spawned : {}
    const out = {}
    for (const k of Object.keys(s)) {
      const r = s[k]
      if (!r || typeof r !== 'object') continue
      out[k] = {
        binJs: typeof r.binJs === 'string' ? r.binJs : null,
        dshHome: typeof r.dshHome === 'string' ? r.dshHome : null,
        at: toNum(r.at, 0),
      }
    }
    return out
  }
  function recordDshSpawned(input) {
    const i = input && typeof input === 'object' ? input : {}
    const pid = Number(i.pid)
    if (!isFinite(pid) || pid <= 0) return { ok: false, error: 'bad_pid' }
    const st = load()
    const cur = st.dshRuntime && typeof st.dshRuntime === 'object' ? st.dshRuntime : {}
    const spawned = cur.spawned && typeof cur.spawned === 'object' ? Object.assign({}, cur.spawned) : {}
    spawned[String(pid)] = {
      binJs: typeof i.binJs === 'string' ? i.binJs : null,
      dshHome: typeof i.dshHome === 'string' ? i.dshHome : null,
      at: now(),
    }
    const keys = Object.keys(spawned)
    if (keys.length > 8) {
      keys.sort((a, b) => toNum(spawned[a] && spawned[a].at, 0) - toNum(spawned[b] && spawned[b].at, 0))
      for (const k of keys.slice(0, keys.length - 8)) delete spawned[k]
    }
    st.dshRuntime = Object.assign({}, cur, { spawned: spawned, updatedAt: now() })
    st.updatedAt = now()
    scheduleSave()
    return { ok: true, pid: pid }
  }
  function clearDshSpawnedRecords(pids) {
    const list = Array.isArray(pids) ? pids.map(String) : []
    if (!list.length) return { ok: true, cleared: 0 }
    const st = load()
    const cur = st.dshRuntime && typeof st.dshRuntime === 'object' ? st.dshRuntime : {}
    const spawned = cur.spawned && typeof cur.spawned === 'object' ? Object.assign({}, cur.spawned) : {}
    let cleared = 0
    for (const p of list) { if (spawned[p]) { delete spawned[p]; cleared++ } }
    st.dshRuntime = Object.assign({}, cur, { spawned: spawned })
    st.updatedAt = now()
    scheduleSave()
    return { ok: true, cleared: cleared }
  }


  /* 运行时信息视图（只读回显；无注入时为 null，保持既有调用方语义） */
  function runtimeInfoView() {
    try {
      const r = runtimeInfoFn()
      if (!r || typeof r !== 'object') return null
      return {
        edition: ['production', 'clean', 'test', 'dev'].indexOf(r.edition) >= 0 ? r.edition : null,
        dataDir: typeof r.dataDir === 'string' ? r.dataDir : null,
        userDataSource: typeof r.userDataSource === 'string' ? r.userDataSource.slice(0, 32) : null,
      }
    } catch (err) { return null }
  }

  function status() {
    try {
      const s = load()
      return {
        ok: true,
        registry: registryView(true),
        models: modelsView({ cached: true }),
        probe: probeView({ cached: true }),
        audit: s.audit.slice(-5).map((a) => Object.assign({}, a)),
        usage: { last: s.usage.last.slice(-5), counts: Object.assign({}, s.usage.counts) },
        stateFile: stateFile ? pathMod.basename(stateFile) : null,
        runtime: runtimeInfoView(),
        stats: { saves, saveFailures },
      }
    } catch (err) {
      return { ok: false, error: 'status_failed', registry: ModelRegistry.statusForAll({ listedIds: null }), models: null, probe: null, audit: [], usage: { last: [], counts: {} } }
    }
  }

  return {
    probeModels,
    modelDiscovery,
    candidatesView,
    validationView,
    recordValidation,
    runModelValidation,
    productionValidationPlan,
    runProductionValidation,
    recordAudit,
    dshUserStopped,
    setDshUserStopped,
    dshSpawnedRecords,
    recordDshSpawned,
    clearDshSpawnedRecords,
    dshRecordAudit,
    recordModelUse,
    status,
    readState,
    flush,
    save: saveNow,
    _config: { modelsUrl, timeoutMs, cacheTtlMs, minIntervalMs, maxDiscovered, maxLifecycle, validationMinIntervalMs, validationModelMinIntervalMs, validationWindowMs, validationWindowMax, maxValidationRatePairs },
    _stats: () => ({ saves, saveFailures }),
  }
}

module.exports = {
  createUpdateManager, classifyHttp,
  deriveDiscoveredModels, computeModelConflicts, aggregateModelRoute, maxActionLevel,
  DEFAULT_MODELS_URL, DEFAULTS,
  MODEL_CONFLICT_KINDS: [
    'catalog-empty', 'catalog-missing', 'retired-still-listed',
    'route-after-passed', 'declared-unknown', 'declared-alias', 'declared-routed',
  ],
}
