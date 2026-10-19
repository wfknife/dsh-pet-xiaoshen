'use strict'
/**
 * K4 短计划执行状态机。
 *
 * 借用 BehaviorTree.CPP 的执行语义而不是引擎本身（总规 §6.1）：
 *  - “动作尚未完成”是稳定状态（waiting），不是必须立刻返回成功的函数；
 *  - 条件步在每次 tick 重评；
 *  - 显式 halt（取消）会让后续步骤不再执行，但**不篡改已经发生的结果**；
 *  - 回执到达才推进 cursor；unknown 只能等待核对，不能盲重发。
 */

const { deterministicId } = require('../ids.cjs')

const PLAN_STATUS = Object.freeze(['active', 'waiting', 'completed', 'failed', 'cancelled'])

function createPlan (input) {
  const recipe = input.recipe
  const planId = deterministicId('plan', input.characterId + '|' + recipe.recipeId + '|' + recipe.version + '|' + input.now + '|' + Math.random().toString(36).slice(2, 8))
  return {
    planId,
    characterId: input.characterId,
    opportunityId: input.opportunity ? input.opportunity.opportunityId : null,
    recipeId: recipe.recipeId,
    recipeVersion: recipe.version,
    status: 'active',
    stepCursor: 0,
    epoch: input.epoch,
    createdAt: input.now,
    updatedAt: input.now,
    cancelReason: null,
    steps: recipe.steps.map(step => ({
      stepId: step.id,
      type: step.type,
      capabilityId: step.capabilityId || null,
      condition: step.condition || null,
      args: step.args || null,
      status: 'pending',
      operationId: null,
      attempts: 0,
      outcome: null,
    })),
  }
}

function currentStep (plan) {
  if (!plan || plan.status === 'completed' || plan.status === 'cancelled' || plan.status === 'failed') return null
  return plan.steps[plan.stepCursor] || null
}

/**
 * 评估条件步。上下文由内核从同一 revision 装配（state/observations/artifacts/concern/project）。
 * 条件失败是**正常的执行结果**（例如已经很精神了），不是错误。
 */
function evaluateCondition (step, context) {
  const args = step.args || {}
  switch (step.condition) {
    case 'always':
      return { ok: true }
    case 'needs_at_least': {
      const value = context.state && context.state.needs ? Number(context.state.needs[args.name]) : null
      if (value === null) return { ok: false, reason: 'needs_unavailable' }
      return { ok: value >= Number(args.value), value, threshold: Number(args.value) }
    }
    case 'needs_at_most': {
      const value = context.state && context.state.needs ? Number(context.state.needs[args.name]) : null
      if (value === null) return { ok: false, reason: 'needs_unavailable' }
      return { ok: value <= Number(args.value), value, threshold: Number(args.value) }
    }
    case 'observation_fresh': {
      const fresh = (context.observations || []).filter(item => item.freshUntil > context.now)
      // 有新鲜观测，或候选自带可定位来源，都足以支撑“这条记录有来源”。
      const evidence = (context.evidenceRefs || []).filter(Boolean)
      return { ok: fresh.length > 0 || evidence.length > 0, count: fresh.length, evidenceRefs: evidence.length }
    }
    case 'artifact_exists': {
      const artifacts = context.artifactRefs || []
      return { ok: artifacts.length > 0, count: artifacts.length }
    }
    case 'concern_status': {
      const status = context.concern && context.concern.status
      const allowed = Array.isArray(args.status) ? args.status : []
      return { ok: !!status && allowed.includes(status), status }
    }
    case 'project_cursor': {
      const project = context.project
      if (!project) return { ok: false, reason: 'project_missing' }
      return { ok: Number(project.stepCursor) === Number(args.expected), stepCursor: project.stepCursor }
    }
    default:
      return { ok: false, reason: 'condition_unknown', condition: step.condition }
  }
}

/**
 * 计算下一步该怎么动。内核据此决定：调能力、推进、还是等待。
 * @returns {{kind: 'capability'|'done'|'halted'|'waiting', step?: object, reason?: string}}
 */
function planNext (plan, context) {
  if (!plan) return { kind: 'halted', reason: 'plan_missing' }
  if (plan.status === 'waiting') return { kind: 'waiting', reason: 'awaiting_reconcile' }
  if (['completed', 'cancelled', 'failed', 'paused'].includes(plan.status)) return { kind: 'halted', reason: plan.status }
  const step = currentStep(plan)
  if (!step) return { kind: 'done' }
  if (step.status === 'running') return { kind: 'waiting', reason: 'step_running', step }
  if (step.type === 'condition') {
    const result = evaluateCondition(step, context)
    return { kind: 'condition', step, result }
  }
  return { kind: 'capability', step }
}

function markStepRunning (plan, stepId, operationId, now) {
  return mutate(plan, now, next => {
    const step = next.steps.find(item => item.stepId === stepId)
    if (!step) return next
    step.status = 'running'
    step.operationId = operationId
    step.attempts += 1
    next.status = 'waiting'
    return next
  })
}

/**
 * 回执 → 推进。
 * - succeeded：条件步记录结果；能力步推进 cursor，全部完成则 completed。
 * - failed：按 recoveryPolicy 决定重试/暂停；不把失败当成功。
 * - unknown：plan 进入 waiting，等 reconcile；绝不自动重发。
 */
function markStepResult (plan, stepId, result, now) {
  return mutate(plan, now, next => {
    const step = next.steps.find(item => item.stepId === stepId)
    if (!step) return next
    step.outcome = result.outcome || null
    if (result.outcome === 'succeeded') {
      step.status = 'succeeded'
      next.stepCursor += 1
      // Kernel finalizes only after checking receipts/artifacts and applying domain progress.
      next.status = 'active'
      return next
    }
    if (result.outcome === 'failed') {
      step.status = 'failed'
      const policy = result.recoveryPolicy || {}
      const canRetry = step.attempts < (Number(policy.maxAttempts) || 1) && policy.onFailure === 'retry_once'
      if (canRetry) {
        step.status = 'pending'
        step.operationId = null
        next.status = 'active'
      } else {
        next.status = 'failed'
        next.failureReason = result.reason || 'step_failed'
      }
      return next
    }
    if (result.outcome === 'unknown') {
      step.status = 'running'
      next.status = 'waiting'
      next.unknownReason = result.reason || 'operation_unknown'
      return next
    }
    if (result.outcome === 'cancelled') {
      step.status = 'halted'
      next.status = 'cancelled'
      next.cancelReason = result.reason || 'cancelled'
      return next
    }
    return next
  })
}

/**
 * 显式取消（halt）。只影响后续步骤；已经发生的副作用通过 operation 保留真实结果。
 */
function halt (plan, reason, now) {
  return mutate(plan, now, next => {
    next.status = 'cancelled'
    next.cancelReason = String(reason || 'cancelled').slice(0, 200)
    for (let i = next.stepCursor; i < next.steps.length; i++) {
      if (next.steps[i].status === 'pending') next.steps[i].status = 'halted'
    }
    return next
  })
}

function mutate (plan, now, fn) {
  const next = {
    ...plan,
    steps: plan.steps.map(step => ({ ...step })),
    updatedAt: Number(now) || plan.updatedAt,
  }
  return fn(next)
}

/** 计划是否因 epoch 变化而失效：旧 epoch 的计划不得继续提交。 */
function staleForEpoch (plan, epoch) {
  return !plan || plan.epoch !== epoch
}

module.exports = {
  PLAN_STATUS,
  createPlan,
  currentStep,
  evaluateCondition,
  planNext,
  markStepRunning,
  markStepResult,
  halt,
  staleForEpoch,
}
