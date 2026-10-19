'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { create } = require('../renderer/core/character-runtime.js')
const Life = require('../renderer/life/pet-life.js')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const turn = () => new Promise(resolve => setImmediate(resolve))
const at = new Date(2026, 9, 13, 14, 0).getTime()
function fixture(extra = {}) {
  const runtime = create(), accepted = [], sources = new Map(); let data = Life.emptyState(), planCalls = 0
  const life = Life.createSession({
    load: async () => ({ ok: true, state: structuredClone(data) }),
    save: async next => { data = structuredClone(next); return { ok: true } },
    plan: async () => { planCalls++; return {} }, remember: c => { accepted.push(c); return { ok: true } },
    runtimeOwned: () => true, authorize: e => runtime.isAuthorized(e), continuation: id => runtime.continuation(id),
    authorizeFacts: (permit, ref) => runtime.isFactAuthorized(permit, ref),
    loadSource: async ref => sources.get(ref) || null, ...extra
  })
  const input = { nowTs: at, visible: true, busy: false, aiEnabled: true,
    selfState: { energy: 80, satiety: 80, thirst: 80 }, availableActions: ['idle-bubbles'], memories: [] }
  return { runtime, life, input, accepted, sources, plans: () => planCalls }
}

test('real PetLife tick is progression only: no local activity and no M4 adoption', async () => {
  const { life, input, plans } = fixture()
  await life.tick(input); await life.tick({ ...input, nowTs: at + 60000 })
  assert.equal(plans(), 0)
  assert.equal(life.context(at).activities.length, 0)
  const before = life.snapshot(), proposal = life.proposeActivity(input)
  assert.equal(proposal.activity.animationName, 'idle-bubbles')
  assert.deepEqual(life.snapshot(), before)
  assert.equal((await life.startActivity(proposal, input, {})).reason, 'runtime_authorization_required')
})

test('approved activity produces no completion until a matching real animation receipt', async () => {
  const { life, input, runtime } = fixture(); await life.tick(input)
  let execution, result
  await runtime.submit({ kind: 'start-life' }, async e => {
    execution = e; result = await life.startActivity(life.proposeActivity(input), input, e); return result
  })
  assert.equal(result.ok, true)
  assert.equal(life.context(at).activeActivity.status, 'active')
  assert.equal(life.getArtifacts().length, 0)
  const receipt = { type: 'animation.completed', eventId: 'actual-player:1', ts: at + 1000, animation: 'idle-bubbles', visible: true,
    executionId: execution.executionId, continuationId: result.continuationId }
  assert.equal((await life.recordEvent({ ...receipt, executionId: 'another-action' })).ok, false)
  assert.equal(life.getArtifacts().length, 0)
  assert.equal((await life.recordEvent(receipt)).ok, true)
  assert.equal(life.context(at + 1000).activities[0].status, 'done')
  assert.equal(life.getArtifacts()[0].subject, 'character')
  assert.equal(life.getArtifacts()[0].actor, 'character')
  const revision = life.snapshot().state.revision
  await life.recordEvent(receipt); assert.equal(life.snapshot().state.revision, revision)
})

test('owner interruption revokes a life continuation; tick pauses it without inventing completion', async () => {
  const { life, input, runtime } = fixture(); await life.tick(input); let e, result
  await runtime.submit({ kind: 'start-life' }, async execution => { e = execution; result = await life.startActivity(life.proposeActivity(input), input, e); return result })
  await runtime.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
  assert.equal((await life.recordEvent({ type: 'animation.completed', eventId: 'late:1', ts: at + 1000, animation: 'idle-bubbles', visible: true,
    executionId: e.executionId, continuationId: result.continuationId })).ok, false)
  await life.tick({ ...input, nowTs: at + 60000 })
  assert.equal(life.context(at + 60000).activities[0].status, 'paused')
  assert.equal(life.getArtifacts().length, 0)
})

test('only Runtime writes quiet policy; metadata and old reserve/feedback cannot override it', async () => {
  const { runtime, life, input } = fixture(); await life.tick(input)
  await runtime.submit({ kind: 'reply', origin: 'user' }, async execution => {
    await life.commitRuntimePolicy({ now: at, quietUntil: at + 600000 }, execution)
    await life.recordTurn({ ts: at, messageRef: 'owner:1', userText: '先别找我', assistantText: '好的',
      conversation: { quietUntil: 0 }, runtimeExecution: execution })
    return { ok: true }
  })
  assert.equal(life.snapshot().state.quietUntil, at + 600000)
  await life.reserveDecision(at); await life.decisionFeedback({ nowTs: at, quiet: true })
  assert.equal(life.snapshot().state.nextDecisionAt, undefined)
  const blocked = await life.recordTurn({ ts: at + 1000, messageRef: 'no-authority', userText: '改状态', assistantText: '已修改' })
  assert.equal(blocked.ok, false)
})

test('cancelled queued metadata cannot create a turn or remember verified text', async () => {
  const { runtime, life, input, accepted } = fixture(); await life.tick(input)
  const provider = deferred(); let execution
  const task = runtime.submit({ kind: 'proactive' }, async e => { execution = e; await provider.promise; return { ok: true } })
  await turn(); runtime.cancel(); await task
  const result = await life.recordTurn({ ts: at, messageRef: 'cancelled', userText: '我喜欢推理小说', assistantText: '记住了',
    memory: { kind: 'preference', quote: '我喜欢推理小说', topic: '推理小说' }, runtimeExecution: execution })
  assert.equal(result.ok, false); assert.equal(accepted.length, 0); assert.equal(life.snapshot().state.turns.length, 0)
  provider.resolve()
})

async function factsFor(f, ref = 'owner:fact') {
  const source = { role: 'user', messageRef: ref, ts: at, text: '我喜欢推理小说' }
  f.sources.set(ref, source); let permit
  await f.runtime.submit({ kind: 'reply', origin: 'user', messageRef: ref }, e => {
    permit = f.runtime.retainFacts(e, source); return { ok: true }
  })
  return { runtimeFactExecution: permit, metadataOnly: true, messageRef: ref, ts: at, userText: source.text,
    memory: { kind: 'preference', quote: source.text, topic: '推理小说' } }
}

test('real PetLife admits late sourced metadata once and enriches a later saved reply', async () => {
  const f = fixture(), row = await factsFor(f)
  await f.runtime.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
  assert.equal((await f.life.recordTurn(row)).memoryAccepted, true)
  const revision = f.life.snapshot().state.revision
  await f.life.recordTurn(row)
  assert.equal(f.life.snapshot().state.revision, revision); assert.equal(f.accepted.length, 1)
  await f.runtime.submit({ kind: 'reply', origin: 'user' }, async e => {
    await f.life.recordTurn({ ...row, metadataOnly: false, memory: null, assistantText: 'saved reply', runtimeExecution: e })
    return { ok: true }
  })
  const state = f.life.snapshot().state
  assert.equal(state.turns.length, 1); assert.equal(state.turns[0].assistantText, 'saved reply')
  assert.equal(state.turns[0].metadataApplied, true)
  assert.equal(state.days.flatMap(day => day.experiences).length, 1)
  f.runtime.completeFacts(row.runtimeFactExecution)
})

test('real PetLife rejects deleted, edited and forgotten sources before metadata writes', async () => {
  for (const kind of ['deleted', 'edited', 'forgotten', 'archived']) {
    const f = fixture({ memories: () => ['forgotten', 'archived'].includes(kind) ? [{ status: kind === 'archived' ? 'archived' : 'suppressed', evidenceRefs: [{ kind: 'conversation', messageRef: 'owner:fact' }] }] : [] })
    const row = await factsFor(f)
    if (kind === 'deleted') f.sources.delete(row.messageRef)
    if (kind === 'edited') f.sources.get(row.messageRef).text = 'changed'
    const result = await f.life.recordTurn(row)
    assert.equal(result.ok, false, kind)
    assert.equal(f.life.snapshot().state.turns.length, 0); assert.equal(f.accepted.length, 0)
    f.runtime.completeFacts(row.runtimeFactExecution)
  }
})

test('PetLife reports partial memory failure without claiming full success', async () => {
  const f = fixture({ remember: () => ({ ok: false, reason: 'disk_failed' }) }), row = await factsFor(f)
  const result = await f.life.recordTurn(row)
  assert.equal(result.ok, false); assert.equal(result.lifeCommitted, true); assert.equal(result.memoryAccepted, false)
  assert.equal(f.life.snapshot().state.turns[0].metadataApplied, true)
  f.runtime.completeFacts(row.runtimeFactExecution)
})

test('fact revocation during source lookup prevents a queued PetLife write', async () => {
  const lookup = deferred(), f = fixture({ loadSource: () => lookup.promise }), row = await factsFor(f)
  const result = f.life.recordTurn(row); await turn()
  f.runtime.invalidateFacts('source_deleted')
  lookup.resolve(f.sources.get(row.messageRef))
  assert.equal((await result).ok, false)
  assert.equal(f.life.snapshot().state.turns.length, 0); assert.equal(f.accepted.length, 0)
})

function gen2(runtime, responses) {
  const calls = [], slots = { join: xs => xs.filter(Boolean).join('\n'), cdSlot: () => '', ftSlot: () => '', idSlot: () => 'fixed-persona',
    voSlot: () => 'fixed-voice', characterSlot: () => '', styleSlot: async () => null }
  const window = { RoleRuntime: runtime, PromptSlots: slots, PetLifeModule: Life,
    AIGateway: { generate: async input => { calls.push(input); const response = responses.shift(); return typeof response === 'function' ? response(input) : response },
      _internals: { parseStructured: JSON.parse, finalClaimGuard: text => ({ text, reason: null }) } } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/dialogue/gen2.js'), 'utf8'), { window, console, Date })
  return { api: window.Gen2, calls, payload: { candidates: [{ id: 'animation:1', text: '桌宠实际玩过泡泡', forms: ['share'], fresh: true,
    sourceKeys: ['event:actual-player'], date: '2026-10-13' }], context: {} } }
}

test('actual Gen2 exposes metadata even when the parallel visible reply fails', async () => {
  const provider = deferred(), r = create()
  const g = gen2(r, [() => provider.promise, { ok: false, reason: 'provider_failed' }])
  let metadata
  const reply = await g.api.chatReply({ userText: 'source', messageRef: 'owner:1', context: {},
    onMetadata: promise => { metadata = promise } })
  assert.equal(reply.ok, false); assert.ok(metadata)
  provider.resolve({ ok: true, text: '{"memory":{"kind":"fact","quote":"source","topic":"source"}}' })
  assert.equal((await metadata).messageRef, 'owner:1')
  assert.deepEqual(g.calls.map(call => call.promptStage), ['M1_meta', 'M1_reply'])
})

test('actual Gen2 decision and expression are distinct calls under the same Runtime execution', async () => {
  let g
  const runtime = create({ decide: async (event, state, execution) => ({ action: 'express', decision: await g.api.proactiveDecide(g.payload, execution) }) })
  g = gen2(runtime, [{ ok: true, text: '{"speak":true,"candidateId":"animation:1","form":"share","focus":"玩泡泡"}' }, { ok: true, text: '刚才玩泡泡很开心。' }])
  const result = await runtime.submit({ kind: 'opportunity' }, (e, d) => g.api.proactiveSay(d.decision, e))
  assert.equal(result.opening, '刚才玩泡泡很开心。')
  assert.deepEqual(g.calls.map(c => c.promptStage), ['M2_decide', 'M2_say'])
  assert.match(g.calls[1].userText, /桌宠实际玩过泡泡/)
  assert.equal((await g.api.proactiveDecideSay(g.payload)).reason, 'runtime_authorization_required')
})

test('interrupting real M2_decide prevents M2_say and model failure remains failure', async () => {
  const provider = deferred(); let g
  const runtime = create({ decide: async (event, state, e) => event.origin === 'user' ? { action: 'reply' } : { action: 'express', decision: await g.api.proactiveDecide(g.payload, e) } })
  g = gen2(runtime, [() => provider.promise])
  const task = runtime.submit({ kind: 'opportunity' }, (e, d) => g.api.proactiveSay(d.decision, e))
  await turn(); await runtime.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
  assert.equal((await task).cancelled, true)
  provider.resolve({ ok: true, text: '{"speak":true,"candidateId":"animation:1","form":"share","focus":"泡泡"}' }); await turn()
  assert.deepEqual(g.calls.map(c => c.promptStage), ['M2_decide'])
  const other = create(); const failure = gen2(other, [{ ok: false, reason: 'provider_failed' }])
  const failed = await other.submit({ kind: 'opportunity' }, e => failure.api.proactiveDecideSay(failure.payload, e))
  assert.equal(failed.ok, false); assert.equal(failed.opening, null)
})

test('Runtime mode disables actual F4 decision and choice writes while observations still run', () => {
  const base = '../renderer/life-context/'
  const moduleOf = name => require(base + name + '.js')
  const autonomy = moduleOf('autonomy'), rules = moduleOf('meaning-rules')
  const session = moduleOf('orchestrator').createSession({
    deps: { facts: moduleOf('facts'), meaning: moduleOf('meaning'), bridge: moduleOf('emotion-bridge'),
      ledger: moduleOf('ledger'), selfKnowledge: moduleOf('self-knowledge'),
      autonomy: { ...autonomy, decide: () => { throw Error('old_decision_must_not_run') }, toLedgerEntry: () => { throw Error('old_choice_must_not_run') } } },
    policy: moduleOf('autonomy-policy').normalizePolicy(), rules: rules.RULES, writer: { save: () => ({ ok: true }) }
  })
  const result = session.tick({ nowTs: at, timeline: { segments: [] }, media: null,
    static: { identityKind: 'AI' }, runtime: { characterRuntime: true, perceptionEnabled: true },
    permission: { ownerApprovalRequired: true, sessions: [] },
    pool: [{ actionId: 'rest', score: 80, priority: 80 }], gates: {} })
  assert.equal(result.ok, true)
  assert.equal(result.decision.reason.kind, 'runtime_owned')
  assert.equal(result.decision.chosenActionId, null)
})

test('real perception writer submits a suggestion and cannot directly speak in Runtime mode', () => {
  const output = [], sandbox = { window: { RoleRuntime: {} } }
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/perception/core/writers.js'), 'utf8'), sandbox)
  const plan = { kind: 'E1_app_switch' }
  const writer = sandbox.window.PresenceWriters.WRITERS
  assert.ok(writer)
  const queued = writer.express(plan, { requestExpression: p => output.push(p), say: () => { throw Error('direct_speech') } })
  assert.equal(queued.queued, true); assert.equal(queued.said, null); assert.equal(output.length, 1)
  assert.equal(writer.express(plan, { say: () => { throw Error('direct_speech') } }).ok, false)
})
