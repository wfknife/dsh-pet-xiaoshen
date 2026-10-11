/* LifeLedger — 第二期 F3「Life Context 账本」纯逻辑核心（零 I/O / 存储注入）
 *
 * 上位约束：P3-life-context-boundary-final-v1-20260918.md v1.1 §6.7/§6.8/§6.10 + F0F7 设计 §3.4
 *   - 账本核心 = **无 I/O 的纯逻辑**；"数据写哪里"是外部 adapter 的事
 *   - **删除必须彻底**：删除 → 依赖失效/重算 → 查询/导出/后续推导都不得再把它当有效依据
 *   - **不得留下幽灵结论**：任何"有效条目"都不得引用已删/失效条目（除非自己已被标 basisStale）
 *   - 经验倾向（derived）住 Life Context、不进 Memory；不记录对主人的价值评价
 *   - 审计日志（auditLog）只留 id + 时间，**不是她的经历、不得进入角色上下文**
 *
 * 记录类型（本期定好，F4 只写字段、不再发明结构）：
 *   choice 做了/选了 | no-op 想做但没做（轻量痕迹） | gated 条件不允许（仅必要系统状态）
 *   promise 说出口的延后（承诺，含 kept/broken） | duty 甲层职责履行结果 | wish 愿望（绝不进候选行动池）
 *   derived 经验倾向（引用 refs） | summary 折叠摘要（长期保留）
 *
 * Used by: build/test-life-context-f3-*.cjs、ledger-store.js、E:\dsh\tools\life-context-inspect.cjs
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeLedger = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const LEDGER_VERSION = 'life-ledger/1'
  const KIND_LIST = ['choice', 'no-op', 'gated', 'promise', 'duty', 'wish', 'derived', 'summary']
  const PROMISE_STATUS = ['pending', 'kept', 'broken']
  const DUTY_STATUS = ['done', 'failed']
  const DEFAULT_FOLD_MS = 30 * 24 * 60 * 60 * 1000

  // 叙事文本纪律（默认最小实现；调用方可注入更强的校验器，例如 Meaning.validateCandidateText）
  const BANNED_NARRATIVE = [
    { re: /主人[^，。]{0,8}(心情|情绪|状态|性格)/, why: 'judges_owner_state' },
    { re: /(焦虑|焦躁|生气|难过|开心|无聊|偷懒|懒散|累了|困了|辛苦了)/, why: 'infers_owner_feeling' },
    { re: /(想念|想主人|寂寞|孤单|后悔|担心|心疼)/, why: 'relationship_or_emotion_conclusion' },
    { re: /(应该|不该|建议|不如|别忘|记得|要不要)/, why: 'directive' }
  ]

  function clamp01(n) {
    const v = Number(n)
    if (!Number.isFinite(v)) return 0
    return Math.max(0, Math.min(1, v))
  }
  function round4(n) { return Math.round(Number(n) * 10000) / 10000 }
  function clone(o) { return JSON.parse(JSON.stringify(o)) }

  function defaultTextGuard(text) {
    const reasons = []
    const s = typeof text === 'string' ? text : ''
    if (!s.trim()) reasons.push('empty')
    if (s.length > 120) reasons.push('too_long')
    BANNED_NARRATIVE.forEach((b) => { if (b.re.test(s)) reasons.push(b.why) })
    return { ok: reasons.length === 0, reasons }
  }

  function isSummary(e) { return !!e && e.kind === 'summary' }
  function isValid(e) { return !!e && !e.invalidated }
  function isUsableAsBasis(e) {
    if (!e) return false
    if (e.invalidated) return false
    if (e.basisStale) return false
    if (isSummary(e)) return false
    if (typeof e.support === 'number' && e.support <= 0) return false
    return true
  }

  function validateEntry(entry, opts) {
    const reasons = []
    const e = entry
    if (!e || typeof e !== 'object') return { ok: false, reasons: ['not_object'] }
    if (typeof e.id !== 'string' || !e.id) reasons.push('bad_id')
    if (KIND_LIST.indexOf(e.kind) < 0) reasons.push('bad_kind:' + String(e.kind))
    if (typeof e.atTs !== 'number' || !Number.isFinite(e.atTs) || e.atTs <= 0) reasons.push('bad_atTs')
    if (!Array.isArray(e.refs)) reasons.push('missing_refs')
    else if (e.kind === 'derived' && e.refs.length < 1) reasons.push('derived_needs_refs')
    if (e.kind === 'promise' && PROMISE_STATUS.indexOf(e.status) < 0) reasons.push('bad_promise_status')
    if (e.kind === 'duty') {
      if (DUTY_STATUS.indexOf(e.status) < 0) reasons.push('bad_duty_status')
      if (e.status === 'failed' && !e.reason) reasons.push('failed_duty_needs_reason')
    }
    if (e.kind === 'wish' && e.blockedBy !== 'capability') reasons.push('wish_must_be_blocked_by_capability')
    if (e.kind === 'no-op' && !e.droppedBecause) reasons.push('noop_needs_droppedBecause')
    const guard = (opts && typeof opts.textValidator === 'function') ? opts.textValidator : defaultTextGuard
    ;['text', 'reason', 'summary'].forEach((k) => {
      if (e[k] === undefined) return
      const g = guard(e[k])
      if (!g || !g.ok) reasons.push('narrative_' + k + ':' + ((g && g.reasons) || ['invalid']).join('+'))
    })
    return { ok: reasons.length === 0, reasons }
  }

  function createState(input) {
    const i = input || {}
    return {
      version: LEDGER_VERSION,
      entries: Array.isArray(i.entries) ? clone(i.entries) : [],
      auditLog: Array.isArray(i.auditLog) ? clone(i.auditLog) : []
    }
  }

  function sortEntries(entries) {
    return entries.slice().sort((a, b) => (a.atTs - b.atTs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  function query(state, filter) {
    const f = filter || {}
    let out = (state && state.entries ? state.entries : []).filter((e) => (f.includeInvalidated ? true : isValid(e)))
    if (f.kind) out = out.filter((e) => e.kind === f.kind)
    if (f.kinds) out = out.filter((e) => f.kinds.indexOf(e.kind) >= 0)
    if (f.fromTs) out = out.filter((e) => e.atTs >= f.fromTs)
    if (f.toTs) out = out.filter((e) => e.atTs <= f.toTs)
    if (f.refs) out = out.filter((e) => (e.refs || []).indexOf(f.refs) >= 0)
    if (f.ids) out = out.filter((e) => f.ids.indexOf(e.id) >= 0)
    if (f.usableAsBasis) out = out.filter(isUsableAsBasis)
    return sortEntries(out)
  }

  function recompute(state, opts) {
    const nowTs = (opts && opts.nowTs) || 0
    /* 外部依据解析器（可选）：把"不属于账本条目"的依据（例如事实 f:…）交给调用方判定可用性。
       只补解析通道——支撑度公式与有效性定义都不变。 */
    const resolveRefs = (opts && typeof opts.resolveRefs === 'function') ? opts.resolveRefs : null
    const st = clone(state)
    const changed = []
    const invalidated = []
    let touched = true
    let guard = 0
    while (touched && guard++ <= st.entries.length + 2) {
      touched = false
      const index = {}
      st.entries.forEach((e) => { index[e.id] = e })
      st.entries.forEach((e) => {
        if (isSummary(e)) return
        const refs = Array.isArray(e.refs) ? e.refs : []
        const usable = refs.filter((r) => isUsableAsBasis(index[r]) || (resolveRefs ? resolveRefs(r) === true : false))
        const support = refs.length ? round4(usable.length / refs.length) : 1
        const missing = refs.length - usable.length
        const prevSupport = typeof e.support === 'number' ? e.support : 1
        const prevStale = !!e.basisStale
        if (typeof e.baseConfidence !== 'number') {
          e.baseConfidence = typeof e.confidence === 'number' ? e.confidence : 0.5
        }
        e.support = support
        e.confidence = round4(clamp01(e.baseConfidence * support))
        e.basisStale = missing > 0
        if (e.kind === 'derived') {
          const shouldInvalidate = refs.length === 0 || support === 0
          if (shouldInvalidate && !e.invalidated) {
            e.invalidated = true
            e.invalidatedReason = refs.length === 0 ? 'no_refs' : 'all_refs_gone'
            invalidated.push(e.id)
            touched = true
          } else if (!shouldInvalidate && e.invalidated) {
            e.invalidated = false
            e.invalidatedReason = null
            touched = true
          }
        }
        if (support !== prevSupport || e.basisStale !== prevStale) {
          changed.push(e.id)
          touched = true
        }
        e.recomputedAt = nowTs
      })
    }
    return { state: st, changed: changed.filter((v, i, a) => a.indexOf(v) === i), invalidated: invalidated.filter((v, i, a) => a.indexOf(v) === i) }
  }

  function append(state, entry, opts) {
    const nowTs = (opts && opts.nowTs) || 0
    if (!(nowTs > 0)) return { ok: false, reasons: ['bad_nowTs'] }
    const v = validateEntry(entry, opts)
    if (!v.ok) return { ok: false, reasons: v.reasons }
    const st = clone(state)
    if (st.entries.some((e) => e.id === entry.id)) return { ok: false, reasons: ['duplicate_id'] }
    // 「真删除」防复活：曾被删除过的 id 不得再被写入（审计日志里只留 id，不含内容）
    if ((st.auditLog || []).some((a) => a && a.targetId === entry.id)) return { ok: false, reasons: ['id_was_deleted'] }
    const e = clone(entry)
    if (typeof e.support !== 'number') e.support = 1
    if (typeof e.confidence !== 'number') e.confidence = typeof e.baseConfidence === 'number' ? e.baseConfidence : 0.5
    e.createdAt = nowTs
    st.entries.push(e)
    const rc = recompute(st, { nowTs: nowTs, resolveRefs: opts && opts.resolveRefs })
    return { ok: true, state: rc.state, entry: e, recomputed: { changed: rc.changed, invalidated: rc.invalidated } }
  }

  function remove(state, id, opts) {
    const nowTs = (opts && opts.nowTs) || 0
    if (!(nowTs > 0)) return { ok: false, reasons: ['bad_nowTs'] }
    const st = clone(state)
    const i = st.entries.findIndex((e) => e.id === id)
    if (i < 0) return { ok: false, reasons: ['not_found'] }
    const removed = st.entries.splice(i, 1)[0]
    // 审计日志：**只留 id + 时间**，不含任何内容；不是她的经历、不进入角色上下文
    st.auditLog.push({ targetId: id, atTs: nowTs })
    const rc = recompute(st, { nowTs: nowTs, resolveRefs: opts && opts.resolveRefs })
    return { ok: true, state: rc.state, removed, invalidated: rc.invalidated, changed: rc.changed }
  }

  function fold(state, opts) {
    const nowTs = (opts && opts.nowTs) || 0
    if (!(nowTs > 0)) return { ok: false, reasons: ['bad_nowTs'] }
    const keepMs = (opts && opts.keepMs) || DEFAULT_FOLD_MS
    const st = clone(state)
    const cutoff = nowTs - keepMs
    const referenced = {}
    st.entries.forEach((e) => (e.refs || []).forEach((r) => { referenced[r] = true }))
    const candidates = st.entries.filter((e) => !isSummary(e) && e.atTs < cutoff)
    const foldable = candidates.filter((e) => !referenced[e.id])
    const skippedReferenced = candidates.filter((e) => referenced[e.id]).map((e) => e.id)
    if (!foldable.length) return { ok: true, state: st, folded: [], summaries: [], skippedReferenced }
    const groups = {}
    foldable.forEach((e) => {
      const d = new Date(e.atTs)
      const k = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
      if (!groups[k]) groups[k] = []
      groups[k].push(e)
    })
    const summaries = Object.keys(groups).map((k) => {
      const g = groups[k]
      const byKind = {}
      g.forEach((e) => { byKind[e.kind] = (byKind[e.kind] || 0) + 1 })
      return {
        id: 'summary:' + k,
        kind: 'summary',
        atTs: Math.max.apply(null, g.map((e) => e.atTs)),
        refs: [],
        value: { dateKey: k, total: g.length, byKind },
        foldedFrom: g.map((e) => e.id),
        support: 1,
        confidence: 1,
        createdAt: nowTs
      }
    })
    const foldedIds = foldable.map((e) => e.id)
    st.entries = st.entries.filter((e) => foldedIds.indexOf(e.id) < 0).concat(summaries)
    st.auditLog.push({ foldedCount: foldedIds.length, dateKeys: Object.keys(groups), atTs: nowTs })
    return { ok: true, state: st, folded: foldedIds, summaries: summaries.map((s) => s.id), skippedReferenced }
  }

  function exportView(state, opts) {
    const nowTs = (opts && opts.nowTs) || 0
    const only = !(opts && opts.validOnly === false)
    const entries = query(state, only ? {} : { includeInvalidated: true })
    return {
      version: LEDGER_VERSION,
      exportedAt: nowTs,
      count: entries.length,
      entries
      // 注意：**不含 auditLog**（审计日志不是她的经历）
    }
  }

  function assertInvariants(state) {
    const reasons = []
    const entries = (state && state.entries) || []
    const seen = {}
    entries.forEach((e) => {
      if (seen[e.id]) reasons.push('duplicate_id:' + e.id)
      seen[e.id] = true
      if (KIND_LIST.indexOf(e.kind) < 0) reasons.push('bad_kind:' + e.id)
      if (!(typeof e.atTs === 'number' && e.atTs > 0)) reasons.push('bad_atTs:' + e.id)
    })
    const index = {}
    entries.forEach((e) => { index[e.id] = e })
    entries.forEach((e) => {
      if (isSummary(e)) {
        if (!e.value || !e.value.dateKey) reasons.push('summary_without_value:' + e.id)
        if (isValid(e) && (e.refs || []).length) reasons.push('summary_with_refs:' + e.id)
        return
      }
      if (!isValid(e)) return
      const refs = Array.isArray(e.refs) ? e.refs : []
      const unusable = refs.filter((r) => !isUsableAsBasis(index[r]))
      if (!unusable.length) return
      if (!e.basisStale || (typeof e.support === 'number' && e.support > 0)) {
        reasons.push('valid_entry_refs_unusable_without_stale_flag:' + e.id)
      }
    })
    const audit = (state && state.auditLog) || []
    audit.forEach((a) => {
      const contentKeys = ['text', 'reason', 'value', 'summary', 'entries']
      if (Object.keys(a).some((k) => contentKeys.indexOf(k) >= 0)) reasons.push('audit_carries_content')
      if (a.targetId && index[a.targetId]) reasons.push('deleted_id_present:' + a.targetId)
    })
    return { ok: reasons.length === 0, reasons }
  }

  return {
    LEDGER_VERSION,
    KIND_LIST,
    PROMISE_STATUS,
    DUTY_STATUS,
    DEFAULT_FOLD_MS,
    BANNED_NARRATIVE,
    defaultTextGuard,
    validateEntry,
    createState,
    query,
    append,
    remove,
    recompute,
    fold,
    exportView,
    assertInvariants,
    isUsableAsBasis,
    isValid
  }
})
