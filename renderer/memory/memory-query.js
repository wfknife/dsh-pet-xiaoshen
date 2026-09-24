/* MemoryQuery — v3.3 Batch B
 * Query parsing and target resolution for forget/restore.
 */
window.MemoryQuery = (function () {
  function parseMemoryQuery(text) {
    if (window.MemoryTopic && typeof window.MemoryTopic.parseMemoryIntent === 'function') {
      return window.MemoryTopic.parseMemoryIntent(text)
    }
    return { intent: 'none', subjectKey: null, propertyKey: null, valueKey: null, historical: false, includeSuperseded: false }
  }

  function matchesQuery(m, query) {
    if (!m) return false
    if (query.subjectKey && m.subjectKey !== query.subjectKey) return false
    if (query.propertyKey && m.propertyKey !== query.propertyKey && m.propertyKey !== null) return false
    if (query.valueKey && m.valueKey !== query.valueKey && !(m.content && m.content.indexOf(query.valueKey) >= 0)) return false
    return true
  }

  function resolveTarget(text, memories, mode) {
    const query = parseMemoryQuery(text)
    const list = Array.isArray(memories) ? memories : []
    let candidates = list.filter((m) => matchesQuery(m, query))
    if (mode === 'restore') candidates = candidates.filter((m) => m.status === 'suppressed')
    if (mode === 'forget') candidates = candidates.filter((m) => m.status === 'active' || m.status === 'fading' || m.status === 'suppressed')
    if (query.valueKey) {
      // Prefer exact valueKey matches; fall back to content matches already included.
      const exact = candidates.filter((m) => m.valueKey === query.valueKey)
      if (exact.length) candidates = exact
    }
    return {
      query,
      count: candidates.length,
      unique: candidates.length === 1,
      memories: candidates,
      target: candidates.length === 1 ? candidates[0] : null
    }
  }

  return {
    parseMemoryQuery,
    resolveTarget
  }
})()
