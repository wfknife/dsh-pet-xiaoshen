/* AchievementSystem — Phase 10
 * 成就领域边界；当前 Adapter 指向现有 checkAchievements。
 */
window.AchievementSystem = (function () {
  let api = null
  function bind(a) { api = a; return api }
  function check() {
    if (api && typeof api.checkAchievements === 'function') return api.checkAchievements()
    return false
  }
  return { bind, check }
})()
