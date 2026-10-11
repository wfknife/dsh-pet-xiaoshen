/* Perception Core · Throttle（M0/M1/M3/M4）
 * 职责：说话节流策略 —— 唯一的冷却权威。
 * 为什么在共享层：冷却必须按 **topic** 而非按传感器计，否则视说完音乐、听又会说一遍。
 * 数值来源：原 vision detectors 的 SPEAK_COOLDOWN_MIN（键由类别改为 topic，数值不变）。
 * 边界：本文件不引用 Engine / Writer / Router / Detector；只做纯计算。
 */
(function () {
  const MIN = 60 * 1000
  const TOPIC_COOLDOWN_MIN = { default: 20, music: 10, chat: 30 }

  function cooldownMsOf(topic) {
    const m = TOPIC_COOLDOWN_MIN[topic]
    return (m === undefined ? TOPIC_COOLDOWN_MIN.default : m) * MIN
  }

  /** 是否已过该 topic 的冷却（shared.lastSaidAt 按 topic 记录上次发声时间） */
  function canSpeak(shared, topic, now) {
    const t = topic || 'other'
    const last = Number((shared && shared.lastSaidAt && shared.lastSaidAt[t]) || 0)
    return Number(now) - last >= cooldownMsOf(t)
  }

  /** 记录一次发声（只应由 Router 在自己的状态副本上调用） */
  function markSpoke(shared, topic, now) {
    if (!shared.lastSaidAt) shared.lastSaidAt = {}
    const t = topic || 'other'
    const ts = Number(now) || Date.now()
    const prev = Number(shared.lastSaidAt[t]) || 0
    if (ts > prev) shared.lastSaidAt[t] = ts
    if (ts > (Number(shared.lastReactionAt) || 0)) shared.lastReactionAt = ts
    return shared
  }

  window.PresenceThrottle = {
    TOPIC_COOLDOWN_MIN: TOPIC_COOLDOWN_MIN,
    cooldownMsOf: cooldownMsOf,
    canSpeak: canSpeak,
    markSpoke: markSpoke,
  }
})()
