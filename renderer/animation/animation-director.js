/* Animation Director — Phase 3
 * 记录并逐步仲裁“现在应该播什么”。
 * Phase 3 先建立请求/当前状态/优先级/打断原因的运行时视图；
 * 后续 Behavior Director 稳定后，再把这层变成真正的硬调度器。
 */
window.AnimationDirector = (function () {
  let current = null
  let requestSeq = 0
  const history = []

  function prioOf(source) {
    switch (source) {
      case 'drag': return 100
      case 'user': return 90
      case 'interaction': return 80
      case 'work': return 50
      case 'needs': return 30
      case 'idle': return 10
      default: return 20
    }
  }

  function request(opts) {
    const o = opts || {}
    const id = String(o.id || '')
    const source = o.source || 'unknown'
    const priority = Number.isFinite(o.priority) ? o.priority : prioOf(source)
    const interruptible = o.interruptible !== false
    const prev = current
    const req = {
      id,
      source,
      priority,
      interruptible,
      requestId: ++requestSeq,
      startedAt: Date.now(),
      reason: o.reason || ''
    }
    if (prev && prev.id !== id) {
      pushHistory({ ...prev, endedAt: Date.now(), endReason: 'superseded' })
    }
    current = req
    return { accepted: true, request: req, previous: prev || null }
  }

  function end(reason) {
    if (!current) return null
    const ended = { ...current, endedAt: Date.now(), endReason: reason || 'ended' }
    pushHistory(ended)
    current = null
    return ended
  }

  function pushHistory(item) {
    history.push(item)
    if (history.length > 50) history.shift()
  }

  function getState() {
    return {
      current: current ? { ...current } : null,
      history: history.slice(-10)
    }
  }

  function clear() {
    end('clear')
  }

  return { request, end, getState, clear, prioOf }
})()
