/* StateExpression — 3.1 S2「状态驱动回复」只读投射层
 *
 * Ownership（与 DialogueEngine.WRITE_BOUNDARY 同族约定）：
 *   - **只读** CharacterContext（persona / emotion / relationship / relevantMemories / 情境）。
 *   - 产出三样东西：
 *       ① candidates  本地「候选表达」——由**状态检索 + 本地模板**得到（不许 AI 生成）
 *       ② diction     措辞约束（温暖度 / 篇幅 / 称呼 / 语气），供 LLM **只做润色**
 *       ③ facts       允许被引用的事实（情绪状态 + 关系档 + **≤2 条**记忆）
 *   - **不写任何核心域**：不写 Memory / Relationship / Emotion / Persona / State；
 *     不产生事实；不把 AI 解释当新事实。
 *   - 纯函数 + 零 I/O + 零随机（时钟可注入）⇒ 同一输入永远同一输出，可离线断言。
 *
 * 红线依据（3.1 主线）：`Persona/Emotion/Memory/Relationship → Character Context
 *   → Dialogue Expression → LLM 只润色`，禁止 `用户输入 → LLM → 回复`。
 */
window.StateExpression = (function () {
  const SCHEMA_VERSION = 1
  /* 记忆引用上限：候选/提示词里最多允许引用 2 条记忆（验收硬指标）。 */
  const MEMORY_LIMIT = 2
  /* 单条候选表达的长度上限（本地模板本身就短；这里只做兜底裁剪）。 */
  const MAX_CANDIDATE_CHARS = 60
  const MAX_MEMORY_CHARS = 60

  let clock = function () { return Date.now() }
  /* 仅供测试注入，生产不调用（保持"同一输入同一输出"）。 */
  function setClock(fn) { clock = typeof fn === 'function' ? fn : function () { return Date.now() } }

  function captureNow() {
    try { return Number(clock()) || Date.now() } catch (err) { return Date.now() }
  }

  function clamp01(v) {
    const n = Number(v)
    if (!Number.isFinite(n)) return 0
    return n < 0 ? 0 : (n > 1 ? 1 : n)
  }

  function trimText(s, max) {
    const t = String(s == null ? '' : s).trim()
    if (!max || t.length <= max) return t
    return t.slice(0, max)
  }

  /* ---------- 关系：0~100 → 档位（与 DialogueEngine.affectionTierOf 同语义） ---------- */
  function affectionOf(context) {
    const rel = (context && (context.relationship || context.relationshipSummary)) || {}
    const n = Number(rel.affection)
    if (!Number.isFinite(n)) return null
    return Math.max(0, Math.min(100, n))
  }

  function tierIndexOf(aff) {
    if (aff === null) return 2 // 未知关系按"亲近"保守处理
    if (aff >= 85) return 4
    if (aff >= 60) return 3
    if (aff >= 30) return 2
    return 1
  }

  const TIER_WORD = { 1: '普通', 2: '亲近', 3: '很亲', 4: '特别亲' }

  /* ---------- 情绪：与 DialogueEngine.emotionStateOf 同语义（happy/low/tired/neutral） ---------- */
  function emotionStateOf(context) {
    const emo = (context && context.emotion) || {}
    const values = emo.values || emo
    const derived = emo.derivedMood || emo.mood || ''
    const happiness = Number(values.happiness)
    const sadness = Number(values.sadness)
    const loneliness = Number(values.loneliness)
    if (derived === 'happy' || derived === 'cheerful' || derived === 'excited' ||
      (Number.isFinite(happiness) && happiness >= 0.6)) return 'happy'
    if (derived === 'sad' || derived === 'low' || derived === 'lonely' ||
      (Number.isFinite(sadness) && sadness >= 0.6) ||
      (Number.isFinite(happiness) && happiness <= 0.3) ||
      (Number.isFinite(loneliness) && loneliness >= 0.6)) return 'low'
    if (derived === 'tired' || (Number.isFinite(values.fatigue) && values.fatigue >= 0.6)) return 'tired'
    return 'neutral'
  }

  /* ---------- 情境识别（只读用户这句话 + 自身情绪，不读窗口/页面内容） ---------- */
  const SITUATION_RULES = [
    { key: 'user_tired', re: /(好累|累死|累坏|累了|好困|困死|困了|没精神|没力气|疲惫|加班|熬夜|顶不住)/ },
    { key: 'user_sad', re: /(难过|伤心|委屈|低落|不开心|想哭|心情不好|心里难受|有点烦|好烦|压力)/ },
    { key: 'user_praise', re: /(真棒|好棒|厉害|可爱|聪明|贴心|优秀|辛苦了|做得好|夸)/ },
    { key: 'user_affection', re: /(抱抱|贴贴|亲亲|想你|陪我|撒娇|喜欢你)/ },
    { key: 'user_food', re: /(米饭|白饭|饭团|吃饭|干饭|饿|吃点|想吃)/ },
  ]

  function detectSituations(userText) {
    const t = String(userText || '')
    const out = []
    for (const r of SITUATION_RULES) {
      if (r.re.test(t)) out.push(r.key)
    }
    return out
  }

  /* ---------- 候选表达表：每条都是「状态检索 + 本地模板」，按关系档分两版措辞 ---------- */
  const SITUATION_TEMPLATES = {
    user_tired: {
      label: '听你说累了',
      distant: '嗯……主人辛苦了。先歇一会儿吧，我不吵你，就在旁边待着。',
      close: '主人累了吧。那就先别管别的了，靠过来歇一会儿，我陪着你。',
    },
    user_sad: {
      label: '听你心情不好',
      distant: '……我听到了。要是不想说，也没关系，我不会追问。',
      close: '别一个人扛着。我在这儿，你想说多少，我就听多少。',
    },
    user_praise: {
      label: '被主人夸',
      distant: '……谢谢。我会继续好好做的。',
      close: '主人这么夸我，我会偷偷开心一整天的。……才没有很开心。',
    },
    user_affection: {
      label: '主人想亲近',
      distant: '诶……那、那我知道了。我会在的。',
      close: '嗯，我也在。今天可以多撒娇一会儿，就一会儿哦。',
    },
    user_food: {
      label: '说到吃的',
      distant: '说到吃的……我好像也开始惦记米饭了。',
      close: '主人一提米饭，我尾巴都要动了。今天想吃点什么？',
    },
  }

  /* 自身情绪带来的候选（与情境无关，但属于"状态被说出口"） */
  const EMOTION_TEMPLATES = {
    low: '我今天本来有点闷，不过听到主人说话，好像好一点了。',
    tired: '我也稍微有点困了……不过还是想陪主人说说话。',
    happy: '我今天心情不错，主人想聊什么都可以。',
  }

  const ORDINARY_CLOSE = '嗯，我听着呢。主人慢慢说就好。'
  const ORDINARY_DISTANT = '我在听，主人慢慢说。'

  function candidateText(tpl, tierIndex) {
    const close = tierIndex >= 3
    return trimText(close ? tpl.close : tpl.distant, MAX_CANDIDATE_CHARS)
  }

  function candidatesFor(state) {
    const out = []
    const tier = state.tierIndex
    for (const key of state.situations) {
      const tpl = SITUATION_TEMPLATES[key]
      if (!tpl) continue
      out.push({
        id: 'situation:' + key + ':' + (tier >= 3 ? 'close' : 'distant'),
        text: candidateText(tpl, tier),
        sourceRef: 'situation:' + key,
        reason: tpl.label,
        confidence: 0.9,
        priority: 90,
        weight: 90,
      })
    }
    const emoLine = EMOTION_TEMPLATES[state.emotionState]
    if (emoLine) {
      out.push({
        id: 'emotion:' + state.emotionState,
        text: trimText(emoLine, MAX_CANDIDATE_CHARS),
        sourceRef: 'emotion:' + state.emotionState,
        reason: '我自己的心情',
        confidence: 0.6,
        priority: 60,
        weight: 60,
      })
    }
    if (!out.length) {
      out.push({
        id: 'ordinary:' + (tier >= 3 ? 'close' : 'distant'),
        text: trimText(tier >= 3 ? ORDINARY_CLOSE : ORDINARY_DISTANT, MAX_CANDIDATE_CHARS),
        sourceRef: 'state:ordinary',
        reason: '普通对话',
        confidence: 0.3,
        priority: 30,
        weight: 30,
      })
    }
    return out
  }

  /* ---------- 措辞约束：给 LLM 的"只润色"参数（也用于 AI 关闭时的本地兜底风格） ---------- */
  function dictionFor(state) {
    const tier = state.tierIndex
    /* 温暖度：关系档为主，情绪（happy/low）做小幅调整，恒定落在 [0.15, 0.95] */
    let warmth = 0.15 + (tier - 1) * 0.22
    if (state.emotionState === 'happy') warmth += 0.06
    if (state.emotionState === 'low') warmth -= 0.04
    warmth = Math.round(clamp01(warmth) * 100) / 100
    const situation = state.situations.length > 0
    const verbosity = Math.round(clamp01(situation ? 0.45 : 0.35) * 100) / 100
    return {
      warmth,
      verbosity,
      maxChars: warmth >= 0.6 ? 60 : 40,
      address: state.address,
      register: tier >= 3 ? '自然、亲近；可以稍微吐槽或撒娇，但不腻' : '克制、客气、话少；不主动拉近关系',
    }
  }

  function addressOf(context, tierIndex) {
    const persona = (context && context.persona) || {}
    const speech = persona.speechBaseline || {}
    const def = speech.defaultAddressing || '主人'
    const intimate = speech.intimateAddressing || '主人sama'
    return tierIndex >= 4 ? intimate : def
  }

  /* ---------- 事实：只允许 ≤2 条记忆 + 情绪/关系（记忆不是"新事实"，只是可引用的旧事实） ---------- */
  function memoryFactsFor(context) {
    const raw = (context && (context.relevantMemories || context.recentMemory || context.recentEventsMemory)) || []
    const list = Array.isArray(raw) ? raw : []
    const out = []
    for (const m of list) {
      if (out.length >= MEMORY_LIMIT) break
      const content = m && (m.content || m.text || '')
      const text = trimText(content, MAX_MEMORY_CHARS)
      if (!text) continue
      out.push({
        id: (m && m.id) || null,
        date: (m && (m.date || m.eventTime)) || null,
        text,
      })
    }
    return out
  }

  function build(capturedAt, context, userText) {
    const aff = affectionOf(context)
    const tierIndex = tierIndexOf(aff)
    const emotionState = emotionStateOf(context)
    const situations = detectSituations(userText)
    const state = { tierIndex, emotionState, situations }
    const diction = dictionFor(state)
    const address = addressOf(context, tierIndex)
    diction.address = address
    return {
      schemaVersion: SCHEMA_VERSION,
      source: 'state-expression',
      capturedAt,
      userText: trimText(userText, 200),
      personaName: trimText((context && context.persona && context.persona.identity && context.persona.identity.displayName) || '小深', 40),
      emotionState,
      affection: aff,
      tierIndex,
      tierWord: TIER_WORD[tierIndex] || TIER_WORD[2],
      situations,
      diction,
      candidates: candidatesFor(state),
      facts: {
        emotion: { state: emotionState },
        relationship: { affection: aff, tierIndex, tierWord: TIER_WORD[tierIndex] || TIER_WORD[2] },
        memories: memoryFactsFor(context),
        memoryLimit: MEMORY_LIMIT,
      },
      boundaries: {
        readOnly: true,
        noNewFacts: true,
        memoryLimit: MEMORY_LIMIT,
        polishOnly: true,
        note: '候选由状态检索 + 本地模板得到；LLM 只润色，不得新增候选之外的事实/记忆/经历。',
      },
    }
  }

  function project(context, userText, opts) {
    const o = opts || {}
    const capturedAt = Number.isFinite(Number(o.capturedAt)) ? Number(o.capturedAt) : captureNow()
    try {
      return build(capturedAt, context || {}, userText == null ? '' : userText)
    } catch (err) {
      /* 投影失败不得影响主链：给一个最小的中性投影 */
      return {
        schemaVersion: SCHEMA_VERSION,
        source: 'state-expression',
        capturedAt,
        userText: trimText(userText, 200),
        personaName: '小深',
        emotionState: 'neutral',
        affection: null,
        tierIndex: 2,
        tierWord: TIER_WORD[2],
        situations: [],
        diction: { warmth: 0.37, verbosity: 0.35, maxChars: 40, address: '主人', register: '克制、客气、话少；不主动拉近关系' },
        candidates: [{ id: 'ordinary:distant', text: ORDINARY_DISTANT, sourceRef: 'state:ordinary', reason: '普通对话', confidence: 0.3, priority: 30, weight: 30 }],
        facts: { emotion: { state: 'neutral' }, relationship: { affection: null, tierIndex: 2, tierWord: TIER_WORD[2] }, memories: [], memoryLimit: MEMORY_LIMIT },
        boundaries: { readOnly: true, noNewFacts: true, memoryLimit: MEMORY_LIMIT, polishOnly: true, note: '投影降级为中性' },
        degraded: true,
      }
    }
  }

  /* ---------- 给 LLM 的提示块（纯字符串，可离线断言） ---------- */
  function promptLines(projection) {
    const p = projection || null
    if (!p || !Array.isArray(p.candidates) || !p.candidates.length) return []
    const d = p.diction || {}
    const lines = []
    lines.push('[状态表达（S2 只读投影）]')
    lines.push('措辞约束：温暖度 ' + (d.warmth == null ? '-' : d.warmth) +
      '／篇幅 ≤' + (d.maxChars || 40) + ' 字／称呼“' + (d.address || '主人') + '”／语气：' + (d.register || ''))
    p.candidates.forEach((c, i) => {
      lines.push('候选 ' + (i + 1) + '（' + (c.reason || '状态') + '｜来源 ' + (c.sourceRef || '-') + '）：' + c.text)
    })
    const mems = (p.facts && Array.isArray(p.facts.memories)) ? p.facts.memories : []
    if (mems.length) {
      lines.push('可引用的旧记忆（最多 ' + MEMORY_LIMIT + ' 条，不得改写、不得补充细节）：' + mems.map((m) => m.text).join(' ／ '))
    } else {
      lines.push('可引用的旧记忆：无（这条回复里不要声称记得任何旧事）')
    }
    lines.push('用法：若候选与主人这句话相合，请**只润色**其中一条；不得新增候选里没有的事实、记忆或经历，不得改变它的意思。若都不合适，可以自然回答，但上面的措辞约束与记忆纪律同样适用。')
    return lines
  }

  /* ---------- AI 关闭 / 网关不可用时的本地兜底（不装成回答了内容） ---------- */
  function localFallback(input) {
    const p = input && typeof input === 'object' ? input : null
    if (p && Array.isArray(p.candidates) && p.candidates.length) {
      const sit = p.candidates.find((c) => /^situation:/.test(String(c.sourceRef || '')))
      if (sit && sit.text) return sit.text
      const emo = p.candidates.find((c) => /^emotion:/.test(String(c.sourceRef || '')))
      if (emo && emo.text) return emo.text
    }
    return '我听见了，就是这会儿说不出完整的话。主人先慢慢说，我在这儿陪你。'
  }

  return {
    SCHEMA_VERSION,
    MEMORY_LIMIT,
    MAX_CANDIDATE_CHARS,
    project,
    promptLines,
    localFallback,
    candidatesFor,
    dictionFor,
    emotionStateOf,
    detectSituations,
    affectionOf,
    tierIndexOf,
    setClock,
  }
})()
