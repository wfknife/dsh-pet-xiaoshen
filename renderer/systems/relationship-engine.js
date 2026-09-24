/* RelationshipEngine — 3.0-03
 * Single authoritative local relationship state engine.
 *
 * Ownership:
 *   - RelationshipEngine is the only writer for relationship dimensions.
 *   - Other systems read via deep-frozen snapshots only.
 *   - AI / Dialogue / Diary / Emotion / Intent / Expression / Memory must
 *     not write relationship state directly.
 *
 * Scope:
 *   - Three dimensions: affection (2.0 legacy), familiarity, trust.
 *   - Event-driven, idempotent, rate-limited, auditable local changes.
 *   - No automatic time-based punishment/decay in this phase.
 */
window.RelationshipEngine = (function () {
  const SCHEMA_VERSION = 1
  const MAX_CHANGES = 50
  const MAX_APPLIED_EVENTS = 300
  const MAX_DAILY_DAYS = 7

  const TIERS = [
    { min: 0, label: '初识' },
    { min: 25, label: '熟悉' },
    { min: 50, label: '亲近' },
    { min: 75, label: '信赖' },
    { min: 100, label: '羁绊' }
  ]

  /* Local first-version rules. These are deliberately small and readable.
   * They prevent low-value repeated interactions from mechanically maxing
   * relationship values while leaving high-value unique events usable.
   */
  const RULES = {
    interaction: { label: '主动互动', dailyCap: 30, cooldownMs: 30 * 1000 },
    play: { label: '游戏互动', dailyCap: 20, cooldownMs: 10 * 1000 },
    feed: { label: '喂食', dailyCap: 15, cooldownMs: 10 * 1000 },
    gift: { label: '礼物', dailyCap: 10, cooldownMs: 0 },
    work: { label: '工作陪伴', dailyCap: 20, cooldownMs: 20 * 1000 },
    daily_company: { label: '长期陪伴', dailyCap: 1, cooldownMs: 0 },
    milestone: { label: '特殊共同经历', dailyCap: 10, cooldownMs: 0 },
    promise_kept: { label: '兑现约定', dailyCap: 10, cooldownMs: 0 },
    negative: { label: '负面关系事件', dailyCap: 20, cooldownMs: 0 },
    legacy_affection: { label: '2.0兼容好感度', dailyCap: 200, cooldownMs: 0 },
    custom: { label: '自定义关系事件', dailyCap: 100, cooldownMs: 0 }
  }

  const DENIED_SOURCES = new Set([
    'ai', 'dialogue', 'chat', 'diary', 'emotion', 'intent',
    'expression', 'memory', 'behavior', 'perception', 'vision'
  ])

  /* ---------- helpers ---------- */

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

  /* P0 修复：日期键统一补零（YYYY-MM-DD），保证字符串序 == 时间序。
     旧数据里可能存在未补零的键（如 "2026-9-3"），由 parseDayKey 兼容解析。 */
  function localDateKey(ts) {
    const d = new Date(ts || Date.now())
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n
  }

  /* 兼容解析 daily 键：同时接受 "2026-9-3" 与 " "。
     返回可直接数值比较的 yyyymmdd；非法键返回 null（裁剪时优先淘汰）。 */
  function parseDayKey(key) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(key == null ? '' : key))
    if (!m) return null
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
    return y * 10000 + mo * 100 + d
  }

  function compareDayKeys(a, b) {
    const va = parseDayKey(a)
    const vb = parseDayKey(b)
    if (va === null && vb === null) return 0
    if (va === null) return -1
    if (vb === null) return 1
    return va - vb
  }

  /* 规范键-> 旧键（2026-9-3），仅用于读取/迁移历史数据 */
  function legacyDateKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key == null ? '' : key))
    if (!m) return null
    return Number(m[1]) + '-' + Number(m[2]) + '-' + Number(m[3])
  }

  function getP(P) {
    if (P && typeof P === 'object' && !Array.isArray(P) &&
        ('relationship' in P || 'affection' in P || 'stats' in P || 'name' in P)) return P
    return window.PetStateApi && window.PetStateApi.raw ? window.PetStateApi.raw : null
  }

  function defaultState(affection) {
    return {
      schemaVersion: SCHEMA_VERSION,
      affection: clamp(affection, 0, 100),
      familiarity: 0,
      trust: 0,
      lastPositiveInteractionAt: null,
      lastRelationshipEventAt: null,
      version: 1,
      appliedEvents: [],
      daily: {},
      lastEventAt: {},
      changes: [],
      stats: {
        applied: 0,
        idempotentRejected: 0,
        rateLimited: 0,
        deniedSource: 0,
        invalid: 0,
        lastEventId: null,
        lastRuleId: null,
        lastSource: null,
        lastTs: null
      }
    }
  }

  function ensureState(P) {
    const raw = getP(P)
    if (!raw) return null
    if (!raw.relationship || typeof raw.relationship !== 'object' || Array.isArray(raw.relationship)) {
      raw.relationship = defaultState(typeof raw.affection === 'number' ? raw.affection : 0)
    } else {
      const s = raw.relationship
      if (typeof s.schemaVersion !== 'number') s.schemaVersion = SCHEMA_VERSION
      if (typeof s.affection !== 'number') s.affection = clamp(typeof raw.affection === 'number' ? raw.affection : 0, 0, 100)
      if (typeof s.familiarity !== 'number') s.familiarity = 0
      if (typeof s.trust !== 'number') s.trust = 0
      if (typeof s.lastPositiveInteractionAt !== 'number') s.lastPositiveInteractionAt = s.lastPositiveInteractionAt || null
      if (typeof s.lastRelationshipEventAt !== 'number') s.lastRelationshipEventAt = s.lastRelationshipEventAt || null
      if (typeof s.version !== 'number' || s.version < 1) s.version = 1
      if (!Array.isArray(s.appliedEvents)) s.appliedEvents = []
      if (!s.daily || typeof s.daily !== 'object' || Array.isArray(s.daily)) s.daily = {}
      if (!s.lastEventAt || typeof s.lastEventAt !== 'object' || Array.isArray(s.lastEventAt)) s.lastEventAt = {}
      if (!Array.isArray(s.changes)) s.changes = []
      if (!s.stats || typeof s.stats !== 'object' || Array.isArray(s.stats)) s.stats = defaultState(0).stats
      s.affection = clamp(s.affection, 0, 100)
      s.familiarity = clamp(s.familiarity, 0, 100)
      s.trust = clamp(s.trust, 0, 100)
      pruneDaily(s)
    }
    raw.affection = raw.relationship.affection
    return raw.relationship
  }

  function pruneDaily(s) {
    if (!s.daily || typeof s.daily !== 'object') return
    // P0 修复：必须按“日历值”排序，不能按字典序。未补零的键（2026-9-10）在字典序里
    // 会排在 2026-9-3 之前，导致当天 bucket 被当成最旧项裁掉。
    const keys = Object.keys(s.daily).sort(compareDayKeys)
    while (keys.length > MAX_DAILY_DAYS) {
      delete s.daily[keys.shift()]
    }
  }

  /* ---------- derived views ---------- */

  function deriveTier(affection) {
    const a = clamp(affection, 0, 100)
    let idx = 0
    for (let i = 0; i < TIERS.length; i++) {
      if (a >= TIERS[i].min) idx = i
    }
    return idx
  }

  function deriveLabel(affection) {
    return TIERS[deriveTier(affection)].label
  }

  function getSnapshot(P) {
    const s = ensureState(P)
    if (!s) return deepFreeze({ source: 'unknown', confidence: null })
    const snap = {
      source: 'relationship-engine',
      schemaVersion: SCHEMA_VERSION,
      affection: s.affection,
      familiarity: s.familiarity,
      trust: s.trust,
      tier: deriveTier(s.affection),
      relationshipLabel: deriveLabel(s.affection),
      lastPositiveInteractionAt: s.lastPositiveInteractionAt,
      lastRelationshipEventAt: s.lastRelationshipEventAt,
      version: s.version
    }
    return deepFreeze(snap)
  }

  /* Compatibility: keep the old RelationshipSystem.get() shape while adding
   * the new dimensions for Context / UI consumers.
   */
  function get(P) {
    const s = ensureState(P)
    if (!s) return { affection: 0, tier: 0 }
    return {
      affection: s.affection,
      familiarity: s.familiarity,
      trust: s.trust,
      tier: deriveTier(s.affection),
      relationshipLabel: deriveLabel(s.affection),
      lastPositiveInteractionAt: s.lastPositiveInteractionAt,
      lastRelationshipEventAt: s.lastRelationshipEventAt
    }
  }

  /* ---------- event / rate / idempotency ---------- */

  function isSourceAllowed(source) {
    const v = String(source || 'system').toLowerCase()
    return !DENIED_SOURCES.has(v)
  }

  function normalizeDelta(delta) {
    if (!delta || typeof delta !== 'object') return null
    const affection = Number(delta.affection)
    const familiarity = Number(delta.familiarity)
    const trust = Number(delta.trust)
    const out = {}
    if (Number.isFinite(affection) && affection !== 0) out.affection = clamp(affection, -100, 100)
    if (Number.isFinite(familiarity) && familiarity !== 0) out.familiarity = clamp(familiarity, -100, 100)
    if (Number.isFinite(trust) && trust !== 0) out.trust = clamp(trust, -100, 100)
    if (Object.keys(out).length === 0) return null
    return out
  }

  function getRule(kind) {
    return RULES[kind] || RULES.custom
  }

  function newDayBucket() {
    return { events: {}, deltas: { affection: 0, familiarity: 0, trust: 0 } }
  }

  /* 兜底：保证 bucket 存在且形状合法。任何异常数据都不会让读取方 TypeError。 */
  function ensureDayBucket(s, key) {
    let day = s.daily[key]
    if (!day || typeof day !== 'object' || Array.isArray(day)) {
      day = newDayBucket()
      s.daily[key] = day
    }
    if (!day.events || typeof day.events !== 'object' || Array.isArray(day.events)) day.events = {}
    if (!day.deltas || typeof day.deltas !== 'object' || Array.isArray(day.deltas)) day.deltas = { affection: 0, familiarity: 0, trust: 0 }
    return day
  }

  /* 同一天若只有旧格式键（2026-9-10），就地迁移到规范键：不新增、不丢失任何计数。
     若两种键同时存在（例如同一天先跑旧版、后跑新版），按计数合并而不是丢弃。 */
  function mergeDayBucket(into, from) {
    const fe = (from && from.events) || {}
    for (const k of Object.keys(fe)) into.events[k] = (Number(into.events[k]) || 0) + (Number(fe[k]) || 0)
    const fd = (from && from.deltas) || {}
    into.deltas.affection = (Number(into.deltas.affection) || 0) + (Number(fd.affection) || 0)
    into.deltas.familiarity = (Number(into.deltas.familiarity) || 0) + (Number(fd.familiarity) || 0)
    into.deltas.trust = (Number(into.deltas.trust) || 0) + (Number(fd.trust) || 0)
  }

  function migrateLegacyDayKey(s, key) {
    const legacy = legacyDateKey(key)
    if (!legacy || legacy === key) return
    const old = s.daily[legacy]
    if (old === undefined) return
    if (s.daily[key] === undefined) {
      s.daily[key] = old
    } else {
      mergeDayBucket(ensureDayBucket(s, key), old)
    }
    delete s.daily[legacy]
  }

  /* 只读解析“某天”的 bucket（兼容旧键），供诊断/快照使用，不产生副作用。 */
  function readDayBucket(s, key) {
    if (s.daily[key] !== undefined) return s.daily[key]
    const legacy = legacyDateKey(key)
    return legacy && s.daily[legacy] !== undefined ? s.daily[legacy] : undefined
  }

  function getDay(s, ts) {
    const key = localDateKey(ts)
    // 总是尝试迁移/合并当天的旧格式键（无旧键时是 no-op）；
    // 这样"同一天两种键并存"也不会分裂计数或丢数据。
    migrateLegacyDayKey(s, key)
    if (!s.daily[key]) {
      ensureDayBucket(s, key)
      pruneDaily(s)
    }
    return { key, day: ensureDayBucket(s, key) }
  }

  function dailyEventCount(s, kind, ts) {
    const { day } = getDay(s, ts)
    // 兜底：即使当天 bucket 因任何异常缺失或形状损坏，也只按 0 计数，绝不 TypeError。
    if (!day || !day.events) return 0
    return day.events[kind] || 0
  }

  function checkRateLimit(s, event, ts) {
    const kind = event.kind || 'custom'
    const rule = getRule(kind)
    const count = dailyEventCount(s, kind, ts)
    if (rule.dailyCap && count >= rule.dailyCap) {
      return { ok: false, reason: 'daily_cap', cap: rule.dailyCap, kind }
    }
    if (rule.cooldownMs) {
      const last = s.lastEventAt[kind] || 0
      if (ts - last < rule.cooldownMs) {
        return { ok: false, reason: 'cooldown', remainingMs: rule.cooldownMs - (ts - last), kind }
      }
    }
    return { ok: true }
  }

  function markApplied(s, eventId, ts) {
    if (!eventId) return
    if (s.appliedEvents.indexOf(eventId) < 0) {
      s.appliedEvents.push(eventId)
      if (s.appliedEvents.length > MAX_APPLIED_EVENTS) {
        s.appliedEvents.splice(0, s.appliedEvents.length - MAX_APPLIED_EVENTS)
      }
    }
  }

  function isApplied(s, eventId) {
    return !!eventId && s.appliedEvents.indexOf(eventId) >= 0
  }

  function recordChange(s, change) {
    if (!change) return
    s.changes.unshift(change)
    if (s.changes.length > MAX_CHANGES) s.changes.length = MAX_CHANGES
  }

  function applyDeltaToState(s, delta) {
    if (delta.affection) s.affection = clamp(s.affection + delta.affection, 0, 100)
    if (delta.familiarity) s.familiarity = clamp(s.familiarity + delta.familiarity, 0, 100)
    if (delta.trust) s.trust = clamp(s.trust + delta.trust, 0, 100)
  }

  function recordDaily(s, kind, delta, ts) {
    const { day } = getDay(s, ts)
    day.events[kind] = (day.events[kind] || 0) + 1
    if (delta.affection) day.deltas.affection += delta.affection
    if (delta.familiarity) day.deltas.familiarity += delta.familiarity
    if (delta.trust) day.deltas.trust += delta.trust
  }

  function notifyExternal(event, result) {
    try {
      if (window.EventBus && typeof window.EventBus.emit === 'function') {
        window.EventBus.emit('relationship:event', {
          eventId: event.eventId || null,
          kind: event.kind || 'custom',
          ruleId: event.ruleId || ('REL-' + String(event.kind || 'custom').toUpperCase()),
          source: event.source || 'system',
          applied: result.applied,
          reason: result.reason || null,
          delta: result.delta || null,
          ts: event.ts || Date.now()
        })
        if (result.applied) {
          window.EventBus.emit('relationship:change', result.snapshot || getSnapshot(getP(event._p)))
        }
      }
    } catch (err) {
      // EventBus must never break relationship persistence.
    }
  }

  /* ---------- public write entry ---------- */

  function applyEvent(P, rawEvent) {
    const s = ensureState(P)
    if (!s) return { applied: false, reason: 'no_state' }
    const event = rawEvent && typeof rawEvent === 'object' ? { ...rawEvent } : {}
    const ts = Number(event.ts) || Date.now()
    const kind = String(event.kind || 'custom')
    const eventId = String(event.eventId || '').trim() || (kind + ':' + ts + ':' + Math.random().toString(36).slice(2, 8))
    const source = String(event.source || 'system')
    const ruleId = String(event.ruleId || ('REL-' + kind.toUpperCase())).trim()
    const delta = normalizeDelta(event.delta || { affection: event.affection, familiarity: event.familiarity, trust: event.trust })

    if (!delta) {
      s.stats.invalid++
      return { applied: false, reason: 'empty_delta' }
    }
    if (!isSourceAllowed(source)) {
      s.stats.deniedSource++
      return { applied: false, reason: 'denied_source', source }
    }
    if (isApplied(s, eventId)) {
      s.stats.idempotentRejected++
      return { applied: false, reason: 'duplicate', eventId }
    }

    const rate = checkRateLimit(s, event, ts)
    if (!rate.ok) {
      s.stats.rateLimited++
      return { applied: false, reason: rate.reason, cap: rate.cap, kind }
    }

    const before = {
      affection: s.affection,
      familiarity: s.familiarity,
      trust: s.trust,
      tier: deriveTier(s.affection),
      label: deriveLabel(s.affection)
    }
    applyDeltaToState(s, delta)
    const after = {
      affection: s.affection,
      familiarity: s.familiarity,
      trust: s.trust,
      tier: deriveTier(s.affection),
      label: deriveLabel(s.affection)
    }

    const positive = (delta.affection || 0) > 0 || (delta.familiarity || 0) > 0 || (delta.trust || 0) > 0
    if (positive) s.lastPositiveInteractionAt = ts
    s.lastRelationshipEventAt = ts
    s.version++
    s.stats.applied++
    s.stats.lastEventId = eventId
    s.stats.lastRuleId = ruleId
    s.stats.lastSource = source
    s.stats.lastTs = ts

    markApplied(s, eventId, ts)
    recordDaily(s, kind, delta, ts)
    s.lastEventAt[kind] = ts

    const change = {
      eventId,
      kind,
      ruleId,
      source,
      ts,
      delta: { ...delta },
      before: { ...before },
      after: { ...after }
    }
    recordChange(s, change)

    // Legacy mirror for 2.0 UI / unlock / photo thresholds.
    const raw = getP(P)
    if (raw) raw.affection = s.affection

    const snapshot = getSnapshot(P)
    const result = { applied: true, reason: 'ok', eventId, kind, ruleId, source, delta: { ...delta }, change, snapshot }
    notifyExternal({ ...event, _p: P }, result)
    return result
  }

  /* Direct delta command used by controlled local systems. This is still a
   * RelationshipEngine-only write; callers do not mutate P.relationship.
   */
  function add(P, delta, options) {
    const opts = options || {}
    const kind = opts.kind || 'custom'
    const eventId = opts.eventId || (kind + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8))
    return applyEvent(P, {
      eventId,
      kind,
      delta,
      source: opts.source || 'system',
      ruleId: opts.ruleId || ('REL-' + kind.toUpperCase()),
      ts: opts.ts || Date.now()
    })
  }

  /* Legacy compatibility: old addAffection(n) still works, but all affection
   * writes now flow through RelationshipEngine and update the mirror.
   */
  function addAffection(P, amount, options) {
    const opts = options || {}
    const raw = getP(P)
    const s = ensureState(P)
    if (!s || !raw) return raw ? (raw.affection || 0) : 0
    // Legacy direct writes to P.affection (tests/older code) are still honoured
    // by using P.affection as the base for the compatibility path.
    s.affection = clamp(typeof raw.affection === 'number' ? raw.affection : s.affection, 0, 100)
    const n = Number(amount) || 0
    if (n === 0) return s.affection
    const id = opts.eventId || ('legacy-affection:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8))
    const result = applyEvent(P, {
      eventId: id,
      kind: opts.kind || 'legacy_affection',
      delta: { affection: n },
      source: opts.source || 'legacy',
      ruleId: opts.ruleId || 'REL-LEGACY-AFFECTION',
      ts: opts.ts || Date.now()
    })
    if (raw) raw.affection = s.affection
    return raw ? raw.affection : (result.applied ? s.affection : s.affection)
  }

  function init(P, savedRelationship) {
    const raw = getP(P)
    if (raw && savedRelationship && typeof savedRelationship === 'object' && !Array.isArray(savedRelationship)) {
      // Hydration is still an engine-owned write: callers only provide the
      // persisted object; they never assign P.relationship themselves.
      raw.relationship = deepCopy(savedRelationship)
    }
    const s = ensureState(P)
    return s ? getSnapshot(P) : null
  }

  function getDiagnostics(P) {
    const s = ensureState(P)
    if (!s) return null
    const now = Date.now()
    const today = localDateKey(now)
    // P0 修复：只读兼容旧格式键（当天尚未触发迁移时也能读到真实数据）
    const rawToday = readDayBucket(s, today)
    const day = (rawToday && typeof rawToday === 'object' && !Array.isArray(rawToday) && rawToday.events && rawToday.deltas)
      ? rawToday
      : { events: {}, deltas: { affection: 0, familiarity: 0, trust: 0 } }
    const lastChange = s.changes[0] || null
    const recentDelta = { affection: 0, familiarity: 0, trust: 0 }
    for (const c of s.changes.slice(0, 10)) {
      if (!c.delta) continue
      if (c.delta.affection) recentDelta.affection += c.delta.affection
      if (c.delta.familiarity) recentDelta.familiarity += c.delta.familiarity
      if (c.delta.trust) recentDelta.trust += c.delta.trust
    }
    const weekDelta = { affection: 0, familiarity: 0, trust: 0 }
    for (const d of Object.values(s.daily || {})) {
      if (!d || !d.deltas) continue
      weekDelta.affection += d.deltas.affection || 0
      weekDelta.familiarity += d.deltas.familiarity || 0
      weekDelta.trust += d.deltas.trust || 0
    }
    return deepCopy({
      schemaVersion: s.schemaVersion,
      state: {
        affection: s.affection,
        familiarity: s.familiarity,
        trust: s.trust,
        tier: deriveTier(s.affection),
        relationshipLabel: deriveLabel(s.affection)
      },
      lastEvent: s.stats.lastEventId ? {
        eventId: s.stats.lastEventId,
        ruleId: s.stats.lastRuleId,
        source: s.stats.lastSource,
        ts: s.stats.lastTs,
        delta: lastChange ? lastChange.delta : null
      } : null,
      recentChanges: s.changes.slice(0, 10),
      today: {
        date: today,
        events: { ...day.events },
        deltas: { ...day.deltas }
      },
      recentDeltaSummary: { ...recentDelta },
      week: {
        days: Object.keys(s.daily || {}).length,
        deltas: { ...weekDelta }
      },
      counters: {
        applied: s.stats.applied,
        idempotentRejected: s.stats.idempotentRejected,
        rateLimited: s.stats.rateLimited,
        deniedSource: s.stats.deniedSource,
        invalid: s.stats.invalid
      },
      appliedEventCount: s.appliedEvents.length,
      changesCount: s.changes.length
    })
  }

  function getRecentChanges(P, limit) {
    const s = ensureState(P)
    if (!s) return []
    const n = Math.max(1, Math.min(Number(limit) || 10, MAX_CHANGES))
    return deepCopy(s.changes.slice(0, n))
  }

  const WRITE_BOUNDARY = {
    owner: 'RelationshipEngine',
    allowedWriters: ['relationship-events', 'legacy-affection-compat', 'controlled-local-systems'],
    deniedWriters: ['ai', 'dialogue', 'chat', 'diary', 'emotion', 'intent', 'expression', 'memory', 'behavior'],
    note: 'Reading via getSnapshot/getDiagnostics only. No direct setter for P.relationship.'
  }

  return {
    SCHEMA_VERSION,
    TIERS: TIERS.map((t) => ({ ...t })),
    DEFAULT_STATE: (affection) => defaultState(affection),
    init,
    hydrate: init,
    ensure: init,
    get,
    getSnapshot,
    read: getSnapshot,
    snapshot: getSnapshot,
    add,
    applyEvent,
    applyRelationshipEvent: applyEvent,
    recordEvent: applyEvent,
    addAffection,
    addLegacyAffection: addAffection,
    applyLegacyAffection: addAffection,
    legacyAdd: addAffection,
    deriveTier,
    deriveLabel,
    getDiagnostics,
    diagnostics: getDiagnostics,
    getRecentChanges,
    recentChanges: getRecentChanges,
    WRITE_BOUNDARY,
    isWriteSourceAllowed: isSourceAllowed
  }
})()
