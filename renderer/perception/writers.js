/* 兼容别名（M0）：实现已迁移至 renderer/perception/core/writers.js。
 * 保留旧路径与旧全局名 window.PerceptionWriters。
 * 加载顺序要求：core/writers.js 在前。 */
(function () {
  if (!window.PresenceWriters) {
    console.warn('perception/writers.js: 请先加载 perception/core/writers.js')
    return
  }
  window.PerceptionWriters = window.PresenceWriters
})()
