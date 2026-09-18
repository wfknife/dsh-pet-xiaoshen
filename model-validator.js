'use strict'
/*
 * DeskPet Model Validator — P1-A（Offline / Mock Model Validation Engine）
 *
 * 唯一的 ValidationRecord producer：
 *     runValidation()  →  CHECK_REGISTRY（offline + mock runners）
 *                      →  ModelCandidate.buildValidationRecord()   （唯一构造入口）
 *                      →  返回 draft（**不落盘、不限流、不审计**）
 * 落盘/限流/审计由 update-manager.runModelValidation() 负责（本模块不 require 它）。
 *
 * 硬边界（可由静态扫描证明）：
 *   ✅ require('./model-registry.js')、require('./model-candidate.js')
 *   ❌ update-manager.js / 任何文件系统 / 任何网络库 / 任何进程与 shell /
 *      渲染层 / 迁移 / declared 写入 / settings / credentials / DSH runtime
 * 全部 runner 为纯函数：时间由 nowMs 注入，fixture 为内存常量，零副作用、可重放。
 *
 * 语义铁律：
 *   offline  ≠ mock  ≠ real
 *   mock PASS → validated=true、recommended 可能为 true、**migrationEligible 永远 false**
 *   real 为保留值：本模块的引擎**不可产生**；请求 real → ok=false / real_mode_not_available
 */
const ModelRegistry = require('./model-registry.js')
const ModelCandidate = require('./model-candidate.js')

/* 执行引擎身份（**只作审计**，绝不参与 evidence 失效判定：implementation 修复/重构
   不得作废旧证据；兼容性契约变化才由 VALIDATOR_VERSION 作废）。 */
const VALIDATOR_IMPLEMENTATION_VERSION = 'impl-1.0.0'
const VALIDATOR_VERSION = ModelCandidate.VALIDATOR_VERSION
const VALIDATION_SCHEMA_VERSION = ModelCandidate.VALIDATION_SCHEMA_VERSION

/* 封闭 mock 场景枚举（任何输入都不能越过它；新增场景 = 契约变更 ⇒ 必须随 VALIDATOR_VERSION 递增） */
const MOCK_SCENARIOS = {
  direct: ['canonical', 'malformed-json', 'truncated', 'empty-body', 'http-401', 'http-429', 'timeout'],
  dsh: ['dispatch-ok', 'dispatch-denied', 'dispatch-timeout', 'permission-approved', 'permission-rejected', 'permission-timeout'],
}

/* 传输层 fixture（纯数据；**期望结果在 runner 内**，输入无法覆盖） */
const MOCK_FIXTURES = {
  direct: {
    canonical: { kind: 'direct', scenario: 'canonical', httpStatus: 200, body: 'json-ok', errorClass: null, latencyBucket: 'p50' },
    'malformed-json': { kind: 'direct', scenario: 'malformed-json', httpStatus: 200, body: 'malformed', errorClass: 'invalid_json', latencyBucket: 'p50' },
    truncated: { kind: 'direct', scenario: 'truncated', httpStatus: 200, body: 'truncated', errorClass: 'invalid_json', latencyBucket: 'p50' },
    'empty-body': { kind: 'direct', scenario: 'empty-body', httpStatus: 200, body: 'empty', errorClass: 'invalid_json', latencyBucket: 'p50' },
    'http-401': { kind: 'direct', scenario: 'http-401', httpStatus: 401, body: 'error', errorClass: 'auth', latencyBucket: 'p50' },
    'http-429': { kind: 'direct', scenario: 'http-429', httpStatus: 429, body: 'error', errorClass: 'rate_limited_remote', latencyBucket: 'p50' },
    timeout: { kind: 'direct', scenario: 'timeout', httpStatus: null, body: null, errorClass: 'timeout', latencyBucket: 'timeout' },
  },
  dsh: {
    'dispatch-ok': { kind: 'dsh', scenario: 'dispatch-ok', dispatch: 'accepted', errorClass: null, latencyBucket: 'p50' },
    'dispatch-denied': { kind: 'dsh', scenario: 'dispatch-denied', dispatch: 'denied', errorClass: 'dsh_denied', latencyBucket: 'p50' },
    'dispatch-timeout': { kind: 'dsh', scenario: 'dispatch-timeout', dispatch: 'timeout', errorClass: 'timeout', latencyBucket: 'timeout' },
    'permission-approved': { kind: 'dsh', scenario: 'permission-approved', permission: 'approved', errorClass: null, latencyBucket: 'p50' },
    'permission-rejected': { kind: 'dsh', scenario: 'permission-rejected', permission: 'rejected', errorClass: 'dsh_permission_rejected', latencyBucket: 'p50' },
    'permission-timeout': { kind: 'dsh', scenario: 'permission-timeout', permission: 'timeout', errorClass: 'timeout', latencyBucket: 'timeout' },
  },
}

/* 每个 mock 检查的**默认（正向）场景**：计划覆盖只能在此枚举内替换，期望值不可被输入覆盖 */
const DEFAULT_SCENARIO = {
  'request-shape': 'canonical',
  'response-shape': 'canonical',
  'error-classification': 'http-401',
  'dsh-dispatch': 'dispatch-ok',
  'dsh-permission-flow': 'permission-approved',
  'latency-budget': 'canonical',
}

/* 内部 HTTP 分类回退（生产路径由 update-manager 注入真实 classifyHttp） */
function internalClassifyHttp(status) {
  const s = Number(status)
  if (s === 401 || s === 403) return 'auth'
  if (s === 429) return 'rate_limited_remote'
  return 'http_' + s
}

function kindForPurpose(purpose) {
  return purpose === 'work' ? 'dsh' : 'direct'
}

function transport(kind, scenario) {
  const table = MOCK_FIXTURES[kind]
  if (!table) return null
  const fx = table[scenario]
  return fx ? Object.assign({}, fx) : null
}

function allowedScenarios(checkId, kind) {
  const k = kind === 'dsh' ? 'dsh' : 'direct'
  switch (checkId) {
    case 'dsh-dispatch': return k === 'dsh' ? ['dispatch-ok', 'dispatch-denied', 'dispatch-timeout'] : []
    case 'dsh-permission-flow': return k === 'dsh' ? ['permission-approved', 'permission-rejected', 'permission-timeout'] : []
    case 'request-shape': return k === 'direct' ? ['canonical', 'malformed-json'] : []
    case 'response-shape': return k === 'direct' ? ['canonical', 'malformed-json', 'truncated', 'empty-body'] : []
    case 'error-classification': return k === 'dsh' ? ['dispatch-denied', 'dispatch-timeout', 'permission-rejected'] : ['http-401', 'http-429', 'timeout']
    case 'latency-budget': return k === 'dsh' ? ['dispatch-ok', 'dispatch-timeout'] : ['canonical', 'timeout']
    default: return []
  }
}

/* 每个检查按传输类型选择默认（正向）场景 */
function defaultScenarioFor(checkId, kind) {
  if (kind === 'dsh') {
    if (checkId === 'error-classification') return 'dispatch-denied'
    if (checkId === 'latency-budget') return 'dispatch-ok'
  }
  return DEFAULT_SCENARIO[checkId]
}

/* ============================================================================
 * Offline runners（纯确定性检查）
 * ========================================================================= */
const FORBIDDEN_KEYS = ['apikey', 'api_key', 'authorization', 'bearer', 'token', 'cookie', 'secret', 'prompt', 'content']
function findForbidden(value, depth) {
  const d = typeof depth === 'number' ? depth : 0
  if (d > 4 || value === null || value === undefined) return null
  if (typeof value === 'string') {
    const low = value.toLowerCase()
    for (const k of FORBIDDEN_KEYS) if (low.indexOf(k) >= 0) return k
    return null
  }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 24)) { const hit = findForbidden(v, d + 1); if (hit) return hit }
    return null
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value).slice(0, 48)) {
      const low = String(k).toLowerCase()
      for (const f of FORBIDDEN_KEYS) if (low.indexOf(f) >= 0) return f
      const hit = findForbidden(value[k], d + 1)
      if (hit) return hit
    }
    return null
  }
  return null
}

const OFFLINE_RUNNERS = {
  'id-resolvable': (ctx) => {
    const known = ModelRegistry.isKnown(ctx.modelId)
    const listed = ctx.facts.listed === true
    return known || listed
      ? { status: 'pass', detail: known ? 'registry-known' : 'catalog-listed' }
      : { status: 'fail', detail: 'unresolvable-id' }
  },
  'catalog-state': (ctx) => {
    if (ctx.facts.listed === null) return { status: 'skip', detail: 'catalog-not-probed' }
    return ctx.facts.listed === true
      ? { status: 'pass', detail: 'listed' }
      : { status: 'fail', detail: 'catalog-missing' }
  },
  'purpose-binding': (ctx) => {
    if (ModelCandidate.PURPOSES.indexOf(ctx.purpose) < 0) return { status: 'fail', detail: 'unknown-purpose' }
    if (ctx.facts.purpose !== ctx.purpose) return { status: 'fail', detail: 'purpose-mismatch' }
    return { status: 'pass', detail: ctx.purpose }
  },
  'lifecycle-state': (ctx) => {
    const lc = ctx.facts.lifecycle
    if (lc === 'retired') return { status: 'fail', detail: 'retired' }
    if (lc === 'unknown') return { status: 'skip', detail: 'lifecycle-unknown' }
    return { status: 'pass', detail: lc }
  },
  'route-state': (ctx) => {
    const st = ctx.facts.routeState
    if (st === null || st === undefined) return { status: 'pass', detail: 'no-route-plan' }
    if (st === 'scheduled' || st === 'due') return { status: 'pass', detail: st }
    if (st === 'passed') return { status: 'fail', detail: 'route-already-effective' }
    return { status: 'fail', detail: 'route-invalid' }
  },
  'state-contract': (ctx) => {
    /* 探针只覆盖引擎自身能诚实产出的检查（offline/mock）；real 层由 sanitizer + production gate 约束 */
    const probeChecks = (ctx.selectedIds || [])
      .filter((id) => { const v = ModelCandidate.CHECK_VOCABULARY[id]; return !v || v.tier !== 'real' })
      .map((id) => ({ id, status: 'pass', detail: '' }))
    const probe = ModelCandidate.buildValidationRecord({
      modelId: ctx.modelId,
      purpose: ctx.purpose,
      profile: ctx.profile,
      checks: probeChecks,
      nowMs: ctx.nowMs,
      implementationVersion: VALIDATOR_IMPLEMENTATION_VERSION,
    })
    if (!probe) return { status: 'fail', detail: 'probe-build-failed' }
    const sane = ModelCandidate.sanitizeValidationRecord(probe, { purpose: ctx.purpose })
    if (!sane || sane.wellFormed !== true) return { status: 'fail', detail: 'probe-not-well-formed' }
    if (sane.checks.length > ModelCandidate.MAX_CHECKS) return { status: 'fail', detail: 'checks-unbounded' }
    if (sane.evidenceRefs.length > ModelCandidate.MAX_EVIDENCE_REFS) return { status: 'fail', detail: 'refs-unbounded' }
    const tampered = ModelCandidate.sanitizeValidationRecord(Object.assign({}, probe, { status: 'passed', checks: (probe.checks || []).map((c) => ({ id: c.id, status: 'fail', detail: '' })) }), { purpose: ctx.purpose })
    if (!tampered || tampered.status === 'passed') return { status: 'fail', detail: 'status-tamper-not-detected' }
    return { status: 'pass', detail: 'well-formed' }
  },
  'no-secret-echo': (ctx) => {
    const hit = findForbidden({
      modelId: ctx.modelId,
      purpose: ctx.purpose,
      profile: ctx.profile,
      checks: (ctx.checks || []).map((c) => ({ id: c.id, detail: c.detail })),
    })
    return hit ? { status: 'fail', detail: 'forbidden-field:' + hit } : { status: 'pass', detail: 'no-secret-shaped-field' }
  },
}

/* ============================================================================
 * Mock runners（封闭 fixture 的传输/契约检查）
 * ========================================================================= */
function classifyOf(ctx, fx) {
  if (typeof ctx.adapters.classifyHttp === 'function' && typeof fx.httpStatus === 'number') {
    try { return ctx.adapters.classifyHttp(fx.httpStatus) } catch (e) { return '__classify-error__' }
  }
  return fx.errorClass
}

function mockCheck(checkId) {
  return (ctx) => {
    const kind = kindForPurpose(ctx.purpose)
    const plan = ctx.plan && typeof ctx.plan === 'object' ? ctx.plan : {}
    const scenario = plan[checkId] === undefined ? defaultScenarioFor(checkId, kind) : plan[checkId]
    if (allowedScenarios(checkId, kind).indexOf(scenario) < 0) return { status: 'skip', detail: 'unknown-scenario:' + String(scenario) }
    const fx = transport(kind, scenario)
    if (!fx) return { status: 'skip', detail: 'unknown-scenario:' + String(scenario) }
    const pass = (d) => ({ status: 'pass', detail: d })
    const fail = (d) => ({ status: 'fail', detail: d })
    switch (checkId) {
      case 'request-shape': {
        const keys = kind === 'dsh' ? ['modelId', 'purpose', 'dispatch', 'scenario', 'profile'] : ['modelId', 'purpose', 'transport', 'scenario', 'profile']
        const shape = requestShape(ctx, fx)
        const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(shape, k))
        if (missing.length) return fail('missing-keys:' + missing.join(','))
        const bad = Object.keys(shape).filter((k) => typeof shape[k] !== 'string' || !shape[k] || shape[k].length > 64)
        if (bad.length) return fail('bad-values:' + bad.join(','))
        if (scenario !== 'canonical') return fail('non-canonical-request:' + scenario)
        return pass('shape-ok:' + scenario)
      }
      case 'response-shape': {
        if (scenario !== 'canonical') return fail('expected-parse-ok-got:' + scenario)
        for (const neg of ['malformed-json', 'truncated', 'empty-body']) {
          const nfx = transport(kind, neg)
          if (!nfx || !isRejected(nfx)) return fail('negative-not-rejected:' + neg)
        }
        return isParseable(fx) ? pass('parse-ok+negatives-rejected') : fail('canonical-not-parseable')
      }
      case 'error-classification': {
        const battery = kind === 'dsh'
          ? [['dispatch-denied', 'dsh_denied'], ['permission-rejected', 'dsh_permission_rejected'], ['dispatch-timeout', 'timeout']]
          : [['http-401', 'auth'], ['http-429', 'rate_limited_remote'], ['timeout', 'timeout']]
        for (const [sc, expect] of battery) {
          const bfx = transport(kind, sc)
          if (!bfx) return fail('missing-fixture:' + sc)
          const got = classifyOf(ctx, bfx)
          if (got !== expect) return fail('misclassified:' + sc + ':' + String(got))
        }
        return pass('battery-ok:' + scenario)
      }
      case 'dsh-dispatch': {
        if (scenario !== 'dispatch-ok') return fail('expected-accepted-got:' + String(fx.dispatch))
        return pass('dispatch-accepted')
      }
      case 'dsh-permission-flow': {
        if (scenario !== 'permission-approved') return fail('expected-approved-got:' + String(fx.permission))
        const rejected = transport(kind, 'permission-rejected')
        const timedOut = transport(kind, 'permission-timeout')
        if (!rejected || rejected.permission !== 'rejected') return fail('negative-not-rejected')
        if (!timedOut || timedOut.permission !== 'timeout') return fail('timeout-not-bounded')
        return pass('approved+negatives-ok')
      }
      case 'latency-budget': {
        if (fx.latencyBucket === 'timeout') return fail('timeout-bucket')
        return pass('bucket:' + fx.latencyBucket)
      }
      default:
        return { status: 'skip', detail: 'no-runner' }
    }
  }
}

function isParseable(fx) {
  return fx && fx.body === 'json-ok'
}
function isRejected(fx) {
  return !!(fx && (fx.errorClass === 'invalid_json' || fx.body === 'malformed' || fx.body === 'truncated' || fx.body === 'empty'))
}
function requestShape(ctx, fx) {
  if (fx.kind === 'dsh') {
    return { modelId: ctx.modelId, purpose: ctx.purpose, dispatch: String(fx.dispatch || 'accepted'), scenario: fx.scenario, profile: ctx.profile }
  }
  return { modelId: ctx.modelId, purpose: ctx.purpose, transport: 'direct-' + fx.scenario, scenario: fx.scenario, profile: ctx.profile }
}

/* ============================================================================
 * CHECK_REGISTRY：13 项（7 offline + 6 mock），与 model-candidate.js 的词汇表 1:1
 * ========================================================================= */
function runnerFor(id, mode) {
  if (mode === 'offline') return OFFLINE_RUNNERS[id] || null
  /* P1-B：real 层由 model-validator-real.js（外部执行器）提供；引擎自身不跑 real，
     只在收到 checkResults 覆盖时采用其结果，否则记 skip（⇒ required unavailable ⇒ unknown）。 */
  if (mode === 'real') return null
  return mockCheck(id)
}
const CHECK_REGISTRY = ModelCandidate.CHECK_IDS.map((id) => {
  const v = ModelCandidate.CHECK_VOCABULARY[id]
  return {
    id,
    scope: v.scope,
    required: v.required,
    mode: v.mode,
    runner: runnerFor(id, v.mode),
  }
})
const REGISTRY_IDS = CHECK_REGISTRY.map((c) => c.id).sort()
const VOCABULARY_IDS = ModelCandidate.CHECK_IDS.slice().sort()

/* 注册表自检：词汇表与注册表必须 1:1 且每项都有 runner（漂移时引擎拒绝运行，而不是静默降级） */
function registryDrift() {
  if (REGISTRY_IDS.join(',') !== VOCABULARY_IDS.join(',')) return 'id-mismatch'
  for (const c of CHECK_REGISTRY) {
    if (typeof c.runner !== 'function' && c.mode !== 'real') return 'no-runner:' + c.id
    if (typeof c.mode !== 'string' || ModelCandidate.MODES.indexOf(c.mode) < 0) return 'bad-mode:' + c.id
  }
  return null
}

/* purpose + profile + plan → 本次要执行的检查（required 一律全跑，plan 只能换 fixture 场景） */
function selectChecks(purpose, profile, plan) {
  if (ModelCandidate.PURPOSES.indexOf(purpose) < 0) return null
  const prof = ModelCandidate.PROFILES.indexOf(profile) >= 0 ? profile : 'default'
  const wanted = ModelCandidate.checksForPurpose(purpose, prof)
  const p = plan && typeof plan === 'object' ? plan : {}
  const out = []
  for (const w of wanted) {
    const reg = CHECK_REGISTRY.filter((c) => c.id === w.id)[0]
    if (!reg) return null
    out.push({
      id: reg.id,
      scope: reg.scope,
      required: reg.required,
      mode: reg.mode,
      scenario: reg.mode === 'mock' ? (p[reg.id] === undefined ? DEFAULT_SCENARIO[reg.id] : p[reg.id]) : null,
      run: reg.runner,
    })
  }
  return out
}

/* ============================================================================
 * runValidation：唯一 producer 入口
 *   输入：{ modelId, purpose, profile, plan(仅内部/测试), nowMs, listing, conflicts,
 *           declaredMap, adapters }
 *   输出：{ ok, error?, ..., draft（ValidationRecord 事实，未落盘） }
 * 不落盘、不限流、不审计；请求 real 一律拒绝。
 * ========================================================================= */
function runValidation(input) {
  const i = input || {}
  const modelId = typeof i.modelId === 'string' ? i.modelId.slice(0, 64) : ''
  const purpose = ModelCandidate.PURPOSES.indexOf(i.purpose) >= 0 ? i.purpose : null
  const profile = i.profile === undefined ? 'default' : (ModelCandidate.PROFILES.indexOf(i.profile) >= 0 ? i.profile : null)
  const nowMs = Number.isFinite(Number(i.nowMs)) ? Number(i.nowMs) : Date.now()

  if (i.mode !== undefined) {
    if (i.mode === 'real') return { ok: false, error: 'real_mode_not_available', mode: null, checks: [], draft: null }
    return { ok: false, error: 'forbidden_param', detail: 'mode', mode: null, checks: [], draft: null }
  }
  if (!modelId) return { ok: false, error: 'invalid_input', detail: 'modelId', mode: null, checks: [], draft: null }
  if (!purpose) return { ok: false, error: 'invalid_input', detail: 'purpose', mode: null, checks: [], draft: null }
  if (profile === null) return { ok: false, error: 'invalid_input', detail: 'profile', mode: null, checks: [], draft: null }
  const drift = registryDrift()
  if (drift) return { ok: false, error: 'registry_drift', detail: drift, mode: null, checks: [], draft: null }

  const listedIds = i.listing && Array.isArray(i.listing.listedIds) ? i.listing.listedIds : null
  const facts = ModelCandidate.buildCandidateFacts({
    modelId,
    purpose,
    listedIds,
    declaredMap: i.declaredMap || {},
    conflicts: Array.isArray(i.conflicts) ? i.conflicts : [],
    nowMs,
  })
  const base = { modelId, purpose, profile, plan: i.plan, nowMs, facts, adapters: i.adapters && typeof i.adapters === 'object' ? i.adapters : {} }
  const selected = selectChecks(purpose, profile, i.plan)
  if (!selected) return { ok: false, error: 'invalid_input', detail: 'selection', mode: null, checks: [], draft: null }
  if (profile === 'production' && selected.length === 0) {
    /* work 等不支持 production tier 的 purpose：拒绝，绝不产生"空 required 集合"的 passed 记录 */
    return { ok: false, error: 'production_tier_unsupported_purpose', mode: null, checks: [], draft: null }
  }

  const checks = []
  const selectedIds = selected.map((s) => s.id)
  const ctx = Object.assign({}, base, { checks: [], selectedIds })
  const overrides = i.checkResults && typeof i.checkResults === 'object' ? i.checkResults : null
  for (const s of selected) {
    let res
    const ov = overrides && overrides[s.id] ? overrides[s.id] : null
    if (ov) {
      res = ov
    } else if (typeof s.run !== 'function') {
      res = { status: 'skip', detail: 'external-executor-unavailable' }
    } else {
      try {
        res = s.run(Object.assign({}, ctx, { checks }))
      } catch (err) {
        res = { status: 'skip', detail: 'runner-error' }
      }
    }
    const status = res && ['pass', 'fail', 'skip'].indexOf(res.status) >= 0 ? res.status : 'skip'
    checks.push({ id: s.id, status, detail: typeof (res && res.detail) === 'string' ? res.detail.slice(0, ModelCandidate.MAX_DETAIL) : '', mode: s.mode, required: s.required })
  }

  const draft = ModelCandidate.buildValidationRecord({
    modelId,
    purpose,
    profile,
    checks,
    mode: i.recordMode,
    provenance: i.provenance,
    validationId: i.validationId,
    nonce: i.nonce,
    providerRevisionHash8: i.providerRevisionHash8,
    evidenceRefs: [{
      kind: i.provenance ? 'real-check-run' : 'check-run',
      ref: (i.provenance ? 'real:' : 'engine:') + (i.provenance ? 'chat.completions:v1' : VALIDATOR_IMPLEMENTATION_VERSION + ':' + profile) + ':' + (i.provenance ? String(i.providerRevisionHash8 || 'unbound') : (i.plan ? 'plan' : 'default')),
      at: nowMs,
    }],
    actor: i.actor === 'user' ? 'user' : 'auto',
    nowMs,
    implementationVersion: VALIDATOR_IMPLEMENTATION_VERSION,
  })
  if (!draft) return { ok: false, error: 'draft_failed', mode: null, checks: [], draft: null }

  return {
    ok: true,
    error: null,
    modelId,
    purpose,
    profile,
    mode: draft.mode,
    status: draft.status,
    trust: draft.mode === 'real'
      ? (ModelCandidate.productionTrustFor(draft, i.trustCtx || {}).eligible ? 'production' : 'compatibility')
      : ModelCandidate.trustOf(draft),
    productionCompatible: draft.mode === 'real'
      ? ModelCandidate.productionTrustFor(draft, i.trustCtx || {}).eligible
      : ModelCandidate.productionCompatibleOf(draft),
    productionReasons: draft.mode === 'real' ? ModelCandidate.productionTrustFor(draft, i.trustCtx || {}).reasons.slice(0, 6) : [],
    validatorVersion: draft.validatorVersion,
    implementationVersion: draft.implementationVersion,
    schemaVersion: draft.schemaVersion,
    checkSetHash: draft.checkSetHash,
    provenance: draft.provenance,
    validationId: draft.validationId,
    nonce: draft.nonce,
    providerRevisionHash8: draft.providerRevisionHash8,
    evidenceRefs: draft.evidenceRefs.slice(),
    warnings: draft.warnings.slice(),
    checks: checks.slice(),
    draft,
  }
}

module.exports = {
  VALIDATOR_IMPLEMENTATION_VERSION,
  VALIDATOR_VERSION,
  VALIDATION_SCHEMA_VERSION,
  MOCK_SCENARIOS,
  MOCK_FIXTURES,
  DEFAULT_SCENARIO,
  CHECK_REGISTRY,
  PROFILES: ModelCandidate.PROFILES,
  selectChecks,
  runValidation,
  registryDrift,
  internalClassifyHttp,
  transport,
  allowedScenarios,
  kindForPurpose,
}
