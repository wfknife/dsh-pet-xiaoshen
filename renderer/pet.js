/* DeskPet renderer - plain JS, talks to DSH through the main process. */
(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const runtimeBubblePermits = new Map()
  let currentAnimationOwner = null
  const roleRuntime = window.CharacterRuntime.create({ decide: decideCharacterEvent,
    onChange: record => {
      if (platformBridge && record.phase === 'completed' && record.automatic && record.ok && !record.silent) void platformBridge.presented(record.inputId).catch(e => console.warn('[platform] budget save:', e.message))
    },
    presentation: { claim: plan => presentationPlans ? presentationPlans.claim(plan) : null, stage: (token, phase) => presentationPlans && presentationPlans.stage(token, phase),
      setVisible: value => presentationPlans && presentationPlans.setVisible(value) }, initialState: async () => {
    await window.PetLife.init()
    const state = window.PetLife.snapshot().state
    const saved = window.pet.platform ? await window.pet.platform.info() : null
    if (saved && !saved.ok) throw Error(saved.reason || 'platform_restore_failed')
    return { quietUntil: state.quietUntil, lastAutomatic: Math.max(0, saved && saved.policy && saved.policy.lastAutomatic || 0, ...state.contacts.map(c => Number(c.ts) || 0)) }
  } })
  window.RoleRuntime = roleRuntime
  const platformBridge = window.pet.platform
  if (platformBridge && platformBridge.onInvalidated) platformBridge.onInvalidated(data => {
    const received = new Set(data && data.refs || []), refs = new Set(received)
    for (const memory of window.MemoryEngine.getMemories()) if ((memory.evidenceRefs || []).some(e => refs.has(e.messageRef))) { refs.add(memory.id); refs.add('mem:' + memory.id) }
    const derived = [...refs].filter(ref => !received.has(ref))
    for (let index = 0; index < derived.length; index += 240) void platformBridge.forget(derived.slice(index, index + 240)).catch(e => console.warn('[platform] lineage delete:', e.message))
    roleRuntime.invalidateFacts('source_forgotten', ref => refs.has(ref))
    roleRuntime.cancel('source_forgotten', event => event.origin === 'automatic' || refs.has(event.messageRef))
    if (characterRetryTurn && refs.has(characterRetryTurn.messageRef)) characterRetryTurn = null
    window.PlatformContext = null
    if (window.PetLife.invalidateSources) void window.PetLife.invalidateSources([...refs]).catch(e => console.warn('[platform]', e.message))
    if (window.MemoryEngine.invalidateSources) window.MemoryEngine.invalidateSources([...refs])
  })
  const presentationPlans = window.PresentationPlan ? window.PresentationPlan.create({ receipt: row => platformBridge && platformBridge.delivery && platformBridge.delivery(row) }) : null
  const lifeCapabilities = platformBridge && window.CharacterCapabilities ? window.CharacterCapabilities.create({
    store: platformBridge, authorize: (execution, effect) => effect === 'virtual' && roleRuntime.isAuthorized(execution)
  }) : null
  if (lifeCapabilities) lifeCapabilities.register({ id: 'life.virtual-activity', provider: 'builtin.pet-life', version: '1', effect: 'virtual', timeoutMs: 5000,
    input: window.CharacterCapabilities.SCHEMAS.activityInput, output: window.CharacterCapabilities.SCHEMAS.activity, available: () => !!window.PetLife.snapshot().ready },
    async (value, host, execution) => {
      const result = await window.PetLife.startActivity(value.proposal, value.input, execution)
      return result && result.ok ? { ok: true, awaitingReceipt: true, value: { ...result, virtual: true } } : result
    })
  async function recoverPlatformFacts() {
    if (!platformBridge) return
    const info = await platformBridge.info()
    if (!info || !info.ok) throw Error(info && info.reason || 'platform_unavailable')
    window.PlatformCandidate = { enabled: !!info.enabled }
    const restored = await platformBridge.recover()
    if (!restored || !restored.ok) throw Error(restored && restored.reason || 'operation_recovery_failed')
    await window.PetLife.init()
    if (window.MemoryEngine && window.MemoryEngine.init) await window.MemoryEngine.init()
    const jobs = await platformBridge.pendingFacts()
    if (!Array.isArray(jobs)) throw Error(jobs && jobs.reason || 'fact_recovery_failed')
    for (const job of jobs) {
      const source = await window.pet.characterHistorySource(job.sourceRefs[0])
      if (!source || source.ts !== job.input.ts || source.text !== job.input.userText) continue
      const permit = roleRuntime.restoreFacts(source, job.expiresAt)
      if (!permit) continue
      try {
        const result = await window.PetLife.recordTurn({ ...job.input, metadataOnly: true, runtimeFactExecution: permit })
        if (!result || !result.ok) console.warn('[platform] incomplete recovery:', result && result.reason)
      } finally { roleRuntime.completeFacts(permit) }
    }
  }
  // Wait for all renderer scripts and their storage initialization, without making a model call.
  window.addEventListener('load', () => { void recoverPlatformFacts().catch(e => console.warn('[platform]', e.message)) })
  if (lifeCapabilities) lifeCapabilities.register({ id: 'life.virtual-project', provider: 'builtin.virtual-notebook', version: '1', effect: 'virtual', timeoutMs: 5000,
    output: window.CharacterCapabilities.SCHEMAS.project,
    input: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', maxLength: 140 } }, additionalProperties: false } },
    async (input, host) => platformBridge.projectStep(input.projectId, host.operationId))
  window.pet.onCharacterHistoryInvalidated(() => roleRuntime.invalidateFacts('history_cleared'))
  window.addEventListener('beforeunload', () => roleRuntime.shutdown())
  async function decideCharacterEvent(event, state, execution) {
    if (event.origin === 'user') return { action: 'reply' }
    if (event.origin === 'user-feedback') return { action: event.kind }
    if (R.hidden || R.busy || chatBusy || charcBusy || pendingInter || Date.now() < state.quietUntil) return { action: 'wait', reason: 'not_available' }
    if (event.origin !== 'system' && Date.now() - state.lastAutomatic < 10 * 60000) return { action: 'wait', reason: 'runtime_interval' }
    if (event.kind !== 'opportunity') return { action: event.kind }
    const focused = document.activeElement
    const typing = focused && ['mini-chat-input', 'charc-input', 'chat-input'].includes(focused.id) && String(focused.value || '').trim()
    if (typing || game && game.playing || bubbleEl.dataset.remind || bubbleEl.dataset.report || bubbleEl.dataset.inter) return { action: 'wait', reason: 'surface_busy' }
    const input = runtimeLifeInput()
    const flags = event.constraints || {}
    const proactiveAllowed = !Pace.blocked() && flags.switchEnabled !== false && flags.quietHours !== true && flags.ownerBusy !== true && flags.politenessDefer !== true &&
      flags.noCredit !== true && flags.intervalOk !== false && flags.familyRecent !== true
    if (platformBridge && window.PlatformCandidate && window.PlatformCandidate.enabled) {
      const projection = await platformBridge.projection()
      execution.assertCurrent()
      window.PlatformContext = projection
      const proposals = []
      for (const concern of projection.concerns || []) if (concern.nextCheckAt <= Date.now()) proposals.push({ id: concern.id, kind: 'concern', text: concern.quote,
        topic: concern.key, sourceRefs: concern.sourceRefs, expiresAt: concern.expiresAt, priority: 2 })
      for (const project of projection.projects || []) proposals.push({ id: project.id, kind: 'project', text: project.quote, sourceRefs: project.sourceRefs,
        capabilityId: 'life.virtual-project', expiresAt: project.expiresAt, priority: 1, step: project.step })
      proposals.push({ id: 'existing-life', kind: 'life', priority: 0, expiresAt: Date.now() + 30000 })
      if (event.observation && event.observation.text) proposals.push({ id: 'observation', kind: 'life', text: event.observation.text, priority: 0, expiresAt: Date.now() + 30000 })
      const chosen = await platformBridge.select(proposals, { busy: !proactiveAllowed, hidden: R.hidden, quietUntil: state.quietUntil,
        capabilities: lifeCapabilities.available() })
      execution.assertCurrent()
      if (!chosen.selected) return { action: 'wait', reason: chosen.reason || 'no_opportunity' }
      if (chosen.selected.kind === 'project') return { action: 'project-step', project: chosen.selected }
      if (chosen.selected.kind === 'concern') event.concern = chosen.selected
    }
    if (proactiveOn && proactiveAllowed && window.PetLife && window.PetLife.snapshot().ready) {
      const context = proactiveTopicContext(), full = window.CharacterSnapshot.toCharacterAIContext('')
      Object.assign(context, { selfState: full.selfState, runtimeFacts: full.runtimeFacts, petLife: full.petLife })
      if (window.PlatformCandidate && window.PlatformCandidate.enabled) context.recentInteractions = await window.pet.characterHistoryLoad()
      if (window.PlatformContext) Object.assign(context, { platform: window.PlatformContext, capabilities: lifeCapabilities ? lifeCapabilities.available() : [] })
      if (platformBridge && window.PlatformCandidate && window.PlatformCandidate.enabled) {
        const catalog = await platformBridge.capabilities()
        context.capabilities = [...new Map([...(context.capabilities || []), ...(catalog.capabilities || [])].map(c => [c.id, c])).values()]
      }
      let candidates = window.PetLife.candidates({ nowTs: Date.now(), memories: window.MemoryRetrieval ? window.MemoryRetrieval.retrieve({}, { limit: 8 }) : [],
        allMemories: window.MemoryEngine ? window.MemoryEngine.getMemories() : [], history: chatHistoryCache, reality: context.reality, events: full.recentEvents })
      const concernBindings = {}
      if (platformBridge && window.PlatformCandidate && window.PlatformCandidate.enabled && candidates.length) {
        for (const candidate of candidates) {
          const concern = (window.PlatformContext.concerns || []).find(c => c.sourceRefs.includes(candidate.messageRef))
          if (concern) concernBindings[candidate.id] = concern.id
        }
        const ranked = await platformBridge.select(candidates.map(c => ({ id: c.id, text: c.text, topic: c.text,
          sourceRefs: c.sourceKeys || [], priority: concernBindings[c.id] ? 2 : c.fresh ? 1 : 0, expiresAt: Date.now() + 30000 })),
          { busy: !proactiveAllowed, hidden: R.hidden, quietUntil: state.quietUntil, capabilities: context.capabilities || [] })
        execution.assertCurrent()
        window.LastOpportunitySelection = { ranked: ranked.ranked || [], excluded: ranked.excluded || [], reason: ranked.reason || null }
        candidates = (ranked.ranked || []).map(row => candidates.find(c => c.id === row.id)).filter(Boolean)
      }
      const decision = await window.Gen2.proactiveDecide({ context, candidates, recentOpenings: proactiveOpeningLog.slice() }, execution)
      execution.assertCurrent()
      if (decision.ok && !decision.silent) return { action: 'express', decision, concernBindings }
      if (!decision.ok) return { action: 'none', ok: false, reason: decision.reason }
    }
    const proposal = window.PetLife && window.PetLife.proposeActivity(input)
    return proposal ? { action: 'start-life', input, proposal } : { action: 'wait', reason: 'no_opportunity' }
  }
  function runtimeLifeInput() {
    const c = window.CharacterSnapshot.toCharacterAIContext('')
    return { nowTs: Date.now(), selfState: c.selfState, emotion: c.emotion, persona: c.personaProjection,
      busy: !!(R.busy || chatBusy || charcBusy || (game && game.playing)), visible: !R.hidden,
      availableActions: R.hidden ? [] : Object.keys(window.LivingPresence.ACTIONS).filter(id => !!$('anim-' + id) && !failedAnimations.has(id)),
      aiEnabled: false, memories: window.MemoryEngine ? window.MemoryEngine.getMemories() : [] }
  }
  function runtimeNotify(render, key, origin = 'automatic') {
    return roleRuntime.submit({ kind: 'local-expression', origin, coalesceKey: key }, execution => {
      return execution.publish(() => render(execution))
    })
  }
  function runtimeOpportunity(observation) {
    return roleRuntime.submit({ kind: 'opportunity', origin: 'automatic', coalesceKey: 'life-opportunity', observation, constraints: observation && observation.proactive && observation.proactive.suppressors }, async (execution, decision) => {
      if (decision.action === 'project-step') {
        const result = await execution.commit(() => lifeCapabilities.execute({ id: 'project-step:' + decision.project.id + ':' + decision.project.step,
          capabilityId: 'life.virtual-project', effect: 'virtual', input: { projectId: decision.project.id }, sourceRefs: decision.project.sourceRefs,
          deadline: Date.now() + 30000 }, execution))
        if (result && result.ok) await platformBridge.presented(decision.project.id)
        return result
      }
      if (decision.action === 'start-life') {
        const result = await execution.commit(() => lifeCapabilities ? lifeCapabilities.execute({ id: 'activity:' + execution.executionId,
          capabilityId: 'life.virtual-activity', effect: 'virtual', input: { proposal: decision.proposal, input: { nowTs: decision.input.nowTs } },
          sourceRefs: decision.proposal.activity.refs || [], deadline: Date.now() + 30000 }, execution)
          : window.PetLife.startActivity(decision.proposal, decision.input, execution))
        if (!result || !result.ok) return result
        execution.assertCurrent(); armIdleChain(); return result
      }
      const topic = await window.Gen2.proactiveSay(decision.decision, execution)
      execution.assertCurrent()
      if (!topic || !topic.ok || topic.silent) return topic
      if (!window.PetLife.canPresentDecision(topic, Date.now())) return { ok: false, reason: 'topic_no_longer_available' }
      const id = execution.executionId
      const presented = await proactiveShowCard(topic.opening, id, execution)
      if (!presented || !presented.ok) return presented || { ok: false, reason: 'presentation_failed' }
      execution.assertCurrent()
      Pace.onAssistant()
      const contact = await execution.commit(() => window.PetLife.presented({ candidateId: topic.candidateId, instanceId: id, topic: topic.topic,
        sourceKeys: topic.sourceKeys, opening: topic.opening, form: topic.form, ts: Date.now(), runtimeExecution: execution }))
        .catch(error => ({ ok: false, reason: error.message }))
      if (platformBridge && window.PlatformCandidate && window.PlatformCandidate.enabled) await platformBridge.presented(decision.concernBindings && decision.concernBindings[topic.candidateId] || topic.candidateId)
      const chosenActionId = { share: 'comment_on_activity', question: 'seek_attention', invite: 'seek_attention', accompany: 'accompany_owner', celebrate: 'celebrate' }[topic.form]
      const bookkeeping = await proactiveReport({ type: 'present', id, presented: true, nowTs: Date.now(), opening: topic.opening,
        topic: topic.topic, topicSource: 'ai', decision: { outcome: 'act', chosenActionId },
        suppressors: observation && observation.proactive && observation.proactive.suppressors || {} })
      // Actual presentation remains an observed fact even if the later ledger write fails.
      return { ok: true, displayed: 'card', bookkeepingOk: !!(contact && contact.ok !== false && bookkeeping && bookkeeping.ok),
        contactReason: contact && contact.reason, ledgerReason: bookkeeping && bookkeeping.reason }
    })
  }
  function submitOwnerReply(text, execute) {
    if (!text) return Promise.resolve({ ok: false, reason: 'empty_input' })
    if (presentationPlans) presentationPlans.cancel(null, 'owner_input')
    const frame = window.ConversationPolicy.analyzeTurn({ userText: text, now: Date.now() })
    roleRuntime.setQuietUntil(frame.quietUntil || 0)
    const status = roleRuntime.snapshot()
    const previous = !status.current && !status.queued.length && characterRetryTurn && characterRetryTurn.text === text && characterRetryTurn.userSaved
      ? { ...characterRetryTurn } : null
    const messageRef = previous && previous.messageRef || window.MemoryMessageRef.next()
    // User input is an observed fact, independent of whether a reply is later cancelled.
    const accepted = previous ? Promise.resolve({ ok: true }) : Promise.resolve(window.pet.characterHistoryAppend({ role: 'user', text, messageRef })).catch(error => ({ ok: false, error: error.message }))
    latestCharacterTurnRef = messageRef
    const inputId = previous ? messageRef + ':retry:' + window.MemoryMessageRef.next() : messageRef
    return roleRuntime.submit({ kind: 'reply', origin: 'user', id: inputId, messageRef, text }, async execution => {
      const inputSaved = await accepted
      if (!inputSaved || !inputSaved.ok) return { ok: false, reason: 'history_write_failed' }
      execution.assertCurrent()
      characterRetryTurn = { text, userSaved: true, messageRef, executionId: execution.executionId, reply: previous && previous.reply || null }
      refreshCharacterHistoryViews()
      if (!previous) diaryEvent('chat', text, { source: 'char-chat' })
      const saved = await execution.commit(() => window.PetLife.commitRuntimePolicy(frame, execution))
      if (!saved || !saved.ok) return saved
      execution.assertCurrent()
      return execute(execution)
    })
  }
  function systemNotice(text, ms) {
    const toast = $('panel-toast')
    toast.textContent = String(text); toast.classList.remove('hidden')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.add('hidden'), ms || 6000)
    return { ok: true, displayed: 'system' }
  }
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b)
  let uid = 0
  let __diaryTLCache = null
  let __diaryTLJob = null
  // 工作区路径：主进程提供（环境变量 DSH_WORKSPACE 可覆盖，默认用户主目录 dsh-workspace）
  let WORKSPACE = ''

  // 固定人设与聊天规则统一在主进程 main.js（CHAT_PERSONA/CHAT_RULES）——
  // 日常聊天会话由主进程 ensureChatSession 创建并植入，渲染层不再重复维护。
  // 固定人设下的随机台词（按状态分组）
  const LINES = window.LivingPresence.DEFAULT_LINES
  const livingPresence = window.LivingPresence.createSession()
  const livingSessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)


  // 道具分类（商店按此分组展示）
  const ITEM_CATEGORIES = [
    { key: 'meal', name: '🍽️ 餐点', icon: '🍽️' },
    { key: 'drink', name: '🥤 饮品', icon: '🥤' },
    { key: 'gift', name: '💝 心意礼物', icon: '💝' },
    { key: 'fun', name: '🎲 娱乐', icon: '🎲' },
  ]
  // 道具：category 分类；effect 里 affection = 加好感度（礼物类专属，定价远高于普通道具）
  const ITEMS = window.NurtureRules.ITEMS

  let activeGame = 'catch'

  /* 等级称号表（按累计经验） */
  const LEVELS = window.NurtureRules.LEVELS
  /* 成就定义 */
  const ACHIEVEMENTS = window.NurtureRules.ACHIEVEMENTS

  /* ---------- 相册照片定义（照片 = 成就式解锁，用户提供图片 renderer/photos/<id>.png） ---------- */
  // 农历节日判定（lunar-javascript：Solar → Lunar；库缺失时降级为 false，不误判）
  function isLunarFestival(lMonth, lDay) {
    try {
      if (!window.Solar) return false
      const now = new Date()
      const l = window.Solar.fromYmd(now.getFullYear(), now.getMonth() + 1, now.getDate()).getLunar()
      return l.getMonth() === lMonth && l.getDay() === lDay
    } catch (err) { return false }
  }
  // 解锁两类：
  //  - 事件型：代码里 unlockPhoto('id') 主动调用（首次启动/喂食/游戏/清洁等）
  //  - 数值型：checkPhotoUnlocks() 扫描 check(p)（累计次数/时长/金币等）
  const PHOTOS = window.NurtureRules.photoDefinitions({ getName: petName, getAway: () => R.awayDaysAway, Solar: window.Solar })
  const stateDefaults = {
    coins: 20,
    name: '小深',
    summarySessionId: '',
    stats: { satiety: 85, mood: 85, energy: 85, thirst: 85 },
    inventory: { cookie: 3, drink: 0, toy: 0, feast: 0 },
    lastTick: Date.now(),
    totalWorkDone: 0,
    totalGames: 0,
    bestGameScore: 0,
    pomodoros: 0,
    // 照片补发存档：曾播放过的动画/赢过的游戏/首次操作等（供 check 型照片补发旧版达成条件）
    animSeen: [], // 曾播放过的动画名列表（如 ['idle-bubbles', 'eat-caught']）
    gameWins: [], // 曾赢过的游戏列表（如 ['gomoku', 'guess', 'sudoku', 'mines', 't2048', 'snake']）
    todos: [],
    schedule: [],
    firedClasses: [],
    hydrateEnabled: true,
    lastHydrate: 0,
    waterToday: 0,
    waterDay: '',
    semesterStart: '',
    ownerName: '',
    ownerBirthday: '',
    lastBirthdayGreeted: '',
    lastPetBirthdayGreeted: '',
    birthdayCards: [], // 历年生日贺卡存档 [{ date, theme, salute, body, sign, aff, affTier }]
    lastExitTime: 0, // 上次退出时间（主进程 before-quit 写入），久别重逢判断用
    lastReunionDate: '', // 上次弹「久别重逢」气泡的日期（每天一次）
    workLog: [], // 工作日志 [{ date, id, name, coins, minutes, ts }]
    workMinutes: 0, // 累计工作分钟数（成就用）
    workSessions: 0, // 累计完成工作次数（含提前结束）
    memories: [], // 长期记忆（纯净版日记系统：写日记时抽取的高价值事实）[{ content, importance, date }]
    lorebook: [], // 视听说 B·感知世界书（台词素材）[{ trigger:{kind,value}, reaction:{says:[...]}, source:'persona'|'learned' }]（P4：节流改由 Detector 声明）
    // 视听说 B·感知（P1）：配置与运行状态分离（§五）
    perceptionConfig: { enabled: false, intervalMs: 30000, confidenceMin: 0.5 },
    // 视听说 B·感知（M2/H）：状态信封 schemaVersion 2（shared / vision / hearing），旧 v1 由 ensureState 迁移
    perceptionState: {
      schemaVersion: 2,
      shared: { lastSaidAt: {}, lastReactionAt: 0, mergeUntil: {}, lastReactionId: '' },
      vision: { lastApp: '', lastCat: '', catSince: 0, catAccum: {}, catDays: {}, lastSeenTs: 0, firedForDwell: {}, firedToday: {}, firedForPref: {} },
      hearing: { lastApp: '', lastTrackHash: '', lastArtistHash: '', playState: 'Closed', trackSince: 0, pausedSince: 0, artistDays: {}, trackRepeats: {}, firedFor: {} },
    },
    soundEnabled: true,
    soundEvents: { report: true, achievement: true, chat: true, proactive: true, reminder: true, ui: true },
    soundVolume: 80,
    hydrateIntervalMin: 45,
    personality: 'gentle',
    uiScale: 1, // 托盘调节：UI（气泡/动作条/迷你聊天/面板）缩放
    petScale: 1, // 托盘调节：桌宠角色缩放
    // 养成 A：好感度（聊天/喂食/游戏/工作累积，解锁台词与彩蛋）
    affection: 0,
    // 3.0-05 EmotionEngine 专属当前情绪状态（由引擎管理，勿直接改）
    emotion: null,
    // 养成 B：每日任务 + 签到
    daily: { date: '', tasks: [], signStreak: 0, lastSign: '' },
    // 台词池：自定义台词 + 禁用组（托盘/设置页管理）
    customLines: [],
    disabledGroups: [],
    // 歌词全量覆盖表：{ group: [文案...] } —— 存在即完全覆盖官方（官方预设也可编辑/删除）；
    // 不存在则用官方默认。迁移自 customLines/disabledGroups。
    lines: {},
    exp: 0,
    level: 1,
    achievements: [],
    photos: {}, // 相册已解锁照片 { id: { ts: 时间戳 } }
    bootCount: 0, // 启动次数（0=首次启动，用于"初次见面"）
    streak: 0,
    lastSeenDate: '',
    lastInteractionAt: 0, // 最近互动时间戳（聊天/点击/喂食/游戏/工作，用于"想你了"判定）
    feedCount: 0,
    memos: [],
    diary: [],
    diaryOutputs: [],
    // A5：DiaryEngine AI 日记每日配额持久化（{ [DiaryDay]: count }）
    diaryAiRequestsByDay: {},
    diaryTime: '23:00',
    daySnapshot: null,
  }

  const kernelState = window.pet.character?.authority ? window.PetState.projection(stateDefaults) : null
  const P = kernelState ? kernelState.state : stateDefaults
  const PetStateApi = window.PetState.create(P)
  window.PetStateApi = PetStateApi // 3.0 Context 只读读取入口

  /* ---------- runtime state ---------- */
  const R = {
    sessions: [],
    currentId: null,
    running: false,
    busy: false,
    dragging: false,
    chatOpen: false,
    hidden: false,
    mood: 'idle',
    activeTab: 'chat',
    chatView: 'chat',
    visibleSessions: null,
    visKey: '',
    /* 本次启动距上次启动的天数（在 loadState 覆盖 lastSeenDate 之前算好）。
       照片 miss-you 的 A 分支要用它 —— 详见该规则与 loadState 里的注释。 */
    awayDaysAway: 0,
    lastSentAt: 0,
    sleepy: false,
    writingDiary: false,
    diarySuppressed: '', // "今天"被删/忘掉后标记：当天不再自动补写（手动仍可写）
    interExpanded: false,
    remindExpanded: false,
    chatSessionId: null,
    workId: null, // 当前挂机工作 id（null = 未工作）
    workStart: 0, // 工作开始时间戳
    workEnd: 0, // 工作结束时间戳
  }

  let prevRunning = false
  const settledWorkRuns = new Set() // 工作结算幂等：同一 workRun 只结算一次
  let sessionsKey = ''
  let pendingReport = null
  let bubbleTimer = null
  let moodTimer = null
  let zzzTimer = null
  let busyTimeout = null
  let workUiTimer = null

  const stage = $('stage')
  const petEl = $('pet')
  const petArea = $('pet-area')
  const panel = $('panel')
  const bubbleEl = $('bubble')
  const heartsWrap = $('hearts')
  const miniEl = $('mini')
  const ta = $('chat-input')
  const sel = $('session-select')
  const btnSend = $('btn-send')
  const canvas = $('game-canvas')
  const ctx2d = canvas.getContext('2d')

  /* ---------- persistence ---------- */

  let stateWritable = true
  async function loadState() {
    if (window.pet.character?.authority) {
      for (let attempt = 0; attempt < 150; attempt++) {
        const projection = await window.pet.character.read()
        if (projection?.ok) { applyKernelProjection(projection); return }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error('Kernel 状态尚未就绪，已保留原数据。')
    }
    let savedRelationship = null
    try {
      let loaded
      try { loaded = window.pet.stateRead ? await window.pet.stateRead() : null }
      catch (error) { stateWritable = false; throw error }
      if (loaded && loaded.ok === false && ['corrupt', 'io_error'].includes(loaded.status)) {
        stateWritable = false
        throw new Error('原有状态未能恢复，已保留文件；本次不会用默认状态覆盖。')
      }
      let saved = loaded && loaded.ok ? loaded.state : await window.pet.stateLoad()
      if (loaded && (loaded.recovery || loaded.status === 'recovered')) {
        setTimeout(() => systemNotice('上次的状态文件未能读取，已从备份恢复。最近的部分变化可能未保留，原文件已留存。', 12000, 'ui'), 2000)
      }
      if (window.StateStore && saved && typeof saved === 'object') saved = window.StateStore.migrate(saved)
      if (saved && typeof saved === 'object') {
        if (saved.stats && typeof saved.stats === 'object') P.stats = Object.assign({}, P.stats, saved.stats)
        if (typeof saved.coins === 'number') P.coins = saved.coins
        if (typeof saved.name === 'string' && saved.name.trim()) P.name = saved.name.trim()
        if (typeof saved.summarySessionId === 'string') P.summarySessionId = saved.summarySessionId
        if (saved.inventory && typeof saved.inventory === 'object') P.inventory = Object.assign({}, P.inventory, saved.inventory)
        if (typeof saved.totalWorkDone === 'number') P.totalWorkDone = saved.totalWorkDone
        if (typeof saved.totalGames === 'number') P.totalGames = saved.totalGames
        /* S3/ F7C 订正：presenceBudget 已按 F7C 冻结裁定「退役、不移交」
           ——此处读回只是让历史键在 pet-state.json 里**原样往返（不删不迁）**：它不进引擎、不被写新值、
           不构成任何主动联系资格或计数依据（recovery/P3-life-context-F7C-施工单-v1 §A.3）。 */
        if (saved.presenceBudget && typeof saved.presenceBudget === 'object') P.presenceBudget = saved.presenceBudget
        if (typeof saved.bestGameScore === 'number') P.bestGameScore = saved.bestGameScore
        if (typeof saved.totalGames === 'number') P.totalGames = saved.totalGames
        if (typeof saved.pomodoros === 'number') P.pomodoros = saved.pomodoros
        if (Array.isArray(saved.todos)) {
          P.todos = saved.todos
            .filter((t) => t && typeof t.text === 'string')
            .map((t) => ({ id: t.id, text: t.text, done: !!t.done }))
        }
        if (Array.isArray(saved.schedule)) {
          P.schedule = saved.schedule
            .filter((c) => c && typeof c.name === 'string' && typeof c.time === 'string')
            .map((c) => ({
              id: c.id,
              name: c.name,
              day: Number(c.day) || 1,
              time: c.time,
              weeks: c.weeks === 'odd' || c.weeks === 'even' ? c.weeks : 'all',
              remind: Number(c.remind) || 0,
            }))
        }
        if (Array.isArray(saved.firedClasses)) P.firedClasses = saved.firedClasses.slice(-200)
        if (typeof saved.hydrateEnabled === 'boolean') P.hydrateEnabled = saved.hydrateEnabled
        if (typeof saved.lastHydrate === 'number') P.lastHydrate = saved.lastHydrate
        if (typeof saved.waterToday === 'number') P.waterToday = saved.waterToday
        if (typeof saved.waterDay === 'string') P.waterDay = saved.waterDay
        if (typeof saved.semesterStart === 'string') P.semesterStart = saved.semesterStart
        if (typeof saved.ownerName === 'string') P.ownerName = saved.ownerName
        if (typeof saved.ownerBirthday === 'string') P.ownerBirthday = saved.ownerBirthday
        if (typeof saved.lastBirthdayGreeted === 'string') P.lastBirthdayGreeted = saved.lastBirthdayGreeted
        if (typeof saved.lastPetBirthdayGreeted === 'string') P.lastPetBirthdayGreeted = saved.lastPetBirthdayGreeted
        if (Array.isArray(saved.birthdayCards)) P.birthdayCards = saved.birthdayCards
          .filter((c) => c && typeof c.date === 'string' && typeof c.body === 'string')
          .slice(-60) // 最多保留 60 张，防止无限增长
        if (typeof saved.lastExitTime === 'number') P.lastExitTime = saved.lastExitTime
        if (typeof saved.lastReunionDate === 'string') P.lastReunionDate = saved.lastReunionDate
        if (Array.isArray(saved.workLog)) P.workLog = saved.workLog.filter((w) => w && typeof w.id === 'string').slice(-50)
        if (typeof saved.workMinutes === 'number') P.workMinutes = saved.workMinutes
        if (typeof saved.workSessions === 'number') P.workSessions = saved.workSessions
        if (typeof saved.soundEnabled === 'boolean') P.soundEnabled = saved.soundEnabled
        if (saved.soundEvents && typeof saved.soundEvents === 'object') P.soundEvents = Object.assign({}, P.soundEvents, saved.soundEvents)
        if (typeof saved.soundVolume === 'number') P.soundVolume = clamp(saved.soundVolume, 0, 100)
        if (typeof saved.hydrateIntervalMin === 'number') P.hydrateIntervalMin = clamp(saved.hydrateIntervalMin, 15, 240)
        if (typeof saved.uiScale === 'number') P.uiScale = clamp(saved.uiScale, 0.6, 1.8)
        if (typeof saved.petScale === 'number') P.petScale = clamp(saved.petScale, 0.5, 2)
        if (typeof saved.affection === 'number') P.affection = clamp(saved.affection, 0, 100)
        if (saved.relationship && typeof saved.relationship === 'object') savedRelationship = saved.relationship
        if (saved.emotion && typeof saved.emotion === 'object') P.emotion = saved.emotion
        if (saved.daily && typeof saved.daily === 'object') {
          if (Array.isArray(saved.daily.tasks)) P.daily.tasks = saved.daily.tasks
          if (typeof saved.daily.date === 'string') P.daily.date = saved.daily.date
          if (typeof saved.daily.signStreak === 'number') P.daily.signStreak = saved.daily.signStreak
          if (typeof saved.daily.lastSign === 'string') P.daily.lastSign = saved.daily.lastSign
        }
        if (Array.isArray(saved.customLines)) P.customLines = saved.customLines.filter((l) => l && typeof l.text === 'string' && typeof l.group === 'string')
        if (Array.isArray(saved.disabledGroups)) P.disabledGroups = saved.disabledGroups.filter((g) => typeof g === 'string')
        if (saved.lines && typeof saved.lines === 'object') {
          // 加载用户完整台词覆盖表
          const lines = {}
          for (const [k, v] of Object.entries(saved.lines)) {
            if (Array.isArray(v)) lines[k] = v.filter((x) => typeof x === 'string')
          }
          P.lines = lines
        } else if (P.customLines.length || P.disabledGroups.length) {
          // 迁移旧版（customLines/disabledGroups）→ lines：合并官方+自定义，按禁用组删除
          const merged = {}
          for (const [key, official] of Object.entries(LINES)) {
            if (!Array.isArray(official)) continue
            if (P.disabledGroups.indexOf(key) >= 0) continue
            const customs = P.customLines.filter((l) => l.group === key).map((l) => l.text)
            merged[key] = official.concat(customs)
          }
          if (Object.keys(merged).length) P.lines = merged
        }
        if (typeof saved.exp === 'number') P.exp = saved.exp
        if (typeof saved.level === 'number') P.level = saved.level
        if (typeof saved.personality === 'string') P.personality = saved.personality
        if (Array.isArray(saved.achievements)) P.achievements = saved.achievements.filter((x) => typeof x === 'string')
        if (Array.isArray(saved.animSeen)) P.animSeen = saved.animSeen.filter((x) => typeof x === 'string')
        if (Array.isArray(saved.gameWins)) P.gameWins = saved.gameWins.filter((x) => typeof x === 'string')
        if (saved.photos && typeof saved.photos === 'object') {
          const p = {}
          for (const [k, v] of Object.entries(saved.photos)) {
            if (v && typeof v.ts === 'number') p[k] = { ts: v.ts }
          }
          P.photos = p
        }
        if (typeof saved.streak === 'number') P.streak = saved.streak
        if (typeof saved.bootCount === 'number') P.bootCount = saved.bootCount
        if (typeof saved.lastSeenDate === 'string') P.lastSeenDate = saved.lastSeenDate
        if (typeof saved.lastInteractionAt === 'number') P.lastInteractionAt = saved.lastInteractionAt
        if (typeof saved.feedCount === 'number') P.feedCount = saved.feedCount
        if (Array.isArray(saved.memos)) P.memos = saved.memos.filter((m) => m && typeof m.text === 'string')
        if (Array.isArray(saved.memories)) P.memories = saved.memories.filter((m) => m && typeof m.content === 'string').slice(-30)
        // 视听说 B·感知世界书（§8.3：上限 200；persona 条目在写入侧永不淘汰）
        if (Array.isArray(saved.lorebook)) {
          P.lorebook = saved.lorebook
            .filter((e) => e && e.trigger && typeof e.trigger.kind === 'string' && typeof e.trigger.value === 'string')
            .slice(-200)
        }
        if (typeof saved.perceptionEnabled === 'boolean' && !saved.perceptionConfig) P.perceptionConfig.enabled = saved.perceptionEnabled // 旧字段迁移
        if (saved.perceptionConfig && typeof saved.perceptionConfig === 'object') P.perceptionConfig = Object.assign({}, P.perceptionConfig, saved.perceptionConfig)
        if (saved.perceptionState && typeof saved.perceptionState === 'object') P.perceptionState = saved.perceptionState
        if (Array.isArray(saved.diary)) P.diary = saved.diary.filter((d) => d && typeof d.date === 'string' && typeof d.text === 'string')
        if (Array.isArray(saved.diaryOutputs)) P.diaryOutputs = saved.diaryOutputs
        if (typeof saved.diaryTime === 'string' && /^\d{2}:\d{2}$/.test(saved.diaryTime)) P.diaryTime = saved.diaryTime
        if (saved.diaryAiRequestsByDay && typeof saved.diaryAiRequestsByDay === 'object') {
          P.diaryAiRequestsByDay = sanitizeDiaryAiRequestsByDay(saved.diaryAiRequestsByDay, Date.now())
        } else {
          P.diaryAiRequestsByDay = {}
        }
        if (typeof saved.diarySuppressed === 'string') P.diarySuppressed = saved.diarySuppressed
        if (saved.daySnapshot && typeof saved.daySnapshot.date === 'string') P.daySnapshot = saved.daySnapshot
        if (typeof saved.lastTick === 'number') applyDecay(saved.lastTick)
        /* 在 updateStreak 覆盖 lastSeenDate **之前**，先算出"离开了几天"。
           用途：照片 miss-you 的 A 分支（≥3 天没开桌宠）—— 它以前恒为假，因为
           checkPhotoUnlocks() 开头就先 updateStreak() 把 lastSeenDate 写成今天。 */
        try {
          if (saved.lastSeenDate && /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(saved.lastSeenDate))) {
            const [yy, mo, dd] = String(saved.lastSeenDate).split('-').map(Number)
            const d = new Date(yy, mo - 1, dd)
            if (!isNaN(d.getTime())) {
              R.awayDaysAway = Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000))
            }
          }
        } catch (err) { /* 非致命：拿不到就当 0 */ }
        // uid 从已有数据恢复：防止重启后新添加项 id 从 1 重新计数（与旧项冲突导致删除误删）
        const maxId = Math.max(0,
          ...(P.todos || []).map((t) => t.id || 0),
          ...(P.schedule || []).map((c) => c.id || 0),
          ...(P.memos || []).map((m) => m.id || 0),
        )
        if (maxId >= uid) uid = maxId + 1
      }
    } catch (err) {
      console.log('state load failed', err && err.message)
      if (!stateWritable) setTimeout(() => systemNotice('状态文件暂时无法恢复，原文件已保留。本次修改不会保存，请查看恢复记录。', 15000, 'ui'), 1500)
    }
    if (window.RelationshipEngine) window.RelationshipEngine.init(P, savedRelationship)
    try {
      if (window.MemoryEngine && window.pet.memoryLoad) await window.MemoryEngine.init(P.memories || [])
    } catch (err) { /* MemoryStore failure must not block core runtime */ }
    try {
      if (window.pet && typeof window.pet.onBeforeQuitFlush === 'function' && typeof window.pet.beforeQuitFlushDone === 'function') {
        window.pet.onBeforeQuitFlush(async () => {
          try {
            const pending = []
            if (window.MemoryEngine && typeof window.MemoryEngine.flushAndWait === 'function') pending.push(window.MemoryEngine.flushAndWait(2500))
            else if (window.MemoryEngine && typeof window.MemoryEngine.flushPersistence === 'function') pending.push(window.MemoryEngine.flushPersistence())
            if (window.PetLife) pending.push(window.PetLife.flush())
            await Promise.allSettled(pending)
          } catch (err) { /* ignore */ }
          try { window.pet.beforeQuitFlushDone() } catch (err) { /* ignore */ }
        })
      }
    } catch (err) { /* ignore */ }
    if (window.EmotionEngine) window.EmotionEngine.init(P)
    if (window.IntentEngine) window.IntentEngine.init()
    /* S3：恢复主动存在感的预算（每日上限 / 冷却必须**跨重启**成立，
       否则用户重启几次就能绕过 dailyCap）。恢复失败按"今天还没开口"处理，不阻塞启动。 */
    if (window.DialogueEngine) {
      window.DialogueEngine.init({
        lines: P.lines || {},
        customLines: P.customLines || [],
        disabledGroups: P.disabledGroups || []
      })
    }
    if (window.DiaryEngine) {
      window.DiaryEngine.init({
        aiEnabled: true,
        outputs: Array.isArray(P.diaryOutputs) ? P.diaryOutputs : [],
        aiRequestsByDay: P.diaryAiRequestsByDay || {},
        now: Date.now(),
        diaryTime: P.diaryTime || '23:00',
        save: saveDiaryOutput,
        // A5：count 已 +1 后持久化；saveState 失败不回退内存计数。
        onAiRequestConsumed: (day, count) => {
          if (!P.diaryAiRequestsByDay || typeof P.diaryAiRequestsByDay !== 'object') P.diaryAiRequestsByDay = {}
          P.diaryAiRequestsByDay[day] = count
          try {
            const p = saveState()
            if (p && typeof p.catch === 'function') {
              p.catch((err) => console.warn('[diary-quota] persist failed (in-memory count kept):', day, count, err && err.message))
            }
          } catch (err) {
            console.warn('[diary-quota] persist failed (in-memory count kept):', day, count, err && err.message)
          }
        }
      })
    }
    if (window.EventBus && !window.__diaryUiBound) {
      window.__diaryUiBound = true
      window.EventBus.on('diary:output-created', () => {
        try { renderDiary() } catch (err) { /* ignore */ }
      })
    }
    saveState()
    renderCare()
    updateCoins()
    updateStreak()
    ensureDaySnapshot()
    renderMemos()
    renderDiary()
    initDiaryState()
    migratePhotoHistory()
    // 面板已开但人物没缩小（自启向导/恢复窗口状态等路径）→ 补一次适配
    if (stage.classList.contains('dp-open')) refitCurrentAnim()
  }

  // 照片历史迁移（旧版本 → 新版本）：animSeen/gameWins 是新增字段，
  // 旧档为空时用可推断的历史数据填充，让"曾达成过"的条件能补发照片
  function migratePhotoHistory() {
    if (P.animSeen && P.animSeen.length) return // 已迁移过
    // 从旧字段推断：玩过游戏（totalGames）→ 标记常见游戏胜利类
    if ((P.totalGames || 0) > 0) {
      // 无法区分具体哪种游戏胜利，标记"玩过"的通用胜利（保守：只标记猜数字/扫雷这种常玩的）
      // 更保守：不推断胜利，仅当 totalGames >= 5 标记"游戏体验"（victory-10 已由 totalGames 覆盖）
    }
    // 写过的备忘录/日程 → 照片已按 memo/schedule 长度 check，无需 animSeen
    // 动画类历史无法推断（旧版无记录），从"已解锁的照片"反向同步 animSeen（可信但冗余）
    const animOfPhoto = {
      'bubble-time': 'idle-bubbles', 'mirror-look': 'idle-mirror', 'hum-moment': 'idle-hum',
      'fan-breeze': 'idle-fan', 'stretch-time': 'idle-stretch', 'tickle-battle': 'click-tickle',
      'tsundere-moment': 'click-tsundere', 'caught-eating': 'eat-caught',
    }
    const seen = []
    for (const [photoId, animName] of Object.entries(animOfPhoto)) {
      if (P.photos && P.photos[photoId] && P.animSeen.indexOf(animName) < 0) seen.push(animName)
    }
    // 小厨师：进食动画（已解锁 little-chef 说明播过）
    if (P.photos && P.photos['little-chef'] && P.animSeen.indexOf('eat-rice') < 0) seen.push('eat-rice')
    if (seen.length) {
      P.animSeen = (P.animSeen || []).concat(seen)
      saveState()
    }
    // 游戏胜利：无法回溯具体游戏，保持 gameWins 空（等新结算标记）；如需补发可后续扩展
  }

  // 照片记录灾后恢复（血泪教训 ）：升级时旧版实例（不认识 photos 字段）
  // 保存状态会把照片解锁记录/animSeen/gameWins 等整个抹掉。旧版认识的统计数据
  // （totalGames/workMinutes/feedCount/streak/coins/level/affection 等）仍然完好，
  // 这里按当前统计一次性补发所有"按数据可判定"的 check 型照片（不弹卡片，静默恢复），
  // 依赖 animSeen/gameWins 的历史回顾型照片无法回溯，用户重新达成后会自动解锁。
  function restorePhotosFromStats() {
    let added = 0
    for (const p of PHOTOS) {
      if (!p || typeof p.check !== 'function') continue
      if (P.photos[p.id]) continue
      let ok = false
      try { ok = !!p.check(P) } catch (err) { /* 单条失败不影响整体 */ }
      if (ok) {
        P.photos[p.id] = { ts: Date.now() }
        added += 1
      }
    }
    if (added > 0) saveState()
    return added
  }

  function applyDecay(fromTs) {
    const mins = clamp(Math.round((Date.now() - fromTs) / 60000), 0, 600)
    P.stats.satiety = clamp(P.stats.satiety - mins * 0.22, 0, 100)
    P.stats.mood = clamp(P.stats.mood - mins * 0.15, 0, 100)
    P.stats.energy = clamp(P.stats.energy - mins * 0.2, 0, 100)
    P.stats.thirst = clamp(P.stats.thirst - mins * 0.18, 0, 100)
  }

  function saveState() {
    if (window.pet.character?.authority) {
      const preferences = Object.fromEntries(window.NurtureRules.UI_PREFERENCE_FIELDS.filter(key => P[key] !== undefined).map(key => [key, P[key]]))
      return window.pet.character.submit({ kind: 'settings.update', payload: { preferences } })
    }
    if (!stateWritable) return Promise.resolve(false)
    P.lastTick = Date.now()
    return Promise.resolve(window.StateStore.save(P)).catch(() => {
      console.warn('[state] save failed')
      return false
    })
  }

  // 记录互动（"想你了"判定用：主人触碰/聊天/喂食/游戏/工作都算"被理会"）
  function touch() {
    if (window.pet.character?.authority) { void submitKernelInteraction({ kind: 'touch' }); return }
    P.lastInteractionAt = Date.now()
  }

  const presenceRuntimeLog = []
  /* ⑤ 只读统计用的极小累加器（不参与任何决策；只为了让"她多久主动说一次"可被事后统计） */
  const presenceStat = { count: 0, lastFireTs: 0 }
  function recordPresenceLog(entry) {
    presenceRuntimeLog.push(entry)
    if (presenceRuntimeLog.length > 120) presenceRuntimeLog.shift()
  }

  function presenceDateKey(ts) {
    const d = new Date(typeof ts === 'number' ? ts : Date.now())
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function hasMemorySource(m) {
    if (!m) return false
    return !!(m.sourceType || (Array.isArray(m.sourceEventIds) && m.sourceEventIds.length) || (Array.isArray(m.sourceDiaryIds) && m.sourceDiaryIds.length) || (Array.isArray(m.relatedAlbumIds) && m.relatedAlbumIds.length) || m.originalContent)
  }

  function pickPresenceMemory() {
    try {
      if (!window.MemoryRetrieval || typeof window.MemoryRetrieval.retrieve !== 'function') return null
      const todayKey = presenceDateKey()
      const now = Date.now()
      const mems = window.MemoryRetrieval.retrieve({}, { limit: 12 }) || []
      const valid = mems.filter((m) => {
        const c = m && (m.content || m.text || '')
        if (!c.trim()) return false
        if (!hasMemorySource(m)) return false
        const dateStr = m.date || m.eventTime || ''
        if (dateStr && String(dateStr) > todayKey) return false
        const ts = m.createdAt || m.updatedAt || 0
        if (ts && ts > now) return false
        return true
      })
      if (!valid.length) return null
      valid.sort((a, b) => {
        const imp = (Number(b.importance) || 0) - (Number(a.importance) || 0)
        if (imp !== 0) return imp
        const todayA = a.date === todayKey ? 1 : 0
        const todayB = b.date === todayKey ? 1 : 0
        if (todayA !== todayB) return todayA - todayB
        const recallA = a.lastRecalledAt || 0
        const recallB = b.lastRecalledAt || 0
        if (recallA !== recallB) return recallA - recallB
        return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
      })
      return valid[0]
    } catch (err) {
      return null
    }
  }

  function runAmbientPresence() {
    return { ok: false, reason: "runtime_owned" }
    try {
      if (!window.IntentEngine || typeof window.IntentEngine.evaluatePresence !== 'function') return
      const snap = window.CharacterSnapshot && typeof window.CharacterSnapshot.toCharacterContext === 'function' ? window.CharacterSnapshot.toCharacterContext() : null
      if (!snap) return
      const ctx = {
        ...snap,
        lastInteractionAt: P.lastInteractionAt || 0,
        pet: { lastInteractionAt: P.lastInteractionAt || 0 },
        busy: !!R.busy,
        chatBusy: !!chatBusy,
        chatOpen: !!R.chatOpen,
        workId: R.workId || null,
        resting: restUntil > Date.now(),
        gamePlaying: !!(game && game.playing),
        userTyping: document.activeElement === $('chat-input')
      }
      const result = window.IntentEngine.evaluatePresence(ctx)
      recordPresenceLog({
        ts: Date.now(),
        intent: result ? result.intent : null,
        trigger: result ? result.trigger : null,
        reason: result ? result.reason : null,
        output: null,
        sourceRef: null,
        suppressed: result ? !!result.suppressed : true,
        suppressionReason: result ? (result.suppressionReason || null) : 'no_presence_result'
      })
      if (!result || !result.selected) return

      const presenceContext = { ...snap }
      let memoryRef = null
      if (result.intent === 'share_memory') {
        memoryRef = pickPresenceMemory()
        if (!memoryRef) return
        const memoryText = (memoryRef.content || memoryRef.text || '').trim()
        presenceContext.memoryText = memoryText
        presenceContext.recentMemory = [memoryRef]
        presenceContext.memoryRef = memoryRef
      }

      const intentSnap = {
        source: 'presence-policy',
        activeKind: result.intent,
        presence: true,
        reason: result.reason,
        trigger: result.trigger,
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 1000
      }
      if (!window.BehaviorDirector || typeof window.BehaviorDirector.planForIntent !== 'function') return
      const behaviorPlan = window.BehaviorDirector.planForIntent(intentSnap)
      if (!behaviorPlan || !behaviorPlan.ok) return
      if (!window.ExpressionEngine || typeof window.ExpressionEngine.createPlan !== 'function') return
      const exprPlan = window.ExpressionEngine.createPlan({
        intent: intentSnap,
        behavior: behaviorPlan,
        emotion: presenceContext.emotion,
        persona: presenceContext.persona,
        relationship: presenceContext.relationship,
        context: presenceContext
      })
      if (!exprPlan || !exprPlan.channels || !exprPlan.channels.dialogue) return
      if (window.ExpressionEngine.activatePlan && exprPlan.requestId) {
        window.ExpressionEngine.activatePlan(exprPlan.requestId)
      }
      if (!window.DialogueEngine || typeof window.DialogueEngine.resolveForExpression !== 'function') return
      const dlgPromise = window.DialogueEngine.resolveForExpression(exprPlan, presenceContext)
      if (!dlgPromise || typeof dlgPromise.then !== 'function') return
      dlgPromise.then((dlg) => {
        if (!dlg || !dlg.ok || !dlg.result || !dlg.result.text || !dlg.result.status || dlg.result.status !== 'spoken' || isInternalUiText(dlg.result.text)) return
        if (window.IntentEngine.markPresenceUsed) window.IntentEngine.markPresenceUsed(Date.now(), result.intent)
        /* S3：把预算写回状态（跨重启生效；失败不阻塞表达） */
        try {
        } catch (err) { /* non-fatal */ }
        recordPresenceLog({
          ts: Date.now(),
          intent: result.intent,
          trigger: result.trigger,
          reason: result.reason,
          output: dlg.result.text,
          sourceRef: dlg.result.sourceRef || null,
          contentId: dlg.result.contentId || null,
          planId: exprPlan.requestId || null,
          behaviorKey: exprPlan.behaviorKey || null,
          memoryId: memoryRef ? (memoryRef.id || null) : null,
          memorySourceType: memoryRef ? (memoryRef.sourceType || null) : null,
          suppressed: false,
          suppressionReason: null
        })
        /* ⑤ 只读可观测性：存在感**真的开口时**留一行日志，供事后统计
           （开口频率/间隔/意图分布）。**不改任何策略参数**，也与决策逻辑无关；
           因为自身有 15 分钟冷却 + 每日上限，这行日志量极低。
           渲染层 console 会被主进程写进 pet.log（`[renderer:N]` 前缀）。 */
        try {
          const nowTs = Date.now()
          const lastTs = presenceStat.lastFireTs
          const gapMin = lastTs ? Math.round((nowTs - lastTs) / 60000) : null
          presenceStat.lastFireTs = nowTs
          presenceStat.count++
          /* S3 观测：带上"今天第几次 / 上限"，便于事后核对预算是否真的生效 */
          const pol = window.IntentEngine && typeof window.IntentEngine.getPresencePolicy === 'function'
            ? window.IntentEngine.getPresencePolicy(nowTs) : null
          console.log('presence-fire intent=' + String(result.intent || '-') +
            ' trigger=' + String(result.trigger || '-') +
            ' gapMin=' + (gapMin === null ? 'first' : gapMin) +
            ' count=' + presenceStat.count +
            ' dayCount=' + (pol ? pol.dailyCount : '-') + '/' + (pol ? pol.dailyCap : '-'))
        } catch (err) { /* 非致命 */ }
        const beats = dlg.result.beats
        const presenceToken = beginBubble('presence')
        if (!presenceToken) return
        if (Array.isArray(beats) && beats.length > 1) sayBeats(beats, presenceToken)
        else { say(dlg.result.text, 4500, 'presence', presenceToken); if (bubbleTokenValid(presenceToken)) endBubble(presenceToken) }
      }).catch(() => {})
    } catch (err) { /* presence must never break core loop */ }
  }

  /* CC-3 / P0：**心跳逐步护栏 ＋ 运行/失败计数**。
     背景：这个 60s 心跳是 Life Context / Shadow／proactive 的**唯一时序入口**，而回调体内多步无 try/catch
     ⇒ 任一步抛异常会**静默吃掉同轮后续所有步骤**（同口径实测：本项目"去注释后为空"的静默 catch 占 49.1%）。
     纪律：**只加护栏与计数，不改任何一步的业务语义、顺序与周期**；计数只读出口挂到既有 `__petTest`。
     回退：删本块与下方 4 处 `try/catch` 包装即可（纯追加，无删除行）。 */
  const __beatGuard = { ticks: 0, stepsOk: 0, failures: {} }
  function __beatFail(name, err) {
    try {
      const k = String(name)
      __beatGuard.failures[k] = (__beatGuard.failures[k] || 0) + 1
      console.warn('[heartbeat] step failed: ' + k + ' — ' + ((err && err.message) || err))
    } catch (e2) { /* 计数与日志本身失败不改变任何行为 */ }
  }
  Scheduler.every('needs', 60000, () => {
    __beatGuard.ticks++
    // 按实际经过时间计算衰减系数（setInterval 有漂移，长跑会累积误差；用 lastTick 差值精确）
    const nowTick = Date.now()
    const elapsedMin = clamp((nowTick - (P.lastTick || nowTick)) / 60000, 0, 30) // 最多按 30 分钟补（异常大值防跳变）
    // 照片数值扫描放最前：任何分支（工作/休息/空闲）都要跑，否则工作态金币涨了永远不解锁
    try {
    checkPhotoUnlocks()
    __beatGuard.stepsOk++
    } catch (err) { __beatFail('checkPhotoUnlocks', err) }
    // 成就补检：只加金币的路径不查成就，靠这次心跳兜底，最多延迟 1 分钟
    try {
    catchUpAchievements()
    __beatGuard.stepsOk++
    } catch (err) { __beatFail('catchUpAchievements', err) }
    // 日记调度也放最前：工作时间到点也该写日记（原来放末尾会被工作/休息 return 截断）
    try {
    maybeWriteDiary()
    __beatGuard.stepsOk++
    } catch (err) { __beatFail('maybeWriteDiary', err) }
    // F5-B：Life Context 每分钟一跳（**唯一调用点**；只提交本轮输入，不读文件、不写盘、不对外开口）
    try {
    lifeContextTickOnce()
    __beatGuard.stepsOk++
    } catch (err) { __beatFail('lifeContextTickOnce', err) }
    // Establish the calendar-day baseline on each heartbeat, before actions
    // change cumulative counters. Migration reuses the saved daySnapshot.
    try {
    ensureDiaryBase()
    __beatGuard.stepsOk++
    } catch (err) { __beatFail('ensureDiaryBase', err) }
    // 工作中：按工作速率逐分钟消耗状态，到时自动结算
    if (R.workId) {
      const job = WORK_JOBS.find((j) => j.id === R.workId)
      if (job) {
        const consume = workConsumePerMin(job)
        // job.consume 是每分钟消耗点，按实际经过分钟扣（速率正确且不漂移）
        Object.keys(consume).forEach((k) => {
          P.stats[k] = clamp(P.stats[k] - consume[k] * elapsedMin, 0, 100)
        })
        renderCare()
        saveState()
        if (Date.now() >= R.workEnd) {
          const coins = workReward(job)
          settleWork(job, coins, job.minutes, false)
          return
        }
        renderWorkProgress()
        ensureDaySnapshot()
        return
      }
      finishWorkUI()
    }
    // 休息中：自然消耗完全停止，由休息定时器单独恢复心情/精力
    if (restUntil > Date.now()) {
      P.stats.mood = clamp(P.stats.mood + 0.6 * elapsedMin, 0, 100)
      P.stats.energy = clamp(P.stats.energy + 0.8 * elapsedMin, 0, 100)
      renderCare()
      saveState()
      ensureDaySnapshot()
      return
    }
    const livingState = window.PetLife && window.PetLife.context(Date.now()).livingState
    window.NeedsSystem.decay(P, elapsedMin, { sleepy: R.sleepy, running: R.running, resting: !!(livingState && livingState.resting) })
    renderCare()
    saveState()
    ensureDaySnapshot()
  })

  Scheduler.every('diary2', 60000, () => {
    try {
      if (!window.DiaryEngine || !diaryOn || R.busy || R.hidden) return
      const now = Date.now()
      /* P2/D4-4：与 maybeWriteDiary 同口径——今天被删/忘掉过 ⇒ 不自动补写（两条路径不漂移）。 */
      if (P.diarySuppressed === diaryDayKey(new Date())) return
      /* CC-4 / P1-D1：与 `maybeWriteDiary` **同一判据**（避免两条写路径漂移）。 */
      if (!diaryWindowDue(now).due) return
      /* 热修：原「if (!resolver.reached) return」与 ε-窗口矛盾（reached 只在边界之后为真）
         ⇒ 该路径同样永不落笔。 */
      const resolver = window.DiaryEngine.resolveDiaryDay(now, P.diaryTime || '23:00')
      if (window.DiaryEngine.getOutput(resolver.diaryDay)) return
      // Use the same façade as manual writes: fresh material, save acknowledgement,
      // progress cleanup and rejection handling belong to one path.
      writeDiary(false).catch(() => {})
    } catch (err) { /* Diary must never break runtime */ }
  })

  /* ---------- speech & mood ---------- */

  let toastTimer = null

  function clearSayBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (bubbleEl.classList.contains('dp-bubble-interaction')) return
    if (bubbleEl.classList.contains('dp-bubble-remind')) return
    bubbleEl.classList.add('hidden')
    bubbleEl.classList.remove('dp-chat-reply')
    bubbleEl.dataset.chatReply = ''
    bubbleEl.dataset.thinking = ''
    stage.classList.remove('dp-busy-bubble')
    // 注：聊天回复气泡固定小尺寸，不放大窗口，人物与窗口均不动
    flushReminder()
  }

  function isInternalUiText(text) {
    const t = String(text || '')
    if (window.DialogueEngine && typeof window.DialogueEngine.isInternalLabelText === 'function') return window.DialogueEngine.isInternalLabelText(t)
    return /开心台词|本地默认台词|默认台词|fallback|default dialogue|source名称|source label|source name|category名称|category label|debug label|fallback label/i.test(t)
  }

  let bubbleSeq = 0
  let bubbleOwner = ''
  function beginBubble(owner, execution) {
    if (!roleRuntime.isAuthorized(execution)) return null
    const newPriority = BUBBLE_PRIORITY[owner] || 0
    if (bubbleOwner) {
      const curPriority = BUBBLE_PRIORITY[bubbleOwner] || 0
      if (newPriority < curPriority) return null
    }
    bubbleSeq++
    bubbleOwner = owner
    runtimeBubblePermits.set(bubbleSeq, execution)
    while (runtimeBubblePermits.size > 16) runtimeBubblePermits.delete(runtimeBubblePermits.keys().next().value)
    return bubbleSeq
  }
  function bubbleTokenValid(token) {
    return token === bubbleSeq && roleRuntime.isAuthorized(runtimeBubblePermits.get(token))
  }
  function endBubble(token) {
    if (token === bubbleSeq) bubbleOwner = ''
  }

  const BUBBLE_PRIORITY = { 'character-chat': 100, 'presence': 80, 'expression': 60, 'random-dialogue': 20, 'ui': 30 }
  function bubbleCanWrite(source) {
    const src = source || 'ui'
    if (!bubbleOwner) return true
    const cur = BUBBLE_PRIORITY[bubbleOwner] || 0
    const s = BUBBLE_PRIORITY[src] || 0
    return s >= cur
  }

  function sleepWithToken(ms, token) {
    return new Promise((resolve) => {
      const start = Date.now()
      const timer = setInterval(() => {
        if (token !== undefined && !bubbleTokenValid(token)) { clearInterval(timer); resolve(); return }
        if (Date.now() - start >= ms) { clearInterval(timer); resolve() }
      }, 100)
    })
  }

  function bubbleDurationMs(text) {
    const len = String(text || '').trim().length
    return clamp(2600 + Math.min(len, 80) * 35, 2600, 7000)
  }

  function say(text, ms, source, token, execution) {
    execution = execution || runtimeBubblePermits.get(token)
    if (!roleRuntime.isAuthorized(execution)) {
      if (source !== 'ui' && source !== 'user-feedback') return { ok: false, reason: 'runtime_authorization_required' }
      if (!text) return { ok: false, reason: 'empty_text' }
      void runtimeNotify(permit => say(text, ms, 'ui', undefined, permit), 'local:' + String(text), source === 'user-feedback' ? 'user-feedback' : 'automatic')
      return { ok: true, queued: true, displayed: false }
    }
    if (R.hidden) return { ok: false, reason: 'hidden' }
    return execution.publish(() => writeSay(text, ms, source, token))
  }
  function writeSay(text, ms, source, token) {
    if (!source) return { ok: false, reason: 'no_source' }
    const src = source
    const life = window.PetLife && window.PetLife.context(Date.now())
    const permit = livingPresence.canSpeak({ source: src, text, token, hidden: R.hidden, busy: R.busy || chatBusy || charcBusy, quietUntil: roleRuntime.snapshot().quietUntil })
    if (!permit.ok) return permit
    if (src !== 'ui' && token === undefined) return { ok: false, reason: 'missing_token' }
    if (!bubbleCanWrite(src)) return { ok: false, reason: 'owner_rejected' }
    if (token !== undefined && !bubbleTokenValid(token)) return { ok: false, reason: 'token_invalid' }
    if (bubbleEl.dataset.report === '1') return { ok: false, reason: 'report_active' }
    if (bubbleEl.classList.contains('dp-bubble-interaction')) return { ok: false, reason: 'interaction_active' }
    if (bubbleEl.classList.contains('dp-bubble-remind')) return { ok: false, reason: 'remind_active' }
    // 闲聊思考/回复气泡保护：闲置台词等不得打断
    if (bubbleEl.dataset.chatReply === '1' || bubbleEl.dataset.thinking === '1') return { ok: false, reason: 'chat_reply_active' }
    text = String(text || '').replace(/\{name\}/g, P.name)
    text = text.replace(/\{owner\}/g, P.ownerName || '主人')
    if (isInternalUiText(text)) { console.warn('[dialogue-output-boundary] blocked internal label:', text); return { ok: false, reason: 'internal_ui_text' } }
    if (R.chatOpen) {
      const toast = $('panel-toast')
      toast.textContent = text
      toast.classList.remove('hidden')
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => toast.classList.add('hidden'), ms || 3500)
      livingPresence.spoken(src, text, token)
      return { ok: true, displayed: 'toast' }
    }
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    bubbleEl.dataset.report = ''
    bubbleEl.className = 'dp-bubble'
    bubbleEl.textContent = text
    bubbleEl.classList.remove('hidden')
    stage.classList.add('dp-busy-bubble')
    bubbleTimer = setTimeout(clearSayBubble, ms || 3200)
    livingPresence.spoken(src, text, token)
    return { ok: true, displayed: 'bubble' }
  }

  async function sayBeats(beats, token) {
    if (!Array.isArray(beats) || !beats.length) return { status: 'empty' }
    for (let i = 0; i < beats.length; i++) {
      if (token !== undefined && !bubbleTokenValid(token)) return { status: 'tokenInvalid', index: i }
      const b = beats[i] || {}
      if (b.text) {
        const dur = bubbleDurationMs(b.text)
        const res = say(String(b.text), dur, bubbleOwner, token)
        if (!res || res.ok === false) {
          if (token !== undefined && bubbleTokenValid(token)) endBubble(token)
          return { status: 'writeRejected', index: i, reason: (res && res.reason) || 'unknown' }
        }
        if (i < beats.length - 1) {
          await sleepWithToken(dur + (Number(b.delay) || 350), token)
        }
      }
    }
    if (token !== undefined && bubbleTokenValid(token)) endBubble(token)
    return { status: 'completed' }
  }

  let reportModeOpen = false
  let currentReport = null // 当前展示的汇报卡内容 { summary, fullText }
  let queuedReport = null // 被选项卡挤下场的汇报卡，交互处理完自动恢复（容量 1，只留最新）

  function hideReport() {
    currentReport = null
    bubbleEl.classList.add('hidden')
    stage.classList.remove('dp-busy-bubble')
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (reportModeOpen && !R.chatOpen && !R.hidden) {
      reportModeOpen = false
      window.pet.setMode('pet')
    }
    flushReminder()
  }

  function showReport(summary, fullText) {
    roleRuntime.cancel('technical_report', event => event.origin === 'automatic')
    // Work reports are technical results, never a second character reply pipeline.
    summary = '工作结果：' + String(summary || '')
    // 选项卡（授权/提问）优先级更高：正在展示时先排队，交互处理完自动恢复
    if (pendingInter && bubbleEl.classList.contains('dp-bubble-interaction')) {
      queuedReport = { summary, fullText }
      playDing('report')
      return
    }
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    // 面板开着也直接弹汇报卡（卡片是模态浮层，压在面板之上），不再走横幅
    if (!R.hidden) {
      reportModeOpen = true
      window.pet.setMode('chat')
    }
    currentReport = { summary, fullText }
    renderReportCard(summary, fullText)
    playDing('report')
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        return
      }
    } catch (err) { /* fall through */ }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }

  // 汇报卡符号清洗：剥离模型输出常见的 markdown 残留（纯文本显示时符号裸露）
  function cleanMarkdown(t) {
    if (!t) return t
    let s = String(t)
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '').trim()) // 代码块去围栏
      .replace(/`([^`]+)`/g, '$1') // 行内反引号
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接 [t](url) → t
      .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
      .replace(/__([^_]+)__/g, '$1') // __bold__
      .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2') // *italic*（不碰行首列表符）
      .replace(/~~([^~]+)~~/g, '$1') // ~~strike~~
      .replace(/^#{1,6}\s+/gm, '') // 行首 # 标题符
      .replace(/^>\s?/gm, '') // 引用符
      .replace(/^\s*[-*]\s+/gm, '• ') // 无序列表 → •
      .replace(/^\s*\d+[.)]\s+/gm, '') // 数字列表去序号（保留内容）
      .replace(/^[|].*[|]\s*$/gm, '') // 表格行整行删除（简化）
      .replace(/\s{2,}/g, ' ')
      .trim()
    return s
  }

  function renderReportCard(summary, fullText) {
    bubbleEl.innerHTML = ''
    bubbleEl.dataset.report = '1'
    bubbleEl.className = 'dp-bubble dp-bubble-report'
    const title = document.createElement('div')
    title.className = 'dp-bubble-report-title'
    title.textContent = '📣 工作完成汇报'
    bubbleEl.appendChild(title)
    // 详细内容直接占满卡片（不再显示摘要区块，避免高度不足显示不全、内容重复）
    if (fullText && fullText.trim()) {
      const label = document.createElement('div')
      label.className = 'dp-bubble-report-detail-label'
      label.textContent = '📄 详细内容（可滚动）'
      const detail = document.createElement('div')
      detail.className = 'dp-bubble-report-detail'
      detail.textContent = cleanMarkdown(fullText)
      bubbleEl.appendChild(label)
      bubbleEl.appendChild(detail)
    } else {
      const body = document.createElement('div')
      body.className = 'dp-bubble-report-body'
      body.textContent = cleanMarkdown(summary) || '（这次没有文字内容，点下面按钮去客户端看完整过程）'
      bubbleEl.appendChild(body)
    }
    const foot = document.createElement('div')
    foot.className = 'dp-bubble-report-hint'
    if (fullText && fullText.trim()) {
      const copyBtn = document.createElement('button')
      copyBtn.className = 'dp-bubble-report-btn'
      copyBtn.textContent = '📋 复制全文'
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        copyText(fullText).then(() => {
          copyBtn.textContent = '✅ 已复制'
          setTimeout(() => { copyBtn.textContent = '📋 复制全文' }, 1600)
        }).catch(() => {
          copyBtn.textContent = '复制失败'
          setTimeout(() => { copyBtn.textContent = '📋 复制全文' }, 1600)
        })
      })
      foot.appendChild(copyBtn)
      const memoBtn = document.createElement('button')
      memoBtn.className = 'dp-bubble-report-btn'
      memoBtn.textContent = '📝 存备忘录'
      memoBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const ok = addMemo(fullText)
        memoBtn.textContent = ok ? '✅ 已存' : '未保存'
        setTimeout(() => { memoBtn.textContent = '📝 存备忘录' }, 1600)
      })
      foot.appendChild(memoBtn)
    }
    const openBtn = document.createElement('button')
    openBtn.className = 'dp-bubble-report-btn'
    openBtn.textContent = '打开客户端 →'
    openBtn.addEventListener('click', (e) => { e.stopPropagation(); openHarnessDesktop(openBtn) })
    const closeBtn = document.createElement('button')
    closeBtn.className = 'dp-bubble-report-close'
    closeBtn.title = '关闭'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); hideReport() })
    foot.appendChild(openBtn)
    foot.appendChild(closeBtn)
    bubbleEl.appendChild(foot)
    bubbleEl.classList.remove('hidden')
    stage.classList.add('dp-busy-bubble')
    bubbleTimer = setTimeout(hideReport, 600000)
  }

  let audioCtx = null

  function ensureAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
      if (audioCtx.state === 'suspended') audioCtx.resume()
    } catch (err) { audioCtx = null }
  }

  // notes: [[频率, 起始偏移秒, 时长秒], ...] —— 通用合成音播放器
  function playNotes(notes, volMul, evt) {
    if (!P.soundEnabled) return
    if (evt && P.soundEvents && P.soundEvents[evt] === false) return
    try {
      ensureAudio()
      if (!audioCtx) return
      const vol = 0.3 * (P.soundVolume / 100) * (volMul || 1)
      const t0 = audioCtx.currentTime
      notes.forEach((n) => {
        const freq = n[0]
        const off = n[1]
        const dur = n[2]
        const osc = audioCtx.createOscillator()
        const gain = audioCtx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        const t = t0 + off
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
        osc.connect(gain)
        gain.connect(audioCtx.destination)
        osc.start(t)
        osc.stop(t + dur + 0.05)
      })
    } catch (err) { /* silent */ }
  }

  function playDing(evt) {
    playNotes([[880, 0, 0.5], [1318.5, 0.18, 0.5]], 1, evt || 'ui')
  }

  // 三类提醒专属音：番茄=上扬双音 / 课程=报时三连 / 喝水=水滴两连
  function playRemindSound(kind) {
    if (kind === 'pomo') playNotes([[784, 0, 0.5], [1174.7, 0.22, 0.6]], 1.05, 'reminder')
    else if (kind === 'class') playNotes([[880, 0, 0.35], [1108.7, 0.16, 0.35], [1318.5, 0.32, 0.45]], 1, 'reminder')
    else if (kind === 'water') playNotes([[1568, 0, 0.22], [1174.7, 0.24, 0.3]], 0.9, 'reminder')
    else playDing('reminder')
  }

  function extractLastAssistant(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] && events[i].event
      if (ev && ev.type === 'assistant/message' && ev.data && ev.data.message) {
        const content = ev.data.message.content
        if (!Array.isArray(content)) continue
        const text = content
          .filter((b) => b && b.type === 'text' && b.text)
          .map((b) => b.text)
          .join('\n')
          .trim()
        if (text) return text
      }
    }
    return null
  }

  async function buildReport() {
    // 轮次刚结束时历史可能还没落库，重试几次拿到最终回复
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const resp = await window.pet.api('session.history', { sessionId: R.currentId, maxMessages: 4 })
        const r = resp && resp.result
        if (r && r.ok) {
          const text = extractLastAssistant(r.value.events || [])
          if (text) return text
        }
      } catch (err) { /* retry */ }
      await sleep(2500)
    }
    return null
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  async function ensureSummarySession() {
    try {
      if (P.summarySessionId) {
        const lr = await window.pet.api('session.list', {})
        const items = (lr && lr.result && lr.result.ok && lr.result.value.items) || []
        const cur = items.find((s) => s.sessionId === P.summarySessionId)
        if (cur) {
          const cp = cur.projections && cur.projections.values && cur.projections.values.contextPressure
          const limit = (cp && cp.contextWindow) ? cp.contextWindow : 1000000
          const pressure = (cp && cp.pressureTokens) ? cp.pressureTokens : 0
          if (pressure < limit * 0.8) return P.summarySessionId
          // 文本预算快用完：归档旧助手会话，换一个新的
          log('summary session rotating (pressure ' + pressure + '/' + limit + ')')
          try {
            await window.pet.api('workspace.archiveSession', { sessionId: P.summarySessionId })
          } catch (err) { /* 归档失败也继续轮换 */ }
          P.summarySessionId = ''
          saveState()
        } else {
          P.summarySessionId = ''
          saveState()
        }
      }
      // 新建并绑定摘要会话（遇适配器/运行时异常时由调用侧触发轮换）
      const cr = await window.pet.api('session.create', { cwd: WORKSPACE || undefined })
      if (cr && cr.result && cr.result.ok) {
        P.summarySessionId = cr.result.value.sessionId
        saveState()
        try {
          await window.pet.api('session.rename', { sessionId: P.summarySessionId, title: '🐣 桌宠汇报助手' })
        } catch (err) { /* optional */ }
        return P.summarySessionId
      }
      return null
    } catch (err) {
      return null
    }
  }

  // 摘要会话健康检查：上一轮失败且疑似会话损坏 → 强制轮换（删旧建新），
  // 解决"特定会话 adapter 损坏导致每轮失败"的问题
  function rotateSummarySession() {
    if (!P.summarySessionId) return
    const old = P.summarySessionId
    P.summarySessionId = ''
    saveState()
    try {
      window.pet.api('workspace.archiveSession', { sessionId: old }).then(() => log('summary session rotated (broken): ' + old)).catch(() => {})
    } catch (err) { /* ignore */ }
  }

  function setMood(m, ms) {
    R.mood = m
    updateMood()
    if (moodTimer) { clearTimeout(moodTimer); moodTimer = null }
    if (ms) {
      moodTimer = setTimeout(() => {
        // Expire the logical mood on time; playAnim's lock lets the current clip finish.
        R.mood = 'idle'
        updateMood()
        moodTimer = null
      }, ms)
    }
  }

  // 状态 → webm 动画组（PC2005 dsh-pet 开源素材，renderer/anim/）
    const ANIM_GROUPS = window.AnimationRegistry.groups
  // 每个动画里角色的实际包围盒（640×360 画面内的 alpha bbox，实测数据）
  // 宽动作（工作/进食）带场景道具（桌子/电脑），单独用小目标高度
          const ANIM_BBOX = window.AnimationRegistry.bbox
  // 统一角色高度（155px）：思考/进食等带道具的宽动作与待机动作一致，
  // 避免"思考动画比待机小一圈"；容器加宽到 220 填满窗口（角色宽 ~215 仍放得下）
  const PET_VIEW_H = 155
  const PET_VIEW_H_OPEN = 84 // 面板打开时宠物缩小（84×118 容器），宽窄统一
  const PET_W = 220
  const PET_H = 170
  const PET_W_OPEN = 84
  const PET_H_OPEN = 118
  // 每动画水平微调（px）：角色视觉重心可能偏离 bbox 中心（尾巴/发丝占位），逐动画修正。
  // 工作/进食动画的 bbox 含绿幕未扣净的半透明残留（画面比主体宽），主体实际偏左 → 大幅右移
      const ANIM_SHIFT_X = window.AnimationRegistry.shiftX

  // 垂直微调（px）：点击回应等动画角色视觉重心偏高，上移贴近容器底更自然
    const ANIM_SHIFT_Y = window.AnimationRegistry.shiftY

  function fitAnim(videoEl, name) {
    const bb = ANIM_BBOX[name]
    if (!bb) return
    const open = stage.classList.contains('dp-open')
    const cw = open ? PET_W_OPEN : PET_W
    const ch = open ? PET_H_OPEN : PET_H
    // 高度优先（155/84），但宽度不得超过容器（宽动作带道具画面很宽，防止溢出盖住 UI）
    const maxH = open ? PET_VIEW_H_OPEN : PET_VIEW_H
    const wLimitH = (cw - 2) * (bb.h / bb.w) // 宽度限制下的等效高度
    const targetH = Math.min(maxH, wLimitH)
    const s = targetH / bb.h
    const shiftX = ANIM_SHIFT_X[name] || 0
    // 垂直微调（px）：部分动画角色视觉重心偏高（如点击挥手/跳跃），手动下移贴近容器底
    const shiftY = ANIM_SHIFT_Y[name] || 0
    // 位置过渡：动画切换时 left/top 平滑过渡（原跳变导致"闪跳"感）；尺寸不过渡（缩放会模糊）
    videoEl.style.transition = 'left .18s ease-out, top .18s ease-out'
    // 水平：角色 bbox 中心对齐容器中心 + 每动画微调（修正视觉偏左）；垂直：角色底部贴容器底
    videoEl.style.width = Math.round(640 * s) + 'px'
    videoEl.style.height = Math.round(360 * s) + 'px'
    videoEl.style.left = Math.round(cw / 2 - (bb.x + bb.w / 2) * s + shiftX) + 'px'
    videoEl.style.top = Math.round(-bb.y * s + (ch - targetH) + shiftY) + 'px'
  }

  let currentAnimName = null
  const failedAnimations = new Set()
  let animationRunSeq = 0
  const animTransitionLog = []
  function recordAnimTransition(entry) {
    animTransitionLog.push({ ...entry, ts: Date.now(), runId: animationRunSeq })
    if (animTransitionLog.length > 60) animTransitionLog.shift()
  }
  let activeDialogueRequestId = null
  let animTimer = null

  // 闲置动画链：主待机（idle-breathe）持续循环；每 20 秒随机表演一个动作，
  // 播放 10 秒后自动切回主待机；另有 20% 概率触发"彩蛋"（随机动画，播放 10 秒），
  // 让桌宠偶尔自己找乐子（已扩充：新增 57 个上游动画全部纳入）
  const IDLE_MAIN = 'idle-breathe'
  const IDLE_PERFORM = ['idle-lookaround', 'idle-hum', 'idle-float', 'idle-mirror', 'idle-fan', 'idle-stretch', 'idle-bubbles', 'happy-sway']
  // 彩蛋池：原有 16 个 + 新增玩耍/时节/表演/移动类（40 个）
  const EGG_ANIMS = [
    // 原有
    'egg-violin', 'egg-watergun', 'egg-kite', 'egg-snowman', 'egg-balloon', 'egg-animals',
    'egg-whale', 'egg-leaves', 'egg-icecream', 'egg-maiddance', 'egg-zhaiwu', 'egg-rubik',
    'egg-bubbles', 'egg-jump', 'egg-desk', 'egg-wake',
    // 新增：玩耍/时节/表演/移动
    'egg-dove', 'egg-chrysanthemum', 'egg-gift', 'egg-spinningtop', 'egg-needlework',
    'egg-flute', 'wake-startle', 'egg-swing', 'egg-riverlantern', 'egg-skyllantern',
    'egg-firework', 'egg-bloom', 'egg-catpet', 'egg-ghost', 'perform-curtsy', 'move-crab',
    'egg-flower', 'egg-magic', 'egg-rockhorse', 'perform-note', 'egg-juggling',
    'word-whattoeat', 'egg-redpacket', 'egg-pumpkin', 'egg-shuttlecock',
    'egg-gameangry', 'egg-liondance', 'egg-gomoku', 'perform-spin', 'egg-fuchinese',
    'perform-tailthump', 'egg-toycar', 'perform-squash', 'move-runleft', 'perform-dressup',
    'egg-mooncake', 'egg-christmas',
  ]
  // 吃什么表演池（新增 15 个吃类动画 + 原有进食）
  const EAT_PERFORM = ['eat-crab', 'eat-dumpling', 'eat-laba', 'eat-ricecake', 'eat-qingtuan', 'eat-tangyuan', 'eat-tanghulu', 'eat-dinner', 'eat-lunch', 'eat-watermelon', 'eat-breakfast', 'eat-longevity', 'eat-chongyang', 'eat-zongzi', 'eat-hotpot', 'eat-rice', 'eat-token', 'eat-snack', 'eat-caught']
  // 点击回应池（点击桌宠时随机触发）
  const CLICK_ANIMS = ['click-tsundere', 'click-shy', 'click-tickle', 'click-wave', 'happy-jump']
  const IDLE_PERFORM_MS = 20000
  // drag-carry webm 结构（canvas 实测 alpha bbox 底部）：
  //   0~0.75s  站立（bottom≈331 贴地，尚未拎起）
  //   0.75~1.5s 被拎起动效（bottom 314→298 快速上移）
  //   1.5~6.5s  悬空挣扎（bottom≈296~303 稳定悬空，拖拽中循环此段）
  //   7.5~9.0s  下落→落地（bottom 303→331 下移贴地）
  //   9.0~10s   落地站稳
  // 拖拽开始从 PICK_START（被拎起动效起点）播——跳过站立帧，一开始就是"被拎起"；
  // 拖拽中循环守卫只循环【悬空挣扎段】WRAP_START→WRAP_END（1.5~6.5s）；
  // 松手 seek 到 DROP_START 播放下落→落地收尾。
  const DRAG_CARRY_PICK_START = 0.9 // 拖拽开始时间点（被拎起动效起点，跳过 0~0.75s 站立帧）
  const DRAG_CARRY_WRAP_START = 3.2 // 拖拽中循环起点（悬空挣扎段开始）
  const DRAG_CARRY_WRAP_END = 6.6 // 拖拽中循环终点（悬空部分到此为止，到点跳回 WRAP_START）
  const DRAG_CARRY_DROP_START = 7.5 // 松手后下落段起点（seek 到这里播放下落→落地）
  let lastRandomAnim = '' // 防连续重复：上次随机播放的动画

  // 从池中随机选一个（避免与上次重复）
  function pickFrom(pool) {
    if (!pool.length) return ''
    let pick = ''
    if (window.BehaviorDirector && typeof window.BehaviorDirector.selectFromPool === 'function') {
      pick = window.BehaviorDirector.selectFromPool(pool, {})
    } else {
      pick = pool[Math.floor(Math.random() * pool.length)]
    }
    if (pool.length > 1 && pick === lastRandomAnim) {
      pick = pool[(pool.indexOf(pick) + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length]
    }
    lastRandomAnim = pick
    return pick
  }

  function cancelIdleChain() {
    if (animTimer) { clearTimeout(animTimer); animTimer = null }
  }

  function armIdleChain() {
    if (window.pet.character?.authority) return
    // 已在链上则不重置（updateMood 高频调用会反复走这里，
    // 若每次 reset 20s 定时器，表演/彩蛋永远到不了点——思考动画与待机"冲突"的根因）
    if (animTimer || R.hidden) return
    animTimer = setTimeout(() => {
      animTimer = null
      if (R.hidden || R.running || R.dragging || R.chatOpen) return
      const activeIntent = window.BehaviorDirector && window.BehaviorDirector.getActiveIntent
        ? window.BehaviorDirector.getActiveIntent()
        : null
      if (chatBusy || charcBusy || R.sleepy || Date.now() < animLockUntil) { armIdleChain(); return }
      const mood = effectiveAnimationMood()
      if (mood !== 'idle') { playAnim(mood); return }
      const life = window.PetLife && window.PetLife.context(Date.now())
      const activity = life && (life.activeActivity || (life.activities || []).find(a => a.status === "active"))
      const embodied = activity && activity.animationName
      if (embodied && !failedAnimations.has(embodied) && $("anim-" + embodied)) { const permit = roleRuntime.continuation(activity.runtimeContinuation); if (permit) showAnimOnce(embodied, 10000, permit); else armIdleChain(); return }
      const livingAnim = window.LivingPresence.activityAnimation(life, window.AnimationRegistry.list().map(a => typeof a === "string" ? a : a.name || a.id))
      if (livingAnim && roleRuntime.continuation(activity && activity.runtimeContinuation)) { showAnimOnce(livingAnim, 10000, roleRuntime.continuation(activity.runtimeContinuation)); return }
      if (activeIntent && activeIntent !== 'idle') { armIdleChain(); return }
      // Full little activities come from PetLife's motives; ambient motion stays small.
      const pool = window.BehaviorDirector.ambientPool({ R, P }).filter(n => !failedAnimations.has(n) && !window.LivingPresence.ACTIONS[n])
      const candidate = window.BehaviorDirector.selectFromPool(pool, { cooldown: 120000 })
      if (candidate) showAnimOnce(candidate)
      else armIdleChain()
    }, IDLE_PERFORM_MS + Math.random() * 25000)
  }

  // 动画播放守卫：非待机动画播放中锁定，避免被闲置链/setMood超时/高频updateMood抢切。
  // lockUntil = 时间戳，此期间 playAnim('idle')/闲置链不得切走当前动画
  let animLockUntil = 0

  // 核心动画播放：name 视频设为可见并播放。
  // - 状态动画（idle/working/carried 等常驻）：AnimationPlayer 内部 loop=true 无限循环。
  // - 一次性动画（点击回应/彩蛋/吃饭/表演）：loop=false，用 video ended 作为主完成信号。
  // 媒体生命周期统一交给 AnimationPlayer，避免手动 setTimeout 猜测播放结束。
  function animRequestMeta(name, onEnded) {
    // 兼容层：先给每个播放请求挂上来源/优先级，供 Director 记录与后续硬调度使用。
    if (name === 'drag-carry') return { source: 'drag', priority: 100, interruptible: false }
    if (onEnded) {
      if (CLICK_ANIMS.indexOf(name) >= 0) return { source: 'user', priority: 90, interruptible: true }
      return { source: 'interaction', priority: 80, interruptible: true }
    }
    const group = ANIM_GROUPS[R.mood] || ANIM_GROUPS.idle
    if (group === ANIM_GROUPS.working) return { source: 'work', priority: 50, interruptible: true }
    if (R.mood === 'hungry' || R.mood === 'thirsty' || R.mood === 'tired' || R.mood === 'sleepy') {
      return { source: 'needs', priority: 30, interruptible: true }
    }
    return { source: 'idle', priority: 10, interruptible: true }
  }

  function showAnim(name, lockMs, onEnded, metaOverride) {
    if (window.pet.character?.authority) {
      if (window.CharacterView?.state().animation && name !== 'drag-carry') return { ok: false, reason: 'kernel_animation_owned' }
      if (name === 'drag-carry') window.CharacterView?.interruptAnimation('owner_drag')
      if (onEnded) return { ok: false, reason: 'kernel_animation_required' }
    }
    const requestedAnimation = name
    if ((!name || failedAnimations.has(name) || !$('anim-' + name)) && window.LivingPresence.ACTIONS[name]) return { ok: false, reason: 'virtual_asset_missing' }
    if (!name || failedAnimations.has(name) || !$('anim-' + name)) {
      name = (ANIM_GROUPS[R.running ? 'working' : 'idle'] || []).find(n => !failedAnimations.has(n) && $('anim-' + n))
      if (!name) { cancelIdleChain(); return }
    }
    const activityAnimation = window.LivingPresence.ACTIONS[name]
    const execution = metaOverride && metaOverride.runtimeExecution
    if (activityAnimation && !roleRuntime.isAuthorized(execution)) return { ok: false, reason: 'runtime_authorization_required' }
    if (name === currentAnimName && (!execution || currentAnimationOwner === execution.executionId)) return
    const claimed = presentationPlans ? presentationPlans.claim({ owner: execution && execution.executionId || 'local-body', channel: 'body',
      priority: metaOverride && metaOverride.priority || 10, semanticId: activityAnimation ? 'virtual:' + requestedAnimation : requestedAnimation,
      force: R.dragging, isCurrent: execution ? () => roleRuntime.isAuthorized(execution) && !R.hidden : () => !R.hidden }) : { ok: true }
    if (!claimed.ok) return claimed
    currentAnimationOwner = execution && execution.executionId || null
    recordAnimTransition({ requested: name, previous: currentAnimName, reason: onEnded ? 'one-shot' : 'state' })
    if (window.AnimationPlayer && typeof window.AnimationPlayer.stop === 'function') {
      try { window.AnimationPlayer.stop('transition') } catch (err) { /* ignore */ }
    }
    currentAnimName = name
    if (window.AnimationHistory) window.AnimationHistory.note(name)
    if (window.DevStats) window.DevStats.recordAnimation(name, {})
    const meta = metaOverride || animRequestMeta(name, onEnded)
    const animationRunId = ++animationRunSeq
    window.AnimationDirector.request({
      id: name,
      source: meta.source,
      priority: meta.priority,
      interruptible: meta.interruptible,
      reason: onEnded ? 'one-shot' : 'state'
    })
    // 生活瞬间照片：某些动画播放即解锁（"动画触发过"条件）
    const animPhotoMap = {
      'idle-bubbles': 'bubble-time',
      'idle-mirror': 'mirror-look',
      'idle-hum': 'hum-moment',
      'idle-fan': 'fan-breeze',
      'idle-stretch': 'stretch-time',
      'click-tickle': 'tickle-battle',
      'click-tsundere': 'tsundere-moment',
      'eat-caught': 'caught-eating',
    }
    /* （#4）：由硬表派生"需要记进 animSeen 的动画名"，
       避免再手写第二份清单（照片表里的 animSeen 检查也读同一份事实）。 */
    const IDLE_ANIM_KEYS = Object.keys(animPhotoMap)
    const pid = animPhotoMap[name]
    if (pid && !P.photos[pid]) unlockPhoto(pid)
    if (!P.photos['little-chef'] && EAT_PERFORM.indexOf(name) >= 0) unlockPhoto('little-chef')
    if (EAT_PERFORM.indexOf(name) >= 0 && R.workId) unlockPhoto('efficient-lunch')
    /* （#4 animSeen 统一）：把"这个动画播过了"如实记进 `P.animSeen`。
       原状况：`animPhotoMap` 才是真正生效的硬表，而 `P.animSeen` **只读不写** ——
       于是照片表里 8~9 条 `(p.animSeen||[]).includes('xxx')` 的条件**永远不成立**（死条件），
       谁照着那种写法加新照片就会"永远解锁不了"。现在两条路径共用同一份事实：
       播过就记、并顺手用统一的检查函数扫描一次（新加 animSeen 型照片即可正常触发）。 */
    /* AL-3：进食表演（EAT_PERFORM）也记进 animSeen ⇒ little-chef / efficient-lunch 的 animSeen 条件真可达 */
    if (name && IDLE_ANIM_KEYS && IDLE_ANIM_KEYS.length && (IDLE_ANIM_KEYS.indexOf(name) >= 0 || EAT_PERFORM.indexOf(name) >= 0)) {
      if (!Array.isArray(P.animSeen)) P.animSeen = []
      if (P.animSeen.indexOf(name) < 0) { P.animSeen.push(name); try { saveState() } catch (err) { /* 非致命 */ } }
    }
    const isIdle = name === IDLE_MAIN
    petEl.classList.toggle('dp-click-anim', !isIdle)
    if (!isIdle) animLockUntil = Date.now() + (lockMs || 10000)
    const target = document.getElementById('anim-' + name)
    const videos = document.querySelectorAll('.dp-anim')
    for (const v of videos) {
      if (v !== target && !v.paused) { try { v.pause() } catch (err) { /* ignore */ } }
      if (v !== target) { v.onended = null; v.onerror = null; v.onloadeddata = null }
    }
    if (target) {
      fitAnim(target, name)
      // Retain the paused previous frame until the new video can show a frame.
      const reveal = () => {
        if (animationRunId !== animationRunSeq) return
        for (const v of videos) v.classList.toggle('on', v === target)
        target.onloadeddata = null
      }
      if (target.readyState >= 2) reveal()
      else target.onloadeddata = reveal
      window.AnimationPlayer.play(name, target, {
        once: !!onEnded,
        onStarted: () => {
          if (animationRunId === animationRunSeq && presentationPlans) presentationPlans.stage(claimed.token, 'playback_started', { animation: name, fallback: requestedAnimation !== name })
        },
        onEnded: onEnded ? async () => {
          if (animationRunId !== animationRunSeq) return
          if (presentationPlans && !presentationPlans.current(claimed.token)) return
          if (presentationPlans) presentationPlans.stage(claimed.token, 'playback_completed', { animation: name, fallback: requestedAnimation !== name })
          window.AnimationDirector.end('ended')
          if (window.EventBus) window.EventBus.emitOnce('pet.animation.ended', { name, animationRunId }, 'anim:' + animationRunId + ':ended')
          if (activityAnimation && execution && execution.isCurrent()) {
            const life = window.PetLife.context(Date.now()), active = life.activities.find(a => a.runtimeExecutionId === execution.executionId && a.animationName === name)
            const continuationId = active && active.runtimeContinuation || meta.continuationId
            if (continuationId) {
              try {
                const receipt = await window.PetLife.recordEvent({ type: 'animation.completed', eventId: 'animation:' + livingSessionId + ':' + animationRunId,
                  ts: Date.now(), animation: name, visible: !R.hidden, executionId: execution.executionId, continuationId })
                if (receipt && receipt.ok && platformBridge) await platformBridge.operationUpdate('activity:' + execution.executionId, 'completed',
                  { ok: true, sourceType: 'animation.completed', virtual: true, animation: name, eventAt: Date.now() })
                renderLivingNotebook(); if (receipt && receipt.ok) roleRuntime.completeContinuation(continuationId)
              } catch (err) { console.warn('[living] receipt:', err.message) }
            }
          }
          if (animationRunId !== animationRunSeq) return
          onEnded()
        } : null,
        onError: () => {
          if (animationRunId !== animationRunSeq) return
          if (presentationPlans) presentationPlans.stage(claimed.token, 'playback_failed', { animation: name })
          window.AnimationDirector.end('error')
          if (window.EventBus) window.EventBus.emitOnce('pet.animation.cancelled', { name, animationRunId }, 'anim:' + animationRunId + ':cancelled')
          animLockUntil = 0
          currentAnimName = null
          failedAnimations.add(name)
          if (execution && platformBridge) void platformBridge.operation('activity:' + execution.executionId).then(op => {
            if (op && op.status === 'awaiting_receipt') return platformBridge.operationUpdate(op.id, 'failed', { ok: false, reason: 'playback_failed', virtual: true, eventAt: Date.now() })
          }).catch(e => console.warn('[presentation]', e.message))
          updateMood()
        }
      })
      if (R.hidden) window.AnimationPlayer.pause()
    }
  }

  // 播完一遍一次性动画后：解锁、清标记，重新评估下一行为。
  function afterOneShotAnimation() {
    animLockUntil = 0
    currentAnimName = null
    playAnim(effectiveAnimationMood())
  }

  // 一次性动画便捷入口：播完一遍后按当前状态恢复（工作态→工作动画；空闲→待机）
  function showAnimOnce(name, lockMs, execution) {
    showAnim(name, lockMs, afterOneShotAnimation, execution ? { source: "runtime", runtimeExecution: execution } : null)
  }

  function playAnim(mood) {
    const group = ANIM_GROUPS[mood] || ANIM_GROUPS.idle
    let name
    if (mood === 'idle') {
      // 锁定期内：不切回待机（让当前表演/彩蛋/点击回应完整播放）
      if (Date.now() < animLockUntil) { armIdleChain(); return }
      // 待机：主动画持续循环 + 定期表演/彩蛋，链由定时器驱动；高频 updateMood 调用保持现状
      if (currentAnimName === IDLE_MAIN || (currentAnimName && (IDLE_PERFORM.indexOf(currentAnimName) >= 0 || EGG_ANIMS.indexOf(currentAnimName) >= 0))) {
        armIdleChain() // 保证链在跑（防御：链定时器意外丢失时补上）
        return
      }
      name = IDLE_MAIN
      armIdleChain()
    } else {
      cancelIdleChain()
      // 锁定期内不打断的检查：
      // 1) 当前动画属于目标 mood 组（如工作态 work-code/work-think、彩蛋、吃饭）→ 保持现状，
      //    防止 updateMood 高频触发下每 1.5s 重新 80/20 选一次（"动画频繁切换"根因）。
      // 2) 表演类动画（点击回应/彩蛋/吃饭）播完前 → 保持。
      // 3) 跨状态（如 work-code → drag-carry 拖拽、idle → happy）→ 放行，保证用户交互立即响应。
      if (Date.now() < animLockUntil && currentAnimName && currentAnimName !== IDLE_MAIN) {
        if (group.indexOf(currentAnimName) >= 0) return
        // 工作/聊天动画是"常驻状态动画"，mood 变化时可切换（如 work-code → drag-carry 拖拽）；
        // 其余（点击回应/彩蛋/吃饭/拖拽/位置动画）锁期内保持，播完才按 mood 切换。
        const isStateAnim = ANIM_GROUPS.working.indexOf(currentAnimName) >= 0 ||
          ANIM_GROUPS.chatting.indexOf(currentAnimName) >= 0
        if (!isStateAnim) return
      }
      name = window.BehaviorDirector.pickStateAnimation(mood, {
        groups: ANIM_GROUPS, random: Math.random, idleMain: IDLE_MAIN,
        previous: currentAnimName, waiting: !!pendingInter, organizing: !!R.preparingReport
      })
    }
    window.BehaviorDirector.setCurrent(mood)
    const cycle = mood !== 'idle' && mood !== 'carried' && group.length > 1
    if (cycle) playStateCycle(name, mood)
    else showAnim(name)
  }

  function playStateCycle(name, mood) {
    showAnim(name, 0, () => {
      animLockUntil = 0
      const previous = currentAnimName
      currentAnimName = null
      if (effectiveAnimationMood() !== mood || R.hidden || R.dragging) { updateMood(); return }
      playStateCycle(window.BehaviorDirector.pickStateAnimation(mood, { groups: ANIM_GROUPS, previous, waiting: !!pendingInter, organizing: !!R.preparingReport }), mood)
    }, { source: mood === 'working' ? 'work' : 'needs', priority: mood === 'working' ? 50 : 30, interruptible: true })
  }

  function effectiveAnimationMood() {
    if (R.dragging) return 'carried'
    if (R.sleepy) return 'sleepy'
    if (R.running || pendingInter || R.preparingReport) return 'working'
    if (chatBusy || charcBusy) return 'chatting'
    const life = window.PetLife && window.PetLife.context(Date.now())
    if (life && life.livingState && life.livingState.resting) return 'sleepy'
    if (R.mood !== 'idle') return R.mood
    if (P.stats.thirst < 30) return 'thirsty'
    if (P.stats.energy < 25) return 'tired'
    if (P.stats.satiety < 30) return 'hungry'
    if (P.stats.mood < 30) return 'sad'
    return 'idle'
  }

  let pendingIdleTimer = null

  function updateMood() {
    // 拖拽（R.dragging）优先级最高：用户物理拖拽时即使 agent 在运行（R.running）
    // 也必须立刻播 drag-carry——否则拖拽中动画不变（"拖拽不跟手"）。
    const m = effectiveAnimationMood()
    petEl.className = 'dp-pet' + (m && m !== 'idle' ? ' dp-m-' + m : '')
    // 工作态防抖：agent 回合间 running 状态可能高频翻转，从 working 退 idle 延迟 5s
    // （期间又变回工作则取消），避免思考动画与待机动画疯狂切换
    if (m === 'idle' && currentAnimName && ANIM_GROUPS.working.indexOf(currentAnimName) >= 0) {
      if (!pendingIdleTimer) {
        pendingIdleTimer = setTimeout(() => {
          pendingIdleTimer = null
          playAnim('idle')
        }, 5000)
      }
      return
    }
    if (pendingIdleTimer) { clearTimeout(pendingIdleTimer); pendingIdleTimer = null }
    playAnim(m)
  }

  function sleepNow() {
    if (R.sleepy) return
    R.sleepy = true
    setMood('sleepy')
    if (zzzTimer) clearTimeout(zzzTimer)
    zzzTimer = setTimeout(wakeUp, 10000)
  }

  function wakeUp() {
    R.sleepy = false
    if (zzzTimer) { clearTimeout(zzzTimer); zzzTimer = null }
    setMood('idle')
    // Waking is expressed by the animation. It is not a reason to interrupt.
  }

  // 台词分组元信息（管理 UI 用）：官方组名 + 显示名 + 图标
  const LINE_GROUPS = [
    { key: 'idle', name: '待机', icon: '🌊' },
    { key: 'hungry', name: '饥饿', icon: '🍽️' },
    { key: 'thirsty', name: '口渴', icon: '💧' },
    { key: 'sad', name: '难过', icon: '💧' },
    { key: 'eat', name: '进食', icon: '🍚' },
    { key: 'wake', name: '起床', icon: '🌅' },
    { key: 'happy', name: '开心', icon: '😊' },
    { key: 'birthday', name: '生日', icon: '🎂' },
  ]
  const OFFICIAL_GROUPS = new Set(LINE_GROUPS.map((g) => g.key))

  // 组是否启用（用户可在台词管理面板/托盘开关）
  function groupEnabled(key) {
    return P.disabledGroups.indexOf(key) < 0
  }

  // 取某组可用的全部台词（P.lines 覆盖表有就用它=完全用户控制；否则官方；未启用返回空）
  function linesForGroup(key) {
    if (!groupEnabled(key)) return []
    let arr = []
    if (P.lines && P.lines[key] && Array.isArray(P.lines[key]) && P.lines[key].length) arr = P.lines[key]
    else {
      const official = LINES[key] || []
      const custom = P.customLines.filter((l) => l.group === key).map((l) => l.text)
      arr = official.concat(custom)
    }
    return arr.filter((text) => !isInternalUiText(text))
  }

  function currentLines() {
    // 状态优先级：口渴 → 饿 → 难过 → 待机（心情高时混入开心组，不独占——保证老台词正常弹出）
    if (P.stats.thirst < 30) {
      const t = linesForGroup('thirsty')
      if (t.length) return t
    }
    if (P.stats.satiety < 30) {
      const h = linesForGroup('hungry')
      if (h.length) return h
    }
    if (P.stats.mood < 30) {
      const s = linesForGroup('sad')
      if (s.length) return s
    }
    // 官方生日当天：生日台词混入待机池最前，频率更高但不独占
    if (isPetBirthday) {
      const b = linesForGroup('birthday')
      if (b.length) return b.concat(linesForGroup('idle'))
    }
    const idle = linesForGroup('idle')
    const happy = P.stats.mood >= 75 ? linesForGroup('happy') : []
    return idle.concat(happy)
  }

  /* ---------- care / shop ---------- */

  function setBar(key, val) {
    $('bar-' + key).style.width = Math.round(val) + '%'
    $('val-' + key).textContent = String(Math.round(val))
  }

  /* ---------- 养成 A/B/D：好感度 / 每日任务签到 / 随机事件 ---------- */

  const AFF_LEVELS = window.NurtureRules.AFF_LEVELS

  function affInfo() {
    let cur = AFF_LEVELS[0]
    for (const l of AFF_LEVELS) if (P.affection >= l.min) cur = l
    return cur
  }

  function addAffection(n) {
    if (window.pet.character?.authority) return
    const before = affInfo().name
    if (window.RelationshipEngine) {
      window.RelationshipEngine.addAffection(P, n, { source: 'pet-legacy', kind: 'legacy_affection', ruleId: 'REL-LEGACY-AFFECTION' })
    }
    const after = affInfo().name
    if (before !== after) {
      say('好感度提升：' + before + ' → ' + after + ' 💗 关系更进一步啦！', 5000, 'ui')
      unlockPhoto('surprise-gift')
    }
    renderCare()
    saveState()
  }

  // 每日任务：聊天 / 玩游戏 / 喂食 / 完成工作（每日重置）
  function dailyKey() {
    const d = new Date()
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function ensureDaily() {
    if (window.pet.character?.authority) return
    const k = dailyKey()
    if (P.daily.date !== k) {
      P.daily = {
        date: k,
        tasks: [
          { id: 'chat', label: '💬 和' + petName() + '聊一句天', done: false },
          { id: 'game', label: '🎮 玩一局小游戏', done: false },
          { id: 'work', label: '📋 完成一次工作', done: false },
        ],
        signStreak: P.daily && P.daily.signStreak || 0,
        lastSign: P.daily && P.daily.lastSign || '',
      }
      // 自动签到：新的一天自动完成签到（无需手动按钮）
      const y = new Date()
      y.setDate(y.getDate() - 1)
      const yKey = y.getFullYear() + '-' + (y.getMonth() + 1) + '-' + y.getDate()
      P.daily.signStreak = (P.daily.lastSign === yKey ? P.daily.signStreak : 0) + 1
      P.daily.lastSign = k
      const reward = Math.min(5 + P.daily.signStreak * 5, 50)
      P.coins += reward
      saveState()
      updateCoins()
      // 静默签到提示（不打断界面）
      setTimeout(() => {
        say('☀️ 自动签到成功！连续 ' + P.daily.signStreak + ' 天，+🪙 ' + reward + ' 🎉', 5000, 'ui')
      }, 2000)
    }
  }

  function markDaily(id) {
    if (window.pet.character?.authority) return
    ensureDaily()
    const t = P.daily.tasks.find((x) => x.id === id)
    if (!t || t.done) return
    t.done = true
    saveState()
    if (P.daily.tasks.every((x) => x.done)) {
      P.coins += 10
      saveState()
      updateCoins()
      say('今日互动任务全部完成！奖励 +🪙 10', 5000, 'ui')
      addAffection(1)
      unlockPhoto('daily-summary')
    }
  }

  function renderDaily() {
    // 每日任务已隐藏（自动签到替代），此函数保留兼容旧调用
    if (!$('daily-progress')) return
    ensureDaily()
    const done = P.daily.tasks.filter((t) => t.done).length
    $('daily-progress').textContent = done + '/' + P.daily.tasks.length
    const wrap = $('daily-list')
    wrap.innerHTML = ''
    P.daily.tasks.forEach((t) => {
      const row = document.createElement('div')
      row.className = 'dp-inv-row'
      const label = document.createElement('span')
      label.textContent = (t.done ? '✅ ' : '⬜ ') + t.label
      row.appendChild(label)
      wrap.appendChild(row)
    })
    $('sign-streak').textContent = String(P.daily.signStreak)
  }

  function signIn() {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'sign' })
    ensureDaily()
    const k = dailyKey()
    if (P.daily.lastSign === k) { say('今天已经签过到啦，明天再来～', undefined, 'ui'); return }
    // 连续签到：昨天签过 → +1；断签重置
    const y = new Date()
    y.setDate(y.getDate() - 1)
    const yKey = y.getFullYear() + '-' + (y.getMonth() + 1) + '-' + y.getDate()
    P.daily.signStreak = (P.daily.lastSign === yKey ? P.daily.signStreak : 0) + 1
    P.daily.lastSign = k
    const reward = Math.min(5 + P.daily.signStreak * 5, 50)
    P.coins += reward
    saveState()
    updateCoins()
    renderDaily()
    say('签到成功！连续 ' + P.daily.signStreak + ' 天，+🪙 ' + reward + ' 🎉', 5000, 'ui')
    addAffection(1)
  }

  /* Lv.8 之后：原来 exp 继续涨但完全没用。
     现在把"超出满级门槛的那部分经验"转成**深海徽章的进度**（每 500 点一枚，无上限），
     并在成长区显示进度 —— 满级仍是成就体系的一部分，但成长曲线不再断掉。
     注意：本段必须在 renderCare() 之前（renderCare 会调用它们）。 */
  const LEVEL_CAP_EXP = 1800 // = LEVELS[LEVELS.length-1].exp（Lv.8 门槛）
  const PRESTIGE_PER_BADGE = 500
  function prestigeOf(exp) {
    const over = Math.max(0, (Number(exp) || 0) - LEVEL_CAP_EXP)
    return { over, badges: Math.floor(over / PRESTIGE_PER_BADGE), into: over % PRESTIGE_PER_BADGE, need: PRESTIGE_PER_BADGE }
  }

  function renderCare() {
    setBar('satiety', P.stats.satiety)
    setBar('mood', P.stats.mood)
    setBar('energy', P.stats.energy)
    setBar('thirst', P.stats.thirst == null ? 85 : P.stats.thirst)
    // 好感度条
    setBar('aff', P.affection)
    $('aff-badge').textContent = affInfo().name
    $('val-aff').textContent = Math.round(P.affection) + '/100'
    // 陪伴天数
    const cd = $('companion-days')
    if (cd) cd.textContent = '☀️ ' + P.name + ' 已陪伴你 ' + (P.streak || 1) + ' 天'
    const inv = $('inventory')
    inv.innerHTML = ''
    let any = false
    Object.keys(ITEMS).forEach((key) => {
      const n = P.inventory[key] || 0
      if (n <= 0) return
      any = true
      const it = ITEMS[key]
      const row = document.createElement('div')
      row.className = 'dp-inv-row'
      const label = document.createElement('span')
      label.textContent = it.icon + ' ' + it.name + ' ×' + n
      const btn = document.createElement('button')
      btn.className = 'dp-mini-btn'
      btn.textContent = '使用'
      btn.addEventListener('click', () => useItem(key))
      row.appendChild(label)
      row.appendChild(btn)
      inv.appendChild(row)
    })
    if (!any) inv.innerHTML = '<div class="dp-muted">背包空空如也，去 🏪 商店逛逛吧</div>'
    const metaParts = ['完成工作 ' + P.totalWorkDone + ' 次', '游戏 ' + P.totalGames + ' 局', '最高分 ' + P.bestGameScore]
    $('care-meta').textContent = metaParts.join(' · ')
    const info = levelInfo(P.exp)
    $('level-badge').textContent = 'Lv.' + info.lv + ' · ' + info.title
    const barExp = $('bar-exp')
    const valExp = $('val-exp')
    if (info.next) {
      const span = info.next - info.cur
      barExp.style.width = clamp(Math.round(((P.exp - info.cur) / span) * 100), 0, 100) + '%'
      valExp.textContent = P.exp + '/' + info.next
    } else {
      barExp.style.width = '100%'
      /* 满级后不再只显示"MAX"：显示深海徽章进度（每 500 点一枚），成长曲线继续往下走 */
      const pre = prestigeOf(P.exp)
      valExp.textContent = 'MAX · 深海徽章 ×' + pre.badges + '（' + pre.into + '/' + pre.need + '）'
    }
    renderAchievements()
    updateMood()
  }

  /* ---------- 等级 / 成就 ---------- */

  function levelInfo(exp) {
    let lv = 1
    for (let i = 0; i < LEVELS.length; i++) {
      if (exp >= LEVELS[i].exp) lv = i + 1
    }
    const cur = LEVELS[lv - 1]
    const next = LEVELS[lv] || null
    return { lv, title: cur.title, cur: cur.exp, next: next ? next.exp : null }
  }

  /* 升级奖励：此前升级只有一句气泡+音效（`addHearts` 早已被禁用的空壳）。
     口径：奖励按"跨过的每一级"发放，避免一次掉很多经验时只算一级。
     数值刻意小（不破坏既有经济）：金币 = 10 + 等级×5（Lv.2=20 … Lv.8=50），心情 +6 封顶 100。 */
  function applyLevelUpRewards(fromLv, toLv) {
    let coins = 0
    for (let lv = fromLv + 1; lv <= toLv; lv++) coins += 10 + lv * 5
    if (coins > 0) P.coins += coins
    P.stats.mood = clamp((P.stats.mood || 0) + 6, 0, 100)
    return coins
  }

  function gainExp(n) {
    if (window.pet.character?.authority) return
    const before = P.level
    P.exp += n
    const info = levelInfo(P.exp)
    let coins = 0
    if (info.lv > before) {
      P.level = info.lv
      coins = applyLevelUpRewards(before, info.lv)
      const pre = prestigeOf(P.exp)
      const extra = coins > 0 ? ('　+🪙' + coins) : ''
      say('🎉 升级啦！Lv.' + P.level + ' · ' + info.title + extra + (pre.badges > 0 ? '　深海徽章 ×' + pre.badges : ''), 5000, 'ui')
      playDing('achievement')
    }
    saveState()
    renderCare()
    checkAchievements()
  }

  function checkAchievements() {
    if (window.pet.character?.authority) return renderAchievements()
    ACHIEVEMENTS.forEach((a) => {
      if (P.achievements.includes(a.id)) return
      if (!a.check(P)) return
      P.achievements.push(a.id)
      saveState()
      say('🏅 成就解锁：' + a.icon + ' ' + a.name, 4500, 'ui')
      playDing('achievement')
    })
    renderAchievements()
  }

  /* ---------- 相册：照片解锁 + 卡片提醒 ---------- */

  let photoCardTimer = null

  function hidePhotoCard() {
    const card = $('photo-card')
    if (card) card.classList.add('hidden')
    if (photoCardTimer) clearTimeout(photoCardTimer)
    photoCardTimer = null
  }

  // 相册卡片提醒：浮动照片卡片（缩略图 + 名称 + 描述），自动消失，可点击关闭
  function showPhotoCard(photo) {
    if (!photo) return
    if (R.chatOpen) { say('📷 已解锁「' + photo.name + '」，可以在相册查看～', 3000, 'ui'); return }
    // 复用/替换已有卡片
    let card = $('photo-card')
    if (!card) {
      card = document.createElement('div')
      card.id = 'photo-card'
      petArea.appendChild(card)
      card.addEventListener('click', (e) => {
        e.stopPropagation()
        hidePhotoCard()
      })
    }
    card.innerHTML = ''
    const close = document.createElement('button')
    close.type = 'button'; close.className = 'dp-photo-card-close'; close.textContent = '×'
    close.title = '关闭照片提醒'; close.setAttribute('aria-label', '关闭照片提醒')
    card.appendChild(close)
    const title = document.createElement('div')
    title.className = 'dp-photo-card-title'
    title.textContent = '📷 解锁照片：「' + photo.name + '」'
    const img = document.createElement('img')
    img.className = 'dp-photo-card-img'
    img.src = 'photos/' + photo.id + '.webp'
    img.draggable = false
    img.addEventListener('dragstart', (e) => e.preventDefault())
    img.onerror = () => { img.style.display = 'none' } // 缺图时只显示文字
    const desc = document.createElement('div')
    desc.className = 'dp-photo-card-desc'
    desc.textContent = photo.desc || ''
    card.appendChild(title)
    card.appendChild(img)
    card.appendChild(desc)
    card.classList.remove('hidden')
    if (photoCardTimer) clearTimeout(photoCardTimer)
    photoCardTimer = setTimeout(hidePhotoCard, 6000)
    playDing('achievement')
  }

  // 解锁一张照片（事件型：首次启动/喂食/游戏等函数里主动调用）
  function unlockPhoto(id) {
    if (window.pet.character?.authority) return
    const p = PHOTOS.find((x) => x.id === id)
    if (!p) return
    if (P.photos[id]) return
    P.photos[id] = { ts: Date.now() }
    saveState()
    showPhotoCard(p)
  }

  // 扫描解锁（数值型/时间型：在 saveState 前后重要的状态检查点调用）
  function checkPhotoUnlocks() {
    if (window.pet.character?.authority) return
    // 每日事件（电脑常开不重启也生效）：每天第一次扫描 = 新的一天
    // - 更新连续天数（streak）
    // - 解锁"早安第一眼"
    // - 重置每日任务
    updateStreak()
    ensureDaily()
    const mf = P.photos['morning-first']
    // 早安第一眼：每天第一次扫描刷新为今天（unlockPhoto 对已存在照片不更新 ts，需直接改）
    if ((!mf || dayKey(new Date(mf.ts)) !== dayKey(new Date())) && P.bootCount > 0) {
      const isNew = !mf
      P.photos['morning-first'] = { ts: Date.now() }
      if (isNew) {
        saveState()
        showPhotoCard(PHOTOS.find((x) => x.id === 'morning-first'))
      }
    }
    const now = new Date()
    const h = now.getHours()
    PHOTOS.forEach((p) => {
      if (P.photos[p.id]) return
      let ok = false
      if (p.event) {
        // 事件型由 unlockPhoto 主动触发，此处跳过
        return
      } else if (p.check) {
        ok = p.check(P)
      } else if (p.time) {
        const [a, b] = p.time
        ok = (h >= a && h < b) || (a > b && (h >= a || h < b)) // 支持跨天区间（如 22~24 无跨天；0~4 跨天）
      }
      if (ok) {
        P.photos[p.id] = { ts: Date.now() }
        saveState()
        showPhotoCard(p)
      }
    })
  }

  // 游戏胜局/事件计数：游戏相关函数里手动 markGameWin()（供 check 型照片）
  function markGameWin() { /* 供未来 game-win 计数，暂时只依赖 totalGames */ }

  // 记录游戏胜利（照片补发用：gameWins 供 check 型照片回溯历史）
  function markGameWin2(game) {
    if (window.pet.character?.authority) return
    if (P.gameWins.indexOf(game) < 0) {
      P.gameWins.push(game)
      saveState()
    }
    diaryEvent('game', game)
  }

  function updateStreak() {
    const today = dayKey(new Date())
    if (P.lastSeenDate === today) return
    const y = new Date()
    y.setDate(y.getDate() - 1)
    P.streak = P.lastSeenDate === dayKey(y) ? P.streak + 1 : 1
    P.lastSeenDate = today
    saveState()
    checkAchievements()
  }

  function renderAchievements() {
    // 成就已迁移到托盘独立窗口（achievements.html），此函数保留供 checkAchievements 调用计数
    const wrap = $('ach-list')
    if (!wrap) return
    wrap.innerHTML = ''
    ACHIEVEMENTS.forEach((a) => {
      const un = !P.achievements.includes(a.id)
      const el = document.createElement('div')
      el.className = 'dp-ach' + (un ? ' dp-ach-lock' : '')
      el.title = a.name + '：' + a.desc
      el.textContent = a.icon
      wrap.appendChild(el)
    })
    if ($('ach-count')) $('ach-count').textContent = P.achievements.length + '/' + ACHIEVEMENTS.length
  }

  /* ---------- 备忘录 ---------- */

  function addMemo(text) {
    if (!text || !String(text).trim()) return false
    P.memos.push({ id: ++uid, text: String(text).trim(), ts: Date.now() })
    saveState()
    renderMemos()
    unlockPhoto('remember-me')
    diaryEvent('memo', String(text).trim().slice(0, 60))
    return true
  }

  function renderMemos() {
    const wrap = $('memo-list')
    if (!wrap) return
    wrap.innerHTML = ''
    if (!P.memos.length) {
      wrap.innerHTML = '<div class="dp-muted">还没有备忘录</div>'
      return
    }
    ;[...P.memos].reverse().forEach((m) => {
      const row = document.createElement('div')
      row.className = 'dp-inv-row'
      const label = document.createElement('span')
      label.style.whiteSpace = 'pre-wrap'
      label.style.wordBreak = 'break-word'
      label.textContent = m.text.length > 80 ? m.text.slice(0, 80) + '…' : m.text
      const del = document.createElement('button')
      del.className = 'dp-mini-btn'
      del.textContent = '✕'
      del.addEventListener('click', () => {
        P.memos = P.memos.filter((x) => x.id !== m.id)
        saveState()
        renderMemos()
      })
      row.appendChild(label)
      row.appendChild(del)
      wrap.appendChild(row)
    })
  }

  /* ---------- 每日日记 ---------- */

  let diaryOn = false // 渲染层缓存的日记开关（主进程持久化）

  // 桌宠事件入流：聊天/喂食/游戏/工作/备忘/主人标记 → 主进程 events（日记素材）
  // P3：meta 为可选可溯源信息（感知通道用 {eventId, observationId, kind, cat}）
  function diaryEvent(kind, text, meta) {
    if (!diaryOn) return { ok: false, reason: 'diary_off' }
    if (window.pet && window.pet.diaryEvent) {
      try {
        window.pet.diaryEvent(kind, String(text || '').slice(0, 80), meta || null)
        return { ok: true }
      } catch (err) { return { ok: false, reason: 'ipc_error' } }
    }
    return { ok: false, reason: 'no_api' }
  }

  function eventLabel(kind, text) {
    const t = text || ''
    if (kind === 'chat') return '主人跟我说：「' + t + '」'
    if (kind === 'task_request') return '主人给我派了一个任务：「' + t + '」（请求，不代表已经完成）'
    if (kind === 'feed') return '主人喂我吃了「' + t + '」'
    if (kind === 'game') return '主人陪我玩了一局' + (t || '小游戏')
    if (kind === 'work') return '我完成了桌宠工作「' + t + '」'
    if (kind === 'pomo') return '主人专注了一轮番茄钟'
    if (kind === 'memo') return '主人记了备忘：' + t
    if (kind === 'praise') return '主人夸了我'
    if (kind === 'pin') return '📌 主人特意标记想记住：' + t
    return t || kind
  }

  // Reflection 输出解析：宽容提取 JSON（重试一次仍失败则回退单步）
  function parseReflection(s) {
    if (!s || typeof s !== 'string') return null
    const m = s.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { return JSON.parse(m[0]) } catch (err) { return null }
  }

  let forgetArmed = false
  let lastShownMemory = null

  function updateDiaryUI() {
    const cb = $('diary-enabled'); if (cb) cb.checked = diaryOn
    const t = $('diary-time'); if (t) t.disabled = !diaryOn
    const b = $('btn-diary-now'); if (b) { b.disabled = !diaryOn || R.writingDiary; b.textContent = R.writingDiary ? '✍️ 正在写…' : '✍️ 立即写' }
    renderDiary()
  }

  function initDiaryState() {
    if (window.pet && window.pet.diaryEnabled) {
      window.pet.diaryEnabled().then((r) => {
        diaryOn = !!(r && r.enabled)
        updateDiaryUI()
        maybeWriteDiary()
      }).catch(() => { updateDiaryUI(); maybeWriteDiary() })
    } else {
      diaryOn = true
      updateDiaryUI()
      maybeWriteDiary()
    }
  }

  // 官方桌宠生日：7月17日（不显示，但当天有表现：专属台词/事件/数值加成/特殊日记）
  const PET_BIRTHDAY = { month: 7, day: 17 }
  let isPetBirthday = false // 当天为 true，渲染层多处判断用
  function checkPetBirthday() {
    const now = new Date()
    isPetBirthday = now.getMonth() + 1 === PET_BIRTHDAY.month && now.getDate() === PET_BIRTHDAY.day
    return isPetBirthday
  }

  function ensureDaySnapshot(execution) {
    const today = dayKey(new Date())
    if (!P.daySnapshot || P.daySnapshot.date !== today) {
      P.daySnapshot = { date: today, work: P.totalWorkDone, games: P.totalGames, pomos: P.pomodoros, feeds: P.feedCount }
    }
    // 官方生日（7月17日）：当天祝福一次 + 数值加成 + 专属台词
    checkPetBirthday()
    if (isPetBirthday && P.lastPetBirthdayGreeted !== today) {
      if (!roleRuntime.isAuthorized(execution)) { void runtimeNotify(permit => { ensureDaySnapshot(permit); return { ok: true } }, 'pet-birthday:' + today); return }
      P.lastPetBirthdayGreeted = today
      P.stats.mood = clamp(P.stats.mood + 15, 0, 100)
      P.stats.energy = clamp(P.stats.energy + 10, 0, 100)
      addAffection(5)
      P.coins += 20
      saveState()
      renderCare()
      updateCoins()
      setTimeout(() => {
        say('🎂 今天是 7月17日，我的生日！心情 +15、精力 +10、好感 +5，还有 🪙×20 压岁钱～', 8000, 'ui')
      }, 1500)
      unlockPhoto('pet-birthday')
    }
    // 生日彩蛋：设置了生日且今天未祝福过 → 祝福一次
    if (P.ownerBirthday && P.lastBirthdayGreeted !== today) {
      const now = new Date()
      const bd = P.ownerBirthday.split('-').map(Number)
      if (now.getMonth() + 1 === bd[1] && now.getDate() === bd[2]) {
        if (!roleRuntime.isAuthorized(execution)) { void runtimeNotify(permit => { ensureDaySnapshot(permit); return { ok: true } }, 'owner-birthday:' + today); return }
        P.lastBirthdayGreeted = today
        P.coins += 30
        P.stats.mood = clamp(P.stats.mood + 10, 0, 100)
        addAffection(5)
        // 生成并保存今年的贺卡（可随时在贺卡窗口回看历史）
        try {
          if (window.__BIRTHDAY_CARD && !P.birthdayCards.some((c) => c.date === today)) {
            P.birthdayCards.push(window.__BIRTHDAY_CARD.makeCard(P, today))
          }
        } catch (err) { /* 生成失败不阻塞祝福 */ }
        saveState()
        renderCare()
        updateCoins()
        showBirthdayCard(execution)
        unlockPhoto('owner-birthday')
      } else {
        // 非生日当天，确保明天还会检查
        P.lastBirthdayGreeted = ''
      }
    }
  }

  // 用户生日祝福卡（渲染层交互卡，点「查收」打开独立贺卡窗口）：
  // 桌宠窗口是 transparent+frame:false，主进程 dialog 会挂起，所以自绘卡片，且必须点按钮才消失
  function showBirthdayCard(execution) {
    if (!roleRuntime.isAuthorized(execution)) { void runtimeNotify(permit => showBirthdayCard(permit), "birthday-card"); return }
    const busy = bubbleEl.dataset.report === '1' || !!bubbleEl.dataset.remind || !!bubbleEl.dataset.inter ||
      bubbleEl.dataset.chatReply === '1' || bubbleEl.dataset.thinking === '1'
    if (busy) {
      // 被其他卡占用：压入队列，稍后自动补发
      setTimeout(() => showBirthdayCard(), 30000)
      return
    }
    bubbleEl.innerHTML = ''
    bubbleEl.dataset.report = ''
    bubbleEl.className = 'dp-bubble dp-bubble-interaction'
    stage.classList.add('dp-busy-bubble')
    const title = document.createElement('div')
    title.className = 'dp-bubble-report-title'
    title.textContent = '💌 生日快乐，' + (P.ownerName || '主人') + '！'
    const body = document.createElement('div')
    body.className = 'dp-bubble-report-body'
    body.textContent = petName() + '给你写了一封生日贺卡（好感度加成 +🪙30 已到账）\n点「查收」打开看看吧～'
    const foot = document.createElement('div')
    foot.className = 'dp-inter-foot'
    const openBtn = document.createElement('button')
    openBtn.className = 'dp-mini-btn'
    openBtn.textContent = '💌 查收贺卡'
    openBtn.addEventListener('click', () => {
      try { window.pet.birthdayCardOpen() } catch (err) { /* 忽略 */ }
      bubbleEl.classList.add('hidden')
      bubbleEl.innerHTML = ''
      bubbleEl.className = 'dp-bubble'
      stage.classList.remove('dp-busy-bubble')
    })
    foot.appendChild(openBtn)
    bubbleEl.appendChild(title)
    bubbleEl.appendChild(body)
    bubbleEl.appendChild(foot)
    bubbleEl.classList.remove('hidden')
  }

  /* ---------- 久别重逢：上次退出 ≥1 个自然日，弹重逢气泡（每天最多一次） ---------- */

  const REUNION_LINES = [
    // 思念系
    '主人，好久不见…你不在的这些天，我把桌面擦了又擦，等你回来。',
    '这么久没见，我以为你把我忘在桌面上了。想你了，真的。',
    '你离开的第 N 天，我每天都会看看桌面上有没有你的影子。欢迎回家。',
    '主、主人！你终于回来了…我还以为你换了个桌面，把我落下了。',
    // 开心系
    '主人回来啦！我就知道你会回来的，尾巴都开心得翘起来了～',
    '哇，是主人！好久没见，快让我看看你有没有瘦！',
    '欢迎回家！虽然你不在的日子我有点寂寞，但你现在回来了，一切就都值了！',
    '主人主人！你不在的这几天我攒了好多话想跟你说呢！',
  ]

  function checkReunion() {
    if (!P.lastExitTime) return
    const today = dayKey(new Date())
    if (P.lastReunionDate === today || dayKey(new Date(P.lastExitTime)) === today) return
    void runtimeNotify(execution => {
      const n = Math.max(1, Math.round((Date.now() - P.lastExitTime) / 86400000))
      const result = say(pick(REUNION_LINES).replace('第 N 天', '第 ' + n + ' 天'), 8000, 'ui', undefined, execution)
      if (result.ok && result.displayed) { P.lastReunionDate = today; saveState(); unlockPhoto('reunion-moment') }
      return result
    }, 'reunion:' + today)
  }

  /* 日记素材文本。
     原来直接喂"喂食了 8 次 / 完成了 1 项工作"这类**计数句**，AI 会原样复述
     （实测有 58 字、含"喂食 8 次。"无主语残句的成篇）。现在：
       · 仍带准确数字（日记需要事实依据），但措辞更口语、更像"发生了一件事"；
       · 素材仍以"事件"为单位，AI 可以自由组织语言，不必照抄句式。 */
  function diaryCountEvents(counts) {
    const list = []
    if (counts.work > 0) list.push({ kind: 'work', text: counts.work === 1 ? '今天陪主人做完了一件工作' : '今天陪主人做完了 ' + counts.work + ' 件工作' })
    if (counts.games > 0) list.push({ kind: 'game', text: counts.games === 1 ? '和主人玩了一局小游戏' : '和主人玩了 ' + counts.games + ' 局小游戏' })
    if (counts.feeds > 0) list.push({ kind: 'feed', text: counts.feeds === 1 ? '今天被喂了一次' : '今天被喂了 ' + counts.feeds + ' 次' })
    if (counts.pomos > 0) list.push({ kind: 'pomo', text: counts.pomos === 1 ? '陪着做完了一个番茄钟' : '陪着做完了 ' + counts.pomos + ' 个番茄钟' })
    return list
  }

  // Counters and diary events share the same calendar day. Recover a saved
  // daySnapshot on upgrade so earlier actions today remain available.
  function ensureDiaryBase() {
    let key = null
    try {
      if (window.DiaryEngine && typeof window.DiaryEngine.resolveDiaryDay === 'function') {
        const r = window.DiaryEngine.resolveDiaryDay(Date.now(), P.diaryTime || '23:00')
        key = (r && r.diaryDay) || null
      }
    } catch (err) { /* 引擎不可用则退回日历日 */ }
    if (!key) key = dayKey(new Date())
    const b = P.diaryBase
    if (!b || b.date !== key || b.daySchemaVersion !== 2) {
      const daily = P.daySnapshot && P.daySnapshot.date === key ? P.daySnapshot : null
      const baseline = (field, total) => daily && Number.isFinite(daily[field]) ? daily[field] : Number(total) || 0
      P.diaryBase = {
        date: key,
        daySchemaVersion: 2,
        work: baseline('work', P.totalWorkDone),
        games: baseline('games', P.totalGames),
        pomos: baseline('pomos', P.pomodoros),
        feeds: baseline('feeds', P.feedCount),
      }
      try { saveState() } catch (err) { /* 非致命 */ }
    }
    return P.diaryBase
  }

  function todayCounts() {
    ensureDaySnapshot() // 兼容旧字段（部分界面/逻辑仍在读）
    const b = ensureDiaryBase()
    return {
      work: Math.max(0, (P.totalWorkDone || 0) - b.work),
      games: Math.max(0, (P.totalGames || 0) - b.games),
      pomos: Math.max(0, (P.pomodoros || 0) - b.pomos),
      feeds: Math.max(0, (P.feedCount || 0) - b.feeds),
    }
  }

  function diaryOutputForDay(day) {
    if (!Array.isArray(P.diaryOutputs)) return null
    return P.diaryOutputs.find((o) => o && (o.diaryDay === day || (o.calendarContext && o.calendarContext.date === day))) || null
  }

  function diaryExists(today) {
    if (P.diary.some((d) => d.date === today)) return true
    return !!diaryOutputForDay(today)
  }

  // A4：真实并发保护是 per-DiaryDay 的 diaryWriteInFlight。
  // 同一 DiaryDay 的并发写共享同一 Promise；不同 DiaryDay 互不阻塞。
  // R.writingDiary 仅作为兼容/诊断状态，不再作为守卫依据。
  const diaryWriteInFlight = new Map() // diaryDay -> Promise
  let diaryLastResult = null
  let diarySaveQueue = Promise.resolve()

  function saveDiaryOutput(output) {
    const job = diarySaveQueue.then(async () => {
      const previous = Array.isArray(P.diaryOutputs) ? P.diaryOutputs.slice() : []
      P.diaryOutputs = previous.filter(x => x && x.diaryDay !== output.diaryDay).concat([output])
      P.diaryOutputs.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))
      const trimmed = P.diaryOutputs.splice(0, Math.max(0, P.diaryOutputs.length - 180))
      try {
        if (await saveState() !== true) throw new Error('write_failed')
      } catch (err) { P.diaryOutputs = previous; throw err }
      for (const old of trimmed) console.log('[diary] trimmed oldest (cap 180):', old.diaryId)
      return true
    })
    diarySaveQueue = job.catch(() => {})
    return job
  }

  function diaryResultMessage(result) {
    if (!result) return ''
    const messages = {
      'no-material': '今天的素材还不够，先不编写日记；多互动后可再试。',
      'daily_ai_limit': result.output ? '这一天的 AI 写作次数已用完，原篇已保留。' : '这一天的 AI 写作次数已用完，可点立即写保存本地日记。',
      'write_failed': '日记保存失败，原篇和本次草稿已保留，点立即写重试保存。',
      'cancelled': '本次写日记已取消。',
      'error': '这次没能写好，原有日记已保留，请稍后重试。'
    }
    return messages[result.reason] || ''
  }

  function diaryWriteWindowLabel() {
    const r = window.DiaryDay.resolve(Date.now(), P.diaryTime || '23:00')
    return r.diaryTime + '～当天结束前'
  }

  /* ===== P1-3/D2：日记素材派生（纯函数，设计细化③ 三件套）=====
   timeline.segments/events → [{ref, at, kind, text}]；ref 用既有命名空间（f:activity.segment:<startTs> /
   tl:event:<ts>，可在 timeline 反查）；events 的 label 复用 eventLabel（死代码接线）；
   优先保留主人对话/标记，再按最近优先截断 ≤12 条/≤1200 字，truncated 标志。零新存储、零 AI 调用点。 */
  /* P1MARK-START */
  function diaryMaterialFromTimeline(timeline, nowTs) {
    const out = []
    try {
      const t = (timeline && typeof timeline === 'object') ? timeline : null
      const segs = (t && Array.isArray(t.segments)) ? t.segments : []
      for (let i = segs.length - 1; i >= 0 && out.length < 24; i--) {
        const s = segs[i]
        if (!s || typeof s.app !== 'string' || !s.app) continue
        const start = Date.parse(s.start)
        if (!Number.isFinite(start)) continue
        const end = Date.parse(s.end) || start
        const mins = Math.max(1, Math.round((end - start) / 60000))
        out.push({ ref: 'f:activity.segment:' + start, at: start, kind: 'segment', text: s.app + '上待了约 ' + mins + ' 分钟' })
      }
      const evs = (t && Array.isArray(t.events)) ? t.events : []
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i]
        if (!e) continue
        const ts = Number(e.ts) || Date.parse(e.at) || 0
        if (!ts) continue
        out.push({ ref: 'tl:event:' + ts, at: ts, kind: String(e.kind || 'event'), text: eventLabel(e.kind, e.text || e.label || '') })
      }
    } catch (err) { /* 取不到 ⇒ 空素材（不伪造） */ }
    const priority = m => ['chat', 'pin', 'praise', 'relationship', 'important'].includes(m.kind) ? 2 : m.kind === 'segment' ? 0 : 1
    out.sort((a, b) => priority(b) - priority(a) || (Number(b.at) || 0) - (Number(a.at) || 0))
    const CAP_N = 12
    const truncated = out.length > CAP_N
    const picked = out.slice(0, CAP_N)
    let budget = 1200
    const kept = []
    for (const m of picked) {
      if (budget - m.text.length < 0) break
      budget -= m.text.length
      kept.push(m)
    }
    return { material: kept, truncated: truncated || kept.length < picked.length }
  }
  /* P1MARK-END */
  function writeDiary(manual) {
    if (window.pet.character?.authority) return renderDiary()
    const now = new Date()
    const day = diaryDayKey(now)
    if (diaryWriteInFlight.has(day)) return diaryWriteInFlight.get(day)
    R.writingDiary = true
    diaryLastResult = null
    const p = doWriteDiary(manual, day).catch(() => {
      diaryLastResult = { reason: 'error' }
      console.warn('[diary] write failed reason=error')
      if (manual) say(diaryResultMessage(diaryLastResult), 6000, 'ui')
      return false
    }).finally(() => {
      diaryWriteInFlight.delete(day)
      R.writingDiary = diaryWriteInFlight.size > 0
      if (diaryLastResult) diaryLastResult.diaryDay = day
      updateDiaryUI()
    })
    diaryWriteInFlight.set(day, p)
    updateDiaryUI()
    return p
  }

  async function doWriteDiary(manual, resolvedDay) {
    if (!diaryOn) {
      if (manual) say('📔 日记开关关着呢，去 设置 → 每日日记 打开吧～', undefined, 'ui')
      return false
    }
    const now = new Date()
    const today = resolvedDay || diaryDayKey(now)
    if (!manual && diaryExists(today)) {
      return false
    }
    if (manual && diaryExists(today)) {
      say('✍️ 重新生成今天的日记…', 4000, 'ui')
    }
    // 3.0 DiaryEngine façade: generate local DiaryOutput when available.
    if (window.DiaryEngine) {
      if (window.DiaryEngine.setSaveHandler) {
        window.DiaryEngine.setSaveHandler(saveDiaryOutput)
      }
      const resolver = window.DiaryEngine.resolveDiaryDay(now.getTime(), P.diaryTime || '23:00')
      // Calendar/weekday/season must describe the resolved DiaryDay, not the
      // wall-clock date: at 00:30 the active diary day is still yesterday.
      const diaryDayDate = diaryDateFromKey(resolver.diaryDay)
      const counts = todayCounts()
      const events = diaryCountEvents(counts)
      /* P1-3/D2：把真实时间线素材接进日记输入（两条写路径都接；计数器之外的第一路真实素材）。
         桥 → DiarySystem.timeline() → main diary:timeline；≤12 条/≤1200 字；取不到 ⇒ 退回计数器（不伪造）。 */
      let diaryMaterialTruncated = false
      try {
        const __tl = window.DiarySystem && typeof window.DiarySystem.timelineAsync === 'function' ? await window.DiarySystem.timelineAsync() : null
        // Never use a previous window's cached timeline after IPC failure/day rollover.
        if (__tl && __tl.date !== resolver.diaryDay) throw new Error('stale-timeline')
        const __nowTs = (now && typeof now.getTime === 'function') ? now.getTime() : (Number(now) || Date.now())
        const __mat = diaryMaterialFromTimeline(__tl, __nowTs)
        diaryMaterialTruncated = __mat.truncated === true
        for (const m of __mat.material) events.push({ text: m.text, ts: m.at, ref: m.ref, kind: m.kind })
        try { console.log('[diary] material', __mat.material.length, 'entries, truncated=' + diaryMaterialTruncated) } catch (e) { /* ignore */ }
      } catch (err) { /* 素材取不到 ⇒ 退回计数器（不伪造） */ }
      if (!diaryOn) { diaryLastResult = { reason: 'cancelled' }; return false }
      const emotionSummary = window.EmotionEngine ? (window.EmotionEngine.getSnapshot() || {}) : {}
      const relationshipSummary = window.RelationshipEngine ? window.RelationshipEngine.get() || {} : {}
      const memoryRefs = window.MemoryRetrieval ? window.MemoryRetrieval.retrieve({ text: events.map(e => e.text || '').join(' ').slice(0, 600), intent: 'past_episode' }, { limit: 3 }) : []
      const gen = await window.DiaryEngine.generate({
        force: !!manual,
        now: now.getTime(),
        diaryTime: P.diaryTime || '23:00',
        events,
        memoryRefs,
        emotionSummary,
        relationshipSummary,
        calendar: {
          date: resolver.diaryDay,
          weekday: ['周日','周一','周二','周三','周四','周五','周六'][diaryDayDate.getDay()],
          season: ['冬','冬','春','春','春','夏','夏','夏','秋','秋','秋','冬'][diaryDayDate.getMonth()],
          festival: []
        }
      })
      if (gen.ok && gen.output && gen.output.text) {
        diaryLastResult = gen
        if (manual || !R.chatOpen) say(gen.output.source === 'ai' ? '📔 日记写好并保存啦～' : '📔 已保存本地日记。AI 暂未生成，可查看后再试～', 5000, 'ui')
        unlockPhoto('diary-time')
        renderDiary()
        return true
      }
      diaryLastResult = gen
      if (manual) say(diaryResultMessage(gen) || '这次没能写好，请稍后重试～', 6000, 'ui')
    }
    // DiaryEngine generate/persist failed: no legacy askDiary fallback.
    console.log('diary-write-failed: generate/persist failed', diaryDayKey(new Date()))
    R.diaryFailedDate = today
    return false
  }


/* CC-4 / P1-D1: both automatic paths use the configured writing time.
   Once it is due, busy/hidden can defer writing until later that calendar day. */
function diaryWindowDue(nowTs) {
  try {
    const t = (typeof nowTs === 'number' && Number.isFinite(nowTs)) ? nowTs : Date.now()
    const dt = P.diaryTime || '23:00'
    const r = (window.DiaryDay && typeof window.DiaryDay.resolve === 'function') ? window.DiaryDay.resolve(t, dt) : null
    if (!r || !Number.isFinite(r.boundaryMinutes)) return { due: false, day: null }
    const due = r.reached === true
    let day = null
    if (window.DiaryEngine && typeof window.DiaryEngine.resolveDiaryDay === 'function') {
      const rr = window.DiaryEngine.resolveDiaryDay(t, dt)
      day = (rr && rr.diaryDay) || null
    }
    return { due: due, day: day }
  } catch (err) { return { due: false, day: null } }
}

function maybeWriteDiary() {
    if (!diaryOn) return
    if (R.busy || R.hidden) return
    if (P.diarySuppressed === diaryDayKey(new Date())) return // 今天被删/忘掉过：不自动补写
    const now = new Date()
    // One schedule for both automatic paths; manual writing remains available.
    if (!diaryWindowDue(now.getTime()).due) return
    /* 热修：原为「分钟数 < 边界时刻就 return」的旧闸门——与上面 ε-窗口判据（要求 minutes < 边界）
       互相矛盾，导致 CC-4 上机后 maybeWriteDiary 永不落笔；窗口判据已是唯一来源，这里不再重复判定。 */
    const today = diaryDayKey(now)
    if (diaryExists(today)) return
    // A4：已有 in-flight 时不再发起第二次；直接复用 writeDiary 的共享 Promise。
    try {
      writeDiary(false).catch(() => { /* maybeWriteDiary must not leave unhandled rejection */ })
    } catch (err) { /* ignore */ }
  }

  /* hmClock 已随"今日时间线展示"一并移除：它只被那段 chip 渲染使用。 */

  /* P2/D4-3（设计细化③）：删除日记产物——只删 diaryOutputs 条目（不碰记忆/时间线/相册）；
     删的是今天 ⇒ 置 P.diarySuppressed（既有语义：当日不自动补写、手动仍可写）；saveState＋pet.log。 */
  async function deleteDiaryEntry(diaryId) {
    if (!Array.isArray(P.diaryOutputs)) return false
    const idx = P.diaryOutputs.findIndex((x) => x && x.diaryId === diaryId)
    if (idx < 0) return false
    if (R.writingDiary) { say('日记还在写，请写完后再删除～', 5000, 'ui'); return false }
    const previous = P.diaryOutputs.slice()
    const previousSuppressed = P.diarySuppressed
    const removed = P.diaryOutputs.splice(idx, 1)[0]
    try {
      if (removed && removed.diaryDay === diaryDayKey(new Date())) P.diarySuppressed = diaryDayKey(new Date())
    } catch (err) { /* ignore */ }
    if (await saveState() !== true) {
      P.diaryOutputs = previous; P.diarySuppressed = previousSuppressed
      say('删除未能保存，日记已保留，请稍后再试～', 6000, 'ui')
      return false
    }
    if (window.DiaryEngine && window.DiaryEngine.removeOutput) window.DiaryEngine.removeOutput(diaryId)
    diaryLastResult = null
    try { console.log('[diary] deleted', diaryId, 'day=' + (removed && removed.diaryDay)) } catch (e) { /* ignore */ }
    try { updateDiaryUI() } catch (err) { /* 面板刷新失败不影响删除本体 */ }
    say('已删除这篇日记' + (removed.diaryDay === diaryDayKey(new Date()) ? '（这一天不会自动补写）' : ''), 5000, 'ui')
    return true
  }
  try { window.__deleteDiaryEntry = deleteDiaryEntry } catch (e) { /* 作用域免疫暴露（bind/UI 走 window 钩子） */ }
  async function renderDiary() {
    const wrap = $('diary-list')
    if (window.pet.character?.authority) {
      const result = await window.pet.character.read({ kind: 'diary' })
      wrap.replaceChildren()
      for (const day of result.days || []) for (const entry of day.entries) {
        const card = document.createElement('article'), title = document.createElement('strong'), text = document.createElement('p')
        title.textContent = day.date + ' · ' + entry.title
        text.textContent = entry.body?.text || JSON.stringify(entry.body || {})
        card.append(title, text); wrap.appendChild(card)
      }
      if (!wrap.children.length) wrap.textContent = '还没有可展示的经历。'
      return
    }
    if (!wrap) return
    const today = diaryDayKey(new Date())
    const hasToday = diaryExists(today)
    const info = $('diary-info')
    if (info) info.textContent = !diaryOn ? '日记已关闭' : R.writingDiary ? '正在写日记，AI 最多等待约 2 分钟…' : diaryResultMessage(diaryLastResult && diaryLastResult.diaryDay === today ? diaryLastResult : null) || (hasToday ? '这一篇已写 ✓' : P.diarySuppressed === today ? '这一篇已删除，不会自动补写；可点立即写。' : '在 ' + diaryWriteWindowLabel() + ' 有素材时自动写；也可立即写。')

    // 旧日记忆：最近一条往日记（可点 ✕ 忘记）
    const mem = $('diary-memory')
    const memTextEl = $('diary-memory-text')
    if (mem) {
      const engineMems = window.MemoryEngine ? window.MemoryEngine.getMemories({ status: 'active' }) : []
      // Diary Recall 只使用 MemoryEngine 正式记忆，不再回退到 P.memories legacy。
      lastShownMemory = [...engineMems].reverse().find((m) => m.content && m.date && m.date !== today) || null
      if (lastShownMemory && memTextEl) {
        memTextEl.textContent = '💭 还记得那一天：' + lastShownMemory.content
        mem.classList.remove('hidden')
      } else {
        mem.classList.add('hidden')
      }
    }

    /* 今日时间线展示已移除。
       原因：用户看到的是"浏览器 22:24~22:35 / 22:37~22:53"这类 chip 越积越多，
       明确表示"这部分会累积，但其实不需要显示这部分"。
       注意：**只删展示，不删采集**——主进程仍采集活跃片段，日记 AI 素材/日记正文仍可用它；
       桥 `window.pet.diaryTimeline()` 也保留（当前父调用方传 null ⇒ 一直是空态）。 */

    wrap.innerHTML = ''
    const diaryOutputs = Array.isArray(P.diaryOutputs) ? [...P.diaryOutputs].reverse() : []
    if (!P.diary.length && !diaryOutputs.length) {
      wrap.innerHTML = diaryOn
        ? '<div class="dp-muted">还没有日记，有素材时会在 ' + diaryWriteWindowLabel() + ' 自动写（也可点 ✍️ 立即写）</div>'
        : '<div class="dp-muted">日记已关闭，去 设置 → 每日日记 打开后我每天都会写～</div>'
      return
    }
    // 3.0 DiaryOutput 优先展示（只读）
    diaryOutputs.forEach((d) => {
      if (!d || !d.text) return
      const item = document.createElement('div')
      item.className = 'dp-hist-item'
      const headRow = document.createElement('div')
      headRow.className = 'dp-hist-role dp-hist-assistant'
      headRow.style.display = 'flex'
      headRow.style.alignItems = 'center'
      const head = document.createElement('div')
      head.style.flex = '1'
      head.textContent = '📔 ' + (d.diaryDay || d.calendarContext && d.calendarContext.date || '') + ' · ' + (d.source === 'ai' ? 'AI' : '本地')
      headRow.appendChild(head)
      /* P2/D4-3：删除入口——两击确认（5 秒内第二击生效），只删产物条目。 */
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'dp-mini-btn dp-diary-del'
      del.title = '删除这篇日记（需要再次确认）'
      del.disabled = !!R.writingDiary
      del.style.cssText = 'margin-left:8px;opacity:0.55;cursor:pointer;font-size:11px;flex-shrink:0'
      del.textContent = '🗑'
      let delArmed = false
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        if (!delArmed) {
          delArmed = true; del.textContent = '确认删除？'; del.style.opacity = '1'
          setTimeout(() => { delArmed = false; del.textContent = '🗑'; del.style.opacity = '0.55' }, 5000)
          return
        }
        del.disabled = true
        Promise.resolve(window.__deleteDiaryEntry(d.diaryId)).catch(() => {
          say('删除失败，日记已保留，请稍后再试～', 6000, 'ui')
        }).finally(() => { del.disabled = !!R.writingDiary })
      })
      headRow.appendChild(del)
      item.appendChild(headRow)
      const body = document.createElement('div')
      body.className = 'dp-diary-text'
      body.textContent = d.text
      item.appendChild(body)
      wrap.appendChild(item)
    })
    ;[...P.diary].reverse().forEach((d) => {
      const item = document.createElement('div')
      item.className = 'dp-hist-item'
      const headRow = document.createElement('div')
      headRow.className = 'dp-hist-role dp-hist-assistant'
      headRow.style.display = 'flex'
      headRow.style.alignItems = 'center'
      const head = document.createElement('div')
      head.style.flex = '1'
      head.textContent = '📔 ' + d.date + ' · ' + (d.mood || '')
      const del = document.createElement('button')
      del.className = 'dp-mini-btn dp-diary-del'
      del.textContent = '✕'
      del.title = d && d.date === today ? '删除今天的日记（可重新生成）' : '删除这篇日记'
      del.addEventListener('click', () => {
        P.diary = P.diary.filter((x) => x !== d)
        if (d && d.date === today) P.diarySuppressed = today
        saveState()
        renderDiary()
        say('已删除这篇日记' + (d && d.date === today ? '（今天不会自动补写啦）' : ''), undefined, 'ui')
      })
      headRow.appendChild(head)
      headRow.appendChild(del)
      item.appendChild(headRow)
      if (d.title) {
        const t = document.createElement('div')
        t.className = 'dp-diary-title'
        t.textContent = d.title
        item.appendChild(t)
      }
      if (d.highlight) {
        const hl = document.createElement('div')
        hl.className = 'dp-diary-highlight'
        hl.textContent = '✨ 值得记住：' + d.highlight
        item.appendChild(hl)
      }
      const txt = document.createElement('div')
      txt.className = 'dp-hist-text'
      txt.textContent = d.text
      item.appendChild(txt)
      wrap.appendChild(item)
    })
  }

  /* ---------- <pet-command> 协议：回复里的 JSON 指令 ---------- */

  function applyPetCommands(text) {
    return { ok: false, reason: "runtime_command_action_not_enabled", clean: String(text || ''), applied: [] }
    /* Legacy free-text commands retained for reference, never executed. */
    if (!text) return { clean: text || '', applied: [] }
    const re = /<pet-command>([\s\S]*?)<\/pet-command>/g
    const applied = []
    let m
    while ((m = re.exec(text))) {
      try {
        const cmd = JSON.parse(m[1])
        if (!cmd || typeof cmd !== 'object') continue
        if (cmd.type === 'todos' && Array.isArray(cmd.items)) {
          const items = cmd.items.filter((t) => t && typeof t.text === 'string').slice(0, 10)
          items.forEach((t) => { P.todos.push({ id: ++uid, text: t.text.slice(0, 120), done: false }) })
          if (items.length) applied.push('待办 ×' + items.length)
        } else if (cmd.type === 'schedule' && Array.isArray(cmd.items)) {
          const items = cmd.items.filter((c) => c && typeof c.name === 'string' && typeof c.time === 'string').slice(0, 10)
          items.forEach((c) => {
            P.schedule.push({
              id: ++uid,
              name: c.name.slice(0, 20),
              day: [1, 2, 3, 4, 5, 6, 7].includes(Number(c.day)) ? Number(c.day) : 1,
              time: c.time,
              weeks: c.weeks === 'odd' || c.weeks === 'even' ? c.weeks : 'all',
              remind: Number(c.remind) || 0,
            })
          })
          if (items.length) applied.push('课程 ×' + items.length)
        } else if (cmd.type === 'memo' && typeof cmd.text === 'string') {
          if (addMemo(cmd.text)) applied.push('备忘录')
        }
      } catch (err) { /* 非法 JSON 忽略 */ }
    }
    const clean = text.replace(re, '').trim()
    if (applied.length) {
      saveState()
      renderTodos()
      renderSchedule()
      renderMemos()
      updateFocusMeta()
      say('✅ 已按回复执行：' + applied.join('、'), undefined, 'ui')
    }
    return { clean, applied }
  }

  function useItem(key) {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'use_item', item: key })
    if (!(P.inventory[key] > 0)) return
    const it = ITEMS[key]
    P.inventory[key] -= 1
    if (key === 'blindbox') {
      const r = Math.random()
      if (r < 0.3) {
        const gain = 5 + Math.floor(Math.random() * 16)
        P.coins += gain
        say('🎁 盲盒开出了 🪙 ×' + gain + '！', undefined, 'user-feedback')
      } else if (r < 0.6) {
        P.stats.satiety = clamp(P.stats.satiety + 15, 0, 100)
        P.stats.mood = clamp(P.stats.mood + 15, 0, 100)
        P.stats.energy = clamp(P.stats.energy + 15, 0, 100)
        setMood('happy', 10000)
        say('🎁 开出了豪华大礼包，全属性 +15！', undefined, 'user-feedback')
      } else if (r < 0.8) {
        const keys = ['satiety', 'mood', 'energy']
        const k = keys[Math.floor(Math.random() * keys.length)]
        P.stats[k] = clamp(P.stats[k] - 10, 0, 100)
        say('🎁 盲盒里是……过期泡面，' + (k === 'satiety' ? '饱食' : k === 'mood' ? '心情' : '精力') + ' -10 😰', undefined, 'user-feedback')
      } else {
        say('🎁 谢谢惠顾～（下次一定）', undefined, 'user-feedback')
      }
      updateCoins()
      renderCare()
      saveState()
      return
    }
    const e = it.effect
    if (e.satiety) P.stats.satiety = clamp(P.stats.satiety + e.satiety, 0, 100)
    if (e.mood) P.stats.mood = clamp(P.stats.mood + e.mood, 0, 100)
    if (e.energy) P.stats.energy = clamp(P.stats.energy + e.energy, 0, 100)
    if (e.thirst) P.stats.thirst = clamp(P.stats.thirst + e.thirst, 0, 100)
    if (e.affection) addAffection(e.affection) // 礼物类：加好感度（addAffection 内部会 save/render）
    if (key === 'cookie' || key === 'feast' || key === 'noodle' || key === 'cake' || key === 'rice') {
      setMood('eating', 10000)
      P.feedCount += 1 // 喂食计数（喂食锁定照片用：第一块饼干/干饭小鲸）
      unlockPhoto('first-cookie')
      diaryEvent('feed', it.name)
      /* 喂食此前**不给经验、也不触发成就检查**（其他互动都给经验），
         导致「干饭小鲸（喂食 20 次）」要等下一次 gainExp/settleWork 才结算。
         这里按"喂食也算陪伴"补 1 点经验（gainExp 内部会 saveState + checkAchievements）。 */
      gainExp(1)
    }
    else if (key === 'toy') { setMood('happy', 10000); addHearts(3) }
    else if (key === 'hairpin' || key === 'flower' || key === 'bracelet' || key === 'brooch') { setMood('happy', 10000); addHearts(5) }
    else setMood('happy', 10000)
    say(it.icon + ' ' + it.name + ' 用掉啦～', undefined, 'user-feedback')
    renderCare()
    saveState()
  }

  // 商店当前选中的分类（'all' 或分类 key），切换按钮控制
  let activeShopCat = 'all'

  function switchShopCat(cat) {
    activeShopCat = cat
    document.querySelectorAll('#shop-picker .dp-tab').forEach((b) => {
      b.classList.toggle('dp-tab-active', b.id === 'shop-cat-' + cat)
    })
    renderShop()
  }

  function renderShop() {
    const wrap = $('shop-items')
    wrap.innerHTML = ''
    const keys = Object.keys(ITEMS).filter((k) => activeShopCat === 'all' || ITEMS[k].category === activeShopCat)
    if (activeShopCat === 'all') {
      // 全部视图：按分类分组展示，每组一个小标题
      ITEM_CATEGORIES.forEach((cat) => {
        const ckeys = keys.filter((k) => ITEMS[k].category === cat.key)
        if (!ckeys.length) return
        const head = document.createElement('div')
        head.className = 'dp-shop-cat'
        head.textContent = cat.name + '（' + ckeys.length + '）'
        wrap.appendChild(head)
        appendShopGrid(wrap, ckeys)
      })
    } else {
      appendShopGrid(wrap, keys)
    }
  }

  function appendShopGrid(wrap, keys) {
    const grid = document.createElement('div')
    grid.className = 'dp-shop-grid'
    keys.forEach((key) => {
      const it = ITEMS[key]
      const card = document.createElement('div')
      card.className = 'dp-shop-card' + (it.category === 'gift' ? ' dp-shop-gift' : '')
      const icon = document.createElement('div')
      icon.className = 'dp-shop-icon'
      icon.textContent = it.icon
      const name = document.createElement('div')
      name.className = 'dp-shop-name'
      name.textContent = it.name
      const desc = document.createElement('div')
      desc.className = 'dp-shop-desc'
      desc.textContent = it.desc
      const btn = document.createElement('button')
      btn.className = 'dp-mini-btn dp-buy-btn'
      btn.textContent = '🪙 ' + it.price
      btn.addEventListener('click', () => buyItem(key))
      card.appendChild(icon)
      card.appendChild(name)
      card.appendChild(desc)
      card.appendChild(btn)
      grid.appendChild(card)
    })
    wrap.appendChild(grid)
  }

  function buyItem(key) {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'buy', item: key })
    const it = ITEMS[key]
    if (P.coins < it.price) { say('金币不够啦，去 🎮 玩小游戏赚一点吧～', undefined, 'ui'); return }
    P.coins -= it.price
    P.inventory[key] = (P.inventory[key] || 0) + 1
    say('买到了 ' + it.icon + ' ' + it.name + '！', undefined, 'ui')
    updateCoins()
    renderCare()
    saveState()
  }

  function applyName() {
    $('panel-title').textContent = '🐳 ' + P.name
    petEl.title = P.name
    $('name-input').value = P.name
    $('owner-name-input').value = P.ownerName || ''
    $('owner-birthday-input').value = P.ownerBirthday || ''
    $('mini-chat-input').placeholder = '和' + P.name + '聊两句…'
    applyNameToUI()
  }

  function petName() {
    try { return String((typeof P !== 'undefined' && P && P.name) || '小深') } catch (e) { return '小深' }
  }

  /* UI 静态文案里的自称名随 P.name 重放渲染：首轮存原文，改名后可重刷（不叠加、可回退）。 */
  const _l10nOrig = new WeakMap()
  function applyNameToUI() {
    const name = String(P && P.name ? P.name : '小深')
    const root = document.body
    if (!root) return
    for (const el of root.querySelectorAll('*')) {
      if (el.matches('input, textarea, select, option')) continue
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        const cur = el.getAttribute(attr)
        if (!cur || cur.indexOf('小深') === -1) continue
        const key = 'data-l10n-' + attr
        const orig = el.getAttribute(key) || cur
        if (orig.indexOf('小深') === -1) continue
        el.setAttribute(key, orig)
        el.setAttribute(attr, orig.split('小深').join(name))
      }
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType !== 3) continue
        const cur = node.nodeValue || ''
        const orig = _l10nOrig.get(node) || cur
        if (orig.indexOf('小深') === -1) continue
        _l10nOrig.set(node, orig)
        node.nodeValue = orig.split('小深').join(name)
      }
    }
  }

  function updateCoins() {
    const badge = $('coin-badge')
    if (badge) badge.textContent = '🪙 ' + P.coins
  }

  /* 成就补检（收口在**心跳**而不是 24 处加币点）。
     原问题：签到/日结/生日/盲盒/平局这类"只加金币"的路径不查成就，且开机也不查
     ⇒ 会出现「金币早就够 300 了，rich-300 却还锁着」的观感 bug。
     现在：①开机补一次；②跟着已有的 60s 心跳（checkPhotoUnlocks 同处）每分钟补一次。
     代价是达标后最多延迟 1 分钟显示解锁 —— 比在每个加币点插一行更不容易漏。 */
  function catchUpAchievements() {
    try { checkAchievements() } catch (err) { /* 非致命 */ }
  }

  /* ---------- mini game ---------- */

  const game = {
    playing: false,
    score: 0,
    timeLeft: 30,
    items: [],
    basketX: 165,
    keys: { left: false, right: false },
    lastSpawn: 0,
    raf: 0,
    startTs: 0,
  }

  function startGame() {
    if (game.playing) return
    game.playing = true
    game.score = 0
    game.timeLeft = 30
    game.items = []
    game.basketX = 165
    game.keys.left = false
    game.keys.right = false
    game.lastSpawn = 0
    game.startTs = performance.now()
    $('game-result').classList.add('hidden')
    $('btn-game').textContent = '游戏中…'
    $('btn-game').disabled = true
    game.raf = requestAnimationFrame(gameLoop)
  }

  function spawnItem() {
    const r = Math.random()
    const kind = r < 0.55 ? 'cookie' : r < 0.75 ? 'gold' : 'bomb'
    const elapsed = 30 - game.timeLeft
    game.items.push({
      kind,
      x: 20 + Math.random() * 290,
      y: -20,
      vy: 95 + Math.random() * 60 + elapsed * 6,
    })
  }

  function gameLoop(ts) {
    if (!game.playing) return
    const dt = Math.min((ts - (game.lastFrameTs || ts)) / 1000, 0.05)
    game.lastFrameTs = ts
    game.timeLeft = 30 - (ts - game.startTs) / 1000
    if (game.timeLeft <= 0) { game.timeLeft = 0; endGame(true); return }

    if (ts - game.lastSpawn > Math.max(300, 460 - (30 - game.timeLeft) * 8)) {
      spawnItem()
      game.lastSpawn = ts
    }

    if (game.keys.left) game.basketX -= 260 * dt
    if (game.keys.right) game.basketX += 260 * dt
    game.basketX = clamp(game.basketX, 35, 295)

    const kept = []
    const basketY = canvas.height - 25 // 篮子位置随画布高度
    game.items.forEach((item) => {
      item.y += item.vy * dt
      if (item.y > basketY - 25 && item.y < basketY + 25 && Math.abs(item.x - game.basketX) < 36) {
        if (item.kind === 'cookie') game.score += 2
        else if (item.kind === 'gold') game.score += 5
        else game.score = Math.max(0, game.score - 8)
      } else if (item.y < canvas.height + 20) {
        kept.push(item)
      }
    })
    game.items = kept

    drawGame()
    $('game-score').textContent = '得分 ' + game.score
    $('game-time').textContent = '⏱ ' + Math.ceil(game.timeLeft) + 's'
    game.raf = requestAnimationFrame(gameLoop)
  }

  function drawGame() {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height)
    game.items.forEach((item) => {
      ctx2d.font = '24px serif'
      ctx2d.textAlign = 'center'
      ctx2d.textBaseline = 'middle'
      ctx2d.fillText(item.kind === 'cookie' ? '🍪' : item.kind === 'gold' ? '🪙' : '💣', item.x, item.y)
    })
    ctx2d.font = '32px serif'
    ctx2d.fillText('🧺', game.basketX, canvas.height - 25)
  }

  function endGame(reward) {
    if (!game.playing) return
    game.playing = false
    cancelAnimationFrame(game.raf)
    const earned = reward ? Math.max(0, Math.floor(game.score / 2)) : 0
    if (reward) {
      P.coins += earned
      gainExp(5)
      P.totalGames += 1
      P.bestGameScore = Math.max(P.bestGameScore, game.score)
      markDaily('game'); unlockPhoto('first-game'); touch()
      addAffection(1)
      saveState()
      window.GameBridge.complete({ gameId: 'catch', score: game.score, won: true })
      updateCoins()
      renderCare()
    }
    const res = $('game-result')
    res.classList.remove('hidden')
    res.textContent = reward
      ? ('本局得分 ' + game.score + '，赚到 🪙 ' + earned + '！' + (P.bestGameScore > 0 ? '（历史最高 ' + P.bestGameScore + '）' : ''))
      : '本局中断，没有奖励…'
    $('btn-game').textContent = '再来一局 🎮'
    $('btn-game').disabled = false
  }

  function abortGame() {
    if (!game.playing) return
    game.playing = false
    cancelAnimationFrame(game.raf)
    $('game-result').classList.add('hidden')
    $('btn-game').textContent = '开始游戏 🎮'
    $('btn-game').disabled = false
  }


  /* ---------- snake ---------- */

  const snakeCtx = $('snake-canvas').getContext('2d')

  const snake = {
    playing: false,
    score: 0,
    dir: { x: 1, y: 0 },
    nextDir: null,
    body: [],
    food: null,
    timer: null,
    speedMs: 130,
    cols: 22,
    rows: 15,
    cell: 15,
  }

  function snakeReset() {
    snake.body = [{ x: 5, y: 7 }, { x: 4, y: 7 }, { x: 3, y: 7 }]
    snake.dir = { x: 1, y: 0 }
    snake.nextDir = null
    snake.score = 0
    snake.speedMs = 130
    placeSnakeFood()
    $('snake-score').textContent = '得分 0'
    $('snake-result').classList.add('hidden')
    drawSnake()
  }

  function placeSnakeFood() {
    let p
    do {
      p = { x: Math.floor(Math.random() * snake.cols), y: Math.floor(Math.random() * snake.rows) }
    } while (snake.body.some((s) => s.x === p.x && s.y === p.y))
    snake.food = p
  }

  function startSnake() {
    if (snake.playing) return
    snakeReset()
    snake.playing = true
    $('btn-snake').textContent = '游戏中…'
    $('btn-snake').disabled = true
    snake.timer = setInterval(snakeTick, snake.speedMs)
  }

  function setSnakeDir(dx, dy) {
    if (dx === -snake.dir.x && dy === -snake.dir.y) return
    snake.nextDir = { x: dx, y: dy }
  }

  function snakeTick() {
    if (snake.nextDir) { snake.dir = snake.nextDir; snake.nextDir = null }
    const head = { x: snake.body[0].x + snake.dir.x, y: snake.body[0].y + snake.dir.y }
    if (head.x < 0 || head.x >= snake.cols || head.y < 0 || head.y >= snake.rows
      || snake.body.some((s) => s.x === head.x && s.y === head.y)) {
      endSnake(true)
      return
    }
    snake.body.unshift(head)
    if (snake.food && head.x === snake.food.x && head.y === snake.food.y) {
      snake.score += 1
      snake.speedMs = Math.max(70, snake.speedMs - 2)
      clearInterval(snake.timer)
      snake.timer = setInterval(snakeTick, snake.speedMs)
      placeSnakeFood()
    } else {
      snake.body.pop()
    }
    $('snake-score').textContent = '得分 ' + snake.score
    drawSnake()
  }

  function drawSnake() {
    snakeCtx.clearRect(0, 0, 330, 225)
    snakeCtx.fillStyle = '#4cc3f7'
    snake.body.forEach((s, i) => {
      snakeCtx.fillRect(s.x * snake.cell, s.y * snake.cell, snake.cell - 1, snake.cell - 1)
    })
    if (snake.food) {
      snakeCtx.fillStyle = '#ef4444'
      snakeCtx.fillRect(snake.food.x * snake.cell + 2, snake.food.y * snake.cell + 2, snake.cell - 5, snake.cell - 5)
    }
  }

  function endSnake(reward) {
    if (!snake.playing) return
    snake.playing = false
    if (snake.timer) { clearInterval(snake.timer); snake.timer = null }
    const earned = reward ? Math.max(0, Math.floor(snake.score / 2)) : 0
    if (reward) {
      P.coins += earned
      gainExp(5)
      P.totalGames += 1
      markDaily('game'); unlockPhoto('first-game'); touch()
      addAffection(1)
      saveState()
      window.GameBridge.complete({ gameId: 'snake', score: snake.score, won: true })
      updateCoins()
      renderCare()
    }
    const res = $('snake-result')
    res.classList.remove('hidden')
    res.textContent = reward ? ('本局得分 ' + snake.score + '，+🪙 ' + earned) : '本局中断，没有奖励…'
    if (snake.score >= 30) {
      unlockPhoto('snake-king')
      markGameWin2('snake')
    }
    $('btn-snake').textContent = '再来一局 🐍'
    $('btn-snake').disabled = false
  }

  function abortSnake() {
    if (!snake.playing) return
    snake.playing = false
    if (snake.timer) { clearInterval(snake.timer); snake.timer = null }
    $('btn-snake').textContent = '开始游戏 🐍'
    $('btn-snake').disabled = false
    $('snake-result').classList.add('hidden')
  }

  /* ---------- 2048（带动画：滑动/合并/生成） ---------- */

  const t2048 = { size: 4, grid: [], ids: [], score: 0, over: false, nextId: 1 }
  const tileEls = new Map() // id -> 元素

  function tReset() {
    t2048.grid = Array.from({ length: 4 }, () => Array(4).fill(0))
    t2048.ids = Array.from({ length: 4 }, () => Array(4).fill(0))
    t2048.nextId = 1
    t2048.score = 0
    t2048.over = false
    tileEls.forEach((el) => el.remove())
    tileEls.clear()
    spawnT()
    spawnT()
    renderT({ moves: [], spawn: null, fresh: true })
    $('t2048-result').classList.add('hidden')
    $('t2048-score').textContent = '得分 0'
  }

  function spawnT() {
    const empty = []
    for (let r = 0; r < t2048.size; r++) {
      for (let c = 0; c < t2048.size; c++) {
        if (t2048.grid[r][c] === 0) empty.push([r, c])
      }
    }
    if (!empty.length) return null
    const [r, c] = empty[Math.floor(Math.random() * empty.length)]
    t2048.grid[r][c] = Math.random() < 0.9 ? 2 : 4
    t2048.ids[r][c] = t2048.nextId++
    return { id: t2048.ids[r][c], r, c }
  }

  // 滑动一行并记录每个方块的去向（用于动画）
  function slideLineTracked(arr, ids) {
    const entries = []
    arr.forEach((v, i) => { if (v !== 0) entries.push({ v, id: ids[i], from: i }) })
    const out = []
    const outIds = []
    let gained = 0
    const moves = []
    for (let i = 0; i < entries.length; i++) {
      if (i + 1 < entries.length && entries[i].v === entries[i + 1].v) {
        out.push(entries[i].v * 2)
        outIds.push(entries[i].id)
        gained += entries[i].v * 2
        moves.push({ id: entries[i].id, from: entries[i].from, to: out.length - 1, merged: true, absorbedId: entries[i + 1].id })
        moves.push({ id: entries[i + 1].id, from: entries[i + 1].from, to: out.length - 1, absorbed: true })
        i++
      } else {
        out.push(entries[i].v)
        outIds.push(entries[i].id)
        moves.push({ id: entries[i].id, from: entries[i].from, to: out.length - 1 })
      }
    }
    while (out.length < arr.length) { out.push(0); outIds.push(0) }
    return { out, outIds, gained, moves }
  }

  function tMove(dir) {
    if (t2048.over) return
    const n = t2048.size
    let changed = false
    let gained = 0
    const anim = { moves: [], spawn: null }
    for (let i = 0; i < n; i++) {
      let line, lineIds
      if (dir === 'left') { line = t2048.grid[i].slice(); lineIds = t2048.ids[i].slice() }
      else if (dir === 'right') { line = t2048.grid[i].slice().reverse(); lineIds = t2048.ids[i].slice().reverse() }
      else if (dir === 'up') { line = t2048.grid.map((row) => row[i]); lineIds = t2048.ids.map((row) => row[i]) }
      else { line = t2048.grid.map((row) => row[i]).reverse(); lineIds = t2048.ids.map((row) => row[i]).reverse() }
      const { out, outIds, gained: g, moves } = slideLineTracked(line, lineIds)
      gained += g
      const back = (dir === 'right' || dir === 'down') ? out.reverse() : out
      const backIds = (dir === 'right' || dir === 'down') ? outIds.reverse() : outIds
      for (let j = 0; j < n; j++) {
        const cur = dir === 'up' || dir === 'down' ? t2048.grid[j][i] : t2048.grid[i][j]
        if (back[j] !== cur) changed = true
        if (dir === 'up' || dir === 'down') { t2048.grid[j][i] = back[j]; t2048.ids[j][i] = backIds[j] }
        else { t2048.grid[i][j] = back[j]; t2048.ids[i][j] = backIds[j] }
      }
      for (const m of moves) {
        let tr, tc
        if (dir === 'left') { tr = i; tc = m.to }
        else if (dir === 'right') { tr = i; tc = n - 1 - m.to }
        else if (dir === 'up') { tr = m.to; tc = i }
        else { tr = n - 1 - m.to; tc = i }
        anim.moves.push({ id: m.id, toR: tr, toC: tc, merged: !!m.merged, absorbed: !!m.absorbed })
      }
    }
    if (!changed) return
    t2048.score += gained
    anim.spawn = spawnT()
    renderT(anim)
    checkTEnd()
  }

  function tMaxTile() {
    let m = 0
    t2048.grid.forEach((row) => row.forEach((v) => { if (v > m) m = v }))
    return m
  }

  function checkTEnd() {
    // 数字达人：合出 512 即解锁
    if (tMaxTile() >= 512) {
      unlockPhoto('t2048-master')
      markGameWin2('t2048')
    }
    const n = t2048.size
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (t2048.grid[r][c] === 0) return
        if (c + 1 < n && t2048.grid[r][c] === t2048.grid[r][c + 1]) return
        if (r + 1 < n && t2048.grid[r][c] === t2048.grid[r + 1][c]) return
      }
    }
    t2048.over = true
    const maxTile = tMaxTile()
    let reward = 0
    if (maxTile >= 2048) reward = 100
    else if (maxTile >= 1024) reward = 50
    else if (maxTile >= 512) reward = 25
    else if (maxTile >= 256) reward = 15
    else if (maxTile >= 128) reward = 8
    P.totalGames += 1
    if (reward) { P.coins += reward; markDaily('game'); unlockPhoto('first-game'); touch(); addAffection(1) }
    gainExp(5)
    saveState()
    window.GameBridge.complete({ gameId: 't2048', score: maxTile, won: reward > 0 })
    updateCoins()
    renderCare()
    const res = $('t2048-result')
    res.classList.remove('hidden')
    res.textContent = '游戏结束：最高方块 ' + maxTile + (reward ? '，+🪙 ' + reward : '（合到 128 才有金币哦）')
  }

  const T_STRIDE = 70 // 64px 格 + 6px 间距

  function renderT(anim) {
    const gridEl = $('t2048-grid')
    let layer = gridEl.querySelector('.dp-t2048-layer')
    if (!layer) {
      const shells = document.createElement('div')
      shells.className = 'dp-t2048-shells'
      for (let i = 0; i < 16; i++) {
        const s = document.createElement('div')
        s.className = 'dp-t2048-cell'
        shells.appendChild(s)
      }
      gridEl.appendChild(shells)
      layer = document.createElement('div')
      layer.className = 'dp-t2048-layer'
      gridEl.appendChild(layer)
    }
    const setPos = (el, r, c) => { el.style.transform = 'translate(' + (c * T_STRIDE) + 'px, ' + (r * T_STRIDE) + 'px)' }

    // 被吞并的方块：滑到目标格并淡出，然后移除
    if (anim && anim.moves) {
      const absorbed = new Map(anim.moves.filter((m) => m.absorbed).map((m) => [m.id, m]))
      for (const [id, el] of tileEls) {
        const m = absorbed.get(id)
        if (m) {
          setPos(el, m.toR, m.toC)
          el.classList.add('dp-t-fade')
          tileEls.delete(id)
          const gone = el
          setTimeout(() => gone.remove(), 240)
        }
      }
    }

    const wanted = new Set()
    for (let r = 0; r < t2048.size; r++) {
      for (let c = 0; c < t2048.size; c++) {
        const v = t2048.grid[r][c]
        if (!v) continue
        const id = t2048.ids[r][c]
        wanted.add(id)
        let el = tileEls.get(id)
        if (!el) {
          el = document.createElement('div')
          el.className = 'dp-t2048-tile'
          const inner = document.createElement('div')
          inner.className = 'dp-t2048-tile-inner'
          el.appendChild(inner)
          layer.appendChild(el)
          tileEls.set(id, el)
        }
        setPos(el, r, c)
        const inner = el.firstChild
        inner.className = 'dp-t2048-tile-inner dp-t2048-v' + v
        inner.textContent = String(v)
        const isNew = !!((anim && anim.fresh) || (anim && anim.spawn && anim.spawn.id === id))
        const merged = !!(anim && anim.moves && anim.moves.some((m) => m.id === id && m.merged))
        if (isNew) {
          inner.classList.add('dp-t-pop')
          inner.addEventListener('animationend', () => inner.classList.remove('dp-t-pop'), { once: true })
        } else if (merged) {
          // 等滑动到位后再弹，视觉上更顺
          const target = inner
          setTimeout(() => {
            target.classList.add('dp-t-merge')
            target.addEventListener('animationend', () => target.classList.remove('dp-t-merge'), { once: true })
          }, 140)
        }
      }
    }
    for (const [id, el] of tileEls) {
      if (!wanted.has(id)) { el.remove(); tileEls.delete(id) }
    }
    $('t2048-score').textContent = '得分 ' + t2048.score
  }

  window.addEventListener('keydown', (e) => {
    const k = e.key
    if (activeGame === 'catch') {
      if (k === 'ArrowLeft') { game.keys.left = true; if (game.playing) e.preventDefault() }
      else if (k === 'ArrowRight') { game.keys.right = true; if (game.playing) e.preventDefault() }
    } else if (activeGame === 'snake') {
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { if (!snake.playing) startSnake(); setSnakeDir(-1, 0); e.preventDefault() }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { if (!snake.playing) startSnake(); setSnakeDir(1, 0); e.preventDefault() }
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') { if (!snake.playing) startSnake(); setSnakeDir(0, -1); e.preventDefault() }
      else if (k === 'ArrowDown' || k === 's' || k === 'S') { if (!snake.playing) startSnake(); setSnakeDir(0, 1); e.preventDefault() }
    } else if (activeGame === 't2048') {
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { tMove('left'); e.preventDefault() }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { tMove('right'); e.preventDefault() }
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') { tMove('up'); e.preventDefault() }
      else if (k === 'ArrowDown' || k === 's' || k === 'S') { tMove('down'); e.preventDefault() }
    }
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft') game.keys.left = false
    if (e.key === 'ArrowRight') game.keys.right = false
  })
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect()
    game.basketX = clamp((e.clientX - rect.left) * (canvas.width / rect.width), 35, 295)
  })

  /* ---------- sessions & status ---------- */

  function updateStatusUI() {
    const dot = $('dot')
    const txt = $('status-text')
    if (R.busy) {
      dot.className = 'dp-dot dp-dot-busy'
      txt.textContent = '发送中…'
    } else if (R.running) {
      dot.className = 'dp-dot dp-dot-busy'
      txt.textContent = 'DeepSeek 处理中…'
    } else {
      dot.className = 'dp-dot'
      txt.textContent = '空闲中，摸摸' + P.name + '放松一下～'
    }
    updateMood()
  }

  // 与网页端一致：只显示工作区成员中未归档的会话
  async function refreshVisibleSessions() {
    try {
      const ci = await window.pet.chatInfo().catch(() => null)
      R.chatSessionId = (ci && ci.sessionId) || null
      const wr = await window.pet.api('workspace.list', {})
      if (wr && wr.result && wr.result.ok) {
        const val = wr.result.value || {}
        const workspaces = val.items || []
        const archived = new Set(val.archivedSessionIds || [])
        const target = String(WORKSPACE || '').toLowerCase()
        let ws = workspaces.find((w) => target && String(w.path).toLowerCase() === target)
        // 兼容：找不到精确匹配时，选唯一工作区；否则选包含当前会话最多的那个。
        if (!ws && workspaces.length === 1) ws = workspaces[0]
        if (!ws && R.sessions && R.sessions.length) {
          const sessionIds = new Set(R.sessions.map((s) => s.sessionId))
          let best = null
          let bestCount = -1
          for (const w of workspaces) {
            const ids = Array.isArray(w.sessionIds) ? w.sessionIds : []
            const count = ids.reduce((sum, id) => sum + (sessionIds.has(id) ? 1 : 0), 0)
            if (count > bestCount) { best = w; bestCount = count }
          }
          ws = best
        }
        if (ws && Array.isArray(ws.sessionIds)) {
          R.visibleSessions = new Set(ws.sessionIds.filter((id) => !archived.has(id)))
          return
        }
      }
    } catch (err) { /* ignore */ }
    R.visibleSessions = null // 拿不到工作区信息时不过滤
  }

  function isHiddenSession(id) {
    return id === P.summarySessionId || (R.chatSessionId && id === R.chatSessionId)
  }

  function pickDefaultSession(items) {
    const vis = R.visibleSessions ? items.filter((s) => R.visibleSessions.has(s.sessionId)) : items
    const pool = vis.length ? vis : items
    return pool.find((s) => !s.blank && s.origin !== 'subagent' && !s.parentSessionId && s.running && !isHiddenSession(s.sessionId))
      || pool.find((s) => !s.blank && s.origin !== 'subagent' && !s.parentSessionId && !isHiddenSession(s.sessionId))
      || pool.find((s) => !s.blank && s.origin !== 'subagent' && !isHiddenSession(s.sessionId))
      || pool.find((s) => !isHiddenSession(s.sessionId))
      || null
  }

  function renderSessionSelect() {
    sel.innerHTML = ''
    R.sessions.forEach((s) => {
      if (isHiddenSession(s.sessionId)) return
      if (R.visibleSessions && !R.visibleSessions.has(s.sessionId)) return
      const o = document.createElement('option')
      o.value = s.sessionId
      const title = (s.projections && s.projections.values && s.projections.values.title) || ''
      const short = s.sessionId.replace(/^session-/, '').slice(0, 8)
      o.textContent = (s.running ? '● ' : '○ ') + (title || '会话 ' + short)
      sel.appendChild(o)
    })
    sel.value = R.currentId || ''
  }

  async function poll() {
    try {
      const resp = await window.pet.api('session.list', {})
      const result = resp && resp.result
      if (!result || !result.ok) {
        say('⚠️ 获取会话失败', 2000, 'ui')
        setTimeout(poll, 3000)
        return
      }
      const items = result.value.items || []
      R.sessions = items
      await refreshVisibleSessions()
      const visKey = R.visibleSessions ? [...R.visibleSessions].sort().join('|') : 'null'
      if (visKey !== R.visKey) {
        R.visKey = visKey
        renderSessionSelect()
      }
      const key = items.map((s) => s.sessionId + (s.running ? ':1' : ':0')).join('|')
      if (key !== sessionsKey) {
        sessionsKey = key
        renderSessionSelect()
      }
      if (!R.currentId || !items.some((s) => s.sessionId === R.currentId && (!R.visibleSessions || R.visibleSessions.has(s.sessionId)))) {
        const cand = pickDefaultSession(items)
        R.currentId = cand ? cand.sessionId : null
        renderSessionSelect()
        refreshSessionControls()
      }
      const cur = items.find((s) => s.sessionId === R.currentId) || null
      const running = !!(cur && cur.running)
      R.running = running
      if (running && R.lastSentAt) R.requestHasRun = true
      if ((prevRunning || R.requestHasRun) && !running && !pendingInter && R.lastSentAt && Date.now() - R.lastSentAt < 3600000) {
        R.requestHasRun = false
        R.lastSentAt = 0
      clearBusyTimeout()
        R.busy = false
        btnSend.disabled = false
        updateStatusUI()
        console.log('work-complete: preparing report')
        P.coins += 8
        gainExp(15)
        P.totalWorkDone += 1
        markDaily('work')
        addAffection(2)
        saveState()
        updateCoins()
        renderCare()
        addHearts(4)
        R.preparingReport = true
        animLockUntil = 0
        currentAnimName = null
        if (!R.hidden) playAnim('working')
        buildReport().then(async (text) => {
          const raw = String(text || '').trim()
          const { clean } = applyPetCommands(raw)
          const full = clean || '这次任务已经结束，但没有拿到可汇报的结果。'
          const summary = ''
          if (R.hidden) {
            pendingReport = { summary, full }
          } else {
            showReport(summary, full)
          }
          R.preparingReport = false
          setMood('happy', 700)
          if (!R.hidden) showAnimOnce('work-success')
        }).catch(() => {
          if (!R.hidden) showAnimOnce('work-error')
          say('执行已结束，但暂时没能取到汇报，可以在 DeepSeek Harness 桌面端查看。', 6000, 'ui')
        }).finally(() => { R.preparingReport = false; updateMood() })
      }

      prevRunning = running
      updateStatusUI()
      setTimeout(poll, 1500)
    } catch (err) {
      say('⚠️ 连不上 DSH，重试中…', 2000, 'ui')
      setTimeout(poll, 3000)
    }
  }

  /* ---------- interactions ---------- */

  // 头顶爱心动画已移除（1.1.15：用户不需要人物上方的表情动画），调用保留为 no-op
  function addHearts() { /* 已禁用 */ }

  // 摸头互动已移除（1.1.15：点击触发会干扰拖拽手感）

  function feedIt() {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'feed' })
    if ((P.inventory.cookie || 0) > 0) {
      if (R.sleepy) wakeUp()
      P.inventory.cookie -= 1
      P.feedCount += 1
      P.stats.satiety = clamp(P.stats.satiety + 20, 0, 100)
      setMood('eating', 10000)
      void runtimeNotify(execution => say(pick(LINES.eat), 5000, 'ui', undefined, execution), 'feed-feedback', 'user-feedback')
      renderCare()
      saveState()
      gainExp(1)
      unlockPhoto('first-cookie')
      touch()
      window.EventBus.emit('pet.fed', { item: 'cookie', satiety: P.stats.satiety })
    } else {
      say('背包里没有小饼干啦，去 🏪 商店买一点吧～', undefined, 'ui')
    }
  }

  let attachments = []

  function renderAttachments() {
    const wrap = $('attach-row')
    wrap.innerHTML = ''
    attachments.forEach((a, idx) => {
      const chip = document.createElement('div')
      chip.className = 'dp-attach-chip'
      const im = document.createElement('img')
      im.src = 'data:' + a.mime + ';base64,' + a.data
      const rm = document.createElement('button')
      rm.className = 'dp-mini-btn'
      rm.textContent = '✕'
      rm.addEventListener('click', () => {
        attachments.splice(idx, 1)
        renderAttachments()
      })
      chip.appendChild(im)
      chip.appendChild(rm)
      wrap.appendChild(chip)
    })
  }

  $('btn-attach').addEventListener('click', async () => {
    try {
      const img = await window.pet.pickImage()
      if (!img) return
      if (img.error) { say(img.error, undefined, 'ui'); return }
      attachments.push(img)
      renderAttachments()
    } catch (err) {
      say('选择图片失败', undefined, 'ui')
    }
  })

  function maybeRememberFromChat(text, execution) {
    try { noteOwnerReplyToProactive(text) } catch (e) { /* PC-3：降温只做记录，失败不得影响聊天 */ }
    if (!text || !window.MemoryEngine || typeof window.MemoryEngine.remember !== 'function') return
    const m = String(text).match(/(?:记住|请记住|记一下|别忘了|以后要|重要)[：:，,]?\s*(.+)/)
    if (!m) return
    const content = m[1].trim().replace(/[。！!]+$/, '').slice(0, 120)
    if (!content) return
    try {
      const r = window.MemoryEngine.remember(content, { type: 'fact', tags: ['chat'], ts: Date.now() })
      if (r && r.ok) say('📌 记住啦，会作为重要记忆保存～', 3500, execution ? 'ui' : 'user-feedback', undefined, execution)
    } catch (err) { /* ignore */ }
  }

  function clearBusyTimeout() { if (busyTimeout) { clearTimeout(busyTimeout); busyTimeout = null } }

  async function sendChat() {
    if (R.busy) { say('手头还有任务在处理，等它完成再派新的哦～', 3500, 'ui'); return }
    const text = ta.value.trim()
    const parts = []
    if (text) parts.push({ type: 'text', text })
    // Work/Agent chat: DSH surface only. Do NOT inject CharacterContext as user message.
    attachments.forEach((a) => {
      parts.push({ type: 'text', text: '[图片] ' + a.path })
    })
    if (!parts.length) return
    if (!R.currentId) { say('还没有可用的会话哦～', undefined, 'ui'); return }
    // 提交后立即进入 working，防止重复提交；是否算成功由 DSH 的 session.prompt 返回决定。
    R.busy = true
    btnSend.disabled = true
    updateStatusUI()
    try {
      const r = window.AIGateway && typeof window.AIGateway.sessionCommand === 'function'
        ? await window.AIGateway.sessionCommand({ sessionId: R.currentId, content: parts, text, mode: 'queue' })
        : null
      const ok = !!(r && r.result && r.result.ok)
      if (ok) {
        ensureAudio()
        ta.value = ''
        attachments = []
        renderAttachments()
        R.lastSentAt = Date.now()
        R.requestHasRun = false
        clearBusyTimeout()
        busyTimeout = setTimeout(() => { if (R.busy) { R.busy = false; btnSend.disabled = false; updateStatusUI(); say('任务似乎没有进入处理状态，已恢复空闲。', 4000, 'ui') } }, 30 * 60 * 1000)
        P.stats.energy = clamp(P.stats.energy - 3, 0, 100)
        say(pick(LINES.send), 3000, 'ui')
        updateStatusUI()
        renderCare()
        saveState()
        touch()
        if (text && /(真棒|好棒|厉害|可爱|好可爱|辛苦了|喜欢你|棒棒|聪明|贴心|乖|优秀)/.test(text)) {
          unlockPhoto('praised')
          diaryEvent('praise', '')
        }
        diaryEvent('task_request', text)
        /* 按天统计"今天聊了几句"，供照片 chat-ten（陪我聊聊）判定 */
        {
          const today = dayKey(new Date())
          if (P.chatCountDay !== today) { P.chatCountDay = today; P.chatCountToday = 0 }
          P.chatCountToday = (P.chatCountToday || 0) + 1
        }
        maybeRememberFromChat(text)
        // 保持 R.busy=true 直到 poll 检测到任务结束并生成汇报卡。
      } else {
        R.busy = false
        btnSend.disabled = !ta.value.trim()
        updateStatusUI()
        const err = r && r.result && r.result.error ? (r.result.error.message || r.result.error) : (r && r.result ? '会话请求失败' : '未知错误')
        say('发送失败：' + String(err), 5000, 'ui')
        if (!R.hidden) showAnimOnce('work-error')
      }
    } catch (err) {
      R.busy = false
      btnSend.disabled = !ta.value.trim()
      updateStatusUI()
      say('发送失败：连不上 DSH，稍后再试', 5000, 'ui')
      if (!R.hidden) showAnimOnce('work-error')
    }
  }

  function setPetVisible(visible) {
    petArea.classList.toggle('hidden', !visible)
    miniEl.classList.toggle('hidden', visible)
  }

  function doHide() {
    R.hidden = true
    roleRuntime.setVisible(false)
    chatBusy = false; charcBusy = false; clearChatIndicator(); bubbleOwner = ''; bubbleSeq++
    $('mini-chat-send').disabled = false
    if ($('charc-send')) { $('charc-send').disabled = false; $('charc-send').textContent = '发送 ➤' }
    if (window.PetLife && window.PetLife.setVisibility) window.PetLife.setVisibility(false, Date.now()).catch(err => console.warn('[living] hide:', err.message))
    cancelIdleChain()
    if (window.AnimationPlayer) window.AnimationPlayer.pause()
    if (R.chatOpen) closeChat()
    setPetVisible(false)
    window.pet.setMode('mini')
  }

  function doShow() {
    R.hidden = false
    roleRuntime.setVisible(true)
    if (window.PetLife && window.PetLife.setVisibility) window.PetLife.setVisibility(true, Date.now()).catch(err => console.warn('[living] show:', err.message))
    if (window.AnimationPlayer && window.AnimationPlayer.resume) window.AnimationPlayer.resume()
    if (R.mood === 'idle') armIdleChain()
    setPetVisible(true)
    if (pendingInter) {
      R.interExpanded = true
      window.pet.setMode('chat')
      renderInterCard()
      return
    }
    window.pet.setMode(R.chatOpen ? 'chat' : 'pet')
    if (pendingReport) {
      const t = pendingReport
      pendingReport = null
      showReport(t.summary, t.full)
    } else if (queuedReport) {
      const q = queuedReport
      queuedReport = null
      showReport(q.summary, q.fullText)
    } else {
      flushReminder()
      if (!activeReminder) say('我回来啦！', undefined, 'ui')
    }
  }

  function openChat() {
    roleRuntime.setConversationActive(true)
    ensureAudio()
    hidePhotoCard()
    if (bubbleEl.dataset.report !== '1' && bubbleEl.dataset.thinking !== '1' && bubbleEl.dataset.chatReply !== '1' && !bubbleEl.classList.contains('dp-bubble-interaction') && !bubbleEl.classList.contains('dp-bubble-remind')) clearSayBubble()
    R.chatOpen = true
    stage.classList.add('dp-open')
    panel.classList.remove('hidden')
    // 宠物缩小（84×118）：先适配再切窗口，避免窗口变化瞬间溢出渲染
    refitCurrentAnim()
    window.pet.setMode('chat')
    refreshSessionControls()
    syncClickThrough() // 窗口放大后重新判定穿透/UI 状态
    ta.focus()
  }

  function closeChat() {
    roleRuntime.setConversationActive(false)
    // 汇报卡还在显示时先收起它，避免卡片挂在缩小后的窗口上
    if (bubbleEl.dataset.report === '1') hideReport()
    R.chatOpen = false
    // 关闭瞬间抑制 dock 按钮条显示（dp-open 移除后鼠标仍悬停会闪现按钮，随后窗口缩小又收回）
    stage.classList.add('dp-closing')
    setTimeout(() => stage.classList.remove('dp-closing'), 350)
    stage.classList.remove('dp-open')
    panel.classList.add('hidden')
    if (game.playing) abortGame()
    abortSnake()
    // 先恢复人物尺寸再缩小窗口（否则窗口先缩、人物后恢复，会有一帧弹出/收回）
    refitCurrentAnim()
    if (!R.hidden) window.pet.setMode('pet')
    syncClickThrough() // 窗口收缩后立即重判：鼠标可能已落在窗外，清理 UI 残留
  }

  function refitCurrentAnim() {
    if (currentAnimName) {
      const v = document.getElementById('anim-' + currentAnimName)
      if (v) fitAnim(v, currentAnimName)
    }
  }

  /* ---------- 授权 / 提问交互（DSH 下行流） ---------- */

  let pendingInter = null // { rpcId, kind: 'approval' | 'question', payload }

  function interExpand() {
    if (!R.chatOpen && !R.hidden && !R.interExpanded) {
      R.interExpanded = true
      window.pet.setMode('chat')
    }
  }

  function interShrink() {
    if (R.interExpanded) {
      R.interExpanded = false
      if (!R.chatOpen && !R.hidden) window.pet.setMode('pet')
    }
  }

  async function sendInterAnswer(value) {
    if (!pendingInter) return
    const request = pendingInter
    if (request.answering) return
    request.answering = true
    const buttons = bubbleEl.querySelectorAll('.dp-inter-foot button')
    for (const b of buttons) b.disabled = true
    interHint('正在提交回答…')
    try {
      const receipt = await window.pet.respond({ rpcId: request.rpcId, value })
      if (pendingInter !== request) return
      if (receipt && receipt.accepted) {
        clearInterCard()
      } else {
        const reason = receipt && receipt.reason
        if (reason === 'not-pending') {
          clearInterCard()
          say('问题已失效，可能已在 DeepSeek Harness 桌面端处理或已超时。', undefined, 'ui')
        } else interHint('回答未通过服务端校验，请修改后重试。')
      }
    } catch (err) {
      if (pendingInter === request) interHint('连接失败，回答已保留；可以重试，或在 DeepSeek Harness 桌面端处理。')
    } finally {
      request.answering = false
      if (pendingInter === request) for (const b of buttons) b.disabled = false
    }
  }

  function clearInterCard() {
    pendingInter = null
    animLockUntil = 0
    currentAnimName = null
    updateMood()
    bubbleEl.classList.add('hidden')
    bubbleEl.innerHTML = ''
    bubbleEl.className = 'dp-bubble'
    stage.classList.remove('dp-busy-bubble')
    interShrink()
    // 交互处理完：恢复排队中的汇报卡（未被交互挤掉的优先，其次是小深隐藏期间攒的）
    if (!R.hidden) {
      if (queuedReport) {
        const q = queuedReport
        queuedReport = null
        showReport(q.summary, q.fullText)
      } else if (pendingReport) {
        const t = pendingReport
        pendingReport = null
        showReport(t.summary, t.full)
      } else {
        flushReminder()
      }
    }
  }

  // 交互卡显示期间 say(, undefined, 'ui') 会被拦截，校验提示直接画在卡片里
  function interHint(text) {
    let el = bubbleEl.querySelector('.dp-inter-hint')
    if (!el) {
      el = document.createElement('div')
      el.className = 'dp-inter-hint'
      const foot = bubbleEl.querySelector('.dp-inter-foot')
      if (foot) foot.insertAdjacentElement('beforebegin', el)
      else bubbleEl.appendChild(el)
    }
    el.textContent = text
    el.classList.remove('hidden')
  }

  function renderInterCard() {
    roleRuntime.cancel("technical_request", event => event.origin === "automatic")
    if (pendingInter && !R.hidden) {
      animLockUntil = 0
      currentAnimName = null
      playAnim('working')
    }
    if (!pendingInter) return
    // 汇报卡让位给选项卡：内容排队，交互处理完自动恢复（覆盖所有调用路径）
    if (bubbleEl.dataset.report === '1') {
      if (currentReport) queuedReport = currentReport
      hideReport()
    }
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    const { kind, payload } = pendingInter
    bubbleEl.innerHTML = ''
    bubbleEl.dataset.report = ''
    bubbleEl.className = 'dp-bubble dp-bubble-interaction'
    if (kind === 'approval') {
      const title = document.createElement('div')
      title.className = 'dp-bubble-report-title'
      title.textContent = '🔐 需要授权'
      const body = document.createElement('div')
      body.className = 'dp-inter-body'
      body.textContent = '工具：' + (payload.toolName || '未知') + (payload.reason ? '\n原因：' + payload.reason : '')
      const foot = document.createElement('div')
      foot.className = 'dp-inter-foot'
      const allow = document.createElement('button')
      allow.className = 'dp-mini-btn'
      allow.textContent = '✅ 允许一次'
      allow.addEventListener('click', () => {
        sendInterAnswer({ sessionId: payload.sessionId, approvalId: payload.approvalId, outcome: 'allowed-once' })
      })
      const reject = document.createElement('button')
      reject.className = 'dp-mini-btn'
      reject.textContent = '❌ 拒绝'
      reject.addEventListener('click', () => {
        sendInterAnswer({ sessionId: payload.sessionId, approvalId: payload.approvalId, outcome: 'rejected' })
      })
      foot.appendChild(allow)
      foot.appendChild(reject)
      bubbleEl.appendChild(title)
      bubbleEl.appendChild(body)
      bubbleEl.appendChild(foot)
    } else {
      const title = document.createElement('div')
      title.className = 'dp-bubble-report-title'
      title.textContent = '❓ ' + '工作任务需要确认'
      bubbleEl.appendChild(title)
      ;(payload.questions || []).forEach((q) => {
        const qWrap = document.createElement('div')
        qWrap.className = 'dp-inter-q'
        qWrap.dataset.qid = q.id
        qWrap.dataset.multi = q.multiSelect ? '1' : '0'
        if (q.header) {
          const h = document.createElement('div')
          h.className = 'dp-inter-q-header'
          h.textContent = q.header
          qWrap.appendChild(h)
        }
        const qText = document.createElement('div')
        qText.className = 'dp-inter-q-text'
        qText.textContent = q.question
        qWrap.appendChild(qText)
        if (q.detail) {
          const d = document.createElement('div')
          d.className = 'dp-inter-q-detail'
          d.textContent = q.detail.length > 200 ? q.detail.slice(0, 200) + '…' : q.detail
          qWrap.appendChild(d)
        }
        const selected = []
        ;(q.options || []).forEach((opt) => {
          const btn = document.createElement('button')
          btn.className = 'dp-inter-opt'
          btn.textContent = opt.label
          btn.title = opt.description || ''
          btn.addEventListener('click', () => {
            if (q.multiSelect) {
              const i = selected.indexOf(opt.label)
              if (i >= 0) {
                selected.splice(i, 1)
                btn.classList.remove('dp-inter-opt-on')
              } else {
                selected.push(opt.label)
                btn.classList.add('dp-inter-opt-on')
              }
            } else {
              selected.length = 0
              selected.push(opt.label)
              qWrap.querySelectorAll('.dp-inter-opt').forEach((b) => b.classList.remove('dp-inter-opt-on'))
              btn.classList.add('dp-inter-opt-on')
            }
          })
          qWrap.appendChild(btn)
        })
        const input = document.createElement('input')
        input.className = 'dp-name-input'
        input.placeholder = '其他（选填）'
        qWrap.appendChild(input)
        qWrap.__selected = selected
        qWrap.__input = input
        bubbleEl.appendChild(qWrap)
      })
      const foot = document.createElement('div')
      foot.className = 'dp-inter-foot'
      const submit = document.createElement('button')
      submit.className = 'dp-mini-btn'
      submit.textContent = '提交'
      submit.addEventListener('click', () => {
        const answers = []
        let missing = 0
        bubbleEl.querySelectorAll('.dp-inter-q').forEach((qw) => {
          const sel = qw.__selected
          const custom = qw.__input.value.trim()
          const a = { id: qw.dataset.qid, selected: sel.slice() }
          if (custom) {
            a.custom = custom
            // 服务端规则：单选时 custom 覆盖 selected，两者不能同时提交
            if (qw.dataset.multi !== '1') a.selected = []
          }
          if (!custom && !sel.length) { missing++; return }
          answers.push(a)
        })
        if (missing) {
          interHint('还有 ' + missing + ' 个问题没回答哦～')
          return
        }
        // 服务端校验形状：{ sessionId, answer: { answers: [...] } }
        sendInterAnswer({ sessionId: payload.sessionId, answer: { answers } })
      })
      foot.appendChild(submit)
      bubbleEl.appendChild(foot)
    }
    bubbleEl.classList.remove('hidden')
    stage.classList.add('dp-busy-bubble')
    playDing('chat')
  }

  function handleStreamFrame(frame) {
    const f = frame && frame.payload
    if (!f) return
    if (f.type === 'approval/requested' || f.type === 'question/requested') {
      if (f.sessionId !== R.currentId) return
      if (bubbleEl.dataset.report === '1') {
        // 汇报卡让位给选项卡：内容排队，交互处理完自动恢复
        if (currentReport) queuedReport = currentReport
        hideReport()
      }
      pendingInter = { rpcId: frame.rpcId, kind: f.type === 'approval/requested' ? 'approval' : 'question', payload: f }
      if (R.hidden) {
        // 迷你模式下先存着，等主人唤回小深再展示
        playDing('proactive')
        return
      }
      interExpand()
      renderInterCard()
    } else if (f.type === 'approval/resolved') {
      if (pendingInter && pendingInter.payload && pendingInter.payload.approvalId === f.approvalId) clearInterCard()
    } else if (f.type === 'question/resolved') {
      if (pendingInter && pendingInter.rpcId === f.questionRpcId) clearInterCard()
    }
  }

  window.pet.onStreamFrame(handleStreamFrame)

  // 手机端发来的 <pet-command> 指令：本地执行（待办/课程/备忘录），结果回给桥


  /* ---------- 提醒卡（番茄钟/课程/喝水）：常驻直到处理 ---------- */

  let activeReminder = null // { kind, title, text, buttons: [{label, onClick}] }
  let queuedReminder = null // 迷你模式或气泡被占用时排队（容量 1）

  function flushReminder() {
    if (!queuedReminder) return
    if (R.hidden || activeReminder) return
    if (bubbleEl.classList.contains('dp-bubble-interaction') || bubbleEl.dataset.report === '1') return
    const r = queuedReminder
    queuedReminder = null
    fireReminder(r, true)
  }

  function clearReminderCard() {
    activeReminder = null
    bubbleEl.classList.add('hidden')
    bubbleEl.innerHTML = ''
    bubbleEl.classList.remove('dp-bubble-remind', 'dp-remind-pomo', 'dp-remind-class', 'dp-remind-water')
    bubbleEl.dataset.remind = ''
    stage.classList.remove('dp-busy-bubble')
    if (R.remindExpanded && !R.chatOpen && !R.hidden) {
      R.remindExpanded = false
      window.pet.setMode('pet')
    }
    flushReminder()
  }

  function renderReminderCard(data) {
    roleRuntime.cancel("technical_reminder", event => event.origin === "automatic")
    bubbleEl.innerHTML = ''
    bubbleEl.dataset.remind = data.kind
    bubbleEl.className = 'dp-bubble dp-bubble-remind dp-remind-' + data.kind
    const title = document.createElement('div')
    title.className = 'dp-bubble-report-title'
    title.textContent = data.title
    const body = document.createElement('div')
    body.className = 'dp-remind-body'
    // 台词气泡：优先取该提醒组的自定义/官方台词，作为提醒的"开场白"
    const line = '' // Technical reminders have no independent character opening.
    body.textContent = line ? line + '\n' + data.text : data.text
    const foot = document.createElement('div')
    foot.className = 'dp-inter-foot'
    ;(data.buttons || []).forEach((b) => {
      const btn = document.createElement('button')
      btn.className = 'dp-mini-btn'
      btn.textContent = b.label
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        b.onClick()
      })
      foot.appendChild(btn)
    })
    const close = document.createElement('button')
    close.className = 'dp-mini-btn'
    close.textContent = '✕'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      clearReminderCard()
    })
    foot.appendChild(close)
    bubbleEl.appendChild(title)
    bubbleEl.appendChild(body)
    bubbleEl.appendChild(foot)
    bubbleEl.classList.remove('hidden')
    stage.classList.add('dp-busy-bubble')
  }

  // 提醒 → 台词组映射：番茄钟/上课/喝水各自独立，支持台词池自定义
  function pickRemindLine(kind) {
    const map = { pomo: 'remind-pomo', class: 'remind-class', water: 'remind-water' }
    const g = map[kind]
    if (!g) return ''
    const pool = linesForGroup(g)
    if (!pool.length) return ''
    return pool[Math.floor(Math.random() * pool.length)]
  }

  // silent=true 表示从排队恢复，音效已在首次触发时播过
  function fireReminder(data, silent) {    if (R.hidden) {
      queuedReminder = data
      if (!silent) playRemindSound(data.kind)
      return
    }
    if (bubbleEl.classList.contains('dp-bubble-interaction') || bubbleEl.dataset.report === '1') {
      queuedReminder = data
      if (!silent) playRemindSound(data.kind)
      return
    }
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (!R.chatOpen) {
      R.remindExpanded = true
      window.pet.setMode('chat')
    }
    activeReminder = data
    renderReminderCard(data)
    if (!silent) playRemindSound(data.kind)
  }

  /* ---------- 日常聊天（微型聊天框 → DeepSeek 人设闲聊） ---------- */

  let chatBusy = false
  let miniChatRequestVersion = 0

  // 闲聊回复与随机台词用同一个气泡（小巧、居中头顶，不展开窗口）
  function chatSay(text, ms, source, token) {
    const t = String(text || '').trim()
    if (!t) return
    if (token !== undefined && !bubbleTokenValid(token)) return
    if (isInternalUiText(t)) return
    const duration = ms || bubbleDurationMs(t)
    // 先解除保护，允许回复气泡替换思考气泡；显示后重新上保护。
    // 同时清除汇报卡/提醒卡的残留标志（用户主动聊天 = 最高优先级，回复必须显示）
    bubbleEl.dataset.report = ''
    bubbleEl.classList.remove('dp-bubble-report', 'dp-bubble-remind')
    bubbleEl.dataset.thinking = ''
    bubbleEl.dataset.chatReply = ''
    const res = say(t, duration, source, token)
    if (res && res.ok) {
      bubbleEl.classList.add('dp-chat-reply')
      bubbleEl.dataset.chatReply = '1'
    } else {
      bubbleEl.dataset.chatReply = ''
      bubbleEl.classList.remove('dp-chat-reply')
    }
    return res
  }

  function clearChatIndicator() {
    bubbleEl.dataset.thinking = ''
    bubbleEl.dataset.chatReply = ''
    bubbleEl.classList.remove('dp-chat-reply')
  }

  /* 3.1 S2：AI 关闭 / 网关不可用时，用**本地状态表达**兜底（只读投影，不新增事实；
     也不装成"回答了内容"——本地模板只负责表达"我在、我听到了"）。 */
  function localStateExpressionLine(userText, aiContext) {
    try {
      if (!window.StateExpression || typeof window.StateExpression.project !== 'function') return null
      const se = window.StateExpression.project(aiContext || {}, userText || '')
      const line = window.StateExpression.localFallback(se)
      return line ? String(line) : null
    } catch (err) { return null }
  }

  /* 角色聊天的**唯一** AI 调用点（迷你输入与面板「💗 与小深说话」tab 共用 ⇒ 全仓 AI 调用点计数不变）。
     2026-09-25 用户裁定 B：面板新增角色聊天 tab 属于同一套聊天，**不新增第五个 AI 调用点**。 */
  async function characterChatRequest(payload, execution) {
    if (characterRetryTurn && characterRetryTurn.messageRef) payload.messageRef = characterRetryTurn.messageRef
    rememberFromUserMessage(payload)
    const source = (payload.history || []).find(row => row.role === 'user' && row.messageRef === payload.messageRef)
    const permit = roleRuntime.retainFacts(execution, source)
    if (permit && window.pet.platform) {
      const began = await window.pet.platform.extraction(source.messageRef)
      if (!began || began.ok === false) { roleRuntime.completeFacts(permit); return { ok: false, reason: began && began.reason || 'extraction_checkpoint_failed' } }
    }
    let attached = false
    if (permit) payload.onMetadata = promise => {
      if (attached) return
      attached = true
      const expressionContinuation = execution.continueAs('metadata-expression')
      promise.then(async metadata => {
        if (!roleRuntime.isFactAuthorized(permit, source.messageRef) || !metadata || metadata.messageRef !== source.messageRef) return
        if (window.pet.platform) await window.pet.platform.extraction(source.messageRef, { ok: metadata.ok !== false, reason: metadata.reason })
        if (metadata.ok === false) throw Error(metadata.reason || 'metadata_failed')
        const recorded = await window.PetLife.recordTurn({ runtimeFactExecution: permit, metadataOnly: true,
          messageRef: source.messageRef, ts: source.ts, userText: source.text,
          memory: metadata.memory, conversation: metadata.conversation,
          replyTo: payload.context && payload.context.proactiveReplyTo })
        if (recorded && recorded.ok === false) throw Error(recorded.reason || 'metadata_save_failed')
        if (!roleRuntime.isFactAuthorized(permit, source.messageRef)) return
        if (latestCharacterTurnRef === source.messageRef && Date.now() - source.ts < 10000 &&
          !roleRuntime.snapshot().queued.some(turn => turn.kind === 'reply') && roleRuntime.continuation(expressionContinuation)) {
          presentCharacterExpression({ conversation: metadata.conversation }, execution)
        }
        renderLivingNotebook()
      }).catch(err => console.warn('[pet-life] metadata save failed:', err.message)).finally(() => {
        roleRuntime.completeFacts(permit)
        roleRuntime.completeContinuation(expressionContinuation)
      })
    }
    try {
      return window.AIGateway && typeof window.AIGateway.request === 'function'
        ? await window.AIGateway.request(payload) : { ok: false, reason: 'gateway_unavailable' }
    } finally { if (permit && !attached) roleRuntime.completeFacts(permit) }
  }
  /* A2：**用户自己说过的背景/偏好** ⇒ 交给既有记忆写入面
     （`MemoryEngine.processUserMessage`：规则版提及检测＋证据 messageRef＋去重/合并/状态，零 AI）。
     边界：只处理 `role==='chat'` 的 `userText`（绝不写 AI 自己的话）；fail-soft：任何异常都不得影响聊天主链
     （同 C2-F1 经历旁挂纪律）；是否真的写入由 memory-topic 的规则决定（本人知道=不在话下，不推断）。 */
  function rememberFromUserMessage(payload) {
    try {
      const p = payload || {}
      const text = (p.role === 'chat' && typeof p.userText === 'string') ? p.userText.trim() : ''
      if (!text) return
      const me = window.MemoryEngine
      if (!me || typeof me.processUserMessage !== 'function') return
      const r = me.processUserMessage(text, { messageRef: p.messageRef || null, ts: Date.now() })
      const hits = (r && Array.isArray(r.results)) ? r.results.filter((x) => x && x.memory) : []
      if (hits.length) { try { console.log('memory-user-mention ' + JSON.stringify({ n: hits.length, actions: hits.map((x) => x.action) })) } catch (e2) { /* ignore */ } }
    } catch (err) { /* 记忆写入失败不影响聊天 */ }
  }
  function applyKernelProjection(projection) {
    if (!projection?.ok || !projection.state) return
    const body = projection.state
    kernelState.apply({ ...body.legacyUnmapped, ...body.preferences, ...body.nurture,
      stats: { ...body.needs }, relationship: structuredClone(body.relationship), affection: body.relationship?.affection || 0 })
    P.name = body.displayName || projection.displayName || P.name
    const work = body.nurture?.work
    R.workId = work?.id || null; R.workStart = work?.startedAt || 0
    R.workEnd = work ? Date.now() + Math.max(0, (WORK_JOBS.find(job => job.id === work.id)?.minutes || 0) * 60000 - work.elapsedMs) : 0
    restUntil = body.nurture?.rest ? Date.now() + body.nurture.rest.remainingMs : 0
    restEndAt = restUntil
    const timer = body.nurture?.focus
    focus.kernelTimer = timer || null
    focus.active = !!timer && !timer.paused
    focus.remaining = timer ? Math.ceil(timer.remainingMs / 1000) : (focus.mode === 'study' ? 1500 : 300)
    if (timer) focus.mode = timer.mode
    focus.projectedAt = Date.now()
    $('btn-focus').textContent = focus.active ? '暂停' : timer ? '继续专注 ⏱' : '开始专注 ⏱'
    updateFocusClock(); updateFocusMeta()
    renderCare(); updateCoins(); renderWorkList(); renderRestStatus()
  }
  async function submitKernelInteraction(payload) {
    const result = await window.pet.character.submit({ kind: 'owner.interaction', payload })
    if (!result?.ok) systemNotice('操作未完成：' + (result?.code || 'kernel_unavailable'), 5000, 'ui')
    else {
      applyKernelProjection(await window.pet.character.read())
      const item = payload.kind === 'feed' ? 'cookie' : payload.kind === 'use_item' ? payload.item : null
      if (item && ITEMS[item]?.category === 'meal') await window.pet.character.submit({ kind: 'owner.interaction', payload: { kind: 'animation', name: 'eat-snack' } })
    }
    return result
  }
  async function submitKernelChat(input) {
    const text = input && input.value.trim()
    if (!text) return { ok: false, reason: 'message_empty' }
    const messageRef = window.MemoryMessageRef.next()
    const result = await window.pet.character.submit({ commandId: 'owner:' + messageRef, kind: 'owner.message',
      payload: { text, messageRef, ts: Date.now(), sessionId: 'desktop-chat', timezone: 'Asia/Shanghai' } })
    if (result?.ok) { if (input.value.trim() === text) input.value = ''; refreshCharacterHistoryViews() }
    else systemNotice('消息未送达：' + (result?.code || 'kernel_unavailable'), 6000, 'ui')
    return result
  }
  if (window.pet.character?.authority) window.pet.character.onEvent(event => {
    if (event?.kind === 'ready') window.pet.character.read().then(applyKernelProjection)
    if (event?.kind === 'delta') {
      applyKernelProjection(event.event?.projection)
      refreshCharacterHistoryViews()
      if (event.event?.kind === 'owner.reply' && event.event.detail?.outcome === 'failed') systemNotice('本次回复未完成，可稍后重试。', 6000, 'ui')
    }
  })
  async function sendMiniChat(execution, submittedText) {
    if (window.pet.character?.authority) return submitKernelChat($('mini-chat-input'))
    if (!roleRuntime.isAuthorized(execution)) {
      const input = $('mini-chat-input'), text = input.value.trim()
      if (!text) return
      input.value = ''
      const result = await submitOwnerReply(text, permit => sendMiniChat(permit, text))
      if (result && !result.ok && !result.cancelled && !result.committed && !input.value) input.value = text
      return result
    }
    const input = $('mini-chat-input')
    const text = submittedText || input.value.trim()
    if (!text) return
    const requestVersion = ++miniChatRequestVersion
    characterUiExecutionId = execution.executionId
    let actionResult = { ok: false, reason: "reply_incomplete" }
    livingPresence.user()
  Pace.onUser() /* P0-1 第二批：主人开口 ⇒ 连发计数复位 */
    if (!submittedText) input.value = ''
    chatBusy = true
    const requestToken = beginBubble('character-chat', execution)
    if (!requestToken) { chatBusy = false; if (!input.value) input.value = text; return { ok: false, reason: 'bubble_unavailable' } }
    characterChatActiveCount++
    cancelRandomTimer()
    $('mini-chat-send').disabled = true
    ensureAudio()
    say('（认真思考中…）', 60000, 'character-chat', requestToken)
    bubbleEl.dataset.thinking = '1'
    // 聊天动画：发送后切"思考"，回复到达切"开心"，失败恢复待机
    if (!R.running && !R.dragging) setMood('chatting')
    try {
      const history = await prepareCharacterTurn(text, execution)
      const aiContext = window.CharacterSnapshot && typeof window.CharacterSnapshot.toCharacterAIContext === 'function'
        ? window.CharacterSnapshot.toCharacterAIContext({ userText: text, history })
        : {}
      /* R-11 B/C（用户授权）：把"她真实开过的口"与"这句在回应哪条开场"作为**只读**上下文交给 Chat。
         只读已有内存态（proactiveOpeningLog / proactiveAwaitingReply）；取不到就不带（不伪造）。 */
      try {
        if (Array.isArray(proactiveOpeningLog) && proactiveOpeningLog.length) aiContext.proactiveOpenings = proactiveOpeningLog.slice()
        const __aw = proactiveAwaitingReply
        if (__aw && __aw.id) aiContext.proactiveReplyTo = { instanceId: __aw.id, presentedAt: __aw.presentedAt, opening: proactiveOpeningText || '', explicit: __aw.explicit === true }
      } catch (err) { /* 取不到就不带 */ }
      execution.assertCurrent()
      const r = (characterRetryTurn && characterRetryTurn.reply) || await characterChatRequest({ role: 'chat', userText: text, context: aiContext, history, timeoutMs: 90000, force: true, source: 'mini-chat' }, execution)
      execution.assertCurrent()
      actionResult = { ok: !!(r && r.ok && r.text), reason: r && r.reason }
      const reply = r && r.ok ? r.text : null
      if (reply) {
        await persistCharacterReply(text, r, execution)
        execution.assertCurrent()
        actionResult.committed = true
        markDaily('chat')
        maybeRememberFromChat(text, execution)
        addAffection(1)
        presentCharacterExpression(r, execution)
        // 被夸害羞：DSH 语义判断用户夸了小深 → 回复带 [PRAISED] 标记 → 解锁照片 + 害羞
        let finalReply = String(reply)
        let praised = false
        if (finalReply.indexOf('[PRAISED]') === 0) {
          praised = true
          finalReply = finalReply.replace(/^\[PRAISED\]\s*/, '')
          unlockPhoto('praised')
        }
        // AI response is complete: release request lock so user can interrupt during presentation.
        chatBusy = false
        $('mini-chat-send').disabled = false
        Pace.onAssistant()
        /* S6：若本轮是"回应主动开场" ⇒ 上报 reply（状态 ③）并写一条 `P1_proactive_talk` 经历。
           三条件（presentedAt / repliedAt / 回复非空）由 builder＋主进程 recordExperience 双闸；
           eventId＝'p1:<instanceId>' ⇒ 同 instance 不会重复写（**不用递增序号**）。 */
        if (proactiveAwaitingReply && r.conversation && r.conversation.replyTo === proactiveAwaitingReply.id) {
          const aw = proactiveAwaitingReply
          proactiveAwaitingReply = null
          try { console.log('[proactive] reply', aw.id, 'via=chat') } catch (e) { /* ignore */ }
          proactiveReport({ type: 'reply', id: aw.id, nowTs: Date.now() }).then((rr) => {
            if (!rr || rr.ok !== true) return
            try {
              const W = window.PresenceWriters
              const entry = (W && typeof W.buildProactiveTalkExperience === 'function')
                ? W.buildProactiveTalkExperience({ instanceId: aw.id, presentedAt: aw.presentedAt, repliedAt: Date.now(), replyText: text, ts: Date.now() })
                : null
              if (entry && window.pet && typeof window.pet.experienceEvent === 'function') window.pet.experienceEvent(entry)
            } catch (err) { /* 经历写入失败不影响聊天主链 */ }
          }).catch(() => {})
        }
        // Presentation projection: keep one assistant history entry, display via DialogueSequence beats.
        bubbleEl.dataset.report = ''
        bubbleEl.classList.remove('dp-bubble-report', 'dp-bubble-remind')
        bubbleEl.dataset.thinking = ''
        bubbleEl.dataset.chatReply = ''
        const presReq = {
          requestId: 'mini-chat-pres-' + Date.now(),
          intentKind: 'chat',
          tone: (r.conversation && r.conversation.expression && r.conversation.expression.tone) || 'neutral',
          userText: text,
          emotion: aiContext.emotion,
          relationship: aiContext.relationship,
          styleHints: aiContext.personaProjection && aiContext.personaProjection.expressionProfile ? {
            verbosity: 0.5,
            warmth: aiContext.relationship && typeof aiContext.relationship.affection === 'number' ? Math.min(1, aiContext.relationship.affection / 100) : 0.5
          } : undefined
        }
        const beats = window.DialogueEngine && typeof window.DialogueEngine.buildBeatsFromText === 'function'
          ? window.DialogueEngine.buildBeatsFromText(finalReply, presReq, null)
          : []
        const bubbleToken = requestToken
        if (Array.isArray(beats) && beats.length > 1) {
          const seqResult = await sayBeats(beats, bubbleToken)
          if (!seqResult || seqResult.status !== 'completed') actionResult = { ok: false, committed: true, reason: seqResult && seqResult.reason || 'presentation_incomplete' }
          if (bubbleTokenValid(bubbleToken)) {
            if (seqResult && seqResult.status === 'completed') {
              bubbleEl.classList.add('dp-chat-reply')
              bubbleEl.dataset.chatReply = '1'
            } else {
              bubbleEl.dataset.chatReply = ''
              bubbleEl.classList.remove('dp-chat-reply')
            }
          }
        } else {
          const presentation = chatSay(finalReply, undefined, 'character-chat', bubbleToken)
          if (!presentation || !presentation.ok) actionResult = { ok: false, committed: true, reason: presentation && presentation.reason || 'presentation_failed' }
          if (bubbleTokenValid(bubbleToken)) endBubble(bubbleToken)
        }
        execution.assertCurrent()
        if (praised) { setMood('happy', 12000); addHearts(3) }
        touch()
      } else if (r && r.reason === 'quota_exhausted') {
        clearChatIndicator()
        setMood('idle')
        say('今天已经聊了不少啦，先让我安静休息一下，明天再继续陪你聊～', 4500, 'character-chat', requestToken)
      } else if (r && (r.reason === 'disabled' || r.reason === 'gateway_unavailable')) {
        clearChatIndicator()
        setMood('idle')
        say(localStateExpressionLine(text, aiContext) || 'AI 聊天暂时没开，稍后再找我聊聊哦～', 4500, 'character-chat', requestToken)
      } else if (r && (r.reason === 'empty_or_timeout' || r.reason === 'timeout')) {
        clearChatIndicator()
        setMood('idle')
        say(characterChatFailureMessage(r.reason), 6000, 'character-chat', requestToken)
      } else if (r && r.reason === 'persona_boundary') {
        clearChatIndicator()
        setMood('idle')
        say('这个我可不能乱说哦～', 4500, 'character-chat', requestToken)
      } else {
        clearChatIndicator()
        setMood('idle')
        say(characterChatFailureMessage(r && r.reason), 7000, 'character-chat', requestToken)
      }
      if (!reply && !input.value) input.value = text
    } catch (err) {
      actionResult = { ok: false, cancelled: !execution.isCurrent(), reason: err.code || err.message }
      if (execution.isCurrent()) {
      clearChatIndicator()
      setMood('idle')
      if (!input.value) input.value = text
      say(characterChatFailureMessage(err && err.message), 6000, 'character-chat', requestToken)
      }
    }
    if (typeof requestToken === 'number' && bubbleTokenValid(requestToken)) endBubble(requestToken)
    finishCharacterChat()
    if (requestVersion === miniChatRequestVersion && characterUiExecutionId === execution.executionId) {
      chatBusy = false
      $('mini-chat-send').disabled = false
    }
    return actionResult
  }

  $('mini-chat-send').addEventListener('click', sendMiniChat)
  /* B：面板「💗 与小深说话」tab 的发送/回车（与迷你输入同款语义：Enter 发送） */
  if ($('charc-send')) $('charc-send').addEventListener('click', charcSend)
  if ($('charc-input')) {
    $('charc-input').addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); charcSend() }
    })
  }
  $('mini-chat-input').addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendMiniChat() }
  })
  // 迷你聊天：聚焦时切"聊天思考"动画，失焦恢复
  $('mini-chat-input').addEventListener('focus', () => {
    if (!R.running && !R.dragging) setMood('chatting')
  })
  $('mini-chat-input').addEventListener('blur', () => {
    if (R.mood === 'chatting') setMood('idle')
  })

  /* ---------- 历史记录 ---------- */

  const histState = { events: [], minSeq: null }

  function msgText(message) {
    if (!message || !Array.isArray(message.content)) return ''
    return message.content
      .filter((b) => b && b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
      .trim()
  }

  async function loadHist(more) {
    if (!R.currentId) return
    try {
      const payload = { sessionId: R.currentId, maxMessages: 32 }
      if (more && histState.minSeq != null) payload.beforeSeq = histState.minSeq
      const resp = await window.pet.api('session.history', payload)
      const r = resp && resp.result
      if (!r || !r.ok) return
      const events = (r.value && r.value.events) || []
      if (!events.length) {
        if (!more) renderHist()
        return
      }
      histState.events = more ? histState.events.concat(events) : events
      histState.minSeq = events[0].event.seq
      renderHist()
    } catch (err) { /* ignore */ }
  }

  function refreshHist() {
    histState.events = []
    histState.minSeq = null
    loadHist(false)
  }

  function splitAssistantBubbles(text) {
    const t = String(text || '').trim()
    if (!t) return []
    // 短回复保持单气泡
    if (t.length <= 50) return [t]
    const rawParts = t.split(/(?<=[，、。！？；;])/).map((x) => x.trim()).filter(Boolean)
    const bubbles = []
    let current = ''
    const pushCurrent = () => { if (current) bubbles.push(current); current = '' }
    for (const part of rawParts) {
      if (part.length > 50) {
        pushCurrent()
        for (let i = 0; i < part.length; i += 50) bubbles.push(part.slice(i, i + 50))
      } else if (current.length + part.length > 50) {
        pushCurrent()
        current = part
      } else {
        current += part
      }
    }
    pushCurrent()
    return bubbles.length ? bubbles : [t]
  }

  function renderHist() {
    const list = $('hist-list')
    const entries = []
    let cur = null
    for (const ev of histState.events) {
      const e = ev && ev.event
      if (!e) continue
      if (e.type === 'turn/start') {
        if (cur && (cur.user || cur.assistant || (cur.assistantParts && cur.assistantParts.length))) entries.push(cur)
        cur = { user: '', assistant: '', assistantParts: [] }
      }
      if (!cur) cur = { user: '', assistant: '', assistantParts: [] }
      if (e.type === 'user/message') {
        const d = e.data || {}
        if (!d.source || d.source.kind !== 'user') continue
        const t = msgText({ content: d.content })
        if (t) cur.user = cur.user ? cur.user + String.fromCharCode(10) + t : t
      } else if (e.type === 'assistant/message') {
        const t = msgText(e.data && e.data.message)
        if (t) {
          cur.assistantParts.push(t)
          cur.assistant = cur.assistantParts.join(String.fromCharCode(10) + String.fromCharCode(10))
        }
      }
    }
    if (cur && (cur.user || cur.assistant || (cur.assistantParts && cur.assistantParts.length))) entries.push(cur)
    const ordered = entries.slice().reverse()
    list.innerHTML = ''
    ordered.forEach((en) => {
      if (en.user) {
        const item = document.createElement('div')
        item.className = 'dp-hist-item'
        const role = document.createElement('div')
        role.className = 'dp-hist-role dp-hist-user'
        role.textContent = '🧑 你'
        const txt = document.createElement('div')
        txt.className = 'dp-hist-text'
        txt.textContent = en.user.length > 500 ? en.user.slice(0, 500) + ' …' : en.user
        item.appendChild(role)
        item.appendChild(txt)
        list.appendChild(item)
      }
      const assistantBubbles = en.assistantParts && en.assistantParts.length
        ? en.assistantParts.flatMap((p) => splitAssistantBubbles(p))
        : splitAssistantBubbles(en.assistant || '')
      assistantBubbles.forEach((bubbleText) => {
        if (!bubbleText) return
        const item = document.createElement('div')
        item.className = 'dp-hist-item'
        const roleRow = document.createElement('div')
        roleRow.className = 'dp-hist-role-row'
        const role = document.createElement('span')
        role.className = 'dp-hist-role dp-hist-assistant'
        role.textContent = '🐳 ' + P.name
        const copyBtn = document.createElement('button')
        copyBtn.className = 'dp-mini-btn'
        copyBtn.textContent = '📋'
        copyBtn.title = '复制这段回复'
        copyBtn.addEventListener('click', () => {
          copyText(bubbleText).then(() => {
            copyBtn.textContent = '✅'
            setTimeout(() => { copyBtn.textContent = '📋' }, 1500)
          }).catch(() => {})
        })
        const memoBtn = document.createElement('button')
        memoBtn.className = 'dp-mini-btn'
        memoBtn.textContent = '📝'
        memoBtn.title = '存为备忘录'
        memoBtn.addEventListener('click', () => {
          const ok = addMemo(bubbleText)
          memoBtn.textContent = ok ? '✅' : '📝'
          setTimeout(() => { memoBtn.textContent = '📝' }, 1500)
        })
        roleRow.appendChild(role)
        roleRow.appendChild(copyBtn)
        roleRow.appendChild(memoBtn)
        const txt = document.createElement('div')
        txt.className = 'dp-hist-text'
        txt.textContent = bubbleText.length > 1200 ? bubbleText.slice(0, 1200) + String.fromCharCode(10) + '…（点 📋 可复制完整内容）' : bubbleText
        item.appendChild(roleRow)
        item.appendChild(txt)
        list.appendChild(item)
      })
    })
    $('hist-info').textContent = entries.length ? '最近 ' + entries.length + ' 轮 · 可加载更早' : '暂无记录'
    $('btn-hist-more').disabled = histState.minSeq == null
  }

    $('btn-hist-refresh').addEventListener('click', refreshHist)
  $('btn-hist-more').addEventListener('click', () => loadHist(true))

  /* ---------- tabs ---------- */

  const tabButtons = document.querySelectorAll('.dp-tabs .dp-tab')
  function switchTab(name) {
    if (name === R.activeTab) return
    $('panel-toast').classList.add('hidden')
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null }
    if (R.activeTab === 'game') {
      if (game.playing) abortGame()
      abortSnake()
    }
    R.activeTab = name
    /* B：新增第 8 个 tab「💗 与小深说话」（角色聊天）；原有 7 个 tab 一字未动，
       DSH 派活面（tab-chat）**不取代**。 */
    ;['chat', 'care', 'focus', 'remind', 'shop', 'game', 'settings', 'charc'].forEach((t) => {
      $('tab-' + t).classList.toggle('hidden', t !== name)
    })
    tabButtons.forEach((b) => b.classList.toggle('dp-tab-active', b.dataset.tab === name))
    // 切 tab 时刷新列表类内容（防御：确保任何路径添加/删除后显示一致）
    if (name === 'focus') { renderMemos(); renderTodos() }
    if (name === 'remind') renderSchedule()
    if (name === 'care') renderCare()
    /* 角色聊天 tab：每次切进来都从存储重读（唯一的真值来源＝character-chat-history.json） */
    if (name === 'charc') renderCharc()
  }
  tabButtons.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)))

  /* 聊天页内部视图切换：💬 聊天 / 📜 历史 / 📔 日记 */
  function switchChatView(name) {
    R.chatView = name
    $('chat-body').classList.toggle('hidden', name !== 'chat')
    $('hist-body').classList.toggle('hidden', name !== 'hist')
    $('diary-body').classList.toggle('hidden', name !== 'diary')
    $('view-chat').classList.toggle('dp-tab-active', name === 'chat')
    $('view-hist').classList.toggle('dp-tab-active', name === 'hist')
    $('view-diary').classList.toggle('dp-tab-active', name === 'diary')
    if (name === 'hist') refreshHist()
    if (name === 'diary') renderDiary()
  }
  $('view-chat').addEventListener('click', () => switchChatView('chat'))
  $('view-hist').addEventListener('click', () => switchChatView('hist'))
  $('view-diary').addEventListener('click', () => switchChatView('diary'))
  $('btn-diary-now').addEventListener('click', () => { writeDiary(true) })

  /* ---------- wiring ---------- */

  let dragging = false
  let dragMoved = false
  let pressTime = 0 // 按下时间戳（点击判定延迟用）
  let pressCX = 0
  let pressCY = 0
  let activePointer = null
  let dragPreTimer = null // 按下后 150ms 未释放 → 预切拖拽动画（长按=拖拽意图，不等移动）
  let dragAliveTimer = null // 拖拽中保活心跳（按住不动时主进程 3s 会超时强制结束拖拽）

  function releaseCapture() {
    try {
      if (activePointer !== null) {
        petEl.releasePointerCapture(activePointer)
        activePointer = null
      }
    } catch (err) { /* ignore */ }
  }

  // 确认进入拖拽态：切拖拽动画（幂等，多次调用无副作用）。
  // 用户物理拖拽是最高优先级交互：直接 showAnim（绕过任意播放锁），
  // 确保"拖拽了动画立刻切到 drag-carry"——即使点击回应/彩蛋还在播放也应让位。
  // 拖拽期间：drag-carry 只在"悬空挣扎段"循环（见常量注释），不播到下路段。
  function markDragging() {
    if (dragMoved) return
    dragMoved = true
    R.dragging = true
    cancelIdleChain()
    showAnim('drag-carry')
    const v = document.getElementById('anim-drag-carry')
    if (v) {
      // 跳过站立帧（0~0.75s）：直接播放"被拎起"动作起点——松手/拖拽开始即见被拎起
      try { v.currentTime = DRAG_CARRY_PICK_START } catch (err) { /* ignore */ }
      v.onTimeUpdate = (e) => {
        // 拖拽中：只在"悬空挣扎段"（WRAP_START~WRAP_END）循环，到终点跳回起点——
        // 不重播"站立→被拎起"动作，也不播到下落段（DROP_START 起）
        if (R.dragging && e.target.currentTime >= DRAG_CARRY_WRAP_END) {
          try { e.target.currentTime = DRAG_CARRY_WRAP_START } catch (err) { /* ignore */ }
        }
      }
      v.addEventListener('timeupdate', v.onTimeUpdate)
    }
    // 按住不移动时没有 pointermove 事件 → 主进程 3s 心跳超时强制结束拖拽。
    // 这里起一个保活心跳（200ms 一次 dragAlive），拖拽结束/清除时停掉。
    if (dragAliveTimer) { clearInterval(dragAliveTimer); dragAliveTimer = null }
    dragAliveTimer = setInterval(() => {
      if (dragging) { try { window.pet.dragAlive() } catch (err) { /* ignore */ } }
    }, 200)
  }

  // 清除拖拽中的"悬空段循环守卫 + 保活心跳"（拖拽结束/强制结束时调用；不参与下落收尾）
  function clearDragCarryGuard() {
    const v = document.getElementById('anim-drag-carry')
    if (v && v.onTimeUpdate) {
      v.removeEventListener('timeupdate', v.onTimeUpdate)
      v.onTimeUpdate = null
    }
    if (dragAliveTimer) { clearInterval(dragAliveTimer); dragAliveTimer = null }
  }

  window.pet.onDragEnded(() => {
    dragging = false
    releaseCapture()
    if (dragPreTimer) { clearTimeout(dragPreTimer); dragPreTimer = null }
    if (R.dragging) {
      R.dragging = false
      // 主进程强制结束拖拽：清守卫后切状态动画（无下落收尾——如窗口失焦/超时）
      if (currentAnimName === 'drag-carry') {
        clearDragCarryGuard()
        animLockUntil = 0
        currentAnimName = null
        playAnim(R.running ? 'working' : 'idle')
      } else {
        updateMood()
      }
    }
    // 松开：重判鼠标位置——仍在宠物上则 UI 重新出现
    syncClickThrough()
  })

  function onDragPointerDown(e) {
    if (!e.isTrusted) return
    if (e.button !== 0) return
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      console.log('reject-offscreen-press', Math.round(e.clientX), Math.round(e.clientY))
      return
    }
    releaseCapture()
    pressCX = e.clientX
    pressCY = e.clientY
    pressTime = Date.now()
    dragMoved = false
    dragging = true
    activePointer = e.pointerId
    window.pet.dragStart()
    el.setPointerCapture(e.pointerId)
    R.dragging = true
    // 点击 vs 拖拽判定：
    // - 快速点击（<150ms 释放，无移动）→ 点击回应，不闪现 drag-carry
    // - 长按 150ms 未释放（即使没移动）→ 视为拖拽意图，预切 drag-carry
    // - 任何移动 >2px → 立即切 drag-carry（跟手，不等 150ms）
    if (dragPreTimer) clearTimeout(dragPreTimer)
    dragPreTimer = setTimeout(() => {
      dragPreTimer = null
      if (dragging && !dragMoved && !R.sleepy) markDragging()
    }, 150)
  }

  let lastAliveSent = 0

  function onDragPointerMove(e) {
    if (!e.isTrusted) return
    if (!(e.buttons & 1)) return
    if (!dragging) {
      dragging = true
      activePointer = e.pointerId
      window.pet.dragStart()
      R.dragging = true
      updateMood()
    }
    const now = Date.now()
    if (now - lastAliveSent > 100) {
      lastAliveSent = now
      window.pet.dragAlive()
    }
    // 移动 >2px 即视为拖拽（原 6px 偏大，快速拖拽时窗口已动动画还没切，显得"不跟手"）
    if (Math.abs(e.clientX - pressCX) + Math.abs(e.clientY - pressCY) > 2) {
      if (!dragMoved) markDragging()
      else dragMoved = true
    }
  }

  function endDrag(wasClick, tag) {
    if (!dragging) return
    dragging = false
    if (dragPreTimer) { clearTimeout(dragPreTimer); dragPreTimer = null }
    releaseCapture()
    window.pet.dragEnd()
    R.dragging = false
    // 点击回应：轻点桌宠（按下未拖动）随机播放一个点击动画（傲娇/害羞/挠痒/挥手/开心）
    if (wasClick && !R.hidden && !R.chatOpen && !R.busy && !R.sleepy) {
      cancelIdleChain()
      // 连点计数：2s 内点击次数（连点 3 次→傲娇照片；5 次→害羞照片）
      const now = Date.now()
      if (now - (P._lastClickTs || 0) < 2000) P._clickCount = (P._clickCount || 1) + 1
      else P._clickCount = 1
      P._lastClickTs = now
      if (P._clickCount >= 5) unlockPhoto('shy-whale')
      else if (P._clickCount >= 3) unlockPhoto('tsundere-3')
      /* 「摸头杀」：**只轻点一下**（不是连点）就当作摸摸头。
         与连点语义正好互补：连点是"戳她"，单次轻点是"摸摸头"。 */
      else if (P._clickCount === 1) unlockPhoto('head-pat')
      const c = window.BehaviorDirector.clickAnimation({ R, P, count: P._clickCount })
      if (window.pet.character?.authority) void submitKernelInteraction({ kind: 'touch', gesture: 'pet_click' })
      else touch() // 点击桌宠 = 被理会
      window.EventBus.emit('pet.clicked', { count: P._clickCount || 1, animation: c })
      if (window.pet.character?.authority) { void submitKernelInteraction({ kind: 'animation', name: c }); return }
      petEl.classList.add('dp-click-anim') // 停用容器 bob 浮动/摇晃，避免与视频动画叠加
      // 播完一遍（ended）自动恢复：工作→工作动画；空闲→待机。不依赖固定 3s 定时器
      showAnim(c, 0, () => {
        petEl.classList.remove('dp-click-anim')
        animLockUntil = 0
        currentAnimName = null
        if (!R.dragging && !R.chatOpen) {
          updateMood()
        }
      })
      return
    }
    // 拖拽动画（drag-carry 循环播放）：松手后不立即切，切换成"播完当前遍"模式，
    // 播放完整一遍（含"放下"收尾动作）才切回状态动画——避免松手瞬间生硬跳变。
    // 拖拽动画（drag-carry 循环播放）：松手后立刻衔接"下落收尾"——
    // 从 7.0s（下落段起点）开始播放最后约 3s 的"下落→落地"动作，loop=false
    // 播完就切回状态动画。若拖拽已处于下落段（≥7s）则从当前时间继续，无需跳变。
    if (currentAnimName === 'drag-carry') {
      const v = document.getElementById('anim-drag-carry')
      if (v && !v.paused) {
        // 先移除拖拽中的"拎起段循环守卫"，否则 seek 后会被 timeupdate 拉回 0
        clearDragCarryGuard()
        if (v.currentTime < DRAG_CARRY_DROP_START) {
          // 仍在"被拎起"段：跳到下落起点（角色姿态过渡到下落，避免悬空等当前遍）
          try { v.currentTime = DRAG_CARRY_DROP_START } catch (err) { /* ignore */ }
        }
        v.loop = false // 播完收尾段：ended 触发
        v.onended = () => {
          v.onended = null
          animLockUntil = 0
          currentAnimName = null
          updateMood()
        }
        animLockUntil = Date.now() + 5000 // 收尾期间上锁（防 updateMood 抢切）
        return
      }
    }
    animLockUntil = 0
    updateMood()
  }

  function onDragPointerUp(e) {
    if (!e.isTrusted) return
    if (!dragging) return
    if (dragPreTimer) { clearTimeout(dragPreTimer); dragPreTimer = null }
    // 点击判定：按下后无移动即视为点击（拖拽由 dragMoved 判定，与按住时长无关），
    // 保证点击立刻得到回应动画；不再要求 ≥110ms（快速点击 80ms 也算点击）
    const wasClick = !dragMoved
    endDrag(wasClick, 'pet-pointerup')
  }

  // 拖拽同时绑到宠物本体和迷你图标（收起状态下也能拖动桌宠）
  for (const el of [petEl, miniEl]) {
    el.addEventListener('pointerdown', onDragPointerDown)
    el.addEventListener('pointermove', onDragPointerMove)
    el.addEventListener('pointerup', onDragPointerUp)
  }
  window.addEventListener('pointerup', (e) => {
    if (!e.isTrusted) return
    if (dragging) endDrag(false, 'win-pointerup')
  })

  /* ---------- 窗口点击穿透（透明区不挡桌面/其他窗口） ---------- */

  // 主进程默认穿透（forward 转发鼠标移动），这里按鼠标位置实时判定：
  // 命中可交互区 → 关穿透；落在透明空白 → 开穿透。
  // hover 效果（动作条/迷你聊天框出现）由「鼠标在窗口内」决定（mousemove 收到即窗口内），
  // 与穿透判定解耦——鼠标进入窗口任意位置都显示，离开窗口（mouseleave）收起。
  let clickThrough = true
  let ctX = 0
  let ctY = 0
  let lastCtLog = 0

  // 可交互区：宠物本体 / 气泡（含报告·互动·提醒卡片）/ 动作条 / 迷你聊天 / 面板 / 迷你图标 / 照片解锁卡
  /* （主动卡真机"点不动"）：主动卡/专用面板同样是**可交互载体** ⇒ 必须登记。
     否则 `ctHitInteractive` 走父链到 `#pet-area`/`#stage` 就判"非交互" ⇒ 窗口切回**穿透** ⇒ 点击收不到。 */
  /* 快赢批 R1：照片解锁提醒卡（showPhotoCard 建，#pet-area 内、cursor:pointer 、可点击关闭）
     同为可交互载体 ⇒ 必须登记，否则 ctHitInteractive 父链到 #pet-area 判"非交互" ⇒ 穿透 ⇒ 点不动。 */
  const CT_INTERACTIVE = '#pet, .dp-bubble, #mini-chat, .dp-actions, .dp-panel, #mini, #proactive-card, #proactive-panel, #photo-card'

  // 迷你聊天"接近区"：鼠标从人物移向输入框的途中（经空白）不能触发收起，
  // 进入聊天框周边 45px 范围即视为交互区，保持显示直到真正离开
  function nearMiniChat(x, y) {
    const el = $('mini-chat')
    if (!el) return false
    const r = el.getBoundingClientRect()
    const pad = 45
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad
  }

  function ctHitInteractive(el) {
    while (el && el !== document.body) {
      if (el.id === 'pet-area' || el.id === 'stage') return false
      if (el.matches && el.matches(CT_INTERACTIVE)) return true
      el = el.parentElement
    }
    return false
  }

  function syncClickThrough() {
    // 拖拽窗口时必须保持捕获，否则拖动会中断；拖拽中 UI 收起（不遮挡）
    if (dragging) {
      stage.classList.remove('dp-hover')
      if (clickThrough) {
        clickThrough = false
        window.pet.setClickThrough(false)
      }
      return
    }
    const el = document.elementFromPoint(ctX, ctY)
    const interactive = !!(el && ctHitInteractive(el)) || nearMiniChat(ctX, ctY)
    // UI 显示 = 鼠标在宠物/交互区上（dp-hover），离开交互区或窗口即收起
    stage.classList.toggle('dp-hover', interactive)
    if (interactive === !clickThrough) return
    clickThrough = !interactive
    window.pet.setClickThrough(clickThrough)
    if (Date.now() - lastCtLog > 2000) {
      lastCtLog = Date.now()
      console.log('click-through', clickThrough ? 'on(passthrough)' : 'off(capture)', 'at', Math.round(ctX), Math.round(ctY))
    }
  }

  // 闲置收起定时器已移除（2026-08：用户要的是"鼠标放上出现、挪走收起"，静止不应自动收起）

  // 原来这里"无节流：每次 mousemove 直接判定"，注释假设
  // "窗口小、开销可忽略"。但主窗口是 transparent+alwaysOnTop 且用
  // `setIgnoreMouseEvents(true, { forward: true })` ⇒ **整个桌面的鼠标移动都会被转发进渲染进程**。
  // 高刷屏 + 高回报率鼠标（1000Hz+）时本回调每秒被触发上千次，每次都做
  // `document.elementFromPoint()` + `ctHitInteractive()` DOM 命中判定 ⇒ 渲染进程被反复唤醒、
  // 与 DWM 合成互相抢占 ⇒ 实机表现为"鼠标指针/前台窗口偶发顿挫，而底层动态壁纸不受影响"（已复现并定案）。
  // 修法：用 requestAnimationFrame 合帧——每帧最多判定一次；手感不变，调用次数降一到两个数量级。
  let ctRafPending = false
  function syncClickThroughThrottled() {
    if (ctRafPending) return
    ctRafPending = true
    const run = () => {
      ctRafPending = false
      syncClickThrough()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 16)
  }
  // UI 显示规则：鼠标在宠物/交互区上 → 出现；挪走 → 收起；拖拽中 → 收起；松开 → 重判出现
  window.addEventListener('mousemove', (e) => {
    ctX = e.clientX
    ctY = e.clientY
    syncClickThroughThrottled()
  })
  window.addEventListener('mouseenter', syncClickThrough)
  // 鼠标离开窗口：清理 dp-hover（动作条/迷你聊天框收回），并恢复穿透
  document.addEventListener('mouseleave', () => {
    stage.classList.remove('dp-hover')
    if (!clickThrough) {
      clickThrough = true
      window.pet.setClickThrough(true)
    }
  })
  // 主进程守卫：穿透模式下 mouseleave 不可靠（面板关闭窗口收缩后鼠标落在窗外也不触发），
  // 由主进程定期检测鼠标位置，移出窗口时主动清理
  window.pet.onMouseOutside(() => {
    stage.classList.remove('dp-hover')
    if (!clickThrough) {
      clickThrough = true
      window.pet.setClickThrough(true)
    }
  })
  // 主进程 60ms 轮询光标后推送"窗口内相对坐标"（与 clientX/clientY 同一坐标系）。
  // 这是命中判定的主要来源：因为已把 `setIgnoreMouseEvents` 的 forward 关掉，渲染层不再收到
  // 桌面 mousemove（那正是卡顿源），坐标改由这条通道提供。
  // 说明：syncClickThrough 是幂等的（状态没变就不发 IPC），且内部有 rAF 合帧门闩，
  // 所以 60ms 的推送频率不会造成负担。
  if (window.pet.onMousePos) {
    window.pet.onMousePos((x, y) => {
      ctX = x
      ctY = y
      syncClickThroughThrottled()
    })
  }
  // 窗口尺寸变化（模式切换/面板开合）：用最后已知坐标重新判定，避免 UI 残留
  window.addEventListener('resize', syncClickThrough)

  $('btn-chat').addEventListener('click', () => (R.chatOpen ? closeChat() : openChat()))
  async function openHarnessDesktop(button) {
    if (button && button.disabled) return
    if (button) button.disabled = true
    try {
      const r = await window.pet.openWeb()
      if (!r || !r.ok) say(r && r.reason === 'not_installed' ? '还没找到 DeepSeek Harness 桌面端，请安装或先启动一次，再重试。' : '桌面端没能打开，请稍后重试。', 6000, 'ui')
    } catch (err) { say('桌面端没能打开，请稍后重试。', 6000, 'ui') }
    finally { if (button) button.disabled = false }
  }
  $('btn-client').addEventListener('click', () => openHarnessDesktop($('btn-client')))
  $('btn-close').addEventListener('click', closeChat)
  // 吃小饼干按钮已移除（1.1.15）；喂食入口保留在 🎒 背包（道具"小饼干"）
  $('btn-hide').addEventListener('click', doHide)
  $('btn-quit').addEventListener('click', () => window.pet.quit())
  $('btn-send').addEventListener('click', sendChat)
  $('btn-game').addEventListener('click', startGame)
  if ($('charc-more')) $('charc-more').addEventListener('click', async () => {
    const body = $('charc-body')
    const top = body.scrollTop, height = body.scrollHeight
    charcVisibleLimit = Math.min(400, charcVisibleLimit + 40)
    await renderCharc(true)
    body.scrollTop = top + Math.max(0, body.scrollHeight - height)
  })
  $('btn-snake').addEventListener('click', startSnake)
  $('btn-t2048').addEventListener('click', tReset)

  $('name-save').addEventListener('click', () => {
    const v = $('name-input').value.trim()
    if (!v) return
    if (window.pet.character?.authority) { void window.pet.character.submit({ kind: 'identity.update', payload: { displayName: v } }).then(() => window.pet.character.read()).then(applyKernelProjection); return }
    P.name = v
    saveState()
    if (window.PersonaCore && window.PersonaCore.setDisplayName) window.PersonaCore.setDisplayName(v)
    applyName()
    say('以后请叫我' + P.name + '～', undefined, 'ui')
  })

  $('owner-name-save').addEventListener('click', () => {
    const v = $('owner-name-input').value.trim()
    P.ownerName = v
    saveState()
    say(v ? '记住了，你是我最重要的{owner}～' : '好啦，那就继续喊你主人～', undefined, 'ui')
  })

  $('owner-birthday-save').addEventListener('click', () => {
    const v = $('owner-birthday-input').value
    P.ownerBirthday = v || ''
    saveState()
    if (v) {
      const [y, m, d] = v.split('-').map(Number)
      say('记住啦，' + (P.ownerName || '主人') + '的生日是 ' + m + ' 月 ' + d + ' 日，我会提前准备好的 🎁', undefined, 'ui')
    } else {
      say('好～那就不设置生日了', undefined, 'ui')
    }
  })

  // 设置页：查看生日贺卡存档（独立窗口）
  $('btn-birthday-cards').addEventListener('click', () => {
    try { window.pet.birthdayCardOpen() } catch (err) { /* 忽略 */ }
  })

  /* 面板里的相册入口（此前只有托盘菜单能打开相册） */
  if ($('btn-open-album')) $('btn-open-album').addEventListener('click', () => {
    try { window.pet.albumOpen() } catch (err) { /* 忽略 */ }
  })

  /* ---------- new session ---------- */

  async function findWorkspaceId() {
    try {
      const wr = await window.pet.api('workspace.list', {})
      if (wr && wr.result && wr.result.ok) {
        const ws = (wr.result.value.items || []).find((w) => String(w.path).toLowerCase() === String(WORKSPACE).toLowerCase())
        if (ws) return ws.workspaceId
      }
    } catch (err) { /* ignore */ }
    return null
  }

  $('btn-new-session').addEventListener('click', async () => {
    try {
      const wid = await findWorkspaceId()
      const payload = wid ? { workspaceId: wid } : { cwd: WORKSPACE || undefined }
      const resp = await window.pet.api('session.create', payload)
      const r = resp && resp.result
      if (!r || !r.ok) {
        say('新建会话失败：' + ((r && r.error && r.error.message) || '未知错误'), undefined, 'ui')
        return
      }
      R.currentId = r.value.sessionId
      const lr = await window.pet.api('session.list', {})
      if (lr && lr.result && lr.result.ok) {
        R.sessions = lr.result.value.items || []
        sessionsKey = R.sessions.map((s) => s.sessionId + (s.running ? ':1' : ':0')).join('|')
        await refreshVisibleSessions()
        renderSessionSelect()
        refreshSessionControls()
      }
      say('新会话建好啦，把任务派给我吧～', undefined, 'ui')
    } catch (err) {
      say('新建会话失败：连不上 DSH', undefined, 'ui')
    }
  })

  /* ---------- archive session ---------- */

  let delArmed = false

  $('btn-del-session').addEventListener('click', async () => {
    if (!R.currentId) return
    if (!delArmed) {
      delArmed = true
      $('btn-del-session').textContent = '确认?'
      setTimeout(() => {
        delArmed = false
        $('btn-del-session').textContent = '🗑'
      }, 3000)
      return
    }
    delArmed = false
    $('btn-del-session').textContent = '🗑'
    try {
      const resp = await window.pet.api('workspace.archiveSession', { sessionId: R.currentId })
      const r = resp && resp.result
      if (!r || !r.ok) {
        say('归档失败：' + ((r && r.error && r.error.message) || '未知错误'), undefined, 'ui')
        return
      }
      R.currentId = null
      const lr = await window.pet.api('session.list', {})
      if (lr && lr.result && lr.result.ok) {
        R.sessions = lr.result.value.items || []
        sessionsKey = R.sessions.map((s) => s.sessionId + (s.running ? ':1' : ':0')).join('|')
        await refreshVisibleSessions()
        const cand = pickDefaultSession(R.sessions)
        R.currentId = cand ? cand.sessionId : null
        renderSessionSelect()
        refreshSessionControls()
      }
      say('会话已归档 ✅', undefined, 'ui')
    } catch (err) {
      say('归档失败：连不上 DSH', undefined, 'ui')
    }
  })

  /* ---------- session controls: model / preset / permission ---------- */

  function currentSessionItem() {
    return R.sessions.find((s) => s.sessionId === R.currentId) || null
  }

  async function refreshModels() {
    const ms = $('model-select')
    ms.innerHTML = ''
    if (!R.currentId) return
    try {
      const resp = await window.pet.api('session.models', { sessionId: R.currentId })
      const r = resp && resp.result
      if (!r || !r.ok) return
      const info = r.value
      R.modelMeta = {}
      ;(info.groups || []).forEach((g) => {
        ;(g.models || []).forEach((m) => {
          R.modelMeta[g.id + '::' + m.id] = m
          const o = document.createElement('option')
          o.value = g.id + '::' + m.id
          o.textContent = g.name + ' / ' + (m.name || m.id)
          ms.appendChild(o)
        })
      })
      /* （"推理强度无法切换"的根因）：
         DSH 的 `session/modelCatalog` **没有 `current` 字段**（只有 default/groups/routableProviders），
         旧代码 `R.modelCurrent = info.current` ⇒ 恒 undefined ⇒
           ① 下拉永远停在列表第一项（选它 → 把会话模型改成目录第一项，而不是"当前模型"）；
           ② `refreshEfforts()` 读不到 reasoningEffort ⇒ 每次渲染都用"模型默认档"覆盖，
              用户刚选的档被弹回，观感就是"切不了"。
         正确来源 = 会话投影 `projections.values.modelSelection`（next=本次选择，lastUsed=上次实际使用）
         —— 与官方 GUI 同源（`projected.next ?? catalog.value.default`）。 */
      const sel = (currentSessionItem() && currentSessionItem().projections &&
        currentSessionItem().projections.values && currentSessionItem().projections.values.modelSelection) || null
      const picked = {
        provider: (sel && (sel.next && sel.next.provider || sel.lastUsed && sel.lastUsed.provider)) || (info.default && info.default.provider) || '',
        model: (sel && (sel.next && sel.next.model || sel.lastUsed && sel.lastUsed.model)) || (info.default && info.default.model) || '',
        reasoningEffort: (sel && (sel.next && sel.next.reasoningEffort || sel.lastUsed && sel.lastUsed.reasoningEffort)) ||
          (info.default && info.default.reasoningEffort) || '',
      }
      R.modelCurrent = { provider: picked.provider, model: picked.model, reasoningEffort: picked.reasoningEffort }
      if (picked.provider && picked.model) ms.value = picked.provider + '::' + picked.model
      if (!ms.value) {
        /* 投影没给（老会话/新会话未选过）⇒ 用目录默认值兜底，并如实标注"目录默认" */
        if (info.default && info.default.provider) ms.value = info.default.provider + '::' + info.default.model
      }
      if (!ms.value && ms.options.length) {
        /* 连默认值都没有：不要假装已选中第一项，明确提示 */
        const o = document.createElement('option')
        o.value = ''
        o.textContent = '（无法读取当前模型，请刷新或重开会话）'
        ms.insertBefore(o, ms.firstChild)
        ms.value = ''
      }
    } catch (err) {
      /* 原来这里是空 catch ⇒ catalog 取不到时整个下拉静默失效。
         现在把失败写进状态行，便于用户/我判断是"连不上 DSH"而不是"UI 坏了"。 */
      const es = $('effort-select')
      if (es) { es.innerHTML = '<option value="">— 读取模型失败 —</option>'; es.disabled = true; es.title = '连不上 DSH 或会话不可用' }
      say('模型列表读取失败，请稍后重试', 5000, 'ui')
    }
    refreshEfforts()
  }

  function refreshEfforts() {
    const es = $('effort-select')
    es.innerHTML = ''
    const v = $('model-select').value
    const parts = v.split('::')
    const meta = parts.length >= 2 ? (R.modelMeta || {})[parts[0] + '::' + parts[1]] : null
    const reasoning = meta && meta.reasoning
    const efforts = (reasoning && reasoning.efforts) || []
    if (!efforts.length) {
      const o = document.createElement('option')
      o.value = ''
      o.textContent = '— 无 —'
      es.appendChild(o)
      es.disabled = true
      es.title = '当前模型不提供推理等级'
      return
    }
    es.disabled = false
    es.title = ''
    if (reasoning.defaultEffort === undefined) {
      const o = document.createElement('option')
      o.value = ''
      o.textContent = '默认'
      es.appendChild(o)
    }
    efforts.forEach((ef) => {
      const o = document.createElement('option')
      o.value = ef.id
      o.textContent = ef.name || ef.id
      es.appendChild(o)
    })
    /* 会话投影里有明确档位就用它；否则用该模型的默认档。
       （原来恒用 defaultEffort ⇒ 用户刚选的档会在下一次 refresh 被弹回。） */
    const cur = R.modelCurrent && R.modelCurrent.reasoningEffort
    const fallback = reasoning.defaultEffort !== undefined ? reasoning.defaultEffort : ''
    es.value = (cur !== undefined && cur !== null && cur !== '') ? cur : fallback
    if (es.value !== ((cur !== undefined && cur !== null && cur !== '') ? cur : fallback)) es.value = fallback
  }

  async function refreshPresets() {
    const ps = $('preset-select')
    ps.innerHTML = ''
    const item = currentSessionItem()
    try {
      const resp = await window.pet.api('agentPreset.list', {})
      const r = resp && resp.result
      if (!r || !r.ok) return
      ;(r.value.presets || []).forEach((p) => {
        if (p.broken) return
        const o = document.createElement('option')
        o.value = p.id
        o.textContent = (p.name || p.id) + (p.trust === 'user' ? '（自定义）' : '')
        ps.appendChild(o)
      })
      if (item && item.agentPreset) ps.value = item.agentPreset
      const locked = !!(item && !item.blank)
      ps.disabled = locked
      ps.title = locked ? '预设只能在空白会话切换（点 ➕ 新建后选择）' : '选择会话预设'
    } catch (err) { /* ignore */ }
  }

  /* 权限档位：原来的实现有两个独立硬错误 ——
     ① 选项读 `projections.values.permissions.options`，而 DSH 的 permissions 投影**只有 currentValue**
        ⇒ 下拉永远是空的（还不会被 disabled，看着像"点了没反应"）；
     ② 切换用 `session.prompt` 发文本 `/permission x` ⇒ prompt 只把它当用户消息入队、**不解释命令**，
        却仍返回 accepted ⇒ 界面假报"已切换 ✅"。
     现在：清单与切换都走主进程（permission:get / permission:set），renderer 只渲染。 */
  function permLabel(o) {
    return (o && (o.name || o.label || o.value)) || ''
  }

  let permState = { options: [], current: null, running: false }

  async function refreshPerms() {
    const pe = $('perm-select')
    if (!pe) return
    pe.innerHTML = ''
    if (!R.currentId) { pe.disabled = true; pe.title = '先选一个会话'; return }
    try {
      const view = await window.pet.permissionGet(R.currentId)
      if (!view || !view.ok) {
        /* 拿不到就如实说明，不再留一个"看着能点"的空下拉 */
        const o = document.createElement('option')
        o.value = ''
        o.textContent = '（读取权限失败）'
        pe.appendChild(o)
        pe.disabled = true
        pe.title = (view && view.error) || '读取权限失败'
        return
      }
      permState = { options: view.options || [], current: view.current || null, running: !!view.running }
      if (!permState.options.length) {
        const o = document.createElement('option')
        o.value = ''
        o.textContent = '（这个版本没有可用的权限档位）'
        pe.appendChild(o)
        pe.disabled = true
        return
      }
      permState.options.forEach((opt) => {
        const id = typeof opt === 'string' ? opt : (opt && (opt.value || opt.id))
        if (!id) return
        const o = document.createElement('option')
        o.value = id
        o.textContent = typeof opt === 'string' ? opt : permLabel(opt)
        if (opt && opt.description) o.title = opt.description
        pe.appendChild(o)
      })
      if (permState.current) pe.value = permState.current
      pe.disabled = false
      pe.title = permState.running ? '会话正在跑，改权限要等这一轮结束' : '选择这个会话的权限档位'
    } catch (err) {
      pe.disabled = true
    }
  }

  function refreshSessionControls() {
    refreshModels()
    refreshPresets()
    refreshPerms()
  }

  $('model-select').addEventListener('change', async () => {
    const v = $('model-select').value
    if (!v || !R.currentId) return
    const parts = v.split('::')
    if (parts.length < 2) return
    try {
      const resp = await window.pet.api('session.selectModel', { sessionId: R.currentId, provider: parts[0], model: parts[1] })
      const r = resp && resp.result
      say(r && r.ok ? '模型已切换 ✅' : '切换失败：' + ((r && r.error && r.error.message) || '未知错误'), undefined, 'ui')
      if (r && r.ok) refreshModels()
    } catch (err) { say('切换失败：连不上 DSH', undefined, 'ui') }
  })

  $('effort-select').addEventListener('change', async () => {
    const v = $('model-select').value
    const ev = $('effort-select').value
    if (!v || !R.currentId) return
    const parts = v.split('::')
    if (parts.length < 2) return
    try {
      const payload = { sessionId: R.currentId, provider: parts[0], model: parts[1] }
      if (ev) payload.reasoningEffort = ev
      const resp = await window.pet.api('session.selectModel', payload)
      const r = resp && resp.result
      say(r && r.ok ? '推理等级已切换 ✅' : '切换失败：' + ((r && r.error && r.error.message) || '未知错误'), undefined, 'ui')
      if (r && r.ok) refreshModels()
    } catch (err) { say('切换失败：连不上 DSH', undefined, 'ui') }
  })

  $('preset-select').addEventListener('change', async () => {
    const v = $('preset-select').value
    if (!v || !R.currentId) return
    try {
      const resp = await window.pet.api('agentPreset.select', { sessionId: R.currentId, agentPreset: v })
      const r = resp && resp.result
      if (r && r.ok) {
        say('预设已切换 ✅', undefined, 'ui')
        const lr = await window.pet.api('session.list', {})
        if (lr && lr.result && lr.result.ok) {
          R.sessions = lr.result.value.items || []
          sessionsKey = R.sessions.map((s) => s.sessionId + (s.running ? ':1' : ':0')).join('|')
          renderSessionSelect()
        }
      } else {
        const err = r && r.error
        say('切换失败：' + ((err && err.message) || '未知错误') + ((err && (err.code === 'agent-preset/locked' || err.code === 'agent-preset-locked')) ? '（会话已有对话，预设被锁定）' : ''), undefined, 'ui')
      }
    } catch (err) { say('切换失败：连不上 DSH', undefined, 'ui') }
  })

  // 危险权限切换确认：切到 danger-full-access 前弹确认卡（对齐 harness 的确认机制）
  function confirmPermissionChange() {
    // 有其他卡片占用时先不弹（避免覆盖汇报/提醒/交互卡）
    const busy = bubbleEl.dataset.report === '1' || !!bubbleEl.dataset.remind || !!bubbleEl.dataset.inter ||
      bubbleEl.dataset.chatReply === '1' || bubbleEl.dataset.thinking === '1'
    if (busy) {
      say('先处理完当前卡片再切换权限哦～', undefined, 'ui')
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      bubbleEl.innerHTML = ''
      bubbleEl.dataset.report = ''
      bubbleEl.className = 'dp-bubble dp-bubble-interaction'
      stage.classList.add('dp-busy-bubble')
      const title = document.createElement('div')
      title.className = 'dp-bubble-report-title'
      title.textContent = '⚠️ 权限切换确认'
      const body = document.createElement('div')
      body.className = 'dp-bubble-report-body'
      body.textContent = '切换到「最高权限 danger-full-access」后，' + petName() + '可执行该范围内的所有操作（含读写文件、执行命令）。仅在可信任务下使用，确认切换吗？'
      const foot = document.createElement('div')
      foot.className = 'dp-inter-foot'
      const okBtn = document.createElement('button')
      okBtn.className = 'dp-mini-btn'
      okBtn.textContent = '确认切换'
      const cancelBtn = document.createElement('button')
      cancelBtn.className = 'dp-mini-btn'
      cancelBtn.textContent = '取消'
      const finish = (val) => {
        bubbleEl.classList.add('hidden')
        bubbleEl.innerHTML = ''
        bubbleEl.className = 'dp-bubble'
        stage.classList.remove('dp-busy-bubble')
        resolve(val)
      }
      okBtn.addEventListener('click', () => finish(true))
      cancelBtn.addEventListener('click', () => finish(false))
      foot.appendChild(okBtn)
      foot.appendChild(cancelBtn)
      bubbleEl.appendChild(title)
      bubbleEl.appendChild(body)
      bubbleEl.appendChild(foot)
      bubbleEl.classList.remove('hidden')
    })
  }

  $('perm-select').addEventListener('change', async () => {
    const v = $('perm-select').value
    if (!v || !R.currentId) return
    if (v === 'danger-full-access') {
      const confirmed = await confirmPermissionChange()
      if (!confirmed) {
        refreshPerms() // 取消：下拉恢复原值
        say('已取消切换', undefined, 'ui')
        return
      }
    }
    try {
      /* 走主进程：内部执行 host 命令 `/permission <preset>`（DSH 不认 session.prompt 里的斜杠命令），
         并把"命令没匹配上 / host 拒绝"如实回报 —— 不再假报成功。 */
      const r = await window.pet.permissionSet({ sessionId: R.currentId, value: v })
      if (r && r.ok) {
        say('权限已切换 ✅', undefined, 'ui')
      } else {
        const map = {
          'permission-not-allowed': '这个权限档位不被允许',
          'no-permission-command': '当前 DSH 版本没有 /permission 命令，无法切换',
          'bad-request': '会话或权限值无效'
        }
        say('切换失败：' + (map[r && r.error] || (r && r.error) || '未知错误'), 6000, 'ui')
      }
      setTimeout(refreshPerms, 1200)
    } catch (err) { say('切换失败：连不上 DSH', undefined, 'ui') }
  })

  /* ---------- schedule & hydrate ---------- */

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  function renderSchedule() {
    const wrap = $('class-list')
    wrap.innerHTML = ''
    if (!P.schedule.length) {
      wrap.innerHTML = '<div class="dp-muted">暂无课程，添加一节吧</div>'
    }
    const sorted = P.schedule.slice().sort((a, b) => (a.day - b.day) || (String(a.time) < String(b.time) ? -1 : 1))
    sorted.forEach((c) => {
      const row = document.createElement('div')
      row.className = 'dp-inv-row'
      const label = document.createElement('span')
      label.textContent = '📚 ' + c.name + ' · ' + WEEKDAYS[c.day] + ' ' + c.time
        + (c.weeks === 'odd' ? '（单周）' : c.weeks === 'even' ? '（双周）' : '')
        + (c.remind ? ' · 提前' + c.remind + '分' : '')
      const delBtn = document.createElement('button')
      delBtn.className = 'dp-mini-btn'
      delBtn.textContent = '删除'
      delBtn.addEventListener('click', () => {
        P.schedule = P.schedule.filter((x) => x.id !== c.id)
        saveState()
        renderSchedule()
      })
      row.appendChild(label)
      row.appendChild(delBtn)
      wrap.appendChild(row)
    })
  }

  $('class-add').addEventListener('click', () => {
    const name = $('class-name').value.trim()
    const time = $('class-time').value
    if (!name || !time) {
      say('请填写课程名和时间～', undefined, 'ui')
      return
    }
    const day = Number($('class-day').value) || 1
    const weeks = $('class-weeks').value || 'all'
    const remind = Number($('class-remind').value) || 0
    P.schedule.push({ id: ++uid, name, day, time, weeks, remind })
    $('class-name').value = ''
    saveState()
    renderSchedule()
    say('记下啦：' + name + ' ' + WEEKDAYS[day] + ' ' + time + (weeks === 'odd' ? '（单周）' : weeks === 'even' ? '（双周）' : ''), undefined, 'ui')
    unlockPhoto('schedule-manager')
  })

  $('semester-start').addEventListener('change', () => {
    P.semesterStart = $('semester-start').value || ''
    saveState()
    say(P.semesterStart ? '教学周已设置：' + P.semesterStart + ' 为第 1 周' : '已切换为自然周计算', undefined, 'ui')
    if (P.semesterStart) unlockPhoto('school-start')
  })

  function updateHydrateBtn() {
    $('btn-hydrate').textContent = '💧 喝水提醒：' + (P.hydrateEnabled ? '开' : '关')
  }

  /* ---------- settings ---------- */

  // 纯净版：隐藏设置页的 更新/诊断/远程访问 三块
  // 剔除模式下（CLEAN-STRIP）hideCleanFeatures 由构建脚本替换为无条件隐藏版本
  let cleanChecked = false
  let isCleanEdition = false
  function hideCleanFeatures() {
    if (cleanChecked) return
    cleanChecked = true
    window.pet.updateConfig().then((cfg) => {
      if (!cfg || !cfg.clean) return
      isCleanEdition = true
      document.querySelectorAll('[data-clean-hidden]').forEach((el) => { el.remove() })
      console.log('clean edition: 更新/诊断/远程访问已隐藏')
    }).catch(() => { /* 拿不到配置则不隐藏 */ })
  }

  function updateSettingsUI() {
    hideCleanFeatures()
    $('btn-sound').textContent = '🔊 提示音：' + (P.soundEnabled ? '开' : '关')
    $('volume-range').value = P.soundVolume
    $('volume-val').textContent = String(Math.round(P.soundVolume))
    $('hydrate-interval').value = P.hydrateIntervalMin
    const hydrateTitle = $('hydrate-title')
    if (hydrateTitle) hydrateTitle.textContent = '💧 久坐提醒（每 ' + P.hydrateIntervalMin + ' 分钟）'
    $('diary-time').value = P.diaryTime || '23:00'
    for (const k of ['report', 'achievement', 'chat', 'proactive', 'reminder', 'ui']) {
      const el = $('snd-evt-' + k)
      if (el) el.checked = !(P.soundEvents && P.soundEvents[k] === false)
    }
    if (P.semesterStart) $('semester-start').value = P.semesterStart
    updateAutostartUI()
    if (!cleanChecked) updateCheckUI(false) /* CLEAN-STRIP:LINE */
    if (!cleanChecked) refreshUpdateCompatUI(false) /* CLEAN-STRIP:LINE */
    refreshChatModelUI(false)
    refreshSceneModelUI()
    setupSettingsGroups()
  }

  function updateAutostartUI() {
    window.pet.autostartGet().then((st) => {
      const btn = $('btn-autostart')
      if (!btn) return
      const on = !!(st && st.enabled)
      if (st && st.supported === false) {
        /* 测试版/纯净版按策略不写启动项 ⇒ 必须如实说明，不能让按钮"点了没反应" */
        btn.textContent = on
          ? '🚀 开机自启：已由启动项开启（本版本不能改）'
          : '🚀 开机自启：本版本不支持开关（正式版可用）'
        btn.title = '测试版/纯净版按策略不写系统启动项'
        btn.classList.toggle('dp-btn-on', on)
        return
      }
      btn.textContent = on ? '🚀 开机自启：已开启（点一下关闭）' : '🚀 开机自启：未开启（点一下开启）'
      btn.title = on ? '开机时自动启动桌宠；再点一次即关闭' : '开机时自动启动桌宠'
      btn.classList.toggle('dp-btn-on', on)
    }).catch(() => {
      const btn = $('btn-autostart')
      if (btn) btn.textContent = '🚀 开机自启：读取失败，点一下重试'
    })
  }

  async function refreshChatModelUI() { if (window.ModelSettings) await window.ModelSettings.refresh() }
  async function refreshSceneModelUI() { if (window.ModelSettings) await window.ModelSettings.refresh() }

  /* ---------- U2：设置页分组 / 折叠 ----------
     实现口径：**不改 HTML 结构**（纯净版切片标记 / p1f 缩进断言 / id 契约全部保留），
     只在运行时按 `.dp-care-sub` 标题把"节"归组，并在每组前插一个可点的分组条。
     默认**全部展开**（信息不藏；用户明确偏好直白），折叠状态只记在 localStorage。 */
  const SETTINGS_GROUPS = [
    { name: '👤 基本（名字 · 称呼 · 生日 · 相册）', match: /^(✏️ 名称|👤 主人|🐋 固定人设)/ },
    { name: '📔 日记与感知', match: /^(📔 每日日记|👀 感知)/ },
    { name: '🚀 启动与聊天服务', match: /^(🚀 开机自启|🔄 聊天服务)/ },
    { name: '🧩 软件更新', match: /^(🔄 软件更新|💬 DSH 聊天服务更新)/ },
    { name: '🔔 声音与提醒', match: /^(🔔 提示音|💧 喝水提醒)/ },
  ]
  const SETTINGS_COLLAPSE_KEY = 'dp-settings-collapsed-groups'

  function settingsCollapsedSet() {
    try {
      const raw = localStorage.getItem(SETTINGS_COLLAPSE_KEY)
      const arr = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [])
    } catch (err) { return new Set() }
  }

  function saveSettingsCollapsed(set) {
    try { localStorage.setItem(SETTINGS_COLLAPSE_KEY, JSON.stringify(Array.from(set))) } catch (err) { /* ignore */ }
  }

  function setupSettingsGroups() {
    const pane = $('tab-settings')
    if (!pane || pane.dataset.groupsReady === '1') return
    const sections = []
    let cur = null
    Array.from(pane.children).forEach((el) => {
      if (el.classList && el.classList.contains('dp-care-sub')) {
        cur = { head: el, nodes: [el], name: String(el.textContent || '').trim() }
        sections.push(cur)
      } else if (cur) {
        cur.nodes.push(el)
      }
    })
    if (!sections.length) return
    const collapsed = settingsCollapsedSet()
    const groups = new Map()
    sections.forEach((sec) => {
      const rule = SETTINGS_GROUPS.find((g) => g.match.test(sec.name))
      const key = rule ? rule.name : ('其他：' + sec.name)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(sec)
    })
    groups.forEach((secs, key) => {
      const bar = document.createElement('button')
      bar.type = 'button'
      bar.className = 'dp-care-group'
      bar.dataset.group = key
      bar.textContent = key
      bar.setAttribute('aria-expanded', String(!collapsed.has(key)))
      secs[0].head.parentNode.insertBefore(bar, secs[0].head)
      secs.forEach((sec) => {
        sec.nodes.forEach((n) => {
          n.dataset.groupKey = key
          if (collapsed.has(key)) n.classList.add('dp-group-hidden')
        })
      })
    })
    pane.dataset.groupsReady = '1'
    pane.addEventListener('click', (e) => {
      const bar = e.target && e.target.closest ? e.target.closest('.dp-care-group[data-group]') : null
      if (!bar || !pane.contains(bar)) return
      const key = bar.dataset.group
      const set = settingsCollapsedSet()
      const willCollapse = !set.has(key)
      if (willCollapse) set.add(key); else set.delete(key)
      saveSettingsCollapsed(set)
      bar.setAttribute('aria-expanded', String(!willCollapse))
      Array.from(pane.children).forEach((el) => {
        if (el.dataset && el.dataset.groupKey === key) el.classList.toggle('dp-group-hidden', willCollapse)
      })
    })
  }


  /* CLEAN-STRIP:BEGIN update */
  /* ---------- 更新检测（设置页） ---------- */

  // 更新安装确认卡（渲染层自绘）：
  // 桌宠窗口是 transparent+frame:false+alwaysOnTop，主进程 dialog.showMessageBox(win,...) 会不显示且挂起，
  // 所以在渲染层用交互卡确认，确认后 updateInstall({confirmed:true}) 跳过主进程 dialog。
  function confirmUpdateInstall(version) {
    const busy = bubbleEl.dataset.report === '1' || !!bubbleEl.dataset.remind || !!bubbleEl.dataset.inter ||
      bubbleEl.dataset.chatReply === '1' || bubbleEl.dataset.thinking === '1'
    if (busy) {
      say('先处理完当前卡片再安装更新哦～', undefined, 'ui')
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      bubbleEl.innerHTML = ''
      bubbleEl.dataset.report = ''
      bubbleEl.className = 'dp-bubble dp-bubble-interaction'
      stage.classList.add('dp-busy-bubble')
      const title = document.createElement('div')
      title.className = 'dp-bubble-report-title'
      title.textContent = '🔄 确认更新'
      const body = document.createElement('div')
      body.className = 'dp-bubble-report-body'
      body.textContent = '即将安装新版本 v' + version + '。\n安装过程会自动关闭桌宠，完成后自动重新打开。\n确认现在更新吗？'
      const foot = document.createElement('div')
      foot.className = 'dp-inter-foot'
      const okBtn = document.createElement('button')
      okBtn.className = 'dp-mini-btn'
      okBtn.textContent = '✅ 立即更新'
      const cancelBtn = document.createElement('button')
      cancelBtn.className = 'dp-mini-btn'
      cancelBtn.textContent = '取消'
      const finish = (val) => {
        bubbleEl.classList.add('hidden')
        bubbleEl.innerHTML = ''
        bubbleEl.className = 'dp-bubble'
        stage.classList.remove('dp-busy-bubble')
        resolve(val)
      }
      okBtn.addEventListener('click', () => finish(true))
      cancelBtn.addEventListener('click', () => finish(false))
      foot.appendChild(okBtn)
      foot.appendChild(cancelBtn)
      bubbleEl.appendChild(title)
      bubbleEl.appendChild(body)
      bubbleEl.appendChild(foot)
      bubbleEl.classList.remove('hidden')
    })
  }

  function setUpdateStatus(text) {
    $('update-status').textContent = text
    // 注意：不再清空 update-actions！按钮区由下载/安装流程自己管理，
    // 否则 setUpdateStatus 会把刚绑定好 onclick 的按钮从 DOM 移除（1.1.23"点安装没反应"根因之一）
  }

  // 重置更新按钮区（开始新一轮检查时清空旧按钮）
  function clearUpdateActions() {
    $('update-actions').innerHTML = ''
  }

  /* ---------- P0-A：更新与兼容状态（只读展示，不做任何升级/切换动作） ---------- */
  function ucFormatModel(m) {
    if (!m) return '-'
    const listed = m.listed === true ? '官方目录中' : (m.listed === false ? '不在官方目录' : '未探测')
    const parts = [String(m.id || '-'), listed]
    if (m.lifecycle && m.lifecycle !== 'unknown') parts.push(m.lifecycle)
    if (m.recommended) parts.push('建议 ' + m.recommended)
    return parts.join(' · ')
  }

  async function refreshUpdateCompatUI(force) {
    const config = window.pet.modelConfig ? await window.pet.modelConfig.get().catch(() => null) : null
    if (config && config.ok) {
      const route = config.routes.character, provider = config.providers.find(p => p.id === route.effectiveProviderId)
      if (provider && (provider.protocol !== 'openai' || !/^https:\/\/api\.deepseek\.com(?:\/v1)?$/.test(provider.baseUrl))) {
        if ($('uc-model')) $('uc-model').textContent = route.effectiveModel || '未配置'
        if ($('uc-status')) $('uc-status').textContent = '直连模型状态请在“模型与 API”中检测；本区仅用于 DSH / DeepSeek 兼容性。'
        return
      }
    }
    const modelEl = $('uc-model')
    const stEl = $('uc-status')
if (!modelEl || !stEl) return
    try {
      if (force) {
        try { await window.pet.ucModelStatus({ force: true }) } catch (err) { /* 只读探测失败不影响展示 */ }
      }
      const snap = await window.pet.ucStatusSnapshot()
      if (!snap || !snap.ok) { stEl.textContent = '状态读取失败'; return }
      const purposes = (snap.registry && snap.registry.purposes) || {}
      /* 这里原来直接显示 registry 的**声明 ID**（合法但已下线的兼容别名），
         会被读成"她在用 v4"。改为显示**实际生效**的模型：由主进程按白名单解析
         （用户偏好 → 未设则跟随最新 Flash），并把别名路由关系如实写在名字后面。 */
      const cv = await window.pet.chatModelGet().catch(() => null)
      const effView = (cv && cv.ok)
        ? { id: cv.effective, name: cv.effectiveName, lifecycle: cv.effectiveLifecycle }
        : purposes.character
      modelEl.textContent = ucFormatModel(effView)
      const probe = snap.probe || {}
      const last = (snap.usage && snap.usage.last && snap.usage.last.length) ? snap.usage.last[snap.usage.last.length - 1] : null
      const probeText = probe.ok
        ? ('已同步 ' + ((probe.listed && probe.listed.length) || 0) + ' 个 ID' + (probe.stale ? '（缓存过期）' : ''))
        : ('未同步（' + (probe.error || '未探测') + '）')
      const usageText = last ? ('最近一次：' + last.model + (last.ok ? ' 成功' : ' ' + (last.error || '失败'))) : null
      const action = (purposes.character && purposes.character.actionRequired) || 'none'
      const actionText = action === 'required' ? '需处理' : (action === 'recommended' ? '建议迁移' : '正常')
      stEl.textContent = ['模型目录：' + probeText, usageText, '状态：' + actionText].filter(Boolean).join(' · ')
    } catch (err) {
      try { $('uc-status').textContent = '状态读取失败' } catch (e) { /* ignore */ }
    }
  }

  if ($('btn-uc-refresh')) $('btn-uc-refresh').addEventListener('click', async () => {
    const btn = $('btn-uc-refresh')
    if (btn) btn.disabled = true
    try { await refreshUpdateCompatUI(true) } finally { if (btn) btn.disabled = false }
  })

  /* ---------- 聊天模型选择器（设置页） ----------
     设计口径（用户拍板）：默认跟随最新 Flash；可用显式选择覆盖；**绝不自动切到 Pro**
     （Pro 只能由用户在这里自己选）。合法性判定在白名单（主进程），本函数只渲染。 */
  let chatModelView = null


  async function updateCheckUI(manual) {
    const btn = $('btn-update-check')
    btn.disabled = true
    clearUpdateActions() // 每次检查都清空旧按钮，避免反复打开设置页/多次检查累积多个按钮
    /* 缺陷修复：兜底值原来读的是**界面当前文字**
       （`setUpdateStatus($('update-status').textContent || '启动时会自动检查…')`），
       于是"上一次的检查结果"会被当成默认文案保留下来，出现"状态文本像是历史残留/叠加"的观感。
       改为**常量兜底**，不读 DOM。 */
    setUpdateStatus('启动时会自动检查；发现新版本可在这里下载安装')
    try {
      const cfg = await window.pet.updateConfig()
      $('cur-ver').textContent = cfg.current || '-'
      $('update-source').value = cfg.baseUrl || ''
      if (manual) setUpdateStatus('正在检查更新…')
      const r = await window.pet.updateCheck()
      if (!r.ok) {
        if (manual) setUpdateStatus(r.error || '检查失败')
        else setUpdateStatus('更新检查：' + (r.error || '失败') + '（可稍后手动检查）')
        return
      }
      if (!r.hasUpdate) {
        setUpdateStatus('已是最新版本 v' + r.current + ' 🎉')
        return
      }
      setUpdateStatus('发现新版本 v' + r.latest + '（当前 v' + r.current + '）' + (r.note ? '：' + r.note : ''))
      // 智能识别：本地已有目标版本安装包则直接显示「安装」，否则显示「下载」
      let hasLocal = false
      try {
        const h = await window.pet.updateHasInstaller(r.latest)
        hasLocal = !!(h && h.ok && h.has)
      } catch (err) { /* 查询失败则按未下载处理 */ }
      const dl = document.createElement('button')
      dl.className = 'dp-mini-btn'
      const bindInstall = () => {
        dl.textContent = '📦 安装 v' + r.latest
        dl.disabled = false
        dl.onclick = async () => {
          dl.disabled = true
          dl.textContent = '📦 安装中…'
          setUpdateStatus('请确认后开始安装…')
          // 渲染层自绘确认卡（透明桌宠窗口不能作为主进程 dialog 的 parent，否则确认框不显示且挂起）
          const ok = await confirmUpdateInstall(r.latest)
          if (!ok) {
            dl.disabled = false
            dl.textContent = '📦 安装 v' + r.latest
            setUpdateStatus('已取消安装')
            return
          }
          const ins = await window.pet.updateInstall({ confirmed: true })
          if (!ins.ok) {
            dl.disabled = false
            dl.textContent = '📦 重试安装'
            setUpdateStatus('启动安装器失败：' + ((ins && ins.error) || '未知错误'))
            return
          }
          setUpdateStatus('正在安装 v' + r.latest + '，桌宠即将自动关闭，装完自动重新打开…')
          // 安装器已接管，桌宠即将退出
        }
      }
      if (hasLocal) {
        bindInstall()
        setUpdateStatus('发现新版本 v' + r.latest + '（当前 v' + r.current + '）· 安装包已就绪，可直接安装' + (r.note ? '：' + r.note : ''))
      } else {
        dl.textContent = '⬇️ 下载 v' + r.latest + '（' + (r.size ? Math.round(r.size / 1048576) + ' MB' : '') + '）'
        dl.onclick = async () => {
          dl.disabled = true
          dl.textContent = '⬇️ 下载中…（增量更新，只下载变化部分）'
          setUpdateStatus('正在下载升级包…（首次全量，之后增量）')
          const d = await window.pet.updateDownload()
          if (!d.ok) {
            dl.disabled = false
            dl.textContent = '⬇️ 重试下载'
            setUpdateStatus('下载失败：' + (d.error || '未知错误'))
            return
          }
          bindInstall()
          setUpdateStatus('下载完成 ✅ 点「安装」开始升级（会弹确认，桌宠自动退出，装完自动重开）')
          // 关键：替换整个按钮区为当前这一个安装按钮（清除并发 updateCheckUI 可能残留的重复按钮）
          $('update-actions').replaceChildren(dl)
        }
      }
      // 初始：显示按钮（replaceChildren 保证唯一，清除并发调用残留）
      $('update-actions').replaceChildren(dl)
    } catch (err) {
      if (manual) setUpdateStatus('检查异常：' + (err && err.message))
    } finally {
      btn.disabled = false
    }
  }

  if ($('btn-update-check')) $('btn-update-check').addEventListener('click', () => updateCheckUI(true))
  if ($('update-source-save')) $('update-source-save').addEventListener('click', async () => {
    const v = $('update-source').value.trim()
    await window.pet.updateSetConfig(v)
    setUpdateStatus(v ? '更新源已保存，重新检查…' : '已关闭自动更新检查')
    updateCheckUI(true)
  })
  window.pet.onUpdateProgress((p) => {
    if (!p || typeof p.pct !== 'number') return
    const wrap = $('update-progress-wrap')
    const fill = $('update-progress-fill')
    const txt = $('update-progress-text')
    if (wrap) {
      wrap.classList.remove('hidden')
      fill.style.width = p.pct + '%'
      if (txt) txt.textContent = p.pct + '%'
    }
    setUpdateStatus('正在下载升级包… ' + p.pct + '%')
    // 下载完成：进度条满后延迟收起
    if (p.pct >= 100) {
      clearTimeout(window.__updBarTimer)
      window.__updBarTimer = setTimeout(() => {
        if (wrap) wrap.classList.add('hidden')
      }, 1500)
    }
  })
  window.pet.onUpdateAvailable((info) => {
    // 启动时自动检查发现新版：气泡提示 + 设置页标记
    if (info && info.latest) {
      window.__updateAutoNotified = true
      say('有新版本 v' + info.latest + ' 可以升级啦，去 ⚙️ 设置看看吧～', 6000, 'ui')
    }
  })

  /* CLEAN-STRIP:END update */

  $('btn-autostart').addEventListener('click', async () => {
    try {
      const st = await window.pet.autostartGet()
      const next = await window.pet.autostartSet(!(st && st.enabled))
      updateAutostartUI()
      if (next && next.supported === false) {
        /* 测试版/纯净版：如实说"这个版本不给改"，不要让用户以为点了没反应 */
        say('这个版本（测试版/纯净版）不写开机启动项，正式版里可以开关', 6000, 'ui')
        return
      }
      say(next && next.enabled ? '已开启开机自启 🚀' : '已关闭开机自启', undefined, 'ui')
    } catch (err) {
      say('操作失败，请检查权限', undefined, 'ui')
    }
  })


  /* ---------- P4-P1/P4-P2：官方 DeepSeek Harness 状态（只读检测 + 接入状态；失败不影响其他功能） ---------- */
  let harnessRunningSeen = new Set()
  let harnessSeedDone = false
  /* 接入失败原因 → 人话（键来自 official-harness.attach() 的 reason 枚举） */
  const HARNESS_WHY = {
    desktop_offline: '尚未发现可用的桌面端服务',
    authentication_failed: '桌面端认证未通过，将重新检测',
    protocol_unavailable: '桌面端协议暂不可用，将重新检测',
    credentials_missing: '找不到凭据文件',
    record_absent: '凭据里没有会话记录',
    secret_absent: '凭据里没有签名密钥',
    secret_bad_length: '签名密钥格式不符',
    read_error: '凭据读取失败',
    secret_unavailable: '签名密钥不可用',
    exception: '接入异常',
  }
  async function refreshHarnessStatusUI() {
    try {
      const st = await window.pet.harnessStatus().catch(() => null)
      const el = $('harness-status')
      if (!el) return
      const det = $('harness-detail')
      if (!st) { el.textContent = '检测失败（不影响其他功能）'; if (det) det.textContent = ''; return }
      const o = (st && st.official) || {}
      const h = (st && st.harness) || {}
      const parts = []
      if (o.unavailable) parts.push('（' + o.edition + ' 版不提供）')
      else if (!o.installed && (h.usable || o.running || o.endpointOnline)) parts.push('DSH 正在运行（安装位置未确认）')
      else if (!o.installed) parts.push('未检测到正在运行的 DSH；安装位置未确认')
      else parts.push('已安装 v' + (o.version || '?'))
      if (h.usable) parts.push('已接入 ✅')
      else if (o.unavailable) parts.push('未接入')
      else {
        const why = (h.attachFail && h.attachFail.why) || null
        parts.push('未接入' + (why ? '（' + (HARNESS_WHY[why] || why) + '）' : ''))
      }
      el.textContent = parts.join(' · ')
      /* 细节行：端点 / Desktop 存在性 / 任务数 —— 全部来自真实探测，不编造 */
      const w = st.work
      const seg = []
      if (h.endpoint) seg.push(String(h.endpoint).replace(/^https?:\/\//, ''))
      if (o.running) seg.push('Desktop 在跑')
      if (!h.usable && !o.endpointOnline && (o.installed || o.running)) seg.push('服务尚未就绪，自动重试中')
      if (w && !w.error && typeof w.total === 'number') seg.push('任务 ' + ((w.running || []).length) + '/' + w.total)
      if (det) det.textContent = seg.join(' · ')
      /* 感知：共享会话库里 running 任务消失 → 完成提醒（自有当前会话由既有汇报卡链负责，此处不重复） */
      const running = new Set(((st && st.work && st.work.running) || []))
      if (harnessSeedDone && h.usable && w && !w.error) {
        for (const id of harnessRunningSeen) {
          if (!running.has(id) && id !== R.currentId) { say('有任务完成啦～', 5000, 'ui'); playDing('report'); break }
        }
      }
      if (h.usable && w && !w.error) {
        harnessRunningSeen = running
        harnessSeedDone = true
      }
    } catch (e) { /* 检测失败不影响其他功能 */ }
  }
  if ($('btn-harness-ensure')) $('btn-harness-ensure').addEventListener('click', async () => {
    const el = $('harness-status')
    if (el) el.textContent = '正在检测并接入…'
    try { await window.pet.harnessEnsure() } catch (e) { /* ignore */ }
    setTimeout(refreshHarnessStatusUI, 1500)
    say('去看一眼官方 Harness 在不在～', 3000, 'ui')
  })

  $('btn-sound').addEventListener('click', () => {
    P.soundEnabled = !P.soundEnabled
    saveState()
    updateSettingsUI()
    if (P.soundEnabled) playDing('ui')
    say(P.soundEnabled ? '提示音已开启 🔊' : '提示音已关闭 🔇', undefined, 'ui')
  })

  // 音量：input 事件即时保存（拖动过程中持续落盘，杜绝 change 丢失导致重启回默认）；
  // 拖动时试听（200ms 节流，避免拖动过程连续发声）
  let volDingTimer = null
  $('volume-range').addEventListener('input', () => {
    P.soundVolume = Number($('volume-range').value) || 0
    saveState()
    $('volume-val').textContent = String(Math.round(P.soundVolume))
    if (volDingTimer) clearTimeout(volDingTimer)
    volDingTimer = setTimeout(() => {
      volDingTimer = null
      if (P.soundEnabled) playDing('ui')
    }, 200)
  })

  for (const k of ['report', 'achievement', 'chat', 'proactive', 'reminder', 'ui']) {
    const el = $('snd-evt-' + k)
    if (el) el.addEventListener('change', () => {
      if (!P.soundEvents || typeof P.soundEvents !== 'object') P.soundEvents = {}
      P.soundEvents[k] = !!el.checked
      saveState()
    })
  }

  const pqFrom = $('proactive-quiet-from'), pqTo = $('proactive-quiet-to')
  const pCap = $('proactive-daily-cap'), pIv = $('proactive-min-interval')
  if (pqFrom && window.pet.proactiveTuning) {
    window.pet.proactiveTuning.get().then((t) => {
      t = t || {}
      if (Number.isFinite(Number(t.quietFrom))) pqFrom.value = t.quietFrom
      if (Number.isFinite(Number(t.quietTo))) pqTo.value = t.quietTo
      if (Number.isFinite(Number(t.dailyCap))) pCap.value = t.dailyCap
      if (Number.isFinite(Number(t.minIntervalMinutes))) pIv.value = t.minIntervalMinutes
    }).catch(() => {})
    $('proactive-tuning-save').addEventListener('click', async () => {
      const r = await window.pet.proactiveTuning.set({
        quietFrom: parseInt(pqFrom.value, 10),
        quietTo: parseInt(pqTo.value, 10),
        dailyCap: parseInt(pCap.value, 10),
        minIntervalMinutes: parseInt(pIv.value, 10)
      })
      say(r && r.ok ? '主动参数已保存，重启后生效' : '主动参数保存失败', undefined, 'ui')
    })
  }

  $('hydrate-save').addEventListener('click', () => {
    let v = parseInt($('hydrate-interval').value, 10)
    if (!Number.isFinite(v)) {
      say('请输入有效的分钟数', undefined, 'ui')
      return
    }
    v = clamp(v, 15, 240)
    P.hydrateIntervalMin = v
    $('hydrate-interval').value = v
    updateSettingsUI()
    saveState()
    say('喝水提醒间隔已设为 ' + v + ' 分钟', undefined, 'ui')
  })

  $('btn-hydrate').addEventListener('click', () => {
    P.hydrateEnabled = !P.hydrateEnabled
    saveState()
    updateHydrateBtn()
    say(P.hydrateEnabled ? '喝水提醒已开启，每 45 分钟提醒一次～' : '喝水提醒已关闭', undefined, 'ui')
  })

  function dayKey(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  // DiaryDay 单一来源：renderer/diary/diary-day.js（与 main.js / DiaryEngine 共用）。
  // 只用于日记相关语义（写日记 / 存在判断 / 时间线 / 忘掉今天）；
  // 喝水、签到、久别重逢、工作日志等仍使用日历日 dayKey()。
  function diaryDayKey(ts) {
    if (window.DiaryDay && typeof window.DiaryDay.key === 'function') {
      return window.DiaryDay.key(typeof ts === 'number' ? ts : (ts || Date.now()), P.diaryTime || '23:00')
    }
    return dayKey(ts instanceof Date ? ts : new Date(ts || Date.now()))
  }

  // 'YYYY-M-D' -> local Date at 00:00（用于日记日历上下文；无效输入回退今天）
  function diaryDateFromKey(key) {
    const parts = String(key || '').split('-').map(Number)
    if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return new Date()
    return new Date(parts[0], parts[1] - 1, parts[2])
  }

  // A5：sanitize + 只保留当前 DiaryDay 的 AI 请求计数。
  // 非法 key/value 丢弃；绝不抛异常；旧 DiaryDay 不保留。
  function sanitizeDiaryAiRequestsByDay(raw, nowTs) {
    const out = {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
    let currentDay = ''
    try { currentDay = diaryDayKey(nowTs || Date.now()) } catch (err) { currentDay = '' }
    for (const key of Object.keys(raw)) {
      if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(String(key))) continue
      const n = Number(raw[key])
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) continue
      if (currentDay && key !== currentDay) continue
      out[key] = n
    }
    return out
  }

  function checkScheduleAndHydrate() {
    const now = new Date()
    const jsDay = now.getDay()
    const myDay = jsDay === 0 ? 7 : jsDay
    let weekNum
    if (P.semesterStart) {
      const start = new Date(P.semesterStart + 'T00:00:00')
      weekNum = Math.max(1, Math.floor((now.getTime() - start.getTime()) / (7 * 86400000)) + 1)
    } else {
      const jan1 = new Date(now.getFullYear(), 0, 1)
      const dayOfYear = Math.floor((now.getTime() - jan1.getTime()) / 86400000)
      weekNum = Math.floor((dayOfYear + jan1.getDay()) / 7) + 1
    }
    const isOddWeek = weekNum % 2 === 1
    P.schedule.forEach((c) => {
      if (Number(c.day) !== myDay) return
      if (c.weeks === 'odd' && !isOddWeek) return
      if (c.weeks === 'even' && isOddWeek) return
      const parts = String(c.time).split(':')
      if (parts.length < 2) return
      const start = new Date(now)
      start.setHours(Number(parts[0]), Number(parts[1]), 0, 0)
      const remindMs = (Number(c.remind) || 0) * 60000
      const diff = start.getTime() - now.getTime()
      if (diff <= remindMs && diff > remindMs - 60000) {
        const key = c.id + ':' + dayKey(now)
        if (!P.firedClasses.includes(key)) {
          P.firedClasses.push(key)
          if (P.firedClasses.length > 200) P.firedClasses = P.firedClasses.slice(-200)
          saveState()
          const mins = Number(c.remind) || 0
          const card = {
            kind: 'class',
            title: '📚 上课提醒',
            text: '「' + c.name + '」' + (mins ? '还有 ' + mins + ' 分钟' : '现在') + '上课啦！',
            buttons: [
              { label: '知道了', onClick: () => clearReminderCard() },
              {
                label: '10 分钟后再提醒',
                onClick: () => {
                  clearReminderCard()
                  setTimeout(() => fireReminder(card), 600000)
                },
              },
            ],
          }
          fireReminder(card)
        }
      }
    })
    if (P.hydrateEnabled && now.getTime() - P.lastHydrate >= P.hydrateIntervalMin * 60000) {
      P.lastHydrate = now.getTime()
      saveState()
      const today = dayKey(now)
      if (P.waterDay !== today) { P.waterDay = today; P.waterToday = 0 }
      fireReminder({
        kind: 'water',
        title: '💧 喝水时间到',
        text: '该喝水啦 · 今日第 ' + (P.waterToday + 1) + ' 杯',
        buttons: [
          {
            label: '已喝 ✓',
            onClick: () => {
              clearReminderCard()
              const t = dayKey(new Date())
              if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'water_drink' })
              P.waterToday = (P.waterDay === t ? P.waterToday : 0) + 1
              P.waterDay = t
              P.stats.mood = clamp(P.stats.mood + 2, 0, 100)
              gainExp(2)
              saveState()
              renderCare()
              say('吨吨吨～今日第 ' + P.waterToday + ' 杯！', 3500, 'ui')
              unlockPhoto('tea-serve')
            },
          },
          {
            label: '5 分钟后再提醒',
            onClick: () => {
              clearReminderCard()
              P.lastHydrate = Date.now() - (P.hydrateIntervalMin - 5) * 60000
              saveState()
            },
          },
        ],
      })
    }
  }

  setInterval(checkScheduleAndHydrate, 30000)

  /* ---------- 视听说 B · 感知通道（视）—— 六层架构 P1/P2/P3 ----------
     Sensor → Observation → Detector(纯函数链) → Router → Writer
     P1 express（实时表现） / P2 emotion（applyEvent） / P3 memory·diary（admitCandidate + diaryEvent）。
     pet.js 只提供素材与宿主状态（say / pickLine / diaryEvent / P），不做分流决定。
     台词素材来自 P.lorebook（人设底色）；状态累计在 P.perceptionState。 */

  // express 通道的台词选择：
  //   视 → 世界书类别/应用条目；听 → 听觉专属池（H6，按 A-kind 索引）
  function perceptionPickLine(plan) {
    if (plan && (plan.sensor === 'hearing' || String(plan.kind || '').charAt(0) === 'A')) return pickMediaLine(plan)
    const payload = (plan && plan.payload) || {}
    const cat = String(payload.cat || '')
    const app = String(payload.app || '').toLowerCase()
    const entry = (P.lorebook || []).find((e) => {
      if (!e || !e.trigger || !e.trigger.kind) return false
      if (e.trigger.kind === 'category') return String(e.trigger.value || '') === cat
      if (e.trigger.kind === 'app') return String(e.trigger.value || '').toLowerCase() === app
      return false
    })
    if (!entry) return null
    const r = entry.reaction || {}
    const pool = Array.isArray(r.says) && r.says.length ? r.says : (r.say ? [r.say] : [])
    if (!pool.length) return null
    return String(pool[Math.floor(Math.random() * pool.length)])
  }

  // H6：听觉专属台词池（按 A-kind 取；{artist}/{title}/{count} 为当期占位符，不落库）
  function pickMediaLine(plan) {
    const kind = String((plan && plan.kind) || '')
    const p = (plan && plan.payload) || {}
    const v = window.HearingVocab || {}
    const clean = typeof v.cleanMediaText === 'function' ? v.cleanMediaText : (s) => String(s || '').trim()
    const title = clean(p.title), artist = clean(p.artist)
    const topic = (plan && plan.topic) || (v.topicOfMedia ? v.topicOfMedia(p.app, p.mediaType) : 'media')
    if (topic !== 'music') {
      // A browser media session does not prove that the owner is listening to music.
      const lines = {
        A1_media_start: title ? '「' + title.slice(0, 40) + '」开始播放了，我安静陪着你～' : '有内容开始播放了，我安静陪着你～',
        A2_media_stop: '播放停下来啦，有需要就叫我～',
        A3_track_repeat: '又回到这段内容啦，我陪着你～',
        A4_listening_dwell: '播放持续好一会儿啦，要不要歇一歇？',
        A6_media_paused: '播放暂停了，我在这里等你～'
      }
      return lines[kind] || null
    }
    const entry = (P.lorebook || []).find((e) => e && e.trigger && e.trigger.kind === 'media' && e.trigger.value === kind)
    if (!entry) return null
    const r = entry.reaction || {}
    const all = Array.isArray(r.says) && r.says.length ? r.says : (r.say ? [r.say] : [])
    const pool = all.filter(s => (title || !String(s).includes('{title}')) && (artist || !String(s).includes('{artist}')))
    if (!pool.length) return kind === 'A1_media_start' ? '音乐开始播放了，我在这儿陪你 🎵' : null
    let line = String(pool[Math.floor(Math.random() * pool.length)])
    line = line.replace(/\{artist\}/g, artist)
    line = line.replace(/\{title\}/g, title.slice(0, 40))
    line = line.replace(/\{count\}/g, String(Number(p.count) || 2))
    return line
  }

  /* P4：感知 → 微表情/小动作（宿主能力，供 writers 的 express 通道调用）。
     链路复用既有正规通道，不新增 intent kind、不新增动画资源：
       intentSnap → BehaviorDirector.planForIntent → ExpressionEngine.createPlan → showAnim
     安全：正在播一次性动画（animLockUntil）时不打断；任一环缺失即降级返回，不影响台词。 */
  function perceptionExpress(plan, intentKind, execution) {
    if (!roleRuntime.isAuthorized(execution)) return { ok: false, reason: "runtime_authorization_required" }
    if (!intentKind) return { ok: false, reason: 'no_intent_map' }
    if (animLockUntil && Date.now() < animLockUntil) return { ok: false, reason: 'anim_busy' }
    if (!window.BehaviorDirector || !window.ExpressionEngine) return { ok: false, reason: 'no_expression_engine' }
    const now = Date.now()
    const intentSnap = {
      source: 'perception',
      activeKind: intentKind,
      presence: true,
      reason: (plan && plan.kind) || 'perception',
      trigger: (plan && plan.eventId) || null,
      createdAt: now,
      expiresAt: now + 30 * 1000,
    }
    const bplan = window.BehaviorDirector.planForIntent(intentSnap)
    if (!bplan || !bplan.ok || !bplan.behavior) return { ok: false, reason: 'no_behavior' }
    const expr = window.ExpressionEngine.createPlan({ intent: intentSnap, behavior: bplan })
    if (!expr || !expr.requestId) return { ok: false, reason: 'no_plan' }
    if (window.ExpressionEngine.activatePlan) window.ExpressionEngine.activatePlan(expr.requestId)
    const cand = expr.channels && expr.channels.animation && expr.channels.animation.candidate
    if (!cand) return { ok: false, reason: 'no_candidate' }
    showAnim(cand, 10000, afterOneShotAnimation, {
      source: 'expression',
      priority: 60,
      interruptible: true,
      reason: 'perception-express', runtimeExecution: execution,
    })
    return { ok: true, candidate: cand, requestId: expr.requestId, intent: intentKind }
  }

  // Perception 管线句柄（M0：新命名空间优先，旧 window.Perception 作为兼容别名）
  function perceptionPipeline() {
    return window.PresencePipeline || window.Perception || null
  }

  /* C2-F1：经历写入口（Perception Writer 的唯一出口）。**fire-and-forget**：失败只回 reason、不影响感知主循环；
     真正的去重与落盘由主进程 recordExperience 裁决（渲染层不做二次判定、不缓存第二份经历）。 */
  function perceptionExperience(entry) {
    try {
      const api = window.pet
      if (!api || typeof api.experienceEvent !== 'function') return { ok: false, reason: 'no_bridge' }
      Promise.resolve(api.experienceEvent(entry)).catch(function () { /* 单条失败不影响主循环 */ })
      return { ok: true }
    } catch (err) { return { ok: false, reason: String((err && err.message) || err) } }
  }

  /* P3-F0：前台变化观察写入口（同 perceptionExperience 纪律：fire-and-forget、渲染层不判去重）。
     只搬运保真事实，不做任何"用户在做什么"的解释；自进程/锁屏/容量/稳定 ID 由主进程旁路模块裁决。 */
  function perceptionForegroundObservation(entry) {
    try {
      const api = window.pet
      if (!api || typeof api.foregroundObservationEvent !== 'function') return { ok: false, reason: 'no_bridge' }
      Promise.resolve(api.foregroundObservationEvent(entry)).catch(function () { /* 单条失败不影响主循环 */ })
      return { ok: true }
    } catch (err) { return { ok: false, reason: String((err && err.message) || err) } }
  }

  function startPerception() {
    if (window.pet.character?.authority) return
    const pipe = perceptionPipeline()
    if (!pipe || typeof pipe.start !== 'function') return
    // P3/P4：把宿主能力注入 ctx（Writer 是唯一执行层，仍由它决定怎么用）
    pipe.start(P, {
      requestExpression: (plan, intentKind) => runtimeNotify(execution => {
        const line = perceptionPickLine(plan)
        if (!line) return { ok: false, reason: 'no_line' }
        perceptionExpress(plan, intentKind, execution)
        return say(line, 5000, 'ui', undefined, execution)
      }, 'perception-expression'),
      say: say,
      pickLine: perceptionPickLine,
      diaryEvent: diaryEvent,
      express: perceptionExpress,
      experience: perceptionExperience,
      foregroundObservation: perceptionForegroundObservation,
    })
  }

  // 人设底色（§二.1 C：人设硬编码底色）——女仆天性偏好，幂等注入。
  // 遵守 v10 人设纪律：女仆口吻、无鱼化词、无固定时段词；台词可带 emoji。
  // reaction.says 为台词池（随机取一条）；reaction.say 为兼容单条写法。
  // P4：不再声明 cooldownMs —— 说话节流已迁到 Detector（SPEAK_COOLDOWN_MIN），单一权威。
  //     mood / affection 保留作后续"养成联动"通道的意图声明，当前不生效。
  const PERSONA_LOREBOOK = [
    {
      trigger: { kind: 'category', value: '音乐' },
      reaction: {
        says: [
          '在听歌呀，我陪你听一会儿～ 🎵',
          '这首歌的调子，让人心里软软的 🎶',
          '主人挑的歌，我也想听完整首 🎧',
        ],
        mood: 3, affection: 1,
      },
      source: 'persona', hits: 0, lastHit: 0,
    },
    {
      trigger: { kind: 'category', value: '开发工具' },
      reaction: {
        says: [
          '主人又在忙呢，我安安静静在旁边陪着 💻',
          '写代码的时候我帮不上忙，就负责守着你 ✨',
        ],
        mood: 1, affection: 1,
      },
      source: 'persona', hits: 0, lastHit: 0,
    },
    {
      trigger: { kind: 'category', value: '浏览器' },
      reaction: {
        says: [
          '在查什么呀？查资料的话我也能帮上忙 🌐',
          '网页翻得好快，眼睛不累吗 👀',
        ],
        mood: 1, affection: 1,
      },
      source: 'persona', hits: 0, lastHit: 0,
    },
    {
      trigger: { kind: 'category', value: '文档' },
      reaction: {
        says: [
          '在写东西呀，我不出声，就在旁边看着 📄',
          '笔头顺不顺？写累了记得起来动一动 ✍️',
        ],
        mood: 1, affection: 1,
      },
      source: 'persona', hits: 0, lastHit: 0,
    },
    {
      trigger: { kind: 'category', value: '视频' },
      reaction: {
        says: [
          '在看视频呀，我也偷偷看两眼 🎬',
          '要是好笑的，记得分我一点开心 🍿',
        ],
        mood: 2, affection: 1,
      },
      source: 'persona', hits: 0, lastHit: 0,
    },
    {
      trigger: { kind: 'category', value: '设计' },
      reaction: {
        says: [
          '在画东西呀，主人的配色我偷偷记下了 🎨',
          '设计的时候最安静了，我陪你一起 🖌️',
        ],
        mood: 2, affection: 1,
      },
      source: 'persona', hits: 0, lastHit: 0,
    },
    {
      trigger: { kind: 'category', value: '聊天' },
      reaction: {
        says: ['在和朋友说话呀……我不打扰，就是有点想凑过去 💬'],
        mood: 0, affection: 1,
      },
      source: 'persona', hits: 0, lastHit: 0,
    },
  ]

  /* H6：听觉专属台词池（按 A-kind 索引；占位符 {artist}/{title}/{count} 在当期替换，不落库）。
     遵守 v10 人设纪律：女仆口吻、无鱼化词、无固定时段词；可带 emoji。 */
  const MEDIA_LOREBOOK = [
    {
      trigger: { kind: 'media', value: 'A1_media_start' },
      reaction: { says: [
        '开始放歌啦？我听着呢 🎵',
        '这首是「{title}」吧，名字我记住了 🎧',
        '{artist} 的歌呀，主人喜欢这个调调？ 🎶',
      ] },
      source: 'persona',
    },
    {
      trigger: { kind: 'media', value: 'A2_media_stop' },
      reaction: { says: ['不听了呀？那我把耳朵收回来 🐾'] },
      source: 'persona',
    },
    {
      trigger: { kind: 'media', value: 'A3_track_repeat' },
      reaction: { says: [
        '这首已经放第 {count} 次啦，主人是真的喜欢 🎵',
        '又听这首？我都快会唱了 🎤',
      ] },
      source: 'persona',
    },
    {
      trigger: { kind: 'media', value: 'A4_listening_dwell' },
      reaction: { says: [
        '听了好一会儿了呢，主人耳朵不累吗 🎧',
        '我陪主人听了很久，屋子里都软软的 🎵',
      ] },
      source: 'persona',
    },
    {
      trigger: { kind: 'media', value: 'A5_taste_across_days' },
      reaction: { says: [
        '{artist} 主人好像很常听呢，我记下了 💛',
        '最近总能听到 {artist}，主人喜欢这个吧 🎶',
      ] },
      source: 'persona',
    },
    {
      trigger: { kind: 'media', value: 'A6_media_paused' },
      reaction: { says: ['停了一会儿了，是在忙别的吗？ 🐾'] },
      source: 'persona',
    },
  ]

  function seedLorebookPersona() {
    if (!Array.isArray(P.lorebook)) P.lorebook = []
    // P4 清理：cooldownMs 已成死配置（节流迁到 Detector），从既有条目移除，避免两个权威
    for (const e of P.lorebook) {
      if (e && e.reaction && Object.prototype.hasOwnProperty.call(e.reaction, 'cooldownMs')) delete e.reaction.cooldownMs
      if (e && Object.prototype.hasOwnProperty.call(e, 'cooldownMs')) delete e.cooldownMs
    }
    for (const seed of PERSONA_LOREBOOK.concat(MEDIA_LOREBOOK)) {
      const exists = P.lorebook.some(
        (e) => e && e.source === 'persona' && e.trigger && e.trigger.kind === seed.trigger.kind && e.trigger.value === seed.trigger.value,
      )
      if (!exists) P.lorebook.push({ ...seed, trigger: { ...seed.trigger }, reaction: { ...seed.reaction } })
    }
  }

  /* ---------- guess number ---------- */

  const guess = { target: 0, left: 7, over: false }

  function guessReset() {
    guess.target = Math.floor(Math.random() * 100) + 1
    guess.left = 7
    guess.over = false
    $('guess-log').textContent = '输入你的第一个猜测～'
    $('guess-result').classList.add('hidden')
    $('guess-input').value = ''
  }

  function guessSubmit() {
    if (guess.over) return
    const v = parseInt($('guess-input').value, 10)
    if (!Number.isFinite(v) || v < 1 || v > 100) {
      $('guess-log').textContent = '请输入 1~100 的数字'
      return
    }
    $('guess-input').value = ''
    guess.left -= 1
    if (v === guess.target) {
      if (window.pet.character?.authority) window.GameBridge.complete({ gameId: 'guess', score: 1, won: true })
      guess.over = true
      P.coins += 10
      gainExp(5)
      P.totalGames += 1
      markDaily('game'); unlockPhoto('first-game'); touch()
      addAffection(1)
      saveState()
      updateCoins()
      renderCare()
      $('guess-log').textContent = '🎉 猜中了！就是 ' + guess.target + '！+10 🪙'
      $('guess-result').classList.remove('hidden')
      $('guess-result').textContent = '点 🔄 再来一局'
      unlockPhoto('guess-win')
      markGameWin2('guess')
    } else if (guess.left <= 0) {
      if (window.pet.character?.authority) window.GameBridge.complete({ gameId: 'guess', score: 0, won: false })
      guess.over = true
      P.totalGames += 1
      saveState()
      $('guess-log').textContent = '💥 机会用完了，答案是 ' + guess.target
      $('guess-result').classList.remove('hidden')
      $('guess-result').textContent = '点 🔄 再来一局'
    } else {
      $('guess-log').textContent = (v < guess.target ? '⬆ 太小了' : '⬇ 太大了') + '，还剩 ' + guess.left + ' 次机会'
    }
  }

  $('guess-btn').addEventListener('click', guessSubmit)
  $('guess-reset').addEventListener('click', guessReset)
  $('guess-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') guessSubmit() })

  /* ---------- tic-tac-toe ---------- */

  const ttt = { board: [], over: false }

  function tttReset() {
    ttt.board = Array(9).fill(null)
    ttt.over = false
    $('ttt-result').classList.add('hidden')
    renderTtt()
  }

  function renderTtt() {
    const grid = $('ttt-grid')
    grid.innerHTML = ''
    ttt.board.forEach((cell, i) => {
      const el = document.createElement('div')
      el.className = 'dp-ttt-cell' + (cell === 'X' ? ' dp-ttt-x' : cell === 'O' ? ' dp-ttt-o' : '')
      el.textContent = cell === 'X' ? '✕' : cell === 'O' ? '◯' : ''
      el.addEventListener('click', () => tttMove(i))
      grid.appendChild(el)
    })
  }

  function tttWinner(b) {
    const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
    for (const l of lines) {
      if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return b[l[0]]
    }
    return null
  }

  function tttAi() {
    const empty = ttt.board.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0)
    if (!empty.length) return
    for (const i of empty) {
      ttt.board[i] = 'O'
      if (tttWinner(ttt.board) === 'O') return
      ttt.board[i] = null
    }
    for (const i of empty) {
      ttt.board[i] = 'X'
      if (tttWinner(ttt.board) === 'X') {
        ttt.board[i] = 'O'
        return
      }
      ttt.board[i] = null
    }
    ttt.board[empty[Math.floor(Math.random() * empty.length)]] = 'O'
  }

  function tttEnd(winner) {
    if (window.pet.character?.authority) window.GameBridge.complete({ gameId: 'ttt', score: winner === 'X' ? 1 : 0, won: winner === 'X', draw: winner === null })
    ttt.over = true
    P.totalGames += 1
    let reward = 0
    if (winner === 'X') reward = 10
    else if (winner === null) reward = 2
    if (reward) { P.coins += reward; markDaily('game'); unlockPhoto('first-game'); touch(); addAffection(1) }
    gainExp(5)
    saveState()
    updateCoins()
    renderCare()
    const res = $('ttt-result')
    res.classList.remove('hidden')
    res.textContent = winner === 'X' ? '🎉 你赢了！+10 🪙' : winner === 'O' ? '电脑获胜' : '🤝 平局，+2 🪙'
    renderTtt()
  }

  function tttMove(i) {
    if (ttt.over || ttt.board[i] !== null) return
    ttt.board[i] = 'X'
    let w = tttWinner(ttt.board)
    if (w || ttt.board.every((v) => v !== null)) { tttEnd(w); return }
    tttAi()
    w = tttWinner(ttt.board)
    if (w || ttt.board.every((v) => v !== null)) { tttEnd(w); return }
    renderTtt()
  }

  $('ttt-reset').addEventListener('click', tttReset)

  /* ---------- sudoku ---------- */

  const SUDOKU_LEVELS = {
    easy: { name: '😊 初级', holes: 34, reward: 30 },
    mid: { name: '🙂 中级', holes: 46, reward: 60 },
    hard: { name: '😈 高级', holes: 54, reward: 120 },
  }

  const sudoku = { level: 'easy', solution: [], given: [], sel: null, notesMode: false, notes: {}, over: false, started: false }

  function sudokuSolve(grid) {
    const find = () => {
      for (let i = 0; i < 81; i++) {
        if (grid[i] === 0) return i
      }
      return -1
    }
    const valid = (i, n) => {
      const r = Math.floor(i / 9)
      const c = i % 9
      for (let k = 0; k < 9; k++) {
        if (grid[r * 9 + k] === n || grid[k * 9 + c] === n) return false
      }
      const br = Math.floor(r / 3) * 3
      const bc = Math.floor(c / 3) * 3
      for (let dr = 0; dr < 3; dr++) {
        for (let dc = 0; dc < 3; dc++) {
          if (grid[(br + dr) * 9 + (bc + dc)] === n) return false
        }
      }
      return true
    }
    const i = find()
    if (i < 0) return true
    const order = [1, 2, 3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - 0.5)
    for (const n of order) {
      if (valid(i, n)) {
        grid[i] = n
        if (sudokuSolve(grid)) return true
        grid[i] = 0
      }
    }
    return false
  }

  function sudokuReset() {
    const lv = SUDOKU_LEVELS[sudoku.level] || SUDOKU_LEVELS.easy
    const grid = Array(81).fill(0)
    sudokuSolve(grid)
    sudoku.solution = grid.slice()
    const board = grid.slice()
    const holes = new Set()
    while (holes.size < lv.holes) holes.add(Math.floor(Math.random() * 81))
    holes.forEach((i) => { board[i] = 0 })
    sudoku.board = board
    sudoku.given = board.map((v, i) => (v !== 0 ? i : -1)).filter((i) => i >= 0)
    sudoku.sel = null
    sudoku.notes = {}
    sudoku.over = false
    sudoku.started = true
    $('sudoku-result').classList.add('hidden')
    $('sudoku-meta').textContent = lv.name + ' · 待填 ' + holes.size
    renderSudoku()
  }

  function renderSudoku() {
    const grid = $('sudoku-grid')
    // 自适应格子大小：网格 + 侧边键盘必须完整落在面板可视区内，无滚动条
    const pane = $('tab-game')
    const paneRect = pane ? pane.getBoundingClientRect() : null
    const gridRect = grid.getBoundingClientRect()
    const pad = document.querySelector('#game-sudoku .dp-sudoku-pad')
    const gridTopInPane = paneRect ? (gridRect.top - paneRect.top + pane.scrollTop) : 0
    const padW = pad ? pad.offsetWidth : 65
    const availW = (pane && pane.clientWidth ? pane.clientWidth : 340) - 12 - padW - 8
    // 预留 18px 底边余量，保证网格与结果条都不贴边
    const availH = (pane && pane.clientHeight ? pane.clientHeight : 380) - gridTopInPane - 18
    let cell = Math.floor((availW - 10) / 9)
    if (availH > 0) cell = Math.min(cell, Math.floor((availH - 16) / 9))
    cell = Math.max(12, Math.min(24, cell))
    grid.style.width = (cell * 9 + 10) + 'px'
    grid.style.setProperty('--su-cell', cell + 'px')
    grid.style.fontSize = Math.max(11, Math.round(cell * 0.62)) + 'px'
    grid.innerHTML = ''
    for (let i = 0; i < 81; i++) {
      const el = document.createElement('div')
      const isGiven = sudoku.given.includes(i)
      let cls = 'dp-sudoku-cell'
      if (isGiven) cls += ' dp-su-given'
      if (sudoku.sel === i) cls += ' dp-su-sel'
      const v = sudoku.board[i]
      if (v && !isGiven && v !== sudoku.solution[i]) cls += ' dp-su-wrong'
      el.className = cls
      if (v) el.textContent = String(v)
      const notes = sudoku.notes[i]
      if (!v && notes && notes.length) {
        const wrap = document.createElement('div')
        wrap.className = 'dp-sudoku-notes'
        for (let n = 1; n <= 9; n++) {
          const s = document.createElement('span')
          s.textContent = notes.includes(n) ? String(n) : ''
          wrap.appendChild(s)
        }
        el.appendChild(wrap)
      }
      el.addEventListener('click', () => {
        if (sudoku.over) return
        sudoku.sel = i
        renderSudoku()
      })
      grid.appendChild(el)
    }
  }

  function sudokuInput(n) {
    if (sudoku.over || sudoku.sel == null) return
    const i = sudoku.sel
    if (sudoku.given.includes(i)) return
    if (sudoku.notesMode) {
      if (!n) { sudoku.notes[i] = []; renderSudoku(); return }
      const notes = sudoku.notes[i] ? sudoku.notes[i].slice() : []
      const k = notes.indexOf(n)
      if (k >= 0) notes.splice(k, 1)
      else notes.push(n)
      sudoku.notes[i] = notes
      renderSudoku()
      return
    }
    if (sudoku.board[i] === n) return
    sudoku.board[i] = n
    if (!n) sudoku.notes[i] = []
    renderSudoku()
    if (n && sudoku.board.every((v) => v !== 0)) {
      if (sudoku.board.every((v, j) => v === sudoku.solution[j])) sudokuWin()
    }
  }

  function sudokuWin() {
    if (window.pet.character?.authority) window.GameBridge.complete({ gameId: 'sudoku', score: 1, won: true, level: sudoku.level })
    const lv = SUDOKU_LEVELS[sudoku.level] || SUDOKU_LEVELS.easy
    sudoku.over = true
    P.coins += lv.reward
    P.totalGames += 1
    markDaily('game'); unlockPhoto('first-game'); touch()
    addAffection(1)
    gainExp(6)
    saveState()
    updateCoins()
    renderCare()
    checkAchievements()
    const res = $('sudoku-result')
    res.textContent = '🎉 数独完成！+' + lv.reward + ' 🪙'
    res.classList.remove('hidden')
    say('🎉 数独解出来了！不愧是你～', 4000, 'ui')
    unlockPhoto('sudoku-master')
      markGameWin2('sudoku')
  }

  function setSudokuLevel(lv) {
    if (!SUDOKU_LEVELS[lv] || sudoku.level === lv) return
    sudoku.level = lv
    document.querySelectorAll('.dp-sudoku-lv').forEach((b) => {
      b.classList.toggle('dp-level-active', b.dataset.level === lv)
    })
    sudokuReset()
  }

  $('btn-sudoku-new').addEventListener('click', sudokuReset)
  $('btn-sudoku-notes').addEventListener('click', () => {
    sudoku.notesMode = !sudoku.notesMode
    $('btn-sudoku-notes').textContent = '✏️ 笔记：' + (sudoku.notesMode ? '开' : '关')
  })
  document.querySelectorAll('.dp-sudoku-lv').forEach((b) => {
    b.addEventListener('click', () => setSudokuLevel(b.dataset.level))
  })
  document.querySelectorAll('.dp-sudoku-key').forEach((b) => {
    b.addEventListener('click', () => sudokuInput(Number(b.dataset.n)))
  })
  // 数字键输入（仅数独激活且没有聚焦输入框时）
  document.addEventListener('keydown', (e) => {
    if ($('game-sudoku').classList.contains('hidden')) return
    const tag = document.activeElement && document.activeElement.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key >= '1' && e.key <= '9') { e.preventDefault(); sudokuInput(Number(e.key)); return }
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { e.preventDefault(); sudokuInput(0) }
  })

  /* ---------- 五子棋（人机，玩家执黑先手） ---------- */

  const GOMOKU_SIZE = 15
  const gomoku = { board: [], over: false, turn: 'black', resultShown: false }

  function gomokuReset() {
    gomoku.board = Array(GOMOKU_SIZE * GOMOKU_SIZE).fill(null)
    gomoku.over = false
    gomoku.turn = 'black'
    gomoku.resultShown = false
    $('gomoku-result').classList.add('hidden')
    $('gomoku-result').textContent = ''
    renderGomoku()
  }

  function renderGomoku() {
    const wrap = $('gomoku-board')
    wrap.innerHTML = ''
    gomoku.board.forEach((cell, i) => {
      const el = document.createElement('div')
      el.className = 'dp-gomoku-cell' + (cell === 'black' ? ' gomoku-black' : cell === 'white' ? ' gomoku-white' : '')
      el.addEventListener('click', () => gomokuMove(i))
      wrap.appendChild(el)
    })
  }

  function gomokuWin(board, player) {
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]]
    for (let r = 0; r < GOMOKU_SIZE; r++) {
      for (let c = 0; c < GOMOKU_SIZE; c++) {
        if (board[r * GOMOKU_SIZE + c] !== player) continue
        for (const [dr, dc] of dirs) {
          let n = 1
          while (true) {
            const rr = r + dr * n, cc = c + dc * n
            if (rr < 0 || rr >= GOMOKU_SIZE || cc < 0 || cc >= GOMOKU_SIZE || board[rr * GOMOKU_SIZE + cc] !== player) break
            n++
          }
          if (n >= 5) return true
        }
      }
    }
    return false
  }

  // 单格评分：在四个方向统计连子 + 两端空位，用于贪心攻防
  function gomokuScoreAt(board, idx, player) {
    const r = Math.floor(idx / GOMOKU_SIZE), c = idx % GOMOKU_SIZE
    if (board[idx] !== null) return -1
    let score = 0
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]]
    for (const [dr, dc] of dirs) {
      let count = 1 // 落子位
      let open = 0
      for (const sign of [1, -1]) {
        let n = 1
        while (true) {
          const rr = r + dr * n * sign, cc = c + dc * n * sign
          if (rr < 0 || rr >= GOMOKU_SIZE || cc < 0 || cc >= GOMOKU_SIZE) break
          const v = board[rr * GOMOKU_SIZE + cc]
          if (v === player) { count++; n++ }
          else if (v === null) { open++; break }
          else break
        }
      }
      if (count >= 5) score += 100000
      else if (count === 4 && open > 0) score += 5000
      else if (count === 3 && open >= 2) score += 600
      else if (count === 3 && open >= 1) score += 300
      else if (count === 2 && open >= 2) score += 40
      else if (count === 2 && open >= 1) score += 15
      else if (count === 1 && open >= 2) score += 3
    }
    return score
  }

  function gomokuAiMove() {
    let bestIdx = -1, bestScore = -1
    for (let i = 0; i < GOMOKU_SIZE * GOMOKU_SIZE; i++) {
      if (gomoku.board[i] !== null) continue
      // 进攻分（AI 连子） + 防守分（堵玩家，权重略高）
      const attack = gomokuScoreAt(gomoku.board, i, 'white')
      const defend = gomokuScoreAt(gomoku.board, i, 'black') * 1.1
      const s = attack + defend
      if (s > bestScore) { bestScore = s; bestIdx = i }
    }
    return bestIdx
  }

  function gomokuFinish(winner) {
    gomoku.over = true
    const res = $('gomoku-result')
    res.classList.remove('hidden')
    if (winner === 'black') {
      P.coins += 15
      P.totalGames += 1
      markDaily('game'); unlockPhoto('first-game'); touch()
      addAffection(1)
      saveState(); updateCoins()
      window.GameBridge.complete({ gameId: 'gomoku', score: 1, won: true })
      res.textContent = '🎉 你赢了！+🪙 15'
      gainExp(2)
      unlockPhoto('gomoku-win')
      markGameWin2('gomoku')
    } else if (winner === 'white') {
      if (window.pet.character?.authority) window.GameBridge.complete({ gameId: 'gomoku', score: 0, won: false })
      res.textContent = '电脑获胜'
    } else {
      P.coins += 5
      saveState(); updateCoins()
      if (window.pet.character?.authority) window.GameBridge.complete({ gameId: 'gomoku', score: 0, won: false, draw: true })
      res.textContent = '🤝 平局 +🪙 5'
    }
    renderGomoku()
  }

  function gomokuMove(idx) {
    if (gomoku.over || gomoku.turn !== 'black' || gomoku.board[idx] !== null) return
    gomoku.board[idx] = 'black'
    if (gomokuWin(gomoku.board, 'black')) { gomokuFinish('black'); return }
    // 平局判定（棋盘满）
    if (gomoku.board.every((v) => v !== null)) { gomokuFinish('draw'); return }
    gomoku.turn = 'white'
    renderGomoku()
    // AI 落子
    setTimeout(() => {
      if (gomoku.over) return
      const ai = gomokuAiMove()
      if (ai < 0) { gomokuFinish('draw'); return }
      gomoku.board[ai] = 'white'
      if (gomokuWin(gomoku.board, 'white')) { gomokuFinish('white'); return }
      if (gomoku.board.every((v) => v !== null)) { gomokuFinish('draw'); return }
      gomoku.turn = 'black'
      renderGomoku()
    }, 350)
  }

  $('gomoku-restart').addEventListener('click', gomokuReset)
  gomokuReset()

  const focus = { mode: 'study', active: false, remaining: 25 * 60, timerInt: null }

  function fmtClock(s) {
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
  }

  function updateFocusClock() {
    $('focus-clock').textContent = fmtClock(Math.max(0, focus.remaining))
  }

  function updateFocusMeta() {
    $('focus-meta').textContent = '已完成 🍅 × ' + P.pomodoros + ' · 待办 ' + P.todos.filter((t) => !t.done).length + ' 项'
  }

  function setFocusMode(m, silent) {
    if (focus.active) return
    focus.mode = m
    focus.remaining = m === 'study' ? 25 * 60 : 5 * 60
    updateFocusClock()
    $('focus-study').classList.toggle('dp-level-active', m === 'study')
    $('focus-break').classList.toggle('dp-level-active', m === 'break')
    if (!silent) say(m === 'study' ? '切换到学习模式，加油！' : '切换到休息模式，放松一下～', undefined, 'user-feedback')
  }

  function focusTick() {
    if (window.pet.character?.authority) {
      if (focus.kernelTimer) focus.remaining = Math.max(0, Math.ceil((focus.kernelTimer.remainingMs - (focus.active ? Date.now() - focus.projectedAt : 0)) / 1000))
      updateFocusClock(); return
    }
    focus.remaining -= 1
    updateFocusClock()
    if (focus.remaining <= 0) focusComplete()
  }

  function startFocus() {
    if (window.pet.character?.authority) {
      if (!focus.timerInt) focus.timerInt = setInterval(focusTick, 1000)
      return submitKernelInteraction({ kind: focus.kernelTimer?.paused && focus.kernelTimer.mode === focus.mode ? 'focus_resume' : 'focus_start', mode: focus.mode })
    }
    if (focus.active) return
    focus.active = true
    focus.timerInt = setInterval(focusTick, 1000)
    $('btn-focus').textContent = '暂停'
  }

  function pauseFocus() {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'focus_pause' })
    if (focus.timerInt) { clearInterval(focus.timerInt); focus.timerInt = null }
    focus.active = false
    $('btn-focus').textContent = '继续专注 ⏱'
  }

  function focusComplete() {
    if (window.pet.character?.authority) return
    if (focus.timerInt) { clearInterval(focus.timerInt); focus.timerInt = null }
    focus.active = false
    $('btn-focus').textContent = '开始专注 ⏱'
    if (focus.mode === 'study') {
      P.pomodoros += 1
      P.coins += 5
      gainExp(5)
      saveState()
      updateCoins()
      renderCare()
      diaryEvent('pomo', '')
      setFocusMode('break', true)
      const card = {
        kind: 'pomo',
        title: '🍅 专注完成！',
        text: '学习完成 +5 🪙，起来活动一下喝口水吧～',
        buttons: [
          {
            label: '开始休息 5 分钟',
            onClick: () => {
              clearReminderCard()
              setFocusMode('break', true)
              startFocus()
            },
          },
          {
            label: '继续专注',
            onClick: () => {
              clearReminderCard()
              setFocusMode('study', true)
              startFocus()
            },
          },
          {
            label: '推迟 5 分钟',
            onClick: () => {
              clearReminderCard()
              setTimeout(() => fireReminder(card), 300000)
            },
          },
        ],
      }
      fireReminder(card)
    } else {
      setFocusMode('study', true)
      fireReminder({
        kind: 'pomo',
        title: '☕ 休息结束',
        text: '准备好就继续专注吧！',
        buttons: [
          {
            label: '开始专注 25 分钟',
            onClick: () => {
              clearReminderCard()
              setFocusMode('study', true)
              startFocus()
            },
          },
          {
            label: '再休息 5 分钟',
            onClick: () => {
              clearReminderCard()
              setFocusMode('break', true)
              startFocus()
            },
          },
        ],
      })
    }
    updateFocusMeta()
  }

  $('btn-focus').addEventListener('click', () => {
    if (focus.active) pauseFocus()
    else startFocus()
  })

  $('focus-study').addEventListener('click', () => { if (!focus.active) setFocusMode('study') })
  $('focus-break').addEventListener('click', () => { if (!focus.active) setFocusMode('break') })

  function renderTodos() {
    const wrap = $('todo-list')
    wrap.innerHTML = ''
    if (!P.todos.length) {
      wrap.innerHTML = '<div class="dp-muted">暂无待办，添加一条吧</div>'
    }
    P.todos.forEach((t) => {
      const row = document.createElement('div')
      row.className = 'dp-inv-row'
      const label = document.createElement('span')
      label.textContent = (t.done ? '✅ ' : '⬜ ') + t.text
      if (t.done) label.style.textDecoration = 'line-through'
      const btns = document.createElement('span')
      const doneBtn = document.createElement('button')
      doneBtn.className = 'dp-mini-btn'
      doneBtn.textContent = t.done ? '取消' : '完成'
      doneBtn.addEventListener('click', () => {
        t.done = !t.done
        saveState()
        renderTodos()
        updateFocusMeta()
      })
      const delBtn = document.createElement('button')
      delBtn.className = 'dp-mini-btn'
      delBtn.textContent = '删除'
      delBtn.addEventListener('click', () => {
        P.todos = P.todos.filter((x) => x.id !== t.id)
        saveState()
        renderTodos()
        updateFocusMeta()
      })
      btns.appendChild(doneBtn)
      btns.appendChild(delBtn)
      btns.style.display = 'inline-flex'
      btns.style.gap = '6px'
      row.appendChild(label)
      row.appendChild(btns)
      wrap.appendChild(row)
    })
  }

  $('todo-add').addEventListener('click', () => {
    const v = $('todo-input').value.trim()
    if (!v) return
    P.todos.push({ id: ++uid, text: v, done: false })
    $('todo-input').value = ''
    saveState()
    renderTodos()
    updateFocusMeta()
    say('记下啦：' + v, undefined, 'ui')
  })
  $('todo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('todo-add').click()
  })

  $('memo-add').addEventListener('click', () => {
    const text = $('memo-input').value.trim()
    if (!text) { say('写点什么再保存哦～', undefined, 'ui'); return }
    $('memo-input').value = ''
    addMemo(text)
    say('📌 已存入备忘录', undefined, 'ui')
  })
  $('memo-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('memo-add').click()
  })

  $('diary-enabled').addEventListener('change', () => {
    const v = $('diary-enabled').checked
    $('diary-enabled').disabled = true
    if (window.pet && window.pet.diarySetEnabled) {
      window.pet.diarySetEnabled(v).then((r) => {
        if (!r) throw new Error('setting_failed')
        diaryOn = !!(r && r.enabled)
        if (!diaryOn && window.DiaryEngine && window.DiaryEngine.cancelPending) {
          for (const day of diaryWriteInFlight.keys()) window.DiaryEngine.cancelPending(day)
        }
        updateDiaryUI()
        if (r.ok !== true) {
          say('日记开关本次已生效，但未能保存；重启后可能恢复，请稍后再试～', 6000, 'ui')
          return
        }
        say(diaryOn ? '📔 日记已开启，我会记录你每天的小时光～' : '📔 日记已关闭，我先不收集活动啦', undefined, 'ui')
      }).catch(() => {
        $('diary-enabled').checked = diaryOn
        say('日记开关设置失败，稍后再试～', undefined, 'ui')
      }).finally(() => { $('diary-enabled').disabled = false })
    } else {
      $('diary-enabled').checked = diaryOn
      $('diary-enabled').disabled = false
    }
  })

  /* S3：主动联系开关（UI 首次接线；IPC / pet-prefs / 主进程唯一读写早已存在）。
     默认值仍由主进程 pet-prefs 决定（保持 false，**不改默认值**）；写失败必须回滚复选框并如实提示。 */
  const proactiveCb = $('proactive-enabled')
  if (proactiveCb) {
    proactiveCb.addEventListener('change', () => {
      const v = proactiveCb.checked
      proactiveCb.disabled = true
      if (window.pet && window.pet.proactiveSetEnabled) {
        window.pet.proactiveSetEnabled(v).then((r) => {
          if (!r || r.ok !== true) throw new Error('setting_failed')
          proactiveOn = !!(r && r.enabled)
          if (!proactiveOn) roleRuntime.cancel("proactive_disabled", event => event.kind === "opportunity")
          if (!proactiveOn) { proactivePresentationEpoch++; proactiveHideCard() }
          proactiveCb.checked = proactiveOn
          say(proactiveOn ? '💬 主动联系已开启，我偶尔会来找你聊聊～' : '💬 主动联系已关闭，我不会再主动出现啦', undefined, 'ui')
        }).catch(() => {
          proactiveCb.checked = proactiveOn
          say('主动联系开关设置失败，稍后再试～', undefined, 'ui')
        }).finally(() => { proactiveCb.disabled = false })
      } else {
        proactiveCb.checked = proactiveOn
        proactiveCb.disabled = false
      }
    })
  }

  /* 感知开关。
     语义：**一个开关同时管两个传感器** —— 打开 = 看前台应用类别 + 听系统媒体信息；
     打开时会顺带打开"听"（历史上打开听也会带开总开关，保持行为最不易误解）；
     关掉 = 两个传感器一起停。传感器各自的 enabled 字段保留（管道内部要用），
     UI 不再暴露第二颗开关。 */
  const perceptionCb = $('perception-enabled')
  if (perceptionCb) {
    if (window.pet.character?.authority) window.pet.character.perception().then(result => { if (result.ok) perceptionCb.checked = result.enabled })
    perceptionCb.addEventListener('change', () => {
      if (window.pet.character?.authority) {
        void window.pet.character.perception(!!perceptionCb.checked).then(result => {
          if (result.ok) perceptionCb.checked = result.enabled
          else systemNotice('感知设置未保存：' + result.reason, 5000, 'ui')
        })
        return
      }
      const pipe = perceptionPipeline()
      if (pipe && typeof pipe.ensureState === 'function') pipe.ensureState(P)
      if (!P.perceptionConfig) P.perceptionConfig = { enabled: false, intervalMs: 30000, confidenceMin: 0.5 }
      if (!P.perceptionConfig.sensors) P.perceptionConfig.sensors = {}
      if (!P.perceptionConfig.sensors.hearing) P.perceptionConfig.sensors.hearing = { enabled: false, intervalMs: 10000 }
      const on = !!perceptionCb.checked
      P.perceptionConfig.enabled = on
      P.perceptionConfig.sensors.hearing.enabled = on
      saveState()
      if (on) {
        startPerception()
        say('👀 好的，我会留意你在忙什么、在听什么～', 5000, 'ui')
      } else {
        if (pipe && typeof pipe.stop === 'function') pipe.stop()
        say('👀 明白，我先不看也不听啦', 5000, 'ui')
      }
    })
  }

  $('btn-diary-pin').addEventListener('click', () => {
    $('diary-pin-row').classList.toggle('hidden')
    if (!$('diary-pin-row').classList.contains('hidden')) $('diary-pin-input').focus()
  })
  function currentDiaryTimeContext() {
    try {
      if (window.DiaryEngine && typeof window.DiaryEngine.createDiaryContext === 'function') {
        const dc = window.DiaryEngine.createDiaryContext({})
        return { currentDate: dc.currentDate || dc.diaryDay, diaryDay: dc.diaryDay, generatedAt: dc.generatedAt }
      }
    } catch (err) { /* ignore */ }
    const now = new Date()
    return { currentDate: now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate(), diaryDay: '', generatedAt: now.getTime() }
  }

  $('diary-pin-ok').addEventListener('click', () => {
    const v = $('diary-pin-input').value.trim()
    $('diary-pin-row').classList.add('hidden')
    if (!v) return
    diaryEvent('pin', v)
    const dc = currentDiaryTimeContext()
    if (window.MemoryEngine && typeof window.MemoryEngine.remember === 'function') {
      window.MemoryEngine.remember(v, {
        type: 'fact',
        tags: ['manual', 'diary-pin'],
        importance: 0.8,
        ts: dc.generatedAt,
        date: dc.currentDate
      })
    }
    $('diary-pin-input').value = ''
    say('📌 记住啦，会作为重要记忆保存，也会写进今天的日记～', undefined, 'ui')
  })
  $('diary-pin-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) $('diary-pin-ok').click()
  })
  $('btn-diary-forget').addEventListener('click', async () => {
    if (R.writingDiary) { say('日记还在写，请写完后再清除～', 5000, 'ui'); return }
    if (!forgetArmed) {
      forgetArmed = true
      $('btn-diary-forget').textContent = '再点一次确认 ⚠️'
      setTimeout(() => {
        forgetArmed = false
        $('btn-diary-forget').textContent = '🌫 忘掉今天'
      }, 5000)
      return
    }
    forgetArmed = false
    $('btn-diary-forget').textContent = '🌫 忘掉今天'
    const dc = currentDiaryTimeContext()
    const today2 = dc.diaryDay || dc.currentDate || diaryDayKey(new Date())
    const previousDiary = P.diary.slice()
    const previousOutputs = Array.isArray(P.diaryOutputs) ? P.diaryOutputs.slice() : []
    const previousSuppressed = P.diarySuppressed
    P.diary = P.diary.filter((d) => d.date !== today2)
    if (Array.isArray(P.diaryOutputs)) P.diaryOutputs = P.diaryOutputs.filter((o) => o.diaryDay !== today2)
    // 保留长期 Memory / Relationship / 重要记忆；只清除当天临时日记与时间线。
    P.diarySuppressed = today2
    if (await saveState() !== true) {
      P.diary = previousDiary; P.diaryOutputs = previousOutputs; P.diarySuppressed = previousSuppressed
      say('清除未能保存，原有日记已保留，请稍后再试～', 6000, 'ui')
      return
    }
    if (window.DiaryEngine && window.DiaryEngine.removeDay) window.DiaryEngine.removeDay(today2)
    diaryLastResult = null
    let cleared = false
    try {
      if (window.pet && window.pet.diaryForgetToday) {
        const result = await window.pet.diaryForgetToday()
        cleared = !!(result && result.ok === true)
      }
    } catch (err) { /* Partial failure is explained below. */ }
    __diaryTLCache = null
    renderDiary()
    say(cleared ? '🌫 今天的临时记录已清掉，长期记忆和重要回忆还留着～' : '日记已删除，但活动记录没能清除，请再点“忘掉今天”重试。', 6000, 'ui')
  })
  $('diary-memory-del').addEventListener('click', () => {
    if (!lastShownMemory) return
    if (window.MemoryEngine && lastShownMemory.id) window.MemoryEngine.archive(lastShownMemory.id)
    renderDiary()
    say('已忘记这条记忆', undefined, 'ui')
  })

  $('diary-time').addEventListener('change', () => {
    const v = $('diary-time').value
    if (!/^\d{2}:\d{2}$/.test(v)) return
    P.diaryTime = v
    saveState()
    renderDiary()
    say('日记时间已设为 ' + v + '，到点自动写～', undefined, 'ui')
  })

  const GAME_PANES = { catch: 'game-catch', snake: 'game-snake', t2048: 'game-t2048', guess: 'game-guess', ttt: 'game-ttt', sudoku: 'game-sudoku', gomoku: 'game-gomoku', mines: 'game-mines' }

  function pickGame(name) {
    if (!GAME_PANES[name]) return
    if (activeGame === 'catch' && game.playing) abortGame()
    if (activeGame === 'snake') abortSnake()
    activeGame = name
    Object.keys(GAME_PANES).forEach((g) => {
      $(GAME_PANES[g]).classList.toggle('hidden', g !== name)
    })
    const pane = $('tab-game')
    if (pane) pane.scrollTop = 0
    document.querySelectorAll('.dp-game-picker .dp-tab').forEach((b) => {
      b.classList.toggle('dp-tab-active', b.id === 'pick-' + name)
    })
    if (name === 'snake' && !snake.playing) snakeReset()
    if (name === 't2048') tReset()
    if (name === 'guess') guessReset()
    if (name === 'ttt') tttReset()
    if (name === 'sudoku' && !sudoku.started) sudokuReset()
    if (name === 'gomoku') gomokuReset()
  }

  $('pick-catch').addEventListener('click', () => pickGame('catch'))
  $('pick-snake').addEventListener('click', () => pickGame('snake'))
  $('pick-t2048').addEventListener('click', () => pickGame('t2048'))
  $('pick-guess').addEventListener('click', () => pickGame('guess'))
  $('pick-ttt').addEventListener('click', () => pickGame('ttt'))
  $('pick-sudoku').addEventListener('click', () => pickGame('sudoku'))
  $('pick-gomoku').addEventListener('click', () => pickGame('gomoku'))
  $('pick-mines').addEventListener('click', () => pickGame('mines'))

  /* ---------- 互动面板：游戏 / 休息 / 清洁 / 工作 ---------- */
  const INTERACT_VIEWS = { game: 'interact-game', rest: 'interact-rest', clean: 'interact-clean', work: 'interact-work' }
  let activeInteract = 'game'

  function switchInteract(view) {
    if (!INTERACT_VIEWS[view]) return
    activeInteract = view
    Object.keys(INTERACT_VIEWS).forEach((v) => {
      $(INTERACT_VIEWS[v]).classList.toggle('hidden', v !== view)
    })
    document.querySelectorAll('.dp-interact-picker .dp-tab').forEach((b) => {
      b.classList.toggle('dp-tab-active', b.id === 'pick-' + view)
    })
    if (view === 'rest') renderRestStatus()
    if (view === 'work') renderWorkList()
  }
  $('pick-game').addEventListener('click', () => switchInteract('game'))
  $('pick-rest').addEventListener('click', () => switchInteract('rest'))
  $('pick-clean').addEventListener('click', () => switchInteract('clean'))
  $('pick-work').addEventListener('click', () => switchInteract('work'))

  /* ---------- 休息：设定时长，期间恢复心情+精力 ---------- */
  let restTimer = null
  let restUntil = 0 // 结束时间戳
  let restEndAt = 0

  function startRest() {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'rest_start', minutes: Number($('rest-min').value) || 10 })
    if (R.workId) { say('工作中，先结束工作再休息哦～', undefined, 'user-feedback'); return }
    if (restTimer) { clearInterval(restTimer); restTimer = null }
    const mins = Number($('rest-min').value) || 10
    restUntil = Date.now() + mins * 60000
    restEndAt = restUntil
    setMood('sleepy')
    say('😴 我要休息 ' + mins + ' 分钟啦，醒来会更精神～', 4000, 'user-feedback')
    renderRestStatus()
    // 休息期间心情/精力恢复已由主循环处理（休息时自然消耗停止）
    restTimer = setInterval(() => {
      if (Date.now() >= restUntil) { finishRest(); return }
      renderRestStatus()
    }, 30000)
  }

  function finishRest() {
    if (restTimer) { clearInterval(restTimer); restTimer = null }
    restUntil = 0
    restEndAt = 0
    setMood('idle')
    say('😊 休息结束，精神满满！', 3500, 'user-feedback')
    renderRestStatus()
  }

  function cancelRest() {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'rest_cancel' })
    if (restTimer) { clearInterval(restTimer); restTimer = null }
    restUntil = 0
    restEndAt = 0
    setMood('idle')
    renderRestStatus()
  }

  function renderRestStatus() {
    const el = $('rest-status')
    if (!el) return
    if (restUntil > Date.now()) {
      const left = Math.ceil((restUntil - Date.now()) / 60000)
      el.textContent = '😴 休息中，还有 ' + left + ' 分钟（心情/精力持续恢复）'
    } else {
      el.textContent = '未在休息（休息期间心情 +0.6/分、精力 +0.8/分）'
    }
  }
  $('btn-rest-start').addEventListener('click', startRest)
  // 离开互动页或切走时自动结束休息？保持休息跨页生效（更自然），仅由用户主动取消
  window.pet.onTrayCommand((data) => {
    if (data && data.cmd === 'toggle-sound' && restTimer) { /* 不影响 */ }
  })
  renderRestStatus()

  /* ---------- 工作：挂机赚金币 ---------- */
  // 女仆职责映射（参考百科：打扫/泡茶/整理/园艺/烹饪/洗衣/缝纫等），
  // 每份工作独立设定：时长 / 基础酬劳 / 状态消耗速率 / 解锁条件
  const WORK_JOBS = window.NurtureRules.WORK_JOBS
  const WORK_STAT_NAMES = { satiety: '饱食', mood: '心情', energy: '精力', thirst: '口渴' }

  // 收益公式：基础酬劳 ×（1 + 等级加成 + 好感度档加成 + 心情加成）
  function workReward(job) {
    const lvBonus = Math.max(0, (P.level || 1) - 1) * 0.02
    const affTierIdx = AFF_LEVELS.findIndex((l) => P.affection < l.min) - 1
    const affIdx = affTierIdx < 0 ? AFF_LEVELS.length - 1 : affTierIdx
    const affBonus = affIdx * 0.05
    const moodBonus = P.stats.mood >= 75 ? 0.1 : P.stats.mood < 30 ? -0.1 : 0
    return Math.max(1, Math.round(job.reward * (1 + lvBonus + affBonus + moodBonus)))
  }

  // 前置条件：按工作总消耗量校验 —— 起始状态必须够撑完整份工作，且结束后留 15 点保底，
  // 保证满状态一定能按时完成，状态不足在开工前就拦截，不会出现中途状态条耗尽
  function workBlockReason(job) {
    const need = {}
    Object.keys(job.consume || {}).forEach((k) => { need[k] = job.consume[k] * job.minutes })
    if ((need.satiety || 0) > 0 && P.stats.satiety - need.satiety < 15) {
      return '饱食度撑不完这份工作（需 ' + Math.ceil(need.satiety + 15 - P.stats.satiety) + '），先吃点东西吧'
    }
    if ((need.energy || 0) > 0 && P.stats.energy - need.energy < 15) {
      return '精力撑不完这份工作（需 ' + Math.ceil(need.energy + 15 - P.stats.energy) + '），先休息一下吧'
    }
    if ((need.thirst || 0) > 0 && P.stats.thirst - need.thirst < 15) {
      return '口渴值撑不完这份工作（需 ' + Math.ceil(need.thirst + 15 - P.stats.thirst) + '），先喝口水吧'
    }
    return null
  }

  // 工作消耗速率：job.consume 是「每分钟消耗点」（如 energy:0.8 = 每分钟 0.8 点）。
  // 主循环每 60s 跑一次 → 每次直接扣 job.consume[k]（不要再除以秒数，否则速率差 60 倍）
  function workConsumePerMin(job) {
    return Object.assign({}, job.consume || {})
  }

  function renderWorkList() {
    const wrap = $('work-list')
    const prog = $('work-progress')
    if (!wrap) return
    if (R.workId) {
      wrap.classList.add('hidden')
      prog.classList.remove('hidden')
      renderWorkProgress()
      return
    }
    wrap.classList.remove('hidden')
    prog.classList.add('hidden')
    wrap.innerHTML = ''
    WORK_JOBS.forEach((job) => {
      const lv = P.level || 1
      const aff = P.affection || 0
      const locked = lv < job.minLevel || aff < job.minAff
      const card = document.createElement('div')
      card.className = 'dp-work-card' + (locked ? ' locked' : '')
      const icon = document.createElement('div')
      icon.className = 'dp-work-icon'
      icon.textContent = job.icon
      const info = document.createElement('div')
      info.className = 'dp-work-info'
      const name = document.createElement('div')
      name.className = 'dp-work-name'
      name.textContent = job.name
      const desc = document.createElement('div')
      desc.className = 'dp-work-desc'
      desc.textContent = job.desc
      const meta = document.createElement('div')
      meta.className = 'dp-work-meta'
      const cons = Object.keys(job.consume || {}).map((k) => WORK_STAT_NAMES[k] + ' ' + job.consume[k] + '/分').join('、')
      meta.textContent = '⏱ ' + job.minutes + ' 分钟 · 🪙 ' + workReward(job) + ' · ' + cons
      if (locked) {
        const why = []
        if (lv < job.minLevel) why.push('Lv.' + job.minLevel)
        if (aff < job.minAff) why.push('好感度 ' + job.minAff)
        meta.innerHTML += ' <span class="warn">🔒 ' + why.join(' / ') + ' 解锁</span>'
      }
      info.appendChild(name)
      info.appendChild(desc)
      info.appendChild(meta)
      const go = document.createElement('div')
      go.className = 'dp-work-go'
      const btn = document.createElement('button')
      btn.className = 'dp-mini-btn'
      btn.textContent = locked ? '未解锁' : '开始'
      btn.disabled = locked
      btn.addEventListener('click', () => startWork(job.id))
      go.appendChild(btn)
      card.appendChild(icon)
      card.appendChild(info)
      card.appendChild(go)
      wrap.appendChild(card)
    })
    renderWorkLog()
  }

  function renderWorkProgress() {
    const job = WORK_JOBS.find((j) => j.id === R.workId)
    if (!job) return
    const total = job.minutes * 60000
    const left = Math.max(0, R.workEnd - Date.now())
    const pct = clamp(Math.round(((total - left) / total) * 100), 0, 100)
    $('work-progress-name').textContent = job.icon + ' ' + job.name + ' 进行中…'
    $('work-progress-fill').style.width = pct + '%'
    $('work-progress-pct').textContent = pct + '%'
    const mm = Math.floor(left / 60000)
    const ss = Math.floor((left % 60000) / 1000)
    $('work-progress-time').textContent = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0')
    $('work-progress-reward').textContent = '预计收益 ' + workReward(job) + ' 🪙（完整完成）'
  }

  function renderWorkLog() {
    const el = $('work-log')
    if (!el) return
    const today = dayKey(new Date())
    const todayMin = P.workLog.filter((w) => w.date === today).reduce((s, w) => s + (w.minutes || 0), 0)
    el.textContent = '📊 今日已工作 ' + todayMin + ' 分钟 · 累计 ' + P.workMinutes + ' 分钟 · ' + P.workSessions + ' 次'
  }

  function startWork(id) {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'work_start', id })
    if (R.workId) return
    // 工作与聊天面板完全独立：不需要先收起聊天；工作中打开/收起聊天也不影响工作
    if (restUntil > Date.now()) { say('正在休息中，先结束休息再开始工作哦～', undefined, 'user-feedback'); return }
    const job = WORK_JOBS.find((j) => j.id === id)
    if (!job) return
    if ((P.level || 1) < job.minLevel || (P.affection || 0) < job.minAff) { say('🔒 等级或好感度不够，还做不了这份工作～', undefined, 'user-feedback'); return }
    const block = workBlockReason(job)
    if (block) { say(block, undefined, 'user-feedback'); return }
    R.workId = id
    R.workStart = Date.now()
    R.workEnd = R.workStart + job.minutes * 60000
    setMood('working')
    // 工作中动画：以写代码为主（80%），偶尔碎碎念（20%）
    playAnim(Math.random() < 0.8 ? 'work-code' : 'work-think')
    say(job.icon + ' 开工！' + job.name + ' ' + job.minutes + ' 分钟，完成可得 🪙 ' + workReward(job) + '～', 4000, 'user-feedback')
    renderWorkList()
    renderCare()
    // 工作中每 5 秒刷新进度 + 消耗状态；结算由主循环 60s tick 判定
    if (workUiTimer) clearInterval(workUiTimer)
    workUiTimer = setInterval(() => {
      if (!R.workId) { clearInterval(workUiTimer); workUiTimer = null; return }
      renderWorkProgress()
    }, 5000)
  }

  // 提前结束：按已过时间比例结算（打 5 折防刷）
  /* （可刷漏洞）：原来"点开始 → 立刻提前结束"也保底 +1 金币，
     且每次都计入 workSessions / totalWorkDone ⇒ 连点 20 次即可白拿「work-sess-20」成就
     与「模范员工」照片。现在只对**真正干过一段活**的会话结算：
     不足 1 分钟 = 取消（不计次数、不发币、不写日志），保证"次数类成就"只能靠真实工作拿到。 */
  const MIN_WORK_SETTLE_MS = 60 * 1000
  function cancelWork() {
    if (window.pet.character?.authority) return submitKernelInteraction({ kind: 'work_cancel' })
    if (!R.workId) return
    const job = WORK_JOBS.find((j) => j.id === R.workId)
    if (!job) { finishWorkUI(); return }
    const total = job.minutes * 60000
    const elapsed = Date.now() - R.workStart
    if (!(elapsed >= MIN_WORK_SETTLE_MS)) {
      // 太短：视为取消，不留任何进度痕迹
      say('这么快就取消啦？这次不算工时哦～', 4000, 'ui')
      R.workId = null
      R.workStart = 0
      finishWorkUI()
      return
    }
    const ratio = clamp(elapsed / total, 0, 1)
    const coins = Math.max(1, Math.round(workReward(job) * ratio * 0.5))
    settleWork(job, coins, Math.round(ratio * job.minutes), true)
  }

  // 结算：发金币 + 记日志 + 成就 + 恢复 UI
  function settleWork(job, coins, minutes, early) {
    const workRunKey = 'work:' + job.id + ':' + (R.workStart || Date.now())
    if (settledWorkRuns.has(workRunKey)) return
    settledWorkRuns.add(workRunKey)

    P.coins += coins
    P.workMinutes += minutes
    P.workSessions += 1
    P.totalWorkDone += 1
    P.workLog.push({ date: dayKey(new Date()), id: job.id, name: job.name, coins, minutes, ts: Date.now() })
    P.workLog = P.workLog.slice(-50)
    saveState()
    updateCoins()
    renderCare()
    markDaily('work')
    touch() // 完成工作 = 有陪伴互动
    renderWorkList()
    renderWorkLog()
    say(job.icon + ' ' + (early ? '提前收工' : '完成') + '！' + job.name + ' 赚了 🪙 ' + coins + (early ? '（提前结束按比例结算）' : '') + '～', 5000, 'user-feedback')
    // 状态消耗由主循环在 workEnd 前逐分钟扣减；此处只补最后不足一分钟的零头
    checkAchievements()
    unlockPhoto('first-day')
    if (minutes >= 30) unlockPhoto('hard-coding')
    diaryEvent('work', job.name)
    window.EventBus.emitOnce('pet.work.completed', { jobId: job.id, jobName: job.name, runId: workRunKey, ts: Date.now(), coins, minutes }, 'settle:' + workRunKey)
    finishWorkUI()
    if (!R.hidden) showAnimOnce('work-success')
  }

  function finishWorkUI() {
    R.workId = null
    R.workStart = 0
    R.workEnd = 0
    if (workUiTimer) { clearInterval(workUiTimer); workUiTimer = null }
    setMood('idle')
    playAnim('idle')
    renderWorkList()
    renderCare()
  }

  $('btn-work-cancel').addEventListener('click', cancelWork)
  // 主循环 60s tick 里处理：工作中逐分钟消耗 + 到时自动结算
  // 见 setInterval(() => { ... }, 60000) 内追加的逻辑
  renderWorkList()

  /* ---------- 清洁：调 DSH 安全清理系统垃圾 ---------- */
  $('btn-clean-run').addEventListener('click', async () => {
    const btn = $('btn-clean-run')
    const st = $('clean-status')
    btn.disabled = true
    st.textContent = '🧹 正在派发清理任务给 DeepSeek…'
    say('🧹 收到！我这就去叫 DeepSeek 帮忙清理垃圾～', 4000, 'ui')
    try {
      const r = await window.pet.cleanRun()
      if (r && r.ok) {
        st.textContent = '✅ ' + (r.note || '清理任务已派发')
        say('🧹 清理任务已发出，结果稍后送到～', 4000, 'ui')
        unlockPhoto('clean-time')
      } else {
        st.textContent = '❌ ' + ((r && r.error) || '清理失败')
        say('🧹 清理失败了：' + ((r && r.error) || '未知原因'), 4000, 'ui')
      }
    } catch (err) {
      st.textContent = '❌ ' + (err && err.message)
    } finally {
      btn.disabled = false
    }
  })

  /* ---------- 扫雷（独立窗口）金币回传 ---------- */
  window.pet.onMinesweeperReward((payload) => {
    if (!payload || !payload.ok) return
    P.coins += payload.total || 0
    P.totalGames += 1
    markDaily('game'); unlockPhoto('first-game'); touch()
    addAffection(1)
    saveState()
    window.GameBridge.complete({ gameId: 'mines', score: payload.total || 0, won: true })
    updateCoins()
    const res = $('mines-result')
    if (res) {
      res.classList.remove('hidden')
      res.textContent = '💣 扫雷 ' + (payload.level === 'easy' ? '初级' : payload.level === 'mid' ? '中级' : '高级') + ' 通关 +🪙 ' + payload.total
      setTimeout(() => res.classList.add('hidden'), 8000)
    }
    say('扫雷通关啦！+🪙 ' + payload.total, undefined, 'ui')
    gainExp(2)
    unlockPhoto('mines-clear')
      markGameWin2('mines')
  })
  $('btn-open-mines').addEventListener('click', () => window.pet.minesweeperOpen())

  // 迷你图标点击唤出；但拖拽后（有位移）不触发——否则拖完松开就退出收起状态
  miniEl.addEventListener('click', (e) => {
    if (dragMoved) return
    doShow()
  })

  ta.addEventListener('input', () => { btnSend.disabled = !ta.value.trim() })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
    else if (e.key === 'Escape') closeChat()
  })

  sel.addEventListener('change', () => {
    R.currentId = sel.value
    refreshSessionControls()
    if (R.chatView === 'hist') refreshHist()
  })

  bubbleEl.addEventListener('click', () => {
    if (bubbleEl.dataset.report === '1') hideReport()
    else if (bubbleEl.classList.contains('dp-bubble-interaction')) return
    else if (bubbleEl.classList.contains('dp-bubble-remind')) return
    else clearSayBubble()
  })

  // 从窗口外进入时，先收起闲聊气泡，让浮标干净地出现（交互卡/提醒卡/闲聊思考与回复不受影响）
  stage.addEventListener('mouseenter', () => {
    if (!bubbleEl.classList.contains('hidden') && bubbleEl.dataset.report !== '1'
      && !bubbleEl.classList.contains('dp-bubble-interaction')
      && !bubbleEl.classList.contains('dp-bubble-remind')
      && bubbleEl.dataset.chatReply !== '1'
      && bubbleEl.dataset.thinking !== '1') clearSayBubble()
  })

  /* ---------- idle life ---------- */

  // Autonomous rest follows the persistent life activity, not a six-second lottery.


  // 随机台词：串行调度——台词显示（5s）结束之后才开始计 15s，再弹下一句。
  // 避免固定间隔并发计时导致"上一句还没播完下一句又来"的冲突。
  const LINE_SHOW_MS = 5000
  const LINE_GAP_MS = 10000 // 显示 5s + 等 10s = 15s 一轮（恢复原活跃频率）
  let lineTimer = null
  let lastLineLog = 0
  let characterChatActiveCount = 0
  function cancelRandomTimer() {
    if (lineTimer) {
      clearTimeout(lineTimer)
      lineTimer = null
    }
  }
  function finishCharacterChat() {
    if (characterChatActiveCount > 0) characterChatActiveCount--
    if (characterChatActiveCount === 0) {
      cancelRandomTimer()
      scheduleNextLine()
    }
  }

  function scheduleNextLine() {
    return // Runtime opportunities replace the old independent dialogue timer.
    if (lineTimer) clearTimeout(lineTimer)
    lineTimer = setTimeout(() => {
      lineTimer = null
      // 诊断：记录被哪一步拦截（节流到 5 秒一条）
      const block = R.hidden ? 'hidden' : R.chatOpen ? 'chatOpen' : R.busy ? 'busy' : R.dragging ? 'dragging'
        : R.sleepy ? 'sleepy'
          : bubbleEl.dataset.report === '1' ? 'report'
            : (bubbleEl.dataset.chatReply === '1' || bubbleEl.dataset.thinking === '1') ? 'chatReply' : ''
      // 注：不拦截 R.running——外部会话运行状态不该卡死桌宠台词（开发机常选到 running 会话导致一直无气泡）
      if (block) {
        if (Date.now() - lastLineLog > 5000) { lastLineLog = Date.now(); console.log('line-blocked:', block, 'chatOpen=' + R.chatOpen, 'busy=' + R.busy, 'running=' + R.running) }
        scheduleNextLine()
        return
      }
      if (Pace.ambientBlocked()) {
        if (Date.now() - lastLineLog > 5000) { lastLineLog = Date.now(); console.log('line-blocked:', 'burst-limit', 'pace=' + Pace.status()) }
        scheduleNextLine()
        return
      }
      const pool = currentLines()
      if (pool.length) {
        if (bubbleOwner === 'character-chat' || bubbleOwner === 'presence' || bubbleOwner === 'expression') {
          scheduleNextLine()
          return
        }
        console.log('line-ok: 弹出台词', pool.length, '条可选')
        const randomToken = beginBubble('random-dialogue')
        if (randomToken) {
          say(pick(pool), LINE_SHOW_MS, 'random-dialogue', randomToken)
          Pace.onAmbient()
          setTimeout(() => { if (bubbleTokenValid(randomToken)) endBubble(randomToken) }, LINE_SHOW_MS)
        }
      }
      scheduleNextLine()
    }, LINE_SHOW_MS + LINE_GAP_MS)
  }
  scheduleNextLine()

  /* ---------- boot ---------- */

  // 托盘大小调节：应用 CSS 缩放变量（持久化在 P）
  function applyScales() {
    const root = document.documentElement
    root.style.setProperty('--ui-scale', String(P.uiScale || 1))
    root.style.setProperty('--pet-scale', String(P.petScale || 1))
  }

  /* ---------- 统一启动刷新 ---------- */
  // 状态加载完成后一次性刷新所有依赖 P 的 UI 面板：
  // 之前各面板在 loadState 完成前先用 P 默认值渲染（音量/金币/待办/番茄钟/日程/工作解锁等
  // 显示默认值或 0 的"没保存"假象），这里统一在状态就绪后刷新，避免遗漏。
  function refreshAllUI() {
    applyName()
    applyScales()
    renderCare() // 含状态条/背包/等级/成就
    updateStatusUI()
    updateCoins()
    renderMemos()
    renderDiary()
    renderTodos()
    renderSchedule()
    updateFocusMeta()
    updateSettingsUI() // 音效/音量/喝水间隔/日记时间/学期/自启/桥/更新检测
    updateHydrateBtn()
    renderWorkList() // 依赖等级/好感度（未解锁判定）
    renderWorkLog()
  }

  // 托盘命令（main.js 转发）：切换迷你/声音/大小
  window.pet.onTrayCommand((data) => {
    if (!data) return
    const cmd = data.cmd
    if (cmd === 'toggle-mini') {
      if (R.hidden) doShow()
      else doHide()
    } else if (cmd === 'toggle-sound') {
      P.soundEnabled = !P.soundEnabled
      saveState()
      updateSettingsUI()
      say(P.soundEnabled ? '提示音已开启 🔊' : '提示音已关闭 🔇', undefined, 'ui')
    } else if (cmd === 'ui-scale') {
      P.uiScale = clamp(Number(data.value) || 1, 0.6, 1.8)
      applyScales()
      saveState()
      say('UI 大小已调整', undefined, 'ui')
    } else if (cmd === 'pet-scale') {
      P.petScale = clamp(Number(data.value) || 1, 0.5, 2)
      applyScales()
      saveState()
      say('桌宠大小已调整', undefined, 'ui')
    } else if (cmd === 'line-settings') {
      // 打开独立的台词池设置窗口
      window.pet.linesOpen()
    }
  })

  // 台词数据在独立窗口修改后：刷新本实例的 P（下次随机弹出立即生效）
  window.pet.onLinesChanged(() => {
    window.pet.stateLoad().then((saved) => {
      if (saved && typeof saved === 'object') {
        if (Array.isArray(saved.customLines)) P.customLines = saved.customLines
        if (Array.isArray(saved.disabledGroups)) P.disabledGroups = saved.disabledGroups
        // 同步用户完整台词覆盖表（P.lines：官方预设也可编辑/删除后保存）
        if (saved.lines && typeof saved.lines === 'object') {
          P.lines = saved.lines
        }
      }
    }).catch(() => { /* ignore */ })
  })

  // 工作区路径：主进程提供（环境变量 DSH_WORKSPACE 可覆盖，默认用户主目录 dsh-workspace）
  if (window.pet.workspacePath) window.pet.workspacePath().then((p) => { if (p) WORKSPACE = p }).catch(() => { /* 拿不到则空 */ })

  window.UIAdapter.bind({ getState: () => PetStateApi.snapshot(), get: (path) => PetStateApi.get(path) })
  // Completed local actions become receipts. They are never inferred from a
  // model sentence or a scheduled intention, and do not create owner memories.
  if (window.EventBus) {
    window.EventBus.on('game.completed', ev => {
      if (window.PetLife && window.PetLife.recordEvent) window.PetLife.recordEvent({ type: 'game.completed', eventId: ev.eventId || ('game:' + livingSessionId + ':' + ev.gameId + ':' + ev.ts), ts: ev.ts || Date.now(), game: { gameId: ev.gameId, score: ev.score, won: ev.won, draw: ev.draw, level: ev.level, elapsedSeconds: ev.elapsedSeconds } }).then(renderLivingNotebook).catch(err => console.warn('[living] game receipt:', err.message))
    })
    window.EventBus.on('pet.work.completed', ev => {
      if (window.PetLife && window.PetLife.recordEvent) window.PetLife.recordEvent({ type: 'work.completed', eventId: ev.runId || ('work:' + livingSessionId + ':' + ev.jobId + ':' + ev.ts), ts: ev.ts || Date.now(), text: '完成了桌宠工作：' + (ev.jobName || ev.jobId), refs: ['work:' + ev.jobId] }).then(renderLivingNotebook).catch(err => console.warn('[living] work receipt:', err.message))
    })
  }
  window.AlbumSystem.bind({ unlockPhoto })
  window.AchievementSystem.bind({ checkAchievements })
  // Keep the synchronous inspection API; writes await a fresh snapshot instead of
  // consuming yesterday's cache on the first request after a day rollover.
  window.DiarySystem.bind({ writeDiary, diaryTimeline: () => __diaryTLCache,
    diaryTimelineAsync: refreshDiaryTimeline,
    /* P2/D4-3：删除入口走 window 钩子（实现在 renderDiary 同作用域） */
    deleteDiaryEntry: (id) => (window.__deleteDiaryEntry ? window.__deleteDiaryEntry(id) : null) })
  refreshDiaryTimeline().catch(() => {})
  window.MemorySystem.bind({ addMemory: (c) => window.MemoryEngine ? window.MemoryEngine.addCandidate(c) : null })

  loadState().then(() => {
    if (window.pet.character?.authority) { refreshAllUI(); return }
    // 状态就绪：先跑会改动状态/数值的日常检查（生日加成、久别重逢），再统一刷新全部 UI
    ensureDaySnapshot()
    checkReunion()
    refreshAllUI()
    // 视听说 B·感知：注入人设底色（幂等）+ 补齐 Config/State（含 v1→v2 迁移）+ 启动感知循环
    seedLorebookPersona()
    const pipeInit = perceptionPipeline()
    if (pipeInit && typeof pipeInit.ensureState === 'function') pipeInit.ensureState(P)
    startPerception()
    const perceptionCbInit = $('perception-enabled')
    /* 合并后的单开关回填：任一传感器处于开启状态就显示为"开"（旧档可能只有 hearing 开着）。
       注意：管道真正的启动条件仍是 P.perceptionConfig.enabled（见上），
       这里只让 UI 如实反映"有没有在读"。 */
    if (perceptionCbInit) {
      const pc = P.perceptionConfig || {}
      const hearingOn = !!(pc.sensors && pc.sensors.hearing && pc.sensors.hearing.enabled)
      perceptionCbInit.checked = !!(pc.enabled || hearingOn)
    }
    /* S3：主动联系开关回填（设置页 reload / 重开窗口后必须如实反映真实开关；只读、不写回）。 */
    try {
      const pcb = $('proactive-enabled')
      if (pcb && window.pet && window.pet.proactiveGetEnabled) {
        window.pet.proactiveGetEnabled().then((r) => {
          proactiveOn = !!(r && r.enabled)
          if (!proactiveOn) roleRuntime.cancel("proactive_disabled", event => event.kind === "opportunity")
          pcb.checked = proactiveOn
        }).catch(() => { pcb.checked = proactiveOn })
      }
    } catch (err) { /* 回填失败不阻塞启动 */ }

    // 相册初始化：首次启动 → 初次见面；每天首次打开 → 早安第一眼；随后按时段/数值扫描
    P.bootCount += 1
    // 初次见面：首次启动解锁；兼容旧档（bootCount 缺失/已 >1 但从未解锁）补发一次
    if (P.bootCount === 1 || !P.photos['first-meet']) {
      // 首次/旧档补发：只解锁"初次见面"——第一眼相遇已涵盖在初次见面里，
      // "早安第一眼"从第二天开始（每天首次打开时解锁）
      unlockPhoto('first-meet')
      // 静默标记 morning-first 为已解锁今日（checkPhotoUnlocks 的每日逻辑会补，
      // 但首次启动当天不弹"早安"卡片；从明天起每天解锁）
      if (!P.photos['morning-first']) {
        P.photos['morning-first'] = { ts: Date.now() }
        saveState()
      }
    } else {
      // 早安第一眼：用照片自身的解锁时间判断"今天是否已解锁"（不能用 lastSeenDate——
      // loadState 内部 updateStreak 已把它更新为今天，会导致永不触发）
      const mf = P.photos['morning-first']
      if (!mf || dayKey(new Date(mf.ts)) !== dayKey(new Date())) unlockPhoto('morning-first')
    }
    // 照片灾后恢复：若启动时照片数量异常少于"统计数据可判定的 check 型"（如被旧版覆盖丢失），
    // 按保留的统计数据静默补发，避免用户看到已达成条件/记过的照片"变回未解锁"
    const restored = restorePhotosFromStats()
    if (restored > 0) console.log('photo-restore: 补发 ' + restored + ' 张（统计数据可判定）')
    checkPhotoUnlocks()
    // 成就补检：同日重启后也能把"早就达标"的成就补上（原来开机完全不查成就）
    catchUpAchievements()
    saveState()
    setTimeout(() => {
      say('你好呀，我是' + P.name + '！有需要随时 💬 派活～', 6000, 'ui')
    }, 900)
  })

  renderShop()
  /* P4-P1：Harness 状态首轮刷新 + 30s 周期；未检测到官方 Desktop 时开机提示一次 */
  refreshHarnessStatusUI()
  if (window.pet.onHarnessChanged) window.pet.onHarnessChanged(refreshHarnessStatusUI)
  setInterval(refreshHarnessStatusUI, 30000)
  setTimeout(() => {
    try {
      const el = $('harness-status')
      if (el && el.textContent.indexOf('未检测到') >= 0) systemNotice('没找到官方 DeepSeek Harness，安装后我才能派活哦～', 7000, 'ui')
    } catch (e) { /* ignore */ }
  }, 9000)
  // 商店分类切换（用独立常量，避免数组字面量在语句位置被解析歧义）
  var SHOP_CATS = ['all', 'meal', 'drink', 'gift', 'fun']
  SHOP_CATS.forEach(function (cat) {
    var btn = $('shop-cat-' + cat)
    if (btn) btn.addEventListener('click', function () { switchShopCat(cat) })
  })
  snakeReset()
  tReset()
  // 注意：依赖 P 的面板（状态条/待办/日程/番茄钟/设置页/喝水按钮/工作解锁等）
  // 不在此处渲染——此时 P 还是默认值，会显示"没保存"假象；
  // 统一在 loadState().then → refreshAllUI() 里刷新。
  updateFocusClock() // 只读 focus 内存态，可提前渲染
  guessReset()
  tttReset()
  btnSend.disabled = true
  poll()
  console.log('deskpet renderer booted')

  /* CLEAN-STRIP:BEGIN test */
  /* ---------- 自动验证钩子（verify-visual.js 用；控制状态/模拟鼠标/读取 UI） ---------- */

  const legacyPetTest = {
    presentContactTest: async ({ id, candidateId, opening, ts }) => { await window.PetLife.presented({ instanceId: id, candidateId, opening, ts, form: 'question' }); await proactiveShowCard(opening, id); return true },
    setMood: (m, ms) => setMood(m, ms),
    playAnim: (mood) => playAnim(mood),
    getAnim: () => currentAnimName,
    getBubbleOwner: () => bubbleOwner,
    getChatBusy: () => chatBusy,
    getAnimationTransitions: () => animTransitionLog.slice(),
    getBubbleSeq: () => bubbleSeq,
    getRandomTimerState: () => ({ active: !!lineTimer, characterChatActiveCount }),
    resetRandomSchedulerTest: () => { characterChatActiveCount = 0; cancelRandomTimer(); scheduleNextLine(); return true },
    startChatLifecycleTest: () => { const t = beginBubble('character-chat'); if (!t) return null; characterChatActiveCount++; cancelRandomTimer(); return t },
    endChatLifecycleTest: (token) => { if (token) endBubble(token); finishCharacterChat(); return true },
    beginBubble: (owner) => beginBubble(owner),
    endBubble: (token) => endBubble(token),
    bubbleTokenValid: (token) => bubbleTokenValid(token),
    bubbleCanWrite: (source) => bubbleCanWrite(source),
    wakeUpTest: () => wakeUp(),
    sleepNowTest: () => sleepNow(),
    // 直接触发任意动画（走 showAnim/fitAnim 完整路径，CDP 截图验证用；不影响业务状态）
    showAnim: (name, lockMs) => { currentAnimName = null; showAnim(name, lockMs || 12000) },
    // 模拟鼠标位置（与真实 mousemove 走同一判定路径）
    setMouse: (x, y) => { ctX = x; ctY = y; syncClickThrough() },
    getHover: () => stage.classList.contains('dp-hover'),
    getClickThrough: () => clickThrough,
    getVolumeUI: () => $('volume-range') ? $('volume-range').value : null,
    getVolumeState: () => P.soundVolume,
    getState: () => ({ mood: R.mood, chatOpen: R.chatOpen, running: R.running, dragging: R.dragging, sleepy: R.sleepy }),
    stateSnapshot: () => PetStateApi.snapshot(),
    devStats: () => window.DevStats ? window.DevStats.getStats() : null,
    runtimeDiagnostics: () => window.RuntimeDiagnostics.get(),
    /* CC-3 / P0：心跳健康出口（只读）。ticks＝心跳拍数；stepsOk＝步成功计数；failures＝按步名聚合的失败计数。
       "期望清单"式的"应有哪几步"由本对象的 4 个 step 名与上方的 4 处包装共同定义（对照 MaiBot 的
       AsyncTaskManager：它把死任务从 dict 摘掉 ⇒ 状态查询看不见死亡，我们不做那种"看不见"的设计）。 */
    heartbeatHealth: () => ({ ticks: __beatGuard.ticks, stepsOk: __beatGuard.stepsOk, failures: Object.assign({}, __beatGuard.failures) }),
    dshMockSet: (mode) => window.DSHClient.setMockMode(mode),
    openChat: () => openChat(),
    sendWorkTest: async (text) => { const ta = $('chat-input'); if (ta && text !== undefined) ta.value = text; return sendChat() },
    startWorkTest: (id) => startWork(id),
    getPresenceRuntimeLog: () => presenceRuntimeLog.slice(),
    clearPresenceRuntimeLog: () => { presenceRuntimeLog.length = 0 },
    finishWorkTest: () => finishWorkUI(),
    getBubbleText: () => bubbleEl ? bubbleEl.textContent : '',
    hideReportTest: () => { hideReport(); bubbleEl.dataset.report = ''; bubbleEl.classList.remove('dp-bubble-report'); bubbleEl.textContent = '' },
    setBusyTest: (v) => { R.busy = !!v; updateStatusUI() },
    setMiniChatBusyTest: (v) => { chatBusy = !!v },
    setGameBusyTest: (v) => { if (game) game.playing = !!v },
    getWorkState: () => ({ busy: !!R.busy, running: !!R.running, input: $('chat-input') ? $('chat-input').value : null, disabled: !!btnSend.disabled, workId: R.workId || null, workEnd: R.workEnd || 0, resting: restUntil > Date.now() }),
    setRestTest: (minutes) => { if (restTimer) { clearInterval(restTimer); restTimer = null }; const m = Number(minutes) || 10; restUntil = Date.now() + m * 60000; restEndAt = restUntil; return true },
    clearRestTest: () => { if (restTimer) { clearInterval(restTimer); restTimer = null }; restUntil = 0; restEndAt = 0; setMood('idle'); return true },
    resetWorkState: () => { clearBusyTimeout(); R.busy = false; R.running = false; btnSend.disabled = false; updateStatusUI() },
    showReportTest: (summary, full) => showReport(summary || '', full || ''),
    getReportTest: () => ({ visible: !!document.querySelector('.dp-bubble-report'), title: document.querySelector('.dp-bubble-report-title') ? document.querySelector('.dp-bubble-report-title').textContent : '' }),
    closeChat: () => closeChat(),
    say: (t, ms, source, token) => say(t, ms, source, token),
    sayBeatsTest: (beats, token) => sayBeats(beats, token),
    /* ---------- 测试辅助：调用真实事件路径（用于验证照片解锁挂点；不影响业务） ---------- */
    // 喂食（商店 cookie 路径：useItem）
    useItemTest: (key) => { if (P.inventory[key] > 0) useItem(key); else { P.inventory[key] = 1; useItem(key) } },
    // 备忘录
    addMemoTest: (text) => addMemo(text),
    // 猜数字胜利（直接把 target 设为当前输入并提交）
    guessWinTest: () => { guess.target = 42; const inp = $('guess-input'); inp.value = '42'; guessSubmit() },
    // 五子棋胜利（玩家黑胜）
    gomokuWinTest: () => gomokuFinish('black'),
    // 数独胜利（直接调 sudokuWin）
    sudokuWinTest: () => sudokuWin(),
    // 贪吃蛇 30 分（设 score 后正常结算）
    snake30Test: () => { snake.score = 30; snake.playing = true; endSnake(true) },
    // 2048 合出 512（把最大格设 512 后检查）
    t2048Test: () => { t2048.grid[0][0] = 512; checkTEnd() },
    // 任意分数验证：返回值含前后对比（提前解锁回归测试用）
    t2048ScoreTest: (v) => {
      const before = { photos: Object.keys(P.photos), wins: P.gameWins.slice() }
      t2048.grid = Array.from({ length: t2048.size }, (_, r) => Array.from({ length: t2048.size }, (_, c) => (r === 0 && c === 0 ? v : 0)))
      checkTEnd()
      return { before, after: { photos: Object.keys(P.photos), wins: P.gameWins.slice() } }
    },
    snakeScoreTest: (v) => {
      const before = { photos: Object.keys(P.photos), wins: P.gameWins.slice() }
      snake.score = v; snake.playing = true; endSnake(true)
      return { before, after: { photos: Object.keys(P.photos), wins: P.gameWins.slice() } }
    },
    // 工作结算（30 分钟任务完成，触发 first-day/hard-coding）
    workTest: (minutes) => { const job = WORK_JOBS[0]; settleWork(job, 10, minutes || 5, false) },
    // 好感升档（+15 强制跨档）
    affectionUpTest: () => { P.affection = Math.min(100, Math.max(0, 74)); addAffection(10) },
    // 日记
    diaryTest: () => { P.diary = []; R.lastDiaryDate = ''; R.writingDiary = false; diaryWriteInFlight.clear(); return writeDiary(true) },
    diaryInFlight: () => ({ inFlight: diaryWriteInFlight.size > 0, days: Array.from(diaryWriteInFlight.keys()), writingDiary: !!R.writingDiary, engine: window.DiaryEngine && typeof window.DiaryEngine.getDiagnostics === 'function' ? window.DiaryEngine.getDiagnostics().inFlightCount : null }),
    renderDiaryTest: () => renderDiary(),
    // 被夸（sendChat 关键词检测路径）
    praisedTest: () => { const old = window.pet.api; window.pet.api = async () => ({ result: { ok: true, value: {} } }); try { const ta0 = $('mini-chat-input'); return 'sendChat 需真实 api，改用关键词函数'; } finally { window.pet.api = old } },
    // 连点计数直接触发（复用 endDrag 里的逻辑）
    clickCountTest: (n) => { P._lastClickTs = Date.now() - 100; P._clickCount = n; if (n >= 5) unlockPhoto('shy-whale'); else if (n >= 3) unlockPhoto('tsundere-3') },
    // 喝水已喝（tea-serve 路径）
    waterDrinkTest: () => { clearReminderCard(); const t = dayKey(new Date()); P.waterToday = (P.waterDay === t ? P.waterToday : 0) + 1; P.waterDay = t; P.stats.mood = clamp(P.stats.mood + 2, 0, 100); gainExp(2); saveState(); renderCare(); unlockPhoto('tea-serve') },
    // 当前照片
    getPhotos: () => ({ photos: P.photos, count: Object.keys(P.photos).length }),
    /* ---------- 测试辅助：状态注入 + 扫描（模拟 check 型达到条件） ---------- */
    // 达到数值条件后手动扫描（模拟 checkPhotoUnlocks 主循环行为）
    setFieldTest: (field, val) => { P[field] = val; checkPhotoUnlocks(); saveState() },
    setStatTest: (stat, val) => { P.stats[stat] = val; renderCare(); checkPhotoUnlocks(); saveState() },
    setPhotosTest: (id, tsVal) => { P.photos[id] = { ts: tsVal || Date.now() }; saveState() },
    // 直接扫描
    scanTest: () => { checkPhotoUnlocks(); saveState() },
    // 生日模拟（owner-birthday / pet-birthday）
    birthdayTest: (who) => {
      if (who === 'owner') { const now = new Date(); P.ownerBirthday = (now.getMonth() + 1) + '-' + (now.getDate() < 10 ? '0' + now.getDate() : now.getDate()); P.lastBirthdayGreeted = ''; }
      else { P.lastPetBirthdayGreeted = ''; }
      checkPetBirthday()
      // 模拟当天逻辑（直接触发分支）
      const today = dayKey(new Date())
      const now = new Date()
      if (who === 'owner') {
        P.lastBirthdayGreeted = today
        P.coins += 30; P.stats.mood = clamp(P.stats.mood + 10, 0, 100); addAffection(5)
        saveState(); renderCare(); updateCoins()
        unlockPhoto('owner-birthday')
      } else {
        P.lastPetBirthdayGreeted = today
        P.stats.mood = clamp(P.stats.mood + 15, 0, 100); P.stats.energy = clamp(P.stats.energy + 10, 0, 100); addAffection(5); P.coins += 20
        saveState(); renderCare(); updateCoins()
        unlockPhoto('pet-birthday')
      }
    },
    // 学期开始（school-start）
    schoolStartTest: () => { P.semesterStart = dayKey(new Date()); saveState(); unlockPhoto('school-start') },
    // 每日任务全完成（daily-summary）：走真实 markDaily 路径（ensureDaily 重置后依次完成）
    dailyAllTest: () => { P.daily = { date: '2000-01-01', tasks: [], signStreak: 0, lastSign: '' }; saveState(); markDaily('chat'); markDaily('game'); markDaily('work'); },
  }
  // Expose diagnostics only. No raw state setter or publisher survives Runtime takeover.
  window.__petTest = Object.freeze({ getState: () => JSON.parse(JSON.stringify(P)), heartbeatHealth: legacyPetTest.heartbeatHealth,
    runtimeSnapshot: () => roleRuntime.snapshot(), getAnim: legacyPetTest.getAnim })
  /* CLEAN-STRIP:END test */
/* ---------- F5-B：Life Context 接线（纯追加；只提交输入 + 缓存能力投影，不做 I/O、不对外开口） ---------- */
let lifeContextCapabilities = null // 最近一次主进程返回的 F5 能力投影（每轮现取；不落盘、不缓存到磁盘）
let lifeContextExpressible = null // F6-B 只读镜像：最近一次 tick 给的 F6-A 结果（**镜像，不是第二份状态**）
let lifeContextExpressibleAt = 0 // 该镜像的落地时刻（用于 ≤1 heartbeat 时效闸）
/* P3-C1：Reality 只读镜像（只搬运，不采集、不推断、不落盘）。
   · 当前前台应用取自**已有**的 perception 状态（P.perceptionState.vision），是实时值 ⇒ **不受最近活动的时效闸限制**；
   · 最近活动取自 runLifeContextTick **已返回**的 reality（timeline 段落快照）⇒ 有自己的时效闸。 */
let lifeContextReality = null // 最近一次 tick 返回的 {asOfTs, segments:[{cat,startTs,endTs,minutes}]}
let lifeContextRealityAt = 0  // 该快照的落地时刻
const LIFE_REALITY_MAX_LAG_MS = 10 * 60 * 1000 // 最近活动允许的最大滞后（tick 每 60s 一次；超时即视为陈旧、不注入）
/* P3-C2-F1：经历只读镜像（只搬运，不采集、不推断、不落盘）。
   Experience 是"已经发生过的事" ⇒ **不做时间失效**（与 Reality 的 10 分钟闸语义相反）；条数上限由主进程裁决。 */
let lifeContextExperiences = null // 最近一次 tick 返回的 {asOfTs, items:[{eventId,kind,category,ts,text}], count}

function lifeContextIntentContext() {
  const snap = window.CharacterSnapshot && typeof window.CharacterSnapshot.toCharacterContext === 'function' ? window.CharacterSnapshot.toCharacterContext() : null
  return Object.assign({}, snap || {}, {
    lastInteractionAt: P.lastInteractionAt || 0,
    pet: { lastInteractionAt: P.lastInteractionAt || 0 },
    busy: !!R.busy,
    chatBusy: !!chatBusy,
    chatOpen: !!R.chatOpen,
    workId: R.workId || null,
    resting: restUntil > Date.now(),
    gamePlaying: !!(game && game.playing),
    userTyping: document.activeElement === $('chat-input')
  })
}

function lifeContextTickPayload() {
  const pc = (P && P.perceptionConfig) || {}
  const hearing = pc.sensors && pc.sensors.hearing ? pc.sensors.hearing : {}
  let pool = []
  try {
    if (window.IntentEngine && typeof window.IntentEngine.selectAutonomous === 'function') {
      const r = window.IntentEngine.selectAutonomous(lifeContextIntentContext(), { nowTs: Date.now() })
      pool = (r && Array.isArray(r.pool)) ? r.pool : []
    }
  } catch (err) { pool = [] }
  let identityKind = null
  try {
    if (window.PersonaCore && typeof window.PersonaCore.getCore === 'function') {
      const b = window.PersonaCore.getCore().selfAwarenessBoundary || {}
      identityKind = b.selfIdentity || null
    }
  } catch (err) { identityKind = null }
  return {
    pool: pool,
    static: { identityKind: identityKind },
    runtime: {
      perceptionEnabled: typeof pc.enabled === 'boolean' ? pc.enabled : null,
      hearingEnabled: typeof hearing.enabled === 'boolean' ? hearing.enabled : null,
      diaryEnabled: typeof diaryOn === 'boolean' ? diaryOn : null,
      localChatEnabled: true,
      remoteBridgeEnabled: null,
      remoteTunnelEnabled: null
    },
    // ownerApprovalRequired=true 是**代码事实**（main.js 的 /api/pending 只读 + 写方法 405）；会话权限本轮不取（unknown）
    permission: { ownerApprovalRequired: true, sessions: null },
    events: [], // F2 事件规则的上游（事件流 tap）尚未接线 ⇒ 目前只有"采纳意义"这一路（已登记）
    gates: { ownerBusy: false, politenessDefer: false },
    dutyEvidence: []
  }
}

/* ===== P0-1 第二批（C3）：全局发言节奏器 =====
   连续聊天发言（主动开场/角色回复）≥3 次而主人一句话都没插 ⇒
   随机台词与主动呈现暂停，直到主人再次开口（任何角色面输入/点卡都算）。纯内存计数，
   不落盘、不是第二套频率参数（interval ladder/cap 归 F7 不动）；呈现闸的丢弃进 A8 no-present 对账。 */
/* PACE-START */
const Pace = {
  n: 0,
  ambientN: 0,
  LIMIT: 3,
  onAssistant() { this.n++ },
  onAmbient() { this.ambientN++ },
  onUser() { this.n = 0; this.ambientN = 0 },
  blocked() { return this.n >= this.LIMIT },
  // Ambient chatter has its own limit and must never prevent the first contact.
  ambientBlocked() { return this.blocked() || this.ambientN >= this.LIMIT },
  status() { return this.n + '/' + this.LIMIT },
}
/* PACE-END */
/* Writes await fresh data; the synchronous API remains available for inspection. */
function refreshDiaryTimeline() {
  if (__diaryTLJob) return __diaryTLJob
  __diaryTLJob = Promise.resolve().then(() => window.pet.diaryTimeline()).then(t => {
    __diaryTLCache = t && typeof t === 'object' ? t : null
    return __diaryTLCache
  }).catch(() => { __diaryTLCache = null; return null }).finally(() => { __diaryTLJob = null })
  return __diaryTLJob
}
function lifeContextTickOnce() {
  try {
    const p = window.pet
    if (!p || typeof p.lifeContextTick !== 'function') return
    const payload = lifeContextTickPayload()
    payload.runtime = Object.assign({}, payload.runtime, { characterRuntime: true })
    Promise.resolve(p.lifeContextTick(payload)).then(async (r) => {
      if (r && r.ok === false && !r.skipped) { try { console.warn('[life-context] tick failed:', r.reason || '-') } catch (e) {} }
      if (r && r.capabilities) lifeContextCapabilities = r.capabilities
      // F6-B：只读镜像（tick 给什么就镜像什么；没给就明确标记不可用，绝不自己推演）
      lifeContextExpressible = (r && r.expressible) ? r.expressible : null
      lifeContextExpressibleAt = Date.now()
      /* P3-C1：Reality 只读镜像（tick 给什么就镜像什么；没给就置 null，绝不自己推演） */
      lifeContextReality = (r && r.reality) ? r.reality : null
      lifeContextRealityAt = Date.now()
      /* P3-C2-F1：经历只读镜像（tick 给什么就镜像什么；没给就置 null，绝不自己推演） */
      lifeContextExperiences = (r && r.experiences) ? r.experiences : null
      /* S-6（Shadow Mode）：把本轮 F4 结果并入只读观测记录并落日志；只读 r，不改 r、不参与任何判定 */
      try { ShadowInternalLife.observe(r, Date.now()) } catch (e) { /* 观测不得影响主循环 */ }
      await window.PetLife.tick(runtimeLifeInput())
      const living = window.PetLife.context(Date.now())
      for (const activity of living.activities) if (activity.status !== 'active' && activity.runtimeContinuation) roleRuntime.completeContinuation(activity.runtimeContinuation)
      updateMood(); renderLivingNotebook()
      proactiveAfterTick(r)
    }).catch(() => { /* 单轮失败不影响主循环 */ })
  } catch (err) { /* 单轮失败不影响主循环 */ }
}

/* H4（A1）取数口：把 F5 能力投影映射成既有四个名字（weather/web/screen/browser）。
   没有对应能力的（browser）恒 unavailable；没有投影时**逐字回落到改造前的四项 unavailable**。 */
function lifeContextCapabilityStatusMap() {
  const out = { weather: 'unavailable', web: 'unavailable', screen: 'unavailable', browser: 'unavailable' }
  const proj = lifeContextCapabilities
  const items = (proj && Array.isArray(proj.items)) ? proj.items : []
  const byId = {}
  items.forEach((it) => { if (it && it.id) byId[it.id] = it.status })
  const map = { weather: 'net.query-weather', web: 'net.web-search', screen: 'see.screen-content' }
  Object.keys(map).forEach((k) => { const s = byId[map[k]]; if (typeof s === 'string') out[k] = s })
  return out
}
try { window.lifeContextCapabilityStatusMap = lifeContextCapabilityStatusMap } catch (err) { /* ignore */ }

/* ===== F7-B：主动联系载体（桌边提醒卡 + 专用主动聊天面板）=====
   边界（施工单 §6/§7 + 用户 2026-09-20 圈定「b」）：
     · **不拥有任何选择权**：只有后端（F4→F7）已选中 seek_attention 且开关/闸门放行（tick 返回 canPresent）时才呈现；
     · **正文来源（S5 更新）**：先问 `AIGateway.proactiveTopic`（AI 只决定"这次怎么说"，≤60 字、必须提问/邀请）；
       失败/不合格 ⇒ fallback 到 F6-A `expressible.text`；两者皆空 ⇒ **不展示、不 present、不 spend**；
       卡片本身只显示固定钩子文案「小深想和你说点什么」，真正的开场在点击后进主聊天窗（S4）。
     · 四状态严格分离并**逐个上报**：present / view / reply / supersede —— 一律经主进程 IPC 走既有原子提交路径；
     · 样式一律**内联**（不改 pet.css / index.html）；建卡沿用 showPhotoCard() 的动态范式；
     · 四阶段语义：choice(F4) ≠ presented(真渲染出来) ≠ initiated(上报成功且主进程提交) ≠ replied(用户在专用面板回话)。 */
let proactiveCardEl = null
let proactiveCardBody = null
let proactiveFocusId = null      // 最近一次「已呈现」的实例 id（view/reply 都以它为对象）
let proactiveCardText = ''
let proactiveOn = false              // S3：开关镜像（真值在主进程 pet-prefs）
let proactiveOpeningText = ''        // S5：本次真正要说的话（AI 生成或 F6-A fallback）
let proactiveOpeningAppendedFor = null   // S4：同 instance 只往 history 追加一次（防重复）
let proactiveOpeningPendingFor = null
let proactiveAwaitingReply = null    // S6：等她回应的实例 { id, presentedAt }
/* PC-3：**被否证／没兴趣就降温**——主人回的是否定/别再问这类话时，
   把「活动分钟数」这一族素材（tl:segment:* 载体）整体降温 6 小时，避免她换个数字接着问同一模板。
   触发条件保守：①必须是在回应主动开场（有 awaitingReply）②回复文本命中否定词 ③上次开口用的确实是 tl:segment 载体。 */
let proactiveFamilyCool = null
const PROACTIVE_DISINTEREST_RE = /(没什么|没有啊|没有|没在|没动|不是|并没有|别问|不想说|算了|就是开着|随便|不用管|没事)/
function noteOwnerReplyToProactive(userText) {
  try {
    if (!proactiveAwaitingReply || !proactiveAwaitingReply.id) return null   /* 只在回应主动开场时判读 */
    const surf = (window.ShadowInternalLife && typeof window.ShadowInternalLife.getLastSurfaced === 'function') ? window.ShadowInternalLife.getLastSurfaced() : null
    if (!surf || !surf.memoryId) return null
    if (!/^tl:segment:/.test(String(surf.memoryId))) return null
    if (!PROACTIVE_DISINTEREST_RE.test(String(userText || ''))) return null
    proactiveFamilyCool = { at: Date.now(), until: Date.now() + 6 * 60 * 60 * 1000, marker: 'tl:segment:', why: 'owner-disinterest' }
    try { console.log('[proactive] family-cool', '6h', 'why=owner-disinterest', 'reply=' + String(userText || '').slice(0, 24)) } catch (e) { /* ignore */ }
    return proactiveFamilyCool
  } catch (err) { return null }
}
/* R-11 B：她真实开过的口（只读、内存内、上限 5）；用于让"我先开口说的那句"在后续 Chat 里可见。
   不落盘、不进 memories、不构成第二套会话状态。 */
let proactiveOpeningLog = []
let proactivePanelEl = null
let proactivePanelListEl = null
let proactivePanelInputEl = null
function proactiveEl(tag, styles, text) {
  const el = document.createElement(tag)
  if (styles) Object.keys(styles).forEach((k) => { el.style[k] = styles[k] })
  if (text !== undefined && text !== null) el.textContent = String(text)
  return el
}
/* 四状态上报（唯一出口）：拿不到回执就如实记日志，绝不伪造「已执行」。 */
function proactiveReport(payload) {
  try {
    const p = window.pet
    if (!p || typeof p.proactiveEvent !== 'function') return Promise.resolve({ ok: false, reason: 'no-bridge' })
    return Promise.resolve(p.proactiveEvent(payload)).then((r) => {
      if (!r || r.ok !== true) { try { console.warn('[proactive] 上报未确认:', (r && r.reason) || '-') } catch (e) {} }
      return r || { ok: false, reason: 'no-result' }
    }).catch(() => ({ ok: false, reason: 'invoke-failed' }))
  } catch (err) { return Promise.resolve({ ok: false, reason: 'throw' }) }
}
function ensureProactiveCard() {
  if (proactiveCardEl && proactiveCardEl.parentNode) return proactiveCardEl
  /* （A 方案 + 顶部条带）：①加 id 并登记进 CT_INTERACTIVE（否则点不动 —— 真机
     实测 hover 卡片时窗口切回穿透）；②位置由 `right/bottom`（压住人物框 24.6% 面积）改为窗口**顶部条带**：
     真机实测窗口 220×380、气泡占 y102–160、人物占 y174+、动作列 x15–45 ⇒ **只有 y0–102 是真空白**。 */
  const card = proactiveEl('div', { position: 'absolute', left: '12px', right: '12px', top: '8px', padding: '10px 12px', borderRadius: '12px', background: 'rgba(28,34,48,0.94)', color: '#e8eefc', font: '13px/1.5 system-ui, sans-serif', boxShadow: '0 6px 18px rgba(0,0,0,0.28)', cursor: 'pointer', zIndex: '40', display: 'none' })
  card.id = 'proactive-card'
  const body = proactiveEl('div', { whiteSpace: 'pre-wrap' }, '')
  body.setAttribute('data-role', 'proactive-body')
  card.appendChild(body)
  card.addEventListener('click', () => { proactiveOnCardClick() })
  petArea.appendChild(card)
  proactiveCardEl = card
  proactiveCardBody = body
  return card
}
async function persistProactiveOpening(text, instanceId, execution) {
  execution.assertCurrent()
  const entry = { role: 'assistant', text: String(text || ''), selfInitiated: true }
  if (instanceId) entry.messageRef = 'proactive:' + instanceId
  const saved = await execution.commit(() => window.pet.characterHistoryAppend(entry))
  execution.assertCurrent()
  if (!saved || saved.ok !== true) throw new Error('history_write_failed')
  if (instanceId) proactiveOpeningAppendedFor = instanceId
}
async function proactiveShowCard(text, instanceId, execution) {
  if (!roleRuntime.isAuthorized(execution)) return { ok: false, reason: "runtime_authorization_required" }
  const card = ensureProactiveCard()
  /* 最终文本在展示时进入统一历史，普通输入和重启后的追问均可读取。
     同一实例的展示/点击共用稳定 messageRef，由存储层幂等去重。 */
  await persistProactiveOpening(text, instanceId, execution)
  execution.assertCurrent()
  return execution.publish(() => {
  /* The owner can see what she wants to say without opening the chat panel. */
  if (proactiveCardBody) {
    proactiveCardBody.textContent = String(text || '')
    Object.assign(proactiveCardBody.style, { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: '2', overflow: 'hidden' })
  }
  card.style.display = 'block'
  proactiveCardText = String(text || '')
  proactiveOpeningText = String(text || '')
  /* R-11 B：记下"她真实开过的口"（供后续 Chat 把这条 assistant-only 开场锚点保留；上限 5 条） */
  try {
    const t = String(text || '').trim()
    if (t && proactiveOpeningLog.indexOf(t) < 0) { proactiveOpeningLog.push(t); if (proactiveOpeningLog.length > 5) proactiveOpeningLog = proactiveOpeningLog.slice(-5) }
  } catch (err) { /* 记录失败不影响呈现 */ }
  proactiveFocusId = instanceId || null
  return { ok: true, displayed: "card" }
  })
}
function proactiveHideCard() { if (proactiveCardEl) proactiveCardEl.style.display = 'none' }
/* S3/S4：点击卡片 ⇒ 进**主聊天窗**（聊天功能只存在一套＝Character Chat）。
   · 上报 view（状态 ②）；
   · 开场已在展示时存档，点击只重读历史（同 instance 不重复）；
   · 主聊天窗显示这条开场；
   · 记下"正在等她回这句"的实例（S6：回复成功后上报 reply ＋ 写 P1_proactive_talk 经历）。
   专用面板不再作为主要载体（代码保留，仅历史查看用）。 */
async function proactiveOnCardClick() {
  Pace.onUser() /* P0-1 第二批：主人点卡＝注意 ⇒ 连发计数复位 */
  const id = proactiveFocusId
  const opening = proactiveOpeningText || proactiveCardText
  if (id && proactiveOpeningPendingFor === id) return
  proactiveHideCard()
  if (id) proactiveReport({ type: 'view', id: id, nowTs: Date.now() })
  try { if (id) console.log('[proactive] view', id) } catch (e) { /* ignore */ }
  /* B：打开面板并**切到角色聊天 tab**（原来只 openChat ⇒ 落到 DSH 派活面，
     用户真机反馈「跳到了"聊天"面板，但那个面板实际是派活面板，她说的话没出现」）。 */
  try { openChat() } catch (err) { /* 窗口失败不影响已落 history 的开场 */ }
  try { switchTab('charc') } catch (err) { /* 切页失败不影响已落 history 的开场 */ }
  try { const ci = $('charc-input'); if (ci) ci.focus() } catch (err) { /* 聚焦失败可忽略 */ }
  if (!opening) return
  if (id) proactiveOpeningPendingFor = id
  /* P0-1d：真实主动开场结构化落盘 selfInitiated——主进程窗口锚点判据用（C5 根因=文本标记从不落盘） */
  try {
    // The displayed opening was already durably committed by its Runtime execution.
    await renderCharc(true)
  } catch (err) {
    if (proactiveFocusId === id && proactiveCardEl) proactiveCardEl.style.display = 'block'
    say('开场没能保存，请再点一次卡片重试～', 6000, 'ui')
    return
  } finally { if (proactiveOpeningPendingFor === id) proactiveOpeningPendingFor = null }
  Pace.onAssistant()
  // Opening an existing history entry is display, not a second character publication.
  proactiveAwaitingReply = id ? { id: id, presentedAt: Date.now(), explicit: false } : null
}
function ensureProactivePanel() {
  if (proactivePanelEl && proactivePanelEl.parentNode) return proactivePanelEl
  /* 同 A 方案：面板也加 id、登记白名单，并移到顶部条带；宽度改由 `left/right` 双约束随窗口
     （原写死 `width:284px` > 窗口 220 ⇒ 必被裁；盒子自带 12px padding，内容宽自动收窄）。 */
  const wrap = proactiveEl('div', { position: 'absolute', left: '12px', right: '12px', top: '8px', padding: '12px', borderRadius: '12px', background: 'rgba(22,27,38,0.97)', color: '#e8eefc', font: '13px/1.5 system-ui, sans-serif', boxShadow: '0 10px 26px rgba(0,0,0,0.35)', zIndex: '45', display: 'none' })
  wrap.id = 'proactive-panel'
  const head = proactiveEl('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' })
  head.appendChild(proactiveEl('div', { fontSize: '12px', opacity: '0.8' }, petName() + '主动联系'))
  const close = proactiveEl('div', { cursor: 'pointer', opacity: '0.7', padding: '0 4px' }, '✕')
  close.addEventListener('click', () => { wrap.style.display = 'none' })
  head.appendChild(close)
  const list = proactiveEl('div', { maxHeight: '180px', overflowY: 'auto', marginBottom: '8px' })
  const input = proactiveEl('input', { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)', color: '#e8eefc', outline: 'none' })
  input.setAttribute('placeholder', '回她一句…')
  const send = proactiveEl('div', { marginTop: '8px', textAlign: 'center', padding: '6px 0', borderRadius: '8px', background: 'rgba(120,170,255,0.25)', cursor: 'pointer' }, '发送')
  send.addEventListener('click', () => { proactiveOnReply() })
  input.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') proactiveOnReply() })
  wrap.appendChild(head); wrap.appendChild(list); wrap.appendChild(input); wrap.appendChild(send)
  petArea.appendChild(wrap)
  proactivePanelEl = wrap
  proactivePanelListEl = list
  proactivePanelInputEl = input
  return wrap
}
function proactivePanelAdd(who, text) {
  return { ok: false, reason: "runtime_owned" }
  const listEl = ensureProactivePanel() && proactivePanelListEl
  if (!listEl) return
  const line = proactiveEl('div', { margin: '4px 0', opacity: who === '我' ? '0.95' : '0.85' }, (who === '我' ? '我：' : '小深：') + String(text || ''))
  listEl.appendChild(line)
  listEl.scrollTop = listEl.scrollHeight
}
function proactiveOpenPanel(text) {
  return { ok: false, reason: "runtime_owned" }
  const wrap = ensureProactivePanel()
  if (text) proactivePanelAdd('她', text)
  wrap.style.display = 'block'
  if (proactivePanelInputEl) proactivePanelInputEl.value = ''
  proactiveHideCard()
}
/* 用户在专用面板回话：状态 ③ replied。**只本地回显**——不写任何持久层、不进 Chat 主链路、不调 AI。 */
function proactiveOnReply() {
  const input = proactivePanelInputEl
  const text = (input && typeof input.value === 'string') ? input.value.trim() : ''
  if (!text) return
  const id = proactiveFocusId
  proactivePanelAdd('我', text)
  if (input) input.value = ''
  if (id) proactiveReport({ type: 'reply', id: id, nowTs: Date.now() })
  try { if (id) console.log('[proactive] reply', id, 'via=panel') } catch (e) { /* ignore */ }
  proactiveFocusId = null
  proactiveCardText = ''
}
/* S5：主动话题的**输入白名单**（只读既有投影/上下文；不在名单里的字段一律不传）。
   禁止注入：窗口标题 / URL / 页面正文 / 键盘输入 / 原始 timeline / segment 数组 / 其它会话内容 / 额度数字。 */
function proactiveTopicContext() {
  const out = {}
  try {
    const cs = window.CharacterSnapshot
    const c = (cs && typeof cs.toCharacterAIContext === 'function') ? cs.toCharacterAIContext('') : null
    if (c) { out.emotion = c.emotion || null; out.relationship = c.relationship || null; out.personaProjection = c.personaProjection || null }
  } catch (err) { /* ignore */ }
  try { if (typeof window.lifeRealityForPrompt === 'function') out.reality = window.lifeRealityForPrompt() } catch (err) { /* ignore */ }
  try { if (typeof window.lifeExpressionForPrompt === 'function') out.expression = window.lifeExpressionForPrompt() } catch (err) { /* ignore */ }
  try { if (Array.isArray(lifeContextExperiences)) out.experiences = lifeContextExperiences.slice(0, 3) } catch (err) { /* ignore */ }
  try {
    if (window.PersonaCore && typeof window.PersonaCore.project === 'function') {
      const pc = window.PersonaCore.project({ scale: 'short_social' })
      out.personaCore = (typeof pc === 'string') ? pc : ''
    }
  } catch (err) { /* ignore */ }
  return out
}
/* ===== 角色聊天 Tab=====
   数据源＝既有角色聊天存储（`character-chat-history.json`，与迷你输入**同一份**，不新建第二套历史）；
   AI 路径＝共用 `characterChatRequest`（＝既有角色通道那唯一调用点，**不新增 AI 调用点**）；
   呈现＝面板内滚动列表（受限高度、可读更早记录，消息用 textContent）；
   边界：本区块绝不引用 sessionCommand / sendChat / R.currentId（那三个属 DSH 派活面）。 */
let charcBusy = false
let characterUiExecutionId = null
let charcRenderVersion = 0
let charcVisibleLimit = 40
let characterRetryTurn = null
let latestCharacterTurnRef = null
async function prepareCharacterTurn(text, execution) {
  execution.assertCurrent()
  if (!characterRetryTurn || characterRetryTurn.text !== text) characterRetryTurn = { text, userSaved: false, reply: null }
  if (!characterRetryTurn.userSaved) {
    if (!characterRetryTurn.messageRef) characterRetryTurn.messageRef = window.MemoryMessageRef.next()
    latestCharacterTurnRef = characterRetryTurn.messageRef
    const saved = await window.pet.characterHistoryAppend({ role: 'user', text, messageRef: characterRetryTurn.messageRef })
    if (!saved || saved.ok !== true) throw new Error('history_write_failed')
    characterRetryTurn.userSaved = true
    refreshCharacterHistoryViews()
    if (typeof diaryEvent === 'function') diaryEvent('chat', text, { source: 'char-chat' })
  }
  const history = await window.pet.characterHistoryLoad()
  if (!Array.isArray(history)) throw new Error('history_load_failed')
  if (window.PlatformCandidate && window.PlatformCandidate.enabled && window.pet.platform) window.PlatformContext = await window.pet.platform.projection()
  execution.assertCurrent()
  const pendingInputs = new Set(roleRuntime.snapshot().queued.map(item => item.inputId))
  const currentRef = characterRetryTurn && characterRetryTurn.messageRef
  const prior = history.filter(row => row.messageRef !== currentRef && !(row.role === 'user' && pendingInputs.has(row.messageRef)))
  const currentInput = history.find(row => row.messageRef === currentRef)
  return currentInput ? prior.concat(currentInput) : prior
}
async function persistCharacterReply(text, reply, execution) {
  execution.assertCurrent()
  const turn = characterRetryTurn && characterRetryTurn.text === text ? { ...characterRetryTurn } : null
  if (characterRetryTurn && characterRetryTurn.text === text) characterRetryTurn.reply = reply
  const finalText = String(reply.text || '').replace(/^\[PRAISED\]\s*/, '')
  const saved = await execution.commit(() => window.pet.characterHistoryAppend({ role: 'assistant', text: finalText, messageRef: 'reply:' + (turn && turn.messageRef || execution.executionId) }))
  execution.assertCurrent()
  if (!saved || saved.ok !== true) throw new Error('history_write_failed')
  // Only a durably saved reply can create a continuous conversational memory.
  refreshCharacterHistoryViews()
  try {
    if (window.PetLife && turn && turn.messageRef) {
      const messageRef = turn.messageRef
      const source = await window.pet.characterHistorySource(messageRef)
      if (!source || source.text !== text) throw Error('history_source_invalid')
      const ts = source.ts
      await window.PetLife.recordTurn({
      runtimeExecution: execution, userText: text, assistantText: finalText, memory: reply.continuityMemory || null,
      messageRef, ts,
      replyTo: reply.conversation && reply.conversation.replyTo,
      conversation: reply.conversation || null
      })
      execution.assertCurrent()
    }
  } catch (err) { console.warn('[pet-life] conversation save failed:', err.message) }
  execution.assertCurrent()
  characterRetryTurn = null
  if (!reply.conversation || !reply.conversation.replyTo) proactiveAwaitingReply = null
  renderLivingNotebook()
}
function presentCharacterExpression(reply, execution) {
  if (!roleRuntime.isAuthorized(execution)) return
  if (R.running || R.dragging || R.sleepy) return
  const available = window.AnimationRegistry.list().map(a => typeof a === 'string' ? a : a.name || a.id)
  const plan = window.LivingPresence.expression(reply.conversation, available)
  setMood('idle')
  if (plan.animation && $('anim-' + plan.animation)) {
    const continuationId = window.LivingPresence.ACTIONS[plan.animation] ? execution.continueAs('expression-animation') : null
    showAnim(plan.animation, 4500, afterOneShotAnimation, { source: 'conversation', priority: 75, interruptible: true, runtimeExecution: execution, continuationId })
  }
}
function renderLivingNotebook() {
  const host = $('living-notebook')
  if (!host || !window.PetLife) return
  const life = window.PetLife.context(Date.now())
  const active = life.activeActivity || (life.activities || []).find(a => a.status === 'active')
  const summary = $('living-current')
  if (summary) summary.textContent = active ? active.wish : '现在没有急着要做的事。'
  host.replaceChildren()
  const items = (life.artifacts || []).slice(-8).reverse()
  if (!items.length) { const empty = document.createElement('p'); empty.textContent = '聊过的话、做过的小事，会慢慢留在这里。'; host.appendChild(empty) }
  for (const item of items) {
    const card = document.createElement('article'), text = document.createElement('p'), time = document.createElement('small')
    text.textContent = item.text || item.content || item.title || ''
    time.textContent = item.createdAt || item.ts ? new Date(item.createdAt || item.ts).toLocaleString() : ''
    card.append(text, time)
    if (window.PetLife.forgetArtifact) { const button = document.createElement('button'); button.textContent = '移除'; button.onclick = async () => { button.disabled = true; try { await window.PetLife.forgetArtifact(item.id); renderLivingNotebook() } catch { button.disabled = false; button.textContent = '未保存，重试' } }; card.appendChild(button) }
    host.appendChild(card)
  }
}
function characterChatFailureMessage(reason) {
  if (/history_(write|load)_failed/.test(String(reason || ''))) return '聊天记录未能保存或读取，草稿已保留；点发送重试，不会重复生成已有回复。'
  const messages = {
    http_402: '模型服务拒绝了请求（HTTP 402），请检查账户余额或计费状态；草稿已保留。',
    http_401: '模型服务验证失败，请检查 API 密钥；草稿已保留。',
    'auth-required': '模型服务要求认证：请到设置里填写 API Key（本机服务可在高级设置选择“无需认证”）；草稿已保留。',
    auth: 'API Key 无效或认证方式不匹配，请检查设置里的密钥与认证方式；草稿已保留。',
    'no-key': '还没有可用的模型密钥，请先完成模型配置；草稿已保留。',
    network: '连接不上模型服务：请确认服务已启动、地址和端口正确；草稿已保留。',
    timeout: '这次等得有点久，草稿已保留，点发送重试。',
    empty: '模型返回了空内容：请换一个模型或确认它支持文本对话；草稿已保留。',
    model_invalid: '服务不识别当前模型：请在设置里重新获取模型列表；草稿已保留。',
    endpoint_not_found: '模型服务地址不匹配，或该服务没有模型列表接口，请在设置里检查地址；草稿已保留。',
    model_loading: '模型正在加载，请稍后点发送重试；草稿已保留。',
    provider_unavailable: '模型服务暂时出错，请稍后点发送重试；草稿已保留。',
    empty_or_timeout: '这次没有收到完整回复，草稿已保留，点发送重试。',
    disabled: 'AI 聊天已关闭，可在设置里开启；草稿已保留。',
    quota_exhausted: '今天的 AI 聊天次数已用完，草稿已保留。',
    persona_boundary: '这次回复没有通过真实性检查，草稿已保留，可换个问法。',
    guard_rejected: '这次回复核验后未能修复，草稿已保留，点发送重试。'
  }
  return messages[reason] || '这次连接失败，草稿已保留，点发送重试。'
}
function charcEl(tag, styles, text) {
  const el = document.createElement(tag)
  if (styles) Object.keys(styles).forEach((k) => { el.style[k] = styles[k] })
  if (text !== undefined && text !== null) el.textContent = String(text)
  return el
}
function charcRow(role, text, ts) {
  const mine = role === 'user'
  const row = charcEl('div', { display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', margin: '4px 0' })
  const wrap = charcEl('div', { display: 'flex', flexDirection: 'column', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '82%' })
  wrap.appendChild(charcEl('div', {
    maxWidth: '100%', padding: '6px 9px', borderRadius: '10px', fontSize: '12.5px', lineHeight: '1.45',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#26313f',
    background: mine ? 'rgba(120,170,255,0.20)' : 'rgba(255,255,255,0.92)',
    border: mine ? '1px solid rgba(120,170,255,0.35)' : '1px solid rgba(0,0,0,0.06)'
  }, text))
  if (ts) {
    const d = new Date(ts)
    wrap.appendChild(charcEl('div', { fontSize: '10.5px', opacity: '0.55', marginTop: '2px' },
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')))
  }
  row.appendChild(wrap)
  return row
}
/* 只读渲染：每次切进来都从存储重读（真值唯一来源），默认最近 40 条，可展开更早记录。 */
function refreshCharacterHistoryViews() {
  chatHistoryCacheAt = 0
  renderCharc(false).catch(err => console.warn('[chat] refresh failed:', err.message))
}
async function renderCharc(forceBottom) {
  renderLivingNotebook()
  const body = $('charc-body')
  if (!body) return 0
  const version = ++charcRenderVersion
  const oldHeight = body.scrollHeight
  const oldTop = body.scrollTop
  const readingOlder = !forceBottom && body.childElementCount > 0 && oldHeight - oldTop - body.clientHeight > 48
  let hist = []
  try { hist = await window.pet.characterHistoryLoad(); if (!Array.isArray(hist)) throw Error('history_load_failed') } catch (err) {
    const status = $('charc-status')
    if (status && version === charcRenderVersion) status.textContent = '聊天记录暂时读不到，已有内容保留；重新打开此页可重试。'
    return 0
  }
  if (version !== charcRenderVersion) return 0
  chatHistoryCache = hist
  chatHistoryCacheAt = Date.now()
  while (body.firstChild) body.removeChild(body.firstChild)
  const tail = (Array.isArray(hist) ? hist : []).slice(-charcVisibleLimit)
  if (!tail.length) body.appendChild(charcEl('div', { opacity: '0.6', fontSize: '12px', margin: '8px 0' }, '（还没聊过。跟她说点什么吧～）'))
  tail.forEach((m) => body.appendChild(charcRow(m && m.role === 'user' ? 'user' : 'assistant', (m && m.text) || '', m && m.ts)))
  body.scrollTop = readingOlder ? oldTop : body.scrollHeight
  const more = $('charc-more')
  if (more) more.hidden = !Array.isArray(hist) || hist.length <= charcVisibleLimit
  return tail.length
}
async function charcSend(execution, submittedText) {
  if (window.pet.character?.authority) return submitKernelChat($('charc-input'))
  if (!roleRuntime.isAuthorized(execution)) {
    const input = $('charc-input'), text = input && String(input.value || '').trim()
    if (!text) return
    input.value = ''
    const result = await submitOwnerReply(text, permit => charcSend(permit, text))
    if (result && !result.ok && !result.cancelled && !result.committed && !input.value) input.value = text
    return result
  }
  const input = $('charc-input')
  if (!input) return
  const text = submittedText || String(input.value || '').trim()
  if (!text) return
  livingPresence.user()
  Pace.onUser() /* P0-1 第二批：主人开口 ⇒ 连发计数复位 */
  if (!submittedText) input.value = ''
  charcBusy = true
  characterUiExecutionId = execution.executionId
  let actionResult = { ok: false, reason: "reply_incomplete" }
  const btn = $('charc-send')
  if (btn) { btn.disabled = true; btn.textContent = '…' }
  try {
    const history = await prepareCharacterTurn(text, execution)
    await renderCharc(true)
    const thinking = $('charc-status')
    if (thinking) thinking.textContent = '小深正在想怎么回你…'
    const aiContext = (window.CharacterSnapshot && typeof window.CharacterSnapshot.toCharacterAIContext === 'function')
      ? window.CharacterSnapshot.toCharacterAIContext({ userText: text, history })
      : {}
    /* R-11 B/C（用户授权）：与迷你输入那条路径**同款**（两处逐行一致，防两套逻辑漂移） */
    try {
      if (Array.isArray(proactiveOpeningLog) && proactiveOpeningLog.length) aiContext.proactiveOpenings = proactiveOpeningLog.slice()
      const __aw2 = proactiveAwaitingReply
      if (__aw2 && __aw2.id) aiContext.proactiveReplyTo = { instanceId: __aw2.id, presentedAt: __aw2.presentedAt, opening: proactiveOpeningText || '', explicit: __aw2.explicit === true }
    } catch (err) { /* 取不到就不带 */ }
    execution.assertCurrent()
    const r = (characterRetryTurn && characterRetryTurn.reply) || await characterChatRequest({ role: 'chat', userText: text, context: aiContext, history: history, timeoutMs: 90000, force: true, source: 'charc-tab' }, execution)
    execution.assertCurrent()
    actionResult = { ok: !!(r && r.ok && r.text), reason: r && r.reason }
    const reply = (r && r.ok) ? r.text : null
    if (reply) {
      await persistCharacterReply(text, r, execution)
      execution.assertCurrent()
      markDaily('chat')
      maybeRememberFromChat(text, execution)
      addAffection(1)
      presentCharacterExpression(r, execution)
      let finalReply = String(reply)
      let praised = false
      if (finalReply.indexOf('[PRAISED]') === 0) { praised = true; finalReply = finalReply.replace(/^\[PRAISED\]\s*/, ''); unlockPhoto('praised') }
      Pace.onAssistant()
      await renderCharc(true)
      execution.assertCurrent()
      /* S6：若本轮是"回应主动开场" ⇒ 上报 reply（状态 ③）并写一条 `P1_proactive_talk` 经历。
         本块与 sendMiniChat 里的那一段**同款**（契约逐行钉死两处相等，防两套逻辑漂移）。 */
      if (proactiveAwaitingReply && r.conversation && r.conversation.replyTo === proactiveAwaitingReply.id) {
        const aw = proactiveAwaitingReply
        proactiveAwaitingReply = null
        try { console.log('[proactive] reply', aw.id, 'via=chat') } catch (e) { /* ignore */ }
        proactiveReport({ type: 'reply', id: aw.id, nowTs: Date.now() }).then((rr) => {
          if (!rr || rr.ok !== true) return
          try {
            const W = window.PresenceWriters
            const entry = (W && typeof W.buildProactiveTalkExperience === 'function')
              ? W.buildProactiveTalkExperience({ instanceId: aw.id, presentedAt: aw.presentedAt, repliedAt: Date.now(), replyText: text, ts: Date.now() })
              : null
            if (entry && window.pet && typeof window.pet.experienceEvent === 'function') window.pet.experienceEvent(entry)
          } catch (err) { /* 经历写入失败不影响聊天主链 */ }
        }).catch(() => {})
      }
      if (praised) { setMood('happy', 12000); addHearts(3) }
      touch()
    } else {
      const body = $('charc-body')
      if (body) {
        body.appendChild(charcEl('div', { opacity: '0.8', fontSize: '12px', margin: '6px 0' }, characterChatFailureMessage(r && r.reason)))
        body.scrollTop = body.scrollHeight
      }
      if (!input.value) input.value = text
    }
  } catch (err) {
    if (!execution.isCurrent()) return { ok: false, cancelled: true, reason: 'runtime_cancelled' }
    actionResult = { ok: false, reason: err.code || err.message }
    if (!input.value) input.value = text
    const message = characterChatFailureMessage(err && err.message)
    const body = $('charc-body')
    if (body) { body.appendChild(charcEl('div', { fontSize: '12px', margin: '6px 0' }, message)); body.scrollTop = body.scrollHeight }
    say(message, 6000, 'ui', undefined, execution)
  } finally {
    if (characterUiExecutionId === execution.executionId) {
    charcBusy = false
    const thinking = $('charc-status')
    if (thinking) thinking.textContent = ''
    if (btn) { btn.disabled = false; btn.textContent = '发送 ➤' }
    }
  }
  return actionResult
}

/* tick 之后：只在后端放行时呈现；**本函数不做任何判定/选择**。
   开场文案＝S5 AI（失败/不合格 ⇒ F6-A fallback；两者皆空 ⇒ **不展示、不 present、不 spend**）。 */
let proactivePresentationJob = null
let proactivePresentationEpoch = 0
function proactivePresentationBlocked() {
  const focused = typeof document !== 'undefined' ? document.activeElement : null
  const typing = focused && ['mini-chat-input', 'charc-input', 'chat-input'].includes(focused.id) && String(focused.value || '').trim()
  const life = typeof window !== 'undefined' && window.PetLife && window.PetLife.context(Date.now())
  const quiet = life && life.livingState && life.livingState.quietUntil > Date.now()
  return !proactiveOn || R.hidden || R.busy || chatBusy || charcBusy ||
    quiet || (typeof game !== 'undefined' && game && game.playing) || typing || Pace.blocked()
}
function proactiveAfterTick(r) {
  void runtimeOpportunity(r)
  return // Old F4/M2 publication orchestration is no longer an entry point.
  try {
    if (!r || r.ok !== true) return
    const pr = r.proactive
    if (!pr || pr.canPresent !== true) {
      if (pr && pr.entryId) console.log('[proactive] no-present', 'reason=canpresent-false', 'entry=' + String(pr.entryId))
      // No new choice is not a revocation of the opening already in flight.
      // Only an actual suppressor may invalidate it before its bounded timeout.
      const s = (pr && pr.suppressors) || {}
      if (s.switchEnabled === false || s.quietHours === true || s.ownerBusy === true ||
          s.politenessDefer === true || s.noCredit === true || s.intervalOk === false || s.familyRecent === true) {
        proactivePresentationEpoch++
      }
      return
    }
    /* PC-2：呈现门槛由「只放 seek_attention」改为**白名单判定**（4 条动作，逐字与
       renderer/life-context/proactive.js 的 LEGAL_ACTIONS 一致；契约守两处漂移）。仍**不新增选择权**：
       只呈现后端（F4→F7）已经选中的那一个动作。 */
    const PROACTIVE_CARD_ACTIONS = ['seek_attention', 'comment_on_activity', 'accompany_owner', 'celebrate']
    if (PROACTIVE_CARD_ACTIONS.indexOf(String(pr.chosenActionId || '')) < 0) {
      console.log('[proactive] no-present', 'reason=action-not-allowed', String(pr.chosenActionId || ''), 'entry=' + String(pr.entryId || '-'))
      return
    }
    if (proactivePresentationJob || proactivePresentationBlocked()) return
    const epoch = proactivePresentationEpoch
    const started = Date.now()
    /* P0-1 第二批（C3）：连发刹车——连续 3 次 assistant 侧发言而主人零插话 ⇒ 本拍不呈现（质量闸：
       不拥有选择权、不碰 F4/F7 判定；丢弃走 A8 no-present 对账口径，主人开口即恢复） */
    try { if (Pace.blocked()) { console.log('[proactive] no-present', 'reason=burst-limit', 'pace=' + Pace.status()); return } } catch (e) { /* ignore */ }
    let job = null
    /* S-8（第二阶段·用户授权）：若本轮选中的主动行为来自内部方向 ⇒ 把**同一批**真实 memory
       交给主动上下文与 Guard（同批取证，不允许"AI 看得到、Guard 看不到"）。
       只放 1 条真实载体（不塞整库）；普通主动行为不受影响（无内部方向时 ctx 与原来逐字相同）。 */
    const ctx = proactiveTopicContext()
    try {
      const surf = (window.ShadowInternalLife && typeof window.ShadowInternalLife.getLastSurfaced === 'function') ? window.ShadowInternalLife.getLastSurfaced() : null
      /* R-8 M2（用户 ）：除"90 秒新鲜"外，**同轮同源实例绑定**也算新鲜——她"这一件想说的话"
         不再因过了 90 秒就脱钩；其余条件逐字保留，时间表达仍由 verifyTimeProvenance 核验。 */
      const sameRound = !!(surf && surf.entryId && pr.entryId && String(surf.entryId) === String(pr.entryId))
      const fresh = !!(surf && (sameRound || (Number.isFinite(Number(surf.at)) && (Date.now() - Number(surf.at)) <= 90000)))
      if (fresh && surf.memoryId) {
        const all = (window.MemoryEngine && typeof window.MemoryEngine.getMemories === 'function') ? window.MemoryEngine.getMemories() : []
        const mem = (Array.isArray(all) ? all : []).find(function (m) { return m && m.id === surf.memoryId }) || null
        /* R-8 M1：既有结构化素材载体（pet:/tl:）不在记忆库里 ⇒ 用**内存只读视图**（真实 id + 真实字段文本）；
           不新建、不改写任何记忆。 */
        const view = mem || ((surf.text && /^(pet|tl):/.test(String(surf.memoryId))) ? { id: surf.memoryId, date: surf.date || null, content: surf.text } : null)
        if (view) {
          ctx.relevantMemories = [view]
          ctx.internalDirection = {
            type: surf.type, about: surf.about, memoryId: surf.memoryId,
            date: surf.date || view.date || null, evidenceClass: surf.evidenceClass, source: surf.source
          }
        }
      }
    } catch (err) { /* 取载体失败 ⇒ 退回普通上下文（不伪造证据） */ }
    try {
      if (window.AIGateway && typeof window.AIGateway.proactiveTopic === 'function') {
      /* PC-2：把 F4→F7 选定的动作交给 prompt（模型只按形态说，不拥有选择权） */
      try { ctx.action = String(pr.chosenActionId || '') } catch (e) {}
      let topics
      if (window.PetLife && window.PetLife.snapshot().ready) {
        const full = window.CharacterSnapshot.toCharacterAIContext('')
        Object.assign(ctx, { selfState: full.selfState, runtimeFacts: full.runtimeFacts, petLife: full.petLife })
        topics = window.PetLife.candidates({ nowTs: Date.now(),
          memories: window.MemoryRetrieval ? window.MemoryRetrieval.retrieve({}, { limit: 8 }) : [],
          allMemories: window.MemoryEngine ? window.MemoryEngine.getMemories() : [],
          history: chatHistoryCache, reality: ctx.reality, events: full.recentEvents })
      }
      job = window.AIGateway.proactiveTopic({
          context: ctx,
          candidates: topics,
          entryId: (pr && pr.entryId) ? pr.entryId : null, // CC-5：承接派生要按候选 entryId 找 topicId
          family: (pr && pr.family) ? pr.family : null, // P0-1c：主题族键（族级卡片与 24h family-recent 对齐）
          recentOpenings: Array.isArray(pr.recentOpenings) ? pr.recentOpenings : [],
          maxChars: 60,
          timeoutMs: 90000
        })
      }
    } catch (err) { job = null }
    proactivePresentationJob = Promise.resolve(job).then((tp) => {
      if (epoch !== proactivePresentationEpoch || proactivePresentationBlocked() || Date.now() - started > 120000) {
        console.log('[proactive] no-present', 'reason=stale-request', 'entry=' + String(pr.entryId || '-'))
        return
      }
      const aiOpening = (tp && tp.ok === true && typeof tp.opening === 'string') ? tp.opening.trim() : ''
      if (tp && tp.silent === true) {
        console.log('[proactive] no-present reason=planner-silent')
        return
      }
      const text = aiOpening
      if (!text) {
        console.log('[proactive] no-present', 'reason=empty-text', 'entry=' + String(pr.entryId || '-'))
        return
      }
      const prev = proactiveFocusId
      return proactiveReport({
        type: 'present', presented: true, nowTs: Date.now(),
        opening: text,
        topic: (tp && tp.topic) || null,
        topicSource: (tp && tp.source) || 'ai',
        family: (tp && tp.family) || pr.family || null,
        decision: { outcome: pr.outcome, chosenActionId: pr.chosenActionId, entryId: pr.entryId },
        suppressors: pr.suppressors
      }).then(async (res) => {
        try { if (!res || res.ok !== true) console.log('[proactive] no-present', 'reason=backend-refused', 'reason2=' + String((res && res.reason) || '-')) } catch (e) { /* ignore */ }
        if (!res || res.ok !== true) return                 // 后端拒绝（开关/闸门）⇒ 不显示（渲染层不自行判定）
        const inst = res.instance || null
        const id = inst ? inst.id : null
        if (epoch !== proactivePresentationEpoch || proactivePresentationBlocked() ||
            (tp && tp.candidateId && window.PetLife && !window.PetLife.canPresentDecision(tp, Date.now()))) return
        await proactiveShowCard(text, id)
        if (window.PetLife && tp && tp.candidateId) window.PetLife.presented({
          candidateId: tp.candidateId, instanceId: id, topic: tp.topic,
          sourceKeys: tp.sourceKeys, opening: text, form: tp.form, ts: Date.now()
        }).catch(err => console.warn('[pet-life] contact save failed:', err.message))
        try { console.log('[proactive] present', id, 'initiated=true', 'entry=' + String((pr && pr.entryId) || '-'), 'action=' + String((pr && pr.chosenActionId) || '-'), 'src=ai', 'topic=' + String(text || '').slice(0, 24)) } catch (e) { /* ignore */ }
        Pace.onAssistant()
        /* 状态 ④：新卡替换掉一张「已呈现未回复」的旧卡 ⇒ 上报 supersede（R3 乙）；
           主进程在 present 内部已原子地做过一次，这里是显式补充，重复调用是 no-op。 */
        if (prev && id && prev !== id) proactiveReport({ type: 'supersede', id: prev, byId: id, nowTs: Date.now() })
        try { if (prev && id && prev !== id) console.log('[proactive] supersede', prev, 'by', id) } catch (e) { /* ignore */ }
      })
    }).catch(() => { console.warn('[proactive] no-present reason=request-failed') }).finally(() => { proactivePresentationJob = null })
  } catch (err) { /* 载体失败不影响主循环 */ }
}


/* F6-B 取数口（aigateway 只走这里，不直读文件、不查规则表）：
   **只做镜像** —— 上游 tick 给什么就镜像什么；超过 1 个 heartbeat（60s + 30s 抖动容差）没刷新 ⇒
   视为 stale、明确返回 null（不注入），**绝不自己推演/自己查表/自己选候选**。 */
const LIFE_EXPRESSION_MAX_LAG_MS = 90000
function lifeExpressionForPrompt() {
  try {
    if (!lifeContextExpressible || lifeContextExpressible.ok !== true) return null
    if (!lifeContextExpressibleAt || (Date.now() - lifeContextExpressibleAt) > LIFE_EXPRESSION_MAX_LAG_MS) return null
    const line = (lifeContextExpressible.lines && lifeContextExpressible.lines[0]) || null
    if (!line || typeof line.text !== 'string' || !line.text) return null
    return {
      text: line.text,
      tone: line.tone || lifeContextExpressible.tone || null,
      refs: (lifeContextExpressible.refs || []).slice(),
      sourceRefs: lifeContextExpressible.sourceRefs || null,
      asOfTs: lifeContextExpressibleAt
    }
  } catch (err) { return null }
}
try { window.lifeExpressionForPrompt = lifeExpressionForPrompt } catch (err) { /* ignore */ }

/* P3-C1 取数口（aigateway 只走这里）：只做**镜像搬运**，不采集、不推断、不新增第二套 Reality 数据结构。
   · 当前前台应用：读**已有** perception 状态（P.perceptionState.vision.lastApp/lastCat/lastSeenTs，由 detectors 每轮更新）
     —— 这是实时前台状态，**不受** LIFE_REALITY_MAX_LAG_MS 限制；
   · 最近活动：读本 tick 已返回的 reality.segments（timeline 段落），超过 10 分钟视为陈旧 ⇒ 不提供；
   · 两者都无 ⇒ 返回 null（调用方**完全不输出** Reality 块，prompt 逐字保持不变）。 */
function lifeRealityForPrompt() {
  try {
    let currentApp = null
    try {
      const v = (P && P.perceptionState && P.perceptionState.vision) || null
      if (v && v.lastApp) {
        currentApp = { app: String(v.lastApp), cat: String(v.lastCat || ''), seenAtTs: Number(v.lastSeenTs) || 0 }
      }
    } catch (err) { currentApp = null }
    let segments = null
    let segmentsAsOfTs = null
    if (lifeContextReality && lifeContextRealityAt && (Date.now() - lifeContextRealityAt) <= LIFE_REALITY_MAX_LAG_MS) {
      const arr = Array.isArray(lifeContextReality.segments) ? lifeContextReality.segments.slice() : []
      if (arr.length) { segments = arr; segmentsAsOfTs = Number(lifeContextReality.asOfTs) || lifeContextRealityAt }
    }
    if (!currentApp && !segments) return null
    return { currentApp: currentApp, segments: segments, segmentsAsOfTs: segmentsAsOfTs }
  } catch (err) { return null }
}
try { window.lifeRealityForPrompt = lifeRealityForPrompt } catch (err) { /* ignore */ }
/* P3-C2-F1 取数口（aigateway 只走这里）：只做镜像搬运；**不设时间闸**（经历不因超过 N 分钟失效），
   条数上限由主进程只读快照裁决（最多 3 条）；无经历 ⇒ 返回 null（调用方完全不输出块）。 */
function lifeExperiencesForPrompt() {
  try {
    const src = lifeContextExperiences
    if (!src || typeof src !== 'object') return null
    const items = Array.isArray(src.items) ? src.items.slice(0, 3) : []
    const kept = items.filter(function (x) { return x && typeof x.text === 'string' && x.text.trim() })
    if (!kept.length) return null
    return { items: kept, asOfTs: Number(src.asOfTs) || 0, count: Number(src.count) || kept.length }
  } catch (err) { return null }
}
try { window.lifeExperiencesForPrompt = lifeExperiencesForPrompt } catch (err) { /* ignore */ }
/* ===== [F5-LCTAP-BEGIN] 事件旁路（内联；测试用源码抽取 + vm 沙箱求值同一份代码；锚点勿改） =====
   设计（用户 2026-09-19 拍板 + 2026-09-20 甲方案修定）：观察点必须落在那条"事件真正流经的调用面"上。
   实测根因①：引擎的 bus 订阅（`subscribeEvents`）调的是**模块内闭包** `applyEvent(P,…)`，
   所以"包裹 API 属性 `engine.applyEvent`"看不到任何总线事件（接线看似通、实际零输入）。
   实测根因②：本文件是 IIFE，而 `loadState()` 是 **async + .then**（pet.js:8042）⇒ 追加块先执行、状态后恢复；
   若此时取刻度，会拿到"还没恢复的默认态"并让之后所有事件都判成"不是恰好 +1"而静默丢弃。
   现行做法（甲）：**总线旁听 + 引擎自报诊断的 version 递增判定 + 只在状态已恢复时取刻度**——
     · 只读引擎公开读接口 `engine.getDiagnostics(state)`（state 由接线处显式传入；
       若 `state.emotion` 尚未恢复 ⇒ 直接放弃取刻度，既不猜、也不触发引擎懒创建状态）；
     · **顺序无关**：loadState() 在 await 之后才 init 引擎 ⇒ tap 的监听器可能先回调，
       故观察取"进门同步读 + 微任务读"两分支归因（见 observe 注释）。
     · 硬约束（用户原话口径）：**tap 只能把"当前这次总线事件导致的诊断 version 递增"关联到这次事件；
       若无法建立这一对应关系，就宁可不记，不能猜。**
     · 因此三件事同时成立才记：①`version === 上一次观测 + 1`（恰好一次采纳；冷却/拒绝源/重复/unknown 都不递增）；
       ②诊断里的 `lastEmotionEvent.eventId` 前缀命中**本次总线事件**（emo:fed: / emo:work: / emo:game: / emo:click:）；
       ③记录用的 kind 取自引擎自己给出的 `lastEmotionEvent.kind` —— **kind 解释只由引擎持有**，tap 不做任何映射。
     · 刻度自愈：每次 install 都重取一次刻度（心跳每分钟一次）；observe 在刻度为空时只建刻度、不记。
     · 派生性质：**完全不碰引擎对象**（不包 applyEvent、不改别名）⇒ "保留原函数语义与返回值"由构造本身保证。
   为什么内联：渲染层无 require、index.html 不许接线（4 处断言看守）⇒ 独立模块在渲染层加载不了。 */
const LifeContextEventTap = (function () {
  const MAX_BUFFER = 64
  // 只用于"把这次总线事件与引擎诊断对应起来"，不解释 kind（kind 永远取自引擎自报）
  const BUS_EVENT_PREFIX = {
    'pet.fed': 'emo:fed:',
    'pet.work.completed': 'emo:work:',
    'game.completed': 'emo:game:',
    'pet.clicked': 'emo:click:'
  }
  let buf = []
  let dropped = 0
  let installs = 0
  let subscribed = false
  let stateRef = null
  let lastVersion = null

  function readDiag(engine, state) {
    try {
      if (!engine || typeof engine.getDiagnostics !== 'function') return null
      // 状态还没恢复（或压根没有 emotion）⇒ 不取刻度：既不猜，也避免触发引擎懒创建默认态
      if (state && typeof state === 'object' && !state.emotion) return null
      const d = state ? engine.getDiagnostics(state) : engine.getDiagnostics()
      if (!d || typeof d !== 'object') return null
      if (typeof d.version !== 'number') return null
      const ev = (d.lastEmotionEvent && typeof d.lastEmotionEvent === 'object') ? d.lastEmotionEvent : null
      return { version: d.version, event: ev }
    } catch (e) { return null }
  }

  function push(item) {
    if (buf.length >= MAX_BUFFER) { buf.shift(); dropped++ }
    buf.push(item)
    return true
  }

  function prime(engine, state) {
    const d = readDiag(engine, state)
    if (d) lastVersion = d.version
    return d ? d.version : null
  }

  // 一次总线事件之后：只有当"恰好一次采纳 + 最近一次采纳就是这次事件"时才有资格入账
  // 注意：本 tap 的监听器**可能先于引擎**（pet.js 是同步 IIFE，而引擎订阅发生在 loadState() 的 await 之后），
  // 所以不能只看"回调这一刻"的版本 —— 进门同步读一次(entry)，微任务再读一次(after)，按两分支归因。
  function observe(engine, busName, state) {
    const prefix = BUS_EVENT_PREFIX[busName]
    if (!prefix) return false
    const entry = readDiag(engine, state)   // 可能早于引擎处理（tap 先注册）；也可能晚于（引擎先注册）
    const decide = function () {
      try {
        const after = readDiag(engine, state)
        if (!after) return false
        const prev = lastVersion
        lastVersion = after.version                         // 无论记不记，刻度都推进
        let ev = null
        if (entry && after.version === entry.version + 1) {
          ev = after.event                                  // A：本次回调区间内恰好发生一次采纳 ⇒ 就是这次事件
        } else if (entry && after.version === entry.version && prev !== null && entry.version === prev + 1) {
          ev = entry.event                                  // B：引擎比我们先跑；递增发生在我们进门之前，但恰好一次
        } else {
          return false                                      // 增量≠1 / 刻度不可用 ⇒ 无法建立对应关系 ⇒ 不记
        }
        if (!ev) return false
        if (typeof ev.eventId !== 'string' || ev.eventId.indexOf(prefix) !== 0) return false
        const kind = String(ev.kind || '')
        if (!kind) return false
        return push({ kind: kind, eventId: ev.eventId, ts: (typeof ev.ts === 'number' ? ev.ts : null), source: busName })
      } catch (e) { return false }
    }
    try { Promise.resolve().then(decide) } catch (e) { /* 环境无 Promise ⇒ 不记（不猜） */ }
    return true
  }

  function install(engine, bus, state) {
    const wasSubscribed = subscribed
    if (state && typeof state === 'object') stateRef = state
    if (!engine || typeof engine !== 'object') return { ok: false, reason: 'no_engine' }
    if (typeof engine.getDiagnostics !== 'function') return { ok: false, reason: 'no_diagnostics' }
    if (!subscribed) {
      if (!bus || typeof bus.on !== 'function') return { ok: false, reason: 'no_bus' }
      let n = 0
      Object.keys(BUS_EVENT_PREFIX).forEach(function (name) {
        try {
          bus.on(name, function () { try { observe(engine, name, stateRef) } catch (e) { /* 记录失败绝不影响引擎 */ } })
          n++
        } catch (e) { /* 单个订阅失败不影响其它 */ }
      })
      if (n === 0) return { ok: false, reason: 'subscribe-failed' }
      subscribed = true
      installs++
    }
    // 每次调用都重取刻度（状态未恢复则内部直接放弃）—— 心跳每分钟一次 ⇒ 刻度自愈
    const scale = prime(engine, stateRef)
    return { ok: true, already: wasSubscribed, subscribed: subscribed ? Object.keys(BUS_EVENT_PREFIX).length : 0, installs: installs, scale: scale }
  }

  function drain() { const events = buf.slice(); const d = dropped; buf = []; dropped = 0; return { events: events, dropped: d } }
  function size() { return buf.length }
  function droppedCount() { return dropped }
  function reset() { buf = []; dropped = 0; lastVersion = null; subscribed = false; stateRef = null }
  function assertNoSurface() {
    const forbidden = ['say', 'speak', 'emit', 'dispatch', 'fire', 'run', 'notify', 'act', 'intent', 'presence', 'play', 'send']
    const keys = Object.keys(api || {})
    return { ok: keys.every(function (k) { return forbidden.indexOf(k.toLowerCase()) < 0 }), keys: keys }
  }
  const api = {
    MAX_BUFFER: MAX_BUFFER,
    BUS_EVENT_PREFIX: BUS_EVENT_PREFIX,
    install: install,
    drain: drain,
    size: size,
    droppedCount: droppedCount,
    reset: reset,
    prime: prime,
    isPrimed: function () { return lastVersion !== null },
    assertNoSurface: assertNoSurface,
    __observeForTest: observe
  }
  return api
})()/* ===== [F5-LCTAP-END] ===== */
try { if (window.EmotionEngine) LifeContextEventTap.install(window.EmotionEngine, window.EventBus, P) } catch (e) { /* load 时先装一次（幂等）；payload 构造时再兜一次 */ }
/* 尽早取刻度（有界重试）：loadState() 是 async ⇒ 本追加块执行时 P.emotion 尚未恢复；
   不重试的话，"恢复后、下一次心跳前"到来的第一个总线事件会因"首次观测只建刻度"被丢弃。
   拿到刻度即 clearInterval；60 次（≈60s）后无条件停，避免长跑里的多余读取。 */
let __lcTapPrimeTries = 0
const __lcTapPrimeTimer = setInterval(function () {
  try { LifeContextEventTap.install(window.EmotionEngine, window.EventBus, P) } catch (e) { /* ignore */ }
  __lcTapPrimeTries++
  if (LifeContextEventTap.isPrimed() || __lcTapPrimeTries >= 60) clearInterval(__lcTapPrimeTimer)
}, 1000)

/* F5 接线补齐（纯追加）：三处真值叠加到既有 payload（不改原行，用"覆盖"方式叠加） */
let lifeContextSessions = null // 最近一次成功取得的会话权限真值（允许最多一个 heartbeat 延迟）
function lifeContextRefreshSessions() {
  try {
    const p = window.pet
    const __sl = (p.sessions && typeof p.sessions.list === 'function') ? function () { return p.sessions.list() } : ((typeof p.dshCall === 'function') ? function () { return p.dshCall('session.list', {}) } : null)
    if (!__sl) return // 无可用访问器 ⇒ 保持 null（不伪装真值）
    Promise.resolve(__sl()).then(function (r) {
      try {
        const v = (r && r.result && r.result.value) || r || {}
        const items = v.items
        if (!Array.isArray(items)) return
        lifeContextSessions = items.map(function (s) {
          const proj = (s && s.projections && s.projections.values && s.projections.values.permissions) || {}
          return { sessionId: (s && s.sessionId) || null, current: proj.currentValue || null }
        })
      } catch (e) { /* 解析失败保持旧真值 */ }
    }).catch(function () { /* 读取失败保持旧真值（不伪装成真值） */ })
  } catch (e) { /* ignore */ }
}
/* ===== [SHADOW-IL-BEGIN] =====
   S-1…S-7：内部生活 Shadow Mode（零 AI / 零 present / 零 credits / 零 Memory 写入 / 零用户可见表达）
   · 唯一时序入口＝既有 60s 心跳（lifeContextTickOnce 的那次调用；本块不自建任何 timer）
   · S-2 复用既有 MemoryRetrieval（只读）；S-3 只用规则（无随机）；S-4 只把"方向+载体"挂到
     本轮**既有**池候选上（不改分、不增候选、不改池基数 ⇒ 旧主动行为不变）
   · S-6 观测经既有 console.log → main console-message → pet.log 落地；运行时不回读日志
   · S-7 封条：不出现 AI/present/credits/Memory 写入面；断言见 assertSeals()
   本块是纯函数式 + 一个内存内计数器（不落盘、不进账本、不被任何产品决策读取）。 */
const ShadowInternalLife = (function () {
  const VERSION = 'shadow-internal-life/1'
  /* shadow-local 参数（只用于 Shadow Mode 自己的节流/封顶；不喂 F4、不进任何产品决策、不是 endogenous 阈值） */
  const IDLE_MIN_MS = 10 * 60 * 1000
  /* 用户「行」（A/B 有界校准，P1-S 节奏）：24h 读数＝attach 12/92 拍、准入 6 拍、内部方向占出卡 1/5 ⇒
     把"单方向的再浮现间隔/日上限"各放宽一档，让"心里的话"更容易成为候选（**只影响 Shadow 自己的节流**，
     不喂 F4、不改 F7/credits/证据门；契约测试按导出常量取判据 ⇒ 行为断言不受影响）。可一行回滚：30/3。 */
  const COOLDOWN_MS = 20 * 60 * 1000
  const MAX_SURFACES_PER_DIRECTION = 4
  const MAX_TRACKED_DIRECTIONS = 20
  const SPREAD_WINDOW = 5
  /* PC-1 S3：**被看见没被回**的载体冷却（比普通 20min 更久）。
     只针对「最近一次真正挂上候选池的那条载体」；主人一有互动立即解除；**绝不因此把她憋死**（只有它一个候选时退化为原规则）。 */
  const UNANSWERED_COOLDOWN_MS = 2 * 60 * 60 * 1000
  const CARRIER_LIMIT = 3
  const DIRECTION_ACTION = 'seek_attention' /* R-4 I-1：方向候选的载体动作（动作加权仍由既有 IntentEngine 给出） */
  const LOG_RING_MAX = 200
  const FORBIDDEN_API_KEYS = ['say', 'speak', 'emit', 'dispatch', 'notify', 'present', 'ai', 'write', 'save', 'persist', 'mutate', 'credit', 'spend']
  const state = { surfaces: {}, recent: [], ticks: 0, pending: null, dayKey: '' }
  const ring = []

  function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0 }
  function pad2(x) { return String(x).padStart(2, '0') }
  function memDate(m) {
    if (m && typeof m.date === 'string' && m.date) return m.date
    const ts = n(m && (m.updatedAt || m.createdAt))
    return ts > 0 ? new Date(ts).toISOString().slice(0, 10) : null
  }

  /* S-1：闲置信号（只表示"现在外部世界没有足够活动"；**不得**直接触发任何行为） */
  function computeIdle(ctx) {
    const c = ctx || {}
    const nowTs = n(c.nowTs)
    const reasons = []
    if (c.busy) reasons.push('busy')
    if (c.chatOpen) reasons.push('chat-open')
    if (c.gamePlaying) reasons.push('game-playing')
    if (c.userTyping) reasons.push('user-typing')
    if (!(n(c.lastInteractionAt) > 0)) reasons.push('no-interaction-ts')
    else if (nowTs > 0 && (nowTs - n(c.lastInteractionAt)) < IDLE_MIN_MS) reasons.push('recent-interaction')
    return { idle: reasons.length === 0, reasons: reasons, minMs: IDLE_MIN_MS, asOfTs: nowTs, evidenceClass: 'REAL(runtime truth)' }
  }

  /* S-2：载体（真实 id；只读；不复制内容、不改写任何记忆） */
  function carrierOf(m) {
    if (!m || !m.id) return null
    return { memoryId: String(m.id), type: String(m.type || ''), status: String(m.status || ''), date: memDate(m), evidenceClass: 'REAL(memory field)' }
  }
  /* R-8 M1（用户 ）：**既有结构化素材**的只读内存载体（pet-state.ownerBirthday／未完成 todos／
     主人活动段）。只读已有字段：**不写盘、不写 memories、不新增持久层**；id 自带来源前缀 ⇒ 每个载体都能反查
     真实来源（pet:ownerBirthday／pet:todo:<id>／tl:segment:<startTs>）。 */
  function dayOf(ts) { const d = new Date(n(ts)); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) }
  function sourceCarriers(s) {
    const src = s || {}
    const out = []
    const bd = String(src.ownerBirthday || '').trim()
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(bd)) {
      out.push({ memoryId: 'pet:ownerBirthday', type: 'fact', status: 'active', date: null, text: '主人的生日：' + bd, evidenceClass: 'REAL(existing field)' })
    }
    const todos = Array.isArray(src.todos) ? src.todos : []
    todos.filter((t) => t && t.done !== true && String(t.text || '').trim()).slice(0, 3).forEach((t) => {
      out.push({ memoryId: 'pet:todo:' + String(t.id), type: 'todo', status: 'active', date: null, text: '主人还没做完的事：' + String(t.text).trim().slice(0, 40), evidenceClass: 'REAL(existing field)' })
    })
    const segs = Array.isArray(src.segments) ? src.segments : []
    segs.filter((g) => g && g.cat).slice(-2).forEach((g) => {
      out.push({ memoryId: 'tl:segment:' + String(n(g.startTs)), type: 'timeline', status: 'active', date: n(g.startTs) > 0 ? dayOf(n(g.startTs)) : null, text: '主人今天在「' + String(g.cat) + '」上活动了 ' + String(n(g.minutes)) + ' 分钟', evidenceClass: 'REAL(existing field)' })
    })
    /* PC-1 S2a：**她自己的日记**——取 `P.diaryOutputs` 里最新一篇有正文的；
       只读既有落盘、不新增字段；没有就不生成（不编造）。日期只放 date 字段，正文不带日期数字。 */
    try {
      const dos = Array.isArray(src.diaryOutputs) ? src.diaryOutputs : []
      let last = null
      for (let i = dos.length - 1; i >= 0; i--) {
        const d = dos[i]
        if (d && d.diaryDay && String(d.text || '').trim()) { last = d; break }
      }
      if (last) {
        out.push({ memoryId: 'pet:diary:' + String(last.diaryDay), type: 'diary', status: 'active', date: String(last.diaryDay),
          text: '我自己写的日记：「' + String(last.text).trim().replace(/\s+/g, ' ').slice(0, 60) + '」', evidenceClass: 'REAL(existing field)' })
      }
    } catch (err) { /* 缺素材 ⇒ 不生成该方向 */ }
    /* PC-1 S2b：**共同历史**——主人自己说过的原话（取会话历史里最新一条 user 消息）；
       只读既有落盘、不新增字段；没有就不生成（不编造）。id 复用 pet: 前缀（下游只放行 pet:/tl:）。 */
    try {
      const rows = Array.isArray(src.history) ? src.history : []
      let lastUser = null
      for (let i = rows.length - 1; i >= 0; i--) {
        const m = rows[i]
        if (m && m.role === 'user' && String(m.text || '').trim()) { lastUser = m; break }
      }
      if (lastUser) {
        out.push({ memoryId: 'pet:chat:' + String(n(lastUser.ts)), type: 'chat', status: 'active',
          date: n(lastUser.ts) > 0 ? dayOf(n(lastUser.ts)) : null,
          text: '主人以前说过：「' + String(lastUser.text).trim().replace(/\s+/g, ' ').slice(0, 60) + '」',
          evidenceClass: 'REAL(existing field)' })
      }
    } catch (err) { /* 缺素材 ⇒ 不生成该方向 */ }
    /* PC-1 S2c：**她自己的成长**（等级／成就数／照片数，全部来自真机既有字段；一个都取不到就不生成） */
    try {
      const lv = Number(src.level)
      const achN = Array.isArray(src.achievements) ? src.achievements.length : -1
      const phN = (src.photos && typeof src.photos === 'object') ? Object.keys(src.photos).length : -1
      const parts = []
      if (Number.isFinite(lv) && lv > 0) parts.push('Lv.' + lv)
      if (achN >= 0) parts.push(achN + ' 个成就')
      if (phN >= 0) parts.push(phN + ' 张照片')
      if (parts.length) {
        out.push({ memoryId: 'pet:growth', type: 'growth', status: 'active', date: null,
          text: '我自己的成长：' + parts.join('／'), evidenceClass: 'REAL(existing field)' })
      }
    } catch (err) { /* 缺素材 ⇒ 不生成该方向 */ }
    return out
  }
  function collectCarriers(deps) {
    const d = deps || {}
    const memories = Array.isArray(d.memories) ? d.memories : []
    let episodes = []
    try {
      if (typeof d.retrieve === 'function') {
        /* 既有真实检索：intent='past_episode' 会一并取 active+fading */
        episodes = (d.retrieve({ intent: 'past_episode' }, { limit: CARRIER_LIMIT }) || []).map(carrierOf).filter(Boolean)
      }
    } catch (err) { episodes = [] }
    if (!episodes.length) {
      episodes = memories.filter((m) => m && m.type === 'episode' && (m.status === 'active' || m.status === 'fading') && !m.supersededBy)
        .sort((a, b) => n(b.updatedAt) - n(a.updatedAt))
        .slice(0, CARRIER_LIMIT).map(carrierOf).filter(Boolean)
    }
    const preferences = memories.filter((m) => m && m.type === 'preference' && m.status === 'active' && !m.supersededBy)
      .sort((a, b) => n(b.updatedAt) - n(a.updatedAt))
      .slice(0, CARRIER_LIMIT).map(carrierOf).filter(Boolean)
    const coverage = {
      ownerBackground: memories.filter((m) => m && m.subjectKey === 'user' && (m.type === 'episode' || m.type === 'fact')).length,
      ownerPresent: memories.filter((m) => m && m.subjectKey === 'user' && m.propertyKey == null).length,
      ownerPreference: memories.filter((m) => m && m.subjectKey === 'user' && m.propertyKey != null).length
    }
    return { episodes: episodes, preferences: preferences, facts: sourceCarriers(d.sources), coverage: coverage, totalMemories: memories.length }
  }

  /* S-3：规则版方向（确定性、可枚举、可审计；不生成虚构事实） */
  function generateDirections(c) {
    const out = []
    if (c && c.episodes && c.episodes.length) {
      out.push({ key: 'episode_recall:' + c.episodes[0].memoryId, type: 'episode_recall', about: 'memory:' + c.episodes[0].memoryId,
        carrier: c.episodes[0], tokens: ['episode_recall', 'episode'], evidenceClass: 'DERIVED(real carrier)' })
    }
    if (c && c.preferences && c.preferences.length) {
      out.push({ key: 'long_term_continue:' + c.preferences[0].memoryId, type: 'long_term_continue', about: 'memory:' + c.preferences[0].memoryId,
        carrier: c.preferences[0], tokens: ['long_term_continue', 'preference'], evidenceClass: 'DERIVED(real carrier)' })
    }
    if (c && c.coverage && c.coverage.ownerBackground === 0) {
      out.push({ key: 'gap_curiosity:pil.owner.background', type: 'gap_curiosity', about: 'dimension:pil.owner.background', carrier: null,
        tokens: ['gap_curiosity', 'pil.owner.background'], evidenceClass: 'DERIVED(coverage count = 0; annotation-only, NOT an absence claim)',
        evidence: { kind: 'coverage-count', dimension: 'pil.owner.background', count: 0 } })
    }
    /* R-8 M1：既有结构化素材也进方向池（**只输出"方向＋载体"**；不进评分、不改候选集与闸门语义） */
    const factList = (c && Array.isArray(c.facts)) ? c.facts : []
    factList.forEach((f) => {
      /* PC-1：她自己的素材（日记／成长）**单独立族**，其余仍是"主人的已知信息"；
         owner_known 的 key 逐字不变（`owner_known:<memoryId>`），只给新族换前缀。 */
      const isDiary = /^pet:diary:/.test(String(f.memoryId))
      const isGrowth = String(f.memoryId) === 'pet:growth'
      const isChat = /^pet:chat:/.test(String(f.memoryId))
      const fam = isDiary ? 'self_diary' : (isGrowth ? 'self_growth' : (isChat ? 'shared_history' : 'owner_known'))
      out.push({ key: fam + ':' + f.memoryId, type: fam, about: 'source:' + f.memoryId, carrier: f,
        tokens: [fam, String(f.type || '')], evidenceClass: 'DERIVED(real existing field)' })
    })
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return out
  }

  /* S-5：复发计数 + 冷却 + 封顶 + 方向空间铺开（集合运算；零随机） */
  function selectDirection(dirs, nowTs, ctx) {
    const c = ctx || {}
    const blocked = []
    let eligible = []
    /* PC-1 S3：最近一次挂池的载体若至今没换来主人任何互动 ⇒ 本轮把它挡在"未被回应"里（2h 内） */
    const una = state.lastSurfaced
    const unaAt = (una && Number.isFinite(Number(una.at))) ? Number(una.at) : 0
    const lastAct = Number.isFinite(Number(c.lastInteractionAt)) ? Number(c.lastInteractionAt) : 0
    const unaKey = (una && una.key && lastAct > 0 && lastAct < unaAt && (nowTs - unaAt) < UNANSWERED_COOLDOWN_MS) ? String(una.key) : null
    const coolKey = String(c.coolMarker || '')
    const isCooled = (d) => !!(coolKey && String((d.carrier && d.carrier.memoryId) || '').indexOf(coolKey) === 0)
    const pass = (skipKey, useCool) => {
      const out = []
      for (const d of (dirs || [])) {
        const s = state.surfaces[d.key]
        if (s && s.count >= MAX_SURFACES_PER_DIRECTION) { blocked.push({ key: d.key, reason: 'cap' }); continue }
        if (s && (nowTs - s.lastTs) < COOLDOWN_MS) { blocked.push({ key: d.key, reason: 'cooldown' }); continue }
        if (useCool && isCooled(d)) { blocked.push({ key: d.key, reason: 'cooled-family' }); continue }
        if (skipKey && d.key === skipKey) { blocked.push({ key: d.key, reason: 'unanswered' }); continue }
        out.push(d)
      }
      return out
    }
    eligible = pass(unaKey, true)
    let unansweredFallback = false
    if (!eligible.length && (unaKey || coolKey)) { eligible = pass(null, false); unansweredFallback = true }
    if (!eligible.length) return { chosen: null, blocked: blocked, eligibleCount: 0, unansweredKey: unaKey, unansweredFallback: false }
    const recentTokens = {}
    state.recent.slice(-SPREAD_WINDOW).forEach((x) => (x.tokens || []).forEach((t) => { recentTokens[t] = true }))
    const scored = eligible.map((d) => ({ d: d, overlap: (d.tokens || []).filter((t) => recentTokens[t]).length }))
    scored.sort((a, b) => (a.overlap - b.overlap) || (a.d.key < b.d.key ? -1 : a.d.key > b.d.key ? 1 : 0))
    return { chosen: scored[0].d, blocked: blocked, eligibleCount: eligible.length, unansweredKey: unaKey, unansweredFallback: unansweredFallback }
  }
  function surface(d, nowTs) {
    const s = state.surfaces[d.key] || { count: 0, lastTs: 0 }
    state.surfaces[d.key] = { count: s.count + 1, lastTs: nowTs }
    state.recent.push({ key: d.key, tokens: (d.tokens || []).slice(), atTs: nowTs })
    if (state.recent.length > SPREAD_WINDOW) state.recent = state.recent.slice(-SPREAD_WINDOW)
    const keys = Object.keys(state.surfaces)
    if (keys.length > MAX_TRACKED_DIRECTIONS) {
      keys.sort((a, b) => state.surfaces[a].lastTs - state.surfaces[b].lastTs)
      keys.slice(0, keys.length - MAX_TRACKED_DIRECTIONS).forEach((k) => { delete state.surfaces[k] })
    }
  }

  /* S-4（第一阶段：只挂载体字段）；第二阶段：追加 **内部念头候选准入载荷**（真实 carrier + 真实 evidenceRefs）。
     两件事**解耦**：①"挂上并计一次 surface"＝第一阶段语义（gap_curiosity 也照旧计数/冷却，观测不变）；
     ②"追加 internalDirection 准入载荷"＝只有真实 carrier 且非 gap_curiosity 才给（gap 是 annotation artifact
     的伪空集依据，按 S-4 不得进入 F4 候选）。 */
  function attachToPool(pool, dir) {
    const list = Array.isArray(pool) ? pool : []
    const idx = list.findIndex((c) => c && c.actionId === DIRECTION_ACTION)
    if (!dir || idx < 0) return { pool: null, attached: false, admitted: false, actionId: DIRECTION_ACTION, actionIdPresent: idx >= 0 }
    const admitted = !!(dir.carrier && typeof dir.carrier.memoryId === 'string' && dir.carrier.memoryId && dir.type !== 'gap_curiosity')
    const next = list.slice()
    const extra = { shadowDirection: { type: dir.type, about: dir.about, carrier: dir.carrier, evidenceClass: dir.evidenceClass } }
    if (admitted) {
      extra.internalDirection = {
        type: dir.type,
        about: dir.about,
        carrier: { memoryId: dir.carrier.memoryId, date: dir.carrier.date || null },
        evidenceRefs: [/^(pet|tl):/.test(dir.carrier.memoryId) ? dir.carrier.memoryId : ('mem:' + dir.carrier.memoryId)],
        evidenceClass: dir.evidenceClass,
        source: 'shadow-internal-life'
      }
    }
    next[idx] = Object.assign({}, list[idx], extra)
    return { pool: next, attached: true, admitted: admitted, actionId: DIRECTION_ACTION, actionIdPresent: true }
  }

  /* 一轮：S-1 → S-2 → S-3 → S-5 → S-4；只返回数据，不做任何 I/O 与表达 */
  function tick(input) {
    const i = input || {}
    const nowTs = n(i.nowTs)
    state.ticks += 1
    /* PC-1 S1：**封顶/冷却按本地日重置**——原实现只在应用重启或 key 表淘汰时
       归零，9 条稳定方向累计出满约 36 次后即"烧穿"，此后只剩随活动段变化的 key 还能用（实测 58% 的空闲拍因此
       被 cap/cooldown 全挡）。只清计数器与铺开窗口，**不改 cap/cooldown 取值、不改选择语义**。 */
    try {
      const dk = dayOf(nowTs)
      if (state.dayKey !== dk) { state.dayKey = dk; state.surfaces = {}; state.recent = [] }
    } catch (err) { /* 重置失败不得影响本轮 */ }
    const idle = computeIdle(Object.assign({}, i.idleCtx || {}, { nowTs: nowTs }))
    const carriers = idle.idle ? collectCarriers({ memories: i.memories, retrieve: i.retrieve, sources: i.sources }) : { episodes: [], preferences: [], facts: [], coverage: null, totalMemories: 0 }
    const directions = idle.idle ? generateDirections(carriers) : []
    /* PC-3：族降温（只认"还没过期"的；过期即视为无） */
    const coolMarker = (i.familyCool && Number(i.familyCool.until) > nowTs) ? String(i.familyCool.marker || '') : ''
    const selection = idle.idle ? selectDirection(directions, nowTs, { lastInteractionAt: n(i.idleCtx && i.idleCtx.lastInteractionAt), coolMarker: coolMarker }) : { chosen: null, blocked: [], eligibleCount: 0, unansweredKey: null, unansweredFallback: false }
    const attach = attachToPool(i.pool, selection.chosen)
    const surfaced = !!(selection.chosen && attach.attached)
    if (surfaced) surface(selection.chosen, nowTs)
    /* 第二阶段：把本轮真正进入候选池的内部方向留给 S-8（主动上下文/Guard 同批取证）用；
       只存真实 id 与日期，不存正文；带 at 供时效闸判断。 */
    state.lastSurfaced = (surfaced && attach.admitted) ? {
      at: nowTs,
      key: selection.chosen.key, /* PC-1 S3：未回冷却要按方向 key 比对 */
      type: selection.chosen.type,
      about: selection.chosen.about,
      memoryId: selection.chosen.carrier.memoryId,
      date: selection.chosen.carrier.date || null,
      /* R-8 M1：只读载体文本（内存内，仅本次同一轮用；不落盘、不进 memories） */
      text: selection.chosen.carrier.text || null,
      /* R-8 M2：与本轮账本 entryId 绑定（同源方向），供 proactiveAfterTick 判"还是那一件事" */
      entryId: null,
      evidenceClass: selection.chosen.evidenceClass,
      source: 'shadow-internal-life'
    } : null
    const s = selection.chosen ? state.surfaces[selection.chosen.key] : null
    const record = {
      v: VERSION,
      at: nowTs,
      tick: state.ticks,
      idle: { value: idle.idle, reasons: idle.reasons, minMs: idle.minMs, evidenceClass: 'REAL(runtime truth)' },
      carriers: (carriers.episodes || []).concat(carriers.preferences || []).concat(carriers.facts || []),
      coverage: carriers.coverage,
      directions: directions.map((d) => ({ key: d.key, type: d.type, about: d.about, carrierId: d.carrier ? d.carrier.memoryId : null, evidenceClass: d.evidenceClass })),
      blocked: selection.blocked,
      unansweredKey: selection.unansweredKey || null,
      unansweredFallback: selection.unansweredFallback === true,
      familyCool: coolMarker || null,
      chosen: selection.chosen ? { key: selection.chosen.key, type: selection.chosen.type, about: selection.chosen.about, carrierId: selection.chosen.carrier ? selection.chosen.carrier.memoryId : null } : null,
      poolAttach: { attached: attach.attached, admitted: attach.admitted, actionId: attach.actionId, actionIdPresent: attach.actionIdPresent },
      recurrence: selection.chosen ? { key: selection.chosen.key, count: s ? s.count : 0, cooldownUntil: s ? (s.lastTs + COOLDOWN_MS) : 0 } : null,
      trackedDirections: Object.keys(state.surfaces).length,
      evidenceClass: { carriers: 'REAL', coverage: 'DERIVED', directions: 'DERIVED', idle: 'REAL' },
      f4: null,
      silent: null
    }
    state.pending = record
    return { record: record, pool: attach.pool }
  }

  /* S-6：把本轮的 F4 结果并入观测记录（只读 r；不改 r、不影响任何判定），并落既有一行日志 */
  function observe(r, nowTs) {
    const rec = state.pending
    if (!rec) return null
    const outcome = (r && typeof r.outcome === 'string') ? r.outcome : null
    const gate = (r && typeof r.gate === 'string') ? r.gate : null
    const entryKind = (r && typeof r.entryKind === 'string') ? r.entryKind : null
    const chosenActionId = (r && r.proactive && typeof r.proactive.chosenActionId === 'string') ? r.proactive.chosenActionId : null
    const carrierActionChosen = !!(rec.chosen && chosenActionId === DIRECTION_ACTION)
    const finalRec = Object.assign({}, rec, {
      observedAt: n(nowTs),
      f4: { outcome: outcome, gate: gate, entryKind: entryKind, chosenActionId: chosenActionId, carrierActionChosen: carrierActionChosen },
      silent: !(rec.chosen && carrierActionChosen)
    })
    /* R-8 M2：把"这一轮真正选中载体"的账本 entryId 绑到 lastSurfaced（**内存内**，不新增持久状态） */
    if (carrierActionChosen && state.lastSurfaced) {
      state.lastSurfaced.entryId = (r && r.proactive && r.proactive.entryId) || null
    }
    try { console.log('shadow-internal-life ' + JSON.stringify(finalRec)) } catch (err) { /* 观测不得影响主循环 */ }
    ring.push(finalRec)
    if (ring.length > LOG_RING_MAX) ring.shift()
    state.pending = null
    return finalRec
  }

  function assertSeals() {
    const keys = Object.keys(apiRef)
    const hits = keys.filter((k) => FORBIDDEN_API_KEYS.some((f) => k.toLowerCase().indexOf(f) >= 0))
    return { ok: hits.length === 0, hits: hits, keys: keys }
  }
  function reset() { state.surfaces = {}; state.recent = []; state.ticks = 0; state.pending = null; ring.length = 0; return true }

  const apiRef = {
    VERSION: VERSION,
    IDLE_MIN_MS: IDLE_MIN_MS,
    COOLDOWN_MS: COOLDOWN_MS,
    MAX_SURFACES_PER_DIRECTION: MAX_SURFACES_PER_DIRECTION,
    MAX_TRACKED_DIRECTIONS: MAX_TRACKED_DIRECTIONS,
    SPREAD_WINDOW: SPREAD_WINDOW,
    DIRECTION_ACTION: DIRECTION_ACTION,
    UNANSWERED_COOLDOWN_MS: UNANSWERED_COOLDOWN_MS,
    computeIdle: computeIdle,
    collectCarriers: collectCarriers,
    generateDirections: generateDirections,
    selectDirection: selectDirection,
    attachToPool: attachToPool,
    tick: tick,
    observe: observe,
    assertSeals: assertSeals,
    reset: reset,
    getLog: function () { return ring.slice() },
    getLastSurfaced: function () { return state.lastSurfaced ? JSON.parse(JSON.stringify(state.lastSurfaced)) : null },
    clearLastSurfaced: function () { state.lastSurfaced = null; return true },
    getState: function () { return { surfaces: JSON.parse(JSON.stringify(state.surfaces)), recent: JSON.parse(JSON.stringify(state.recent)), ticks: state.ticks } }
  }
  try { window.ShadowInternalLife = apiRef } catch (err) { /* 非浏览器环境由调用方接收 */ }
  return apiRef
})()
/* ===== [SHADOW-IL-END] ===== */
/* PC-1 S2b：**共同历史**（主人自己说过的原话）只读缓存。
   零新增持久化字段、零新增定时器：借用既有 60s 心跳，每 5 分钟最多刷一次；失败保持旧值（不编造）。
   刻意放在 SHADOW-IL 封条块**之外** ⇒ 不改动该模块的"无 I/O"封条。 */
let chatHistoryCache = []
let chatHistoryCacheAt = 0
let chatHistoryRefreshing = false
function refreshChatHistoryCache() {
  try {
    if (chatHistoryRefreshing) return
    if (Date.now() - chatHistoryCacheAt < 5 * 60 * 1000) return
    const api = (window.pet && typeof window.pet.characterHistoryLoad === 'function') ? window.pet : null
    if (!api) return
    chatHistoryRefreshing = true
    const pr = api.characterHistoryLoad()
    if (pr && typeof pr.then === 'function') {
      pr.then(function (rows) { chatHistoryCache = Array.isArray(rows) ? rows : []; chatHistoryCacheAt = Date.now() })
        .catch(function () { /* 读失败保持旧缓存，不伪造 */ })
        .then(function () { chatHistoryRefreshing = false })
    } else { chatHistoryRefreshing = false }
  } catch (err) { chatHistoryRefreshing = false }
}
const __lcBasePayload = lifeContextTickPayload
lifeContextTickPayload = function () {
  try { LifeContextEventTap.install(window.EmotionEngine, window.EventBus, P) } catch (e) { /* 安装失败不影响 payload */ }
  lifeContextRefreshSessions() // 每轮触发一次刷新；payload 使用最近一次成功取得的真值
  const p = __lcBasePayload() || {}
  try {
    const d = LifeContextEventTap.drain()
    p.events = d.events
    if (d.dropped > 0) { try { console.warn('[life-context] event tap dropped ' + d.dropped) } catch (e) {} }
  } catch (e) { /* 保持原值 */ }
  try { p.gates = Object.assign({}, p.gates || {}, { ownerBusy: !!(R.busy || chatBusy || (game && game.playing) || document.activeElement === $('chat-input')) }) } catch (e) {}
  /* CC-1：面板角色聊天在飞（charcBusy）也应视为"主人正忙"⇒ 计入 F7 第 3 道
     抑制器 owner-busy。**纯追加、不改既有行**；不动 Shadow 的 idleCtx.busy（那是只读观测，改它会动 P1-S 读数基线）。 */
  try { if (charcBusy) p.gates.ownerBusy = true } catch (e) {}
  try { p.permission = Object.assign({}, p.permission || {}, { sessions: lifeContextSessions }) } catch (e) {}
  /* S-1…S-4（Shadow Mode）：唯一时序入口＝既有心跳（本函数由 60s Scheduler 调用）。
     只读记忆与既有运行态；结果只作 p.shadow 观测 + 把"方向+载体"挂到**既有**池候选上（不改分/不增候选）。
     任何异常都不得影响 payload 构造（外层 try/catch 兜底）。 */
  try { refreshChatHistoryCache() /* PC-1 S2b：只读缓存，最坏空数组 */ } catch (e) {}
  try {
    if (window.PetLife) {
      const c = window.CharacterSnapshot.toCharacterAIContext('')
      const input = { nowTs: Date.now(), selfState: c.selfState, emotion: c.emotion,
        persona: c.personaProjection, busy: !!(R.busy || chatBusy || charcBusy || (game && game.playing)),
        visible: !R.hidden, availableActions: R.hidden ? [] : Object.keys(window.LivingPresence.ACTIONS).filter(id => !!$('anim-' + id) && !failedAnimations.has(id)),
        aiEnabled: !!proactiveOn, memories: window.MemoryEngine ? window.MemoryEngine.getMemories() : [] }
      input.aiEnabled = false
      // PetLife domain progression is awaited at the tick result, not started while building a read payload.
      if (window.PetLife.snapshot().ready) {
        p.runtime.semanticTopics = true
        const topics = window.PetLife.candidates({ nowTs: input.nowTs, memories: input.memories,
          history: chatHistoryCache, reality: window.lifeRealityForPrompt(), events: c.recentEvents })
        if (Date.now() < roleRuntime.snapshot().quietUntil) p.pool = (p.pool || []).filter(x => !['seek_attention', 'comment_on_activity', 'accompany_owner', 'celebrate'].includes(x.actionId))
        const motive = topics.find(t => t.source !== 'environment')
        if (!input.busy && motive && Date.now() >= roleRuntime.snapshot().quietUntil) {
          const loneliness = Number(c.emotion && c.emotion.values && c.emotion.values.loneliness) || 0
          const candidate = { actionId: 'seek_attention', score: 55 + Math.min(15, loneliness * 15), priority: 0, source: 'pet-life',
            internalDirection: { type: 'living_motive', about: motive.id, carrier: { memoryId: motive.id }, evidenceRefs: ['pet:life:' + motive.id] } }
          p.pool = (p.pool || []).filter(x => x.actionId !== candidate.actionId).concat([candidate])
        }
      }
    }
  } catch (err) { console.warn('[pet-life] context failed:', err.message) }
  if (p.runtime.semanticTopics === true) return p
  try {
    const __sh = ShadowInternalLife.tick({
      nowTs: Date.now(),
      idleCtx: {
        busy: !!(R.busy || chatBusy || (game && game.playing)),
        chatOpen: !!R.chatOpen,
        gamePlaying: !!(game && game.playing),
        userTyping: document.activeElement === $('chat-input'),
        lastInteractionAt: Number(P.lastInteractionAt) || 0
      },
      memories: (window.MemoryEngine && typeof window.MemoryEngine.getMemories === 'function') ? window.MemoryEngine.getMemories() : [],
      retrieve: (window.MemoryRetrieval && typeof window.MemoryRetrieval.retrieve === 'function') ? window.MemoryRetrieval.retrieve : null,
      /* R-8 M1：既有结构化素材的**只读**来源（ownerBirthday／未完成 todos／本轮 reality 的活动段）；不写盘 */
      sources: {
        ownerBirthday: P.ownerBirthday || '',
        todos: Array.isArray(P.todos) ? P.todos : [],
        segments: (lifeContextReality && Array.isArray(lifeContextReality.segments)) ? lifeContextReality.segments : [],
        /* PC-1 S2a/S2c：她自己的素材（日记／成长）——**只读既有字段**，不新增任何持久化状态 */
        diaryOutputs: Array.isArray(P.diaryOutputs) ? P.diaryOutputs : [],
        level: Number(P.level) || 0,
        achievements: Array.isArray(P.achievements) ? P.achievements : [],
        photos: (P.photos && typeof P.photos === 'object') ? P.photos : {},
        /* PC-1 S2b：共同历史（只读内存缓存；没有就是空数组 ⇒ 不生成该方向） */
        history: Array.isArray(chatHistoryCache) ? chatHistoryCache : []
      },
      pool: p.pool,
      /* PC-3：被否证/没兴趣的素材族降温（内存态；无则 null） */
      familyCool: proactiveFamilyCool
    })
    if (__sh && __sh.pool) p.pool = __sh.pool
    if (__sh && __sh.record) p.shadow = __sh.record
  } catch (e) { /* Shadow Mode 不得影响 payload 构造 */ }
  return p
}

})()
















