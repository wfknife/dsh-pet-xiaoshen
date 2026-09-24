/* LifeMeaning — F1「候选意义 / 解释投影层」只读实现（第一期 / 甲方案：产品零接线）
 *
 * 上位约束：P3-life-context-boundary-final-v1-20260918.md v1.1
 *   §4.3 与 CharacterContext 同级的**只读投影层**，不是决策引擎；
 *        只能回答"我可以怎样理解眼前发生的事"，**不能**回答"所以我应该做什么"
 *   §1.3 顺序：事实 → 候选意义 → 情绪倾向 → 候选行动 → 选择 → 理由记录 → 表达
 *   §3.5 语气三档：我觉得 / 大概 / 很可能；低到最低档 ⇒ 标记"不说"（silent）
 *   §6.7 不产生对主人的价值评价；AI 不参与候选的生成/筛选/排序（本模块零 AI、零网络）
 *   §0.4 不确定性：v1 只用确定性排序（随机留给 F4 的近似并列 tie-break）
 *
 * 设计纪律：
 *   - 纯函数 + 依赖注入（facts / context / nowTs 全部外部传入）⇒ 可离线、可复现
 *   - 零 I/O、零网络、零写；不引用 remainingCap / usedToday（额度是刹车不是油门）
 *   - **候选只来自规则表**；每条候选必须带 ruleId + ≥1 条依据 refs，否则被拒绝
 *   - 权重只受性格/关系/底子影响；**文本永不因权重而改变**
 *
 * Used by: build/test-life-context-f1-meaning.cjs、E:\dsh\tools\life-context-inspect.cjs、未来线（本期不接）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeMeaning = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const ENGINE_VERSION = 'life-meaning/1'

  // 倾向词表（闭集）：只表示"这个读法让她自己更容易往哪个情绪方向去"
  const TENDENCIES = ['平静', '在意', '好奇', '轻松', '亲近']

  const TONE_LEVELS = [
    { level: 'high', label: '很可能', min: 0.75 },
    { level: 'mid', label: '大概', min: 0.5 },
    { level: 'low', label: '我觉得', min: 0.3 }
  ]
  const SILENT_TONE = { level: 'silent', label: '（不说）' }

  const DEFAULT_NOW = 0 // 由调用方注入；缺失时确定性取 0，绝不读真实时间

  // 权重增益（可调默认值）：性格/关系/底子对"候选权重"的影响强度。
  // 只放大权重差异，**永不改变候选文本**（文本纪律见 BANNED_TEXT）。
  const AFFINITY_GAIN = 2.5

  // 文本纪律（V8）：禁止判断主人状态 / 禁止给建议 / 禁止把关系与情绪结论写进意义
  const BANNED_TEXT = [
    { re: /主人[^，。]{0,8}(心情|情绪|状态|性格)/, why: 'judges_owner_state' },
    { re: /(焦虑|焦躁|生气|难过|开心|无聊|偷懒|懒散|累了|困了|辛苦了)/, why: 'infers_owner_feeling' },
    { re: /(想念|想主人|寂寞|孤单|后悔|担心|心疼)/, why: 'relationship_or_emotion_conclusion' },
    { re: /(应该|不该|建议|不如|别忘|记得|要不要|来聊|聊两句|陪陪|安慰|提醒|去休息|去睡)/, why: 'directive' }
  ]

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }

  function validateCandidateText(text) {
    const reasons = []
    const s = typeof text === 'string' ? text : ''
    if (!s.trim()) reasons.push('empty')
    if (s.length > 40) reasons.push('too_long')
    if (/^主人/.test(s)) reasons.push('owner_first_person_subject')
    BANNED_TEXT.forEach((b) => { if (b.re.test(s)) reasons.push(b.why) })
    return { ok: reasons.length === 0, reasons }
  }

  function validateRule(rule) {
    const reasons = []
    if (!rule || typeof rule !== 'object') return { ok: false, reasons: ['not_object'] }
    if (typeof rule.id !== 'string' || !rule.id) reasons.push('bad_id')
    if (rule.status !== 'active' && rule.status !== 'dormant') reasons.push('bad_status')
    if (rule.status === 'dormant' && !rule.reason) reasons.push('dormant_without_reason')
    const cands = Array.isArray(rule.candidates) ? rule.candidates : []
    if (rule.status === 'active' && cands.length < 2) reasons.push('active_rule_needs_2_candidates')
    cands.forEach((c) => {
      if (!c || typeof c.id !== 'string' || !c.id) reasons.push('bad_candidate_id')
      const t = validateCandidateText(c && c.text)
      if (!t.ok) reasons.push('candidate_text:' + (c && c.id) + ':' + t.reasons.join('+'))
      if (TENDENCIES.indexOf(c && c.tendency) < 0) reasons.push('bad_tendency:' + (c && c.id))
      if (typeof c.base !== 'number' || c.base < 0 || c.base > 1) reasons.push('bad_base:' + (c && c.id))
      if (!c.affinity || typeof c.affinity !== 'object') reasons.push('missing_affinity:' + (c && c.id))
    })
    return { ok: reasons.length === 0, reasons }
  }

  function toneFor(confidence) {
    for (const t of TONE_LEVELS) if (confidence >= t.min) return { level: t.level, label: t.label }
    return { level: SILENT_TONE.level, label: SILENT_TONE.label }
  }

  /* ---------- 事实读取小工具（只读） ---------- */

  function segmentsOf(facts) {
    return (facts || [])
      .filter((f) => f && f.key === 'activity.segment')
      .slice()
      .sort((a, b) => a.value.startTs - b.value.startTs)
  }

  function familyFactsOf(facts, fam) {
    return (facts || []).filter((f) => f && f.key === 'activity.family' && f.value && f.value.family === fam)
  }

  function recentSegments(facts, nowTs, windowMs) {
    return segmentsOf(facts).filter((f) => f.value.startTs >= nowTs - windowMs && f.value.startTs <= nowTs)
  }

  function overlapMs(f, fromTs, toTs) {
    return Math.max(0, Math.min(f.value.endTs, toTs) - Math.max(f.value.startTs, fromTs))
  }

  function activeAt(facts, nowTs) {
    return segmentsOf(facts).find((f) => f.value.startTs <= nowTs && nowTs <= f.value.endTs) || null
  }

  /* P3 F0-2：activity.current 只读消费 —— 本轮**仅供 just-finished 的
     activeNow 使用**（存在性布尔）。不读 cat/startTs/asOfTs 做任何时间/类别计算、不产生 metric、
     不进 evidenceRefs；rest-or-away 与其余规则本轮一律不经此函数。 */
  function currentOf(facts) {
    return (facts || []).find((f) => f && f.key === 'activity.current') || null
  }

  function lastEnded(facts, nowTs) {
    const segs = segmentsOf(facts).filter((f) => f.value.endTs <= nowTs)
    if (!segs.length) return null
    return segs.sort((a, b) => b.value.endTs - a.value.endTs)[0]
  }

  function clockOf(facts) {
    const f = (facts || []).find((x) => x && x.key === 'clock.local')
    return f ? f.value : null
  }

  function mediaOf(facts) {
    const f = (facts || []).find((x) => x && x.key === 'media.state')
    return f ? { factId: f.id, value: f.value, availability: f.availability } : null
  }

  // 类别家族：**必须与 facts.js 的 CATEGORY_FAMILIES 保持一致**（F1 测试有防漂移断言）。
  // 这里用镜像而不是 require：本模块要能在「零接线」的渲染层与 Node 两侧独立加载。
  const CATEGORY_FAMILIES = {
    work: ['开发工具', '文档'],
    media: ['音乐'],
    chat: ['聊天'],
    browser: ['浏览器']
  }

  function categories(fam) {
    return CATEGORY_FAMILIES[fam] || []
  }

  /* ---------- 规则匹配（matcher 按 ruleId 对应；数据在 meaning-rules.js） ---------- */

  function match(rule, facts, nowTs) {
    const ruleId = rule && rule.id
    const windowMs = (rule && typeof rule.windowMs === 'number') ? rule.windowMs : 60 * 60 * 1000
    switch (ruleId) {
      case 'work-long': {
        const cats = categories('work')
        const segs = segmentsOf(facts).filter((f) => cats.indexOf(f.value.cat) >= 0 && f.value.endTs >= nowTs - windowMs && f.value.endTs <= nowTs)
        /* F1 work-long 可达性修复：把**真实存在且仍可信**的进行中活动
           （`activity.current`，主进程 collectSeg 的瞬时只读投影）纳入 work-long 的**证据来源**。
           纪律（缺一不可）：①类别必须属 work 家族；②`startTs/asOfTs` 必须合法且 `asOfTs >= startTs`；
           ③`asOfTs` 必须新鲜（本轮 tick 内，容差 ≤90s）——否则视为 **stale** 一律不采用；
           ④时长**只用事实自带的 `asOfTs - startTs`**（绝不用 nowTs 硬凑）；⑤阈值仍由既有
           `guardPass`（≥30min / ≥45min）判定，本处**不改任何阈值、不改 F4**。 */
        const cur = currentOf(facts)
        const curVal = cur && cur.value ? cur.value : null
        const curOk = !!(cur && curVal &&
          cats.indexOf(curVal.cat) >= 0 &&
          Number.isFinite(curVal.startTs) && curVal.startTs > 0 &&
          Number.isFinite(curVal.asOfTs) && curVal.asOfTs > 0 &&
          curVal.asOfTs >= curVal.startTs &&
          (nowTs - curVal.asOfTs) >= 0 && (nowTs - curVal.asOfTs) <= 90 * 1000 &&
          curVal.asOfTs >= nowTs - windowMs)
        if (!segs.length && !curOk) return null
        let maxSegMs = 0
        segs.forEach((f) => { const d = Number(f.value.durationMs) || 0; if (d > maxSegMs) maxSegMs = d })
        const curMs = curOk ? (curVal.asOfTs - curVal.startTs) : 0
        const famFact = familyFactsOf(facts, 'work')[0] || null
        const evidence = segs.map((f) => f.id).concat(curOk ? [cur.id] : []).concat(famFact ? [famFact.id] : [])
        /* `currentMs` 只在**真的采用了 current** 时出现 ⇒ 无 current 的路径与旧实现逐字段等价（含 metrics 形状） */
        const metrics = Object.assign({ maxSegmentMs: Math.max(maxSegMs, curMs), segmentCount: segs.length }, curOk ? { currentMs: curMs } : {}, { familyFact: famFact ? famFact.id : null })
        return { evidenceRefs: evidence, metrics: metrics }
      }
      case 'late-night': {
        const clock = clockOf(facts)
        if (!clock || !clock.isLateNight) return null
        const segs = recentSegments(facts, nowTs, windowMs)
        if (!segs.length) return null
        const total = segs.reduce((a, f) => a + overlapMs(f, nowTs - windowMs, nowTs), 0)
        return { evidenceRefs: segs.map((f) => f.id), metrics: { windowMs: total, hour: clock.hour } }
      }
      case 'switch-heavy': {
        const segs = recentSegments(facts, nowTs, windowMs)
        if (segs.length < 4) return null
        let tight = 0
        for (let i = 1; i < segs.length; i++) {
          const gap = segs[i].value.startTs - segs[i - 1].value.endTs
          if (gap >= 0 && gap <= 2 * 60 * 1000) tight += 1
        }
        if (tight < 2) return null
        return { evidenceRefs: segs.map((f) => f.id), metrics: { segmentCount: segs.length, tightGaps: tight } }
      }
      case 'music-playing': {
        const cats = categories('media')
        const segs = segmentsOf(facts).filter((f) => cats.indexOf(f.value.cat) >= 0 && f.value.endTs >= nowTs - windowMs && f.value.endTs <= nowTs)
        if (!segs.length) return null
        const maxSeg = segs.slice().sort((a, b) => b.value.durationMs - a.value.durationMs)[0]
        return { evidenceRefs: segs.map((f) => f.id), metrics: { maxSegmentMs: maxSeg.value.durationMs } }
      }
      case 'just-finished': {
        const cats = categories('work')
        const last = segmentsOf(facts)
          .filter((f) => cats.indexOf(f.value.cat) >= 0 && f.value.endTs <= nowTs)
          .sort((a, b) => b.value.endTs - a.value.endTs)[0]
        if (!last) return null
        if (nowTs - last.value.endTs > windowMs) return null
        const active = activeAt(facts, nowTs) || currentOf(facts)
        return { evidenceRefs: [last.id], metrics: { sinceEndMs: nowTs - last.value.endTs, activeNow: !!active } }
      }
      case 'rest-or-away': {
        const gapMs = (typeof rule.gapMs === 'number') ? rule.gapMs : 30 * 60 * 1000
        const segs = segmentsOf(facts)
        const recent = segs.filter((f) => f.value.endTs > nowTs - gapMs && f.value.startTs <= nowTs)
        if (recent.length) return null
        const last = lastEnded(facts, nowTs)
        if (!last) return null
        const quietMs = nowTs - last.value.endTs
        if (quietMs < gapMs) return null
        return { evidenceRefs: [last.id], metrics: { quietMs } }
      }
      case 'app-category-mix': {
        const segs = recentSegments(facts, nowTs, windowMs)
        const set = {}
        const count = {}
        segs.forEach((f) => { set[f.value.cat] = true; count[f.value.cat] = (count[f.value.cat] || 0) + 1 })
        const cats = Object.keys(set)
        if (cats.length < 3) return null
        const dominant = cats.slice().sort((a, b) => count[b] - count[a] || (a < b ? -1 : 1))[0]
        return { evidenceRefs: segs.map((f) => f.id), metrics: { categoryCount: cats.length, categories: cats, dominant, dominantShare: count[dominant] / segs.length } }
      }
      default:
        return null
    }
  }

  /* ---------- 候选守卫：每条候选必须"站得住"，否则该规则不成立 ---------- */

  function guardPass(ruleId, candidateId, metrics) {
    const m = metrics || {}
    switch (ruleId + '|' + candidateId) {
      case 'work-long|work-long.sustained': return m.maxSegmentMs >= 30 * 60 * 1000
      case 'work-long|work-long.duration': return m.maxSegmentMs >= 45 * 60 * 1000
      case 'late-night|late-night.active': return true
      case 'late-night|late-night.long': return m.windowMs >= 10 * 60 * 1000
      case 'switch-heavy|switch-heavy.segments': return m.segmentCount >= 4
      case 'switch-heavy|switch-heavy.gap-tight': return m.tightGaps >= 2
      case 'music-playing|music-playing.present': return m.maxSegmentMs >= 10 * 60 * 1000
      case 'music-playing|music-playing.duration': return m.maxSegmentMs >= 20 * 60 * 1000
      case 'just-finished|just-finished.ended': return m.sinceEndMs <= 15 * 60 * 1000
      case 'just-finished|just-finished.gap': return m.activeNow === false
      case 'rest-or-away|rest-or-away.no-activity': return m.quietMs >= 30 * 60 * 1000
      case 'rest-or-away|rest-or-away.quiet-long': return m.quietMs >= 30 * 60 * 1000
      case 'app-category-mix|app-category-mix.variety': return m.categoryCount >= 3
      case 'app-category-mix|app-category-mix.dominant': return m.dominantShare >= 0.5
      default: return false
    }
  }

  /* ---------- 置信度 / 语气 / 权重 ---------- */

  function confidenceFor(rule, cand, metrics, ambiguity, evidenceCount) {
    const m = metrics || {}
    let c = cand.base
    if (typeof rule.minDurationMs === 'number' && typeof m.maxSegmentMs === 'number') {
      c += Math.min(0.15, ((m.maxSegmentMs - rule.minDurationMs) / rule.minDurationMs) * 0.1)
    }
    if (typeof m.quietMs === 'number') c += Math.min(0.15, ((m.quietMs - 30 * 60 * 1000) / (30 * 60 * 1000)) * 0.1)
    if (typeof m.segmentCount === 'number') c += Math.min(0.05, (m.segmentCount - 1) * 0.01)
    c += Math.min(0.1, Math.max(0, (Number(evidenceCount) || 1) - 1) * 0.05)
    c -= 0.08 * Math.max(0, ambiguity || 0)
    return Math.round(clamp(c, 0, 1) * 1000) / 1000
  }

  function affinityTerm(cand, context) {
    const aff = cand.affinity || {}
    let t = 0
    const traits = (context && context.persona && context.persona.stableTraits) || {}
    Object.keys(aff.traits || {}).forEach((k) => {
      const v = Number(traits[k])
      if (Number.isFinite(v)) t += v * aff.traits[k]
    })
    const tier = Number(context && context.relationship && context.relationship.tier)
    if (Number.isFinite(tier)) t += (clamp(tier, 0, 5) / 5) * (aff.tier || 0)
    const emo = (context && context.emotion && context.emotion.values) || {}
    Object.keys(aff.emotion || {}).forEach((k) => {
      const v = Number(emo[k])
      if (Number.isFinite(v)) t += v * aff.emotion[k]
    })
    return Math.round(t * 10000) / 10000
  }

  /* ---------- 主投影 ---------- */

  function project(facts, context, options) {
    const opts = options || {}
    const nowTs = typeof opts.nowTs === 'number' && Number.isFinite(opts.nowTs) ? opts.nowTs : DEFAULT_NOW
    const rules = Array.isArray(opts.rules) ? opts.rules : []
    const fired = []
    const skipped = []
    const dormant = []

    rules.forEach((rule) => {
      const v = validateRule(rule)
      if (!v.ok) { skipped.push({ ruleId: rule && rule.id, reason: 'invalid_rule:' + v.reasons.join('+') }); return }
      if (rule.status === 'dormant') { dormant.push({ ruleId: rule.id, reason: rule.reason }); return }
      const m = match(rule, facts, nowTs)
      if (!m) { skipped.push({ ruleId: rule.id, reason: 'no_match' }); return }
      const supported = rule.candidates.filter((c) => guardPass(rule.id, c.id, m.metrics))
      if (supported.length < 2) { skipped.push({ ruleId: rule.id, reason: 'insufficient_candidates:' + supported.length }); return }
      fired.push({ ruleId: rule.id, aspect: rule.aspect, evidenceRefs: m.evidenceRefs.slice(), metrics: m.metrics, rule: rule, supported: supported })
    })

    // 同 aspect 的规则互相竞争 ⇒ 记录歧义度（仅影响置信度，不影响文本）
    const aspectCount = {}
    fired.forEach((f) => { aspectCount[f.aspect] = (aspectCount[f.aspect] || 0) + 1 })

    const candidates = []
    fired.forEach((f) => {
      f.supported.forEach((c) => {
        const ambiguity = Math.max(0, (aspectCount[f.aspect] || 1) - 1)
        const confidence = confidenceFor(f.rule, c, f.metrics, ambiguity, f.evidenceRefs.length)
        const tone = toneFor(confidence)
        const aff = affinityTerm(c, context)
        const applied = Math.round(AFFINITY_GAIN * aff * 10000) / 10000
        candidates.push({
          candidateId: c.id,
          ruleId: f.rule.id,
          aspect: f.rule.aspect,
          text: c.text,
          tendency: c.tendency,
          confidence,
          tone,
          silent: tone.level === 'silent',
          evidenceRefs: f.evidenceRefs.slice(),
          affinity: c.affinity,
          weightRaw: Math.round(confidence * (1 + applied) * 10000) / 10000,
          affinityTerm: aff,
          affinityApplied: applied
        })
      })
    })

    candidates.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0)))
    const sum = candidates.reduce((a, c) => a + c.weightRaw, 0)
    candidates.forEach((c) => { c.weight = sum > 0 ? Math.round((c.weightRaw / sum) * 10000) / 10000 : 0 })

    fired.sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1))
    return {
      engineVersion: ENGINE_VERSION,
      rulesVersion: opts.rulesVersion || null,
      asOfTs: nowTs,
      factsUsed: (facts || []).length,
      firedRules: fired.map((f) => ({ ruleId: f.ruleId, aspect: f.aspect, evidenceRefs: f.evidenceRefs, metrics: f.metrics })),
      dormantRules: dormant,
      skippedRules: skipped,
      candidates,
      notes: [
        'no_ai=true',
        'no_io=true',
        'no_cap_reference=true',
        'deterministic=true',
        'tendencies=' + TENDENCIES.join('/')
      ]
    }
  }

  function assertInvariants(projection) {
    const reasons = []
    const p = projection || {}
    const cands = Array.isArray(p.candidates) ? p.candidates : []
    cands.forEach((c) => {
      if (!c.ruleId) reasons.push('candidate_without_ruleId:' + c.candidateId)
      if (!Array.isArray(c.evidenceRefs) || c.evidenceRefs.length < 1) reasons.push('candidate_without_evidence:' + c.candidateId)
      if (TENDENCIES.indexOf(c.tendency) < 0) reasons.push('candidate_bad_tendency:' + c.candidateId)
      const t = validateCandidateText(c.text)
      if (!t.ok) reasons.push('candidate_bad_text:' + c.candidateId + ':' + t.reasons.join('+'))
    })
    ;(p.firedRules || []).forEach((f) => {
      const n = cands.filter((c) => c.ruleId === f.ruleId).length
      if (n < 2) reasons.push('fired_rule_with_lt2_candidates:' + f.ruleId + ':' + n)
    })
    return { ok: reasons.length === 0, reasons }
  }

  return {
    ENGINE_VERSION,
    TENDENCIES,
    TONE_LEVELS,
    SILENT_TONE,
    BANNED_TEXT,
    AFFINITY_GAIN,
    CATEGORY_FAMILIES,
    validateCandidateText,
    validateRule,
    toneFor,
    guardPass,
    affinityTerm,
    project,
    assertInvariants
  }
})
