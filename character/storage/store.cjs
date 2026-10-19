'use strict'
/**
 * K1 ContinuityStore：角色数据库唯一写入门面。
 *
 * 设计要点（总规 §11.1 / §11.2 / §9.3）：
 *  - 单次命令事务：BEGIN IMMEDIATE → 校验去重/版本/epoch → 写事件/状态/实体 → 写 outbox/job → COMMIT。
 *    事务内不请求模型、不派发能力、不播放动画（不变量 9）。
 *  - 本模块只提供 SQL 网关与事务外壳；领域规则在 domain/、memory/、behavior/ 中，保持纯函数。
 *  - 事件 seq 是提交顺序（唯一单调时间轴）；occurredAt 只是“所描述的发生时间”。
 *  - 写入失败必须向上返回结构化错误，不能让调用方误以为“已记住”。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { openDatabase } = require('./driver.cjs')
const { hash } = require('../ids.cjs')

const SCHEMA_FILE = path.join(__dirname, 'schema.sql')
const INITIAL_MIGRATION = '0001_initial'
const STORE_SCHEMA_VERSION = 1

const json = value => JSON.stringify(value === undefined ? null : value)
const parse = (text, fallback) => {
  if (typeof text !== 'string' || !text) return fallback
  try { return JSON.parse(text) } catch (_) { return fallback }
}
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

/**
 * SQL 网关：无状态，可在事务内或只读事务内使用。
 * 所有 JSON 列在这里序列化/反序列化，上层只看到普通对象。
 */
function createGateway (db, clock) {
  const now = () => clock()

  /* ---------------- meta / character ---------------- */
  const getMeta = key => {
    const row = db.get('SELECT value FROM meta WHERE key = ?', [key])
    return row ? row.value : null
  }
  const setMeta = (key, value) => {
    db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)])
  }

  const getCharacter = characterId => {
    const row = db.get('SELECT * FROM characters WHERE character_id = ?', [characterId])
    if (!row) return null
    return {
      characterId: row.character_id,
      identityRevision: row.identity_revision,
      revision: row.revision,
      writerEpoch: row.writer_epoch,
      createdAt: row.created_at,
    }
  }
  const putCharacter = character => {
    db.run(
      `INSERT INTO characters (character_id, identity_revision, revision, writer_epoch, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET
         identity_revision = excluded.identity_revision,
         revision = excluded.revision,
         writer_epoch = excluded.writer_epoch`,
      [character.characterId, character.identityRevision, character.revision, character.writerEpoch, character.createdAt],
    )
  }
  const bumpEpoch = characterId => {
    const current = getCharacter(characterId)
    if (!current) return null
    const next = { ...current, writerEpoch: current.writerEpoch + 1 }
    putCharacter(next)
    return next
  }

  const putIdentityRevision = row => {
    db.run(
      `INSERT INTO identity_revisions (character_id, revision, display_name, definition_json, hash, reason, source_refs_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(character_id, revision) DO NOTHING`,
      [row.characterId, row.revision, row.displayName, json(row.definition), row.hash, row.reason, json(row.sourceRefs || []), row.createdAt],
    )
  }
  const latestIdentity = characterId => {
    const row = db.get('SELECT * FROM identity_revisions WHERE character_id = ? ORDER BY revision DESC LIMIT 1', [characterId])
    if (!row) return null
    return {
      characterId: row.character_id,
      revision: row.revision,
      displayName: row.display_name,
      definition: parse(row.definition_json, {}),
      hash: row.hash,
      reason: row.reason,
      sourceRefs: parse(row.source_refs_json, []),
      createdAt: row.created_at,
    }
  }

  /* ---------------- payloads / sources ---------------- */
  const putPayload = (body, retentionClass) => {
    const text = typeof body === 'string' ? body : json(body)
    const payloadId = 'pl:' + hash(text)
    db.run(
      `INSERT INTO payloads (payload_id, body, content_hash, retention_class, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(payload_id) DO UPDATE SET body = excluded.body, deleted_at = NULL`,
      [payloadId, text, hash(text), retentionClass, now()],
    )
    return payloadId
  }
  const getPayload = payloadId => {
    const row = db.get('SELECT * FROM payloads WHERE payload_id = ?', [payloadId])
    if (!row || row.deleted_at) return null
    return { payloadId: row.payload_id, body: row.body, contentHash: row.content_hash, retentionClass: row.retention_class, createdAt: row.created_at }
  }
  const deletePayload = payloadId => {
    db.run('UPDATE payloads SET deleted_at = ?, body = \'\' WHERE payload_id = ? AND deleted_at IS NULL', [now(), payloadId])
  }

  const putSource = row => {
    db.run(
      `INSERT INTO sources (source_id, character_id, source_kind, world, trust, permission, payload_ref, source_hash, occurred_at, observed_at, committed_seq, permission_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO NOTHING`,
      [row.sourceId, row.characterId, row.sourceKind, row.world, row.trust, row.permission, row.payloadRef || null,
        row.sourceHash, row.occurredAt, row.observedAt, row.committedSeq || null, row.permissionRef || null],
    )
    return getSource(row.sourceId)
  }
  const getSource = sourceId => {
    const row = db.get('SELECT * FROM sources WHERE source_id = ?', [sourceId])
    if (!row) return null
    return {
      sourceId: row.source_id,
      characterId: row.character_id,
      sourceKind: row.source_kind,
      world: row.world,
      trust: row.trust,
      permission: row.permission,
      payloadRef: row.payload_ref,
      sourceHash: row.source_hash,
      occurredAt: row.occurred_at,
      observedAt: row.observed_at,
      committedSeq: row.committed_seq,
      permissionRef: row.permission_ref,
    }
  }
  const setSourcePermission = (sourceId, permission) => {
    db.run('UPDATE sources SET permission = ? WHERE source_id = ?', [permission, sourceId])
  }
  const listSources = (characterId, limit = 200) =>
    db.all('SELECT * FROM sources WHERE character_id = ? ORDER BY observed_at DESC LIMIT ?', [characterId, limit]).map(row => getSource(row.source_id))

  /* ---------------- events ---------------- */
  const appendEvent = event => {
    const existing = db.get('SELECT seq, event_id FROM events WHERE event_id = ?', [event.eventId])
    if (existing) return { seq: existing.seq, duplicate: true }
    if (event.sourceId && event.sourceEventId) {
      const dup = db.get('SELECT seq FROM events WHERE character_id = ? AND source_id = ? AND source_event_id = ?',
        [event.characterId, event.sourceId, event.sourceEventId])
      if (dup) return { seq: dup.seq, duplicate: true }
    }
    db.run(
      `INSERT INTO events (event_id, character_id, kind, source_id, payload_ref, world, trust, causation_id, correlation_id,
        source_event_id, occurred_at, observed_at, committed_at, timezone, retention_class, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.eventId, event.characterId, event.kind, event.sourceId || null, event.payloadRef || null, event.world, event.trust,
        event.causationId || null, event.correlationId, event.sourceEventId || null, event.occurredAt, event.observedAt,
        event.committedAt, event.timezone, event.retentionClass, json(event.evidenceRefs || [])],
    )
    const row = db.get('SELECT seq FROM events WHERE event_id = ?', [event.eventId])
    return { seq: row ? row.seq : null, duplicate: false }
  }
  const lastSeq = characterId => {
    const row = characterId
      ? db.get('SELECT MAX(seq) AS s FROM events WHERE character_id = ?', [characterId])
      : db.get('SELECT MAX(seq) AS s FROM events')
    return { seq: row && row.s != null ? num(row.s) : 0 }
  }
  const getEvent = seq => {
    const row = db.get('SELECT * FROM events WHERE seq = ?', [seq])
    if (!row) return null
    return {
      seq: row.seq,
      eventId: row.event_id,
      characterId: row.character_id,
      kind: row.kind,
      sourceId: row.source_id,
      payloadRef: row.payload_ref,
      world: row.world,
      trust: row.trust,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      sourceEventId: row.source_event_id,
      occurredAt: row.occurred_at,
      observedAt: row.observed_at,
      committedAt: row.committed_at,
      timezone: row.timezone,
      retentionClass: row.retention_class,
      evidenceRefs: parse(row.evidence_json, []),
    }
  }
  const listEvents = (characterId, limit = 100) =>
    db.all('SELECT seq FROM events WHERE character_id = ? ORDER BY seq DESC LIMIT ?', [characterId, limit]).map(row => getEvent(row.seq))

  /* ---------------- state ---------------- */
  const getState = characterId => {
    const row = db.get('SELECT * FROM state WHERE character_id = ?', [characterId])
    if (!row) return null
    return {
      characterId: row.character_id,
      revision: row.revision,
      identityRevision: row.identity_revision,
      schemaVersion: row.schema_version,
      body: parse(row.body_json, {}),
      seq: row.updated_seq,
    }
  }
  const writeState = row => {
    db.run(
      `INSERT INTO state (character_id, revision, identity_revision, schema_version, body_json, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET
         revision = excluded.revision,
         identity_revision = excluded.identity_revision,
         schema_version = excluded.schema_version,
         body_json = excluded.body_json,
         updated_seq = excluded.updated_seq`,
      [row.characterId, row.revision, row.identityRevision, row.schemaVersion, json(row.body), row.seq],
    )
  }

  /* ---------------- assertions ---------------- */
  const mapAssertion = row => row && ({
    assertionId: row.assertion_id,
    characterId: row.character_id,
    subject: row.subject,
    predicate: row.predicate,
    value: parse(row.value_json, null),
    scope: row.scope,
    world: row.world,
    trust: row.trust,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    supersededBy: row.superseded_by,
    confidence: row.confidence,
    confidenceClass: row.confidence_class,
    memoryLifecycle: row.memory_lifecycle,
    sourceRefs: parse(row.source_refs_json, []),
    quoteSpan: parse(row.quote_span_json, null),
    createdSeq: row.created_seq,
    updatedSeq: row.updated_seq,
  })
  const insertAssertion = row => {
    db.run(
      `INSERT INTO assertions (assertion_id, character_id, subject, predicate, value_json, scope, world, trust, valid_from, valid_to,
        status, superseded_by, confidence, confidence_class, memory_lifecycle, source_refs_json, quote_span_json, created_seq, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(assertion_id) DO NOTHING`,
      [row.assertionId, row.characterId, row.subject, row.predicate, json(row.value), row.scope || 'owner', row.world, row.trust,
        row.validFrom === undefined ? null : row.validFrom, row.validTo === undefined ? null : row.validTo,
        row.status || 'current', row.supersededBy || null, num(row.confidence, 0.5), row.confidenceClass || 'reported',
        row.memoryLifecycle || 'active', json(row.sourceRefs || []), row.quoteSpan ? json(row.quoteSpan) : null,
        row.createdSeq, row.updatedSeq === undefined ? row.createdSeq : row.updatedSeq],
    )
    return getAssertion(row.assertionId)
  }
  const getAssertion = assertionId => mapAssertion(db.get('SELECT * FROM assertions WHERE assertion_id = ?', [assertionId]))
  const findCurrentAssertions = (characterId, subject, predicate, scope) => db.all(
    `SELECT * FROM assertions WHERE character_id = ? AND subject = ? AND predicate = ? AND scope = ?
      AND status IN ('current', 'conflicted') ORDER BY created_seq DESC`,
    [characterId, subject, predicate, scope || 'owner'],
  ).map(mapAssertion)
  const supersedeAssertion = (oldId, newId, seq) => {
    db.run("UPDATE assertions SET status = 'superseded', superseded_by = ?, updated_seq = ? WHERE assertion_id = ?", [newId, seq, oldId])
  }
  const setAssertionStatus = (assertionId, status, seq, lifecycle) => {
    if (lifecycle) db.run('UPDATE assertions SET status = ?, memory_lifecycle = ?, updated_seq = ? WHERE assertion_id = ?', [status, lifecycle, seq, assertionId])
    else db.run('UPDATE assertions SET status = ?, updated_seq = ? WHERE assertion_id = ?', [status, seq, assertionId])
  }
  const listAssertions = (characterId, filters = {}) => {
    const clauses = ['character_id = ?']
    const params = [characterId]
    if (filters.status) { clauses.push('status = ?'); params.push(filters.status) }
    if (filters.lifecycleIn && filters.lifecycleIn.length) {
      clauses.push('memory_lifecycle IN (' + filters.lifecycleIn.map(() => '?').join(',') + ')')
      params.push(...filters.lifecycleIn)
    }
    if (filters.subject) { clauses.push('subject = ?'); params.push(filters.subject) }
    if (filters.trustIn && filters.trustIn.length) {
      clauses.push('trust IN (' + filters.trustIn.map(() => '?').join(',') + ')')
      params.push(...filters.trustIn)
    }
    clauses.push('(valid_to IS NULL OR valid_to > ?)')
    params.push(filters.asOf || now())
    params.push(Math.min(Number(filters.limit) || 200, 500))
    return db.all('SELECT * FROM assertions WHERE ' + clauses.join(' AND ') + ' ORDER BY created_seq DESC LIMIT ?', params).map(mapAssertion)
  }

  /* ---------------- evidence edges ---------------- */
  const addEvidence = (derivedId, sourceId, relation, seq) => {
    db.run('INSERT INTO evidence_edges (derived_id, source_id, relation, created_seq) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [derivedId, sourceId, relation, seq])
  }
  const listEvidenceSources = derivedId => db.all('SELECT source_id, relation FROM evidence_edges WHERE derived_id = ?', [derivedId])
  const listDerivedBySource = sourceId => db.all('SELECT derived_id, relation FROM evidence_edges WHERE source_id = ?', [sourceId])
  const clearEvidenceFor = derivedId => { db.run('DELETE FROM evidence_edges WHERE derived_id = ?', [derivedId]) }

  /* ---------------- episodes / appraisals ---------------- */
  const insertEpisode = row => {
    db.run(
      `INSERT INTO episodes (episode_id, character_id, world, title, body_ref, status, occurred_at, created_seq, source_refs_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(episode_id) DO NOTHING`,
      [row.episodeId, row.characterId, row.world, row.title, row.bodyRef || null, row.status || 'active', row.occurredAt, row.createdSeq, json(row.sourceRefs || [])],
    )
  }
  const listEpisodes = (characterId, limit = 50) => db.all(
    "SELECT * FROM episodes WHERE character_id = ? AND status = 'active' ORDER BY occurred_at DESC LIMIT ?",
    [characterId, Math.min(Number(limit) || 50, 200)],
  ).map(row => ({
    episodeId: row.episode_id, characterId: row.character_id, world: row.world, title: row.title,
    bodyRef: row.body_ref, status: row.status, occurredAt: row.occurred_at, createdSeq: row.created_seq,
    sourceRefs: parse(row.source_refs_json, []),
  }))
  const setEpisodeStatus = (episodeId, status) => { db.run('UPDATE episodes SET status = ? WHERE episode_id = ?', [status, episodeId]) }
  const insertAppraisal = row => {
    db.run(
      `INSERT INTO appraisals (appraisal_id, character_id, episode_id, body_ref, status, confidence_class, created_seq, source_refs_json, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(appraisal_id) DO NOTHING`,
      [row.appraisalId, row.characterId, row.episodeId || null, row.bodyRef || null, row.status || 'active',
        row.confidenceClass || 'interpretation', row.createdSeq, json(row.sourceRefs || []), json(row.evidence || {})],
    )
  }
  const invalidateDerived = (derivedId, seq) => {
    // 被撤销来源的无支持派生物：失活而不是盲删，保留“曾经存在”的痕迹。
    db.run("UPDATE appraisals SET status = 'invalidated' WHERE appraisal_id = ?", [derivedId])
    db.run("UPDATE episodes SET status = 'invalidated' WHERE episode_id = ?", [derivedId])
    db.run("UPDATE assertions SET status = 'invalidated', updated_seq = ? WHERE assertion_id = ?", [seq, derivedId])
    const bodies = db.all('SELECT body_ref FROM episodes WHERE episode_id = ? UNION SELECT body_ref FROM appraisals WHERE appraisal_id = ?', [derivedId, derivedId])
    for (const row of bodies) if (row.body_ref) deletePayload(row.body_ref)
    db.run("UPDATE assertions SET value_json = 'null', quote_span_json = NULL, memory_lifecycle = 'forgotten' WHERE assertion_id = ?", [derivedId])
  }

  /* ---------------- concerns / projects ---------------- */
  const mapConcern = row => row && ({
    concernId: row.concern_id,
    characterId: row.character_id,
    topicKey: row.topic_key,
    subject: row.subject,
    desiredOutcome: row.desired_outcome,
    status: row.status,
    priority: row.priority,
    origin: row.origin,
    createdAt: row.created_at,
    nextCheckAt: row.next_check_at,
    expiresAt: row.expires_at,
    lastContactAt: row.last_contact_at,
    exitCondition: row.exit_condition,
    revision: row.revision,
    body: parse(row.body_json, {}),
    sourceRefs: parse(row.source_refs_json, []),
    updatedSeq: row.updated_seq,
  })
  const putConcern = row => {
    db.run(
      `INSERT INTO concerns (concern_id, character_id, topic_key, subject, desired_outcome, status, priority, origin, created_at,
        next_check_at, expires_at, last_contact_at, exit_condition, revision, body_json, source_refs_json, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(concern_id) DO UPDATE SET
         desired_outcome = excluded.desired_outcome, status = excluded.status, priority = excluded.priority,
         next_check_at = excluded.next_check_at, expires_at = excluded.expires_at, last_contact_at = excluded.last_contact_at,
         exit_condition = excluded.exit_condition, revision = excluded.revision, body_json = excluded.body_json,
         source_refs_json = excluded.source_refs_json, updated_seq = excluded.updated_seq`,
      [row.concernId, row.characterId, row.topicKey, row.subject, row.desiredOutcome, row.status, num(row.priority, 0.5),
        row.origin || 'self', row.createdAt, row.nextCheckAt === undefined ? null : row.nextCheckAt,
        row.expiresAt === undefined ? null : row.expiresAt, row.lastContactAt === undefined ? null : row.lastContactAt,
        row.exitCondition || null, row.revision, json(row.body || {}), json(row.sourceRefs || []), row.updatedSeq],
    )
    return getConcern(row.concernId)
  }
  const getConcern = concernId => mapConcern(db.get('SELECT * FROM concerns WHERE concern_id = ?', [concernId]))
  const findConcernByTopic = (characterId, topicKey) => mapConcern(db.get('SELECT * FROM concerns WHERE character_id = ? AND topic_key = ?', [characterId, topicKey]))
  const listConcerns = (characterId, filters = {}) => {
    const clauses = ['character_id = ?']
    const params = [characterId]
    if (filters.statusIn && filters.statusIn.length) {
      clauses.push('status IN (' + filters.statusIn.map(() => '?').join(',') + ')')
      params.push(...filters.statusIn)
    }
    if (filters.dueBefore !== undefined) { clauses.push('next_check_at IS NOT NULL AND next_check_at <= ?'); params.push(filters.dueBefore) }
    if (filters.origin) { clauses.push('origin = ?'); params.push(filters.origin) }
    params.push(Math.min(Number(filters.limit) || 100, 400))
    return db.all('SELECT * FROM concerns WHERE ' + clauses.join(' AND ') + ' ORDER BY priority DESC, next_check_at ASC LIMIT ?', params)
      .map(mapConcern)
  }
  const countConcerns = (characterId, statusIn, origin) => {
    const clauses = ['character_id = ?']
    const params = [characterId]
    if (statusIn && statusIn.length) {
      clauses.push('status IN (' + statusIn.map(() => '?').join(',') + ')')
      params.push(...statusIn)
    }
    if (origin) { clauses.push('origin = ?'); params.push(origin) }
    const row = db.get('SELECT COUNT(*) AS c FROM concerns WHERE ' + clauses.join(' AND '), params)
    return row ? num(row.c) : 0
  }

  const mapProject = row => row && ({
    projectId: row.project_id,
    characterId: row.character_id,
    goal: row.goal,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    stepCursor: row.step_cursor,
    status: row.status,
    artifactRefs: parse(row.artifact_refs_json, []),
    nextWakeAt: row.next_wake_at,
    deadline: row.deadline,
    revision: row.revision,
    origin: row.origin,
    body: parse(row.body_json, {}),
    sourceRefs: parse(row.source_refs_json, []),
    updatedSeq: row.updated_seq,
  })
  const putProject = row => {
    db.run(
      `INSERT INTO projects (project_id, character_id, goal, recipe_id, recipe_version, step_cursor, status, artifact_refs_json,
        next_wake_at, deadline, revision, origin, body_json, source_refs_json, updated_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         goal = excluded.goal, recipe_id = excluded.recipe_id, recipe_version = excluded.recipe_version,
         step_cursor = excluded.step_cursor, status = excluded.status, artifact_refs_json = excluded.artifact_refs_json,
         next_wake_at = excluded.next_wake_at, deadline = excluded.deadline, revision = excluded.revision,
         body_json = excluded.body_json, source_refs_json = excluded.source_refs_json, updated_seq = excluded.updated_seq`,
      [row.projectId, row.characterId, row.goal, row.recipeId, row.recipeVersion, row.stepCursor || 0, row.status,
        json(row.artifactRefs || []), row.nextWakeAt === undefined ? null : row.nextWakeAt,
        row.deadline === undefined ? null : row.deadline, row.revision, row.origin || 'self',
        json(row.body || {}), json(row.sourceRefs || []), row.updatedSeq],
    )
    return getProject(row.projectId)
  }
  const getProject = projectId => mapProject(db.get('SELECT * FROM projects WHERE project_id = ?', [projectId]))
  const listProjects = (characterId, filters = {}) => {
    const clauses = ['character_id = ?']
    const params = [characterId]
    if (filters.statusIn && filters.statusIn.length) {
      clauses.push('status IN (' + filters.statusIn.map(() => '?').join(',') + ')')
      params.push(...filters.statusIn)
    }
    if (filters.wakeBefore !== undefined) { clauses.push('next_wake_at IS NOT NULL AND next_wake_at <= ?'); params.push(filters.wakeBefore) }
    params.push(Math.min(Number(filters.limit) || 50, 200))
    return db.all('SELECT * FROM projects WHERE ' + clauses.join(' AND ') + ' ORDER BY next_wake_at ASC LIMIT ?', params).map(mapProject)
  }
  const countProjects = (characterId, statusIn, origin) => {
    const clauses = ['character_id = ?']
    const params = [characterId]
    if (statusIn && statusIn.length) {
      clauses.push('status IN (' + statusIn.map(() => '?').join(',') + ')')
      params.push(...statusIn)
    }
    if (origin) { clauses.push('origin = ?'); params.push(origin) }
    const row = db.get('SELECT COUNT(*) AS c FROM projects WHERE ' + clauses.join(' AND '), params)
    return row ? num(row.c) : 0
  }

  /* ---------------- jobs ---------------- */
  const putJob = row => {
    db.run(
      `INSERT INTO jobs (job_id, dedupe_key, character_id, kind, due_at, status, attempts, payload_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET due_at = MIN(due_at, excluded.due_at)`,
      [row.jobId, row.dedupeKey, row.characterId, row.kind, row.dueAt, row.payloadRef || null, now(), now()],
    )
    return db.get('SELECT * FROM jobs WHERE dedupe_key = ?', [row.dedupeKey])
  }
  /**
   * 重排一个已有 job（自调度用）：明确把 due_at 换成新值并回到 pending。
   * 与 putJob 的区别很重要：putJob 取 MIN（“确保已安排”），
   * rescheduleJob 取新值（“下一次就是这时”）。混用会导致自身立刻重跑或永远不跑。
   */
  const rescheduleJob = row => {
    db.run(
      `INSERT INTO jobs (job_id, dedupe_key, character_id, kind, due_at, status, attempts, payload_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         due_at = excluded.due_at,
         status = 'pending',
         attempts = 0,
         payload_ref = COALESCE(excluded.payload_ref, payload_ref),
         lease_epoch = NULL,
         lease_until = NULL,
         updated_at = excluded.updated_at`,
      [row.jobId, row.dedupeKey, row.characterId, row.kind, row.dueAt, row.payloadRef || null, now(), now()],
    )
    return db.get('SELECT * FROM jobs WHERE dedupe_key = ?', [row.dedupeKey])
  }
  const listDueJobs = (characterId, dueBefore, limit = 8) => db.all(
    "SELECT * FROM jobs WHERE character_id = ? AND status = 'pending' AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
    [characterId, dueBefore, limit],
  ).map(mapJob)
  const claimJob = (jobId, epoch, leaseUntil) => {
    const result = db.run(
      "UPDATE jobs SET status = 'leased', lease_epoch = ?, lease_until = ?, updated_at = ? WHERE job_id = ? AND status = 'pending'",
      [epoch, leaseUntil, now(), jobId],
    )
    return !!(result && (result.changes === undefined || result.changes > 0))
  }
  const finishJob = (jobId, status, error) => {
    db.run('UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE job_id = ?', [status, error || null, now(), jobId])
  }
  /** 只结束仍在 pending/leased 的 job，避免覆盖已经取消或重排的状态。 */
  const settleJob = (jobId, status, error) => {
    const result = db.run(
      "UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE job_id = ? AND status IN ('pending', 'leased')",
      [status, error || null, now(), jobId],
    )
    return !!(result && (result.changes === undefined || result.changes > 0))
  }
  const retryJob = (jobId, dueAt, error, attempts) => {
    db.run("UPDATE jobs SET status = 'pending', due_at = ?, last_error = ?, attempts = ?, lease_epoch = NULL, lease_until = NULL, updated_at = ? WHERE job_id = ?",
      [dueAt, error || null, attempts, now(), jobId])
  }
  const reclaimExpiredLeases = leaseCutoff => db.run(
    "UPDATE jobs SET status = 'pending', lease_epoch = NULL, lease_until = NULL WHERE status = 'leased' AND lease_until < ?",
    [leaseCutoff],
  )
  /**
   * 启动时收回**所有**租约：单写者刚完成 epoch 提升，上一进程必然已经死亡，
   * 因此不存在“另一个活着的租约持有者”。这比按时间判断更准确，
   * 避免崩溃前刚申请的 60s 租约把 job 卡住。
   */
  const reclaimAllLeases = characterId => {
    const result = db.run(
      "UPDATE jobs SET status = 'pending', lease_epoch = NULL, lease_until = NULL WHERE character_id = ? AND status = 'leased'",
      [characterId],
    )
    return result && Number.isFinite(Number(result.changes)) ? Number(result.changes) : 0
  }
  const nextDueAt = characterId => {
    const row = db.get("SELECT MIN(due_at) AS d FROM jobs WHERE character_id = ? AND status = 'pending'", [characterId])
    return row && row.d != null ? num(row.d) : null
  }
  /**
   * 取消与被遗忘来源相关的待办。job 的 dedupe_key / payload_ref 里包含来源 ID，
   * 因此用受限 LIKE 匹配；不做模糊“猜”，只按明确的 token 命中。
   */
  const cancelJobsMatching = (characterId, token) => {
    if (!characterId || typeof token !== 'string' || token.length < 4) return 0
    const escaped = token.replace(/[\\%_]/g, match => '\\' + match)
    const result = db.run(
      `UPDATE jobs SET status = 'cancelled', updated_at = ?, last_error = 'source_forgotten'
        WHERE character_id = ? AND status IN ('pending', 'leased')
          AND (dedupe_key LIKE ? ESCAPE '\\' OR payload_ref LIKE ? ESCAPE '\\')`,
      [now(), characterId, '%' + escaped + '%', '%' + escaped + '%'],
    )
    return result && Number.isFinite(Number(result.changes)) ? Number(result.changes) : 0
  }
  const mapJob = row => row && ({
    jobId: row.job_id, dedupeKey: row.dedupe_key, characterId: row.character_id, kind: row.kind, dueAt: row.due_at,
    leaseEpoch: row.lease_epoch, leaseUntil: row.lease_until, status: row.status, attempts: row.attempts,
    payloadRef: row.payload_ref, lastError: row.last_error,
  })

  /* ---------------- operations ---------------- */
  const mapOperation = row => row && ({
    operationId: row.operation_id, characterId: row.character_id, inputHash: row.input_hash,
    capabilityId: row.capability_id, capabilityVersion: row.capability_version, provider: row.provider,
    effect: row.effect, scope: parse(row.scope_json, []), status: row.status, epoch: row.epoch,
    deadline: row.deadline, receiptRef: row.receipt_ref, attempts: row.attempts, planRevision: row.plan_revision,
    createdAt: row.created_at, updatedAt: row.updated_at, unknownReason: row.unknown_reason, dedupeKey: row.dedupe_key,
  })
  const putOperation = row => {
    db.run(
      `INSERT INTO operations (operation_id, character_id, input_hash, capability_id, capability_version, provider, effect,
        scope_json, status, epoch, deadline, receipt_ref, attempts, plan_revision, created_at, updated_at, unknown_reason, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.operationId, row.characterId, row.inputHash, row.capabilityId, row.capabilityVersion, row.provider, row.effect,
        json(row.scope || []), row.status, row.epoch, row.deadline === undefined ? null : row.deadline, row.receiptRef || null,
        row.attempts || 0, row.planRevision === undefined ? null : row.planRevision, now(), now(),
        row.unknownReason || null, row.dedupeKey || null],
    )
    return getOperation(row.operationId)
  }
  const getOperation = operationId => mapOperation(db.get('SELECT * FROM operations WHERE operation_id = ?', [operationId]))
  const getOperationByDedupe = (characterId, dedupeKey) => mapOperation(
    db.get('SELECT * FROM operations WHERE character_id = ? AND dedupe_key = ?', [characterId, dedupeKey]),
  )
  const patchOperation = (operationId, patch) => {
    const fields = []
    const params = []
    const mapping = {
      status: 'status', receiptRef: 'receipt_ref', attempts: 'attempts', unknownReason: 'unknown_reason',
      deadline: 'deadline', planRevision: 'plan_revision', epoch: 'epoch',
    }
    for (const [key, column] of Object.entries(mapping)) {
      if (patch[key] !== undefined) { fields.push(column + ' = ?'); params.push(patch[key]) }
    }
    fields.push('updated_at = ?')
    params.push(now(), operationId)
    db.run('UPDATE operations SET ' + fields.join(', ') + ' WHERE operation_id = ?', params)
    return getOperation(operationId)
  }
  const listOperations = (characterId, statusIn, limit = 50) => {
    const clauses = ['character_id = ?']
    const params = [characterId]
    if (statusIn && statusIn.length) {
      clauses.push('status IN (' + statusIn.map(() => '?').join(',') + ')')
      params.push(...statusIn)
    }
    params.push(Math.min(Number(limit) || 50, 200))
    return db.all('SELECT * FROM operations WHERE ' + clauses.join(' AND ') + ' ORDER BY created_at ASC LIMIT ?', params).map(mapOperation)
  }
  const addAttempt = row => {
    db.run(
      `INSERT INTO operation_attempts (operation_id, attempt, epoch, started_at, ended_at, outcome, idempotency_key, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(operation_id, attempt) DO UPDATE SET
         ended_at = excluded.ended_at, outcome = excluded.outcome, detail_json = excluded.detail_json`,
      [row.operationId, row.attempt, row.epoch, row.startedAt, row.endedAt === undefined ? null : row.endedAt,
        row.outcome || null, row.idempotencyKey || null, row.detail ? json(row.detail) : null],
    )
  }

  /* ---------------- outbox ---------------- */
  const putOutbox = row => {
    db.run(
      `INSERT INTO outbox (dispatch_id, operation_id, channel, status, attempts, next_attempt_at, created_at, updated_at, last_error)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL) ON CONFLICT(dispatch_id) DO NOTHING`,
      [row.dispatchId, row.operationId, row.channel, row.status || 'pending', row.nextAttemptAt === undefined ? now() : row.nextAttemptAt, now(), now()],
    )
  }
  const listOutbox = (statusIn, limit = 20) => {
    const params = []
    let clause = ''
    if (statusIn && statusIn.length) {
      clause = ' WHERE status IN (' + statusIn.map(() => '?').join(',') + ')'
      params.push(...statusIn)
    }
    params.push(Math.min(Number(limit) || 20, 100))
    return db.all('SELECT * FROM outbox' + clause + ' ORDER BY next_attempt_at ASC LIMIT ?', params)
  }
  const patchOutbox = (dispatchId, patch) => {
    const fields = []
    const params = []
    for (const [key, column] of Object.entries({ status: 'status', attempts: 'attempts', nextAttemptAt: 'next_attempt_at', lastError: 'last_error' })) {
      if (patch[key] !== undefined) { fields.push(column + ' = ?'); params.push(patch[key]) }
    }
    if (!fields.length) return
    fields.push('updated_at = ?')
    params.push(now(), dispatchId)
    db.run('UPDATE outbox SET ' + fields.join(', ') + ' WHERE dispatch_id = ?', params)
  }
  const getOutboxForOperation = operationId => db.all('SELECT * FROM outbox WHERE operation_id = ?', [operationId])

  /* ---------------- deliveries ---------------- */
  const putDelivery = row => {
    const result = db.run(
      `INSERT INTO deliveries (presentation_id, channel, phase, operation_id, renderer_session, seq, at, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(presentation_id, channel, phase) DO NOTHING`,
      [row.presentationId, row.channel, row.phase, row.operationId || null, row.rendererSession || null,
        row.seq, row.at, row.detail ? json(row.detail) : null],
    )
    return !!(result && (result.changes === undefined || result.changes > 0))
  }
  const listDeliveries = (presentationId) => db.all('SELECT * FROM deliveries WHERE presentation_id = ?', [presentationId])

  /* ---------------- artifacts ---------------- */
  const putArtifact = row => {
    db.run(
      `INSERT INTO artifacts (artifact_id, character_id, kind, relative_path, hash, world, source_refs_json, created_at, verified, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(artifact_id) DO NOTHING`,
      [row.artifactId, row.characterId, row.kind, row.relativePath, row.hash, row.world,
        json(row.sourceRefs || []), row.createdAt || now(), row.verified ? 1 : 0],
    )
    return getArtifact(row.artifactId)
  }
  const getArtifact = artifactId => {
    const row = db.get('SELECT * FROM artifacts WHERE artifact_id = ?', [artifactId])
    if (!row) return null
    return {
      artifactId: row.artifact_id, characterId: row.character_id, kind: row.kind, relativePath: row.relative_path,
      hash: row.hash, world: row.world, sourceRefs: parse(row.source_refs_json, []), createdAt: row.created_at,
      verified: !!row.verified, deletedAt: row.deleted_at,
    }
  }
  const listArtifacts = (characterId, limit = 50) => db.all(
    'SELECT * FROM artifacts WHERE character_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
    [characterId, Math.min(Number(limit) || 50, 200)],
  ).map(row => getArtifact(row.artifact_id))
  // Unbounded lifecycle/export traversal is separate from bounded UI queries.
  const allArtifacts = characterId => db.all('SELECT artifact_id FROM artifacts WHERE character_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', [characterId]).map(row => getArtifact(row.artifact_id))
  const markArtifactDeleted = (artifactId) => db.run('UPDATE artifacts SET deleted_at = ? WHERE artifact_id = ?', [now(), artifactId])

  /* ---------------- command receipts / budget / observations ---------------- */
  const getCommandReceipt = commandId => {
    const row = db.get('SELECT * FROM command_receipts WHERE command_id = ?', [commandId])
    if (!row) return null
    return { commandId: row.command_id, inputHash: row.input_hash, acceptedAt: row.accepted_at, result: parse(row.result_json, null) }
  }
  const putCommandReceipt = row => {
    db.run('INSERT INTO command_receipts (command_id, input_hash, accepted_at, result_json) VALUES (?, ?, ?, ?) ON CONFLICT(command_id) DO NOTHING',
      [row.commandId, row.inputHash, row.acceptedAt, json(row.result)])
  }

  const consumeBudget = (windowKey, characterId, kind, windowStart, limit) => {
    const row = db.get('SELECT count FROM budget_usage WHERE window_key = ?', [windowKey])
    const used = row ? num(row.count) : 0
    if (used >= limit) return { allowed: false, used, limit }
    db.run(
      `INSERT INTO budget_usage (window_key, character_id, kind, window_start, count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(window_key) DO UPDATE SET count = budget_usage.count + 1`,
      [windowKey, characterId, kind, windowStart],
    )
    return { allowed: true, used: used + 1, limit }
  }
  const readBudget = windowKey => {
    const row = db.get('SELECT count FROM budget_usage WHERE window_key = ?', [windowKey])
    return row ? num(row.count) : 0
  }

  const putObservation = row => {
    db.run(
      `INSERT INTO observations (observation_id, character_id, kind, payload_json, observed_at, fresh_until, source_id, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(observation_id) DO NOTHING`,
      [row.observationId, row.characterId, row.kind, json(row.payload), row.observedAt, row.freshUntil, row.sourceId || null],
    )
  }
  const listFreshObservations = (characterId, asOf, limit = 20) => db.all(
    'SELECT * FROM observations WHERE character_id = ? AND fresh_until > ? AND consumed_at IS NULL ORDER BY observed_at DESC LIMIT ?',
    [characterId, asOf, Math.min(Number(limit) || 20, 100)],
  ).map(row => ({
    observationId: row.observation_id, kind: row.kind, payload: parse(row.payload_json, {}),
    observedAt: row.observed_at, freshUntil: row.fresh_until, sourceId: row.source_id,
  }))
  const consumeObservation = observationId => { db.run('UPDATE observations SET consumed_at = ? WHERE observation_id = ?', [now(), observationId]) }
  const removeObservationsBySources = ids => {
    for (const id of ids) db.run('DELETE FROM observations WHERE source_id = ?', [id])
  }
  const purgeObservations = before => db.run('DELETE FROM observations WHERE fresh_until < ?', [before])

  /* ---------------- reflections / growth ---------------- */
  const putReflection = row => {
    db.run(
      `INSERT INTO reflections (reflection_id, character_id, status, body_json, source_refs_json, created_seq, decided_at, decision)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(reflection_id) DO NOTHING`,
      [row.reflectionId, row.characterId, row.status || 'pending', json(row.body), json(row.sourceRefs || []), row.createdSeq],
    )
  }
  const listReflections = (characterId, status) => db.all(
    'SELECT * FROM reflections WHERE character_id = ? AND status = ? ORDER BY created_seq ASC LIMIT 20',
    [characterId, status || 'pending'],
  ).map(row => ({
    reflectionId: row.reflection_id, characterId: row.character_id, status: row.status,
    body: parse(row.body_json, {}), sourceRefs: parse(row.source_refs_json, []), createdSeq: row.created_seq, decision: row.decision,
  }))
  const decideReflection = (reflectionId, status, decision) => {
    db.run('UPDATE reflections SET status = ?, decision = ?, decided_at = ? WHERE reflection_id = ?', [status, decision || null, now(), reflectionId])
  }
  const putGrowthEvent = row => {
    db.run(
      `INSERT INTO growth_events (growth_id, character_id, target_kind, target_key, old_value_json, new_value_json,
        rule_version, rule_limit_json, source_refs_json, created_seq, reverted_at, reverted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(growth_id) DO NOTHING`,
      [row.growthId, row.characterId, row.targetKind, row.targetKey, json(row.oldValue), json(row.newValue),
        row.ruleVersion, json(row.ruleLimit || {}), json(row.sourceRefs || []), row.createdSeq],
    )
  }
  const listGrowthEvents = (characterId, limit = 100) => db.all(
    'SELECT * FROM growth_events WHERE character_id = ? ORDER BY created_seq DESC LIMIT ?',
    [characterId, Math.min(Number(limit) || 100, 500)],
  ).map(row => ({
    growthId: row.growth_id, targetKind: row.target_kind, targetKey: row.target_key,
    oldValue: parse(row.old_value_json, null), newValue: parse(row.new_value_json, null),
    ruleVersion: row.rule_version, ruleLimit: parse(row.rule_limit_json, {}),
    sourceRefs: parse(row.source_refs_json, []), createdSeq: row.created_seq, revertedAt: row.reverted_at,
  }))

  /* ---------------- plans ---------------- */
  const mapPlan = row => row && ({
    planId: row.plan_id, characterId: row.character_id, opportunityId: row.opportunity_id,
    recipeId: row.recipe_id, recipeVersion: row.recipe_version, status: row.status,
    stepCursor: row.step_cursor, steps: parse(row.steps_json, []), epoch: row.epoch,
    createdAt: row.created_at, updatedAt: row.updated_at, cancelReason: row.cancel_reason,
  })
  const putPlan = row => {
    db.run(
      `INSERT INTO plans (plan_id, character_id, opportunity_id, recipe_id, recipe_version, status, step_cursor, steps_json,
        epoch, created_at, updated_at, cancel_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [row.planId, row.characterId, row.opportunityId || null, row.recipeId, row.recipeVersion, row.status,
        row.stepCursor || 0, json(row.steps), row.epoch, now(), now()],
    )
    return getPlan(row.planId)
  }
  const getPlan = planId => mapPlan(db.get('SELECT * FROM plans WHERE plan_id = ?', [planId]))
  const patchPlan = (planId, patch) => {
    const fields = []
    const params = []
    for (const [key, column] of Object.entries({ status: 'status', stepCursor: 'step_cursor', cancelReason: 'cancel_reason', steps: 'steps_json' })) {
      if (patch[key] !== undefined) { fields.push(column + ' = ?'); params.push(key === 'steps' ? json(patch[key]) : patch[key]) }
    }
    if (!fields.length) return getPlan(planId)
    fields.push('updated_at = ?')
    params.push(now(), planId)
    db.run('UPDATE plans SET ' + fields.join(', ') + ' WHERE plan_id = ?', params)
    return getPlan(planId)
  }
  const listActivePlans = (characterId) => db.all(
    "SELECT * FROM plans WHERE character_id = ? AND status IN ('active','waiting') ORDER BY created_at ASC",
    [characterId],
  ).map(mapPlan)

  /* ---------------- cursors / imports / skills / packages ---------------- */
  const getCursor = consumer => {
    const row = db.get('SELECT * FROM projection_cursors WHERE consumer = ?', [consumer])
    return row ? { consumer: row.consumer, lastSeq: row.last_seq, projectionVersion: row.projection_version } : null
  }
  const setCursor = row => {
    db.run(
      `INSERT INTO projection_cursors (consumer, last_seq, projection_version) VALUES (?, ?, ?)
       ON CONFLICT(consumer) DO UPDATE SET last_seq = excluded.last_seq, projection_version = excluded.projection_version`,
      [row.consumer, row.lastSeq, row.projectionVersion],
    )
  }
  const getImport = importId => {
    const row = db.get('SELECT * FROM imports WHERE import_id = ?', [importId])
    return row ? { importId: row.import_id, sourceHash: row.source_hash, status: row.status, startedAt: row.started_at, completedAt: row.completed_at, detail: parse(row.detail_json, null) } : null
  }
  const putImport = row => {
    db.run(
      `INSERT INTO imports (import_id, source_hash, status, started_at, completed_at, detail_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(import_id) DO UPDATE SET status = excluded.status, completed_at = excluded.completed_at, detail_json = excluded.detail_json`,
      [row.importId, row.sourceHash, row.status, row.startedAt, row.completedAt === undefined ? null : row.completedAt, json(row.detail || {})],
    )
  }
  const putSkill = row => {
    db.run(
      `INSERT INTO skills (skill_id, version, manifest_hash, status, schema_version, data_json) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id, version) DO NOTHING`,
      [row.skillId, row.version, row.manifestHash, row.status, row.schemaVersion, json(row.data)],
    )
  }
  const listSkills = () => db.all('SELECT * FROM skills ORDER BY skill_id ASC, version DESC').map(row => ({
    skillId: row.skill_id, version: row.version, manifestHash: row.manifest_hash, status: row.status,
    schemaVersion: row.schema_version, data: parse(row.data_json, {}),
  }))
  const putPackage = row => {
    db.run(
      `INSERT INTO packages (package_id, version, manifest_hash, status, schema_version, data_namespace, active)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(package_id, version) DO NOTHING`,
      [row.packageId, row.version, row.manifestHash, row.status, row.schemaVersion, row.dataNamespace, row.active ? 1 : 0],
    )
  }
  const listPackages = () => db.all('SELECT * FROM packages ORDER BY package_id ASC, version DESC').map(row => ({
    packageId: row.package_id, version: row.version, manifestHash: row.manifest_hash, status: row.status,
    schemaVersion: row.schema_version, dataNamespace: row.data_namespace, active: !!row.active,
  }))

  return {
    db,
    getMeta, setMeta,
    getCharacter, putCharacter, bumpEpoch,
    putIdentityRevision, latestIdentity,
    putPayload, getPayload, deletePayload,
    putSource, getSource, setSourcePermission, listSources,
    appendEvent, lastSeq, getEvent, listEvents,
    getState, writeState,
    insertAssertion, getAssertion, findCurrentAssertions, supersedeAssertion, setAssertionStatus, listAssertions,
    addEvidence, listEvidenceSources, listDerivedBySource, clearEvidenceFor,
    insertEpisode, listEpisodes, setEpisodeStatus, insertAppraisal, invalidateDerived,
    putConcern, getConcern, findConcernByTopic, listConcerns, countConcerns,
    putProject, getProject, listProjects, countProjects,
    putJob, rescheduleJob, listDueJobs, claimJob, finishJob, settleJob, retryJob, reclaimExpiredLeases, reclaimAllLeases, nextDueAt, cancelJobsMatching,
    putOperation, getOperation, getOperationByDedupe, patchOperation, listOperations, addAttempt,
    putOutbox, listOutbox, patchOutbox, getOutboxForOperation,
    putDelivery, listDeliveries,
    putArtifact, getArtifact, listArtifacts, allArtifacts, markArtifactDeleted,
    getCommandReceipt, putCommandReceipt,
    consumeBudget, readBudget,
    putObservation, listFreshObservations, consumeObservation, purgeObservations, removeObservationsBySources,
    putReflection, listReflections, decideReflection, putGrowthEvent, listGrowthEvents,
    putPlan, getPlan, patchPlan, listActivePlans,
    getCursor, setCursor, getImport, putImport, putSkill, listSkills, putPackage, listPackages,
  }
}

/**
 * 打开/创建 Store。
 * @param {{file: string, now?: Function, readonly?: boolean, preferredDriver?: string, schemaFile?: string}} options
 */
function createStore (options) {
  const file = options && options.file
  if (typeof file !== 'string' || !file) throw new Error('store: file required')
  const clock = typeof options.now === 'function' ? options.now : Date.now
  let db = null
  let gateway = null
  let depth = 0
  let closing = false

  function ensureDir () {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  }

  function migrationChecksum () {
    const sql = fs.readFileSync(options.schemaFile || SCHEMA_FILE, 'utf8')
    return { sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') }
  }

  /**
   * 结构迁移。未知/漂移的 schema 必须拒绝写入（§18.2“数据库损坏/未知 schema”）：
   * 返回 {ok:false, code:'read_only'} 而不是硬崩，让 main 能进只读恢复界面。
   */
  function migrate (openDb) {
    const { sql, checksum } = migrationChecksum()
    openDb.exec(sql)
    const existing = openDb.get('SELECT * FROM schema_migrations WHERE id = ?', [INITIAL_MIGRATION])
    if (!existing) {
      openDb.run('INSERT INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', [INITIAL_MIGRATION, clock(), checksum])
      openDb.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', ['store_schema_version', String(STORE_SCHEMA_VERSION)])
      return { ok: true, applied: true }
    }
    if (existing.checksum !== checksum) {
      return { ok: false, code: 'read_only', reason: 'schema_drift' }
    }
    return { ok: true, applied: false }
  }

  /** FTS5 是可重建的额外索引，不是权威表；不可用时静默降级为关键词扫描。 */
  function ensureFts (openDb) {
    try {
      openDb.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(body, kind UNINDEXED, ref UNINDEXED, tokenize = 'unicode61')")
      openDb.run("INSERT INTO meta (key, value) VALUES ('fts_available', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
      return true
    } catch (_) {
      openDb.run("INSERT INTO meta (key, value) VALUES ('fts_available', '0') ON CONFLICT(key) DO UPDATE SET value = '0'")
      return false
    }
  }

  const api = {
    file,
    get driver () { return db ? db.driver : null },
    open () {
      if (db) return { ok: true, reused: true }
      ensureDir()
      db = openDatabase({ file, readonly: !!options.readonly, preferred: options.preferredDriver })
      closing = false
      const migrated = migrate(db)
      if (!migrated.ok) return { ok: false, ...migrated }
      if (!options.readonly) ensureFts(db)
      gateway = createGateway(db, clock)
      return { ok: true, migration: migrated }
    },
    /** 只读一致性快照事务。 */
    read (fn) {
      if (!db) throw new Error('store_not_open')
      if (depth > 0) return fn(gateway)
      depth++
      try {
        db.exec('BEGIN')
        const value = fn(gateway)
        if (value && typeof value.then === 'function') throw new Error('async_transaction_forbidden')
        db.exec('COMMIT')
        return value
      } catch (error) {
        try { db.exec('ROLLBACK') } catch (_) {}
        throw error
      } finally { depth-- }
    },
    /**
     * 写事务。BEGIN IMMEDIATE 取得写锁；事务内不得 await 外部 I/O。
     * 返回 fn 的结果；异常一律回滚并向上抛，绝不吞掉。
     */
    transaction (fn) {
      if (!db) throw new Error('store_not_open')
      if (depth > 0) return fn(gateway)
      if (options.readonly) {
        const error = new Error('store_read_only')
        error.code = 'read_only'
        throw error
      }
      depth++
      try {
        db.exec('BEGIN IMMEDIATE')
        const value = fn(gateway)
        if (value && typeof value.then === 'function') throw new Error('async_transaction_forbidden')
        db.exec('COMMIT')
        return value
      } catch (error) {
        try { db.exec('ROLLBACK') } catch (_) {}
        throw error
      } finally { depth-- }
    },
    /** 只在确信没有其他语句时使用：例如 epoch 提升前的恢复准备。 */
    gateway () {
      if (!gateway) throw new Error('store_not_open')
      return gateway
    },
    integrity () {
      if (!db) return { ok: false, reason: 'not_open' }
      try {
        const row = db.get('PRAGMA integrity_check')
        const value = row ? Object.values(row)[0] : 'unknown'
        return { ok: value === 'ok', value }
      } catch (error) { return { ok: false, reason: error.message } }
    },
    snapshotTo (target) {
      if (!db) throw new Error('store_not_open')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (fs.existsSync(target)) throw new Error('snapshot_target_exists')
      db.snapshotTo(target)
      return { path: target, bytes: fs.statSync(target).size, hash: hash(fs.readFileSync(target)) }
    },
    close () {
      if (closing) return
      closing = true
      if (db) { try { db.close() } catch (_) {} }
      db = null
      gateway = null
    },
  }
  return api
}

module.exports = { createStore, createGateway, SCHEMA_FILE, INITIAL_MIGRATION, STORE_SCHEMA_VERSION }
