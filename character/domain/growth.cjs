'use strict'
/**
 * K7 受限成长：兴趣 / 关系解释 / Skill 改进。
 *
 * 规则（总规 §16）：
 *  - 反思只产出 ReflectionProposal（待整合变更），不是已经发生的真理；
 *  - 兴趣更新至少来自 3 个独立事件且跨 2 天；每日绝对变化 ≤0.05；
 *  - 关系的公式不在本文件改动，只记录反馈事件与解释版本；
 *  - 用户明确“不要”立即约束行为，不等待累计；
 *  - 成功故事不能自动获得权限；Skill 改进只生成候选 revision。
 *
 * 每次变更都写 growth_events：旧值、新值、规则版本、上限、来源、可撤销方式。
 */

const { deterministicId } = require('../ids.cjs')
const { clamp } = require('./reducer.cjs')

const RULE_VERSION = 1

/** 独立来源判定：同一 messageRef / 同一事件链只算一份证据。 */
function independentSources (refs) {
  const seen = new Map()
  for (const ref of refs || []) {
    const key = String(ref).replace(/^(conversation:|reply:|event:|mem:)/, '')
    if (!key) continue
    if (!seen.has(key)) seen.set(key, String(ref))
  }
  return Array.from(seen.values())
}

function spanDays (timestamps) {
  const values = (timestamps || []).filter(ts => Number.isFinite(Number(ts)) && Number(ts) > 0).sort((a, b) => a - b)
  if (values.length < 2) return 0
  return (values[values.length - 1] - values[0]) / 86400000
}

/**
 * 反思提案：内核把新经历与结果交给模型，模型只输出提案；这里校验结构。
 */
function validateReflectionProposal (proposal, config) {
  if (!proposal || typeof proposal !== 'object') return { ok: false, reason: 'proposal_not_object' }
  const kind = String(proposal.kind || '')
  if (!['interest', 'relationship_note', 'skill_revision', 'none'].includes(kind)) return { ok: false, reason: 'proposal_kind_unknown' }
  if (kind === 'none') return { ok: true, value: { kind, note: String(proposal.note || '').slice(0, 400) } }
  const sourceRefs = independentSources(proposal.sourceRefs)
  if (sourceRefs.length < config.growth.minReflectionSources) {
    return { ok: false, reason: 'insufficient_independent_sources', have: sourceRefs.length, need: config.growth.minReflectionSources }
  }
  if (kind === 'interest') {
    const topicKey = String(proposal.topicKey || '').slice(0, 120)
    if (!topicKey) return { ok: false, reason: 'topic_key_missing' }
    const delta = Number(proposal.delta)
    if (!Number.isFinite(delta) || delta === 0) return { ok: false, reason: 'delta_invalid' }
    if (Math.abs(delta) > config.growth.dailyInterestDelta) return { ok: false, reason: 'delta_exceeds_daily_cap', delta }
    return { ok: true, value: { kind, topicKey, delta, sourceRefs, note: String(proposal.note || '').slice(0, 400) } }
  }
  if (kind === 'relationship_note') {
    return { ok: true, value: { kind, note: String(proposal.note || '').slice(0, 400), sourceRefs } }
  }
  return { ok: true, value: { kind, skillId: String(proposal.skillId || '').slice(0, 120), sourceRefs, note: String(proposal.note || '').slice(0, 400) } }
}

/**
 * 生成待整合的反思记录（不直接改状态）。
 */
function proposeReflection (gw, input) {
  const episodes = gw.listEpisodes(input.characterId, 12)
  if (episodes.length < input.config.growth.minReflectionSources) {
    return { proposed: false, reason: 'insufficient_episodes', episodes: episodes.length }
  }
  const sourceRefs = independentSources(episodes.flatMap(episode => episode.sourceRefs || []))
  const reflectionId = deterministicId('reflect', episodes.map(episode => episode.episodeId).join('|'))
  gw.putReflection({
    reflectionId, characterId: input.characterId, status: 'pending',
    body: { episodeIds: episodes.map(episode => episode.episodeId), proposedAt: input.now },
    sourceRefs, createdSeq: input.seq,
  })
  return { proposed: true, reflectionId, episodeCount: episodes.length, sourceCount: sourceRefs.length }
}

/**
 * 提交兴趣变更：检查独立来源数、跨天数与日上限，然后写状态 + 变更账本。
 * @returns {{ok: boolean, reason?: string, interest?: object, growthId?: string}}
 */
function applyInterestUpdate (gw, input) {
  const config = input.config
  const now = input.now
  const sources = independentSources(input.sourceRefs).map(ref => gw.getSource(ref)).filter(source => source && source.characterId === input.characterId && source.permission === 'granted')
  const sourceRefs = sources.map(source => source.sourceId)
  if (sourceRefs.length < config.growth.minIndependentSources) {
    return { ok: false, reason: 'insufficient_independent_sources', have: sourceRefs.length, need: config.growth.minIndependentSources }
  }
  const sourceTimestamps = sources.map(source => source.occurredAt)
  if (spanDays(sourceTimestamps) < config.growth.minSpanDays) {
    return { ok: false, reason: 'not_enough_time_span', spanDays: spanDays(sourceTimestamps) }
  }
  const state = gw.getState(input.characterId)
  if (!state) return { ok: false, reason: 'state_missing' }
  const body = { ...state.body, interests: { ...(state.body.interests || {}) } }
  const current = body.interests[input.topicKey] || { value: 0.5, sourceRefs: [], updatedAt: null, dayKey: null }
  const dayKey = new Date(now).toISOString().slice(0, 10)
  // 同一自然日内绝对值累计不得超过 dailyInterestDelta
  const alreadyToday = current.dayKey === dayKey ? Number(current.dayDelta || 0) : 0
  const spentToday = current.dayKey === dayKey ? Math.max(Math.abs(alreadyToday), Number(current.daySpent) || 0) : 0
  const allowedDelta = config.growth.dailyInterestDelta - spentToday
  if (allowedDelta <= 0) return { ok: false, reason: 'daily_cap_reached', alreadyToday }
  const delta = clamp(Number(input.delta) || 0, -allowedDelta, allowedDelta)
  const nextValue = clamp(Number(current.value) + delta, 0, 1)
  const growthId = deterministicId('growth', input.topicKey + '|' + now + '|' + delta)
  body.interests[input.topicKey] = {
    value: nextValue,
    sourceRefs: Array.from(new Set([...(current.sourceRefs || []), ...sourceRefs])).slice(0, 20),
    updatedAt: now,
    dayKey,
    dayDelta: alreadyToday + delta,
    daySpent: spentToday + Math.abs(delta),
    ruleVersion: RULE_VERSION,
  }
  gw.writeState({
    characterId: input.characterId,
    revision: state.revision + 1,
    identityRevision: state.identityRevision,
    schemaVersion: state.schemaVersion,
    body,
    seq: gw.lastSeq(input.characterId).seq,
  })
  gw.putGrowthEvent({
    growthId, characterId: input.characterId, targetKind: 'interest', targetKey: input.topicKey,
    oldValue: { value: current.value, dayDelta: current.dayDelta || 0 },
    newValue: { value: nextValue, dayDelta: alreadyToday + delta },
    ruleVersion: RULE_VERSION,
    ruleLimit: { dailyCap: config.growth.dailyInterestDelta, minSources: config.growth.minIndependentSources, minSpanDays: config.growth.minSpanDays },
    sourceRefs, createdSeq: gw.lastSeq(input.characterId).seq,
  })
  return { ok: true, interest: body.interests[input.topicKey], growthId }
}

/**
 * 立即生效的约束：主人明确说“不要”时，不等待累计，直接压制相关候选。
 * 这里只标记兴趣方向暂停，不删除任何经历。
 */
function applyExplicitConstraint (gw, input) {
  const state = gw.getState(input.characterId)
  if (!state) return { ok: false, reason: 'state_missing' }
  const body = { ...state.body, interests: { ...(state.body.interests || {}) } }
  const topic = String(input.topicKey || '')
  if (!topic) return { ok: false, reason: 'topic_key_missing' }
  const current = body.interests[topic] || { value: 0.5, sourceRefs: [] }
  body.interests[topic] = { ...current, value: Math.min(Number(current.value) || 0.5, 0.1), suppressedAt: input.now, suppressedReason: String(input.reason || 'owner_request').slice(0, 200) }
  gw.writeState({
    characterId: input.characterId, revision: state.revision + 1,
    identityRevision: state.identityRevision, schemaVersion: state.schemaVersion,
    body, seq: gw.lastSeq(input.characterId).seq,
  })
  gw.putGrowthEvent({
    growthId: deterministicId('growth', 'constraint|' + topic + '|' + input.now),
    characterId: input.characterId, targetKind: 'interest', targetKey: topic,
    oldValue: { value: current.value }, newValue: { value: body.interests[topic].value, suppressed: true },
    ruleVersion: RULE_VERSION, ruleLimit: { immediate: true },
    sourceRefs: independentSources(input.sourceRefs), createdSeq: gw.lastSeq(input.characterId).seq,
  })
  return { ok: true, interest: body.interests[topic] }
}

module.exports = {
  RULE_VERSION,
  independentSources,
  spanDays,
  validateReflectionProposal,
  proposeReflection,
  applyInterestUpdate,
  applyExplicitConstraint,
}
