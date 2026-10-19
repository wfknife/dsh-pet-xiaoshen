'use strict'
/**
 * K3 检索器（第一版：结构化过滤 + 关键词/全文 + 现有中文规则）。
 *
 * 顺序不可调换（总规 §13.3）：先做作用域 / 遗忘 / 有效期 / 状态过滤，
 * 再算相关度。不得只按相似度取结果。
 *
 * 结果必须附 whyRetrieved / evidenceRefs / asOf，使“为什么想起这件事”可审查。
 * 检索命中（access）不是用户反馈，不能据此无限增加记忆强度。
 */

const { keywordList, normalizedKey } = require('../ids.cjs')
const { recallableLifecycles } = require('./lifecycle.cjs')

/** 权重是版本化初始参数，不是测出来的最优值。 */
const WEIGHTS = Object.freeze({
  keyword: 0.45,
  recency: 0.2,
  confidence: 0.15,
  concernLink: 0.1,
  trust: 0.1,
  repetition: 0.15,
})

const TRUST_SCORE = Object.freeze({ owner_statement: 1, sensor: 0.8, receipt: 0.9, interpretation: 0.45 })

function recencyScore (ageMs, horizonMs) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1
  return Math.max(0, 1 - ageMs / horizonMs)
}

function overlapScore (queryKeywords, text) {
  if (!queryKeywords.length) return 0
  const haystack = normalizedKey(text)
  if (!haystack) return 0
  let hits = 0
  for (const keyword of queryKeywords) if (haystack.includes(normalizedKey(keyword))) hits++
  return hits / queryKeywords.length
}

function textOfAssertion (assertion) {
  const value = typeof assertion.value === 'string' ? assertion.value : JSON.stringify(assertion.value)
  return assertion.subject + ' ' + assertion.predicate + ' ' + value
}

/**
 * @param {{config: object, now?: Function}} deps
 */
function createRetriever (deps) {
  const config = deps.config
  const clock = typeof deps.now === 'function' ? deps.now : Date.now

  /**
   * @param {object} gw 事务内网关
   * @param {{characterId: string, query?: string, purpose?: string, asOf?: number,
   *          deleted: Set<string>, concernTopics?: string[], recentMentioned?: Set<string>,
   *          explicitRecall?: boolean}} input
   */
  function retrieve (gw, input) {
    const asOf = Number(input.asOf) || clock()
    const deleted = input.deleted instanceof Set ? input.deleted : new Set(input.deleted || [])
    const explicit = !!input.explicitRecall
    const purpose = input.purpose || 'decision'
    const budget = purpose === 'expression'
      ? config.retrieval.expressionCandidates
      : (explicit ? config.retrieval.explicitRecallCandidates : config.retrieval.decisionCandidates)
    const queryKeywords = keywordList(input.query || '', 16)
    const concernTopics = new Set((input.concernTopics || []).map(topic => String(topic).toLowerCase() || ''))
    const recentlyMentioned = input.recentMentioned instanceof Set ? input.recentMentioned : new Set()

    const excluded = []
    const candidates = []

    /* ---- 1) 结构化过滤 ---- */
    const rows = gw.listAssertions(input.characterId, {
      status: 'current',
      lifecycleIn: recallableLifecycles(explicit),
      asOf,
      limit: 400,
    })

    for (const assertion of rows) {
      const sourceRefs = (assertion.sourceRefs || []).filter(ref => !deleted.has(ref) && gw.getSource(ref)?.permission === 'granted')
      if ((assertion.sourceRefs || []).length && !sourceRefs.length) { excluded.push({ id: assertion.assertionId, reason: 'no_valid_source' }); continue }
      if (assertion.memoryLifecycle === 'forgotten') {
        excluded.push({ kind: 'assertion', id: assertion.assertionId, reason: 'forgotten' })
        continue
      }
      const revoked = (assertion.sourceRefs || []).filter(ref => !sourceRefs.includes(ref))
      if (revoked.length) {
        if (revoked.length === sourceRefs.length) {
          excluded.push({ kind: 'assertion', id: assertion.assertionId, reason: 'all_sources_forgotten' })
          continue
        }
        excluded.push({ kind: 'assertion', id: assertion.assertionId, reason: 'partial_sources_forgotten', revoked })
        // 部分来源被撤销：保留，但降权（剩余证据可信度重算在 lifecycle 完成）
      }
      if (assertion.validTo !== null && assertion.validTo !== undefined && assertion.validTo <= asOf) {
        excluded.push({ kind: 'assertion', id: assertion.assertionId, reason: 'outside_valid_time' })
        continue
      }
      if (assertion.memoryLifecycle === 'archived' && !explicit) {
        excluded.push({ kind: 'assertion', id: assertion.assertionId, reason: 'cold_archive_not_in_hot_index' })
        continue
      }

      /* ---- 2) 相关度 ---- */
      const text = textOfAssertion(assertion)
      const keyword = overlapScore(queryKeywords, text)
      const age = asOf - (Number(assertion.validFrom) || asOf)
      const recency = recencyScore(age, 30 * 86400000)
      const concernLink = concernTopics.has(String(assertion.predicate).toLowerCase()) || concernTopics.has(String(assertion.subject).toLowerCase()) ? 1 : 0
      const repetition = recentlyMentioned.has(assertion.assertionId) ? 1 : 0
      const lifecyclePenalty = assertion.memoryLifecycle === 'fading' ? 0.5 : 0
      const rawScore = WEIGHTS.keyword * keyword +
        WEIGHTS.recency * recency +
        WEIGHTS.confidence * (Number(assertion.confidence) || 0) +
        WEIGHTS.concernLink * concernLink +
        WEIGHTS.trust * (TRUST_SCORE[assertion.trust] || 0.3) -
        WEIGHTS.repetition * repetition -
        lifecyclePenalty * 0.1

      if (keyword === 0 && purpose === 'decision' && !concernLink) {
        excluded.push({ kind: 'assertion', id: assertion.assertionId, reason: 'no_query_overlap' })
        continue
      }

      candidates.push({
        kind: 'assertion',
        id: assertion.assertionId,
        subject: assertion.subject,
        predicate: assertion.predicate,
        value: assertion.value,
        world: assertion.world,
        trust: assertion.trust,
        confidence: assertion.confidence,
        confidenceClass: assertion.confidenceClass,
        lifecycle: assertion.memoryLifecycle,
        validFrom: assertion.validFrom,
        validTo: assertion.validTo,
        sourceRefs,
        quote: sourceRefs.length === (assertion.sourceRefs || []).length && assertion.quoteSpan ? assertion.quoteSpan.text : null,
        score: Number(rawScore.toFixed(4)),
        whyRetrieved: {
          keyword, recency, concernLink, repetition,
          excludedSources: revoked,
          explanation: buildExplanation({ keyword, recency, concernLink, repetition, revoked }),
        },
        asOf,
      })
    }

    candidates.sort((a, b) => b.score - a.score)
    const chosen = candidates.slice(0, budget)
    const dropped = candidates.slice(budget).map(row => ({ kind: row.kind, id: row.id, reason: 'over_budget', score: row.score }))

    return {
      candidates: chosen,
      excluded: excluded.concat(dropped),
      budget,
      purpose,
      asOf,
      weights: WEIGHTS,
      totalBeforeBudget: candidates.length,
    }
  }

  function buildExplanation (parts) {
    const notes = []
    if (parts.keyword > 0) notes.push('keyword_overlap')
    if (parts.recency > 0.5) notes.push('recent')
    if (parts.concernLink > 0) notes.push('matches_open_concern')
    if (parts.repetition > 0) notes.push('recently_mentioned_dampened')
    if (parts.revoked && parts.revoked.length) notes.push('partial_sources_revoked')
    return notes
  }

  /** 经历检索：日记/上下文投影用，不参与“主动提起”决策。 */
  function retrieveEpisodes (gw, input) {
    const deleted = input.deleted instanceof Set ? input.deleted : new Set(input.deleted || [])
    const limit = Math.min(Number(input.limit) || 5, 20)
    const asOf = input.asOf || clock()
    return gw.listEpisodes(input.characterId, limit * 4)
      .filter(episode => episode.status === 'active')
      .filter(episode => !(episode.sourceRefs || []).some(ref => deleted.has(ref)))
      .slice(0, limit)
      .map(episode => ({ ...episode, asOf }))
  }

  return { retrieve, retrieveEpisodes, WEIGHTS }
}

module.exports = { createRetriever, WEIGHTS, overlapScore }
