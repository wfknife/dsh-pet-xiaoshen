/* MemorySystem — 2.0 compatibility facade
 * Now delegates to MemoryEngine (3.0-04). Kept only for legacy callers/tests.
 * New code should call MemoryEngine directly.
 */
window.MemorySystem = (function () {
  let api = null
  function bind(a) { api = a || null; return api }
  function candidate(content, importance) {
    return {
      content: String(content || '').slice(0, 200),
      importance: Number(importance) || 0,
      ts: Date.now(),
      sourceType: 'event',
      sourceEventIds: []
    }
  }
  function store(c) {
    if (window.MemoryEngine && typeof window.MemoryEngine.addCandidate === 'function') {
      return window.MemoryEngine.addCandidate(c)
    }
    if (api && typeof api.addMemory === 'function') return api.addMemory(c)
    return null
  }
  function addMemory(c) { return store(c) }
  function remember(content, opts) {
    if (window.MemoryEngine && typeof window.MemoryEngine.remember === 'function') {
      return window.MemoryEngine.remember(content, opts)
    }
    return null
  }
  return { bind, candidate, store, addMemory, remember }
})()
