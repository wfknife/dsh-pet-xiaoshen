/* AIGateway — 3.2 Provider Router
 * Thin router only. It decides WHICH provider serves a purpose:
 *
 *   Gen2 chat / proactive / diary / plan → Direct LLM Provider
 *   agent / work / summary              → DSH Provider
 *
 * It does not own Personality, Memory, Emotion, Relationship, or Behavior.
 */
window.AIGateway = (function () {
  function pt(id, fallback) { return typeof window !== 'undefined' && window.PromptConfig ? window.PromptConfig.text(id, fallback) : fallback }
  const DEFAULT_TIMEOUT = 90000
  const DIARY_TIMEOUT = 120000
  const DAILY_QUOTA_LIMIT = 50
  const QUOTA_KEY = 'aigateway.quota.v1'
  let calls = 0
  let failures = 0

  function isDeceptiveIdentityText(text) {
    return !!(window.IdentityBoundary && window.IdentityBoundary.isDeceptiveIdentityText && window.IdentityBoundary.isDeceptiveIdentityText(text))
  }

  function quotaDayKey() {
    const d = new Date()
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function loadQuotaState() {
    try {
      const raw = localStorage.getItem(QUOTA_KEY)
      if (raw) {
        const d = JSON.parse(raw)
        if (d && d.date === quotaDayKey() && typeof d.used === 'number') return { date: d.date, used: d.used }
      }
    } catch (err) { /* ignore */ }
    return { date: quotaDayKey(), used: 0 }
  }

  function saveQuotaState(state) {
    try { localStorage.setItem(QUOTA_KEY, JSON.stringify(state)) } catch (err) { /* ignore */ }
  }

  function quotaExhausted() {
    const st = loadQuotaState()
    return st.used >= DAILY_QUOTA_LIMIT
  }

  function consumeQuota() {
    const st = loadQuotaState()
    st.used++
    saveQuotaState(st)
    return st
  }

  function resetQuota() {
    saveQuotaState({ date: quotaDayKey(), used: 0 })
    return loadQuotaState()
  }


  /* ---------------------------------------------------------------------------
   * #2：记忆引用"支持判定"不再要求逐字包含。
   * 旧实现：AI 文本必须**逐字包含**某条记忆的原文，否则整段被替换成 12 字兜底句
   *   '我不太确定，所以不想乱说。' ⇒ 再被长度闸判过短 ⇒ 整篇回落本地模板
   *   （实测：19 篇里 11 篇因此走 fallback_local）。
   * 新实现：**不关闭 ClaimGuard**，只把"支持"放宽为「现有数据范围内可解释的重合」：
   *   ① 归一化双向包含（去掉空白/标点后互相包含）；或
   *   ② 记忆集合里出现「声称句的多数实词」（≥2 个实词且长度≥6，或覆盖率≥0.5）。
   * 仍然拦截：系统**没有提供任何相关记忆**时的记忆类断言 —— fail-closed 语义不变。
   * ------------------------------------------------------------------------- */
  const CLAIM_STOPWORDS = ['今天', '昨天', '明天', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '还是', '就是', '因为', '所以', '但是', '然后', '其实', '一直', '已经', '可以', '这个', '一起', '记得', '时候', '事情', '感觉', '真的', '好像', '有点']
  function normalizeClaimText(s) {
    return String(s || '').replace(/[\s，。！？；：、,.!?;:"'“”‘’（）()【】\[\]《》〈〉…—～·\-_/\\|]/g, '').toLowerCase()
  }
  function claimKeywords(s) {
    const segs = String(s || '').split(/[^\u4e00-\u9fa5A-Za-z0-9]+/).filter(Boolean)
    const out = []
    for (const raw of segs) {
      if (/[\u4e00-\u9fa5]/.test(raw)) {
        let s2 = raw
        for (const w of CLAIM_STOPWORDS) s2 = s2.split(w).join(' ')
        for (const piece of s2.split(' ').filter(Boolean)) {
          for (let i = 0; i + 2 <= piece.length; i++) out.push(piece.slice(i, i + 2))
        }
      } else {
        for (const w of raw.split(/\s+/).filter(Boolean)) if (w.length >= 3) out.push(w.toLowerCase())
      }
    }
    return Array.from(new Set(out))
  }
  function collectMemoryTexts(mems) {
    const texts = []
    const push = (v) => {
      const s = normalizeClaimText(v)
      if (s && s.length >= 3) texts.push(s)
    }
    for (const m of (Array.isArray(mems) ? mems : [])) {
      if (!m) continue
      push(m.content)
      push(m.originalContent)
      push(m.normalizedKey)
      push(m.subjectKey)
      push(m.propertyKey)
      push(m.valueKey)
      push(m.date)
      if (Array.isArray(m.tags)) for (const t of m.tags) push(t)
      if (Array.isArray(m.evidenceRefs)) for (const e of m.evidenceRefs) push(e && (e.ref || e.summary || e.text))
    }
    const dedup = []
    for (const x of texts) if (dedup.indexOf(x) < 0) dedup.push(x)
    return dedup
  }
  /** 声称是否有支持：优先"双向包含"，否则要求多数实词在记忆里出现 */
  function memoryClaimSupported(claimText, memTexts) {
    const claim = normalizeClaimText(claimText)
    if (!claim) return false
    for (const mem of memTexts) {
      if (!mem) continue
      if (claim.indexOf(mem) >= 0 || mem.indexOf(claim) >= 0) return true
    }
    const kws = claimKeywords(claimText).filter((k) => memTexts.some((mem) => mem.indexOf(k) >= 0))
    if (!kws.length) return false
    /* 支持条件：允许"短记忆只命中一条实词"的情形，
       但要求该实词≥3 字（排除"饭"这类单字偶然命中）；否则要求 ≥2 条实词。 */
    if (kws.some((k) => k.length >= 3)) return true
    const covered = kws.reduce((a, k) => a + k.length, 0)
    if (kws.length >= 2 && covered >= 4) return true
    if (covered / Math.max(1, claim.length) >= 0.5) return true
    return false
  }

  function finalClaimGuard(text, context) {
    const t = String(text || '').trim()
    const c = context || {}
    const mems = (c.relevantMemories || c.memories || []).filter(Boolean)
    const fallback = '我不太确定，所以不想乱说。'
    if (/(?:我的)?记性.{0,8}(?:不会|不太会).{0,4}漏|我.{0,6}(?:永远(?:都)?记得|绝不会忘|所有.{0,4}都记得)/.test(t)) {
      return { text: '我会按实际留下的记录回想，有些细节可能没有记下来。', reason: 'memory_guarantee_unsupported' }
    }
    if (/(我记得|以前你|上次我们|我们曾经|那天我们|还记得)/.test(t)) {
      /* 修复 #2：支持判定改为"归一化双向包含 + 实词重合"，不再要求逐字包含记忆原文。
         仍然拦截无任何相关记忆时的记忆类断言（fail-closed 不变）。 */
      const memTexts = collectMemoryTexts(mems)
      // 本轮用户原话也是已提供的对话依据，不必先等记忆提取落盘。
      if (c.userText) memTexts.push(normalizeClaimText(c.userText))
      // Diary may recall today's recorded event, without turning it into a past memory.
      // Compare each recall sentence; shared words such as 主人/我/说 are not evidence.
      const daily = Array.isArray(c.currentEvents)
        ? c.currentEvents.filter(e => e && e.sourceRef && e.ts && e.day === c.diaryDay) : []
      const strip = s => String(s || '').replace(/我还记得|我记得|还记得|主人跟我说|主人说|主人|今天|这次|一起|一局|玩了|跟我|我|说|想/g, '')
      const support = daily.length ? t.split(/[。！？\n]/).filter(s => /(我记得|以前你|上次我们|我们曾经|那天我们|还记得)/.test(s)).every(s =>
        memoryClaimSupported(s, memTexts) || (!/(以前|上次|曾经|那天|过去|从前)/.test(s) &&
          memoryClaimSupported(strip(s), daily.map(e => normalizeClaimText(strip(e.text)))))
      ) : memoryClaimSupported(t, memTexts)
      if (!support) return { text: fallback, reason: 'memory_claim_unsupported' }
    }
    const obsRe = /((我看到|我看到了|我听见|我听到了|我闻到|我闻到了|我摸到|我摸到了|我感觉到)\s*(你|主人|他|她|桌|文件|屏幕|电脑|桌面|刚才|正在|打开|关闭))|((我刚刚|我刚)?发现\s*(你|主人|他|她|桌|文件|屏幕|电脑|桌面|刚才|正在|打开|关闭))/
    if (obsRe.test(t)) {
      return { text: fallback, reason: 'observation_claim_unsupported' }
    }
    if (/(我正在摸你的头|我正在抱你|我正牵着你的手|我正在拍你|我有现实身体|我在现实世界)/.test(t)) {
      return { text: fallback, reason: 'physical_capability_claim_unsupported' }
    }
    if (/(我的鲸鱼家族|我的深海家族|我的现实朋友|我的朋友们都)/.test(t)) {
      return { text: fallback, reason: 'persona_world_claim_unsupported' }
    }
    const rf = c.runtimeFacts || {}
    const clock = rf.clock || {}
    const factAvailable = (f) => !!f && f.availability === 'available' && !!f.value
    const dateClaim = /(今天(是|\s*)?\d{1,4}年\d{1,2}月\d{1,2}日|今天(是|\s*)?\d{1,2}月\d{1,2}日|现在(是|)\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}|今天(是|\s*)?\d{4}[-/]\d{1,2}[-/]\d{1,2})/.test(t)
    if (dateClaim && !factAvailable(clock.date)) return { text: fallback, reason: 'runtime_date_unavailable' }
    const timeClaim = /(现在(是|)|当前时间)?\s*\d{1,2}[:：]\d{2}/.test(t)
    if (timeClaim && !factAvailable(clock.time)) return { text: fallback, reason: 'runtime_time_unavailable' }
    const weekdayClaim = /(今天|现在是|本周)?\s*(星期|周)[一二三四五六日天]/.test(t)
    if (weekdayClaim && !factAvailable(clock.weekday)) return { text: fallback, reason: 'runtime_weekday_unavailable' }
    const weatherClaim = /(今天|现在|外面)[^。！？\n]{0,12}(下雨|下雪|晴天|阴天|气温|温度|刮风|雷雨)|(正在下雨|下着雨|天气很好|天气不好|气温是|温度是)/.test(t)
    const weatherAvailable = !!(rf.capabilities && rf.capabilities.weather && rf.capabilities.weather.available)
    if (weatherClaim && !weatherAvailable) return { text: fallback, reason: 'weather_unavailable' }
    const externalClaim = /(我刚(上网|查了|看过)|我查了一下|网上说|新闻报道|我能看到外面|我现在知道外面|我感知到外面)/.test(t)
    if (externalClaim) return { text: fallback, reason: 'external_sense_unavailable' }

    return { text: t, reason: null }
  }


  function classifyResponseScale(userText) {
    const t = String(userText || '').trim()
    if (!t) return 'normal'
    const shortRe = /^(晚安|早安|你好|早上好|中午好|下午好|晚上好|谢谢|谢谢你|嗯|嗯嗯|好的|好哒|好的呀|拜拜|辛苦了|晚安啦|嗨|哈喽|嗨喽|再见|在吗|在不在|早|晚安呀)[!！。.~～?？s]*$/i
    if (shortRe.test(t)) return 'short_social'
    if (/(详细|深入|解释|分析|教程|长文|故事|睡前故事|写一段|展开说说|具体说明|说明一下)/.test(t)) return 'expansive'
    return 'normal'
  }


  function activationProfile(userText) {
    const t = String(userText || '').trim()
    let base = []
    try {
      if (window.CharacterSnapshot && typeof window.CharacterSnapshot.situationalProfileFor === 'function') {
        base = window.CharacterSnapshot.situationalProfileFor({ text: t, intentKind: 'chat' }) || []
      }
    } catch (err) { /* ignore */ }
    const active = new Set(base)
    if (/(米饭|白饭|饭团|吃饭|干饭|白米饭|喜欢吃什么|吃什么|食物|吃的|食物偏好)/.test(t)) active.add('rice_context')
    if (/(大肥鱼|胖鱼|蓝色大肥鱼|小肥鱼)/.test(t)) active.add('big_fat_fish_play')
    if (/(夸|表扬|被夸|厉害|可爱|喜欢你|贴心|优秀)/.test(t)) active.add('praise_lowkey')
    if (/(抱抱|撒娇|亲亲|贴贴|亲昵|想你了|陪我)/.test(t)) active.add('cuddle_whale_mode')
    const askIdentity = /(你是谁|你是什么|你是不是.*(AI|人工智能|程序)|你是.*(AI|人工智能|程序|数字生命|机器人)|你知道自己是.*吗|你住在哪|你住在哪里|你怎么存在|你如何存在|你的存在|你叫什么|你的身份|你是真人吗|你是人类吗|你有身体吗|你是生命吗)/i.test(t)
    const askOcean = /(海洋|深海|鲸鱼|海|海水)/.test(t)
    const askBelief = /(信念|相信|意义|愿望|梦想|弱点|害怕|孤独|陪伴|人生|活着)/.test(t)
    return { profile: Array.from(active), active, askIdentity, askOcean, askBelief, userText: t }
  }

  function traitExpressionBudget(userText) {
    const act = activationProfile(userText || '')
    const scale = classifyResponseScale(userText || '')
    const budgets = {}
    if (act.active.has('rice_context')) budgets.rice = 'low'
    if (act.active.has('big_fat_fish_play')) budgets.big_fat_fish = 'medium'
    if (act.askIdentity) budgets.identity = 'high'
    return { scale, activations: act.profile, budgets }
  }

  function naturalRegister(userText) {
    const t = String(userText || '').trim()
    const wantsStage = /(小说|剧本|角色扮演|舞台说明|动作描写|描述你现在的动作)/.test(t)
    const oceanRequested = /(海洋|深海|海|鲸鱼|海水)/.test(t)
    const literaryRequested = /(小说|故事|文学|诗|散文|长文)/.test(t)
    return {
      address: '你/你的',
      playfulness: 'light',
      stageDirectionAllowed: wantsStage,
      oceanAllowed: oceanRequested || literaryRequested
    }
  }

  function isLegacyPersonaPollution(text) {
    const t = String(text || '').trim()
    if (!t) return false
    const lower = t.toLowerCase()
    // 明确旧人格/data海固定叙事
    if (/数据海/.test(lower)) return true
    if (/数据鲸鱼|数据深处|数字深海|数据流|运行的数据流|数据海洋/.test(lower)) return true
    // 明确“AI/数字身体/无法品尝”式第一人称旧模板
    if (/(我没有味觉|没有味觉|我尝不到|尝不到|尝不到人间味道|我不能吃|我是代码构成|我是由代码|我是一串代码|我的数字身体|我的系统在|作为数字生命|作为一段代码|我的身体是代码|我是数据生命)/i.test(lower)) return true
    // 长而多指标的旧自我叙事：保守排除明显人格百科
    // P3：提高门槛，避免把正常 AI 身份说明误判为旧人格污染。
    let score = 0
    if (/数据海|数据鲸鱼|数据流|数字深海|数字身体/.test(lower)) score += 2
    if (/我是由代码|我是一串代码|我的数字身体|作为数字生命|作为一段代码|我的身体是代码|我是数据生命/.test(lower)) score += 2
    if (/我住在数据|生活在数据|我生活在数字|我住在深海/.test(lower)) score += 2
    if (/我是|我的|作为|住在|生活在/.test(lower)) score += 1
    if (/数字|代码|系统|AI|智能体|数据流/.test(lower)) score += 1
    if (/海洋|深海|鲸鱼|月光|海底|味觉|身体|屏幕|电脑/.test(lower)) score += 1
    return score >= 4 && t.length > 50
  }

  const RECENT_PAIR_COUNT = 3
  const MAX_HISTORY_CHARS = 8000
  /* R-11 A/B：把真实时间与"她主动开过口"两件事恢复进 Chat 上下文。
     · A：只在**表示层**给每条历史加 `[MM-DD HH:MM]` 前缀（数据来自真实 `ts`；无 ts 不加、不伪造）
     · B：assistant-only 条目**只有**命中"已知主动开场白"才作为锚点保留（≤2 条，且必须在被保留区间内）
       ⇒ 普通 assistant-only 历史仍一律不进窗口（pair 语义不变） */
  const MAX_PROACTIVE_ANCHORS = 2
  function historyTimeLabel(ts) {
    const t = Number(ts)
    if (!Number.isFinite(t) || t <= 0) return ''
    const d = new Date(t)
    const p = (x) => String(x).padStart(2, '0')
    return '[' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '] '
  }
  function withTimeLabel(item) {
    const label = historyTimeLabel(item && item.ts)
    return label ? { ...item, text: label + String(item.text || '') } : item
  }
  function isProactiveOpeningItem(item, openings) {
    if (!item || item.role !== 'assistant') return false
    if (item.selfInitiated === true) return true
    if (!Array.isArray(openings) || !openings.length) return false
    const t = String(item.text || '').trim()
    if (!t) return false
    return openings.some((o) => String(o || '').trim() === t)
  }

  function historyToPairs(history) {
    const pairs = []
    let pendingUser = null
    let idx = 0
    for (const h of history) {
      if (!h) { idx++; continue }
      const text = String(h.text || h.content || '')
      if (h.role === 'user') {
        if (pendingUser) pairs.push({ user: pendingUser, assistant: null })
        pendingUser = { ...h, role: 'user', text: text, idx: idx }
        idx++
        continue
      }
      const assistant = { ...h, role: 'assistant', text: text, idx: idx }
      if (pendingUser) {
        pairs.push({ user: pendingUser, assistant })
        pendingUser = null
      } else {
        pairs.push({ user: null, assistant })
      }
      idx++
    }
    if (pendingUser) pairs.push({ user: pendingUser, assistant: null })
    return pairs
  }

  function pairChars(pair) {
    const a = pair && pair.user && String(pair.user.text || '').length || 0
    const b = pair && pair.assistant && String(pair.assistant.text || '').length || 0
    return a + b
  }

  function projectCharacterHistory(history, opts) {
    if (!Array.isArray(history)) return []
    const openings = (opts && Array.isArray(opts.proactiveOpenings)) ? opts.proactiveOpenings : []
    let pairs = historyToPairs(history)
    /* R-11 B：先把"已知主动开场"的 assistant-only 位置记下来（带原索引），它们将被允许作为锚点 */
    const anchorIdx = []
    let idx = 0
    for (const h of history) {
      if (!h) { idx++; continue }
      if (isProactiveOpeningItem(h, openings)) anchorIdx.push(idx)
      idx++
    }

    // pair integrity：只保留完整 user + assistant 对；不完整旧消息不进入历史。
    pairs = pairs.filter((pair) => !!(pair && pair.user && pair.assistant))

    // 仅对“明显旧人格污染”整组淘汰，不再按回复长度淘汰最近正常对话。
    pairs = pairs.filter((pair) => {
      const as = pair && pair.assistant && pair.assistant.text || ''
      return !isLegacyPersonaPollution(as)
    })

    // 最近完整 pairs 必须保留
    const recent = pairs.slice(-RECENT_PAIR_COUNT)
    const older = pairs.slice(0, Math.max(0, pairs.length - RECENT_PAIR_COUNT))

    // 旧历史按完整 pair 倒序加入，直到字符预算耗尽
    const selectedOlderReverse = []
    let usedChars = 0
    for (const pair of recent) usedChars += pairChars(pair)
    for (let i = older.length - 1; i >= 0; i--) {
      const pair = older[i]
      const chars = pairChars(pair)
      if (usedChars + chars > MAX_HISTORY_CHARS) break
      usedChars += chars
      selectedOlderReverse.push(pair)
    }
    const selectedOlder = selectedOlderReverse.reverse()
    const finalPairs = selectedOlder.concat(recent)

    const out = []
    for (const pair of finalPairs) {
      if (pair.user) out.push({ _i: pair.user.idx, role: 'user', text: pair.user.text })
      if (pair.assistant) out.push({ _i: pair.assistant.idx, role: 'assistant', text: pair.assistant.text })
    }
    /* R-11 B（用户授权）：把**真实主动开场**放回它在原始序列里的位置（≤2 条、且只取落在已保留区间内的），
       并加显式标记 `[我先开口说]`，使"她先开的口"在后续轮次可见；普通 assistant-only 仍不进窗口。 */
    if (anchorIdx.length) {
      const minIdx = out.length ? out[0]._i : 0
      const anchors = anchorIdx.filter((i) => i >= minIdx && !out.some(x => x._i === i)).slice(-MAX_PROACTIVE_ANCHORS)
      for (const i of anchors) {
        out.push({ _i: i, role: 'assistant', text: '[我先开口说] ' + String((history[i] || {}).text || '') })
      }
      out.sort((a, b) => a._i - b._i)
    }
    /* R-11 A（用户授权）：表示层加真实时间前缀 `[MM-DD HH:MM]`（无 ts 不加、不伪造；不改历史数据） */
    return out.map((x) => withTimeLabel({ role: x.role, text: x.text, ts: (history[x._i] || {}).ts }))
  }

  function pairAwareHistoryWindow(history, maxItems, opts) {
    const limit = Math.max(2, Number(maxItems) || 20)
    if (!Array.isArray(history)) return []
    const allowAnchors = !(opts && opts.keepProactiveAnchors === false)
    const pairs = []
    let pendingUser = null
    let pos = 0
    for (const item of history) {
      if (!item) { pos++; continue }
      const role = item.role
      if (role === 'user') {
        if (pendingUser) pairs.push({ user: pendingUser, assistant: null, pos: pendingUser._pos })
        pendingUser = Object.assign({}, item, { _pos: pos })
        pos++
      } else if (role === 'assistant') {
        if (pendingUser) {
          pairs.push({ user: pendingUser, assistant: item, pos: pendingUser._pos })
          pendingUser = null
        } else {
          pairs.push({ user: null, assistant: item, pos: pos })
        }
        pos++
      } else { pos++ }
    }
    if (pendingUser) pairs.push({ user: pendingUser, assistant: null, pos: pendingUser._pos })
    const completePairs = pairs.filter((p) => p && p.user && p.assistant)
    const maxPairs = Math.max(1, Math.floor(limit / 2))
    const chosen = completePairs.slice(-maxPairs)
    const out = []
    for (const pair of chosen) {
      if (pair.user) out.push(Object.assign({}, pair.user, { _pos: pair.pos }))
      if (pair.assistant) out.push(Object.assign({}, pair.assistant, { _pos: pair.pos + 1 }))
    }
    /* 与主进程共用同一来源判据：持久化字段或旧投影标记。没有完整对话时也保留首次主动联系。 */
    if (allowAnchors) {
      const minPos = out.length ? Math.min.apply(null, out.map((x) => x._pos)) : 0
      const anchors = pairs.filter((p) => p && !p.user && p.assistant && p.pos >= minPos &&
        (p.assistant.selfInitiated === true || String(p.assistant.text || '').indexOf('[我先开口说]') >= 0)).slice(-MAX_PROACTIVE_ANCHORS)
      for (const p of anchors) out.push(Object.assign({}, p.assistant, { _pos: p.pos }))
      out.sort((a, b) => a._pos - b._pos)
    }
    return out.map((x) => { const { _pos, idx, ...rest } = x; return rest })
  }

  // H4（A1）：能力真值来自 F5 投影（由 pet.js 的 window.lifeContextCapabilityStatusMap() 提供）。
  // **无投影时逐字保持改造前的四项 unavailable** —— A/B 验收要求"四项全 unavailable ⇒ prompt 逐字一致"。

  /* 禁令句：四项全未接入时**与改造前逐字相同**；有任一接入时只改这一句（H4 A1）。 */

  function normalizeStageDirection(text) {
    const raw = String(text || '')
    if (!raw.trim()) return raw
    const actionWords = /尾巴|耳朵|声音|目光|眼神|动作|裙摆|低头|抬头|眨眼|轻轻|顿了顿|笑|叹|晃|摆|垂|弯|抖|皱眉|沉默|夜色|海风|呼吸|指尖|脚步|屏幕|视线|开口|闭上|泛起|漾开|海水|沙滩|梦呓|声音放/
    const lines = raw.split(/\r?\n/)
    const out = []
    for (let line of lines) {
      const t = line.trim()
      if (!t) continue
      if (/^[（(【\[]/.test(t) && /[）)】\]]$/.test(t) && actionWords.test(t)) continue
      if (/^\*[^*]+\*$/.test(t) && actionWords.test(t)) continue
      if (/^\[[^\]]+\]$/.test(t) && actionWords.test(t)) continue
      let cleaned = line
      let m
      while ((m = cleaned.match(/^\s*[（(【\[][^）)】\]]{1,50}[）)】\]]\s*/))) {
        if (!actionWords.test(m[0])) break
        cleaned = cleaned.slice(m[0].length)
      }
      if (cleaned.trim()) out.push(cleaned)
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  function stripKnownTimePrefix(text, options) {
    const t = String(text || ''), o = options || {}
    // Only an unsolicited leading protocol marker matching supplied timestamps.
    // Explicit formatting/quotation requests retain their brackets and times.
    if (/时间戳|时间标记|时间表|日程|日志|格式|原样|逐字|引用|\[\d{1,2}:\d{2}\]/.test(String(o.userText || ''))) return t
    const m = t.match(/^\[((?:(?:\d{4}-)?\d{2}-\d{2} )?\d{2}:\d{2}(?::\d{2})?)\](?:[ \t]+|\r?\n)([\s\S]+)$/)
    if (!m) return t
    const known = new Set()
    for (const h of (o.history || [])) {
      const label = historyTimeLabel(h && h.ts).trim().slice(1, -1)
      if (label) { known.add(label); known.add(label.slice(-5)) }
    }
    const clock = o.context && o.context.runtimeFacts && o.context.runtimeFacts.clock
    const current = clock && clock.time
    if (current && current.availability === 'available') {
      const time = String(current.value || '').match(/\d{2}:\d{2}(?::\d{2})?/)
      if (time) { known.add(time[0]); known.add(time[0].slice(0, 5)) }
    }
    return known.has(m[1]) ? m[2].trimStart() : t
  }
  function normalizeCharacterChatText(text, options) {
    let out = normalizeStageDirection(stripKnownTimePrefix(text, options))
    // 默认亲近语气：避免“您”成为模板
    out = out.replace(/您/g, '你')
    return out
  }

  function providerMetadata(result) {
    const r = result || {}, c = r.completion
    return { provider: typeof r.provider === 'string' ? r.provider.slice(0, 40) : 'direct', model: typeof r.model === 'string' ? r.model.slice(0, 100) : null,
      completion: c ? { finishReason: String(c.finishReason || 'unknown').slice(0, 40), tokens: Math.max(0, Number(c.tokens) || 0), reasoningTokens: Math.max(0, Number(c.reasoningTokens) || 0) } : null }
  }
  async function generate(payload) {
    const p = payload || {}
    const timeoutMs = Number(p.timeoutMs) || DEFAULT_TIMEOUT
    const userText = String(p.userText || p.user || p.prompt || '')
    let history = Array.isArray(p.history) ? pairAwareHistoryWindow(p.history, 20) : []
    let system = String(p.system || '').trim()
    if (p.historyMetadata && history.length) {
      let priorUser = ''
      history = history.map(h => {
        if (h.role === 'user') priorUser = h.text || ''
        return h.role === 'assistant' ? { ...h, text: stripKnownTimePrefix(h.text, { history: [h], userText: priorUser }) } : h
      })
      const metadata = history.map((h, index) => ({ index: index + 1, role: h.role, messageRef: h.messageRef || null,
        at: Number.isFinite(Number(h.ts)) && Number(h.ts) > 0 ? new Date(Number(h.ts)).toISOString() : null,
        selfInitiated: h.selfInitiated === true }))
      system += '\n【历史消息元数据】编号对应随后历史消息的顺序；at 是实际发送时间（ISO 8601），正文另列。\n' + JSON.stringify(metadata)
    }
    if (!userText && !Array.isArray(p.messages)) return { ok: false, reason: 'no_user_message', text: null }
    const maxTokens = p.maxTokens || (p.purpose === 'diary' ? 4096 : undefined)
    /* （M5 日记异常）：日记三步是"有界改写"任务，不需要长思考链；
       实测思考模式默认开启（effort=high）时 reasoning 会吃光输出预算 ⇒ content 为空。
       只透传调用方显式要求，不改其它用途的默认行为。 */
    const thinking = p.thinkingDisabled === true ? { type: 'disabled' } : undefined
    const callOnce = () => (Array.isArray(p.messages) && p.messages.length)
      ? window.pet.llmDirect({ purpose: p.purpose || 'character', promptStage: p.promptStage || p.purpose, promptRevision: window.PromptConfig ? window.PromptConfig.revision() : 'builtin', messages: p.messages, model: p.model, temperature: p.temperature, timeoutMs, maxTokens, thinking })
      : window.pet.llmDirect({ purpose: p.purpose || 'character', promptStage: p.promptStage || p.purpose, promptRevision: window.PromptConfig ? window.PromptConfig.revision() : 'builtin', system, user: userText, history, model: p.model, temperature: p.temperature, timeoutMs, maxTokens, thinking })
    /* （M5 日记异常）：空正文是上游偶发（同一调用点实测 5/20 次 empty，
       且失败后下一次同请求即成功），本地曾一次都不重试 ⇒ 直接流失一篇原稿。这里只加
       **一次**重试，仅针对 `empty`（provider 层错误照旧不重试：重试不会让 401/429/超时变好）。 */
    let r = await callOnce()
    let retryAfterEmpty = false
    if (r && r.ok === false && r.error === 'empty') {
      retryAfterEmpty = true
      r = await callOnce()
    }
    if (!r || !r.ok) {
      failures++
      return { ok: false, reason: r && r.error ? r.error : 'provider_failed', text: null, failureStage: 'provider', retryAfterEmpty, ...providerMetadata(r) }
    }
    const text = String(r.text || '').trim()
    if (!text) { failures++; return { ok: false, reason: 'empty', text: null, failureStage: 'provider_content', ...providerMetadata(r) } }
    if (isDeceptiveIdentityText(text)) { failures++; return { ok: false, reason: 'persona_boundary', text: null } }
    return { ok: true, text, source: 'character-direct', retryAfterEmpty, ...providerMetadata(r) }
  }

  async function direct(payload) {
    const r = await generate(payload)
    if (!r || !r.ok) return r
    const guarded = finalClaimGuard(r.text, payload && payload.context)
    return guarded.reason ? { ok: false, text: null, rawText: r.text, reason: 'guard_rejected', guardReason: guarded.reason } : r
  }

  async function _chatInternal(payload) {
    const p = payload || {}
    if (!window.Gen2 || typeof window.Gen2.chatReply !== 'function') return { ok: false, reason: 'chat_engine_unavailable', text: null }
    const userText = String(p.userText || p.user || p.prompt || '')
    const life = window.PetLife ? window.PetLife.context(Date.now(), null, window.MemoryEngine ? window.MemoryEngine.getMemories() : []) : null
    const policy = window.ConversationPolicy
    const frame = policy && policy.analyzeTurn({ userText, life, history: p.history, now: Date.now(), turnRef: p.messageRef,
      replyTo: p.context && p.context.proactiveReplyTo, availableActions: window.LivingPresence ? Object.keys(window.LivingPresence.ACTIONS) : [] })
    return window.Gen2.chatReply({ ...p, userText, life, frame, scale: classifyResponseScale(userText) })
  }


  // Parse structured internal decisions; visible replies use the separate text path.
  function parseStructured(text) {
    try { return JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) } catch (err) { return null }
  }
  async function structuredModel(payload) {
    const p = payload || {}
    const r = await window.pet.llmDirect({ purpose: p.purpose || 'character-chat', promptStage: p.promptStage || p.purpose, promptRevision: window.PromptConfig ? window.PromptConfig.revision() : 'builtin', system: p.system, temperature: p.temperature,
      user: p.userText, history: Array.isArray(p.history) ? pairAwareHistoryWindow(p.history, 20) : [],
      timeoutMs: Number(p.timeoutMs) || DEFAULT_TIMEOUT, maxTokens: Number(p.maxTokens) || 1536 })
    if (!r || !r.ok || !String(r.text || '').trim()) { failures++; return { ok: false, reason: (r && r.error) || 'provider_failed', failureStage: 'provider', ...providerMetadata(r) } }
    return { ok: true, text: String(r.text).trim(), source: 'character-direct', ...providerMetadata(r) }
  }
  function withLifeEvidence(context, life) {
    const c = Object.assign({}, context || {})
    const words = life && Array.isArray(life.conversations) ? life.conversations.map(t => ({ id: t.messageRef, date: normalizeLocalDay(t.ts), content: t.userText })) : []
    c.relevantMemories = (c.relevantMemories || []).concat(words)
    return c
  }
  async function lifePlan(input) {
    calls++
    const p = input || {}
    const r = await structuredModel({ purpose: 'proactive', promptStage: 'M4_plan', timeoutMs: 60000, maxTokens: 4096,
      system: pt('m4.role', "你为桌宠安排有来源、可执行的虚拟生活。") + '\n' + pt('m4.task', "结合角色偏好、当天经历和当前状态，提出今天剩余时间想做的两三件小事。愿望是未来意向，完成情况由实际执行记录决定。") + "\n可执行 kind：revisit_memory、chat_notes、quiet_rest、curiosity_note。回忆的 sourceId 必须来自 memories；未提供的主人信息和外部经历保持未知。只输出 JSON：{\"activities\":[{\"kind\":\"上述种类之一\",\"wish\":\"最多50字的打算\",\"sourceId\":\"回忆活动对应的真实记忆id\"}]}。",
      userText: JSON.stringify({ instruction: 'revisit_memory 必须附上 sourceId，取自下面 memories 的真实 id；wish 必须对应这条记忆。没有可用记忆就不安排回忆。', persona: p.persona && { identity: p.persona.identity, speech: p.persona.speechBaseline, preferences: p.persona.preferences },
        selfState: p.selfState, tier: window.StateTier ? window.StateTier.describe(window.StateTier.tierFor('plan', window.StateTier.snapshot(p.selfState, p.emotion))) : '', experiences: p.context && p.context.experiences.slice(-3),
        currentPlans: p.context && p.context.activities, memories: p.memories }) })
    if (!r.ok) return { reason: r.reason, completion: r.completion || null }
    return parseStructured(r.text) || { reason: 'invalid_plan_json' }
  }

  async function _diaryInternal(payload) {
    const p = payload || {}
    if (Array.isArray(p.messages) && p.messages.length) {
      return generate({ ...p, purpose: 'diary', promptStage: 'M5_write', messages: p.messages })
    }
    return generate({
      ...p,
      purpose: 'diary',
      promptStage: 'M5_write',
      system: p.system || '',
      userText: p.userText || p.user || p.prompt || '',
      timeoutMs: p.timeoutMs || DIARY_TIMEOUT
    })
  }


  async function chat(payload) { return request({ ...(payload || {}), role: 'chat' }) }
  async function diary(payload) { return request({ ...(payload || {}), role: 'diary' }) }

  async function agent(payload) {
    const p = payload || {}
    // DSH is the only provider for agent/work/summary surfaces.
    if (p.sessionId && (Array.isArray(p.content) || p.text || p.prompt)) {
      return sessionCommand({
        sessionId: p.sessionId,
        text: p.text || p.prompt || '',
        content: p.content,
        mode: p.mode || 'queue'
      })
    }
    if (p.text || p.prompt) {
      // Compatibility helper for DSH-backed summarization.
      return window.pet.chatSend({ text: String(p.prompt || p.text || '') })
    }
    return { ok: false, reason: 'no_agent_payload' }
  }

  /* ===== F4-S5：主动话题生成（AI 只决定"这次具体怎么说"）=====
     边界（用户 2026-09-24 施工单 §七/§八）：不决定要不要主动 / 什么时候 / 主人事实与状态 / 是否打扰 /
     最终 action —— 那些属于 F4 与 F7。本函数只回答"既然我要主动，这次想聊什么"。
     · 输入**白名单**（只读 ctx 的这些键）：reality / expression / experiences(≤3) / emotion / relationship /
       personaProjection / personaCore。窗口标题、URL、页面正文、键盘输入、原始 timeline/segment 数组、
       其它会话内容、**额度数字**一律不注入（调用方多传的键会被忽略）。
     · 输出：严格 JSON `{"topic":≤60字,"opening":≤60字}`；非 JSON ⇒ 整段当 opening。
     · 三道闸：①候选文本纪律（finalClaimGuard；direct 内另有 persona 边界）②maxChars ③必须是提问或邀请。
     · 失败/不合格 ⇒ **不重试** ⇒ `{ok:false}`（调用方退回 F6-A 文本；两者皆空 ⇒ 不展示、不 spend）。 */
  /* B1：把"可以说的时间说法"由**真实日期**算出再交给模型 ⇒ 给它一个
     可核验的合规选项，避免它照抄 ISO 日期（V-4 现象）。给出的每档说法都落在 S-9 `REL_DAY_RULES` 覆盖内：
     说得对 ⇒ 放行；说得错 ⇒ guard 拦。超过 3 天 ⇒ 只允许不带具体日期的说法。纯函数、零 AI、零 IO。 */
  /* PC-2：动作→形态约束（数据驱动；与 proactive.js 的白名单一一对应，只给「怎么说」、不给「要不要说」）。 */
  /* 严格 JSON 优先；非 JSON（或解析失败）⇒ 整段当 opening（施工单 §七）。 */
  /* 第三道闸：必须是提问或邀请（否则这次开口无法被回应，作废走 fallback）。 */
  /* 本地 bigram 相似度（近 7 天开场去重；不使用任何外部依赖）。 */
  /* S-9（第二阶段·用户授权）：**本地、零 AI** 的时间/出处核验。
     只在"内部方向"路径启用（context.internalDirection 存在）⇒ 普通主动行为逐字不变。
     原则：①能确认的日期事实才能陈述；②旧事件不得升级成"今天/刚才/昨天"；
          ③记忆措辞必须绑定真实 evidence（真实 id + 日期）；④**判定不靠关键词重合**；
          ⑤有证据不无脑 fail-closed（非时间性措辞照常放行）。 */
  const REL_DAY_RULES = [
    { re: /(今天|今日|今晚|今早|刚刚|刚才|这会儿|现在)/, offset: 0, label: 'today' },
    { re: /(昨天|昨晚|昨日)/, offset: -1, label: 'yesterday' },
    { re: /(大前天)/, offset: -3, label: 'three-days-ago' },
    { re: /(前天)/, offset: -2, label: 'before-yesterday' }
  ]
  const MEMORY_PHRASE_RE = /(我记得|我还记得|以前|上次|那次|之前|曾经|有一阵子|想起来)/
  function normalizeLocalDay(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      const d = new Date(v)
      const p = (x) => String(x).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }
    const s = String(v == null ? '' : v).trim()
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
    if (!m) return null
    const p = (x) => String(x).padStart(2, '0')
    return m[1] + '-' + p(m[2]) + '-' + p(m[3])
  }
  function shiftLocalDay(dayStr, offset) {
    if (!dayStr) return null
    const parts = dayStr.split('-').map((x) => Number(x))
    const d = new Date(parts[0], parts[1] - 1, parts[2])
    d.setDate(d.getDate() + offset)
    const p = (x) => String(x).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  }
  function verifyTimeProvenance(text, context, nowTs) {
    const c = context || {}
    if (!c.internalDirection) return { ok: true, reason: null, checked: false }
    const t = String(text || '')
    const mems = (Array.isArray(c.relevantMemories) ? c.relevantMemories : []).filter(Boolean)
    const dated = mems.filter((m) => m && m.id && normalizeLocalDay(m.date || m.createdAt))
    const dates = dated.map((m) => normalizeLocalDay(m.date || m.createdAt))
    const hasEvidence = dated.length > 0
    for (const rule of REL_DAY_RULES) {
      if (!rule.re.test(t)) continue
      const want = shiftLocalDay(normalizeLocalDay(Number(nowTs) || 0), rule.offset)
      if (!hasEvidence || !want || dates.indexOf(want) < 0) {
        return { ok: false, reason: 'time_unsupported:' + rule.label, checked: true, wantDay: want, evidenceDays: dates }
      }
    }
    if (MEMORY_PHRASE_RE.test(t) && !hasEvidence) {
      return { ok: false, reason: 'provenance_unsupported', checked: true, wantDay: null, evidenceDays: dates }
    }
    return { ok: true, reason: null, checked: true, wantDay: null, evidenceDays: dates }
  }

  /* ================= CC-5（P3 承接机制； 「连续施工」）=================
     三路输入＝①现在的时刻 ②距主人上次说话＋主人最近一句 ③**该话题上次怎么说的**（复用需承接）。
     四条纪律：**无缓存**／**只注入事实**（时间·上次开场原文·主人原话，不写判断句）／
     **不做硬排除**（cc5CarryPlan 只返回 fresh|switch|carry，"switch" 只是不注入承接行，不淘汰候选）／
     **只有 carry 才注入**（负控：首次或超窗一律不注入）。
     数据源全部只读：`LifeContextOrchestrator.snapshot().ledgerState.entries` ／ `proactiveState(now).instances` ／
     `pet.characterHistoryLoad()`。零新存储、零新 IPC、零新 AI 调用点。
     CC5-START */
  /* 只读取账本视图（取不到就返回 null ⇒ 调用方不注入，绝不推演） */
  /* 主人当时怎么回的：那次开场之后一段窗内的 user 消息（取不到就是取不到，不推断） */
  /* 逐实例派生 topicCard（**每拍现算，不落盘、不跨 tick 缓存**） */
  /* 承接决策：fresh | switch | carry（**从不返回"排除"**） */
  /* 把三路输入**就地**挂到既有 ctx 上（不改任何既有字段、不新增 AI 调用点） */


  async function proactiveTopic(payload) {
    let decision
    try {
      decision = !window.Gen2 || typeof window.Gen2.proactiveDecideSay !== 'function'
        ? { ok: false, reason: 'proactive_engine_unavailable', opening: null }
        : await window.Gen2.proactiveDecideSay(payload || {})
    } catch (err) { decision = { ok: false, reason: 'proactive_engine_error', opening: null } }
    if (window.PetLife && typeof window.PetLife.decisionFeedback === 'function') await window.PetLife.decisionFeedback({ nowTs: Date.now(), quiet: !decision.ok || !!decision.silent })
    return decision
  }

  async function request(payload) {
    const req = payload || {}
    const role = String(req.role || 'chat')
    try {
      if (role === 'summary' || role === 'agent') return await agent(req)
      if (!['chat', 'diary'].includes(role)) return { ok: false, reason: 'unsupported_role', text: null }
      if (quotaExhausted()) return { ok: false, reason: 'quota_exhausted', text: null }
      consumeQuota()
      calls++
      const result = role === 'diary' ? await _diaryInternal(req) : await _chatInternal(req)
      // A local configuration refusal is not a paid generation. Transport/model
      // failures still consume the budget to prevent unbounded retry storms.
      if (result && !result.ok && ['no-key', 'disabled', 'no_provider', 'provider_disabled'].includes(result.reason)) {
        const q = loadQuotaState(); q.used = Math.max(0, q.used - 1); saveQuotaState(q)
      }
      return result
    } catch (err) {
      failures++
      return { ok: false, reason: 'error', text: null, error: String((err && err.message) || err) }
    }
  }

  async function sessionChat(payload) {
    const p = payload || {}
    const sid = p.sessionId
    const content = Array.isArray(p.content) ? p.content : [{ type: 'text', text: String(p.text || '') }]
    if (!sid) return { ok: false, reason: 'no_session', error: 'no-session' }
    calls++
    try {
      const pr = await window.pet.api('session.prompt', { sessionId: sid, mode: 'queue', content })
      if (!pr || !pr.result || !pr.result.ok) return { ok: false, reason: 'prompt_failed' }
      for (let i = 0; i < 45; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const lr = await window.pet.api('session.list', {})
        const items = (lr && lr.result && lr.result.ok && lr.result.value.items) || []
        const item = items.find((s) => s.sessionId === sid)
        if (item && item.running) continue
        const hr = await window.pet.api('session.history', { sessionId: sid, maxMessages: 8 })
        if (hr && hr.result && hr.result.ok) {
          const events = hr.result.value.events || []
          const lastAssistant = [...events].reverse().find((e) => e && e.role === 'assistant')
          const reply = lastAssistant && (lastAssistant.text || lastAssistant.content || '')
          if (reply) {
            if (isDeceptiveIdentityText(reply)) return { ok: false, reason: 'persona_boundary' }
            return { ok: true, text: reply, source: 'dsh-agent' }
          }
        }
      }
      return { ok: false, reason: 'timeout' }
    } catch (err) {
      failures++
      return { ok: false, reason: 'error', error: String(err && err.message || err) }
    }
  }

  async function sessionCommand(payload) {
    try {
      return await window.pet.api('session.prompt', payload || {})
    } catch (err) {
      return { result: { ok: false, error: { message: String(err && err.message || err) } } }
    }
  }


  function claimGuard(text, context) { return finalClaimGuard(text, context) }
  function timeProvenanceGuard(text, context, nowTs) { return verifyTimeProvenance(text, context, nowTs) }


  function getDiagnostics() {
    const st = loadQuotaState()
    return { dailyQuotaLimit: DAILY_QUOTA_LIMIT, usedToday: st.used, resetAt: 'daily', calls, failures }
  }

  return {
    request,
    direct,
    generate,
    chat,
    diary,
    agent,
    proactiveTopic,
    lifePlan,
    timeProvenanceGuard,
    sessionChat,
    sessionCommand,
    isDeceptiveIdentityText,
    claimGuard,
    _internals: { finalClaimGuard, withLifeEvidence, parseStructured, classifyResponseScale, stripKnownTimePrefix },
    projectCharacterHistory,
    pairAwareHistoryWindow,
    isLegacyPersonaPollution,
    activationProfile,
    traitExpressionBudget,
    naturalRegister,
    normalizeStageDirection,
    normalizeCharacterChatText,
    getDiagnostics,
    resetQuota,
    diagnostics: getDiagnostics
  }
})()
