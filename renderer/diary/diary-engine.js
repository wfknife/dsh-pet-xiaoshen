/* DiaryEngine — 3.0-09
 * Local-first end-of-day narrative provider.
 *
 * Diary is an off-main-chain daily summary. It:
 *   - resolves diaryDay through the single DiaryDayResolver
 *   - builds a read-only DailyContext from verified facts
 *   - always can compose a complete local narrative
 *   - may request AIGateway at most once per diaryDay
 *   - never writes Persona/Relationship/Emotion/Memory/Intent/Behavior
 *   - never turns AI text into facts or Memory automatically
 */
window.DiaryEngine = (function () {
  const SCHEMA_VERSION = 1
  const DEFAULT_DIARY_TIME = '23:00'
  const MAX_AI_CALLS_PER_DAY = 1
  /* #1：MIN_LENGTH 从 60 降到 20。
     背景：AI 端的 claimGuard 在"记忆引用缺支持"时会把整段替换成 12 字兜底句
     '我不太确定，所以不想乱说。'，12 < 60 ⇒ 被判 too_short ⇒ 整篇被丢弃 ⇒ 回落本地模板。
     修复后：AI 结果只要"非空且达到合理最小长度"即通过，不再用高门槛卡掉自然短篇。 */
  const MIN_LENGTH = 20
  const TARGET_MIN = 120
  const TARGET_MAX = 420
  const HALLUCINATE_WORDS = ['西瓜', '饼干', '风扇', '零食', '冰镇', '冰西瓜', '奶茶', '咖啡', '雪糕', '空调', '糖水']
  const FISH_WORDS = ['蓝色大肥鱼', '大肥鱼', '尾巴尖', '蜷成', '鱼鳍', '赖在脚边', '赖着不走']
  const TIME_GROUPS = [['凌晨', '深夜', '半夜', '午夜'], ['清晨', '早晨'], ['上午'], ['中午', '正午'], ['下午', '午后'], ['傍晚', '黄昏'], ['晚上', '夜间', '夜晚', '夏夜']]

  const outputs = {} // diaryDay -> DiaryOutput
  const diagnostics = {
    resolverDecisions: [],
    generationStarted: 0,
    generationFinished: 0,
    aiRequested: 0,
    aiSkipped: 0,
    aiLatency: null,
    fallbackReason: null,
    duplicateSuppressed: 0,
    persistenceResult: null,
    aiRequestsByDay: {}
  }
  let aiEnabled = false
  let persistenceHandler = null
  let aiRequestConsumedHandler = null // optional: (diaryDay, count) => void
  /* 随机源可注入（默认 Math.random）。
     动机：本地模板的"加权随机选句"是随机的，而验收断言（单句 ≤3 次）恰好卡在分布边界上
     ⇒ 同一个测试时而红时而绿（实测重跑 5 次失败 2 次）。
     现在测试可注入**确定性随机源**（固定种子 PRNG），既保住"单句 ≤3 次"的产品契约，
     又让回归结果可复现。生产路径不设置它，行为与之前完全一致（仍是 Math.random）。 */
  let randomSource = () => Math.random()
  function setRandomSource(fn) {
    randomSource = (typeof fn === 'function') ? fn : (() => Math.random())
  }

  function pad(n) { return String(n).padStart(2, '0') }
  // D0：本地模板选句用随机源（不依赖 diaryDay seed，避免"同一天永远同句"）
  function rnd() { return randomSource() }
  function isTestContent(text) {
    return /MEMTEST|MEMDBG|test-memory|mock|fixture|本地默认台词|开心台词|测试重要约定|时间边界重要事项/.test(String(text || ''))
  }


  function localCalendarDate(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  /* DiaryDay 单一来源：renderer/diary/diary-day.js（main / renderer / 本引擎共用）。
     本函数只做 DiaryEngine 的诊断与 targetDiaryDay 包装，不再自行实现日界算法。 */
  function resolveDiaryDay(now, diaryTime, targetDiaryDay) {
    const ts = typeof now === 'number' ? now : Date.now()
    const time = String(diaryTime || DEFAULT_DIARY_TIME)
    const target = targetDiaryDay && /^\d{4}-\d{1,2}-\d{1,2}$/.test(String(targetDiaryDay)) ? String(targetDiaryDay) : null
    let resolved = null
    try {
      if (window.DiaryDay && typeof window.DiaryDay.resolve === 'function') {
        resolved = window.DiaryDay.resolve(ts, time)
      }
    } catch (err) { /* fall through to calendar fallback */ }
    const calendarDate = resolved ? resolved.calendarDate : localCalendarDate(new Date(ts))
    const diaryDay = target || (resolved ? resolved.diaryDay : calendarDate)
    const decision = {
      calendarDate: calendarDate,
      diaryDay: diaryDay,
      diaryTime: resolved ? resolved.diaryTime : time,
      reached: resolved ? !!resolved.reached : true,
      targetDiaryDay: target || null
    }
    diagnostics.resolverDecisions.push({ ts: ts, ...decision })
    if (diagnostics.resolverDecisions.length > 50) diagnostics.resolverDecisions.shift()
    return decision
  }

  function weekdayName(d) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return names[d.getDay()]
  }

  function seasonOf(month) {
    if (month >= 3 && month <= 5) return '春天'
    if (month >= 6 && month <= 8) return '夏天'
    if (month >= 9 && month <= 11) return '秋天'
    return '冬天'
  }

  function eventScore(e) {
    const kind = String(e && e.kind || '')
    const text = String(e && e.text || '')
    if (kind === 'pet_life') return e.lifeKind === 'conversation' ? 14 : (e.lifeKind === 'completed' ? 12 : 10)
    const isStatText = /((喂食|玩|完成|工作|游戏|番茄)[^，。]{0,4}[0-9一二三四五六七八九十]+(次|局|项|个|小时|分钟))/.test(text) && !/(聊|陪|一起|关系|重要|第一次|夸|纪念|特殊)/.test(text)
    if (isStatText) return 3
    if (['relationship', 'important', 'chat', 'pin'].indexOf(kind) >= 0) return 14
    if (['milestone', 'first', 'special_milestone', 'first_work', 'first_game'].indexOf(kind) >= 0) return 13
    if (['praise', 'accompany_owner', 'special'].indexOf(kind) >= 0) return 12
    if (['feed', 'game'].indexOf(kind) >= 0) return 9
    if (['task_complete', 'work', 'pomo'].indexOf(kind) >= 0) return 6
    return 4
  }

  function rankImportantEvents(events, limit) {
    const list = (events || []).map((e, idx) => ({
      ...e,
      _score: eventScore(e) + (e.importance || 0),
      _idx: idx
    }))
    list.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score
      return a._idx - b._idx
    })
    const n = Math.max(1, Math.min(Number(limit) || 5, 8))
    const seen = new Set(), counts = new Map()
    return list.filter(e => {
      const key = String(e.kind) + ':' + String(e.text || '').replace(/\s+/g, '')
      if (seen.has(key) || (counts.get(e.kind) || 0) >= 2) return false
      seen.add(key); counts.set(e.kind, (counts.get(e.kind) || 0) + 1)
      return true
    }).slice(0, n).map(({ _score, _idx, ...e }) => ({ ...e, text: e.text || '', ts: e.ts || null }))
  }

  function dateFromKey(key) {
    const parts = String(key || '').split('-').map(Number)
    if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return new Date()
    return new Date(parts[0], parts[1] - 1, parts[2])
  }

  function isPreviousDay(day, current) {
    const d = dateFromKey(day)
    const c = dateFromKey(current)
    return Math.round((c - d) / 86400000) === 1
  }

  // DiaryEngine owns the single time source for all narrative date text.
  function createDiaryContext(input) {
    const now = input && typeof input.now === 'number' ? input.now : Date.now()
    const resolver = resolveDiaryDay(now, input && input.diaryTime, input && input.targetDiaryDay)
    const target = dateFromKey(resolver.diaryDay)
    const targetCalendar = {
      date: resolver.diaryDay,
      weekday: weekdayName(target),
      season: seasonOf(target.getMonth() + 1),
      festival: []
    }
    try {
      if (window.HolidayUtil && typeof window.HolidayUtil.getHoliday === 'function') {
        const h = window.HolidayUtil.getHoliday(target.getFullYear(), target.getMonth() + 1, target.getDate())
        if (h) targetCalendar.festival.push(typeof h.getName === 'function' ? h.getName() : String(h))
      }
    } catch (err) { /* ignore */ }
    return {
      schemaVersion: SCHEMA_VERSION,
      diaryDay: resolver.diaryDay,
      displayDate: resolver.diaryDay,
      calendarDate: resolver.calendarDate,
      currentDate: resolver.calendarDate,
      weekday: targetCalendar.weekday,
      season: targetCalendar.season,
      calendar: targetCalendar,
      resolver,
      generatedAt: now,
      relativeDateContext: resolver.diaryDay === resolver.calendarDate ? '今天' : (isPreviousDay(resolver.diaryDay, resolver.calendarDate) ? '昨天' : '那天')
    }
  }

  function memoryDateKey(m) {
    if (!m || typeof m !== 'object') return null
    if (typeof m.date === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/.test(m.date)) return m.date
    const ts = typeof m.eventTime === 'number' ? m.eventTime : (typeof m.createdAt === 'number' ? m.createdAt : (typeof m.ts === 'number' ? m.ts : null))
    if (ts !== null) return localCalendarDate(new Date(ts))
    return null
  }

  function isPastMemory(m, diaryDay) {
    const d = memoryDateKey(m)
    if (!d || !diaryDay) return false
    return dateFromKey(d).getTime() < dateFromKey(diaryDay).getTime()
  }

  function isManualMemory(m) {
    return !!(m && (
      m.manual === true ||
      m.type === 'manual' ||
      (Array.isArray(m.tags) && m.tags.indexOf('manual') >= 0) ||
      (m.sourceType === 'user' && m.explicitRemember === true)
    ))
  }

  function memorySearchText(m) {
    const tags = m && Array.isArray(m.tags) ? m.tags.join(' ') : ''
    return String(((m && (m.content || m.text)) || '') + ' ' + tags).toLowerCase()
  }

  function eventKeywords(kind) {
    if (kind === 'game') return ['游戏', '玩', 'game', '主人', '第一次']
    if (kind === 'feed') return ['喂', '吃', '零食', 'feed', '主人', '第一次']
    if (kind === 'chat' || kind === 'relationship' || kind === 'important') return ['聊', '陪', '说话', '一起', 'chat', '主人', '第一次']
    if (kind === 'work' || kind === 'task_complete') return ['工作', '任务', 'work', '主人', '第一次']
    if (kind === 'pomo') return ['番茄', '专注', 'pomo', '主人', '第一次']
    return ['一起', '小深', '主人', '第一次']
  }

  function isMemoryRelevant(m, events) {
    if (!events || !events.length) return false
    const memText = memorySearchText(m)
    return events.some((e) => {
      const kws = eventKeywords(e.kind).filter(k => !['主人', '第一次', '一起', '小深', '聊', '陪', '说话', 'chat'].includes(k))
      const topic = String(e.text || '').replace(/主人跟我说|主人说|主人|小深|今天|一起|想|我|的/g, ' ').match(/[\u4e00-\u9fff]{2,}|[a-zA-Z]{3,}/g) || []
      for (const word of topic) { if (word.length <= 4) kws.push(word); else for (let i = 0; i < word.length - 1; i++) kws.push(word.slice(i, i + 2)) }
      return kws.some((k) => memText.indexOf(k) >= 0)
    })
  }

  function sanitizePastMemoryText(text) {
    let t = String(text || '').trim()
    t = t.replace(/^(以前|曾经|那时候|过去)[，,：:\s]*/, '')
    t = t.replace(/今天/g, '那天')
    return t
  }

  function usedPastMemoryIds(diaryDay) {
    const ids = new Set()
    for (const o of Object.values(outputs)) {
      if (!o || o.diaryDay === diaryDay) continue
      for (const ref of (o.memoryRefs || [])) {
        if (typeof ref === 'string' && ref) ids.add(ref)
      }
    }
    return ids
  }

  function buildExperienceContext(ctx) {
    const diaryDay = ctx && ctx.diaryDay
    const events = (ctx && ctx.importantEvents) || []
    const memories = (ctx && ctx.memoryRefs) || []
    const rel = (ctx && ctx.relationshipSummary) || {}
    const rawEmotion = (ctx && ctx.emotionSummary) || {}
    const emo = { ...(rawEmotion.values || rawEmotion), derivedMood: rawEmotion.derivedMood }
    const ownerKinds = ['work', 'game', 'feed', 'chat', 'pomo', 'task_complete', 'milestone', 'first_work', 'first_game', 'relationship', 'important']
    const hasOwnerInteraction = events.some((e) => ownerKinds.indexOf(e.kind) >= 0)
    const highlight = events.length ? events[0] : null
    /* A 方案第③项：叙事投影补 `sourceRef` / `confidence`（3.1 基线要求"只读投射带来源与置信度"）。
       只加字段、不改任何既有措辞；confidence 口径：本地计数/用户手记＝确定性(≈1.0)｜引擎状态＝0.9｜过去记忆＝0.6（非今日事实）。 */
    const evRef = (e, i) => 'event:' + String((e && (e.kind || e.id)) || ('#' + i))
    const todayExperiences = events.slice().map((e, i) => Object.assign({}, e, {
      sourceRef: (e && (e.sourceRef || e.ref)) ? (e.sourceRef || e.ref) : evRef(e, i),
      confidence: Number.isFinite(Number(e && e.confidence)) ? Number(e.confidence) : 0.9
    }))
    const usedIds = usedPastMemoryIds(diaryDay)
    const memoryKey = (m) => m.id || m.content || m.text || ''
    const pastMemories = memories
      .filter((m) => !isManualMemory(m) && isPastMemory(m, diaryDay) && isMemoryRelevant(m, events) && !usedIds.has(memoryKey(m)))
      .map((m) => ({
        text: sanitizePastMemoryText(m.content || m.text || ''),
        date: memoryDateKey(m),
        eventTime: memoryDateKey(m),
        temporalRole: 'past_memory',
        sourceRef: 'memory:' + String(m.id || memoryKey(m)).slice(0, 40),
        confidence: 0.6
      }))
    const manualMemories = memories
      .filter((m) => isManualMemory(m) && (!memoryDateKey(m) || dateFromKey(memoryDateKey(m)).getTime() <= dateFromKey(diaryDay).getTime()) && isMemoryRelevant(m, events))
      .map((m) => ({
        text: m.content || m.text || '',
        eventTime: m.createdAt || m.eventTime || memoryDateKey(m),
        temporalRole: 'manual_memory',
        sourceRef: 'memory:' + String(m.id || memoryKey(m)).slice(0, 40),
        confidence: 1
      }))
    /* D0：关系句从"单串常量"改为**同义词池 + 权重**。
       旧实现 affection>=60 恒为 '熟悉而安心' ⇒ 审计实测 11/19 篇复读同一句。
       权重表示"这种说法在语气上有多自然/多常用"，不是概率精确值。 */
    let relationshipFeeling = '还在慢慢靠近'
    let relationshipPool = ['还在慢慢熟悉', '慢慢熟起来的一点点亲近', '还隔着一层，但已经在靠近']
    let relationshipWeights = [3, 2, 1]
    if (typeof rel.affection === 'number') {
      if (rel.affection >= 60) {
        relationshipPool = ['熟悉而安心', '已经很熟，不需要多说', '像是放在手边的旧物，安心', '闭着眼也能认出来的熟悉']
        relationshipWeights = [2, 3, 2, 1]
        relationshipFeeling = pickWeighted(relationshipPool, relationshipWeights, 'rel-60')
      } else if (rel.affection >= 30) {
        relationshipPool = ['还算亲近', '比一开始自然多了', '有点熟，但还没有完全熟透']
        relationshipWeights = [2, 3, 2]
        relationshipFeeling = pickWeighted(relationshipPool, relationshipWeights, 'rel-30')
      } else {
        relationshipFeeling = pickWeighted(relationshipPool, relationshipWeights, 'rel-0')
      }
    } else {
      relationshipFeeling = pickWeighted(relationshipPool, relationshipWeights, 'rel-0')
    }
    let emotionalTone = '平静'
    if (emo.derivedMood === 'tired') emotionalTone = '有一点累，但心里踏实'
    else if (emo.derivedMood === 'cheerful') emotionalTone = '像是轻轻跳起来'
    else if (emo.derivedMood === 'lonely') emotionalTone = '有点想念主人'
    else if (emo.derivedMood === 'annoyed') emotionalTone = '有一点烦闷'
    else if (typeof emo.happiness === 'number' && emo.happiness >= 0.6) emotionalTone = '心情不错'
    return {
      highlightEvent: highlight,
      highlightedText: highlight ? (highlight.text || '') : '',
      todayExperiences,
      pastMemories,
      manualMemories,
      ownerPresence: hasOwnerInteraction ? 'present' : (events.length ? 'partial' : 'absent'),
      relationshipFeeling,
      emotionalTone,
      /* A 方案第③项：来源与置信度（只读；供 prompt/审计引用，不写回任何域） */
      day: diaryDay,
      sourceRefs: {
        relationship: 'relationship',
        emotion: 'emotion',
        ownerPresence: 'events',
        highlight: highlight ? evRef(highlight, 0) : null
      },
      confidence: {
        relationship: typeof rel.affection === 'number' ? 0.9 : 0.4,
        emotion: (emo.derivedMood || typeof emo.happiness === 'number') ? 0.9 : 0.5,
        ownerPresence: hasOwnerInteraction ? 0.95 : (events.length ? 0.6 : 0.3)
      }
    }
  }

  function buildContext(input, diaryContext) {
    const dc = diaryContext || createDiaryContext(input || {})
    let snap = null
    try {
      if (window.CharacterSnapshot && typeof window.CharacterSnapshot.toDiaryContext === 'function') snap = window.CharacterSnapshot.toDiaryContext()
    } catch (err) { /* ignore */ }
    const date = dateFromKey(dc.diaryDay)
    const start = date.getTime(), end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
    const belongs = e => {
      if (!e || isTestContent(e.text || e.userText)) return false
      const ts = Number(e.ts)
      if (Number.isFinite(ts) && ts > 0) return ts >= start && ts < end && ts <= dc.generatedAt
      if (e.ts !== undefined && e.ts !== null) return false
      return !(e.day || e.date) || (e.day || e.date) === dc.diaryDay
    }
    const events = Array.isArray(input && input.events) ? input.events.filter(belongs) : []
    const important = rankImportantEvents(events, (input && input.topEvents) || 5)
    const rawLife = window.PetLife ? window.PetLife.context(dc.generatedAt, dc.diaryDay, window.MemoryEngine ? window.MemoryEngine.getMemories() : []) : null
    const life = rawLife ? { ...rawLife, experiences: (rawLife.experiences || []).filter(belongs), conversations: (rawLife.conversations || []).filter(belongs) } : null
    if (life && life.ready) life.experiences.filter(e => ['completed', 'paused', 'conversation'].includes(e.kind)).slice(-4).forEach(e => {
      if (!important.some(existing => existing.text === e.text)) important.push({ ...e, kind: 'pet_life', lifeKind: e.kind })
    })
    if (life && life.ready) important.splice(0, important.length, ...rankImportantEvents(important, (input && input.topEvents) || 5))
    const ctx = {
      schemaVersion: SCHEMA_VERSION,
      diaryDay: dc.diaryDay,
      diaryContext: dc,
      calendar: dc.calendar || { date: dc.diaryDay, weekday: dc.weekday, season: dc.season, festival: [] },
      activitySummary: (input && input.activitySummary) || { reliable: false },
      importantEvents: important,
      interactionSummary: (input && input.interactionSummary) || {},
      relationshipSummary: (input && input.relationshipSummary) || (snap && snap.relationship) || {},
      emotionSummary: (input && input.emotionSummary) || (snap && snap.emotion) || {},
      memoryRefs: Array.isArray(input && input.memoryRefs) ? input.memoryRefs.filter((m) => !isTestContent(m && (m.content || m.text))).slice() : (Array.isArray(snap && snap.recentMemory) ? snap.recentMemory.filter((m) => !isTestContent(m && (m.content || m.text))).slice() : []),
      albumRefs: Array.isArray(input && input.albumRefs) ? input.albumRefs.slice() : [],
      petSummary: (input && input.petSummary) || {},
      resolver: dc.resolver,
      characterSnapshot: snap
    }
    ctx.petLife = life
    ctx.memoryRefs = ctx.memoryRefs.filter(m => isMemoryRelevant(m, important) &&
      (isPastMemory(m, ctx.diaryDay) || (isManualMemory(m) && (!memoryDateKey(m) || dateFromKey(memoryDateKey(m)).getTime() <= dateFromKey(ctx.diaryDay).getTime()))))
    ctx.experience = buildExperienceContext(ctx)
    return ctx
  }

  function diarySeed(s) {
    let h = 0
    for (const ch of String(s || '')) h = (h * 31 + ch.charCodeAt(0)) % 100000
    return h
  }

  function pickVariant(arr, seed) {
    if (!arr || !arr.length) return ''
    return arr[Math.abs(seed) % arr.length]
  }

  /* D0：本地模板去复读。
     旧实现用 diaryDay 派生 seed 取模选句 ⇒ 同一篇永远同句、跨篇按固定周期复读
     （审计实测：11/19 篇出现同一句"和主人的关系，熟悉而安心"）。
     新实现 = **加权随机 + 近期去重**：权重可配（数字大者优先）；并且先把"最近说过的说法"排名靠后，
     使同一句式不会在近乎连续的几篇里反复出现。
     ⚠ 关键：去重依据必须来自**盘上的历史日记**（outputs），不能只靠进程内 Map——
     桌宠一重启内存就归零，而旧日记还在，那样会立刻复读（首版 D0 就栽在这里）。

     ⚠⚠ 2026-09-17 修复（S1 句池契约收口）：上面那套"重排 + 权重"**曾经是无效的** ——
     `pickWeighted()` 内部第一步就把传入数组 `shuffled()` 重新打乱，
     所以 `pick2` 里 `rankByRecency()` 做的"把用过的排到后面"在下一步被洗掉了；
     真正起作用的只剩 `_pickHistory`（进程内、只记最近 6 次）——
     于是"最近 10 篇说过的话"根本没被硬性避开，实测 60 组随机里约 20% 会出现某句结尾句 4 次（契约 ≤3）。
     现在改成**硬排除 + 逐级放宽**：优先从"最近 14 天内没说过的句子"里选；
     池子太小才逐级放宽到 7 天 / 3 天 / 全池。池子 ≥3 句时，这保证了同一句在连续 3 篇内不会重复。 */
  const _pickHistory = new Map() // poolKey -> [句子（最近用的在前）]
  const PICK_HISTORY_MAX = 6
  /* （S1）：跨篇硬约束用的"最近说过的话"分档集合（由 composeNarrative 每次生成前刷新）。
     从宽到严：14 天 → 7 天 → 3 天；pickWeighted 逐级放宽，池子太小时自动退回全池。 */
  let _recentTiers = []
  /* 最近 10 篇里各句出现**次数**（跨篇契约的真正依据） */
  let _recentCounts = {}
  /* 先做一次 Fisher-Yates 打乱，再用"按位置"的权重取 —— 每个句子的权重期望不变，
     同时消除调用方排序（如按历史把"用过的"排到队尾）带来的位置偏差。 */
  function shuffled(arr) {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const t = a[i]; a[i] = a[j]; a[j] = t
    }
    return a
  }
  /* 硬排除：按"最近 N 天没用过"逐级放宽，保证永远有候选（不会因为池子太小返回空） */
  function excludeRecent(pool, recentByTier) {
    for (const set of recentByTier) {
      if (!set || !set.size) continue
      const fresh = pool.filter((s) => !set.has(s))
      /* 至少留 2 个候选，否则放宽到下一档（池子只有 1~2 句时直接返回全池） */
      if (fresh.length >= Math.min(2, pool.length)) return fresh
    }
    return pool
  }
  /* 按句子文本查权重（排除后下标会变，不能按下标配权重） */
  function weightsByText(pool, weights) {
    const out = {}
    for (let i = 0; i < pool.length; i++) {
      const v = Array.isArray(weights) ? weights[i] : (typeof weights === 'number' ? weights : 1)
      out[pool[i]] = (typeof v === 'number' && v > 0) ? v : 0
    }
    return out
  }
  /* （S1 真正的契约保障）：候选收敛 = **先"最少使用"、再"最近 14 天没用过"**。
     两道一起才稳：
       · 最少使用（按近期出现次数）保证"用得少的先被选到"，不被高权重句垄断；
       · 14 天排除保证"刚说过的句子"先退场（池子只有 5 句时，10 篇内每句至多 2~3 次）。
     只做排除会退化（fresh 不够时回退全池），只做计数则高权重句仍可能被反复抽中。 */
  function leastUsedCandidates(pool, counts, freshSet) {
    let cand = pool
    /* 计数查表：池子里的候选可能是历史整句的**后半截**
       （池子 = `熟悉而安心`，历史整句 = `和主人的关系，熟悉而安心`）⇒
       先查归一化后的精确键，查不到再查"包含该片段"的键（取最大值，保守估计）。 */
    const countOf = (s) => {
      if (!counts) return 0
      const k = normKey(s)
      if (counts[k] !== undefined) return Number(counts[k]) || 0
      let best = 0
      for (const key of Object.keys(counts)) {
        if (k.length >= 4 && key.indexOf(k) >= 0) best = Math.max(best, Number(counts[key]) || 0)
      }
      return best
    }
    if (counts && pool.length >= 2) {
      let min = Infinity
      const cs = cand.map((s) => { const c = countOf(s); if (c < min) min = c; return c })
      if (Number.isFinite(min)) {
        const best = cand.filter((_, i) => cs[i] === min)
        if (best.length) cand = best
      }
    }
    if (freshSet && freshSet.size && cand.length > 1) {
      const isUsed = (s) => {
        const k = normKey(s)
        if (freshSet.has(k)) return true
        for (const key of freshSet) { if (k.length >= 4 && key.indexOf(k) >= 0) return true }
        return false
      }
      const fresh = cand.filter((s) => !isUsed(s))
      if (fresh.length >= Math.min(2, cand.length)) cand = fresh
    }
    return cand
  }
  function pickWeighted(arr, weights, poolKey, usedSet) {
    if (!arr || !arr.length) return ''
    if (arr.length === 1) return arr[0]
    /* （S1）：①"最少使用 + 近期排除"决定候选批次（契约保障）；②批内按权重随机。 */
    const cand = leastUsedCandidates(arr, _recentCounts, (_recentTiers && _recentTiers[0]) || null)
    const a = shuffled(cand)
    const baseW = (i) => {
      const v = Array.isArray(weights) ? weights[i] : (typeof weights === 'number' ? weights : 1)
      return (typeof v === 'number' && v > 0) ? v : 0
    }
    /* 排除后下标会变：权重按**句子文本**查（不能按下标，见上） */
    const W = weightsByText(arr, weights)
    const w = a.map((s) => (W[s] === undefined ? 1 : W[s]))
    let total = w.reduce((x, y) => x + y, 0)
    if (!(total > 0)) { for (let i = 0; i < w.length; i++) w[i] = 1; total = w.length }
    const key = String(poolKey || 'pool')
    const history = _pickHistory.get(key) || []
    /* 权重倍率：越近期用过优先级越低（最近 1 次 ×0.07 … 第 6 次 ×0.5 ＜ 没用过 ×1） */
    const eff = a.map((s, i) => {
      if (w[i] <= 0) return 0
      const idx = history.indexOf(s)
      if (idx < 0) return w[i]
      return w[i] * Math.max(0.04, (idx + 1) / (PICK_HISTORY_MAX + 2))
    })
    const effTotal = eff.reduce((x, y) => x + y, 0)
    let idx = 0
    if (effTotal > 0) {
      let r = rnd() * effTotal
      idx = a.length - 1
      for (let k = 0; k < a.length; k++) {
        if (eff[k] <= 0) continue
        r -= eff[k]
        if (r <= 0) { idx = k; break }
      }
    } else {
      let r = rnd() * total
      for (let k = 0; k < a.length; k++) {
        if (w[k] <= 0) continue
        r -= w[k]
        if (r <= 0) { idx = k; break }
      }
    }
    rememberPick(key, a[idx])
    return a[idx]
  }
  function rememberPick(key, sentence) {
    if (!sentence) return
    const arr = _pickHistory.get(key) || []
    const at = arr.indexOf(sentence)
    if (at >= 0) arr.splice(at, 1)
    arr.unshift(sentence)
    while (arr.length > PICK_HISTORY_MAX) arr.pop()
    _pickHistory.set(key, arr)
  }
  /* 从盘上历史日记里"最近说过的话"（按最新在前）——每次生成前重算，
     只要桌宠重启后仍能从 outputs 恢复 outputs 状态，去重就能跨会话生效。 */
  /* 历史句子 ↔ 池子句子的**同一化**。
     病根：日记正文里关系句是连在别的话后面的（`…。和主人的关系，闭着眼也能认出来的熟悉。`），
     按句号切出来的是**整句**（含前缀"和主人的关系，"），而池子里的候选只是**后半截**
     ⇒ 两边文本永不相等 ⇒ 计数恒为 0 ⇒ "最近说过"的硬约束从来没生效过。
     现在：切句后再按"分句标点/冒号"拆一刀，把**片段**也计入（片段长度 ≥4 才算，避免过短误伤）。 */
  /* 键归一化：
     池子里的候选带句号（`…收进心里了。`），而历史是按句号切开、**不带尾部标点**的
     （`…收进心里了`）⇒ 两边永不相等 ⇒ 计数与排除全部落空（实测 8 条里只有 1 条能对上）。
     统一去掉**首尾**的标点/空白后再比对。 */
  function normKey(s) {
    return String(s == null ? '' : s).replace(/^[\s。！？!?，,、；;：:]+/, '').replace(/[\s。！？!?，,、；;：:]+$/, '')
  }
  function sentenceFragments(s) {
    const out = [normKey(s)]
    const parts = String(s).split(/[，,；;：:、]/)
    for (const p of parts) {
      const x = normKey(p)
      if (x.length >= 4) out.push(x)
    }
    return out
  }
  function recentSentencesFromHistory(limitDays) {
    const days = Math.max(1, Number(limitDays) || 10)
    const recent = Object.keys(outputs)
      .filter((d) => outputs[d] && outputs[d].text)
      .sort((a, b) => dateFromKey(b).getTime() - dateFromKey(a).getTime())
      .slice(0, days)
    const set = new Set()
    for (const d of recent) {
      const t = String(outputs[d].text || '')
      for (const s of t.split(/[。！？!?]/)) {
        const x = s.trim()
        if (x.length >= 6 && x.length <= 40) {
          for (const f of sentenceFragments(x)) set.add(f)
        }
      }
    }
    return set
  }
  /* 同上，但返回**出现次数**（而不是"出现过没有"）。
     2026-09-17（S1）：契约"单句 ≤3 次 / 10 篇"只有靠"计数"才能真正压住——
     原来用 Set 只能判断"最近 10 篇里出现过"，一旦某句在候选里只剩它一个没用过，
     压力就又回到它身上（实测仍会出现 4~6 次）。 */
  function recentSentenceCounts(limitDays) {
    const days = Math.max(1, Number(limitDays) || 10)
    const recent = Object.keys(outputs)
      .filter((d) => outputs[d] && outputs[d].text)
      .sort((a, b) => dateFromKey(b).getTime() - dateFromKey(a).getTime())
      .slice(0, days)
    const counts = {}
    for (const d of recent) {
      const t = String(outputs[d].text || '')
      const seen = new Set()
      for (const s of t.split(/[。！？!?]/)) {
        const x = s.trim()
        if (x.length >= 6 && x.length <= 40) {
          for (const f of sentenceFragments(x)) { if (!seen.has(f)) { seen.add(f); counts[f] = (counts[f] || 0) + 1 } }
        }
      }
    }
    return counts
  }
  function resetPickHistory() { _pickHistory.clear() }
  /* 把池里"最近说过的"项移到候选前列（不筛选，保证池子不被清空，权重仍有作用） */
  function rankByRecency(pool, usedSet) {
    if (!pool || !pool.length || !usedSet || !usedSet.size) return pool
    const used = pool.filter((s) => usedSet.has(s))
    const fresh = pool.filter((s) => !usedSet.has(s))
    return fresh.concat(used)
  }

  function structureFor(ctx, exp) {
    const events = (ctx && ctx.importantEvents) || []
    const pasts = (exp && exp.pastMemories) || []
    const kinds = events.map((e) => e.kind || '')
    if (!events.length && !pasts.length) return 'quiet_day'
    if (kinds.some((k) => ['chat','relationship','important','praise','accompany_owner','milestone','first'].indexOf(k) >= 0)) return 'event_center'
    if (pasts.length && !events.length) return 'memory_center'
    if (events.length) return 'event_center'
    if (exp && exp.emotionalTone && exp.emotionalTone !== '平静') return 'emotion_center'
    return 'companion_center'
  }

  function composeNarrative(ctx) {
    const dc = (ctx && ctx.diaryContext) || {}
    const exp = (ctx && ctx.experience) || buildExperienceContext(ctx || {})
    const events = (ctx && ctx.importantEvents) || []
    const parts = []
    const dayWord = dc.relativeDateContext || '今天'
    const structure = structureFor(ctx, exp)
    const manuals = exp.manualMemories || []
    const pasts = exp.pastMemories || []
    /* D0：本次生成开始前重算"历史最近说过的话"，并重置进程内顺序 —— 跨会话去重的关键。 */
    resetPickHistory()
    /* 这两个是**模块级**状态，必须先清空再重算 ——
       否则"同一进程里连续生成"（例如同一天重生成、或测试连跑多轮）会带着上一次的残留，
       使同样的随机源产出不同文本（实测同一 seed 连跑两次第 1 天就不同）。 */
    _recentTiers = []
    _recentCounts = {}
    const _used = recentSentencesFromHistory(10)
    /* S1：刷新"最近 10 篇各句出现次数"——这是跨篇契约（单句 ≤3 次）的真正依据；
       同时保留分档集合，供 pickWeighted 做逐级排除。 */
    _recentCounts = recentSentenceCounts(10)
    _recentTiers = [
      recentSentencesFromHistory(14),
      recentSentencesFromHistory(7),
      recentSentencesFromHistory(3),
    ]
    // 语法糖：把"最近说过的句子集合"一并传下去（pickWeighted 用计数做最少使用优先）
    const pick2 = (pool, weights, key) => pickWeighted(rankByRecency(pool, _used), weights, key, _used)
    /* D0：**不再输出字面日期开头**（旧实现 18/19 篇以 '2026-9-16，周三。' 开头，
       既复读又像日志表头，不是日记口吻）。日记日语义已在 AI prompt 的【今日日期】里提供，
       本地模板正文无需重复。 */
    // Calendar season is not a weather, sound or room observation.

    if (structure === 'event_center') {
      if (exp.highlightedText) {
        const evKind = exp.highlightEvent && exp.highlightEvent.kind
        const statHeading = events.length > 1 || /(次|项|个|小时|分钟)/.test(exp.highlightedText)
        if (evKind === 'chat' || evKind === 'relationship' || evKind === 'important' || statHeading) {
          /* D0：旧实现此处恒为「小深最记得的是：<素材原文>。」——既是机读标签，
             又让 AI 学走了同一句式（首篇 AI 日记首句照写）。改为同义变体池 + 权重。
             指代一律用 dayWord（今天/昨天/那天），不得硬编码"今天"。 */
          parts.push(pick2([
            '我还记得' + dayWord + '这件事：' + exp.highlightedText + '。',
            '我想留住的，是' + exp.highlightedText + '。',
            '我印象最深的是：' + exp.highlightedText + '。',
            '我还惦记着' + exp.highlightedText + '。'
          ], [3, 2, 2, 1], 'highlight'))
        } else if (evKind === 'game') {
          parts.push('我还记得：' + exp.highlightedText + '。')
        } else if (evKind === 'work') {
          parts.push('我想记下来的是：' + exp.highlightedText + '。')
        } else {
          parts.push('我记得一件小事：' + exp.highlightedText + '。')
        }
      }
      if (events.length > 1) {
        parts.push(pick2([
          '还有一些小事，也轻轻落在今天里。',
          '除此之外，今天还有一些零碎的片段。',
          '其他小事没有被忘记，只是没有这一件清楚。',
          '剩下的都是些不值得单独提的小事。'
        ], [3, 2, 2, 1], 'small-things'))
      }
      if (manuals.length) {
        const firstManual = manuals[0].text || ''
        if (firstManual) parts.push('主人特意让我记住：' + firstManual + '。')
      }
      if (exp.emotionalTone && exp.emotionalTone !== '平静') parts.push(dayWord + '的心情，' + exp.emotionalTone + '。')
      if (pasts.length) {
        const firstPast = pasts[0].text || ''
        if (firstPast) {
          const dateWord = pasts[0].date ? '那天' : '以前'
          const intros = ['这让我想起' + dateWord + '：', '我也想起了' + dateWord + '：', '那时候的事，我还记得：']
          parts.push(intros[(firstPast.length + (pasts[0].date || '').length) % intros.length] + firstPast + '。')
        }
      }
    } else if (structure === 'companion_center') {
      parts.push(pick2([
        '主人' + dayWord + '在的时候，我不需要做什么，陪着就好。',
        '今天没有特别的事，但我记得主人' + dayWord + '来过。',
        '我记得主人' + dayWord + '来过，所以今天也不算空白。',
        '主人' + dayWord + '忙着别的，我就安静待在自己的位置上。'
      ], [3, 2, 2, 1], 'companion'))
      if (exp.emotionalTone && exp.emotionalTone !== '平静') parts.push('写到这里，我的心情是' + exp.emotionalTone + '。')
    } else if (structure === 'emotion_center') {
      parts.push('今天的心情，' + (exp.emotionalTone || '平静') + '。')
      if (exp.highlightedText) parts.push('让我有这种感觉的，是' + exp.highlightedText + '。')
      if (exp.ownerPresence === 'present') parts.push('主人' + dayWord + '有来陪我，所以情绪也慢慢安定下来。')
    } else if (structure === 'memory_center') {
      if (exp.highlightedText) parts.push('今天先记下一件小事：' + exp.highlightedText + '。')
      if (pasts.length) {
        const mp = pasts[0].text || ''
        if (mp) parts.push('这让我想起了' + (pasts[0].date ? '那天' : '以前') + '：' + mp + '。')
      }
      if (exp.emotionalTone && exp.emotionalTone !== '平静') parts.push('写到这里，我的心情是' + exp.emotionalTone + '。')
    } else {
      parts.push(dayWord + '很安静。')
      parts.push('我没有记下具体的互动，先留这么几句，不给这一天添上猜来的事情。')
      if (exp.emotionalTone && exp.emotionalTone !== '平静') parts.push('心情是' + exp.emotionalTone + '。')
    }
    return parts.join('')
  }

  function composeLocalText(ctx) { return composeNarrative(ctx) }
  /* P2/D3-3：成文硬约束可断言子集（saberlights）——
     列点/序号开头、# 或【】式小标题行、"首先/其次/总之"衔接、全文无「我」。
     "至少一处具体内容"与"不用他/她指主人"为 prompt 指令＋契约级判据（运行时正则误伤率高，不硬闸）。 */
  /* D3MARK-START */
  function validateD3Hard(text) {
    const t = String(text || '')
    const issues = []
    for (const ln of t.split('\n')) {
      if (/^\s*([-*•·]|\d+[.、)])\s+/.test(ln)) { issues.push('bullet'); break }
      if (/^\s*#{1,6}\s+/.test(ln) || /^\s*【[^】]{1,20}】\s*$/.test(ln)) { issues.push('heading'); break }
    }
    if (/首先[，,]|其次[，,]|总之[，,]/.test(t)) issues.push('discourse')
    if (!t.includes('我')) issues.push('no_first_person')
    return issues
  }
  function hasDiaryMaterial(importantEvents) {
    return (Array.isArray(importantEvents) ? importantEvents : []).length > 0
  }
  /* D3MARK-END */
  function validateText(text) {
    const t = String(text || '')
    const issues = []
    if (!t.trim()) issues.push('empty')
    if (t.length < MIN_LENGTH) issues.push('too_short')
    if (t.length > TARGET_MAX) issues.push('too_long')
    return issues
  }

  function idForDiaryDay(day) {
    return 'diary:' + day
  }

  function getOutput(diaryDay) {
    return outputs[diaryDay] ? JSON.parse(JSON.stringify(outputs[diaryDay])) : null
  }

  function outputFromText(diaryDay, text, source, ctx, meta) {
    const createdTs = ctx && ctx.diaryContext ? ctx.diaryContext.generatedAt : Date.now()
    return {
      diaryId: idForDiaryDay(diaryDay),
      diaryDay,
      createdAt: createdTs,
      source,
      text,
      eventRefs: (ctx && ctx.importantEvents ? ctx.importantEvents : []).map((e) => (e && e.ref) || (e && e.text)).filter(Boolean).slice(0, 12), /* P1-3/D2：ref 优先（结构化可反查），text 兜底 */
      memoryRefs: (ctx && ctx.memoryRefs ? ctx.memoryRefs : []).map((m) => m.id || m.content).filter(Boolean).slice(0, 5),
      albumRefs: (ctx && ctx.albumRefs ? ctx.albumRefs : []).slice(0, 5),
      calendarContext: ctx && ctx.calendar ? ctx.calendar : (ctx && ctx.diaryContext ? ctx.diaryContext.calendar : {}),
      styleVersion: SCHEMA_VERSION,
      diagnostics: meta || {}
    }
  }

  function hasTemporalConflict(text, exp) {
    const t = String(text || '')
    if (/(以前|曾经|那时候)[：:，]?\s*今天/.test(t)) return true
    const todayText = exp && exp.highlightedText ? exp.highlightedText : ''
    if (todayText) {
      const cues = ['以前：', '曾经：', '那时候：', '以前，', '曾经，', '那时候，']
      for (const cue of cues) {
        if (t.indexOf(cue + todayText) >= 0) return true
      }
      const pastIdx = t.search(/(以前|曾经|那时候)/)
      if (pastIdx >= 0 && t.slice(pastIdx, pastIdx + 40).indexOf(todayText) >= 0) return true
    }
    return false
  }

  function diaryViolate(text, hour, ctx) {
    const t = String(text || '')
    if (!t) return false
    const events = ctx && Array.isArray(ctx.importantEvents) ? ctx.importantEvents : []
    // Current perception supplies text/app categories/media metadata, never microphone or physical actions.
    if (/我(?:听见|听到|闻到|闻见|摸到)/.test(t)) return true
    const listening = t.match(/我听着[^。！？\n]{0,32}/g) || []
    // "这句话我听着挺合心意" is an ordinary response to received words.
    // Actual sounds and voice qualities still require audio perception.
    if (listening.some(s => /声音|音色|音调|语气|脚步|歌声|音乐|动静|笑声|呼吸/.test(s) ||
      !/这句话|这话|说法|听着.{0,6}(合心意|挺好|不错|有意思|安心|舒服)/.test(s))) return true
    const environment = t.match(/(?:屋里|房间|窗外|室内|空气)[^。！？\n]{0,10}(?:安静|很静|冷|热|光|雨|风|气味|声音|香|暗|亮|闷)/g) || []
    if (environment.some(s => !events.some(e => String(e.text || '').includes(s)))) return true
    const unobservedActions = ['没接话', '收好棋子', '把棋子收好', '整理了一下桌面', '把桌面整理', '翻了一会儿自己的收藏', '关上了窗口']
    for (const action of unobservedActions) if (t.includes(action) && !events.some(e => String(e.text || '').includes(action))) return true
    for (const w of FISH_WORDS) if (t.includes(w) &&
      !(FISH_WORDS.indexOf(w) < 2 && events.some(e => ['chat', 'pin'].includes(e.kind) && String(e.text || '').includes(w)))) return true
    for (const w of HALLUCINATE_WORDS) if (t.includes(w) && !events.some(e => String(e.text || '').includes(w))) return true
    const currentGroup = hour < 5 ? 0 : hour < 9 ? 1 : hour < 12 ? 2 : hour < 14 ? 3 : hour < 18 ? 4 : hour < 20 ? 5 : 6
    for (let i = 0; i < TIME_GROUPS.length; i++) {
      if (i !== currentGroup && TIME_GROUPS[i].some((w) => t.includes(w)) && !events.some(e => {
        if (!e.ts || dateFromKey(localCalendarDate(new Date(e.ts))).getTime() !== dateFromKey(ctx.diaryDay).getTime()) return false
        const h = new Date(e.ts).getHours()
        return (h < 5 ? 0 : h < 9 ? 1 : h < 12 ? 2 : h < 14 ? 3 : h < 18 ? 4 : h < 20 ? 5 : 6) === i
      })) return true
    }
    return false
  }

  /* 诊断落盘（离线复盘"这篇 AI 日记为什么没被采用"）：把四道 AI 闸的判定结果做成**可落盘**对象。
     原先这份结果只挂在进程内 diagnostics 上（只有活实例 getDiagnostics() 看得到，重启/换实例即丢）
     ⇒ 现在同一份对象也写进 `meta.aiGate`，随 diaryOutputs 落进 pet-state.json。
     `guard`＝本次**最终命中**的护栏类别（按判定顺序取第一个命中的；四闸全过 ⇒ null）。
     只记原因/长度/规则名，不记正文（隐私 + 体积）。判定逻辑本身仍只有一处（generateOnce 里的 aiOk 表达式）。 */
  function aiGateDiag(aiText, aiHour, exp, claim, ctx) {
    const violate = diaryViolate(aiText, aiHour, ctx) ? 1 : 0
    const temporal = hasTemporalConflict(aiText, exp) ? 1 : 0
    const issues = validateText(aiText).concat(validateD3Hard(aiText))
    const claimReason = (claim && claim.reason) ? String(claim.reason).slice(0, 40) : null
    const guard = violate ? 'diaryViolate' : (temporal ? 'temporal' : (issues.length ? 'validateText' : (claimReason ? 'claimGuard' : null)))
    return { len: aiText.length, violate, temporal, vIssues: issues.slice(0, 3), claim: claimReason, guard }
  }

  function compactMemoryContext(ctx) {
    const exp = ctx.experience || {}
    const mems = [...(exp.pastMemories || []), ...(exp.manualMemories || [])].slice(0, 3)
    if (!mems.length) return '（没有可注入的主人过去记忆）'
    return mems.map((m) => '- ' + String((m.date ? m.date + '：' : '') + (m.content || m.text || ''))).join('\n')
  }

  function diaryGuardContext(ctx) {
    return { relevantMemories: ctx.memoryRefs || [], diaryDay: ctx.diaryDay,
      currentEvents: ((ctx.experience && ctx.experience.todayExperiences) || []).filter(e =>
        e.ts && dateFromKey(localCalendarDate(new Date(e.ts))).getTime() === dateFromKey(ctx.diaryDay).getTime()
      ).map(e => ({ ...e, day: ctx.diaryDay })) }
  }


  /* per-diaryDay single-flight（A4）
     - 非 force：同 day 已有 in-flight → join 同一个 Promise（不丢弃、不并发第二次 AI）
     - force：无 in-flight → 正常 force 生成；有 in-flight → 先等待当前生成完成，再串行执行一次 force
     - 不允许 force 与当前生成并发；不允许 force 永久等待另一个 force
     - in-flight 清理一律在 finally（success / failure / timeout / rejection）
     - 单次实际生成 → 单次 persistenceHandler + 单次 diary:output-created
  */
  const inFlightByDay = new Map() // diaryDay -> { promise, seq, forced }
  const outputRevisionByDay = new Map()
  const pendingOutputByDay = new Map() // unsaved draft; never exposed as a saved entry
  let generateSeq = 0

  function cancelPending(day) {
    if (day) outputRevisionByDay.set(day, (outputRevisionByDay.get(day) || 0) + 1)
  }

  function removeDay(day) {
    if (!day) return false
    cancelPending(day)
    const existed = !!outputs[day]
    delete outputs[day]
    pendingOutputByDay.delete(day)
    return existed
  }

  function removeOutput(diaryId) {
    const day = Object.keys(outputs).find(key => outputs[key].diaryId === diaryId)
    return day ? removeDay(day) : false
  }

  function dayKeyOfInput(input) {
    try {
      const diaryContext = createDiaryContext(input || {})
      return diaryContext.diaryDay
    } catch (err) {
      return null
    }
  }

  function generate(input) {
    const day = dayKeyOfInput(input)
    if (!day) return generateOnce(input)
    const force = !!(input && input.force)
    const existing = inFlightByDay.get(day)

    if (existing) {
      if (!force) {
        // join：调用方拿到同一个生成结果。
        // 若已有 force 排队，普通请求也必须排在 force 后面，不能抢先占用。
        return existing.promise.then((r) => {
          if (existing.forceQueued && inFlightByDay.has(day)) {
            return inFlightByDay.get(day).promise.then((r2) => Object.assign({}, r2, { joined: true }))
          }
          if (r && typeof r === 'object' && r.joined !== true) return Object.assign({}, r, { joined: true })
          return r
        })
      }
      if (!existing.forced) {
        // 先完成当前 normal，再串行执行一次 force（不并发）。
        // forceQueued 是对“下一个实际生成”的预约，后续普通请求不得抢先。
        existing.forceQueued = true
        return existing.promise.then(() => {
          if (inFlightByDay.has(day)) return inFlightByDay.get(day).promise.then((r) => Object.assign({}, r, { joined: true }))
          return startGenerate(day, input, true)
        })
      }
      // 已有 force in-flight：join，绝不永久等待另一个 force
      return existing.promise.then((r) => Object.assign({}, r, { joined: true }))
    }

    return startGenerate(day, input, force)
  }

  function startGenerate(day, input, forced) {
    const seq = ++generateSeq
    const promise = (async () => {
      try {
        return await generateOnce(input)
      } finally {
        const cur = inFlightByDay.get(day)
        if (cur && cur.seq === seq) inFlightByDay.delete(day)
      }
    })()
    inFlightByDay.set(day, { promise, seq, forced: !!forced })
    return promise
  }

  async function generateOnce(input) {
    const diaryContext = createDiaryContext(input || {})
    const ctx = buildContext(input || {}, diaryContext)
    const revision = outputRevisionByDay.get(ctx.diaryDay) || 0
    diagnostics.generationStarted++
    const pending = pendingOutputByDay.get(ctx.diaryDay)
    if (pending) return persistOutput(pending, revision)
    const existing = getOutput(ctx.diaryDay)
    if (existing && !input.force) {
      diagnostics.duplicateSuppressed++
      return { ok: true, output: existing, duplicate: true }
    }
    if (existing && input.force) {
      diagnostics.duplicateSuppressed++
      // A manual retry must not silently replace an AI entry with a local template.
      if (aiEnabled && (diagnostics.aiRequestsByDay[ctx.diaryDay] || 0) >= MAX_AI_CALLS_PER_DAY) {
        return { ok: false, reason: 'daily_ai_limit', output: existing }
      }
    }
    /* P2/D3-1（设计细化③ 借门禁）：素材不足（重要事件 0）且非手动 ⇒ 不落笔——
       不编造"今天没有发生什么"。手动（force）仍可写——用户拍板。 */
    if (!input.force && !(ctx.importantEvents && ctx.importantEvents.length)) {
      diagnostics.noMaterial = true
      try { console.log('[diary] skipped', 'reason=no-material') } catch (e) { /* ignore */ }
      return { ok: false, reason: 'no-material', diagnostics: { reason: 'no-material' } }
    }

    let text = composeNarrative(ctx)
    let source = 'local'
    let meta = { aiRequested: false, aiSkipReason: null }
    let lengthTier = null

    if (aiEnabled && window.AIGateway && typeof window.AIGateway.request === 'function') {
      const aiCallsForDay = diagnostics.aiRequestsByDay[ctx.diaryDay] || 0
      if (aiCallsForDay >= MAX_AI_CALLS_PER_DAY) {
        // An automatic retry after NEED_INFO must not turn the stopped attempt
        // into a local diary on the next heartbeat. Manual local writing remains available.
        if (!input.force) return { ok: false, reason: 'daily_ai_limit' }
        meta.aiSkipReason = 'daily_ai_limit'
      } else {
        const started = Date.now()
        diagnostics.aiRequested++
        diagnostics.aiRequestsByDay[ctx.diaryDay] = aiCallsForDay + 1
        meta.aiRequested = true
        // A5：count 已 +1，通知宿主持久化。回调失败不影响本进程内存计数。
        if (typeof aiRequestConsumedHandler === 'function') {
          try { aiRequestConsumedHandler(ctx.diaryDay, diagnostics.aiRequestsByDay[ctx.diaryDay]) } catch (err) { /* never roll back in-memory count */ }
        }
        /* 日记仅由 DiaryGen2 装配；准备失败明确返回，不换用旧提示词。 */
        let promptData = null
        if (window.DiaryGen2 && window.DiaryGen2.prepare) {
          try {
            promptData = await window.DiaryGen2.prepare(ctx)
            if (promptData && promptData.decision) {
              meta.diaryDecision = promptData.decision
              window.DiaryGen2.lastDecision = promptData.decision
              meta.intentionStatus = promptData.intentionStatus
            }
          } catch (err) { promptData = null }
        }
        if (!promptData) return { ok: false, reason: 'diary_prepare_failed' }
        if (promptData.decision && !promptData.decision.selected.length) return { ok: false, reason: 'no-material' }
        lengthTier = promptData.lengthTier || null
        let r
        try {
          r = await window.AIGateway.request({
            role: 'diary',
            system: promptData.system,
            userText: promptData.userText,
            temperature: promptData.temperature,
            context: diaryGuardContext(ctx),
            timeoutMs: 120000
          })
        } catch (err) { r = { ok: false, reason: 'provider_error' } }
        diagnostics.aiLatency = Date.now() - started
        if (r && r.ok && r.text) {
          const aiText = String(r.text || '').trim()
          meta.aiOriginalText = aiText
          meta.aiSources = promptData.sources || ctx.importantEvents || []
          /* P2/D3-2（借 maibook 停笔）：模型自陈素材不足 ⇒ 同 no-material 分支（不落笔、不编造）。 */
          if (aiText.indexOf('===NEED_INFO===') >= 0) {
            try { console.log('[diary] skipped', 'reason=no-material', 'via=NEED_INFO') } catch (e) { /* ignore */ }
            return { ok: false, reason: 'no-material', diagnostics: { reason: 'no-material', needInfo: true } }
          }
          /* D0 附带修正：旧实现用 ctx.diaryContext.generatedAt 取小时。
             generatedAt 是"创建 DiaryContext 的时刻"（右键菜单那一刻），生成耗时越长偏差越大
             ——实测 21:58 那次报 hour=21、22:02 那次报 22，而 diaryDay 早已翻到次日。
             时段闸应当用"写日记的当前真实钟点"。 */
          const aiHour = new Date().getHours()
          let claim = { reason: null, text: aiText }
          if (window.AIGateway && typeof window.AIGateway.claimGuard === 'function') {
            try { claim = window.AIGateway.claimGuard(aiText, diaryGuardContext(ctx)) } catch (err) { claim = { reason: 'guard_error', text: aiText } }
          }
          const aiOk = !diaryViolate(aiText, aiHour, ctx) &&
            !hasTemporalConflict(aiText, ctx.experience) &&
            validateText(aiText).length === 0 &&
            validateD3Hard(aiText).length === 0 && /* P2/D3-3：成文硬约束（列点/标题/排比/无我） */
            (!claim || !claim.reason)
          meta.aiOriginalGate = aiGateDiag(aiText, aiHour, ctx.experience, claim, ctx)
          if (aiOk) {
            text = claim && claim.text ? String(claim.text).trim() : aiText
            source = 'ai'
            /* 诊断落盘：AI 被采纳时也留一份（全 0 + guard=null）⇒ 离线复盘可区分
               "四闸全过" 与 "根本没发请求 / 回执不 ok"（后者没有 aiGate 字段，只有 aiSkipReason）。 */
            meta.aiGate = aiGateDiag(aiText, aiHour, ctx.experience, claim, ctx)
          } else {
            /* v0.4：局部修复——一次有界修复后复核，不整篇直接丢模板 */
            let repairedOk = false
            if (window.DiaryGen2 && window.DiaryGen2.repair) {
              try {
                const repaired = await window.DiaryGen2.repair(aiText, meta.aiOriginalGate, { ...diaryGuardContext(ctx), sources: meta.aiSources })
                const repairedText = (repaired && repaired.ok && repaired.text) ? String(repaired.text).trim() : ''
                meta.aiRepairText = repairedText || null
                /* （M5 日记异常）：修复失败时记下失败原因与阶段。
                   实测该请求连发两次都返回空正文，而旧实现一律 `''` ⇒ 无法归因。 */
                meta.aiRepairReason = repairedText ? null : ((repaired && repaired.reason) || 'provider_failed')
                meta.aiRepairFailureStage = repairedText ? null : ((repaired && repaired.failureStage) || null)
                meta.aiRepairCompletion = null
                /* （用户要求：不合格原稿不得冒充已通过，但也不得因修复为空而丢失原稿与审核原因）：
                   把"谁写的、没过哪道闸、修复为何没救回"聚成一条可离线复盘的记录。 */
                meta.aiDraft = { text: aiText, gate: meta.aiOriginalGate, repair: { ok: !!repairedText, reason: meta.aiRepairReason, failureStage: meta.aiRepairFailureStage } }
                try {
                  if (!repairedText && repaired && repaired.completion) {
                    meta.aiRepairCompletion = { finishReason: String(repaired.completion.finishReason || 'unknown').slice(0, 40),
                      tokens: Math.max(0, Number(repaired.completion.tokens) || 0),
                      reasoningTokens: Math.max(0, Number(repaired.completion.reasoningTokens) || 0) }
                  }
                  if (!repairedText) console.warn('[diary] repair unavailable:', meta.aiRepairReason)
                } catch (e) { /* diagnostics only: never break the write path */ }
                if (repairedText) {
                  let claim2 = { reason: null, text: repairedText }
                  if (window.AIGateway && typeof window.AIGateway.claimGuard === 'function') {
                    try { claim2 = window.AIGateway.claimGuard(repairedText, diaryGuardContext(ctx)) } catch (err) { claim2 = { reason: 'guard_error', text: repairedText } }
                  }
                  const ok2 = !diaryViolate(repairedText, aiHour, ctx) && !hasTemporalConflict(repairedText, ctx.experience) &&
                    validateText(repairedText).length === 0 && validateD3Hard(repairedText).length === 0 && (!claim2 || !claim2.reason)
                  if (ok2) {
                    text = String((claim2 && claim2.text) || repairedText).trim()
                    source = 'ai'
                    repairedOk = true
                    meta.aiRepaired = true
                    meta.aiGate = aiGateDiag(repairedText, aiHour, ctx.experience, claim2, ctx)
                  }
                }
              } catch (err) {
                meta.aiRepairReason = 'repair_call_threw'
                try { console.warn('[diary] repair attempt failed:', (err && err.message) || err) } catch (e) { /* logging only */ }
              }
            }
            if (repairedOk) { /* 修复后采纳 */ } else {
            diagnostics.fallbackReason = 'ai_failed_or_invalid'
            meta.aiSkipReason = 'fallback_local'
            /* 诊断（AI 采用率专项）：把"具体哪道闸拦下"记进 diagnostics。
               2026-09-27 修正：这份结果**原先并没有随 diaryOutputs 落盘**（只活在进程内 diagnostics 里）
               ⇒ 现在同一份对象也写进 `meta.aiGate`，随 diaryOutputs 落进 pet-state.json 供离线复盘。 */
            const gate = aiGateDiag(aiText, aiHour, ctx.experience, claim, ctx)
            diagnostics.aiGate = gate
            meta.aiGate = gate
            }
          }
        } else {
          /* P2/D4-1（设计细化③）：配额回滚——请求级失败/超时 ⇒ 当日额度 −1 并通知宿主，
             不让一次 timeout 永久吃掉配额；闸拒绝（内容不合格）不回滚（调用已真实发生）。 */
          if (!(r && r.ok && r.text)) {
            const __rest = Math.max(0, (diagnostics.aiRequestsByDay[ctx.diaryDay] || 1) - 1)
            diagnostics.aiRequestsByDay[ctx.diaryDay] = __rest
            diagnostics.aiQuotaRolledBack = true
            if (typeof aiRequestConsumedHandler === 'function') { try { aiRequestConsumedHandler(ctx.diaryDay, __rest) } catch (e) { /* ignore */ } }
          }
          diagnostics.fallbackReason = 'ai_failed_or_invalid'
          meta.aiSkipReason = 'fallback_local'
          meta.aiFailureReason = (r && r.reason) || 'provider_failed'
          meta.aiFailureStage = (r && r.failureStage) || 'provider'
          meta.aiProvider = r && r.provider || null
          meta.aiModel = r && r.model || null
          if (r && r.completion) meta.aiCompletion = { finishReason: String(r.completion.finishReason || 'unknown').slice(0, 40),
            tokens: Math.max(0, Number(r.completion.tokens) || 0), reasoningTokens: Math.max(0, Number(r.completion.reasoningTokens) || 0) }
          try { console.log('[diary] fallback', 'reason=' + meta.aiFailureReason) } catch (err) { /* ignore */ }
        }
      }
    } else {
      meta.aiSkipReason = 'ai_disabled'
      diagnostics.aiSkipped++
    }

    if (hasTemporalConflict(text, ctx.experience)) {
      text = composeNarrative(ctx)
      source = 'local'
      meta.temporalFallback = true
      diagnostics.fallbackReason = 'temporal_conflict'
    }
    meta.structure = structureFor(ctx, ctx.experience)
    meta.lengthTier = lengthTier

    const output = outputFromText(ctx.diaryDay, text, source, ctx, meta)
    return persistOutput(output, revision)
  }

  async function persistOutput(output, revision) {
    const day = output.diaryDay
    if ((outputRevisionByDay.get(day) || 0) !== revision) {
      return { ok: false, reason: 'cancelled' }
    }
    let persistenceOk = true
    if (persistenceHandler) {
      try {
        const saved = await persistenceHandler(output)
        if (saved === false || (saved && saved.ok === false)) throw new Error('write_failed')
        diagnostics.persistenceResult = 'ok'
        output.diagnostics.persistenceResult = 'ok'
      } catch (err) {
        persistenceOk = false
        diagnostics.persistenceResult = 'write_failed'
        output.diagnostics.persistenceResult = 'write_failed'
      }
    }
    if ((outputRevisionByDay.get(day) || 0) !== revision) return { ok: false, reason: 'cancelled' }
    if (!persistenceOk) {
      pendingOutputByDay.set(day, output)
      return { ok: false, reason: 'write_failed', output, duplicate: false, persistenceOk: false }
    }
    pendingOutputByDay.delete(day)
    outputs[day] = output
    const days = Object.keys(outputs).sort((a, b) => (Number(outputs[a].createdAt) || 0) - (Number(outputs[b].createdAt) || 0))
    for (const day of days.slice(0, Math.max(0, days.length - 180))) delete outputs[day]
    try {
      if (window.EventBus && typeof window.EventBus.emit === 'function') {
        window.EventBus.emit('diary:output-created', output)
      }
    } catch (err) { /* event should never break diary */ }
    diagnostics.generationFinished++
    return { ok: persistenceOk, output, duplicate: false, persistenceOk }
  }

  function init(options) {
    const opts = options || {}
    aiEnabled = !!opts.aiEnabled
    persistenceHandler = typeof opts.save === 'function' ? opts.save : null
    aiRequestConsumedHandler = typeof opts.onAiRequestConsumed === 'function' ? opts.onAiRequestConsumed : null
    for (const key of Object.keys(outputs)) delete outputs[key]
    pendingOutputByDay.clear()
    /* init 视为"新会话开始" ⇒ 同时清掉进程内的选句历史。
       历史去重的**权威依据仍是盘上的 outputs**（D0 的核心修复），这里只是防止
       "同一进程里连续多天/多轮生成"时用过的句子在内存里越积越偏。 */
    _pickHistory.clear()
    if (Array.isArray(opts.outputs)) {
      for (const o of opts.outputs) {
        if (o && o.diaryDay && o.text && !isTestContent(o.text)) outputs[o.diaryDay] = JSON.parse(JSON.stringify(o))
      }
    }
    diagnostics.generationStarted = 0
    diagnostics.generationFinished = 0
    diagnostics.aiRequested = 0
    diagnostics.aiSkipped = 0
    diagnostics.aiLatency = null
    diagnostics.fallbackReason = null
    diagnostics.duplicateSuppressed = 0
    // A5：恢复当日 AI 请求计数；只保留当前 DiaryDay，旧 day 丢弃。
    diagnostics.aiRequestsByDay = restoreAiRequestsByDay(opts.aiRequestsByDay, opts.now, opts.diaryTime)
    // The former evening boundary could label today's paid AI diary as yesterday.
    // Migrate its quota by creation timestamp without relabelling saved diaries.
    const now = Number(opts.now) || Date.now(), day = resolveDiaryDay(now, opts.diaryTime).diaryDay
    const legacyPaidToday = Object.values(outputs).some(o => o.source === 'ai' && o.diaryDay !== day &&
      Number(o.createdAt) > 0 && Number(o.createdAt) <= now && resolveDiaryDay(Number(o.createdAt), opts.diaryTime).diaryDay === day &&
      Number.isInteger(Number((opts.aiRequestsByDay || {})[o.diaryDay])) && Number((opts.aiRequestsByDay || {})[o.diaryDay]) > 0)
    if (legacyPaidToday) diagnostics.aiRequestsByDay[day] = Math.max(MAX_AI_CALLS_PER_DAY, diagnostics.aiRequestsByDay[day] || 0)
    return getDiagnostics()
  }

  /** A5：sanitize + 只保留当前 DiaryDay 的已消耗计数 */
  function restoreAiRequestsByDay(raw, nowTs, diaryTime) {
    const out = {}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
    const currentDay = resolveDiaryDay(nowTs, diaryTime).diaryDay
    for (const key of Object.keys(raw)) {
      if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(String(key))) continue
      const n = Number(raw[key])
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) continue
      if (key === currentDay) out[key] = n
    }
    return out
  }

  function setAIEnabled(v) { aiEnabled = !!v }

  function getDiagnostics() {
    return {
      schemaVersion: SCHEMA_VERSION,
      ...diagnostics,
      outputCount: Object.keys(outputs).length,
      inFlightCount: inFlightByDay.size,
      inFlightDays: Array.from(inFlightByDay.keys()),
    }
  }

  const WRITE_BOUNDARY = {
    owner: 'DiaryEngine',
    allowed: ['diaryday-resolver', 'daily-context', 'local-composer', 'one-ai-narrator'],
    denied: ['memory-write', 'persona', 'relationship', 'emotion', 'intent', 'behavior', 'state-write'],
    note: 'Diary is an off-main-chain daily narrative; it never writes other core domains.'
  }

  return {
    SCHEMA_VERSION,
    DEFAULT_DIARY_TIME,
    resolveDiaryDay,
    buildContext,
    rankImportantEvents,
    composeLocalText,
    composeNarrative,
    createDiaryContext,
    buildExperienceContext,
    generate,
    getOutput,
    removeOutput,
    removeDay,
    cancelPending,
    init,
    setRandomSource,
    setSaveHandler: (fn) => { persistenceHandler = typeof fn === 'function' ? fn : null },
    setAiRequestConsumedHandler: (fn) => { aiRequestConsumedHandler = typeof fn === 'function' ? fn : null },
    getAllOutputs: () => Object.keys(outputs).map((k) => JSON.parse(JSON.stringify(outputs[k]))),
    setAIEnabled,
    getDiagnostics,
    diagnostics: getDiagnostics,
    WRITE_BOUNDARY
  }
})()




