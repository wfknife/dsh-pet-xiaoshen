'use strict'
/**
 * K4 行为硬约束与效用排序。
 *
 * 顺序固定（总规 §14.2）：先过不可越过的门，再对**合法**候选算归一化效用。
 * 门失败必须记录原因，不能因为“没有合法候选”就编造一个行为。
 *
 * 效用公式（初版权重全为 1，未测最优）：
 *   utility = urgency + needFit + commitment + preferenceFit + novelty
 *             - interruption - cost - repetition
 * 切换滞后：新候选必须比当前计划高 0.5 才主动切换；控制事件与主人插话除外。
 */

const COMPONENTS = Object.freeze([
  'urgency', 'needFit', 'commitment', 'preferenceFit', 'novelty', 'interruption', 'cost', 'repetition',
])
const POSITIVE = Object.freeze(['urgency', 'needFit', 'commitment', 'preferenceFit', 'novelty'])
const NEGATIVE = Object.freeze(['interruption', 'cost', 'repetition'])

function clamp01 (value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * 把候选的原始字段映射成 0..1 分量。缺字段按 0 处理（而不是猜一个“合理值”）。
 */
function componentsFor (opportunity, context) {
  const now = context.now
  const expiresIn = Math.max(0, (Number(opportunity.expiresAt) || now) - now)
  const urgency = opportunity.kind === 'concern_due'
    ? clamp01(0.6 + (1 - Math.min(1, expiresIn / 86400000)) * 0.4)
    : clamp01(Number(opportunity.expectedBenefit) || 0)
  const needFit = opportunity.kind === 'need' ? 1 : clamp01(Number(opportunity.expectedBenefit) || 0) * 0.5
  const commitment = opportunity.concernId || opportunity.projectId
    ? (opportunity.origin === 'owner' ? 1 : 0.8)
    : 0
  const preferenceFit = clamp01(context.preferenceFit && context.preferenceFit[opportunity.kind])
  const novelty = context.recentKinds && context.recentKinds.has(opportunity.kind) ? 0 : 0.6
  const interruption = opportunity.mayContactOwner
    ? clamp01(Number(opportunity.interruptionCost) || 0)
    : 0
  const cost = clamp01(Number(opportunity.costEstimate) || 0)
  const repetition = context.recentOpportunityIds && context.recentOpportunityIds.has(opportunity.opportunityId) ? 1 : 0
  return { urgency, needFit, commitment, preferenceFit, novelty, interruption, cost, repetition }
}

function utilityOf (components) {
  let total = 0
  for (const key of POSITIVE) total += components[key] || 0
  for (const key of NEGATIVE) total -= components[key] || 0
  // 归一到 0..1：最少 0，最多 5
  return Math.max(0, Math.min(1, total / 5))
}

/**
 * @param {{config: object, now?: Function}} deps
 */
function createRules (deps) {
  const config = deps.config
  const clock = typeof deps.now === 'function' ? deps.now : Date.now

  /**
   * @param {object[]} opportunities
   * @param {{now: number, deleted: Set<string>, availableCapabilities: Set<string>,
   *          capabilityEffects: object, quietUntil: number, ownerBusy: boolean,
   *          budget: {autonomousRemaining: number, contactRemaining: number},
   *          recentKinds?: Set<string>, recentOpportunityIds?: Set<string>,
   *          preferenceFit?: object}} context
   */
  function filter (opportunities, context) {
    const rejected = []
    const legal = []
    for (const opportunity of opportunities) {
      const gate = checkGates(opportunity, context)
      if (!gate.ok) { rejected.push({ opportunityId: opportunity.opportunityId, kind: opportunity.kind, code: gate.code, detail: gate.detail }); continue }
      const components = componentsFor(opportunity, context)
      const utility = utilityOf(components)
      legal.push({ ...opportunity, components, utility: Number(utility.toFixed(4)) })
    }
    legal.sort((a, b) => b.utility - a.utility)
    return { legal, rejected, evaluatedAt: context.now }
  }

  function checkGates (opportunity, context) {
    const now = context.now
    if (!opportunity || typeof opportunity !== 'object') return { ok: false, code: 'malformed' }
    if (!(Number(opportunity.expiresAt) > now)) return { ok: false, code: 'expired', detail: opportunity.expiresAt }
    const refs = opportunity.evidenceRefs || []
    if (refs.some(ref => context.deleted.has(ref))) return { ok: false, code: 'source_forgotten', detail: refs }
    const capabilities = opportunity.candidateCapabilities || []
    if (!capabilities.length) return { ok: false, code: 'no_capability' }
    const authorized = capabilities.filter(id => context.availableCapabilities.has(id))
    if (!authorized.length) return { ok: false, code: 'capability_not_authorized', detail: capabilities }
    // 世界类型必须与能力声明的 effect 兼容：虚拟能力不能把结果写成现实完成。
    for (const id of authorized) {
      const effect = context.capabilityEffects[id]
      if (!effect) return { ok: false, code: 'capability_effect_unknown', detail: id }
      if (opportunity.world === 'desktop_observed' && effect === 'external-unknown') {
        return { ok: false, code: 'effect_world_mismatch', detail: id }
      }
    }
    if (opportunity.mayContactOwner && now < context.quietUntil) return { ok: false, code: 'owner_quiet' }
    if (opportunity.mayContactOwner && context.ownerBusy) return { ok: false, code: 'owner_busy' }
    if (opportunity.mayContactOwner && context.budget.contactRemaining <= 0) return { ok: false, code: 'contact_budget_exhausted' }
    if (context.budget.autonomousRemaining <= 0) return { ok: false, code: 'autonomous_budget_exhausted' }
    if (context.recentOpportunityIds && context.recentOpportunityIds.has(opportunity.opportunityId)) {
      const lastAt = (context.recentTimestamps && context.recentTimestamps.get(opportunity.opportunityId)) || 0
      if (now - lastAt < 600000) return { ok: false, code: 'duplicate_too_soon' }
    }
    return { ok: true, authorizedCapabilities: authorized }
  }

  /**
   * 选择：合法候选里取。若已有在跑计划，除非新候选高出切换余量，否则保持原计划。
   * @returns {{selected: object|null, runnerUp: object|null, keptCurrent: boolean, reason: string, trace: object}}
   */
  function select (legal, options = {}) {
    const current = options.current || null
    const overrideCurrent = !!options.controlOverride
    if (!legal.length) return { selected: null, runnerUp: null, keptCurrent: !!current, reason: 'no_legal_candidate', trace: { legal: 0 } }
    const best = legal[0]
    if (current && !overrideCurrent) {
      const currentUtility = Number(current.utility) || 0
      if (currentUtility + config.behavior.switchMargin >= best.utility) {
        return {
          selected: current,
          runnerUp: best,
          keptCurrent: true,
          reason: 'switch_margin_not_met',
          trace: { currentUtility, bestUtility: best.utility, margin: config.behavior.switchMargin },
        }
      }
    }
    return {
      selected: best,
      runnerUp: legal[1] || null,
      keptCurrent: false,
      reason: overrideCurrent ? 'control_override' : 'utility_winner',
      trace: {
        considered: legal.slice(0, 5).map(item => ({ opportunityId: item.opportunityId, kind: item.kind, utility: item.utility, components: item.components })),
        weights: { positive: POSITIVE, negative: NEGATIVE },
      },
    }
  }

  /**
   * 模型只看 top N（默认 3）。返回裁剪后的候选视图：不含内部得分权重以外的信息，
   * 也不允许模型修改证据或新增能力。
   */
  function forModel (legal, limit) {
    const top = Number(limit) || config.behavior.topCandidatesForModel
    return legal.slice(0, top).map(opportunity => ({
      opportunityId: opportunity.opportunityId,
      kind: opportunity.kind,
      goal: opportunity.goal,
      world: opportunity.world,
      mayContactOwner: !!opportunity.mayContactOwner,
      allowedCapabilities: opportunity.candidateCapabilities,
      preconditions: opportunity.preconditions || [],
      expiresAt: opportunity.expiresAt,
    }))
  }

  return { filter, select, forModel, checkGates, componentsFor, utilityOf, COMPONENTS, POSITIVE, NEGATIVE }
}

module.exports = { createRules, componentsFor, utilityOf, COMPONENTS, POSITIVE, NEGATIVE }
