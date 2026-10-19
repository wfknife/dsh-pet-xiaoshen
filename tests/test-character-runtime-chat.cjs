'use strict'
// Exercise the actual renderer handlers with an isolated bridge and DOM.
// No app process, user data, credentials or real provider is accessed.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { create } = require('../renderer/core/character-runtime.js')
const source = fs.readFileSync(path.join(__dirname, '../renderer/pet.js'), 'utf8')
function actual(name) {
  const match = new RegExp('^([ ]*)(?:async )?function ' + name + '\\(', 'm').exec(source)
  assert.ok(match, name + ' exists')
  const rest = source.slice(match.index)
  const end = new RegExp('^' + match[1] + '}\\r?$', 'm').exec(rest)
  assert.ok(end, name + ' closes')
  return rest.slice(0, end.index + end[0].length)
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const noop = () => {}
function harness(options = {}) {
  const history = [], requests = [], displayed = [], memories = [], lifeTurns = [], notices = [], contacts = [], reports = []
  const elements = new Map()
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, textContent: '', style: {}, dataset: {},
      classList: { add: noop, remove: noop }, appendChild: row => notices.push(row), scrollHeight: 1 })
    return elements.get(id)
  }
  let seq = 0
  const runtime = create()
  const sandbox = {
    console: { log: noop, warn: noop }, Date, setTimeout, clearTimeout, roleRuntime: runtime,
    platformBridge: null, lifeCapabilities: null, presentationPlans: null,
    $: element, R: { hidden: false, busy: false, running: false, dragging: false },
    characterRetryTurn: null, latestCharacterTurnRef: null, charcBusy: false, chatBusy: false,
    characterUiExecutionId: null, miniChatRequestVersion: 0, characterChatActiveCount: 0,
    runtimeBubblePermits: new Map(), bubbleSeq: 0, bubbleOwner: '', BUBBLE_PRIORITY: { 'character-chat': 100, ui: 30 },
    proactiveOpeningLog: [], proactiveAwaitingReply: null, proactiveOpeningText: '',
    proactiveOpeningAppendedFor: null, proactiveCardBody: element('card-body'),
    proactiveCardText: '', proactiveFocusId: null,
    window: {
      ConversationPolicy: { analyzeTurn: () => ({ quietUntil: 0 }) },
      MemoryMessageRef: { next: () => 'input:' + ++seq },
      CharacterSnapshot: { toCharacterAIContext: () => ({}) },
      PetLife: {
        commitRuntimePolicy: async () => ({ ok: true }),
        canPresentDecision: () => true,
        presented: async row => { contacts.push(row); return { ok: !options.contactFail, reason: options.contactFail ? 'contact_disk_failed' : undefined } },
        recordTurn: async row => { if (options.lifeSave) await options.lifeSave(row); lifeTurns.push(row); return { ok: true } }
      },
      Gen2: { proactiveSay: async () => ({ ok: true, opening: 'actual opening', candidateId: 'candidate:1', topic: 'topic', form: 'share', sourceKeys: [] }) },
      pet: {
        characterHistoryAppend: async row => {
          if (options.failSave && options.failSave(row)) return { ok: false, reason: 'disk_failed' }
          if (!history.some(old => old.messageRef === row.messageRef)) history.push({ ...row, ts: Date.now() })
          return { ok: true }
        },
        characterHistoryLoad: async () => history.map(row => ({ ...row })),
        characterHistorySource: async ref => history.find(row => row.role === 'user' && row.messageRef === ref) || null
      },
      AIGateway: { request: async payload => {
        requests.push(payload)
        const result = await (options.provider ? options.provider(payload) : { ok: true, text: 'reply:' + payload.userText })
        if (result.metadataPromise && payload.onMetadata) payload.onMetadata(result.metadataPromise)
        return result
      } }
    },
    rememberFromUserMessage: noop,
    writeSay: text => {
      if (options.rejectPresentation && options.rejectPresentation(text)) return { ok: false, reason: 'interaction_active' }
      displayed.push(text); return { ok: true, displayed: true }
    },
    chatSay: (text, ms, source, token) => sandbox.say(text, ms, source, token),
    maybeRememberFromChat: text => memories.push(text),
    charcEl: (tag, styles, text) => ({ text }),
    ensureProactiveCard: () => element('card'),
    refreshCharacterHistoryViews: noop, renderCharc: async () => {}, renderLivingNotebook: noop,
    diaryEvent: noop, markDaily: noop, addAffection: noop, presentCharacterExpression: noop,
    setMood: noop, addHearts: noop, unlockPhoto: noop, touch: noop, cancelRandomTimer: noop,
    ensureAudio: noop, clearChatIndicator: noop, localStateExpressionLine: () => null,
    livingPresence: { user: noop }, Pace: { onUser: noop, onAssistant: noop },
    bubbleEl: element('bubble'), proactiveReport: async row => { reports.push(row); return { ok: true } }
  }
  vm.createContext(sandbox)
  for (const name of ['runtimeNotify', 'runtimeOpportunity', 'submitOwnerReply', 'beginBubble', 'bubbleTokenValid', 'endBubble', 'say',
    'prepareCharacterTurn', 'characterChatRequest', 'persistCharacterReply', 'characterChatFailureMessage', 'finishCharacterChat',
    'scheduleNextLine', 'sendMiniChat', 'charcSend', 'persistProactiveOpening', 'proactiveShowCard', 'applyPetCommands']) {
    vm.runInContext(actual(name), sandbox, { filename: 'pet.js:' + name })
  }
  return { sandbox, runtime, history, requests, displayed, memories, lifeTurns, notices, contacts, reports, element,
    send: (surface, text) => { element(surface === 'mini' ? 'mini-chat-input' : 'charc-input').value = text;
      return sandbox[surface === 'mini' ? 'sendMiniChat' : 'charcSend']({ type: 'click' }) }
  }
}

test('actual mini and panel handlers share FIFO, retain drafts, and pass only the current input to its turn', async () => {
  const firstProvider = deferred()
  const h = harness({ provider: p => p.userText === 'one' ? firstProvider.promise : { ok: true, text: 'reply:two' } })
  const first = h.send('mini', 'one'); await tick()
  const second = h.send('panel', 'two'); h.element('charc-input').value = 'new draft'
  assert.deepEqual(h.history.map(row => row.text), ['one', 'two'])
  firstProvider.resolve({ ok: true, text: 'reply:one' })
  assert.equal((await first).ok, true); assert.equal((await second).ok, true)
  assert.deepEqual(h.requests.map(p => p.userText), ['one', 'two'])
  assert.deepEqual(Array.from(h.requests[1].history, row => row.text), ['one', 'reply:one', 'two'])
  assert.equal(h.element('charc-input').value, 'new draft')
  assert.deepEqual(h.history.map(row => row.messageRef), ['input:1', 'input:2', 'reply:input:1', 'reply:input:2'])
  assert.deepEqual(h.memories, ['one', 'two'])
})

test('cancelled real handler retains owner fact and ignores its late provider reply', async () => {
  const provider = deferred(), h = harness({ provider: () => provider.promise })
  const task = h.send('mini', 'keep this'); await tick()
  h.runtime.setVisible(false); assert.equal((await task).cancelled, true)
  provider.resolve({ ok: true, text: 'late result' }); await tick()
  assert.deepEqual(h.history.map(row => row.role), ['user'])
  assert.equal(h.displayed.includes('late result'), false)
  assert.equal(h.memories.length, 0); assert.equal(h.lifeTurns.length, 0)
})

test('history failure prevents assistant publication and provider failure stays failure', async () => {
  const intake = harness({ failSave: row => row.role === 'user' })
  assert.equal((await intake.send('panel', 'owner save fails')).ok, false)
  assert.equal(intake.requests.length, 0)
  assert.equal(intake.element('charc-input').value, 'owner save fails')
  const h = harness({ failSave: row => row.role === 'assistant' })
  const failed = await h.send('mini', 'save fails')
  assert.equal(failed.ok, false); assert.equal(failed.reason, 'history_write_failed')
  assert.equal(h.displayed.includes('reply:save fails'), false); assert.equal(h.memories.length, 0)
  const other = harness({ provider: async () => ({ ok: false, reason: 'http_402' }) })
  assert.equal((await other.send('panel', 'provider fails')).ok, false)
  assert.deepEqual(other.history.map(row => row.role), ['user'])
  assert.equal(other.element('charc-input').value, 'provider fails')
})

test('cancellation during life save cannot clear or mutate the next foreground turn', async () => {
  const oldSave = deferred(), nextProvider = deferred()
  const h = harness({ lifeSave: row => row.userText === 'old' ? oldSave.promise : undefined,
    provider: p => p.userText === 'new' ? nextProvider.promise : { ok: true, text: 'reply:old' } })
  const old = h.send('panel', 'old'); await tick()
  h.runtime.cancel('superseded', event => event.id === 'input:1'); await old
  const next = h.send('panel', 'new'); await tick()
  oldSave.resolve(); await tick()
  assert.equal(h.sandbox.characterRetryTurn.text, 'new')
  assert.equal(h.memories.includes('old'), false)
  nextProvider.resolve({ ok: true, text: 'reply:new' }); assert.equal((await next).ok, true)
})

test('actual proactive card requires authority and returns durable presentation result', async () => {
  const h = harness()
  assert.equal((await h.sandbox.proactiveShowCard('blocked', 'fake', {})).ok, false)
  let identity
  const result = await h.runtime.submit({ kind: 'express' }, e => { identity = e.executionId; return h.sandbox.proactiveShowCard('opening', identity, e) })
  assert.equal(result.displayed, 'card')
  assert.equal(h.history[0].messageRef, 'proactive:' + identity)
  assert.equal(h.sandbox.proactiveFocusId, identity)
  assert.equal(h.element('card-body').textContent, 'opening')
  const failed = harness({ failSave: () => true })
  assert.equal((await failed.runtime.submit({ kind: 'express' }, e => failed.sandbox.proactiveShowCard('unsaved', e.executionId, e))).ok, false)
  assert.equal(failed.element('card-body').textContent, '')
})

test('late metadata archives its original saved source after new input without expression authority', async () => {
  const metadata = deferred()
  const h = harness({ provider: p => ({ ok: true, text: 'reply:' + p.userText,
    metadataPromise: p.userText === 'old' ? metadata.promise : undefined }) })
  await h.send('panel', 'old')
  assert.equal(h.runtime.snapshot().continuations.length, 1)
  await h.send('mini', 'new')
  metadata.resolve({ messageRef: 'input:1', memory: { kind: 'fact', quote: 'invented' }, conversation: {} })
  await tick()
  const late = h.lifeTurns.filter(row => row.metadataOnly)
  assert.equal(late.length, 1)
  assert.equal(late[0].messageRef, 'input:1'); assert.equal(late[0].userText, 'old')
  assert.equal(h.runtime.isAuthorized(late[0].runtimeFactExecution), false)
  assert.equal(h.runtime.snapshot().factJobs.length, 0)
})

test('metadata from a failed reply still archives, but clear invalidation discards a pending result', async () => {
  const metadata = deferred()
  const h = harness({ provider: () => ({ ok: false, reason: 'provider_failed', metadataPromise: metadata.promise }) })
  assert.equal((await h.send('mini', 'saved source')).ok, false)
  metadata.resolve({ messageRef: 'input:1', memory: null, conversation: {} }); await tick()
  assert.equal(h.lifeTurns[0].metadataOnly, true)
  assert.deepEqual(h.history.map(row => row.role), ['user'])
  const cancelled = deferred()
  const other = harness({ provider: () => ({ ok: true, text: 'reply', metadataPromise: cancelled.promise }) })
  await other.send('panel', 'erase source')
  other.runtime.invalidateFacts('history_cleared')
  cancelled.resolve({ messageRef: 'input:1', conversation: {} }); await tick()
  assert.equal(other.lifeTurns.filter(row => row.metadataOnly).length, 0)
})

test('disabled free-text work commands retain the report without executing writes', () => {
  const h = harness(), text = 'result <pet-command>{"type":"memo","text":"do not execute"}</pet-command>'
  const result = h.sandbox.applyPetCommands(text)
  assert.equal(result.clean, text); assert.equal(result.applied.length, 0)
  assert.equal(result.ok, false)
})

test('a rejected actual reply presentation is reported separately from its completed history save', async () => {
  const h = harness({ rejectPresentation: text => text === 'reply:blocked surface' })
  const result = await h.send('mini', 'blocked surface')
  assert.equal(result.ok, false); assert.equal(result.committed, true)
  assert.equal(result.reason, 'interaction_active')
  assert.equal(h.history.at(-1).text, 'reply:blocked surface')
  assert.equal(h.displayed.includes('reply:blocked surface'), false)
  assert.equal(h.element('mini-chat-input').value, '')
})

test('explicit retry after assistant save failure reuses the input and generated response', async () => {
  let fail = true
  const h = harness({ failSave: row => row.role === 'assistant' && fail })
  assert.equal((await h.send('panel', 'retry save')).ok, false)
  fail = false
  assert.equal((await h.send('panel', 'retry save')).ok, true)
  assert.equal(h.requests.length, 1)
  assert.deepEqual(h.history.map(row => row.messageRef), ['input:1', 'reply:input:1'])
})

test('actual proactive executor shares identity across history, card, contact and backend receipt', async () => {
  const h = harness(), result = await h.sandbox.runtimeOpportunity({})
  assert.equal(result.displayed, 'card'); assert.equal(result.bookkeepingOk, true)
  const id = h.sandbox.proactiveFocusId
  assert.equal(h.history[0].messageRef, 'proactive:' + id)
  assert.equal(h.contacts[0].instanceId, id); assert.equal(h.reports[0].id, id)
  const failed = harness({ contactFail: true })
  const partial = await failed.sandbox.runtimeOpportunity({})
  assert.equal(partial.displayed, 'card'); assert.equal(partial.bookkeepingOk, false)
  assert.equal(partial.contactReason, 'contact_disk_failed')
})
