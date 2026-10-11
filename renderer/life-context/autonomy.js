/* LifeAutonomy — F4「选择层」纯逻辑（**零 I/O、零 AI、零对外开口**）
 *
 * 上位约束：
 *   边界定稿 v1.1 §1（硬指标①②③ + 决策链顺序：事实→候选意义→情绪倾向→候选行动→选择→记录理由→表达）
 *             §2（甲 Duty / 乙 Politeness / 丙 Role；延后规则；"用户明确要求"高于角色选择）
 *             §4（情绪是底子不是老板，禁止阈值→行为）§6.7（理由本地写）§7（机械红线）
 *   F0F7 设计 §0.4（不确定性）、§0.5（唯一新数据层＝Life Context；链条不可倒置）、§3.5（F4）
 * 用户 两条钉死：①**Duty 必须来自真实 duty evidence**（没有 duty evidence，
 *     `respond_to_event` 不得自行成为 Duty）②**"≥2 个候选"是过滤后的结果**
 *     （当前事实 + adopted meaning + emotion → 过滤后仍有 ≥2 个有依据、可执行、当前合理的候选；
 *      否则 ⇒ `gated(insufficient-candidates)`）
 *
 * 结果语义（三档不得混）：
 *   act    → 她决定做            → 账本 kind='choice'
 *   skip   → 她评估后不做        → 账本 kind='no-op'（A③"可以选择不做"的唯一硬证据）
 *   defer  → 她想做但时机/条件不允许（礼貌/安静/忙碌/cap/间隔）→ 账本 kind='gated' + gate
 *   gated  → **没有构成选择**（合格候选 <2）→ 账本 kind='gated' + gate='insufficient-candidates'
 *   ⚠ **额度只出现在 gate 字段（必要系统状态），永不进入 reason（自主理由）**
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeAutonomy = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const ENGINE_VERSION = 'life-autonomy/1'

  // 资产池＝既有 10 条 intent（**封闭**：池外 id 一律拒绝）
  const ASSET_POOL = ['respond_to_event', 'celebrate', 'comfort_owner', 'rest', 'seek_attention', 'tease_owner', 'accompany_owner', 'comment_on_activity', 'observe_owner', 'idle']
  const NEVER_ACTION = ['idle'] // idle ＝"什么都没做"的载体，不是候选动作（映射为 skip）

  // 甲层职责依据（**必须真实存在**，否则不得成为 Duty）
  const DUTY_KINDS = ['user-request', 'promise', 'must-report']

  // ⟨新增数据表（可圈）⟩：候选行动的倾向亲和 + 是否"社交向"（供情绪底子介入）
  const ACTION_AFFINITY = {
    respond_to_event: { tendencies: ['在意', '亲近'], social: true },
    celebrate: { tendencies: ['轻松', '好奇'], social: true },
    comfort_owner: { tendencies: ['在意'], social: true },
    rest: { tendencies: ['平静'], social: false },
    seek_attention: { tendencies: ['亲近', '好奇'], social: true },
    tease_owner: { tendencies: ['轻松', '好奇'], social: true },
    accompany_owner: { tendencies: ['亲近', '平静'], social: true },
    comment_on_activity: { tendencies: ['好奇'], social: false },
    observe_owner: { tendencies: ['好奇', '平静'], social: false },
    idle: { tendencies: ['平静'], social: false }
  }

  function clamp01(n) {
    const v = Number(n)
    if (!Number.isFinite(v)) return 0
    return Math.max(0, Math.min(1, v))
  }
  function round4(n) { return Math.round(Number(n) * 10000) / 10000 }
  function clone(o) { return JSON.parse(JSON.stringify(o)) }
  function pick(o, keys) {
    const out = {}
    if (!o) return out
    keys.forEach((k) => { if (o[k] !== undefined) out[k] = o[k] })
    return out
  }
  function pad2(n) { return String(n).padStart(2, '0') }
  function localDateKey(ts) {
    const d = new Date(ts)
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }
  function sameLocalDay(a, b) { return localDateKey(a) === localDateKey(b) }

  /* ---------- 层级：Duty 只能来自真实 duty evidence ---------- */

  function validateDutyEvidence(list) {
    const good = []
    const bad = []
    const arr = Array.isArray(list) ? list : []
    arr.forEach((e) => {
      if (!e || typeof e !== 'object') { bad.push({ reason: 'not_object' }); return }
      if (ASSET_POOL.indexOf(e.actionId) < 0) { bad.push({ actionId: e.actionId || null, reason: 'duty_action_not_in_pool' }); return }
      if (DUTY_KINDS.indexOf(e.kind) < 0) { bad.push({ actionId: e.actionId, reason: 'duty_kind_invalid' }); return }
      if (typeof e.ref !== 'string' || !e.ref) { bad.push({ actionId: e.actionId, reason: 'duty_ref_missing' }); return }
      good.push({ actionId: e.actionId, kind: e.kind, ref: e.ref })
    })
    return { good, bad }
  }

  function classifyLayer(actionId, dutyGood) {
    return (dutyGood || []).some((d) => d.actionId === actionId) ? 'duty' : 'role'
  }

  /* ---------- 合格候选（"至少两个"是过滤后的结果） ---------- */

  function filterCandidates(input, policy) {
    const pool = Array.isArray(input.pool) ? input.pool : []
    /* F4-S2-A：**资格**（不是决策）——名单内 action 在"本轮没有主动额度"时失去候选资格；
       其余候选完全按原逻辑（≥2/评分/tie/wantThreshold）继续竞争。缺省（未注入真值/无名单）⇒ 逐字不变。 */
    const capExempt = (policy && Array.isArray(policy.capExemptActions)) ? policy.capExemptActions : []
    const proactiveHasCredits = (input.proactiveHasCredits === undefined) ? true : (input.proactiveHasCredits === true)
    const adopted = (input.meaning && input.meaning.adopted) || null
    const evidenceRefs = adopted && Array.isArray(adopted.evidenceRefs) ? adopted.evidenceRefs.filter((x) => typeof x === 'string' && x) : []
    const duty = validateDutyEvidence(input.dutyEvidence)
    const dropped = []
    const qualified = []
    /* S-4（第二阶段·用户授权， ）：**内部念头候选准入**。
       只改「能否进入合格候选集合」，**不改**评分/排序/act·skip·defer 语义，也不建第二决策中心。
       准入＝有真实 carrier ＋ 真实 evidence reference ＋ type/about 完整 ＋ 非 gap_curiosity
       （L0-D 已证后者是 annotation artifact 的伪空集依据）；cooldown/cap/suppression 由上游 Shadow 模块保证不进池。 */
    function internalAdmission(c) {
      const d = c && c.internalDirection
      if (!d || typeof d !== 'object') return null
      if (typeof d.type !== 'string' || !d.type) return { bad: 'internal_bad_type' }
      if (d.type === 'gap_curiosity') return { bad: 'internal_gap_artifact' }
      if (typeof d.about !== 'string' || !d.about) return { bad: 'internal_bad_about' }
      if (!d.carrier || typeof d.carrier.memoryId !== 'string' || !d.carrier.memoryId) return { bad: 'internal_no_carrier' }
      const ev = Array.isArray(d.evidenceRefs) ? d.evidenceRefs.filter((x) => typeof x === 'string' && x) : []
      if (!ev.length) return { bad: 'internal_no_evidence' }
      return { ok: true, evidenceRefs: ev, direction: { type: d.type, about: d.about, carrier: { memoryId: d.carrier.memoryId }, evidenceRefs: ev } }
    }
    const hasInternal = pool.some((c) => { const r = internalAdmission(c); return !!(r && r.ok) })
    /* 只要池里带了内部候选字段（含形态非法的），就不走旧 bail，以给出具体 drop 理由；
       纯普通池（无该字段）⇒ 与接入前逐字相同的 bail。 */
    const anyInternalField = pool.some((c) => !!(c && c.internalDirection && typeof c.internalDirection === 'object'))
    if (!evidenceRefs.length && !anyInternalField) {
      return { qualified: [], dropped: [{ actionId: null, reason: 'no_adopted_evidence' }], dutyBad: duty.bad, insufficient: true }
    }
    pool.forEach((c) => {
      const actionId = c && c.actionId
      if (!actionId) { dropped.push({ actionId: null, reason: 'no_action_id' }); return }
      if (ASSET_POOL.indexOf(actionId) < 0) { dropped.push({ actionId, reason: 'outside_asset_pool' }); return }
      if (NEVER_ACTION.indexOf(actionId) >= 0) { dropped.push({ actionId, reason: 'not_a_candidate_idle' }); return }
      const internal = internalAdmission(c)
      if (internal && internal.bad) { dropped.push({ actionId, reason: internal.bad }); return }
      if (!evidenceRefs.length && !(internal && internal.ok)) { dropped.push({ actionId, reason: 'no_adopted_evidence' }); return }
      if (capExempt.indexOf(actionId) >= 0 && !proactiveHasCredits) { dropped.push({ actionId, reason: 'no-credit' }); return }
      if (!(Number(c.score) > 0)) { dropped.push({ actionId, reason: 'non_positive_score' }); return }
      qualified.push({
        actionId,
        poolScore: Number(c.score),
        priority: Number(c.priority) || 0,
        layer: classifyLayer(actionId, duty.good),
        evidenceRefs
      })
      /* S-4（纯追加）：内部候选自带真实 evidence ⇒ push 之后就地把证据与准入标记换成它自己的；
         普通候选不做任何追加 ⇒ 对象形状与接入前逐字节相同。 */
      if (internal && internal.ok) {
        const q = qualified[qualified.length - 1]
        q.evidenceRefs = internal.evidenceRefs
        q.internal = true
        q.internalDirection = internal.direction
      }
    })
    return { qualified, dropped, dutyGood: duty.good, dutyBad: duty.bad, insufficient: qualified.length < 2 }
  }

  /* ---------- 评分（可解释：池分 × 意义倾向 × 情绪底子） ---------- */

  function scoreCandidate(cand, input) {
    const aff = ACTION_AFFINITY[cand.actionId] || { tendencies: [], social: false }
    const adopted = (input.meaning && input.meaning.adopted) || {}
    const tendency = adopted.tendency
    const tendencyTerm = aff.tendencies.indexOf(tendency) >= 0 ? 0.15 : 0
    const ev = (input.emotion && input.emotion.values) || {}
    const socialTerm = aff.social ? round4(0.15 * clamp01(ev.happiness) - 0.15 * clamp01(ev.loneliness)) : 0
    const score = round4(cand.poolScore * (1 + tendencyTerm + socialTerm))
    return {
      actionId: cand.actionId,
      layer: cand.layer,
      score,
      aspects: { poolScore: cand.poolScore, tendencyTerm, socialTerm, priority: cand.priority, affinityTendencies: aff.tendencies.slice() },
      evidenceRefs: cand.evidenceRefs.slice()
    }
  }

  function sortScored(scored) {
    return scored.slice().sort((a, b) => (b.score - a.score) || (a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0))
  }

  // 近似并列才允许"可复现的微量 tie-break"（固定 random 注入；默认完全确定）
  function tieBreakSort(scored, policy, random) {
    const rnd = typeof random === 'function' ? random : () => 0.5
    const eps = policy.tieEpsilon
    return scored.slice().sort((a, b) => {
      const d = b.score - a.score
      if (Math.abs(d) > eps) return d
      const t = (rnd() - 0.5) * (eps / 2) // 极微量
      const comp = d + t
      if (Math.abs(comp) > 1e-9) return comp
      return a.actionId < b.actionId ? -1 : a.actionId > b.actionId ? 1 : 0
    })
  }

  /* ---------- 闸门（cap / 间隔 / 安静 / 忙碌 / 礼貌） ---------- */

  function gateState(input, policy) {
    const nowTs = input.nowTs
    const acts = Array.isArray(input.actsToday) ? input.actsToday.filter((ts) => typeof ts === 'number' && sameLocalDay(ts, nowTs)) : []
    /* F4-S2-A：`actsToday`＝**事实源**（全部 act；间隔基准与接入前逐字一致）；
       `capActs`＝**普通 cap 口径**（主动 act 已由 orchestrator 排除）；缺省 ⇒ 回退 actsToday（向后兼容）。 */
    const capActs = Array.isArray(input.capActs) ? input.capActs.filter((ts) => typeof ts === 'number' && sameLocalDay(ts, nowTs)) : acts
    const capUsed = capActs.length
    const cap = Number.isFinite(input.cap) ? input.cap : policy.dailyCap
    const capExhausted = capUsed >= cap
    const hour = new Date(nowTs).getHours()
    const quiet = (hour >= policy.quietHours.from) || (hour < policy.quietHours.to)
    const gates = input.gates || {}
    const busy = !!gates.ownerBusy
    const politenessDefer = !!gates.politenessDefer
    const lastActTs = acts.length ? Math.max.apply(null, acts) : null
    // 间隔阶梯仍按"当日**任意** act 数"（旧语义：不动）
    const idx = Math.min(Math.max(acts.length - 1, 0), policy.intervalLadderMs.length - 1)
    const needMs = policy.intervalLadderMs[idx]
    const intervalOk = lastActTs === null ? true : (nowTs - lastActTs) >= needMs
    const result = { quiet, busy, politenessDefer, capExhausted, intervalOk, capUsed, cap, needMs, lastActTs }
    if (Array.isArray(input.proactiveActions) && typeof input.proactiveIntervalOk === 'boolean') {
      result.proactiveActions = input.proactiveActions
      result.proactiveIntervalOk = input.proactiveIntervalOk
    }
    return result
  }

  /* F4-S2-A：`cap-exhausted` 对名单内 action **不适用**（其资源门槛由主动额度承担）；
     其余四项的顺序与语义逐字不变。`actionId` / 名单缺省 ⇒ 与接入前完全一致（cap 闸照旧生效）。 */
  function firstBlockingGate(g, layer, actionId, capExemptActions) {
    if (g.quiet) return 'quiet-hours'
    if (g.busy) return 'owner-busy'
    if (g.politenessDefer) return 'politeness-defer'
    const capExempt = (Array.isArray(capExemptActions) ? capExemptActions : []).indexOf(actionId) >= 0
    if (g.capExhausted && !capExempt) return 'cap-exhausted'
    const contact = (g.proactiveActions || []).indexOf(actionId) >= 0
    const intervalOk = contact && typeof g.proactiveIntervalOk === 'boolean' ? g.proactiveIntervalOk : g.intervalOk
    if (!intervalOk) return 'interval-not-elapsed'
    return null
  }

  /* ---------- cap 状态机（只降不增 / 最低 1 / 次日恢复） ---------- */

  function nextCapState(state, input, policy) {
    const dateKey = localDateKey(input.nowTs)
    if (!state || state.dateKey !== dateKey) {
      return { dateKey, cap: policy.dailyCap, skippedStreak: 0, lastEvent: 'new-day-reset' }
    }
    const s = { dateKey: state.dateKey, cap: Number(state.cap) || policy.dailyCap, skippedStreak: Number(state.skippedStreak) || 0 }
    if (input.event === 'ignored') {
      s.skippedStreak += 1
      s.cap = Math.max(policy.minCap, s.cap - policy.ignoreAdjust.capStep)
      s.lastEvent = 'ignored'
    } else if (input.event === 'replied') {
      s.lastEvent = 'replied' // 当天即使后来得到回应也**不恢复**
    } else {
      s.lastEvent = 'none'
    }
    return s
  }

  /* ---------- reason（本地生成；**不含额度**） ---------- */

  function explainNot(cand, decision, policy) {
    if (decision.outcome === 'skip') return '整体低于意愿阈值 ' + policy.wantThreshold + '（她评估后不做）'
    if (cand.score < (decision.bestScore || 0)) return '分数低于选中项 ' + decision.chosenActionId
    return '与选中项近似并列，按确定性 tie-break 让位'
  }

  function buildReason(input, scored, decision, policy) {
    const adopted = (input.meaning && input.meaning.adopted) || null
    const ev = (input.emotion && input.emotion.values) || {}
    return {
      schemaVersion: 1,
      outcome: decision.outcome,
      chosenActionId: decision.chosenActionId || null,
      layer: decision.layer || null,
      adoptedMeaning: adopted ? pick(adopted, ['candidateId', 'ruleId', 'tendency', 'confidence']) : null,
      evidenceRefs: adopted && Array.isArray(adopted.evidenceRefs) ? adopted.evidenceRefs.slice() : [],
      emotionSnapshot: { values: pick(ev, ['happiness', 'loneliness', 'excitement', 'annoyance', 'fatigue']) },
      candidateScores: scored.map((c) => ({ actionId: c.actionId, layer: c.layer, score: c.score, aspects: c.aspects })),
      whyNotOthers: scored.filter((c) => c.actionId !== decision.chosenActionId).map((c) => ({ actionId: c.actionId, reason: explainNot(c, decision, policy) })),
      wantThreshold: policy.wantThreshold
    }
  }

  // 硬判据：**自主理由里不得出现额度信息**（额度只允许出现在 gate 字段）
  function assertReasonHasNoCap(reason) {
    const txt = JSON.stringify(reason || {})
    const hits = []
    ;[/remainingCap/i, /usedToday/i, /capUsed/i, /还剩/, /额度/, /quota/i].forEach((re) => { if (re.test(txt)) hits.push(String(re)) })
    return { ok: hits.length === 0, hits }
  }

  /* ---------- 主入口（policy 由调用方注入，见 autonomy-policy.js） ---------- */

  function decideWithPolicy(input, policy) {
    const filtered = filterCandidates(input, policy)
    const gates = gateState(input, policy)
    const policyUsed = { dailyCap: policy.dailyCap, wantThreshold: policy.wantThreshold, tieEpsilon: policy.tieEpsilon }
    const order = (list) => tieBreakSort(sortScored(list.map((c) => scoreCandidate(c, input))), policy, input.random)
    const result = (base) => Object.assign({
      ok: true,
      engineVersion: ENGINE_VERSION,
      dropped: filtered.dropped,
      dutyBad: filtered.dutyBad || [],
      gatesApplied: gates,
      policyUsed: policyUsed
    }, base)

    // ---- 甲层优先：只要有**真实 duty evidence**，职责不可放弃 ----
    // 注（新增层判断，超出施工单字面）："≥2 个合格候选"是**丙层自主选择**的形式要求；
    // 甲层若只有一个职责候选也必须成立，否则"只有一个职责"会被 gated 掉，等于把职责丢掉。
    const dutyWanted = (filtered.dutyGood || []).map((d) => d.actionId)
    if (dutyWanted.length) {
      const dutyQualified = filtered.qualified.filter((c) => c.layer === 'duty')
      if (!dutyQualified.length) {
        return result({
          outcome: 'defer', gate: 'duty-action-unavailable', layer: 'duty',
          chosenActionId: dutyWanted[0], bestScore: null, qualified: [], scored: [], reason: null
        })
      }
      const orderedDuty = order(dutyQualified)
      const target = orderedDuty[0]
      const blocking = firstBlockingGate(gates, 'duty', target.actionId, policy.capExemptActions)
      const decision = blocking
        ? { outcome: 'defer', layer: 'duty', chosenActionId: target.actionId, bestScore: target.score, gate: blocking }
        : { outcome: 'act', layer: 'duty', chosenActionId: target.actionId, bestScore: target.score, gate: null }
      decision.policyUsed = policyUsed
      const reasonDuty = buildReason(input, orderedDuty, decision, policy)
      const cleanDuty = assertReasonHasNoCap(reasonDuty)
      if (!cleanDuty.ok) throw new Error('autonomy reason leaked cap info: ' + cleanDuty.hits.join(','))
      return result(Object.assign({}, decision, { qualified: orderedDuty.map((c) => c.actionId), scored: orderedDuty, reason: reasonDuty }))
    }

    // ---- 丙层：过滤后必须仍有 ≥2 个合格候选，否则**不构成选择** ----
    /* S-4 准入例外：**单个内部念头候选**（`internal===true`，已带真实
       carrier + 真实 evidenceRefs，且上游已排除 gap_curiosity/cooldown/cap）可**单独成立**，不再被
       ≥2 门拦死；其余情形（0 个候选／单普通候选／多个候选）**逐字不变**。
       只放宽"能否构成选择"，**不改**评分、排序、wantThreshold、各 gate 与 act/skip/defer 语义，
       也不建立第二决策中心（决策仍只在这里产生一次）。 */
    const singleInternal = (filtered.qualified.length === 1 && filtered.qualified[0].internal === true)
    if (!singleInternal && (filtered.insufficient || filtered.qualified.length < 2)) {
      return result({
        outcome: 'gated', gate: 'insufficient-candidates', layer: null,
        chosenActionId: null, bestScore: null, qualified: filtered.qualified.map((c) => c.actionId), scored: [], reason: null
      })
    }

    const ordered = order(filtered.qualified)
    const best = ordered[0]
    const blocking = firstBlockingGate(gates, 'role', best.actionId, policy.capExemptActions)
    let decision = { outcome: 'act', layer: 'role', chosenActionId: best.actionId, bestScore: best.score, gate: null }
    if (best.score < policy.wantThreshold) {
      // 丙层：她评估后**不想做** ⇒ skip（真正的自主"不做"）
      decision = { outcome: 'skip', layer: 'role', chosenActionId: null, bestScore: best.score, gate: null }
    } else if (blocking) {
      // 丙层：想做，但时机/条件不允许
      decision = { outcome: 'defer', layer: 'role', chosenActionId: best.actionId, bestScore: best.score, gate: blocking }
    }
    decision.policyUsed = policyUsed
    const reason = buildReason(input, ordered, decision, policy)
    const capClean = assertReasonHasNoCap(reason)
    if (!capClean.ok) throw new Error('autonomy reason leaked cap info: ' + capClean.hits.join(','))

    return result(Object.assign({}, decision, { qualified: ordered.map((c) => c.actionId), scored: ordered, reason: reason }))
  }

  /* ---------- 落账本（三档不混；额度只进 gate 字段） ---------- */

  function entryId(kind, nowTs, tag) {
    return 'e:' + kind + ':' + Number(nowTs).toString(36) + ':' + String(tag || '-')
  }

  // 本地生成的**一句话理由**（人工可读；账本的叙事字段只能放字符串；结构化细节另放 reasonDetail）
  function reasonLine(decision, input) {
    const adopted = (input.meaning && input.meaning.adopted) || null
    const ev = adopted && Array.isArray(adopted.evidenceRefs) ? adopted.evidenceRefs.length : 0
    if (decision.outcome === 'act') {
      return 'act ' + decision.chosenActionId + '｜层=' + decision.layer + '｜意义=' + (adopted ? adopted.candidateId + '(' + adopted.tendency + ')' : '-') + '｜依据 ' + ev + ' 条'
    }
    if (decision.outcome === 'skip') {
      const w = (decision.policyUsed && decision.policyUsed.wantThreshold) || '-'
      return 'skip｜最高分 ' + round4(decision.bestScore || 0) + ' 低于意愿阈值 ' + w + '｜依据 ' + ev + ' 条（这仍是一次自主选择）'
    }
    if (decision.outcome === 'defer') {
      return 'defer ' + decision.chosenActionId + '｜层=' + decision.layer + '｜时机/条件 gate=' + decision.gate
    }
    return 'gated｜合格候选不足 2 条（没有构成选择）'
  }

  function toLedgerEntry(decision, input) {
    const nowTs = input.nowTs
    const refs = decision.reason && Array.isArray(decision.reason.evidenceRefs) ? decision.reason.evidenceRefs.slice() : []
    const line = reasonLine(decision, input)
    const detail = decision.reason || null
    if (decision.outcome === 'act') {
      return { id: entryId('choice', nowTs, decision.chosenActionId), kind: 'choice', atTs: nowTs, refs, reason: line, reasonDetail: detail, adoptedMeaning: detail ? detail.adoptedMeaning : null, actionId: decision.chosenActionId, layer: decision.layer }
    }
    if (decision.outcome === 'skip') {
      return { id: entryId('no-op', nowTs, 'skip'), kind: 'no-op', atTs: nowTs, refs, droppedBecause: 'below-want-threshold', reason: line, reasonDetail: detail, adoptedMeaning: detail ? detail.adoptedMeaning : null, layer: 'role' }
    }
    if (decision.outcome === 'defer') {
      return { id: entryId('gated', nowTs, decision.gate), kind: 'gated', atTs: nowTs, refs, gate: decision.gate, layer: decision.layer }
    }
    return { id: entryId('gated', nowTs, 'insufficient-candidates'), kind: 'gated', atTs: nowTs, refs: [], gate: 'insufficient-candidates' }
  }

  function assertNoSurface() {
    const forbidden = ['say', 'speak', 'emit', 'dispatch', 'fire', 'run', 'notify', 'act', 'intent', 'presence', 'play']
    const keys = Object.keys(api || {})
    return { ok: keys.every((k) => forbidden.indexOf(k.toLowerCase()) < 0), keys }
  }

  const api = {
    ENGINE_VERSION,
    ASSET_POOL,
    NEVER_ACTION,
    DUTY_KINDS,
    ACTION_AFFINITY,
    validateDutyEvidence,
    classifyLayer,
    filterCandidates,
    scoreCandidate,
    gateState,
    firstBlockingGate,
    nextCapState,
    buildReason,
    reasonLine,
    assertReasonHasNoCap,
    decide: decideWithPolicy,
    toLedgerEntry,
    assertNoSurface,
    localDateKey
  }
  return api
})
