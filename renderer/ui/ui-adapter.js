/* UIAdapter — Phase 13
 * 最小 UI 读接口。UI 仍可兼容旧 P 直读；新增/迁移代码应优先通过这里读取。
 */
window.UIAdapter = (function () {
  let api = null
  function bind(a) { api = a; return api }
  function getState() { return api && typeof api.getState === 'function' ? api.getState() : null }
  function get(path) { return api && typeof api.get === 'function' ? api.get(path) : undefined }
  return { bind, getState, get }
})()
