'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createStore, digest } = require('../platform-store.cjs')
const { createDomain } = require('../platform-domain.cjs')
const { createPackages } = require('../platform-packages.cjs')
const { create: createCapabilities } = require('../renderer/core/capabilities.js')
const { create: createRuntime } = require('../renderer/core/character-runtime.js')
const { create: createPresentation } = require('../renderer/core/presentation-plan.js')
const { project } = require('../renderer/dialogue/context-projector.js')
const Life = require('../renderer/life/pet-life.js')
const evidenceRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'deskpet-platform-'))
fs.mkdirSync(evidenceRoot, { recursive: true })
let number = 0
const dir = label => { const p = path.join(evidenceRoot, (++number) + '-' + label); fs.mkdirSync(p, { recursive: true }); return p }
const source = (ref = 'user:1', text = '我喜欢无糖茶。', ts = Date.now()) => ({ role: 'user', messageRef: ref, text, ts })
const input = src => ({ messageRef: src.messageRef, ts: src.ts, userText: src.text, memory: { kind: 'preference', quote: src.text, topic: '无糖茶' }, conversation: null, replyTo: null, eligibleMemory: true })
function fact(store, src, kind = 'preference', topic = '无糖茶') {
  store.acceptSource(src); store.beginFact({ ...input(src), memory: { kind, quote: src.text, topic } })
  for (const step of ['lifeApplied', 'memoryAccepted', 'memoryPersisted']) store.advanceFact(src.messageRef, step)
}
function registry(store, extra = {}) { return createCapabilities({ store, authorize: () => true, ...extra }) }
test('every fact checkpoint failure reopens at the last acknowledged obligation', () => {
  const boundaries = ['source', 'fact_begin', 'fact_lifeApplied', 'fact_memoryAccepted', 'fact_memoryPersisted']
  for (const boundary of boundaries) for (const suffix of ['before_write', 'before_rename']) {
    const directory = dir(boundary + '-' + suffix); let fail = null
    const s = source(), store = createStore(directory, { fault: at => { if (at === fail) throw Error('injected_disk_failure') } })
    if (boundary !== 'source') store.acceptSource(s)
    if (!['source', 'fact_begin'].includes(boundary)) store.beginFact(input(s))
    if (['fact_memoryAccepted', 'fact_memoryPersisted'].includes(boundary)) store.advanceFact(s.messageRef, 'lifeApplied')
    if (boundary === 'fact_memoryPersisted') store.advanceFact(s.messageRef, 'memoryAccepted')
    const before = store.snapshot(); fail = boundary + ':' + suffix
    assert.throws(() => boundary === 'source' ? store.acceptSource(s) : boundary === 'fact_begin' ? store.beginFact(input(s)) : store.advanceFact(s.messageRef, boundary.replace('fact_', '')), /injected_disk_failure/)
    assert.deepEqual(createStore(directory).snapshot(), before)
  }
})
test('real PetLife and MemoryEngine resume only missing persistence after restart', async () => {
  const directory = dir('real-life-memory'), src = source(), clock = () => src.ts + 1000
  let store = createStore(directory, { now: clock }); store.acceptSource(src)
  const lifeStore = require('../pet-life-store.cjs').createStore(directory)
  const memoryFile = path.join(directory, 'memories.json')
  function memoryEngine(failSave) {
    const timers = new Set(), window = { pet: {
      memoryLoad: async () => fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile)) : null,
      memorySave: async value => { if (failSave) return false; fs.writeFileSync(memoryFile, JSON.stringify(value)); return true }
    } }
    const sandbox = { window, console, Date, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); timers.add(t); return t }, clearTimeout }
    vm.createContext(sandbox)
    for (const file of ['memory-store.js', 'memory-engine.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/memory', file), 'utf8'), sandbox)
    return { engine: window.MemoryEngine, stop: () => { for (const t of timers) clearTimeout(t) } }
  }
  let memory = memoryEngine(true); await memory.engine.init()
  let runtime = createRuntime({ now: clock })
  function session() {
    return Life.createSession({ load: () => lifeStore.load(), save: next => lifeStore.save(next), runtimeOwned: () => true,
      authorizeFacts: (p, r) => runtime.isFactAuthorized(p, r), loadSource: async r => store.source(r), memories: () => memory.engine.getMemories(),
      remember: c => memory.engine.admitCandidate(c), factBegin: i => store.beginFact(i), factAdvance: (r, step, detail) => store.advanceFact(r, step, detail),
      hasMemoryEvidence: candidate => memory.engine.getMemories().some(m => (candidate.sourceEventIds || []).some(id => (m.sourceEventIds || []).includes(id)) && (m.content === candidate.content || m.originalContent === candidate.content)),
      flushMemory: () => memory.engine.flushAndWait({ timeoutMs: 60 }) })
  }
  let life = session(), permit = runtime.restoreFacts(src, clock() + 120000)
  const result = await life.recordTurn({ ...input(src), metadataOnly: true, runtimeFactExecution: permit })
  assert.equal(result.ok, false); assert.equal(result.lifeCommitted, true)
  assert.equal(store.operation('fact:' + src.messageRef).obligations.memoryPersisted, false)
  const revision = life.snapshot().state.revision
  memory.stop(); runtime.shutdown()
  store = createStore(directory, { now: clock }); memory = memoryEngine(false); await memory.engine.init(); runtime = createRuntime({ now: clock }); life = session()
  const [job] = store.pendingFacts(); permit = runtime.restoreFacts(src, job.expiresAt)
  const recovered = await life.recordTurn({ ...job.input, metadataOnly: true, runtimeFactExecution: permit })
  assert.equal(recovered.ok, true); assert.equal(life.snapshot().state.revision, revision)
  assert.equal(JSON.parse(fs.readFileSync(memoryFile)).memories.length, 1)
  assert.equal(store.operation('fact:' + src.messageRef).status, 'completed')
  await life.recordTurn({ ...job.input, metadataOnly: true, runtimeFactExecution: permit })
  assert.equal(memory.engine.getMemories().length, 1); assert.equal(life.snapshot().state.revision, revision)
  runtime.shutdown(); memory.stop()
})
test('200 item history rotation retains adopted source, deletion survives old backup and redaction failure', () => {
  const directory = dir('retention-delete'); let fault = false
  const store = createStore(directory, { fault: b => { if (fault && b === 'redaction:before_write') throw Error('redaction_crash') } })
  const src = source(); fact(store, src); const backup = store.backup()
  for (let n = 0; n < 205; n++) store.acceptSource(source('ordinary:' + n, '普通合成输入 ' + n))
  assert.equal(store.source(src.messageRef).text, src.text)
  fault = true; assert.throws(() => store.forget([src.messageRef]), /redaction_crash/)
  const reopened = createStore(directory); reopened.restore(backup)
  assert.equal(reopened.source(src.messageRef), null)
  assert.equal(reopened.operation('fact:' + src.messageRef).status, 'invalidated')
  const m = { memories: [{ evidenceRefs: [{ messageRef: src.messageRef }], content: 'private synthetic' }] }
  assert.equal(reopened.filterMemory(m).memories.length, 0)
  assert.equal(reopened.filterLife({ turns: [{ messageRef: src.messageRef, userText: src.text }], artifacts: [], days: [] }).turns.length, 0)
  assert.throws(() => reopened.acceptSource(src), /source_forgotten/)
})
test('committed-life compensation has a finite fresh lease and unselected recovery jobs do not consume attempts', () => {
  let time = Date.now(); const directory = dir('late-compensation'), store = createStore(directory, { now: () => time })
  for (let n = 0; n < 10; n++) { const src = source('pending:' + n, '我喜欢无糖茶。', time); store.acceptSource(src); store.beginFact(input(src)); store.advanceFact(src.messageRef, 'lifeApplied') }
  time += 130000
  const resumed = store.pendingFacts(); assert.equal(resumed.length, 8); assert.equal(resumed[0].expiresAt, time + 120000)
  assert.equal(store.operation('fact:pending:9').attempts, 0)
  time += 86400001; assert.equal(store.pendingFacts().length, 0)
  assert.equal(store.operation('fact:pending:9').status, 'expired')
})
test('corrupt and unsupported checkpoints fail closed without replacement', () => {
  for (const type of ['corrupt', 'schema']) {
    const directory = dir(type), file = path.join(directory, 'character-platform.json')
    const payload = { schema: 900, operations: {}, sources: {} }
    const raw = type === 'corrupt' ? '{broken' : JSON.stringify({ hash: digest(payload), payload })
    fs.writeFileSync(file, raw); const store = createStore(directory)
    assert.throws(() => store.acceptSource(source()), /platform_read_failed/)
    assert.equal(fs.readFileSync(file, 'utf8'), raw)
  }
})
test('unknown dispatched external effects never automatically repeat and query receipts can reconcile', async () => {
  const store = createStore(dir('unknown')), r = registry(store); let executions = 0
  r.register({ id: 'mock.external', provider: 'mock', version: '1', effect: 'external', timeoutMs: 15 }, async () => { executions++; return new Promise(() => {}) })
  const proposal = { id: 'operation:unknown', capabilityId: 'mock.external', effect: 'external', input: {}, deadline: Date.now() + 1000 }
  const result = await r.execute(proposal); assert.equal(result.status, 'unknown_after_dispatch')
  assert.equal((await r.execute(proposal)).replay, true); assert.equal(executions, 1)
  store.updateOperation(proposal.id, 'completed', { ok: true, externallyQueried: true })
  assert.equal((await r.execute(proposal)).ok, true); assert.equal(executions, 1)
})
test('both real built-in adapters obey contracts, cancellation and capability visibility', async () => {
  const store = createStore(dir('actual-adapters')), runtime = createRuntime(), r = registry(store, { authorize: (e, effect) => effect === 'read' || runtime.isAuthorized(e) })
  const life = Life.createSession({ load: async () => ({ ok: true, state: Life.emptyState() }), save: async () => ({ ok: true }), runtimeOwned: () => true,
    authorize: e => runtime.isAuthorized(e), continuation: id => runtime.continuation(id) })
  const at = Date.now(), lifeInput = { nowTs: at, visible: true, busy: false, selfState: { energy: 80, satiety: 80, thirst: 80 }, availableActions: ['idle-bubbles'], memories: [] }
  await life.tick(lifeInput)
  r.register({ id: 'life.virtual-activity', provider: 'builtin.pet-life', version: '1', effect: 'virtual' }, async (v, host, e) => { const value = await life.startActivity(v.proposal, v.input, e); return { ok: value.ok, awaitingReceipt: true, value } })
  let samples = 0
  r.register({ id: 'desktop.observe', provider: 'builtin.desktop', version: '1', effect: 'read', services: [] }, async (_, host) => { samples++; assert.rejects(host.request('send.text', {}), /host_service_denied/); return { ok: true, value: { app: 'synthetic.exe', cat: '工作', eventAt: at, trust: 'observation' } } })
  const observed = await r.execute({ id: 'desktop:test', capabilityId: 'desktop.observe', effect: 'read', input: {}, deadline: at + 1000 })
  assert.equal(observed.receipt.value.trust, 'observation'); assert.equal(samples, 1)
  await runtime.submit({ kind: 'activity' }, async e => {
    const p = { id: 'activity:one', capabilityId: 'life.virtual-activity', effect: 'virtual', input: { proposal: life.proposeActivity(lifeInput), input: lifeInput }, deadline: at + 1000 }
    const [a, b] = await Promise.all([r.execute(p, e), r.execute(p, e)])
    assert.equal(a.status, 'awaiting_receipt'); assert.deepEqual(a, b); return a
  })
  runtime.cancel('owner_input'); await life.tick({ ...lifeInput, nowTs: at + 60000 })
  assert.equal(life.context(at).activities[0].status, 'paused'); assert.equal(life.getArtifacts().length, 0)
  r.disable('desktop.observe'); assert.equal(r.available().some(c => c.id === 'desktop.observe'), false); runtime.shutdown()
})
test('actual preload exports the same durable store contract used by renderer executors', async () => {
  const store = createStore(dir('preload-contract')), exposed = {}, methods = {
    'platform:operation': id => store.operation(id), 'platform:operationBegin': proposal => store.beginOperation(proposal),
    'platform:operationUpdate': (id, status, receipt) => store.updateOperation(id, status, receipt)
  }
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } }, ipcRenderer: { sendSync: () => ({ authority: false, mode: 'off' }), invoke: async (name, ...args) => methods[name](...args) } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), { require: () => electron, Date })
  const r = createCapabilities({ store: exposed.pet.platform, authorize: () => true })
  r.register({ id: 'life.virtual-project', provider: 'builtin', version: '1', effect: 'virtual' }, async () => ({ ok: true, value: { virtual: true } }))
  const result = await r.execute({ id: 'preload:actual', capabilityId: 'life.virtual-project', effect: 'virtual', input: {}, deadline: Date.now() + 1000 })
  assert.equal(result.ok, true); assert.equal(store.operation('preload:actual').status, 'completed')
})
test('appraisal is idempotent, correction changes future choices without relation inflation', () => {
  let time = Date.now(); const store = createStore(dir('growth'), { now: () => time }), domain = createDomain(store, { now: () => time })
  const preference = source('pref:1'); fact(store, preference); domain.observeFact(preference.messageRef)
  assert.equal(domain.observeFact(preference.messageRef).duplicate, true)
  const candidates = [{ id: 'tea', text: '无糖茶', priority: 0 }, { id: 'other', text: '其他话题', priority: 1 }]
  assert.equal(domain.select(candidates).selected.id, 'tea')
  time += 1000; const corrected = source('pref:2', '我不再喜欢无糖茶。', time); fact(store, corrected, 'dislike'); domain.observeFact(corrected.messageRef)
  const result = domain.select(candidates); assert.equal(result.selected.id, 'other'); assert.match(result.excluded[0].reason, /explicit_dislike/)
  assert.equal(Object.values(store.snapshot().appraisals).reduce((a, r) => a + r.relationDelta, 0), 0)
  store.forget([corrected.messageRef]); assert.equal(domain.projection().preferences.length, 0)
})
test('actual renderer opportunity entry consumes evidence-ranked and corrected speech candidates', async () => {
  const store = createStore(dir('actual-choice')), domain = createDomain(store), src = source('choose:1')
  fact(store, src, 'preference', '喝茶'); domain.observeFact(src.messageRef)
  const text = fs.readFileSync(path.join(__dirname, '../renderer/pet.js'), 'utf8'), match = /^  async function decideCharacterEvent\(/m.exec(text), rest = text.slice(match.index), end = /^  }\r?$/m.exec(rest)
  const pools = [], candidates = [{ id: 'tea', source: 'memory', text: '无糖茶', forms: ['share'], sourceKeys: [] }, { id: 'other', source: 'memory', text: '其他话题', forms: ['share'], sourceKeys: [] }]
  const window = { PlatformCandidate: { enabled: true }, CharacterSnapshot: { toCharacterAIContext: () => ({ selfState: {}, petLife: {} }) },
    PetLife: { snapshot: () => ({ ready: true }), candidates: () => candidates.map(c => ({ ...c })), proposeActivity: () => null },
    MemoryEngine: { getMemories: () => [] }, Gen2: { proactiveDecide: async p => { pools.push(p.candidates); return { ok: true, silent: true } } }, pet: { characterHistoryLoad: async () => [] } }
  const sandbox = vm.createContext({ window, Date, document: { activeElement: null }, R: {}, chatBusy: false, charcBusy: false, pendingInter: false, game: null, bubbleEl: { dataset: {} },
    Pace: { blocked: () => false }, proactiveOn: true, proactiveOpeningLog: [], chatHistoryCache: [], runtimeLifeInput: () => ({}), proactiveTopicContext: () => ({}),
    platformBridge: { projection: async () => domain.projection(), select: async (cs, policy) => domain.select(cs, policy), capabilities: async () => ({ capabilities: [] }) }, lifeCapabilities: { available: () => [] } })
  vm.runInContext(rest.slice(0, end.index + end[0].length), sandbox)
  const execution = { assertCurrent() {} }, state = { quietUntil: 0, lastAutomatic: 0 }
  await sandbox.decideCharacterEvent({ kind: 'opportunity', origin: 'automatic' }, state, execution)
  assert.equal(pools[0][0].id, 'tea')
  const correction = source('choose:2', '我不再喜欢无糖茶。', src.ts + 1000); fact(store, correction, 'dislike', '饮品'); domain.observeFact(correction.messageRef)
  await sandbox.decideCharacterEvent({ kind: 'opportunity', origin: 'automatic' }, state, execution)
  assert.equal(pools[1].some(c => c.id === 'tea'), false)
})
test('validated thread cancellation reconciles the separate concern/project and late older interpretation cannot reopen it', () => {
  const store = createStore(dir('thread-reconcile')), domain = createDomain(store), src = source('thread:1', '我打算整理一份小记。')
  fact(store, src, 'plan', '小记'); domain.observeFact(src.messageRef)
  domain.reconcileLife({ threads: [{ id: 'thread:actual', messageRef: src.messageRef, lastMessageRef: 'correction:1', status: 'cancelled' }] }, 'correction:1')
  assert.equal(domain.projection().concerns.length, 0); assert.equal(domain.projection().projects.length, 0)
  const later = source('late:newer', '我不再喜欢无糖茶。', src.ts + 1000); fact(store, later, 'dislike', '饮品'); domain.observeFact(later.messageRef)
  const older = source('late:older', '我喜欢无糖茶。', src.ts); fact(store, older, 'preference', '喝茶')
  assert.equal(domain.observeFact(older.messageRef).ignoredLateInterpretation, true)
  assert.equal(domain.projection().preferences.filter(p => p.kind === 'preference').length, 0)
})
test('a two-step virtual project pauses across restart, creates only evidenced virtual material and honors cancellation', async () => {
  let time = Date.now(), directory = dir('virtual-project'), store = createStore(directory, { now: () => time }), domain = createDomain(store, { now: () => time })
  const src = source('plan:1', '我打算整理一份小记。', time); fact(store, src, 'plan', '小记'); domain.observeFact(src.messageRef)
  const projectId = domain.projection().projects[0].id
  function r() { const value = registry(store); value.register({ id: 'life.virtual-project', provider: 'builtin.virtual-notebook', version: '1', effect: 'virtual' }, (i, host) => domain.stepProject(i.projectId, host.operationId)); return value }
  const proposal = n => ({ id: 'project:' + n, capabilityId: 'life.virtual-project', effect: 'virtual', input: { projectId }, sourceRefs: [src.messageRef], deadline: time + 30000 })
  assert.equal((await r().execute(proposal(0))).receipt.value.kind, 'material_selected')
  assert.equal(store.snapshot().projects[projectId].status, 'paused')
  time += 3600000; store = createStore(directory, { now: () => time }); domain = createDomain(store, { now: () => time })
  assert.equal((await r().execute(proposal(1))).receipt.value.virtual, true)
  assert.equal(store.snapshot().projects[projectId].status, 'completed')
  assert.equal(domain.projection().projects.length, 0)
  const cancellation = source('plan:2', '不要再整理小记了。', ++time); fact(store, cancellation, 'dislike', '小记'); domain.observeFact(cancellation.messageRef)
  assert.equal(domain.projection().concerns.length, 0)
  time += 100 * 86400000; assert.equal(domain.projection().concerns.length, 0)
})
test('shared attention coalesces competing sources, survives clock jump and does not catch up with a speech burst', () => {
  let time = Date.now(); const store = createStore(dir('attention'), { now: () => time }), domain = createDomain(store, { now: () => time })
  const candidates = [{ id: 'desktop', coalesceKey: 'same', priority: 1 }, { id: 'life', coalesceKey: 'same', priority: 2 }, { id: 'offline', capabilityId: 'missing', priority: 10 }]
  assert.equal(domain.select(candidates, { capabilities: [] }).selected.id, 'life')
  domain.presented('life'); assert.equal(domain.select(candidates).selected, null)
  time -= 86400000; assert.equal(domain.select(candidates).selected, null)
  time += 90 * 86400000; const result = domain.select(candidates); assert.equal(result.selected.id, 'life')
  domain.presented(result.selected.id); assert.equal(domain.select(candidates).selected, null)
})
test('projector preserves proactive origins, source times, paired tools and task budgets', () => {
  const p = project('M2_say', { nowTs: Date.now(), history: [{ role: 'assistant', messageRef: 'a:1', text: '这是之前的主动开场', selfInitiated: true, ts: 12345 }],
    candidate: { id: 'note:1', text: '旧素材', date: '2026-10-01', fresh: false }, context: { selfState: { energy: 20 }, memories: [{ id: 'gone', status: 'suppressed', text: '不可用' }] },
    toolHistory: [{ type: 'tool_call', id: 'call:1' }, { type: 'tool_result', callId: 'call:1', text: 'result' }, { type: 'tool_call', id: 'unpaired' }] })
  assert.equal(p.data.recentInteractions[0].selfInitiated, true); assert.equal(p.data.recentInteractions[0].eventAt, 12345)
  assert.equal(p.data.selectedSource.fresh, false); assert.equal(p.data.toolPairs.length, 1); assert.ok(p.text.length <= p.trace.budget)
  const short = project('M1_short', { context: { memories: [{ text: 'x'.repeat(20000) }] } }); assert.equal(short.data.memoryEvidence, undefined)
})
test('actual Gen2/gateway/main provider object contains projected state and proactive source metadata', async () => {
  const sent = [], mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
  const main = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout,
    llmApiPref: () => ({ apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1', model: 'synthetic', temps: {} }), ModelRegistry: { purposeFor: () => 'character', latestFlashId: () => 'synthetic' },
    recordDirectModelUse() {}, pairAwareHistoryWindow: require('../renderer/memory/history-window.js').pairAwareHistoryWindow,
    fetch: async (_, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: '今天这件虚拟小事可以慢慢接着做。' }, finish_reason: 'stop' }], usage: { completion_tokens: 12 } }) } } })
  main.getModelConfig = () => require('../model-config.cjs').createModelConfig({ read: () => ({ llmApi: { apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1', model: 'synthetic' } }), write: () => true })
  main.getModelClient = () => require('../model-provider.cjs').createClient({ fetch: (...args) => main.fetch(...args) })
  vm.runInContext(mainSource.slice(mainSource.indexOf('async function callDirectLLM('), mainSource.indexOf("ipcMain.handle('llm:direct'")), main)
  const window = { PlatformCandidate: { enabled: true }, ContextProjector: require('../renderer/dialogue/context-projector.js'),
    pet: { llmDirect: p => main.callDirectLLM(p) }, PetLifeModule: Life }
  const sandbox = vm.createContext({ window, console, Date, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} } })
  for (const file of ['dialogue/slots.js', 'dialogue/aigateway.js', 'dialogue/gen2.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf8'), sandbox)
  const candidate = { id: 'self:actual', source: 'self_activity', text: '桌宠虚拟生活的小事', date: '2026-10-13', fresh: false, forms: ['share'], sourceKeys: ['user:source'] }
  const p = { context: { selfState: { energy: 22 }, recentInteractions: [{ role: 'assistant', text: '此前主动开口', ts: 12345, selfInitiated: true, messageRef: 'actual:proactive' }] }, candidates: [candidate], history: [], recentOpenings: [] }
  const raw = { focus: '虚拟小事', candidateId: candidate.id, form: 'share', speak: true }, v = Life.validateDecision({ ...raw, opening: raw.focus }, [candidate])
  const result = await window.Gen2.proactiveSay({ ok: true, prepared: { p, raw, v } })
  assert.equal(result.ok, true)
  const system = sent[0].messages.find(m => m.role === 'system').content
  assert.ok(system.includes('"energy":22')); assert.ok(system.includes('"selfInitiated":true')); assert.ok(system.includes('"eventAt":12345'))
  assert.ok(system.includes('2026-10-13')); assert.ok(system.includes('user:source'))
  assert.equal(sent[0].temperature, 0.8); assert.equal(sent[0].max_tokens, 200)
  assert.equal(window.LastContextProjection.task, 'M2_say')
})
test('provider truncation, network failure and invalid metadata never become a successful empty extraction', async () => {
  let mode = 'truncated', calls = 0
  const window = { PromptSlots: { join: x => x.join('\n') }, pet: { llmDirect: async () => { calls++; return mode === 'network' ? { ok: false, error: 'network' } : mode === 'empty-truncated' ? { ok: false, error: 'empty', completion: { finishReason: 'length' } } :
    { ok: true, text: mode === 'truncated' ? '{"memory":' : 'not JSON', completion: { finishReason: mode === 'truncated' ? 'length' : 'stop' } } } } }
  const sandbox = vm.createContext({ window, console, Date, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} } })
  for (const file of ['dialogue/aigateway.js', 'dialogue/gen2.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer', file), 'utf8'), sandbox)
  for (const [next, reason] of [['truncated', 'provider_truncated'], ['empty-truncated', 'provider_truncated'], ['network', 'network'], ['invalid', 'metadata_invalid_json']]) {
    mode = next; const before = calls, result = await window.Gen2.turnMeta({ userText: '我喜欢无糖茶。', history: [] })
    assert.equal(result.ok, false); assert.equal(result.reason, reason)
    assert.equal(calls - before, 1)
  }
})
test('explicit schema migration preserves legacy fields and pre-migration bytes; rollback cannot undo tombstones', () => {
  const directory = dir('schema-migration'), file = path.join(directory, 'character-platform.json'), src = source()
  const payload = { schema: 0, sources: { [src.messageRef]: src }, operations: {}, revision: 7, customLegacyField: { preserved: true } }
  const raw = JSON.stringify({ hash: digest(payload), payload }); fs.writeFileSync(file, raw)
  const store = createStore(directory, { migrate: true })
  assert.equal(store.snapshot().schema, 1); assert.equal(store.snapshot().customLegacyField.preserved, true)
  assert.equal(fs.readFileSync(file + '.pre-v1', 'utf8'), raw)
  const backup = store.backup(); store.forget([src.messageRef]); store.restore(backup)
  assert.equal(store.source(src.messageRef), null)
})
test('presentation drops stale text/body, prioritizes owners and keeps failure separate from action facts', async () => {
  const rows = [], plans = createPresentation({ receipt: row => rows.push(row) }), runtime = createRuntime({ presentation: plans })
  let old
  await runtime.submit({ kind: 'auto' }, async e => { old = e; e.continueAs('body'); e.publish(() => ({ ok: true })); return { ok: true } })
  const body = plans.claim({ owner: old.executionId, channel: 'body', priority: 10, isCurrent: old.isCurrent })
  runtime.cancel('owner_input'); assert.equal(plans.stage(body.token, 'playback_completed').ok, false)
  const high = plans.claim({ owner: 'human', channel: 'body', priority: 100 }); assert.equal(plans.claim({ owner: 'low', channel: 'body', priority: 1 }).ok, false)
  assert.equal(plans.stage(high.token, 'audio_failed').ok, true); plans.setVisible(false)
  assert.equal(plans.stage(high.token, 'playback_completed').ok, false)
  assert.equal(rows.some(r => r.phase === 'published'), true); assert.equal(rows.some(r => r.phase === 'playback_completed'), false)
  runtime.shutdown()
})
test('actual media player reports started only after play success and suppresses late cancelled/error starts', async () => {
  const window = {}, sandbox = vm.createContext({ window })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/animation/animation-player.js'), 'utf8'), sandbox)
  let resolve, starts = 0, failures = 0
  const pending = new Promise(r => { resolve = r }), video = { paused: true, play: () => pending, pause() {} }
  window.AnimationPlayer.play('one', video, { once: true, onStarted: () => starts++ })
  assert.equal(starts, 0); window.AnimationPlayer.stop(); resolve(); await new Promise(r => setImmediate(r)); assert.equal(starts, 0)
  video.play = () => Promise.resolve(); window.AnimationPlayer.play('two', video, { onStarted: () => starts++ }); await new Promise(r => setImmediate(r)); assert.equal(starts, 1)
  video.play = () => Promise.reject(Error('missing_asset')); window.AnimationPlayer.play('broken', video, { onStarted: () => starts++, onError: () => failures++ })
  await new Promise(r => setImmediate(r)); assert.equal(starts, 1); assert.equal(failures, 1)
})
function packageFixture(directory, id, version, code, extra = {}) {
  const folder = path.join(directory, id + '-' + version); fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'entry.cjs'), code)
  const hash = require('node:crypto').createHash('sha256').update(code).digest('hex')
  const manifest = { id, version, hostApi: 1, entry: 'entry.cjs', files: { 'entry.cjs': hash }, services: ['package.echo'],
    capabilities: [{ id: 'package.inspect', effect: 'read', input: { type: 'object', properties: {}, additionalProperties: false } }], ...extra }
  fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest)); return folder
}
test('two trusted packages install, migrate, fail upgrade, rollback, disable and uninstall without changing identity', async () => {
  const directory = dir('packages'), store = createStore(directory), r = registry(store), manager = createPackages(directory, store, r, { timeoutMs: 300 })
  const code = `module.exports={migrate:(data)=>({...data,count:(data.count||0)+1}),execute:async(_,input,host)=>({ok:true,value:await host.request('package.echo',{version:1})})}`
  try {
    for (const id of ['trusted.notes', 'trusted.desktop']) {
      const v1 = packageFixture(directory, id, '1.0.0', code)
      assert.equal((await manager.install(v1, false)).ok, false); assert.equal((await manager.install(v1, true)).ok, true)
      const v2 = packageFixture(directory, id, '2.0.0', code.replace('version:1', 'version:2'))
      assert.equal((await manager.install(v2, true)).ok, true); assert.equal(store.snapshot().namespaces[id].count, 2)
      const broken = packageFixture(directory, id, '3.0.0', `module.exports={start:()=>{throw Error('startup_failed')}}`)
      assert.equal((await manager.install(broken, true)).ok, false); assert.equal(store.snapshot().packages[id].version, '2.0.0')
      assert.equal((await manager.rollback(id)).ok, true); assert.equal(store.snapshot().packages[id].version, '1.0.0')
    }
    assert.equal(r.available().filter(c => c.id === 'package.inspect').length, 1)
    const receipt = await r.execute({ id: 'package:read', capabilityId: 'package.inspect', effect: 'read', input: {}, deadline: Date.now() + 1000 })
    assert.equal(receipt.ok, true); assert.equal(receipt.receipt.value.version, 1)
    for (const id of ['trusted.notes', 'trusted.desktop']) { await manager.disable(id); assert.equal((await manager.uninstall(id)).ok, true) }
    assert.equal(manager.health().active.length, 0); assert.equal(Object.keys(store.snapshot()).some(k => /persona|relationship/.test(k)), false)
    assert.equal(store.operation('package:read').receipt.value.version, 1)
  } finally { await manager.shutdown() }
})
test('worker timeout, read-only service abuse and content tampering remain contained', async () => {
  const directory = dir('package-faults'), store = createStore(directory), r = registry(store), manager = createPackages(directory, store, r, { timeoutMs: 100 })
  try {
    const denied = packageFixture(directory, 'trusted.denied', '1.0.0', `module.exports={execute:async(_,i,h)=>({ok:true,value:await h.request('send.text',i)})}`)
    assert.equal((await manager.install(denied, true)).ok, true)
    const p = { id: 'denied:1', capabilityId: 'package.inspect', effect: 'read', input: {}, deadline: Date.now() + 1000 }
    assert.match((await r.execute(p)).reason, /host_service_denied/); await manager.disable('trusted.denied')
    const hung = packageFixture(directory, 'trusted.hung', '1.0.0', `module.exports={execute:async()=>{while(true){}}}`)
    assert.equal((await manager.install(hung, true)).ok, true)
    assert.match((await r.execute({ ...p, id: 'hung:1' })).reason, /timeout/)
    const tampered = packageFixture(directory, 'trusted.tampered', '1.0.0', `module.exports={execute:()=>({ok:true})}`)
    fs.appendFileSync(path.join(tampered, 'entry.cjs'), '// tamper'); assert.equal((await manager.install(tampered, true)).reason, 'package_integrity')
    assert.ok(store.health().revision > 0)
  } finally { await manager.shutdown() }
})
test('restarts pause virtual execution, expire fact recovery and retain truthful interrupted provider diagnostics', () => {
  let time = Date.now(), directory = dir('restart-storm'), store = createStore(directory, { now: () => time })
  const src = source(); store.acceptSource(src); store.extraction(src.messageRef); store.beginFact(input(src))
  store.beginOperation({ id: 'virtual:restart', capabilityId: 'life.virtual-activity', effect: 'virtual', input: {}, deadline: time + 30000 })
  store.updateOperation('virtual:restart', 'dispatched'); store.updateOperation('virtual:restart', 'awaiting_receipt')
  for (let n = 0; n < 5; n++) { store = createStore(directory, { now: () => time }); store.recoverOperations(); store.pendingFacts() }
  assert.equal(store.operation('virtual:restart').status, 'paused'); assert.equal(store.operation('fact:' + src.messageRef).status, 'expired')
  assert.equal(store.operation('extraction:' + src.messageRef).reason, 'provider_interrupted_no_auto_retry')
  fs.writeFileSync(path.join(evidenceRoot, 'evidence.json'), JSON.stringify({ directory: evidenceRoot, limitations: ['virtual time is not multi-year real usage', 'mock desktop sample does not prove Windows native observation', 'trusted workers are not an OS sandbox'] }, null, 2))
})
test('180-day replay crosses months and restart without fabricating offline activity or exceeding working-set bounds', async () => {
  const directory = dir('180-day-replay'), store = require('../pet-life-store.cjs').createStore(directory)
  const start = new Date('2026-08-20T12:00:00+08:00').getTime()
  let life, plans = 0
  function reopen() { return Life.createSession({ load: store.load, save: store.save, runtimeOwned: () => true, authorize: () => false, continuation: () => null,
    plan: async () => { plans++; return {} } }) }
  life = reopen()
  for (let n = 0; n < 180; n++) {
    if (n % 30 === 0) { life = reopen(); await life.init() }
    await life.tick({ nowTs: start + n * 86400000, visible: n % 2 === 0, busy: false, aiEnabled: true, selfState: { energy: 80, satiety: 80, thirst: 80 }, availableActions: ['idle-bubbles'], memories: [] })
  }
  const state = life.snapshot().state
  assert.equal(plans, 0); assert.equal(state.days.flatMap(d => d.activities).filter(a => a.status === 'done').length, 0)
  assert.ok(state.days.length <= 30); assert.ok(JSON.stringify(state).length < 470000)
  fs.writeFileSync(path.join(directory, 'replay-result.json'), JSON.stringify({ virtualDays: 180, monthlyRestarts: 6, plans, completedOfflineActivities: 0, retainedDays: state.days.length, realMultiYearVerification: false }, null, 2))
})
test('queue and executor budgets reject excess work without dispatch; old receipts remain readable after disable', async () => {
  const runtime = createRuntime(), pending = [], r = registry(createStore(dir('budgets')))
  let resolve
  const blocked = new Promise(r => { resolve = r })
  pending.push(runtime.submit({ kind: 'owner', origin: 'user', id: 'first' }, async () => { await blocked; return { ok: true } }))
  await new Promise(r => setImmediate(r))
  for (let n = 0; n < 32; n++) pending.push(runtime.submit({ kind: 'owner', origin: 'user', id: 'queued:' + n }, async () => ({ ok: true })))
  assert.equal((await runtime.submit({ kind: 'owner', origin: 'user', id: 'over-budget' }, async () => ({ ok: true }))).reason, 'runtime_capacity')
  resolve(); await Promise.all(pending); runtime.shutdown()
  r.register({ id: 'capability.read', provider: 'builtin', version: '1', effect: 'read' }, async () => ({ ok: true, value: { evidenced: true } }))
  const proposal = { id: 'budget:receipt', capabilityId: 'capability.read', effect: 'read', input: {}, deadline: Date.now() + 1000 }
  await r.execute(proposal); r.disable('capability.read')
  const prior = await r.execute(proposal); assert.equal(prior.replay, true); assert.equal(prior.receipt.value.evidenced, true)
})
