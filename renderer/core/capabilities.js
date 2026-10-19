(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.CharacterCapabilities = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  const SCHEMAS = {
    desktop: { type: 'object', required: ['app', 'cat', 'sourceType', 'eventAt', 'trust'], additionalProperties: false,
      properties: { app: { type: 'string', maxLength: 200 }, cat: { type: 'string', maxLength: 80 }, sourceType: { type: 'string', enum: ['desktop.foreground'] }, eventAt: { type: 'number' }, trust: { type: 'string', enum: ['observation'] } } },
    activityInput: { type: 'object', required: ['proposal', 'input'], additionalProperties: false, properties: {
      proposal: { type: 'object', required: ['revision', 'activity'], properties: { revision: { type: 'number' }, activity: { type: 'object', required: ['id', 'kind'], properties: { id: { type: 'string', maxLength: 180 }, kind: { type: 'string', enum: ['revisit_memory', 'chat_notes', 'quiet_rest', 'curiosity_note'] } }, additionalProperties: true } }, additionalProperties: true },
      input: { type: 'object', required: ['nowTs'], properties: { nowTs: { type: 'number' } }, additionalProperties: false } } },
    activity: { type: 'object', required: ['ok', 'activityId', 'continuationId', 'virtual'], additionalProperties: false,
      properties: { ok: { type: 'boolean' }, activityId: { type: 'string', maxLength: 180 }, continuationId: { type: 'string', maxLength: 400 }, virtual: { type: 'boolean' } } },
    project: { type: 'object', required: ['operationId', 'step', 'virtual', 'kind', 'text', 'sourceRefs', 'eventAt', 'hash', 'quotedRole', 'ownerTaskCompleted'], additionalProperties: true,
      properties: { operationId: { type: 'string', maxLength: 400 }, step: { type: 'number' }, virtual: { type: 'boolean' }, kind: { type: 'string', enum: ['material_selected', 'virtual_notebook'] },
        text: { type: 'string', maxLength: 240 }, sourceRefs: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 240 } }, eventAt: { type: 'number' }, hash: { type: 'string', maxLength: 64 }, quotedRole: { type: 'string', enum: ['user'] }, ownerTaskCompleted: { type: 'boolean' } } }
  }
  function validate(value, schema) {
    if (!schema) return true
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      if ((schema.required || []).some(k => value[k] === undefined)) return false
      if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties || {}, k))) return false
      return Object.entries(schema.properties || {}).every(([k, s]) => value[k] === undefined || validate(value[k], s))
    }
    if (schema.type === 'string') return typeof value === 'string' && (!schema.maxLength || value.length <= schema.maxLength) && (!schema.enum || schema.enum.includes(value))
    if (schema.type === 'number') return Number.isFinite(value)
    if (schema.type === 'boolean') return typeof value === 'boolean'
    if (schema.type === 'array') return Array.isArray(value) && (!schema.maxItems || value.length <= schema.maxItems) && value.every(item => validate(item, schema.items))
    return false
  }
  function create(options = {}) {
    const now = options.now || Date.now, providers = new Map(), inFlight = new Map()
    function register(contract, execute) {
      if (!contract || !/^[a-z][a-z0-9.-]{2,80}$/.test(contract.id) || !contract.provider || !contract.version || !['read', 'virtual', 'external'].includes(contract.effect) || typeof execute !== 'function') throw Error('invalid_capability')
      const key = contract.id + ':' + contract.provider
      if (providers.has(key)) throw Error('provider_already_registered')
      providers.set(key, { contract: { ...contract }, execute, enabled: true, failures: 0, openUntil: 0 })
      return () => { providers.delete(key) }
    }
    function available() {
      const out = new Map()
      for (const row of providers.values()) if (row.enabled && now() >= row.openUntil && (!row.contract.available || row.contract.available())) {
        const old = out.get(row.contract.id)
        if (!old || (row.contract.priority || 0) > (old.priority || 0)) out.set(row.contract.id, { ...row.contract, available: undefined })
      }
      return [...out.values()]
    }
    async function run(proposal, authority) {
      const existing = options.store.operation ? await options.store.operation(proposal.id) : null
      if (existing && existing.ok === false) return existing
      if (existing && existing.status !== 'prepared') {
        if (existing.type !== 'action' || existing.capabilityId !== proposal.capabilityId || existing.effect !== proposal.effect ||
          existing.input && JSON.stringify(existing.input) !== JSON.stringify(proposal.input)) return { ok: false, reason: 'operation_conflict' }
        return { ok: existing.status === 'completed' || existing.status === 'awaiting_receipt', replay: true, status: existing.status, receipt: existing.receipt || null, reason: existing.status }
      }
      const contract = available().find(c => c.id === proposal.capabilityId)
      if (!contract) return { ok: false, reason: 'capability_unavailable' }
      const row = providers.get(contract.id + ':' + contract.provider)
      if (proposal.effect !== contract.effect || !validate(proposal.input, contract.input) || JSON.stringify(proposal.input).length > 16000) return { ok: false, reason: 'capability_contract' }
      if (!(proposal.deadline > now()) || !options.authorize || !options.authorize(authority, contract.effect)) return { ok: false, reason: 'capability_authorization' }
      const op = await options.store.beginOperation({ ...proposal, provider: contract.provider, version: contract.version })
      if (!op || op.ok === false) return op || { ok: false, reason: 'operation_begin_failed' }
      if (op.status === 'prepared' && (op.provider !== contract.provider || op.version !== contract.version)) return { ok: false, reason: 'prepared_provider_changed' }
      if (op.status !== 'prepared') return { ok: op.status === 'completed' || op.status === 'awaiting_receipt', replay: true, status: op.status, receipt: op.receipt || null, reason: op.status }
      if (!options.authorize(authority, contract.effect)) { await options.store.updateOperation(proposal.id, 'cancelled'); return { ok: false, reason: 'cancelled_before_dispatch' } }
      const dispatched = await options.store.updateOperation(proposal.id, 'dispatched')
      if (!dispatched || dispatched.ok === false) return dispatched || { ok: false, reason: 'dispatch_save_failed' }
      let timer
      const controller = new AbortController()
      const services = Object.freeze({
        signal: controller.signal, operationId: proposal.id,
        request: async (name, input) => {
          if (controller.signal.aborted || !row.enabled || !providers.has(contract.id + ':' + contract.provider)) throw Error('capability_cancelled')
          if (!(contract.services || []).includes(name) || !options.service) throw Error('host_service_denied')
          return options.service(name, input, { operationId: proposal.id, effect: contract.effect })
        }
      })
      try {
        const timeout = Math.min(30000, contract.timeoutMs || 5000, proposal.deadline - now())
        const result = await Promise.race([Promise.resolve().then(() => row.execute(proposal.input, services, authority)), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('capability_timeout')) }, timeout) })])
        if (!result || result.ok !== true || contract.output && !validate(result.value, contract.output)) throw Error(result && result.reason || 'capability_output')
        row.failures = 0
        const receipt = { ok: true, operationId: proposal.id, provider: contract.provider, version: contract.version, effect: contract.effect, eventAt: now(), value: result.value || null }
        const status = result.awaitingReceipt ? 'awaiting_receipt' : 'completed'
        const saved = await options.store.updateOperation(proposal.id, status, receipt)
        return saved && saved.ok === false ? saved : { ok: true, status, receipt }
      } catch (e) {
        row.failures++; row.openUntil = now() + (row.failures >= 3 ? 60000 : 15000)
        const status = contract.effect === 'external' ? 'unknown_after_dispatch' : 'failed'
        await options.store.updateOperation(proposal.id, status, { ok: false, reason: e.message, eventAt: now(), effect: contract.effect })
        return { ok: false, reason: e.message, status }
      } finally { clearTimeout(timer); controller.abort() }
    }
    function execute(proposal, authority) {
      if (!proposal || !proposal.id) return Promise.resolve({ ok: false, reason: 'invalid_proposal' })
      if (inFlight.has(proposal.id)) return inFlight.get(proposal.id)
      if (inFlight.size >= 8) return Promise.resolve({ ok: false, reason: 'capability_capacity' })
      const promise = run(proposal, authority).catch(e => ({ ok: false, reason: e.message }))
      inFlight.set(proposal.id, promise); promise.finally(() => inFlight.delete(proposal.id)); return promise
    }
    return { register, available, execute, disable(id, provider) { for (const row of providers.values()) if (row.contract.id === id && (!provider || row.contract.provider === provider)) row.enabled = false },
      enable(id, provider) { for (const row of providers.values()) if (row.contract.id === id && (!provider || row.contract.provider === provider)) { row.enabled = true; row.openUntil = 0 } },
      health: () => [...providers.values()].map(r => ({ id: r.contract.id, provider: r.contract.provider, enabled: r.enabled, failures: r.failures, openUntil: r.openUntil })) }
  }
  return { create, validate, SCHEMAS }
})
