'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createKernel } = require('../character/runtime/kernel.cjs')
const { createConfig, resolvePaths } = require('../character/config.cjs')

function harness(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-test-cutover-'))
  const paths = resolvePaths({ dataDir, mode: 'candidate' }), published = []
  let now = 1800000000000, seq = 0
  const host = { request: async (method, p) => {
    if (method === 'prompts.snapshot') return { ok: true, value: { texts: { M1_reply: '既有人格', M2_say: '既有人格' } } }
    if (method === 'capability.grants') return { ok: true, scopes: ['presentation:text','presentation:animation','character:state:write','character:artifact:write'] }
    if (method === 'model.complete') {
      if (options.model) return options.model(p)
      return { ok: true, text: p.task === 'verify_grounding' ? '{"complete":true,"claims":[],"unsupported":[]}' : p.task === 'extract' ? '{"candidates":[]}' : p.task === 'decide' ? '{"action":"wait"}' : '好呀。' }
    }
    return { ok: false, reason: 'fixture_unavailable' }
  } }
  const create = () => createKernel({ paths, dataDir, host, now: () => now, config: createConfig(), presentation: { publish: async intent => { published.push(intent); return { ok: true } } } })
  let kernel = create(); assert.equal(kernel.start().ok, true)
  t.after(async () => { await kernel.stop(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  return { get k() { return kernel }, dataDir, published, now: () => now, advance: ms => { now += ms },
    submit: (kind, payload, commandId) => kernel.submit({ schemaVersion: 1, characterId: kernel.info().characterId, kind, payload, commandId: commandId || 'command:' + (++seq) }),
    restart: async () => { await kernel.stop(); kernel = create(); return kernel.start() } }
}
const turn = () => new Promise(resolve => setImmediate(resolve))

test('a Kernel crash returns a typed unavailable projection instead of rejecting renderer IPC', async () => {
  const child=new(require('node:events').EventEmitter)();child.postMessage=()=>{};child.kill=()=>{}
  const host=require('../character/host.cjs').createHost({dataDir:os.tmpdir(),env:{DESKPET_CHARACTER_KERNEL:'candidate'},isolatedTrial:true,utilityProcess:{fork:()=>child}})
  host.start();child.emit('message',{type:'ready',info:{epoch:1,characterId:'char:fixture'}})
  const pending=host.read({kind:'projection'});child.emit('exit',1)
  assert.deepEqual(await pending,{ok:false,code:'kernel_exited'})
  await host.stop()
})

test('birthday cards and click milestones retain established content and award once', () => {
  const apply=require('../character/domain/nurture.cjs').apply
  let state=require('../character/domain/reducer.cjs').initialState({})
  state.preferences={ownerBirthday:'2000-10-18',ownerName:'合成主人'}
  const at=new Date(2026,9,18,12).getTime()
  state=apply(state,{kind:'boot',commandId:'birth:1'},at).state
  assert.equal(state.nurture.birthdayCards.length,1)
  const first=JSON.stringify(state.nurture.birthdayCards),coins=state.nurture.coins
  state=apply(state,{kind:'touch',commandId:'ordinary:touch'},at+1).state
  assert.equal(state.nurture.photos['head-pat'],undefined)
  for(let i=0;i<5;i++)state=apply(state,{kind:'touch',gesture:'pet_click',commandId:'click:'+i},at+100+i*100).state
  assert.ok(state.nurture.photos['head-pat']);assert.ok(state.nurture.photos['tsundere-3']);assert.ok(state.nurture.photos['shy-whale'])
  assert.equal(JSON.stringify(state.nurture.birthdayCards),first);assert.equal(state.nurture.coins,coins)
})

test('Kernel package worker uses one operation ledger across upgrade rollback and restart', async t => {
  const h = harness(t), crypto = require('node:crypto')
  const fixture = (version, fail = false) => {
    const folder = path.join(h.dataDir, 'package-' + version); fs.mkdirSync(folder)
    const code = fail ? "module.exports={start:()=>{throw Error('startup_failed')}}" : `module.exports={migrate:d=>({...d,count:(d.count||0)+1}),execute:async(_,input,host)=>({version:'${version}',echo:await host.request('package.echo',{value:7})})}`
    fs.writeFileSync(path.join(folder,'entry.cjs'),code)
    fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify({id:'trusted.cutover',version,hostApi:1,entry:'entry.cjs',files:{'entry.cjs':crypto.createHash('sha256').update(code).digest('hex')},services:['package.echo'],capabilities:[{id:'package.cutover',effect:'read',services:['package.echo'],input:{type:'object',properties:{},additionalProperties:false}}]}))
    return folder
  }
  const install = version => h.submit('package.manage',{action:'install',folder:fixture(version),trusted:true})
  const installed = await install('1.0.0'); assert.equal(installed.ok,true,JSON.stringify(installed))
  let result = await h.submit('capability.invoke',{capabilityId:'package.cutover',input:{}},'invoke:first')
  assert.equal(result.ok,true); assert.equal(result.output.version,'1.0.0')
  assert.equal((await h.submit('capability.invoke',{capabilityId:'package.cutover',input:{}},'invoke:first')).replayed,true)
  assert.equal((await install('2.0.0')).ok,true)
  assert.equal(h.k.read({kind:'packages'}).namespaces['trusted.cutover'].count,2)
  assert.equal((await h.submit('package.manage',{action:'install',folder:fixture('3.0.0',true),trusted:true})).ok,false)
  assert.equal((await h.submit('package.manage',{action:'rollback',id:'trusted.cutover'})).ok,true)
  await h.restart()
  result = await h.submit('capability.invoke',{capabilityId:'package.cutover',input:{}})
  assert.equal(result.ok,true); assert.equal(result.output.version,'1.0.0')
  assert.equal((await h.submit('package.manage',{action:'disable',id:'trusted.cutover'})).ok,true)
  assert.equal((await h.submit('capability.invoke',{capabilityId:'package.cutover',input:{}})).ok,false)
  assert.equal(h.k.read({kind:'operations'}).operations.filter(op=>op.capabilityId==='package.cutover'&&op.status==='succeeded').length,2)
})

test('Kernel contact uses optional topics, closes conversation gate, archives once and permits no-event speech', async t => {
  const prompts = []
  const h = harness(t,{model:p=>{
    if(p.task==='decide') { const data=JSON.parse(p.messages[1].content),c=data.candidates.find(x=>x.kind==='social_contact'); if(c)assert.equal(data.constraints.mayContactOwner,true); return {ok:true,text:JSON.stringify(c?{action:'select',opportunityId:c.opportunityId,recipeId:'social_contact'}:{action:'wait'})} }
    if(p.task==='express') prompts.push(JSON.parse(p.messages[1].content))
    return {ok:true,text:p.task==='verify_grounding'?'{"complete":true,"claims":[],"unsupported":[]}':p.task==='extract'?'{"candidates":[]}':'好呀。'}
  }})
  await h.submit('owner.message',{messageRef:'contact:owner',text:'合成测试的互动',ts:h.now()})
  await h.k._internals.runSchedulerOnce()
  await h.submit('owner.control',{action:'conversation_start'})
  h.advance(4*3600000+1)
  await h.k._internals.runBehaviorTick(); await turn()
  assert.equal(h.published.length,1)
  await h.submit('owner.control',{action:'conversation_end'})
  await h.submit('world.observation',{observation:{observationId:'game:topic',sourceId:'game:topic',kind:'game.completed',observedAt:h.now(),freshUntil:h.now()+3600000,payload:{world:'virtual',actor:'owner',observer:'character',subject:'owner',sourceType:'game.completed',occurredAt:h.now(),game:{gameId:'snake',score:42,won:true}}}})
  await h.k._internals.runBehaviorTick(); for(let i=0;i<20;i++)await turn()
  assert.equal(h.published.length,2)
  assert.equal(h.k.read({kind:'history'}).history.filter(row=>row.role==='assistant').length,2)
  assert.ok(h.k._internals.store.read(g=>g.getMeta('contact-topic:game:topic')))
  assert.match(JSON.stringify(prompts.at(-1)),/game:topic/)
  assert.match(JSON.stringify(prompts.at(-1)),/"actor":"owner"/)
  await h.k._internals.runBehaviorTick(); for(let i=0;i<5;i++)await turn(); assert.equal(h.published.length,2)
  h.advance(1)
  await h.submit('owner.message',{messageRef:'contact:second',text:'新的合成互动',ts:h.now()})
  await h.k._internals.runSchedulerOnce(); await h.k._internals.runSchedulerOnce(); await h.submit('owner.control',{action:'conversation_end'})
  h.advance(4*3600000+1)
  await h.k._internals.runBehaviorTick(); for(let i=0;i<20;i++)await turn()
  assert.equal(h.published.length,4,JSON.stringify({jobs:h.k._internals.store.read(g=>g.listJobs?.(h.k.info().characterId)),history:h.k.read({kind:'history'}),status:h.k.read({kind:'status'})}))
  assert.ok(!JSON.stringify(prompts.at(-1)).includes('game:topic'))
})

test('legacy renderer role values are read-only while projection refresh is explicit', () => {
  const vm = require('node:vm'), window = {}
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/core/pet-state.js'), 'utf8'), { window })
  const adapter = window.PetState.projection({ coins: 20, stats: { mood: 70 }, inventory: { cookie: 3 }, ownerName: '' })
  adapter.state.coins += 100; adapter.state.stats.mood = 1; adapter.state.inventory.cookie--
  assert.equal(adapter.state.coins, 20); assert.equal(adapter.state.stats.mood, 70); assert.equal(adapter.state.inventory.cookie, 3)
  adapter.apply({ coins: 23 }); assert.equal(adapter.state.coins, 23)
})

test('nurture commands preserve item rules and command retries cannot award twice', async t => {
  const h = harness(t), before = h.k.read().state.nurture
  assert.equal((await h.submit('owner.interaction', { kind: 'feed' }, 'feed:one')).ok, true)
  const after = h.k.read().state.nurture
  assert.equal(after.feedCount, before.feedCount + 1); assert.equal(after.exp, before.exp + 1)
  await h.submit('owner.interaction', { kind: 'feed' }, 'feed:one')
  assert.equal(h.k.read().state.nurture.feedCount, after.feedCount)
  assert.equal((await h.submit('owner.interaction', { kind: 'tick', elapsedMs: 9999999 })).ok, false)
  assert.equal((await h.submit('settings.update', { preferences: { coins: 10000 } })).ok, false)
})

test('opening the chat surface does not discard its in-flight owner reply', async t => {
  let resolve, entered
  const called = new Promise(r => { entered = r })
  const h = harness(t, { model: p => p.task === 'express' ? new Promise(r => { resolve = r; entered() }) : Promise.resolve({ ok: true, text: '{"complete":true,"claims":[],"unsupported":[]}' }) })
  await h.submit('owner.message', { messageRef: 'input:one', text: '聊聊', ts: h.now() })
  const task = h.k._internals.runSchedulerOnce(); await called
  await h.submit('owner.control', { action: 'conversation_start' })
  resolve({ ok: true, text: '好呀。' }); await task
  assert.equal(h.published.length, 1)
  assert.equal(h.k.read().state.attentionPolicy.conversation.surfaceOpen, true)
})

test('owner interruption and deletion discard a late provider response without reviving source text', async t => {
  let resolve, entered
  const called = new Promise(r => { entered = r })
  const h = harness(t, { model: p => p.task === 'express' ? new Promise(r => { resolve = r; entered() }) : Promise.resolve({ ok: true, text: '{"candidates":[]}' }) })
  await h.submit('owner.message', { messageRef: 'input:secret', text: '合成待删除信息', ts: h.now() })
  const task = h.k._internals.runSchedulerOnce(); await called
  await h.submit('owner.forget', { sourceIds: ['input:secret'] })
  resolve({ ok: true, text: '合成待删除信息' }); await task; await turn()
  assert.equal(h.published.length, 0); assert.equal(h.k.read({ kind: 'history' }).history.length, 0)
  assert.equal((await h.restart()).ok, true)
  assert.equal(h.k._internals.policyStore.isDeleted('input:secret'), true)
  await h.k._internals.runSchedulerOnce(); assert.equal(h.published.length, 0)
})

test('restart cancels pending old-epoch reply and retains dispatched operation as unknown', async t => {
  const h = harness(t), k = h.k
  await h.submit('owner.message', { messageRef: 'input:pending', text: '还没回复的合成输入', ts: h.now() })
  const op = k._internals.store.transaction(g => {
    const p = k._internals.executor.prepare(g, { characterId: k.info().characterId, capabilityId: 'presentation.text', capabilityVersion: 1,
      input: { text: '可能已经显示', semanticRef: 'unknown' }, sourceRefs: [], grantedScopes: new Set(['presentation:text']), epoch: k.info().epoch, now: h.now(), dedupeKey: 'crash:operation' })
    return k._internals.executor.markDispatchStart(g, p.operation.operationId, h.now()).operation
  })
  const before = k.read().state.needs
  assert.equal((await h.restart()).ok, true)
  await h.k._internals.runSchedulerOnce()
  assert.equal(h.k.read({ kind: 'operations' }).operations.find(row => row.operationId === op.operationId).status, 'unknown')
  assert.equal(h.published.length, 0); assert.deepEqual(h.k.read().state.needs, before)
  assert.equal(h.k.read({ kind: 'history' }).history.length, 1)
})

test('semantic audit rejects imagined game process and accepts sourced results with fenced JSON', async () => {
  const { createExpresser } = require('../character/cognition/express.cjs')
  const parseJson = require('../character/cognition/model-gateway.cjs').createModelGateway({ host: {}, config: createConfig() }).parseJson
  for (const imagined of [true, false]) {
    const text = imagined ? '我看着小蛇一路吃过去了。' : '42分，这一局挺不错。'
    const express = createExpresser({ gateway: { parseJson, complete: async p => ({ text: p.task === 'express' ? text : '```json\n' + JSON.stringify({ complete: true, claims: [{ text: imagined ? text : '42分', supported: !imagined, sourceRefs: ['game:one'] }], unsupported: imagined ? ['缺少过程观测'] : [] }) + '\n```' }) } })
    const result = await express.express({ styleTemplate: '既有风格', act: { kind: 'share' }, evidenceRefs: ['game:one'], context: { sections: { observations: [{ sourceId: 'game:one', actor: 'owner', payload: { gameId: 'snake', score: 42 } }] } } })
    assert.equal(result.ok, !imagined)
  }
})

test('fact arrival time cannot overwrite a newer owner fact', async t => {
  const h = harness(t), admission = require('../character/memory/admission.cjs'), id = h.k.info().characterId
  h.k._internals.store.transaction(g => {
    for (const [sourceId, at, value] of [['new:source', h.now(), '杭州'],['old:source', h.now()-86400000, '北京']]) {
      g.putSource({ sourceId, characterId: id, sourceKind: 'owner_message', world: 'user_report', trust: 'owner_statement', permission: 'granted', sourceHash: sourceId, occurredAt: at, observedAt: h.now() })
      admission.applyCandidate(g, { characterId: id, sourceId, now: h.now(), seq: 1, candidate: { subject: 'owner', predicate: 'city', value, scope: 'owner', world: 'user_report', confidence: 1, validTime: { from: at, to: null } } })
    }
    assert.deepEqual(g.findCurrentAssertions(id, 'owner','city','owner').map(row => row.value), ['杭州'])
  })
})

test('owner chat commits in Kernel and publishes through the operation ledger', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-test-cutover-'))
  const intents = [], calls = []
  const kernel = createKernel({ paths: resolvePaths({ dataDir, mode: 'candidate' }), dataDir, config: createConfig(),
    host: { request: async (method, params) => {
      if (method === 'prompts.snapshot') return { ok: true, value: { texts: { M1_reply: '保持现有人格。' } } }
      if (method === 'capability.grants') return { ok: true, scopes: ['presentation:text'] }
      if (method === 'model.complete') { calls.push(params.task); return { ok: true, model: 'fixture', text: params.task === 'extract' ? '{"candidates":[]}' : params.task === 'verify_grounding' ? '{"complete":true,"claims":[],"unsupported":[]}' : '好呀，聊会儿。' } }
      throw Error(method)
    } }, presentation: { publish: async intent => { intents.push(intent); return { ok: true } } } })
  t.after(async () => { await kernel.stop(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  assert.equal(kernel.start().ok, true)
  const command = { commandId: 'chat:test-1', characterId: kernel.info().characterId, schemaVersion: 1, kind: 'owner.message',
    payload: { messageRef: 'owner:test-1', text: '忙完了，陪我聊会儿。', ts: Date.now() } }
  assert.equal((await kernel.submit(command)).ok, true)
  await kernel._internals.runSchedulerOnce()
  assert.equal(intents.length, 1)
  assert.match(intents[0].semanticRef, /^reply:/)
  assert.deepEqual(kernel.read({ kind: 'history' }).history.map(row => row.role), ['user', 'assistant'])
  assert.equal(kernel.read({ kind: 'operations' }).operations[0].status, 'succeeded')
  assert.equal((await kernel.submit(command)).replayed, true)
  await kernel._internals.runSchedulerOnce()
  assert.equal(intents.length, 1)
})
