'use strict'
/**
 * K6 ModelGateway Adapter。
 *
 * 内核跑在 utilityProcess，模型调用仍归主进程（凭据、供应商适配、设置都在那里）。
 * 因此这里只定义**任务级**接口：输入结构化请求，输出文本或错误分类；
 * 不把供应商差异、凭据或可重试语义泄漏给领域代码。
 *
 * 约束（总规 §3.2 / §18.1）：
 *  - 模型输出永远是提案文本；解析失败 → rejected，不猜成系统命令；
 *  - 支持外部 AbortSignal（用户插话必须能打断模型请求）；
 *  - 原生 tool calling 是后续的显式扩展，本版只走纯文本 JSON。
 */

const { CharacterError, unavailable, internal } = require('../errors.cjs')

const TASK_KINDS = Object.freeze(['decide', 'express', 'extract', 'reflect', 'verify_grounding'])

function createModelGateway (deps) {
  const host = deps.host
  const config = deps.config
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const stats = { requests: 0, failures: 0, lastError: null, lastAt: null }

  /**
   * @param {{task: string, messages: object[], maxTokens?: number, temperature?: number,
   *          signal?: AbortSignal, purpose?: string, timeoutMs?: number}} request
   * @returns {Promise<{ok: true, text: string, model: string} | never>}
   */
  async function complete (request) {
    if (request.signal && request.signal.aborted) throw new CharacterError('rejected', 'model_aborted')
    if (!TASK_KINDS.includes(request.task)) throw internal('model_task_unknown', request.task)
    if (!host || typeof host.request !== 'function') throw unavailable('model_host_unavailable')
    stats.requests++
    stats.lastAt = now()
    const payload = {
      task: request.task,
      purpose: request.purpose || request.task,
      messages: request.messages,
      maxTokens: request.maxTokens || 700,
      temperature: request.temperature === undefined ? 0.4 : request.temperature,
      timeoutMs: request.timeoutMs || 45000,
    }
    let result
    try {
      let onAbort
      const aborted = new Promise((resolve, reject) => {
        onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true })
      })
      try { result = await Promise.race([host.request('model.complete', payload, { signal: request.signal }), aborted]) }
      finally { if (request.signal) request.signal.removeEventListener('abort', onAbort) }
      if (request.signal && request.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    } catch (error) {
      stats.failures++
      stats.lastError = String(error && error.message ? error.message : error).slice(0, 200)
      if (error && error.name === 'AbortError') throw new CharacterError('rejected', 'model_aborted')
      throw unavailable('model_call_failed', stats.lastError)
    }
    if (!result || result.ok !== true) {
      stats.failures++
      stats.lastError = String(result && result.reason || 'model_unavailable').slice(0, 200)
      throw unavailable('model_unavailable', stats.lastError)
    }
    const text = typeof result.text === 'string' ? result.text : ''
    if (!text.trim()) {
      stats.failures++
      stats.lastError = 'model_empty_output'
      throw unavailable('model_empty_output')
    }
    return { ok: true, text, model: String(result.model || 'unknown').slice(0, 120) }
  }

  /** 严格 JSON 解析：允许 ```json 围栏与前后空白，其余一律视为非法输出。 */
  function parseJson (text) {
    if (typeof text !== 'string') return { ok: false, reason: 'not_text' }
    let body = text.trim()
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body)
    if (fence) body = fence[1].trim()
    try {
      const value = JSON.parse(body)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not_object' }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, reason: 'json_parse_failed' }
    }
  }

  /**
   * 一次结构修复：只在解析失败/结构非法时使用，最多一次（§18.2）。
   */
  async function completeJson (request, validate) {
    const first = await complete(request)
    const parsed = parseJson(first.text)
    if (parsed.ok) {
      const validated = validate(parsed.value)
      if (validated.ok) return { ok: true, value: validated.value, model: first.model, repaired: false }
    }
    const repairMessage = {
      role: 'user',
      content: '上一次输出不是合法结构。只输出一个 JSON 对象，不要解释、不要 Markdown。' +
        (parsed.ok ? ' 结构问题：' + JSON.stringify(validate(parsed.value).reason || 'invalid') : ' 解析问题：' + parsed.reason),
    }
    const second = await complete({ ...request, messages: [...request.messages, { role: 'assistant', content: first.text }, repairMessage] })
    const reparsed = parseJson(second.text)
    if (!reparsed.ok) return { ok: false, reason: 'model_invalid_json', attempts: 2 }
    const revalidated = validate(reparsed.value)
    if (!revalidated.ok) return { ok: false, reason: 'model_invalid_structure', detail: revalidated.reason, attempts: 2 }
    return { ok: true, value: revalidated.value, model: second.model, repaired: true }
  }

  return { complete, completeJson, parseJson, stats: () => ({ ...stats }), config }
}

module.exports = { createModelGateway, TASK_KINDS }
