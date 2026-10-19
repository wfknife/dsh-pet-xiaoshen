/* Scheduler — Phase 5
 * 统一管理 timer 的 owner 与生命周期，避免 reload/关闭后重复 timer。
 * 当前先接纳核心 needs tick；后续逐步迁移动画、提醒、游戏、DSH poll。
 */
window.Scheduler = (function () {
  const timers = new Map() // owner -> { kind, id }

  function after(owner, ms, fn) {
    cancel(owner)
    const id = setTimeout(() => {
      timers.delete(owner)
      if (typeof fn === 'function') fn()
    }, ms)
    timers.set(owner, { kind: 'timeout', id })
    return id
  }

  function every(owner, ms, fn) {
    cancel(owner)
    if (window.pet?.character?.authority && ['needs', 'diary2'].includes(owner)) return null
    const id = setInterval(() => {
      if (typeof fn === 'function') fn()
    }, ms)
    timers.set(owner, { kind: 'interval', id })
    return id
  }

  function cancel(owner) {
    const t = timers.get(owner)
    if (!t) return false
    if (t.kind === 'timeout') clearTimeout(t.id)
    else clearInterval(t.id)
    timers.delete(owner)
    return true
  }

  function has(owner) { return timers.has(owner) }
  function owners() { return Array.from(timers.keys()) }

  function cancelAll() {
    for (const owner of Array.from(timers.keys())) cancel(owner)
  }

  function shutdown() {
    cancelAll()
  }

  return { after, every, cancel, has, owners, cancelAll, shutdown }
})()
