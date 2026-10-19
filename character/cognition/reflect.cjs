'use strict'
/**
 * K7 反思认知：读新经历与结果，输出 **ReflectionProposal**。
 *
 * 边界（总规 §16）：
 *  - 提案只包含支持来源、可能的模式、建议更新、置信类别和适用范围；
 *  - 日记/模型转述不能成为新证据；提案引用原 episode 与 sourceRef；
 *  - 宿主检查独立来源数、冲突、用户明确偏好与更新上限后才提交；
 *  - 反思是**待整合变更**，不是已经发生的真理。
 */

const MAX_EPISODES_IN_PROMPT = 8

function buildReflectMessages (input) {
  const system = [
    '你是一个角色的反思组件。只根据给定经历，提出可被否决的整合建议。',
    '只输出 JSON，不要解释。形状：',
    '{"kind":"none|interest|relationship_note|skill_revision","topicKey":"...","delta":0.02,"sourceRefs":["..."],"note":"..."}',
    '规则：',
    '1) 只能引用给定 episode 的 sourceRefs，不得新增来源。',
    '2) 证据不足就输出 {"kind":"none","note":"..."}。',
    '3) interest 的 delta 绝对值不得大于 0.05；没有明确重复模式就不要提兴趣变化。',
    '4) 不要声称做过没有回执支撑的现实操作。',
    '5) 一次只提一条建议，最多 ' + MAX_EPISODES_IN_PROMPT + ' 条经历作为依据。',
  ].join('\n')
  const payload = {
    now: input.now,
    episodes: (input.episodes || []).slice(0, MAX_EPISODES_IN_PROMPT).map(episode => ({
      episodeId: episode.episodeId,
      world: episode.world,
      title: episode.title,
      occurredAt: episode.occurredAt,
      sourceRefs: episode.sourceRefs || [],
      body: input.bodies ? input.bodies[episode.episodeId] || null : null,
    })),
    currentInterests: input.interests || {},
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) },
  ]
}

/**
 * @param {{gateway: object, config: object}} deps
 */
function createReflector (deps) {
  const gateway = deps.gateway

  async function reflect (input) {
    const messages = buildReflectMessages(input)
    const result = await gateway.completeJson(
      { task: 'reflect', messages, maxTokens: 400, temperature: 0.2, signal: input.signal, timeoutMs: 45000 },
      value => {
        // 结构校验在这里只做“可解析 + kind 合法”；业务上限由 growth.validateReflectionProposal 检查。
        if (!value || typeof value !== 'object') return { ok: false, reason: 'not_object' }
        if (typeof value.kind !== 'string') return { ok: false, reason: 'kind_missing' }
        return { ok: true, value }
      },
    )
    if (!result.ok) return { ok: false, reason: result.reason, attempts: result.attempts || 1 }
    return { ok: true, proposal: result.value, model: result.model }
  }

  return { reflect, buildReflectMessages, MAX_EPISODES_IN_PROMPT }
}

module.exports = { createReflector, buildReflectMessages, MAX_EPISODES_IN_PROMPT }
