/* Perception Core · SemanticEvent（M0/M1/M4）
 * 职责：把 Observation 升级为"有语义的事实"，并给出跨模态公共键 topic。
 * 边界：本文件不得引用任何 Engine / Writer / Router / Detector。
 *
 * 为什么是共享层：视与听都需要同一种事件形状，Router 靠 topic 做跨模态合并与节流，
 * 靠 kind 做通道决策。两者都不属于任何单一传感器。
 */
(function () {
  // 事件 id 前缀：视 pev-* / 听 aev-*（既有记忆的 perceptionRef 已是 pev-*，必须保持不变）
  const EVENT_PREFIX = { vision: 'pev', hearing: 'aev' }

  /** semanticEvent(obs, kind, payload, topic) → SemanticEvent
   *  kind 为传感器命名空间内的事件名（视 E1–E6 / 听 A1–A6），topic 为跨模态公共键。 */
  function semanticEvent(obs, kind, payload, topic) {
    const prefix = EVENT_PREFIX[obs && obs.source] || 'pev'
    return {
      eventId: prefix + '-' + obs.id + '-' + kind,
      observationId: obs.id,
      sensor: obs.source || 'vision',
      kind: kind,
      topic: topic || 'other',
      ts: obs.ts,
      confidence: obs.confidence,
      payload: payload || {},
    }
  }

  window.PresenceEvents = {
    semanticEvent: semanticEvent,
    EVENT_PREFIX: EVENT_PREFIX,
  }
})()
