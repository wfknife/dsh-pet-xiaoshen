'use strict'
/* The main process owns state commits. Normal reads never compare collection
 * lengths with old snapshots: deleting content is a legitimate state change.
 * All writes are synchronous and atomic within one main-process event turn. */
const nativeFs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const MAX_STATE_LENGTH = 16000000
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
const clone = value => JSON.parse(JSON.stringify(value))

function validLines(value) {
  if (!plain(value) || !plain(value.lines) || !Array.isArray(value.customLines) || !Array.isArray(value.disabledGroups)) return false
  if (Object.keys(value.lines).length > 80 || value.customLines.length > 3000 || value.disabledGroups.length > 80) return false
  if (!Object.entries(value.lines).every(([key, rows]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype' &&
    key.length <= 80 && Array.isArray(rows) && rows.length <= 3000 && rows.every(text => typeof text === 'string' && text.length <= 2000))) return false
  return value.customLines.every(row => plain(row) && typeof row.group === 'string' && typeof row.text === 'string' && row.group.length <= 80 && row.text.length <= 2000) &&
    value.disabledGroups.every(key => typeof key === 'string' && key.length <= 80)
}
function validState(value) {
  if (!plain(value)) return false
  for (const field of ['level', 'coins', 'exp', 'bootCount']) if (value[field] !== undefined && !Number.isFinite(value[field])) return false
  for (const field of ['diary', 'diaryOutputs', 'todos', 'schedule', 'memos', 'memories']) if (value[field] !== undefined && !Array.isArray(value[field])) return false
  if (value.stats !== undefined && (!plain(value.stats) || !['satiety', 'thirst', 'energy', 'mood'].every(key => value.stats[key] === undefined || Number.isFinite(value.stats[key])))) return false
  if (value._store !== undefined && (!plain(value._store) || value._store.schemaVersion !== 1 ||
    !Number.isSafeInteger(value._store.revision) || value._store.revision < 0 ||
    !Number.isSafeInteger(value._store.linesRevision) || value._store.linesRevision < 0)) return false
  return true
}
function metadata(state) {
  return state && state._store ? clone(state._store) : { schemaVersion: 1, revision: 0, linesRevision: 0, lineCommands: [] }
}
function linesOf(state) {
  return { lines: plain(state && state.lines) ? clone(state.lines) : {},
    customLines: Array.isArray(state && state.customLines) ? clone(state.customLines) : [],
    disabledGroups: Array.isArray(state && state.disabledGroups) ? clone(state.disabledGroups) : [] }
}

function createStateStore(directory, options = {}) {
  const fs = options.fs || nativeFs
  const clock = options.now || Date.now
  const file = path.join(directory, 'pet-state.json')
  const backup = path.join(directory, 'pet-state.backup.json')
  const archives = path.join(directory, 'state-archive')
  const recovery = path.join(directory, 'state-recovery')
  let serial = 0, archiveDay = null
  function atomicWrite(target, text) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const temp = target + '.' + process.pid + '.' + (++serial) + '.tmp'
    try { fs.writeFileSync(temp, text, 'utf8'); fs.renameSync(temp, target) }
    catch (err) { try { fs.unlinkSync(temp) } catch (_) {} throw err }
  }
  function candidate(target) {
    try {
      const raw = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '')
      if (raw.length > MAX_STATE_LENGTH) return { ok: false, status: 'corrupt', reason: 'state_too_large' }
      const state = JSON.parse(raw)
      return validState(state) ? { ok: true, state } : { ok: false, status: 'corrupt', reason: 'invalid_state' }
    } catch (err) {
      return { ok: false, status: err.code === 'ENOENT' ? 'missing' : err instanceof SyntaxError ? 'corrupt' : 'io_error', reason: err.code || err.message }
    }
  }
  function read() {
    const primary = candidate(file)
    if (primary.ok) return { ok: true, status: 'loaded', state: clone(primary.state), revision: metadata(primary.state).revision }
    // A denied read is not evidence of damaged content; don't overwrite it.
    if (primary.status === 'io_error') return { ...primary, state: null, writable: false }
    let files = [backup]
    try {
      files = files.concat(fs.readdirSync(archives).filter(name => /^pet-state-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse().map(name => path.join(archives, name)))
    } catch (err) { if (err.code !== 'ENOENT') return { ok: false, status: 'io_error', reason: err.code || err.message, state: null, writable: false } }
    let damagedCandidate = false
    for (const source of files) {
      const recovered = candidate(source)
      if (!recovered.ok) { if (recovered.status !== 'missing') damagedCandidate = true; continue }
      try {
        let preservedPath = null
        if (primary.status === 'corrupt') {
          preservedPath = path.join(recovery, 'pet-state-' + clock() + '-' + process.pid + '-' + (++serial) + '.corrupt.json')
          fs.mkdirSync(recovery, { recursive: true })
          fs.copyFileSync(file, preservedPath)
        }
        // Keep the recovery source intact even if repairing the primary fails.
        atomicWrite(file, JSON.stringify(recovered.state))
        return { ok: true, status: 'recovered', state: clone(recovered.state), revision: metadata(recovered.state).revision,
          recoveredFrom: source, preservedPath }
      } catch (err) { return { ok: false, status: 'io_error', reason: 'recovery_write_failed:' + (err.code || err.message), state: null, writable: false } }
    }
    if (primary.status === 'missing' && !damagedCandidate) return { ok: true, status: 'missing', state: null, revision: 0 }
    return { ok: false, status: 'corrupt', reason: 'no_valid_recovery', state: null, writable: false }
  }
  function archiveCurrent(state) {
    if (!state) return
    const d = new Date(clock()), day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    if (archiveDay === day) return
    const target = path.join(archives, 'pet-state-' + day + '.json')
    // Don't replace a prior same-day recovery checkpoint with later content.
    if (!fs.existsSync(target)) atomicWrite(target, JSON.stringify(state))
    // Retain the previous seven daily checkpoints, as the legacy store did.
    const snapshots = fs.readdirSync(archives).filter(name => /^pet-state-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse()
    for (const name of snapshots.slice(7)) fs.unlinkSync(path.join(archives, name))
    archiveDay = day
  }
  function persist(next, current) {
    const serialized = JSON.stringify(next)
    // Acknowledged files must remain readable under the same size boundary.
    if (serialized.length > MAX_STATE_LENGTH) return { ok: false, reason: 'state_too_large', retryable: false }
    let archiveWarning = null
    try { archiveCurrent(current) } catch (err) { archiveWarning = err.code || err.message }
    try { atomicWrite(file, serialized) }
    catch (err) { return { ok: false, reason: 'state_write_failed:' + (err.code || err.message), retryable: true } }
    let backupWarning = null
    // Mirror the acknowledged state, including deletions. A backup failure does
    // not turn an already committed primary into a false save failure.
    try { atomicWrite(backup, serialized) } catch (err) { backupWarning = err.code || err.message }
    return { ok: true, state: clone(next), revision: next._store.revision, ...(backupWarning ? { backupWarning } : {}), ...(archiveWarning ? { archiveWarning } : {}) }
  }
  function saveLegacy(input) {
    let proposed
    try { proposed = clone(input) } catch (_) { return { ok: false, reason: 'invalid_state', retryable: false } }
    if (!validState(proposed)) return { ok: false, reason: 'invalid_state', retryable: false }
    const loaded = read()
    if (!loaded.ok) return { ok: false, reason: loaded.reason, status: loaded.status, retryable: true }
    const current = loaded.state, meta = metadata(current)
    const next = { ...(current || {}), ...proposed }
    // Once the dedicated editor has committed, it owns this domain. Legacy P
    // snapshots can still save nurturing/diaries, but never roll lines back.
    if (meta.linesRevision > 0) Object.assign(next, linesOf(current))
    next._store = { ...meta, schemaVersion: 1, revision: meta.revision + 1 }
    return persist(next, current)
  }
  function linesRead() {
    const loaded = read()
    if (!loaded.ok) return { ok: false, reason: loaded.reason, status: loaded.status }
    return { ok: true, ...linesOf(loaded.state), revision: metadata(loaded.state).linesRevision, stateRevision: loaded.revision, status: loaded.status }
  }
  function updateLines(command) {
    const loaded = read()
    if (!loaded.ok) return { ok: false, reason: loaded.reason, status: loaded.status, retryable: true }
    if (!plain(command) || typeof command.commandId !== 'string' || !command.commandId || command.commandId.length > 160 ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || !validLines(command)) {
      return { ok: false, reason: 'invalid_lines_command', retryable: false }
    }
    const current = loaded.state || {}, meta = metadata(current), value = linesOf(command)
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const commands = Array.isArray(meta.lineCommands) ? meta.lineCommands.filter(item => plain(item) && typeof item.commandId === 'string' &&
      typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint) && Number.isSafeInteger(item.revision)).slice(-64) : []
    const previous = commands.find(item => item.commandId === command.commandId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) return { ok: false, reason: 'idempotency_conflict', retryable: false }
      return { ok: true, ...linesOf(current), revision: meta.linesRevision, stateRevision: meta.revision, replayed: true }
    }
    if (command.expectedRevision !== meta.linesRevision) return { ok: false, reason: 'lines_revision_conflict', retryable: false, revision: meta.linesRevision }
    const linesRevision = meta.linesRevision + 1
    const next = { ...current, ...value, _store: { ...meta, schemaVersion: 1, revision: meta.revision + 1, linesRevision,
      lineCommands: [...commands, { commandId: command.commandId, fingerprint, revision: linesRevision }].slice(-64) } }
    const saved = persist(next, loaded.state)
    return saved.ok ? { ok: true, ...value, revision: linesRevision, stateRevision: saved.revision,
      ...(saved.backupWarning ? { backupWarning: saved.backupWarning } : {}) } : saved
  }
  return { read, saveLegacy, linesRead, updateLines }
}
module.exports = { createStateStore, validState, validLines }
