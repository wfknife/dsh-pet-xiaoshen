/* DiarySystem — Phase 10
 * 日记领域边界；保留现有“事件时间线 → 反思/总结 → 正文”结构。
 * 当前通过 Adapter 引用 pet.js 现有实现。
 */
window.DiarySystem = (function () {
  let api = null
  function bind(a) { api = a; return api }
  function write(manual) {
    if (api && typeof api.writeDiary === 'function') return api.writeDiary(manual)
    return null
  }
  function timeline() {
    if (api && typeof api.diaryTimeline === 'function') return api.diaryTimeline()
    return null
  }
  async function timelineAsync() {
    if (api && typeof api.diaryTimelineAsync === 'function') return api.diaryTimelineAsync()
    return timeline()
  }
  /* P2/D4-3：删除产物 API 转接（实现＝pet.js deleteDiaryEntry）。 */
  function remove(diaryId) {
    if (api && typeof api.deleteDiaryEntry === 'function') return api.deleteDiaryEntry(diaryId)
    return null
  }
  return { bind, write, timeline, timelineAsync, remove }
})()
