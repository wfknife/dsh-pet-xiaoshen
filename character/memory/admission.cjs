'use strict'
/**
 * K3 记忆准入：把“模型提出的候选事实”变成“有来源的记录”。
 *
 * 关键边界（总规 §13.1 / §13.2）：
 *  - 抽取只是提案；程序验证 quoteSpan 能在原文定位、主体合法、来源未撤销、字段受限。
 *  - 通过验证只能证明“此主人这样说过”，不能证明世界事实客观正确 → 保留 user_report 归属。
 *  - assistant 回复、工具返回、网站文本都不能成为关于主人的事实来源。
 *  - 明确纠正按 主体+属性+作用域 定位旧断言并记录 supersedes；歧义保留冲突，不覆盖无关事实。
 *  - 同一属性可有合法时间区间：有效时间与提交时间分开，后到的旧经历不覆盖新状态。
 */

const { deterministicId, hash } = require('../ids.cjs')

const LIMITS = Object.freeze({
  subject: 120,
  predicate: 120,
  quote: 500,
  valueBytes: 2048,
  refs: 20,
  confidence: 1,
})

const ALLOWED_WORLDS = new Set(['user_report', 'desktop_observed', 'virtual', 'system'])
const ALLOWED_CONFIDENCE = new Set(['stated', 'reported', 'inferred', 'legacy_unverified'])

const isPlain = value => !!value && typeof value === 'object' && !Array.isArray(value)
const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** 主体必须是受限标识符，不允许任意长自然语言当键。 */
function validSubject (subject) {
  return typeof subject === 'string' && subject.length > 0 && subject.length <= LIMITS.subject && !/[\u0000-\u001f]/.test(subject)
}
function validPredicate (predicate) {
  return typeof predicate === 'string' && predicate.length > 0 && predicate.length <= LIMITS.predicate && !/[\u0000-\u001f]/.test(predicate)
}

/**
 * quoteSpan 定位。接受两种形式：
 *  - { text }：必须是原文的子串（去空白不可靠，因此按原字符串比较）；
 *  - { start, end }：必须落在原文范围内且非空。
 * 定位失败 = 该候选不可准入（不是“降低置信度”）。
 */
function locateQuote (quoteSpan, sourceText) {
  const text = typeof sourceText === 'string' ? sourceText : ''
  if (!isPlain(quoteSpan)) return { ok: false, reason: 'quote_missing' }
  if (typeof quoteSpan.text === 'string' && quoteSpan.text.trim()) {
    const needle = quoteSpan.text.slice(0, LIMITS.quote)
    const index = text.indexOf(needle)
    if (index < 0) return { ok: false, reason: 'quote_not_in_source' }
    return { ok: true, start: index, end: index + needle.length, text: needle }
  }
  const start = Number(quoteSpan.start)
  const end = Number(quoteSpan.end)
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= text.length) {
    return { ok: true, start, end, text: text.slice(start, end) }
  }
  return { ok: false, reason: 'quote_span_invalid' }
}

/**
 * 纯校验：不写任何状态。返回规范化候选或拒绝原因。
 * @param {object} candidate 模型给出的候选
 * @param {{sourceText: string, sourceWorld: string, sourceTrust: string, now: number}} context
 */
function validateCandidate (candidate, context) {
  if (!isPlain(candidate)) return { ok: false, reason: 'candidate_not_object' }
  if (!validSubject(candidate.subject)) return { ok: false, reason: 'candidate_subject_invalid' }
  if (!validPredicate(candidate.predicate)) return { ok: false, reason: 'candidate_predicate_invalid' }
  const value = candidate.value !== undefined ? candidate.value : candidate.valueKey
  if (value === undefined || value === null) return { ok: false, reason: 'candidate_value_missing' }
  const valueBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (valueBytes > LIMITS.valueBytes) return { ok: false, reason: 'candidate_value_too_large' }

  const world = ALLOWED_WORLDS.has(candidate.world) ? candidate.world : null
  if (!world) return { ok: false, reason: 'candidate_world_invalid' }

  const located = locateQuote(candidate.quoteSpan, context && context.sourceText)
  if (!located.ok) return { ok: false, reason: located.reason }

  const confidenceClass = ALLOWED_CONFIDENCE.has(candidate.confidenceClass) ? candidate.confidenceClass : 'stated'
  const validTime = isPlain(candidate.validTime) ? {
    from: Number.isFinite(Number(candidate.validTime.from)) ? Number(candidate.validTime.from) : null,
    to: Number.isFinite(Number(candidate.validTime.to)) ? Number(candidate.validTime.to) : null,
  } : null
  const correctionTarget = typeof candidate.correctionTarget === 'string' && candidate.correctionTarget.length <= 200
    ? candidate.correctionTarget
    : null

  return {
    ok: true,
    candidate: {
      subject: clean(candidate.subject, LIMITS.subject),
      predicate: clean(candidate.predicate, LIMITS.predicate).toLowerCase(),
      value,
      world,
      confidenceClass,
      confidence: Number.isFinite(Number(candidate.confidence)) ? Math.min(1, Math.max(0, Number(candidate.confidence))) : 0.75,
      quoteSpan: located,
      validTime,
      correctionTarget,
      scope: clean(candidate.scope, 40) || 'owner',
    },
  }
}

/**
 * 在事务内落库。规则：
 *  - 同 (subject, predicate, scope) 已存在 current 断言且值不同 → 新的取代旧的（supersedes），
 *    旧断言转 superseded，仍可历史回忆；
 *  - 有效时间区间不同的情况不互相覆盖：若新断言 validTo 早于旧断言 validFrom，
 *    则作为“历史区间”写入且不取代当前；
 *  - 同一提交内重复候选去重（derivedId 由 source+subject+predicate 决定）。
 *
 * @returns {{ok: boolean, reason?: string, assertionId?: string, superseded?: string[], historical?: boolean}}
 */
function applyCandidate (gw, input) {
  const { characterId, sourceId, seq, now } = input
  const candidate = input.candidate
  const assertionId = deterministicId('asr', sourceId + '|' + candidate.subject + '|' + candidate.predicate + '|' + hash(candidate.value))

  const existingById = gw.getAssertion(assertionId)
  if (existingById) return { ok: true, assertionId, superseded: [], dedupe: true }

  const current = gw.findCurrentAssertions(characterId, candidate.subject, candidate.predicate, candidate.scope)
  const superseded = []
  let historical = false

  for (const prior of current) {
    if (prior.assertionId === assertionId) continue
    const priorValueKey = JSON.stringify(prior.value)
    const nextValueKey = JSON.stringify(candidate.value)
    if (priorValueKey === nextValueKey) {
      // 值相同：合并证据，不制造新断言，避免“多为同一来源链”的重复强化。
      gw.addEvidence(prior.assertionId, sourceId, 'supports', seq)
      return { ok: true, assertionId: prior.assertionId, superseded: [], reinforced: true }
    }
    const priorFrom = prior.validFrom === null ? 0 : Number(prior.validFrom)
    const newTo = candidate.validTime && candidate.validTime.to !== null ? Number(candidate.validTime.to) : null
    const newFrom = Number(candidate.validTime?.from) || Number(gw.getSource(sourceId)?.occurredAt) || now
    if ((newTo !== null && priorFrom && newTo < priorFrom) || (priorFrom && newFrom < priorFrom)) {
      // 描述的是更早的时间段：保留为历史断言，不取代当前状态。
      historical = true
      continue
    }
    superseded.push(prior.assertionId)
  }

  gw.insertAssertion({
    assertionId,
    characterId,
    subject: candidate.subject,
    predicate: candidate.predicate,
    value: candidate.value,
    scope: candidate.scope,
    world: candidate.world,
    trust: candidate.world === 'user_report' ? 'owner_statement' : (candidate.world === 'desktop_observed' ? 'sensor' : 'interpretation'),
    validFrom: candidate.validTime ? candidate.validTime.from : now,
    validTo: candidate.validTime ? candidate.validTime.to : null,
    status: historical ? 'superseded' : 'current',
    supersededBy: null,
    confidence: candidate.confidence,
    confidenceClass: candidate.confidenceClass,
    memoryLifecycle: 'active',
    sourceRefs: [sourceId],
    quoteSpan: candidate.quoteSpan,
    createdSeq: seq,
    updatedSeq: seq,
  })
  gw.addEvidence(assertionId, sourceId, 'supports', seq)

  for (const priorId of superseded) {
    gw.supersedeAssertion(priorId, assertionId, seq)
    const prior = gw.getAssertion(priorId)
    if (prior) {
      gw.addEvidence(assertionId, priorId, 'supersedes', seq)
    }
  }
  return { ok: true, assertionId, superseded, historical }
}

/**
 * 创建“经历”记录（Episode）。这是发生过什么，不是对世界的陈述。
 */
function applyEpisode (gw, input) {
  const episodeId = deterministicId('ep', input.sourceId + '|' + input.kind + '|' + hash(input.title))
  const bodyRef = gw.putPayload(JSON.stringify(input.body || {}), 'episode')
  gw.insertEpisode({
    episodeId,
    characterId: input.characterId,
    world: input.world,
    title: String(input.title).slice(0, 160),
    bodyRef,
    status: 'active',
    occurredAt: input.occurredAt,
    createdSeq: input.seq,
    sourceRefs: input.sourceRefs || [input.sourceId],
  })
  for (const ref of input.sourceRefs || [input.sourceId]) gw.addEvidence(episodeId, ref, 'origin', input.seq)
  return { episodeId }
}

/**
 * 解释（Appraisal）：角色如何理解经历。允许不确定、允许被推翻，绝不冒充原始事实。
 */
function applyAppraisal (gw, input) {
  const appraisalId = deterministicId('apr', input.sourceId + '|' + hash(input.body || {}))
  const bodyRef = gw.putPayload(JSON.stringify(input.body || {}), 'episode')
  gw.insertAppraisal({
    appraisalId,
    characterId: input.characterId,
    episodeId: input.episodeId || null,
    bodyRef,
    status: 'active',
    confidenceClass: input.confidenceClass || 'interpretation',
    createdSeq: input.seq,
    sourceRefs: input.sourceRefs || [input.sourceId],
    evidence: input.evidence || {},
  })
  for (const ref of input.sourceRefs || [input.sourceId]) gw.addEvidence(appraisalId, ref, 'supports', input.seq)
  return { appraisalId }
}

module.exports = {
  LIMITS,
  ALLOWED_WORLDS,
  ALLOWED_CONFIDENCE,
  locateQuote,
  validateCandidate,
  applyCandidate,
  applyEpisode,
  applyAppraisal,
}
