/* 兼容别名（M0）：实现已迁移至 renderer/perception/sensors/vision/detectors.js。
 * 保留旧路径与旧全局名 window.PerceptionDetectors（含 semanticEvent / THRESHOLDS）。
 * 加载顺序要求：core/events.js、sensors/vision/vocab.js、sensors/vision/detectors.js 在前。 */
(function () {
  if (!window.VisionDetectors) {
    console.warn('perception/detectors.js: 请先加载 perception/sensors/vision/detectors.js')
    return
  }
  window.PerceptionDetectors = {
    DETECTORS: window.VisionDetectors.DETECTORS,
    semanticEvent: window.PresenceEvents && window.PresenceEvents.semanticEvent,
    THRESHOLDS: window.VisionDetectors.THRESHOLDS,
  }
})()
