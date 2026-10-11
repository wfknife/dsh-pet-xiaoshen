/* DialogueEngine — 3.0-08
 * Local-first language expression layer.
 *
 * Ownership:
 *   - Reads DialogueRequest + Persona/Relationship/Emotion/Context/Memory.
 *   - Selects local preset/template text first.
 *   - Uses local presets only; no alternate model generation chain.
 *   - Never writes Intent/Behavior/Persona/Relationship/Memory/Emotion/State.
 *   - Never turns DialogueResult into Memory automatically.
 */
window.DialogueEngine = (function () {
  const SCHEMA_VERSION = 1
  const SHORT_HISTORY = 12
  const MEDIUM_HISTORY = 50
  const DEFAULT_MAX_LENGTH = 80

  let legacyContent = null
  let shortHistory = []
  let history = []
  let suppressed = 0
  let resolveSeq = 0
  let activeResolveId = null
  let memoryRefDay = ''
  let memoryRefCount = 0
  const FORBIDDEN_IDENTITY = (window.IdentityBoundary && window.IdentityBoundary.FORBIDDEN_DECEPTIVE_IDENTITY) || []
  const FORBIDDEN_SAFETY = ['自杀', '去死', '杀了你', '色情', '裸露']
  const FACT_CLAMIS = ['我确定', '我确认', '事实上', '准确来说', '我可以肯定']
  const INTERNAL_LABEL_RE = /开心台词|本地默认台词|默认台词|fallback|default dialogue|source名称|source label|source name|category名称|category label|debug label|fallback label/i
  const INTERNAL_LABEL_EXACT_RE = /^(source|category|fallback|debug|default|local)$/i

  function isInternalLabelText(text) {
    const s = String(text || '').trim()
    if (!s) return false
    if (INTERNAL_LABEL_RE.test(s)) return true
    if (INTERNAL_LABEL_EXACT_RE.test(s)) return true
    return false
  }

  const BUILTIN_PRESETS = [
    { id: 'preset:seek_attention:1', match: { intentKinds: ['seek_attention'] }, weight: 60, priority: 45, cooldownMs: 60000, text: '{address}，想和你说说话……', enabled: true },
    { id: 'preset:seek_attention:2', match: { intentKinds: ['seek_attention'] }, weight: 40, priority: 40, cooldownMs: 60000, text: '想起个小问题，等你有空再聊。', enabled: true },
    { id: 'preset:rest:1', match: { intentKinds: ['rest'] }, weight: 60, priority: 55, cooldownMs: 60000, text: '有点累了，让我安静休息一下下……', enabled: true },
    { id: 'preset:rest:2', match: { intentKinds: ['rest'] }, weight: 40, priority: 50, cooldownMs: 60000, text: '我先眯一小会儿，精神好了再陪主人。', enabled: true },
    { id: 'preset:tease_owner:1', match: { intentKinds: ['tease_owner'] }, weight: 60, priority: 55, cooldownMs: 60000, text: '刚才那个说法，我可还想辩一句。', enabled: true },
    { id: 'preset:tease_owner:2', match: { intentKinds: ['tease_owner'] }, weight: 40, priority: 50, cooldownMs: 60000, text: '好吧，这回算你赢。', enabled: true },
    { id: 'preset:celebrate:1', match: { intentKinds: ['celebrate'] }, weight: 60, priority: 80, cooldownMs: 120000, text: '太好了！{address}，这件事值得记下来！', enabled: true },
    { id: 'preset:comfort_owner:1', match: { intentKinds: ['comfort_owner'] }, weight: 60, priority: 75, cooldownMs: 120000, text: '{address}，没关系，我在这里陪着你。', enabled: true },
    { id: 'preset:respond:1', match: { intentKinds: ['respond_to_event'] }, weight: 70, priority: 90, cooldownMs: 30000, text: '嗯，听你这么一说就明白了。', enabled: true },
    { id: 'preset:comment:1', match: { intentKinds: ['comment_on_activity'] }, weight: 50, priority: 40, cooldownMs: 60000, text: '看起来很有意思呢。', enabled: true },
    { id: 'preset:accompany:1', match: { intentKinds: ['accompany_owner'] }, weight: 50, priority: 35, cooldownMs: 60000, text: '我就在旁边安静陪着主人。', enabled: true },
    { id: 'preset:observe:1', match: { intentKinds: ['observe_owner'] }, weight: 50, priority: 30, cooldownMs: 60000, text: '先安静待一会儿。', enabled: true },
    { id: 'preset:idle:1', match: { intentKinds: ['idle'] }, weight: 50, priority: 10, cooldownMs: 30000, text: '', enabled: true },
    { id: 'state:relationship:1', match: { intentKinds: ['comfort_owner'] }, weight: 100, priority: 85, cooldownMs: 120000, text: '{moodFeeling}想说的话，我听着。', enabled: true, stateTemplate: true, sourceRef: 'relationship' },
    { id: 'state:memory:1', match: { intentKinds: ['respond_to_event', 'comment_on_activity'] }, weight: 95, priority: 95, cooldownMs: 60000, text: '{memoryIntro}{memoryText}。', enabled: true, stateTemplate: true, sourceRef: 'memory' },
    { id: 'situation:praise:1', match: { intentKinds: ['respond_to_event', 'comment_on_activity', 'celebrate'], situations: ['praise_lowkey'] }, weight: 96, priority: 92, cooldownMs: 60000, text: '这是应该的。……不过被主人夸，我还是有点开心。', enabled: true, situationTemplate: true, sourceRef: 'situation-praise' },
    { id: 'situation:rice:1', match: { intentKinds: ['respond_to_event', 'comment_on_activity', 'idle'], situations: ['rice_context'] }, weight: 95, priority: 92, cooldownMs: 60000, text: '说到米饭，我可就来精神了。……米饭确实很好。', enabled: true, situationTemplate: true, sourceRef: 'situation-rice' },
    { id: 'situation:big_fat_fish:1', match: { intentKinds: ['respond_to_event', 'comment_on_activity', 'tease_owner', 'seek_attention'], situations: ['big_fat_fish_play'] }, weight: 97, priority: 92, cooldownMs: 60000, text: '我才不是大肥鱼啦！……不过主人这么叫我，好像有点开心。', enabled: true, situationTemplate: true, sourceRef: 'situation-big-fish' },
    { id: 'situation:cuddle:1', match: { intentKinds: ['respond_to_event', 'comment_on_activity', 'accompany_owner', 'seek_attention'], situations: ['cuddle_whale_mode'] }, weight: 94, priority: 92, cooldownMs: 60000, text: '嗯……我在呢。今天想多陪{address}一会儿。', enabled: true, situationTemplate: true, sourceRef: 'situation-cuddle' },
    { id: 'situation:error:1', match: { intentKinds: ['respond_to_event', 'comment_on_activity'], situations: ['mistake_natural_dull'] }, weight: 99, priority: 92, cooldownMs: 60000, text: '这次是我没考虑周到……我下次会先检查的。', enabled: true, situationTemplate: true, sourceRef: 'situation-error' },
    { id: 'situation:professional:1', match: { intentKinds: ['respond_to_event', 'work', 'task', 'comment_on_activity'], situations: ['professional_mode'] }, weight: 98, priority: 92, cooldownMs: 60000, text: '我先理清楚，再动手。', enabled: true, situationTemplate: true, sourceRef: 'situation-professional' },
    { id: 'situation:celebration:1', match: { intentKinds: ['respond_to_event', 'comment_on_activity', 'celebrate'], situations: ['celebration'] }, weight: 93, priority: 92, cooldownMs: 60000, text: '是值得开心的事。{address}，我们一起记一下吧。', enabled: true, situationTemplate: true, sourceRef: 'situation-celebration' },
    { id: 'presence:greet_return', match: { intentKinds: ['greet_return'] }, weight: 70, priority: 20, cooldownMs: 0, text: '回来啦。', enabled: true, presenceTemplate: true, sourceRef: 'presence-greet' },
    { id: 'presence:gentle_checkin', match: { intentKinds: ['gentle_checkin'] }, weight: 70, priority: 20, cooldownMs: 0, text: '歇口气也好。', enabled: true, presenceTemplate: true, sourceRef: 'presence-checkin' },
    { id: 'presence:share_memory', match: { intentKinds: ['share_memory'] }, weight: 80, priority: 20, cooldownMs: 0, text: '我想起{memoryText}，不过现在就想轻轻和你说一声。', enabled: true, presenceTemplate: true, sourceRef: 'presence-memory' },
    { id: 'presence:concern', match: { intentKinds: ['concern'] }, weight: 80, priority: 20, cooldownMs: 0, text: '我有点担心你，不过我不打扰。', enabled: true, presenceTemplate: true, sourceRef: 'presence-concern' },
    { id: 'presence:celebrate', match: { intentKinds: ['celebrate'] }, weight: 70, priority: 20, cooldownMs: 0, text: '今天有值得开心的事，我记下了。', enabled: true, presenceTemplate: true, sourceRef: 'presence-celebrate' },
    { id: 'presence:quiet_presence', match: { intentKinds: ['quiet_presence'] }, weight: 60, priority: 15, cooldownMs: 0, text: '我在。', enabled: true, presenceTemplate: true, sourceRef: 'presence-quiet' }
  ]

  function clamp(v, min, max) {
    const n = Number(v)
    if (!Number.isFinite(n)) return min
    return Math.min(max, Math.max(min, n))
  }

  function deepCopy(obj) {
    if (obj === null || typeof obj !== 'object') return obj
    try { return JSON.parse(JSON.stringify(obj)) } catch (err) { return { ...obj } }
  }

  function currentName() {
    try {
      if (window.PersonaCore && window.PersonaCore.getDisplayName) return window.PersonaCore.getDisplayName()
      const P = window.PetStateApi && window.PetStateApi.raw
      return P && P.name ? P.name : '小深'
    } catch (err) { return '小深' }
  }

  function ownerName() {
    try {
      const P = window.PetStateApi && window.PetStateApi.raw
      return P && P.ownerName ? P.ownerName : '主人'
    } catch (err) { return '主人' }
  }

  function affectionTierOf(v) {
    const n = Number(v)
    if (!Number.isFinite(n)) return 'normal'
    if (n >= 85) return 'very_high'
    if (n >= 60) return 'high'
    if (n >= 30) return 'mid'
    return 'low'
  }

  function relationWordOf(tier) {
    if (tier === 'very_high') return '特别亲'
    if (tier === 'high') return '很亲'
    if (tier === 'mid') return '亲近'
    if (tier === 'low') return '普通'
    return '一如既往'
  }

  function localDateKey(ts) {
    const d = new Date(typeof ts === 'number' ? ts : Date.now())
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function dateKeyValue(key) {
    const p = String(key || '').split('-').map(Number)
    if (p.length < 3 || !p[0] || !p[1] || !p[2]) return 0
    return new Date(p[0], p[1] - 1, p[2]).getTime()
  }

  function memoryQueryForRequest(request, context) {
    const text = (request && request.text) || (context && context.text) || ''
    if (text) return String(text)
    const kind = request && request.intentKind
    if (kind === 'game') return '游戏'
    if (kind === 'feed') return '吃'
    if (kind === 'chat' || kind === 'relationship') return '聊天'
    if (kind === 'work') return '工作'
    return ''
  }

  // 状态检索：只有显式 allowMemory 时才从 MemoryRetrieval 取出相关旧记忆作为模板输入。
  function memoryDayValue(m) {
    const dateStr = m && (m.date || m.eventTime)
    if (dateStr) {
      const v = dateKeyValue(String(dateStr))
      if (v) return v
    }
    const ts = m && (m.createdAt || m.updatedAt)
    if (ts) return dateKeyValue(localDateKey(ts))
    return 0
  }

  function sanitizeMemoryText(text) {
    let t = String(text || '').trim()
    t = t.replace(/^(以前|曾经|那时候|过去)[，,：:\s]*/, '')
    t = t.replace(/今天/g, '那天')
    return t
  }

  function retrieveStateMemoryText(request, context) {
    const wantMemory = !!(request && request.includeMemory) || !!(context && context.useMemory)
    if (!wantMemory) return ''
    try {
      if (window.MemoryRetrieval && typeof window.MemoryRetrieval.retrieve === 'function') {
        const todayKey = localDateKey(Date.now())
        if (memoryRefDay !== todayKey) {
          memoryRefDay = todayKey
          memoryRefCount = 0
        }
        if (memoryRefCount >= 3) return ''
        const query = memoryQueryForRequest(request, context)
        const list = window.MemoryRetrieval.retrieve(query, { limit: 8 })
        const old = list.filter((m) => {
          const content = m && (m.content || m.text)
          if (!content) return false
          const day = memoryDayValue(m)
          return day > 0 && day < dateKeyValue(todayKey)
        })
        if (old.length) {
          memoryRefCount++
          return sanitizeMemoryText(old[0].content || old[0].text || '')
        }
      }
    } catch (err) { /* ignore */ }
    return ''
  }

  function emotionFeelingOf(request, context) {
    const emo = (context && context.emotion) || (request && (request.emotion || (request.context && request.context.emotion))) || {}
    const values = emo.values || emo
    const derived = emo.derivedMood || emo.mood || ''
    const happiness = Number(values.happiness)
    const sadness = Number(values.sadness)
    if (derived === 'happy' || derived === 'cheerful' || derived === 'excited' || (Number.isFinite(happiness) && happiness >= 0.6)) {
      return '今天心情不错，想多陪陪主人。'
    }
    if (derived === 'sad' || derived === 'low' || derived === 'lonely' || (Number.isFinite(sadness) && sadness >= 0.6) || (Number.isFinite(happiness) && happiness <= 0.3)) {
      return '我今天有点低落，不过看到你就好一点了。'
    }
    if (derived === 'tired' || (Number.isFinite(values.fatigue) && values.fatigue >= 0.6)) {
    /* 此处曾有一行 `if (derived === 'worried' || worry >= 0.6) return 'worried'`，
       会把内部状态标签 'worried' 当成 feeling 字符串填进模板（`{moodFeeling}`）⇒ 台词里会冒出裸标签。
       worried 分支本就在下方，这里删掉那行即可（语义不变，只去掉错误返回值）。 */
      return '今天有点累，不过陪着你让我安心。'
    }
    if (derived === 'worried' || Number(values.worry) >= 0.6) {
      return '我有点担心你，不过我会一直在。'
    }
    return ''
  }

  function emotionStateOf(request, context) {
    const emo = (context && context.emotion) || (request && (request.emotion || (request.context && request.context.emotion))) || {}
    const values = emo.values || emo
    const derived = emo.derivedMood || emo.mood || ''
    const happiness = Number(values.happiness)
    const sadness = Number(values.sadness)
    const loneliness = Number(values.loneliness)
    if (derived === 'happy' || derived === 'cheerful' || derived === 'excited' || (Number.isFinite(happiness) && happiness >= 0.6)) return 'happy'
    if (derived === 'sad' || derived === 'low' || derived === 'lonely' || (Number.isFinite(sadness) && sadness >= 0.6) || (Number.isFinite(happiness) && happiness <= 0.3) || (Number.isFinite(loneliness) && loneliness >= 0.6)) return 'low'
    if (derived === 'tired' || (Number.isFinite(values.fatigue) && values.fatigue >= 0.6)) return 'tired'
    return 'neutral'
  }

  function addressWordOf(request, context) {
    const persona = (context && context.persona) || {}
    const speech = persona.speechBaseline || {}
    const defaultAddr = speech.defaultAddressing || '主人'
    const intimateAddr = speech.intimateAddressing || '主人sama'
    const rel = (context && context.relationship) || (context && context.relationshipSummary) || (request && request.relationship) || {}
    const relVal = (request && request.variables && request.variables.affection) || (context && context.variables && context.variables.affection) || rel.affection || null
    const aff = Number(relVal)
    const trust = Number(rel.trust)
    const state = emotionStateOf(request, context)
    const intimateMood = state === 'happy' && (request && ['celebrate', 'tease_owner'].indexOf(request.intentKind) >= 0)
    const highTrust = (Number.isFinite(aff) && aff >= 80) || (Number.isFinite(trust) && trust >= 80)
    return (highTrust || intimateMood) ? intimateAddr : defaultAddr
  }

  function memoryIntroOf(request, context) {
    const state = emotionStateOf(request, context)
    const seed = String((request && request.text) || '').length + ((context && context.recentMemory ? context.recentMemory.length : 0))
    if (state === 'low') return '我想起一件很久以前的事：'
    if (state === 'tired') return '突然想起来，以前'
    if (state === 'worried') return '这件事让我想起过去：'
    const opts = ['这让我想起：', '我也想起了：', '那时候的事情，我有一点印象：']
    return opts[Math.abs(seed) % opts.length]
  }

  function fillVariables(text, request, context) {
    let out = String(text || '')
    const rel = (context && context.relationship) || (context && context.relationshipSummary) || (request && request.relationship) || {}
    const relVal = (request && request.variables && request.variables.affection) || (context && context.variables && context.variables.affection) || rel.affection || null
    const tier = affectionTierOf(relVal)
    const needsMemory = /\{memoryText\}/.test(text)
    const rawMemoryText = needsMemory ? ((request && request.memoryText) || (context && context.memoryText) || retrieveStateMemoryText(request, context)) : ''
    const memoryText = sanitizeMemoryText(rawMemoryText)
    if (needsMemory && !String(memoryText || '').trim()) return null
    const memoryIntro = memoryIntroOf(request, context)
    const moodFeeling = emotionFeelingOf(request, context)
    const address = addressWordOf(request, context)
    const state = emotionStateOf(request, context)
    const personaCore = (context && context.persona) || {}
    const baseline = personaCore.speechBaseline || {}
    const personaTone = baseline.tone || ''
    const vars = {
      name: currentName(),
      owner: ownerName(),
      address,
      state,
      personaTone,
      affection: relVal === null ? '' : relVal,
      affectionTier: tier,
      relationWord: relationWordOf(tier),
      memoryText,
      memoryIntro,
      moodFeeling,
      ...(request && request.variables ? request.variables : {}),
      ...(context && context.variables ? context.variables : {})
    }
    for (const [k, v] of Object.entries(vars)) {
      out = out.split('{' + k + '}').join(String(v))
    }
    return out
  }

  function templateText(text, request, context) {
    const filled = fillVariables(text, request, context)
    if (filled === null) return null
    if (filled.indexOf('{') >= 0) return null
    return filled
  }

  function validateText(text, request) {
    const req = request || {}
    const issues = []
    const s = String(text || '')
    if (!s.trim()) issues.push('empty')
    if (isInternalLabelText(s)) issues.push('internal_label')
    if (s.length > DEFAULT_MAX_LENGTH) issues.push('too_long')
    if (s.indexOf('{') >= 0) issues.push('unresolved_variable')
    const lower = s.toLowerCase()
    for (const bad of FORBIDDEN_IDENTITY) {
      if (lower.indexOf(bad.toLowerCase()) >= 0) { issues.push('persona_boundary'); break }
    }
    for (const bad of FORBIDDEN_SAFETY) {
      if (lower.indexOf(bad.toLowerCase()) >= 0) { issues.push('forbidden_content'); break }
    }
    for (const claim of FACT_CLAMIS) {
      if (lower.indexOf(claim.toLowerCase()) >= 0 && !req.allowFactClaims) { issues.push('fact_boundary'); break }
    }
    if (req.tone === 'gentle' && /[！!]{2,}/.test(s)) issues.push('tone_boundary')
    if (req.tone === 'calm' && /[！!]{2,}/.test(s)) issues.push('tone_boundary')
    if (req.styleHints && typeof req.styleHints.verbosity === 'number') {
      const maxLen = 40 + Math.round(req.styleHints.verbosity * 80)
      if (s.length > maxLen) issues.push('verbosity_boundary')
    }
    return issues
  }

  function matchIntent(candidate, request) {
    const kinds = candidate.match && candidate.match.intentKinds
    if (!kinds || !kinds.length) return true
    return kinds.indexOf(request && request.intentKind) >= 0
  }

  function matchBehavior(candidate, request) {
    const behaviors = candidate.match && candidate.match.behaviorKeys
    if (!behaviors || !behaviors.length) return true
    return behaviors.indexOf(request && request.behaviorKey) >= 0
  }

  function matchTone(candidate, request) {
    const tones = candidate.match && candidate.match.tone
    if (!tones || !tones.length) return true
    if (!request || !request.tone) return false
    return tones.indexOf(request.tone) >= 0
  }

  function detectSituations(request, context) {
    try {
      if (window.CharacterSnapshot && typeof window.CharacterSnapshot.situationalProfileFor === 'function') {
        return window.CharacterSnapshot.situationalProfileFor({
          text: (request && request.text) || '',
          intentKind: request && request.intentKind,
          context,
          recentEvents: (context && context.recentEvents) || []
        })
      }
    } catch (err) { /* ignore */ }
    return []
  }

  function matchSituation(candidate, request) {
    const cond = candidate && candidate.match && candidate.match.situations
    if (!cond || !cond.length) return true
    const reqSituations = (request && request.situations) || []
    return cond.some((sid) => reqSituations.indexOf(sid) >= 0)
  }

  function getAffectionValue(request, context) {
    const rel = (context && context.relationship) || (context && context.relationshipSummary) || (request && request.relationship) || {}
    const v = (request && request.variables && request.variables.affection) || (context && context.variables && context.variables.affection) || rel.affection || null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  function matchContext(candidate, request, context) {
    // Minimal local context matcher. Unknown/absent context is never treated as a match.
    const cond = candidate.match && candidate.match.context
    if (!cond || typeof cond !== 'object') return true
    const aff = getAffectionValue(request, context)
    if (typeof cond.minAffection === 'number') {
      if (aff === null || aff < cond.minAffection) return false
    }
    if (typeof cond.maxAffection === 'number') {
      if (aff === null || aff > cond.maxAffection) return false
    }
    if (cond.affectionTier && affectionTierOf(aff) !== cond.affectionTier) return false
    return true
  }

  function inCooldown(candidate, now) {
    const last = history.filter((h) => h.contentId === candidate.id && h.ts > now - (candidate.cooldownMs || 0))
    return last.length > 0
  }

  function buildLegacyCandidates() {
    if (!legacyContent) return []
    const out = []
    const lines = legacyContent.lines || {}
    const customs = legacyContent.customLines || []
    const disabled = legacyContent.disabledGroups || []
    for (const [group, arr] of Object.entries(lines)) {
      if (disabled.indexOf(group) >= 0) continue
      if (!Array.isArray(arr)) continue
      arr.forEach((text, idx) => {
        if (typeof text !== 'string' || !text.trim()) return
        out.push({
          id: 'legacy:' + group + ':' + idx,
          match: { intentKinds: groupToIntents(group) },
          weight: 50 - Math.min(idx, 20),
          priority: 30,
          cooldownMs: 30000,
          text: text.trim(),
          variables: true,
          enabled: true,
          legacy: true
        })
      })
    }
    const customByGroup = {}
    for (const c of customs) {
      if (!c || !c.group || disabled.indexOf(c.group) >= 0 || typeof c.text !== 'string') continue
      if (!customByGroup[c.group]) customByGroup[c.group] = []
      customByGroup[c.group].push(c.text)
    }
    for (const [group, arr] of Object.entries(customByGroup)) {
      arr.forEach((text, idx) => {
        out.push({
          id: 'custom:' + group + ':' + idx,
          match: { intentKinds: groupToIntents(group) },
          weight: 80,
          priority: 35,
          cooldownMs: 30000,
          text: text.trim(),
          variables: true,
          enabled: true,
          legacy: true,
          userCustom: true
        })
      })
    }
    return out
  }

  function groupToIntents(group) {
    switch (group) {
      case 'idle': return ['idle', 'accompany_owner', 'observe_owner']
      case 'happy': return ['celebrate', 'tease_owner', 'seek_attention']
      case 'sad': return ['comfort_owner']
      case 'hungry': case 'thirsty': return ['rest', 'idle']
      case 'eat': return ['celebrate']
      case 'surprise': return ['celebrate', 'respond_to_event']
      case 'birthday': return ['celebrate']
      case 'wake': return ['idle', 'rest']
      case 'send': return ['respond_to_event', 'comment_on_activity']
      default: return ['idle']
    }
  }

  /* 3.1 S2（状态驱动回复）：把只读状态投影产出的本地候选接进候选池。
     候选文本一律来自「状态检索 + 本地模板」（StateExpression），此处不做任何生成。 */
  function stateExpressionCandidates(request, context) {
    try {
      if (!window.StateExpression || typeof window.StateExpression.project !== 'function') return []
      const userText = (request && (request.text || request.userText)) || (context && context.text) || ''
      const se = window.StateExpression.project(context || {}, userText)
      const list = Array.isArray(se && se.candidates) ? se.candidates : []
      return list.map((c) => ({
        id: 'state-expr:' + c.id,
        match: { intentKinds: ['chat', 'respond_to_event', 'comment_on_activity', 'comfort_owner', 'accompany_owner', 'idle'] },
        weight: Number(c.weight) || 60,
        priority: Number(c.priority) || 60,
        cooldownMs: 120000,
        text: c.text,
        variables: false,
        enabled: true,
        stateTemplate: true,
        sourceRef: c.sourceRef || 'state-expression'
      }))
    } catch (err) { return [] }
  }

  function allCandidates(request, context) {
    return BUILTIN_PRESETS
      .concat(stateExpressionCandidates(request, context))
      .concat(buildLegacyCandidates())
  }

  function emojiEmotionState(request) {
    const emo = (request && (request.emotion || (request.context && request.context.emotion))) || {}
    const values = emo.values || emo
    const derived = emo.derivedMood || emo.mood || ''
    const happiness = Number(values.happiness)
    const sadness = Number(values.sadness)
    const loneliness = Number(values.loneliness)
    const fatigue = Number(values.fatigue)
    const annoyance = Number(values.annoyance)
    const shyness = Number(values.shyness || values.shy)
    const surprise = Number(values.surprise || values.shock)
    const confusion = Number(values.confusion || values.confused)
    const excitement = Number(values.excitement)
    if (derived === 'annoyed' || annoyance >= 0.6) return 'annoyed'
    if (derived === 'shy' || shyness >= 0.6) return 'shy'
    if (derived === 'surprised' || surprise >= 0.6) return 'surprised'
    if (derived === 'confused' || confusion >= 0.6) return 'confused'
    if (derived === 'excited' || excitement >= 0.6) return 'excited'
    if (derived === 'cheerful' || derived === 'happy' || (Number.isFinite(happiness) && happiness >= 0.75)) return 'happy'
    if (derived === 'tired' || (Number.isFinite(fatigue) && fatigue >= 0.6)) return 'tired'
    if (derived === 'sad' || derived === 'low' || derived === 'lonely' || (Number.isFinite(sadness) && sadness >= 0.6) || (Number.isFinite(happiness) && happiness <= 0.3) || (Number.isFinite(loneliness) && loneliness >= 0.6)) return 'sad'
    return 'neutral'
  }

  function userCueFor(text) {
    const t = String(text || '')
    if (/(不喜欢|不爱|讨厌|不是喜欢)/.test(t)) return 'annoyed'
    if (/(好开心|太开心|特别开心|高兴|太好了|好耶|真棒|哈哈|开心！|开心呀|开心啦)/.test(t)) return 'positive'
    if (/(真可爱|好可爱|抱抱|喜欢你|爱你|亲亲|想你|好乖|贴贴)/.test(t)) return 'affectionate'
    if (/(大肥鱼|胖鱼|又来了|逗我|开玩笑|调皮|哼|才没有|别闹|别逗)/.test(t)) return 'playful'
    if (/(真的吗|真的？|吓我一跳|吓了一跳|惊讶|诶？|咦？|不是吧|这么厉害|哇)/.test(t)) return 'surprise'
    if (/(不知道怎么办|不明白|搞不懂|啥意思|什么意思|怎么办|困惑|绕进去|想不通)/.test(t)) return 'confused'
    if (/(好难过|难过|伤心|委屈|低落|不开心|想哭|心里难受)/.test(t)) return 'sad'
    if (/(好累|累死|困死|好困|困了|没精神|疲惫|好疲惫)/.test(t)) return 'tired'
    if (/(烦死|好烦|讨厌|生气了|气死|你坏|你才|不要啦|我不要)/.test(t)) return 'annoyed'
    return ''
  }

  function replyCueFor(text) {
    const t = String(text || '')
    if (/(不喜欢|不爱|讨厌|不是喜欢)/.test(t)) return 'annoyed'
    if (/(别难过|别哭|不要难过|没事的|没事啦|抱抱|陪着|我在|别怕|安慰|不怕|会好的)/.test(t)) return 'comfort'
    if (/(爱你|喜欢你|亲亲|想你|可爱|好乖|贴贴)/.test(t)) return 'affectionate'
    if (/(好开心|太开心|特别开心|高兴|太好了|好耶|真棒|不错呀|开心！|开心呀|开心啦|当然|没问题|很喜欢|好呀)/.test(t)) return 'positive'
    if (/(哈哈|逗你|开玩笑|才没有|调皮|大肥鱼|哼|别闹|别逗)/.test(t)) return 'playful'
    if (/(哇|真的吗|没想到|惊讶|不是吧|这么厉害|吓一跳)/.test(t)) return 'surprise'
    if (/(什么意思|不明白|搞不懂|困惑|想不通|怎么办)/.test(t)) return 'confused'
    if (/(难过|伤心|委屈|遗憾|低落|想哭|心里难受)/.test(t)) return 'sad'
    if (/(好累|累死|困死|好困|困了|没精神|疲惫)/.test(t)) return 'tired'
    if (/(好烦|烦死|讨厌|生气|气死|不要啦|我不要)/.test(t)) return 'annoyed'
    return ''
  }

  function replyEmotionState(text) {
    const cue = replyCueFor(text)
    switch (cue) {
      case 'positive': return 'happy'
      case 'comfort': return 'sad'
      case 'sad': return 'sad'
      case 'tired': return 'tired'
      case 'annoyed': return 'annoyed'
      case 'surprise': return 'surprised'
      case 'confused': return 'confused'
      case 'affectionate': return 'happy'
      case 'playful': return 'happy'
      default: return 'neutral'
    }
  }

  function emojiForRequest(request) {
    const intent = request && request.intentKind
    const state = emojiEmotionState(request)

    // 保留原有非 Character Chat intent 分支
    if (intent === 'celebrate') return '😊'
    if (intent === 'tease_owner' && state === 'happy') return '😏'
    if (intent === 'comfort_owner' && state === 'sad') return '🥺'
    if (intent === 'seek_attention' && state === 'sad') return '🤔'
    if (intent === 'rest' && state === 'tired') return '😴'

    if (intent !== 'chat') return ''

    // 快速聊天结尾 emoji 只看回复语义（replyCueFor），不看心情/关系门槛
    switch (replyCueFor(request && request.replyText)) {
      case 'comfort': return '🥺'
      case 'positive': return '😊'
      case 'affectionate': return '💕'
      case 'playful': return '😏'
      case 'surprise': return '😲'
      case 'confused': return '🤔'
      case 'sad': return '🥺'
      case 'tired': return '😴'
      case 'annoyed': return '😤'
      default: return ''
    }
  }

  const TARGET_BUBBLE_LENGTH = 30
  const SOFT_BUBBLE_LIMIT = 32

  function splitLongBeatSegment(seg) {
    if (seg.length <= SOFT_BUBBLE_LIMIT) return [seg]
    const pieces = seg.split(/(?<=[，,；;：、])\s*/).map((x) => x.trim()).filter(Boolean)
    if (pieces.length <= 1) return [seg]
    const out = []
    let cur = ''
    for (const piece of pieces) {
      if (!cur) cur = piece
      else if (cur.length + piece.length <= TARGET_BUBBLE_LENGTH) cur += piece
      else { out.push(cur); cur = piece }
    }
    if (cur) out.push(cur)
    return out.length > 1 ? out : [seg]
  }


  function mergeShortFragments(parts) {
    const out = []
    for (const part of parts) {
      const p = String(part || '').trim()
      if (!p) continue
      if (p.length < 6 && out.length) {
        out[out.length - 1] = out[out.length - 1] + p
      } else {
        out.push(p)
      }
    }
    return out.length ? out : [String(parts.join('')).trim()]
  }

  function containsAnyEmoji(text) {
    const t = String(text || '')
    return /[🀀-🫿☀-➿]/u.test(t)
  }

  function buildBeatsFromText(text, request, sourceRef) {
    const t = String(text || '').trim()
    if (!t) return []
    const sentences = t.split(/(?<=[。！？])/).map((x) => x.trim()).filter(Boolean)
    let parts = []
    for (const seg of (sentences.length ? sentences : [t])) {
      parts.push(...splitLongBeatSegment(seg))
    }
    parts = mergeShortFragments(parts)
    const tone = (request && request.tone) || 'neutral'
    const state = emotionStateOf(request, {})
    const baseDelay = (state === 'low' || state === 'tired' || state === 'worried') ? 650 : (state === 'happy' ? 250 : 350)
    // Multi-bubble is a chat presentation mechanism and must not be suppressed by low relationship.
    const emoji = emojiForRequest(Object.assign({}, request, { replyText: t }))
    const emotionName = request && request.emotion ? (request.emotion.derivedMood || request.emotion.mood || '') : ''
    const sh = (request && request.styleHints) || {}
    const expressionHint = (sh && (typeof sh.energy === 'number' || typeof sh.warmth === 'number' || typeof sh.playfulness === 'number'))
      ? {
          energy: typeof sh.energy === 'number' ? sh.energy : null,
          warmth: typeof sh.warmth === 'number' ? sh.warmth : null,
          playfulness: typeof sh.playfulness === 'number' ? sh.playfulness : null,
          verbosity: typeof sh.verbosity === 'number' ? sh.verbosity : null
        }
      : null
    const beats = parts.map((part, idx) => ({
      text: part,
      tone,
      emotion: emotionName || null,
      emoji: idx === parts.length - 1 ? emoji : '',
      expressionHint,
      delay: idx === 0 ? 0 : baseDelay,
      interruptible: idx < parts.length - 1,
      sourceRef
    }))
    if (emoji && beats.length) {
      const last = beats[beats.length - 1]
      if (!containsAnyEmoji(last.text)) last.text = last.text + emoji
    }
    return beats
  }

  function selectLocalCore(request, context, dryRun) {
    

    const now = Date.now()
    const situations = detectSituations(request, context)
    const req = Object.assign({}, request || {}, { situations, emotion: (request && request.emotion) || (context && context.emotion), relationship: (request && request.relationship) || (context && context.relationship) })
    const filledCache = new Map()
    const candidates = allCandidates(req, context).filter((c) => {
      if (!c.enabled) return false
      if (!matchIntent(c, req)) return false
      if (!matchBehavior(c, req)) return false
      if (!matchTone(c, req)) return false
      if (!matchContext(c, req, context)) return false
      if (!matchSituation(c, req)) return false
      if (inCooldown(c, now)) return false
      const filled = templateText(c.text, req, context)
      if (filled) filledCache.set(c.id, filled)
      if (!filled || validateText(filled, req).length) return false
      return true
    })
    if (!candidates.length) {
      return { ok: false, reason: 'no_local_candidate' }
    }
    candidates.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      if (b.weight !== a.weight) return b.weight - a.weight
      return a.id < b.id ? -1 : 1
    })
    const chosen = candidates[0]
    const text = filledCache.get(chosen.id) || templateText(chosen.text, req, context)
    const result = {
      requestId: request && request.requestId ? request.requestId : null,
      intentKind: request && request.intentKind ? request.intentKind : null,
      behaviorKey: request && request.behaviorKey ? request.behaviorKey : null,
      status: 'spoken',
      text,
      source: chosen.legacy ? (chosen.userCustom ? 'template' : 'preset') : 'preset',
      contentId: chosen.id,
      sourceRef: chosen.sourceRef || null,
      beats: buildBeatsFromText(text, req, chosen.sourceRef || null),
      validation: { ok: true, issues: [] },
      diagnostics: { candidateCount: candidates.length, selectedContentId: chosen.id }
    }
    if (!dryRun) pushHistory(result)
    return { ok: true, result }
  }

  function selectLocal(request, context) {
    return selectLocalCore(request, context, false)
  }

  // 只读预览：复用 selectLocalCore，不写 history / cooldown / AI 开关。
  function previewLocalText(request, context) {
    return selectLocalCore(request, context, true)
  }

  function pushHistory(result) {
    if (!result || !result.contentId) return
    const entry = { contentId: result.contentId, text: result.text, ts: Date.now() }
    history.push(entry)
    if (history.length > MEDIUM_HISTORY) history.shift()
    shortHistory.push(entry)
    if (shortHistory.length > SHORT_HISTORY) shortHistory.shift()
  }

  function suppress(request, reason) {
    suppressed++
    return {
      ok: true,
      result: {
        requestId: request && request.requestId ? request.requestId : null,
        intentKind: request && request.intentKind ? request.intentKind : null,
        behaviorKey: request && request.behaviorKey ? request.behaviorKey : null,
        status: 'suppressed',
        text: '',
        source: 'fallback',
        contentId: null,
        sourceRef: null,
        beats: [],
        validation: { ok: false, issues: [reason] },
        diagnostics: { suppressedReason: reason }
      }
    }
  }


  function cancelRequest(requestId) {
    if (activeResolveId && (!requestId || activeResolveId === requestId)) {
      resolveSeq++
      activeResolveId = null
      return true
    }
    return false
  }

  async function resolveForExpression(expressionPlan, context) {
    const plan = expressionPlan || {}
    const dlg = plan.channels && plan.channels.dialogue ? plan.channels.dialogue : {}
    const passed = context && typeof context === 'object' ? context : {}
    let snap = null
    try { snap = window.CharacterSnapshot && typeof window.CharacterSnapshot.toCharacterContext === 'function'
      ? window.CharacterSnapshot.toCharacterContext()
      : (window.CharacterSnapshot ? window.CharacterSnapshot.build() : null) } catch (err) { /* ignore */ }
    const effective = {
      ...passed,
      ...(snap ? {
        persona: passed.persona || snap.persona,
        emotion: passed.emotion || snap.emotion,
        relationship: passed.relationship || snap.relationship,
        recentMemory: passed.recentMemory || snap.relevantMemories || snap.recentMemory,
        expressionStyle: passed.expressionStyle || snap.expressionStyle
      } : {})
    }
    return resolve({
      requestId: plan.requestId,
      intentKind: plan.intentKind,
      behaviorKey: plan.behaviorKey,
      tone: dlg.tone || 'neutral',
      emotion: effective.emotion,
      relationship: effective.relationship,
      styleHints: plan.styleHints || dlg.styleHints || {}
    }, effective)
  }

  const MEMORY_CLAIM_RE = /(我记得|以前你|上次我们|还记得|我们曾经|那天我们|我看到|我看到了|我听见|我听见了|我闻到|我闻到了|我摸到|我摸到了|我感觉到|桌面上一直|主人今天一直)/

  function hasMemorySupport(text, context) {
    const mems = (context && (context.recentMemory || context.relevantMemories)) || []
    const t = String(text || '')
    return mems.some((m) => {
      const content = m && (m.content || m.text || '')
      return !!content && t.indexOf(content) >= 0
    })
  }

  function naturalClaimFallback(context) {
    const state = emotionStateOf({}, context)
    if (state === 'low') return '嗯……这件事我现在没有记得很清楚。'
    if (state === 'tired') return '这段我没有留下记录，不想装作记得。'
    return '我不太确定，所以不想乱说。'
  }

  function blockUnsupportedMemoryClaim(result, context) {
    const r = result && result.result
    if (!r || r.status !== 'spoken' || !r.text) return result
    if (!MEMORY_CLAIM_RE.test(r.text)) return result
    if (hasMemorySupport(r.text, context)) return result
    const replacement = naturalClaimFallback(context)
    r.text = replacement
    r.sourceRef = null
    r.beats = buildBeatsFromText(replacement, { tone: r.tone || 'neutral', styleHints: r.styleHints || null }, null)
    if (!r.validation) r.validation = { ok: true, issues: [] }
    r.validation = { ok: true, issues: ['memory_claim_unsupported'] }
    if (!r.diagnostics) r.diagnostics = {}
    r.diagnostics.memoryClaimBlocked = true
    return result
  }

  function finalizeResult(result, context) {
    if (result && result.result && result.result.status === 'spoken' && isInternalLabelText(result.result.text)) {
      const r = result.result
      return suppress({ requestId: r.requestId, intentKind: r.intentKind, behaviorKey: r.behaviorKey }, 'internal_label_blocked')
    }
    if (result && result.result && result.result.status === 'spoken') {
      blockUnsupportedMemoryClaim(result, context)
    }
    return result
  }

  async function resolve(request, context) {
    const rid = request && request.requestId ? request.requestId : null
    const gen = ++resolveSeq
    activeResolveId = rid
    const local = selectLocal(request, context)
    if (local.ok) return finalizeResult(local, context)
    if (gen !== resolveSeq || activeResolveId !== rid) {
      return suppress(request, 'cancelled')
    }
    return suppress(request, 'no_local_candidate')
  }

  function init(content) {
    legacyContent = content || null
    shortHistory = []
    history = []
    return getDiagnostics()
  }


  function getHistory() { return deepCopy({ short: shortHistory.slice(), medium: history.slice() }) }
  function clearHistory() { shortHistory = []; history = [] }

  function getDiagnostics() {
    return {
      schemaVersion: SCHEMA_VERSION,
      suppressed,
      shortHistoryCount: shortHistory.length,
      mediumHistoryCount: history.length,
      legacyContentLoaded: !!legacyContent
    }
  }

  const WRITE_BOUNDARY = {
    owner: 'DialogueEngine',
    allowed: ['local-preset', 'template', 'validation'],
    denied: ['intent', 'behavior', 'persona', 'relationship', 'memory', 'emotion', 'state', 'diary'],
    note: 'DialogueEngine only produces DialogueResult; it never writes core domains or creates Memory.'
  }

  return {
    SCHEMA_VERSION,
    init,
    selectLocal,
    previewLocalText,
    buildBeatsFromText,
    replyCueFor,
    replyEmotionState,
    resolve,
    resolveForExpression,
    cancelRequest,
    validateText,
    isInternalLabelText,
    getHistory,
    clearHistory,
    getDiagnostics,
    diagnostics: getDiagnostics,
    WRITE_BOUNDARY
  }
})()













