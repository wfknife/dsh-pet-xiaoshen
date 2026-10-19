'use strict'
/**
 * K4 机会候选：把“自身状态 + 未完成事项 + 世界变化 + 兴趣证据”变成可解释候选。
 *
 * 迁移决定（总规 §14.1）：旧的 candidate/topic、PetLife.proposeActivity 与平台
 * select 全部合并到这一个入口。感知、提醒、life-context 只能提交事实或机会，
 * 不得另开模型、另开气泡。
 *
 * 候选只描述“可以做什么”，不做授权判断，也不调用模型。
 */

const { OPPORTUNITY_KINDS } = require('../contracts.cjs')
const { deterministicId } = require('../ids.cjs')

const NEED_THRESHOLDS = Object.freeze({
  // 数值沿用现有养成区间（0..100），阈值是本版初始参数。
  energyLow: 35,
  satietyLow: 30,
  thirstLow: 30,
  moodLow: 35,
})

/**
 * @param {{config: object, now?: Function}} deps
 */
function createCandidateBuilder (deps) {
  const config = deps.config
  const clock = typeof deps.now === 'function' ? deps.now : Date.now

  /**
   * @param {object} gw 事务内网关
   * @param {{characterId: string, now?: number, deleted?: Set<string>, observations?: object[]}} input
   * @returns {Array<object>} opportunities
   */
  function build (gw, input) {
    const now = Number(input.now) || clock()
    const deleted = input.deleted instanceof Set ? input.deleted : new Set(input.deleted || [])
    const state = gw.getState(input.characterId)
    const body = state ? state.body || {} : {}
    const opportunities = []
    const suppressed = []

    const push = opportunity => {
      const servedAt = Number(gw.getMeta('served:' + opportunity.opportunityId)) || 0
      if (servedAt > 0 && ['world_change', 'interest', 'social_contact'].includes(opportunity.kind)) return
      if (opportunities.some(existing => existing.kind === opportunity.kind && existing.goal === opportunity.goal && existing.concernId === opportunity.concernId && existing.projectId === opportunity.projectId)) return
      opportunities.push(opportunity)
    }

    /* ---- 1) 需求越过阈值 → 安静休息（不需要主人同意，也不打扰主人） ---- */
    const needs = body.needs || {}
    const needReasons = []
    if (Number(needs.energy) <= NEED_THRESHOLDS.energyLow) needReasons.push('energy')
    if (Number(needs.satiety) <= NEED_THRESHOLDS.satietyLow) needReasons.push('satiety')
    if (Number(needs.thirst) <= NEED_THRESHOLDS.thirstLow) needReasons.push('thirst')
    if (Number(needs.mood) <= NEED_THRESHOLDS.moodLow) needReasons.push('mood')
    if (needReasons.length) {
      push({
        opportunityId: deterministicId('opp', input.characterId + '|need|' + needReasons.sort().join(',') + '|' + Math.floor(now / 3600000)),
        kind: 'need',
        origin: 'self_state',
        evidenceRefs: [],
        concernId: null,
        projectId: null,
        goal: '安静休息一会儿',
        candidateCapabilities: ['virtual.rest_local'],
        expiresAt: now + 2 * 3600000,
        expectedBenefit: Math.min(1, needReasons.length * 0.35 + 0.2),
        costEstimate: 0.05,
        interruptionCost: 0,
        preconditions: [{ type: 'needs_below', names: needReasons }],
        world: 'virtual',
        mayContactOwner: false,
        reasons: needReasons,
      })
    }

    /* ---- 2) 到期关注 → 回访 ---- */
    const dueConcerns = gw.listConcerns(input.characterId, { statusIn: ['open', 'deferred'], dueBefore: now, limit: 20 })
    for (const concern of dueConcerns) {
      const refs = concern.sourceRefs || []
      if (refs.some(ref => deleted.has(ref))) { suppressed.push({ concernId: concern.concernId, reason: 'source_forgotten' }); continue }
      push({
        opportunityId: deterministicId('opp', input.characterId + '|concern|' + concern.concernId + '|' + (concern.nextCheckAt || 0)),
        kind: 'concern_due',
        origin: concern.origin || 'self',
        evidenceRefs: refs,
        concernId: concern.concernId,
        projectId: null,
        goal: String(concern.subject || '回到之前记挂的事'),
        candidateCapabilities: concern.origin === 'owner'
          ? ['presentation.text', 'virtual.note']
          : ['presentation.text'],
        expiresAt: concern.expiresAt || now + 86400000,
        expectedBenefit: Math.min(1, 0.4 + Number(concern.priority || 0.5) * 0.5),
        costEstimate: 0.2,
        interruptionCost: concern.origin === 'owner' ? 0.2 : 0.6,
        preconditions: [{ type: 'concern_open', concernId: concern.concernId }],
        world: 'user_report',
        mayContactOwner: true,
        reasons: ['concern_due'],
      })
    }

    /* ---- 3) 未完成项目 → 下一步 ---- */
    for (const project of gw.listProjects(input.characterId, { statusIn: ['active', 'proposed'], limit: 5 })) {
      const refs = project.sourceRefs || []
      if (refs.some(ref => deleted.has(ref))) { suppressed.push({ projectId: project.projectId, reason: 'source_forgotten' }); continue }
      push({
        opportunityId: deterministicId('opp', input.characterId + '|project|' + project.projectId + '|' + project.stepCursor),
        kind: 'project_step',
        origin: project.origin || 'self',
        evidenceRefs: refs,
        concernId: null,
        projectId: project.projectId,
        goal: String(project.goal || '继续手上的事'),
        candidateCapabilities: ['virtual.note', 'virtual.rest_local'],
        expiresAt: project.deadline || now + 86400000,
        expectedBenefit: 0.7,
        costEstimate: 0.25,
        interruptionCost: 0.1,
        preconditions: [{ type: 'project_active', projectId: project.projectId, stepCursor: project.stepCursor }],
        world: 'virtual',
        mayContactOwner: false,
        reasons: ['project_unfinished'],
      })
    }

    /* ---- 4) 有效世界变化（新鲜观测） ---- */
    for (const observation of input.observations || []) {
      if (!observation || observation.freshUntil <= now) continue
      if (observation.sourceId && deleted.has(observation.sourceId)) { suppressed.push({ observationId: observation.observationId, reason: 'source_forgotten' }); continue }
      push({
        opportunityId: deterministicId('opp', input.characterId + '|world|' + observation.observationId),
        kind: 'world_change',
        origin: 'observation',
        evidenceRefs: observation.sourceId ? [observation.sourceId] : [],
        concernId: null,
        projectId: null,
        goal: '为刚才观察到的变化留一条带来源的笔记',
        candidateCapabilities: ['virtual.note'],
        expiresAt: observation.freshUntil,
        expectedBenefit: 0.5,
        costEstimate: 0.1,
        interruptionCost: 0.4,
        preconditions: [{ type: 'observation_fresh', observationId: observation.observationId }],
        world: 'desktop_observed',
        mayContactOwner: false,
        reasons: ['fresh_observation'],
      })
    }

    /* ---- 5) 有证据的兴趣方向 ---- */
    const interests = body.interests || {}
    for (const [topicKey, interest] of Object.entries(interests)) {
      if (!interest || typeof interest !== 'object') continue
      const refs = Array.isArray(interest.sourceRefs) ? interest.sourceRefs : []
      if (refs.length < config.growth.minIndependentSources) continue
      if (refs.some(ref => deleted.has(ref))) { suppressed.push({ topicKey, reason: 'source_forgotten' }); continue }
      push({
        opportunityId: deterministicId('opp', input.characterId + '|interest|' + topicKey),
        kind: 'interest',
        origin: 'self_interest',
        evidenceRefs: refs,
        concernId: null,
        projectId: null,
        goal: '顺着自己记挂的方向继续了解一点',
        candidateCapabilities: ['virtual.note'],
        expiresAt: now + 86400000,
        expectedBenefit: Number(interest.value) || 0.5,
        costEstimate: 0.2,
        interruptionCost: 0.5,
        preconditions: [{ type: 'interest_value', topicKey, value: Number(interest.value) || 0 }],
        world: 'virtual',
        mayContactOwner: false,
        reasons: ['interest_with_sources'],
      })
    }

    const interaction = body.attentionPolicy?.conversation || {}
    const lastContactAt = Number(body.attentionPolicy?.lastContactAt) || 0
    if (interaction.lastOwnerAt > 0 && now - interaction.lastOwnerAt >= 4 * 3600000 && lastContactAt < interaction.lastOwnerAt) {
      // An opportunity comes from the relationship/attention policy. A fresh
      // event may supply a topic, but neither creates nor forces that opportunity.
      const topic = (input.observations || []).find(row => row.freshUntil > now && row.sourceId && !deleted.has(row.sourceId) && !gw.getMeta('contact-topic:' + row.sourceId))
      push({ opportunityId: deterministicId('opp', input.characterId + '|reconnect|' + interaction.lastOwnerAt),
        kind: 'social_contact', origin: 'relationship', goal: '有真实互动基础的轻松闲聊，也可选择等待；不声称发生了新事件',
        evidenceRefs: topic ? [topic.sourceId] : [], concernId: null, projectId: null, candidateCapabilities: ['presentation.text'],
        expiresAt: now + 3600000, expectedBenefit: 0.45, costEstimate: 0.2, interruptionCost: 0.5,
        world: 'system', mayContactOwner: true, reasons: ['relationship_reconnect'],
        focus: topic ? { sourceId: topic.sourceId, kind: topic.kind, payload: topic.payload, optional: true } : null, lastOwnerAt: interaction.lastOwnerAt })
    }
    return {
      opportunities: opportunities.filter(item => OPPORTUNITY_KINDS.includes(item.kind)),
      suppressed,
      evaluatedAt: now,
      needs: { ...needs },
    }
  }

  return { build, NEED_THRESHOLDS }
}

module.exports = { createCandidateBuilder, NEED_THRESHOLDS }
