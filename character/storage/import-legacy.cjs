'use strict'
/**
 * K1 旧数据导入器（只读旧文件，写隔离候选库）。
 *
 * 纪律（总规 §20 K1 / §11.3）：
 *  - 旧文件**只读**，一个字节都不改；不读取任何密钥文件。
 *  - 同一 importId 重跑必须幂等：ID 与内容都来自源文件哈希，不来自时间。
 *  - 先加载墓碑（policy），再身份/来源，再 memory/life/platform 对象，最后操作。
 *  - 相同 ID 不同内容 → 记 conflict，不猜真值（不用 mtime 或数组长度判新旧）。
 *  - 历史 continuation 不恢复执行：转 abandoned/unknown 并保留原因。
 *  - 只有文本、没有可定位证据的记忆标 legacy_unverified，允许查看但不升级为近期事实。
 */

const fs = require('node:fs')
const path = require('node:path')
const { hash, deterministicId, isSafeId, uuid } = require('../ids.cjs')
const { STATE_SCHEMA_VERSION } = require('../contracts.cjs')

const LEGACY_FILES = Object.freeze([
  'pet-state.json',
  'persona.json',
  'prompts/current.json',
  'character-chat-history.json',
  'memories.json',
  'pet-life.json',
  'character-platform.json',
  'character-forgotten.json',
])

const MAX_FILE_BYTES = 64 * 1024 * 1024

function readJsonEnvelope (file, hashedFile) {
  // platform / forgotten 是 {hash, payload} 信封；hash 校验失败不得当成有效数据。
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed && typeof parsed === 'object' && parsed.payload !== undefined && typeof parsed.hash === 'string') {
    const expected = hashedFile(parsed.payload)
    if (expected !== parsed.hash) return { ok: false, reason: 'legacy_checksum_mismatch' }
    return { ok: true, value: parsed.payload }
  }
  return { ok: true, value: parsed }
}

function readLegacyFile (dataDir, relative) {
  const file = path.join(dataDir, relative)
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { relative, exists: false, reason: 'not_a_file' }
    if (stat.size > MAX_FILE_BYTES) return { relative, exists: true, reason: 'too_large', bytes: stat.size }
    const bytes = fs.readFileSync(file)
    const fileHash = hash(bytes.toString('utf8'))
    let parsed
    try {
      parsed = readJsonEnvelope(file, value => hash(JSON.stringify(value)))
    } catch (error) {
      return { relative, exists: true, reason: 'unparsable', error: error.message.slice(0, 200), hash: fileHash, bytes: stat.size }
    }
    if (!parsed.ok) return { relative, exists: true, reason: parsed.reason, hash: fileHash, bytes: stat.size }
    return { relative, exists: true, hash: fileHash, bytes: stat.size, value: parsed.value }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { relative, exists: false, reason: 'missing' }
    return { relative, exists: false, reason: error && error.code ? error.code : 'read_failed' }
  }
}

/** 旧 operation 状态 → 新状态机。绝不把“已派发但无回执”当成 succeeded。 */
function mapLegacyOperationStatus (legacy) {
  const status = String(legacy.status || '')
  const effect = ['read', 'internal', 'virtual', 'external-idempotent', 'external-unknown'].includes(legacy.effect)
    ? legacy.effect
    : (legacy.type === 'action' ? 'external-unknown' : 'internal')
  const hasReceipt = !!(legacy.receipt && typeof legacy.receipt === 'object')
  switch (status) {
    case 'completed':
      return hasReceipt
        ? { status: 'succeeded', reason: null }
        : { status: 'unknown', reason: 'legacy_completed_without_receipt' }
    case 'failed':
      return { status: 'failed', reason: legacy.reason || null }
    case 'cancelled':
      return { status: 'cancelled', reason: legacy.reason || null }
    case 'expired':
      return { status: 'expired', reason: legacy.reason || null }
    case 'rejected':
      return { status: 'rejected', reason: legacy.reason || null }
    case 'invalidated':
      return { status: 'cancelled', reason: 'source_forgotten_at_import' }
    case 'prepared':
      return { status: 'abandoned', reason: 'legacy_prepared_not_resumed' }
    case 'dispatched':
      return effect === 'read'
        ? { status: 'failed', reason: 'legacy_read_in_flight_not_retried' }
        : { status: 'unknown', reason: 'legacy_in_flight_at_import' }
    case 'awaiting_receipt':
      return { status: 'unknown', reason: 'legacy_awaiting_receipt_at_import' }
    case 'unknown_after_dispatch':
      return { status: 'unknown', reason: 'legacy_unknown_after_dispatch' }
    case 'awaiting_metadata':
      return { status: 'failed', reason: 'legacy_provider_interrupted' }
    case 'paused':
      return { status: 'abandoned', reason: 'legacy_paused_at_import' }
    default:
      return { status: 'unknown', reason: 'legacy_status_unmapped:' + status }
  }
}

/**
 * 旧 memories.json 里 status=suppressed 的记录代表“用户已经移除”，
 * 它的 id 与全部证据 ref 都必须进入删除账本，重建索引时不得复活。
 */
function collectSuppressedMemoryRefs (section) {
  const rows = section && section.exists && section.value && Array.isArray(section.value.memories) ? section.value.memories : []
  const refs = []
  for (const row of rows) {
    if (!row || row.status !== 'suppressed') continue
    if (typeof row.id === 'string' && row.id) refs.push(row.id, 'mem:' + row.id)
    for (const ref of Array.isArray(row.evidenceRefs) ? row.evidenceRefs : []) {
      const id = (ref && (ref.messageRef || ref.eventRef)) || (typeof ref === 'string' ? ref : null)
      if (id) refs.push(id)
    }
    if (row.suppression && typeof row.suppression === 'object') {
      for (const value of Object.values(row.suppression)) if (typeof value === 'string') refs.push(value)
    }
  }
  return refs
}

/**
 * @param {{store: object, policyStore: object, dataDir: string, now?: Function}} deps
 */
function createImporter (deps) {
  const store = deps.store
  const policyStore = deps.policyStore
  const dataDir = deps.dataDir
  const clock = typeof deps.now === 'function' ? deps.now : Date.now

  function readAll () {
    const files = {}
    for (const relative of LEGACY_FILES) files[relative] = readLegacyFile(dataDir, relative)
    return files
  }

  /**
   * 主入口。返回 {ok, importId, characterId, counts, conflicts, skipped, notes, idempotent}。
   * 一旦 policy 删除集写入，主库导入在同一事务中完成；失败则主库无残留。
   */
  function run (options = {}) {
    const files = readAll()
    const invalid = LEGACY_FILES.filter(name => files[name].reason !== 'missing' && files[name].value === undefined)
    if (invalid.length) return { ok: false, reason: 'legacy_input_invalid', files: invalid }
    const tombstones = files['character-forgotten.json']
    if (tombstones.exists && (!tombstones.value || typeof tombstones.value.refs !== 'object' || !tombstones.value.refs || Array.isArray(tombstones.value.refs))) return { ok: false, reason: 'legacy_policy_shape_invalid' }
    const hashes = LEGACY_FILES.map(relative => relative + '=' + (files[relative].hash || 'missing')).join('|')
    const importId = deterministicId('import', hashes)

    store.open()
    policyStore.open()

    const prior = store.read(gw => gw.getImport(importId))
    if (prior && prior.status === 'completed') {
      return {
        ok: true, importId, idempotent: true, characterId: prior.detail && prior.detail.characterId,
        counts: prior.detail && prior.detail.counts, conflicts: prior.detail && prior.detail.conflicts,
        skipped: prior.detail && prior.detail.skipped, notes: prior.detail && prior.detail.notes,
      }
    }
    // A second, changed import cannot reset a character's state/revision to 1.
    // Incremental merge needs an explicit conflict protocol; force is not that protocol.
    const priorImport = store.read(gw => gw.db.get("SELECT import_id FROM imports WHERE status = 'completed' LIMIT 1"))
    if (priorImport) return { ok: false, reason: 'incremental_import_requires_merge', importId }
    const occupied = store.read(gw => {
      const id = gw.getMeta('character_id')
      return id && (gw.lastSeq(id).seq > 0 || (gw.getState(id)?.revision || 0) > 1 || !!gw.latestIdentity(id))
    })
    if (occupied) return { ok: false, reason: 'import_target_not_empty', importId }

    const counts = {}
    const conflicts = []
    const skipped = []
    const notes = []
    const inc = key => { counts[key] = (counts[key] || 0) + 1 }

    /* ---------- 1) 墓碑先于一切内容 ---------- */
    const forgotten = files['character-forgotten.json']
    let tombstoneRefs = []
    if (forgotten.exists && forgotten.value && forgotten.value.refs && typeof forgotten.value.refs === 'object') {
      tombstoneRefs = Object.keys(forgotten.value.refs)
      counts.tombstones = tombstoneRefs.length
    } else if (forgotten.exists) {
      conflicts.push({ section: 'character-forgotten.json', reason: 'unexpected_shape' })
    } else {
      skipped.push({ section: 'character-forgotten.json', reason: forgotten.reason })
    }
    if (tombstoneRefs.length) policyStore.recordDeletion(tombstoneRefs, 'legacy_tombstone_import')

    // 旧记忆里 status=suppressed 表示用户已经移除该条；它的证据必须作为删除决定
    // 立刻进入 policy 账本，否则重建索引会让它复活（C06）。
    const suppressedRefs = collectSuppressedMemoryRefs(files['memories.json'])
    if (suppressedRefs.length) policyStore.recordDeletion(suppressedRefs, 'legacy_memory_suppressed')
    const deletedNow = policyStore.deletedSet()

    /* ---------- 2) 身份 ---------- */
    const persona = files['persona.json']
    const prompts = files['prompts/current.json']
    const petState = files['pet-state.json']
    const personaValue = persona.exists && persona.value && typeof persona.value === 'object' ? persona.value : null
    const promptValue = prompts.exists && prompts.value && typeof prompts.value === 'object' ? prompts.value : null
    const stateValue = petState.exists && petState.value && typeof petState.value === 'object' ? petState.value : null

    const displayName = String(
      (personaValue && personaValue.identity && personaValue.identity.displayName) ||
      (stateValue && typeof stateValue.name === 'string' ? stateValue.name : '') ||
      '小深',
    ).slice(0, 80)

    // 身份定义 = persona 规范化内容 + prompt 文本哈希；不重写人格文本，只归档版本。
    const definition = {
      persona: personaValue || null,
      promptRevision: promptValue && typeof promptValue.revision === 'string' ? promptValue.revision : null,
      promptHash: promptValue && promptValue.texts ? hash(promptValue.texts) : null,
      promptTextsHash: promptValue && promptValue.texts ? hash(promptValue.texts) : null,
      legacySourceRef: 'prompts/current.json',
    }
    const identityHash = hash(JSON.stringify(definition))

    const result = store.transaction(gw => {
      let character = gw.getCharacter(characterIdOf(gw))
      const characterId = character ? character.characterId : characterIdOf(gw, true)
      if (!character) {
        gw.putCharacter({ characterId, identityRevision: 1, revision: 0, writerEpoch: 0, createdAt: clock() })
        gw.setMeta('character_id', characterId)
        counts.characters = 1
        character = gw.getCharacter(characterId)
      }
      gw.putIdentityRevision({
        characterId, revision: 1, displayName, definition, hash: identityHash,
        reason: 'legacy_import', sourceRefs: [persona.exists ? 'persona.json' : 'defaults'], createdAt: clock(),
      })
      inc('identityRevisions')

      const stateBody = buildStateBody(stateValue, identityHash)
      gw.writeState({ characterId, revision: 1, identityRevision: 1, schemaVersion: STATE_SCHEMA_VERSION, body: stateBody, seq: 0 })
      inc('state')

      // 日记是经历的文学投影；旧日记不能消失，但也不能反过来成为事实源。
      importLegacyDiary(gw, characterId, stateValue, inc, skipped, conflicts)
      // 旧待办是主人事项，导入为 owner 来源的 Concern，不静默丢弃。
      importLegacyTodos(gw, characterId, stateValue, inc, skipped)

      /* ---------- 3) 来源：只有用户消息是事实来源 ---------- */
      const historySection = importHistory(gw, characterId, files['character-chat-history.json'], deletedNow, inc, conflicts, skipped)
      const platformSection = files['character-platform.json']
      const platform = platformSection.exists && platformSection.value ? platformSection.value : null
      const platformSources = importPlatformSources(gw, characterId, platform, deletedNow, inc, conflicts)

      /* ---------- 4) 记忆 / 事实 / 解释 ---------- */
      const memorySection = files['memories.json']
      const memoryValue = memorySection.exists && memorySection.value ? memorySection.value : null
      const memoryCounts = importMemories(gw, characterId, memoryValue, historySection.sourceIds, platformSources.sourceIds, deletedNow, inc, conflicts, skipped)

      /* ---------- 5) life：经历、关注、项目、作品 ---------- */
      const lifeSection = files['pet-life.json']
      const lifeValue = lifeSection.exists && lifeSection.value ? lifeSection.value : null
      const lifeCounts = importLife(gw, characterId, lifeValue, deletedNow, inc, conflicts, skipped)

      /* ---------- 6) platform 领域对象与操作 ---------- */
      const platformCounts = importPlatformDomain(gw, characterId, platform, deletedNow, inc, conflicts, skipped)

      const detail = {
        characterId,
        counts,
        conflicts,
        skipped,
        notes,
        sourceMapping: {
          historyRows: historySection.rows,
          platformSources: platformSources.count,
          memoryRecords: memoryCounts.records,
          lifeRecords: lifeCounts.records,
          platformOperations: platformCounts.operations,
        },
        fileHashes: Object.fromEntries(LEGACY_FILES.map(relative => [relative, files[relative].hash || null])),
        policyEpoch: policyStore.epoch(),
        importedAt: clock(),
      }
      gw.putImport({ importId, sourceHash: hash(hashes), status: 'completed', startedAt: clock(), completedAt: clock(), detail })
      return { characterId, detail }
    })

    // 清理进度：导入已把删除集应用为“不可见”，但正文清理留给 lifecycle 任务。
    return {
      ok: true,
      importId,
      idempotent: false,
      characterId: result.characterId,
      counts: result.detail.counts,
      conflicts: result.detail.conflicts,
      skipped: result.detail.skipped,
      notes: result.detail.notes,
      detail: result.detail,
    }
  }

  function characterIdOf (gw, create) {
    const existing = gw.getMeta('character_id')
    if (existing) return existing
    if (!create) return '__unassigned__'
    // 首次导入生成一次并持久化；重跑导入复用同一个 ID（不因内容变化而换身份）。
    return 'char-' + uuid()
  }

  function buildStateBody (state, identityHash) {
    if (!state) return require('../domain/reducer.cjs').initialState({ identityHash, displayName: '小深',
      needs: { satiety: 85, thirst: 85, energy: 85, mood: 85 }, nurture: { level: 1, coins: 20 } })
    const stats = state && state.stats && typeof state.stats === 'object' ? state.stats : {}
    const clamp = v => Math.max(0, Math.min(100, Number.isFinite(Number(v)) ? Number(v) : 0))
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      identityHash,
      displayName: state && typeof state.name === 'string' ? state.name.slice(0, 80) : undefined,
      // 养成数值原样迁入：首轮不改数值规则（§3.3 保留清单）
      nurture: {
        level: Number(state && state.level) || 0,
        coins: Number(state && state.coins) || 0,
        exp: Number(state && state.exp) || 0,
        bootCount: Number(state && state.bootCount) || 0,
        totalGames: Number(state && state.totalGames) || 0,
        totalWorkDone: Number(state && state.totalWorkDone) || 0,
        pomodoros: Number(state && state.pomodoros) || 0,
        feedCount: Number(state && state.feedCount) || 0,
      },
      needs: {
        satiety: clamp(stats.satiety === undefined ? 80 : stats.satiety),
        thirst: clamp(stats.thirst === undefined ? 80 : stats.thirst),
        energy: clamp(stats.energy === undefined ? 80 : stats.energy),
        mood: clamp(stats.mood === undefined ? 70 : stats.mood),
      },
      affect: { mood: 'neutral', intensity: 0, updatedAt: 0 },
      relationship: { ...require('../domain/reducer.cjs').initialRelationship(state?.affection), ...(state?.relationship || {}) },
      interests: {},
      attentionPolicy: { quietUntil: 0, lastAutomaticAt: 0 },
      // 未映射的旧字段保留在这里，避免“为了整洁删掉无法解释的数据”
      legacyUnmapped: collectUnmappedLegacy(state),
    }
  }

  function collectUnmappedLegacy (state) {
    if (!state) return {}
    const known = new Set(['level', 'coins', 'exp', 'bootCount', 'totalGames', 'totalWorkDone', 'pomodoros', 'feedCount',
      'stats', 'name', 'diary', 'diaryOutputs', 'memories', '_store'])
    const out = {}
    for (const key of Object.keys(state)) if (!known.has(key)) out[key] = state[key]
    return out
  }

  function importHistory (gw, characterId, section, deletedNow, inc, conflicts, skipped) {
    const out = { rows: 0, sourceIds: new Set() }
    if (!section.exists) { skipped.push({ section: 'character-chat-history.json', reason: section.reason }); return out }
    if (!Array.isArray(section.value)) {
      conflicts.push({ section: 'character-chat-history.json', reason: 'expected_array' })
      return out
    }
    for (const row of section.value) {
      if (!row || typeof row.text !== 'string' || (row.role !== 'user' && row.role !== 'assistant')) continue
      const ts = Number(row.ts) || clock()
      const messageRef = typeof row.messageRef === 'string' && isSafeId(row.messageRef, 160) ? row.messageRef : null
      if (row.role === 'user') {
        if (!messageRef) {
          // 没有稳定 ref 的用户消息不能安全地去重或撤回；保留为事件但不升级为来源。
          skipped.push({ section: 'character-chat-history.json', reason: 'user_row_without_message_ref', ts })
          continue
        }
        if (deletedNow.has(messageRef)) { skipped.push({ section: 'character-chat-history.json', reason: 'forgotten', messageRef }); continue }
        const payloadRef = gw.putPayload(JSON.stringify({ text: row.text.slice(0, 8000), selfInitiated: row.selfInitiated === true }), 'episode')
        const source = gw.putSource({
          sourceId: messageRef, characterId, sourceKind: 'owner_message', world: 'user_report',
          trust: 'owner_statement', permission: 'granted', payloadRef, sourceHash: hash(row.text),
          occurredAt: ts, observedAt: ts,
        })
        if (source) { out.sourceIds.add(messageRef); inc('sources') }
        gw.appendEvent({ eventId: deterministicId('evt', characterId + '|owner.message|' + messageRef), characterId,
          kind: 'owner.message', sourceId: messageRef, sourceEventId: messageRef, payloadRef, world: 'user_report', trust: 'owner_statement',
          correlationId: messageRef, occurredAt: ts, observedAt: ts, committedAt: clock(), timezone: 'Asia/Shanghai', retentionClass: 'episode', evidenceRefs: [messageRef] })
        out.rows++
      } else {
        // assistant 文本是角色表达，不是关于主人的事实来源；只作为事件与表现历史留存。
        const eventId = 'evt:legacy-assistant:' + hash(messageRef || (ts + ':' + row.text)).slice(0, 24)
        gw.appendEvent({
          eventId, characterId, kind: 'assistant.utterance', sourceId: messageRef, sourceEventId: null,
          payloadRef: gw.putPayload(JSON.stringify({ text: row.text.slice(0, 8000) }), 'episode'),
          world: 'virtual', trust: 'interpretation', correlationId: messageRef || eventId,
          occurredAt: ts, observedAt: ts, committedAt: clock(), timezone: 'Asia/Shanghai',
          retentionClass: 'episode', evidenceRefs: [],
        })
        inc('assistantUtterances')
      }
    }
    return out
  }

  function importLegacyDiary (gw, characterId, state, inc, skipped, conflicts) {
    if (!state) return
    const rows = []
    if (Array.isArray(state.diary)) rows.push(...state.diary.map((row, index) => ({ row, key: 'diary:' + index })))
    if (Array.isArray(state.diaryOutputs)) rows.push(...state.diaryOutputs.map((row, index) => ({ row, key: 'diaryOutput:' + index })))
    for (const { row, key } of rows) {
      if (!row) continue
      const text = typeof row === 'string' ? row : (row.text || row.content || row.summary || '')
      if (!text) { skipped.push({ section: 'pet-state.json', reason: 'diary_entry_without_text', key }); continue }
      const ts = Number(row.ts || row.createdAt) || Date.parse(row.date || '') || null
      if (!ts) { skipped.push({ section: 'pet-state.json', reason: 'diary_entry_without_time', key }); continue }
      const bodyRef = gw.putPayload(JSON.stringify(typeof row === 'string' ? { text: row } : row), 'episode')
      gw.insertEpisode({
        episodeId: deterministicId('ep', 'legacy-' + key + ':' + hash(text).slice(0, 16)), characterId,
        world: 'virtual', title: String(text).slice(0, 120), bodyRef, status: 'active',
        occurredAt: ts, createdSeq: 0, sourceRefs: [],
      })
      inc('diaryEpisodes')
    }
  }

  function importLegacyTodos (gw, characterId, state, inc, skipped) {
    const rows = state && Array.isArray(state.todos) ? state.todos : []
    for (const todo of rows) {
      const text = typeof todo === 'string' ? todo : (todo && (todo.text || todo.title))
      if (!text) { skipped.push({ section: 'pet-state.json', reason: 'todo_without_text' }); continue }
      const concernId = deterministicId('concern', 'todo:' + hash(String(text)).slice(0, 24))
      if (gw.getConcern(concernId)) { inc('concernsReused'); continue }
      gw.putConcern({
        concernId, characterId, topicKey: 'todo:' + hash(String(text)).slice(0, 24),
        subject: String(text).slice(0, 200), desiredOutcome: '完成主人记录的事项',
        status: (todo && todo.done) ? 'resolved' : 'open', priority: 0.6, origin: 'owner',
        createdAt: Number(todo && todo.createdAt) || clock(), nextCheckAt: null, expiresAt: null,
        lastContactAt: null, exitCondition: 'owner_confirms_done', revision: 1,
        body: { legacyTodo: todo }, sourceRefs: [], updatedSeq: 0,
      })
      inc('concerns')
    }
  }

  function importPlatformSources (gw, characterId, platform, deletedNow, inc, conflicts) {    const out = { count: 0, sourceIds: new Set() }
    if (!platform || !platform.sources || typeof platform.sources !== 'object') return out
    for (const [ref, row] of Object.entries(platform.sources)) {
      if (!row || typeof row !== 'object') continue
      if (deletedNow.has(ref)) continue
      const text = typeof row.text === 'string' ? row.text : ''
      const payloadRef = gw.putPayload(JSON.stringify({ text: text.slice(0, 8000), important: !!row.important }), 'episode')
      const source = gw.putSource({
        sourceId: ref, characterId, sourceKind: row.role === 'user' ? 'owner_message' : 'platform_source',
        world: row.role === 'user' ? 'user_report' : 'derived',
        trust: row.role === 'user' ? 'owner_statement' : 'interpretation',
        permission: 'granted', payloadRef, sourceHash: hash(text),
        occurredAt: Number(row.ts) || clock(), observedAt: Number(row.observedAt) || Number(row.ts) || clock(),
      })
      if (source) { out.sourceIds.add(ref); out.count++; inc('sources') }
    }
    return out
  }

  function importMemories (gw, characterId, memory, historySourceIds, platformSourceIds, deletedNow, inc, conflicts, skipped) {
    const out = { records: 0 }
    if (!memory) return out
    const rows = Array.isArray(memory.memories) ? memory.memories : []
    if (!Array.isArray(memory.memories)) conflicts.push({ section: 'memories.json', reason: 'memories_not_array' })
    for (const row of rows) {
      if (!row || typeof row.content !== 'string') continue
      out.records++
      const evidenceRefs = Array.isArray(row.evidenceRefs) ? row.evidenceRefs : []
      const messageRefs = evidenceRefs.map(ref => (ref && (ref.messageRef || ref.eventRef)) || (typeof ref === 'string' ? ref : null)).filter(Boolean)
      const known = messageRefs.filter(ref => historySourceIds.has(ref) || platformSourceIds.has(ref))
      const forgotten = messageRefs.some(ref => deletedNow.has(ref))
      if (forgotten) { skipped.push({ section: 'memories.json', reason: 'forgotten_evidence', id: row.id }); continue }

      const memoryId = typeof row.id === 'string' && isSafeId(row.id, 200) ? row.id : deterministicId('mem', hash(row.content).slice(0, 24))
      const bodyRef = gw.putPayload(JSON.stringify({
        content: row.content, originalContent: row.originalContent || row.content, tags: row.tags || [],
        emotionalContext: row.emotionalContext || {}, recallCount: row.recallCount || 0,
      }), 'episode')

      // 有 subjectKey/propertyKey 的记忆才可能成为结构化事实候选；否则是经历/解释。
      if (row.subjectKey && row.propertyKey) {
        const assertionId = deterministicId('asr', memoryId)
        const existing = gw.getAssertion(assertionId)
        if (existing) {
          if (JSON.stringify(existing.value) !== JSON.stringify(row.valueKey)) {
            conflicts.push({ section: 'memories.json', reason: 'assertion_value_conflict', assertionId })
          } else { inc('assertionsReused') }
        } else {
          gw.insertAssertion({
            assertionId, characterId, subject: String(row.subjectKey).slice(0, 120),
            predicate: String(row.propertyKey).slice(0, 120), value: row.valueKey === undefined ? row.content : row.valueKey,
            scope: 'owner', world: 'user_report',
            trust: known.length ? 'owner_statement' : 'interpretation',
            status: 'current', confidence: Number(row.confidence) || (known.length ? 0.75 : 0.5),
            confidenceClass: known.length ? 'reported' : 'legacy_unverified',
            memoryLifecycle: row.status === 'suppressed' ? 'forgotten' : (row.status === 'archived' ? 'archived' : (row.status === 'fading' ? 'fading' : 'active')),
            sourceRefs: known, quoteSpan: null, createdSeq: 0, updatedSeq: 0,
            validFrom: Number(row.createdAt) || null,
          })
          for (const ref of known) gw.addEvidence(assertionId, ref, 'supports', 0)
          inc('assertions')
        }
      } else {
        const episodeId = deterministicId('ep', memoryId)
        gw.insertEpisode({
          episodeId, characterId, world: row.sourceType === 'event' ? 'desktop_observed' : 'virtual',
          title: String(row.content).slice(0, 120), bodyRef, status: 'active',
          occurredAt: Number(row.createdAt) || clock(), createdSeq: 0, sourceRefs: known,
        })
        for (const ref of known) gw.addEvidence(episodeId, ref, 'supports', 0)
        inc('episodes')
      }

      if (row.type === 'preference' || row.type === 'relationship' || row.type === 'milestone') {
        const appraisalId = deterministicId('apr', memoryId)
        gw.insertAppraisal({
          appraisalId, characterId, episodeId: null, bodyRef, status: 'active',
          confidenceClass: known.length ? 'interpretation' : 'legacy_unverified',
          createdSeq: 0, sourceRefs: known, evidence: { type: row.type, importance: row.importance },
        })
        for (const ref of known) gw.addEvidence(appraisalId, ref, 'supports', 0)
        inc('appraisals')
      }
      if (!known.length) inc('legacyUnverified')
    }
    return out
  }

  function importLife (gw, characterId, life, deletedNow, inc, conflicts, skipped) {
    const out = { records: 0 }
    if (!life) return out
    const hidden = row => {
      const refs = [row && row.messageRef, ...((row && (row.refs || row.sourceRefs)) || [])].filter(Boolean)
      return refs.some(ref => deletedNow.has(ref) || deletedNow.has(String(ref).replace(/^(conversation:|event:)/, '')))
    }
    for (const thread of Array.isArray(life.threads) ? life.threads : []) {
      if (!thread || hidden(thread)) continue
      out.records++
      const concernId = deterministicId('concern', String(thread.id || thread.topicKey || thread.subject || JSON.stringify(thread).slice(0, 120)))
      const existing = gw.getConcern(concernId)
      if (existing) { inc('concernsReused'); continue }
      gw.putConcern({
        concernId, characterId,
        topicKey: String(thread.topicKey || thread.id || 'legacy-thread').slice(0, 160),
        subject: String(thread.subject || thread.topic || thread.summary || '未命名关注').slice(0, 200),
        desiredOutcome: String(thread.desiredOutcome || thread.wish || thread.summary || '').slice(0, 400),
        status: ['open', 'deferred', 'resolved', 'cancelled', 'expired'].includes(thread.status) ? thread.status : 'open',
        priority: Number(thread.priority) || 0.5, origin: thread.origin === 'owner' ? 'owner' : 'legacy',
        createdAt: Number(thread.createdAt) || clock(),
        nextCheckAt: Number(thread.nextCheckAt) || null, expiresAt: Number(thread.expiresAt) || null,
        lastContactAt: Number(thread.lastContactAt) || null, exitCondition: thread.exitCondition || null,
        revision: 1, body: { legacy: thread }, sourceRefs: (thread.sourceRefs || thread.refs || []).filter(isSafeId),
        updatedSeq: 0,
      })
      inc('concerns')
    }
    for (const project of Array.isArray(life.activities) ? life.activities : []) {
      if (!project || hidden(project)) continue
      out.records++
      const projectId = deterministicId('project', String(project.id || JSON.stringify(project).slice(0, 120)))
      if (gw.getProject(projectId)) { inc('projectsReused'); continue }
      gw.putProject({
        projectId, characterId, goal: String(project.title || project.goal || '未命名活动').slice(0, 300),
        recipeId: 'legacy.activity', recipeVersion: 1, stepCursor: 0,
        status: project.completedAt ? 'completed' : 'paused', artifactRefs: [],
        nextWakeAt: null, deadline: null, revision: 1, origin: 'legacy',
        body: { legacy: project }, sourceRefs: (project.sourceRefs || []).filter(isSafeId), updatedSeq: 0,
      })
      inc('projects')
    }
    for (const day of Array.isArray(life.days) ? life.days : []) {
      for (const key of ['experiences', 'activities']) {
        for (const row of Array.isArray(day && day[key]) ? day[key] : []) {
          if (!row || hidden(row)) continue
          out.records++
          const bodyRef = gw.putPayload(JSON.stringify(row), 'episode')
          const episodeId = deterministicId('ep', String(day.date) + ':' + key + ':' + (row.id || row.text || ''))
          gw.insertEpisode({
            episodeId, characterId, world: 'virtual', title: String(row.text || row.title || key).slice(0, 120),
            bodyRef, status: 'active', occurredAt: Number(row.ts) || Date.parse(day.date) || clock(),
            createdSeq: 0, sourceRefs: (row.sourceRefs || []).filter(isSafeId),
          })
          inc('episodes')
        }
      }
    }
    for (const artifact of Array.isArray(life.artifacts) ? life.artifacts : []) {
      if (!artifact || hidden(artifact)) continue
      const relativePath = String(artifact.path || artifact.relativePath || '')
      if (!relativePath) { skipped.push({ section: 'pet-life.json', reason: 'artifact_without_path', id: artifact.id }); continue }
      gw.putArtifact({
        artifactId: deterministicId('art', String(artifact.id || relativePath)), characterId,
        kind: String(artifact.kind || 'virtual_note').slice(0, 60), relativePath,
        hash: String(artifact.hash || ''), world: 'virtual',
        sourceRefs: (artifact.sourceRefs || []).filter(isSafeId), createdAt: Number(artifact.createdAt) || clock(), verified: false,
      })
      inc('artifacts')
    }
    return out
  }

  function importPlatformDomain (gw, characterId, platform, deletedNow, inc, conflicts, skipped) {
    const out = { operations: 0 }
    if (!platform) return out
    const visible = refs => !(refs || []).some(ref => deletedNow.has(ref))

    for (const [id, op] of Object.entries(platform.operations || {})) {
      if (!op || typeof op !== 'object') continue
      if (!visible(op.sourceRefs)) continue
      out.operations++
      const mapped = mapLegacyOperationStatus(op)
      const operationId = String(id).slice(0, 200)
      if (gw.getOperation(operationId)) { inc('operationsReused'); continue }
      gw.putOperation({
        operationId, characterId, inputHash: hash(op.input === undefined ? op.id : op.input),
        capabilityId: String(op.capabilityId || 'legacy.unknown').slice(0, 160),
        capabilityVersion: Number(op.version) || 1, provider: String(op.provider || 'legacy').slice(0, 160),
        effect: op.effect === 'action' ? 'external-unknown' : (['read', 'internal', 'virtual', 'external-idempotent', 'external-unknown'].includes(op.effect) ? op.effect : 'internal'),
        scope: [], status: mapped.status, epoch: 0,
        deadline: Number(op.expiresAt) || null, receiptRef: null, attempts: Number(op.attempts) || 0,
        planRevision: null, unknownReason: mapped.reason, dedupeKey: null,
      })
      if (mapped.status === 'succeeded' && op.receipt) {
        const receiptRef = gw.putPayload(JSON.stringify(op.receipt), 'operation')
        gw.patchOperation(operationId, { receiptRef })
      }
      inc('operations')
    }

    for (const [id, concern] of Object.entries(platform.concerns || {})) {
      if (!concern || !visible(concern.sourceRefs)) continue
      const concernId = deterministicId('concern', 'platform:' + id)
      if (gw.getConcern(concernId)) { inc('concernsReused'); continue }
      gw.putConcern({
        concernId, characterId, topicKey: String(concern.topicKey || id).slice(0, 160),
        subject: String(concern.subject || concern.topic || '未命名关注').slice(0, 200),
        desiredOutcome: String(concern.desiredOutcome || '').slice(0, 400),
        status: ['open', 'deferred', 'resolved', 'cancelled', 'expired'].includes(concern.status) ? concern.status : 'open',
        priority: Number(concern.priority) || 0.5, origin: 'legacy', createdAt: Number(concern.createdAt) || clock(),
        nextCheckAt: Number(concern.nextCheckAt) || null, expiresAt: Number(concern.expiresAt) || null,
        lastContactAt: null, exitCondition: concern.exitCondition || null, revision: 1,
        body: { legacy: concern }, sourceRefs: (concern.sourceRefs || []).filter(isSafeId), updatedSeq: 0,
      })
      inc('concerns')
    }

    for (const [id, project] of Object.entries(platform.projects || {})) {
      if (!project || !visible(project.sourceRefs)) continue
      const projectId = deterministicId('project', 'platform:' + id)
      if (gw.getProject(projectId)) { inc('projectsReused'); continue }
      gw.putProject({
        projectId, characterId, goal: String(project.goal || project.title || '未命名项目').slice(0, 300),
        recipeId: String(project.recipeId || 'legacy.project').slice(0, 120), recipeVersion: Number(project.recipeVersion) || 1,
        stepCursor: Number(project.stepCursor) || 0,
        status: ['proposed', 'active', 'paused', 'completed', 'abandoned', 'expired'].includes(project.status) ? project.status : 'paused',
        artifactRefs: (project.artifactRefs || []).filter(isSafeId), nextWakeAt: null, deadline: Number(project.deadline) || null,
        revision: 1, origin: 'legacy', body: { legacy: project }, sourceRefs: (project.sourceRefs || []).filter(isSafeId), updatedSeq: 0,
      })
      inc('projects')
    }

    for (const [id, appraisal] of Object.entries(platform.appraisals || {})) {
      if (!appraisal || !visible(appraisal.sourceRefs)) continue
      const appraisalId = deterministicId('apr', 'platform:' + id)
      gw.insertAppraisal({
        appraisalId, characterId, episodeId: null,
        bodyRef: gw.putPayload(JSON.stringify(appraisal), 'episode'), status: 'active',
        confidenceClass: 'interpretation', createdSeq: 0,
        sourceRefs: (appraisal.sourceRefs || []).filter(isSafeId), evidence: {},
      })
      inc('appraisals')
    }

    if (platform.packages && Object.keys(platform.packages).length) {
      skipped.push({ section: 'character-platform.json', reason: 'packages_not_imported_run_k5', count: Object.keys(platform.packages).length })
    }
    return out
  }

  return { run, readAll, mapLegacyOperationStatus, LEGACY_FILES }
}

module.exports = { createImporter, LEGACY_FILES, mapLegacyOperationStatus, readLegacyFile, collectSuppressedMemoryRefs }
