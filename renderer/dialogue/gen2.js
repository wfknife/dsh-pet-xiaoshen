/* gen2：v0.4 决策/表达分责生成层（M1 聊天 / M2 主动）
 * 原则：
 *  · 决策用**抽象角色**（不注入 {名} 完整人设，不写最终台词，无长期决策人格）；
 *  · 表达才注入 {名} 核心人设（PromptSlots 槽位按需装配，人设不整篇喂）；
 *  · 可见文字单任务纯文本；记忆/元数据独立后台调用，不与表达混装；
 *  · 守卫命中做**一次有界修复**再复核，不整条替换、不加禁令堆；
 *  · silent 是合法终态；F7/候选池/冷却/validateDecision 全部沿用旧链。
 * 自称名唯一来源 = displayName。 */
(function () {
  'use strict'
  function pt(id, fallback) { return typeof window !== 'undefined' && window.PromptConfig ? window.PromptConfig.text(id, fallback) : fallback }


  const TEMP = { decide: 0.5, say: 0.8, reply: 0.8, meta: 0.2, repair: 0.4 }
  const MEM_GUARANTEE_RE = /(?:我的)?记性.{0,8}(?:不会|不太会).{0,4}漏|永远(?:都)?记得|绝不会忘|所有.{0,4}都记得/

  function slots() { return window.PromptSlots || null }
  function nameOf(ctx) {
    try {
      const p = (ctx && (ctx.personaProjection || ctx.persona)) || {}
      return String((p.identity && p.identity.displayName) || '').trim()
    } catch (e) { return '' }
  }
  function agw() { return window.AIGateway || {} }
  function internals() { return (agw()._internals) || {} }

  // 原文生成与最终事实核验分开；底层不能先把正文换成兜底，再让这里核验兜底。
  async function llm(p) {
    if (['M1_reply', 'M2_say'].includes(p.promptStage)) p = { ...p, system: String(p.system || '') + '\n【输出通道】本次只生成普通聊天正文。动画由独立表现通道执行；不在正文输出括号或星号包裹的舞台动作、内心独白。事件中的 actor 是行为者，observer 只是观察者，不能互换。' }
    if (window.PlatformCandidate && window.PlatformCandidate.enabled && window.ContextProjector && p.projectionInput) {
      const projection = window.ContextProjector.project(p.promptStage, { ...p.projectionInput, promptRevision: window.PromptConfig ? window.PromptConfig.revision() : 'builtin' })
      p = { ...p, system: String(p.system || '') + '\n【本次相关语境】\n' + projection.text, projectionTrace: projection.trace }
    }
    const result = await agw().generate(p)
    if (result && result.ok && ['M1_reply', 'M2_say'].includes(p.promptStage) && window.SpeechChannel) {
      const channel = window.SpeechChannel.validate(result.text)
      if (!channel.ok) return { ok: false, reason: channel.reason, rawText: result.text, text: '' }
    }
    return result
  }

  /* ---------------- M2：决策（抽象角色） + 措辞（{名} 人设） ---------------- */

  function abstractRole(taskLine) {
    return pt('m2.0f7edc8475', '根据交流情境和真实来源，判断此刻是否有值得交流的内容。') + (taskLine || '')
  }

  async function proactiveDecide(payload, execution) {
    if (window.RoleRuntime && !window.RoleRuntime.isAuthorized(execution)) return { ok: false, reason: "runtime_authorization_required" }
    const p = window.ContextSelection ? window.ContextSelection.proactive(payload) : payload || {}
    const candidates = Array.isArray(p.candidates) ? p.candidates : []
    if (!candidates.length) return { ok: true, silent: true, reason: 'no_sourced_topic' }
    if (!execution && window.PetLife && typeof window.PetLife.reserveDecision === 'function') {
      const r = window.PetLife.reserveDecision(Date.now())
      if (r && r.ok === false && r.unchanged) return { ok: false, reason: 'thinking_cooldown' }
    }
    const ctx = p.context || {}
    const name = nameOf(ctx)
    const S = slots()
    const tier = window.StateTier ? window.StateTier.tierFor('proactive', window.StateTier.snapshot(ctx.selfState, ctx.emotion)) : null

    /* 决策调用：抽象角色 + CD/FT 槽 + 状态分档数据；输出决策包，不写台词 */
    const decideSystem = S ? S.join([
      abstractRole(pt('m2.143e43da82', '现在判断要不要主动跟主人开口说一句话。')),
      S.cdSlot(),
      S.ftSlot(),
      tier ? window.StateTier.describe(tier) : '',
      pt('m2.f8620c62af', '从候选素材里选一件真正值得说的（新进展/自己的活动或感受/没聊完的话题优先）；没有就选择沉默，沉默是完全正常的结果。'),
      '只输出 JSON：{"speak":true,"candidateId":"候选id","form":"share|question|invite|accompany|celebrate","focus":"选中素材里值得交流的具体信息，短标签"}；不想开口输出 {"speak":false}。'
    ]) : null
    const decideUser = JSON.stringify({
      action: p.action || null, now: p.now || new Date().toLocaleString('zh-CN'),
      selfState: ctx.selfState || null, emotion: ctx.emotion || null, relationship: ctx.relationship || null,
      /* 候选必须带日期与新鲜度（pet-life.js:472-501 提供）：否则 10 天前的事与刚发生的事在提示词里无差别。
         只给标签，不加"旧事不许说成刚发生"这类禁令——缺口在数据不在措辞。 */
      candidates: candidates.map(c => ({ id: c.id, text: c.text, forms: c.forms, date: c.date || null, fresh: !!c.fresh, actor: c.actor || 'unknown', observer: c.observer || 'unknown', subject: c.subject || c.actor || 'unknown', world: c.world || 'unknown', sourceType: c.sourceType || c.source, opportunity: c.opportunity || null })),
      recentOpenings: (p.recentOpenings || []).slice(-5),
      /* 最近联系：过去开口过什么、什么时候（真实 ts）。原来只读 p.recentContacts（payload 里没有该字段）⇒ 恒空。 */
      recentContacts: ((p.recentContacts && p.recentContacts.length ? p.recentContacts : (ctx.petLife && ctx.petLife.recentContacts) || []) || [])
        .slice(-5).map(c => ({
          at: c && (c.presentedAt || c.ts) ? new Date(Number(c.presentedAt || c.ts)).toLocaleString('zh-CN') : null,
          action: String((c && (c.candidateId || c.instanceId)) || ''),
          replied: !!(c && c.repliedAt)
        }))
    })
    const dr = await llm({ purpose: 'proactive', promptStage: 'M2_decide', system: decideSystem, userText: decideUser, projectionInput: p, temperature: TEMP.decide, maxTokens: 800, timeoutMs: 60000 })
    if (execution) execution.assertCurrent()
    if (!dr || !dr.ok) return { ok: false, reason: (dr && dr.reason) || 'provider_failed', source: 'fallback', opening: null, topic: null }
    let raw = internals().parseStructured ? internals().parseStructured(dr.text) : null
    if (!raw) return { ok: false, reason: 'invalid_decision_json', source: 'fallback', opening: null, topic: null }
    /* 复用旧校验（form/来源/action 匹配/记忆保证词表）：opening 以 focus 占位，最终措辞再校验一次 */
    const v = window.PetLifeModule && window.PetLifeModule.validateDecision
      ? window.PetLifeModule.validateDecision(Object.assign({}, raw, { opening: String(raw.focus || '待写').slice(0, 100) }), candidates, p.action)
      : { ok: false, reason: 'no_validator' }
    if (!execution && window.PetLife && typeof window.PetLife.decisionFeedback === 'function' && (!v.ok || v.silent)) {
      try { await window.PetLife.decisionFeedback({ nowTs: Date.now(), quiet: !v.ok || !!v.silent }) } catch (e) { /* ignore */ }
    }
    if (!v.ok) return { ok: false, reason: v.reason, source: 'fallback', opening: null, topic: null }
    if (v.silent) return { ok: true, silent: true, reason: 'planner_silent' }

    return { ok: true, silent: false, prepared: { p, raw, v } }
  }

  async function proactiveSay(decision, execution) {
    if (window.RoleRuntime && !window.RoleRuntime.isAuthorized(execution)) return { ok: false, reason: 'runtime_authorization_required' }
    if (!decision || !decision.ok || decision.silent || !decision.prepared) return decision || { ok: false, reason: 'missing_decision' }
    const { p, raw, v } = decision.prepared
    const ctx = p.context || {}, name = nameOf(ctx), S = slots()
    /* 措辞调用：{名} 人设（ID+VO 半槽），只说这一句 */
    const sayStyle = S && S.styleSlot ? await S.styleSlot('M2_say') : null
    const saySystem = S ? S.join([
      S.idSlot(name),
      S.voSlot(),
      S.characterSlot ? S.characterSlot(ctx, String(raw.focus || '')) : '',
      sayStyle ? pt(sayStyle.promptId, '') : '',
      pt('m2.6f027c6a99', '以当前角色的身份，把已经决定分享的内容自然地说出来。结合当下情况组织语言，表达自己的意思。'),
      '只输出这一句话。'
    ]) : null
    const candidate = v.candidate || {}
    const sayUser = JSON.stringify({ focus: String(raw.focus || v.topic || ''), opportunity: candidate.opportunity || { reason: 'selected_topic_with_current_availability' }, evidence: { text: candidate.text || '', actor: candidate.actor || 'unknown', observer: candidate.observer || 'unknown', subject: candidate.subject || candidate.actor || 'unknown', world: candidate.world || 'unknown', occurredAt: candidate.originTs || null, sourceType: candidate.sourceType || candidate.source }, communication: candidate.kind === 'social_contact' ? '自然闲聊；不得声称有新事件或虚构共同经历。' : '可以使用真实素材；不要求复述事件。' })
    if (execution) execution.assertCurrent()
    const sr = await llm({ purpose: 'proactive', promptStage: 'M2_say', system: saySystem, userText: sayUser, projectionInput: { ...p, candidate: v.candidate }, temperature: TEMP.say, maxTokens: 200, timeoutMs: 60000 })
    if (execution) execution.assertCurrent()
    let opening = ((sr && sr.ok && sr.text) || '').trim()
    if (!opening) return { ok: false, reason: 'empty_opening', source: 'fallback', opening: null, topic: null }

    /* 最终措辞校验：记忆保证词表 + 长度（复用 validateDecision 对 opening 的检查） + claimGuard 一次修复 */
    if (MEM_GUARANTEE_RE.test(opening)) opening = ''
    if (opening && opening.length > 100) opening = opening.slice(0, 100)
    if (!opening) return { ok: false, reason: 'invalid_opening', source: 'fallback', opening: null, topic: null }
    if (window.EvidenceClaims) {
      const checked = window.EvidenceClaims.check(opening, { candidate: v.candidate, life: p.life || ctx.petLife, nowTs: p.nowTs || Date.now() })
      if (!checked.ok) return { ok: false, reason: 'guard_rejected', guardReason: checked.reason, rawText: opening, opening: null, topic: null }
    }
    const guard = internals().finalClaimGuard
    let guarded = guard ? guard(opening, internals().withLifeEvidence ? internals().withLifeEvidence(ctx, p.life) : null) : { text: opening, reason: null }
    if (guarded.reason) {
      const fixed = await repairOnce(opening, guarded.reason, ctx)
      if (execution) execution.assertCurrent()
      const re = fixed && guard ? guard(fixed, internals().withLifeEvidence ? internals().withLifeEvidence(ctx, p.life) : null) : null
      if (re && !re.reason) guarded = re
      else return { ok: false, reason: 'guard_rejected', source: 'fallback', opening: null, topic: null, guardReason: guarded.reason }
    }
    /* bigram 去重（近 N 条开场相似即弃） */
    const recent = (p.recentOpenings || []).map(String)
    if (recent.length && bigramDup(guarded.text, recent)) return { ok: false, reason: 'duplicate_opening', source: 'fallback', opening: null, topic: null }
    return { ok: true, silent: false, source: 'ai', opening: guarded.text, topic: String(raw.focus || v.topic || '').slice(0, 60),
      sourceIds: v.sourceIds, sourceKeys: v.sourceKeys, fresh: v.fresh, form: v.form, candidate: v.candidate, candidateId: v.candidateId }
  }

  async function proactiveDecideSay(payload, execution) {
    const decision = await proactiveDecide(payload, execution)
    return proactiveSay(decision, execution)
  }

  function bigramDup(text, recentList) {
    const grams = (s) => {
      const t = String(s || '').replace(/\s+/g, '')
      const out = new Set()
      for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
      return out
    }
    const a = grams(text)
    for (const r of recentList) {
      const b = grams(r)
      if (!a.size || !b.size) continue
      let inter = 0
      a.forEach(g => { if (b.has(g)) inter++ })
      if (inter / Math.min(a.size, b.size) > 0.8) return true
    }
    return false
  }

  /* ---------------- 一次有界修复（守卫命中后） ---------------- */

  async function repairOnce(text, reason, context) {
    const c = context || {}
    const r = await llm({
      purpose: 'character-chat', promptStage: 'M1_M2_repair', temperature: TEMP.repair, maxTokens: 300, timeoutMs: 30000,
      system: pt('m1.ab533219c6', '把下面这句话改写通顺，去掉没有依据的断言（不编造人物、事情、动作、感官），保持原意和口语语气。只输出改写后的句子。'),
      userText: '判定问题：' + String(reason || '') + '\n句子：' + String(text || '') +
        '\n本轮用户原话：' + String(c.userText || '') +
        '\n核验依据：' + JSON.stringify({ runtimeFacts: c.runtimeFacts || {}, memories: (c.relevantMemories || c.memories || []).slice(0, 6) })
    })
    return r && r.ok ? String(r.text || '').trim() : ''
  }

  /* ---------------- M1：槽位 Reply（纯文本） + 并行元数据调用 ---------------- */

  /* 当前时间行：runtimeFacts 的真实结构是 {clock:{date|time|weekday:{value,availability}}}；
     兼容裸字符串（旧口径）/缺失，取不到就不编。 */
  function factValue(node, fallback) {
    try {
      if (node && typeof node === 'object' && node.availability === 'available' && node.value) return String(node.value)
      if (typeof node === 'string' && node) return node
    } catch (e) { /* ignore */ }
    return fallback || ''
  }
  function nowLine(runtimeFacts, nowTs) {
    const rf = runtimeFacts || {}
    const clock = rf.clock || {}
    /* 快照时间来源优先级：调用方显式传入 → runtimeFacts.capturedAt → clock.*.capturedAt
       （pet.js 的 Object.assign 不会复制 capturedAt，所以这里必须能自己回退，否则只能落到请求时刻）。 */
    const snapTs = Number(nowTs) || Number(rf.capturedAt) ||
      Number((clock.date && clock.date.capturedAt) || (clock.time && clock.time.capturedAt)) || 0
    const now = new Date(snapTs || Date.now())
    const p2 = (x) => String(x).padStart(2, '0')
    const date = factValue(clock.date, (now.getMonth() + 1) + '月' + now.getDate() + '日')
    const time = factValue(clock.time, now.getHours() + ':' + p2(now.getMinutes()))
    const wd = factValue(clock.weekday, '')
    const tz = factValue(clock.timezone, '')
    return '现在是 ' + date + ' ' + time + (wd ? '（' + wd + (tz ? '，' + tz : '') + '）' : '') + '。'
  }

  /* 记忆条目的日期/可信度：与新链外其它出口同词汇（memory-retrieval.js:205-208），
     缺失就不写，不编造。 */
  function memoryDate(m) {
    try {
      const d = m && (m.date || m.eventTime)
      return d ? String(d) + '：' : ''
    } catch (e) { return '' }
  }
  function confidenceLabel(m) {
    try {
      const c = Number(m && m.confidence)
      if (!Number.isFinite(c)) return ''
      return c >= 0.80 ? '（确定）' : (c >= 0.45 ? '（较确定）' : '（模糊）')
    } catch (e) { return '' }
  }

  async function chatReply(payload) {
    const original = payload || {}
    const p = window.ContextSelection ? window.ContextSelection.chat(original) : original
    const ctx = Object.assign({}, p.context || {}, { userText: String(p.userText || '') })
    if (window.PlatformCandidate && window.PlatformCandidate.enabled && window.PlatformContext) ctx.platform = window.PlatformContext
    const S = slots()
    const name = nameOf(ctx)
    const userText = String(p.userText || '')
    const brief = p.scale === 'short_social'
    const memories = brief ? [] : ((ctx.relevantMemories || ctx.memories) || []).slice(0, 3)
    const facts = ctx.runtimeFacts || {}
    const openThreads = brief ? [] : (p.frame && p.frame.openThreads) || []
    const replyStyle = !brief && S && S.styleSlot ? await S.styleSlot('M1_reply') : null

    const system = S.join([
      S.idSlot(name, { honest: true }),
      S.voSlot(),
      !brief && S.characterSlot ? S.characterSlot(ctx, userText) : '',
      !brief && ctx.expressState !== false && window.StateTier ? window.StateTier.describe(window.StateTier.tierFor('chat', window.StateTier.snapshot(ctx.selfState, ctx.emotion))) : '',
      S.ftSlot(),
      nowLine(facts, ctx.capturedAt),
      brief ? pt('m1.73ddef8e15', '这轮是简短社交回应，按这句话的份量自然接一句。') : lifeEvidenceLines(p.life),
      openThreads.length ? pt('m1.1c9b8d3c03', '【没聊完的话题（只是线索，不强接）】\n') + openThreads.map(t => {
        /* analyzeTurn 给的是 {id, quote, label, messageRef}（conversation-policy.js:50-51）：
           原来读 t.topic/t.threadId 两个不存在的字段 ⇒ 这一行恒渲染成空，话题文本根本没进 prompt。 */
        const label = String((t && (t.label || t.quote || t.id)) || '').trim()
        if (!label) return ''
        const when = t && t.ts ? '（' + new Date(Number(t.ts)).toLocaleString('zh-CN') + ' 起）' : ''
        return '- ' + label + when
      }).filter(Boolean).join('\n') : '',
      memories.length ? pt('m1.37a820fae4', '【回复信息参考（只是参考，不用完全遵守，不要逐字复述；有日期即该事发生时间）】\n') + memories.map(m => '- ' + memoryDate(m) + String(m.content || m.text || '') + confidenceLabel(m)).join('\n') : '',
      replyStyle ? pt(replyStyle.promptId, '') : '',
      pt('m1.4c9d3ced5c', '先接住主人这句话再说别的；主人收束就自然收束，不每句反问。'),
      pt('m1.935da7e303', '只输出回复正文，不要任何多余内容。')
    ])
    const relationLine = (ctx.proactiveReplyTo ? pt('m1.7671c9bfe3', '[关系] 主人这句是在回应我刚才主动开口的那条消息。\n') : '')
    /* 元数据（记忆/speechAct/话题）与表达并行：记忆只依赖主人原话，无需等回复 */
    const metaPromise = turnMeta({ userText, history: p.history, frame: p.frame }).then(meta => ({
      messageRef: p.messageRef || (p.frame && p.frame.turnRef), memory: meta.memory || null, ok: meta.ok !== false, reason: meta.reason || null,
      conversation: window.ConversationPolicy ? window.ConversationPolicy.validateResponse(meta.policyPayload || {}, p.frame) : null
    }))
    if (typeof p.onMetadata === 'function') p.onMetadata(metaPromise)
    const rr = await llm({ purpose: 'character-chat', promptStage: brief ? 'M1_short' : 'M1_reply', system, userText: relationLine + userText, projectionInput: { ...p, context: ctx }, history: p.history, historyMetadata: true, temperature: TEMP.reply, maxTokens: p.maxTokens || 1536, timeoutMs: p.timeoutMs || 90000 })
    if (!rr || !rr.ok) return rr
    let text = String(rr.text || '').trim()
    if (!text) return { ok: false, reason: 'invalid_chat_response', text: null }

    /* 同一份事实上下文核验原文与修复稿；失败交给 UI 处理，不冒充角色发言。 */
    const guard = internals().finalClaimGuard
    const life = p.life
    const guardContext = Object.assign({}, original.context || ctx, { userText })
    const evidence = internals().withLifeEvidence ? internals().withLifeEvidence(guardContext, original.life || life) : guardContext
    let checked = guard ? guard(text, evidence) : { text, reason: null }
    if (checked.reason) {
      const originalReason = checked.reason
      const fixed = await repairOnce(text, checked.reason, { ...evidence, memories: ctx.memories, relevantMemories: ctx.relevantMemories })
      const re = fixed && guard ? guard(fixed, evidence) : null
      try { console.info('[gen2-chat-guard]', JSON.stringify({ messageRef: p.messageRef || null, reason: originalReason, repair: re && !re.reason ? 'accepted' : 'rejected' })) } catch (e) { /* logging is non-blocking */ }
      if (re && !re.reason) checked = re
      else return { ok: false, reason: 'guard_rejected', text: null, rawText: text, guardReason: originalReason }
    }
    if (agw().isDeceptiveIdentityText && agw().isDeceptiveIdentityText(checked.text)) return { ok: false, reason: 'persona_boundary', text: null }
    const policy = window.ConversationPolicy
    const finalText = internals().stripKnownTimePrefix ? internals().stripKnownTimePrefix(checked.text, { history: p.history, context: ctx, userText }) : checked.text
    return {
      ok: true,
      text: internals().normalizeCharacterChatText ? internals().normalizeCharacterChatText(finalText) : finalText,
      rawText: text,
      continuityMemory: null,
      conversation: policy ? policy.validateResponse({}, p.frame) : null,
      metadataPromise: metaPromise,
      guardReason: checked.reason || null
    }
  }

  /* 只投影执行记录；聊天原文继续走 history，不能升级成活动事实。 */
  function lifeEvidenceLines(life) {
    if (!life || !life.ready) return ''
    const artifacts = (life.artifacts || []).filter(a => a.sourceType === 'animation.completed' && a.evidenceEventId).slice(-4)
      .map(a => ({ id: a.id, text: a.text, ts: a.ts || a.createdAt, sourceType: a.sourceType, evidenceEventId: a.evidenceEventId }))
    const activities = (life.activities || []).filter(a => a.status === 'done' && a.finishedAt).slice(-3)
      .map(a => ({ id: a.id, kind: a.kind, status: a.status, finishedAt: a.finishedAt, material: a.material, refs: a.refs }))
    if (!artifacts.length && !activities.length) return ''
    return '【桌宠虚拟生活的执行记录】\n' + JSON.stringify({ artifacts, activities }) +
      '\n这些是桌宠世界里的活动记录；聊天历史记录双方说过的话，两者分别提供活动依据和对话上下文。'
  }

  /* 独立元数据调用：从主人原话提取记忆候选/话轮标注（与表达解耦；零结果正常） */
  async function turnMeta(input) {
    const userText = String((input && input.userText) || '')
    if (!userText.trim()) return { memory: null, policyPayload: {} }
    try {
      const r = await llm({
        purpose: 'character-chat', promptStage: 'M1_meta', temperature: TEMP.meta, maxTokens: 700, timeoutMs: 30000,
        system: pt('m1.13599d7d69', '只提取本轮用户原话的元数据，不写回复。闲聊、问题、假设、扮演不提取长期记忆。') + '输出 JSON，memory 为 null 或 {kind:"preference|dislike|plan|event|fact|resolved",quote:"本轮原话完整连续片段",topic:"短话题"}；可附 speechAct、threadUpdates、interestEvidence、expression。\n' +
          (window.ConversationPolicy && window.ConversationPolicy.metadataPromptFor ? window.ConversationPolicy.metadataPromptFor(input.frame) : ''),
        userText: JSON.stringify({ currentUserText: userText, history: (input.history || []).slice(-4) })
      })
      const parsed = r && r.ok && internals().parseStructured ? internals().parseStructured(r.text) : null
      if (!r || !r.ok) return { memory: null, policyPayload: {}, ok: false, reason: r && r.reason || 'provider_failed' }
      if (!parsed) return { memory: null, policyPayload: {}, ok: false, reason: 'metadata_invalid_json' }
      return { memory: parsed.memory || null, policyPayload: parsed, ok: true }
    } catch (e) { return { memory: null, policyPayload: {}, ok: false, reason: e.message || 'metadata_exception' } }
  }

  try {
    window.Gen2 = { chatReply, proactiveDecide, proactiveSay, proactiveDecideSay, turnMeta, repairOnce, TEMP, nowLine, _internals: { nowLine, factValue } }
  } catch (e) { /* ignore */ }
})()
