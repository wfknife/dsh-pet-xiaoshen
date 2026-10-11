/* LifeProactiveCredits — F4-S1「主动额度」纯函数模型（**零接线 / 零 I/O / 时间全靠注入**）
 *
 * 用户 确认的产品目标（S1 只建模，不接线）：
 *   · 每 3 小时产 1 枚主动额度（固定相位 00/03/06/09/12/15/18/21 本地时间）
 *   · 每日最多产出 8 枚；库存最多 8 枚；跨日清零
 *   · **只有 spend 才消耗**：不主动 / 延后 / AI 失败一律不消耗
 *
 * 边界（S1，见施工单）：
 *   - 本模块**不被任何生产代码引用**：接线属 S2，另行授权（本文件不改 autonomy/proactive/orchestrator/UI/IPC）
 *   - 零 I/O：不 require / 无 fs / 无 fetch / 无 IPC / **不读 Date.now()**（nowTs 一律注入 ⇒ 测试可冻结时间）
 *   - 不改变既有 dailyCap / intervalLadderMs / ignoreAdjust 的任何语义（仍在原处、原样生效）
 *
 * 唯一权威语义（逐条可离线单测）：
 *   state = { version, dateKey, credits, lastAccrualTs, producedToday, spentToday }
 * · dateKey = **本地日历日**，与 autonomy.localDateKey 同口径
 *   · producedToday = 当日已**结算**的产出相位个数（≤ perDay）；库存已满时相位仍结算
 *     （lastAccrualTs 前移、producedToday 计数），但 credits 不再增加
 *     ⇒ "每 3h 一枚"与"每天至多 8 枚""库存至多 8 枚"三条不变量同时成立
 *   · accrue(state, nowTs, policy)：先跨日 reset，再补算 (lastAccrualTs, nowTs] 内当日全部相位
 *     ⇒ 应用离线后重新进入时能补算**当日**已过相位；跨多日只补当日（更早的相位作废）
 *   · spend(state, nowTs, policy)：先跨日 reset（防上一日 credits 泄漏），再要求 credits ≥ 1；
 *     不足 ⇒ { ok:false, reason:'no-credits' }，**除跨日归零外不改任何字段**（无消耗副作用）
 *   · 全部函数为纯函数：入参不被修改、返回新对象、同 nowTs 重复调用幂等
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeProactiveCredits = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const STORE_VERSION = 'life-proactive-credits/1'

  /* 与 autonomy-policy.js 的 DEFAULT_POLICY.credits **必须一致**（S1 契约有防漂移断言）。
     保留镜像而不是 require：本模块要能在零接线的渲染层与 Node 两侧独立加载。 */
  const DEFAULT_CREDITS = Object.freeze({
    intervalHours: 3,
    phases: Object.freeze([0, 3, 6, 9, 12, 15, 18, 21]),
    perDay: 8,
    maxStock: 8,
    resetOnNewDay: true
  })

  function localDateKey(ts) {
    const d = new Date(ts)
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function startOfLocalDay(ts) {
    const d = new Date(ts)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  /* 归一化 policy.credits（缺省/非法 ⇒ 用镜像默认值；不抛错、不伪造） */
  function creditsPolicy(policy) {
    const c = (policy && typeof policy.credits === 'object' && policy.credits) ? policy.credits : null
    const src = c || DEFAULT_CREDITS
    const phasesRaw = Array.isArray(src.phases) && src.phases.length ? src.phases : DEFAULT_CREDITS.phases
    const phases = phasesRaw
      .map((h) => Number(h))
      .filter((h) => Number.isFinite(h) && h >= 0 && h < 24)
      .sort((a, b) => a - b)
    return {
      intervalHours: Number.isFinite(src.intervalHours) && src.intervalHours > 0 ? src.intervalHours : DEFAULT_CREDITS.intervalHours,
      phases: phases.length ? phases : DEFAULT_CREDITS.phases.slice(),
      perDay: Number.isFinite(src.perDay) && src.perDay >= 0 ? Math.floor(src.perDay) : DEFAULT_CREDITS.perDay,
      maxStock: Number.isFinite(src.maxStock) && src.maxStock >= 0 ? Math.floor(src.maxStock) : DEFAULT_CREDITS.maxStock,
      resetOnNewDay: src.resetOnNewDay === undefined ? DEFAULT_CREDITS.resetOnNewDay : !!src.resetOnNewDay
    }
  }

  /* 当日相位时刻（本地时间构造 ⇒ 不受时区偏移/DST 影响；升序） */
  function phaseTimestampsOfDay(nowTs, cp) {
    const d = new Date(nowTs)
    const y = d.getFullYear()
    const m = d.getMonth()
    const day = d.getDate()
    return cp.phases.map((h) => new Date(y, m, day, h, 0, 0, 0).getTime())
  }

  function intOr(v, dft) {
    return Number.isFinite(v) ? Math.floor(v) : dft
  }

  /* 规范化 state：坏数据一律收敛到不变量内（不伪造历史：缺失即 0 / null） */
  function createState(raw, policy) {
    const cp = creditsPolicy(policy)
    const s = (raw && typeof raw === 'object') ? raw : {}
    const st = {
      version: (typeof s.version === 'string' && s.version) ? s.version : STORE_VERSION,
      dateKey: (typeof s.dateKey === 'string' && s.dateKey) ? s.dateKey : null,
      credits: Math.max(0, intOr(s.credits, 0)),
      lastAccrualTs: Number.isFinite(s.lastAccrualTs) && s.lastAccrualTs > 0 ? s.lastAccrualTs : null,
      producedToday: Math.max(0, intOr(s.producedToday, 0)),
      spentToday: Math.max(0, intOr(s.spentToday, 0))
    }
    st.credits = Math.min(st.credits, cp.maxStock)
    st.producedToday = Math.min(st.producedToday, cp.perDay)
    st.spentToday = Math.min(st.spentToday, cp.perDay)
    return st
  }

  /* 跨日归零（幂等）：credits / producedToday / spentToday 一律不带入新一天 */
  function rollover(state, nowTs, policy) {
    const cp = creditsPolicy(policy)
    const st = createState(state, policy)
    const key = localDateKey(nowTs)
    if (st.dateKey === key) return { ok: true, changed: false, state: st, dateKey: key }
    if (cp.resetOnNewDay !== true) return { ok: true, changed: false, state: st, dateKey: st.dateKey, disabledByPolicy: true }
    return {
      ok: true,
      changed: true,
      dateKey: key,
      rolledOverFrom: st.dateKey,
      state: { version: st.version, dateKey: key, credits: 0, lastAccrualTs: null, producedToday: 0, spentToday: 0 }
    }
  }

  /* 产出：补算当日已过相位。返回 { ok, changed, state, produced, added, rolledOver } */
  function accrue(state, nowTs, policy) {
    if (!Number.isFinite(nowTs) || nowTs <= 0) return { ok: false, reason: 'bad_nowTs' }
    const cp = creditsPolicy(policy)
    const ro = rollover(state, nowTs, policy)
    const st = ro.state
    const phases = phaseTimestampsOfDay(nowTs, cp)
    let produced = 0
    let added = 0
    let lastTs = st.lastAccrualTs
    for (let i = 0; i < phases.length; i++) {
      const ts = phases[i]
      if (ts > nowTs) break
      if (lastTs !== null && ts <= lastTs) continue
      lastTs = ts
      if (st.producedToday >= cp.perDay) continue   // 当日产出已满：相位结算但不计数、不入库
      st.producedToday += 1
      produced += 1
      if (st.credits < cp.maxStock) {
        st.credits += 1
        added += 1
      }
    }
    if (produced === 0 && !ro.changed) return { ok: true, changed: false, state: st, produced: 0, added: 0, rolledOver: false }
    st.lastAccrualTs = lastTs
    return { ok: true, changed: true, state: st, produced: produced, added: added, rolledOver: ro.changed }
  }

  /* 消耗：唯一会减少 credits 的入口。额度不足 ⇒ 失败且不产生消耗副作用。 */
  function spend(state, nowTs, policy) {
    if (!Number.isFinite(nowTs) || nowTs <= 0) return { ok: false, reason: 'bad_nowTs' }
    const cp = creditsPolicy(policy)
    const ro = rollover(state, nowTs, policy)
    const st = ro.state
    if (st.credits < 1) {
      return { ok: false, reason: 'no-credits', changed: false, state: st, rolledOver: ro.changed, credits: st.credits }
    }
    const next = {
      version: st.version,
      dateKey: st.dateKey,
      credits: st.credits - 1,
      lastAccrualTs: st.lastAccrualTs,
      producedToday: st.producedToday,
      spentToday: Math.min(cp.perDay, st.spentToday + 1)
    }
    return { ok: true, changed: true, state: next, credits: next.credits, rolledOver: ro.changed }
  }

  function assertInvariants(state, policy) {
    const cp = creditsPolicy(policy)
    const reasons = []
    const s = state || {}
    if (typeof s.version !== 'string' || !s.version) reasons.push('bad_version')
    if (!(s.dateKey === null || typeof s.dateKey === 'string')) reasons.push('bad_dateKey')
    if (!Number.isInteger(s.credits) || s.credits < 0) reasons.push('bad_credits')
    if (Number.isInteger(s.credits) && s.credits > cp.maxStock) reasons.push('credits_over_maxStock:' + s.credits + '>' + cp.maxStock)
    if (!Number.isInteger(s.producedToday) || s.producedToday < 0) reasons.push('bad_producedToday')
    if (Number.isInteger(s.producedToday) && s.producedToday > cp.perDay) reasons.push('produced_over_perDay:' + s.producedToday + '>' + cp.perDay)
    if (!Number.isInteger(s.spentToday) || s.spentToday < 0) reasons.push('bad_spentToday')
    if (Number.isInteger(s.spentToday) && s.spentToday > cp.perDay) reasons.push('spent_over_perDay:' + s.spentToday + '>' + cp.perDay)
    if (!(s.lastAccrualTs === null || Number.isFinite(s.lastAccrualTs))) reasons.push('bad_lastAccrualTs')
    return { ok: reasons.length === 0, reasons: reasons }
  }

  return {
    STORE_VERSION,
    DEFAULT_CREDITS,
    localDateKey,
    startOfLocalDay,
    creditsPolicy,
    phaseTimestampsOfDay,
    createState,
    rollover,
    accrue,
    spend,
    assertInvariants
  }
})
