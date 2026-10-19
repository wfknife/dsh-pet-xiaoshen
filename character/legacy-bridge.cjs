'use strict'
/**
 * K8 旧入口 → 新内核的桥（单一权威切换点）。
 *
 * 三种模式的行为必须严格区分，不能“尽量两边都写”：
 *
 *  - off       ：全部走旧路径（当前正式行为，零变化）。
 *  - candidate ：旧 store 仍是 UI 的唯一权威；内核在**隔离目录**里接收主人消息的镜像，
 *                用于验证协议与导入，不把内核结果写回旧 store。
 *                （这是对总规“候选模式下旧 store 只读”的**有意收窄**：完整只读要求
 *                 renderer 全量改读投影，属于 K6/K8 未完成项，见 DECISIONS.md D-03。）
 *  - active    ：内核是唯一写入者。旧写入口在此返回 kernel_authority，
 *                而不是悄悄回退成旧写（否则就是双写）。
 *
 * 无论哪种模式，一次调用只允许一个权威写入者。
 */

const OWNER_MESSAGE_METHODS = new Set(['characterHistory:append'])
const KERNEL_OWNED_METHODS = new Set([
  'state:save', 'memory:save', 'persona:save', 'petLife:save',
  'platform:factBegin', 'platform:factAdvance', 'platform:extraction', 'platform:operationBegin',
  'platform:operationUpdate', 'platform:forget', 'platform:delivery',
  'characterHistory:append', 'characterHistory:clear', 'diary:event',
])

/**
 * @param {{host: object, mode: string, logger?: Function}} deps
 */
function createBridge (deps) {
  const host = deps.host
  const mode = deps.mode
  const log = typeof deps.logger === 'function' ? deps.logger : () => {}

  /** 该 IPC 在 active 模式下是否必须由内核处理。 */
  function isKernelOwned (method) {
    return KERNEL_OWNED_METHODS.has(method)
  }

  /**
   * active 模式下的写入口守卫。
   * @returns {null|{ok:false, reason:string, mode:string}} null 表示“交给旧路径”
   */
  function guard (method) {
    if (mode === 'off') return null
    if (mode === 'candidate') return null
    if (!isKernelOwned(method)) return null
    if (!host.isWritable()) {
      // 内核崩溃/未就绪时禁止写入，绝不静默降级回旧写（§18.2）。
      return { ok: false, reason: 'kernel_unavailable_write_blocked', mode }
    }
    return { ok: false, reason: 'kernel_authority', mode }
  }

  /**
   * candidate 镜像：把主人消息投给内核。失败只记录，不影响旧路径结果——
   * 因为 candidate 模式下内核不是权威。
   */
  function mirrorOwnerMessage (method, args) {
    if (mode !== 'candidate') return { mirrored: false, reason: 'mode_not_candidate' }
    if (!OWNER_MESSAGE_METHODS.has(method)) return { mirrored: false, reason: 'method_not_mirrored' }
    if (!host.isWritable()) return { mirrored: false, reason: 'kernel_not_writable' }
    const entry = args && args[0]
    if (!entry || entry.role !== 'user' || typeof entry.text !== 'string' || !entry.messageRef) {
      return { mirrored: false, reason: 'not_owner_message' }
    }
    const command = {
      commandId: 'owner:' + String(entry.messageRef),
      schemaVersion: 1,
      kind: 'owner.message',
      characterId: null,
      payload: { messageRef: String(entry.messageRef), text: String(entry.text).slice(0, 8000), ts: Number(entry.ts) || Date.now(), timezone: 'Asia/Shanghai' },
    }
    Promise.resolve(host.submit(command))
      .then(result => {
        if (!result || result.ok !== true) log('mirror owner message rejected', JSON.stringify(result && result.code))
      })
      .catch(error => log('mirror owner message failed', error && error.message))
    return { mirrored: true }
  }

  return { mode, guard, isKernelOwned, mirrorOwnerMessage, KERNEL_OWNED_METHODS }
}

// New members of a domain namespace are denied until explicitly routed.
function domainMethod(method) {
  return /^(state|memory|persona|petLife|characterHistory|platform|diary|lifeContext|proactive):/.test(method) ||
    ['llm:direct', 'chat:send', 'minesweeper:reward', 'clean:run'].includes(method)
}
function installBoundary(ipcMain, { owns, route }) {
  for (const name of ['handle', 'on']) {
    const register = ipcMain[name].bind(ipcMain)
    ipcMain[name] = (method, listener) => register(method, (event, ...args) => {
      if (!owns() || !domainMethod(method)) return listener(event, ...args)
      return route(method, event, args)
    })
  }
}
module.exports = { createBridge, KERNEL_OWNED_METHODS, OWNER_MESSAGE_METHODS, domainMethod, installBoundary }
