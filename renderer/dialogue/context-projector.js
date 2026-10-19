(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ContextProjector = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  const BUDGETS = { M1_reply: 6000, M1_short: 1000, M2_decide: 4000, M2_say: 2800 }
  function project(task, input = {}, options = {}) {
    const budget = Math.min(options.budget || BUDGETS[task] || 2800, 8000), now = input.nowTs || Date.now()
    const ctx = input.context || {}, selected = [], excluded = [], data = { schema: 1, task, asOf: now }
    let used = JSON.stringify(data).length
    function add(key, value, refs = []) {
      if (value === undefined || value === null || Array.isArray(value) && !value.length) return
      const size = JSON.stringify({ [key]: value }).length + 1
      if (used + size > budget) { excluded.push({ key, reason: 'budget', refs }); return }
      data[key] = value; used += size; selected.push({ key, refs, chars: size })
    }
    const valid = row => row && row.sourcePermission !== 'revoked' && !['suppressed', 'archived', 'forgotten', 'invalidated'].includes(row.status) && !row.supersededBy &&
      !(row.expiresAt && row.expiresAt < now) && !(row.sourceRefs || []).some(r => (input.invalidRefs || []).includes(r))
    function keep(key, row) {
      if (valid(row)) return true
      excluded.push({ key, id: row && (row.id || row.messageRef) || null, reason: row && row.sourcePermission === 'revoked' ? 'source_permission_revoked' :
        row && row.supersededBy ? 'superseded' : row && row.expiresAt && row.expiresAt < now ? 'expired' : 'source_inactive' })
      return false
    }
    add('identityVersion', ctx.identityVersion || ctx.personaProjection && ctx.personaProjection.version || 'current-config')
    add('promptRevision', input.promptRevision || ctx.promptRevision || null)
    add('currentInputRef', input.messageRef || null)
    add('state', { self: ctx.selfState || null, emotion: ctx.emotion || null, relationship: ctx.relationship || null })
    const history = (input.history && input.history.length ? input.history : ctx.recentInteractions || []).filter(row => keep('recentInteractions', row)).slice(-6).map(h => ({ role: h.role, text: String(h.text || '').slice(0, 240), messageRef: h.messageRef || null, eventAt: h.ts || null, selfInitiated: h.selfInitiated === true, sourceType: h.sourceType || 'chat' }))
    add('recentInteractions', history, history.map(h => h.messageRef).filter(Boolean))
    if (input.candidate) add('selectedSource', { id: input.candidate.id, text: String(input.candidate.text || '').slice(0, 500), date: input.candidate.date || null,
      fresh: !!input.candidate.fresh, actor: input.candidate.actor || 'unknown', observer: input.candidate.observer || 'unknown', subject: input.candidate.subject || input.candidate.actor || 'unknown', world: input.candidate.world || 'unknown', sourceType: input.candidate.sourceType || input.candidate.source, opportunity: input.candidate.opportunity || null, sourceRefs: input.candidate.sourceKeys || input.candidate.sourceRefs || [] }, input.candidate.sourceKeys || [])
    add('concerns', (ctx.concerns || ctx.platform && ctx.platform.concerns || []).filter(row => keep('concerns', row)).slice(0, 4).map(c => ({ id: c.id, quote: c.quote, status: c.status, nextCheckAt: c.nextCheckAt, expiresAt: c.expiresAt, sourceRefs: c.sourceRefs })))
    add('results', (ctx.actionResults || ctx.platform && ctx.platform.results || []).filter(row => keep('results', row)).slice(-3))
    add('capabilities', (ctx.capabilities || []).slice(0, 6).map(c => ({ id: c.id, effect: c.effect, version: c.version })))
    if (task !== 'M1_short') add('memoryEvidence', (ctx.relevantMemories || ctx.memories || []).filter(row => keep('memoryEvidence', row)).slice(0, 3).map(m => ({ id: m.id, text: String(m.content || m.text || '').slice(0, 200), eventAt: m.eventTime || m.createdAt || m.date || null, sourceRefs: m.evidenceRefs || [] })))
    const pairs = []
    for (let i = 0; i < (input.toolHistory || []).length - 1; i++) {
      const call = input.toolHistory[i], result = input.toolHistory[i + 1]
      if (call.type === 'tool_call' && result.type === 'tool_result' && call.id === result.callId && valid(call) && valid(result)) { pairs.push({ call, result }); i++ }
      else excluded.push({ key: 'toolHistory', reason: 'unpaired_or_invalid' })
    }
    add('toolPairs', pairs.slice(-2))
    return { data, trace: { task, budget, used, selected, excluded: excluded.slice(0, 64) }, text: JSON.stringify(data) }
  }
  return { project, BUDGETS }
})
