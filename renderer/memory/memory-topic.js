/* MemoryTopic — v3.3 Batch B
 * Write-side topic extraction, mention detection, and simple memory intent parsing.
 * No external NLP. Pure dictionary + regex.
 */
window.MemoryTopic = (function () {
  const TOPIC_TAXONOMY = {
    food: { label: '食物', keywords: ['白米饭', '米饭', '面条', '火锅', '奶茶', '咖啡', '蛋糕', '水果', '零食'] },
    drink: { label: '饮品', keywords: ['奶茶', '咖啡', '可乐', '汽水', '果汁', '茶'] },
    game: { label: '游戏', keywords: ['Catch', 'Gomoku', '游戏', '下棋', '五子棋', '黑白棋', '小游戏'] },
    activity: { label: '活动', keywords: ['散步', '旅行', '爬山', '游泳', '跑步', '打球', '看电影'] },
    relationship: { label: '关系', keywords: ['主人', '朋友', '家人', '同事'] },
    habit: { label: '习惯', keywords: ['习惯', '总是', '每天', '经常'] },
    work: { label: '工作', keywords: ['工作', '加班', '项目', '任务'] }
  }

  const TOPIC_DICTIONARY = {
    '白米饭': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '白米饭', topic: 'food' },
    '米饭': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '米饭', topic: 'food' },
    '面条': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '面条', topic: 'food' },
    '火锅': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '火锅', topic: 'food' },
    '奶茶': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '奶茶', topic: 'drink' },
    '咖啡': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '咖啡', topic: 'drink' },
    'Catch': { subjectKey: 'user', propertyKey: 'favorite', valueKey: 'Catch', topic: 'game' },
    'Gomoku': { subjectKey: 'user', propertyKey: 'favorite', valueKey: 'Gomoku', topic: 'game' },
    '游戏': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '游戏', topic: 'game' },
    '五子棋': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '五子棋', topic: 'game' },
    '爬山': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '爬山', topic: 'activity' },
    '旅行': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '旅行', topic: 'activity' },
    '散步': { subjectKey: 'user', propertyKey: 'favorite', valueKey: '散步', topic: 'activity' }
  }

  const MENTION_PATTERNS = [
    /喜欢/,
    /我爱吃/,
    /爱吃/,
    /我习惯/,
    /我总是/,
    /我讨厌/,
    /讨厌/,
    /i\s+like/i,
    /i\s+love/i,
    /i\s+prefer/i,
    /* A2：背景/身份/习惯类自述——可枚举、零 AI 、只认第一人称陈述 */
    /我是/,
    /我做/,
    /我平时/,
    /我通常/,
    /我一般/
  ]

  const MEMORY_INTENT_PATTERNS = {
    recall: [/还记得/, /记得我/, /我喜欢什么/, /最爱什么/, /喜欢什么/, /remember/i],
    current_preference: [/现在喜欢/, /目前喜欢/, /我现在喜欢/],
    past_episode: [/以前玩过什么/, /我们以前玩过/, /以前.*玩/, /曾经.*玩/, /过去.*经历/],
    past_relationship: [/以前.*关系/, /曾经.*朋友/, /过去.*认识/],
    historical: [/以前/, /曾经/, /过去/, /之前/],
    forget: [/忘掉/, /忘记/, /不记得/, /别再提/, /删掉.*(?:记忆|偏好|事)/],
    restore: [/恢复/, /找回/, /重新想起/, /解除.*(?:隐藏|屏蔽)/]
  }

  const FORGET_PATTERNS = [/忘掉/, /忘记/, /不记得/, /别再提/, /删掉/, /清除.*(?:记忆|偏好)/]
  const RESTORE_PATTERNS = [/恢复/, /找回/, /重新想起/, /解除.*(?:隐藏|屏蔽)/]

  function normalizeText(text) {
    return String(text || '').replace(/[，。！？、；：,.!?;:]/g, ' ').replace(/\s+/g, ' ').trim()
  }

  function hasAny(text, patterns) {
    return patterns.some((p) => p.test(text))
  }

  function dictionaryLookup(text) {
    for (const key of Object.keys(TOPIC_DICTIONARY)) {
      if (text.indexOf(key) >= 0) return Object.assign({ term: key }, TOPIC_DICTIONARY[key])
    }
    return null
  }

  function extractValue(text) {
    const current = String(text).match(/(?:现在|如今|目前).{0,8}(?:更喜欢|喜欢|最爱|爱吃|讨厌)\s*(?:的)?\s*([^，。！？!?、\s]{1,16})/i)
    if (current && current[1]) {
      return { subjectKey: 'user', propertyKey: /讨厌|不喜欢/.test(text) ? 'dislike' : 'favorite', valueKey: current[1].replace(/^(这个|那个|一种|一次)/, '').trim(), topic: null, term: current[1] }
    }
    const dict = dictionaryLookup(text)
    if (dict) return dict
    const m = String(text).match(/(?:最喜欢|最爱|一直喜欢|我还是喜欢|我喜欢|我爱吃|爱吃|喜欢|讨厌|最讨厌|不喜欢|i\s+like|i\s+love|i\s+prefer)\s*(?:的)?\s*([^，。！？!?、\s]{1,16})/i)
    if (m && m[1]) {
      let v = m[1].replace(/^(这个|那个|一种|一次|今天|昨天)/, '').trim()
      if (!v) return null
      return { subjectKey: 'user', propertyKey: /讨厌|不喜欢|最讨厌/.test(text) ? 'dislike' : 'favorite', valueKey: v, topic: null, term: v }
    }
    return null
  }

  /* A2：**背景/身份/习惯**的第一人称自述 ⇒ 给一个可枚举的 value。
     只做"从本人句子里取短语"，不推断、不补全；取不到就返回 null（宁可不写）。
     返回的 propertyKey 走既有 preference 通道（'background'/'habit' 两个新命名空间），
     因此**不需要改 memory-engine.js**。 */
  function extractBackgroundValue(text) {
    const raw = String(text || '')
    const clean = (v) => String(v || '').replace(/^(做|干|当|是)/, '').replace(/[的了]\s*$/, '').trim()
    const idm = raw.match(/(?:我是|我做|我的工作是|我干)\s*([^，。！？!?、\s]{1,16})/)
    if (idm && idm[1]) {
      const v = clean(idm[1])
      if (v && v.length >= 2) return { subjectKey: 'user', propertyKey: 'background', valueKey: v, topic: 'work', term: v }
    }
    const hm = raw.match(/(?:我习惯|我平时|我通常|我一般|我总是)\s*([^，。！？!?、\s]{2,16})/)
    if (hm && hm[1]) {
      const v = clean(hm[1])
      if (v && v.length >= 2) return { subjectKey: 'user', propertyKey: 'habit', valueKey: v, topic: 'habit', term: v }
    }
    return null
  }

  function isJoke(text) {
    return /只是开玩笑|开玩笑的|逗你|逗你的|哈哈|开玩笑/.test(text)
  }

  function isTemporary(text) {
    return /今天|刚才|这次|临时|突然想|挺好玩|真香|还不错|也还行|最近没那么/.test(text) && !/一直|永远|以后也想|最喜欢|最爱/.test(text)
  }

  function isWeakChange(text) {
    return /没那么喜欢|不太喜欢|也还行|没以前|没有以前|不如以前|一般般|最近不怎么/.test(text)
  }

  function isStrong(text) {
    return /最喜欢|最爱|一直喜欢|永远喜欢|以后也想|我还是喜欢|我现在喜欢|更喜欢|现在更喜欢|已经不喜欢|不再喜欢/.test(text)
  }

  function isDislike(text) {
    return /不喜欢|讨厌|最讨厌/.test(text)
  }

  function isQuestionLike(text) {
    return /[?？]/.test(text) ||
      /什么|哪些|哪个|谁|怎么|为什么/.test(text) ||
      /吗\s*$/.test(text) ||
      /呢\s*$/.test(text)
  }

  function detectMentionCandidate(text) {
    const raw = String(text || '').trim()
    if (!raw || isQuestionLike(raw)) return []
    if (!hasAny(raw, MENTION_PATTERNS)) return []
    const normalized = normalizeText(raw)
    const value = extractValue(raw)
    const out = []
    const joke = isJoke(raw)
    const temporary = isTemporary(raw)
    const strong = isStrong(raw)
    const weakChange = isWeakChange(raw)
    const dislike = isDislike(raw)
    /* A2 修缺陷①：裸 `玩` 会命中「开**玩**笑」⇒ 收窄为真正的"一起玩/玩过/玩了"形态 */
    const hasEpisode = /昨天|前天|今天|刚才|和主人|一起|玩过|玩了|玩游戏|完成|第一次|去过|吃了/.test(raw)
    const oldMatch = String(raw).match(/(?:以前|曾经|过去|之前).{0,16}?(?:喜欢|爱吃|玩)\s*([^，。！？!?、\s]{1,16})/)
    const oldValueKey = oldMatch && oldMatch[1] ? oldMatch[1].trim() : null

    if (value && !joke && !temporary) {
      const confidence = strong ? 0.90 : 0.75
      out.push({
        kind: 'preference',
        type: 'preference',
        content: raw,
        subjectKey: value.subjectKey || 'user',
        propertyKey: value.propertyKey || (dislike ? 'dislike' : 'favorite'),
        valueKey: value.valueKey,
        oldValueKey,
        confidence,
        strong,
        weakChange,
        dislike,
        temporary: false,
        joke: false,
        episode: false,
        evidenceText: normalized
      })
    }

    /* A2（用户授权「方案 A」）：背景/身份/习惯自述 ⇒ 走既有 preference 通道的 'background'/'habit' 命名空间。
       与偏好分支**互斥**（`!value`）⇒ 一句自述最多产生 1 条候选，不放大写入量。 */
    const bg = extractBackgroundValue(raw)
    if (!value && bg && !joke && !temporary) {
      out.push({
        kind: 'preference',
        type: 'preference',
        content: raw,
        subjectKey: bg.subjectKey,
        propertyKey: bg.propertyKey,
        valueKey: bg.valueKey,
        oldValueKey: null,
        confidence: 0.80,
        strong: false,
        weakChange: false,
        dislike: false,
        temporary: false,
        joke: false,
        episode: false,
        topic: bg.topic,
        evidenceText: normalized
      })
    }

    /* A2 修缺陷①：episode 分支必须沿用 joke 判定（原实现把它硬编码为 false ⇒ 玩笑句会被写成"共同经历"） */
    if (hasEpisode && !joke) {
      out.push({
        kind: 'episode',
        type: 'episode',
        content: raw,
        subjectKey: null,
        propertyKey: null,
        valueKey: null,
        confidence: 0.90,
        strong: false,
        dislike: false,
        temporary: false,
        joke: false,
        episode: true,
        evidenceText: normalized
      })
    }

    return out
  }

  function extractMemoryTopic(text) {
    const c = detectMentionCandidate(text)[0] || null
    if (!c) return null
    return {
      subjectKey: c.subjectKey,
      propertyKey: c.propertyKey,
      valueKey: c.valueKey,
      type: c.type,
      confidence: c.confidence,
      strong: c.strong,
      temporary: c.temporary,
      joke: c.joke
    }
  }

  function parseMemoryIntent(text) {
    const raw = String(text || '').trim()
    const intent = { intent: 'none', subjectKey: null, propertyKey: null, valueKey: null, confidence: null, historical: false, includeSuperseded: false }
    if (hasAny(raw, FORGET_PATTERNS)) intent.intent = 'forget'
    else if (hasAny(raw, RESTORE_PATTERNS)) intent.intent = 'restore'
    else if (hasAny(raw, MEMORY_INTENT_PATTERNS.past_episode)) {
      intent.intent = 'past_episode'
      intent.historical = true
      intent.includeSuperseded = true
    } else if (hasAny(raw, MEMORY_INTENT_PATTERNS.past_relationship)) {
      intent.intent = 'past_relationship'
      intent.historical = true
      intent.includeSuperseded = true
    } else if (hasAny(raw, MEMORY_INTENT_PATTERNS.historical) && hasAny(raw, [/喜欢|玩|吃|关系/])) {
      intent.intent = 'current_preference'
      intent.historical = true
      intent.includeSuperseded = true
    } else if (hasAny(raw, MEMORY_INTENT_PATTERNS.current_preference)) {
      intent.intent = 'current_preference'
    } else if (hasAny(raw, MEMORY_INTENT_PATTERNS.recall)) {
      intent.intent = 'recall'
    }
    if (!intent.propertyKey && /什么|哪/.test(raw) && /喜欢|爱吃|讨厌|不喜欢/.test(raw)) {
      intent.subjectKey = 'user'
      intent.propertyKey = /讨厌|不喜欢/.test(raw) ? 'dislike' : 'favorite'
    }
    const topic = extractMemoryTopic(raw) || dictionaryLookup(raw)
    if (topic) {
      intent.subjectKey = topic.subjectKey || null
      intent.propertyKey = topic.propertyKey || null
      intent.valueKey = topic.valueKey || null
      intent.confidence = typeof topic.confidence === 'number' ? topic.confidence : null
    }
    return intent
  }

  return {
    TOPIC_TAXONOMY,
    TOPIC_DICTIONARY,
    MENTION_PATTERNS,
    MEMORY_INTENT_PATTERNS,
    FORGET_PATTERNS,
    RESTORE_PATTERNS,
    normalizeText,
    detectMentionCandidate,
    extractMemoryTopic,
    extractValue,
    parseMemoryIntent,
    isJoke,
    isTemporary,
    isStrong,
    isWeakChange,
    isDislike,
    isQuestionLike,
    hasAny
  }
})()
