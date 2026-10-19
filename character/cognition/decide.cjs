'use strict'
/**
 * K4/K6 决策认知：模型只在**合法候选**中选择一个、等待，或在已有 recipe 内提出
 * 最多 3 步计划（总规 §14.2）。
 *
 * 模型不能：新增候选、修改证据、调用未授权能力、生成无限步骤。
 * 程序在模型之前就已经决定了“哪些是合法的”，模型的决定只是其中一次选择。
 */

const { getRecipe, validateProposedPlan } = require('../behavior/recipes.cjs')

const WAIT = 'wait'
const SELECT = 'select'

function buildDecideMessages (input) {
  const system = [
    '你是一个桌面角色的决策组件，只能从给定候选里选择，或选择等待。',
    '只输出 JSON，不要解释，不要 Markdown。',
    '允许的输出形状：',
    '{"action":"wait","reason":"..."}',
    '{"action":"select","opportunityId":"<候选ID>","recipeId":"<recipedId>","reason":"..."}',
    '{"action":"plan","opportunityId":"<候选ID>","recipeId":"<recipedId>","steps":[{"stepId":"<步骤ID>"}],"reason":"..."}',
    '禁止：发明候选ID、发明recipe、发明步骤、引用未列出的能力、编造事实。',
  ].join('\n')
  const payload = {
    now: input.asOf,
    situation: {
      state: input.context.sections.state,
      identity: input.context.sections.identity,
      concerns: input.context.sections.concerns,
      projects: input.context.sections.projects,
      observations: input.context.sections.observations,
      memories: input.context.sections.memories,
    },
    candidates: input.candidates,
    recipes: input.recipeViews,
    constraints: {
      maxPlanSteps: input.maxPlanSteps,
      mayContactOwner: input.mayContactOwner,
    },
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) },
  ]
}

/**
 * 校验模型决策。任何越权/非法 ID 都返回 rejected，不落副作用。
 */
function validateDecision (decision, input) {
  if (!decision || typeof decision !== 'object') return { ok: false, reason: 'decision_not_object' }
  const action = String(decision.action || '')
  if (action === WAIT) return { ok: true, value: { action: WAIT, reason: String(decision.reason || '').slice(0, 200) } }
  if (action !== SELECT && action !== 'plan') return { ok: false, reason: 'action_unknown' }
  const allowedIds = new Set((input.candidates || []).map(candidate => candidate.opportunityId))
  if (!allowedIds.has(decision.opportunityId)) return { ok: false, reason: 'opportunity_not_in_candidates' }
  const candidate = input.candidates.find(item => item.opportunityId === decision.opportunityId)
  const recipe = getRecipe(decision.recipeId)
  if (!recipe) return { ok: false, reason: 'recipe_unknown' }
  if (!recipe.originKinds.includes(candidate.kind) || !recipe.requiredCapabilities.every(capability => candidate.allowedCapabilities.includes(capability))) {
    return { ok: false, reason: 'recipe_capability_not_allowed' }
  }
  if (action === SELECT) {
    return { ok: true, value: { action: SELECT, opportunityId: decision.opportunityId, recipeId: recipe.recipeId, recipeVersion: recipe.version, reason: String(decision.reason || '').slice(0, 200) } }
  }
  const plan = validateProposedPlan(decision, { autonomous: true })
  if (!plan.ok) return { ok: false, reason: plan.reason }
  return {
    ok: true,
    value: {
      action: 'plan',
      opportunityId: decision.opportunityId,
      recipeId: recipe.recipeId,
      recipeVersion: recipe.version,
      steps: plan.steps,
      reason: String(decision.reason || '').slice(0, 200),
    },
  }
}

/**
 * @param {{gateway: object, config: object}} deps
 */
function createDecider (deps) {
  const gateway = deps.gateway
  const config = deps.config

  /**
   * @param {{context: object, candidates: object[], recipeViews: object[], signal?: AbortSignal, asOf: number}} input
   */
  async function decide (input) {
    const messages = buildDecideMessages(input)
    const result = await gateway.completeJson(
      { task: 'decide', messages, maxTokens: 400, temperature: 0.3, signal: input.signal, timeoutMs: 45000 },
      value => validateDecision(value, input),
    )
    if (!result.ok) return { ok: false, reason: result.reason, attempts: result.attempts || 1 }
    return { ok: true, decision: result.value, model: result.model, repaired: !!result.repaired }
  }

  return { decide, buildDecideMessages, validateDecision, maxPlanSteps: config.behavior.maxPlanSteps }
}

module.exports = { createDecider, buildDecideMessages, validateDecision, WAIT, SELECT }
