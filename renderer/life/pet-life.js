/* Persistent daily life and conversational continuity.
 * Plans are intentions; only runtime transitions become experiences. The model
 * selects topics from sourced candidates, never writes owner facts directly.
 */
(function (root, factory) {
  const mod = factory()
  if (typeof module === 'object' && module.exports) module.exports = mod
  else {
    root.PetLifeModule = mod
    if (root.pet?.character?.authority) {
      const api = root.pet.character
      let projection = null
      const init = async () => { const p = await api.read(); if (p?.ok) projection = p; return { ok: !!projection } }
      api.onEvent(event => { if (event?.event?.projection) projection = event.event.projection; else if (event?.kind === 'ready') void init() })
      const state = () => ({ ...mod.emptyState(), revision: projection?.revision || 0, threads: projection?.concerns || [], artifacts: projection?.episodes || [] })
      const rejected = async () => ({ ok: false, reason: 'kernel_authority' })
      const adapter = { init, snapshot: () => ({ ready: !!projection, state: state() }),
        context: () => ({ ready: !!projection, ...state(), recentContacts: [], livingState: { resting: !!projection?.state?.attentionPolicy?.restUntil } }),
        candidates: () => [], getArtifacts: () => projection?.episodes || [], canPlan: () => false, canPresentDecision: () => false,
        recordEvent: event => api.observe(event), flush: async () => ({ ok: true }),
        forgetArtifact: id => {
          const artifact = (projection?.episodes || []).find(item => item.id === id)
          return artifact ? api.submit({ kind: 'owner.forget', payload: { sourceIds: artifact.sourceRefs || [] } }) : rejected()
        },
        setVisibility: visible => api.submit({ kind: 'owner.control', payload: { action: 'visibility', visible } }) }
      for (const name of ['tick','proposeActivity','startActivity','commitRuntimePolicy','recordTurn','invalidateSources','presented','reserveDecision','decisionFeedback']) adapter[name] = rejected
      root.PetLife = Object.freeze(adapter)
      void init()
      return
    }
    root.PetLife = mod.createSession({
      load: () => root.pet.petLifeLoad(),
      save: (state, source) => root.pet.petLifeSave(state, source),
      loadSource: ref => root.pet.characterHistorySource(ref),
      memories: () => root.MemoryEngine ? root.MemoryEngine.getMemories() : [],
      plan: input => root.AIGateway.lifePlan(input),
      runtimeOwned: () => !!root.RoleRuntime,
      authorize: execution => !!root.RoleRuntime && root.RoleRuntime.isAuthorized(execution),
      authorizeFacts: (permit, ref) => !!root.RoleRuntime && root.RoleRuntime.isFactAuthorized(permit, ref),
      invalidateFacts: ref => {
        if (root.RoleRuntime) root.RoleRuntime.invalidateFacts('source_forgotten', id => id === ref)
        if (root.pet.platform) root.pet.platform.forget([ref]).catch(e => console.warn('[pet-life] forget:', e.message))
      },
      continuation: id => root.RoleRuntime && root.RoleRuntime.continuation(id),
      remember: candidate => root.MemoryEngine.admitCandidate(candidate),
      factBegin: input => root.pet.platform && root.pet.platform.factBegin(input),
      factAdvance: (ref, step, detail) => root.pet.platform && root.pet.platform.factAdvance(ref, step, detail),
      flushMemory: () => root.MemoryEngine.flushAndWait({ timeoutMs: 5000 }),
      hasMemoryEvidence: candidate => root.MemoryEngine.getMemories().some(m => !['suppressed', 'archived'].includes(m.status) && !m.supersededBy &&
        (candidate.sourceEventIds || []).some(id => (m.sourceEventIds || []).includes(id)) && (m.content === candidate.content || m.originalContent === candidate.content)),
      completeOperation: async activity => {
        if (!root.pet.platform) return
        const id = 'activity:' + activity.runtimeExecutionId, op = await root.pet.platform.operation(id)
        if (op && op.status === 'awaiting_receipt') {
          const saved = await root.pet.platform.operationUpdate(id, 'completed', { ok: true, virtual: true, sourceType: 'virtual.elapsed', activityId: activity.id,
            kind: activity.kind, eventAt: activity.finishedAt, elapsedMs: activity.elapsedMs, ownerTaskCompleted: false })
          if (!saved || saved.ok === false) throw Error(saved && saved.reason || 'activity_receipt_save_failed')
        }
      }
    })
    root.PetLife.init().catch(err => console.warn('[pet-life] load failed:', err.message))
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  const MINUTE = 60000
  const KINDS = ['revisit_memory', 'chat_notes', 'quiet_rest', 'curiosity_note']
  const FORMS = ['share', 'question', 'invite', 'accompany', 'celebrate']
  const VIRTUAL_ACTIONS = Object.freeze([
    { id: 'idle-stretch', label: '在桌面上伸了个懒腰', wish: '想在桌面上活动一下', affinity: 'rest' },
    { id: 'idle-mirror', label: '在桌面上照了照小镜子', wish: '想看看今天的装扮', affinity: 'care' },
    { id: 'idle-bubbles', label: '在桌面上玩了一会儿泡泡', wish: '想玩一小会儿泡泡', affinity: 'play' },
    { id: 'idle-hum', label: '在桌面上轻轻哼了一会儿', wish: '想给自己哼一小段', affinity: 'music' },
    { id: 'egg-rubik', label: '在桌面上摆弄了一会儿魔方', wish: '想琢磨一下手里的魔方', affinity: 'puzzle' },
    { id: 'egg-needlework', label: '在桌面上做了一会儿针线活', wish: '想继续桌面里的小手工', affinity: 'craft' },
    { id: 'routine-brush', label: '在桌面上梳理了一下自己', wish: '想把自己整理清爽一点', affinity: 'care' },
    { id: 'perform-dressup', label: '在桌面上换了一身装扮', wish: '想试试桌面里的另一身装扮', affinity: 'care' },
    { id: 'egg-juggling', label: '在桌面上练了一会儿杂耍', wish: '想练一下桌面里的小把戏', affinity: 'play' }
  ])
  const EVENT_TYPES = ['animation.completed', 'game.completed', 'work.completed']
  const copy = value => JSON.parse(JSON.stringify(value))
  const clip = (value, n) => String(value || '').trim().slice(0, n)
  const dayOf = ts => {
    const d = new Date(ts)
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }
  const minuteOf = ts => new Date(ts).getHours() * 60 + new Date(ts).getMinutes()
  function hash(text) {
    let h = 2166136261
    for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    return (h >>> 0).toString(36)
  }
  function emptyState() { return { version: 1, revision: 0, days: [], turns: [], contacts: [], threads: [], artifacts: [], interests: [], eventIds: [], ignoredSourceKeys: [], quietUntil: 0 } }
  function validState(s) {
    return !!s && s.version === 1 && Number.isInteger(s.revision) && s.revision >= 0 &&
      ['days', 'turns', 'contacts', 'threads'].every(k => Array.isArray(s[k])) &&
      s.days.length <= 30 && s.turns.length <= 160 && s.contacts.length <= 100 && s.threads.length <= 40 &&
      s.days.every(d => d && typeof d.date === 'string' && Array.isArray(d.activities) && d.activities.length <= 4 && Array.isArray(d.experiences) && d.experiences.length <= 24 && d.activities.every(a => a && KINDS.includes(a.kind) && ['planned', 'active', 'paused', 'done'].includes(a.status))) &&
      s.turns.every(t => t && typeof t.userText === 'string' && typeof t.messageRef === 'string' && Number.isFinite(t.ts)) &&
       ['artifacts', 'interests', 'eventIds', 'ignoredSourceKeys'].every(k => s[k] === undefined || Array.isArray(s[k])) &&
       (!s.artifacts || s.artifacts.length <= 80) && (!s.interests || s.interests.length <= 16) &&
       (!s.eventIds || s.eventIds.length <= 240) && (!s.ignoredSourceKeys || s.ignoredSourceKeys.length <= 240) &&
       JSON.stringify(s).length <= 500000
  }
  function usefulMemories(items) {
    return (Array.isArray(items) ? items : []).filter(m => m && m.id && (m.content || m.text) &&
      String(m.content || m.text).length <= 1000 && !isTestMaterial(m) && !['suppressed', 'archived', 'forgotten'].includes(m.status) && !m.supersededBy)
  }
  function isTestMaterial(row) {
    // These exact legacy strings are fixtures in the repository's UI tests.
    // Exclude from AI material; leave the formal memory untouched.
    return row.testOnly === true || row.synthetic === true || row.sourceType === 'test' ||
      /^(?:TEST[-_:]|MEMTEST|MEMDBG)|^(?:测试重要约定|时间边界重要事项)$/.test(String(row.content || row.text || row.wish || ''))
  }
  function meaning(text) {
    return String(text || '').replace(/主人|我们|我想|回想|回忆|记忆|记下|记录|以前|今天|昨天|那句|这句|说过|聊过|小事|一下|一条|想|我|的|了|过|和|与|[\s，。！？：、；,.!?;:「」“”"']/g, '')
  }
  function overlap(a, b) {
    const x = meaning(a), y = meaning(b), grams = new Set()
    for (let i = 0; i + 1 < x.length; i++) grams.add(x.slice(i, i + 2))
    return [...grams].filter(g => y.includes(g)).length
  }
  function rankedMemories(items, state, wish) {
    const used = new Map()
    ;((state && state.days) || []).forEach(d => d.activities.filter(a => a.kind === 'revisit_memory' && a.material).forEach(a => used.set(a.material.id, (used.get(a.material.id) || 0) + 1)))
    return usefulMemories(items).slice().sort((a, b) =>
      overlap(wish, b.content || b.text) - overlap(wish, a.content || a.text) ||
      (used.get(a.id) || 0) - (used.get(b.id) || 0) ||
      (Number(b.updatedAt || b.createdAt) || 0) - (Number(a.updatedAt || a.createdAt) || 0) ||
      (Number(b.importance) || 0) - (Number(a.importance) || 0))
  }
  function chooseMemory(activity, items, state) {
    const ranked = rankedMemories(items, state, activity.wish)
    return activity.sourceId ? ranked.find(m => m.id === activity.sourceId) : ranked[0]
  }
  function presenceOnly(text) {
    return /我还在|安静.{0,6}(?:歇|待)|歇够|歇完|我在这儿.{0,6}待/.test(String(text || ''))
  }
  function sourceKeys(row) {
    const text = row.memory ? row.memory.content : row.material ? row.material.text : row.text
    const keys = [row.id || row.candidateId]
    if (row.messageRef) keys.push('conversation:' + row.messageRef, row.messageRef)
    if (row.animationName) keys.push('motif:virtual:' + row.animationName)
    if (row.memory) keys.push('memory:' + row.memory.id)
    if (row.material) keys.push((row.kind === 'chat_notes' || (row.refs || []).some(r => String(r).startsWith('chat-')) ? 'conversation:' : 'memory:') + row.material.id)
    for (const ref of row.refs || []) keys.push(String(ref).replace(/^mem:/, 'memory:'))
    if (meaning(text)) keys.push('content:' + hash(meaning(text)))
    if (/quiet_rest/.test(row.id || '') || presenceOnly(text)) keys.push('motif:quiet_presence')
    return [...new Set(keys.filter(Boolean))].slice(0, 12)
  }
  function contactKeys(contact, state) {
    if (Array.isArray(contact.sourceKeys) && contact.sourceKeys.length) return contact.sourceKeys
    const e = state.days.flatMap(d => d.experiences).find(e => e.id === contact.candidateId)
    const keys = e ? sourceKeys(e) : [contact.candidateId]
    if (presenceOnly(contact.opening)) keys.push('motif:quiet_presence')
    return keys
  }
  function repeatReason(keys, fresh, state, ts) {
    const last = state.contacts.at(-1)
    const interaction = Math.max(0, ...state.turns.map(t => t.ts), ...state.contacts.map(c => Number(c.repliedAt) || 0))
    const unanswered = state.contacts.filter(c => !c.repliedAt && c.ts > interaction && ts - c.ts >= 60 * MINUTE)
    if (!fresh && last && unanswered.length >= 2 && ts - last.ts < Math.min(240, unanswered.length * 60) * MINUTE) return 'no_progress_interval'
    for (const contact of state.contacts) {
      const prior = contactKeys(contact, state)
      const shared = keys.filter(k => prior.includes(k))
      const minutes = contact.repliedAt ? 30 : (shared.some(k => k.startsWith('content:') || k.startsWith('memory:') || k === 'motif:quiet_presence') ? 360 : 120)
      if (shared.length && ts - contact.ts < minutes * MINUTE) return 'source_or_motif_recent'
    }
    return null
  }
  function excluded(row, memories) {
    if (isTestMaterial(row) || (row.material && isTestMaterial({ text: row.material.text }))) return true
    const normalize = s => String(s || '').replace(/[\s，。！？：、；,.!?;:]/g, '')
    const text = normalize(row.quote || (row.memory && row.memory.quote) || row.userText || row.text)
    return (Array.isArray(memories) ? memories : []).filter(m => ['suppressed', 'forgotten'].includes(m.status) || m.supersededBy).some(m => {
      if ((row.material && row.material.id === m.id) || (row.refs || row.sourceRefs || []).includes('mem:' + m.id)) return true
      if ((m.evidenceRefs || []).some(e => e && e.kind === 'conversation' &&
        (e.messageRef === row.messageRef || (row.material && e.messageRef === row.material.id) || (row.refs || []).includes(e.messageRef)))) return true
      const phrase = normalize(m.content || m.originalContent)
      return phrase.length >= 8 && text.includes(phrase)
    })
  }
  function localPlan(ts) {
    return KINDS.slice(0, 3).map((kind, i) => ({
      id: dayOf(ts) + ':' + kind, kind, atMinute: Math.min(1430, minuteOf(ts) + i * 30),
      wish: ['想回想一件我们聊过的小事', '想把今天在意的话记下来', '想安静歇一会儿'][i],
      status: 'planned', elapsedMs: 0, source: 'local-intention'
    }))
  }
  function validatePlan(raw, ts, memories) {
    const list = raw && Array.isArray(raw.activities) ? raw.activities : []
    if (!list.length || list.length > 3) return null
    const seen = new Set()
    const plan = []
    for (const [i, row] of list.entries()) {
      if (!row || !KINDS.includes(row.kind) || seen.has(row.kind)) return null
      const wish = clip(row.wish, 100)
      if (!wish || /(出门|逛街|买了|散步|天气|上网|查资料|读文件|打开文件|看视频|听音乐|喝咖啡)/.test(wish)) return null
      if (isTestMaterial({ wish })) return null
      const sourceId = row.kind === 'revisit_memory' ? clip(row.sourceId, 120) : ''
      if (sourceId && Array.isArray(memories) && !usefulMemories(memories).some(m => m.id === sourceId)) return null
      seen.add(row.kind)
      plan.push({ id: dayOf(ts) + ':' + row.kind, kind: row.kind,
        atMinute: Math.min(1430, minuteOf(ts) + i * 30), wish, status: 'planned', elapsedMs: 0, source: 'ai-intention', ...(sourceId ? { sourceId } : {}) })
    }
    return plan
  }
  function verifiedMemory(raw, userText, messageRef, ts) {
    if (!raw || !messageRef) return null
    const quote = clip(raw.quote, 240), full = String(userText)
    if (quote.length < 4 || !String(userText).includes(quote) || !['preference', 'plan', 'event', 'fact', 'dislike', 'resolved'].includes(raw.kind)) return null
    const start = full.indexOf(quote), end = start + quote.length
    const before = full.slice(0, start), after = full.slice(end)
    const left = Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('\n')) + 1
    const nextStop = after.search(/[。！？\n]/)
    const sentence = full.slice(left, nextStop < 0 ? full.length : end + nextStop + 1).trim()
    if (sentence.length > 1000 || /[？?]$/.test(sentence) || /^(假如|假设|假装|如果|要是)/.test(sentence) || /[（(](开玩笑|假设|举例)/.test(sentence)) return null
    // Store the owner's actual words, including negation, uncertainty and tense.
    // A model summary or topic label can never become the factual content.
    return { quote: sentence, kind: raw.kind, label: clip(raw.topic, 40),
      candidate: { content: sentence, originalContent: sentence, type: 'episode', sourceType: 'user', userInput: true,
        ts, date: dayOf(ts), tags: ['conversation', raw.kind], importance: 0.55,
        evidenceRefs: [{ kind: 'conversation', messageRef: String(messageRef), at: ts }] } }
  }
  function hydrate(state) {
    const out = copy(state)
    for (const key of ['artifacts', 'interests', 'eventIds', 'ignoredSourceKeys']) if (!Array.isArray(out[key])) out[key] = []
    if (!Number.isFinite(out.quietUntil)) out.quietUntil = 0
    return out
  }
  function threadDeadline(quote, ts) {
    const day = new Date(ts)
    day.setHours(23, 59, 59, 999)
    if (/明天/.test(quote)) { day.setDate(day.getDate() + 1); return day.getTime() }
    if (/今天|今晚/.test(quote)) return day.getTime()
    return ts + 7 * 24 * 60 * MINUTE
  }
  function hasQuote(quote, text) { return typeof quote === 'string' && quote.trim().length >= 2 && quote.length <= 1000 && String(text || '').includes(quote) }
  function evidenceClause(quote, full) {
    const text = String(full || ''), at = text.indexOf(quote)
    if (at < 0) return ''
    const before = text.slice(0, at), after = text.slice(at + quote.length)
    const start = Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('\n')) + 1
    const end = after.search(/[。！？\n]/)
    return text.slice(start, end < 0 ? text.length : at + quote.length + end + 1)
  }
  function explicitResolution(quote) {
    return !/[？?]|假如|如果|假设|要是|可能|也许|一半|部分|还差|正在|打算|准备|计划|他说|她说|听说|你说/.test(quote) &&
      !/(没|未|还没|没有|尚未)[^。！？]{0,10}(完|好|结束|解决|办|弄|完成|交)|不确定|并非|不是/.test(quote) &&
      /(?:已经|已)[^。！？]{0,16}(?:完|好|结束|解决|办|弄|提交)|完成|做完|买完|写完|交了|交完|提交了|结束了|解决了|弄好了|办好了|搞定/.test(quote)
  }
  function explicitCancellation(quote) {
    return !/[？?]|假如|如果|假设|要是|可能|也许|没取消|不取消|不要取消|不能取消|不是|并非|他说|她说|听说|你说/.test(quote) && /取消|不打算[^。！？]{0,20}了|不准备[^。！？]{0,20}了|不做了|不去了|不买了|放弃了|算了[^。！？]{0,12}(不|取消)/.test(quote)
  }
  function addArtifact(state, item) {
    if (state.artifacts.some(a => a.id === item.id)) return null
    const artifact = { ...item, title: clip(item.title, 40), text: clip(item.text, 400), ts: item.createdAt,
      sourceRefs: (item.sourceRefs || []).slice(0, 8), subject: 'pet', status: 'active' }
    state.artifacts.push(artifact); state.artifacts = state.artifacts.slice(-80)
    return artifact
  }
  function availableEpisode(input, state, ts) {
    const available = new Set((Array.isArray(input.availableActions) ? input.availableActions : []).map(a => typeof a === 'string' ? a : a && (a.id || a.actionId)))
    const episodes = VIRTUAL_ACTIONS.filter(a => available.has(a.id))
    if (!episodes.length || state.quietUntil > ts || input.busy) return null
    if (state.days.some(d => d.activities.some(a => a.mode === 'virtual_episode' && a.status === 'paused' && !a.abandoned && a.retryAt > ts))) return null
    const last = state.artifacts.filter(a => a.kind === 'virtual_episode').at(-1)
    if (last && ts - last.createdAt < 20 * MINUTE) return null
    const interests = state.interests.filter(a => ts - a.updatedAt < 14 * 24 * 60 * MINUTE)
    const need = Number(input.selfState && input.selfState.energy)
    const score = action => {
      const recent = state.artifacts.filter(a => a.animationName === action.id && ts - a.createdAt < 24 * 60 * MINUTE)
      const related = interests.filter(t => (action.affinity === 'puzzle' && /推理|谜|解题|魔方|逻辑|棋/.test(t.topic)) ||
        (action.affinity === 'music' && /歌|音乐|旋律/.test(t.topic)) || (action.affinity === 'craft' && /手工|画|编织|设计/.test(t.topic)))
      const interest = related.reduce((value, item) => value + (item.kind === 'avoidance' ? -8 : 5) * item.strength, 0)
      return interest + (need < 45 && action.affinity === 'rest' ? 4 : 0) - recent.length * 4
    }
    return episodes.slice().sort((a, b) => score(b) - score(a) || hash(dayOf(ts) + a.id).localeCompare(hash(dayOf(ts) + b.id)))[0]
  }
  function threadOverlap(a, b) {
    // Chinese aspect words can split a topical phrase: 买书 -> 买完书.
    // Remove only temporal/aspect scaffolding, retaining the actual action and object.
    const topic = text => meaning(text).replace(/明天|今晚|已经|打算|准备|计划|不打算|不准备|完成|搞定|完|去/g, '')
    return overlap(topic(a), topic(b))
  }
  function threadMatch(threads, quote) {
    const ranked = threads.filter(t => t.status === 'open').map(t => ({ t, score: threadOverlap(t.quote, quote) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score)
    return ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score) ? ranked[0].t : null
  }
  function createSession(deps) {
    let committed = emptyState(), initJob = null, queue = Promise.resolve(), planJob = null, lastTick = 0
    let ready = false, lastError = null, current = null, visibilityVersion = 0
    const runtimeOwned = () => !!(deps.runtimeOwned && deps.runtimeOwned())
    async function init() {
      if (!initJob) initJob = Promise.resolve().then(() => deps.load()).then(r => {
        if (!r || r.ok !== true) throw Error((r && r.error) || 'life_load_failed')
        const state = r.state || emptyState()
        if (!validState(state)) throw Error('life_invalid_state')
        committed = hydrate(state); ready = true; return snapshot()
      }).catch(err => { lastError = String(err.message || err); initJob = null; throw err })
      return initJob
    }
    function snapshot() { return { ready, error: lastError, state: copy(committed) } }
    function mutate(fn, source, authorizeWrite) {
      const operation = queue.then(async () => {
        await init()
        const next = copy(committed), result = await fn(next)
        if (result && result.unchanged) return result
        next.revision = committed.revision + 1
        // The formal memory store retains important facts. This working context
        // stays bounded even after many long conversations and busy days.
        while (JSON.stringify(next).length > 470000 && next.turns.length > 40) next.turns.shift()
        while (JSON.stringify(next).length > 470000 && next.days.length > 14) next.days.shift()
        if (authorizeWrite && !authorizeWrite()) return { unchanged: true, ok: false, reason: 'runtime_cancelled' }
        const r = await deps.save(next, source)
        if (!r || r.ok !== true) throw Error((r && r.error) || 'life_save_failed')
        committed = next; lastError = null; return result
      })
      queue = operation.catch(err => { lastError = String(err.message || err) })
      return operation
    }
    function makeDay(state, ts) {
      let day = state.days.find(d => d.date === dayOf(ts))
      if (!day) {
        day = { date: dayOf(ts), createdAt: ts, planAttempted: false, planSource: 'local', activities: runtimeOwned() ? [] : localPlan(ts), experiences: [] }
        state.days.push(day); state.days = state.days.slice(-30)
      }
      return day
    }
    function experience(day, kind, text, ts, refs, extra) {
      const eventRef = (refs || []).find(ref => String(ref).startsWith('event:')) || ''
      const e = { id: 'life:' + hash(day.date + ':' + kind + ':' + text + ':' + eventRef), kind, text: clip(text, 240),
        ts, day: day.date, sourceRef: 'pet-life:' + day.date, refs: refs || [], subject: 'pet', ...(extra || {}) }
      if (!day.experiences.some(x => x.id === e.id)) day.experiences.push(e)
      day.experiences = day.experiences.slice(-24)
    }
    function insertActivity(day, activity) {
      if (day.activities.length < 4) { day.activities.push(activity); return activity }
      const finished = day.activities.findIndex(a => a.status === 'done' || a.abandoned)
      if (finished < 0) return null
      day.activities[finished] = activity
      return activity
    }
    function setVisibility(visible, nowTs) {
      const ts = Number(nowTs)
      if (typeof visible !== 'boolean' || !(ts > 0)) return Promise.resolve({ ok: false, reason: 'invalid_visibility' })
      // Apply the guard immediately, even while load/save is pending. Dropping the
      // next delta is conservative: hidden time can never become lived time.
      current = { ...(current || {}), visible, hidden: !visible }
      visibilityVersion++; lastTick = 0
      return mutate(state => {
        let changed = false
        if (!visible) state.days.forEach(day => day.activities.filter(a => a.status === 'active').forEach(a => {
          a.status = 'paused'; a.pauseReason = '桌宠暂时隐藏，回来后再继续'; changed = true
        }))
        return changed ? { ok: true, visible } : { unchanged: true, ok: true, visible }
      })
    }
    async function tick(input) {
      const i = input || {}, ts = Number(i.nowTs)
      if (!(ts > 0)) throw Error('life_missing_clock')
      current = i
      const visibilityAtStart = visibilityVersion
      await init()
      const delta = lastTick > 0 && ts - lastTick <= 3 * MINUTE ? Math.max(0, ts - lastTick) : 0
      lastTick = ts
      await mutate(state => {
        const before = JSON.stringify(state), day = makeDay(state, ts)
        state.threads.forEach(t => {
          if (t.status === 'open' && (t.expiresAt || threadDeadline(t.quote, t.ts)) < ts) {
            t.status = 'expired'; t.closedAt = ts; t.closeReason = 'past_confirmation_window'
          }
        })
        if (i.visible === false || i.hidden === true || (current && (current.visible === false || current.hidden === true))) {
          day.activities.filter(a => a.status === 'active').forEach(a => { a.status = 'paused'; a.pauseReason = '桌宠暂时隐藏，回来后再继续' })
          return JSON.stringify(state) === before ? { unchanged: true } : { ok: true }
        }
        if (runtimeOwned()) {
          for (const active of day.activities.filter(a => a.status === 'active')) {
            const permit = deps.continuation && deps.continuation(active.runtimeContinuation)
            if (!permit || i.busy) {
              active.status = 'paused'; active.pauseReason = '等待角色运行器重新授权'; continue
            }
            if (active.mode === 'virtual_episode') {
              if (ts - active.startedAt >= 3 * MINUTE) { active.status = 'paused'; active.pauseReason = '没有收到实际播放完成'; }
              continue
            }
            active.elapsedMs += visibilityAtStart !== visibilityVersion ? 0 : delta
            if (active.elapsedMs >= (active.kind === 'quiet_rest' ? 10 : 5) * MINUTE) {
              active.status = 'done'; active.finishedAt = ts
              experience(day, 'completed', active.resultText, ts, active.refs)
              if (active.material || (active.kind === 'curiosity_note' && active.resultText)) addArtifact(state, {
                id: 'artifact:' + active.id, kind: active.kind === 'revisit_memory' ? 'reflection' : active.kind === 'chat_notes' ? 'conversation_note' : 'curiosity',
                title: active.kind === 'revisit_memory' ? '想起一件小事' : active.kind === 'chat_notes' ? '留在小记里的原话' : '一个好奇的问题',
                text: active.resultText, evidenceQuote: active.material && active.material.text || null, material: active.material || null,
                createdAt: ts, sourceRefs: active.refs, refs: active.refs
              })
            }
          }
          return JSON.stringify(state) === before ? { unchanged: true } : { ok: true }
        }
        const needs = i.selfState || {}, em = (i.emotion && i.emotion.values) || i.emotion || {}
        const tired = (Number.isFinite(needs.energy) && needs.energy < 30) || em.fatigue >= 0.7
        const needsCare = (Number.isFinite(needs.satiety) && needs.satiety < 20) || (Number.isFinite(needs.thirst) && needs.thirst < 20)
        const allowed = Array.isArray(i.availableActions) ? new Set(i.availableActions.map(a => typeof a === 'string' ? a : a && (a.id || a.actionId))) : null
        day.activities.filter(a => a.mode === 'virtual_episode' && a.status === 'active').forEach(a => {
          if (allowed && !allowed.has(a.animationName)) {
            a.status = 'paused'; a.abandoned = true; a.pauseReason = '这件桌面小事暂时不能播放，先放下'; a.abandonedAt = ts
          } else if (!i.busy && ts - (a.lastAttemptAt || a.startedAt) >= 3 * MINUTE) {
            a.status = 'paused'; a.retryCount = (a.retryCount || 0) + 1; a.retryAt = ts + 5 * MINUTE
            a.pauseReason = '还没有收到播放完成，稍后再试'; a.abandoned = a.retryCount >= 3
          }
        })
        let active = day.activities.find(a => a.status === 'active') || day.activities.find(a => a.status === 'paused' && !a.abandoned && !(a.retryAt > ts))
        if (active && (i.busy || (active.kind !== 'quiet_rest' && (tired || needsCare)))) {
          if (active.status !== 'paused') {
            active.status = 'paused'; active.pauseReason = i.busy ? '我先把这件小事放一放，待会儿再继续' : (tired ? '我有点累，先缓一缓' : '我想先照顾一下自己的状态')
            experience(day, 'paused', active.pauseReason, ts, [active.id])
          }
          const rest = !i.busy && (day.activities.find(a => a.kind === 'quiet_rest' && a.status === 'planned') ||
            (tired && insertActivity(day, { id: day.date + ':rest:' + ts, kind: 'quiet_rest', wish: '现在有点累，想先歇一会儿',
              status: 'planned', elapsedMs: 0, atMinute: minuteOf(ts), source: 'needs' })))
          if (rest) {
            rest.status = 'active'; rest.startedAt = ts; rest.resultText = '我留了一段时间安静歇着'; rest.refs = [rest.id]
            experience(day, 'started', '我暂时放下刚才的事，安静歇一会儿', ts, [rest.id])
          }
        } else if (active) {
          const resumed = active.status === 'paused'
          active.status = 'active'; active.elapsedMs += resumed || visibilityAtStart !== visibilityVersion ? 0 : delta
          if (resumed) {
            delete active.pauseReason
            if (active.mode === 'virtual_episode') active.lastAttemptAt = ts
            experience(day, 'resumed', active.mode === 'virtual_episode' ? '我接着做桌面里刚才暂停的小事' :
              ({ revisit_memory: '我接着回想刚才没想完的事', chat_notes: '我接着整理刚才的聊天小记', quiet_rest: '我接着安静歇一会儿', curiosity_note: '我接着想刚才那个好奇的问题' })[active.kind], ts, [active.id])
          }
          if (active.mode !== 'virtual_episode' && active.elapsedMs >= (active.kind === 'quiet_rest' ? 10 : 5) * MINUTE) {
            active.status = 'done'; active.finishedAt = ts
            experience(day, 'completed', active.resultText, ts, active.refs)
            if (active.material || (active.kind === 'curiosity_note' && active.resultText)) addArtifact(state, {
              id: 'artifact:' + active.id, kind: active.kind === 'revisit_memory' ? 'reflection' : active.kind === 'chat_notes' ? 'conversation_note' : 'curiosity',
              title: active.kind === 'revisit_memory' ? '想起一件小事' : active.kind === 'chat_notes' ? '留在小记里的原话' : '一个好奇的问题',
              text: active.resultText, evidenceQuote: active.material && active.material.text || null, material: active.material || null,
              createdAt: ts, sourceRefs: active.refs, refs: active.refs
            })
          }
        } else if (!i.busy) {
          if (tired || needsCare) active = day.activities.find(a => a.kind === 'quiet_rest' && a.status === 'planned')
          else active = day.activities.find(a => a.status === 'planned' && a.atMinute <= minuteOf(ts) &&
            (a.kind !== 'revisit_memory' || !!chooseMemory(a, i.memories, state)) &&
            (a.kind !== 'chat_notes' || state.turns.some(t => dayOf(t.ts) === day.date)))
          if (!active && !tired && !needsCare) {
            const episode = availableEpisode(i, state, ts)
            if (episode) active = insertActivity(day, { id: day.date + ':episode:' + hash(ts + ':' + episode.id), kind: 'curiosity_note',
              mode: 'virtual_episode', animationName: episode.id, wish: episode.wish, resultText: '我' + episode.label,
              status: 'planned', elapsedMs: 0, atMinute: minuteOf(ts), source: 'living-motive', affinity: episode.affinity })
          }
          if (!active && tired) active = insertActivity(day, { id: day.date + ':rest:' + ts, kind: 'quiet_rest',
            wish: '现在有点累，想先歇一会儿', status: 'planned', elapsedMs: 0, atMinute: minuteOf(ts), source: 'needs' })
          if (active) {
            const mem = chooseMemory(active, i.memories, state)
            const turn = state.turns.filter(t => dayOf(t.ts) === day.date).slice(-1)[0]
            if (active.kind === 'revisit_memory' && mem) {
              active.sourceId = mem.id
              if (!overlap(active.wish, mem.content || mem.text)) active.wish = '想回想这条记下的小事：' + clip(mem.content || mem.text, 70)
              active.resultText = '我回想了这段记忆：' + clip(mem.content || mem.text, 160)
              active.refs = ['mem:' + mem.id]; active.material = { id: mem.id, text: clip(mem.content || mem.text, 160), date: mem.date || dayOf(mem.createdAt || ts) }
            } else if (active.kind === 'chat_notes' && turn) {
              active.resultText = '我把主人这句话记下来了：' + clip(turn.userText, 160)
              active.refs = [turn.messageRef]; active.material = { id: turn.messageRef, text: clip(turn.userText, 160), date: dayOf(turn.ts) }
            } else if (active.kind === 'quiet_rest') {
              active.resultText = '我留了一段时间安静歇着'; active.refs = [active.id]
            } else if (active.mode === 'virtual_episode') {
              active.refs = [active.id]
            } else if (active.kind === 'curiosity_note') {
              active.resultText = '我记下了一个好奇的问题：' + active.wish
              active.refs = [active.id]
            } else active = null // An empty notebook is not a completed activity.
            if (active) { active.status = 'active'; active.startedAt = ts; active.lastAttemptAt = ts;
              if (active.mode !== 'virtual_episode') experience(day, 'started', '我开始' + ({ revisit_memory: '回想以前的记忆', chat_notes: '整理今天的聊天小记', quiet_rest: '安静歇一会儿', curiosity_note: '想一件自己好奇的小事' })[active.kind], ts, active.refs)
            }
          }
        }
        if (JSON.stringify(state) === before) return { unchanged: true }
        return { ok: true }
      })
      if (deps.completeOperation) for (const activity of committed.days.flatMap(day => day.activities).filter(a => a.status === 'done' && a.mode !== 'virtual_episode' && a.runtimeExecutionId)) await deps.completeOperation(copy(activity))
      const today = committed.days.find(d => d.date === dayOf(ts))
      if (!runtimeOwned() && i.aiEnabled && !i.busy && i.visible !== false && i.hidden !== true && !(current && (current.visible === false || current.hidden === true)) && today && !today.planAttempted && !planJob && typeof deps.plan === 'function') {
        // Persist the attempt before calling AI: restart cannot repeat a daily request.
        planJob = mutate(state => { makeDay(state, ts).planAttempted = true }).then(() => deps.plan({
          nowTs: ts, context: context(ts), persona: i.persona, selfState: i.selfState, emotion: i.emotion,
          memories: rankedMemories(i.memories, committed).slice(0, 6).map(m => ({ id: m.id, content: clip(m.content || m.text, 160) }))
        })).then(raw => mutate(state => {
          const day = state.days.find(d => d.date === dayOf(ts)), plan = validatePlan(raw, ts, i.memories)
          if (!day) return { unchanged: true }
          day.planSource = plan ? 'ai' : 'local'; day.planError = plan ? null : clip(raw && raw.reason || 'invalid_plan', 80)
          if (plan) {
            plan.filter(a => a.kind === 'revisit_memory' && !a.sourceId).forEach(a => {
              const m = chooseMemory(a, i.memories, state)
              if (m) a.sourceId = m.id
            })
            const fixed = day.activities.filter(a => a.status !== 'planned')
            day.activities = fixed.concat(plan.filter(a => !fixed.some(f => f.kind === a.kind))).slice(0, 4)
          }
        })).catch(err => { lastError = 'life_plan:' + String(err.message || err) }).finally(() => { planJob = null })
      }
      return context(ts)
    }
    function proposeActivity(input) {
      if (!ready || input.busy || input.visible === false) return null
      const ts = Number(input.nowTs), state = copy(committed)
      const day = state.days.find(d => d.date === dayOf(ts)) || { date: dayOf(ts), activities: [] }
      if (day.activities.some(a => a.status === 'active')) return null
      const tired = Number(input.selfState && input.selfState.energy) < 30 || Number(input.emotion && input.emotion.values && input.emotion.values.fatigue) >= 0.7 ||
        Number(input.selfState && input.selfState.satiety) < 20 || Number(input.selfState && input.selfState.thirst) < 20
      let activity = day.activities.find(a => !a.abandoned && !(a.retryAt > ts) && ['paused', 'planned'].includes(a.status) &&
        (!tired || a.kind === 'quiet_rest') && (a.kind !== 'revisit_memory' || chooseMemory(a, input.memories, state)))
      if (!activity) {
        const episode = !tired && availableEpisode(input, { ...state, quietUntil: 0 }, ts)
        activity = episode ? { id: day.date + ':episode:' + hash(ts + ':' + episode.id), kind: 'curiosity_note', mode: 'virtual_episode',
          animationName: episode.id, wish: episode.wish, resultText: '我' + episode.label, source: 'living-motive', affinity: episode.affinity } :
          { id: day.date + ':runtime-rest:' + ts, kind: 'quiet_rest', wish: '想安静歇一会儿', source: 'needs' }
      }
      activity = copy(activity)
      const mem = chooseMemory(activity, input.memories, state), turn = state.turns.filter(t => dayOf(t.ts) === day.date).at(-1)
      if (activity.kind === 'revisit_memory') {
        if (!mem) return null
        activity.sourceId = mem.id; activity.resultText = '我回想了这段记忆：' + clip(mem.content || mem.text, 160)
        activity.refs = ['mem:' + mem.id]; activity.material = { id: mem.id, text: clip(mem.content || mem.text, 160), date: mem.date || dayOf(mem.createdAt || ts) }
      } else if (activity.kind === 'chat_notes') {
        if (!turn) return null
        activity.resultText = '我把主人这句话记下来了：' + clip(turn.userText, 160)
        activity.refs = [turn.messageRef]; activity.material = { id: turn.messageRef, text: clip(turn.userText, 160), date: dayOf(turn.ts) }
      } else {
        activity.resultText = activity.mode === 'virtual_episode' ? activity.resultText : activity.kind === 'quiet_rest' ? '我留了一段时间安静歇着' : '我记下了一个好奇的问题：' + activity.wish
        activity.refs = [activity.id]
      }
      return { revision: committed.revision, activity }
    }
    function startActivity(proposal, input, execution) {
      if (!runtimeOwned() || !deps.authorize || !deps.authorize(execution)) return Promise.resolve({ ok: false, reason: 'runtime_authorization_required' })
      return mutate(state => {
        if (!deps.authorize(execution)) return { unchanged: true, ok: false, reason: 'runtime_cancelled' }
        if (!proposal || proposal.revision !== committed.revision) return { unchanged: true, ok: false, reason: 'stale_life_proposal' }
        const day = makeDay(state, input.nowTs)
        if (day.activities.some(a => a.status === 'active')) return { unchanged: true, ok: false, reason: 'activity_active' }
        const proposed = copy(proposal.activity), existing = day.activities.find(a => a.id === proposed.id)
        const active = existing ? Object.assign(existing, proposed) : insertActivity(day, proposed)
        if (!active) return { unchanged: true, ok: false, reason: 'activity_capacity' }
        Object.assign(active, { status: 'active', startedAt: input.nowTs, lastAttemptAt: input.nowTs, elapsedMs: Number(active.elapsedMs) || 0,
          runtimeExecutionId: execution.executionId, runtimeContinuation: execution.continueAs('life:' + active.id) })
        delete active.pauseReason
        return { ok: true, activityId: active.id, continuationId: active.runtimeContinuation }
      })
    }
    function commitRuntimePolicy(policy, execution) {
      return mutate(state => {
        if (!runtimeOwned() || !deps.authorize || !deps.authorize(execution)) return { unchanged: true, ok: false, reason: 'runtime_authorization_required' }
        state.quietUntil = Math.max(0, Number(policy.quietUntil) || 0)
        state.conversationPolicy = { speechAct: 'answer', explicitClosing: !!policy.explicitClosing, updatedAt: policy.now, sourceRef: execution.executionId }
        return { ok: true }
      })
    }
    function context(ts, diaryDay, memoryView) {
      const day = committed.days.find(d => d.date === (diaryDay || dayOf(ts)))
      const memories = memoryView || (current && current.memories) || []
      const experienceDays = diaryDay ? (day ? [day] : []) : committed.days.slice(-3)
      const activities = day ? copy(day.activities).filter(a => !excluded(a, memories)).map(a => ({
        id: a.id, kind: a.kind, wish: a.wish, status: a.status, pauseReason: a.pauseReason || null,
        startedAt: a.startedAt || null, finishedAt: a.finishedAt || null, material: a.material || null,
        mode: a.mode || null, animationName: a.animationName || null, refs: a.refs || [], runtimeContinuation: a.runtimeContinuation || null, runtimeExecutionId: a.runtimeExecutionId || null,
        retryAt: a.retryAt || 0, retryCount: a.retryCount || 0, abandoned: !!a.abandoned
      })) : []
      const activeActivity = current && (current.visible === false || current.hidden === true) ? null : activities.find(a => a.status === 'active') || null
      const visible = row => !excluded(row, memories) && !sourceKeys(row).some(k => committed.ignoredSourceKeys.includes(k))
      return { ready, date: diaryDay || dayOf(ts), activities, activeActivity,
        artifacts: copy(committed.artifacts.filter(a => a.status === 'active' && (!diaryDay || dayOf(a.createdAt) === diaryDay) && visible(a))).slice(-12),
        interests: copy(committed.interests.filter(a => ts - a.updatedAt < 14 * 24 * 60 * MINUTE && visible(a))).slice(-8),
        livingState: { resting: !!(activeActivity && activeActivity.kind === 'quiet_rest' && !(current && current.busy)),
          quietUntil: Math.max(0, Number(committed.quietUntil) || 0), activityKind: activeActivity && activeActivity.kind || null,
          conversationPolicy: copy(committed.conversationPolicy || {}) },
        // Repeated verified motion remains in the persisted receipt trail, but is not new conversational material.
        experiences: copy(experienceDays.flatMap(d => d.experiences)).filter(e => e.proactiveEligible !== false && visible(e)).slice(diaryDay ? -24 : -8),
        conversations: copy(committed.turns.filter(t => (!diaryDay || dayOf(t.ts) === diaryDay) && !excluded(t, memories)).slice(-6)),
        threads: copy(committed.threads.filter(t => t.status === 'open' && (t.expiresAt || threadDeadline(t.quote, t.ts)) >= ts && !excluded(t, memories)).slice(-6)),
        recentContacts: copy(committed.contacts.slice(-8)) }
    }
    function candidates(input) {
      const i = input || {}, ts = Number(i.nowTs), out = [], seen = new Set()
      if (!runtimeOwned() && committed.quietUntil > ts) return []
      const push = row => {
        if (!row.text || seen.has(row.id) || excluded(row, i.allMemories || i.memories)) return
        // A routine movement or rest is valid life, but has no new conversational event on its own.
        // Keep the receipt/activity in storage; only omit the unsolicited topic candidate.
        if (['self_activity', 'self_experience'].includes(row.source) &&
            (row.kind === 'quiet_rest' || ['idle-stretch', 'idle-mirror', 'routine-brush'].includes(row.animationName))) return
        if (row.source === 'self_experience' && (row.refs || []).some(ref => committed.days.some(day =>
          day.activities.some(a => a.id === ref && a.kind === 'quiet_rest')))) return
        const contacts = committed.contacts.filter(c => c.candidateId === row.id)
        const last = contacts.slice(-1)[0]
        if (last && ts - last.ts < (last.repliedAt ? 30 : 120) * MINUTE) return
        if (contacts.filter(c => dayOf(c.ts) === dayOf(ts)).length >= 2) return
        row.sourceKeys = sourceKeys(row)
        if (row.sourceKeys.some(k => committed.ignoredSourceKeys.includes(k))) return
        const latestContact = committed.contacts.at(-1)
        row.fresh = row.source !== 'environment' && !row.sourceKeys.includes('motif:quiet_presence') &&
          Number(row.originTs) > (latestContact ? latestContact.ts : 0) && ts >= Number(row.originTs) && ts - Number(row.originTs) < 24 * 60 * MINUTE
        if (repeatReason(row.sourceKeys, row.fresh, committed, ts)) return
        seen.add(row.id); out.push(row)
      }
      const life = context(ts, null, i.allMemories || i.memories)
      life.activities.filter(a => a.status === 'active' || (a.status === 'paused' && !a.abandoned)).forEach(a => push({
        id: 'self:' + a.id + ':' + a.status, source: 'self_activity', text: a.wish + '；状态：' + a.status + (a.pauseReason ? '；' + a.pauseReason : ''),
        date: life.date, kind: a.kind, animationName: a.animationName, originTs: a.startedAt, confidence: 1, forms: a.kind === 'quiet_rest' ? ['share', 'accompany'] : ['share', 'question', 'invite'], material: a.material || null
      }))
      life.experiences.filter(e => e.proactiveEligible !== false).slice(-3).forEach(e => push({ id: e.id, source: e.actor === 'owner' || e.sourceType === 'game.completed' ? 'observed_owner_event' : 'self_experience', text: e.text, date: e.day, originTs: e.ts, confidence: 1, forms: ['share', 'question'], refs: e.refs, animationName: e.animationName, actor: e.actor || (e.sourceType === 'game.completed' ? 'owner' : 'character'), observer: e.observer || 'character', subject: e.subject, world: e.world || 'virtual', sourceType: e.sourceType }))
      life.threads.filter(t => !(t.deferUntil > ts)).slice(-3).forEach(t => push({ id: t.id, source: 'unfinished_conversation', text: '主人说过：' + t.quote, date: dayOf(t.ts), confidence: 1, forms: ['question', 'share'], messageRef: t.messageRef }))
      rankedMemories(i.memories, committed).forEach(m => push({ id: 'memory:' + m.id, source: 'memory',
        text: String(m.content || m.text), date: m.date || (m.createdAt ? dayOf(m.createdAt) : null), originTs: m.createdAt, confidence: Number(m.confidence) || 0.7,
        forms: ['share', 'question', 'invite'], memory: { id: m.id, content: String(m.content || m.text), date: m.date || null } }))
      life.conversations.slice(-2).forEach(t => push({ id: 'conversation:' + t.messageRef, source: 'owner_words', text: '主人说过：' + clip(t.userText, 200), date: dayOf(t.ts), originTs: t.ts, confidence: 1, forms: ['share', 'question'], messageRef: t.messageRef }))
      ;(Array.isArray(i.history) ? i.history : []).filter(t => t && t.role === 'user' && t.messageRef && t.ts && !life.conversations.some(c => c.messageRef === t.messageRef)).slice(-2).forEach(t => push({
        id: 'conversation:' + t.messageRef, source: 'owner_words', text: '主人说过：' + clip(t.text, 200), date: dayOf(t.ts), originTs: t.ts, confidence: 1, forms: ['share', 'question'], messageRef: t.messageRef
      }))
      const r = i.reality || {}, app = r.currentApp
      if (app && app.app && app.seenAtTs > 0 && ts - app.seenAtTs >= 0 && ts - app.seenAtTs < 2 * MINUTE) push({
        id: 'environment:' + hash(app.app + ':' + app.cat + ':' + dayOf(ts)), source: 'environment',
        text: '前台应用为' + clip(app.app, 60) + '，类别为' + clip(app.cat, 20) + '；只知道应用信息，不知道内容、目的和主人心情',
        date: dayOf(ts), confidence: 0.65, forms: ['accompany', 'share'], observedAt: app.seenAtTs
      })
      ;(Array.isArray(i.events) ? i.events : []).filter(e => /milestone|achievement|task_complete|work_completed/.test(String(e.kind || e.type || '')) && e.ts && ts >= e.ts && ts - e.ts < 60 * MINUTE).slice(-2).forEach(e => push({
        id: 'event:' + (e.id || hash(e.ts + ':' + e.text)), source: 'event', text: clip(e.text || e.description, 160), date: dayOf(e.ts), originTs: e.ts, confidence: 1, forms: ['celebrate', 'share']
      }))
      life.artifacts.forEach(a => push({ id: a.id, source: a.actor === 'owner' || a.sourceType === 'game.completed' ? 'observed_owner_event' : 'self_experience', text: a.text, date: dayOf(a.createdAt), originTs: a.createdAt,
        confidence: 1, kind: a.kind, animationName: a.animationName, material: a.material || null, refs: a.sourceRefs || [], forms: ['share', 'question'], actor: a.actor || (a.sourceType === 'game.completed' ? 'owner' : 'character'), observer: a.observer || 'character', subject: a.subject, world: a.world || 'virtual', sourceType: a.sourceType }))
      // Relationship opportunity is supported by actual interaction cadence; it is not an invented episode.
      const lastOwner = Math.max(0, ...life.conversations.map(row => Number(row.ts) || 0), ...(i.history || []).filter(row => row.role === 'user').map(row => Number(row.ts) || 0))
      const lastContact = committed.contacts.at(-1)
      if (lastOwner > 0 && ts - lastOwner >= 4 * 60 * MINUTE && (!lastContact || lastContact.repliedAt || lastContact.ts < lastOwner)) push({
        id: 'social:' + lastOwner, source: 'interaction_cadence', kind: 'social_contact',
        text: '已有真实互动，当前交流已结束，可以选择轻松闲聊，也可以继续安静等待。没有新的经历可供声称。',
        date: dayOf(lastOwner), originTs: lastOwner, confidence: 1, forms: ['question', 'share'],
        actor: 'character', observer: 'system', subject: 'relationship', world: 'system',
        opportunity: { reason: 'relationship_reconnect', lastOwnerAt: lastOwner }, evidenceRefs: [],
      })
      // Admission and cooldown happen before budgets; a cooling recent item cannot hide unused material.
      const rank = row => (row.fresh ? 100 : 0) + (({ event: 35, unfinished_conversation: 25, owner_words: 20, self_experience: 18, observed_owner_event: 18, interaction_cadence: 10, self_activity: 12, memory: 8, environment: 0 })[row.source] || 0)
      out.sort((a, b) => rank(b) - rank(a) || (Number(b.originTs) || 0) - (Number(a.originTs) || 0) || a.id.localeCompare(b.id))
      const selected = [], bySource = new Map()
      for (const row of out) {
        const cap = row.source === 'memory' ? 4 : 5
        if ((bySource.get(row.source) || 0) >= cap) continue
        selected.push(row); bySource.set(row.source, (bySource.get(row.source) || 0) + 1)
        if (selected.length >= 14) break
      }
      return selected
    }
    async function recordTurn(input) {
      const i = input || {}, ts = Number(i.ts), ref = clip(i.messageRef, 120)
      if (!(ts > 0) || !ref || !i.userText) throw Error('life_turn_missing_evidence')
      const verified = verifiedMemory(i.memory, i.userText, ref, ts)
      const factWrite = runtimeOwned() && i.metadataOnly
      const sourceGuard = factWrite ? { messageRef: ref, ts, text: String(i.userText) } : null
      const factAllowed = () => deps.authorizeFacts && deps.authorizeFacts(i.runtimeFactExecution, ref)
      if (factWrite && !factAllowed()) return { ok: false, reason: 'runtime_cancelled' }
      const durable = factWrite && typeof deps.factBegin === 'function'
      if (durable) {
        const began = await deps.factBegin({ messageRef: ref, ts, userText: String(i.userText), memory: i.memory || null,
          conversation: i.conversation || null, replyTo: i.replyTo || null, eligibleMemory: !!verified })
        if (began && began.ok === false) return began
      }
      const recorded = await mutate(async state => {
        if (runtimeOwned() && (factWrite ? !factAllowed() : !deps.authorize || !deps.authorize(i.runtimeExecution))) return { unchanged: true, ok: false, reason: 'runtime_cancelled' }
        if (factWrite) {
          const source = deps.loadSource && await deps.loadSource(ref)
          if (!source || source.role !== 'user' || source.ts !== ts || source.text !== String(i.userText) ||
            i.runtimeFactExecution.sourceTs !== ts || !factAllowed()) return { unchanged: true, ok: false, reason: 'history_source_invalid' }
          const memories = deps.memories ? deps.memories() : []
          const archivedSource = memories.some(m => m.status === 'archived' && (m.evidenceRefs || []).some(e => e && e.messageRef === ref))
          if (archivedSource || excluded({ messageRef: ref, userText: i.userText }, memories) || state.ignoredSourceKeys.includes(ref) ||
            state.ignoredSourceKeys.includes('conversation:' + ref)) return { unchanged: true, ok: false, reason: 'source_forgotten' }
        }
        const priorTurn = state.turns.find(t => t.messageRef === ref)
        if (i.metadataOnly) {
          if (priorTurn && (priorTurn.userText !== clip(i.userText, 800) || priorTurn.metadataApplied)) return { unchanged: true }
          if (!priorTurn && !factWrite) return { unchanged: true }
          if (priorTurn) {
            priorTurn.memory = verified ? { quote: verified.quote, kind: verified.kind, label: verified.label } : null
            priorTurn.metadataApplied = true
          }
        } else if (priorTurn) {
          if (priorTurn.userText !== clip(i.userText, 800) || priorTurn.assistantText || !i.assistantText) return { unchanged: true }
          priorTurn.assistantText = clip(i.assistantText, 800)
          const contact = i.replyTo && state.contacts.find(c => c.instanceId === i.replyTo)
          if (contact) contact.repliedAt = ts
          return { ok: true }
        }
        const metadata = i.conversation || i.metadata || i.conversationPolicy || {}
        if (!i.metadataOnly) {
          // Fresh owner input releases an old pause; a newly explicit finite pause may replace it.
          if (!runtimeOwned()) {
          state.quietUntil = 0
          if (Number.isFinite(metadata.quietUntil) && metadata.quietUntil > ts &&
            /先别|不要[^。！？]{0,12}(主动|找|打扰)|别[^。！？]{0,10}(找|打扰)|稍后|晚点|过会|等我|再聊|分钟|小时/.test(i.userText)) {
            state.quietUntil = Math.min(ts + 24 * 60 * MINUTE, metadata.quietUntil)
          }
          state.conversationPolicy = {
            speechAct: ['answer', 'acknowledge', 'clarify', 'continue', 'share', 'invite', 'playful', 'comfort', 'close'].includes(metadata.speechAct) ? metadata.speechAct : 'answer',
            explicitClosing: !!metadata.explicitClosing, updatedAt: ts, sourceRef: ref
          }
          }
          if (!runtimeOwned()) {
          state.quietDecisions = 0
          state.nextDecisionAt = Math.min(Number(state.nextDecisionAt) || ts + 10 * MINUTE, ts + 10 * MINUTE)
          }
          const contact = i.replyTo && state.contacts.find(c => c.instanceId === i.replyTo)
          if (contact) contact.repliedAt = ts
        }
        if (!priorTurn) {
          state.turns.push({ messageRef: ref, ts, userText: clip(i.userText, 800), assistantText: i.metadataOnly ? '' : clip(i.assistantText, 800),
            memory: verified ? { quote: verified.quote, kind: verified.kind, label: verified.label } : null, metadataApplied: !!i.metadataOnly })
          state.turns = state.turns.sort((a, b) => a.ts - b.ts).slice(-160)
        }
        const contact = i.replyTo && state.contacts.find(c => c.instanceId === i.replyTo)
        if (!runtimeOwned() && i.metadataOnly && state.conversationPolicy && state.conversationPolicy.sourceRef === ref) {
          state.conversationPolicy.speechAct = metadata.speechAct || state.conversationPolicy.speechAct
        }
        const laterResolution = verified && state.turns.some(t => t.ts > ts && threadOverlap(verified.quote, t.userText) > 0 &&
          (explicitResolution(t.userText) || explicitCancellation(t.userText)))
        if (verified && verified.kind === 'plan' && !laterResolution) {
          const id = 'thread:' + hash(ref + ':' + verified.quote)
          state.threads.push({ id, quote: verified.quote, label: verified.label, ts, messageRef: ref, status: 'open',
            expiresAt: threadDeadline(verified.quote, ts), updatedAt: ts })
          state.threads = state.threads.slice(-40)
        }
        const updates = Array.isArray(metadata.threadUpdates) ? metadata.threadUpdates : Array.isArray(i.threadUpdates) ? i.threadUpdates : []
        const applied = new Set()
        for (const update of updates.slice(0, 6)) {
          const thread = state.threads.find(t => t.id === update.threadId && t.status === 'open')
          if (!thread || (thread.updatedAt || 0) > ts || !hasQuote(update.quote, i.userText) || (update.sourceRef && update.sourceRef !== ref) || !['continue', 'resolve', 'cancel', 'defer'].includes(update.operation)) continue
          const related = threadOverlap(thread.quote, update.quote) > 0 || (contact && contact.candidateId === thread.id)
          const clause = evidenceClause(update.quote, i.userText)
          if (update.operation === 'resolve' && (!explicitResolution(clause) || !related)) continue
          if (update.operation === 'cancel' && (!explicitCancellation(clause) || !related)) continue
          if (update.operation === 'defer' && (!related || !/晚点|稍后|明天|改天|再说|推迟|延期/.test(clause))) continue
          if (update.operation === 'resolve' || update.operation === 'cancel') {
            thread.status = update.operation === 'resolve' ? 'resolved' : 'cancelled'; thread.closedAt = ts; thread.closeQuote = update.quote
          } else if (update.operation === 'defer') {
            thread.deferUntil = ts + (/明天|改天/.test(update.quote) ? 24 * 60 : 60) * MINUTE
            thread.expiresAt = Math.max(thread.expiresAt || 0, thread.deferUntil + 24 * 60 * MINUTE)
          }
          thread.updatedAt = ts; thread.lastMessageRef = ref; applied.add(thread.id)
        }
        // Compatibility: an explicit completed/cancelled statement can close an unambiguous matching plan
        // even when it was volunteered in ordinary chat, without requiring a proactive contact.
        if (verified && ['resolved', 'dislike'].includes(verified.kind)) {
          const thread = contact && state.threads.find(t => t.id === contact.candidateId && t.status === 'open') || threadMatch(state.threads, verified.quote)
          if (thread && (thread.updatedAt || 0) <= ts && !applied.has(thread.id) && (explicitResolution(verified.quote) || explicitCancellation(verified.quote))) {
            thread.status = explicitCancellation(verified.quote) ? 'cancelled' : 'resolved'; thread.closedAt = ts; thread.closeQuote = verified.quote; thread.lastMessageRef = ref
          }
        }
        const interestEvidence = Array.isArray(metadata.interestEvidence) ? metadata.interestEvidence : Array.isArray(i.interestEvidence) ? i.interestEvidence : []
        let acceptedInterests = 0
        for (const evidence of interestEvidence.slice(0, 4)) {
          const topic = clip(evidence.topic, 40)
          if (!topic || evidence.source !== 'current_user_turn' || !hasQuote(evidence.quote, i.userText) ||
            (evidence.sourceRef && evidence.sourceRef !== ref) ||
            !['curiosity', 'enjoyment', 'avoidance'].includes(evidence.kind) || !overlap(topic, evidence.quote)) continue
          const id = 'interest:' + hash(meaning(topic)), prior = state.interests.find(x => x.id === id)
          if (prior && prior.updatedAt > ts) continue
          if (prior) { prior.kind = evidence.kind; prior.updatedAt = ts; prior.evidenceQuote = evidence.quote; prior.refs = [ref]; prior.strength = Math.min(1, (prior.strength || 0.4) + 0.1) }
          else state.interests.push({ id, topic, kind: evidence.kind, strength: 0.4, updatedAt: ts, evidenceQuote: evidence.quote, refs: [ref], subject: 'pet', source: 'conversation_interest' })
          acceptedInterests++
        }
        state.interests = state.interests.slice(-16)
        if (verified || applied.size || acceptedInterests) addArtifact(state, {
          id: 'note:' + ref, kind: 'conversation_note', title: verified && verified.label || '一次在意的聊天',
          text: clip(i.userText, 240), evidenceQuote: clip(i.userText, 240), createdAt: ts, sourceRefs: [ref], refs: [ref],
          material: { id: ref, text: clip(i.userText, 240), date: dayOf(ts) }
        })
        if (!priorTurn) {
          const day = makeDay(state, ts)
          experience(day, 'conversation', '主人跟我说：' + clip(i.userText, 160), ts, [ref])
        }
      }, sourceGuard, factWrite ? factAllowed : null)
      if (recorded && recorded.ok === false) return recorded
      async function advance(step, detail) {
        if (!durable || !deps.factAdvance) return
        const result = await deps.factAdvance(ref, step, detail)
        if (result && result.ok === false) throw Error(result.reason || 'fact_checkpoint_failed')
      }
      await advance('lifeApplied')
      let memoryAccepted = false
      if (verified && (durable || !(recorded && recorded.unchanged)) && (!runtimeOwned() || (factWrite ? factAllowed() : deps.authorize(i.runtimeExecution))) && typeof deps.remember === 'function') {
        const r = durable && deps.hasMemoryEvidence && deps.hasMemoryEvidence(verified.candidate) ? { ok: true, alreadyApplied: true } : deps.remember(verified.candidate)
        memoryAccepted = !!(r && (r.ok || r.reason === 'duplicate_event'))
        if (r && r.ok === false && !memoryAccepted) {
          lastError = 'memory:' + String(r.reason || 'rejected')
          await advance('memoryRejected', { reason: lastError })
          return { ok: false, reason: lastError, lifeCommitted: true, memoryAccepted: false }
        }
      }
      if (durable) {
        if (verified && !memoryAccepted) return { ok: false, reason: 'memory_pending_authorization', lifeCommitted: true }
        await advance('memoryAccepted')
        const flushed = deps.flushMemory ? await deps.flushMemory() : { ok: !verified }
        if (!flushed || !flushed.ok) return { ok: false, reason: flushed && flushed.reason || 'memory_persist_failed', lifeCommitted: true, memoryAccepted }
        await advance('memoryPersisted')
      }
      return { ok: true, unchanged: !!(recorded && recorded.unchanged), memoryAccepted }
    }
    function recordEvent(input) {
      const i = input || {}, ts = Number(i.ts), eventId = clip(i.eventId, 180)
      if (i.type === 'animation.completed' && (i.visible === false || (i.visible !== true && current && (current.visible === false || current.hidden === true)))) return Promise.resolve({ ok: false, reason: 'life_not_visible' })
      if (!EVENT_TYPES.includes(i.type) || !(ts > 0) || !eventId) return Promise.resolve({ ok: false, reason: 'unsupported_life_event' })
      if (i.type === 'animation.completed' && !VIRTUAL_ACTIONS.some(a => a.id === i.animation)) return Promise.resolve({ ok: false, reason: 'unsupported_virtual_action' })
      const gameLabels = { catch: '接金币', snake: '贪吃蛇', t2048: '2048', guess: '猜数字', ttt: '井字棋', sudoku: '数独', gomoku: '五子棋', mines: '扫雷' }
      if (i.type === 'game.completed' && (!i.game || !gameLabels[i.game.gameId])) return Promise.resolve({ ok: false, reason: 'unsupported_game_event' })
      if (i.type === 'work.completed' && (!i.text || !/^完成了桌宠工作：/.test(i.text) || /外出|联网|读屏|打开文件|现实/.test(i.text))) return Promise.resolve({ ok: false, reason: 'unsupported_work_event' })
      return mutate(state => {
        if (state.eventIds.includes(eventId)) return { unchanged: true, ok: true }
        const day = makeDay(state, ts), action = VIRTUAL_ACTIONS.find(a => a.id === i.animation)
        const refs = ['event:' + eventId]
        let text, title, kind
        if (i.type === 'animation.completed') {
          const permit = deps.continuation && deps.continuation(i.continuationId)
          if (runtimeOwned() && (!permit || permit.executionId !== i.executionId)) return { unchanged: true, ok: false, reason: 'runtime_authorization_required' }
          const active = day.activities.find(a => a.status === 'active' && a.mode === 'virtual_episode' && a.animationName === i.animation && a.startedAt <= ts && (!runtimeOwned() || a.runtimeExecutionId === i.executionId))
          text = '我' + action.label; title = action.wish.replace(/^想/, ''); kind = 'virtual_episode'
          if (active) { active.status = 'done'; active.finishedAt = ts; active.completionEventId = eventId; refs.push(active.id) }
        } else if (i.type === 'game.completed') {
          text = '主人在桌宠程序里玩了' + gameLabels[i.game.gameId] + '，这一局结束了'
          if (Number.isFinite(i.game.score) && Math.abs(i.game.score) <= 1000000) text += '，这局得分 ' + i.game.score
          title = gameLabels[i.game.gameId] + '的一局'; kind = 'shared_game'
        } else { text = clip(i.text, 200); title = '一项桌宠工作'; kind = 'shared_work' }
        const virtualNotes = state.artifacts.filter(a => a.kind === 'virtual_episode')
        const latest = virtualNotes.at(-1), same = action && virtualNotes.filter(a => a.animationName === action.id).at(-1)
        const notable = !action || ((!latest || ts - latest.createdAt >= 10 * MINUTE) && (!same || ts - same.createdAt >= 60 * MINUTE))
        const semantics = { actor: i.type === 'game.completed' ? 'owner' : 'character', observer: 'character', subject: i.type === 'game.completed' ? 'owner' : 'character', world: 'virtual', sourceType: i.type }
        const artifact = notable ? addArtifact(state, { id: 'event-artifact:' + hash(eventId), kind, title, text, createdAt: ts, sourceRefs: refs, refs,
          animationName: action ? action.id : null, ...semantics, evidenceEventId: eventId }) : null
        if (artifact) Object.assign(artifact, semantics)
        experience(day, 'completed', text, ts, refs, { ...semantics, animationName: action ? action.id : null, proactiveEligible: notable })
        state.eventIds.push(eventId); state.eventIds = state.eventIds.slice(-240)
        return { ok: true, artifactId: artifact && artifact.id || null }
      })
    }
    function forgetArtifact(id) {
      const artifact = committed.artifacts.find(a => a.id === id)
      if (artifact && artifact.status === 'active' && deps.invalidateFacts) {
        for (const ref of artifact.sourceRefs || artifact.refs || []) deps.invalidateFacts(ref)
      }
      return mutate(state => {
        const artifact = state.artifacts.find(a => a.id === id)
        if (!artifact || artifact.status !== 'active') return { unchanged: true, ok: false, reason: 'artifact_not_found' }
        artifact.status = 'removed'; artifact.removedAt = Date.now()
        state.ignoredSourceKeys = [...new Set(state.ignoredSourceKeys.concat(sourceKeys(artifact)))].slice(-240)
        return { ok: true }
      })
    }
    function getArtifacts(ts, memoryView) {
      const memories = memoryView || current && current.memories || []
      return copy(committed.artifacts.filter(a => a.status === 'active' && !excluded(a, memories)))
    }
    function invalidateSources(refs) {
      const set = new Set(refs)
      return mutate(state => {
        const linked = row => set.has(row.messageRef) || (row.sourceRefs || row.refs || []).some(r => set.has(r)) || row.material && set.has(row.material.id)
        for (const key of ['turns', 'threads', 'artifacts', 'interests']) state[key] = state[key].filter(row => !linked(row))
        for (const day of state.days) { day.activities = day.activities.filter(row => !linked(row)); day.experiences = day.experiences.filter(row => !linked(row)) }
        state.ignoredSourceKeys = [...new Set(state.ignoredSourceKeys.concat(refs))].slice(-240)
        return { ok: true }
      })
    }
    function presented(input) {
      const i = input || {}
      if (!i.candidateId || !i.instanceId || !(i.ts > 0)) return Promise.resolve({ unchanged: true })
      return mutate(state => {
        if (runtimeOwned() && (!deps.authorize || !deps.authorize(i.runtimeExecution))) return { unchanged: true, ok: false, reason: 'runtime_authorization_required' }
        if (state.contacts.some(c => c.instanceId === i.instanceId)) return { unchanged: true }
        state.contacts.push({ candidateId: clip(i.candidateId, 180), instanceId: clip(i.instanceId, 120), ts: i.ts,
          topic: clip(i.topic, 60), opening: clip(i.opening, 100), form: clip(i.form, 20), repliedAt: null,
          sourceKeys: Array.isArray(i.sourceKeys) ? i.sourceKeys.filter(k => typeof k === 'string').slice(0, 12).map(k => clip(k, 180)) : [] })
        state.contacts = state.contacts.slice(-100)
      })
    }
    async function flush() { await queue; return { ok: !lastError, error: lastError } }
    function canPlan(ts) { return ready && ts >= Math.max(Number(committed.nextDecisionAt) || 0, Number(committed.quietUntil) || 0) }
    function reserveDecision(ts) {
      if (runtimeOwned()) return Promise.resolve({ ok: false, unchanged: true, reason: "runtime_owned" })
      return mutate(state => {
        if (ts < Math.max(Number(state.nextDecisionAt) || 0, Number(state.quietUntil) || 0)) return { unchanged: true, ok: false }
        state.nextDecisionAt = ts + 10 * MINUTE
        return { ok: true }
      })
    }
    function decisionFeedback(input) {
      if (runtimeOwned()) return Promise.resolve({ ok: false, unchanged: true, reason: "runtime_owned" })
      return mutate(state => {
        state.quietDecisions = input.quiet ? Math.min(3, (Number(state.quietDecisions) || 0) + 1) : 0
        if (input.quiet) state.nextDecisionAt = input.nowTs + 15 * MINUTE * Math.pow(2, state.quietDecisions)
      })
    }
    function canPresentDecision(decision, ts) {
      return (runtimeOwned() || committed.quietUntil <= ts) && !(decision.sourceKeys || []).some(k => committed.ignoredSourceKeys.includes(k)) &&
        !repeatReason(decision.sourceKeys || [], !!decision.fresh, committed, ts)
    }
    return { init, tick, proposeActivity, startActivity, commitRuntimePolicy, setVisibility, context, candidates, recordTurn, recordEvent, forgetArtifact, getArtifacts, invalidateSources, presented, flush, snapshot, canPlan, reserveDecision, decisionFeedback, canPresentDecision }
  }
  function validateDecision(raw, candidates, action) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'invalid_decision' }
    if (raw.speak === false) return { ok: true, silent: true }
    const chosen = candidates.find(c => c.id === raw.candidateId)
    const opening = clip(raw.opening, 200), form = raw.form
    if (!chosen || !FORMS.includes(form) || !chosen.forms.includes(form)) return { ok: false, reason: 'invalid_topic_source' }
    if (action === 'accompany_owner' && form !== 'accompany') return { ok: false, reason: 'action_form_mismatch' }
    if (action === 'celebrate' && form !== 'celebrate') return { ok: false, reason: 'action_form_mismatch' }
    if (action === 'comment_on_activity' && form !== 'share') return { ok: false, reason: 'action_form_mismatch' }
    if (!opening || opening.length > 100) return { ok: false, reason: 'invalid_opening' }
    if (/(?:我的)?记性.{0,8}(?:不会|不太会).{0,4}漏|永远(?:都)?记得|绝不会忘|所有.{0,4}都记得/.test(opening)) return { ok: false, reason: 'memory_guarantee_unsupported' }
    const ids = raw.sourceIds === undefined ? [chosen.id] : raw.sourceIds
    if (!Array.isArray(ids) || ids.length > 4 || ids.some(id => !candidates.some(c => c.id === id))) return { ok: false, reason: 'invalid_topic_source' }
    const used = [...new Set([chosen.id, ...ids])].map(id => candidates.find(c => c.id === id))
    const keys = [...new Set(used.flatMap(c => c.sourceKeys || sourceKeys(c)))].slice(0, 12)
    return { ok: true, silent: false, candidate: chosen, candidateId: chosen.id, sourceIds: used.map(c => c.id), sourceKeys: keys,
      fresh: used.some(c => c.fresh), form, opening, topic: clip(raw.topic, 60) }
  }
  return { createSession, emptyState, validState, dayOf, validatePlan, validateDecision, verifiedMemory, VIRTUAL_ACTIONS }
})
