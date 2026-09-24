/* ExpressionEngine — 3.0-07
 * Renders an already-decided Intent + Behavior into a multi-channel
 * ExpressionPlan (animation / dialogue / sound).
 *
 * Ownership:
 *   - ExpressionEngine never creates or changes Intent/Behavior.
 *   - It never plays animation, audio, or generates final dialogue.
 *   - It does not call AI.
 *   - It only produces a short-lived, explainable ExpressionPlan.
 */
window.ExpressionEngine = (function () {
  const SCHEMA_VERSION = 1
  const STYLE_HINTS = ['energy', 'warmth', 'playfulness', 'shyness', 'urgency', 'softness', 'verbosity']
  const CHANNELS = ['animation', 'dialogue', 'sound']
  const PLAN_TTL_MS = 30 * 1000

  let activePlan = null
  let planSeq = 0
  const plans = {}
  let diagnostics = {
    created: 0,
    cancelled: 0,
    superseded: 0,
    expired: 0,
    completed: 0,
    channelFailures: []
  }

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

  function round3(v) { return Math.round((Number(v) || 0) * 1000) / 1000 }

  function getPersona() {
    try { return window.PersonaCore ? window.PersonaCore.getCore() : null } catch (err) { return null }
  }

  function getRelationship() {
    try { return window.RelationshipEngine ? window.RelationshipEngine.get() : null } catch (err) { return null }
  }

  function getEmotion() {
    try { return window.EmotionEngine ? window.EmotionEngine.getSnapshot() : null } catch (err) { return null }
  }

  function getContext() {
    try { return window.ContextFoundation ? window.ContextFoundation.builder.build() : {} } catch (err) { return {} }
  }

  function normalizeInput(input) {
    const x = input && typeof input === 'object' ? input : {}
    let characterContext = null
    try {
      if (window.CharacterSnapshot && typeof window.CharacterSnapshot.toCharacterContext === 'function') characterContext = window.CharacterSnapshot.toCharacterContext()
    } catch (err) { /* ignore */ }
    const intent = x.intent || (window.IntentEngine ? window.IntentEngine.getSnapshot() : null)
    const behavior = x.behavior || (window.BehaviorDirector && intent ? window.BehaviorDirector.planForIntent(intent) : null)
    const emotion = 'emotion' in x ? x.emotion : (characterContext && characterContext.emotion ? characterContext.emotion : getEmotion())
    const persona = 'persona' in x ? x.persona : (characterContext && characterContext.persona ? characterContext.persona : getPersona())
    const relationship = 'relationship' in x ? x.relationship : (characterContext && characterContext.relationship ? characterContext.relationship : getRelationship())
    const context = 'context' in x ? x.context : (characterContext || getContext())
    return { intent, behavior, emotion, persona, relationship, context }
  }

  function styleBase(intentKind, behaviorKey) {
    const b = {
      respond_to_event: { energy: 0.75, urgency: 0.85, warmth: 0.55 },
      celebrate: { energy: 0.85, playfulness: 0.6, warmth: 0.7, urgency: 0.5 },
      comfort_owner: { energy: 0.35, softness: 0.7, warmth: 0.75, shyness: 0.2 },
      rest: { energy: 0.2, softness: 0.8, verbosity: 0.2, warmth: 0.5 },
      seek_attention: { energy: 0.65, playfulness: 0.5, warmth: 0.65, urgency: 0.45 },
      tease_owner: { energy: 0.65, playfulness: 0.85, warmth: 0.6, urgency: 0.4 },
      accompany_owner: { energy: 0.4, warmth: 0.6, softness: 0.55 },
      comment_on_activity: { energy: 0.5, playfulness: 0.35, verbosity: 0.45 },
      observe_owner: { energy: 0.3, softness: 0.55, shyness: 0.35 },
      idle: { energy: 0.4, warmth: 0.5, softness: 0.5 }
    }
    return deepCopy(b[intentKind] || { energy: 0.4, warmth: 0.5, softness: 0.5 })
  }

  function computeStyleHints(n) {
    const intentKind = n.intent && n.intent.activeKind ? n.intent.activeKind : 'idle'
    const behaviorKey = n.behavior && n.behavior.behavior ? n.behavior.behavior.key : null
    const base = styleBase(intentKind, behaviorKey)
    const emotion = n.emotion && n.emotion.values ? n.emotion.values : {}
    const traits = n.persona && (n.persona.stableTraits || n.persona) ? (n.persona.stableTraits || n.persona) : {}
    const profile = n.persona && n.persona.expressionProfile ? n.persona.expressionProfile : {}
    const rel = n.relationship || {}
    const aff = typeof rel.affection === 'number' ? rel.affection / 100 : 0.5
    const trust = typeof rel.trust === 'number' ? rel.trust / 100 : 0.5

    const hints = {
      energy: clamp(base.energy * 0.5 + (emotion.excitement || 0) * 0.35 + (emotion.happiness || 0) * 0.15 + 0.1, 0, 1),
      warmth: clamp(base.warmth * 0.5 + aff * 0.25 + trust * 0.15 + 0.1, 0, 1),
      playfulness: clamp(base.playfulness * 0.4 + (traits.playfulness || 0.5) * 0.35 + (traits.mischievousness || 0.3) * 0.25, 0, 1),
      shyness: clamp(base.shyness || 0.15, 0, 1),
      urgency: clamp(base.urgency * 0.6 + (emotion.excitement || 0) * 0.25 + (intentKind === 'respond_to_event' ? 0.15 : 0), 0, 1),
      softness: clamp(base.softness * 0.5 + (1 - (emotion.annoyance || 0)) * 0.2 + (1 - (traits.confidence || 0.5)) * 0.1 + 0.2, 0, 1),
      verbosity: clamp((profile.sentenceLength === 'short' ? 0.3 : profile.sentenceLength === 'long' ? 0.8 : 0.5), 0, 1)
    }
    for (const k of STYLE_HINTS) hints[k] = round3(clamp(hints[k], 0, 1))
    hints.emojiMap = { happy: '😊', thoughtful: '🤔', shy: '(///▽///)', sleepy: '😴' }
    return hints
  }

  function makeAnimationChannel(n, styleHints) {
    const behavior = n.behavior
    if (behavior && behavior.behavior && behavior.behavior.candidate) {
      return {
        candidate: behavior.behavior.candidate,
        mode: behavior.behavior.mode || 'once',
        style: { energy: styleHints.energy, softness: styleHints.softness, playfulness: styleHints.playfulness }
      }
    }
    return null
  }

  function toneFor(intentKind, styleHints) {
    if (intentKind === 'comfort_owner') return 'gentle'
    if (intentKind === 'tease_owner') return 'playful'
    if (intentKind === 'celebrate') return 'cheerful'
    if (intentKind === 'rest') return 'calm'
    if (intentKind === 'respond_to_event') return 'attentive'
    return 'neutral'
  }

  function makeDialogueChannel(n, styleHints) {
    const intentKind = n.intent && n.intent.activeKind ? n.intent.activeKind : null
    if (!intentKind || intentKind === 'idle' || intentKind === 'observe_owner') return null
    return {
      intentKind,
      behaviorKey: n.behavior && n.behavior.behavior ? n.behavior.behavior.key : null,
      tone: toneFor(intentKind, styleHints),
      styleHints: {
        warmth: styleHints.warmth,
        playfulness: styleHints.playfulness,
        verbosity: styleHints.verbosity,
        softness: styleHints.softness
      },
      requiresFinalText: true
    }
  }

  function makeSoundChannel(n, styleHints) {
    const intentKind = n.intent && n.intent.activeKind ? n.intent.activeKind : null
    if (!intentKind || ['celebrate', 'tease_owner', 'seek_attention'].indexOf(intentKind) < 0) return null
    return {
      kind: 'ambient_chime',
      volume: round3(clamp(0.3 + styleHints.energy * 0.3 + styleHints.playfulness * 0.2, 0, 1)),
      styleHints: { softness: styleHints.softness, playfulness: styleHints.playfulness }
    }
  }

  function createPlan(input) {
    const n = normalizeInput(input)
    const intentKind = n.intent && n.intent.activeKind ? n.intent.activeKind : 'idle'
    const behaviorKey = n.behavior && n.behavior.behavior ? n.behavior.behavior.key : null
    const styleHints = computeStyleHints(n)
    const now = Date.now()
    const requestId = 'expr-' + (++planSeq) + '-' + now.toString(36)
    const animation = makeAnimationChannel(n, styleHints)
    const dialogue = makeDialogueChannel(n, styleHints)
    const sound = makeSoundChannel(n, styleHints)
    if (animation && window.AnimationMetadata && typeof window.AnimationMetadata.get === 'function') {
      animation.tags = window.AnimationMetadata.get(animation.candidate)
    }
    const emotionValues = n.emotion && n.emotion.values ? n.emotion.values : {}
    const expressionEvent = {
      intent: intentKind,
      emotion: { ...emotionValues },
      expressionType: behaviorKey,
      animationHint: animation ? animation.candidate : null,
      dialogueHint: dialogue ? dialogue.tone : null,
      priority: 60
    }
    const plan = {
      schemaVersion: SCHEMA_VERSION,
      requestId,
      intentKind,
      behaviorKey,
      status: 'proposed',
      styleHints,
      expressionEvent,
      channels: {
        animation,
        dialogue,
        sound
      },
      sourceSummary: {
        intent: intentKind,
        behavior: behaviorKey,
        candidate: animation ? animation.candidate : null
      },
      createdAt: now,
      expiresAt: now + PLAN_TTL_MS,
      diagnostics: {
        selectedChannels: CHANNELS.filter((c) => !!plan_channel(n, c)),
        suppressedChannels: [],
        channelFailures: []
      }
    }
    // After constructing object, c

    // After constructing object, compute selections using actual channels.
    plan.diagnostics.selectedChannels = CHANNELS.filter((c) => !!plan.channels[c])
    plan.diagnostics.suppressedChannels = CHANNELS.filter((c) => !plan.channels[c]).map((c) => ({ channel: c, reason: 'no_available_request' }))
    if (!animation) plan.diagnostics.channelFailures.push({ channel: 'animation', reason: 'no_candidate' })
    plans[requestId] = plan
    diagnostics.created++
    diagnostics.lastCreatedPlan = requestId
    activePlan = plan
    return deepFreeze(deepCopy(plan))
  }

  function plan_channel(n, c) {
    return c === 'animation' ? n.behavior && n.behavior.behavior && n.behavior.behavior.candidate : c === 'dialogue' ? n.intent && n.intent.activeKind && n.intent.activeKind !== 'idle' : c === 'sound' ? n.intent && (['celebrate','tease_owner','seek_attention'].indexOf(n.intent.activeKind) >= 0) : false
  }

  function getPlan(id) {
    const p = plans[id]
    return p ? deepCopy(p) : null
  }

  function getActivePlan() {
    return activePlan ? deepCopy(activePlan) : null
  }

  function setStatus(id, status, reason) {
    const p = plans[id]
    if (!p) return { ok: false, reason: 'not_found' }
    if (status === 'cancelled') diagnostics.cancelled++
    if (status === 'superseded') diagnostics.superseded++
    if (status === 'expired') diagnostics.expired++
    if (status === 'completed') diagnostics.completed++
    p.status = status
    p.cancelReason = reason || null
    if (activePlan && activePlan.requestId === id && status !== 'active') activePlan = null
    return { ok: true, plan: deepCopy(p) }
  }

  function activatePlan(id) {
    const p = plans[id]
    if (!p) return { ok: false, reason: 'not_found' }
    p.status = 'active'
    activePlan = p
    return { ok: true, plan: deepCopy(p) }
  }

  function cancelPlan(id, reason) { return setStatus(id, 'cancelled', reason || 'cancelled') }
  function supersedePlan(id, reason) { return setStatus(id, 'superseded', reason || 'superseded') }
  function expirePlan(id, reason) { return setStatus(id, 'expired', reason || 'expired') }
  function completePlan(id) { return setStatus(id, 'completed', 'completed') }

  function getDiagnostics() {
    return deepCopy({
      schemaVersion: SCHEMA_VERSION,
      activePlanId: activePlan ? activePlan.requestId : null,
      created: diagnostics.created,
      cancelled: diagnostics.cancelled,
      superseded: diagnostics.superseded,
      expired: diagnostics.expired,
      completed: diagnostics.completed,
      channelFailures: diagnostics.channelFailures.slice(-20)
    })
  }

  const WRITE_BOUNDARY = {
    owner: 'ExpressionEngine',
    allowed: ['read-intent-behavior', 'style-projection', 'channel-request'],
    denied: ['ai', 'dialogue-final-text', 'animation-play', 'sound-play', 'intent', 'behavior', 'persona', 'relationship', 'memory', 'emotion', 'state'],
    note: 'ExpressionEngine creates short-lived ExpressionPlans only; it never executes media or changes other systems.'
  }

  return {
    SCHEMA_VERSION,
    STYLE_HINTS: STYLE_HINTS.slice(),
    CHANNELS: CHANNELS.slice(),
    createPlan,
    getPlan,
    getActivePlan,
    activatePlan,
    cancelPlan,
    supersedePlan,
    expirePlan,
    completePlan,
    getDiagnostics,
    diagnostics: getDiagnostics,
    WRITE_BOUNDARY
  }
})()
