'use strict'
/*
 * DeskPet Model Candidate — Update & Compatibility Manager · B4
 * （Model Candidate Validation & Recommendation Gate）
 *
 * 资格链（单向、逐级加严）：
 *      discovered → verified → validated → recommended → migrationEligible
 *      （事实）      （事实）      （事实）   （派生）        （派生）
 *
 * 语义分离（铁律）：
 *      官方目录发现 ≠ 本地认可
 *      本地认可     ≠ 已验证兼容
 *      已验证兼容   ≠ 推荐
 *      推荐         ≠ 允许迁移
 *      任何一级     ≠ 自动执行
 *
 * 本模块**纯函数 / 零 I/O**：不联网、不读写文件、不执行进程动作、不修改 registry。
 * 时间/版本/TTL 全部通过参数注入（缺省用模块常量），因此完全 deterministic、可重放。
 * B4 **不实现真实 validator**（不调 LLM、不发请求）；只实现 ValidationRecord 的
 * 正式构建/准入（写契约）与三道门的判定。真实离线/mock 验证器属于后续阶段。
 */
const ModelRegistry = require('./model-registry.js')

/* ============================================================================
 * 版本常量 —— 全部是"资格链契约版本"，不是 UI/工具版本
 * ========================================================================= */

/* VALIDATOR_VERSION：**真正的兼容性版本**（compatibility-contract version）。
   它标识"本条 ValidationRecord 所证明的兼容性契约版本"：
   只要下列任一兼容性契约发生不兼容变更，必须递增本版本，
   历史记录随即 outdated（不构成 validated），必须重新验证：
     - DirectLLM 请求/响应契约（character / diary / expression 路径）
     - DSH 会话分派与授权/提问流契约（work 路径）
     - 结果解析 / 错误分类契约（response-shape、error-classification）
     - **check 集合本身**（required 的增删、check 语义/期望结果的变更）
   MAJOR = 不兼容变更（旧证据一律作废）；MINOR = 兼容新增；PATCH = 文档/夹具修正。
   P1-A：required 集合从 8 项扩为 13 项、error-classification 转为 mock 传输验证
        ⇒ 不兼容变更 ⇒ compat-1.0.0 → compat-2.0.0。 */
const VALIDATOR_VERSION = 'compat-3.0.0'
const COMPAT_SURFACES = [
  'directllm.request',
  'directllm.response',
  'dsh.dispatch',
  'dsh.permission',
]

const VALIDATION_SCHEMA_VERSION = 3
const RECOMMENDATION_POLICY_VERSION = 'rec-1.0.0'
const MIGRATION_POLICY_VERSION = 'mig-3.0.0'

/* 执行引擎身份：由 producer（model-validator.js）填写，**只作审计**，
   绝不参与 validationStateFor 的过期/失效判定（implementation bugfix 不得作废旧证据）。
   手工构造的记录（测试/夹具）用 'impl-unknown'。 */
const UNKNOWN_IMPLEMENTATION_VERSION = 'impl-unknown'

/* mode（事实）：证据是怎么产生的；trust（派生）由 mode 映射得到，禁止自由写入。 */
const MODES = ['offline', 'mock', 'real']
const TRUST_BY_MODE = { offline: 'structural', mock: 'compatibility', real: 'production' }
const TRUST_RANK = { none: 0, structural: 1, compatibility: 2, production: 3 }
const TRUST_LEVELS = Object.keys(TRUST_RANK)
/* 推荐至少需要 compatibility（mock）；迁移至少需要 production（real）。
   因此 offline ⇒ 不可推荐；mock ⇒ 可推荐；任何非 real ⇒ 不可迁移。 */
const RECOMMENDATION_MIN_TRUST = 'compatibility'
const MIGRATION_MIN_TRUST = 'production'
const PROFILES = ['default', 'offline-only', 'production']

/* 验证有效期：30 天；超过 50% 视为 stale（仍有效，只加 warning），超过 TTL 视为 expired（无效） */
const VALIDATION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/* P1-B：production 证据 TTL = 7 天（短于 mock/offline 的 30 天） */
const PRODUCTION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/* production 必备的故障注入类别数（auth/quota/timeout/network） */
const PRODUCTION_FAULT_INJECTIONS = 4
const VALIDATION_STALE_RATIO = 0.5

/* 有界化常量（持久事实与 view 都不得无界增长） */
const MAX_CHECKS = 24 /* P1-B：production profile 需要 19 项（离线7+mock4+real8），仍为有界 */
const MAX_EVIDENCE_REFS = 8
const MAX_WARNINGS = 8
const MAX_DETAIL = 160
const MAX_ERROR = 120
const MAX_VALIDATION_MODELS = 32
const MAX_CANDIDATES_PER_PURPOSE = 16

/* 硬闸：迁移永不自动执行（与 model-registry.js 的同名常量语义一致） */
const AUTO_MIGRATION_ENABLED = false

const PURPOSES = ['character', 'diary', 'expression', 'work']

/* 推荐目标生命周期：只有 GA 可作为"迁移目标"；alias/routed 只作迁移来源，
   retired/unknown 永不作目标。 */
const LIFECYCLE_TARGETS = ['ga']
const LIFECYCLE_RANK = { ga: 3, routed: 2, alias: 1, retired: 0, unknown: 0 }

const VALIDATION_STATES = ['missing', 'malformed', 'unknown', 'failed', 'outdated', 'expired', 'stale', 'passed']

/* 事实侧冲突中会阻断"该候选"的 kind（声明侧冲突只触发换签，不阻断候选） */
const BLOCKING_CONFLICT_KINDS = ['catalog-empty', 'catalog-missing', 'retired-still-listed', 'route-after-passed']

const REASON_CODES = [
  'ok', 'incumbent-ok', 'already-declared', 'no-candidate',
  'not-verified', 'not-validated', 'not-a-target-lifecycle', 'catalog-not-listed',
  'purpose-mismatch', 'conflict', 'missing-candidate',
  'trust-below-recommendation',
]
const BLOCKER_CODES = [
  'not-recommended', 'candidate-missing', 'candidate-not-verified', 'candidate-not-validated',
  'candidate-not-in-catalog', 'candidate-requires-action', 'purpose-mismatch',
  'unresolved-conflict', 'route-not-effective', 'incumbent-unresolvable', 'auto-migration-not-authorized',
  'validation-not-production-grade',
]
const WARNING_CODES = [
  'auto-apply-disabled', 'validation-stale', 'route-scheduled', 'route-due', 'route-passed',
  'candidate-listed-but-unverified', 'incumbent-alias', 'incumbent-routed', 'incumbent-unlisted',
  'incumbent-requires-action', 'policy-version-bumped',
]

/* 声明式检查词汇表（数据，不是执行器）。P1-A：13 项，含 mode（执行方式）。
   scope: all | direct（character/diary/expression）| work
   mode : offline（纯确定性结构检查）| mock（封闭 fixture 的传输/契约检查）
   required=true 的检查缺失/跳过/不可用 ⇒ unknown；任一 required 失败 ⇒ failed。 */
const CHECK_VOCABULARY = {
  'id-resolvable': { scope: 'all', required: true, mode: 'offline' },
  'catalog-state': { scope: 'all', required: true, mode: 'offline' },
  'purpose-binding': { scope: 'all', required: true, mode: 'offline' },
  'lifecycle-state': { scope: 'all', required: true, mode: 'offline' },
  'route-state': { scope: 'all', required: true, mode: 'offline' },
  'state-contract': { scope: 'all', required: true, mode: 'offline' },
  'no-secret-echo': { scope: 'all', required: true, mode: 'offline' },
  'request-shape': { scope: 'direct', required: true, mode: 'mock' },
  'response-shape': { scope: 'direct', required: true, mode: 'mock' },
  'error-classification': { scope: 'all', required: true, mode: 'mock' },
  'dsh-dispatch': { scope: 'work', required: true, mode: 'mock' },
  'dsh-permission-flow': { scope: 'work', required: true, mode: 'mock' },
  'latency-budget': { scope: 'all', required: false, mode: 'mock' },
  /* ---- P1-B：real 层（仅 production profile 选取；runner 由 model-validator-real.js 提供）---- */
  'real-request': { scope: 'direct', required: true, mode: 'real', tier: 'real' },
  'real-response-binding': { scope: 'direct', required: true, mode: 'real', tier: 'real' },
  'real-auth-classification': { scope: 'all', required: true, mode: 'real', tier: 'real' },
  'real-quota-classification': { scope: 'all', required: true, mode: 'real', tier: 'real' },
  'real-timeout-classification': { scope: 'all', required: true, mode: 'real', tier: 'real' },
  'real-network-classification': { scope: 'all', required: true, mode: 'real', tier: 'real' },
  'real-no-secret-echo': { scope: 'all', required: true, mode: 'real', tier: 'real' },
  'real-latency-bucket': { scope: 'all', required: false, mode: 'real', tier: 'real' },
}
const CHECK_IDS = Object.keys(CHECK_VOCABULARY)

/* ============================================================================
 * 小工具（纯）
 * ========================================================================= */
function isPurpose(p) { return PURPOSES.indexOf(p) >= 0 }

function msOf(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}
function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : null
}
function oneOf(v, list, dflt) {
  return list.indexOf(v) >= 0 ? v : dflt
}
function uniq(list) {
  const seen = new Set()
  const out = []
  for (const x of list) { if (seen.has(x)) continue; seen.add(x); out.push(x) }
  return out
}

/* 某 purpose 适用的检查表（含 required 标记） */
function checksForPurpose(purpose, profile) {
  const prof = PROFILES.indexOf(profile) >= 0 ? profile : 'default'
  /* P1-B：work 暂不支持 production tier（真实 DSH 会话留待 P1-B2） */
  if (prof === 'production' && purpose === 'work') return []
  const out = []
  for (const id of Object.keys(CHECK_VOCABULARY)) {
    const v = CHECK_VOCABULARY[id]
    if (v.tier === 'real' && prof !== 'production') continue
    if (prof === 'offline-only' && v.mode !== 'offline') continue
    if (v.scope === 'all') out.push({ id, required: v.required, mode: v.mode, scope: v.scope })
    else if (v.scope === 'direct' && purpose !== 'work') out.push({ id, required: v.required, mode: v.mode, scope: v.scope })
    else if (v.scope === 'work' && purpose === 'work') out.push({ id, required: v.required, mode: v.mode, scope: v.scope })
  }
  return out
}

/* ============================================================================
 * 验证证据模型（事实）：构建（写契约）→ 准入 sanitize → 状态求值
 * ========================================================================= */

/* 确定性 32-bit FNV-1a（不依赖 crypto / 任何 I/O），用于 checkSetHash 指纹 */
function hash32Hex(input) {
  const s = String(input == null ? '' : input)
  let h = 0x811c9dc5
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ('00000000' + h.toString(16)).slice(-8)
}

/* 实际执行的 required 检查集指纹（可由记录本身复算 ⇒ 可验证，防伪造） */
function checkSetHashFor(checks, purpose, profile) {
  const executed = new Set((Array.isArray(checks) ? checks : []).map((c) => (c && typeof c.id === 'string' ? c.id : null)).filter(Boolean))
  const parts = checksForPurpose(purpose, profile)
    .filter((v) => v.required && executed.has(v.id))
    .map((v) => v.id + ':' + v.mode)
    .sort()
  return 'cs-' + hash32Hex(parts.join('|'))
}

const MODE_RANK = { offline: 0, mock: 1, real: 2 }
const MODE_NAMES = ['offline', 'mock', 'real']

/* mode 由**实际执行的 required 检查**推导：取其中**最强**者（覆盖越广，证据等级越高）。
   安全性来自另一侧：任何 required 缺失/跳过/不可用都会把 status 降为 unknown
   （⇒ trust='none'），因此”漏跑 mock 检查却拿 compatibility“不可能发生。 */
function derivedMode(checks, purpose, profile) {
  const executed = new Set((Array.isArray(checks) ? checks : []).map((c) => (c && typeof c.id === 'string' ? c.id : null)).filter(Boolean))
  let rank = null
  for (const v of checksForPurpose(purpose, profile)) {
    if (!v.required || !executed.has(v.id)) continue
    const r = MODE_RANK[v.mode] == null ? 0 : MODE_RANK[v.mode]
    if (rank === null || r > rank) rank = r
  }
  return rank === null ? MODE_NAMES[0] : MODE_NAMES[rank]
}

/* trust（**派生**，绝不落盘）：mode × status。
   只有 status==='passed' 才有信任等级；mock 永远到不了 production。 */
function trustOf(record, ctx) {
  if (!record || typeof record !== 'object') return 'none'
  if (record.status !== 'passed') return 'none'
  if (record.mode === 'real') {
    /* P1-B：real 的 trust **只能**由 production gate 决定。
       ctx 缺失（调用方漏传上下文）时**绝不**回落为 production —— 否则等价于"声明即信任"；
       缺失一律降级为 compatibility（表示"未过生产门"，不代表失败）。 */
    if (!ctx || typeof ctx !== 'object') return 'compatibility'
    const gated = productionTrustFor(record, ctx)
    return gated.eligible ? 'production' : 'compatibility'
  }
  const t = TRUST_BY_MODE[record.mode]
  return t || 'none'
}

function productionCompatibleOf(record, ctx) {
  return trustOf(record, ctx) === 'production'
}

/* P1-B：环境指纹（16 hex，绝不含 secret） */
function envFingerprintFor(env) {
  const e = env || {}
  const material = [e.endpoint, e.purpose, e.modelId, e.keyIdHash8, e.appVersion, e.dshCompatVersion, e.checkSetHash, e.providerRevisionHash8]
    .map((x) => String(x == null ? '' : x)).join('|')
  return hash32Hex(material) + hash32Hex(material + '|v2')
}

/* P1-B：production trust 的唯一判定路径（纯函数、无 I/O、时间注入）。
   必须同时满足：mode=real / executor=real-validator / realRequests>=1 / 故障注入完整 /
   status=passed / version 当前 / schema 当前 / checkSetHash 当前 / envFingerprint 匹配 /
   providerRevisionHash8 绑定且与当前观测一致 / production TTL 未过期 /
   是该 model+purpose 的当前有效记录（防重放）/ nonce 未重放。 */
function productionTrustFor(record, ctx) {
  const o = ctx || {}
  const nowMs = msOf(o.nowMs, Date.now())
  const reasons = []
  if (!record || typeof record !== 'object') {
    return { eligible: false, reasons: ['no-record'], trust: 'none', productionCompatible: false, ttlMs: PRODUCTION_TTL_MS, ageMs: null, expiresAt: null }
  }
  if (record.status !== 'passed') reasons.push('status:' + record.status)
  if (record.mode !== 'real') reasons.push('mode:' + (record.mode || 'none'))
  if (record.profile !== 'production') reasons.push('profile:' + (record.profile || 'none'))
  const st = validationStateFor(record, { nowMs })
  if (!st.valid) reasons.push('state:' + st.state)
  const pv = sanitizeProvenance(record.provenance)
  if (!pv || pv.executor !== 'real-validator') reasons.push('executor')
  if (!pv || !(Number(pv.realRequests) >= 1)) reasons.push('real-request-missing')
  const minFaults = msOf(o.policy && o.policy.minFaultInjections, PRODUCTION_FAULT_INJECTIONS)
  if (!pv || !(Number(pv.faultInjections) >= minFaults)) reasons.push('fault-injection-incomplete')
  if (typeof record.validationId !== 'string' || !record.validationId) reasons.push('no-validation-id')
  if (typeof record.nonce !== 'string' || !record.nonce) reasons.push('no-nonce')
  if (typeof record.providerRevisionHash8 !== 'string' || !record.providerRevisionHash8) reasons.push('provider-revision-unbound')
  if (record.validatorVersion !== VALIDATOR_VERSION) reasons.push('validator-outdated')
  if (msOf(record.schemaVersion, 0) < VALIDATION_SCHEMA_VERSION) reasons.push('schema-outdated')
  const expHash = checkSetHashFor(record.checks, record.purpose, 'production')
  if (record.checkSetHash !== expHash) reasons.push('check-set-mismatch')
  const env = o.env || {}
  const expFp = env.envFingerprint || envFingerprintFor({
    endpoint: env.endpoint, purpose: record.purpose, modelId: record.modelId,
    keyIdHash8: env.keyIdHash8, appVersion: env.appVersion,
    dshCompatVersion: env.dshCompatVersion, checkSetHash: expHash,
    providerRevisionHash8: record.providerRevisionHash8,
  })
  if (pv && pv.envFingerprint !== expFp) reasons.push('env-fingerprint-mismatch')
  /* P1-B（红队加固）：**当前观测**必须存在且与记录一致。
     仅"记录缺 revision"不够 —— 观测缺失（不可知）时若放行，等于让"记录自称"通过；
     观测不可知 ⇒ production-env-unbound（与冻结设计的 secure-by-default 语义一致）。 */
  if (!env.providerRevisionHash8) reasons.push('production-env-unbound')
  else if (env.providerRevisionHash8 !== record.providerRevisionHash8) reasons.push('provider-revision-mismatch')
  const ttl = msOf(o.policy && o.policy.ttlMs, PRODUCTION_TTL_MS)
  if (record.checkedAt && nowMs > msOf(record.checkedAt, 0) + ttl) reasons.push('production-ttl-expired')
  const cur = o.currentRecord
  if (!cur || typeof cur !== 'object') reasons.push('no-current-record')
  else if (cur.validationId !== record.validationId || cur.nonce !== record.nonce) reasons.push('not-current-record')
  /* 身份 = (validationId, nonce)；**内容锚** = checkSetHash / checkedAt / providerRevisionHash8。
     身份对相同但内容不同的"复制记录"不得继承 production —— 否则复制一条记录即可伪造证据。
     （逐字节完全相同的克隆在无签名的本地 state 下不可区分，见红队报告"已知边界"：
       它与当前记录同判定，且不带来任何额外权限。） */
  if (cur && typeof cur === 'object' &&
      cur.validationId === record.validationId && cur.nonce === record.nonce &&
      (cur.checkSetHash !== record.checkSetHash ||
       msOf(cur.checkedAt, 0) !== msOf(record.checkedAt, 0) ||
       (cur.providerRevisionHash8 || null) !== (record.providerRevisionHash8 || null))) {
    reasons.push('not-current-record')
  }
  const used = (Array.isArray(o.usedNonces) ? o.usedNonces : [])
    .map((x) => (typeof x === 'string' ? { nonce: x, validationId: null } : (x && typeof x === 'object' ? x : null)))
    .filter(Boolean)
  /* nonce 复用（同一 nonce 绑定到别的 validationId） */
  if (used.some((x) => x.nonce === record.nonce && x.validationId && record.validationId && x.validationId !== record.validationId)) reasons.push('nonce-replay')
  /* validationId 复用（同一 validationId 绑定到别的 nonce） */
  if (used.some((x) => x.validationId && x.validationId === record.validationId && x.nonce && x.nonce !== record.nonce)) reasons.push('validation-id-replay')
  /* 非当前记录复用已用 nonce */
  if (used.some((x) => x.nonce === record.nonce) && (!cur || cur.nonce !== record.nonce)) reasons.push('nonce-replay')
  const eligible = reasons.length === 0
  return {
    eligible, reasons,
    trust: eligible ? 'production' : 'compatibility',
    productionCompatible: eligible,
    ttlMs: ttl, ageMs: st.ageMs, expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : null,
  }
}

/* P1-B：provenance 白名单（事实，绝不含 key/正文/原始错误） */
function sanitizeProvenance(p) {
  if (!p || typeof p !== 'object') return null
  const out = {
    executor: p.executor === 'real-validator' ? 'real-validator' : null,
    realRequests: Math.max(0, Math.min(8, msOf(p.realRequests, 0))),
    faultInjections: Math.max(0, Math.min(16, msOf(p.faultInjections, 0))),
    endpoint: str(p.endpoint, 96),
    envFingerprint: str(p.envFingerprint, 16),
    keyIdHash8: str(p.keyIdHash8, 8),
    appVersion: str(p.appVersion, 32),
    dshCompatVersion: str(p.dshCompatVersion, 32),
    servedModel: str(p.servedModel, 64),
    providerRevisionSource: str(p.providerRevisionSource, 40),
    providerRequestIdHash8: str(p.providerRequestIdHash8, 8),
    latencyBucket: str(p.latencyBucket, 16),
    finishReason: str(p.finishReason, 16),
    responseLengthBucket: str(p.responseLengthBucket, 16),
  }
  if (!out.executor) return null
  return out
}

/* 写契约：**唯一**能产生 ValidationRecord 的入口。
   status 由 checks 计算得出，调用方无法直接指定；
   任一 required 失败 ⇒ failed；任一 required 缺失/跳过 ⇒ unknown；全部 required 通过 ⇒ passed。
   mode/checkSetHash 由实际执行的 required 检查推导，调用方只能提供 audit 用的 implementationVersion/profile。 */
function buildValidationRecord(input) {
  const i = input || {}
  const modelId = str(i.modelId, 64)
  const purpose = i.purpose
  if (!modelId || !isPurpose(purpose)) return null
  const nowMs = msOf(i.nowMs, Date.now())
  const ttlMs = Math.max(1000, msOf(i.ttlMs, VALIDATION_TTL_MS))
  const validatorVersion = str(i.validatorVersion, 32) || VALIDATOR_VERSION

  const checks = []
  const warnings = []
  const rawChecks = Array.isArray(i.checks) ? i.checks.slice(0, MAX_CHECKS) : []
  for (const c of rawChecks) {
    if (!c || typeof c !== 'object') continue
    const id = str(c.id, 32)
    if (!id) continue
    checks.push({
      id,
      status: oneOf(c.status, ['pass', 'fail', 'skip'], 'skip'),
      detail: str(c.detail, MAX_DETAIL) || '',
    })
  }
  const profile = oneOf(i.profile, PROFILES, 'default')
  const vocab = checksForPurpose(purpose, profile)
  const byId = new Map()
  for (const c of checks) if (!byId.has(c.id)) byId.set(c.id, c)
  let failed = false
  let unknown = false
  for (const v of vocab) {
    if (!v.required) continue
    const c = byId.get(v.id)
    if (!c) { unknown = true; continue }
    if (c.status === 'fail') failed = true
    else if (c.status !== 'pass') unknown = true
  }
  for (const c of checks) {
    const v = CHECK_VOCABULARY[c.id]
    if (v && !v.required && c.status === 'fail') warnings.push('check-failed:' + c.id)
    if (!v) warnings.push('unknown-check:' + c.id)
  }
  const status = failed ? 'failed' : (unknown ? 'unknown' : 'passed')

  const evidenceRefs = []
  const rawRefs = Array.isArray(i.evidenceRefs) ? i.evidenceRefs.slice(0, MAX_EVIDENCE_REFS) : []
  for (const r of rawRefs) {
    if (!r || typeof r !== 'object') continue
    const kind = str(r.kind, 24)
    const ref = str(r.ref, 120)
    if (!kind || !ref) continue
    evidenceRefs.push({ kind, ref, at: msOf(r.at, nowMs) })
  }

  const error = str(i.error, MAX_ERROR) ||
    (status === 'failed' ? 'validation-failed' : (status === 'unknown' ? 'validation-incomplete' : null))

  /* mode / checkSetHash：由实际执行的 required 检查推导（调用方不可指定更强值） */
  /* 显式合法的 mode（保留值 real 供未来真实验证器/夹具）；否则按已执行 required 检查推导。
     IPC/引擎都不会传入更强者：IPC 直接拒绝 mode 参数，引擎永不产生 real。 */
  const mode = MODES.indexOf(i.mode) >= 0 ? i.mode : derivedMode(checks, purpose, profile)
  const checkSetHash = checkSetHashFor(checks, purpose, profile)
  const implementationVersion = str(i.implementationVersion, 40) || UNKNOWN_IMPLEMENTATION_VERSION
  /* P1-B：real 层事实（仅由 real 执行器提供；sanitizer 会反伪造校验） */
  const provenance = sanitizeProvenance(i.provenance)
  const validationId = str(i.validationId, 48)
  const nonce = str(i.nonce, 32)
  const providerRevisionHash8 = str(i.providerRevisionHash8, 16)

  return {
    kind: 'model-candidate',
    modelId,
    purpose,
    status,
    checkedAt: nowMs,
    expiresAt: nowMs + ttlMs,
    ttlMs,
    validatorVersion,
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    mode,
    implementationVersion,
    checkSetHash,
    profile,
    provenance,
    validationId,
    nonce,
    providerRevisionHash8,
    checks,
    evidenceRefs,
    warnings: uniq(warnings).slice(0, MAX_WARNINGS),
    error,
    actor: i.actor === 'user' ? 'user' : 'auto',
    wellFormed: true,
  }
}

/* 准入 sanitize：只保留白名单字段 + 有界；**永不信任输入 status**（按 checks 重算），
   结构不合法时降级为 wellFormed=false / status=unknown（保留给审计看，但绝不计入 validated）。 */
function sanitizeValidationRecord(record, opts) {
  const o = opts || {}
  if (!record || typeof record !== 'object') return null
  const modelId = str(record.modelId, 64)
  const purpose = oneOf(record.purpose, PURPOSES, isPurpose(o.purpose) ? o.purpose : 'character')
  if (!modelId) return null
  const ttlMs = Math.max(1000, msOf(record.ttlMs, msOf(o.ttlMs, VALIDATION_TTL_MS)))
  const checkedAt = msOf(record.checkedAt, 0)
  const expiresAt = msOf(record.expiresAt, checkedAt ? checkedAt + ttlMs : 0)

  const checks = []
  const rawChecks = Array.isArray(record.checks) ? record.checks.slice(0, MAX_CHECKS) : []
  for (const c of rawChecks) {
    if (!c || typeof c !== 'object') continue
    const id = str(c.id, 32)
    if (!id) continue
    checks.push({ id, status: oneOf(c.status, ['pass', 'fail', 'skip'], 'skip'), detail: str(c.detail, MAX_DETAIL) || '' })
  }
  const evidenceRefs = []
  const rawRefs = Array.isArray(record.evidenceRefs) ? record.evidenceRefs.slice(0, MAX_EVIDENCE_REFS) : []
  for (const r of rawRefs) {
    if (!r || typeof r !== 'object') continue
    const kind = str(r.kind, 24)
    const ref = str(r.ref, 120)
    if (!kind || !ref) continue
    evidenceRefs.push({ kind, ref, at: msOf(r.at, 0) })
  }
  const validatorVersion = str(record.validatorVersion, 32)
  const schemaVersion = msOf(record.schemaVersion, 0)
  const implementationVersion = str(record.implementationVersion, 40) || UNKNOWN_IMPLEMENTATION_VERSION
  const profile = oneOf(record.profile, PROFILES, 'default')

  /* 以 checks 重算状态：不接受调用方声明的 status */
  const vocab = checksForPurpose(purpose, profile)
  const byId = new Map()
  for (const c of checks) if (!byId.has(c.id)) byId.set(c.id, c)
  let failed = false
  let unknown = false
  for (const v of vocab) {
    if (!v.required) continue
    const c = byId.get(v.id)
    if (!c) { unknown = true; continue }
    if (c.status === 'fail') failed = true
    else if (c.status !== 'pass') unknown = true
  }
  const computed = failed ? 'failed' : (unknown ? 'unknown' : 'passed')

  /* mode：非法值 ⇒ 降级为推导值并标 malformed（伪造更强 mode 不可能得逞） */
  const providedMode = record.mode
  const mode = oneOf(providedMode, MODES, derivedMode(checks, purpose, profile))
  /* checkSetHash：必须能由记录本身复算一致（伪造/漂移 ⇒ malformed） */
  const recomputedHash = checkSetHashFor(checks, purpose, profile)
  const providedHash = str(record.checkSetHash, 32)

  const provenance = sanitizeProvenance(record.provenance)
  const validationId = str(record.validationId, 48)
  const nonce = str(record.nonce, 32)
  const providerRevisionHash8 = str(record.providerRevisionHash8, 16)

  const problems = []
  if (!vocab.length) problems.push('no-required-checks-for-profile')
  if (!checks.length) problems.push('no-checks')
  if (!checkedAt) problems.push('no-checked-at')
  if (!validatorVersion) problems.push('no-validator-version')
  if (!schemaVersion) problems.push('no-schema-version')
  if (providedMode !== undefined && providedMode !== null && MODES.indexOf(providedMode) < 0) problems.push('invalid-mode:' + providedMode)
  if (providedHash && providedHash !== recomputedHash) problems.push('check-set-hash-mismatch')
  /* P1-B：real 证据反伪造 —— mode=real 必须由 real-validator 执行器产生且带完整 provenance */
  if (providedMode === 'real') {
    if (!provenance || provenance.executor !== 'real-validator') problems.push('real-executor-missing')
    if (!provenance || !(Number(provenance.realRequests) >= 1)) problems.push('real-request-missing')
    if (!provenance || !(Number(provenance.faultInjections) >= PRODUCTION_FAULT_INJECTIONS)) problems.push('real-fault-injection-incomplete')
    if (!validationId) problems.push('no-validation-id')
    if (!nonce) problems.push('no-nonce')
    if (!providerRevisionHash8) problems.push('no-provider-revision')
    if (!provenance || !provenance.envFingerprint) problems.push('no-env-fingerprint')
  }
  if (oneOf(record.status, ['passed', 'failed', 'unknown'], null) !== null && record.status !== computed) {
    problems.push('status-mismatch:' + record.status + '!=' + computed)
  }
  const wellFormed = problems.length === 0

  return {
    kind: 'model-candidate',
    modelId,
    purpose,
    status: wellFormed ? computed : (computed === 'failed' ? 'failed' : 'unknown'),
    checkedAt,
    expiresAt,
    ttlMs,
    validatorVersion: validatorVersion || VALIDATOR_VERSION,
    schemaVersion: schemaVersion || VALIDATION_SCHEMA_VERSION,
    mode,
    implementationVersion,
    checkSetHash: recomputedHash,
    profile,
    provenance,
    validationId,
    nonce,
    providerRevisionHash8,
    checks,
    evidenceRefs,
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((w) => typeof w === 'string').map((w) => w.slice(0, 48)).slice(0, MAX_WARNINGS) : [],
    error: wellFormed ? (str(record.error, MAX_ERROR) || null) : ('malformed:' + problems.join(',')),
    actor: record.actor === 'user' ? 'user' : 'auto',
    wellFormed,
  }
}

/* 有效验证状态（纯、时间注入）。
   优先级：malformed > unknown/failed > outdated > expired > stale > passed */
function validationStateFor(record, opts) {
  const o = opts || {}
  const nowMs = msOf(o.nowMs, Date.now())
  const validatorVersion = str(o.validatorVersion, 32) || VALIDATOR_VERSION
  const ttlMs = Math.max(1000, msOf(o.ttlMs, VALIDATION_TTL_MS))
  if (!record || typeof record !== 'object') return { state: 'missing', valid: false, ageMs: null, effectiveAt: null }
  const ageMs = record.checkedAt ? nowMs - record.checkedAt : null
  const effectiveAt = record.checkedAt || null
  if (record.wellFormed === false) return { state: 'malformed', valid: false, ageMs, effectiveAt }
  if (record.status === 'failed') return { state: 'failed', valid: false, ageMs, effectiveAt }
  if (record.status === 'unknown') return { state: 'unknown', valid: false, ageMs, effectiveAt }
  if (record.validatorVersion !== validatorVersion || msOf(record.schemaVersion, 0) < VALIDATION_SCHEMA_VERSION) {
    return { state: 'outdated', valid: false, ageMs, effectiveAt }
  }
  const expiry = msOf(record.expiresAt, record.checkedAt ? record.checkedAt + ttlMs : 0)
  if (!expiry || nowMs > expiry) return { state: 'expired', valid: false, ageMs, effectiveAt }
  if (ageMs !== null && ageMs > ttlMs * VALIDATION_STALE_RATIO) return { state: 'stale', valid: true, ageMs, effectiveAt }
  return { state: 'passed', valid: true, ageMs, effectiveAt }
}

/* ============================================================================
 * 事实层：候选事实（来自 B3 registry + 对账结果，只读）
 * ========================================================================= */
function buildCandidateFacts(input) {
  const i = input || {}
  const modelId = String(i.modelId || '')
  const purpose = isPurpose(i.purpose) ? i.purpose : null
  const nowMs = msOf(i.nowMs, Date.now())
  const listedIds = Array.isArray(i.listedIds) ? i.listedIds : null
  const st = ModelRegistry.statusFor(modelId, { listedIds, nowMs })
  const declaredFor = purpose && i.declaredMap ? i.declaredMap[purpose] : null
  const conflicts = Array.isArray(i.conflicts)
    ? i.conflicts.filter((c) => c && typeof c === 'object' && (c.id === modelId || !c.id))
    : []
  return {
    modelId,
    purpose,
    known: st.known === true,
    lifecycle: st.lifecycle,
    state: st.state,
    listed: st.listed,
    listedButUnverified: st.listedButUnverified === true,
    verified: st.verified === true,
    trusted: st.trusted === true,
    lifecycleTarget: typeof st.recommended === 'string' ? st.recommended : null,
    actionRequired: st.actionRequired,
    routeState: st.routeState,
    routeDue: st.routeDue,
    routeAfter: st.routeAfter,
    conflicts,
    source: declaredFor === modelId ? 'declared' : (st.known ? 'registry-known' : 'discovered'),
    declared: declaredFor === modelId,
    firstSeenAt: msOf(i.firstSeenAt, 0),
    lastSeenAt: msOf(i.lastSeenAt, 0),
  }
}

/* P1-B：trustCtx 支持「对象」或「(modelId, purpose) => ctx」函数形态。
   production gate 的上下文是**逐 (model,purpose)** 的（currentRecord / env / nonce 集合），
   集合级调用（deriveRecommendation*）必须能按候选分别解析：
   否则 real 记录会被一律降级为 compatibility（安全但误报），
   或更糟 —— 被当作免检的 production。 */
function resolveTrustCtx(trustCtx, modelId, purpose) {
  if (typeof trustCtx === 'function') {
    try { return trustCtx(modelId, purpose) || null } catch (e) { return null }
  }
  return trustCtx && typeof trustCtx === 'object' ? trustCtx : null
}

/* ============================================================================
 * 门 1：候选验证评估（validated 事实 → 是否有效）
 * ========================================================================= */
function validateCandidate(input) {
  const i = input || {}
  const facts = i.facts || buildCandidateFacts(i)
  const nowMs = msOf(i.nowMs, Date.now())
  const validatorVersion = str(i.validatorVersion, 32) || VALIDATOR_VERSION
  const ttlMs = Math.max(1000, msOf(i.ttlMs, VALIDATION_TTL_MS))
  const record = i.validationRecord || i.validation || null
  const st = validationStateFor(record, { nowMs, validatorVersion, ttlMs })
  const reasons = []
  if (st.state === 'missing') reasons.push('validation-missing')
  if (st.state === 'malformed') reasons.push('validation-malformed')
  if (st.state === 'unknown') reasons.push('validation-unknown')
  if (st.state === 'failed') reasons.push('validation-failed')
  if (st.state === 'expired') reasons.push('validation-expired')
  if (st.state === 'outdated') reasons.push('validation-outdated')
  if (st.state === 'stale') reasons.push('validation-stale')
  /* P1-B：real 的 trust **只能**由 production gate 给出；无 ctx ⇒ trustOf 一律降级 compatibility */
  const trustCtx = resolveTrustCtx(i.trustCtx, facts && facts.modelId, facts && facts.purpose)
  const trust = st.valid ? trustOf(record, trustCtx) : 'none'
  const productionGate = trustCtx && record ? productionTrustFor(record, Object.assign({}, trustCtx, { nowMs })) : null
  return {
    modelId: facts.modelId,
    purpose: facts.purpose,
    facts,
    validation: {
      state: st.state,
      valid: st.valid === true,
      mode: record && MODES.indexOf(record.mode) >= 0 ? record.mode : null,
      trust,
      productionCompatible: trust === 'production',
      productionReasons: productionGate ? productionGate.reasons.slice(0, 6) : [],
      implementationVersion: record && typeof record.implementationVersion === 'string' ? record.implementationVersion : null,
      checkSetHash: record && typeof record.checkSetHash === 'string' ? record.checkSetHash : null,
      checkedAt: record && msOf(record.checkedAt, 0) ? msOf(record.checkedAt, 0) : null,
      expiresAt: record && msOf(record.expiresAt, 0) ? msOf(record.expiresAt, 0) : null,
      ageMs: st.ageMs,
      validatorVersion: record ? record.validatorVersion : null,
      purpose: record ? record.purpose : null,
      record: record || null,
    },
    validated: st.valid === true,
    reasons,
  }
}

/* 冲突原因码（候选侧阻断 kind 优先，按 kind 字典序稳定） */
function conflictReason(facts) {
  const hits = (facts.conflicts || [])
    .filter((c) => BLOCKING_CONFLICT_KINDS.indexOf(c.kind) >= 0)
    .map((c) => c.kind)
    .sort()
  return hits.length ? 'conflict:' + hits[0] : null
}

/* ============================================================================
 * 门 2：推荐（派生）
 * 优先级固定：purpose-mismatch > not-verified > not-a-target-lifecycle >
 *             catalog-not-listed > conflict:<kind> > not-validated > ok
 * ========================================================================= */
function evaluateCandidate(input) {
  const i = input || {}
  const purpose = isPurpose(i.purpose) ? i.purpose : (i.facts && i.facts.purpose) || 'character'
  const candidate = i.candidate || i
  const facts = candidate.facts
  const v = validateCandidate({ facts, validationRecord: candidate.validation && candidate.validation.record, nowMs: i.nowMs, validatorVersion: i.validatorVersion, ttlMs: i.ttlMs, trustCtx: i.trustCtx })
  const warnings = []
  let reason = 'ok'
  let reasonDetail = ''

  if (!facts || !facts.modelId) { reason = 'missing-candidate'; reasonDetail = 'facts 缺失' }
  else if (v.validation.purpose && v.validation.purpose !== purpose) { reason = 'purpose-mismatch'; reasonDetail = v.validation.purpose + '≠' + purpose }
  else if (facts.verified !== true) { reason = 'not-verified'; reasonDetail = facts.known ? 'metadata-unverified' : 'discovered-unknown' }
  else if (LIFECYCLE_TARGETS.indexOf(facts.lifecycle) < 0) { reason = 'not-a-target-lifecycle'; reasonDetail = facts.lifecycle }
  else if (facts.listed === false) { reason = 'catalog-not-listed'; reasonDetail = 'not-listed' }
  else {
    const cr = conflictReason(facts)
    if (cr) { reason = cr; reasonDetail = cr.slice('conflict:'.length) }
    else if (!v.validated) { reason = 'not-validated'; reasonDetail = v.validation.state }
    else if (TRUST_RANK[v.validation.trust] < TRUST_RANK[RECOMMENDATION_MIN_TRUST]) {
      /* offline(structural) 证据不足以产生推荐（更不足以迁移）；mock(compatibility) 才可推荐 */
      reason = 'trust-below-recommendation'
      reasonDetail = v.validation.trust + '<' + RECOMMENDATION_MIN_TRUST + '(' + (v.validation.mode || 'unknown') + ')'
    }
  }
  if (facts && facts.listedButUnverified) warnings.push('candidate-listed-but-unverified')
  if (v.validation.state === 'stale') warnings.push('validation-stale')
  if (facts && facts.routeState === 'scheduled') warnings.push('route-scheduled')
  if (facts && facts.routeState === 'due') warnings.push('route-due')
  if (facts && facts.routeState === 'passed') warnings.push('route-passed')

  return {
    modelId: facts ? facts.modelId : null,
    purpose,
    allowed: reason === 'ok',
    reason,
    reasonDetail,
    warnings: uniq(warnings),
    lifecycle: facts ? facts.lifecycle : 'unknown',
    validationState: v.validation.state,
    validationMode: v.validation.mode,
    validationTrust: v.validation.trust,
    productionCompatible: v.validation.productionCompatible === true,
    validated: v.validated,
    facts,
    validation: v.validation,
  }
}

/* 确定性排序键：lifecycle 排序分 desc → 验证更新鲜 desc → modelId asc（稳定兜底） */
function rankCandidates(evals) {
  const arr = Array.isArray(evals) ? evals.slice() : []
  arr.sort((a, b) => {
    const ra = LIFECYCLE_RANK[a.lifecycle] || 0
    const rb = LIFECYCLE_RANK[b.lifecycle] || 0
    if (ra !== rb) return rb - ra
    const ta = a.validation && a.validation.checkedAt ? a.validation.checkedAt : 0
    const tb = b.validation && b.validation.checkedAt ? b.validation.checkedAt : 0
    if (ta !== tb) return tb - ta
    const ia = a.modelId || ''
    const ib = b.modelId || ''
    return ia < ib ? -1 : (ia > ib ? 1 : 0)
  })
  return arr
}

/* 声明模型是否处于"需要换签"的状态（在位保护的对偶） */
function incumbentTrigger(facts) {
  if (!facts) return { triggered: true, reason: 'incumbent-unresolvable' }
  if (facts.known !== true) return { triggered: true, reason: 'incumbent-unknown' }
  if (facts.lifecycle === 'alias') return { triggered: true, reason: 'incumbent-alias' }
  if (facts.lifecycle === 'routed') return { triggered: true, reason: 'incumbent-routed' }
  if (facts.lifecycle === 'retired') return { triggered: true, reason: 'incumbent-retired' }
  if (facts.listed === false) return { triggered: true, reason: 'incumbent-unlisted' }
  if (facts.routeState === 'passed') return { triggered: true, reason: 'incumbent-route-passed' }
  return { triggered: false, reason: 'incumbent-ok' }
}

/* 集合级推荐：同一 purpose 只允许一个候选被推荐（可解释、可重放） */
function deriveRecommendations(input) {
  const i = input || {}
  const purpose = isPurpose(i.purpose) ? i.purpose : 'character'
  const nowMs = msOf(i.nowMs, Date.now())
  const declaredId = typeof i.declaredId === 'string' ? i.declaredId : null
  const list = Array.isArray(i.candidates) ? i.candidates.slice(0, MAX_CANDIDATES_PER_PURPOSE) : []
  const evals = list.map((c) => evaluateCandidate({ candidate: c, purpose, nowMs, validatorVersion: i.validatorVersion, ttlMs: i.ttlMs, trustCtx: i.trustCtx }))
  const incumbent = i.incumbent || (declaredId ? list.map((c) => c.facts).find((f) => f && f.modelId === declaredId) : null)
  const inc = incumbentTrigger(incumbent || null)
  const warnings = []
  const out = { purpose, outcome: 'no-candidate', winnerId: null, recommendationReason: 'no-candidate', recommendations: [], warnings }

  if (!evals.length) {
    out.recommendations = []
    return out
  }

  /* 在位保护：当前声明模型没有换签理由 ⇒ 不推荐任何变动 */
  if (!inc.triggered) {
    out.outcome = 'incumbent-ok'
    out.recommendationReason = 'incumbent-ok'
    out.recommendations = evals.map((e) => ({
      modelId: e.modelId,
      recommended: false,
      reason: e.modelId === declaredId ? 'already-declared' : 'incumbent-ok',
      reasonDetail: inc.reason,
      warnings: e.warnings,
    }))
    return out
  }

  const allowed = rankCandidates(evals.filter((e) => e.allowed))
  if (!allowed.length) {
    out.outcome = 'no-candidate'
    out.recommendationReason = 'no-candidate'
    out.recommendations = evals.map((e) => ({ modelId: e.modelId, recommended: false, reason: e.reason, reasonDetail: e.reasonDetail, warnings: e.warnings }))
    out.warnings = uniq([inc.reason]).filter((w) => WARNING_CODES.indexOf(w) >= 0)
    return out
  }

  const winner = allowed[0]
  if (winner.modelId === declaredId) {
    out.outcome = 'incumbent-ok'
    out.recommendationReason = 'already-declared'
    out.recommendations = evals.map((e) => ({
      modelId: e.modelId,
      recommended: false,
      reason: e.modelId === declaredId ? 'already-declared' : 'incumbent-ok',
      reasonDetail: 'best-candidate-is-declared',
      warnings: e.warnings,
    }))
    return out
  }

  out.outcome = 'ok'
  out.winnerId = winner.modelId
  out.recommendationReason = 'ok'
  out.recommendations = evals.map((e) => (e.modelId === winner.modelId
    ? { modelId: e.modelId, recommended: true, reason: 'ok', reasonDetail: 'validated-ga-candidate', warnings: e.warnings }
    : { modelId: e.modelId, recommended: false, reason: e.allowed ? 'superseded-by:' + winner.modelId : e.reason, reasonDetail: e.reasonDetail, warnings: e.warnings }))
  out.rank = rankCandidates(evals).map((e) => e.modelId)
  return out
}

/* 单候选推荐（与集合级结果逐字段一致；供单点测试与迁移门复用） */
function deriveRecommendation(input) {
  const i = input || {}
  const purpose = isPurpose(i.purpose) ? i.purpose : ((i.candidate && i.candidate.facts && i.candidate.facts.purpose) || 'character')
  const declaredId = typeof i.declaredId === 'string' ? i.declaredId : null
  const list = i.candidate ? [i.candidate] : (Array.isArray(i.candidates) ? i.candidates : [])
  const res = deriveRecommendations({
    purpose,
    declaredId,
    candidates: list,
    incumbent: i.incumbent,
    nowMs: i.nowMs,
    validatorVersion: i.validatorVersion,
    ttlMs: i.ttlMs,
    trustCtx: i.trustCtx,
  })
  const mine = res.recommendations[0] || { modelId: null, recommended: false, reason: 'missing-candidate', reasonDetail: '', warnings: [] }
  return {
    modelId: mine.modelId,
    purpose,
    recommended: mine.recommended === true,
    reason: mine.reason,
    reasonDetail: mine.reasonDetail,
    warnings: mine.warnings || [],
    outcome: res.outcome,
    winnerId: res.winnerId,
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    evaluatedAt: msOf(i.nowMs, Date.now()),
  }
}

/* ============================================================================
 * 门 3：迁移资格（派生；独立于推荐，永不自动执行）
 * ========================================================================= */
function deriveMigrationEligibility(input) {
  const i = input || {}
  const purpose = isPurpose(i.purpose) ? i.purpose : 'character'
  const nowMs = msOf(i.nowMs, Date.now())
  const declaredId = typeof i.declaredId === 'string' ? i.declaredId : null
  const candidate = i.candidate || null
  const incumbent = i.incumbent && i.incumbent.facts ? i.incumbent : null
  const blockers = []
  const warnings = []

  /* 独立重算推荐（不信任入参中的任何 recommended/eligible 声称） */
  const rec = deriveRecommendation({
    purpose,
    declaredId,
    candidate,
    incumbent,
    nowMs,
    validatorVersion: i.validatorVersion,
    ttlMs: i.ttlMs,
    trustCtx: i.trustCtx,
  })
  if (!rec.recommended) blockers.push('not-recommended')
  /* 集合级被更优候选取代：仍以"独立重算"为准（不信任布尔入参），只额外记录取代事实 */
  const supersededBy = typeof i.supersededBy === 'string' && i.supersededBy && i.supersededBy !== (candidate && candidate.facts ? candidate.facts.modelId : null)
    ? i.supersededBy
    : null
  if (supersededBy) {
    blockers.push('not-recommended')
    warnings.push('superseded-by:' + supersededBy)
  }
  for (const w of rec.warnings || []) warnings.push(w)

  if (!candidate || !candidate.facts) {
    blockers.push('candidate-missing')
  } else {
    const f = candidate.facts
    if (f.purpose !== purpose) blockers.push('purpose-mismatch')
    if (f.verified !== true) blockers.push('candidate-not-verified')
    const vs = validationStateFor(candidate.validation && candidate.validation.record, {
      nowMs,
      validatorVersion: i.validatorVersion,
      ttlMs: i.ttlMs,
    })
    if (vs.state !== 'passed') {
      blockers.push('candidate-not-validated')
      blockers.push('candidate-validation-' + vs.state)
    }
    /* 迁移门硬要求 production-grade 证据：offline/mock 一律 blocker（mock 可推荐但永不可迁移） */
    const migCtx = resolveTrustCtx(i.trustCtx, candidate && candidate.facts && candidate.facts.modelId, purpose)
    const recTrust = vs.valid ? trustOf(candidate.validation.record, migCtx) : 'none'
    if (TRUST_RANK[recTrust] < TRUST_RANK[MIGRATION_MIN_TRUST]) {
      blockers.push('validation-not-production-grade')
      warnings.push('validation-trust:' + recTrust)
      if (migCtx && candidate.validation && candidate.validation.record) {
        const g = productionTrustFor(candidate.validation.record, migCtx)
        for (const r of g.reasons.slice(0, 4)) warnings.push('production-blocked:' + r)
      }
    }
    if (vs.state === 'stale') warnings.push('validation-stale')
    for (const c of f.conflicts || []) {
      if (BLOCKING_CONFLICT_KINDS.indexOf(c.kind) >= 0) blockers.push('unresolved-conflict:' + c.kind)
    }
    if (f.listed === false) blockers.push('candidate-not-in-catalog')
    if (f.actionRequired === 'required') blockers.push('candidate-requires-action')
    if (f.listedButUnverified) warnings.push('candidate-listed-but-unverified')
  }

  if (!incumbent) blockers.push('incumbent-unresolvable')
  else {
    const inc = incumbent.facts
    if (inc.routeState === 'scheduled') blockers.push('route-not-effective')
    if (inc.routeState === 'due') warnings.push('route-due')
    if (inc.routeState === 'passed') warnings.push('route-passed')
    if (inc.lifecycle === 'alias') warnings.push('incumbent-alias')
    if (inc.lifecycle === 'routed') warnings.push('incumbent-routed')
    if (inc.listed === false) warnings.push('incumbent-unlisted')
    if (inc.actionRequired === 'required') warnings.push('incumbent-requires-action')
  }

  const autoRequested = i.autoMigrationEnabled === true || AUTO_MIGRATION_ENABLED === true
  if (autoRequested) blockers.push('auto-migration-not-authorized')
  warnings.push('auto-apply-disabled')

  const dedup = (arr) => uniq(arr)
  return {
    eligible: dedup(blockers).length === 0,
    blockers: dedup(blockers),
    warnings: dedup(warnings),
    autoApply: false,
    requiresUserAction: true,
    autoMigrationEnabled: false,
    policyVersion: MIGRATION_POLICY_VERSION,
    recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
    evaluatedAt: nowMs,
    verdict: dedup(blockers).length === 0 ? 'eligible-user-action-only' : 'blocked',
  }
}

/* ============================================================================
 * 组装：单候选完整评估（事实 + 验证 + 推荐 + 迁移）
 * ========================================================================= */
function assessCandidate(input) {
  const i = input || {}
  const purpose = isPurpose(i.purpose) ? i.purpose : 'character'
  const nowMs = msOf(i.nowMs, Date.now())
  const facts = i.facts || buildCandidateFacts(Object.assign({}, i, { purpose, nowMs }))
  const candidate = { facts, validation: { record: i.validationRecord || null } }
  const v = validateCandidate({ facts, validationRecord: candidate.validation.record, nowMs, validatorVersion: i.validatorVersion, ttlMs: i.ttlMs, trustCtx: i.trustCtx })
  const rec = deriveRecommendation({
    purpose,
    declaredId: i.declaredId,
    candidate,
    incumbent: i.incumbent,
    nowMs,
    validatorVersion: i.validatorVersion,
    ttlMs: i.ttlMs,
    trustCtx: i.trustCtx,
  })
  const supersededBy = typeof i.supersededBy === 'string' && i.supersededBy && i.supersededBy !== facts.modelId ? i.supersededBy : null
  if (supersededBy) {
    rec.recommended = false
    rec.reason = 'superseded-by:' + supersededBy
    rec.reasonDetail = 'set-level-winner'
  }
  const mig = deriveMigrationEligibility({
    purpose,
    declaredId: i.declaredId,
    candidate,
    incumbent: i.incumbent,
    nowMs,
    validatorVersion: i.validatorVersion,
    ttlMs: i.ttlMs,
    supersededBy,
    trustCtx: i.trustCtx,
  })
  return {
    candidate: true,
    modelId: facts.modelId,
    purpose,
    source: facts.source,
    known: facts.known,
    lifecycle: facts.lifecycle,
    state: facts.state,
    listed: facts.listed,
    verified: facts.verified,
    trusted: facts.trusted,
    listedButUnverified: facts.listedButUnverified,
    lifecycleTarget: facts.lifecycleTarget,
    actionRequired: facts.actionRequired,
    validated: v.validated,
    validation: v.validation,
    validationMode: v.validation.mode,
    validationTrust: v.validation.trust,
    productionCompatible: v.validation.productionCompatible === true,
    recommended: rec.recommended,
    recommendationReason: rec.reason,
    recommendationDetail: rec.reasonDetail,
    migrationEligible: mig.eligible,
    migrationBlockers: mig.blockers,
    migrationWarnings: mig.warnings,
    conflicts: facts.conflicts,
    routeState: facts.routeState,
    routeDue: facts.routeDue,
    routeAfter: facts.routeAfter,
    autoApply: false,
    requiresUserAction: true,
    policyVersion: RECOMMENDATION_POLICY_VERSION,
    migrationPolicyVersion: MIGRATION_POLICY_VERSION,
    evaluatedAt: nowMs,
  }
}

module.exports = {
  // 版本/常量
  VALIDATOR_VERSION,
  COMPAT_SURFACES,
  VALIDATION_SCHEMA_VERSION,
  RECOMMENDATION_POLICY_VERSION,
  MIGRATION_POLICY_VERSION,
  VALIDATION_TTL_MS,
  PRODUCTION_TTL_MS,
  PRODUCTION_FAULT_INJECTIONS,
  VALIDATION_STALE_RATIO,
  MAX_CHECKS,
  MAX_EVIDENCE_REFS,
  MAX_WARNINGS,
  MAX_VALIDATION_MODELS,
  MAX_CANDIDATES_PER_PURPOSE,
  AUTO_MIGRATION_ENABLED,
  PURPOSES,
  LIFECYCLE_TARGETS,
  BLOCKING_CONFLICT_KINDS,
  REASON_CODES,
  BLOCKER_CODES,
  WARNING_CODES,
  VALIDATION_STATES,
  CHECK_VOCABULARY,
  CHECK_IDS,
  MODES,
  MODE_NAMES,
  MODE_RANK,
  TRUST_BY_MODE,
  TRUST_RANK,
  TRUST_LEVELS,
  RECOMMENDATION_MIN_TRUST,
  MIGRATION_MIN_TRUST,
  PROFILES,
  UNKNOWN_IMPLEMENTATION_VERSION,
  // 纯函数
  checksForPurpose,
  hash32Hex,
  checkSetHashFor,
  derivedMode,
  trustOf,
  productionCompatibleOf,
  envFingerprintFor,
  productionTrustFor,
  sanitizeProvenance,
  buildValidationRecord,
  sanitizeValidationRecord,
  validationStateFor,
  buildCandidateFacts,
  validateCandidate,
  evaluateCandidate,
  rankCandidates,
  deriveRecommendations,
  deriveRecommendation,
  deriveMigrationEligibility,
  assessCandidate,
  incumbentTrigger,
}
