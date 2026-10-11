/* Perception Core · Presence Router（M0/M1/M3/M4 + H3/H4/H5）
 * 职责：**唯一分流权威**。把 SemanticEvent 变成 ReactionPlan。四件事只在这里发生：
 *   ① 跨模态合并（同 topic 的事件 → 一个 ReactionPlan，通道取并集）
 *   ② 通道决策（声明式 CHANNELS 表）
 *   ③ 说话节流（channel-scoped：只摘 express，绝不触碰 emotion/memory/diary）
 *   ④ 单窗口单反应 + 全局冷却
 * 边界：不得引用任何 Engine / Writer / Detector；保持纯函数
 *   plan(events, shared, now) → { plans, shared }   ← 只读入参，返回新的 shared
 */
(function () {
  // kind → 通道（kind 按传感器命名空间：视 E*，听 A*）
  const CHANNELS = {
    E1_app_switch: ['express'],
    E2_category_dwell: ['express'],
    E3_long_activity: ['express', 'emotion', 'memory', 'diary'],
    E4_late_night: ['express', 'emotion', 'memory', 'diary'],
    E5_absence_return: ['express'],
    E6_preference: ['express', 'memory', 'diary'],
    A1_media_start: ['express'],
    A2_media_stop: ['express'],
    A3_track_repeat: ['express'],
    A4_listening_dwell: ['express', 'emotion', 'memory', 'diary'],
    A5_taste_across_days: ['express', 'memory', 'diary'],
    A6_media_paused: ['express'],
  }

  /* 哪些 kind 的 express 受 topic 冷却约束。
     日常/高频事件（E1/E2/E5、A1/A2/A3/A6）受约束；
     有意义的低频事件（E3/E4/E6、A4/A5）保留表达，且自身已有"每类别/每天/每歌手一次"上限。 */
  const THROTTLE_KINDS = {
    E1_app_switch: true, E2_category_dwell: true, E5_absence_return: true,
    A1_media_start: true, A2_media_stop: true, A3_track_repeat: true, A6_media_paused: true,
  }

  /* lead / 通道归属的择优顺序（信息增益优先：具体媒体事件 > 泛在状态事件） */
  const KIND_PRIORITY = {
    A4_listening_dwell: 70,
    E3_long_activity: 65,
    A5_taste_across_days: 60,
    E4_late_night: 55,
    E6_preference: 50,
    A1_media_start: 45,
    A3_track_repeat: 40,
    E5_absence_return: 35,
    A2_media_stop: 30,
    A6_media_paused: 25,
    E2_category_dwell: 20,
    E1_app_switch: 10,
  }

  let reactionSeq = 0

  function priorityOf(kind) { return KIND_PRIORITY[kind] === undefined ? 0 : KIND_PRIORITY[kind] }
  function channelsOf(kind) { return CHANNELS[kind] || [] }

  function cloneShared(shared) {
    const s = shared || {}
    return {
      lastSaidAt: Object.assign({}, s.lastSaidAt || {}),
      lastReactionAt: Number(s.lastReactionAt) || 0,
      lastReactionId: typeof s.lastReactionId === 'string' ? s.lastReactionId : '',
      mergeUntil: Object.assign({}, s.mergeUntil || {}),
    }
  }

  function meta(ev) {
    return {
      eventId: ev.eventId, observationId: ev.observationId, sensor: ev.sensor || 'vision',
      kind: ev.kind, topic: ev.topic || 'other', ts: ev.ts, payload: ev.payload || {},
    }
  }

  /** 择优：优先级高者胜，同级取先到 */
  function pickBest(list, predicate) {
    let best = null
    for (let i = 0; i < list.length; i++) {
      const c = list[i]
      if (predicate && !predicate(c)) continue
      if (!best || priorityOf(c.kind) > priorityOf(best.kind)) best = c
    }
    return best
  }

  function unionChannels(contributors) {
    const out = []
    for (let i = 0; i < contributors.length; i++) {
      const chs = channelsOf(contributors[i].kind)
      for (let j = 0; j < chs.length; j++) {
        if (out.indexOf(chs[j]) < 0) out.push(chs[j])
      }
    }
    return out
  }

  function buildPlan(topic, contributors, ts) {
    const lead = pickBest(contributors)
    const channels = unionChannels(contributors)
    const channelSource = {}
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i]
      channelSource[ch] = pickBest(contributors, function (c) { return channelsOf(c.kind).indexOf(ch) >= 0 })
    }
    reactionSeq += 1
    return {
      reactionId: 'rx-' + ts.toString(36) + '-' + reactionSeq,
      topic: topic,
      ts: ts,
      // 兼容字段（等于 lead）
      eventId: lead.eventId,
      observationId: lead.observationId,
      sensor: lead.sensor,
      kind: lead.kind,
      payload: lead.payload,
      lead: lead,
      contributors: contributors,
      channels: channels,
      channelSource: channelSource,
      throttled: null,
      mergedInto: null,
    }
  }

  /** 带合并 + 节流的分流：pipeline 走这条
   *  policy：{ globalCooldownMs, mergeWindowMs }（由 pipeline 从 perceptionConfig.speech 传入） */
  function plan(events, shared, now, policy) {
    const T = window.PresenceThrottle
    const s = cloneShared(shared)
    const ts = Number(now) || Date.now()
    const def = (window.PresenceState && window.PresenceState.DEFAULT_CONFIG.speech) || { globalCooldownMs: 0, mergeWindowMs: 0 }
    const pol = policy || def
    const globalMs = Number(pol.globalCooldownMs) || 0
    const mergeMs = Number(pol.mergeWindowMs) || 0

    // ① 按 topic 分组（保持出现顺序）
    const order = []
    const groups = {}
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      if (!channelsOf(ev.kind).length) continue
      const topic = ev.topic || 'other'
      if (!groups[topic]) { groups[topic] = []; order.push(topic) }
      groups[topic].push(meta(ev))
    }

    // ② 每组 → 一个 ReactionPlan（同 topic 的事件合并成一次反应）
    //    分配顺序按组内最高优先级降序：保证信息量更大的反应先拿到"单窗口"发言权，
    //    避免"无台词的低价值事件"挤掉真正的反应（live 验收发现）。
    const ordered = order.map(function (topic) {
      let prio = 0
      for (let i = 0; i < groups[topic].length; i++) prio = Math.max(prio, priorityOf(groups[topic][i].kind))
      return { topic: topic, prio: prio }
    })
    ordered.sort(function (a, b) { return b.prio - a.prio })

    const plans = []
    let spokeInWindow = false
    for (let gi = 0; gi < ordered.length; gi++) {
      const topic = ordered[gi].topic
      const contributors = groups[topic]
      const p = buildPlan(topic, contributors, ts)

      if (p.channels.indexOf('express') >= 0) {
        // 是否受 topic 冷却约束：由 **express 通道的来源事件** 决定（合并后取最懂它的事件）
        const expressKind = (p.channelSource.express && p.channelSource.express.kind) || p.lead.kind
        const throttleable = !!THROTTLE_KINDS[expressKind]
        const topicCooling = T && throttleable ? !T.canSpeak(s, topic, ts) : false
        const mergeActive = Number(s.mergeUntil[topic] || 0) > ts
        const globalCooling = globalMs > 0 && s.lastReactionAt > 0 && (ts - s.lastReactionAt) < globalMs
        let reason = null
        if (mergeActive) { reason = 'merged'; p.mergedInto = s.lastReactionId || null }
        else if (topicCooling) reason = 'topic'
        else if (spokeInWindow) reason = 'window'
        else if (globalCooling) reason = 'global'

        if (reason) {
          p.channels.splice(p.channels.indexOf('express'), 1)
          delete p.channelSource.express
          p.throttled = reason
        } else {
          if (T) T.markSpoke(s, topic, ts)
          s.lastReactionAt = ts
          s.lastReactionId = p.reactionId
          if (mergeMs > 0) s.mergeUntil[topic] = ts + mergeMs
          spokeInWindow = true
        }
      }
      plans.push(p)
    }
    return { plans: plans, shared: s }
  }

  /** 兼容入口：单事件、无合并、无节流（供测试/诊断） */
  function route(event) {
    const channels = channelsOf(event.kind)
    if (!channels.length) return null
    const p = buildPlan(event.topic || 'other', [meta(event)], Number(event.ts) || Date.now())
    return p
  }

  function routeAll(events) {
    const plans = []
    for (let i = 0; i < events.length; i++) {
      const p = route(events[i])
      if (p) plans.push(p)
    }
    return plans
  }

  window.PresenceRouter = {
    CHANNELS: CHANNELS,
    ROUTE: CHANNELS, // 旧名兼容
    THROTTLE_KINDS: THROTTLE_KINDS,
    KIND_PRIORITY: KIND_PRIORITY,
    plan: plan,
    route: route,
    routeAll: routeAll,
  }
})()
