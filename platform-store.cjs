'use strict'
// Main-process owned bounded transactional checkpoint. No renderer authority is serialized.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const clone = value => JSON.parse(JSON.stringify(value))
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const initial = () => ({ schema: 1, revision: 0, sources: {}, operations: {}, concerns: {}, projects: {}, appraisals: {}, packages: {}, namespaces: {}, policy: { lastAutomatic: 0 }, diagnostics: [] })
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !['__proto__', 'constructor', 'prototype', 'toString', 'valueOf'].includes(value)
function createStore(directory, options = {}) {
  const now = options.now || Date.now, file = path.join(directory, 'character-platform.json'), deletionFile = path.join(directory, 'character-forgotten.json')
  let state = null, tombstones = null, error = null
  function read(fileName, fallback) {
    try {
      const envelope = JSON.parse(fs.readFileSync(fileName, 'utf8'))
      if (!envelope.payload || envelope.hash !== digest(envelope.payload)) throw Error('checkpoint_checksum')
      return envelope.payload
    } catch (e) { if (e.code === 'ENOENT') return fallback(); throw e }
  }
  function write(fileName, value, boundary) {
    if (options.readOnly) throw Error('kernel_authority')
    if (options.fault) options.fault(boundary + ':before_write')
    fs.mkdirSync(directory, { recursive: true })
    const fd = fs.openSync(fileName + '.tmp', 'w')
    try { fs.writeFileSync(fd, JSON.stringify({ hash: digest(value), payload: value })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (options.fault) options.fault(boundary + ':before_rename')
    fs.renameSync(fileName + '.tmp', fileName)
  }
  function load() {
    if (error) throw Error(error)
    if (state) return state
    try {
      tombstones = read(deletionFile, () => ({ schema: 1, refs: {} }))
      state = read(file, initial)
      if (state.schema === 0 && options.migrate === true && state.sources && state.operations) {
        const legacy = clone(state)
        fs.copyFileSync(file, file + '.pre-v1')
        state = { ...initial(), ...legacy, schema: 1, concerns: legacy.concerns || {}, projects: legacy.projects || {}, appraisals: legacy.appraisals || {},
          packages: legacy.packages || {}, namespaces: legacy.namespaces || {}, policy: legacy.policy || { lastAutomatic: 0 }, diagnostics: legacy.diagnostics || [] }
        write(file, state, 'schema_migration')
      }
      if (state.schema !== 1 || !state.operations || !state.sources || tombstones.schema !== 1 || !tombstones.refs) throw Error('unsupported_platform_schema')
      applyDeletes(state)
      return state
    } catch (e) { state = null; error = 'platform_read_failed:' + e.message; throw Error(error) }
  }
  function deleted(ref) { load(); return !!tombstones.refs[ref] }
  function applyDeletes(s) {
    for (const ref of Object.keys(tombstones.refs)) {
      delete s.sources[ref]
      for (const op of Object.values(s.operations)) if ((op.sourceRefs || []).includes(ref)) {
        op.status = 'invalidated'; delete op.input; delete op.result; delete op.receipt
      }
      for (const map of [s.concerns, s.projects, s.appraisals]) for (const [id, row] of Object.entries(map || {})) {
        if ((row.sourceRefs || []).includes(ref)) delete map[id]
      }
    }
  }
  function bound(next) {
    const reads = Object.values(next.operations).filter(o => o.type === 'action' && o.effect === 'read' && ['completed', 'failed'].includes(o.status)).sort((a, b) => a.observedAt - b.observedAt)
    while (reads.length > 200) delete next.operations[reads.shift().id]
    const pinned = new Set(Object.values(next.operations).filter(o => o.status !== 'invalidated').flatMap(o => o.sourceRefs || []))
    Object.values(next.concerns).forEach(c => (c.sourceRefs || []).forEach(r => pinned.add(r)))
    Object.values(next.appraisals).forEach(c => (c.sourceRefs || []).forEach(r => pinned.add(r)))
    const disposable = Object.values(next.sources).filter(s => !s.important && !pinned.has(s.messageRef)).sort((a, b) => a.ts - b.ts)
    while (Object.keys(next.sources).length > 1200 && disposable.length) delete next.sources[disposable.shift().messageRef]
    next.diagnostics = next.diagnostics.slice(-100)
    // Never silently evict deletion policy or pending obligations to meet a cap.
    if (Object.keys(next.operations).length > 2000 || Object.keys(next.appraisals).length > 1000 || Buffer.byteLength(JSON.stringify(next), 'utf8') + 128 > 4 * 1024 * 1024) throw Error('platform_capacity_export_required')
  }
  function transaction(fn, boundary = 'checkpoint') {
    if (options.readOnly) throw Error('kernel_authority')
    const next = clone(load()), result = fn(next)
    applyDeletes(next); bound(next); next.revision++
    write(file, next, boundary); state = next
    return clone(result === undefined ? { ok: true } : result)
  }
  function acceptSource(source, important = false) {
    if (!source || source.role !== 'user' || !validId(source.messageRef) || source.messageRef.length > 120 || !(source.ts > 0) || typeof source.text !== 'string' || source.text.length > 8000) throw Error('invalid_source')
    if (deleted(source.messageRef)) throw Error('source_forgotten')
    const prior = load().sources[source.messageRef]
    if (prior && (prior.ts !== source.ts || prior.text !== source.text)) throw Error('source_conflict')
    return transaction(s => { s.sources[source.messageRef] = { ...clone(source), important: important || !!(prior && prior.important), observedAt: prior && prior.observedAt || now() }; return { ok: true } }, 'source')
  }
  function source(ref) { return deleted(ref) ? null : clone(load().sources[ref] || null) }
  function beginFact(input) {
    const src = source(input.messageRef)
    if (!src || src.ts !== input.ts || src.text !== input.userText) throw Error('history_source_invalid')
    const id = 'fact:' + input.messageRef, prior = load().operations[id]
    if (prior) {
      if (digest(prior.input) !== digest(input)) throw Error('fact_payload_conflict')
      return clone(prior)
    }
    return transaction(s => {
      s.sources[src.messageRef].important = true
      const op = { id, type: 'fact', sourceRefs: [src.messageRef], input: clone(input), eventAt: src.ts, observedAt: now(), expiresAt: now() + 120000,
        status: 'pending', obligations: { sourceAccepted: true, lifeApplied: false, memoryAccepted: false, memoryPersisted: false, domainApplied: false }, attempts: 0 }
      s.operations[id] = op; return op
    }, 'fact_begin')
  }
  function extraction(ref, result) {
    const src = source(ref); if (!src) throw Error('source_missing')
    return transaction(s => {
      const id = 'extraction:' + ref
      if (!s.operations[id]) s.operations[id] = { id, type: 'extraction', sourceRefs: [ref], status: 'awaiting_metadata', eventAt: src.ts, observedAt: now(), expiresAt: now() + 120000 }
      if (result) { s.operations[id].status = result.ok ? 'metadata_received' : 'failed'; s.operations[id].reason = result.reason || null }
      return { ok: true }
    }, 'extraction')
  }
  function advanceFact(ref, step, detail = {}) {
    if (!['lifeApplied', 'memoryAccepted', 'memoryPersisted', 'memoryRejected', 'domainApplied'].includes(step)) throw Error('invalid_fact_step')
    return transaction(s => {
      const op = s.operations['fact:' + ref]
      if (!op || deleted(ref) || op.status === 'invalidated') throw Error('source_forgotten')
      if (step.startsWith('memory') && !op.obligations.lifeApplied) throw Error('life_not_applied')
      if (step === 'memoryPersisted' && !op.obligations.memoryAccepted) throw Error('memory_not_accepted')
      if (step === 'domainApplied' && !op.obligations.memoryPersisted) throw Error('memory_not_persisted')
      op.obligations[step] = true; op.updatedAt = now()
      if (step === 'memoryRejected') { op.reason = String(detail.reason || 'memory_rejected'); op.status = 'rejected' }
      else if (op.obligations.memoryPersisted) op.status = 'completed'
      return op
    }, 'fact_' + step)
  }
  function pendingFacts() {
    return transaction(s => {
      const out = []
      for (const op of Object.values(s.operations)) if (op.type === 'fact' && op.status === 'pending') {
        const compensation = op.obligations.lifeApplied && now() - op.observedAt <= 86400000
        if (!s.sources[op.sourceRefs[0]]) op.status = 'invalidated'
        else if ((!compensation && now() >= op.expiresAt) || op.attempts >= 3) { op.status = 'expired'; op.reason = 'recovery_budget_expired' }
        else if (out.length < 8) {
          // A committed domain fact may finish its missing storage obligation
          // within one day, with at most three fresh 120s permits; no new model call.
          if (compensation) op.expiresAt = now() + 120000
          op.attempts++; out.push(clone(op))
        }
      }
      return out
    }, 'fact_recovery')
  }
  function forget(refs, reason = 'user_request') {
    load()
    const next = clone(tombstones)
    for (const ref of refs) if (validId(ref)) next.refs[ref] = { at: now(), reason }
    // Separate monotonic policy commits first; a crash before checkpoint redaction still blocks resurrection.
    write(deletionFile, next, 'deletion'); tombstones = next
    return transaction(s => { applyDeletes(s); return { ok: true } }, 'redaction')
  }
  function beginOperation(proposal) {
    if (!proposal || !validId(proposal.id) || !proposal.capabilityId || !proposal.effect || !(proposal.deadline > now())) throw Error('invalid_proposal')
    if ((proposal.sourceRefs || []).some(deleted)) throw Error('source_forgotten')
    const prior = load().operations[proposal.id]
    if (prior) { if (prior.inputHash !== digest(proposal.input)) throw Error('operation_conflict'); return clone(prior) }
    return transaction(s => {
      const op = { id: proposal.id, type: 'action', capabilityId: proposal.capabilityId, provider: proposal.provider, version: proposal.version,
        effect: proposal.effect, inputHash: digest(proposal.input), input: clone(proposal.input), sourceRefs: proposal.sourceRefs || [], eventAt: proposal.eventAt || now(), observedAt: now(),
        expiresAt: proposal.deadline, status: 'prepared', attempts: 0 }
      s.operations[op.id] = op; return op
    }, 'operation_begin')
  }
  function operation(id) { return clone(load().operations[id] || null) }
  function updateOperation(id, status, receipt) {
    return transaction(s => {
      const op = s.operations[id]; if (!op || op.status === 'invalidated') throw Error('operation_invalid')
      const allowed = { prepared: ['dispatched', 'cancelled', 'expired'], dispatched: ['completed', 'failed', 'unknown_after_dispatch', 'awaiting_receipt'], awaiting_receipt: ['completed', 'failed', 'paused'], unknown_after_dispatch: ['completed', 'failed'], paused: [] }
      if (op.status !== status && !(allowed[op.status] || []).includes(status)) throw Error('operation_transition:' + op.status + ':' + status)
      op.status = status; op.updatedAt = now()
      if (status === 'dispatched') op.attempts++
      if (receipt) op.receipt = clone(receipt)
      return op
    }, 'operation_' + status)
  }
  function recoverOperations() {
    return transaction(s => {
      for (const op of Object.values(s.operations)) {
        if (op.status === 'awaiting_metadata') { op.status = 'failed'; op.reason = 'provider_interrupted_no_auto_retry' }
        if (op.status === 'dispatched') op.status = op.effect === 'read' ? 'failed' : 'unknown_after_dispatch'
        if (op.status === 'awaiting_receipt' && op.effect === 'virtual') op.status = 'paused'
        if (op.status === 'prepared' && now() >= op.expiresAt) op.status = 'expired'
      }
      return { ok: true }
    }, 'operation_recovery')
  }
  function backup() { return { schema: 1, hash: digest(load()), payload: clone(load()) } }
  function restore(envelope) {
    load()
    if (!envelope || envelope.hash !== digest(envelope.payload) || envelope.payload.schema !== 1) throw Error('invalid_restore')
    const next = clone(envelope.payload); applyDeletes(next); bound(next); next.revision = state.revision + 1
    write(file, next, 'restore'); state = next; return { ok: true, revision: next.revision }
  }
  function filterMemory(data) {
    load(); if (!data || !Array.isArray(data.memories)) return data
    const next = clone(data)
    next.memories = next.memories.filter(m => !(m.evidenceRefs || []).some(e => tombstones.refs[e.messageRef || e.eventRef]) && !(m.sourceEventIds || []).some(r => tombstones.refs[r] || tombstones.refs[r.replace(/^conversation:/, '')]))
    // Working caches/evidence indexes are rebuildable, not a restore authority.
    if (next.evidence) for (const [key, row] of Object.entries(next.evidence)) if ((row.sourceEventIds || []).some(r => tombstones.refs[r] || tombstones.refs[r.replace(/^conversation:/, '')])) delete next.evidence[key]
    return next
  }
  function filterLife(data) {
    load(); if (!data) return data
    const next = clone(data)
    const hidden = row => !!tombstones.refs[row.messageRef] || (row.refs || row.sourceRefs || []).some(r => tombstones.refs[r] || tombstones.refs[String(r).replace(/^(conversation:|event:)/, '')]) || row.material && !!tombstones.refs[row.material.id]
    for (const key of ['turns', 'threads', 'artifacts', 'interests']) if (Array.isArray(next[key])) next[key] = next[key].filter(row => !hidden(row))
    for (const day of next.days || []) for (const key of ['experiences', 'activities']) if (Array.isArray(day[key])) day[key] = day[key].filter(row => !hidden(row))
    return next
  }
  return { load, transaction, source, acceptSource, beginFact, extraction, advanceFact, pendingFacts, forget, deleted, beginOperation, operation, updateOperation, recoverOperations, backup, restore, filterMemory, filterLife,
    snapshot: () => clone(load()), health: () => ({ schema: 1, revision: load().revision, sourceCount: Object.keys(state.sources).length, operationCount: Object.keys(state.operations).length, tombstoneCount: Object.keys(tombstones.refs).length, error }) }
}
module.exports = { createStore, digest }
