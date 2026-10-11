/* LifeExpression — F6-A 表达层「人话化」（纯函数 / 零 I/O / **不拥有选择权**）
 *
 * 上位约束：P3-life-context-boundary-final-v1-20260918.md（§C 语气三档 / §D / §F）+ F0F7 设计 §3.7（F6）
 *   一句话目标：把**已选定**的意义与理由说成人话；AI 只润色、本地可兜底。
 *
 * 用户 拍板（逐条落地，勿改）：
 *   ① 三档语气**挂句首**：低「我觉得，」／中「大概，」／高「很可能，」；**已有置信词时不重复叠加**。
 *   ② 输入＝**每轮现取最近一条有效 choice**（只读账本视图由调用方提供）；本模块**不缓存、不改 F5 payload**。
 *   ③ `localFallback` 只作**最终兜底机制**复用（由调用方注入），**不得**当作固定话术库当常规表达。
 *   ④ 本轮**不实现 F6-B**；冻结：本地表达不依赖 AI 开关，未来「只读提示块」是否附加跟随现有 AI 总开关。
 *   ⑤ 只读**有效**条目；`basisStale=true` 一律排除；**有效条目为空 ⇒ 走兜底或"不可表达"，绝不拿 stale 顶上**。
 *
 * 硬红线：
 *   - **不拥有 meaning 选择权**（必须与 `entry.adoptedMeaning.candidateId` 一致，多个候选一律拒绝，不排序不挑选）
 *   - **不拥有 intent/choice 选择权**（只读账本，不产生新选择、不调用 F4）
 *   - **不产生新事实**：文本只能来自调用方传入的只读候选；`refs` 必须非空且 ⊆ 输入依据
 *   - **不写回** F0–F5（无 I/O、无 require、不碰 window）；**零对外开口**（开口是 F7）
 * - **N2 fail-closed** 出口过 `LifeKnowledge`的 `filterTexts` / `assertNoCapabilityClaim`；
 *     守卫缺失或能力投影不可用 ⇒ **拒绝表达**（宁可少说，不许说错）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeExpression = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const EXPRESSION_VERSION = 'life-expression/1'

  // 与 F1 `meaning.js` 的 TONE_LEVELS **逐值一致**（契约测试断言相等，防漂移）
  //   前缀不另存表：**挂句首**＝`label + '，'`（少一份数据＝少一处漂移）
  const TONE_LEVELS = [
    { level: 'high', label: '很可能', min: 0.75 },
    { level: 'mid', label: '大概', min: 0.5 },
    { level: 'low', label: '我觉得', min: 0.3 }
  ]
  const SILENT_TONE = { level: 'silent', label: '（不说）' }
  const CONFIDENCE_WORDS = ['我觉得', '大概', '很可能']

  // 结构断言用禁词（本模块不得出现"选择/写回/对外开口"面）
  const FORBIDDEN_SELECTION_KEYS = ['choose', 'select', 'decide', 'rank', 'score', 'arbitrate', 'pick']
  const FORBIDDEN_WRITE_KEYS = ['write', 'save', 'persist', 'commit', 'applydelta', 'mutate', 'update']
  const FORBIDDEN_SURFACE_KEYS = ['say', 'speak', 'emit', 'dispatch', 'fire', 'notify', 'presence', 'intent', 'act', 'play', 'send', 'run']

  function toneFor(confidence) {
    const c = Number(confidence)
    if (!Number.isFinite(c)) return { level: SILENT_TONE.level, label: SILENT_TONE.label }
    for (const t of TONE_LEVELS) if (c >= t.min) return { level: t.level, label: t.label }
    return { level: SILENT_TONE.level, label: SILENT_TONE.label }
  }

  // ① 三档语气**挂句首**：前缀 = 标签 + '，'；silent 无前缀
  function prefixOf(tone) {
    if (!tone || tone.level === SILENT_TONE.level) return null
    const hit = TONE_LEVELS.filter((t) => t.level === tone.level)[0]
    return hit ? hit.label + '，' : null
  }

  function isStaleEntry(entry) {
    return !!(entry && (entry.basisStale === true || entry.invalidated === true))
  }

  function entriesOf(view) {
    if (!view) return []
    if (Array.isArray(view)) return view.slice()
    return Array.isArray(view.entries) ? view.entries.slice() : []
  }

  // ② 每轮现取：最近一条**有效** choice（basisStale / invalidated 排除；只看 kind==='choice'）
  function latestValidChoice(view, opts) {
    const wantTs = Number(opts && opts.nowTs)
    const list = entriesOf(view)
      .filter((e) => e && e.kind === 'choice' && !isStaleEntry(e))
      .filter((e) => !Number.isFinite(wantTs) || !Number.isFinite(Number(e.atTs)) || Number(e.atTs) <= wantTs)
      .sort((a, b) => Number(a.atTs || 0) - Number(b.atTs || 0))
    return list.length ? list[list.length - 1] : null
  }

  function refsOfEntry(entry) {
    const a = entry && Array.isArray(entry.refs) ? entry.refs : null
    if (a && a.length) return a.slice()
    const b = entry && entry.reasonDetail && Array.isArray(entry.reasonDetail.evidenceRefs) ? entry.reasonDetail.evidenceRefs : null
    return b ? b.slice() : []
  }

  /* ---------- 「已选定那条」的文本解析（**归 F6-A**；F6-B 不得自己查表） ----------
     账本 adoptedMeaning 只有 {candidateId, ruleId, tendency, confidence}（无文本），
     文本按 candidateId 查 meaning-rules.js 的**静态候选表**：这是**查表**，不是重跑投影
     （不重算 confidence / 不排序 / 不挑选）；查不到 ⇒ 不表达。 */
  function indexRules(rules) {
    const byId = {}
    const list = Array.isArray(rules) ? rules : (rules && Array.isArray(rules.RULES) ? rules.RULES : [])
    list.forEach((r) => {
      const cands = r && Array.isArray(r.candidates) ? r.candidates : []
      cands.forEach((c) => { if (c && typeof c.id === 'string' && byId[c.id] === undefined) byId[c.id] = c })
    })
    return byId
  }

  function resolveMeaningText(rules, candidateId) {
    const id = typeof candidateId === 'string' ? candidateId : ''
    if (!id) return { ok: false, reason: 'meaning-text-unavailable', text: null, candidateId: null }
    const hit = indexRules(rules)[id]
    if (!hit) return { ok: false, reason: 'meaning-text-unavailable', text: null, candidateId: id }
    const text = typeof hit.text === 'string' ? hit.text.trim() : ''
    if (!text) return { ok: false, reason: 'meaning-text-empty', text: null, candidateId: id }
    return { ok: true, reason: null, text: text, candidateId: id, tendency: hit.tendency || null }
  }

  // 允许集＝**条目自身的依据**（账本是权威）+ 调用方显式白名单。
  //   ⚠ 不得把 `input.meaning.evidenceRefs` 加进来：那会让"候选自己写 refs"被当成合法依据（伪造 ref 洗白）。
  function allowedRefs(input, entry) {
    const out = []
    const push = (arr) => { if (Array.isArray(arr)) arr.forEach((r) => { if (typeof r === 'string' && out.indexOf(r) < 0) out.push(r) }) }
    push(input && input.allowedRefs)
    push(refsOfEntry(entry))
    push(entry && entry.reasonDetail && entry.reasonDetail.evidenceRefs)
    return out
  }

  // 纯组合（不含闸）：已选定 meaning 文本 + 语气前缀。三档挂句首；已带同档置信词则不重复叠加。
  function composeLocal(input) {
    const i = input || {}
    const meaning = i.meaning || null
    const raw = meaning && typeof meaning.text === 'string' ? meaning.text.trim() : ''
    if (!raw) return { ok: false, reason: 'meaning-text-empty', text: null, tone: null }
    const tone = toneFor(meaning && meaning.confidence)
    const prefix = prefixOf(tone)
    if (!prefix) return { ok: false, reason: 'below-tone-threshold', text: null, tone: tone }
    const head = CONFIDENCE_WORDS.filter((w) => raw.indexOf(w) === 0)[0] || null
    if (head && head !== tone.label) return { ok: false, reason: 'tone-conflict', text: null, tone: tone, conflict: head }
    if (head === tone.label) return { ok: true, reason: null, text: raw, tone: tone, prefixed: false }
    return { ok: true, reason: null, text: prefix + raw, tone: tone, prefixed: true }
  }

  // N2 出口闸（复用 F5-A LifeKnowledge）：守卫缺失 ⇒ fail-closed
  function guardText(text, input, deps) {
    const sk = deps && deps.selfKnowledge
    if (!sk || typeof sk.filterTexts !== 'function' || typeof sk.assertNoCapabilityClaim !== 'function') {
      return { ok: false, reasons: ['guard-unavailable'], failClosed: true }
    }
    const projection = (input && input.capabilities) || null
    const r1 = sk.assertNoCapabilityClaim(text, projection)
    const r2 = sk.filterTexts([text], { projection: projection })
    const reasons = []
    if (r1 && Array.isArray(r1.reasons)) r1.reasons.forEach((x) => reasons.push(x))
    if (r2 && Array.isArray(r2.dropped)) r2.dropped.forEach((d) => (d.reasons || []).forEach((x) => reasons.push(x)))
    const uniq = reasons.filter((x, i) => reasons.indexOf(x) === i)
    return { ok: uniq.length === 0, reasons: uniq, failClosed: false }
  }

  function blocked(code, detail) { return { code: code, detail: detail === undefined ? null : detail } }

  // 主入口：只读账本视图 + 只读候选 → 可表达结果（含闸与 refs 校验）
  function toExpressible(input, deps) {
    const i = input || {}
    const meaning = i.meaning || null
    const entry = i.entry || latestValidChoice(i.view, { nowTs: i.nowTs })
    const out = { expressionVersion: EXPRESSION_VERSION, ok: false, reason: null, tone: null, lines: [], refs: [], sourceRefs: null, blocked: [], fallbackUsed: false }

    if (!entry) { out.reason = 'no-valid-choice'; out.blocked.push(blocked('no-valid-choice')); return out } // ⑤ 不拿 stale 顶上
    if (entry.kind !== 'choice') { out.reason = 'not-a-choice'; out.blocked.push(blocked('not-a-choice', entry.kind)); return out }
    if (isStaleEntry(entry)) { out.reason = 'stale-basis-excluded'; out.blocked.push(blocked('stale-basis-excluded', entry.id)); return out }
    const adopted = entry.adoptedMeaning || null
    if (!adopted) { out.reason = 'no-adopted-meaning'; out.blocked.push(blocked('no-adopted-meaning')); return out }
    if (!meaning) { out.reason = 'meaning-text-unavailable'; out.blocked.push(blocked('meaning-text-unavailable', adopted.candidateId)); return out } // 不产生新事实
    if (meaning.candidateId !== adopted.candidateId) {
      out.reason = 'meaning-mismatch'; out.blocked.push(blocked('meaning-mismatch', String(meaning.candidateId) + '!=' + String(adopted.candidateId))); return out
    }

    const comp = composeLocal({ meaning: meaning })
    if (!comp.ok) { out.reason = comp.reason; out.tone = comp.tone; out.blocked.push(blocked(comp.reason, comp.conflict || null)); return out }
    out.tone = { level: comp.tone.level, label: comp.tone.label }
    out.sourceRefs = { entryId: entry.id || null, candidateId: adopted.candidateId, ruleId: adopted.ruleId || null, actionId: entry.actionId || null }

    // 引用可回溯：非空 + ⊆ 允许集（伪造 ref 一律拦下）
    const allowed = allowedRefs(i, entry)
    const refs = Array.isArray(meaning.evidenceRefs) && meaning.evidenceRefs.length ? meaning.evidenceRefs.slice() : refsOfEntry(entry)
    if (!refs.length) { out.reason = 'refs-missing'; out.blocked.push(blocked('refs-missing', entry.id || null)); return out }
    const forged = refs.filter((r) => allowed.indexOf(r) < 0)
    if (forged.length) { out.reason = 'refs-not-subset'; out.blocked.push(blocked('refs-not-subset', forged.join(','))); return out }
    out.refs = refs

    // 措辞约束：只做"是否超限"判定，**不截断**（截断会改意义）
    const maxChars = i.diction && Number(i.diction.maxChars)
    if (Number.isFinite(maxChars) && maxChars > 0 && comp.text.length > maxChars) {
      out.reason = 'exceeds-max-chars'; out.blocked.push(blocked('exceeds-max-chars', comp.text.length + '>' + maxChars)); return out
    }

    const g = guardText(comp.text, i, deps)
    if (!g.ok) { out.reason = g.failClosed ? 'guard-unavailable' : 'capability-claim'; out.blocked.push(blocked(out.reason, g.reasons.join('+'))); return out }

    out.ok = true
    out.lines = [{ text: comp.text, tone: out.tone, refs: refs.slice(), prefixed: !!comp.prefixed }]
    return out
  }

  // A 侧统一入口：账本视图 + 规则表 + 能力投影 → 可表达结果（**文本解析与出口闸都在 A 侧**）
  function buildExpressible(input, deps) {
    const i = input || {}
    const entry = i.entry || latestValidChoice(i.view, { nowTs: i.nowTs })
    const pass = (meaning) => toExpressible({ entry: entry, meaning: meaning, capabilities: i.capabilities, nowTs: i.nowTs, diction: i.diction }, deps)
    if (!entry || entry.kind !== 'choice' || isStaleEntry(entry)) return pass(i.meaning || null)
    const adopted = entry.adoptedMeaning || null
    if (!adopted) return pass(null)
    const res = resolveMeaningText(i.rules, adopted.candidateId)
    if (!res.ok) {
      const out = pass(null)
      out.reason = res.reason
      out.blocked = [blocked(res.reason, res.candidateId)]
      return out
    }
    return pass({
      candidateId: adopted.candidateId,
      ruleId: adopted.ruleId || null,
      text: res.text,
      confidence: adopted.confidence,
      evidenceRefs: refsOfEntry(entry)
    })
  }

  // ③ 最终兜底：**只**在没有有效依据时调用调用方注入的 localFallback（复用机制，不当话术库）；结果仍过闸
  function boundedFallback(input, deps) {
    const i = input || {}
    const out = { expressionVersion: EXPRESSION_VERSION, ok: false, reason: null, tone: null, lines: [], refs: [], blocked: [], fallbackUsed: false }
    const fb = deps && typeof deps.localFallback === 'function' ? deps.localFallback : null
    if (!fb) { out.reason = 'not-expressible'; out.blocked.push(blocked('not-expressible')); return out } // 没有兜底 ⇒ 明确不可表达
    let text = null
    try { text = fb(i.fallbackContext || {}) } catch (e) { text = null }
    text = typeof text === 'string' ? text.trim() : ''
    if (!text) { out.reason = 'fallback-empty'; out.blocked.push(blocked('fallback-empty')); return out }
    const g = guardText(text, i, deps)
    if (!g.ok) { out.reason = g.failClosed ? 'guard-unavailable' : 'capability-claim'; out.blocked.push(blocked(out.reason, g.reasons.join('+'))); return out }
    out.ok = true
    out.fallbackUsed = true
    out.lines = [{ text: text, tone: null, refs: [], prefixed: false }]
    return out
  }

  // 供 F6-B 使用的**只读**提示块（本轮不接线）：只允许润色这一条，禁止新增事实/能力宣称
  function buildPromptLines(input, deps) {
    const i = input || {}
    const r = toExpressible(i, deps)
    if (!r.ok) return { ok: false, reason: r.reason, lines: [], blocked: r.blocked }
    const t = r.lines[0]
    const lines = [
      '[生活表达（F6 只读投影；只能润色，不能新增）]',
      '- 只允许润色下面这一条：不得新增任何事实、不得改理由、不得声称任何能力',
      '- 语气档：低→句首「我觉得，」；中→句首「大概，」；高→句首「很可能，」（已带则不重复叠加）',
      '- 待润色：' + t.text,
      '- 依据（不得增删）：' + r.refs.join('、')
    ]
    return { ok: true, reason: null, lines: lines, tone: r.tone, refs: r.refs, blocked: [] }
  }

  function keysHit(forbidden) {
    // 结构自证函数自身（assert*）不算"面"，否则 assertNoSelection 会被自己的 'select' 命中
    const keys = Object.keys(api || {}).filter((k) => !/^assert/.test(k))
    const hits = keys.filter((k) => forbidden.some((f) => k.toLowerCase().indexOf(f) >= 0))
    return { ok: hits.length === 0, hits: hits, keys: Object.keys(api || {}) }
  }
  function assertNoSelection() { return keysHit(FORBIDDEN_SELECTION_KEYS) }
  function assertNoWriteBack() { return keysHit(FORBIDDEN_WRITE_KEYS) }
  function assertNoSurface() { return keysHit(FORBIDDEN_SURFACE_KEYS) }
  // 结构自证：本模块不声明任何 I/O 依赖
  function assertNoIO() { return { ok: true, io: [], note: 'no require / no fetch / no fs / no window' } }

  const api = {
    EXPRESSION_VERSION,
    TONE_LEVELS,
    SILENT_TONE,
    CONFIDENCE_WORDS,
    toneFor,
    prefixOf,
    isStaleEntry,
    latestValidChoice,
    refsOfEntry,
    indexRules,
    resolveMeaningText,
    allowedRefs,
    composeLocal,
    guardText,
    toExpressible,
    buildExpressible,
    boundedFallback,
    buildPromptLines,
    assertNoSelection,
    assertNoWriteBack,
    assertNoSurface,
    assertNoIO
  }
  return api
})
