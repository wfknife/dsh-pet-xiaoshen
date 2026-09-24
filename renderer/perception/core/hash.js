/* Perception Core · Hash（H1）
 * 职责：为传感器提供稳定的短哈希，用于**不落原文**的状态记录（隐私红线：不逐首永久记录）。
 * 边界：纯计算，不引用任何 Engine / Writer / Router / Detector。
 */
(function () {
  function hashOf(str) {
    let h = 2166136261
    const s = String(str || '')
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(16)
  }

  window.PresenceHash = { hashOf: hashOf }
})()
