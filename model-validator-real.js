'use strict'
/*
 * DeskPet Real Validation Client — P1-B（Production Validation Gate）
 *
 * 唯一职责：对**锁定端点**执行一次真实 DirectLLM 校验请求，并产出 real 层的
 * check 结果与 provenance（供 model-validator.js / update-manager.js 组装 ValidationRecord）。
 *
 * 硬边界（可由静态扫描证明）：
 *   ✅ require('./model-candidate.js')（常量/契约）、node:crypto（哈希/指纹）
 *   ❌ renderer / memory / diary / relationship / migration / recordDirectModelUse /
 *      callDirectLLM / conversation history / declared / settings / credentials 写入
 *   ❌ 任意 endpoint 输入（端点**锁定**为官方 API；测试只能注入 fetchImpl，不能改 URL）
 *
 * 成本硬约束：每次运行 **至多 1 次真实请求**、0 重试、output ≤8 tokens、固定输入、timeout ≤20s。
 * 故障注入（auth/quota/timeout/network）走**同一分类代码路径**，且不产生真实网络请求。
 */
const crypto = require('crypto')
const ModelCandidate = require('./model-candidate.js')

/* 构建期开关（build gate）：默认关闭。启用 production tier 需要显式、经批准的改动。 */
const PRODUCTION_TIER_ENABLED = false

/* 生产端点锁死（任何 IPC/参数都不得覆盖） */
const LOCKED_ENDPOINT = 'https://api.deepseek.com/chat/completions'
/* 固定校验提示词：不含任何用户数据/历史/人格 */
const VALIDATION_PROMPT = 'Reply with the single word: OK'
const MAX_OUTPUT_TOKENS = 8
const MAX_INPUT_TOKENS_EST = 64
const TIMEOUT_MS = 20000
const MAX_REQUESTS_PER_RUN = 1
const FAULT_CLASSES = ['auth', 'quota', 'timeout', 'network']

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input == null ? '' : input)).digest('hex')
}
function hash8(input) {
  if (input == null || input === '') return null
  return sha256Hex(input).slice(0, 8)
}
function nonce16() {
  return crypto.randomBytes(8).toString('hex')
}
function latencyBucket(ms) {
  const n = Number(ms) || 0
  if (n < 1500) return 'p50'
  if (n < 5000) return 'p90'
  if (n < 12000) return 'p99'
  return 'slow'
}
function lengthBucket(text) {
  const n = typeof text === 'string' ? text.length : 0
  if (n === 0) return 'empty'
  if (n <= 8) return 'le8'
  if (n <= 64) return 'le64'
  return 'gt64'
}

/* 错误消息脱敏：绝不外泄 key / Authorization / 带凭据的 URL */
function redactError(input) {
  let s = String((input && input.message) || input || '')
  s = s.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
  s = s.replace(/(authorization|bearer)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{6,}/gi, '$1 ***')
  s = s.replace(/([?&](?:key|token|api_key|apikey)=)[^&\s]+/gi, '$1***')
  s = s.replace(/\bhttps?:\/\/[^\s"']+/gi, (u) => u.replace(/\/\/[^@/]+@/, '//***@'))
  if (s.length > 160) s = s.slice(0, 160)
  return s
}

function classifyHttpStatus(status) {
  const s = Number(status)
  if (s === 401 || s === 403) return 'auth'
  if (s === 429) return 'quota'
  return 'http_' + s
}
function classifyThrown(err, timedOut) {
  if (timedOut) return 'timeout'
  const name = String((err && err.name) || '')
  const msg = String((err && err.message) || '')
  if (name === 'AbortError' || /abort|timeout|timed out/i.test(msg)) return 'timeout'
  return 'network'
}

/* 故障注入适配器：与真实请求**共用** performRequest/分类路径 */
function faultTransport(kind) {
  const mk = (status) => async () => ({
    ok: false,
    status,
    json: async () => ({}),
    headers: { get: () => null },
  })
  if (kind === 'auth') return mk(401)
  if (kind === 'quota') return mk(429)
  if (kind === 'network') return async () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }) }
  if (kind === 'timeout') {
    return async (url, init) => new Promise((_resolve, reject) => {
      const signal = init && init.signal
      const abort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      }
    })
  }
  return null
}

/* 单次请求执行（真实或注入），返回统一结构；不含任何分类判断 */
async function performRequest(opts) {
  const o = opts || {}
  const fetchImpl = o.fetchImpl
  const timeoutMs = Math.min(Math.max(Number(o.timeoutMs) || TIMEOUT_MS, 500), TIMEOUT_MS)
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { ctl.abort() } catch (e) { /* ignore */ }
  }, timeoutMs)
  const started = Date.now()
  let res = null
  let err = null
  try {
    res = await fetchImpl(LOCKED_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer ' + String(o.key || ''),
      },
      body: JSON.stringify({
        model: String(o.modelId || ''),
        messages: [{ role: 'user', content: VALIDATION_PROMPT }],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        stream: false,
      }),
      signal: ctl.signal,
    })
  } catch (e) {
    err = e
  } finally {
    clearTimeout(timer)
  }
  return { res, err, timedOut, latencyMs: Date.now() - started }
}

function pass(detail) { return { status: 'pass', detail: String(detail || '').slice(0, ModelCandidate.MAX_DETAIL) } }
function fail(detail) { return { status: 'fail', detail: String(detail || '').slice(0, ModelCandidate.MAX_DETAIL) } }
function skip(detail) { return { status: 'skip', detail: String(detail || '').slice(0, ModelCandidate.MAX_DETAIL) } }

function requestCountOf(kind) { return kind === 'real' ? 1 : 0 }

/* 主入口：真实校验（1 次真实请求 + 4 类故障注入；0 重试） */
async function runRealValidation(opts) {
  const o = opts || {}
  const modelId = typeof o.modelId === 'string' ? o.modelId.slice(0, 64) : ''
  const purpose = ModelCandidate.PURPOSES.indexOf(o.purpose) >= 0 ? o.purpose : null
  const key = typeof o.key === 'string' ? o.key : ''
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : (typeof fetch === 'function' ? fetch : null)

  if (!modelId) return { ok: false, error: 'invalid_input', detail: 'modelId', checks: null, provenance: null }
  if (!purpose) return { ok: false, error: 'invalid_input', detail: 'purpose', checks: null, provenance: null }
  if (purpose === 'work') return { ok: false, error: 'production_tier_unsupported_purpose', checks: null, provenance: null }
  if (!key) return { ok: false, error: 'no-key', checks: null, provenance: null }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'no_fetch', checks: null, provenance: null }

  const validationId = 'v-' + Date.now().toString(36) + '-' + nonce16()
  const nonce = nonce16()
  const checks = {}

  /* ---- 1) 真实请求（至多 1 次）---- */
  const real = await performRequest({ fetchImpl, key, modelId, timeoutMs: o.timeoutMs })
  const realRequests = requestCountOf('real')
  let httpStatus = null
  let errorClass = null
  let servedModel = null
  let providerRevisionHash8 = null
  let providerRevisionSource = null
  let providerRequestIdHash8 = null
  let finishReason = null
  let responseLengthBucket = 'empty'

  if (real.err) {
    errorClass = classifyThrown(real.err, real.timedOut)
    checks['real-request'] = fail(errorClass + ':' + redactError(real.err))
    checks['real-response-binding'] = skip('no-response')
  } else if (!real.res || typeof real.res.status !== 'number') {
    errorClass = 'network'
    checks['real-request'] = fail('bad-response')
    checks['real-response-binding'] = skip('no-response')
  } else {
    httpStatus = real.res.status
    if (!real.res.ok) {
      errorClass = classifyHttpStatus(httpStatus)
      checks['real-request'] = fail('http_' + httpStatus + ':' + errorClass)
      checks['real-response-binding'] = skip('no-response')
    } else {
      let json = null
      let parseOk = true
      try { json = await real.res.json() } catch (e) { parseOk = false }
      if (!parseOk || !json || typeof json !== 'object') {
        errorClass = 'invalid_json'
        checks['real-request'] = fail('invalid_json')
        checks['real-response-binding'] = skip('unparseable')
      } else {
        checks['real-request'] = pass('http_200')
        const choice = json.choices && json.choices[0]
        const content = choice && choice.message && choice.message.content
        finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null
        servedModel = typeof json.model === 'string' ? json.model.slice(0, 64) : null
        const fp = typeof json.system_fingerprint === 'string' && json.system_fingerprint ? json.system_fingerprint : null
        const headerRevision = real.res.headers && typeof real.res.headers.get === 'function' ? real.res.headers.get('x-ds-model-revision') : null
        if (fp) { providerRevisionSource = 'response.system_fingerprint'; providerRevisionHash8 = hash8('sf|' + fp) }
        else if (headerRevision) { providerRevisionSource = 'header.x-ds-model-revision'; providerRevisionHash8 = hash8('hdr|' + headerRevision) }
        else { providerRevisionSource = null; providerRevisionHash8 = null }
        const reqId = (real.res.headers && typeof real.res.headers.get === 'function' && real.res.headers.get('x-request-id')) || (typeof json.id === 'string' ? json.id : null)
        providerRequestIdHash8 = hash8(reqId)
        const textOk = typeof content === 'string' && content.trim().length > 0
        const finishOk = finishReason === 'stop' || finishReason === 'length'
        responseLengthBucket = lengthBucket(content)
        checks['real-response-binding'] = (textOk && finishOk) ? pass('bound:' + finishReason) : fail(!textOk ? 'empty-content' : 'finish:' + String(finishReason))
      }
    }
  }

  /* ---- 2) 故障注入（同一分类路径；0 真实请求）---- */
  const faultExpect = { auth: 'auth', quota: 'quota', timeout: 'timeout', network: 'network' }
  let faultInjections = 0
  for (const kind of FAULT_CLASSES) {
    const transport = faultTransport(kind)
    const probe = await performRequest({ fetchImpl: transport, key, modelId, timeoutMs: 300 })
    faultInjections++
    let got = null
    if (probe.err) got = classifyThrown(probe.err, probe.timedOut)
    else if (probe.res && typeof probe.res.status === 'number') got = probe.res.ok ? 'ok' : classifyHttpStatus(probe.res.status)
    else got = 'network'
    const id = 'real-' + kind + '-classification'
    checks[id] = got === faultExpect[kind] ? pass(got) : fail('expected-' + faultExpect[kind] + '-got-' + String(got))
  }

  /* ---- 3) 安全：证据中不得出现 key / Authorization / bearer ---- */
  const evidenceProbe = JSON.stringify({ provenance: { providerRequestIdHash8, providerRevisionHash8, servedModel, source: providerRevisionSource } })
  const leak = key && evidenceProbe.indexOf(key) >= 0
  checks['real-no-secret-echo'] = (!leak && evidenceProbe.indexOf('authorization') < 0 && evidenceProbe.indexOf('bearer') < 0)
    ? pass('no-secret-in-evidence')
    : fail('secret-leak')

  /* ---- 4) 延迟桶（optional）---- */
  const lb = latencyBucket(real.latencyMs)
  checks['real-latency-bucket'] = real.latencyMs <= 12000 ? pass(lb) : fail(lb)

  const provenance = {
    executor: 'real-validator',
    realRequests,
    faultInjections,
    endpoint: LOCKED_ENDPOINT,
    keyIdHash8: hash8('deskpet-model-validation|' + key),
    servedModel,
    providerRevisionSource,
    providerRequestIdHash8,
    latencyBucket: lb,
    finishReason,
    responseLengthBucket,
  }

  const requiredReal = ['real-request', 'real-response-binding', 'real-auth-classification', 'real-quota-classification', 'real-timeout-classification', 'real-network-classification', 'real-no-secret-echo']
  const failedRequired = requiredReal.filter((id) => !checks[id] || checks[id].status !== 'pass')
  return {
    ok: failedRequired.length === 0,
    error: failedRequired.length === 0 ? null : 'real-check-failed',
    failedChecks: failedRequired,
    validationId,
    nonce,
    providerRevisionHash8,
    providerRevisionSource,
    servedModel,
    httpStatus,
    errorClass,
    realRequests,
    faultInjections,
    latencyBucket: lb,
    requestBudget: { maxRequests: MAX_REQUESTS_PER_RUN, usedRequests: realRequests, retries: 0, maxOutputTokens: MAX_OUTPUT_TOKENS, estInputTokens: MAX_INPUT_TOKENS_EST, timeoutMs: TIMEOUT_MS },
    checks,
    provenance,
  }
}

module.exports = {
  PRODUCTION_TIER_ENABLED,
  LOCKED_ENDPOINT,
  VALIDATION_PROMPT,
  MAX_OUTPUT_TOKENS,
  MAX_INPUT_TOKENS_EST,
  TIMEOUT_MS,
  MAX_REQUESTS_PER_RUN,
  FAULT_CLASSES,
  runRealValidation,
  performRequest,
  classifyHttpStatus,
  classifyThrown,
  redactError,
  latencyBucket,
  lengthBucket,
  hash8,
  sha256Hex,
  nonce16,
}
