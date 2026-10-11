/* LifeAutonomyPolicy — F4 参数与闸门配置（**纯数据**，便于逐条评审）
 *
 * 上位约束：边界定稿 v1.1 §5（cap/间隔/安静/额度是刹车）+ F0F7 设计 §3.5 + 第二期施工单 §0 拍板
 *   - cap 默认 8＝**允许的最大机会数**（不是触发次数/目标次数/最低次数）
 *   - 间隔阶梯以"上一次真正 act"计时（F4 期 act 无开口，F7 换"真正发起"）
 *   - **额度是刹车不是油门**：`还剩几次`不得进入理由/候选意义/选择依据
 * - F4 期 cap 计数对象＝**当日 act 条数**（用户 拍板）；F7 再切"真正发起"
 *   - 只降不增／最低 1／次日恢复：状态机实现并单测；**F4 期产品路径不可达**（没有用户可见请求 ⇒ 无"被略过"）
 *
 * ⟨可调默认值⟩：wantThreshold / tieEpsilon / 间隔与安静时段，都可被用户一句话改。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeAutonomyPolicy = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const POLICY_VERSION = 'life-autonomy-policy/1'

  const DEFAULT_POLICY = Object.freeze({
    version: POLICY_VERSION,
    dailyCap: 8,                                  // 当日上限（= 允许的最大机会数）
    minCap: 1,                                    // 只降不增的下限（语义：上限最低为 1，实际可为 0 次）
    intervalLadderMs: Object.freeze([             // 第 1/2/3/4+ 次之后的**最小间隔**
      20 * 60 * 1000,
      40 * 60 * 1000,
      60 * 60 * 1000,
      90 * 60 * 1000
    ]),
    quietHours: Object.freeze({ from: 23, to: 7 }), // 深夜默认安静
    wantThreshold: 35,                            // ⟨可调⟩ 阈值作用在**评分**上（量级与既有 baseWeight 一致，约 10–60）；低于此分 ⇒"她不想做" ⇒ skip（Duty 不适用）
    tieEpsilon: 0.01,                             // ⟨可调⟩ 近似并列阈值（只有这里才允许可复现 tie-break）
    ignoreAdjust: Object.freeze({ capStep: 1 }),  // 被略过一次 ⇒ 当日 cap −1（最低 minCap）
    /* （F4-S2-A「主动资源与普通 autonomy 资源分离」）：**只加这一项**。
       名单内 action 的 act **不计入普通 cap 口径**，且**不被普通 cap-exhausted 阻断**（它的资源
       门槛由主动额度承担；额度接线属 S2-B）。其余 action 的 cap/interval/ignoreAdjust 一律不变。
       这是**资格**不是决策：最终仍由既有 decide() 选；缺省（无名单/未注入真值）与接入前逐字一致。 */
    capExemptActions: Object.freeze(['seek_attention']),
    /* **S1 只加数据、不接线**。
       语义＝每 3 小时产 1 枚（固定相位 00/03/…/21 本地时间）、每日最多产出 8 枚、库存 8、跨日清零；
       消费规则与纯函数实现见 renderer/life-context/proactive-credits.js（S2 才接线）。
       现有 dailyCap / intervalLadderMs / ignoreAdjust 的语义与取值**一律不动**。 */
    credits: Object.freeze({
      intervalHours: 3,
      phases: Object.freeze([0, 3, 6, 9, 12, 15, 18, 21]),
      perDay: 8,
      maxStock: 8,
      resetOnNewDay: true
    })
  })

  /* credits：缺省/非法一律回退默认；相位过滤到 [0,24) 并升序（不抛错、不伪造） */
  function normalizeCredits(input, def) {
    const c = (input && typeof input === 'object') ? input : {}
    const phasesRaw = Array.isArray(c.phases) && c.phases.length ? c.phases : def.phases
    const phases = phasesRaw
      .map((h) => Number(h))
      .filter((h) => Number.isFinite(h) && h >= 0 && h < 24)
      .sort((a, b) => a - b)
    return {
      intervalHours: Number.isFinite(c.intervalHours) && c.intervalHours > 0 ? c.intervalHours : def.intervalHours,
      phases: phases.length ? phases : def.phases.slice(),
      perDay: Number.isFinite(c.perDay) && c.perDay >= 0 ? c.perDay : def.perDay,
      maxStock: Number.isFinite(c.maxStock) && c.maxStock >= 0 ? c.maxStock : def.maxStock,
      resetOnNewDay: c.resetOnNewDay === undefined ? def.resetOnNewDay : !!c.resetOnNewDay
    }
  }

  /* capExemptActions：缺省/非法一律回退默认；只收非空字符串、去重保序（不抛错、不伪造） */
  function normalizeCapExemptActions(input, def) {
    const src = Array.isArray(input) ? input : def
    const out = []
    src.forEach((a) => { const s = String(a || ''); if (s && out.indexOf(s) < 0) out.push(s) })
    return out.length ? out : def.slice()
  }

  function normalizePolicy(input) {
    const p = input || {}
    const d = DEFAULT_POLICY
    const ladder = Array.isArray(p.intervalLadderMs) && p.intervalLadderMs.length ? p.intervalLadderMs.slice() : d.intervalLadderMs.slice()
    return {
      version: p.version || d.version,
      dailyCap: Number.isFinite(p.dailyCap) ? p.dailyCap : d.dailyCap,
      minCap: Number.isFinite(p.minCap) ? p.minCap : d.minCap,
      intervalLadderMs: ladder,
      quietHours: {
        from: p.quietHours && Number.isFinite(p.quietHours.from) ? p.quietHours.from : d.quietHours.from,
        to: p.quietHours && Number.isFinite(p.quietHours.to) ? p.quietHours.to : d.quietHours.to
      },
      wantThreshold: Number.isFinite(p.wantThreshold) ? p.wantThreshold : d.wantThreshold,
      tieEpsilon: Number.isFinite(p.tieEpsilon) ? p.tieEpsilon : d.tieEpsilon,
      ignoreAdjust: { capStep: p.ignoreAdjust && Number.isFinite(p.ignoreAdjust.capStep) ? p.ignoreAdjust.capStep : d.ignoreAdjust.capStep },
      capExemptActions: normalizeCapExemptActions(p.capExemptActions, d.capExemptActions),
      credits: normalizeCredits(p.credits, d.credits)
    }
  }

  return { POLICY_VERSION, DEFAULT_POLICY, normalizePolicy }
})
