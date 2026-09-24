/* AlbumSystem — Phase 10
 * 作为相册领域边界；当前只做 Adapter，不新增/修改解锁规则。
 */
window.AlbumSystem = (function () {
  let api = null
  function bind(a) { api = a; return api }
  function unlock(id) {
    if (api && typeof api.unlockPhoto === 'function') return api.unlockPhoto(id)
    return false
  }
  return { bind, unlock }
})()
