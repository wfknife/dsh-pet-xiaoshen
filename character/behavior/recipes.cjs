'use strict'
/**
 * K4/K5 短行为 recipe。**模型不能生成无限动态树**（总规 §6.1 / §17.2）：
 * recipe 是受版本控制的有限步骤，每步调用一个 Capability 或一个纯条件判断，
 * 必须等待真实回执才前进。
 *
 * 首批只实现三条（§20 K4）：安静休息、带来源的虚拟笔记、到期关注回访。
 * 每条都有进入条件、执行步骤、成功/失败/取消与下一次检查。
 */

const MAX_STEPS_MANUAL = 8
const MAX_STEPS_AUTONOMOUS = 3

const CONDITION_TYPES = Object.freeze(['needs_at_least', 'needs_at_most', 'observation_fresh', 'artifact_exists', 'concern_status', 'project_cursor', 'always'])

function validateRecipe (recipe) {
  const errors = []
  if (!recipe || typeof recipe !== 'object') return { ok: false, errors: ['recipe_not_object'] }
  if (typeof recipe.recipeId !== 'string' || !recipe.recipeId) errors.push('recipe_id')
  if (!Number.isSafeInteger(recipe.version) || recipe.version < 1) errors.push('recipe_version')
  if (!Array.isArray(recipe.steps) || !recipe.steps.length) errors.push('recipe_steps')
  else if (recipe.steps.length > MAX_STEPS_MANUAL) errors.push('recipe_steps_too_many')
  if (!Array.isArray(recipe.requiredCapabilities)) errors.push('recipe_capabilities')
  if (!recipe.successCondition || typeof recipe.successCondition !== 'object') errors.push('recipe_success_condition')
  for (const [index, step] of (recipe.steps || []).entries()) {
    if (!step || typeof step !== 'object') { errors.push('step_' + index + '_not_object'); continue }
    if (typeof step.id !== 'string' || !step.id) errors.push('step_' + index + '_id')
    if (step.type === 'capability') {
      if (typeof step.capabilityId !== 'string' || !step.capabilityId) errors.push('step_' + index + '_capability')
      if (!step.waitForReceipt) errors.push('step_' + index + '_must_wait_for_receipt')
    } else if (step.type === 'condition') {
      if (!CONDITION_TYPES.includes(step.condition)) errors.push('step_' + index + '_condition_unknown')
    } else {
      errors.push('step_' + index + '_type_unknown')
    }
    if (step.loop) errors.push('step_' + index + '_loops_not_allowed_in_v1')
  }
  return { ok: errors.length === 0, errors }
}

const RECIPES = Object.freeze([
  /** 1) 安静休息：不需要向主人开口；数值恢复由既有 NeedsSystem 规则承担。 */
  {
    recipeId: 'quiet_rest',
    version: 1,
    label: '安静休息',
    world: 'virtual',
    originKinds: ['need'],
    requiredCapabilities: ['virtual.rest_local'],
    maxSteps: 3,
    steps: [
      { id: 'rest', type: 'capability', capabilityId: 'virtual.rest_local', waitForReceipt: true, timeoutMs: 10 * 60 * 1000 },
      { id: 'check', type: 'condition', condition: 'needs_at_least', args: { name: 'energy', value: 40 } },
    ],
    successCondition: { requireReceipt: true, intent: 'internal' },
    recoveryPolicy: { onFailure: 'pause', onUnknown: 'wait_for_reconcile', maxAttempts: 2 },
    nextCheckMs: 3600000,
    evidenceRequired: false,
  },
  /** 2) 带来源的虚拟笔记：必须有来源，不产生“现实已完成”的事实。 */
  {
    recipeId: 'virtual_note',
    version: 1,
    label: '给自己记一条带来源的笔记',
    world: 'virtual',
    originKinds: ['world_change', 'interest', 'project_step'],
    requiredCapabilities: ['virtual.note'],
    maxSteps: 3,
    steps: [
      { id: 'check_source', type: 'condition', condition: 'observation_fresh', args: {} },
      { id: 'write', type: 'capability', capabilityId: 'virtual.note', waitForReceipt: true, timeoutMs: 30000 },
      { id: 'verify', type: 'condition', condition: 'artifact_exists', args: {} },
    ],
    successCondition: { requireReceipt: true, intent: 'virtual', minArtifacts: 1 },
    recoveryPolicy: { onFailure: 'retry_once', onUnknown: 'wait_for_reconcile', maxAttempts: 2 },
    nextCheckMs: 0,
    evidenceRequired: true,
  },
  /** 3) 到期关注回访：这是唯一会主动向主人开口的 recipe，必须重新过打扰门。 */
  {
    recipeId: 'concern_revisit',
    version: 1,
    label: '回到之前记挂的事',
    world: 'user_report',
    originKinds: ['concern_due', 'owner_reminder'],
    requiredCapabilities: ['presentation.text'],
    maxSteps: 3,
    steps: [
      { id: 'recheck', type: 'condition', condition: 'concern_status', args: { status: ['open', 'deferred'] } },
      { id: 'speak', type: 'capability', capabilityId: 'presentation.text', waitForReceipt: true, timeoutMs: 60000 },
    ],
    successCondition: { requireReceipt: true, intent: 'presentation' },
    recoveryPolicy: { onFailure: 'pause', onUnknown: 'pause', maxAttempts: 1 },
    nextCheckMs: 6 * 3600000,
    evidenceRequired: true,
    mayContactOwner: true,
  },
  {
    recipeId: 'social_contact', version: 1, label: '自然闲聊', world: 'system', originKinds: ['social_contact'],
    requiredCapabilities: ['presentation.text'], maxSteps: 1,
    steps: [{ id: 'speak', type: 'capability', capabilityId: 'presentation.text', waitForReceipt: true, timeoutMs: 60000 }],
    successCondition: { requireReceipt: true, intent: 'presentation' }, recoveryPolicy: { onFailure: 'pause', maxAttempts: 1 },
    nextCheckMs: 4 * 3600000, evidenceRequired: false, mayContactOwner: true,
  },
])

function listRecipes () {
  return RECIPES.map(recipe => ({ ...recipe, steps: recipe.steps.map(step => ({ ...step })) }))
}

function getRecipe (recipeId, version) {
  const recipe = RECIPES.find(item => item.recipeId === recipeId && (version === undefined || item.version === version))
  if (!recipe) return null
  return { ...recipe, steps: recipe.steps.map(step => ({ ...step })) }
}

/** 按候选种类找可用 recipe（候选只描述目标，recipe 决定怎么执行）。 */
function recipesForKind (kind) {
  return RECIPES.filter(recipe => recipe.originKinds.includes(kind)).map(recipe => recipe.recipeId)
}

/**
 * 模型提出的短计划必须落在已有 recipe 的步骤集合内；不允许新增能力、不允许改证据。
 * @returns {{ok: boolean, reason?: string, steps?: object[]}}
 */
function validateProposedPlan (proposal, options = {}) {
  if (!proposal || typeof proposal !== 'object') return { ok: false, reason: 'plan_not_object' }
  const recipe = getRecipe(proposal.recipeId, proposal.recipeVersion)
  if (!recipe) return { ok: false, reason: 'recipe_unknown' }
  if (proposal.wait === true) return { ok: true, steps: [], wait: true }
  const steps = Array.isArray(proposal.steps) ? proposal.steps : []
  if (!steps.length) return { ok: false, reason: 'plan_empty' }
  const limit = options.autonomous === false ? MAX_STEPS_MANUAL : Math.min(MAX_STEPS_AUTONOMOUS, recipe.maxSteps)
  if (steps.length > limit) return { ok: false, reason: 'plan_too_long', limit }
  const allowed = new Set(recipe.steps.map(step => step.id))
  for (const step of steps) {
    if (!step || typeof step !== 'object') return { ok: false, reason: 'plan_step_not_object' }
    if (!allowed.has(step.stepId)) return { ok: false, reason: 'plan_step_not_in_recipe', stepId: step.stepId }
    const definition = recipe.steps.find(item => item.id === step.stepId)
    if (definition.type === 'capability' && step.capabilityId && step.capabilityId !== definition.capabilityId) {
      return { ok: false, reason: 'plan_step_capability_mismatch', stepId: step.stepId }
    }
  }
  return { ok: true, recipe, steps: steps.map(step => ({ stepId: step.stepId })) }
}

module.exports = {
  MAX_STEPS_MANUAL,
  MAX_STEPS_AUTONOMOUS,
  CONDITION_TYPES,
  RECIPES,
  listRecipes,
  getRecipe,
  recipesForKind,
  validateRecipe,
  validateProposedPlan,
}
