'use strict'
/**
 * K3 事实抽取（独立 job）。
 *
 * 边界（总规 §13.1）：
 *  - 抽取是模型提案，输出 shape 受限；程序再用 admission 校验 quoteSpan 能否定位原文。
 *  - 以 `sourceId + extractorVersion` 去重，最多一个模型结果被采用，失败可明确重试，
 *    不循环自我修复。
 *  - 抽取提示词是**新增的内部结构提示**，不属于 Expression Style（M1/M2）改动，
 *    因此不触发 deskpet/AGENTS.md 的 A/B 人工验收；这一点记录在 DECISIONS.md。
 */

const { validateCandidate } = require('../memory/admission.cjs')

const EXTRACTOR_VERSION = 'extract-v1'
const MAX_CANDIDATES = 6

function buildExtractMessages (input) {
  const system = [
    '你是一个事实抽取组件。从主人这句话里抽取可以长期保存的陈述。',
    '只输出 JSON：{"candidates":[{"subject":"...","predicate":"...","value":...,"quoteSpan":{"text":"原文子串"},"world":"user_report","validTime":null,"confidenceClass":"stated"}]}',
    '规则：',
    '1) 只抽取主人明确说出的内容；不要推断、不要补充常识。',
    '2) quoteSpan.text 必须是原文里逐字出现的子串，用来证明来源。',
    '3) subject 用简短标识符（如 owner、owner.pet），predicate 用简短属性名（如 likes_drink、lives_in）。',
    '4) 主人明确纠正旧说法时，加 "correctionTarget":"<被纠正的属性>"。',
    '5) 没有可抽取内容就输出 {"candidates":[]}。',
    '6) 最多 ' + MAX_CANDIDATES + ' 条。',
  ].join('\n')
  const payload = {
    sourceText: String(input.sourceText || '').slice(0, 8000),
    occurredAt: input.occurredAt,
    timezone: input.timezone || 'Asia/Shanghai',
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(payload) },
  ]
}

function validateExtraction (value, input) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.candidates)) {
    return { ok: false, reason: 'candidates_missing' }
  }
  if (value.candidates.length > MAX_CANDIDATES) return { ok: false, reason: 'too_many_candidates' }
  const accepted = []
  const rejected = []
  for (const raw of value.candidates) {
    const validated = validateCandidate(raw, {
      sourceText: input.sourceText,
      sourceWorld: 'user_report',
      sourceTrust: 'owner_statement',
      now: input.occurredAt,
    })
    if (!validated.ok) { rejected.push({ reason: validated.reason, candidate: summarize(raw) }); continue }
    accepted.push(validated.candidate)
  }
  // 全部被拒也算结构合法（结论是“没有可保存的事实”），但要保留拒绝原因供审查。
  return { ok: true, value: { accepted, rejected } }
}

function summarize (raw) {
  if (!raw || typeof raw !== 'object') return null
  return { subject: String(raw.subject || '').slice(0, 60), predicate: String(raw.predicate || '').slice(0, 60) }
}

/**
 * @param {{gateway: object, config: object}} deps
 */
function createExtractor (deps) {
  const gateway = deps.gateway

  /**
   * @param {{sourceText: string, occurredAt: number, timezone?: string, signal?: AbortSignal}} input
   */
  async function extract (input) {
    const result = await gateway.completeJson(
      {
        task: 'extract',
        messages: buildExtractMessages(input),
        maxTokens: 600,
        temperature: 0.1,
        signal: input.signal,
        timeoutMs: 45000,
      },
      value => validateExtraction(value, input),
    )
    if (!result.ok) return { ok: false, reason: result.reason, attempts: result.attempts || 1 }
    return {
      ok: true,
      accepted: result.value.accepted,
      rejected: result.value.rejected,
      model: result.model,
      extractorVersion: EXTRACTOR_VERSION,
    }
  }

  return { extract, buildExtractMessages, validateExtraction, EXTRACTOR_VERSION, MAX_CANDIDATES }
}

module.exports = { createExtractor, buildExtractMessages, validateExtraction, EXTRACTOR_VERSION, MAX_CANDIDATES }
