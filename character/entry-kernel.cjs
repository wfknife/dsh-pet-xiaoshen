'use strict'
/**
 * K2 内核进程入口（Electron utilityProcess）。
 *
 * 这个进程是角色数据库的**唯一写入者**。renderer 重载不会重建它；
 * 关窗进托盘时继续；真正退出应用时保存并停止；电脑关闭时不虚构活动。
 *
 * 通信是双向的：
 *   parent → kernel: {type:'request', id, method, params}
 *   kernel → parent: {type:'request', id, method, params}   （模型/感知/prompt/表现）
 *   kernel → parent: {type:'event'|'ready'|'fatal'}
 */

const path = require('node:path')

function createParentPort () {
  if (process.parentPort && typeof process.parentPort.postMessage === 'function') {
    return process.parentPort
  }
  // 非 utilityProcess 环境（例如未来的 node 直跑）：退化成无端口，明确不可用。
  return null
}

function main () {
  const mode = String(process.env.DESKPET_CHARACTER_MODE || 'candidate')
  const dataDir = String(process.env.DESKPET_CHARACTER_DATA_DIR || '')
  const port = createParentPort()

  const log = (...args) => {
    try { process.stdout.write('[character-kernel] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n') } catch (_) {}
  }

  if (!port) {
    log('no parent port; refusing to run as an unsupervised writer')
    process.exit(0)
  }
  if (!dataDir) {
    port.postMessage({ type: 'fatal', error: 'data_dir_missing' })
    process.exit(1)
  }

  const { createKernel } = require('./runtime/kernel.cjs')
  const { resolvePaths, createConfig, KERNEL_MODES } = require('./config.cjs')

  const normalizedMode = KERNEL_MODES.includes(mode) ? mode : 'candidate'
  const paths = resolvePaths({ dataDir, mode: normalizedMode })
  const config = createConfig()

  let seq = 0
  const pending = new Map()

  function request (method, params, options = {}) {
    const id = 'k' + (++seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Object.assign(new Error('host_timeout'), { code: 'host_timeout' }))
      }, 60000)
      if (timer.unref) timer.unref()
      const signal = options.signal
      const abort = () => {
        if (!pending.delete(id)) return
        clearTimeout(timer)
        port.postMessage({ type: 'cancel-request', id })
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      }
      if (signal?.aborted) { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return }
      if (signal) signal.addEventListener('abort', abort, { once: true })
      pending.set(id, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value) },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error) }, timer })
      port.postMessage({ type: 'request', id, method, params })
    })
  }

  port.on('message', event => {
    const message = event && event.data ? event.data : event
    if (!message || typeof message !== 'object') return
    if (message.type === 'response') {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(Object.assign(new Error(message.error && message.error.code || 'host_error'), message.error || {}))
    }
  })

  const hostBridge = { request }

  const presentation = {
    publish: intent => request('presentation.publish', intent),
  }

  const kernel = createKernel({
    paths,
    config,
    mode: normalizedMode,
    dataDir,
    bootstrapLegacy: process.env.DESKPET_CHARACTER_BOOTSTRAP === '1',
    host: hostBridge,
    presentation,
    logger: log,
  })

  kernel.subscribe(0, delta => {
    port.postMessage({ type: 'event', event: delta })
  })

  async function handleRequest (message) {
    try {
      if (message.method === 'character.shutdown') { await shutdown(message.id); return }
      if (message.method === 'character.submit') {
        const value = await kernel.submit(message.params)
        port.postMessage({ type: 'response', id: message.id, ok: true, value })
        return
      }
      if (message.method === 'character.read') {
        const value = kernel.read(message.params || {})
        port.postMessage({ type: 'response', id: message.id, ok: true, value })
        return
      }
      if (message.method === 'character.cancel') {
        // 取消是 command，不是另开写入口（§9.1）。
        const command = {
          commandId: 'cancel:' + (message.params && message.params.commandId || Date.now()),
          schemaVersion: 1,
          kind: 'owner.control',
          characterId: message.params && message.params.characterId,
          payload: { action: 'cancel_auto' },
        }
        const info = kernel.info()
        if (!command.characterId) command.characterId = info.characterId
        const value = await kernel.submit(command)
        port.postMessage({ type: 'response', id: message.id, ok: true, value })
        return
      }
      if (message.method === 'character.status') {
        port.postMessage({ type: 'response', id: message.id, ok: true, value: { ...kernel.info(), status: 'ok' } })
        return
      }
      port.postMessage({ type: 'response', id: message.id, ok: false, error: { code: 'method_unknown', detail: message.method } })
    } catch (error) {
      port.postMessage({
        type: 'response', id: message.id, ok: false,
        error: { code: String(error && error.code || 'internal').slice(0, 80), detail: String(error && error.message || error).slice(0, 300) },
      })
    }
  }

  port.on('message', event => {
    const message = event && event.data ? event.data : event
    if (!message || message.type !== 'request') return
    handleRequest(message)
  })

  const started = kernel.start()
  if (!started.ok) {
    port.postMessage({ type: 'fatal', error: started.code || started.reason || 'start_failed' })
    process.exit(1)
  }
  port.postMessage({ type: 'ready', info: kernel.info() })

  let shuttingDown = false
  async function shutdown (requestId) {
    if (shuttingDown) return
    shuttingDown = true
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('host_shutting_down')) }
    pending.clear()
    try { await kernel.stop() } catch (error) { log('stop failed', error.message) }
    if (typeof requestId === 'string') port.postMessage({ type: 'response', id: requestId, ok: true, value: { ok: true, stopped: true } })
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('uncaughtException', error => {
    log('uncaught', error && error.stack ? error.stack : String(error))
    port.postMessage({ type: 'fatal', error: 'uncaught_exception' })
    shutdown()
  })
  process.on('unhandledRejection', reason => {
    log('unhandled rejection', String(reason))
  })
}

main()
