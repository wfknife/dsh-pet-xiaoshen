const { test } = require('node:test')
const assert = require('node:assert/strict')
const { create } = require('../renderer/core/character-runtime.js')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('owner input cancels automatic generation and a late provider cannot publish or commit', async () => {
  const provider = deferred(), effects = [], r = create()
  const auto = r.submit({ kind: 'proactive', origin: 'automatic' }, async execution => {
    await provider.promise
    execution.publish(() => effects.push('late text'))
    await execution.commit(() => effects.push('late memory'))
    return { ok: true }
  })
  await tick()
  const reply = r.submit({ kind: 'reply', origin: 'user' }, execution => {
    execution.publish(() => effects.push('owner reply')); return { ok: true }
  })
  assert.equal((await auto).cancelled, true)
  assert.equal((await reply).ok, true)
  provider.resolve(); await tick()
  assert.deepEqual(effects, ['owner reply'])
})

test('both owner input surfaces are FIFO, automatic opportunities coalesce', async () => {
  const hold = deferred(), seen = [], r = create()
  const a = r.submit({ kind: 'reply', origin: 'user', id: 'mini' }, async () => { seen.push('mini'); await hold.promise; return { ok: true } })
  await tick()
  const b = r.submit({ kind: 'reply', origin: 'user', id: 'panel' }, () => { seen.push('panel'); return { ok: true } })
  const c = r.submit({ kind: 'tick', coalesceKey: 'tick' }, () => { seen.push('tick'); return { ok: true } })
  const d = r.submit({ kind: 'tick', coalesceKey: 'tick' }, () => { throw Error('duplicate') })
  assert.equal(c, d)
  hold.resolve(); await Promise.all([a, b, c])
  assert.deepEqual(seen, ['mini', 'panel', 'tick'])
})

test('cancelled decision cannot start an action, hidden and quiet suppress automatic events', async () => {
  const model = deferred(), effects = [], r = create({ decide: () => model.promise, now: () => 1000 })
  const task = r.submit({ kind: 'proactive' }, () => effects.push('action'))
  await tick(); r.setVisible(false)
  assert.equal((await task).cancelled, true)
  model.resolve({ action: 'express' }); await tick(); assert.deepEqual(effects, [])
  r.setVisible(true); r.setQuietUntil(2000)
  assert.equal((await r.submit({ kind: 'tick' }, () => effects.push('tick'))).silent, true)
})

test('commit started before cancellation completes truthfully but cannot publish afterward', async () => {
  const disk = deferred(), started = deferred(), effects = [], r = create()
  const task = r.submit({ kind: 'proactive' }, async e => {
    await e.commit(async () => { started.resolve(); await disk.promise; effects.push('saved'); return { ok: true } })
    e.publish(() => effects.push('text')); return { ok: true }
  })
  await started.promise; r.cancel('stop'); await task; disk.resolve(); await tick()
  assert.deepEqual(effects, ['saved'])
  assert.ok(r.snapshot().recent.some(x => x.phase === 'committed'))
})

test('continuation is distinct from a finished turn and revoked by new owner input', async () => {
  const r = create(); let id, capability
  await r.submit({ kind: 'start-life' }, e => { capability = e; id = e.continueAs('activity'); return { ok: true } })
  assert.equal(r.continuation(id), capability)
  assert.equal(capability.isCurrent(), true)
  await r.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
  assert.equal(r.continuation(id), null)
  assert.equal(capability.isCurrent(), false)
})

test('input IDs are idempotent, failure stays failure, shutdown closes every capability', async () => {
  const r = create(); let count = 0, capability
  const execute = e => { count++; capability = e; return { ok: false, reason: 'disk_failed' } }
  assert.equal((await r.submit({ kind: 'reply', origin: 'user', id: 'same' }, execute)).reason, 'disk_failed')
  await r.submit({ kind: 'reply', origin: 'user', id: 'same' }, execute)
  assert.equal(count, 1)
  r.shutdown(); assert.equal(r.isAuthorized(capability), false)
  assert.equal((await r.submit({ kind: 'reply' }, execute)).reason, 'runtime_stopped')
})

test('foreign capability and missing decision cannot execute publication', async () => {
  const r = create({ decide: () => ({ action: 'wait' }) })
  assert.equal(r.isAuthorized({ isCurrent: () => true }), false)
  let called = false
  assert.equal((await r.submit({ kind: 'tick' }, () => { called = true })).silent, true)
  assert.equal(called, false)
})

test('new owner input revokes metadata without cancelling the current owner reply', async () => {
  const hold = deferred(), r = create(); let metadata, execution
  const first = r.submit({ kind: 'reply', origin: 'user' }, async e => {
    execution = e; metadata = e.continueAs('metadata'); await hold.promise
    e.assertCurrent(); return { ok: true }
  })
  await tick()
  const second = r.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
  assert.equal(r.continuation(metadata), null)
  assert.equal(execution.isCurrent(), true)
  hold.resolve(); assert.equal((await first).ok, true); assert.equal((await second).ok, true)
})

test('restored waiting policy blocks automatic input, while new owner policy takes precedence', async () => {
  const r = create({ now: () => 1000, initialState: async () => ({ quietUntil: 2000 }) })
  let executed = false
  assert.equal((await r.submit({ kind: 'tick' }, () => { executed = true })).silent, true)
  assert.equal(executed, false)
  const restore = deferred(), newer = create({ initialState: () => restore.promise })
  newer.setQuietUntil(0)
  const task = newer.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
  restore.resolve({ quietUntil: Date.now() + 60000 })
  await task; assert.equal(newer.snapshot().quietUntil, 0)
  const broken = create({ initialState: async () => { throw Error('disk_failed') } })
  assert.match((await broken.submit({ kind: 'tick' }, () => ({ ok: true }))).reason, /runtime_restore_failed/)
})

test('filtered cancellation revokes matching completed activity continuations only', async () => {
  const r = create(); let automatic, owner
  await r.submit({ kind: 'activity' }, e => { automatic = e.continueAs('life'); return { ok: true } })
  await r.submit({ kind: 'feedback', origin: 'user-feedback' }, e => { owner = e.continueAs('animation'); return { ok: true } })
  r.cancel('technical_overlay', event => event.origin !== 'user-feedback')
  assert.equal(r.continuation(automatic), null)
  assert.ok(r.continuation(owner))
})

test('owner turn start revokes metadata created after the successor was already queued', async () => {
  const r = create(), hold = deferred(); let metadata
  const first = r.submit({ kind: 'reply', origin: 'user' }, async e => {
    await hold.promise; metadata = e.continueAs('metadata'); return { ok: true }
  })
  await tick()
  const second = r.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
  hold.resolve(); await first; await second
  assert.equal(r.continuation(metadata), null)
})

test('fact authority survives new input and visibility changes, and never grants publication', async () => {
  const r = create(); let permit, expression
  await r.submit({ kind: 'reply', origin: 'user', messageRef: 'source:1' }, e => {
    permit = r.retainFacts(e, { role: 'user', messageRef: 'source:1', ts: 1000 })
    expression = e.continueAs('metadata-expression'); return { ok: true }
  })
  assert.equal(r.isFactAuthorized(permit, 'source:1'), true)
  assert.equal(r.isAuthorized(permit), false); assert.equal(permit.publish, undefined)
  await r.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
  assert.equal(r.continuation(expression), null)
  r.setVisible(false); r.setQuietUntil(Date.now() + 1000)
  assert.equal(r.isFactAuthorized(permit, 'source:1'), true)
  r.invalidateFacts('source_deleted', ref => ref === 'source:1')
  assert.equal(permit.signal.aborted, true); assert.equal(r.isFactAuthorized(permit, 'source:1'), false)
})

test('fact leases reject foreign sources, expire, complete and shut down independently', async () => {
  let time = 1000; const r = create({ now: () => time }); let permit
  await r.submit({ kind: 'reply', origin: 'user', messageRef: 'saved:1' }, e => {
    assert.equal(r.retainFacts(e, { role: 'user', messageRef: 'wrong', ts: 1000 }), null)
    permit = r.retainFacts(e, { role: 'user', messageRef: 'saved:1', ts: 1000 })
    assert.equal(r.retainFacts(e, { role: 'user', messageRef: 'saved:1', ts: 1000 }), null)
    return { ok: true }
  })
  assert.equal(r.isFactAuthorized({}, 'saved:1'), false)
  time += 120000; assert.equal(r.isFactAuthorized(permit, 'saved:1'), false)
  r.completeFacts(permit); assert.equal(r.snapshot().factJobs.length, 0)
  await r.submit({ kind: 'reply', origin: 'user', messageRef: 'saved:2' }, e => {
    permit = r.retainFacts(e, { role: 'user', messageRef: 'saved:2', ts: time }); return { ok: true }
  })
  r.shutdown(); assert.equal(permit.signal.aborted, true)
})
