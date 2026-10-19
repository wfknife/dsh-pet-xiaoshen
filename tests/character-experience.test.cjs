'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const Life = require('../renderer/life/pet-life.js')
const { create } = require('../renderer/core/character-runtime.js')
const Speech = require('../renderer/core/speech-channel.js')
const now = new Date('2026-10-18T14:00:00+08:00').getTime()

function generationHarness(reply = '刚才那一局怎么样？') {
  const requests = [], window = { PetLifeModule: Life, SpeechChannel: Speech,
    PromptSlots: { join: xs => xs.filter(Boolean).join('\n'), idSlot: () => '你是小深', voSlot: () => '', cdSlot: () => '', ftSlot: () => '' },
    AIGateway: { generate: async p => { requests.push(p); return { ok: true, text: reply } } } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/dialogue/gen2.js'), 'utf8'), { window, console, Date, setTimeout, clearTimeout })
  return { window, requests }
}
async function say(candidate, reply) {
  const h = generationHarness(reply), raw = { speak: true, candidateId: candidate.id, focus: '一局游戏', form: 'share', opening: '一局游戏' }
  const v = Life.validateDecision(raw, [candidate])
  assert.equal(v.ok, true)
  const result = await h.window.Gen2.proactiveSay({ ok: true, prepared: { p: { candidates: [candidate], context: {}, nowTs: now }, raw, v } })
  return { ...h, result }
}

test('continuous chat suppresses contact, explicit surface close permits opportunities again', async () => {
  let time = now, calls = 0
  const runtime = create({ now: () => time })
  for (let n = 0; n < 4; n++) {
    await runtime.submit({ kind: 'reply', origin: 'user' }, () => ({ ok: true }))
    const r = await runtime.submit({ kind: 'opportunity' }, () => { calls++; return { ok: true } })
    assert.equal(r.reason, 'conversation_active')
    time += 60000
  }
  runtime.setConversationActive(true); time += 3600000
  assert.equal((await runtime.submit({ kind: 'opportunity' }, () => { calls++ })).reason, 'conversation_active')
  runtime.setConversationActive(false)
  assert.equal((await runtime.submit({ kind: 'opportunity' }, () => { calls++; return { ok: true } })).ok, true)
  assert.equal(calls, 1); runtime.shutdown()
})

test('game provenance travels from real life event through candidate to final model payload', async () => {
  const life = Life.createSession({ load: async () => ({ ok: true, state: Life.emptyState() }), save: async () => ({ ok: true }) })
  await life.init()
  assert.equal((await life.recordEvent({ type: 'game.completed', eventId: 'game:test:1', ts: now, game: { gameId: 'snake', score: 42 } })).ok, true)
  const pool = life.candidates({ nowTs: now + 1000, memories: [] })
  const candidate = pool.find(c => c.sourceType === 'game.completed')
  assert.ok(candidate, JSON.stringify(pool))
  assert.equal(candidate.actor, 'owner'); assert.equal(candidate.observer, 'character'); assert.equal(candidate.subject, 'owner')
  const { requests, result } = await say(candidate)
  assert.equal(result.ok, true)
  const payload = JSON.parse(requests[0].userText)
  assert.equal(payload.evidence.actor, 'owner'); assert.equal(payload.evidence.world, 'virtual')
  assert.match(payload.evidence.text, /主人/)
  assert.equal(requests.length, 1)
})

test('speech validation rejects stage directions but preserves normal parenthetical information', async () => {
  assert.equal(Speech.validate('（歪头）你回来啦。').ok, false)
  assert.equal(Speech.validate('我动了动（伸懒腰）。').ok, false)
  assert.equal(Speech.validate('明天下午（三点以后）都可以。').ok, true)
  const { result } = await say({ id: 'animation:1', text: '角色播放了伸懒腰动画', actor: 'character', observer: 'system', subject: 'character', world: 'virtual', sourceType: 'animation.completed', forms: ['share'], sourceKeys: ['event:animation:1'] }, '（伸懒腰）刚才放松了一下。')
  assert.equal(result.ok, false)
  assert.equal(result.opening, null)
})

test('no candidate waits without a model call; social opportunity does not assert an episode', async () => {
  const h = generationHarness()
  assert.equal((await h.window.Gen2.proactiveDecide({ candidates: [] })).silent, true)
  assert.equal(h.requests.length, 0)
  const { requests, result } = await say({ id: 'social:1', kind: 'social_contact', text: '有互动基础，可以闲聊，也可等待。', forms: ['share'], sourceKeys: [], opportunity: { reason: 'relationship_reconnect', lastOwnerAt: now - 14400000 } }, '今天想随便聊聊吗？')
  assert.equal(result.ok, true)
  const payload = JSON.parse(requests[0].userText)
  assert.equal(payload.opportunity.reason, 'relationship_reconnect')
  assert.match(payload.communication, /不得声称有新事件/)
})
