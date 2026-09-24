/* CharacterSnapshot — Runtime Experience Polish v2
 * Minimal read-only aggregate of the current character-facing state.
 * Does not write anything; only snapshots existing 3.0 engines.
 */
window.CharacterSnapshot = (function () {
  function build() {
    let persona = null
    let emotion = null
    let relationship = null
    let recentEvents = []
    let recentMemory = []
    let expressionStyle = null
    let selfState = null
    try {
      const ui = window.UIAdapter
      const stats = ui && typeof ui.get === 'function' ? ui.get('stats') : null
      if (stats && typeof stats === 'object') {
        selfState = { source: 'pet_needs', capturedAt: Date.now() }
        for (const key of ['satiety', 'thirst', 'energy']) {
          if (Number.isFinite(stats[key])) selfState[key] = Math.max(0, Math.min(100, stats[key]))
        }
      }
    } catch (err) { /* unavailable */ }
    try { if (window.PersonaCore) persona = window.PersonaCore.getCore() } catch (err) { /* ignore */ }
    try { if (window.EmotionEngine) emotion = window.EmotionEngine.getSnapshot() } catch (err) { /* ignore */ }
    try { if (window.RelationshipEngine) relationship = window.RelationshipEngine.get() } catch (err) { /* ignore */ }
    try { if (window.EventBus && window.EventBus.recent) recentEvents = window.EventBus.recent().slice(-5) } catch (err) { /* ignore */ }
    try { if (window.MemoryRetrieval) recentMemory = window.MemoryRetrieval.retrieve({}, { limit: 3 }) } catch (err) { /* ignore */ }
    try { if (window.ExpressionEngine && window.ExpressionEngine.getActivePlan) {
      const plan = window.ExpressionEngine.getActivePlan()
      expressionStyle = plan && plan.styleHints ? plan.styleHints : null
    } } catch (err) { /* ignore */ }
    return {
      persona,
      emotion,
      relationship,
      selfState,
      recentEvents,
      recentMemory,
      expressionStyle
    }
  }

  function relevantFor(userText, snapshot, history) {
    const s = snapshot || build()
    if (userText && window.MemoryRetrieval && typeof window.MemoryRetrieval.retrieve === 'function') {
      try {
        let query = String(userText)
        if (/^(后来呢|然后呢|为什么|那呢|怎么说|真的吗|还记得吗|那件事|接着说|继续)[？?。！!\s]*$/.test(query.trim())) {
          const turns = Array.isArray(history) ? history.filter(x => x && x.role === 'user' && typeof x.text === 'string' && x.text.trim() && x.text.trim() !== query.trim()) : []
          const previous = turns[turns.length - 1]
          if (previous) query += ' ' + previous.text.slice(0, 300)
        }
        const r = window.MemoryRetrieval.retrieve(query, { limit: 3 })
        return Array.isArray(r) ? r : []
      } catch (err) { return [] }
    }
    return Array.isArray(s.recentMemory) ? s.recentMemory : []
  }

  function toCurrentDateContext() {
    const now = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const week = ['周日','周一','周二','周三','周四','周五','周六']
    let timezone = ''
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch (err) { /* ignore */ }
    return {
      currentDate: now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate(),
      weekday: week[now.getDay()],
      timezone,
      capturedAt: now.getTime()
    }
  }

  function toRuntimeFacts() {
    const now = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const week = ['周日','周一','周二','周三','周四','周五','周六']
    const capturedAt = now.getTime()
    let timezone = ''
    try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch (err) { /* ignore */ }
    let locale = ''
    try { locale = Intl.DateTimeFormat().resolvedOptions().locale || '' } catch (err) { /* ignore */ }
    const dateValue = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate()
    const timeValue = p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds())
    return {
      schemaVersion: 1,
      capturedAt,
      clock: {
        date: { value: dateValue, source: 'system_clock', capturedAt, availability: 'available' },
        time: { value: timeValue, source: 'system_clock', capturedAt, availability: 'available' },
        timezone: { value: timezone || null, source: 'system_clock', capturedAt, availability: timezone ? 'available' : 'unavailable' },
        weekday: { value: week[now.getDay()] || null, source: 'system_clock', capturedAt, availability: 'available' }
      },
      environment: {
        locale: { value: locale || null, source: 'system_locale', capturedAt, availability: locale ? 'available' : 'unavailable' }
      },
      capabilities: {
        weather: { available: false, source: 'none', reason: 'not_connected' },
        web: { available: false, source: 'none', reason: 'not_connected' },
        screen: { available: false, source: 'none', reason: 'not_connected' },
        browser: { available: false, source: 'none', reason: 'not_connected' }
      }
    }
  }

  function toPersonaBaselineContext(snapshot) {
    const s = snapshot || build()
    const persona = s.persona || {}
    const sp = persona.speechBaseline || {}
    return '[表达基线] 默认：' + (sp.tone || '温婉、克制、安静、可靠') + '；默认称呼：' + (sp.defaultAddressing || '主人') + '；仅明确情境才使用：' + (sp.intimateAddressing || '主人sama') + '。'
  }

  function toMemoryPromptContext(snapshot) {
    const s = snapshot || build()
    const mems = Array.isArray(s.recentMemory) ? s.recentMemory : []
    const lines = []
    lines.push('[小深的真实记忆（只能引用以下内容）]')
    if (mems.length) {
      for (const m of mems) {
        const content = m && (m.content || m.text || '')
        if (!content) continue
        const date = m && m.date ? m.date : ''
        lines.push('- ' + (date ? date + '：' : '') + content)
      }
    } else {
      lines.push('（当前没有可确认的真实记忆）')
    }
    lines.push('')
    lines.push('[记忆引用纪律]')
    lines.push('1. 只能引用上方列出的真实记忆。')
    lines.push('2. 禁止补写不存在的经历，禁止推测不存在的历史。')
    lines.push('3. 禁止把当前事件说成“以前/过去/那天”的记忆。')
    lines.push('4. 无法确认时不要提及任何记忆。')
    return lines.join('\n')
  }

  function toPromptContext() {
    const s = build()
    const parts = []
    const p = s.persona && s.persona.identity ? s.persona.identity : {}
    if (p.displayName) parts.push('我是' + p.displayName)
    const e = s.emotion && s.emotion.values ? s.emotion.values : {}
    const mood = s.emotion && s.emotion.derivedMood ? s.emotion.derivedMood : null
    if (mood) parts.push('当前心情：' + mood)
    if (typeof e.fatigue === 'number' && e.fatigue >= 0.7) parts.push('有点累')
    const r = s.relationship || {}
    if (typeof r.affection === 'number') parts.push('和主人亲近程度：' + Math.round(r.affection))
    const dateCtx = toCurrentDateContext()
    parts.push('当前日期：' + dateCtx.currentDate + '（' + dateCtx.weekday + (dateCtx.timezone ? '，' + dateCtx.timezone : '') + '）')
    const head = parts.join('；') + '\n\n'
    return head + toPersonaBaselineContext(s) + '\n\n' + toMemoryPromptContext(s)

  }

  function toDiaryContext() {
    const s = build()
    const persona = s.persona || {}
    /* D1：日记的**写作面**投影 —— `PersonaCore.project('diary')` 早就实现了
       （perspective / baseline / addressing / beliefs / selfAwarenessBoundary + 基座的
       identity / expressionProfile），但此前**全仓无人调用**（唯一调用点是 `project('chat')`）。
       这里挂进日记上下文，作为"身份 / 语气 / 称呼"的**主来源**；失败回落 null（调用方再回落裸 persona）。 */
    let personaProjectionDiary = null
    try {
      if (window.PersonaCore && typeof window.PersonaCore.project === 'function') {
        personaProjectionDiary = window.PersonaCore.project('diary')
      }
    } catch (err) { personaProjectionDiary = null }
    return {
      persona: s.persona,
      personaProjectionDiary,
      selfState: s.selfState,
      emotion: s.emotion,
      relationship: s.relationship,
      recentMemory: s.recentMemory,
      relevantMemories: s.recentMemory,
      recentEvents: s.recentEvents,
      expressionStyle: s.expressionStyle,
      selfAwareness: persona.selfAwarenessBoundary ? {
        isAI: true,
        honestAllowed: persona.selfAwarenessBoundary.honestAllowed || [],
        forbidden: persona.selfAwarenessBoundary.forbidden || [],
        note: persona.selfAwarenessBoundary.note || ''
      } : null
    }
  }

  function toCharacterContext() {
    const s = build()
    const persona = s.persona || {}
    return {
      source: 'character-snapshot',
      capturedAt: Date.now(),
      persona,
      emotion: s.emotion,
      relationship: s.relationship,
      recentEvents: s.recentEvents,
      relevantMemories: s.recentMemory,
      expressionStyle: s.expressionStyle,
      selfAwareness: persona.selfAwarenessBoundary ? {
        isAI: true,
        honestAllowed: persona.selfAwarenessBoundary.honestAllowed || [],
        forbidden: persona.selfAwarenessBoundary.forbidden || [],
        note: persona.selfAwarenessBoundary.note || ''
      } : null
    }
  }

  function toCharacterAIContext(input) {
    const s = build()
    const userText = typeof input === 'string' ? input : (input && (input.userText || input.text)) || ''
    const persona = s.persona || {}
    const projection = window.PersonaCore && typeof window.PersonaCore.project === 'function'
      ? window.PersonaCore.project('chat')
      : null
    const dateCtx = toCurrentDateContext()
    const runtimeFacts = toRuntimeFacts()
    return {
      schemaVersion: 1,
      capturedAt: runtimeFacts.capturedAt,
      runtimeFacts,
      personaProjection: projection || persona,
      expressionStyle: s.expressionStyle,
      persona: persona,
      emotion: s.emotion,
      relationship: s.relationship,
      relevantMemories: relevantFor(userText, s, input && input.history),
      selfState: s.selfState,
      petLife: window.PetLife ? window.PetLife.context(runtimeFacts.capturedAt, null, window.MemoryEngine ? window.MemoryEngine.getMemories() : []) : null,
      recentEvents: Array.isArray(s.recentEvents) ? s.recentEvents : [],
      currentDate: dateCtx.currentDate,
      weekday: dateCtx.weekday,
      timezone: dateCtx.timezone,
      userText: String(userText || ''),
      situationalProfile: situationalProfileFor({ text: userText, intentKind: 'chat' }),
      selfAwareness: persona.selfAwarenessBoundary ? {
        isAI: true,
        honestAllowed: persona.selfAwarenessBoundary.honestAllowed || [],
        forbidden: persona.selfAwarenessBoundary.forbidden || [],
        note: persona.selfAwarenessBoundary.note || ''
      } : null,
      claimRules: {
        noUnsupportedMemoryClaim: true,
        noUnsupportedObservationClaim: true,
        noUnsupportedEventClaim: true,
        noUnsupportedPersonaWorldClaim: true,
        noUnsupportedPhysicalCapabilityClaim: true,
        allowEmotionalWish: true
      }
    }
  }

  function situationalProfileFor(input) {
    const x = input && typeof input === 'object' ? input : {}
    const text = String(x.text || '').toLowerCase()
    const intentKind = x.intentKind || ''
    const events = Array.isArray(x.recentEvents) ? x.recentEvents : (x.context && Array.isArray(x.context.recentEvents) ? x.context.recentEvents : [])
    const active = new Set()

    // 被夸：真实用户言语中明确夸奖
    if (/(真棒|好棒|厉害|可爱|喜欢你|辛苦了|聪明|贴心|优秀|赞美|夸)/.test(text)) active.add('praise_lowkey')
    // 温暖/感谢：被感谢或被需要，属于亲近但克制的表达
    if (/(谢谢|感谢|多谢|辛苦了|帮我|陪着)/.test(text)) active.add('affection_warmth')
    // 大肥鱼玩梗：用户明确使用昵称
    if (/(大肥鱼|胖鱼|小肥鱼|蓝色大肥鱼)/.test(text)) active.add('big_fat_fish_play')
    // 米饭：用户明确讨论米饭/吃饭
    if (/(米饭|大米|白饭|饭团|吃饭|干饭|白米饭)/.test(text)) active.add('rice_context')
    // 撒娇/亲昵：用户明确表达亲昵请求
    if (/(抱抱|撒娇|亲亲|贴贴|亲昵|想你了|陪我)/.test(text)) active.add('cuddle_whale_mode')
    // 犯错/失败：真实错误语境或事件
    if (/(错了|失败|出错|搞砸|故障|翻车|失误)/.test(text) || events.some((e) => e && /错误|失败|出错|故障/.test(String(e.text || e.kind || '')))) active.add('mistake_natural_dull')
    // 庆祝：明确庆祝/节日语境
    if (/(庆祝|生日|恭喜|节日|纪念日|恭喜你)/.test(text) || intentKind === 'celebrate') active.add('celebration')
    // 专业模式：工作/任务类 Intent 或用户明确问任务
    if (intentKind === 'work' || intentKind === 'task' || intentKind === 'professional' || /(工作|任务|方案|分析|代码|报告|帮我做|帮我写)/.test(text)) active.add('professional_mode')
    // 冲突规则：明确“搞砸/出错”时，错误情境优先于专业情境，避免“失误也被冷冰冰处理”。
    if (active.has('mistake_natural_dull')) active.delete('professional_mode')
    if (active.size === 0) active.add('ordinary_conversation')
    return Array.from(active)
  }

  return { build, get: build, snapshot: build, toPromptContext, toCurrentDateContext, toPersonaBaselineContext, toMemoryPromptContext, toDiaryContext, toCharacterContext, toCharacterAIContext, toRuntimeFacts, situationalProfileFor }
})()




