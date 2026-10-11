/* EventBus — Phase 6
 * 轻量事件总线。先建立事件出口，后续 System 逐步订阅，
 * 避免一个动作直接修改十几个模块。
 */
window.EventBus = (function () {
  const handlers = new Map() // event -> Set<fn>
  const recentLog = [] // max 20 recent events for readonly consumers

  function on(event, fn) {
    if (!handlers.has(event)) handlers.set(event, new Set())
    handlers.get(event).add(fn)
    return () => off(event, fn)
  }

  function once(event, fn) {
    const wrapper = (payload) => {
      off(event, wrapper)
      fn(payload)
    }
    return on(event, wrapper)
  }

  function off(event, fn) {
    const set = handlers.get(event)
    if (!set) return false
    if (!fn) { handlers.delete(event); return true }
    set.delete(fn)
    if (!set.size) handlers.delete(event)
    return true
  }

  function emitOnce(event, payload, eventId) {
    const id = eventId || (event + ':' + JSON.stringify(payload || {}))
    if (window.Idempotency && !window.Idempotency.mark(id)) return 0
    return emit(event, payload)
  }

  function emit(event, payload) {
    const set = handlers.get(event)
    if (!set) return 0
    let n = 0
    for (const fn of Array.from(set)) {
      try { fn(payload); n++ } catch (err) { console.error('[EventBus]', event, err) }
    }
    if (recentLog.length >= 20) recentLog.shift()
    recentLog.push({ event, payload: JSON.parse(JSON.stringify(payload || {})), ts: Date.now() })
    return n
  }

  function events() { return Array.from(handlers.keys()) }

  function recent() { return recentLog.map((x) => ({ ...x, payload: JSON.parse(JSON.stringify(x.payload || {})) })) }

  function listeners(event) {
    return handlers.has(event) ? handlers.get(event).size : 0
  }

  function clear() { handlers.clear() }

  return { on, once, off, emit, emitOnce, events, recent, listeners, clear }
})()
