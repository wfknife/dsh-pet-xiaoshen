/* MemoryStore — 3.0-04
 * Independent persistence layer for memories.json.
 *
 * Responsibilities:
 *   - Load/save the separate memories.json file through main-process IPC.
 *   - Maintain schemaVersion=2, atomic save, backup recovery.
 *   - Validate memory records.
 *
 * This module does NOT decide what becomes a memory. MemoryEngine owns the
 * domain write path; MemoryStore is only the durable persistence boundary.
 */
window.MemoryStore = (function () {
  const SCHEMA_VERSION = 2
  const MAX_STRENGTH = 0.95
  const MAX_EVIDENCE_REFS = 20

  let state = null
  let loaded = false
  let loadError = null

  function defaultData() {
    return {
      schemaVersion: SCHEMA_VERSION,
      memories: [],
      migration: {
        version: 2,
        migratedAt: null,
        count: 0,
        sourceCount: 0,
        idempotent: true
      },
      evidence: {},
      appliedEventIds: [],
      diagnostics: {
        created: 0,
        ignored: 0,
        deduped: 0,
        merged: 0,
        migrated: 0,
        invalid: 0,
        recall: 0,
        archived: 0,
        lastMutation: null,
        lastMigrationVersion: 0,
        loadError: null
      }
    }
  }

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

  function defaultConfidence(m) {
    const st = String(m && m.sourceType || '')
    if (st === 'legacy-migration' || st === 'legacy') return 0.60
    if (st === 'event' || st === 'reliable_event') return 0.90
    if (st === 'user' || st === 'user_explicit') return 0.90
    return 0.60
  }

  function computeStrength(importance, confidence) {
    const imp = Number.isFinite(Number(importance)) ? Number(importance) : 0
    const conf = Number.isFinite(Number(confidence)) ? Number(confidence) : 0.6
    return clamp(0.4 * imp + 0.6 * conf, 0, MAX_STRENGTH)
  }

  // P3：新增 'perception' —— 感知层语义事件的证据（perceptionRef = pev-<obsId>-<kind>）
  const EVIDENCE_KINDS = ['conversation', 'event', 'diary', 'perception']

  function evidenceRefKeyOf(kind) {
    if (kind === 'conversation') return 'messageRef'
    if (kind === 'event') return 'eventRef'
    if (kind === 'diary') return 'diaryRef'
    if (kind === 'perception') return 'perceptionRef'
    return null
  }

  function normalizeEvidenceRefs(list) {
    const out = []
    if (!Array.isArray(list)) return out
    for (const item of list) {
      if (typeof item === 'string' && item) {
        out.push(item)
        continue
      }
      if (isPlainObject(item)) {
        const kind = EVIDENCE_KINDS.indexOf(item.kind) >= 0 ? item.kind : null
        const refKey = evidenceRefKeyOf(kind)
        const obj = {
          kind,
          at: typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : null
        }
        if (refKey) obj[refKey] = typeof item[refKey] === 'string' ? item[refKey] : null
        out.push(obj)
      }
    }
    return out.slice(0, MAX_EVIDENCE_REFS)
  }

  function normalizeMemory(m) {
    if (!isPlainObject(m)) return null
    const id = typeof m.id === 'string' && m.id ? m.id : null
    const content = typeof m.content === 'string' ? m.content.trim() : ''
    if (!id || !content) return null
    const baseImportance = clamp(typeof m.importance === 'number' ? m.importance : 0.5, 0, 1)
    const confidence = clamp(typeof m.confidence === 'number' ? m.confidence : defaultConfidence(m), 0, 1)
    const strength = clamp(typeof m.strength === 'number' ? m.strength : computeStrength(baseImportance, confidence), 0, MAX_STRENGTH)
    const createdAt = typeof m.createdAt === 'number' ? m.createdAt : null
    const updatedAt = typeof m.updatedAt === 'number'
      ? m.updatedAt
      : (typeof createdAt === 'number' ? createdAt : Date.now())
    const evidenceRefs = normalizeEvidenceRefs(m.evidenceRefs)
    const suppression = isPlainObject(m.suppression)
      ? {
          reason: typeof m.suppression.reason === 'string' ? m.suppression.reason : null,
          at: typeof m.suppression.at === 'number' ? m.suppression.at : null,
          actor: typeof m.suppression.actor === 'string' ? m.suppression.actor : null,
          restoredAt: typeof m.suppression.restoredAt === 'number' ? m.suppression.restoredAt : null
        }
      : null
    return {
      id,
      type: typeof m.type === 'string' && m.type ? m.type : 'episode',
      content,
      createdAt,
      updatedAt,
      importance: baseImportance,
      confidence,
      strength,
      sourceEventIds: Array.isArray(m.sourceEventIds) ? m.sourceEventIds.filter((x) => typeof x === 'string') : [],
      sourceDiaryIds: Array.isArray(m.sourceDiaryIds) ? m.sourceDiaryIds.filter((x) => typeof x === 'string') : [],
      relatedAlbumIds: Array.isArray(m.relatedAlbumIds) ? m.relatedAlbumIds.filter((x) => typeof x === 'string') : [],
      tags: Array.isArray(m.tags) ? m.tags.filter((x) => typeof x === 'string').slice(0, 20) : [],
      emotionalContext: isPlainObject(m.emotionalContext) ? m.emotionalContext : {},
      recallCount: clamp(typeof m.recallCount === 'number' && m.recallCount >= 0 ? Math.floor(m.recallCount) : 0, 0, 1000000),
      lastRecalledAt: typeof m.lastRecalledAt === 'number' ? m.lastRecalledAt : null,
      mentionCount: clamp(typeof m.mentionCount === 'number' && m.mentionCount >= 0 ? Math.floor(m.mentionCount) : 0, 0, 1000000),
      lastMentionedAt: typeof m.lastMentionedAt === 'number' ? m.lastMentionedAt : updatedAt,
      status: ['active', 'fading', 'archived', 'suppressed'].indexOf(m.status) >= 0 ? m.status : 'active',
      schemaVersion: SCHEMA_VERSION,
      normalizedKey: typeof m.normalizedKey === 'string' ? m.normalizedKey : null,
      date: typeof m.date === 'string' ? m.date : null,
      sourceType: typeof m.sourceType === 'string' ? m.sourceType : 'event',
      originalContent: typeof m.originalContent === 'string' ? m.originalContent : null,
      migrationDerived: !!m.migrationDerived,
      subjectKey: typeof m.subjectKey === 'string' ? m.subjectKey : null,
      propertyKey: typeof m.propertyKey === 'string' ? m.propertyKey : null,
      valueKey: typeof m.valueKey === 'string' ? m.valueKey : null,
      supersededAt: typeof m.supersededAt === 'number' ? m.supersededAt : null,
      supersededBy: typeof m.supersededBy === 'string' ? m.supersededBy : null,
      evidenceRefs,
      suppression
    }
  }

  function normalizeData(raw) {
    const base = defaultData()
    if (!isPlainObject(raw)) return base
    const out = {
      schemaVersion: SCHEMA_VERSION,
      memories: Array.isArray(raw.memories) ? raw.memories.map(normalizeMemory).filter(Boolean) : [],
      migration: {
        ...base.migration,
        ...(isPlainObject(raw.migration) ? raw.migration : {})
      },
      evidence: isPlainObject(raw.evidence) ? deepCopy(raw.evidence) : {},
      appliedEventIds: Array.isArray(raw.appliedEventIds) ? raw.appliedEventIds.filter((x) => typeof x === 'string').slice(-1000) : [],
      diagnostics: {
        ...base.diagnostics,
        ...(isPlainObject(raw.diagnostics) ? raw.diagnostics : {})
      }
    }
    if (!out.migration.schema) {
      const memCount = out.memories.length
      out.migration.schema = {
        version: SCHEMA_VERSION,
        migratedAt: out.migration.migratedAt || null,
        count: memCount,
        sourceCount: memCount,
        idempotent: true
      }
      if (!out.migration.count) out.migration.count = memCount
      if (!out.migration.sourceCount) out.migration.sourceCount = memCount
    }
    if (out.schemaVersion === SCHEMA_VERSION && Number(out.diagnostics.lastMigrationVersion) < SCHEMA_VERSION) {
      out.diagnostics.lastMigrationVersion = SCHEMA_VERSION
    }
    return out
  }

  function validate(data) {
    const issues = []
    if (!isPlainObject(data)) {
      issues.push('store data is not object')
      return issues
    }
    if (data.schemaVersion !== SCHEMA_VERSION) issues.push('schemaVersion mismatch: ' + data.schemaVersion)
    if (!Array.isArray(data.memories)) issues.push('memories is not array')
    if (Array.isArray(data.memories)) {
      data.memories.forEach((m, i) => {
        if (!isPlainObject(m)) {
          issues.push('memory[' + i + '] is not object')
          return
        }
        if (!m.id || typeof m.id !== 'string') issues.push('memory[' + i + '] missing id')
        if (!m.content || typeof m.content !== 'string') issues.push('memory[' + i + '] missing content')
        if (typeof m.importance !== 'number' || m.importance < 0 || m.importance > 1) issues.push('memory[' + i + '] importance out of range')
        if (typeof m.confidence !== 'number' || m.confidence < 0 || m.confidence > 1) issues.push('memory[' + i + '] confidence out of range')
        if (typeof m.strength !== 'number' || m.strength < 0 || m.strength > MAX_STRENGTH) issues.push('memory[' + i + '] strength out of range')
        if (!Number.isInteger(m.mentionCount) || m.mentionCount < 0) issues.push('memory[' + i + '] mentionCount invalid')
        if (!Number.isInteger(m.recallCount) || m.recallCount < 0) issues.push('memory[' + i + '] recallCount invalid')
        if (m.createdAt !== null && typeof m.createdAt !== 'number') issues.push('memory[' + i + '] createdAt not number')
        if (m.updatedAt !== null && typeof m.updatedAt !== 'number') issues.push('memory[' + i + '] updatedAt not number')
        if (m.lastMentionedAt !== null && typeof m.lastMentionedAt !== 'number') issues.push('memory[' + i + '] lastMentionedAt invalid')
        if (m.lastRecalledAt !== null && typeof m.lastRecalledAt !== 'number') issues.push('memory[' + i + '] lastRecalledAt invalid')
        if (m.subjectKey !== null && typeof m.subjectKey !== 'string') issues.push('memory[' + i + '] subjectKey invalid')
        if (m.propertyKey !== null && typeof m.propertyKey !== 'string') issues.push('memory[' + i + '] propertyKey invalid')
        if (m.valueKey !== null && typeof m.valueKey !== 'string') issues.push('memory[' + i + '] valueKey invalid')
        if (m.supersededAt !== null && typeof m.supersededAt !== 'number') issues.push('memory[' + i + '] supersededAt invalid')
        if (m.supersededBy !== null && typeof m.supersededBy !== 'string') issues.push('memory[' + i + '] supersededBy invalid')
        if (!Array.isArray(m.evidenceRefs)) {
          issues.push('memory[' + i + '] evidenceRefs invalid')
        } else {
          if (m.evidenceRefs.length > MAX_EVIDENCE_REFS) issues.push('memory[' + i + '] evidenceRefs too long')
          m.evidenceRefs.forEach((ref, j) => {
            if (typeof ref === 'string') return
            if (!isPlainObject(ref)) {
              issues.push('memory[' + i + '] evidenceRefs[' + j + '] not object')
              return
            }
            if (EVIDENCE_KINDS.indexOf(ref.kind) < 0) issues.push('memory[' + i + '] evidenceRefs[' + j + '] kind invalid')
            const refKey = evidenceRefKeyOf(ref.kind)
            if (!refKey || typeof ref[refKey] !== 'string' || !ref[refKey]) issues.push('memory[' + i + '] evidenceRefs[' + j + '] ref invalid')
            if (typeof ref.at !== 'number' || !Number.isFinite(ref.at)) issues.push('memory[' + i + '] evidenceRefs[' + j + '] at invalid')
          })
        }
        if (m.suppression !== null && !isPlainObject(m.suppression)) issues.push('memory[' + i + '] suppression invalid')
        if (!Array.isArray(m.sourceEventIds) && !Array.isArray(m.sourceDiaryIds)) issues.push('memory[' + i + '] missing source arrays')
      })
    }
    return issues
  }

  async function migrateToV2() {
    const raw = await window.pet.memoryLoad()
    if (!raw) {
      state = defaultData()
      loaded = true
      loadError = null
      return { migrated: false, reason: 'no-data', sourceCount: 0, migratedCount: 0 }
    }
    if (raw.schemaVersion === SCHEMA_VERSION) {
      state = normalizeData(raw)
      loaded = true
      loadError = null
      return { migrated: false, reason: 'already-schema-2', sourceCount: Array.isArray(raw.memories) ? raw.memories.length : 0, migratedCount: 0 }
    }
    const sourceMemories = Array.isArray(raw.memories) ? raw.memories : []
    const sourceCount = sourceMemories.length
    const normalized = normalizeData(raw)
    const stats = {
      confidence: sourceMemories.filter((m) => typeof m.confidence !== 'number').length,
      strength: sourceMemories.filter((m) => typeof m.strength !== 'number').length,
      mentionCount: sourceMemories.filter((m) => typeof m.mentionCount !== 'number').length,
      lastMentionedAt: sourceMemories.filter((m) => typeof m.lastMentionedAt !== 'number').length,
      subjectKey: sourceMemories.filter((m) => typeof m.subjectKey !== 'string').length,
      propertyKey: sourceMemories.filter((m) => typeof m.propertyKey !== 'string').length,
      valueKey: sourceMemories.filter((m) => typeof m.valueKey !== 'string').length,
      supersededAt: sourceMemories.filter((m) => typeof m.supersededAt !== 'number').length,
      supersededBy: sourceMemories.filter((m) => typeof m.supersededBy !== 'string').length,
      evidenceRefs: sourceMemories.filter((m) => !Array.isArray(m.evidenceRefs)).length,
      suppression: sourceMemories.filter((m) => typeof m.suppression === 'undefined').length
    }
    state = normalized
    loaded = true
    loadError = null
    state.migration = {
      version: 2,
      migratedAt: Date.now(),
      count: normalized.memories.length,
      sourceCount,
      idempotent: true,
      schema: {
        version: 2,
        migratedAt: Date.now(),
        count: normalized.memories.length,
        sourceCount,
        idempotent: true
      }
    }
    state.diagnostics.migrated = (state.diagnostics.migrated || 0) + normalized.memories.length
    state.diagnostics.lastMigrationVersion = 2
    const ok = await persist()
    return {
      migrated: true,
      ok,
      sourceCount,
      migratedCount: normalized.memories.length,
      filledDefaults: stats,
      backupCreatedBySave: true
    }
  }

  async function load() {
    try {
      const raw = await window.pet.memoryLoad()
      if (raw && raw.schemaVersion !== SCHEMA_VERSION) {
        await migrateToV2()
      } else {
        state = normalizeData(raw)
        loadError = null
        loaded = true
        const needMeta = raw && raw.schemaVersion === SCHEMA_VERSION && (!raw.migration || !raw.migration.schema)
        if (needMeta) await persist()
      }
    } catch (err) {
      state = defaultData()
      loadError = String((err && err.message) || err)
      state.diagnostics.loadError = loadError
      loaded = false
    }
    return getData()
  }

  function getData() {
    return deepCopy(state || defaultData())
  }

  function getSnapshot() {
    const snap = getData()
    return Object.freeze(snap) // shallow freeze at top level; deep consumers should use getData copies
  }

  async function persist() {
    if (!state) state = defaultData()
    try {
      const ok = await window.pet.memorySave(state)
      return !!ok
    } catch (err) {
      return false
    }
  }

  function replace(next) {
    state = normalizeData(next)
    loaded = true
    loadError = null
    return true
  }

  function isLoaded() { return loaded }
  function getLoadError() { return loadError }

  return {
    SCHEMA_VERSION,
    MAX_STRENGTH,
    MAX_EVIDENCE_REFS,
    defaultData,
    load,
    migrateToV2,
    getData,
    getSnapshot,
    persist,
    save: persist,
    replace,
    validate,
    computeStrength,
    normalizeMemory,
    normalizeData,
    isLoaded,
    getLoadError
  }
})()
