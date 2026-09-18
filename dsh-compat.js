'use strict'
/*
 * DSH Compatibility Layer
 *
 * Stable internal DSH client API. Business code should only use methods
 * exposed here; protocol differences are isolated in this module.
 *
 * Modes:
 *   old  - force DSH 0.1.1-rc.2 HTTP/WS protocol
 *   new  - force DSH 0.1.2-rc.1 protocol (auth + remote.mux + $events)
 *   auto - capability detection; old first, then new
 *
 * This module never changes the bundled DSH runtime. It only talks to an
 * already-running DSH web server.
 */
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')

const DSH_COMPAT_VERSION = '0.1.0'
const OLD_MODE = 'old'
const NEW_MODE = 'new'
const AUTO_MODE = 'auto'

const OLD_EVENTS_PATH = '/api/events.mux'
const NEW_REMOTE_MUX_PATH = '/api/remote.mux'
const NEW_EVENTS_ENDPOINT = '$events'
const NEW_EVENTS_RESULT_ENDPOINT = '$events/result'
const NEW_WORKSPACE_FOLLOW_ENDPOINT = 'workspace/follow'

// Old RPC method name -> [new endpoint, payload adapter, response adapter]
const OLD_TO_NEW_METHODS = {
  'session.list': {
    endpoint: 'session/list',
    payload: (p) => ({ args: { _request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  'session.create': {
    endpoint: 'session/create',
    payload: (p) => ({ args: { request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  'session.rename': {
    endpoint: 'session/rename',
    payload: (p) => ({ args: { request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  'session.history': {
    endpoint: 'session/page',
    payload: async (p, ctx, opts) => {
      const address = { kind: 'session', sessionId: p.sessionId }
      const request = { address, maxMessages: p.maxMessages || 20 }
      if (p.beforeSeq !== undefined) request.beforeSeq = p.beforeSeq
      if (p.throughSeq !== undefined) {
        request.throughSeq = p.throughSeq
      } else if (ctx && typeof ctx._resolveThroughSeqForSession === 'function') {
        request.throughSeq = await ctx._resolveThroughSeqForSession(p.sessionId, opts)
      } else {
        // Safe fallback: a very large seq means "no upper bound".
        request.throughSeq = Number.MAX_SAFE_INTEGER
      }
      return { args: { request } }
    },
    respond: (r) => {
      // Normalize new session/page records -> old session.history shape
      if (r && r.result && r.result.ok && r.result.value && Array.isArray(r.result.value.records)) {
        r.result.value.events = r.result.value.records
        delete r.result.value.records
        delete r.result.value.hasMore
      }
      return r
    },
  },
  'session.prompt': {
    endpoint: 'session/prompt',
    payload: (p) => ({
      args: {
        request: {
          requestId: p && p.requestId ? p.requestId : 'pet-' + crypto.randomUUID(),
          sessionId: (p && p.sessionId) || '',
          mode: (p && p.mode) || 'queue',
          content: (p && p.content) || [],
          ...((p && p.clientTimeZone) ? { clientTimeZone: p.clientTimeZone } : {}),
        },
      },
    }),
    respond: (r) => r,
  },
  'session.models': {
    endpoint: 'session/modelCatalog',
    payload: () => ({ args: {} }),
    respond: (r) => r,
  },
  'session.selectModel': {
    endpoint: 'session/selectModel',
    payload: (p) => ({ args: { request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  'session.archive': {
    endpoint: 'workspace/archiveSession',
    payload: (p) => ({ args: { request: { sessionId: p.sessionId } } }),
    respond: (r) => r,
  },
  'workspace.archiveSession': {
    endpoint: 'workspace/archiveSession',
    payload: (p) => ({ args: { request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  'workspace.create': {
    endpoint: 'workspace/create',
    payload: (p) => ({ args: { request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  'workspace.rename': {
    endpoint: 'workspace/rename',
    payload: (p) => ({ args: { request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  'workspace.delete': {
    endpoint: 'workspace/delete',
    payload: (p) => ({ args: { request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  'agentPreset.list': {
    endpoint: 'agentPresets/list',
    payload: () => ({ args: {} }),
    respond: (r) => r,
  },
  'agentPreset.select': {
    endpoint: 'agentPresets/select',
    payload: (p) => ({
      args: {
        agentId: (p && p.sessionId) || '',
        agentPreset: (p && p.agentPreset) || '',
      },
    }),
    respond: (r) => r,
  },
  'agentPreset.read': {
    endpoint: 'agentPresets/read',
    payload: (p) => ({ args: { request: { ...(p || {}) } } }),
    respond: (r) => r,
  },
  /* 权限：DSH 把"权限档位"拆成两个 RPC ——
     选项清单在 `permissionPresets/catalog`，当前值在 session/list 的 `projections.values.permissions.currentValue`；
     改档位**没有** select 类 RPC，唯一写路径是执行 host 命令 `/permission <preset>`（commands/execute，
     scope wire = agentId）。deskpet 此前用 session.prompt 发这句文本 ⇒ 只当用户消息入队、永不执行，
     还会假报成功；这里补上正确通道。 */
  'permissionPresets.catalog': {
    endpoint: 'permissionPresets/catalog',
    payload: () => ({ args: {} }),
    respond: (r) => r,
  },
  'commands.execute': {
    endpoint: 'commands/execute',
    payload: (p) => {
      const line = String((p && p.line) || '')
      if (!line) throw new Error('commands.execute requires a non-empty line')
      return {
        args: {
          agentId: (p && (p.agentId || p.sessionId)) || '',
          line,
          submittedAttachments: Array.isArray(p && p.submittedAttachments) ? p.submittedAttachments : [],
        },
      }
    },
    respond: (r) => r,
  },
}

function randomId(prefix) {
  return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex')
}

function parseJsonSafe(text) {
  try { return JSON.parse(text) } catch (e) { return null }
}

/* ------------------------------ 统一超时层 ------------------------------ */
/* 所有对 DSH 的 HTTP / WebSocket 调用都必须走下面三个入口：
     fetchWithTimeout()           —— 所有 fetch（旧/新协议 RPC、respond）
     requestRaw()                 —— 所有 http/https.request（token 交换）
     openWebSocketWithTimeout()   —— 所有 ws 连接（旧 events.mux / 新 remote.mux）
   设计要点：
   1) 每类请求一个预算（timeouts），可用构造参数或 DSH_TIMEOUT_*_MS 覆盖；
   2) opts.deadlineAt 会把“剩余总预算”向下传播（_waitForReady 用），避免逐跳超时加起来超过总预算；
   3) 超时是"真的结束"：fetch 用 AbortController、http.request 用 destroy、ws 用 terminate 并补发 error；
   4) 超时统一抛 DshTimeoutError(code=DSH_TIMEOUT)，调用方原有的 catch→false / reject 语义不变。 */
const DSH_TIMEOUT_DEFAULTS = {
  auth: 8000,          // token 交换（/?token=...）
  rpc: 15000,          // 旧/新协议 JSON RPC（session.* / workspace.* / agentPresets.*）
  probe: 6000,         // 协议探测 / health（_oldHealth / _newHealth）
  respond: 8000,       // 回答授权/提问（/api/respond、$events/result）
  httpReachable: 3000, // 端口可达性探测（保持原 3s 语义）
  wsConnect: 8000,     // WebSocket 建连（events.mux / remote.mux）
  wsBaseline: 10000,   // workspace/follow 建流后等待 baseline 帧
}

function normalizeTimeouts(overrides) {
  const out = {}
  for (const k of Object.keys(DSH_TIMEOUT_DEFAULTS)) {
    const envName = 'DSH_TIMEOUT_' + k.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase() + '_MS'
    const envRaw = process.env[envName]
    const envVal = Number(envRaw)
    const given = overrides ? Number(overrides[k]) : NaN
    const pick = Number.isFinite(given) && given > 0 ? given
      : (envRaw != null && Number.isFinite(envVal) && envVal > 0 ? envVal : DSH_TIMEOUT_DEFAULTS[k])
    out[k] = pick
  }
  return out
}

class DshTimeoutError extends Error {
  constructor(label, timeoutMs) {
    super('DSH timeout (' + label + ') after ' + timeoutMs + 'ms')
    this.name = 'DshTimeoutError'
    this.code = 'DSH_TIMEOUT'
    this.label = label
    this.timeoutMs = timeoutMs
  }
}

/* opts: { signal, timeoutMs, deadlineAt }；deadlineAt 优先收紧 timeoutMs。
   预算名打错/非正数时退化为默认 rpc 预算，绝不退化成 0（否则会“立即超时”）。 */
function resolveTimeoutMs(opts, budgetMs) {
  const base = Number((opts && opts.timeoutMs) || budgetMs)
  let ms = Number.isFinite(base) && base > 0 ? base : DSH_TIMEOUT_DEFAULTS.rpc
  if (opts && Number.isFinite(Number(opts.deadlineAt))) ms = Math.min(ms, Number(opts.deadlineAt) - Date.now())
  return Math.max(1, Math.round(ms))
}

async function fetchWithTimeout(url, init, opts) {
  const label = (opts && opts.label) || 'http'
  const ms = resolveTimeoutMs(opts, (opts && opts.budgetMs) || DSH_TIMEOUT_DEFAULTS.rpc)
  const outer = opts && opts.signal
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { ctl.abort() } catch (e) { /* ignore */ } }, ms)
  const onAbort = () => { try { ctl.abort() } catch (e) { /* ignore */ } }
  if (outer) {
    if (outer.aborted) onAbort()
    else { try { outer.addEventListener('abort', onAbort, { once: true }) } catch (e) { /* ignore */ } }
  }
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctl.signal }))
  } catch (err) {
    // 超时 → 统一错误类型；调用方主动 abort → 保留 AbortError（外层已给出自己的超时结论）
    if (timedOut) throw new DshTimeoutError(label, ms)
    throw err
  } finally {
    clearTimeout(timer)
    if (outer) { try { outer.removeEventListener('abort', onAbort) } catch (e) { /* ignore */ } }
  }
}

/* 所有 http/https.request 的唯一入口；超时会 destroy socket 并抛 DshTimeoutError。 */
function requestRaw(base, path, options, cookie, reqOpts) {
  const label = (reqOpts && reqOpts.label) || 'http-raw'
  const ms = resolveTimeoutMs(reqOpts, (reqOpts && reqOpts.budgetMs) || DSH_TIMEOUT_DEFAULTS.auth)
  const outer = reqOpts && reqOpts.signal
  return new Promise((resolve, reject) => {
    const u = new URL(base + path)
    const mod = u.protocol === 'https:' ? https : http
    const body = options && options.body ? Buffer.from(options.body) : null
    let settled = false
    let timedOut = false
    let timer = null
    let req = null
    const settle = (fn, v) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (outer) { try { outer.removeEventListener('abort', onAbort) } catch (e) { /* ignore */ } }
      fn(v)
    }
    const onAbort = () => { try { req.destroy(new Error('aborted')) } catch (e) { /* ignore */ } }
    try {
      req = mod.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: (options && options.method) || 'GET',
        headers: {
          ...((options && options.headers) || {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { 'content-length': body.length } : {}),
        },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => settle(resolve, {
          status: res.statusCode,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
        res.on('error', (err) => settle(reject, timedOut ? new DshTimeoutError(label, ms) : err))
      })
    } catch (err) {
      settle(reject, err)
      return
    }
    timer = setTimeout(() => { timedOut = true; try { req.destroy() } catch (e) { /* ignore */ } }, ms)
    if (outer) {
      if (outer.aborted) onAbort()
      else { try { outer.addEventListener('abort', onAbort, { once: true }) } catch (e) { /* ignore */ } }
    }
    req.on('error', (err) => settle(reject, timedOut ? new DshTimeoutError(label, ms) : err))
    if (body) req.write(body)
    req.end()
  })
}

/* 所有 WebSocket 连接的唯一入口。连接超时：terminate() + 补发 error，
   让调用方既有的 sock.on('error', reject) / onError 路径照常收到通知。 */
function openWebSocketWithTimeout(WebSocketCtor, url, options, opts) {
  const label = (opts && opts.label) || 'ws-connect'
  const ms = resolveTimeoutMs(opts, (opts && opts.budgetMs) || DSH_TIMEOUT_DEFAULTS.wsConnect)
  const outer = opts && opts.signal
  const sock = new WebSocketCtor(url, options || {}) // 构造失败由调用方 try/catch
  let fired = false
  let timer = null
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (outer) { try { outer.removeEventListener('abort', onOuterAbort) } catch (e) { /* ignore */ } }
  }
  /* 超时/外部取消：真正结束 socket，并补发 error 让调用方既有的
     sock.on('error', reject) / onError 路径收到通知（单一通知路径，不会重复回调）。 */
  const abort = (err) => {
    if (fired) return
    fired = true
    cleanup()
    try { sock.terminate() } catch (e) { /* ignore */ }
    if (sock.listenerCount('error') > 0) { try { sock.emit('error', err) } catch (e) { /* ignore */ } }
  }
  const onOuterAbort = () => abort(new Error('aborted'))
  const settleOk = () => { if (fired) return; fired = true; cleanup() }
  timer = setTimeout(() => abort(new DshTimeoutError(label, ms)), ms)
  if (outer) {
    if (outer.aborted) setImmediate(onOuterAbort) // 让调用方先挂上 error 监听
    else { try { outer.addEventListener('abort', onOuterAbort, { once: true }) } catch (e) { /* ignore */ } }
  }
  sock.once('open', settleOk)
  sock.once('error', settleOk)
  sock.once('close', settleOk)
  return sock
}

function setCookieFromResponse(headers) {
  const raw = headers['set-cookie']
  if (!raw) return null
  // Node may expose a single string or an array; handle both.
  const lines = Array.isArray(raw) ? raw : [raw]
  return lines.map((l) => l.split(';')[0].trim()).filter(Boolean).join('; ')
}

class DshCompat {
  constructor(options) {
    this.baseUrl = options.baseUrl || 'http://127.0.0.1:3080'
    this.dshStartLogPath = options.dshStartLogPath || null
    this.forceMode = options.mode || AUTO_MODE
    this.log = options.log || (() => {})
    this.timeouts = normalizeTimeouts(options.timeouts) // P2-8 统一超时预算
    this.mode = null // resolved after detection when auto
    this.authCookie = null
    this.lastToken = null
    this.capabilities = {
      alive: false,
      httpReachable: false,
      protocolUsable: false,
      auth: 'none',
      events: false,
      workspaceFollow: false,
      version: null,
    }
    this.diagnostics = []
    this.eventState = {
      socket: null,
      streamId: null,
      clientId: null,
      stopRequested: false,
      reconnectTimer: null,
      pending: new Map(), // synthetic rpcId -> { event, clientId, eventId, sessionId }
      workspaceSnapshot: null,
      workspaceListeners: new Set(),
    }
    this._detectPromise = null
    this._spawnDsh = null
    this._dshBinJs = null
  }

  /* ------------------------------ restart orchestration ------------------------------ */

  setSpawner(fn) {
    this._spawnDsh = fn
    return this
  }

  setDshBinJs(p) {
    this._dshBinJs = p
    return this
  }

  /* P1-G：强身份校验器由组合根注入（唯一 kill 判据）；未注入则拒绝对任何 PID 动手 */
  setOwnershipVerifier(fn) {
    this._ownershipVerifier = typeof fn === 'function' ? fn : null
    return this
  }

  activePort() {
    try {
      const u = new URL(this.baseUrl)
      return u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
    } catch (e) {
      return 3080
    }
  }

  async _discoverDshPids(port) {
    const cp = require('child_process')
    const r = cp.spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 8000 })
    const pids = new Set()
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.match(new RegExp(':' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)'))
      if (m) pids.add(m[1])
    }
    return Array.from(pids)
  }


  /**
   * P1-G：停止端口上的 DSH —— 只认组合根注入的强身份校验器（runtime node + 精确 bin.js + web + --no-open）。
   * 未注入校验器 / 校验不通过 / 校验抛错 ⇒ 一律拒绝，绝不 taskkill 任何未经证明的 PID。
   */
  async _killSafeDshPids(port) {
    if (typeof this._ownershipVerifier !== 'function') {
      const pids0 = await this._discoverDshPids(port)
      return { ok: false, error: 'no_ownership_verifier', killed: 0, unsafe: pids0, pids: pids0 }
    }
    let v = null
    try { v = await this._ownershipVerifier(port) } catch (e) { v = { ok: false, error: 'verifier_threw' } }
    /* P1-K.2.4-FIX：free = 没有可杀对象 —— 这正是 restart 的正常前置状态（更新流程已先停旧 DSH）。
       ⇒ 放行继续（spawn/waitForReady/verify 由调用方完成）；放行前再确认端口上确实没有残留监听 PID。
       其余非 ok 状态（weak / foreign / conflict / unsafe / verifier 异常）保持 fail-closed 拒绝不变。 */
    if (v && v.ok !== true && v.state === 'free') {
      const leftover = await this._discoverDshPids(port)
      if (leftover.length === 0) return { ok: true, killed: 0, unsafe: [], pids: [] }
    }
    if (!v || v.ok !== true) {
      return { ok: false, error: 'unsafe_port_process', killed: 0, unsafe: (v && v.unsafe) || [], pids: [], state: v && v.state }
    }
    const owned = Array.isArray(v.owned) ? v.owned.filter((x) => Number(x) > 0) : []
    const cp = require('child_process')
    for (const pid of owned) {
      cp.spawnSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 8000 })
    }
    return { ok: true, killed: owned.length, unsafe: [] }
  }

  async _waitPortFree(port, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const pids = await this._discoverDshPids(port)
      if (pids.length === 0) return true
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  async restartDsh({ spawn, dshBinJs } = {}) {
    /* P1-K.2.10 观测（不改行为）：本函数是"升级/回滚卡在重启"的第一现场，但旧实现只回
       no_spawner/unsafe_port_process/port_not_clear/spawn_failed/gate_not_ready/event_stream_failed
       这类通用码，真实原因（哪一段、耗时多少、capabilities/diagnostics 是什么、是否抛异常）全丢。
       这里只加 **日志与 stages 字段**，返回值与判定语义保持原样。 */
    const t0 = Date.now()
    const stages = {}
    const mark = (name, extra) => {
      stages[name] = Date.now() - t0
      try {
        const tail = extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))
        this.log('restartDsh ' + name + ' +' + stages[name] + 'ms' + tail.slice(0, 400))
      } catch (e) { /* 观测不得影响主流程 */ }
    }
    const spawner = spawn || this._spawnDsh
    if (dshBinJs) this._dshBinJs = dshBinJs
    if (typeof spawner !== 'function') {
      mark('fail:no_spawner')
      return { ok: false, error: 'no_spawner', stages }
    }

    const port = this.activePort()

    this.stop()
    mark('stopped')
    const kill = await this._killSafeDshPids(port)
    if (!kill.ok) {
      mark('fail:unsafe_port_process', { unsafe: kill.unsafe, pids: kill.pids })
      return { ok: false, error: 'unsafe_port_process', unsafePids: kill.unsafe, pids: kill.pids, stages }
    }
    mark('killed', { killed: kill.killed })
    if (!(await this._waitPortFree(port, 15000))) {
      const pids = await this._discoverDshPids(port)
      mark('fail:port_not_clear', { pids })
      return { ok: false, error: 'port_not_clear', pids, stages }
    }
    mark('port_free')
    /* P1-K.2.8 取证改进：把上一次 spawn 的 dsh-start.log **轮转**为 .1，而不是清空。
       清空会把"失败运行时的启动输出/崩溃栈"一起抹掉 —— 2026-09-13 的 E2E 就因此无法区分
       "新版本起得慢"与"新版本起来就崩"。轮转不改变 token 语义（读取方只认当前文件的最后一条
       `dsh web:` 行）；仅当轮转失败（旧进程仍占用文件等）才退回原来的清空行为。 */
    if (this.dshStartLogPath) {
      try {
        const fsM = require('fs')
        if (fsM.existsSync(this.dshStartLogPath)) {
          try { fsM.renameSync(this.dshStartLogPath, this.dshStartLogPath + '.1'); mark('log_rotated', this.dshStartLogPath + '.1') } catch (e2) { try { fsM.writeFileSync(this.dshStartLogPath, '', 'utf8'); mark('log_cleared_fallback') } catch (e3) { /* ignore */ } }
        }
      } catch (e) { /* ignore */ }
    }
    this.onDshStarted()

    mark('spawning', { mode: this.mode, port })
    try {
      await spawner()
    } catch (e) {
      mark('fail:spawn_failed', String((e && e.message) || e))
      return { ok: false, error: 'spawn_failed', message: e && e.message, stages }
    }
    mark('spawned')

    let gate = null
    try {
      gate = await this._waitForReady(90000)
    } catch (e) {
      /* 旧实现的盲点：这里的异常会一路冒到调用方被压成布尔，真实原因从未落盘 */
      mark('fail:waitForReady_threw', String((e && e.message) || e))
      throw e
    }
    if (!gate) {
      mark('fail:gate_not_ready', { capabilities: this.capabilities, diagnostics: this.diagnostics })
      return { ok: false, error: 'gate_not_ready', capabilities: { ...this.capabilities }, diagnostics: [...this.diagnostics], stages }
    }
    mark('gate_ready', { mode: this.mode, usable: gate.usable === true, capabilities: this.capabilities })

    try {
      await this.connectStreamVerified()
    } catch (e) {
      mark('fail:event_stream_failed', String((e && e.message) || e))
      return { ok: false, error: 'event_stream_failed', message: e && e.message, stages }
    }
    mark('ready')

    return {
      ok: true,
      dshUp: true,
      mode: this.mode,
      killed: kill.killed,
      port,
      stages,
    }
  }

  async _waitForReady(timeoutMs) {
    const start = Date.now()
    const deadlineAt = start + timeoutMs
    // P2-8：把剩余总预算以 deadlineAt 向下传播（用于 token 交换等非共享步骤），
    // 保证等待循环不会被单跳请求无限拖长；协议探测本身用自己的 probe 预算，
    // 且是共享缓存（_detectPromise），不接调用方 deadline，避免互相截断。
    const budget = { deadlineAt }
    while (Date.now() < deadlineAt) {
      const mode = await this.resolveMode(true)
      const gate = await this.compatibilityGate()
      if (gate.usable && mode) {
        if (mode === NEW_MODE) {
          const auth = await this.ensureAuth(true, budget)
          if (!auth) {
            await new Promise((r) => setTimeout(r, 500))
            continue
          }
        }
        return gate
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return null
  }

  async connectStreamVerified() {
    return new Promise((resolve, reject) => {
      let ok = false
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (iv) clearInterval(iv)
        if (err) reject(err)
        else resolve(true)
      }
      const timeout = setTimeout(() => {
        if (!ok) finish(new Error('event stream not ready'))
      }, 30000)
      let iv = null
      this.connectEvents(() => {}).then((sock) => {
        if (this.mode === OLD_MODE) {
          ok = true
          try { sock.close() } catch (e) {}
          finish()
          return
        }
        // New mode: wait until capabilities.events becomes true (ready frame).
        iv = setInterval(() => {
          if (this.capabilities.events) {
            ok = true
            try { sock.close() } catch (e) {}
            finish()
          }
        }, 200)
        sock.once('close', () => {
          if (!ok) finish(new Error('event stream closed before ready'))
        })
      }).catch(finish)
    })
  }

  /* ------------------------------ detection ------------------------------ */

  async resolveMode(forceRefresh) {
    if (!forceRefresh && this.mode) return this.mode
    if (this.forceMode !== AUTO_MODE) {
      this.mode = this.forceMode
      return this.mode
    }
    if (this._detectPromise) return this._detectPromise
    this._detectPromise = this._detect().finally(() => { this._detectPromise = null })
    return this._detectPromise
  }

  async _detect() {
    // 1) old protocol first
    const oldOk = await this._oldHealth()
    if (oldOk) {
      this.mode = OLD_MODE
      this.capabilities.alive = true
      this.capabilities.httpReachable = true
      this.capabilities.protocolUsable = true
      this.capabilities.version = '0.1.1-rc.2?'
      return this.mode
    }
    // 2) new protocol
    const newOk = await this._newHealth()
    if (newOk) {
      this.mode = NEW_MODE
      this.capabilities.alive = true
      this.capabilities.httpReachable = true
      this.capabilities.protocolUsable = true
      this.capabilities.auth = 'cookie'
      this.capabilities.version = '0.1.2-rc.1?'
      return this.mode
    }
    // At least note whether the HTTP server itself is reachable.
    this.capabilities.httpReachable = await this._httpReachable()
    this.capabilities.alive = this.capabilities.httpReachable
    this.mode = null
    this.capabilities.protocolUsable = false
    return null
  }

  /* P2-8：统一的网络调用参数。budget=预算名，label=诊断标签。
     调用方可以传 opts.deadlineAt 把剩余总预算收紧到本次请求。 */
  _netOpts(opts, budget, label) {
    return { signal: opts && opts.signal, timeoutMs: resolveTimeoutMs(opts, this.timeouts[budget]), label }
  }

  async _httpReachable(opts) {
    try {
      const res = await fetchWithTimeout(this.baseUrl + '/', { method: 'GET', redirect: 'manual' }, this._netOpts(opts, 'httpReachable', 'httpReachable'))
      return res.status === 200 || res.status === 401 || res.status === 303
    } catch (e) {
      return false
    }
  }

  async _oldHealth(opts) {
    try {
      const r = await this._rpcOld('session.list', {}, this._netOpts(opts, 'probe', 'probe old session.list'))
      return !!r && !!r.result
    } catch (e) {
      return false
    }
  }

  async _newHealth(opts) {
    try {
      await this.ensureAuth(true, opts)
      if (!this.authCookie) return false
      const r = await this._rpcNew('session/list', { args: { _request: {} } }, null, this._netOpts(opts, 'probe', 'probe new session/list'))
      return !!r && !!r.result
    } catch (e) {
      return false
    }
  }

  async probe() {
    await this.resolveMode(true)
    return {
      mode: this.mode,
      capabilities: { ...this.capabilities },
      diagnostics: [...this.diagnostics],
      authCookie: !!this.authCookie,
    }
  }

  /* ------------------------------ auth ------------------------------ */

  async captureToken() {
    if (!this.dshStartLogPath) return null
    try {
      const text = fs.readFileSync(this.dshStartLogPath, 'utf8')
      const m = text.match(/dsh web:\s*(https?:\/\/[^\s]+)/)
      if (!m) return null
      const u = new URL(m[1])
      const token = u.searchParams.get('token')
      if (!token) return null
      this.lastToken = token
      return token
    } catch (e) {
      return null
    }
  }

  async ensureAuth(refresh, opts) {
    if (!refresh && this.authCookie) return this.authCookie
    const token = await this.captureToken()
    if (!token) return null
    try {
      const r = await requestRaw(this.baseUrl, '/?token=' + encodeURIComponent(token), { method: 'GET' }, null, this._netOpts(opts, 'auth', 'auth token exchange'))
      if (r.status !== 200 && r.status !== 303) return null
      const cookie = setCookieFromResponse(r.headers)
      if (!cookie) return null
      this.authCookie = cookie
      this.capabilities.auth = 'cookie'
      return this.authCookie
    } catch (e) {
      this.diagnostics.push('auth exchange failed: ' + e.message)
      return null
    }
  }

  /**
   * P1-K.2 自适应：用**完整 token URL**（形如 http://127.0.0.1:3080/?token=…）换取会话 cookie。
   * 用途：判断"当前 3080 上这个 DSH 能否被本应用认证"——候选 URL 由调用方提供
   * （通常来自 dsh-start.log 里 `dsh web: …` 那行，见 peekAuthCandidateUrl）。
   * 只做认证交换：不改 baseUrl、不宣称协议可用；失败一律 fail-closed 返回 false。
   */
  async adoptAuthUrl(candidateUrl, opts) {
    if (typeof candidateUrl !== 'string' || !candidateUrl) return false
    try {
      const r = await requestRaw(candidateUrl, '', { method: 'GET' }, null, this._netOpts(opts, 'auth', 'auth token exchange'))
      if (r.status !== 200 && r.status !== 303) return false
      const cookie = setCookieFromResponse(r.headers)
      if (!cookie) return false
      this.authCookie = cookie
      this.capabilities.auth = 'cookie'
      return true
    } catch (e) {
      this.diagnostics.push('adopt auth url failed: ' + e.message)
      return false
    }
  }

  /** P1-K.2 自适应：只读探测"当前 3080 是否可被本应用认证"（刷新一次认证交换，不改其它状态） */
  async probeAuthenticated(opts) {
    try {
      return (await this.ensureAuth(true, opts)) != null
    } catch (e) {
      return false
    }
  }

  /**
   * Return the current authenticated Web UI URL.
   * Reuses auth/token state; safe fallback is the bare base URL (old DSH).
   */
  async authenticatedUrl() {
    const token = this.lastToken || await this.captureToken()
    if (!token) {
      // Old protocol has no auth; bare URL is correct.
      return this.baseUrl + '/'
    }
    // Ensure we have a valid cookie before handing the URL to a browser.
    await this.ensureAuth(true)
    return this.baseUrl + '/?token=' + encodeURIComponent(token)
  }

  /* ------------------------------ HTTP RPC ------------------------------ */

  async _rpcOld(method, payload, netOpts) {
    const rpcId = randomId('old')
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload })
    const res = await fetchWithTimeout(this.baseUrl + '/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }, netOpts || this._netOpts(null, 'rpc', 'old ' + method))
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from old ' + method)
    return res.json()
  }

  async _rpcNew(endpoint, payload, extraHeaders, netOpts) {
    const rpcId = randomId('new')
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
    const res = await fetchWithTimeout(this.baseUrl + '/api/' + endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.authCookie ? { Cookie: this.authCookie } : {}),
        ...(extraHeaders || {}),
      },
      body,
    }, netOpts || this._netOpts(null, 'rpc', 'new ' + endpoint))
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from new ' + endpoint)
    return res.json()
  }

  /**
   * Unified old-style entry point used by main.js's existing api().
   * Accepts old method names from business code and returns the same
   * {type:'server-response', rpcId, result} envelope in both protocols.
   * opts: { signal } —— 调用方（main.js api()）的截止时间，用于真正取消在途请求。
   */
  async api(method, payload, opts) {
    const mode = await this.resolveMode()
    const netOpts = this._netOpts(opts, 'rpc', 'rpc ' + method)
    if (mode === OLD_MODE) {
      return this._rpcOld(method, payload, netOpts)
    }
    if (mode === NEW_MODE) {
      /* workspace 列表：新协议里**没有** workspace/list 这种 RPC ——
         0.1.6 的 dsh-api-workspace-controller 只暴露 archiveSession / create / delete /
         follow / rename（本地 runtime grep 实测），列表快照只能从 `workspace/follow` 的
         baseline 帧取。而业务代码（pet.js 的 findWorkspaceId / refreshVisibleSessions）走的是
         通用 `api('workspace.list')` —— 以前到这里直接抛 "no mapping"，导致新建 DSH 聊天
         会话失败。这里在查映射表之前把它接到已有的 workspaceList()（它内部已实现 new 模式
         快照，返回同样的 { type, rpcId, result:{ ok, value } } 信封），不改动其它协议。 */
      if (method === 'workspace.list') return this.workspaceList(opts)
      const map = OLD_TO_NEW_METHODS[method]
      if (!map) {
        throw new Error('DSH new protocol has no mapping for ' + method)
      }
      const newPayload = map.payload ? await map.payload(payload, this, opts) : payload
      const r = await this._rpcNew(map.endpoint, newPayload, null, netOpts)
      return map.respond(r)
    }
    throw new Error('DSH protocol not available')
  }

  /* ------------------------------ session/page helpers ------------------------------ */

  async _resolveThroughSeqForSession(sessionId, opts) {
    // Prefer a cached latest seq from eventState if available.
    if (this.eventState && this.eventState.latestSeqBySession && this.eventState.latestSeqBySession[sessionId] !== undefined) {
      return this.eventState.latestSeqBySession[sessionId]
    }
    try {
      const list = await this.sessionList(opts)
      const row = ((list.result && list.result.value && list.result.value.items) || [])
        .find((s) => s.sessionId === sessionId)
      const seq = row && row.projections && row.projections.asOfSeq
      if (Number.isSafeInteger(seq) && seq >= 0) {
        if (!this.eventState.latestSeqBySession) this.eventState.latestSeqBySession = {}
        this.eventState.latestSeqBySession[sessionId] = seq
        return seq
      }
    } catch (e) {
      this.diagnostics.push('session/page throughSeq resolve failed: ' + e.message)
    }
    return Number.MAX_SAFE_INTEGER
  }

  /* ------------------------------ unified business API ------------------------------ */

  async sessionList(opts) { return this.api('session.list', {}, opts) }
  async sessionCreate(payload, opts) { return this.api('session.create', payload || {}, opts) }
  async sessionRename(payload, opts) { return this.api('session.rename', payload || {}, opts) }
  async sessionHistory(payload, opts) { return this.api('session.history', payload || {}, opts) }
  async sessionPrompt(payload, opts) { return this.api('session.prompt', payload || {}, opts) }
  async sessionModels(payload, opts) { return this.api('session.models', payload || {}, opts) }
  async sessionSelectModel(payload, opts) { return this.api('session.selectModel', payload || {}, opts) }
  async agentPresets(payload, opts) { return this.api('agentPreset.list', payload || {}, opts) }
  async agentPresetSelect(payload, opts) { return this.api('agentPreset.select', payload || {}, opts) }
  async permissionPresets(payload, opts) { return this.api('permissionPresets.catalog', payload || {}, opts) }
  async commandsExecute(payload, opts) { return this.api('commands.execute', payload || {}, opts) }
  async workspaceArchiveSession(payload, opts) { return this.api('workspace.archiveSession', payload || {}, opts) }
  async workspaceCreate(payload, opts) { return this.api('workspace.create', payload || {}, opts) }
  async workspaceRename(payload, opts) { return this.api('workspace.rename', payload || {}, opts) }
  async workspaceDelete(payload, opts) { return this.api('workspace.delete', payload || {}, opts) }

  async workspaceList(opts) {
    const mode = await this.resolveMode()
    if (mode === OLD_MODE) {
      return this.api('workspace.list', {}, opts)
    }
    if (mode === NEW_MODE) {
      // Return the internally normalized workspace snapshot from workspace/follow.
      const snap = await this._workspaceSnapshotNew(opts)
      return {
        type: 'server-response',
        rpcId: randomId('ws'),
        result: { ok: true, value: snap },
      }
    }
    throw new Error('DSH protocol not available')
  }

  async _workspaceSnapshotNew(opts) {
    await this.ensureAuth(true, opts)
    // Open a short-lived remote.mux workspace/follow stream and take baseline.
    const baselineMs = resolveTimeoutMs(opts, this.timeouts.wsBaseline)
    return new Promise((resolve, reject) => {
      let done = false
      let timer = null
      const streamId = randomId('ws-follow')
      // P2-8：建流成功但 baseline 帧永不到达时，之前会永久 pending（socket 也泄漏）。
      const finish = (fn, v) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        fn(v)
      }
      const socket = this._openRemoteMux((frame) => {
        if (done) return
        const value = frame && frame.value
        if (value && value.type === 'baseline') {
          try { socket.close() } catch (e) {}
          finish(resolve, {
            items: (value.value && value.value.items) || [],
            archivedSessionIds: (value.value && value.value.archivedSessionIds) || [],
          })
        } else if (frame && frame.type === 'error') {
          try { socket.close() } catch (e) {}
          finish(reject, new Error('workspace/follow error: ' + JSON.stringify(frame.error)))
        }
      }, (err) => {
        finish(reject, err)
      }, this._netOpts(opts, 'wsConnect', 'workspace/follow connect'))
      if (!socket) {
        finish(reject, new Error('cannot open remote.mux'))
        return
      }
      timer = setTimeout(() => {
        try { socket.close() } catch (e) { /* ignore */ }
        finish(reject, new DshTimeoutError('workspace/follow baseline', baselineMs))
      }, baselineMs)
      socket.on('open', () => {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: NEW_WORKSPACE_FOLLOW_ENDPOINT,
          payload: { args: {} },
        }))
      })
    })
  }

  /* ------------------------------ events / stream ------------------------------ */

  /**
   * Connect the DSH event downlink and forward normalized old-style frames
   * to onFrame. In auto mode it chooses old or new after detection.
   */
  async connectEvents(onFrame, opts) {
    const mode = await this.resolveMode()
    this.eventState.onFrame = onFrame
    if (mode === OLD_MODE) return this._connectOldEvents(onFrame, opts)
    if (mode === NEW_MODE) {
      await this.ensureAuth(true, opts)
      return this._connectNewEvents(onFrame, opts)
    }
    throw new Error('DSH protocol not available')
  }

  _connectOldEvents(onFrame, opts) {
    const WebSocketCtor = require('ws')
    return new Promise((resolve, reject) => {
      let sock
      try {
        sock = openWebSocketWithTimeout(WebSocketCtor, this.baseUrl + OLD_EVENTS_PATH, {}, this._netOpts(opts, 'wsConnect', 'events.mux connect (old)'))
      } catch (e) {
        reject(e)
        return
      }
      this.eventState.socket = sock
      sock.on('open', () => {
        this.capabilities.events = true
        resolve(sock)
      })
      sock.on('message', (data) => {
        const env = parseJsonSafe(String(data))
        if (!env) return
        if (onFrame) onFrame(env)
      })
      sock.on('error', reject)
      sock.on('close', () => {
        this.capabilities.events = false
        if (this.eventState.socket === sock) this.eventState.socket = null
      })
    })
  }

  _connectNewEvents(onFrame, opts) {
    return new Promise((resolve, reject) => {
      const streamId = randomId('events')
      const sock = this._openRemoteMux((frame) => {
        if (frame && frame.type === 'item') {
          const value = frame.value
          if (value && value.type === 'ready') {
            this.eventState.clientId = value.clientId
            this.eventState.streamId = streamId
            this.capabilities.events = true
            return
          }
          const old = this._mapNewEventToOld(streamId, value)
          if (old && onFrame) onFrame(old)
        } else if (frame && frame.type === 'error') {
          this.diagnostics.push('events.mux stream error: ' + JSON.stringify(frame.error))
        }
      }, (err) => {
        if (err && onFrame) {
          const synthetic = {
            type: 'server-request',
            rpcId: randomId('stream-error'),
            payload: { type: 'stream/error', error: { code: 'stream', message: String(err && err.message || err) } },
          }
          onFrame(synthetic)
        }
      }, this._netOpts(opts, 'wsConnect', 'remote.mux connect (events)'))
      if (!sock) {
        reject(new Error('cannot open remote.mux for events'))
        return
      }
      this.eventState.socket = sock
      sock.on('open', () => {
        sock.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: NEW_EVENTS_ENDPOINT,
          payload: { args: {} },
        }))
        resolve(sock)
      })
      sock.on('error', reject)
      sock.on('close', () => {
        this.capabilities.events = false
        if (this.eventState.socket === sock) this.eventState.socket = null
        this._clearPending('event stream closed')
      })
    })
  }

  _openRemoteMux(onMessage, onError, netOpts) {
    const WebSocketCtor = require('ws')
    let sock
    try {
      const options = {}
      if (this.authCookie) options.headers = { Cookie: this.authCookie }
      sock = openWebSocketWithTimeout(WebSocketCtor, this.baseUrl + NEW_REMOTE_MUX_PATH, options,
        netOpts || this._netOpts(null, 'wsConnect', 'remote.mux connect'))
    } catch (e) {
      if (onError) onError(e)
      return null
    }
    sock.on('message', (data) => {
      const frame = parseJsonSafe(String(data))
      if (frame) onMessage(frame)
    })
    sock.on('error', (e) => { if (onError) onError(e) })
    return sock
  }

  _mapNewEventToOld(streamId, value) {
    if (!value) return null
    if (value.type === 'waterfall') {
      const rpcId = randomId('dsh-event')
      const event = value.event
      if (event === 'approval/request') {
        const sessionId = (value.request && value.request.sessionId) || value.agentId
        const oldPayload = {
          type: 'approval/requested',
          sessionId,
          approvalId: value.eventId,
          toolName: value.request && value.request.toolName,
          callId: value.request && value.request.callId,
          reason: value.request && value.request.reason,
        }
        this.eventState.pending.set(rpcId, {
          kind: 'approval',
          event,
          clientId: this.eventState.clientId,
          eventId: value.eventId,
          sessionId: oldPayload.sessionId,
        })
        return { type: 'server-request', rpcId, payload: oldPayload }
      }
      if (event === 'user-questions/request') {
        const sessionId = (value.request && value.request.sessionId) || value.agentId
        const oldPayload = {
          type: 'question/requested',
          sessionId,
          questions: (value.request && value.request.questions) || [],
        }
        this.eventState.pending.set(rpcId, {
          kind: 'question',
          event,
          clientId: this.eventState.clientId,
          eventId: value.eventId,
          sessionId: oldPayload.sessionId,
        })
        return { type: 'server-request', rpcId, payload: oldPayload }
      }
      return null
    }
    // Non-waterfall emits are not part of the deskpet approval/question flow.
    return null
  }

  /* ------------------------------ pending lifecycle ------------------------------ */

  _clearPending(reason) {
    const n = this.eventState.pending.size
    if (n === 0) return
    this.eventState.pending.clear()
    this.diagnostics.push('cleared ' + n + ' pending interaction(s): ' + (reason || 'unknown'))
  }

  /* ------------------------------ answering ------------------------------ */

  async respond(payload, opts) {
    const mode = await this.resolveMode()
    const rpcId = payload && payload.rpcId
    if (mode === OLD_MODE) {
      const body = JSON.stringify({
        type: 'client-response',
        rpcId,
        result: { ok: true, value: payload && payload.value },
      })
      const res = await fetchWithTimeout(this.baseUrl + '/api/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }, this._netOpts(opts, 'respond', 'old respond'))
      if (!res.ok) throw new Error('HTTP ' + res.status + ' from respond')
      return { accepted: true }
    }
    if (mode === NEW_MODE) {
      const pending = this.eventState.pending.get(rpcId)
      if (!pending) {
        return { accepted: false, reason: 'not-pending' }
      }
      let outcomeValue
      if (pending.kind === 'approval') {
        outcomeValue = (payload.value && payload.value.outcome) || 'unavailable'
      } else {
        outcomeValue = (payload.value && payload.value.answer) || { answers: [] }
      }
      const result = {
        clientId: pending.clientId,
        eventId: pending.eventId,
        outcome: { kind: 'result', value: outcomeValue },
      }
      const r = await this._rpcNew(NEW_EVENTS_RESULT_ENDPOINT, { args: result }, null, this._netOpts(opts, 'respond', 'new $events/result'))
      if (!r || !r.result || !r.result.ok) {
        return { accepted: false, reason: 'rpc_failed' }
      }
      this.eventState.pending.delete(rpcId)
      // Synthesize resolved frames so renderer clears the interaction card.
      if (this.eventState.onFrame) {
        const sessionId = pending.sessionId
        if (pending.kind === 'approval') {
          this.eventState.onFrame({
            type: 'server-request',
            rpcId: randomId('resolved'),
            payload: {
              type: 'approval/resolved',
              sessionId,
              approvalId: pending.eventId,
              outcome: outcomeValue,
            },
          })
        } else {
          this.eventState.onFrame({
            type: 'server-request',
            rpcId: randomId('resolved'),
            payload: {
              type: 'question/resolved',
              sessionId,
              questionRpcId: rpcId,
            },
          })
        }
      }
      return { accepted: true }
    }
    throw new Error('DSH protocol not available')
  }

  async submitApproval(payload, opts) {
    return this.respond({ rpcId: payload.rpcId, value: payload.value }, opts)
  }

  async submitQuestionAnswer(payload, opts) {
    return this.respond({ rpcId: payload.rpcId, value: payload.value }, opts)
  }

  /* ------------------------------ health / gate ------------------------------ */

  async isDshUp() {
    const mode = await this.resolveMode(true)
    if (!mode) return false
    try {
      if (mode === OLD_MODE) {
        const r = await this._oldHealth()
        this.capabilities.alive = !!r
        this.capabilities.httpReachable = !!r
        return !!r
      }
      if (mode === NEW_MODE) {
        await this.ensureAuth(true)
        const r = await this._newHealth()
        this.capabilities.alive = !!r
        this.capabilities.httpReachable = !!r
        return !!r
      }
      return false
    } catch (e) {
      return false
    }
  }

  async compatibilityGate() {
    await this.resolveMode(true)
    return {
      mode: this.mode,
      capabilities: { ...this.capabilities },
      usable: !!this.mode && !!this.capabilities.protocolUsable,
      diagnostics: [...this.diagnostics],
    }
  }

  /* ------------------------------ lifecycle ------------------------------ */

  onDshStarted() {
    // Called after spawn; token is captured lazily on first new-mode use.
    this.mode = null
    this.authCookie = null
    this._detectPromise = null
  }

  stop() {
    this.eventState.stopRequested = true
    if (this.eventState.socket) {
      try { this.eventState.socket.close() } catch (e) {}
      this.eventState.socket = null
    }
    if (this.eventState.reconnectTimer) {
      clearTimeout(this.eventState.reconnectTimer)
      this.eventState.reconnectTimer = null
    }
    this._clearPending('compat stopped')
  }
}

function createDshCompat(options) {
  return new DshCompat(options || {})
}

module.exports = {
  createDshCompat, DshCompat, OLD_MODE, NEW_MODE, AUTO_MODE, DSH_COMPAT_VERSION,
  DshTimeoutError, DSH_TIMEOUT_DEFAULTS, // P2-8 统一超时层
}
