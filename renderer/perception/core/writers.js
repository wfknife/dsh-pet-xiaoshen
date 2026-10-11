/* Perception Core · Writers（M0/M1 + H6）
 * 职责：执行 ReactionPlan。**唯一允许触碰 UI / Engine 的地方**。
 * 边界：不决定"该不该去"（Router 决定），不修改感知状态（Pipeline commit）。
 * 宿主能力（ctx）：say / pickLine / diaryEvent / express —— 由 pet.js 注入，Writer 只调用。
 * 跨模态：一个 plan 的每个通道都有自己的来源事件（plan.channelSource），
 *         因此合并后的反应仍能把 emotion/memory/diary 交给"最懂它"的那个事件。
 */
(function () {
  /* express：实时表现（微表情/小动作 + 台词）。
     台词由 ctx.pickLine 解析（视走世界书类别池，听走听觉专属池）；无台词则不做表情。
     M5：说话身份仍为 'ui'，不改 Character Chat 优先级。 */
  const EXPRESS_INTENT = {
    E1_app_switch: 'observe_owner',
    E2_category_dwell: 'comment_on_activity',
    E3_long_activity: 'accompany_owner',
    E4_late_night: 'comfort_owner',
    E5_absence_return: 'seek_attention',
    E6_preference: 'celebrate',
    A1_media_start: 'seek_attention',
    A2_media_stop: 'accompany_owner',
    A3_track_repeat: 'comment_on_activity',
    A4_listening_dwell: 'accompany_owner',
    A5_taste_across_days: 'celebrate',
    A6_media_paused: 'comfort_owner',
  }

  function writeExpress(plan, ctx) {
    if (!ctx || typeof ctx.say !== 'function') return { ok: false, reason: 'no_say' }
    let line = null
    if (typeof ctx.pickLine === 'function') line = ctx.pickLine(plan)
    if (!line) return { ok: false, reason: 'no_line' }
    let expression = null
    if (typeof ctx.express === 'function') {
      try { expression = ctx.express(plan, EXPRESS_INTENT[plan.kind] || null) } catch (err) { expression = { ok: false, reason: String((err && err.message) || err) } }
    }
    const r = ctx.say(String(line), 5000, 'ui')
    return { ok: !(r && r.ok === false), reason: (r && r.reason) || null, said: line, expression: expression }
  }

  /* emotion：**不新增任何情绪规则**，只把事件映射到既有 kind。
     E3/A4 → long_activity；E4 → low_energy。其余不进 emotion 通道。 */
  const EMOTION_KIND_MAP = {
    E3_long_activity: 'long_activity',
    E4_late_night: 'low_energy',
    A4_listening_dwell: 'long_activity',
  }

  function writeEmotion(plan, ctx) {
    const kind = EMOTION_KIND_MAP[plan.kind]
    if (!kind) return { ok: true, skipped: 'not-emotion-event' }
    const ee = window.EmotionEngine
    if (!ee || typeof ee.applyEvent !== 'function') return { ok: false, reason: 'no_emotion_engine' }
    if (!ctx || !ctx.P) return { ok: false, reason: 'no_state' }
    const r = ee.applyEvent(ctx.P, {
      kind: kind,
      source: 'perception',
      eventId: plan.eventId,
      ts: plan.ts || Date.now(),
    })
    return r || { ok: false, reason: 'no_result' }
  }

  /* memory / diary：**同源解耦**（记忆不记日记 id，日记 meta 不记记忆 id）。
     记忆：MemoryEngine.admitCandidate + sourceType 'event' + evidenceRefs.kind 'perception'。
     DENIED_SOURCES 不变：任何传感器都不获得一等写入来源。 */
  const MEMORY_SPEC = {
    E3_long_activity: 'episode',
    E4_late_night: 'episode',
    E6_preference: 'preference',
    A4_listening_dwell: 'episode',
    A5_taste_across_days: 'preference',
  }

  function catOf(plan) {
    return String((plan && plan.payload && plan.payload.cat) || '')
  }

  function mediaNoun(plan) {
    const topic = String((plan && plan.topic) || '')
    if (topic === 'music') return '歌'
    if (topic === 'video') return '视频'
    return '内容'
  }

  /* 记忆内容：面向 chat 回忆的事实陈述。同类内容稳定 → normalizedKey 稳定 → 可合并强化。
     隐私：不写曲名；A5 只写"歌手偏好"（这是"经历加热"的产物，不是逐首记录）。 */
  function memoryText(plan) {
    const cat = catOf(plan)
    if (plan.kind === 'E3_long_activity') return '主人今天在「' + cat + '」上连续忙了超过一小时'
    if (plan.kind === 'E4_late_night') {
      const h = plan.payload && plan.payload.hour
      return '主人今天忙到很晚' + (h === undefined || h === null ? '' : '（' + h + '点）') + '还在用电脑'
    }
    if (plan.kind === 'E6_preference') return '主人常把时间花在「' + cat + '」上'
    if (plan.kind === 'A4_listening_dwell') return '主人今天连着听了很久的' + mediaNoun(plan)
    if (plan.kind === 'A5_taste_across_days') {
      const artist = String((plan.payload && plan.payload.artist) || '').trim()
      return artist ? '主人最近常听「' + artist + '」的歌' : '主人最近常听同一类歌'
    }
    return ''
  }

  /* 日记内容：第一人称叙述（女仆口吻）。 */
  function diaryText(plan) {
    const cat = catOf(plan)
    if (plan.kind === 'E3_long_activity') return '主人今天在「' + cat + '」上忙了很久，我一直在旁边陪着'
    if (plan.kind === 'E4_late_night') return '夜深了，主人还在用电脑，我有点心疼'
    if (plan.kind === 'E6_preference') return '最近主人常待在「' + cat + '」里，我记下了'
    if (plan.kind === 'A4_listening_dwell') return '主人今天一直在听' + mediaNoun(plan) + '，我陪在旁边'
    if (plan.kind === 'A5_taste_across_days') {
      const artist = String((plan.payload && plan.payload.artist) || '').trim()
      return artist ? '最近主人常听「' + artist + '」，我悄悄记住了' : '最近主人常听同一类歌，我悄悄记住了'
    }
    return ''
  }

  /* C2-F1：经历（Experience）通道 —— 只把"已经发生过的现实事件"变成一条**结构化经历**。
     边界：不写心理活动/评价（那是 Emotion / Memory 的职责）、不新增感知字段（全部取自本 plan 已有字段）、
     不新增情绪/关系数值字段。白名单只收高价值低频事件；E1_app_switch（每分钟级）与 EventBus 互动事件一律不收。 */
  const EXPERIENCE_SPEC = {
    E3_long_activity: true,
    E4_late_night: true,
    E5_absence_return: true,
    A4_listening_dwell: true,
    /* F4-S6：主动开口经历。注意它不是"感知事件"，走下面的
       buildProactiveTalkExperience(input) 专用构造器（三条件：presentedAt ∧ repliedAt ∧ 回复非空）。 */
    P1_proactive_talk: true,
  }

  function dayLabelOf(ts) {
    const d = new Date(Number(ts))
    if (isNaN(d.getTime())) return ''
    return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
  }

  /* C2-F1.1：经历文本只改**可读性 / 可引用性**，不改数据语义与消费机制。
     事实行必须：①有第一人称主体；②有具体时刻；③有时长（仅当该 kind 的 plan 真有 `dwellMs` 字段）；
     ④**永不出现内部 kind 名**（E3_/E4_/E5_/A4_ 只留在结构字段 `kind` 里供程序使用）。
     边界：只写"发生过什么"——不写心理活动/评价、不判断主人状态、不新增感知字段、不伪造"今天/刚才"、
     不从当前时间倒推、不加"凌晨/深夜"等额外文学判断。 */
  function clockLabelOf(ts) {
    const d = new Date(Number(ts))
    if (isNaN(d.getTime())) return ''
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getHours()) + ':' + p(d.getMinutes())
  }

  /* 时长只从 plan **已有**的 dwellMs 折算（E4/E5 的 plan 不带时长 ⇒ 宁可不写，也不编）。 */
  function minutesLabelOf(plan) {
    const ms = Number(plan && plan.payload && plan.payload.dwellMs)
    if (!isFinite(ms) || ms <= 0) return ''
    const m = Math.round(ms / 60000)
    return m > 0 ? '持续 ' + m + ' 分钟的' : ''
  }

  /* 结构化经历文本（模板拼装，不接受自由叙事）：只写 WHAT HAPPENED。 */
  function experienceText(plan) {
    const ts = Number(plan.ts) || Date.now()
    const day = dayLabelOf(ts)
    const hm = clockLabelOf(ts)
    const when = day + (hm ? ' ' + hm + ' 左右' : '')
    const cat = catOf(plan)
    const dur = minutesLabelOf(plan)
    if (plan.kind === 'E3_long_activity') return when + '，我经历了一次' + dur + cat + '活动。'
    if (plan.kind === 'E4_late_night') return when + '，我经历了一次' + cat + '活动。'
    if (plan.kind === 'E5_absence_return') return when + '，我经历了一次离开较久之后的返回。'
    if (plan.kind === 'A4_listening_dwell') return when + '，我经历了一次' + dur + '连续听' + mediaNoun(plan) + '。'
    /* F4-S6：主动开口。纪律：有主体（"我"）、有时刻、无 kind 代号、不写主人具体行为/情绪结论、
       第一版不引用主人原话（"主人回了我一句"只陈述发生过一次回应）。 */
    if (plan.kind === 'P1_proactive_talk') return when + '，我先开了口，主人回了我一句。'
    return ''
  }

  /* 经历写入：**一个 SemanticEvent 最多一条经历**；去重由主进程按 eventId 裁决（本层不做二次判定）。 */
  function writeExperience(plan, ctx) {
    if (!EXPERIENCE_SPEC[plan.kind]) return { ok: true, skipped: 'not-experience-event' }
    if (!ctx || typeof ctx.experience !== 'function') return { ok: false, reason: 'no_experience_sink' }
    const entry = {
      eventId: String(plan.eventId || ''),
      observationId: String(plan.observationId || ''),
      kind: String(plan.kind || ''),
      topic: String(plan.topic || ''),
      sensor: String(plan.sensor || 'vision'),
      category: catOf(plan),
      ts: Number(plan.ts) || Date.now(),
      text: experienceText(plan),
      source: 'perception',
    }
    if (!entry.eventId || !entry.text) return { ok: false, reason: 'incomplete-experience' }
    const r = ctx.experience(entry)
    return r || { ok: false, reason: 'no_result' }
  }

  /* F4-S6：主动开口经历 `P1_proactive_talk` 的**唯一构造器**。
     三条件必须**同时**成立才返回 entry：①presentedAt ②repliedAt ③回复内容非空；否则返回 null
     （不写、不伪造）。去重＝eventId `p1:<instanceId>`（**不用递增序号**，同 instance 天然不会重复）；
     文本走 experienceText 模板（无 kind 代号、无主人行为/情绪结论、不引用主人原话）。
     落盘仍由主进程 recordExperience 裁决（本层不做二次判定、不缓存第二份经历）。 */
  function buildProactiveTalkExperience(input) {
    const i = input || {}
    const instanceId = String(i.instanceId || '')
    const presentedAt = Number(i.presentedAt)
    const repliedAt = Number(i.repliedAt)
    const replyText = (typeof i.replyText === 'string') ? i.replyText.trim() : ''
    if (!instanceId) return null
    if (!isFinite(presentedAt) || presentedAt <= 0) return null
    if (!isFinite(repliedAt) || repliedAt <= 0) return null
    if (!replyText) return null
    const ts = Number(i.ts) || repliedAt
    const text = experienceText({ kind: 'P1_proactive_talk', ts: ts })
    if (!text) return null
    return {
      eventId: 'p1:' + instanceId,
      observationId: '',
      kind: 'P1_proactive_talk',
      topic: '',
      sensor: 'proactive',
      category: 'social',
      ts: ts,
      text: text,
      source: 'proactive',
    }
  }

  function writeMemory(plan, ctx) {
    const type = MEMORY_SPEC[plan.kind]
    if (!type) return { ok: true, skipped: 'not-memory-event' }
    const me = window.MemoryEngine
    if (!me || typeof me.admitCandidate !== 'function') return { ok: false, reason: 'no_memory_engine' }
    const ts = Number(plan.ts) || Date.now()
    const cand = {
      content: memoryText(plan),
      type: type,
      sourceType: 'event',
      sourceEventIds: [plan.eventId],
      ts: ts,
      importance: 0.3,
      tags: ['perception', plan.sensor || 'vision', catOf(plan) || plan.topic].filter(Boolean),
      evidenceRefs: [{ kind: 'perception', perceptionRef: String(plan.eventId), at: ts }],
    }
    if (plan.kind === 'E6_preference') {
      cand.preference = true
      cand.subjectKey = 'user'
      cand.propertyKey = 'app_category_preference'
      cand.valueKey = catOf(plan)
      cand.splitKey = 'preference'
    }
    if (plan.kind === 'A5_taste_across_days') {
      const artist = String((plan.payload && plan.payload.artist) || '').trim()
      cand.preference = true
      cand.subjectKey = 'user'
      cand.propertyKey = 'music_taste'
      cand.valueKey = artist || 'unknown'
      cand.splitKey = 'preference'
    }
    const r = me.admitCandidate(cand)
    return r || { ok: false, reason: 'no_result' }
  }

  function writeDiary(plan, ctx) {
    if (!MEMORY_SPEC[plan.kind]) return { ok: true, skipped: 'not-diary-event' }
    if (!ctx || typeof ctx.diaryEvent !== 'function') return { ok: false, reason: 'no_diary' }
    const text = diaryText(plan)
    if (!text) return { ok: true, skipped: 'no_text' }
    const meta = {
      eventId: String(plan.eventId || ''),
      observationId: String(plan.observationId || ''),
      kind: String(plan.kind || ''),
      cat: catOf(plan) || String(plan.topic || ''),
      source: String(plan.sensor || 'vision'),
    }
    const r = ctx.diaryEvent('perception', text, meta)
    return { ok: !(r && r.ok === false), reason: (r && r.reason) || null, text: text }
  }

  const WRITERS = {
    express: writeExpress,
    emotion: writeEmotion,
    memory: writeMemory,
    diary: writeDiary,
    experience: writeExperience,
  }

  /** 通道视图：合并后的 plan 里，每个通道用它自己的来源事件（channelSource） */
  function viewFor(plan, channel) {
    const src = (plan.channelSource && plan.channelSource[channel]) || plan.lead || plan
    return Object.assign({}, plan, {
      eventId: src.eventId,
      observationId: src.observationId,
      sensor: src.sensor,
      kind: src.kind,
      topic: src.topic,
      ts: src.ts,
      payload: src.payload || {},
    })
  }

  /* P3-F0：前台变化观察旁挂 —— 只搬运"感知到前台从 A 变成 B"这一保真事实。
     边界：①只认 E1_app_switch 与 E5_absence_return 贡献者（**遍历 contributors**：同 topic 合并后
     lead 可能被高优先级 kind 顶掉，匹配者仍必须各喂一条，否则同类别内部切换会丢）；
     ②不做任何行为/意义解释（不是用户活动判断）；E5 的 kind 名仅作**匹配与断档信号**用，
     其命名语义不进入任何字段——断档只表达"中间有一段没有观察到，之后重新观察到一个前台状态"；
     ③与 express 节流无关（节流只摘 channels，本旁挂走 plan 本体，被节流也照记）；
     ④不进 channels 结果形状、失败只留诊断，绝不打断其它通道（同 C2-F1 experience 旁挂纪律）。 */
  function writeForegroundObservation(plan, ctx) {
    if (!ctx || typeof ctx.foregroundObservation !== 'function') return { ok: true, fed: 0, skipped: 'no_fg_sink' }   // 旁路可选：无 sink 属正常降级，不告警
    const contributors = (plan && Array.isArray(plan.contributors) && plan.contributors.length) ? plan.contributors : [plan]
    let fed = 0
    for (let i = 0; i < contributors.length; i++) {
      const c = contributors[i]
      if (!c) continue
      const isGapSignal = c.kind === 'E5_absence_return'   // 断档信号（观测流中断 ≥30min 后重新观察到前台）
      if (c.kind !== 'E1_app_switch' && !isGapSignal) continue
      const payload = c.payload || {}
      const app = String(payload.app || '')
      if (!app) continue   // 无前台窗口：现有 !appName 行为是跳过采样 ⇒ 旁路同样不记、不解释
      const entry = {
        eventId: String(c.eventId || ''),
        observationId: String(c.observationId || ''),
        sensor: String(c.sensor || 'vision'),
        ts: Number(c.ts) || 0,
        to: app,
        category: String(payload.cat || ''),
        source: 'perception-vision'
      }
      if (!entry.eventId || !entry.ts) continue
      if (isGapSignal) entry.gap = true   // 仅主进程断链/前态未知消费；**不落记录**（记录键集合封闭）
      const r = ctx.foregroundObservation(entry)
      if (r && r.ok !== false) fed++
    }
    return { ok: true, fed: fed }
  }

  function executePlans(plans, ctx) {
    const results = []
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]
      for (let j = 0; j < plan.channels.length; j++) {
        const ch = plan.channels[j]
        const w = WRITERS[ch]
        if (!w) continue
        const view = viewFor(plan, ch)
        try {
          results.push({
            channel: ch, reactionId: plan.reactionId || null,
            eventId: view.eventId, observationId: view.observationId, topic: plan.topic,
            result: w(view, ctx),
          })
        } catch (err) {
          results.push({
            channel: ch, reactionId: plan.reactionId || null,
            eventId: view.eventId, observationId: view.observationId, topic: plan.topic,
            result: { ok: false, reason: String((err && err.message) || err) },
          })
        }
      }
      /* C2-F1：经历写入（**不计入 channels 结果形状**：白名单外直接跳过；失败只留诊断，绝不打断其它通道） */
      try {
        const exp = writeExperience(plan, ctx)
        if (!exp || exp.ok !== true) { try { console.warn('[experience] write failed:', (exp && exp.reason) || 'unknown') } catch (e2) { /* ignore */ } }
      } catch (err) { try { console.warn('[experience] write error:', String((err && err.message) || err)) } catch (e2) { /* ignore */ } }
      /* P3-F0：前台变化观察旁挂（同上纪律：不计形状、失败不打断；无 sink / 非 E1 贡献者零成本跳过） */
      try {
        const fgo = writeForegroundObservation(plan, ctx)
        if (!fgo || fgo.ok !== true) { try { console.warn('[fg-obs] write failed:', (fgo && fgo.reason) || 'unknown') } catch (e2) { /* ignore */ } }
      } catch (err) { try { console.warn('[fg-obs] write error:', String((err && err.message) || err)) } catch (e2) { /* ignore */ } }
    }
    return results
  }

  window.PresenceWriters = { WRITERS: WRITERS, executePlans: executePlans, EXPRESS_INTENT: EXPRESS_INTENT, MEMORY_SPEC: MEMORY_SPEC, EMOTION_KIND_MAP: EMOTION_KIND_MAP, EXPERIENCE_SPEC: EXPERIENCE_SPEC, buildProactiveTalkExperience: buildProactiveTalkExperience, writeForegroundObservation: writeForegroundObservation }
})()
