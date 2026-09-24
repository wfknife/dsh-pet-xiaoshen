/* MemoryMessageRef — v3.3 Batch B
 * Renderer-side MessageRef generator for character chat history.
 * Format: chat-<sessionEpoch>-<monotonicSequence>
 */
window.MemoryMessageRef = (function () {
  let sessionEpoch = Date.now().toString(36)
  let monotonic = 0
  function next() {
    if (window && window.pet && typeof window.pet.nextMessageRef === 'function') {
      return window.pet.nextMessageRef()
    }
    monotonic += 1
    return 'chat-' + sessionEpoch + '-' + monotonic
  }
  function hist(index) {
    return 'hist-' + Date.now().toString(36) + '-' + String(index || 0)
  }
  function reset(epoch) {
    sessionEpoch = epoch || Date.now().toString(36)
    monotonic = 0
  }
  function current() {
    return { sessionEpoch, monotonic }
  }
  return { next, hist, reset, current }
})()
