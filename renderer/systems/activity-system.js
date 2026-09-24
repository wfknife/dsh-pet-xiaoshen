/* ActivitySystem — Phase 8
 * 统一描述持续活动：idle / working / resting / sleeping / eating / playing / chatting。
 * 当前先提供轻量状态接口，后续替换 pet.js 中的分散判断。
 */
window.ActivitySystem = (function () {
  let current = { type: 'idle', startedAt: 0, endsAt: 0, source: '', metadata: {} }
  function set(activity) {
    current = {
      type: activity && activity.type ? activity.type : 'idle',
      startedAt: (activity && activity.startedAt) || Date.now(),
      endsAt: (activity && activity.endsAt) || 0,
      source: (activity && activity.source) || '',
      metadata: (activity && activity.metadata) || {}
    }
    return current
  }
  function get() { return { ...current } }
  return { set, get }
})()
