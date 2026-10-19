'use strict'
/**
 * K3/K6 ContextProjector：从**同一 revision** 装配任务上下文。
 *
 * 目的（总规 §9.2 / §13.3）：
 *  - 状态、关注、事实、能力必须来自同一快照，避免“用新事实配旧状态”；
 *  - 记忆只在这里进入模型，且返回 trace（哪些进了、哪些被排除、为什么）；
 *  - 字符预算向模型 token 预算适配：先按字符裁剪，调用方再按 token 复核；
 *  - 不拼原始事件日志，不暴露凭据、任意文件路径或全宿主 API。
 */

const { relationshipSnapshot } = require('../domain/reducer.cjs')

const DEFAULT_MAX_CHARS = 6000
const SECTION_ORDER = ['identity', 'state', 'concerns', 'projects', 'observations', 'memories', 'capabilities']

function truncate (text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : text.slice(0, max) + '…'
}

/**
 * @param {{config: object, retriever: object, now?: Function}} deps
 */
function createProjector (deps) {
  const config = deps.config
  const retriever = deps.retriever
  const clock = typeof deps.now === 'function' ? deps.now : Date.now

  /**
   * @param {object} gw 事务内网关
   * @param {{characterId: string, purpose?: string, query?: string, asOf?: number,
   *          deleted: Set<string>, explicitRecall?: boolean, capabilityCatalog?: object[],
   *          maxChars?: number, observations?: object[]}} input
   */
  function project (gw, input) {
    const asOf = Number(input.asOf) || clock()
    const deleted = input.deleted instanceof Set ? input.deleted : new Set(input.deleted || [])
    const character = gw.getCharacter(input.characterId)
    if (!character) return { ok: false, reason: 'character_missing' }
    const state = gw.getState(input.characterId)
    const identity = gw.latestIdentity(input.characterId)
    const seq = gw.lastSeq(input.characterId).seq

    const concerns = gw.listConcerns(input.characterId, { statusIn: ['open', 'deferred'], limit: 20 })
      .filter(concern => !(concern.sourceRefs || []).some(ref => deleted.has(ref)))
    const projects = gw.listProjects(input.characterId, { statusIn: ['proposed', 'active', 'paused'], limit: 10 })
      .filter(project => !(project.sourceRefs || []).some(ref => deleted.has(ref)))

    const memory = retriever.retrieve(gw, {
      characterId: input.characterId,
      query: input.query || '',
      purpose: input.purpose === 'expression' ? 'expression' : 'decision',
      asOf,
      deleted,
      explicitRecall: !!input.explicitRecall,
      concernTopics: concerns.map(concern => concern.topicKey),
    })

    const capabilities = (input.capabilityCatalog || []).map(capability => ({
      id: capability.id,
      version: capability.version,
      effect: capability.effect,
      scopes: capability.scopes,
      description: capability.description || '',
    }))

    const sections = {
      identity: buildIdentity(identity, state),
      state: buildState(state),
      concerns: concerns.map(concern => ({
        concernId: concern.concernId,
        topicKey: concern.topicKey,
        subject: concern.subject,
        desiredOutcome: truncate(concern.desiredOutcome, 200),
        status: concern.status,
        nextCheckAt: concern.nextCheckAt,
        expiresAt: concern.expiresAt,
      })),
      projects: projects.map(project => ({
        projectId: project.projectId,
        goal: truncate(project.goal, 160),
        recipeId: project.recipeId,
        status: project.status,
        stepCursor: project.stepCursor,
        nextWakeAt: project.nextWakeAt,
      })),
      observations: (input.observations || []).filter(observation => observation.sourceId && !deleted.has(observation.sourceId) && observation.freshUntil > asOf && gw.getSource(observation.sourceId)?.permission === 'granted').map(observation => ({
        observationId: observation.observationId,
        sourceId: observation.sourceId,
        kind: observation.kind,
        actor: observation.payload.actor || 'unknown',
        observer: observation.payload.observer || 'unknown',
        subject: observation.payload.subject || observation.payload.actor || 'unknown',
        world: observation.payload.world || gw.getSource(observation.sourceId).world,
        observedAt: observation.observedAt,
        freshUntil: observation.freshUntil,
        payload: observation.payload,
      })),
      memories: memory.candidates.map(candidate => ({
        id: candidate.id,
        statement: truncate(candidate.subject + ' / ' + candidate.predicate, 120),
        value: truncate(typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.value), 240),
        world: candidate.world,
        trust: candidate.trust,
        confidence: candidate.confidence,
        quote: candidate.quote ? truncate(candidate.quote, 200) : null,
        evidenceRefs: candidate.sourceRefs,
        whyRetrieved: candidate.whyRetrieved,
        score: candidate.score,
      })),
      capabilities,
    }

    const maxChars = Number(input.maxChars) || DEFAULT_MAX_CHARS
    const { text, used, included, dropped, accepted } = assemble(sections, maxChars)
    return {
      ok: true,
      projectionVersion: 1,
      characterId: input.characterId,
      revision: state ? state.revision : 0,
      seq,
      epoch: character.writerEpoch,
      identityRevision: character.identityRevision,
      asOf,
      sections: accepted,
      text,
      budget: { maxChars, usedChars: used, overBudget: used > maxChars },
      trace: {
        included,
        dropped,
        memory: { excluded: memory.excluded, budget: memory.budget, weights: memory.weights, totalBeforeBudget: memory.totalBeforeBudget },
        sections: SECTION_ORDER,
      },
    }
  }

  function buildIdentity (identity, state) {
    return {
      displayName: identity ? identity.displayName : (state && state.body && state.body.displayName) || null,
      identityRevision: identity ? identity.revision : 0,
      identityHash: identity ? identity.hash : null,
      // 静态表达仍然来自 prompts/current.json；这里只引用，不复制、不重写。
      stableDefinitionRef: identity ? 'identity:' + identity.revision : null,
    }
  }

  function buildState (state) {
    if (!state) return null
    const body = state.body || {}
    return {
      needs: body.needs || null,
      affect: body.affect || null,
      relationship: body.relationship ? relationshipSnapshot({ relationship: body.relationship }) : null,
      interests: body.interests || {},
      attentionPolicy: body.attentionPolicy || null,
      nurture: body.nurture || null,
    }
  }

  /** 按段装配并裁剪：超预算时从优先级最低的段开始丢，且如实记录。 */
  function assemble (sections, maxChars) {
    const included = []
    const dropped = []
    const accepted = Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, Array.isArray(value) ? [] : null]))
    let text = ''
    for (const name of SECTION_ORDER) {
      const value = sections[name]
      const serialized = JSON.stringify(value)
      if (!serialized || serialized === 'null' || serialized === '{}' || serialized === '[]') continue
      const block = '## ' + name + '\n' + serialized + '\n'
      if (text.length + block.length > maxChars) {
        // 记忆段允许压缩：丢弃低分条目而不是整段丢弃
        if (name === 'memories' && Array.isArray(value) && value.length) {
          const room = Math.max(0, maxChars - text.length - 200)
          const kept = []
          let used = 0
          for (const item of value) {
            const size = JSON.stringify(item).length + 2
            if (used + size > room) { dropped.push({ section: name, id: item.id, reason: 'char_budget' }); continue }
            kept.push(item)
            used += size
          }
          if (kept.length) {
            const compact = '## ' + name + '\n' + JSON.stringify(kept) + '\n'
            text += compact
            accepted[name] = kept
            included.push({ section: name, count: kept.length, truncated: kept.length < value.length })
            continue
          }
        }
        dropped.push({ section: name, reason: 'char_budget', size: block.length })
        continue
      }
      text += block
      accepted[name] = value
      included.push({ section: name, count: Array.isArray(value) ? value.length : 1 })
    }
    return { text, used: text.length, included, dropped, accepted }
  }

  return { project, assemble, DEFAULT_MAX_CHARS }
}

module.exports = { createProjector, DEFAULT_MAX_CHARS }
