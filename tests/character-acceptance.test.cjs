'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createKernel } = require('../character/runtime/kernel.cjs')
const { createConfig, resolvePaths } = require('../character/config.cjs')
const { createHost } = require('../character/host.cjs')
const { createPolicyStore } = require('../character/storage/policy-store.cjs')
const { createModelGateway } = require('../character/cognition/model-gateway.cjs')
const { hash } = require('../character/ids.cjs')

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-acceptance-'))
  let now = 1800000000000, seq = 0
  const requests = [], published = []
  const host = { async request(method, params) {
    requests.push({ method, params })
    if (method === 'capability.grants') return { ok: true, scopes: ['character:state:write', 'character:artifact:write', 'presentation:text'] }
    if (method === 'prompts.snapshot') return { ok: true, value: { texts: { M1_reply: '隔离测试模板', M2_say: '隔离测试模板' } } }
    if (method === 'model.complete') {
      if (params.task === 'verify_grounding') return { ok: true, text: '{"complete":true,"claims":[],"unsupported":[]}' }
      if (options.model) return options.model(params)
      return { ok: false, reason: 'fixture_no_model' }
    }
    return { ok: false, reason: 'fixture_unknown_method' }
  } }
  const paths = resolvePaths({ dataDir: dir, mode: options.mode || 'active' })
  const kernel = createKernel({ paths, dataDir: dir, mode: options.mode || 'active', config: createConfig(), now: () => now, host,
    presentation: { async publish(intent) { published.push(intent); return { ok: true } } } })
  const started = kernel.start()
  assert.equal(started.ok, true, JSON.stringify(started))
  t.after(async () => { await kernel.stop(); fs.rmSync(dir, { recursive: true, force: true }) })
  const submit = (kind, payload, extra = {}) => kernel.submit({ schemaVersion: 1, commandId: 'test:' + (++seq), characterId: kernel.info().characterId, kind, payload, ...extra })
  return { kernel, paths, dir, requests, published, submit, now: () => now, advance: ms => { now += ms },
    read: fn => kernel._internals.store.read(fn), write: fn => kernel._internals.store.transaction(fn) }
}
async function drain(f) {
  for (let n = 0; n < 30; n++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    if (!f.read(gw => gw.listOperations(f.kernel.info().characterId, ['dispatched'])).length) break
  }
}
function owner(f, id = 'owner:one') { return f.submit('owner.message', { messageRef: id, text: '我想聊一会儿', ts: f.now() }) }
function observe(f, id = 'game:one') { return f.submit('world.observation', { observationId: id, kind: 'game.completed', observedAt: f.now(), freshUntil: f.now() + 3600000, payload: { actor: 'owner', observer: 'character', subject: 'owner', world: 'virtual', score: 42 } }) }

test('command receipt and owner state commit atomically', async t => {
  const f = fixture(t)
  const gw = f.kernel._internals.store.gateway(), original = gw.putCommandReceipt
  gw.putCommandReceipt = () => { throw new Error('injected_receipt_write_failure') }
  const result = await owner(f)
  gw.putCommandReceipt = original
  assert.equal(result.ok, false)
  assert.equal(f.read(g => g.getSource('owner:one')), null, 'unacknowledged command must not leave a committed source')
})
test('stale expected revision cannot mutate identity', async t => {
  const f = fixture(t)
  const r = await f.submit('identity.update', { displayName: 'changed' }, { expectedRevision: 999 })
  assert.equal(r.code, 'stale_revision')
})
test('observation provenance survives projection and forgetting removes it', async t => {
  const f = fixture(t)
  const r = await observe(f)
  assert.equal(r.ok, true)
  const before = f.kernel.read({ kind: 'context' }).sections.observations[0]
  assert.equal(before.sourceId, r.sourceId)
  assert.equal(before.actor, 'owner')
  await f.submit('owner.forget', { sourceIds: [r.sourceId] })
  assert.equal(f.kernel.read({ kind: 'context' }).sections.observations.length, 0)
})
test('active owner conversation rejects autonomous contact before model work', async t => {
  const f = fixture(t)
  await owner(f)
  await f.submit('owner.reminder', { subject: '看看最近如何', dueAt: f.now() })
  const r = await f.kernel._internals.runBehaviorTick()
  assert.equal(r.action, 'wait')
  assert.equal(f.requests.filter(r => r.method === 'model.complete' && r.params.task !== 'extract').length, 0)
})
test('a real observation produces one sourced artifact and is not consumed twice', async t => {
  const f = fixture(t)
  await observe(f)
  const r = await f.kernel._internals.runBehaviorTick()
  assert.equal(r.action, 'plan')
  await drain(f)
  const operations = f.kernel.read({ kind: 'operations' }).operations
  assert.equal(operations[0].status, 'succeeded', JSON.stringify(operations))
  assert.equal(f.read(g => g.listArtifacts(f.kernel.info().characterId)).length, 1)
  assert.equal(f.read(g => g.getPlan(r.planId)).status, 'completed')
  f.advance(3600001)
  await f.kernel._internals.runBehaviorTick()
  await drain(f)
  assert.equal(f.kernel.read({ kind: 'operations' }).operations.length, 1)
})
test('failed or duplicate internal receipt cannot apply a state change', async t => {
  const f = fixture(t), k = f.kernel
  const prep = f.write(g => k._internals.executor.prepare(g, { characterId: k.info().characterId, capabilityId: 'virtual.rest_local', capabilityVersion: 1,
    input: { minutes: 15 }, grantedScopes: new Set(['character:state:write']), sourceRefs: [], epoch: k.info().epoch, dedupeKey: 'rest:one' }))
  assert.equal(prep.ok, true)
  f.write(g => k._internals.executor.markDispatchStart(g, prep.operation.operationId, f.now()))
  const before = k.read().state
  await f.submit('operation.receipt', { operationId: prep.operation.operationId, result: { outcome: 'failed', error: 'not_done' } })
  assert.deepEqual(k.read().state, before)
})
test('pending deletion cleanup survives a main transaction rollback', async t => {
  const f = fixture(t)
  await owner(f)
  const lifecycle = require('../character/memory/lifecycle.cjs')
  assert.throws(() => f.write(gw => { lifecycle.forget({ gw, policyStore: f.kernel._internals.policyStore, characterId: f.kernel.info().characterId, sourceIds: ['owner:one'], now: f.now(), seq: 2 }); throw new Error('crash_before_commit') }))
  assert.equal(f.kernel._internals.policyStore.pendingCleanup().length, 1)
})
test('policy export includes more than 2000 tombstones', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-policy-'))
  const store = createPolicyStore({ file: path.join(dir, 'policy.sqlite') })
  store.open()
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  store.recordDeletion(Array.from({ length: 2101 }, (_, n) => 'source:' + n), 'fixture')
  assert.equal(store.exportSidecar().deletions.length, 2101)
})
test('presentation reaches a live Electron webContents', async () => {
  const sent = []
  const host = createHost({ env: { DESKPET_CHARACTER_KERNEL: 'active' }, dataDir: os.tmpdir(), webContentsProvider: () => [{ isDestroyed: () => false, send: (...args) => sent.push(args) }] })
  const r = await host.publishPresentation({ presentationId: 'p:1', text: 'hello', channel: 'text', epoch: 1 })
  assert.equal(r.ok, true)
  assert.equal(sent.length, 1)
})
test('JSON proposal parser rejects prose around a JSON object', () => {
  const g = createModelGateway({ host: {}, config: createConfig() })
  assert.equal(g.parseJson('思考内容 {"action":"wait"} 解释').ok, false)
  assert.equal(g.parseJson('```json\n{"action":"wait"}\n```').ok, true)
})

test('owner conversation ends explicitly and a reasoned no-event contact can resume', async t => {
  const f = fixture(t, { model: async params => {
    if (params.task === 'decide') {
      const p = JSON.parse(params.messages.at(-1).content)
      return { ok: true, text: JSON.stringify({ action: 'select', opportunityId: p.candidates[0].opportunityId, recipeId: p.recipes[0].recipeId }) }
    }
    return { ok: true, text: '现在想聊点什么？' }
  } })
  assert.equal((await f.kernel._internals.runBehaviorTick()).reason, 'no_opportunity')
  await owner(f)
  await f.submit('owner.control', { action: 'conversation_end' })
  f.advance(4 * 3600000 + 1)
  const built = f.read(g => f.kernel._internals.candidates.build(g, { characterId: f.kernel.info().characterId, now: f.now(), deleted: new Set(), observations: [] }))
  assert.equal(built.opportunities[0].kind, 'social_contact')
  assert.deepEqual(built.opportunities[0].evidenceRefs, [])
  const r = await f.kernel._internals.runBehaviorTick()
  assert.equal(r.action, 'plan', JSON.stringify(r))
  await drain(f)
  assert.equal(f.published.length, 1)
  const request = f.requests.find(r => r.method === 'model.complete' && r.params.task === 'express')
  assert.ok(JSON.stringify(request).includes('social_contact'))
  f.advance(3600001)
  await f.kernel._internals.runBehaviorTick()
  assert.equal(f.published.length, 1, 'unanswered contact must not be repeated')
})

test('late decision after owner input cannot dispatch a plan', async t => {
  let resolveModel, entered
  const started = new Promise(resolve => { entered = resolve })
  const f = fixture(t, { model: params => new Promise(resolve => { resolveModel = resolve; entered(params) }) })
  await observe(f)
  const pending = f.kernel._internals.runBehaviorTick()
  const params = await started
  await owner(f)
  const p = JSON.parse(params.messages.at(-1).content)
  resolveModel({ ok: true, text: JSON.stringify({ action: 'select', opportunityId: p.candidates[0].opportunityId, recipeId: p.recipes[0].recipeId }) })
  assert.equal((await pending).reason, 'decision_invalidated')
  assert.equal(f.kernel.read({ kind: 'operations' }).operations.length, 0)
})

test('successful internal receipt changes state once across duplicate commands', async t => {
  const f = fixture(t), k = f.kernel
  const prepared = f.write(g => k._internals.executor.prepare(g, { characterId: k.info().characterId, capabilityId: 'virtual.rest_local', capabilityVersion: 1,
    input: { minutes: 15 }, grantedScopes: new Set(['character:state:write']), sourceRefs: [], epoch: k.info().epoch, dedupeKey: 'rest:duplicate' }))
  const op = f.write(g => k._internals.executor.markDispatchStart(g, prepared.operation.operationId, f.now())).operation
  const result = await k._internals.executor.dispatch(op, { input: { minutes: 15 } })
  assert.equal(result.outcome, 'succeeded')
  assert.equal((await f.submit('operation.receipt', { operationId: op.operationId, result })).ok, true)
  const state = k.read().state
  await f.submit('operation.receipt', { operationId: op.operationId, result })
  assert.deepEqual(k.read().state, state)
})

test('backup contains artifacts; restoring an old backup applies newer local deletions before reads', async t => {
  const f = fixture(t), { createBackupManager } = require('../character/storage/backup.cjs')
  const obs = await observe(f)
  await f.kernel._internals.runBehaviorTick(); await drain(f)
  const manager = createBackupManager({ ...f.kernel._internals, paths: f.paths, now: f.now })
  const backup = manager.create()
  assert.equal(backup.ok, true, JSON.stringify(backup))
  assert.equal(backup.manifest.files.artifacts.length, 1)
  assert.equal(manager.listBackups().length, 1)
  await f.submit('owner.forget', { sourceIds: [obs.sourceId] })
  f.kernel._internals.policyStore.recordPermissionRevocation('presentation:text', 'test')
  const dataDir = path.join(f.dir, 'restored'), paths = resolvePaths({ dataDir, mode: 'active' })
  assert.equal(manager.restoreToNewDirectory(backup.directory, paths.root).ok, true)
  const restored = createKernel({ paths, dataDir, config: createConfig(), mode: 'active', now: f.now })
  try {
    assert.equal(restored.start().ok, true)
    assert.equal(restored._internals.policyStore.isDeleted(obs.sourceId), true)
    assert.equal(restored._internals.policyStore.isScopeRevoked('presentation:text'), true)
    assert.equal(restored.read({ kind: 'context' }).sections.observations.length, 0)
    assert.equal(restored._internals.store.read(g => g.allArtifacts(restored.info().characterId)).length, 0)
  } finally { await restored.stop() }
  fs.appendFileSync(path.join(backup.directory, 'policy.json'), 'corrupted')
  assert.equal(manager.inspect(backup.directory).usableAsCurrent, false)
})

test('backup rotation retains seven directories and never removes unrelated files', t => {
  const f = fixture(t), { createBackupManager } = require('../character/storage/backup.cjs')
  const manager = createBackupManager({ ...f.kernel._internals, paths: f.paths, now: f.now })
  fs.mkdirSync(f.paths.backups, { recursive: true })
  fs.writeFileSync(path.join(f.paths.backups, 'unrelated.json'), '{}')
  for (let n = 0; n < 9; n++) { f.advance(86400000); assert.equal(manager.create().ok, true) }
  assert.equal(manager.listBackups().length, 7)
  assert.equal(fs.existsSync(path.join(f.paths.backups, 'unrelated.json')), true)
})

test('bundle validation rejects malformed, traversal and tampered packages', t => {
  const f = fixture(t), exp = f.kernel._internals.exporter
  const result = exp.exportPackage()
  assert.equal(exp.inspectPackage(result.directory).ok, true)
  const file = path.join(result.directory, 'manifest.json')
  fs.writeFileSync(file, '{}')
  assert.equal(exp.inspectPackage(result.directory).usableAsCurrent, false)
  result.manifest.files.database.name = '../character.sqlite'
  fs.writeFileSync(file, JSON.stringify(result.manifest))
  assert.equal(exp.inspectPackage(result.directory).usableAsCurrent, false)
})

test('source deletion remains effective across a crash between policy and main commit', async t => {
  const f = fixture(t), obs = await observe(f), lifecycle = require('../character/memory/lifecycle.cjs')
  assert.throws(() => f.write(gw => { lifecycle.forget({ gw, policyStore: f.kernel._internals.policyStore, characterId: f.kernel.info().characterId, sourceIds: [obs.sourceId], now: f.now(), seq: 2 }); throw Error('crash') }))
  assert.equal(f.kernel._internals.exporter.exportPackage().reason, 'deletion_cleanup_pending')
  await f.kernel.stop()
  const k = createKernel({ paths: f.paths, dataDir: f.dir, config: createConfig(), now: f.now })
  try {
    assert.equal(k.start().recoveredCleanup, 1)
    assert.equal(k.read({ kind: 'context' }).sections.observations.length, 0)
    assert.equal(k._internals.policyStore.pendingCleanup().length, 0)
  } finally { await k.stop() }
})

test('projector structured sections retain exactly the items admitted by the character budget', () => {
  const projector = require('../character/context/projector.cjs').createProjector({ config: createConfig() })
  const result = projector.assemble({ memories: [{ id: 'large', text: 'x'.repeat(900) }, { id: 'small', text: 'yes' }] }, 300)
  assert.deepEqual(result.accepted.memories.map(x => x.id), ['small'])
  assert.ok(result.used <= 300)
})

test('unfinished active cutover cannot start a second live writer through an environment flag', () => {
  const host = createHost({ env: { DESKPET_CHARACTER_KERNEL: 'active' }, dataDir: os.tmpdir() })
  assert.equal(host.start().code, 'active_cutover_incomplete')
  assert.equal(host.isWritable(), false)
})

test('renderer IPC rejects forged operation results, growth and unregistered senders', async () => {
  const handlers = {}, sender = { mainFrame: {} }
  const host = createHost({ env: {}, dataDir: os.tmpdir(), webContentsProvider: () => [sender] })
  host.registerIpc({ handle: (name, fn) => { handlers[name] = fn } })
  for (const kind of ['operation.receipt', 'growth.update', 'world.observation']) assert.equal((await handlers['character:submit']({ sender, senderFrame: sender.mainFrame }, { kind })).code, 'not_authorized')
  assert.equal((await handlers['character:read']({ sender: {} }, {})).code, 'not_authorized')
})

test('legacy import is idempotent and refuses changed forced imports or invalid policy', async t => {
  const f = fixture(t)
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-import-'))
  const store = require('../character/storage/store.cjs').createStore({ file: path.join(targetDir, 'import-target.sqlite') })
  const policyStore = createPolicyStore({ file: path.join(targetDir, 'import-policy.sqlite') })
  const importer = require('../character/storage/import-legacy.cjs').createImporter({ store, policyStore, dataDir: f.dir, now: f.now })
  t.after(() => { store.close(); policyStore.close(); fs.rmSync(targetDir, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(f.dir, 'character-chat-history.json'), JSON.stringify([{ role: 'user', text: '这是一条隔离输入', messageRef: 'legacy:1', ts: f.now() }]))
  // Bootstrap uses an empty destination before starting the state clock.
  const first = importer.run()
  assert.equal(first.ok, true, JSON.stringify(first))
  const id = store.read(g => g.getMeta('character_id'))
  assert.equal(importer.run({ force: true }).idempotent, true)
  fs.writeFileSync(path.join(f.dir, 'pet-state.json'), JSON.stringify({ stats: { energy: 80 } }))
  assert.equal(importer.run({ force: true }).reason, 'incremental_import_requires_merge')
  assert.equal(store.read(g => g.getMeta('character_id')), id)
  fs.writeFileSync(path.join(f.dir, 'character-forgotten.json'), '[]')
  assert.equal(importer.run().reason, 'legacy_policy_shape_invalid')
})

test('growth uses persisted permitted sources and absolute daily spending, not model timestamps', async t => {
  const f = fixture(t), growth = require('../character/domain/growth.cjs'), config = createConfig()
  const refs = ['event:source1', 'event:source2', 'event:source3']
  for (let n = 0; n < refs.length; n++) f.write(g => g.putSource({ sourceId: refs[n], characterId: f.kernel.info().characterId, sourceKind: 'owner_message', permission: 'granted', world: 'user_report', trust: 'owner_statement', sourceHash: hash(refs[n]), occurredAt: f.now() - (3 - n) * 86400000, observedAt: f.now() }))
  const apply = delta => f.write(g => growth.applyInterestUpdate(g, { characterId: f.kernel.info().characterId, topicKey: 'drawing', sourceRefs: refs, sourceTimestamps: [f.now()], delta, config, now: f.now() }))
  assert.equal(apply(0.03).ok, true)
  assert.equal(apply(-0.02).ok, true)
  assert.equal(apply(0.03).reason, 'daily_cap_reached')
  await f.submit('owner.forget', { sourceIds: [refs[0]] })
  assert.equal(apply(0.01).reason, 'insufficient_independent_sources')
})

test('first legacy import cannot overwrite an already used candidate', async t => {
  const f = fixture(t)
  await owner(f)
  const before = f.kernel.read().state
  assert.equal(f.kernel._internals.importer.run().reason, 'import_target_not_empty')
  assert.deepEqual(f.kernel.read().state, before)
})
