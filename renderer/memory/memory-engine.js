/* MemoryEngine — 3.0-04
 * Single local coordinator for Memory domain writes.
 *
 * Ownership:
 *   - MemoryEngine decides what becomes a formal Memory.
 *   - MemoryStore only persists; Retrieval only reads.
 *   - AI / Dialogue / Diary must not write directly to MemoryStore.
 *
 * Pipeline:
 *   reliable Event / explicit user input -> Candidate -> Consolidation -> Store
 */
window.MemoryEngine = (function () {
  if (window.pet?.character?.authority) {
    const api = window.pet.character
    let data = { schemaVersion: 2, memories: [] }
    const init = async () => { const result = await api.read({ kind: 'memory' }); if (result?.ok) data = result; return data }
    const rejected = () => ({ ok: false, reason: 'kernel_authority' })
    const forget = async id => {
      const row = data.memories.find(item => item.id === id)
      if (!row) return { ok: false, reason: 'memory_missing' }
      const result = await api.submit({ kind: 'owner.forget', payload: { sourceIds: row.sourceRefs || [] } })
      await init(); return result
    }
    api.onEvent(event => { if (['ready', 'delta'].includes(event?.kind)) void init() })
    const adapter = { init, ensure: init, getMemories: () => structuredClone(data.memories), list: () => structuredClone(data.memories),
      getById: id => structuredClone(data.memories.find(item => item.id === id)), getStoreData: () => structuredClone(data), getData: () => structuredClone(data),
      suppress: forget, forgetByQuery: async query => { const rows = data.memories.filter(item => item.content.includes(String(query))); return Promise.all(rows.map(row => forget(row.id))) },
      flushAndWait: async () => ({ ok: true }), flushPersistence: async () => ({ ok: true }),
      getDiagnostics: () => ({ owner: 'Kernel', readOnly: true }), getWriteQueue: () => ({ dirty: false }),
      effectiveStrength: item => Number(item?.strength) || 0.7, isWriteSourceAllowed: () => false }
    for (const name of ['addCandidate','admitCandidate','addEvent','createCandidate','remember','processUserMessage','restoreByQuery','consolidate','migrateLegacy','migrate','rollbackLegacyMigration','rollback','recordRecall','recordMention','recalculateStatus','runDecayMaintenance','invalidateSources','archive','restore','archiveByDate']) adapter[name] = rejected
    return Object.freeze(adapter)
  }
  const SCHEMA_VERSION = 2
  const MAX_STRENGTH = 0.95
  const ACTIVE_THRESHOLD = 0.45
  const FADING_THRESHOLD = 0.15
  const HALF_LIFE_DAYS = {
    episode: 21,
    preference: 180,
    fact: 180,
    relationship: 365,
    milestone: 365,
    interest: 90,
    habit: 90,
    goal: 60,
    promise: 180,
    dislike: 180
  }
  const MENTION_REINFORCEMENT = [0.10, 0.06, 0.03, 0.01]
  let lastDecayMaintenanceAt = 0
  const PREFERENCE_EVIDENCE_THRESHOLD = 3
  const VALID_TYPES = ['fact', 'episode', 'preference', 'milestone', 'relationship', 'diary-reference']
  const IMPORTANCE_RULES = {
    firstEvent: 0.30,
    milestone: 0.35,
    explicitRemember: 0.80,
    relationship: 0.20,
    novelty: 0.10
  }

  const DENIED_SOURCES = new Set([
    'ai', 'dialogue', 'chat', 'diary', 'emotion', 'intent', 'expression',
    'relationship', 'behavior', 'perception', 'vision'
  ])

  let data = null
  let initialized = false
  let initError = null
  let eventSubscribed = false

  let memoryCreationSeq = 0
  const RECALL_DEBOUNCE_MS = 10000
  const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000]
  let memoryRevision = 0
  let persistedRevision = 0
  let dirty = false
  let persistInFlight = false
  let persistTimer = null
  let retryTimer = null
  let persistAttempts = 0
  const recallDebounceTimers = new Map()

  /* ---------- helpers ---------- */

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v)
  }

  function deepCopy(obj) {
    if (obj === null || typeof obj !== 'object') return obj
    try { return JSON.parse(JSON.stringify(obj)) } catch (err) { return { ...obj } }
  }

  function clamp(v, min, max) {
    const n = Number(v)
    if (!Number.isFinite(n)) return min || 0
    return Math.min(max, Math.max(min, n))
  }

  function localDate(ts) {
    const d = new Date(typeof ts === 'number' ? ts : Date.now())
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function hashString(str) {
    let h = 2166136261
    const s = String(str || '')
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0).toString(36)
  }

  function normalizedContent(content) {
    let s = String(content || '').trim()
    s = s.replace(/^(?:长期记忆|记忆|备忘|日记|记录)[：:\s]*/, '')
    s = s.replace(/\[[^\]]*\]/g, ' ')
    s = s.replace(/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?\s*/, '')
    s = s.replace(/\s+/g, ' ').trim()
    return s
  }

  function normalizedKeyFor(content) {
    return 'k:' + hashString(normalizedContent(content))
  }

  function stableId(seed) {
    return 'mem-' + hashString(seed)
  }

  function unique(arr) {
    const seen = new Set()
    const out = []
    for (const x of arr) {
      if (typeof x !== 'string' || !x) continue
      if (seen.has(x)) continue
      seen.add(x)
      out.push(x)
    }
    return out
  }

  function ensureData() {
    if (!data) {
      data = window.MemoryStore ? window.MemoryStore.getData() : null
      if (!data) {
        const base = window.MemoryStore && window.MemoryStore.defaultData ? window.MemoryStore.defaultData() : {}
        data = base
      }
    }
    return data
  }

  function schedulePersist(delayMs) {
    if (persistTimer) return
    const delay = Math.max(0, Number(delayMs) || 0)
    persistTimer = setTimeout(() => {
      persistTimer = null
      flushPersist()
    }, delay)
  }

  function scheduleRetry() {
    if (retryTimer || persistAttempts > RETRY_DELAYS.length) return
    const delay = RETRY_DELAYS[Math.min(persistAttempts - 1, RETRY_DELAYS.length - 1)]
    retryTimer = setTimeout(() => {
      retryTimer = null
      flushPersist()
    }, delay)
  }

  function scheduleDebouncedPersist(key) {
    if (recallDebounceTimers.has(key)) return
    const timer = setTimeout(() => {
      recallDebounceTimers.delete(key)
      schedulePersist(0)
    }, RECALL_DEBOUNCE_MS)
    recallDebounceTimers.set(key, timer)
  }

  async function flushPersist() {
    if (persistInFlight) return { ok: false, reason: 'in_flight' }
    for (const t of recallDebounceTimers.values()) clearTimeout(t)
    recallDebounceTimers.clear()
    if (!dirty) return { ok: true, skipped: true }
    persistInFlight = true
    const revision = memoryRevision
    try {
      let ok = true
      if (window.MemoryStore) {
        window.MemoryStore.replace(data)
        ok = await window.MemoryStore.persist()
      }
      if (ok) {
        persistedRevision = Math.max(persistedRevision, revision)
        persistAttempts = 0
        dirty = memoryRevision > persistedRevision
        if (dirty) schedulePersist(0)
        return { ok: true, persistedRevision, memoryRevision }
      }
      dirty = true
      persistAttempts += 1
      scheduleRetry()
      return { ok: false, reason: 'persist_failed', attempt: persistAttempts }
    } catch (err) {
      dirty = true
      persistAttempts += 1
      scheduleRetry()
      return { ok: false, reason: 'persist_error', error: String((err && err.message) || err), attempt: persistAttempts }
    } finally {
      persistInFlight = false
    }
  }

  async function flushAndWait(timeoutMs) {
    const timeout = Math.max(200, Number(timeoutMs) || 2000)
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (!dirty && !persistInFlight && persistedRevision >= memoryRevision) {
        return { ok: true, persistedRevision, memoryRevision, dirty: false }
      }
      if (persistInFlight) {
        await new Promise((r) => setTimeout(r, 20))
        continue
      }
      const r = await flushPersist()
      if (r.ok && !dirty && persistedRevision >= memoryRevision) {
        return { ok: true, persistedRevision, memoryRevision, dirty: false }
      }
      if (!r.ok) {
        await new Promise((r2) => setTimeout(r2, 50))
      } else {
        await new Promise((r2) => setTimeout(r2, 10))
      }
    }
    return { ok: false, reason: 'flush_timeout', persistedRevision, memoryRevision, dirty, persistInFlight }
  }

  function commit(opts) {
    const o = opts || {}
    ensureData()
    memoryRevision++
    dirty = true
    if (window.MemoryStore) window.MemoryStore.replace(data)
    if (o.debounceKey) scheduleDebouncedPersist(o.debounceKey)
    else schedulePersist(o.delay || 0)
    return true
  }

  function markMutation(kind) {
    if (!data.diagnostics) data.diagnostics = { created: 0, ignored: 0, deduped: 0, merged: 0, migrated: 0, invalid: 0, recall: 0, archived: 0, lastMutation: null, lastMigrationVersion: 0, loadError: null }
    data.diagnostics.lastMutation = { kind, ts: Date.now() }
  }

  function bumpCounter(key, n) {
    ensureData()
    if (!data.diagnostics) data.diagnostics = { created: 0, ignored: 0, deduped: 0, merged: 0, migrated: 0, invalid: 0, recall: 0, archived: 0, lastMutation: null, lastMigrationVersion: 0, loadError: null }
    data.diagnostics[key] = (data.diagnostics[key] || 0) + (n || 1)
  }

  function isApplied(eventId) {
    if (!eventId) return false
    ensureData()
    return Array.isArray(data.appliedEventIds) && data.appliedEventIds.indexOf(eventId) >= 0
  }

  function markApplied(eventId) {
    if (!eventId) return
    ensureData()
    if (!Array.isArray(data.appliedEventIds)) data.appliedEventIds = []
    if (data.appliedEventIds.indexOf(eventId) < 0) {
      data.appliedEventIds.push(eventId)
      if (data.appliedEventIds.length > 1000) data.appliedEventIds.splice(0, data.appliedEventIds.length - 1000)
    }
  }

  function findMemoryByKey(key) {
    ensureData()
    return data.memories.find((m) => m.normalizedKey === key) || null
  }

  function findMemoryById(id) {
    ensureData()
    return data.memories.find((m) => m.id === id) || null
  }

  function getEvidence(key) {
    ensureData()
    if (!data.evidence) data.evidence = {}
    return data.evidence[key] || null
  }

  function bumpEvidence(c) {
    ensureData()
    if (!data.evidence) data.evidence = {}
    const key = c.normalizedKey
    const ev = data.evidence[key] || {
      count: 0,
      sourceEventIds: [],
      sourceTypes: [],
      firstSeenAt: c.ts,
      lastSeenAt: c.ts
    }
    ev.count = (ev.count || 0) + 1
    ev.sourceEventIds = unique([...(ev.sourceEventIds || []), ...c.sourceEventIds])
    ev.sourceTypes = unique([...(ev.sourceTypes || []), c.sourceType])
    ev.lastSeenAt = c.ts
    data.evidence[key] = ev
    return ev
  }

  function halfLifeFor(m) {
    return HALF_LIFE_DAYS[String(m && m.type || '')] || HALF_LIFE_DAYS.episode
  }

  function referenceTimeFor(m) {
    return m.lastMentionedAt || m.updatedAt || m.createdAt || Date.now()
  }

  function effectiveStrength(m, now) {
    const ts = Number(now) || Date.now()
    const ref = Number(referenceTimeFor(m)) || ts
    const ageDays = Math.max(0, (ts - ref) / 86400000)
    const decay = Math.exp(-ageDays / halfLifeFor(m))
    return clamp((Number(m.strength) || 0) * decay, 0, MAX_STRENGTH)
  }

  function recalculateStatus(m, now) {
    if (m.status === 'suppressed' || m.status === 'archived') return m.status
    const eff = effectiveStrength(m, now)
    if (eff >= ACTIVE_THRESHOLD) return 'active'
    if (eff >= FADING_THRESHOLD) return 'fading'
    return 'archived'
  }

  function runDecayMaintenance(now, force) {
    ensureData()
    if (!data || !Array.isArray(data.memories)) return { ok: false, reason: 'not_ready' }
    const ts = Number(now) || Date.now()
    if (!force && lastDecayMaintenanceAt && (ts - lastDecayMaintenanceAt) < 24 * 3600 * 1000) {
      return { ok: true, skipped: true, reason: 'within_24h' }
    }
    let changed = 0
    for (const m of data.memories) {
      if (!m || m.status === 'suppressed' || m.status === 'archived') continue
      const next = recalculateStatus(m, ts)
      if (next !== m.status) {
        m.status = next
        changed++
      }
    }
    lastDecayMaintenanceAt = ts
    if (changed) {
      markMutation('decay_maintenance')
      commit()
    }
    return { ok: true, changed, nextRunInMs: 24 * 3600 * 1000 }
  }

  function recordMention(id, options) {
    ensureData()
    const m = findMemoryById(id)
    if (!m) return { ok: false, reason: 'not_found' }
    if (m.status === 'suppressed') {
      return { ok: true, reason: 'suppressed_no_auto_restore', memory: deepCopy(m) }
    }
    if (m.status === 'archived') {
      return { ok: false, reason: 'archived_not_reinforced', memory: deepCopy(m) }
    }
    const now = (options && Number(options.ts)) || Date.now()
    const previous = m.mentionCount || 0
    const increment = MENTION_REINFORCEMENT[Math.min(previous, MENTION_REINFORCEMENT.length - 1)] || 0.01
    m.mentionCount = previous + 1
    m.lastMentionedAt = now
    const nextConfidence = Math.min(1, (Number(m.confidence) || 0) + increment)
    m.confidence = nextConfidence
    m.strength = clamp(Math.max(Number(m.strength) || 0, m.strength || 0) + increment, 0, MAX_STRENGTH)
    m.updatedAt = Math.max(m.updatedAt || 0, now)
    m.status = recalculateStatus(m, now)
    bumpCounter('mention')
    markMutation('mention')
    commit()
    return { ok: true, reason: 'reinforced', memory: deepCopy(m), confidenceDelta: increment, strengthDelta: increment }
  }

  function invalidateMemoryFacts(memory, reason) {
    const refs = new Set((memory.evidenceRefs || []).map(ref => ref && ref.messageRef).filter(Boolean))
    if (window.RoleRuntime && window.RoleRuntime.invalidateFacts) window.RoleRuntime.invalidateFacts(reason, ref => refs.has(ref))
    // Archive is reversible storage management. Explicit forgetting/suppression
    // revokes the source and its memory-derived actions across backup restore.
    if (reason === 'memory_suppressed' && memory.id) { refs.add(memory.id); refs.add('mem:' + memory.id) }
    if (reason === 'memory_suppressed' && window.pet && window.pet.platform && refs.size) window.pet.platform.forget([...refs]).then(r => {
      if (!r || !r.ok) console.warn('[memory] durable forget pending:', r && r.reason)
    }).catch(e => console.warn('[memory] durable forget failed:', e.message))
  }
  function invalidateSources(refs) {
    ensureData()
    const set = new Set(refs)
    data.memories = data.memories.filter(m => !(m.evidenceRefs || []).some(e => set.has(e.messageRef) || set.has(e.eventRef)))
    for (const [key, row] of Object.entries(data.evidence || {})) if ((row.sourceEventIds || []).some(ref => set.has(ref) || set.has(String(ref).replace(/^conversation:/, '')))) delete data.evidence[key]
    markMutation('source_invalidated'); commit()
    return { ok: true }
  }

  function suppress(id, reason, actor) {
    ensureData()
    const m = findMemoryById(id)
    if (!m) return { ok: false, reason: 'not_found' }
    const now = Date.now()
    m.status = 'suppressed'
    invalidateMemoryFacts(m, 'memory_suppressed')
    m.suppression = {
      reason: reason || 'user_request',
      at: now,
      actor: actor || 'user',
      restoredAt: null
    }
    markMutation('suppress')
    commit()
    return { ok: true, memory: deepCopy(m) }
  }

  function inferLegacyType(content) {
    const s = String(content || '')
    if (/喜欢|爱吃|偏好|最爱|不喜欢|讨厌/.test(s)) return 'preference'
    if (/第一次|首次|第一次完成|第一次玩|里程碑|达成|解锁/.test(s)) return 'milestone'
    return 'episode'
  }

  /* ---------- candidate normalization ---------- */

  function normalizeCandidate(raw) {
    const input = raw && typeof raw === 'object' ? raw : {}
    const content = String(input.content || '').trim()
    const sourceEventIds = unique(
      Array.isArray(input.sourceEventIds)
        ? input.sourceEventIds
        : (input.eventId ? [input.eventId] : [])
    )
    const sourceDiaryIds = unique(Array.isArray(input.sourceDiaryIds) ? input.sourceDiaryIds : [])
    const relatedAlbumIds = unique(Array.isArray(input.relatedAlbumIds) ? input.relatedAlbumIds : [])
    const tags = unique(Array.isArray(input.tags) ? input.tags : [])
    const type = VALID_TYPES.indexOf(input.type) >= 0 ? input.type : 'episode'
    const sourceType = String(input.sourceType || (sourceEventIds.length ? 'event' : (input.userInput ? 'user' : 'unknown')))
    const userInput = !!input.userInput || sourceType === 'user'
    const ts = Number(input.ts) || Date.now()
    return {
      content: normalizedContent(content),
      originalContent: content,
      normalizedKey: normalizedKeyFor(content),
      type,
      sourceEventIds,
      sourceDiaryIds,
      relatedAlbumIds,
      tags,
      emotionalContext: isPlainObject(input.emotionalContext) ? deepCopy(input.emotionalContext) : {},
      sourceType,
      userInput,
      eventId: input.eventId ? String(input.eventId) : (sourceEventIds[0] || null),
      ts,
      date: typeof input.date === 'string' ? input.date : localDate(ts),
      importance: Number.isFinite(Number(input.importance)) ? clamp(Number(input.importance), 0, 1) : 0,
      explicitRemember: !!input.explicitRemember || userInput,
      milestone: type === 'milestone' || !!input.milestone,
      relationshipMeaning: type === 'relationship' || !!input.relationshipMeaning,
      preference: type === 'preference' || !!input.preference,
      novelty: input.novelty !== false,
      subjectKey: typeof input.subjectKey === 'string' ? input.subjectKey : null,
      propertyKey: typeof input.propertyKey === 'string' ? input.propertyKey : null,
      valueKey: typeof input.valueKey === 'string' ? input.valueKey : null,
      splitKey: typeof input.splitKey === 'string' ? input.splitKey : null,
      evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.slice(0, 20) : []
    }
  }

  function computeImportance(c, isNew) {
    let imp = c.importance || 0
    if (c.explicitRemember) imp = Math.max(imp, IMPORTANCE_RULES.explicitRemember)
    else if (c.milestone) imp = Math.max(imp, IMPORTANCE_RULES.milestone)
    else if (c.relationshipMeaning) imp = Math.max(imp, IMPORTANCE_RULES.relationship)
    else if (isNew) imp = Math.max(imp, IMPORTANCE_RULES.firstEvent)
    if (isNew && c.novelty) imp = imp + IMPORTANCE_RULES.novelty
    return clamp(imp, 0, 1)
  }

  /* 唯一 type 决策权威。
     规则：
       - 候选没有显式 preference 意图 → type 原样保留（episode/fact/milestone/... 永不因频次改类）。
       - 显式 preference 候选 → preference。
       - 显式 preference 但 type 还不是 preference → 证据 count 达到阈值才升级为 preference。
     禁止在其它位置复制 "evidence.count >= threshold → preference" 逻辑。 */
  function decideType(candidate, evidence) {
    const c = candidate || {}
    if (!c.preference) return c.type
    if (c.type === 'preference') return 'preference'
    if (evidence && evidence.count >= PREFERENCE_EVIDENCE_THRESHOLD) return 'preference'
    return c.type
  }

  function buildMemory(c, ev) {
    memoryCreationSeq += 1
    const id = stableId(c.normalizedKey + ':' + (c.sourceEventIds[0] || c.sourceType || '') + ':' + (c.date || '') + ':' + memoryCreationSeq)
    const importance = computeImportance(c, true)
    const sourceTypeStr = String(c.sourceType || '')
    const confidence = sourceTypeStr === 'legacy-migration' || sourceTypeStr === 'legacy'
      ? 0.60
      : (sourceTypeStr === 'event' || sourceTypeStr === 'reliable_event')
        ? 0.90
        : (c.explicitRemember ? 0.90 : 0.75)
    const strength = clamp(0.4 * importance + 0.6 * confidence, 0, MAX_STRENGTH)
    return {
      id,
      type: decideType(c, ev),
      content: c.content,
      createdAt: c.ts,
      updatedAt: c.ts,
      importance,
      confidence,
      strength,
      sourceEventIds: c.sourceEventIds.slice(),
      sourceDiaryIds: c.sourceDiaryIds.slice(),
      relatedAlbumIds: c.relatedAlbumIds.slice(),
      tags: c.tags.slice(),
      emotionalContext: deepCopy(c.emotionalContext),
      recallCount: 0,
      lastRecalledAt: null,
      mentionCount: 0,
      lastMentionedAt: c.ts,
      status: 'active',
      schemaVersion: SCHEMA_VERSION,
      normalizedKey: c.normalizedKey,
      date: c.date,
      sourceType: c.sourceType,
      originalContent: c.originalContent || c.content,
      migrationDerived: false,
      subjectKey: c.subjectKey || null,
      propertyKey: c.propertyKey || null,
      valueKey: c.valueKey || null,
      supersededAt: null,
      supersededBy: null,
      evidenceRefs: (c.evidenceRefs || []).slice(0, 20),
      suppression: null
    }
  }

  function evidenceRefKey(ref) {
    if (typeof ref === 'string') return 's:' + ref
    if (ref && typeof ref === 'object') {
      return (ref.kind || '') + ':' + (ref.messageRef || ref.eventRef || ref.diaryRef || ref.perceptionRef || '')
    }
    return ''
  }

  function mergeEvidenceRefs(a, b) {
    const seen = new Set()
    const out = []
    for (const ref of [...(a || []), ...(b || [])]) {
      const key = evidenceRefKey(ref)
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(ref && typeof ref === 'object' ? deepCopy(ref) : ref)
      if (out.length >= 20) break
    }
    return out
  }

  function mergeInto(existing, c, ev) {
    existing.sourceEventIds = unique([...(existing.sourceEventIds || []), ...c.sourceEventIds])
    existing.sourceDiaryIds = unique([...(existing.sourceDiaryIds || []), ...c.sourceDiaryIds])
    existing.relatedAlbumIds = unique([...(existing.relatedAlbumIds || []), ...c.relatedAlbumIds])
    existing.tags = unique([...(existing.tags || []), ...c.tags])
    existing.updatedAt = Math.max(existing.updatedAt || 0, c.ts)
    if (c.originalContent && !existing.originalContent) existing.originalContent = c.originalContent
    if (!existing.subjectKey && c.subjectKey) existing.subjectKey = c.subjectKey
    if (!existing.propertyKey && c.propertyKey) existing.propertyKey = c.propertyKey
    if (!existing.valueKey && c.valueKey) existing.valueKey = c.valueKey
    existing.evidenceRefs = mergeEvidenceRefs(existing.evidenceRefs, c.evidenceRefs)
    const mergedImportance = computeImportance(c, false)
    existing.importance = clamp(Math.max(existing.importance || 0, mergedImportance, c.explicitRemember ? IMPORTANCE_RULES.explicitRemember : 0), 0, 1)
    existing.type = decideType(c, ev)
    return existing
  }

  /* ---------- domain write entry ---------- */

  function addCandidate(rawCandidate) {
    ensureData()
    const c = normalizeCandidate(rawCandidate)
    if (!c.content) {
      bumpCounter('invalid')
      markMutation('invalid')
      return { ok: false, action: 'ignored', reason: 'empty_content' }
    }
    const sourceStr = String(c.sourceType || '').toLowerCase()
    if (DENIED_SOURCES.has(sourceStr) || sourceStr === 'chat_candidate' || sourceStr === 'diary_candidate' || sourceStr === 'ai_direct_write') {
      bumpCounter('ignored')
      markMutation('denied_source')
      return { ok: false, action: 'ignored', reason: 'denied_source', source: c.sourceType }
    }
    if (!c.sourceEventIds.length && !c.userInput) {
      bumpCounter('ignored')
      markMutation('ignored_no_source')
      return { ok: false, action: 'ignored', reason: 'no_source' }
    }
    const duplicateEvent = c.sourceEventIds.find((id) => isApplied(id))
    if (duplicateEvent) {
      bumpCounter('deduped')
      markMutation('duplicate_event')
      return { ok: false, action: 'ignored', reason: 'duplicate_event', eventId: duplicateEvent }
    }

    let existing = findMemoryByKey(c.normalizedKey)
    if (existing && (existing.status === 'suppressed' || existing.status === 'archived' || existing.supersededBy)) existing = null
    if (c.splitKey) {
      const sameType = data.memories.find((m) => m.normalizedKey === c.normalizedKey && m.type === c.type && m.status !== 'archived' && m.status !== 'suppressed' && !m.supersededBy)
      existing = sameType || null
    }
    const ev = bumpEvidence(c)
    for (const id of c.sourceEventIds) markApplied(id)

    if (existing) {
      const merged = mergeInto(existing, c, ev)
      bumpCounter('merged')
      markMutation('merged')
      commit()
      return { ok: true, action: 'merged', memory: deepCopy(merged), evidence: deepCopy(ev) }
    }

    const memory = buildMemory(c, ev)
    ensureData().memories.push(memory)
    bumpCounter('created')
    markMutation('created')
    commit()
    return { ok: true, action: 'created', memory: deepCopy(memory), evidence: deepCopy(ev) }
  }

  function admitCandidate(rawCandidate, options) {
    const c = normalizeCandidate(rawCandidate)
    if (!c.content) return { ok: false, action: 'rejected', reason: 'empty_content' }
    const src = String(c.sourceType || '').toLowerCase()
    if (DENIED_SOURCES.has(src) || src === 'chat_candidate' || src === 'diary_candidate' || src === 'ai_direct_write') {
      return { ok: false, action: 'rejected', reason: 'denied_source', source: c.sourceType }
    }
    const isLegacy = src === 'legacy' || src === 'legacy-migration'
    const evidence = Array.isArray(c.evidenceRefs) ? c.evidenceRefs : []
    if (!isLegacy && evidence.length === 0) {
      return { ok: false, action: 'rejected', reason: 'no_evidence', source: c.sourceType }
    }
    if (options && options.messageRef && evidence.length === 0 && !isLegacy) {
      c.evidenceRefs = [{ kind: 'conversation', messageRef: String(options.messageRef), at: c.ts }]
    }
    return addCandidate(c)
  }

  function findPreferenceByTopic(c) {
    if (!c || !c.subjectKey || !c.propertyKey) return null
    ensureData()
    const pool = data.memories.filter((m) => m.subjectKey === c.subjectKey && m.propertyKey === c.propertyKey && m.status !== 'archived' && m.status !== 'suppressed' && !m.supersededBy)
    if (!pool.length) return null
    if (c.valueKey) {
      const exact = pool.filter((m) => m.valueKey === c.valueKey)
      if (exact.length) return exact[0]
    }
    if (c.oldValueKey) {
      const old = pool.filter((m) => m.valueKey === c.oldValueKey)
      if (old.length) return old[0]
    }
    return pool[0]
  }

  function buildEvidenceRefs(options, ts) {
    if (!options) return []
    const out = []
    if (options.messageRef) out.push({ kind: 'conversation', messageRef: String(options.messageRef), at: Number(ts) || Date.now() })
    if (options.eventRef) out.push({ kind: 'event', eventRef: String(options.eventRef), at: Number(ts) || Date.now() })
    if (options.diaryRef) out.push({ kind: 'diary', diaryRef: String(options.diaryRef), at: Number(ts) || Date.now() })
    return out.slice(0, 20)
  }

  function processUserMessage(text, options) {
    const opts = options || {}
    const mention = window.MemoryTopic && typeof window.MemoryTopic.detectMentionCandidate === 'function'
      ? window.MemoryTopic.detectMentionCandidate(text)
      : []
    if (!mention.length) return { ok: true, action: 'no_mention', results: [] }
    const results = []
    const autoMessageRef = opts.messageRef || (window.MemoryMessageRef && typeof window.MemoryMessageRef.next === 'function' ? window.MemoryMessageRef.next() : null)
    const defaultEvidence = buildEvidenceRefs(autoMessageRef ? { ...opts, messageRef: autoMessageRef } : opts, Date.now())
    for (const cand of mention) {
      const evidence = cand.evidenceRefs && cand.evidenceRefs.length ? cand.evidenceRefs : defaultEvidence
      if (cand.joke || cand.temporary) {
        results.push({ ok: true, action: 'ignored', reason: cand.joke ? 'joke' : 'temporary', candidate: cand })
        continue
      }
      if (cand.kind === 'episode') {
        const r = admitCandidate({
          content: cand.content,
          type: 'episode',
          sourceType: 'user',
          userInput: true,
          explicitRemember: false,
          ts: opts.ts || Date.now(),
          evidenceRefs: evidence,
          splitKey: 'episode',
          tags: opts.tags || []
        }, { messageRef: opts.messageRef })
        results.push({ ok: r.ok, action: r.action || (r.ok ? 'created' : 'rejected'), reason: r.reason || null, memory: r.memory || null, candidate: cand })
        continue
      }
      const prefCand = {
        content: cand.content,
        type: 'preference',
        sourceType: 'user',
        userInput: true,
        explicitRemember: cand.strong,
        preference: true,
        ts: opts.ts || Date.now(),
        subjectKey: cand.subjectKey,
        propertyKey: cand.propertyKey,
        valueKey: cand.valueKey,
        oldValueKey: cand.oldValueKey || null,
        splitKey: 'preference',
        evidenceRefs: evidence
      }
      const existing = findPreferenceByTopic(prefCand)
      if (!existing) {
        const r = admitCandidate(prefCand, { messageRef: opts.messageRef })
        results.push({ ok: r.ok, action: r.action || (r.ok ? 'created' : 'rejected'), reason: r.reason || null, memory: r.memory || null, candidate: cand })
        continue
      }
      if (existing.valueKey === prefCand.valueKey) {
        if (!existing.supersededBy && (existing.status === 'active' || existing.status === 'fading')) {
          const r = recordMention(existing.id, { ts: opts.ts || Date.now() })
          results.push({ ok: r.ok, action: 'reinforced', reason: r.reason || null, memory: r.memory || null, candidate: cand })
        } else {
          const r = admitCandidate(prefCand, { messageRef: opts.messageRef })
          results.push({ ok: r.ok, action: r.action || (r.ok ? 'created' : 'rejected'), reason: r.reason || (existing.status === 'suppressed' ? 'old_suppressed_new_allowed' : 'old_not_reinforced'), memory: r.memory || null, oldId: existing.id, candidate: cand })
        }
        continue
      }
      // different value
      if (cand.weakChange) {
        results.push({ ok: true, action: 'no_change', reason: 'weak_change_preserve_old', memory: deepCopy(existing), candidate: cand })
        continue
      }
      // New distinct preference or strong correction -> create a new active Memory.
      const r = admitCandidate(prefCand, { messageRef: opts.messageRef })
      if (r.ok && r.memory) {
        if (cand.strong) {
          const old = findMemoryById(existing.id)
          if (old && old.status !== 'suppressed' && old.status !== 'archived' && !old.supersededBy) {
            old.supersededAt = Date.now()
            old.supersededBy = r.memory.id
            markMutation('supersede')
            commit()
          }
          results.push({ ok: true, action: 'superseded', memory: r.memory, oldId: existing.id, candidate: cand })
        } else {
          results.push({ ok: true, action: 'created', memory: r.memory, candidate: cand })
        }
      } else {
        results.push({ ok: false, action: 'rejected', reason: r.reason || null, candidate: cand })
      }
    }
    return { ok: true, action: 'processed', messageRef: autoMessageRef, results }
  }

  function forgetByQuery(text) {
    ensureData()
    const resolve = window.MemoryQuery && typeof window.MemoryQuery.resolveTarget === 'function'
      ? window.MemoryQuery.resolveTarget(text, data.memories, 'forget')
      : { count: 0, unique: false, target: null, query: null }
    if (!resolve.unique || !resolve.target) {
      return { ok: false, action: 'no_mutation', reason: resolve.count > 1 ? 'ambiguous' : 'not_found', count: resolve.count }
    }
    const r = suppress(resolve.target.id, 'user_request', 'user')
    return { ok: r.ok, action: r.ok ? 'suppressed' : 'failed', memory: r.memory || null, targetId: resolve.target.id, count: resolve.count }
  }

  function restoreByQuery(text) {
    ensureData()
    const resolve = window.MemoryQuery && typeof window.MemoryQuery.resolveTarget === 'function'
      ? window.MemoryQuery.resolveTarget(text, data.memories, 'restore')
      : { count: 0, unique: false, target: null, query: null }
    if (!resolve.unique || !resolve.target) {
      return { ok: false, action: 'no_mutation', reason: resolve.count > 1 ? 'ambiguous' : 'not_found', count: resolve.count }
    }
    const r = restore(resolve.target.id)
    return { ok: r.ok, action: r.ok ? 'restored' : 'failed', memory: r.memory || null, targetId: resolve.target.id, count: resolve.count }
  }

  function addEvent(event) {
    const e = event && typeof event === 'object' ? event : {}
    if (!e.eventId && !e.content) {
      return { ok: false, action: 'ignored', reason: 'missing_event' }
    }
    const candidate = {
      content: e.content,
      type: e.type || 'episode',
      eventId: e.eventId || null,
      sourceEventIds: e.sourceEventIds || (e.eventId ? [e.eventId] : []),
      sourceDiaryIds: e.sourceDiaryIds || [],
      relatedAlbumIds: e.relatedAlbumIds || [],
      tags: e.tags || [],
      emotionalContext: e.emotionalContext,
      ts: e.ts || Date.now(),
      date: e.date,
      importance: e.importance,
      sourceType: e.sourceType || 'event',
      userInput: !!e.userInput,
      explicitRemember: !!e.explicitRemember,
      preference: e.preference,
      milestone: e.milestone,
      relationshipMeaning: e.relationshipMeaning,
      novelty: e.novelty
    }
    return addCandidate(candidate)
  }

  function remember(content, options) {
    const opts = options || {}
    return addCandidate({
      content: String(content || ''),
      type: opts.type || 'fact',
      sourceType: 'user',
      userInput: true,
      explicitRemember: true,
      importance: Math.max(Number(opts.importance) || 0, IMPORTANCE_RULES.explicitRemember),
      ts: opts.ts || Date.now(),
      date: opts.date,
      tags: opts.tags || [],
      sourceDiaryIds: opts.sourceDiaryIds || [],
      relatedAlbumIds: opts.relatedAlbumIds || [],
      preference: opts.preference
    })
  }

  function createCandidate(input) {
    return normalizeCandidate(input)
  }

  function consolidate() {
    ensureData()
    const stats = {
      memories: data.memories.length,
      evidence: Object.keys(data.evidence || {}).length,
      appliedEvents: (data.appliedEventIds || []).length,
      migration: deepCopy(data.migration || {})
    }
    commit()
    return stats
  }

  /* ---------- legacy migration ---------- */

  function parseLegacyDate(value) {
    if (typeof value !== 'string' || !value) return null
    const m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
    if (!m) return null
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    if (Number.isNaN(d.getTime())) return null
    return d.getTime()
  }

  function migrateLegacy(items) {
    ensureData()
    if (data.migration && data.migration.legacyVersion >= 1) {
      return { ok: true, action: 'already_migrated', migrated: 0, count: data.migration.count || 0 }
    }
    const list = Array.isArray(items) ? items : []
    if (!list.length) {
      return { ok: true, action: 'no_legacy', migrated: 0, count: 0, total: 0 }
    }
    const now = Date.now()
    let migrated = 0
    let deduped = 0

    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue
      const original = String(raw.content || '').trim()
      const content = normalizedContent(original)
      if (!content) continue
      const key = normalizedKeyFor(content)
      const existing = findMemoryByKey(key)
      const createdAt = parseLegacyDate(raw.date) || now
      if (existing) {
        if (existing.sourceType === 'legacy-migration') {
          if (createdAt && (!existing.createdAt || createdAt < existing.createdAt)) existing.createdAt = createdAt
          if (!existing.originalContent) existing.originalContent = original
          deduped++
          continue
        }
        // If a non-legacy memory already exists, do not create a duplicate; keep it as the sole record.
        deduped++
        continue
      }
      const type = inferLegacyType(content)
      const id = stableId('legacy:' + key + ':' + (raw.date || ''))
      const importance = clamp(typeof raw.importance === 'number' ? raw.importance : 0.5, 0, 1)
      const confidence = 0.60
      const strength = clamp(0.4 * importance + 0.6 * confidence, 0, MAX_STRENGTH)
      const memory = {
        id,
        type,
        content,
        createdAt,
        updatedAt: createdAt,
        importance,
        confidence,
        strength,
        sourceEventIds: [],
        sourceDiaryIds: [],
        relatedAlbumIds: [],
        tags: [],
        emotionalContext: {},
        recallCount: 0,
        lastRecalledAt: null,
        mentionCount: 0,
        lastMentionedAt: createdAt,
        status: 'active',
        schemaVersion: SCHEMA_VERSION,
        normalizedKey: key,
        date: typeof raw.date === 'string' ? raw.date : localDate(createdAt),
        sourceType: 'legacy-migration',
        originalContent: original,
        migrationDerived: !parseLegacyDate(raw.date),
        subjectKey: null,
        propertyKey: null,
        valueKey: null,
        supersededAt: null,
        supersededBy: null,
        evidenceRefs: [],
        suppression: null
      }
      ensureData().memories.push(memory)
      if (!data.evidence[key]) {
        data.evidence[key] = { count: 1, sourceEventIds: [], sourceTypes: ['legacy-migration'], firstSeenAt: createdAt, lastSeenAt: createdAt }
      }
      migrated++
    }

    data.migration = {
      ...(data.migration || {}),
      version: Math.max(Number(data.migration && data.migration.version) || 0, 2),
      legacyVersion: 1,
      legacyMigratedAt: now,
      legacyCount: migrated,
      legacySourceCount: list.length,
      idempotent: true
    }
    data.diagnostics.migrated += migrated
    data.diagnostics.deduped += deduped
    data.diagnostics.lastMigrationVersion = SCHEMA_VERSION
    markMutation('migration')
    commit()
    return { ok: true, action: 'migrated', migrated, deduped, count: migrated, total: list.length }
  }

  async function rollbackLegacyMigration() {
    ensureData()
    const before = data.memories.length
    data.memories = data.memories.filter((m) => m.sourceType !== 'legacy-migration')
    data.migration = { ...(data.migration || {}), version: Math.max(Number(data.migration && data.migration.version) || 0, 2), legacyVersion: 0, legacyMigratedAt: null, legacyCount: 0, legacySourceCount: 0, idempotent: true }
    data.diagnostics.migrated = Math.max(0, (data.diagnostics.migrated || 0))
    markMutation('rollback')
    await commit()
    return { ok: true, removed: before - data.memories.length }
  }

  /* ---------- inspection / recall / archive ---------- */

  function getMemories(options) {
    ensureData()
    const opts = options || {}
    let list = data.memories.slice()
    if (opts.status) list = list.filter((m) => m.status === opts.status)
    if (opts.type) list = list.filter((m) => m.type === opts.type)
    if (opts.date) list = list.filter((m) => m.date === opts.date)
    return deepCopy(list)
  }

  function list(options) { return getMemories(options) }

  function getById(id) {
    const m = findMemoryById(id)
    return m ? deepCopy(m) : null
  }

  function recordRecall(id) {
    const m = findMemoryById(id)
    if (!m) return { ok: false, reason: 'not_found' }
    m.recallCount = (m.recallCount || 0) + 1
    m.lastRecalledAt = Date.now()
    // Recall must not automatically increase importance.
    bumpCounter('recall')
    markMutation('recall')
    commit({ debounceKey: 'recall:' + id })
    return { ok: true, memory: deepCopy(m) }
  }

  function archive(id) {
    const m = findMemoryById(id)
    if (!m) return { ok: false, reason: 'not_found' }
    m.status = 'archived'
    invalidateMemoryFacts(m, 'memory_archived')
    bumpCounter('archived')
    markMutation('archive')
    commit()
    return { ok: true, memory: deepCopy(m) }
  }

  function restore(id) {
    const m = findMemoryById(id)
    if (!m) return { ok: false, reason: 'not_found' }
    const wasSuppressed = m.status === 'suppressed'
    m.status = 'active'
    if (wasSuppressed && m.suppression) {
      m.suppression.restoredAt = Date.now()
    }
    markMutation('restore')
    commit()
    return { ok: true, restoredFromSuppressed: wasSuppressed, memory: deepCopy(m) }
  }

  function archiveByDate(date) {
    const list = getMemories({ date }).filter((m) => m.status === 'active' || m.status === 'fading')
    let n = 0
    for (const m of list) {
      const inner = findMemoryById(m.id)
      if (inner) {
        inner.status = 'archived'
        invalidateMemoryFacts(inner, 'memory_archived')
        n++
      }
    }
    if (n) {
      bumpCounter('archived', n)
      markMutation('archive_by_date')
      commit()
    }
    return { ok: true, archived: n }
  }

  function getDiagnostics() {
    ensureData()
    const invalid = data.memories.filter((m) => !m.id || !m.content || typeof m.importance !== 'number').map((m) => m.id)
    const knownEventIds = new Set(Array.isArray(data.appliedEventIds) ? data.appliedEventIds : [])
    const orphanedReferences = []
    for (const m of data.memories) {
      for (const eid of (m.sourceEventIds || [])) {
        if (!knownEventIds.has(eid)) orphanedReferences.push({ memoryId: m.id, sourceEventId: eid, type: 'sourceEvent' })
      }
    }
    return deepCopy({
      loaded: initialized,
      initError,
      schemaVersion: SCHEMA_VERSION,
      count: data.memories.length,
      activeCount: data.memories.filter((m) => m.status === 'active').length,
      fadingCount: data.memories.filter((m) => m.status === 'fading').length,
      archivedCount: data.memories.filter((m) => m.status === 'archived').length,
      suppressedCount: data.memories.filter((m) => m.status === 'suppressed').length,
      evidenceCount: Object.keys(data.evidence || {}).length,
      lastDecayMaintenanceAt: lastDecayMaintenanceAt || null,
      writeQueue: {
        memoryRevision,
        persistedRevision,
        dirty,
        persistInFlight,
        persistAttempts,
        recallDebounceCount: recallDebounceTimers.size
      },
      migration: deepCopy(data.migration || {}),
      counters: {
        created: data.diagnostics.created || 0,
        candidateCreated: data.diagnostics.created || 0,
        ignored: data.diagnostics.ignored || 0,
        candidateIgnored: data.diagnostics.ignored || 0,
        deduped: data.diagnostics.deduped || 0,
        merged: data.diagnostics.merged || 0,
        migrated: data.diagnostics.migrated || 0,
        invalid: data.diagnostics.invalid || 0,
        recall: data.diagnostics.recall || 0,
        mention: data.diagnostics.mention || 0,
        archived: data.diagnostics.archived || 0
      },
      lastMutation: deepCopy(data.diagnostics.lastMutation || null),
      invalidOrphaned: invalid.concat(orphanedReferences.map((o) => o.memoryId)),
      orphanedReferences,
      orphanedReferenceCount: orphanedReferences.length
    })
  }

  function subscribeEvents() {
    if (eventSubscribed || !window.EventBus) return
    eventSubscribed = true
    window.EventBus.on('game.completed', (p) => {
      const payload = p || {}
      const gameId = String(payload.gameId || 'unknown')
      addEvent({
        eventId: 'memory-game:' + gameId + ':' + (payload.ts || Date.now()),
        content: '和主人玩了一局《' + gameId + '》小游戏',
        type: 'episode',
        sourceType: 'event',
        ts: payload.ts || Date.now(),
        tags: ['game'],
        novelty: true
      })
    })
    window.EventBus.on('pet.fed', (p) => {
      const payload = p || {}
      addEvent({
        eventId: 'memory-fed:' + (payload.ts || Date.now()),
        content: '主人喂了小深食物',
        type: 'episode',
        sourceType: 'event',
        ts: payload.ts || Date.now(),
        tags: ['feed'],
        novelty: true
      })
    })
    window.EventBus.on('pet.work.completed', (p) => {
      const payload = p || {}
      addEvent({
        eventId: 'memory-work:' + (payload.jobId || 'unknown') + ':' + (payload.ts || Date.now()),
        content: '陪主人完成了一次工作',
        type: 'episode',
        sourceType: 'event',
        ts: payload.ts || Date.now(),
        tags: ['work'],
        novelty: true
      })
    })
  }

  function reconcileAppliedEventIds() {
    ensureData()
    if (!Array.isArray(data.appliedEventIds)) data.appliedEventIds = []
    const seen = new Set(data.appliedEventIds)
    let changed = false
    const add = (id) => {
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id)
        data.appliedEventIds.push(id)
        changed = true
      }
    }
    for (const m of (data.memories || [])) {
      for (const id of (m.sourceEventIds || [])) add(id)
    }
    for (const ev of Object.values(data.evidence || {})) {
      for (const id of (ev.sourceEventIds || [])) add(id)
    }
    if (data.appliedEventIds.length > 1000) data.appliedEventIds = data.appliedEventIds.slice(-1000)
    return changed
  }

  async function init(legacyItems) {
    try {
      if (window.MemoryStore) {
        await window.MemoryStore.load()
        data = window.MemoryStore.getData()
      } else {
        data = {}
      }
      initialized = true
      initError = null
      subscribeEvents()
      if (Array.isArray(legacyItems) && legacyItems.length) {
        await migrateLegacy(legacyItems)
        if (window.MemoryStore) await window.MemoryStore.persist()
      }
      if (reconcileAppliedEventIds() && window.MemoryStore) {
        window.MemoryStore.replace(data)
        await window.MemoryStore.persist()
      }
      runDecayMaintenance(Date.now(), true)
      return getDiagnostics()
    } catch (err) {
      initialized = false
      initError = String((err && err.message) || err)
      if (window.MemoryStore) data = window.MemoryStore.getData()
      return getDiagnostics()
    }
  }

  const WRITE_BOUNDARY = {
    owner: 'MemoryEngine',
    allowed: ['reliable-events', 'explicit-user-input', 'legacy-migration', 'controlled-maintenance'],
    denied: ['ai', 'dialogue', 'chat', 'diary', 'emotion', 'intent', 'expression', 'relationship', 'behavior', 'perception']
  }

  return {
    SCHEMA_VERSION,
    MAX_STRENGTH,
    ACTIVE_THRESHOLD,
    FADING_THRESHOLD,
    HALF_LIFE_DAYS,
    IMPORTANCE_RULES,
    init,
    ensure: init,
    addCandidate,
    admitCandidate,
    addEvent,
    createCandidate,
    remember,
    processUserMessage,
    forgetByQuery,
    restoreByQuery,
    consolidate,
    migrateLegacy,
    migrate: migrateLegacy,
    rollbackLegacyMigration,
    rollback: rollbackLegacyMigration,
    getMemories,
    getStoreData: () => (window.MemoryStore ? window.MemoryStore.getData() : deepCopy(ensureData())),
    getData: () => (window.MemoryStore ? window.MemoryStore.getData() : deepCopy(ensureData())),
    list,
    getById,
    recordRecall,
    recordMention,
    effectiveStrength,
    recalculateStatus,
    runDecayMaintenance,
    suppress,
    invalidateSources,
    archive,
    restore,
    archiveByDate,
    getDiagnostics,
    diagnostics: getDiagnostics,
    flushPersistence: flushPersist,
    flushAndWait,
    getWriteQueue: () => ({
      memoryRevision,
      persistedRevision,
      dirty,
      persistInFlight,
      persistAttempts,
      recallDebounceCount: recallDebounceTimers.size
    }),
    nextMessageRef: () => (window.MemoryMessageRef && typeof window.MemoryMessageRef.next === 'function' ? window.MemoryMessageRef.next() : 'chat-' + Date.now().toString(36) + '-0'),
    WRITE_BOUNDARY,
    isWriteSourceAllowed: (source) => !DENIED_SOURCES.has(String(source || '').toLowerCase())
  }
})()
