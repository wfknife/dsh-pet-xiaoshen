/* 兼容别名（M0）：实现已迁移至 renderer/perception/core/pipeline.js。
 * 保留旧路径与旧全局名 window.Perception（ensureState / perceive / tick / start / stop）。
 * 加载顺序要求：core/pipeline.js 在前。 */
(function () {
  if (!window.PresencePipeline) {
    console.warn('perception/index.js: 请先加载 perception/core/pipeline.js')
    return
  }
  window.Perception = window.PresencePipeline
})()
