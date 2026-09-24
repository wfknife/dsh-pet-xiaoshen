/* 兼容别名（M0）：实现已迁移至 renderer/perception/core/observation.js。
 * 保留旧路径与旧全局名 window.PerceptionObservation，供既有引用/测试使用。
 * 加载顺序要求：core/observation.js 在前。 */
(function () {
  if (!window.PresenceObservation) {
    console.warn('perception/observation.js: 请先加载 perception/core/observation.js')
    return
  }
  window.PerceptionObservation = window.PresenceObservation
})()
