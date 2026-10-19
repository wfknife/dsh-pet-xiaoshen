'use strict'
/**
 * K5 操作执行器：授权 → 派发 → 回执 → 落账。
 *
 * 不变量（总规 §9.3 / §12.3）：
 *  - 一次任务的外部 await 不占据数据库事务：prepare 在一个事务里提交 operation + outbox，
 *    派发在事务外，结果在另一个事务里落账。
 *  - succeeded 必须有结构化 receipt；没有回执的“成功”不成立。
 *  - external-* 崩溃/超时一律 unknown，等待 reconcile；绝不盲重发。
 *  - 已取消计划的迟到回执仍然保存真实结果（不篡改已发生的事实）。
 */

const { canTransition, validateReceipt } = require('../contracts.cjs')
const { deterministicId, hash } = require('../ids.cjs')

/**
 * @param {{registry: object, adapters: object, config: object, now?: Function}} deps
 */
function createExecutor (deps) {
  const registry = deps.registry
  const adapters = deps.adapters || {}
  const config = deps.config
  const clock = typeof deps.now === 'function' ? deps.now : Date.now
  const running = new Map()

  function adapterFor (capabilityId, version) {
    const adapter = adapters[capabilityId + '@' + version] || adapters[capabilityId]
    if (!adapter) return null
    if (version !== undefined && adapter.version !== undefined && adapter.version !== version) {
      // 在途操作必须固定旧版本；版本不匹配时明确失败，而不是用新版本悄悄重放。
      return { mismatch: true, have: adapter.version, want: version }
    }
    return adapter
  }

  /**
   * 事务内准备。成功返回已提交 operation；失败返回明确原因，不写任何副作用。
   */
  function prepare (gw, input) {
    const now = Number(input.now) || clock()
    const authorization = registry.authorize(input.capabilityId, {
      version: input.capabilityVersion,
      grantedScopes: input.grantedScopes,
      allowExternal: input.allowExternal,
      now,
    })
    if (!authorization.ok) return { ok: false, code: authorization.code, detail: authorization.detail }
    const manifest = authorization.manifest

    const validation = registry.validateInput(manifest, input.input)
    if (!validation.ok) return { ok: false, code: validation.code, detail: validation.detail }

    const inputHash = hash(input.input === undefined ? null : input.input)
    const dedupeKey = input.dedupeKey || (input.characterId + '|' + manifest.id + '|' + inputHash)
    const existing = gw.getOperationByDedupe(input.characterId, dedupeKey)
    if (existing) {
      if (existing.inputHash !== inputHash) {
        return { ok: false, code: 'operation_conflict', detail: { operationId: existing.operationId } }
      }
      // 同 ID 同正文：返回既有状态，不重复执行（C01/C03）。
      return { ok: true, reused: true, operation: existing }
    }
    // 来源已撤销的输入不得派发。
    for (const ref of input.sourceRefs || []) {
      const source = gw.getSource(ref)
      if (!source || source.permission === 'revoked') return { ok: false, code: 'source_forgotten', detail: ref }
    }

    const operationId = input.operationId || deterministicId('op', input.characterId + '|' + dedupeKey + '|' + now)
    const operation = gw.putOperation({
      operationId,
      characterId: input.characterId,
      inputHash,
      capabilityId: manifest.id,
      capabilityVersion: manifest.version,
      provider: manifest.providerId,
      effect: manifest.effect,
      scope: manifest.scopes,
      status: 'authorized',
      epoch: input.epoch,
      deadline: input.deadline || (manifest.timeoutMs ? now + manifest.timeoutMs : null),
      attempts: 0,
      planRevision: input.planRevision === undefined ? null : input.planRevision,
      dedupeKey,
    })
    for (const ref of input.sourceRefs || []) gw.addEvidence(operationId, ref, 'operation_input', 0)
    gw.putOutbox({
      dispatchId: deterministicId('outbox', operationId + '|' + manifest.providerId),
      operationId,
      channel: manifest.providerId,
      status: 'pending',
      nextAttemptAt: now,
    })
    return { ok: true, reused: false, operation, manifest }
  }

  /**
   * 事务外派发。永不 reject：所有失败都归一成 outcome。
   * @returns {Promise<{outcome: string, output?: object, receipt?: object, error?: string, artifactRefs?: string[], unknownReason?: string}>}
   */
  async function dispatch (operation, context = {}) {
    const now = Number(context.now) || clock()
    const adapter = adapterFor(operation.capabilityId, operation.capabilityVersion)
    if (!adapter) return { outcome: 'failed', error: 'adapter_missing', definitive: true }
    if (adapter.mismatch) {
      return { outcome: 'failed', error: 'adapter_version_mismatch', definitive: true, detail: { have: adapter.have, want: adapter.want } }
    }
    const timeoutMs = adapter.timeoutMs || config.capability.defaultTimeoutMs
    const controller = new AbortController()
    running.set(operation.operationId, controller)
    let timer = null
    const timeout = new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve({ timeout: true }), { once: true })
      timer = setTimeout(() => {
        try { controller.abort() } catch (_) {}
        resolve({ timeout: true })
      }, Math.min(timeoutMs, config.capability.maxTimeoutMs))
    })
    try {
      const input = context.input
      const invoked = Promise.resolve().then(() => adapter.invoke(input, {
        operationId: operation.operationId,
        effect: operation.effect,
        characterId: operation.characterId,
        epoch: operation.epoch,
        signal: controller.signal,
        sourceRefs: context.sourceRefs || [],
        now,
        services: context.services || {},
      }))
      const result = await Promise.race([invoked, timeout])
      if (result && result.timeout) {
        return unknownOrFailed(operation, 'provider_timeout')
      }
      if (!result || typeof result !== 'object') return unknownOrFailed(operation, 'adapter_bad_result')
      if (result.ok) {
        const output = result.output === undefined ? {} : result.output
        const validation = registry.validateOutput(registry.get(operation.capabilityId, operation.capabilityVersion), output)
        if (!validation.ok) {
          // 返回超长或不符合 schema 视为工具失败，不能回退成“成功文本”。
          return unknownOrFailed(operation, validation.code)
        }
        return {
          outcome: 'succeeded',
          output,
          artifactRefs: result.artifactRefs || output.artifactRefs || [],
          receipt: {
            operationId: operation.operationId,
            provider: operation.provider,
            version: operation.capabilityVersion,
            effect: operation.effect,
            evidence: result.evidence || output.evidence || {},
            artifactRefs: result.artifactRefs || output.artifactRefs || [],
            occurredAt: Number(result.occurredAt) || clock(),
          },
        }
      }
      if (result.unknown === true || result.applied === 'unknown') return unknownOrFailed(operation, result.reason || 'unknown_effect')
      return { outcome: 'failed', error: String(result.reason || 'adapter_failed').slice(0, 200), definitive: result.applied === false }
    } catch (error) {
      return unknownOrFailed(operation, 'adapter_error:' + String(error && error.message ? error.message : error).slice(0, 160))
    } finally {
      running.delete(operation.operationId)
      if (timer) clearTimeout(timer)
    }
  }

  function unknownOrFailed (operation, reason) {
    // read 可以安全重读；internal/virtual 若已进入执行也可能已写入，但仍可核对。
    // external-* 无法确定是否生效 → 必须 unknown。
    const effect = operation.effect
    if (effect === 'read') return { outcome: 'failed', error: reason, definitive: true, retryable: true }
    if (effect === 'external-idempotent' || effect === 'external-unknown') {
      return { outcome: 'unknown', unknownReason: reason }
    }
    return { outcome: 'unknown', unknownReason: reason }
  }

  /**
   * 结果落账（事务内）。永不把 unknown 直接改回 authorized 盲发。
   */
  function settle (gw, input) {
    const now = Number(input.now) || clock()
    const operation = gw.getOperation(input.operationId)
    if (!operation) return { ok: false, code: 'operation_missing' }
    const result = input.result
    const target = result.outcome === 'succeeded'
      ? 'succeeded'
      : (result.outcome === 'unknown' ? 'unknown' : (result.outcome === 'cancelled' ? 'cancelled' : 'failed'))

    if (!canTransition(operation.status, target)) {
      // 幂等重放：同状态直接返回既有事实，而不是报错。
      if (operation.status === target) return { ok: true, operation, duplicate: true }
      return { ok: false, code: 'operation_transition_invalid', detail: { from: operation.status, to: target } }
    }

    let receiptRef = null
    if (target === 'succeeded') {
      const receipt = result.receipt || {}
      const validation = validateReceipt({ ...receipt, operationId: operation.operationId, provider: operation.provider, effect: operation.effect })
      if (!validation.ok) return { ok: false, code: 'receipt_invalid', detail: validation.detail }
      if (receipt.operationId !== operation.operationId || receipt.provider !== operation.provider || receipt.effect !== operation.effect || receipt.version !== operation.capabilityVersion) return { ok: false, code: 'receipt_identity_mismatch' }
      const outputCheck = registry.validateOutput(registry.get(operation.capabilityId, operation.capabilityVersion), result.output || {})
      if (!outputCheck.ok) return { ok: false, code: outputCheck.code }
      receiptRef = gw.putPayload(JSON.stringify({ ...receipt, output: result.output, settledAt: now }), 'operation')
    }
    const patched = gw.patchOperation(operation.operationId, {
      status: target,
      receiptRef,
      attempts: operation.attempts + 1,
      unknownReason: target === 'unknown' ? String(result.unknownReason || 'unknown').slice(0, 200) : null,
    })
    gw.addAttempt({
      operationId: operation.operationId,
      attempt: operation.attempts + 1,
      epoch: operation.epoch,
      startedAt: operation.createdAt,
      endedAt: now,
      outcome: target,
      idempotencyKey: null,
      detail: { error: result.error || null, artifactRefs: result.artifactRefs || [] },
    })
    const outbox = gw.getOutboxForOperation(operation.operationId)
    for (const row of outbox) {
      gw.patchOutbox(row.dispatch_id, {
        status: target === 'succeeded' ? 'done' : (target === 'unknown' ? 'awaiting_reconcile' : 'failed'),
        attempts: (row.attempts || 0) + 1,
        lastError: result.error || null,
        nextAttemptAt: null,
      })
    }
    return { ok: true, operation: patched, receiptRef }
  }

  /**
   * 核对：只在 effect 支持 reconcile 时可用，且必须产出确定结论。
   */
  async function reconcile (operation, context = {}) {
    const adapter = adapterFor(operation.capabilityId, operation.capabilityVersion)
    if (!adapter || typeof adapter.reconcile !== 'function') return { outcome: 'unknown', unknownReason: 'reconcile_unsupported' }
    try {
      const result = await adapter.reconcile(operation, { ...context, operationId: operation.operationId, characterId: operation.characterId, epoch: operation.epoch })
      if (!result || typeof result !== 'object') return { outcome: 'unknown', unknownReason: 'reconcile_bad_result' }
      if (result.applied === true) {
        return {
          outcome: 'succeeded',
          output: result.output || {},
          artifactRefs: result.artifactRefs || [],
          receipt: {
            operationId: operation.operationId,
            provider: operation.provider,
            version: operation.capabilityVersion,
            effect: operation.effect,
            evidence: { reconciled: true, ...(result.evidence || {}) },
            artifactRefs: result.artifactRefs || [],
            occurredAt: Number(result.occurredAt) || clock(),
          },
        }
      }
      if (result.applied === false) return { outcome: 'failed', error: 'reconciled_not_applied', definitive: true }
      return { outcome: 'unknown', unknownReason: 'reconcile_inconclusive' }
    } catch (error) {
      return { outcome: 'unknown', unknownReason: 'reconcile_error:' + String(error && error.message ? error.message : error).slice(0, 120) }
    }
  }

  function markDispatchStart (gw, operationId, now) {
    const operation = gw.getOperation(operationId)
    if (!operation) return { ok: false, code: 'operation_missing' }
    if (operation.status !== 'authorized') return { ok: false, code: 'operation_not_authorized' }
    return { ok: true, operation: gw.patchOperation(operationId, { status: 'dispatched' }) }
  }

  function cancel(operationId) { const controller = running.get(operationId); if (controller) controller.abort(); return !!controller }
  function cancelAll() { for (const controller of running.values()) controller.abort() }
  return { prepare, dispatch, settle, reconcile, markDispatchStart, adapterFor, cancel, cancelAll }
}

module.exports = { createExecutor }
