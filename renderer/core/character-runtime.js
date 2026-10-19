/* Character Runtime: sole owner of role turns, cancellation and publication.
 * Providers may finish after cancellation; their execution capability cannot.
 * Domain rules and technical UI remain outside the model's authority. */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.CharacterRuntime = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  function create(options = {}) {
    if (typeof window !== 'undefined' && window.pet?.character?.authority) {
      // Retired domain runtime. Keep UI callers connected to the authoritative
      // command port, but never run their old decision/expression callbacks.
      const api = window.pet.character
      const command = (kind, payload) => api.submit({ kind, payload })
      let surface = false
      const rejected = () => ({ ok: false, reason: 'kernel_authority', cancelled: true })
      return Object.freeze({
        submit: async () => rejected(), cancel: () => command('owner.control', { action: 'cancel_auto' }),
        isAuthorized: () => false, isFactAuthorized: () => false, retainFacts: () => null, restoreFacts: () => null,
        completeFacts() {}, invalidateFacts() {}, continuation: () => null, completeContinuation() {}, shutdown() {},
        setConversationActive(value) { surface = !!value; return command('owner.control', { action: value ? 'conversation_start' : 'conversation_end' }) },
        conversationActive: () => surface,
        setVisible: value => command('owner.control', { action: 'visibility', visible: !!value }),
        setQuietUntil: until => command('owner.control', { action: 'quiet_until', until: Number(until) || 0 }),
        snapshot: () => ({ version: 1, authority: 'kernel', current: null, queued: [], continuations: [], factJobs: [], recent: [], conversationActive: surface }),
      })
    }
    const now = options.now || (() => Date.now())
    const decide = options.decide || (async event => ({ action: event.kind }))
    const records = [], queue = [], pending = new Map(), completed = new Map(), capabilities = new WeakMap(), continuations = new Map()
    const factJobs = new Map(), factCapabilities = new WeakMap()
    let seq = 0, current = null, stopped = false, visible = true, quietUntil = 0, lastAutomatic = 0, policyTouched = false, initializationError = null
    let conversationUntil = 0, conversationSurface = false
    const conversationActive = () => conversationSurface || now() < conversationUntil || !!(current && isUser(current.event)) || queue.some(t => isUser(t.event))
    const contact = event => automatic(event) && ['opportunity', 'local-expression'].includes(event.kind)
    const initialized = Promise.resolve().then(() => options.initialState ? options.initialState() : null).then(state => {
      if (state && !policyTouched) quietUntil = Math.max(0, Number(state.quietUntil) || 0)
      if (state) lastAutomatic = Math.max(0, Number(state.lastAutomatic) || 0)
    }).catch(error => { initializationError = error })
    const session = options.sessionId || 'runtime:' + now() + ':' + Math.random().toString(36).slice(2)
    const cancelled = reason => ({ ok: false, cancelled: true, reason })
    const isUser = e => e.origin === 'user'
    const automatic = e => e.origin !== 'user' && e.origin !== 'user-feedback' && e.origin !== 'system'
    function note(turn, phase, detail) {
      const record = { turnId: turn.id, inputId: turn.event.id, kind: turn.event.kind, phase, at: now(), ...detail }
      records.push(record)
      if (records.length > 100) records.shift()
      if (options.onChange) { try { options.onChange(record) } catch (_) {} }
    }
    function allowed(execution) {
      const turn = capabilities.get(execution)
      return !!(turn && !stopped && !turn.controller.signal.aborted &&
        (current === turn || [...continuations.values()].some(c => c.turn === turn)))
    }
    function revokeContinuations(reason, filter) {
      for (const [id, c] of continuations) {
        if (filter && !filter(c.turn.event)) continue
        if (current !== c.turn) c.turn.controller.abort(reason)
        note(c.turn, 'continuation_cancelled', { reason })
        continuations.delete(id)
      }
    }
    function cancelCurrent(reason, onlyAutomatic = false) {
      if (current && (!onlyAutomatic || automatic(current.event))) {
        current.controller.abort(reason)
        note(current, 'cancel_requested', { reason })
      }
    }
    function invalidateFacts(reason = 'source_invalidated', filter) {
      for (const [ref, job] of factJobs) {
        if (filter && !filter(ref)) continue
        job.controller.abort(reason)
        clearTimeout(job.timer)
        factJobs.delete(ref)
        note(job.turn, 'facts_cancelled', { messageRef: ref, reason })
      }
    }
    function isFactAuthorized(permit, messageRef) {
      const job = factCapabilities.get(permit)
      return !!(job && !stopped && !job.controller.signal.aborted && now() < job.expiresAt &&
        job.messageRef === messageRef && factJobs.get(messageRef) === job)
    }
    function retainFacts(execution, source) {
      const turn = capabilities.get(execution)
      if (!allowed(execution) || !turn || !isUser(turn.event) || !source || source.role !== 'user' ||
        typeof source.messageRef !== 'string' || !source.messageRef || source.messageRef.length > 120 ||
        source.messageRef !== turn.event.messageRef || !Number.isFinite(source.ts) || !(source.ts > 0)) return null
      const ref = source.messageRef
      if (factJobs.has(ref) || factJobs.size >= 8) {
        note(turn, 'facts_rejected', { messageRef: ref, reason: factJobs.has(ref) ? 'facts_pending' : 'facts_capacity' })
        return null
      }
      const controller = new AbortController(), expiresAt = now() + 120000
      const permit = Object.freeze({ messageRef: ref, sourceTs: source.ts, signal: controller.signal })
      const job = { turn, messageRef: ref, controller, expiresAt, timer: null }
      factCapabilities.set(permit, job); factJobs.set(ref, job)
      job.timer = setTimeout(() => invalidateFacts('facts_timeout', id => id === ref), 120000)
      note(turn, 'facts_retained', { messageRef: ref, expiresAt })
      return permit
    }
    function completeFacts(permit) {
      const job = factCapabilities.get(permit)
      if (!job || factJobs.get(job.messageRef) !== job) return
      clearTimeout(job.timer); factJobs.delete(job.messageRef)
      note(job.turn, 'facts_completed', { messageRef: job.messageRef })
    }
    function executionFor(turn) {
      const execution = Object.freeze({
        turnId: turn.id, actionId: turn.id + ':action', executionId: turn.id + ':execution', signal: turn.controller.signal,
        isCurrent: () => allowed(execution),
        assertCurrent: () => { if (!allowed(execution)) throw Object.assign(new Error('runtime_cancelled'), { code: 'RUNTIME_CANCELLED' }) },
        publish: fn => {
          if (!allowed(execution) || !visible) return cancelled('publication_cancelled')
          if (contact(turn.event) && conversationActive()) return cancelled('conversation_active')
          const plan = options.presentation && options.presentation.claim({ owner: execution.executionId, channel: 'text', priority: isUser(turn.event) ? 100 : 10, isCurrent: () => allowed(execution) })
          if (plan && !plan.ok) return plan
          const result = fn()
          if (result && typeof result.then === 'function') throw new Error('publication_must_be_synchronous')
          note(turn, result && result.ok === false ? 'presentation_rejected' : 'presented', {})
          if (plan && !(result && result.ok === false)) options.presentation.stage(plan.token, 'published')
          return result
        },
        commit: async fn => {
          if (!allowed(execution)) return cancelled('commit_cancelled')
          // Once started, an atomic domain commit is allowed to finish truthfully.
          const result = await fn()
          note(turn, result && result.ok === false ? 'commit_failed' : 'committed', {})
          return result
        },
        continueAs: key => {
          if (!allowed(execution) || !key) return null
          const id = execution.executionId + ':' + key
          continuations.set(id, { turn, execution })
          return id
        }
      })
      capabilities.set(execution, turn)
      return execution
    }
    function restoreFacts(source, expiresAt) {
      if (stopped || !source || source.role !== 'user' || !source.messageRef || !(source.ts > 0) ||
        !(expiresAt > now()) || expiresAt > now() + 120000 || factJobs.has(source.messageRef) || factJobs.size >= 8) return null
      const controller = new AbortController(), ref = source.messageRef
      const permit = Object.freeze({ messageRef: ref, sourceTs: source.ts, signal: controller.signal })
      const turn = { id: session + ':recovery:' + (++seq), event: { id: ref, kind: 'fact-recovery' } }
      const job = { turn, messageRef: ref, controller, expiresAt, timer: setTimeout(() => invalidateFacts('facts_timeout', id => id === ref), expiresAt - now()) }
      factCapabilities.set(permit, job); factJobs.set(ref, job)
      note(turn, 'facts_restored', { messageRef: ref, expiresAt }); return permit
    }
    async function run(turn) {
      // A predecessor may create a metadata lease after this input was queued.
      if (isUser(turn.event)) revokeContinuations('owner_turn')
      current = turn
      const execution = executionFor(turn)
      note(turn, 'deciding', {})
      let abortListener
      const aborted = new Promise(resolve => {
        abortListener = () => resolve(cancelled(String(turn.controller.signal.reason || 'cancelled')))
        turn.controller.signal.addEventListener('abort', abortListener, { once: true })
      })
      const work = (async () => {
        const decision = await decide(turn.event, { visible, quietUntil, lastAutomatic, now: now() }, execution)
        if (!allowed(execution)) return cancelled('decision_cancelled')
        if (decision && decision.ok === false) return { ok: false, reason: decision.reason || 'decision_failed' }
        if (!decision || decision.action === 'wait' || decision.action === 'none') {
          note(turn, 'waiting', { reason: decision && decision.reason })
          return { ok: true, silent: true }
        }
        note(turn, 'executing', { action: decision.action })
        return turn.executor(execution, decision)
      })()
      try {
        const result = await Promise.race([work, aborted])
        if (automatic(turn.event) && result && result.ok && !result.silent) lastAutomatic = now()
        note(turn, result && result.cancelled ? 'cancelled' : result && result.ok === false ? 'failed' : 'completed', { reason: result && result.reason,
          automatic: automatic(turn.event), silent: !!(result && result.silent), ok: !(result && result.ok === false) })
        const final = result || { ok: true }
        completed.set(turn.event.id, final)
        if (completed.size > 256) completed.delete(completed.keys().next().value)
        turn.resolve(final)
      } catch (error) {
        note(turn, 'failed', { reason: error.code || error.message })
        const final = { ok: false, reason: error.code || error.message }
        completed.set(turn.event.id, final)
        if (completed.size > 256) completed.delete(completed.keys().next().value)
        turn.resolve(final)
      } finally {
        if (isUser(turn.event)) conversationUntil = now() + 90000
        turn.controller.signal.removeEventListener('abort', abortListener)
        if (current === turn) current = null
        pending.delete(turn.key)
      }
    }
    let pumping = false
    async function pump() {
      if (pumping) return
      pumping = true
      try {
        await initialized
        if (initializationError) throw initializationError
        while (queue.length && !stopped) {
          queue.sort((a, b) => b.priority - a.priority || a.order - b.order)
          const turn = queue.shift()
          if (contact(turn.event) && conversationActive()) {
            pending.delete(turn.key); turn.resolve({ ok: true, silent: true, reason: 'conversation_active' }); continue
          }
          if (!visible && turn.event.origin !== 'system' || automatic(turn.event) && now() < quietUntil) {
            pending.delete(turn.key); note(turn, 'waiting', { reason: 'not_available' }); turn.resolve({ ok: true, silent: true, reason: 'not_available' }); continue
          }
          await run(turn)
        }
      } catch (error) {
        for (const turn of queue.splice(0)) { pending.delete(turn.key); turn.resolve({ ok: false, reason: 'runtime_restore_failed:' + error.message }) }
      } finally { pumping = false }
    }
    function submit(event, executor) {
      if (stopped) return Promise.resolve(cancelled('runtime_stopped'))
      if (!event || !event.kind || typeof executor !== 'function') return Promise.resolve({ ok: false, reason: 'invalid_input' })
      const input = { ...event, id: event.id || session + ':input:' + (++seq) }
      if (completed.has(input.id)) return Promise.resolve(completed.get(input.id))
      const key = input.coalesceKey || input.id
      if (pending.has(key)) return pending.get(key).promise
      if (queue.length >= 32) return Promise.resolve({ ok: false, reason: 'runtime_capacity' })
      if (isUser(input)) {
        conversationUntil = now() + 90000
        cancelCurrent('owner_input', true)
        revokeContinuations('owner_input')
        // Old automatic opportunities do not become a burst after the reply.
        for (let i = queue.length - 1; i >= 0; i--) if (automatic(queue[i].event)) {
          const old = queue.splice(i, 1)[0]; pending.delete(old.key); old.resolve(cancelled('owner_input'))
        }
      }
      let resolve
      const promise = new Promise(r => { resolve = r })
      const turn = { id: session + ':turn:' + (++seq), event: input, executor, key, promise, resolve,
        controller: new AbortController(), order: seq, priority: isUser(input) ? 100 : input.origin === 'user-feedback' ? 50 : input.origin === 'system' ? 40 : 10 }
      pending.set(key, turn); queue.push(turn); note(turn, 'accepted', {}); void pump()
      return promise
    }
    function cancel(reason = 'cancelled', filter) {
      if (!filter || current && filter(current.event)) cancelCurrent(reason)
      for (let i = queue.length - 1; i >= 0; i--) if (!filter || filter(queue[i].event)) {
        const turn = queue.splice(i, 1)[0]; pending.delete(turn.key); turn.resolve(cancelled(reason)); note(turn, 'cancelled', { reason })
      }
      revokeContinuations(reason, filter)
    }
    return Object.freeze({
      submit, cancel, isAuthorized: allowed, retainFacts, restoreFacts, isFactAuthorized, completeFacts, invalidateFacts,
      setConversationActive(value) {
        conversationSurface = !!value
        if (value) { conversationUntil = now() + 90000; cancel('conversation_active', contact) }
        else conversationUntil = 0
      },
      conversationActive,
      setVisible(value) { visible = !!value; if (options.presentation) options.presentation.setVisible(visible); if (!visible) cancel('hidden') },
      setQuietUntil(value) { policyTouched = true; quietUntil = Math.max(0, Number(value) || 0); if (quietUntil > now()) cancel('owner_quiet', automatic) },
      continuation(id) { const c = continuations.get(id); return c && allowed(c.execution) ? c.execution : null },
      completeContinuation(id) { continuations.delete(id) },
      shutdown() { stopped = true; cancel('shutdown'); invalidateFacts('shutdown') },
      snapshot: () => ({ version: 1, session, visible, quietUntil, conversationActive: conversationActive(), current: current && { turnId: current.id, kind: current.event.kind },
        queued: queue.map(t => ({ turnId: t.id, inputId: t.event.id, kind: t.event.kind })), continuations: [...continuations.keys()],
        factJobs: [...factJobs.values()].map(j => ({ messageRef: j.messageRef, expiresAt: j.expiresAt })), recent: records.map(r => ({ ...r })) })
    })
  }
  return { create }
})
