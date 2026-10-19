'use strict'
/**
 * K4 生活域：Concern 与 Project 的状态转换（纯函数）。
 *
 * 迁移决定（总规 §10.3）：旧 PetLife.threads 与 platform.concerns 合并为 Concern；
 * PetLife.activities 与 platform.projects 分成“短 Activity operation”与“跨回合 Project”，
 * 不再保留两个互相同步的项目权威。
 *
 * 完成依据是结构化条件 + 已提交回执，不是模型说“完成了”。
 */

const { CONCERN_STATUS, PROJECT_STATUS } = require('../contracts.cjs')

/** 允许的 Concern 迁移：任何状态都可因来源撤销进入 invalidated。 */
const CONCERN_TRANSITIONS = Object.freeze({
  open: ['deferred', 'resolved', 'cancelled', 'expired', 'invalidated'],
  deferred: ['open', 'resolved', 'cancelled', 'expired', 'invalidated'],
  resolved: ['invalidated'],
  cancelled: ['invalidated'],
  expired: ['invalidated'],
  invalidated: [],
})

const PROJECT_TRANSITIONS = Object.freeze({
  proposed: ['active', 'abandoned', 'expired', 'invalidated'],
  active: ['paused', 'completed', 'abandoned', 'expired', 'invalidated'],
  paused: ['active', 'abandoned', 'expired', 'invalidated'],
  completed: ['invalidated'],
  abandoned: ['invalidated'],
  expired: ['invalidated'],
  invalidated: [],
})

function canConcernTransition (from, to) {
  const allowed = CONCERN_TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}
function canProjectTransition (from, to) {
  const allowed = PROJECT_TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

function concernCountsAgainstCap (concern) {
  // 只有“打开且非用户强制”的关注受 8 条上限约束（§14.2）。
  return !!concern && concern.status === 'open' && concern.origin !== 'owner'
}
function projectCountsAgainstCap (project) {
  return !!project && (project.status === 'active' || project.status === 'proposed') && project.origin !== 'owner'
}

/**
 * 新建 Concern 前的硬上限判定。到上限时返回拒绝原因，由 Behavior 记录 trace，
 * 不静默丢弃候选。
 */
function canOpenConcern ({ existing, config }) {
  const cap = config.behavior.maxOpenNonOwnerConcerns
  const used = (existing || []).filter(concernCountsAgainstCap).length
  if (used >= cap) return { ok: false, reason: 'concern_cap_reached', used, cap }
  return { ok: true, used, cap }
}
function canOpenProject ({ existing, config }) {
  const cap = config.behavior.maxAutonomousProjects
  const used = (existing || []).filter(projectCountsAgainstCap).length
  if (used >= cap) return { ok: false, reason: 'project_cap_reached', used, cap }
  return { ok: true, used, cap }
}

/**
 * 到期判定。用户明确长期承诺不用统一 7 天过期；未指定则每 30 天重新确认必要性，
 * 期间不反复催问（§14.2）。
 */
function expiryFor (concern, config, now) {
  if (!concern) return null
  if (concern.origin === 'owner') {
    if (Number.isFinite(Number(concern.expiresAt)) && concern.expiresAt > 0) return concern.expiresAt
    return now + config.behavior.ownerCommitmentReviewDays * 86400000
  }
  if (Number.isFinite(Number(concern.expiresAt)) && concern.expiresAt > 0) return concern.expiresAt
  return now + config.behavior.defaultConcernExpiryDays * 86400000
}

/**
 * 纯函数：把一个关注推进到新状态，返回新对象或拒绝原因。
 * @param {object} concern 当前关注
 * @param {string} to 目标状态
 * @param {{now: number, reason?: string, sourceRefs?: string[]}} ctx
 */
function transitionConcern (concern, to, ctx = {}) {
  if (!concern) return { ok: false, reason: 'concern_missing' }
  if (!CONCERN_STATUS.includes(to)) return { ok: false, reason: 'concern_status_unknown', to }
  if (!canConcernTransition(concern.status, to)) return { ok: false, reason: 'concern_transition_invalid', from: concern.status, to }
  const now = Number(ctx.now) || 0
  const next = { ...concern, status: to, revision: (concern.revision || 0) + 1 }
  if (to === 'resolved' || to === 'cancelled' || to === 'expired' || to === 'invalidated') next.nextCheckAt = null
  if (to === 'deferred') next.nextCheckAt = Number(ctx.deferUntil) || (now + 3600000)
  if (to === 'open') next.nextCheckAt = Number(ctx.nextCheckAt) || null
  if (to === 'invalidated') next.invalidatedReason = String(ctx.reason || 'source_revoked').slice(0, 200)
  return { ok: true, concern: next }
}

function transitionProject (project, to, ctx = {}) {
  if (!project) return { ok: false, reason: 'project_missing' }
  if (!PROJECT_STATUS.includes(to)) return { ok: false, reason: 'project_status_unknown', to }
  if (!canProjectTransition(project.status, to)) return { ok: false, reason: 'project_transition_invalid', from: project.status, to }
  const next = { ...project, status: to, revision: (project.revision || 0) + 1 }
  if (to === 'completed' || to === 'abandoned' || to === 'expired' || to === 'invalidated') next.nextWakeAt = null
  if (to === 'invalidated') next.invalidatedReason = String(ctx.reason || 'source_revoked').slice(0, 200)
  return { ok: true, project: next }
}

/**
 * 项目完成条件：必须由“结构化产物 + 已提交回执”满足，模型自称完成不算。
 * @param {object} project
 * @param {{recipe: object, artifactRefs: string[], receipts: object[]}} evidence
 */
function projectCompletion (project, evidence) {
  const recipe = evidence && evidence.recipe
  const artifacts = (evidence && evidence.artifactRefs) || []
  const receipts = (evidence && evidence.receipts) || []
  if (!recipe || !recipe.successCondition) return { ok: false, reason: 'no_success_condition' }
  const condition = recipe.successCondition
  if (condition.minArtifacts && artifacts.length < condition.minArtifacts) {
    return { ok: false, reason: 'insufficient_artifacts', need: condition.minArtifacts, have: artifacts.length }
  }
  if (condition.requireReceipt && receipts.length === 0) return { ok: false, reason: 'missing_receipt' }
  if (condition.intent && !receipts.some(receipt => receipt && (condition.intent === 'presentation' ? receipt.capabilityId === 'presentation.text' : receipt.effect === condition.intent))) {
    return { ok: false, reason: 'receipt_effect_mismatch', need: condition.intent }
  }
  return { ok: true, artifactRefs: artifacts, receiptCount: receipts.length }
}

/**
 * 来源撤销传播：关注/项目因来源失效而无效化（而不是删除），
 * 这样用户仍能看到“它为何消失”。
 */
function invalidateBySources (items, revokedSources, now) {
  const revoked = revokedSources instanceof Set ? revokedSources : new Set(revokedSources || [])
  const out = []
  for (const item of items || []) {
    const refs = item.sourceRefs || []
    if (refs.length && refs.every(ref => revoked.has(ref)) && item.status !== 'invalidated') {
      const transition = item.desiredOutcome !== undefined
        ? transitionConcern(item, 'invalidated', { now, reason: 'source_revoked' })
        : transitionProject(item, 'invalidated', { now, reason: 'source_revoked' })
      out.push(transition.ok ? transition.concern || transition.project : item)
    } else {
      out.push(item)
    }
  }
  return out
}

module.exports = {
  CONCERN_TRANSITIONS,
  PROJECT_TRANSITIONS,
  canConcernTransition,
  canProjectTransition,
  canOpenConcern,
  canOpenProject,
  concernCountsAgainstCap,
  projectCountsAgainstCap,
  expiryFor,
  transitionConcern,
  transitionProject,
  projectCompletion,
  invalidateBySources,
}
