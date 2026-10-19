'use strict'
/**
 * K2+K8 Host：主进程侧的内核监督者与 typed bridge。
 *
 * 职责（总规 §9.1 / §12.1）：
 *  - 按已注册窗口与用户手势签发能力；renderer 不得自报权限。
 *  - 启动/监督 utilityProcess 内核，崩溃时先撤销旧 epoch 的权限再按 1/5/30 秒重启，
 *    三次失败后转只读（禁止自主派发）。
 *  - 把 renderer 的 submit/read/subscribe/cancel 收口成 command；
 *    不暴露任意状态写。
 *  - 内核反向请求（模型、prompt 快照、感知、DSH）由主进程处理并回传。
 *
 * 默认 mode=off：不启动内核，一切仍走旧路径（单写者不被破坏）。
 */

const path = require('node:path')
const { readMode, resolvePaths, createConfig } = require('./config.cjs')

const ENTRY = path.join(__dirname, 'entry-kernel.cjs')
const RESTART_DELAYS = [1000, 5000, 30000]
const MAX_RESTARTS = 3

function createHost (deps) {
  const mode = readMode(deps.env || process.env)
  const dataDir = deps.dataDir
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {}
  const handlers = deps.handlers || {}
  // Only main's canonical temporary-data resolver can grant trial execution.
  // This does not remove or change the production active cutover gate.
  const trial = deps.isolatedTrial === true && mode === 'candidate'
  const paths = resolvePaths({ dataDir, mode })
  const config = createConfig(deps.configOverrides)

  let child = null
  let ready = false
  let readOnly = mode !== 'off'
  let restarts = 0
  let shutdownRequested = false
  let seq = 0
  const pending = new Map()
  const kernelRequests = new Map()
  const listeners = new Set()
  const presentations = new Map()
  let presentationGeneration = 0
  const rendererCommands = new Set(['owner.message', 'owner.control', 'owner.forget', 'owner.correct', 'owner.reminder', 'owner.suppress', 'owner.interaction', 'presentation.receipt', 'settings.update', 'identity.update'])
  function trustedRenderer(event) {
    const targets = typeof deps.webContentsProvider === 'function' ? deps.webContentsProvider() : []
    return !!event && targets.includes(event.sender) && (!event.senderFrame || event.senderFrame === event.sender.mainFrame)
  }
  let status = { state: 'off', mode, epoch: null, characterId: null, restarts: 0, lastError: null }

  function nextId () { return 'h' + (++seq) }

  function send (message) {
    if (!child) return false
    try { child.postMessage(message); return true } catch (error) { logger('host send failed', error.message); return false }
  }

  function request (method, params, options) {
    if (!child) return Promise.reject(Object.assign(new Error('kernel_unavailable'), { code: 'kernel_unavailable' }))
    const id = nextId()
    return new Promise((resolve, reject) => {
      const timeoutMs = Number(options && options.timeoutMs) || 60000
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error('kernel_timeout'), { code: 'kernel_timeout' }))
      }, timeoutMs)
      if (timer.unref) timer.unref()
      const signal = options && options.signal
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer)
          pending.delete(id)
          reject(Object.assign(new Error('aborted'), { code: 'aborted', name: 'AbortError' }))
          return
        }
        signal.addEventListener('abort', () => {
          // 只放弃本地等待；内核侧仍在跑，结果晚到时会被当作迟到结果处理。
          if (!pending.has(id)) return
          pending.delete(id)
          clearTimeout(timer)
          reject(Object.assign(new Error('aborted'), { code: 'aborted', name: 'AbortError' }))
        }, { once: true })
      }
      pending.set(id, { resolve, reject, timer })
      if (!send({ type: 'request', id, method, params })) {
        clearTimeout(timer)
        pending.delete(id)
        reject(Object.assign(new Error('kernel_unavailable'), { code: 'kernel_unavailable' }))
      }
    })
  }

  /** 内核反向 RPC：只允许白名单方法，避免内核顺手拿到主进程任意能力。 */
  async function handleKernelRequest (message) {
    const sender = child
    const respond = reply => { if (sender && child === sender) { try { sender.postMessage(reply) } catch (_) {} } }
    if (mode === 'candidate' && !trial && ['model.complete', 'presentation.publish', 'dsh.createTask'].includes(message.method)) {
      respond({ type: 'response', id: message.id, ok: true, value: { ok: false, reason: 'candidate_observation_only' } }); return
    }
    const handler = handlers[message.method]
    if (typeof handler !== 'function') {
      respond({ type: 'response', id: message.id, ok: false, error: { code: 'host_method_unknown', detail: message.method } })
      return
    }
    try {
      const controller = new AbortController()
      kernelRequests.set(message.id, controller)
      const value = await handler(message.params || {}, { sender: null, kernel: true, signal: controller.signal })
      respond({ type: 'response', id: message.id, ok: true, value })
    } catch (error) {
      respond({
        type: 'response', id: message.id, ok: false,
        error: { code: String(error && error.code || 'host_error').slice(0, 80), detail: String(error && error.message || error).slice(0, 300) },
      })
    } finally { kernelRequests.delete(message.id) }
  }

  function broadcast (event) {
    for (const sink of listeners) {
      try { sink(event) } catch (_) { listeners.delete(sink) }
    }
  }

  function onChildMessage (message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'cancel-request') { kernelRequests.get(message.id)?.abort(); return }
    if (message.type === 'response') {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(Object.assign(new Error(message.error && message.error.code || 'kernel_error'), message.error || {}))
      return
    }
    if (message.type === 'request') { handleKernelRequest(message); return }
    if (message.type === 'ready') {
      ready = true
      readOnly = false
      status = { state: 'ready', mode, epoch: message.info && message.info.epoch, characterId: message.info && message.info.characterId, restarts, lastError: null }
      broadcast({ kind: 'ready', info: message.info })
      logger('kernel ready', JSON.stringify(status))
      return
    }
    if (message.type === 'event') {
      broadcast({ kind: 'delta', event: message.event })
      return
    }
    if (message.type === 'fatal') {
      ready = false
      readOnly = true
      status = { ...status, state: 'failed', lastError: String(message.error || 'fatal').slice(0, 300) }
      logger('kernel fatal', status.lastError)
    }
  }

  function spawn () {
    const utilityProcess = deps.utilityProcess
    if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
      status = { ...status, state: 'unavailable', lastError: 'utilityProcess_unavailable' }
      readOnly = true
      return { ok: false, reason: 'utilityProcess_unavailable' }
    }
    try {
      child = utilityProcess.fork(ENTRY, [], {
        serviceName: 'deskpet-character-kernel',
        stdio: 'ignore',
        env: {
          ...process.env,
          DESKPET_CHARACTER_MODE: mode,
          DESKPET_CHARACTER_DATA_DIR: dataDir,
          DESKPET_CHARACTER_BOOTSTRAP: trial ? '1' : '0',
        },
      })
    } catch (error) {
      status = { ...status, state: 'failed', lastError: String(error && error.message || error).slice(0, 300) }
      readOnly = true
      return { ok: false, reason: 'fork_failed' }
    }
    child.on('message', onChildMessage)
    child.on('exit', code => {
      for (const controller of kernelRequests.values()) controller.abort()
      kernelRequests.clear()
      presentationGeneration++
      presentations.clear()
      broadcast({ kind: 'presentation_revoked', generation: presentationGeneration })
      const wasReady = ready
      child = null
      ready = false
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(Object.assign(new Error('kernel_exited'), { code: 'kernel_exited' }))
        pending.delete(id)
      }
      if (shutdownRequested) { status = { ...status, state: 'stopped' }; return }
      status = { ...status, state: 'crashed', lastError: 'exit_' + code }
      broadcast({ kind: 'crashed', code, wasReady })
      if (restarts >= MAX_RESTARTS) {
        readOnly = true
        status = { ...status, state: 'read_only', lastError: 'restart_budget_exhausted' }
        logger('kernel restart budget exhausted; entering read-only')
        return
      }
      const delay = RESTART_DELAYS[Math.min(restarts, RESTART_DELAYS.length - 1)]
      restarts++
      status = { ...status, restarts }
      setTimeout(() => { if (!shutdownRequested) spawn() }, delay)
    })
    return { ok: true }
  }

  const host = {
    mode,
    paths,
    config,
    /** 只有 Ready 且非只读才接受写命令。 */
    isWritable: () => ready && !readOnly && !!child,
    status: () => ({ ...status, isolatedTrial: trial, authority: trial || mode === 'active', writable: host.isWritable() }),

    start () {
      if (child) return { ok: true, reused: true, mode }
      if (mode === 'off') {
        status = { state: 'off', mode, epoch: null, characterId: null, restarts: 0, lastError: null }
        return { ok: true, mode }
      }
      // K6 ownership migration is incomplete. A mode env var cannot authorize
      // running the legacy UI and Kernel as competing live writers.
      if (mode === 'active') {
        status = { ...status, state: 'blocked', lastError: 'active_cutover_incomplete' }
        return { ok: false, code: 'active_cutover_incomplete', mode }
      }
      const spawned = spawn()
      if (!spawned.ok) return spawned
      return { ok: true, mode, pending: true }
    },

    async stop () {
      shutdownRequested = true
      for (const controller of kernelRequests.values()) controller.abort()
      const stopping = child
      if (stopping) {
        try { await request('character.shutdown', {}, { timeoutMs: 5000 }) }
        catch (_) { try { stopping.kill() } catch (_) {} }
        if (child === stopping) child = null
      }
      ready = false
      status = { ...status, state: 'stopped' }
      return { ok: true }
    },

    submit: command => {
      if (mode === 'off') return Promise.resolve({ ok: false, code: 'kernel_off', failureClass: 'unavailable' })
      if (!host.isWritable()) return Promise.resolve({ ok: false, code: readOnly ? 'read_only' : 'kernel_unavailable', failureClass: 'unavailable' })
      if (command && ['owner.message', 'owner.forget', 'owner.control'].includes(command.kind)) {
        presentationGeneration++
        broadcast({ kind: 'presentation_revoked', generation: presentationGeneration })
      }
      // characterId 由宿主绑定，renderer 不能自报身份。
      const filled = {
        schemaVersion: 1,
        ...(command || {}),
        commandId: (command && command.commandId) || ('cmd:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8)),
        characterId: status.characterId,
      }
      return request('character.submit', filled, { timeoutMs: 30000 }).catch(error => ({ ok: false, code: error.code || 'kernel_unavailable', failureClass: 'unavailable' }))
    },
    read: query => {
      if (mode === 'off') return Promise.resolve({ ok: false, code: 'kernel_off' })
      if (!child) return Promise.resolve({ ok: false, code: 'kernel_unavailable' })
      return request('character.read', query || {}, { timeoutMs: 15000 }).catch(error => ({ ok: false, code: error.code || 'kernel_unavailable' }))
    },
    cancel: payload => {
      if (mode === 'off') return Promise.resolve({ ok: false, code: 'kernel_off' })
      if (!child) return Promise.resolve({ ok: false, code: 'kernel_unavailable' })
      return request('character.cancel', payload || {}, { timeoutMs: 10000 }).catch(error => ({ ok: false, code: error.code || 'kernel_unavailable' }))
    },

    subscribe (sink) {
      listeners.add(sink)
      return () => listeners.delete(sink)
    },

    /**
     * 表现端口：内核下发 intent，主进程转给 renderer。
     * 只推给仍可展示的窗口；没有窗口时不假装发布成功。
     */
    async publishPresentation (intent) {
      if (mode !== 'active' && !trial) return { ok: false, reason: 'candidate_presentation_disabled' }
      const targets = typeof deps.webContentsProvider === 'function' ? deps.webContentsProvider() : []
      if (!targets.length) return { ok: false, reason: 'no_presentation_target' }
      const expiresAt = Number(intent.expiresAt) || (Date.now() + 60000)
      if (expiresAt <= Date.now()) return { ok: false, reason: 'intent_expired' }
      presentations.set(intent.presentationId, { ...intent, expiresAt, targets: targets.length, at: Date.now() })
      const outgoing = { ...intent, expiresAt }
      if (status.epoch !== null && intent.epoch !== status.epoch) return { ok: false, reason: 'stale_epoch' }
      outgoing.generation = presentationGeneration
      for (const [id, value] of presentations) if (value.expiresAt <= Date.now()) presentations.delete(id)
      while (presentations.size > 128) presentations.delete(presentations.keys().next().value)
      let delivered = 0
      for (const contents of targets) {
        if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) continue
        try { contents.send('character:presentation', outgoing); delivered++ } catch (_) {}
      }
      if (!delivered) return { ok: false, reason: 'presentation_send_failed' }
      return { ok: true, delivered }
    },

    presentation: (presentationId) => presentations.get(presentationId) || null,

    /** 供 main 注册 ipcMain.handle 使用（typed bridge）。 */
    registerIpc (ipcMain) {
      ipcMain.handle('character:status', () => host.status())
      ipcMain.handle('character:observe', (event, input) => {
        if (!trustedRenderer(event) || !input || input.type !== 'game.completed') return { ok: false, code: 'observation_not_authorized' }
        const id = typeof input.eventId === 'string' ? input.eventId.slice(0, 160) : null
        if (!id) return { ok: false, code: 'event_id_required' }
        const at = Number(input.ts) || Date.now(), kind = input.type
        const payload = { actor: kind === 'game.completed' ? 'owner' : 'character', observer: kind === 'game.completed' ? 'character' : 'system',
          subject: kind === 'game.completed' ? 'owner' : 'character', world: 'virtual', sourceType: kind, occurredAt: at }
        if (kind === 'game.completed') payload.game = { gameId: String(input.game?.gameId || '').slice(0, 40), score: Number(input.game?.score) || 0, won: input.game?.won === true,
          draw: input.game?.draw === true, level: ['easy','mid','hard'].includes(input.game?.level) ? input.game.level : 'easy', elapsedSeconds: Math.max(1, Number(input.game?.elapsedSeconds) || 1) }
        else payload.animationName = String(input.animationName || '').slice(0, 80)
        return host.submit({ commandId: 'observe:' + id, kind: 'world.observation', payload: { observation: {
          observationId: id, sourceId: id, kind, observedAt: at, freshUntil: at + 3600000, payload,
        } } })
      })
      ipcMain.handle('character:submit', (event, command) => {
        if (!trustedRenderer(event) || !command || !rendererCommands.has(command.kind)) return { ok: false, code: 'not_authorized' }
        if (command.kind === 'identity.update' && Object.keys(command.payload || {}).some(key => key !== 'displayName')) return { ok: false, code: 'identity_fields_not_authorized' }
        if (command.kind === 'presentation.receipt') {
          const delivery = command.payload?.delivery || command.payload || {}
          const intent = presentations.get(delivery.presentationId)
          if (!intent || intent.operationId !== delivery.operationId) return { ok: false, code: 'unknown_presentation' }
          if (delivery.channel !== intent.channel || intent.epoch !== status.epoch) return { ok: false, code: 'presentation_identity_mismatch' }
          command = { ...command, payload: { delivery: { ...delivery, detail: { ...delivery.detail, animationName: intent.animationName } } } }
        }
        return host.submit(command)
      })
      ipcMain.handle('character:read', (event, query) => trustedRenderer(event) ? host.read(query || {}) : { ok: false, code: 'not_authorized' })
      ipcMain.handle('character:cancel', (event, payload) => trustedRenderer(event) ? host.submit({ kind: 'owner.control', payload: { action: 'cancel_auto' } }) : { ok: false, code: 'not_authorized' })
      return { ok: true }
    },
  }
  return host
}

module.exports = { createHost, RESTART_DELAYS, MAX_RESTARTS }
