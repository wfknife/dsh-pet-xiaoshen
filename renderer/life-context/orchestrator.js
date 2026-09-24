/* LifeContextOrchestrator — F5「编排层」唯一实现（第三期 F5-A：纯新增、零接线）
 *
 * 目标：把 F0→F1→(F5 能力边界)→F4→F2→F3 串成**唯一**一轮，并保证三件事：
 *   ① 唯一调用时序：`decide(旧 values)` → `step(adopted)` → 写账本；同一轮最多一次 `step()`
 *   ② 唯一 act/cap 事实源：`actsToday()` = 当日**有效 `choice` 条目**（basisStale 仍计入；真 remove 才减），
 *      全仓只有这一个实现；cap 只走 `Autonomy.nextCapState`
 * ③ **原子提交**（用户 修订一）：计算阶段不改当前状态；**只有本轮写盘成功后**
 *      `nextEmotion`/`nextMeta`/`nextCap`/新账本才提交；写失败 ⇒ 整轮保持旧快照 + 明确失败（不得只记日志）
 *
 * 边界：
 *   - **本模块零 I/O**：落盘由调用方注入 `writer.save(payload)`（生产实现见 F5-B 的 ledger-store.production）
 *   - 零 AI / 零网络 / 零随机 / 零真实时钟（时钟必须注入；缺 nowTs 直接拒绝）
 *   - 不对外开口（N5）：不 say / 不 dispatch / 不碰 DOM / 不写 pet-state
 *   - 未知顶层键与未知 kind 条目**原样保留**（KNOWN_KINDS 直接取自 `Ledger.KIND_LIST`，不复制清单）
 * - 总开关（用户 修订二）：`lifeContext.enabled` 是 Life Context 唯一总开关；
 *     本模块**不读** `isDiaryEnabled()`（那只是 `write.diary` 这条能力事实的来源，由 self-knowledge 消费）
 *
 * Used by:
 *   - build/test-life-context-f5-orchestrator.cjs（离线契约 + 负控）
 * - 未来接线：渲染层分钟心跳调用 `session.tick(...)`，writer 经新 IPC 交主进程落盘
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeContextOrchestrator = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const ENGINE_VERSION = 'life-orchestrator/1'
  /* F4-S2-B：主动额度纯函数模块（S1 交付；与 dailyCap **完全独立**的资源）。
     direct require 同目录纯模块（**不改 main.js 的依赖面**）；非 CommonJS 上下文拿不到 require ⇒ Credits=null
     ⇒ **fail-closed**（视为 0 枚，绝不放行主动链）。 */
  const Credits = (typeof require === 'function') ? require('./proactive-credits.js') : null
  const DEFAULT_META_THROTTLE_MS = 5 * 60 * 1000
  const NULL_GATE = 'insufficient-candidates'
  const PAYLOAD_SCHEMA_VERSION = 1
  const ORCHESTRATOR_DEPS = ['facts', 'meaning', 'bridge', 'autonomy', 'ledger', 'selfKnowledge']

  function clone(o) { return JSON.parse(JSON.stringify(o)) }

  /* R-9 收尾（用户 裁定）：内部候选 evidenceRefs 的**命名空间固化**（mem:/pet:/tl:）。
     只做"命名空间 + 形态"校验 ⇒ 这些 ref 在 F3 recompute 里按"可作依据"计入（支持度公式与有效性定义**不变**），
     "指向真实来源"由构造保证 + id 可反查（memories.json / pet-state.json / daily-timeline.json）。 */
  function isSourceRef(id) {
    return typeof id === 'string' && /^(mem:[^:\s]+|pet:ownerBirthday|pet:todo:[^:\s]+|pet:life:[^\s]+|tl:segment:\d+)$/.test(id)
  }

  function requireDeps(deps) {
    const missing = ORCHESTRATOR_DEPS.filter((k) => !deps || !deps[k])
    if (missing.length) throw new Error('orchestrator: missing deps: ' + missing.join(','))
    if (typeof deps.autonomy.localDateKey !== 'function') throw new Error('orchestrator: deps.autonomy.localDateKey required（禁止第二份本地日实现）')
    if (typeof deps.autonomy.decide !== 'function' || typeof deps.autonomy.nextCapState !== 'function' || typeof deps.autonomy.toLedgerEntry !== 'function') {
      throw new Error('orchestrator: deps.autonomy 缺 decide/nextCapState/toLedgerEntry')
    }
    if (typeof deps.ledger.append !== 'function' || typeof deps.ledger.query !== 'function' || !Array.isArray(deps.ledger.KIND_LIST)) {
      throw new Error('orchestrator: deps.ledger 缺 append/query/KIND_LIST')
    }
    if (typeof deps.selfKnowledge.project !== 'function') throw new Error('orchestrator: deps.selfKnowledge.project required')
    /* F7-B：主动联系模块（可选注入；缺省＝无 F7 能力，行为与 F7 之前一致） */
    if (deps.proactive) {
      const need = ['canInitiate', 'present', 'view', 'reply', 'supersede', 'initiatedTimestamps', 'capEventsOf', 'assertInvariants']
      const miss = need.filter((k) => typeof deps.proactive[k] !== 'function')
      if (miss.length) throw new Error('orchestrator: deps.proactive 缺 ' + miss.join(','))
    }
    /* P3-F0：前台变化观察旁路模块（可选注入；缺省＝无旁路能力，行为与接入前一致） */
    if (deps.foregroundObservation) {
      const need = ['buildRecord', 'createStore', 'append']
      const miss = need.filter((k) => typeof deps.foregroundObservation[k] !== 'function')
      if (miss.length) throw new Error('orchestrator: deps.foregroundObservation 缺 ' + miss.join(','))
    }
  }

  /* ---------- ① 唯一 act 事实源 ---------- */
  // 当日**有效 choice 条目**的时间戳（升序）。basisStale 仍计入；被 remove / invalidated 才不计入。
  /* F4-S2-A：`opts.excludeActions` 用于形成"**普通 action** 的 act 口径"（主动 act 不计入普通 cap）。
     仍只有这一个实现（唯一 act 事实源）；缺省 ⇒ 行为与接入前逐字一致。 */
  function actsToday(ledgerState, nowTs, autonomy, ledger, opts) {
    if (!(typeof nowTs === 'number' && nowTs > 0)) return []
    const dayKey = autonomy.localDateKey
    const exclude = (opts && Array.isArray(opts.excludeActions)) ? opts.excludeActions : []
    const ledgerQuery = ledger && typeof ledger.query === 'function' ? ledger.query : null
    const entries = (ledgerState && ledgerState.entries) || []
    const valid = ledgerQuery
      ? ledgerQuery(ledgerState, { kind: 'choice' })
      : entries.filter((e) => e && e.kind === 'choice' && !e.invalidated)
    return valid
      .filter((e) => e && typeof e.atTs === 'number' && dayKey(e.atTs) === dayKey(nowTs))
      .filter((e) => exclude.indexOf(e.actionId) < 0)
      .map((e) => e.atTs)
      .sort((a, b) => a - b)
  }

  /* ---------- ② 能力边界过滤候选池（H3：capability ≠ precondition） ---------- */
  const ACTION_CAPABILITY_REQUIREMENTS = Object.freeze({}) // 封闭；默认空 = 池内 10 个动作均本地可执行
  function filterPoolByCapability(pool, projection, opts) {
    const reqs = (opts && opts.requirements) || ACTION_CAPABILITY_REQUIREMENTS
    const statusOf = (id) => {
      const it = projection && projection.byId ? projection.byId[id] : null
      return it ? it.status : null
    }
    const kept = []
    const dropped = []
    ;(Array.isArray(pool) ? pool : []).forEach((c) => {
      const actionId = c && c.actionId
      if (!actionId) { dropped.push({ actionId: null, reason: 'no_action_id' }); return }
      const need = Array.isArray(reqs[actionId]) ? reqs[actionId] : []
      const missing = need.filter((id) => statusOf(id) !== 'available')
      if (missing.length) { dropped.push({ actionId, reason: 'capability-unavailable:' + missing[0] }); return }
      kept.push({ actionId, score: Number(c.score), priority: Number(c.priority) || 0, source: c.source || null })
    })
    /* S-4（第二阶段·用户授权，**纯追加**）：capability 过滤只搬 4 个字段，会把内部候选的准入载荷丢掉 ⇒
       这里按 actionId 把 internalDirection 补回 kept（上方原有搬运逻辑逐字未改）。 */
    const __internalByAction = {}
    ;(Array.isArray(pool) ? pool : []).forEach((c) => { if (c && c.internalDirection) __internalByAction[String(c.actionId)] = c.internalDirection })
    kept.forEach((k) => { const d = __internalByAction[String(k.actionId)]; if (d) k.internalDirection = d })
    return { kept, dropped }
  }

  /* ---------- ③ 采纳意义（本轮"我最终怎样理解"） ----------
     新增层判断（备审）：确定性 = weight 降序 → ruleId → candidateId；无候选 ⇒ null（不编造）。 */
  function selectAdopted(projection) {
    const cands = (projection && projection.candidates) || []
    if (!cands.length) return null
    const sorted = cands.slice().sort((a, b) => {
      const dw = (Number(b.weight) || 0) - (Number(a.weight) || 0)
      if (dw) return dw
      if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1
      if (a.candidateId !== b.candidateId) return a.candidateId < b.candidateId ? -1 : 1
      return 0
    })
    const c = sorted[0]
    return {
      candidateId: c.candidateId,
      ruleId: c.ruleId,
      tendency: c.tendency,
      confidence: c.confidence,
      tone: c.tone || null,
      weight: c.weight,
      text: c.text || null,
      evidenceRefs: Array.isArray(c.evidenceRefs) ? c.evidenceRefs.slice() : []
    }
  }

  /* ---------- ④ 落盘 payload（未知键/未知 kind 原样保留） ---------- */
  function buildPayload(snapshot, ledger) {
    const st = (snapshot && snapshot.ledgerState) || {}
    const known = (ledger && ledger.KIND_LIST) || []
    const entries = Array.isArray(st.entries) ? st.entries : []
    const unknownEntryIds = entries.filter((e) => e && known.indexOf(e.kind) < 0).map((e) => e.id)
    const reserved = ['version', 'entries', 'auditLog', 'meta']
    const top = {}
    Object.keys(st).forEach((k) => { if (reserved.indexOf(k) < 0) top[k] = clone(st[k]) })
    return Object.assign({}, top, {
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      version: st.version || null,
      entries: clone(entries),
      auditLog: clone(Array.isArray(st.auditLog) ? st.auditLog : []),
      meta: clone((snapshot && snapshot.meta) || {}),
      passthrough: { unknownTopLevelKeys: Object.keys(top), unknownEntryIds }
    })
  }

  /* ---------- ⑤ 会话（唯一编排层） ---------- */
  function createSession(input) {
    const i = input || {}
    const deps = i.deps || {}
    requireDeps(deps)
    const policy = i.policy || null
    if (!policy || !Number.isFinite(policy.dailyCap)) throw new Error('orchestrator: policy（normalizePolicy 产物）必须注入')
    const writer = i.writer || null
    const rules = Array.isArray(i.rules) ? i.rules : []
    const requirements = i.actionCapabilityRequirements || ACTION_CAPABILITY_REQUIREMENTS
    const throttleMs = Number(i.metaThrottleMs) > 0 ? Number(i.metaThrottleMs) : DEFAULT_META_THROTTLE_MS

    let committed = {
      ledgerState: i.ledgerState || deps.ledger.createState({}),
      emotion: i.emotion || { values: deps.bridge.defaultValues(), updatedAt: 0, version: 0 },
      cap: i.cap || null,
      meta: i.meta || {},
      lastPersistTs: Number(i.lastPersistTs) || 0
    }
    let ticks = 0
    let steps = 0

    function snapshot() { return clone(committed) }
    function status() { return { ticks, steps, stepPerTick: ticks ? steps / ticks : 0, lastPersistTs: committed.lastPersistTs, metaThrottleMs: throttleMs } }

    /* ---------- F4-S2-B：主动额度（唯一真值来源＝ledgerState.proactiveCredits；与 dailyCap 独立） ---------- */
    function creditsStateOf(state) {
      if (!Credits) return null
      return Credits.createState((state && state.proactiveCredits) || null, policy)
    }
    /* 本轮真实额度：accrue（跨日 reset + 固定相位补算；同 nowTs 幂等）⇒ 唯一真值 credits / creditsOk */
    function creditsAccrueOf(state, nowTs) {
      if (!Credits) return { ok: false, reason: 'no-credits-module', state: null, credits: 0, changed: false }
      const acc = Credits.accrue(creditsStateOf(state), nowTs, policy)
      if (!acc.ok) return { ok: false, reason: acc.reason, state: null, credits: 0, changed: false }
      return {
        ok: true,
        reason: null,
        state: acc.state,
        credits: Math.max(0, Number(acc.state.credits) || 0),
        changed: acc.changed === true,
        produced: acc.produced || 0,
        added: acc.added || 0,
        rolledOver: acc.rolledOver === true
      }
    }
    /* ---------- F7-B：主动联系（四状态）只读视图 + 唯一写入面 ----------
       四状态写在 life-context.json 的 **F7 专属顶层区** proactive（不进 ledger.Entry ⇒ 不扩张 F3 语义），
       经 buildPayload 的未知顶层键透传走**同一原子提交 writer**（保存成功才发布）。 */
    function proactiveStore() {
      const st = (committed.ledgerState && committed.ledgerState.proactive) || null
      return {
        version: (st && st.version) || 'life-proactive-store/1',
        instances: (st && Array.isArray(st.instances)) ? st.instances.slice() : [],
        consumedCapEventIds: (st && Array.isArray(st.consumedCapEventIds)) ? st.consumedCapEventIds.slice() : []
      }
    }
    function proactiveInitiatedTodayOf(instances, nowTs) {
      const day = deps.autonomy.localDateKey(nowTs)
      return deps.proactive.initiatedTimestamps(instances).filter((ts) => deps.autonomy.localDateKey(ts) === day).length
    }
    function proactivePendingCapEvents() {
      const st = proactiveStore()
      /* F4-S2-A：F7 产生的 capEvent 一律带 `source:'proactive'`（**只加这一个字段**）——
         用于让 orchestrator 区分"主动被顶掉"与其它来源的 ignored（只有后者才允许降普通 cap）。 */
      return deps.proactive.capEventsOf(st.instances)
        .filter((e) => st.consumedCapEventIds.indexOf(e.id) < 0)
        .map((e) => Object.assign({}, e, { source: 'proactive' }))
    }
    function proactiveRecentOpenings(nowTs) {
      /* F4-S5：近 7 天已发出的开场（最多 20 条）——只作为**去重**依据；不新建第二套主动历史，
         数据源就是 instance.opening。 */
      const st = proactiveStore()
      const since = nowTs - 7 * 24 * 60 * 60 * 1000
      return st.instances
        .filter((x) => x && typeof x.opening === 'string' && x.opening.trim() && Number(x.presentedAt) >= since)
        .sort((a, b) => (Number(b.presentedAt) || 0) - (Number(a.presentedAt) || 0))
        .slice(0, 20)
        .map((x) => String(x.opening).trim().slice(0, 200))
    }
    /* P0-1c：同族 24h 内已真正呈现过 ⇒ family-recent（族级去重；24-72h 交给 CC5 carry 接续） */
    function familyRecentOf(instances, familyKey, nowTs) {
      const f = String(familyKey || '')
      if (!f) return false
      return (Array.isArray(instances) ? instances : []).some((x) => x && String(x.family || '') === f && Number(x.presentedAt) > 0 && (nowTs - Number(x.presentedAt)) < 24 * 60 * 60 * 1000)
    }
    function proactiveSuppressorsOf(nowTs, creditsOk, gates, familyKey) {
      const st = proactiveStore()
      const initiatedToday = proactiveInitiatedTodayOf(st.instances, nowTs)
      const ladder = (policy.intervalLadderMs && policy.intervalLadderMs.length) ? policy.intervalLadderMs : [20 * 60 * 1000]
      const idx = Math.min(Math.max(initiatedToday - 1, 0), ladder.length - 1)
      const ts = deps.proactive.initiatedTimestamps(st.instances)
      const lastInitiated = ts.length ? ts[ts.length - 1] : null
      const g = gates || {}
      const hour = new Date(nowTs).getHours()
      return {
        initiatedToday: initiatedToday,
        lastInitiatedTs: lastInitiated,
        flag: {
          switchEnabled: false,
          quietHours: (hour >= policy.quietHours.from) || (hour < policy.quietHours.to),
          ownerBusy: !!g.ownerBusy,
          politenessDefer: !!g.politenessDefer,
          /* F4-S2-B：第 5 项真值＝主动额度（**不再**借 autonomy 的 cap；与 F4 资格前置同源） */
          noCredit: creditsOk !== true,
          intervalOk: lastInitiated === null ? true : (nowTs - lastInitiated) >= ladder[idx],
          familyRecent: familyRecentOf(st.instances, familyKey, nowTs)
        }
      }
    }
    function tick(t) {
      const ti = t || {}
      const nowTs = ti.nowTs
      if (!(typeof nowTs === 'number' && nowTs > 0)) return { ok: false, committed: false, reason: 'bad_nowTs' }
      ticks++

      /* ---- 计算阶段：完全不修改 committed ---- */
      const facts = deps.facts.buildFacts({ nowTs, timeline: ti.timeline, media: ti.media })
      const self = deps.selfKnowledge.project({
        nowTs,
        static: ti.static,
        runtime: ti.runtime,
        permission: ti.permission,
        declared: ti.declared
      })
      const poolFiltered = filterPoolByCapability(ti.pool, self, { requirements })
      const prevValues = (committed.emotion && committed.emotion.values) || {}
      const meanings = deps.meaning.project(facts.facts, { emotion: { values: prevValues }, selfKnowledge: self }, { nowTs, rules })
      const adopted = selectAdopted(meanings)
      const prevTickTs = committed.meta && typeof committed.meta.lastTickTs === 'number' ? committed.meta.lastTickTs : null
      const acts = actsToday(committed.ledgerState, nowTs, deps.autonomy, deps.ledger)
      /* F4-S2-A：主动 act **不进普通 cap 口径**（名单来自 policy.capExemptActions）；
         两个口径分开喂 F4：actsToday＝事实源（间隔基准，旧语义），capActs＝普通 cap 计数。 */
      const capExemptActions = Array.isArray(policy.capExemptActions) ? policy.capExemptActions : []
      const capActs = actsToday(committed.ledgerState, nowTs, deps.autonomy, deps.ledger, { excludeActions: capExemptActions })
      /* F4-S2-B：**同一份真值**——本 tick 只 accrue 一次，结果分别交给 F4 资格前置与 F7 抑制器（禁止两套状态各算一次） */
      const cr = creditsAccrueOf(committed.ledgerState, nowTs)
      const creditsOk = cr.credits > 0
      const capToday = (committed.cap && committed.cap.dateKey === deps.autonomy.localDateKey(nowTs) && Number.isFinite(committed.cap.cap))
        ? committed.cap.cap
        : policy.dailyCap
      // Contact cooldown starts at actual presentation, using the same truth as F7.
      // A choice whose opening was never delivered must remain retryable.
      const proactiveTiming = deps.proactive ? proactiveSuppressorsOf(nowTs, creditsOk, ti.gates || {}, null) : null

      const decideInput = {
        nowTs,
        pool: poolFiltered.kept,
        meaning: { adopted },
        emotion: { values: prevValues },
        actsToday: acts,
        capActs: capActs,
        /* F4-S2-B：资格真值＝本轮真实额度（`ledgerState.proactiveCredits` ⇒ accrue）；**无任何"缺省 true 放行"** */
        proactiveHasCredits: creditsOk,
        proactiveActions: deps.proactive ? deps.proactive.LEGAL_ACTIONS : [],
        proactiveIntervalOk: proactiveTiming ? proactiveTiming.flag.intervalOk : null,
        cap: capToday,
        gates: ti.gates || {},
        dutyEvidence: ti.dutyEvidence || [],
        random: ti.random
      }
      const decision = deps.autonomy.decide(decideInput, policy)

      steps++ // 本轮唯一一次 step()（结构上只有一个调用点；status() 可断言 steps === ticks）
      const nextEmotion = deps.bridge.step(prevValues, {
        events: ti.events,
        adopted,
        clock: { nowTs, prevTs: prevTickTs }
      })

      const entry = deps.autonomy.toLedgerEntry(decision, decideInput)
      /* R-9 收尾（用户 裁定）：把内部候选**已有**的 evidenceRefs 原样写进既有 `refs` 字段。
         · 不新增字段、不改事件语义、不改 F4/F7：只在"refs 为空 **且** 本轮选中的候选自带证据"时补；
         · 命名空间（正式固化）：`mem:`（记忆库真实 id）／`pet:`（pet-state 真实字段，如 pet:ownerBirthday／
           pet:todo:<id>）／`tl:`（daily-timeline 真实段，如 tl:segment:<startTs>）——只允许指向当前真实来源。 */
      if (entry && Array.isArray(entry.refs) && entry.refs.length === 0 && decision && decision.chosenActionId) {
        const __picked = (Array.isArray(decision.scored) ? decision.scored : []).filter((c) => c && c.actionId === decision.chosenActionId)[0]
        const __refs = (__picked && Array.isArray(__picked.evidenceRefs)) ? __picked.evidenceRefs.filter((x) => typeof x === 'string' && x) : []
        if (__refs.length) entry.refs = __refs.slice()
      }
      const isNullGate = !!(decision && decision.outcome === 'gated' && decision.gate === NULL_GATE)
      let nextLedger = committed.ledgerState
      let appended = null
      if (!isNullGate) {
        /* F5-A/F3 wiring repair：F4 写的 refs 是**事实 id**（f:…），
           而 F3 的 recompute 只按"条目 id"解析 ⇒ 新 choice 永远 support=0/basisStale=true。
           这里只把"本轮 facts 的可用性"作为外部依据解析器喂进去——支撑度公式与有效性定义不变。 */
        const __factIds = {}
        ;(facts.facts || []).forEach((f) => { if (f && typeof f.id === 'string') __factIds[f.id] = true })
        const ap = deps.ledger.append(committed.ledgerState, entry, { nowTs: nowTs, resolveRefs: (id) => __factIds[id] === true || isSourceRef(id) })
        if (!ap.ok) return { ok: false, committed: false, persisted: false, reason: 'append-refused', detail: ap.reasons, tickIndex: ticks }
        nextLedger = ap.state
        appended = ap.entry
      }

      /* F7-B：本轮「能否呈现主动联系」的唯一判定（F4 已选中才可能 true；开关/cap/静默/忙碌/礼貌/间隔均为抑制器） */
      let proactiveView = null
      if (deps.proactive) {
      /* P0-1c：主题族键——从本轮 choice entry 的 refs[0] 派生（segment 载体按 fact value.cat 归并，
         解析不到回落裸 ref＝旧行为）；喂给 family-recent 真值与 proactiveView（→present 盖戳→CC5 族卡）。 */
      const __fam = (function () {
        // An unrelated activity must not suppress every semantic topic for a day.
        // The actual model-selected topic has its own persistent contact history.
        if (ti.runtime && ti.runtime.semanticTopics === true) return null
        try {
          const __ref0 = (appended && Array.isArray(appended.refs) && appended.refs.length) ? String(appended.refs[0]) : null
          if (!__ref0 || !deps.proactive || typeof deps.proactive.familyKeyOf !== 'function') return null
          return deps.proactive.familyKeyOf(__ref0, (id) => {
            const f = (facts.facts || []).find((x) => x && x.id === id)
            return (f && f.value && typeof f.value.cat === 'string') ? f.value.cat : null
          })
        } catch (err) { return null }
      })()
      const __ps = proactiveSuppressorsOf(nowTs, creditsOk, ti.gates || {}, __fam)
      __ps.flag.switchEnabled = ti.proactiveEnabled === true
      const __can = deps.proactive.canInitiate({ decision: decision, suppressors: __ps.flag })
      proactiveView = {
        chosenActionId: (decision && decision.chosenActionId) ? decision.chosenActionId : null,
        outcome: (decision && decision.outcome) ? decision.outcome : null,
        entryId: appended ? appended.id : null,
        family: __fam || null,
        canPresent: !!__can.ok,
        blockedBy: __can.blockedBy || null,
        suppressors: __ps.flag,
        initiatedToday: __ps.initiatedToday,
        lastInitiatedTs: __ps.lastInitiatedTs,
        pendingCapEvents: proactivePendingCapEvents().length,
        credits: cr.credits,
        creditsOk: creditsOk,
        /* F4-S5：近 7 天开场（≤20 条）供生成侧本地 bigram 去重；本视图仍是只读 */
        recentOpenings: proactiveRecentOpenings(nowTs)
      }
      }

      /* F7-B：capEvent 兼容两种形态——F7 的 { event, atTs, id } 对象，或裸字符串 'ignored'/'replied'（既有测试与调用方）。
         状态机只认字符串（input.event === 'ignored'）；传对象会静默落入 else ⇒ cap 永不下降。 */
      const __capEventStr = (ti.capEvent && typeof ti.capEvent === 'object' && typeof ti.capEvent.event === 'string') ? ti.capEvent.event : (ti.capEvent || null)
      /* F4-S2-A：**主动来源**的 'ignored' 不进入普通 cap 降额（`ignoreAdjust` 本体与其它来源照旧）。
         判据＝事件对象带 `source:'proactive'`（由 proactivePendingCapEvents 标注）；裸字符串／其它来源＝旧语义。 */
      const __capEventSource = (ti.capEvent && typeof ti.capEvent === 'object' && typeof ti.capEvent.source === 'string') ? ti.capEvent.source : null
      const __capEventIgnoredByProactive = (__capEventStr === 'ignored' && __capEventSource === 'proactive')
      const nextCap = deps.autonomy.nextCapState(committed.cap, { nowTs: nowTs, event: __capEventIgnoredByProactive ? null : __capEventStr }, policy)
      const nextEmotionSnap = { values: nextEmotion.values, updatedAt: nowTs, version: ((committed.emotion && committed.emotion.version) || 0) + 1 }
      const nextMeta = Object.assign({}, committed.meta, {
        lastTickTs: nowTs,
        cap: nextCap,
        emotion: nextEmotionSnap,
        orchestrator: ENGINE_VERSION
      })
      /* F7-B：capEvent 由 main 从 pendingCapEvents 队首注入；本轮成功即记入 consumed（同一原子提交） */
      let nextLedgerB = nextLedger
      if (ti.capEvent && typeof ti.capEvent.id === 'string') {
        const st0 = (nextLedger && nextLedger.proactive) || null
        if (st0) {
          const consumed = Array.isArray(st0.consumedCapEventIds) ? st0.consumedCapEventIds.slice() : []
          if (consumed.indexOf(ti.capEvent.id) < 0) consumed.push(ti.capEvent.id)
          nextLedgerB = Object.assign({}, nextLedger, { proactive: Object.assign({}, st0, { consumedCapEventIds: consumed }) })
        }
      }
      /* 视图里的待消费数按**本轮之后**的状态报告（本轮消费掉的那条不再计入） */
      if (proactiveView) {
        const stB = (nextLedgerB && nextLedgerB.proactive) || null
        const consB = (stB && Array.isArray(stB.consumedCapEventIds)) ? stB.consumedCapEventIds : []
        proactiveView.pendingCapEvents = (stB && Array.isArray(stB.instances)) ? deps.proactive.capEventsOf(stB.instances).filter((e) => consB.indexOf(e.id) < 0).length : 0
      }
      const shouldPersist = !!appended || (nowTs - (Number(committed.lastPersistTs) || 0)) >= throttleMs
      /* F4-S2-B：本轮 accrue 结果与其它账本字段走**同一份 nextLedger / 同一次 writer.save**（否则会账实不一致） */
      const nextLedgerC = cr.state ? Object.assign({}, nextLedgerB, { proactiveCredits: cr.state }) : nextLedgerB
      const nextSnapshot = {
        ledgerState: nextLedgerC,
        emotion: nextEmotionSnap,
        cap: nextCap,
        meta: nextMeta,
        lastPersistTs: shouldPersist ? nowTs : committed.lastPersistTs
      }

      /* ---- 提交阶段（原子）：写成功才发布；写失败 ⇒ 整轮保持旧快照 ---- */
      if (shouldPersist) {
        let w = null
        try {
          w = writer ? writer.save(buildPayload(nextSnapshot, deps.ledger)) : { ok: false, error: 'no-writer' }
        } catch (err) {
          w = { ok: false, error: String((err && err.message) || err) }
        }
        if (!w || w.ok !== true) {
          return {
            ok: false,
            committed: false,
            persisted: false,
            reason: 'commit-failed',
            detail: (w && (w.error || w.reason)) || 'writer-failed',
            tickIndex: ticks,
            decision,
            self,
            nextEmotionNotPublished: true
          }
        }
      }

      committed = nextSnapshot
      return {
        ok: true,
        committed: true,
        persisted: !!shouldPersist,
        tickIndex: ticks,
        decision,
        entry: appended,
        poolDropped: poolFiltered.dropped,
        self,
        facts,
        meanings,
        adopted,
        actsToday: acts,
        nextEmotion,
        nextCap,
        proactive: proactiveView
      }
    }

    /* F7-B：四状态写入入口（唯一）。只做组装与校验，不自行判定该不该联系（那是 F4 的权）。 */
    function recordProactiveEvent(evt) {
      const e = evt || {}
      const nowTs = Number(e.nowTs) || 0
      if (!(nowTs > 0)) return { ok: false, committed: false, persisted: false, reason: 'bad_nowTs' }
      if (!deps.proactive) return { ok: false, committed: false, persisted: false, reason: 'no-proactive-dep' }
      const st = proactiveStore()
      let instances = st.instances
      let touched = null
      let spentCredits = null
      if (e.type === 'present') {
        const pr = deps.proactive.present({ decision: e.decision, suppressors: e.suppressors, presented: e.presented === true, nowTs: nowTs, id: e.id, opening: e.opening, topic: e.topic, family: (typeof e.family === 'string' && e.family) ? e.family : null })
        if (!pr.ok) return { ok: false, committed: false, persisted: false, reason: 'present-refused:' + pr.reason }
        touched = pr.instance
        if (instances.some((x) => x && x.id === touched.id)) return { ok: false, committed: false, persisted: false, reason: 'duplicate-instance' }
        /* F4-S2-B：**只有"真正展示并成功提交"才花掉 1 枚**——位置在 present() 通过 **且 duplicate 去重之后**。
           额度不足 ⇒ 拒绝本次 present（不写实例、不扣额），保证账实相符。 */
        if (!Credits) return { ok: false, committed: false, persisted: false, reason: 'no-credit', detail: 'no-credits-module', credits: 0 }
        const sp = Credits.spend(creditsStateOf(committed.ledgerState), nowTs, policy)
        if (!sp.ok) return { ok: false, committed: false, persisted: false, reason: 'no-credit', detail: sp.reason, credits: (sp.state && Number(sp.state.credits)) || 0 }
        spentCredits = sp.state
        instances = instances.concat([touched]).map((x) => (x.id === touched.id ? x : deps.proactive.supersede(x, touched.id, nowTs).instance))
      } else if (e.type === 'view' || e.type === 'reply') {
        const idx = instances.findIndex((x) => x && x.id === e.id)
        if (idx < 0) return { ok: false, committed: false, persisted: false, reason: 'unknown-instance' }
        const tr = (e.type === 'view') ? deps.proactive.view(instances[idx], nowTs) : deps.proactive.reply(instances[idx], nowTs)
        if (!tr.ok) return { ok: false, committed: false, persisted: false, reason: tr.reason }
        touched = tr.instance
        instances = instances.slice(); instances[idx] = touched
      } else if (e.type === 'supersede') {
        const idx = instances.findIndex((x) => x && x.id === e.id)
        if (idx < 0) return { ok: false, committed: false, persisted: false, reason: 'unknown-instance' }
        const tr = deps.proactive.supersede(instances[idx], e.byId || null, nowTs)
        touched = tr.instance
        instances = instances.slice(); instances[idx] = touched
      } else {
        return { ok: false, committed: false, persisted: false, reason: 'bad-event-type' }
      }
      const inv = deps.proactive.assertInvariants(instances)
      if (!inv.ok) return { ok: false, committed: false, persisted: false, reason: 'invariant-violated', detail: inv.reasons }
      /* F4-S2-B：扣额结果与 proactive 实例放进**同一份 nextLedger**（同一次 writer.save 提交，无中途不一致） */
      const ledgerPatch = { proactive: { version: st.version, instances: instances, consumedCapEventIds: st.consumedCapEventIds } }
      if (spentCredits) ledgerPatch.proactiveCredits = spentCredits
      const nextLedger = Object.assign({}, committed.ledgerState, ledgerPatch)
      const nextSnapshot = Object.assign({}, committed, { ledgerState: nextLedger, lastPersistTs: nowTs })
      let w = null
      try { w = writer ? writer.save(buildPayload(nextSnapshot, deps.ledger)) : { ok: false, error: 'no-writer' } } catch (err) { w = { ok: false, error: String((err && err.message) || err) } }
      if (!w || w.ok !== true) return { ok: false, committed: false, persisted: false, reason: 'commit-failed', detail: (w && (w.error || w.reason)) || 'writer-failed' }
      committed = nextSnapshot
      return { ok: true, committed: true, persisted: true, instance: touched, initiatedToday: proactiveInitiatedTodayOf(instances, nowTs), credits: creditsStateOf(committed.ledgerState).credits }
    }

    function proactiveState(nowTs) {
      if (!deps.proactive) return { instances: [], initiatedToday: 0, pendingCapEvents: [] }
      const st = proactiveStore()
      const tsN = Number(nowTs) > 0 ? Number(nowTs) : 0
      return { instances: st.instances, initiatedToday: tsN ? proactiveInitiatedTodayOf(st.instances, tsN) : 0, pendingCapEvents: proactivePendingCapEvents() }
    }

    /* ---------- P3-C2-F1：经历（Experience）专属顶层区 ----------
       经历**不进 ledger.entries**（不扩张 F3 语义、不参与 recompute / fold）；
       经 buildPayload 的未知顶层键透传走**同一原子提交 writer**（保存成功才发布）。
       去重由本入口按 eventId 裁决（唯一权威）；时钟必须注入（本模块零真实时钟）。 */
    const EXPERIENCE_VERSION = 'life-experience-store/1'
    const EXPERIENCE_KINDS = ['E3_long_activity', 'E4_late_night', 'E5_absence_return', 'A4_listening_dwell', 'P1_proactive_talk']
    const MAX_EXPERIENCE_ENTRIES = 50
    const EXPERIENCE_TEXT_MAX = 160
    const EXPERIENCE_FORBIDDEN_FIELDS = ['happiness', 'fatigue', 'affection', 'derivedMood', 'values', 'mood']
    function experienceStore() {
      const st = (committed.ledgerState && committed.ledgerState.experiences) || null
      return {
        version: (st && st.version) || EXPERIENCE_VERSION,
        entries: (st && Array.isArray(st.entries)) ? st.entries.slice() : []
      }
    }
    function recordExperience(entry) {
      const e0 = entry || {}
      const ts = Number(e0.ts) || 0
      if (!(ts > 0)) return { ok: false, committed: false, persisted: false, reason: 'bad_ts' }
      const eventId = String(e0.eventId || '')
      if (!eventId) return { ok: false, committed: false, persisted: false, reason: 'missing_eventId' }
      if (EXPERIENCE_KINDS.indexOf(String(e0.kind || '')) < 0) return { ok: false, committed: false, persisted: false, reason: 'kind-not-allowed' }
      const badFields = EXPERIENCE_FORBIDDEN_FIELDS.filter((k) => e0[k] !== undefined)
      if (badFields.length) return { ok: false, committed: false, persisted: false, reason: 'forbidden-field:' + badFields.join(',') }
      const text = String(e0.text || '').trim()
      if (!text || text.length > EXPERIENCE_TEXT_MAX) return { ok: false, committed: false, persisted: false, reason: 'bad_text' }
      const banned = (deps.ledger.BANNED_NARRATIVE || []).filter((b) => b && b.re && b.re.test(text))
      if (banned.length) return { ok: false, committed: false, persisted: false, reason: 'banned-narrative:' + banned[0].why }
      const st = experienceStore()
      if (st.entries.some((x) => x && x.eventId === eventId)) {
        return { ok: true, committed: false, persisted: false, duplicate: true, reason: 'duplicate-eventId', count: st.entries.length }
      }
      const record = {
        id: 'exp:' + eventId,
        eventId: eventId,
        observationId: String(e0.observationId || ''),
        kind: String(e0.kind),
        topic: String(e0.topic || ''),
        sensor: String(e0.sensor || ''),
        category: String(e0.category || ''),
        source: String(e0.source || 'perception'),
        ts: ts,
        text: text
      }
      let entries = st.entries.concat([record])
      if (entries.length > MAX_EXPERIENCE_ENTRIES) {
        entries = entries.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0)).slice(-MAX_EXPERIENCE_ENTRIES)
      }
      const nextLedger = Object.assign({}, committed.ledgerState, {
        experiences: { version: st.version, entries: entries }
      })
      const nextSnapshot = Object.assign({}, committed, { ledgerState: nextLedger, lastPersistTs: ts })
      let w = null
      try { w = writer ? writer.save(buildPayload(nextSnapshot, deps.ledger)) : { ok: false, error: 'no-writer' } } catch (err) { w = { ok: false, error: String((err && err.message) || err) } }
      if (!w || w.ok !== true) return { ok: false, committed: false, persisted: false, reason: 'commit-failed', detail: (w && (w.error || w.reason)) || 'writer-failed' }
      committed = nextSnapshot
      return { ok: true, committed: true, persisted: true, duplicate: false, record: record, count: entries.length }
    }
    function experienceState() {
      const st = experienceStore()
      return { version: st.version, count: st.entries.length, entries: st.entries }
    }

    /* ---------- P3-F0：前台变化观察旁路（**独立顶层区**） ----------
       与 experiences/proactive 同机制：不进 ledger.entries（不扩张 F3 语义、不进 F1/F2/F4 消费链），
       经 buildPayload 未知顶层键透传走**同一原子提交 writer**（保存成功才发布）。
       · 模块由 deps.foregroundObservation 注入（可选；缺 ⇒ 无旁路能力，既有会话行为不变）
       · 自进程名单由 createSession 的 selfProcessNames 注入（生产 = main.js 的 SELF_PROCESS_NAMES）
       · 时钟必须注入（本模块零真实时钟）；from 以 store.lastTo 为唯一权威（调用方不传 from） */
    const fgObs = deps.foregroundObservation || null
    const selfProcessNames = Array.isArray(i.selfProcessNames) ? i.selfProcessNames.slice() : []
    function foregroundObservationStore() {
      const st = (committed.ledgerState && committed.ledgerState.foregroundObservations) || null
      return fgObs.createStore(st)
    }
    function recordForegroundObservation(input) {
      if (!fgObs) return { ok: false, committed: false, persisted: false, reason: 'no-fg-obs-dep' }
      const src = input || {}
      const isGap = src.gap === true
      const st = foregroundObservationStore()
      const built = fgObs.buildRecord({
        ts: src.ts, to: src.to, from: isGap ? null : st.lastTo,
        category: src.category, source: src.source, gap: isGap
      }, { selfNames: selfProcessNames })
      if (!built.ok) {
        /* 断档拒绝路径：该条记录不了（自进程/无前台/坏输入），
           但断档事实仍使 lastTo 失效——否则后续普通 E1 会沿用旧链伪造断档前后的直接切换。
           仅 gap 信号触发；普通 E1 自进程路径行为完全不变（仍零触碰 store）。 */
        if (isGap) {
          const br = fgObs.breakChain(st)
          if (!br.changed) return { ok: false, committed: false, persisted: false, reason: built.reason, brokenChain: true }
          const nextLedgerB = Object.assign({}, committed.ledgerState, { foregroundObservations: br.store })
          const snapB = Object.assign({}, committed, { ledgerState: nextLedgerB, lastPersistTs: committed.lastPersistTs })
          let wb = null
          try { wb = writer ? writer.save(buildPayload(snapB, deps.ledger)) : { ok: false, error: 'no-writer' } } catch (err) { wb = { ok: false, error: String((err && err.message) || err) } }
          if (!wb || wb.ok !== true) return { ok: false, committed: false, persisted: false, reason: 'commit-failed', detail: (wb && (wb.error || wb.reason)) || 'writer-failed', gapReason: built.reason }
          committed = snapB
          return { ok: false, committed: true, persisted: true, reason: built.reason, brokenChain: true }
        }
        return { ok: false, committed: false, persisted: false, reason: built.reason }
      }
      const ap = fgObs.append(st, built.record, { gap: isGap })
      if (!ap.ok) return { ok: false, committed: false, persisted: false, reason: ap.reason }
      if (ap.duplicate) return { ok: true, committed: false, persisted: false, duplicate: true, reason: ap.reason, count: st.entries.length }
      const nextLedger = Object.assign({}, committed.ledgerState, { foregroundObservations: ap.store })
      const nextSnapshot = Object.assign({}, committed, { ledgerState: nextLedger, lastPersistTs: built.record.ts })
      let w = null
      try { w = writer ? writer.save(buildPayload(nextSnapshot, deps.ledger)) : { ok: false, error: 'no-writer' } } catch (err) { w = { ok: false, error: String((err && err.message) || err) } }
      if (!w || w.ok !== true) return { ok: false, committed: false, persisted: false, reason: 'commit-failed', detail: (w && (w.error || w.reason)) || 'writer-failed' }
      committed = nextSnapshot
      return { ok: true, committed: true, persisted: true, duplicate: false, record: built.record, count: ap.store.entries.length }
    }
    function foregroundObservationState() {
      if (!fgObs) return { version: null, count: 0, lastTo: null, entries: [] }
      const st = foregroundObservationStore()
      return { version: st.version, count: st.entries.length, lastTo: st.lastTo, entries: st.entries }
    }

    function describe() {
      return {
        engineVersion: ENGINE_VERSION,
        metaThrottleMs: throttleMs,
        deps: ORCHESTRATOR_DEPS.slice(),
        actionCapabilityRequirements: Object.keys(requirements),
        hasWriter: !!writer
      }
    }

    return { tick, snapshot, status, describe, recordProactiveEvent, proactiveState, recordExperience, experienceState, recordForegroundObservation, foregroundObservationState, buildPayload: (s) => buildPayload(s, deps.ledger) }
  }

  function assertNoSurface() {
    const forbidden = ['say', 'speak', 'emit', 'dispatch', 'fire', 'run', 'notify', 'act', 'intent', 'presence', 'play', 'send']
    const keys = Object.keys(api || {})
    return { ok: keys.every((k) => forbidden.indexOf(k.toLowerCase()) < 0), keys }
  }

  const api = {
    ENGINE_VERSION,
    DEFAULT_META_THROTTLE_MS,
    NULL_GATE,
    PAYLOAD_SCHEMA_VERSION,
    ORCHESTRATOR_DEPS,
    ACTION_CAPABILITY_REQUIREMENTS,
    actsToday,
    filterPoolByCapability,
    selectAdopted,
    buildPayload,
    createSession,
    assertNoSurface
  }
  return api
})
