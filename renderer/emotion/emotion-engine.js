/* EmotionEngine — 3.0-05
 * Pure local, explainable current-emotion engine.
 *
 * Ownership:
 *   - EmotionEngine is the only writer of EmotionState.
 *   - Other systems submit normalized EmotionEvent or read EmotionSnapshot.
 *   - AI / Dialogue / UI / Game / Diary must not write EmotionState directly.
 *
 * Design rules frozen by Phase 3.0-05 v0.3:
 *   - five dimensions with fixed baselines and half-lives
 *   - exponential recovery based on real elapsed time
 *   - fixed EmotionEvent whitelist and deltas
 *   - owner_interaction cooldown + diminishing returns
 *   - loneliness requires reliable interaction history and 2h idle
 *   - fatigue bridges from Needs.energy without copying energy
 */
window.EmotionEngine = (function () {
  const SCHEMA_VERSION = 1

  const DIMENSIONS = {
    happiness: { baseline: 0.50, halfLifeMs: 90 * 60 * 1000 },
    loneliness: { baseline: 0.10, halfLifeMs: 360 * 60 * 1000 },
    excitement: { baseline: 0.10, halfLifeMs: 45 * 60 * 1000 },
    annoyance: { baseline: 0.00, halfLifeMs: 60 * 60 * 1000 },
    fatigue: { baseline: 0.20, halfLifeMs: 180 * 60 * 1000 }
  }

  const EVENT_RULES = {
    owner_interaction: { ruleId: 'EMO-OWNER-01', delta: { happiness: 0.05, loneliness: -0.05 } },
    task_complete: { ruleId: 'EMO-TASK-01', delta: { happiness: 0.06, excitement: 0.05 } },
    special_milestone: { ruleId: 'EMO-MILESTONE-01', delta: { happiness: 0.10, excitement: 0.12 } },
    explicit_failure: { ruleId: 'EMO-FAILURE-01', delta: { annoyance: 0.07, excitement: -0.03 } },
    explicit_interruption: { ruleId: 'EMO-INTERRUPT-01', delta: { annoyance: 0.05 } },
    low_energy: { ruleId: 'EMO-LOWENERGY-01', delta: { fatigue: 0.05 } },
    long_activity: { ruleId: 'EMO-LONGACT-01', delta: { fatigue: 0.03, excitement: -0.02 } },
    rest: { ruleId: 'EMO-REST-01', delta: { fatigue: -0.08 } },
    sleep: { ruleId: 'EMO-SLEEP-01', delta: { fatigue: -0.15, happiness: 0.03 } }
  }

  // P2（视听说）：解除对 'perception' 的拒绝 —— 感知经
  // Observation → SemanticEvent → EmotionEvent 正规通道提交，
  // 仍必须通过 applyEvent() 进入状态机（Only EmotionEngine writes EmotionState）。
  const DENIED_SOURCES = new Set([
    'ai', 'dialogue', 'chat', 'diary', 'ui', 'game', 'expression', 'intent',
    'relationship', 'memory', 'behavior', 'vision'
  ])

  const OWNER_INTERACTION_COOLDOWN_MS = 30 * 1000
  const OWNER_DIMINISHING = [1.0, 0.6, 0.35, 0.2]
  const OWNER_WINDOW_MS = 10 * 60 * 1000
  const LONELINESS_THRESHOLD_MS = 2 * 60 * 60 * 1000
  const LONELINESS_RATE = 0.01 // per 30 minutes beyond threshold
  const LONELINESS_STEP_MS = 30 * 60 * 1000
  const FATIGUE_LOW_COOLDOWN_MS = 30 * 60 * 1000
  const MAX_PROCESSED_EVENT_IDS = 200

  function clamp(v, min, max) {
    const n = Number(v)
    if (!Number.isFinite(n)) return min || 0
    return Math.min(max, Math.max(min, n))
  }

  function deepCopy(obj) {
    if (obj === null || typeof obj !== 'object') return obj
    try { return JSON.parse(JSON.stringify(obj)) } catch (err) { return { ...obj } }
  }

  function deepFreeze(obj) {
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
      Object.freeze(obj)
      for (const k of Object.keys(obj)) deepFreeze(obj[k])
    }
    return obj
  }

  function getP(P) {
    if (P && typeof P === 'object' && !Array.isArray(P) &&
        ('emotion' in P || 'affection' in P || 'stats' in P || 'name' in P)) return P
    return window.PetStateApi && window.PetStateApi.raw ? window.PetStateApi.raw : null
  }

  function defaultState() {
    const now = Date.now()
    return {
      schemaVersion: SCHEMA_VERSION,
      values: {
        happiness: DIMENSIONS.happiness.baseline,
        loneliness: DIMENSIONS.loneliness.baseline,
        excitement: DIMENSIONS.excitement.baseline,
        annoyance: DIMENSIONS.annoyance.baseline,
        fatigue: DIMENSIONS.fatigue.baseline
      },
      updatedAt: now,
      version: 1,
      processedEventIds: [],
      ownerInteractionTimes: [],
      lastFatigueLowEnergyAt: 0,
      diagnostics: {
        lastEventId: null,
        lastKind: null,
        lastRuleId: null,
        lastDelta: null,
        lastTs: null,
        decaySince: 0,
        offlineRecovery: false,
        lastLonelinessRule: null,
        clampCount: 0,
        saturatedCount: 0,
        duplicateEventIgnored: 0,
        persistenceWarning: null
      }
    }
  }

  function ensureState(P) {
    const raw = getP(P)
    if (!raw) return null
    if (!raw.emotion || typeof raw.emotion !== 'object' || Array.isArray(raw.emotion)) {
      raw.emotion = defaultState()
    } else {
      const s = raw.emotion
      if (typeof s.schemaVersion !== 'number') s.schemaVersion = SCHEMA_VERSION
      if (!s.values || typeof s.values !== 'object') s.values = defaultState().values
      for (const key of Object.keys(DIMENSIONS)) {
        const v = s.values[key]
        if (typeof v !== 'number' || !Number.isFinite(v)) s.values[key] = DIMENSIONS[key].baseline
        s.values[key] = clamp(s.values[key], 0, 1)
      }
      if (typeof s.updatedAt !== 'number' || !Number.isFinite(s.updatedAt)) s.updatedAt = Date.now()
      if (typeof s.version !== 'number' || s.version < 1) s.version = 1
      if (!Array.isArray(s.processedEventIds)) s.processedEventIds = []
      if (!Array.isArray(s.ownerInteractionTimes)) s.ownerInteractionTimes = []
      if (typeof s.lastFatigueLowEnergyAt !== 'number') s.lastFatigueLowEnergyAt = 0
      if (!s.diagnostics || typeof s.diagnostics !== 'object') s.diagnostics = defaultState().diagnostics
    }
    return raw.emotion
  }

  function decayValue(value, baseline, halfLifeMs, elapsedMs) {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return value
    const k = Math.LN2 / halfLifeMs
    return baseline + (value - baseline) * Math.exp(-k * elapsedMs)
  }

  function applyDecay(state, now) {
    const elapsed = now - state.updatedAt
    if (elapsed > 0) {
      for (const key of Object.keys(DIMENSIONS)) {
        const v = state.values[key]
        state.values[key] = clamp(decayValue(v, DIMENSIONS[key].baseline, DIMENSIONS[key].halfLifeMs, elapsed), 0, 1)
      }
      state.diagnostics.decaySince = elapsed
    } else if (elapsed < 0) {
      // Time rollback: never reverse-decay. Re-anchor and keep current values.
    }
    state.updatedAt = now
    return state
  }

  function applyLonelinessRule(state, P, now) {
    const lastInteraction = P && typeof P.lastInteractionAt === 'number' ? P.lastInteractionAt : 0
    if (!lastInteraction || lastInteraction <= 0) return false
    const idleBeyond = now - lastInteraction - LONELINESS_THRESHOLD_MS
    if (idleBeyond <= 0) return false
    const steps = Math.floor(idleBeyond / LONELINESS_STEP_MS)
    const target = clamp(DIMENSIONS.loneliness.baseline + steps * LONELINESS_RATE, 0, 1)
    const before = state.values.loneliness
    if (target > before) {
      state.values.loneliness = clamp(target, 0, 1)
      state.diagnostics.lastLonelinessRule = { rule: 'long_idle', ts: now }
      return true
    }
    return false
  }

  function applyFatigueBridge(state, P, now) {
    const energy = P && P.stats && typeof P.stats.energy === 'number' ? P.stats.energy / 100 : null
    if (energy === null || energy >= 0.30) return false
    if (now - (state.lastFatigueLowEnergyAt || 0) < FATIGUE_LOW_COOLDOWN_MS) return false
    let delta = 0
    if (energy < 0.15) delta = 0.05
    else delta = 0.03
    state.values.fatigue = clamp(state.values.fatigue + delta, 0, 1)
    state.lastFatigueLowEnergyAt = now
    return true
  }

  function refresh(P, now) {
    const state = ensureState(P)
    if (!state) return null
    const ts = Number(now) || Date.now()
    applyDecay(state, ts)
    applyLonelinessRule(state, getP(P), ts)
    applyFatigueBridge(state, getP(P), ts)
    return state
  }

  function getSnapshot(P) {
    const state = refresh(P)
    if (!state) return null
    const values = deepCopy(state.values)
    return deepFreeze({
      source: 'emotion-engine',
      schemaVersion: SCHEMA_VERSION,
      values,
      derivedMood: deriveMood(values),
      updatedAt: state.updatedAt,
      version: state.version
    })
  }

  function getValues(P) {
    const state = refresh(P)
    return state ? deepCopy(state.values) : deepCopy(defaultState().values)
  }

  function deriveMood(values) {
    if (values.fatigue >= 0.70) return 'tired'
    if (values.annoyance >= 0.65) return 'annoyed'
    if (values.loneliness >= 0.60) return 'lonely'
    if (values.excitement >= 0.65) return 'excited'
    if (values.happiness >= 0.65) return 'cheerful'
    return 'neutral'
  }

  function isDuplicate(state, eventId) {
    return !!eventId && state.processedEventIds.indexOf(eventId) >= 0
  }

  function markProcessed(state, eventId) {
    if (!eventId) return
    if (state.processedEventIds.indexOf(eventId) < 0) {
      state.processedEventIds.push(eventId)
      if (state.processedEventIds.length > MAX_PROCESSED_EVENT_IDS) {
        state.processedEventIds.splice(0, state.processedEventIds.length - MAX_PROCESSED_EVENT_IDS)
      }
    }
  }

  function applyDelta(state, delta) {
    const before = deepCopy(state.values)
    for (const key of Object.keys(delta || {})) {
      if (!DIMENSIONS[key]) continue
      const v = state.values[key] + (delta[key] || 0)
      const clamped = clamp(v, 0, 1)
      if (clamped !== v || (state.values[key] === 0 && clamped === 0) || (state.values[key] === 1 && clamped === 1)) {
        state.diagnostics.clampCount++
      }
      if (clamped >= 1 || clamped <= 0) state.diagnostics.saturatedCount++
      state.values[key] = clamped
    }
    return { before, after: deepCopy(state.values) }
  }

  function ownerInteractionFactor(state, now) {
    const times = state.ownerInteractionTimes
    const recent = times.filter((t) => now - t < OWNER_WINDOW_MS)
    state.ownerInteractionTimes = recent
    const rank = recent.length + 1
    const factor = OWNER_DIMINISHING[Math.min(rank - 1, OWNER_DIMINISHING.length - 1)]
    return { factor, rank }
  }

  function applyEvent(P, rawEvent) {
    const state = refresh(P)
    if (!state) return { ok: false, reason: 'no_state' }
    const event = rawEvent && typeof rawEvent === 'object' ? { ...rawEvent } : {}
    const kind = String(event.kind || '')
    const eventId = String(event.eventId || (kind + ':' + (event.ts || Date.now()) + ':' + Math.random().toString(36).slice(2, 8)))
    const ts = Number(event.ts) || Date.now()
    const source = String(event.source || 'internal')
    if (DENIED_SOURCES.has(source.toLowerCase())) {
      return { ok: false, reason: 'denied_source', eventId, kind, source }
    }
    const rule = EVENT_RULES[kind]
    if (!rule) {
      state.diagnostics.lastEventId = eventId
      state.diagnostics.lastKind = kind
      state.diagnostics.lastRuleId = null
      return { ok: false, reason: 'unknown_kind', eventId, kind }
    }
    if (isDuplicate(state, eventId)) {
      state.diagnostics.duplicateEventIgnored++
      return { ok: false, reason: 'duplicate_event', eventId, kind }
    }

    // Base deltas are frozen by v0.3. Relationship may influence emotional
    // amplitude in a future integration, but this phase keeps the frozen base
    // rule set exact and does not introduce non-frozen modifiers.
    let appliedDelta = { ...rule.delta }
    if (kind === 'owner_interaction') {
      const lastTime = state.ownerInteractionTimes.length ? state.ownerInteractionTimes[state.ownerInteractionTimes.length - 1] : 0
      if (ts - lastTime < OWNER_INTERACTION_COOLDOWN_MS) {
        // Cooldown: record the event but do not linearly accumulate.
        state.diagnostics.lastEventId = eventId
        state.diagnostics.lastKind = kind
        state.diagnostics.lastRuleId = rule.ruleId
        state.diagnostics.lastTs = ts
        markProcessed(state, eventId)
        return { ok: true, applied: false, reason: 'cooldown', eventId, kind, ruleId: rule.ruleId, delta: null }
      }
      const { factor } = ownerInteractionFactor(state, ts)
      appliedDelta = {}
      if (rule.delta.happiness) appliedDelta.happiness = rule.delta.happiness * factor
      if (rule.delta.loneliness) appliedDelta.loneliness = rule.delta.loneliness * factor
      state.ownerInteractionTimes.push(ts)
      if (state.ownerInteractionTimes.length > 12) state.ownerInteractionTimes.shift()
    }

    const change = applyDelta(state, appliedDelta)
    state.diagnostics.lastEventId = eventId
    state.diagnostics.lastKind = kind
    state.diagnostics.lastRuleId = rule.ruleId
    state.diagnostics.lastTs = ts
    state.diagnostics.lastDelta = deepCopy(appliedDelta)
    state.version++
    markProcessed(state, eventId)

    return {
      ok: true,
      applied: true,
      eventId,
      kind,
      ruleId: rule.ruleId,
      delta: deepCopy(appliedDelta),
      before: change.before,
      after: change.after,
      snapshot: getSnapshot(P)
    }
  }

  function getDiagnostics(P) {
    const state = refresh(P)
    if (!state) return null
    return deepCopy({
      schemaVersion: SCHEMA_VERSION,
      values: deepCopy(state.values),
      derivedMood: deriveMood(state.values),
      lastEmotionEvent: state.diagnostics.lastEventId ? {
        eventId: state.diagnostics.lastEventId,
        kind: state.diagnostics.lastKind,
        ruleId: state.diagnostics.lastRuleId,
        delta: state.diagnostics.lastDelta,
        ts: state.diagnostics.lastTs
      } : null,
      decaySince: state.diagnostics.decaySince || 0,
      clampCount: state.diagnostics.clampCount || 0,
      saturatedCount: state.diagnostics.saturatedCount || 0,
      duplicateEventIgnored: state.diagnostics.duplicateEventIgnored || 0,
      offlineRecovery: !!state.diagnostics.offlineRecovery,
      lastLonelinessRule: state.diagnostics.lastLonelinessRule || null,
      persistenceWarning: state.diagnostics.persistenceWarning || null,
      processedEventCount: state.processedEventIds.length,
      version: state.version
    })
  }

  let emotionEventSubscribed = false

  function subscribeEvents(P) {
    if (emotionEventSubscribed || !window.EventBus) return
    emotionEventSubscribed = true
    window.EventBus.on('pet.fed', (p) => {
      const payload = p || {}
      applyEvent(P, { eventId: 'emo:fed:' + (payload.ts || Date.now()), kind: 'owner_interaction', ts: payload.ts || Date.now(), source: 'domain-pet-fed' })
    })
    window.EventBus.on('pet.work.completed', (p) => {
      const payload = p || {}
      applyEvent(P, { eventId: 'emo:work:' + (payload.jobId || 'unknown') + ':' + (payload.ts || Date.now()), kind: 'task_complete', ts: payload.ts || Date.now(), source: 'domain-work' })
    })
    window.EventBus.on('game.completed', (p) => {
      const payload = p || {}
      applyEvent(P, {
        eventId: 'emo:game:' + (payload.gameId || 'unknown') + ':' + (payload.ts || Date.now()),
        kind: payload.won ? 'special_milestone' : 'task_complete',
        ts: payload.ts || Date.now(),
        source: 'domain-game'
      })
    })
    window.EventBus.on('pet.clicked', (p) => {
      const payload = p || {}
      applyEvent(P, { eventId: 'emo:click:' + (payload.ts || Date.now()), kind: 'owner_interaction', ts: payload.ts || Date.now(), source: 'domain-click' })
    })
  }

  function init(P) {
    const state = ensureState(P)
    if (state) {
      refresh(P)
      subscribeEvents(P)
    }
    return state ? getSnapshot(P) : null
  }

  const WRITE_BOUNDARY = {
    owner: 'EmotionEngine',
    allowed: ['normalized-emotion-events', 'decay', 'needs-fatigue-bridge', 'loneliness-rule', 'perception-observation'],
    denied: ['ai', 'dialogue', 'chat', 'diary', 'ui', 'game', 'expression', 'intent', 'relationship', 'memory', 'behavior'],
    note: 'Only EmotionEngine writes EmotionState. Others submit EmotionEvent or read EmotionSnapshot.'
  }

  return {
    SCHEMA_VERSION,
    DIMENSIONS,
    EVENT_RULES,
    init,
    getSnapshot,
    snapshot: getSnapshot,
    getValues,
    getDiagnostics,
    diagnostics: getDiagnostics,
    applyEvent,
    emitEvent: applyEvent,
    deriveMood,
    WRITE_BOUNDARY,
    isWriteSourceAllowed: (source) => !WRITE_BOUNDARY.denied.includes(String(source || '').toLowerCase())
  }
})()
