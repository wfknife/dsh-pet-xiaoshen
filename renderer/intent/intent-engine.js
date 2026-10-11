/* IntentEngine — 3.0-06
 * Local high-level intent decision authority.
 *
 * Ownership:
 *   - IntentEngine is the only owner of active Intent.
 *   - It reads Context / Persona / Relationship / Memory / Emotion / Needs,
 *     but never writes those systems.
 *   - BehaviorDirector remains the execution bridge; IntentEngine never
 *     plays animation / calls Expression / Dialogue directly.
 */
window.IntentEngine = (function () {
  const SCHEMA_VERSION = 1
  const HISTORY_LIMIT = 10
  const SUPERSEDE_DELTA = 20

  const INTENTS = {
    respond_to_event:    { priority: 100, ttlMs: 20 * 1000, cooldownMs: 10 * 1000, baseWeight: 60, order: 1 },
    celebrate:           { priority: 80,  ttlMs: 60 * 1000, cooldownMs: 120 * 1000, baseWeight: 50, order: 2 },
    comfort_owner:       { priority: 75,  ttlMs: 120 * 1000, cooldownMs: 180 * 1000, baseWeight: 50, order: 3 },
    rest:                { priority: 70,  ttlMs: 300 * 1000, cooldownMs: 60 * 1000, baseWeight: 48, order: 4 },
    seek_attention:      { priority: 65,  ttlMs: 120 * 1000, cooldownMs: 180 * 1000, baseWeight: 45, order: 5 },
    tease_owner:         { priority: 60,  ttlMs: 120 * 1000, cooldownMs: 180 * 1000, baseWeight: 40, order: 6 },
    accompany_owner:     { priority: 50,  ttlMs: 300 * 1000, cooldownMs: 180 * 1000, baseWeight: 38, order: 7 },
    comment_on_activity: { priority: 40,  ttlMs: 60 * 1000, cooldownMs: 120 * 1000, baseWeight: 30, order: 8 },
    observe_owner:       { priority: 30,  ttlMs: 90 * 1000, cooldownMs: 60 * 1000, baseWeight: 25, order: 9 },
    idle:                { priority: 10,  ttlMs: 30 * 1000, cooldownMs: 0, baseWeight: 10, order: 10 }
  }

  const PRESENCE_POLICY = {
    dailyCap: 3,
    cooldownMs: 15 * 60 * 1000,
    minAffection: 20,
    minLoneliness: 0.45
  }
  const presenceBudget = PRESENCE_POLICY

  const FIXED_ORDER = [
    'respond_to_event', 'celebrate', 'comfort_owner', 'rest',
    'seek_attention', 'tease_owner', 'accompany_owner',
    'comment_on_activity', 'observe_owner', 'idle'
  ]

  let active = null
  let history = []
  let cooldowns = {} // kind -> available timestamp
  let pendingEvents = [] // { id, kind, createdAt, sourceSummary, consumed }
  let initialized = false
  let presenceDayKey = ''
  let presenceDailyCount = 0
  let lastPresenceAt = 0
  let lastPresenceByIntent = {}
  let lastSelectionReason = ''
  let lastRejectedReasons = []
  const counters = { reconsiderCount: 0, supersededCount: 0, cooldownBlockedCount: 0 }
  let lastCandidateIntents = []

  function clamp(v, min, max) {
    const n = Number(v)
    if (!Number.isFinite(n)) return min || 0
    return Math.min(max, Math.max(min, n))
  }

  function round3(v) {
    return Math.round((Number(v) || 0) * 1000) / 1000
  }

  function deepCopy(obj) {
    if (obj === null || typeof obj !== 'object') return obj
    try { return JSON.parse(JSON.stringify(obj)) } catch (err) { return { ...obj } }
  }

  function now() { return Date.now() }

  function presenceDayKeyOf(ts) {
    const d = new Date(ts || now())
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function getPresencePolicy(ts) {
    const t = ts || now()
    const day = presenceDayKeyOf(t)
    if (presenceDayKey !== day) {
      presenceDayKey = day
      presenceDailyCount = 0
    }
    const cooldownLeft = Math.max(0, (lastPresenceAt + PRESENCE_POLICY.cooldownMs - t))
    return {
      allowed: presenceDailyCount < PRESENCE_POLICY.dailyCap && cooldownLeft <= 0,
      dailyCount: presenceDailyCount,
      dailyCap: PRESENCE_POLICY.dailyCap,
      cooldownLeftMs: Math.round(cooldownLeft),
      lastPresenceAt
    }
  }

  function markPresenceUsed(ts, intent) {
    const t = ts || now()
    const day = presenceDayKeyOf(t)
    if (presenceDayKey !== day) {
      presenceDayKey = day
      presenceDailyCount = 0
      lastPresenceByIntent = {}
    }
    presenceDailyCount++
    lastPresenceAt = t
    if (intent) lastPresenceByIntent[intent] = t
  }

  /* ---------- S3：把主动存在感的**预算状态**做成可序列化纯数据 ----------
     为什么需要：`presenceDailyCount` / `lastPresenceAt` 原本只在内存里 ⇒ 用户重启几次桌宠
     就能绕过"每日上限"，冷却也会被清空。这里只负责**导出/恢复纯数据**，
     存储 I/O 仍归渲染层（pet.js 写进 pet-state.json），本模块依旧零 I/O。 */
  function getPresenceState() {
    return {
      schemaVersion: 1,
      dayKey: presenceDayKey,
      dailyCount: presenceDailyCount,
      lastAt: lastPresenceAt,
      byIntent: Object.assign({}, lastPresenceByIntent)
    }
  }

  function restorePresenceState(state, ts) {
    const t = Number.isFinite(Number(ts)) ? Number(ts) : now()
    const today = presenceDayKeyOf(t)
    const s = state && typeof state === 'object' ? state : null
    /* 无记录 / 跨天 / 非法值 ⇒ 一律按"今天还没开口"处理（保守、安全、可复现） */
    const sameDay = !!(s && typeof s.dayKey === 'string' && s.dayKey === today)
    const count = sameDay ? Number(s.dailyCount) : 0
    const lastAt = sameDay ? Number(s.lastAt) : 0
    const byIntent = {}
    if (sameDay && s.byIntent && typeof s.byIntent === 'object') {
      for (const k of Object.keys(s.byIntent)) {
        const v = Number(s.byIntent[k])
        if (Number.isFinite(v) && v > 0) byIntent[k] = v
      }
    }
    presenceDayKey = today
    presenceDailyCount = Number.isFinite(count) && count > 0
      ? Math.min(Math.floor(count), PRESENCE_POLICY.dailyCap)
      : 0
    lastPresenceAt = Number.isFinite(lastAt) && lastAt > 0 ? lastAt : 0
    lastPresenceByIntent = byIntent
    return getPresenceState()
  }

  function getPersona() {
    try { return window.PersonaCore ? window.PersonaCore.getCore() : null } catch (err) { return null }
  }

  function getRelationship() {
    try { return window.RelationshipEngine ? window.RelationshipEngine.get() : null } catch (err) { return null }
  }

  function getEmotion() {
    try { return window.EmotionEngine ? window.EmotionEngine.getSnapshot() : null } catch (err) { return null }
  }

  function getMemories() {
    try {
      if (window.MemoryRetrieval) return window.MemoryRetrieval.retrieve({}, { limit: 5 })
    } catch (err) { /* ignore */ }
    return []
  }

  function getContext() {
    try {
      if (window.ContextFoundation) return window.ContextFoundation.builder.build()
    } catch (err) { /* ignore */ }
    return {}
  }

  function getActiveIntent() {
    if (!active) return null
    if (active.status !== 'active' || (active.expiresAt && active.expiresAt < now())) {
      if (active && active.status === 'active' && active.expiresAt < now()) active.status = 'expired'
      return null
    }
    return deepCopy(active)
  }

  function isCooldownBlocked(kind, ts) {
    const avail = cooldowns[kind] || 0
    return ts < avail
  }

  function consecutiveSame(kind) {
    let count = 0
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] === kind) count++
      else break
    }
    return count
  }

  function noveltyFor(kind) {
    if (history.length && history[history.length - 1] === kind) {
      const n = consecutiveSame(kind)
      return n <= 1 ? 0 : n === 2 ? -5 : -10
    }
    return 2 // a fresh alternative is mildly novel
  }

  /* ---------- input normalization ---------- */

  function normalizeInput(input) {
    const ctx = input && typeof input === 'object' ? input : {}
    const context = ctx.context || getContext()
    const persona = 'persona' in ctx ? ctx.persona : getPersona()
    const relationship = 'relationship' in ctx ? ctx.relationship : getRelationship()
    const emotion = 'emotion' in ctx ? ctx.emotion : getEmotion()
    const memories = Array.isArray(ctx.memories) ? ctx.memories : getMemories()
    const activity = ctx.activity || context.activity || null
    const needs = ctx.needs || (context.pet && (context.pet.needs || context.pet.state)) || null
    const pet = ctx.pet || context.pet || (window.PetStateApi && window.PetStateApi.raw ? window.PetStateApi.raw : null)
    const currentBehavior = ctx.currentBehavior || (window.BehaviorDirector ? { kind: window.BehaviorDirector.getCurrent() } : { kind: 'idle' })
    const recentEvents = Array.isArray(ctx.recentEvents) ? ctx.recentEvents : (Array.isArray(context.recentEvents) ? context.recentEvents : [])
    const eventInputs = Array.isArray(ctx.events) ? ctx.events : []
    return {
      context,
      persona,
      relationship,
      emotion,
      memories,
      activity,
      needs,
      pet,
      currentBehavior,
      recentEvents,
      eventInputs
    }
  }

  function reliableActivity(activity) {
    return !!activity && typeof activity.type === 'string' && activity.type !== 'unknown' && activity.type !== 'idle'
  }

  function ownerActivityType(ctx) {
    const activity = ctx.activity
    if (!activity || !activity.type || activity.type === 'unknown') return 'unknown'
    return activity.type
  }

  function energyRatio(ctx) {
    const needs = ctx.needs
    const stats = ctx.pet && ctx.pet.stats
    const v = needs && typeof needs.energy === 'number' ? needs.energy : (stats && typeof stats.energy === 'number' ? stats.energy : null)
    if (v === null) return null
    return v <= 1 ? v : v / 100
  }

  function pendingImportantEvents(ctx, ts) {
    const list = []
    for (const e of pendingEvents) {
      if (e && !e.consumed && e.createdAt && ts - e.createdAt < INTENTS[e.kind === 'special_milestone' ? 'celebrate' : 'respond_to_event'].ttlMs) {
        list.push(e)
      }
    }
    for (const e of ctx.eventInputs || []) {
      if (e && !e.consumed) list.push(e)
    }
    return list
  }

  function hasEventKind(kind, events) {
    return events.some((e) => e && e.kind === kind)
  }

  function findEvent(kind, events) {
    return events.find((e) => e && e.kind === kind) || null
  }

  function precondition(intent, ctx, ts, opts) {
    const events = pendingImportantEvents(ctx, ts)
    const activityType = ownerActivityType(ctx)
    const energy = energyRatio(ctx)
    const emotion = ctx.emotion && ctx.emotion.values ? ctx.emotion.values : null
    const persona = ctx.persona || {}
    const traits = persona.stableTraits || persona
    const rel = ctx.relationship || {}
    const affection = typeof rel.affection === 'number' ? rel.affection : 0
    switch (intent) {
      case 'respond_to_event':
        return events.length > 0 && hasEventKind('important', events)
      case 'celebrate':
        return events.length > 0 && hasEventKind('milestone', events)
      case 'comfort_owner':
        return events.length > 0 && hasEventKind('owner_negative', events)
      case 'rest':
        return (emotion && emotion.fatigue >= 0.70) || (energy !== null && energy < 0.20)
      case 'seek_attention': {
        /* F7-C P2：入口语义移交。
           · loneliness 门退役：`PRESENCE_POLICY.minLoneliness` 不再参与本入口判定（数值未删，仅不再当门）。
           · 旧存在感 dailyCap/cooldown 门退役：本入口不再读 `getPresencePolicy(ts)` / `pol.allowed`。
           · 执行抑制仍由 F4/F7 既有 cap / interval / quiet / busy / politeness 负责；本阶段不新增任何入口规则。
           · P2 作用域隔离（2026-09-20 用户授权·方案①）：**P2 新入口语义只用于非-legacy candidate pipeline**；
             reconsider() 通过 opts.legacyPresenceGate 传入 legacy 标记，保留旧 Presence 资格门
             （loneliness >= PRESENCE_POLICY.minLoneliness 且 getPresencePolicy(ts).allowed），
             避免旧动画环获得主动联系语义。复用既有常量与函数，不新增第三套 cap / 规则。 */
        const legacyPresenceGate = !!(opts && opts.legacyPresenceGate)
        return activityType !== 'unknown'
          && activityType !== 'work'
          && activityType !== 'busy'
          && (rel.affection >= PRESENCE_POLICY.minAffection)
          && (!legacyPresenceGate || (!!(emotion && emotion.loneliness >= PRESENCE_POLICY.minLoneliness) && getPresencePolicy(ts).allowed))
      }
      case 'tease_owner':
        return (typeof traits.mischievousness === 'number' ? traits.mischievousness : 0) >= 0.50 &&
          affection >= 40 && activityType !== 'unknown' && activityType !== 'work'
      case 'accompany_owner':
        return reliableActivity(ctx.activity) || activityType !== 'unknown'
      case 'comment_on_activity':
        return reliableActivity(ctx.activity)
      case 'observe_owner':
        return reliableActivity(ctx.activity) || events.length > 0
      case 'idle':
        return true
      default:
        return false
    }
  }

  /* ---------- scoring ---------- */

  function contextBonusFor(intent, ctx, ts) {
    const events = pendingImportantEvents(ctx, ts)
    const activityType = ownerActivityType(ctx)
    const energy = energyRatio(ctx)
    const emotion = ctx.emotion && ctx.emotion.values ? ctx.emotion.values : {}
    switch (intent) {
      case 'respond_to_event': return hasEventKind('important', events) ? 15 : -15
      case 'celebrate': return hasEventKind('milestone', events) ? 12 : -8
      case 'comfort_owner': return hasEventKind('owner_negative', events) ? 12 : -8
      case 'rest': return (emotion.fatigue >= 0.70 || (energy !== null && energy < 0.20)) ? 12 : (energy !== null && energy < 0.35 ? 5 : -5)
      case 'seek_attention': return (emotion.loneliness >= 0.60 && activityType !== 'unknown') ? 10 : -5
      case 'tease_owner': return activityType !== 'unknown' && activityType !== 'work' ? 5 : -8
      case 'accompany_owner': return reliableActivity(ctx.activity) ? 8 : -10
      case 'comment_on_activity': return reliableActivity(ctx.activity) ? 7 : -10
      case 'observe_owner': return (reliableActivity(ctx.activity) || events.length > 0) ? 6 : -10
      default: return 0
    }
  }

  function emotionBiasFor(intent, ctx) {
    const e = ctx.emotion && ctx.emotion.values ? ctx.emotion.values : {}
    switch (intent) {
      case 'seek_attention': return clamp(Math.round((e.loneliness - 0.1) * 25), -5, 15)
      case 'rest': return clamp(Math.round(e.fatigue * 18), -5, 15)
      case 'comfort_owner': return clamp(Math.round((e.annoyance + e.loneliness) * 8), -5, 10)
      case 'celebrate': return clamp(Math.round((e.happiness + e.excitement) * 5), -5, 8)
      case 'tease_owner': return clamp(Math.round(e.happiness * 4), -5, 5)
      case 'idle': return 0
      default: return 0
    }
  }

  function relationshipBiasFor(intent, ctx) {
    const rel = ctx.relationship || {}
    const aff = typeof rel.affection === 'number' ? rel.affection : 0
    const trust = typeof rel.trust === 'number' ? rel.trust : 0
    const fam = typeof rel.familiarity === 'number' ? rel.familiarity : 0
    switch (intent) {
      case 'tease_owner': return clamp(Math.round((aff * 0.06) + (trust * 0.04)), -5, 10)
      case 'seek_attention': return clamp(Math.round((aff * 0.04) + (trust * 0.03)), -5, 8)
      case 'celebrate': return clamp(Math.round(aff * 0.03), -5, 5)
      case 'accompany_owner': return clamp(Math.round((aff * 0.02) + (fam * 0.03)), -5, 5)
      default: return 0
    }
  }

  function personaBiasFor(intent, ctx) {
    const persona = ctx.persona || {}
    const traits = persona.stableTraits || persona
    const mis = typeof traits.mischievousness === 'number' ? traits.mischievousness : 0
    const soc = typeof traits.sociability === 'number' ? traits.sociability : 0
    const play = typeof traits.playfulness === 'number' ? traits.playfulness : 0
    switch (intent) {
      case 'tease_owner': return clamp(Math.round(mis * 10), -5, 10)
      case 'seek_attention': return clamp(Math.round(soc * 4), -5, 6)
      case 'comment_on_activity': return clamp(Math.round(soc * 3), -5, 5)
      case 'celebrate': return clamp(Math.round(play * 3), -5, 5)
      default: return 0
    }
  }

  function memoryRelevanceFor(intent, ctx) {
    const mems = Array.isArray(ctx.memories) ? ctx.memories : []
    if (!mems.length) return 0
    if (intent === 'accompany_owner' || intent === 'comment_on_activity' || intent === 'observe_owner') {
      return clamp(mems.length * 2, 0, 10)
    }
    if (intent === 'celebrate' || intent === 'comfort_owner') {
      return clamp(mems.length, 0, 6)
    }
    return clamp(Math.floor(mems.length / 2), 0, 5)
  }

  function conflictPenaltyFor(intent, ctx) {
    const behavior = ctx.currentBehavior || {}
    const activityType = ownerActivityType(ctx)
    let penalty = 0
    if (behavior.interruptible === false) {
      penalty = -50
    }
    if (intent === 'rest' && activityType === 'work') penalty -= 20
    if (intent === 'tease_owner' && activityType === 'work') penalty -= 20
    return clamp(penalty, -50, 0)
  }

  function scoreIntent(intent, ctx, ts) {
    const config = INTENTS[intent]
    const breakdown = {
      baseWeight: config.baseWeight,
      contextBonus: contextBonusFor(intent, ctx, ts),
      emotionBias: emotionBiasFor(intent, ctx),
      relationshipBias: relationshipBiasFor(intent, ctx),
      personaBias: personaBiasFor(intent, ctx),
      memoryRelevance: memoryRelevanceFor(intent, ctx),
      noveltyBonus: noveltyFor(intent),
      cooldownPenalty: isCooldownBlocked(intent, ts) ? -20 : 0,
      conflictPenalty: conflictPenaltyFor(intent, ctx)
    }
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
    return { intent, priority: config.priority, score: round3(total), breakdown }
  }

  /* ---------- selection / arbitration ---------- */

  function eventTimeFor(intent, events) {
    if (intent === 'respond_to_event') {
      const e = findEvent('important', events)
      return e && e.createdAt ? e.createdAt : Number.MAX_SAFE_INTEGER
    }
    if (intent === 'celebrate') {
      const e = findEvent('milestone', events)
      return e && e.createdAt ? e.createdAt : Number.MAX_SAFE_INTEGER
    }
    if (intent === 'comfort_owner') {
      const e = findEvent('owner_negative', events)
      return e && e.createdAt ? e.createdAt : Number.MAX_SAFE_INTEGER
    }
    return Number.MAX_SAFE_INTEGER
  }

  function compareCandidates(a, b, ctx, ts) {
    if (b.priority !== a.priority) return b.priority - a.priority
    if (b.score !== a.score) return b.score - a.score
    const an = a.breakdown.noveltyBonus || 0
    const bn = b.breakdown.noveltyBonus || 0
    if (bn !== an) return bn - an
    const at = eventTimeFor(a.intent, pendingImportantEvents(ctx, ts))
    const bt = eventTimeFor(b.intent, pendingImportantEvents(ctx, ts))
    if (at !== bt) return at - bt
    return INTENTS[a.intent].order - INTENTS[b.intent].order
  }

  function buildCandidates(ctx, ts, opts) {
    const candidates = []
    const rejected = []
    for (const kind of FIXED_ORDER) {
      try {
        if (!precondition(kind, ctx, ts, opts)) {
          rejected.push({ kind, reason: 'precondition_failed' })
          continue
        }
        const scored = scoreIntent(kind, ctx, ts)
        if (!Number.isFinite(scored.score)) {
          rejected.push({ kind, reason: 'invalid_score' })
          continue
        }
        candidates.push(scored)
      } catch (err) {
        rejected.push({ kind, reason: 'error' })
      }
    }
    candidates.sort((a, b) => compareCandidates(a, b, ctx, ts))
    return { candidates: candidates.length ? candidates : [], rejected }
  }

  function reset() {
    active = null
    history = []
    cooldowns = {}
    pendingEvents = []
    lastSelectionReason = ''
    lastRejectedReasons = []
    presenceDayKey = ''
    presenceDailyCount = 0
    lastPresenceAt = 0
    lastPresenceByIntent = {}
    counters.reconsiderCount = 0
    counters.supersededCount = 0
    counters.cooldownBlockedCount = 0
    lastCandidateIntents = []
    initialized = true
    return getSnapshot()
  }

  function init() { return reset() }

  function noteEvent(event) {
    const e = event && typeof event === 'object' ? { ...event } : {}
    if (!e.kind) return false
    pendingEvents.push({
      id: e.id || ('evt-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)),
      kind: String(e.kind),
      createdAt: e.createdAt || now(),
      sourceSummary: e.sourceSummary || e.source || '',
      consumed: false
    })
    if (pendingEvents.length > 30) pendingEvents = pendingEvents.slice(-30)
    return true
  }

  function consumeEventsFor(intent, ctx, ts) {
    const events = pendingImportantEvents(ctx, ts)
    if (intent === 'respond_to_event') {
      for (const e of events) if (e.kind === 'important') e.consumed = true
    }
    if (intent === 'celebrate') {
      for (const e of events) if (e.kind === 'milestone') e.consumed = true
    }
    if (intent === 'comfort_owner') {
      for (const e of events) if (e.kind === 'owner_negative') e.consumed = true
    }
  }

  function reconsider(input) {
    counters.reconsiderCount++
    const ctx = normalizeInput(input)
    const ts = now()
    // expire current active
    if (active && active.status === 'active' && active.expiresAt && active.expiresAt < ts) {
      active.status = 'expired'
      active = null
    }
    const built = buildCandidates(ctx, ts, { legacyPresenceGate: true })
    lastRejectedReasons = built.rejected
    const candidates = built.candidates
    lastCandidateIntents = candidates.map((c) => c.intent)
    counters.cooldownBlockedCount += candidates.filter((c) => (c.breakdown.cooldownPenalty || 0) < 0).length
    const selected = candidates.length ? candidates[0] : { intent: 'idle', priority: 10, score: 10, breakdown: { baseWeight: 10 } }

    let shouldReplace = !active || active.status !== 'active'
    if (active && active.status === 'active') {
      const activeCfg = INTENTS[active.kind]
      const incomingCfg = INTENTS[selected.intent]
      const behavior = ctx.currentBehavior || {}
      const canSupersede = active.allowSupersede === true || incomingCfg.priority >= activeCfg.priority + SUPERSEDE_DELTA
      const interruptible = behavior.interruptible !== false
      shouldReplace = canSupersede && interruptible
      if (!shouldReplace) {
        lastSelectionReason = 'keep_active_no_force_supersede'
      }
    }

    let resultIntent
    if (shouldReplace) {
      const nowTs = ts
      const prev = active
      if (prev && prev.status === 'active') {
        prev.status = 'superseded'
        counters.supersededCount++
      }
      resultIntent = {
        id: 'intent-' + nowTs.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        kind: selected.intent,
        createdAt: nowTs,
        expiresAt: nowTs + INTENTS[selected.intent].ttlMs,
        score: selected.score,
        priority: selected.priority,
        sourceSummary: '',
        status: 'active',
        breakdown: deepCopy(selected.breakdown || {})
      }
      active = resultIntent
      history.push(selected.intent)
      if (history.length > HISTORY_LIMIT) history.shift()
      cooldowns[selected.intent] = nowTs + INTENTS[selected.intent].cooldownMs
      if (selected.intent === 'seek_attention') markPresenceUsed(nowTs)
      consumeEventsFor(selected.intent, ctx, ts)
      lastSelectionReason = shouldReplace && prev ? 'supersede' : 'selected'
    } else {
      resultIntent = active
      lastSelectionReason = 'retain_active'
    }

    initialized = true
    return getSnapshot()
  }

  function getSnapshot() {
    const act = getActiveIntent()
    return {
      source: 'intent-engine',
      schemaVersion: SCHEMA_VERSION,
      activeIntent: act ? deepCopy(act) : null,
      activeKind: act ? act.kind : null,
      activeScore: act ? act.score : null,
      activePriority: act ? act.priority : null,
      history: history.slice(),
      pendingEventCount: pendingEvents.filter((e) => !e.consumed).length,
      diagnostics: getDiagnostics()
    }
  }

  function getDiagnostics() {
    return {
      initialized,
      activeIntent: active ? deepCopy(active) : null,
      candidateIntents: lastCandidateIntents.slice(),
      selectedIntent: active ? active.kind : null,
      selectionReason: lastSelectionReason,
      rejectedReasons: deepCopy(lastRejectedReasons),
      reconsiderCount: counters.reconsiderCount,
      supersededCount: counters.supersededCount,
      cooldownBlockedCount: counters.cooldownBlockedCount
    }
  }

  function getCandidates(input) {
    const ctx = normalizeInput(input)
    const built = buildCandidates(ctx, now())
    return deepCopy(built)
  }

  const PRESENCE_INTENTS = {
    greet_return:   { priority: 1, minAffection: 20, cooldownMs: 30 * 60 * 1000, requiresRecentInteraction: true },
    gentle_checkin: { priority: 2, minAffection: 30, cooldownMs: 2 * 60 * 60 * 1000, idleMinMs: 25 * 60 * 1000 },
    share_memory:   { priority: 3, minAffection: 20, cooldownMs: 60 * 60 * 1000, requiresMemory: true },
    concern:        { priority: 4, minAffection: 20, cooldownMs: 30 * 60 * 1000, requiresEmotionBasis: true },
    celebrate:      { priority: 5, minAffection: 20, cooldownMs: 30 * 60 * 1000, requiresEvent: true },
    quiet_presence: { priority: 6, minAffection: 40, cooldownMs: 3 * 60 * 60 * 1000, idleMinMs: 2 * 60 * 60 * 1000 }
  }
  const presenceDiagnostics = []

  function lastPresenceForIntent(intent) {
    return lastPresenceByIntent[intent] || 0
  }

  function presenceEventKind(e) {
    if (!e) return null
    if (e.kind) return e.kind
    if (e.payload && e.payload.kind) return e.payload.kind
    const name = String(e.event || '')
    if (name === 'game.completed' && e.payload && e.payload.won) return 'special_milestone'

    if (['milestone', 'celebrate', 'festival', 'special_milestone'].indexOf(name) >= 0) return name
    if (/birthday|milestone|achievement|festival|celebrate/i.test(name)) return 'special_milestone'
    return null
  }

  function evaluatePresence(input) {
    const x = input && typeof input === 'object' ? input : {}
    const ctx = normalizeInput(x)
    const ts = x.ts || now()
    const pol = getPresencePolicy(ts)
    const pet = ctx.pet || {}
    const emotionValues = ctx.emotion && ctx.emotion.values ? ctx.emotion.values : {}
    const rel = ctx.relationship || {}
    const affection = typeof x.affection === 'number' ? x.affection : (typeof rel.affection === 'number' ? rel.affection : 0)
    const memories = Array.isArray(x.memories) ? x.memories : (Array.isArray(ctx.memories) ? ctx.memories : [])
    const recentEvents = ctx.recentEvents || []
    const lastInteraction = typeof x.lastInteractionAt === 'number' ? x.lastInteractionAt : (pet.lastInteractionAt ? pet.lastInteractionAt : 0)
    const idleMs = lastInteraction ? ts - lastInteraction : 0
    const suppression = {
      busy: !!x.busy || !!x.chatBusy,
      chatOpen: !!x.chatOpen,
      work: !!x.workId || (x.activityType === 'work'),
      rest: !!x.resting,
      game: !!x.gamePlaying,
      typing: !!x.userTyping
    }
    const suppressReason = Object.keys(suppression).find((k) => suppression[k]) || null
    const record = (intent, reason, trigger, suppressed, suppressionReason) => {
      const d = { intent, trigger, reason, suppressed: !!suppressed, suppressionReason: suppressionReason || null, timestamp: ts }
      presenceDiagnostics.push(d)
      if (presenceDiagnostics.length > 50) presenceDiagnostics.shift()
      return d
    }
    if (suppressReason) {
      const d = record('none', 'suppressed', null, true, suppressReason)
      return { selected: false, intent: null, reason: 'suppressed', trigger: null, suppressed: true, suppressionReason: suppressReason, diagnostic: d, pol }
    }
    if (!pol.allowed) {
      const d = record('none', 'cooldown_or_daily_limit', null, true, pol.cooldownLeftMs > 0 ? 'cooldown' : 'daily_limit')
      return { selected: false, intent: null, reason: d.reason, trigger: null, suppressed: true, suppressionReason: d.suppressionReason, diagnostic: d, pol }
    }
    if (affection < PRESENCE_POLICY.minAffection) {
      const d = record('none', 'low_affection', null, true, 'low_affection')
      return { selected: false, intent: null, reason: d.reason, trigger: null, suppressed: true, suppressionReason: d.suppressionReason, diagnostic: d, pol }
    }
    const candidates = Object.keys(PRESENCE_INTENTS)
      .map((intent) => {
        const cfg = PRESENCE_INTENTS[intent]
        const last = lastPresenceForIntent(intent)
        const cooldownLeft = last + cfg.cooldownMs - ts
        if (cooldownLeft > 0) return null
        if (affection < cfg.minAffection) return null
        if (intent === 'greet_return' && !(lastInteraction && ts - lastInteraction < 5 * 60 * 1000)) return null
        if (intent === 'gentle_checkin' && idleMs < cfg.idleMinMs) return null
        if (intent === 'share_memory' && memories.length === 0) return null
        if (intent === 'concern' && !(emotionValues.sadness >= 0.5 || emotionValues.worry >= 0.5 || emotionValues.loneliness >= 0.5 || emotionValues.fatigue >= 0.7)) return null
        if (intent === 'celebrate' && !recentEvents.some((e) => ['milestone', 'celebrate', 'festival', 'special_milestone'].indexOf(presenceEventKind(e)) >= 0)) return null
        if (intent === 'quiet_presence' && idleMs < cfg.idleMinMs) return null
        return { intent, cfg, priority: cfg.priority }
      })
      .filter(Boolean)
      .sort((a, b) => a.priority - b.priority)
    if (!candidates.length) {
      const d = record('none', 'no_trigger', null, true, 'no_trigger')
      return { selected: false, intent: null, reason: d.reason, trigger: null, suppressed: true, suppressionReason: d.suppressionReason, diagnostic: d, pol }
    }
    const chosen = candidates[0]
    const d = record(chosen.intent, 'valid_trigger', chosen.intent, false, null)
    return { selected: true, intent: chosen.intent, reason: d.reason, trigger: chosen.intent, suppressed: false, suppressionReason: null, diagnostic: d, pol }
  }

  function getPresenceDiagnostics() { return deepCopy(presenceDiagnostics) }

  function getPresenceStats() {
    const triggered = presenceDiagnostics.filter((d) => d.suppressed !== true && d.intent !== 'none')
    const suppressed = presenceDiagnostics.filter((d) => d.suppressed === true)
    return deepCopy({
      triggerCount: triggered.length,
      suppressedCount: suppressed.length,
      lastTriggeredAt: triggered.length ? triggered[triggered.length - 1].timestamp : null,
      lastSuppressedAt: suppressed.length ? suppressed[suppressed.length - 1].timestamp : null
    })
  }

  const WRITE_BOUNDARY = {
    owner: 'IntentEngine',
    allowed: ['local-preconditions', 'frozen-scoring', 'priority-arbitration'],
    denied: ['ai', 'dialogue', 'chat', 'expression', 'animation', 'persona', 'relationship', 'memory', 'emotion', 'needs', 'behavior', 'perception'],
    note: 'IntentEngine reads snapshots only. It never writes other 3.0 modules or executes behavior.'
  }

  /* ---------- 未来线 F4：自主选择（**纯追加**；零接线；不触发任何存在感路径） ---------- */

  const AUTONOMY_POLICY = Object.freeze({
    dailyCap: 8,
    intervalLadderMs: Object.freeze([20 * 60 * 1000, 40 * 60 * 1000, 60 * 60 * 1000, 90 * 60 * 1000]),
    quietHours: Object.freeze({ from: 23, to: 7 }),
    pool: Object.freeze(FIXED_ORDER.slice())
  })

  // 只读适配：把**既有**候选（buildCandidates 的打分结果）交给未来线选择器（window.LifeAutonomy.decide）。
  // 不写任何既有状态、不调用 selectIntent / markPresenceUsed、不触发存在感；本函数无任何对外开口。
  function selectAutonomous(input, options) {
    const opts = options || {}
    const ctx = normalizeInput(input || {})
    const ts = Number.isFinite(opts.nowTs) ? opts.nowTs : now()
    const built = buildCandidates(ctx, ts)
    const pool = (built && built.candidates ? built.candidates : []).map((c) => ({
      actionId: c.intent,
      score: c.score,
      priority: c.priority,
      breakdown: deepCopy(c.breakdown)
    }))
    const autonomy = (typeof window !== 'undefined' && window.LifeAutonomy) ? window.LifeAutonomy : null
    const decision = autonomy
      ? autonomy.decide(Object.assign({}, opts.decisionInput || {}, { pool: pool, nowTs: ts }), opts.policy || autonomyPolicyView())
      : { ok: false, reason: 'autonomy_module_absent' }
    return { policy: autonomyPolicyView(), pool: pool, rejected: deepCopy((built && built.rejected) || []), decision: decision }
  }

  function autonomyPolicyView() {
    return deepCopy(AUTONOMY_POLICY)
  }

  return {
    SCHEMA_VERSION,
    INTENTS: deepCopy(INTENTS),
    FIXED_ORDER: FIXED_ORDER.slice(),
    init,
    reset,
    noteEvent,
    reconsider,
    getSnapshot,
    getActiveIntent,
    getDiagnostics,
    diagnostics: getDiagnostics,
    getCandidates,
    PRESENCE_POLICY: deepCopy(PRESENCE_POLICY),
    presenceBudget,
    getPresencePolicy,
    presencePolicy: getPresencePolicy,
    evaluatePresence,
    markPresenceUsed,
    getPresenceState,
    restorePresenceState,
    getPresenceDiagnostics,
    getPresenceStats,
    PRESENCE_INTENTS: deepCopy(PRESENCE_INTENTS),
    selectAutonomous,
    AUTONOMY_POLICY: autonomyPolicyView(),
    WRITE_BOUNDARY
  }
})()








