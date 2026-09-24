/* PersonaCore — 3.0-02
 * Single authoritative local persona definition.
 * AI/Dialogue/Diary/etc may read PersonaProjection only; no direct write API.
 */
window.PersonaCore = (function () {
  const SCHEMA_VERSION = 2
  // Static expression is authored in prompts/current.json. Do not rehydrate legacy traits.
  const DEFAULT_PERSONA = {
    schemaVersion: SCHEMA_VERSION, sourceRef: 'prompts/current.json',
    identity: { displayName: '小深' }, stableTraits: {}, speechBaseline: {},
    situationalTraits: [], preferences: { learnedPreferences: {} }, quirks: [],
    emotionalTriggers: [], interactionStyle: {}, beliefs: [], selfAwarenessBoundary: {}, expressionProfile: {}
  }
  function deepCopy(v) { return JSON.parse(JSON.stringify(v)) }
  function deepFreeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v) } return v }
  let core = deepCopy(DEFAULT_PERSONA)
  let loaded = false
  let loadError = null

  function mergeSaved(saved) {
    const base = deepCopy(DEFAULT_PERSONA)
    if (!saved || typeof saved !== 'object') return base
    if (saved.identity && typeof saved.identity.displayName === 'string' && saved.identity.displayName.trim()) base.identity.displayName = saved.identity.displayName.trim()
    if (saved.preferences && saved.preferences.learnedPreferences && typeof saved.preferences.learnedPreferences === 'object') base.preferences.learnedPreferences = deepCopy(saved.preferences.learnedPreferences)
    return base
  }
  function currentStateName() {
    try {
      return window.PetStateApi && window.PetStateApi.raw && typeof window.PetStateApi.raw.name === 'string' && window.PetStateApi.raw.name.trim()
        ? window.PetStateApi.raw.name.trim()
        : ''
    } catch (err) { return '' }
  }

  async function init() {
    try {
      const saved = await window.pet.personaLoad()
      core = mergeSaved(saved)
      if (!core.identity.displayName || core.identity.displayName === '小深') {
        const name = currentStateName()
        if (name) core.identity.displayName = name
      }
      loaded = true
    } catch (err) {
      loadError = String((err && err.message) || err)
      core = deepCopy(DEFAULT_PERSONA)
      loaded = false
    }
    return getCore()
  }

  function getCore() {
    return deepCopy(core)
  }

  function isLoaded() { return loaded }

  function getDisplayName() { return core.identity.displayName }

  async function setDisplayName(name) {
    const v = String(name || '').trim()
    if (!v) return false
    core.identity.displayName = v
    try {
      const ok = await window.pet.personaSave(core)
      return !!ok
    } catch (err) { return false }
  }

  function project(scene) {
    const sceneName = scene || 'generic'
    const projection = {
      source: 'persona-core',
      sourceRef: core.sourceRef || null,
      schemaVersion: core.schemaVersion,
      scene: sceneName,
      identity: deepCopy(core.identity),
      stableTraits: deepCopy(core.stableTraits),
      speechBaseline: deepCopy(core.speechBaseline),
      situationalTraits: deepCopy(core.situationalTraits),
      preferences: deepCopy(core.preferences),
      quirks: deepCopy(core.quirks),
      emotionalTriggers: deepCopy(core.emotionalTriggers),
      interactionStyle: deepCopy(core.interactionStyle),
      beliefs: deepCopy(core.beliefs),
      selfAwarenessBoundary: deepCopy(core.selfAwarenessBoundary),
      expressionProfile: deepCopy(core.expressionProfile)
    }
    if (sceneName === 'chat') {
      projection.promptHints = {
        selfReference: core.speechBaseline.selfReference || core.expressionProfile.selfReference || '我',
        addressing: core.speechBaseline.defaultAddressing || null,
        intimateAddressing: core.speechBaseline.intimateAddressing || null,
        baseline: core.speechBaseline,
        situationalTraits: core.situationalTraits.map((s) => s.id),
        selfAwarenessBoundary: core.selfAwarenessBoundary,
        quirks: core.quirks.map((q) => q.id)
      }
    }
    if (sceneName === 'diary') {
      projection.narrative = {
        perspective: core.identity.displayName,
        baseline: core.speechBaseline,
        addressing: core.speechBaseline.defaultAddressing || null,
        intimateAddressing: core.speechBaseline.intimateAddressing || null,
        beliefs: core.beliefs,
        selfAwarenessBoundary: core.selfAwarenessBoundary
      }
    }
    if (sceneName === 'expression') {
      projection.expression = {
        baseline: core.speechBaseline,
        stableTraits: core.stableTraits,
        situationalTraits: core.situationalTraits,
        emotionalTriggers: core.emotionalTriggers
      }
    }
    return deepFreeze(projection)
  }

  function learnedPreferences() {
    return deepFreeze(deepCopy(core.preferences.learnedPreferences || {}))
  }

  function getDiagnostics() {
    return {
      loaded,
      loadError,
      displayName: core.identity.displayName,
      schemaVersion: core.schemaVersion,
      traits: Object.keys(core.stableTraits),
      quirks: core.quirks.map((q) => q.id),
      learnedPreferencesCount: Object.keys(core.preferences.learnedPreferences || {}).length
    }
  }

  // Explicit write-boundary documentation: only user settings / controlled growth may write.
  const WRITE_BOUNDARY = {
    allowed: ['user_settings', 'controlled_growth_future'],
    denied: ['ai', 'dialogue', 'chat', 'diary', 'expression', 'intent', 'emotion', 'relationship', 'behavior']
  }

  return {
    SCHEMA_VERSION,
    init,
    getCore,
    isLoaded,
    getDisplayName,
    setDisplayName,
    project,
    learnedPreferences,
    getDiagnostics,
    WRITE_BOUNDARY,
    DEFAULT_PERSONA: deepFreeze(deepCopy(DEFAULT_PERSONA))
  }
})()

window.PersonaCore.init()




