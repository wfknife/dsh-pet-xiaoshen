/* 兼容别名（M0）：实现已迁移至 renderer/perception/core/router.js。
 * 保留旧路径与旧全局名 window.PerceptionRouter（含 ROUTE / route / routeAll）。
 * 加载顺序要求：core/throttle.js、core/router.js 在前。 */
(function () {
  if (!window.PresenceRouter) {
    console.warn('perception/router.js: 请先加载 perception/core/router.js')
    return
  }
  window.PerceptionRouter = window.PresenceRouter
})()
