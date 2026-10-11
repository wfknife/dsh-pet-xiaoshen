/* Context Foundation — 3.0-01
 * Read-only aggregated context snapshot.
 * Providers only read owned facts; ContextBuilder only builds snapshots.
 * Consumers cannot mutate the snapshot.
 */
window.ContextFoundation = (function () {
  const SCHEMA_VERSION = 'v0.1'
  const MAX_RECENT_EVENTS = 20

  function deepFreeze(obj) {
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
      Object.freeze(obj)
      for (const key of Object.keys(obj)) deepFreeze(obj[key])
    }
    return obj
  }

  function deepCopy(obj) {
    if (obj === null || typeof obj !== 'object') return obj
    return JSON.parse(JSON.stringify(obj))
  }

  function ContextSnapshot(data) {
    const snap = deepCopy(data)
    snap.schemaVersion = SCHEMA_VERSION
    deepFreeze(snap)
    return snap
  }

  /* ---------- Providers ---------- */

  function localDateParts(date) {
    return {
      iso: date.toISOString(),
      localDate: date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      dayPart: date.getHours() < 5 ? '凌晨' : date.getHours() < 9 ? '清晨' : date.getHours() < 12 ? '上午' : date.getHours() < 14 ? '中午' : date.getHours() < 18 ? '下午' : date.getHours() < 22 ? '晚上' : '深夜'
    }
  }

  function seasonOf(month) {
    if (month === 3 || month === 4 || month === 5) return 'spring'
    if (month === 6 || month === 7 || month === 8) return 'summer'
    if (month === 9 || month === 10 || month === 11) return 'autumn'
    return 'winter'
  }

  function calendarOf(date) {
    const festival = []
    try {
      if (window.HolidayUtil && typeof window.HolidayUtil.getHoliday === 'function') {
        const h = window.HolidayUtil.getHoliday(date.getFullYear(), date.getMonth() + 1, date.getDate())
        if (h) festival.push(typeof h.getName === 'function' ? h.getName() : String(h))
      }
    } catch (err) { /* festival nullable */ }
    return {
      calendarDate: localDateParts(date).localDate,
      season: seasonOf(date.getMonth() + 1),
      festival
    }
  }

  const TimeProvider = {
    name: 'time',
    getSnapshot() {
      const now = new Date()
      return { source: 'system-clock', timestamp: now.getTime(), ...localDateParts(now) }
    }
  }

  const CalendarProvider = {
    name: 'calendar',
    getSnapshot() {
      const now = new Date()
      return { source: 'calendar', timestamp: now.getTime(), ...calendarOf(now) }
    }
  }

  const StateProvider = {
    name: 'state',
    getSnapshot() {
      const api = window.PetStateApi
      const raw = api ? api.raw : null
      if (!raw) return { source: 'unknown', confidence: null, state: null, needs: null }
      const state = raw.stats || null
      return {
        source: api ? 'pet-state-api' : 'unknown',
        confidence: raw.stats ? 1 : null,
        state: state ? { ...state } : null,
        needs: state ? { satiety: state.satiety, thirst: state.thirst, energy: state.energy, mood: state.mood } : null,
        level: typeof raw.level === 'number' ? raw.level : null,
        coins: typeof raw.coins === 'number' ? raw.coins : null
      }
    }
  }

  const OwnerStateProvider = {
    name: 'owner',
    getSnapshot() {
      const raw = window.PetStateApi ? window.PetStateApi.raw : null
      if (!raw) return { source: 'unknown', confidence: null, ownerName: null, ownerBirthday: null }
      return {
        source: 'pet-state',
        confidence: (raw.ownerName || raw.ownerBirthday) ? 1 : 0,
        ownerName: typeof raw.ownerName === 'string' && raw.ownerName ? raw.ownerName : null,
        ownerBirthday: typeof raw.ownerBirthday === 'string' && raw.ownerBirthday ? raw.ownerBirthday : null
      }
    }
  }

  const ActivityProvider = {
    name: 'activity',
    getSnapshot() {
      const activity = window.ActivitySystem ? window.ActivitySystem.get() : null
      return activity ? { source: 'activity-system', confidence: activity.type ? 1 : null, ...activity } : { source: 'unknown', confidence: null, type: null, startedAt: null, endsAt: null, metadata: {} }
    }
  }

  const InteractionProvider = {
    name: 'interaction',
    getSnapshot() {
      const raw = window.PetStateApi ? window.PetStateApi.raw : null
      if (!raw) return { source: 'unknown', confidence: null, lastInteractionAt: null, feedCount: null, totalGames: null }
      return {
        source: 'pet-state',
        confidence: raw.lastInteractionAt ? 1 : 0,
        lastInteractionAt: typeof raw.lastInteractionAt === 'number' ? raw.lastInteractionAt : null,
        feedCount: typeof raw.feedCount === 'number' ? raw.feedCount : null,
        totalGames: typeof raw.totalGames === 'number' ? raw.totalGames : null
      }
    }
  }

  const RelationshipProvider = {
    name: 'relationship',
    getSnapshot() {
      const P = window.PetStateApi ? window.PetStateApi.raw : null
      if (!P) return { source: 'unknown', confidence: null, affection: null, tier: null }
      const rel = window.RelationshipEngine
        ? window.RelationshipEngine.get(P)
        : (window.RelationshipSystem ? window.RelationshipSystem.get(P) : null)
      return rel ? { source: 'relationship-engine', confidence: typeof rel.affection === 'number' ? 1 : null, ...rel } : { source: 'unknown', confidence: null, affection: null, tier: null }
    }
  }

  const EventProvider = {
    name: 'events',
    getSnapshot() {
      const events = window.EventBus && typeof window.EventBus.recent === 'function' ? window.EventBus.recent() : []
      return { source: 'event-bus', confidence: events.length ? 1 : 0, items: events }
    }
  }

  const MemoryRetriever = {
    name: 'memory',
    getSnapshot() {
      const items = window.MemoryRetrieval ? window.MemoryRetrieval.retrieve({}, { limit: 5 }) : []
      return { status: items.length ? 'ready' : 'empty', items }
    }
  }

  const EmotionProvider = {
    name: 'emotion',
    getSnapshot() {
      const snap = window.EmotionEngine ? window.EmotionEngine.getSnapshot() : null
      return snap
        ? { source: 'emotion-engine', confidence: 1, ...snap }
        : { source: 'unknown', confidence: null, values: null, derivedMood: null }
    }
  }

  const DiagnosticsProvider = {
    name: 'diagnostics',
    getSnapshot() {
      return { source: 'runtime-diagnostics', enabled: !!window.RuntimeDiagnostics }
    }
  }

  /* ---------- ContextBuilder ---------- */

  const providers = [
    TimeProvider, CalendarProvider, StateProvider, OwnerStateProvider,
    ActivityProvider, InteractionProvider, RelationshipProvider,
    EventProvider, MemoryRetriever, EmotionProvider, DiagnosticsProvider
  ]

  const builder = {
    providers,
    build() {
      const started = Date.now()
      const diagnostics = {
        build: { started, completed: 0, durationMs: 0 },
        providers: {},
        snapshot: { fieldCount: 0, missingCount: 0 }
      }
      const out = {}
      for (const p of providers) {
        const t0 = Date.now()
        let value = null
        let status = 'ok'
        try {
          value = p.getSnapshot()
        } catch (err) {
          status = 'error'
          value = null
        }
        diagnostics.providers[p.name] = { status, durationMs: Date.now() - t0 }
        switch (p.name) {
          case 'time': out.time = value || { source: 'unknown' }; break
          case 'calendar': out.calendar = value || { source: 'unknown' }; break
          case 'state': out.pet = value || { source: 'unknown' }; break
          case 'owner': out.owner = value || { source: 'unknown' }; break
          case 'activity': out.activity = value || { source: 'unknown' }; break
          case 'interaction': out.interaction = value || { source: 'unknown' }; break
          case 'relationship': out.relationship = value || { source: 'unknown' }; break
          case 'events': out.recentEvents = value && Array.isArray(value.items) ? value.items : []; break
          case 'memory': out.relevantMemories = value && Array.isArray(value.items) ? value.items : []; break
          case 'emotion': out.emotion = value || { source: 'unknown' }; break
      
          case 'diagnostics': out.diagnostics = value || null; break
        }
      }
      const missing = Object.keys(out).filter((k) => out[k] === undefined)
      diagnostics.build.durationMs = Date.now() - started
      diagnostics.build.completed = Date.now()
      diagnostics.snapshot.fieldCount = Object.keys(out).length
      diagnostics.snapshot.missingCount = missing.length
      return ContextSnapshot({
        capturedAt: Date.now(),
        time: out.time,
        calendar: out.calendar,
        pet: out.pet,
        owner: out.owner,
        activity: out.activity,
        interaction: out.interaction,
        relationship: out.relationship,
        recentEvents: out.recentEvents,
        relevantMemories: out.relevantMemories,
        emotion: out.emotion,
        diagnostics
      })
    }
  }


  return { SCHEMA_VERSION, ContextSnapshot, builder, providers }
})()
