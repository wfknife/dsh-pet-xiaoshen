/* Idempotency — Phase 10
 * 仅用于运行时去重。真实持久化结算去重后续再接入 StateStore。
 */
window.Idempotency = (function () {
  const seen = new Set()
  function mark(key) {
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
  function has(key) { return seen.has(key) }
  function clear() { seen.clear() }
  return { mark, has, clear }
})()
