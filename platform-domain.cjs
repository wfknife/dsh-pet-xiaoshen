'use strict'
const { digest } = require('./platform-store.cjs')
const topicKey = text => String(text || '').replace(/[\s，。！？：、；,.!?;:]/g, '').slice(0, 80)
function createDomain(store, options = {}) {
  const now = options.now || Date.now
  function observeFact(ref) {
    const op = store.operation('fact:' + ref), src = store.source(ref)
    if (!op || op.status !== 'completed' || !src) return { ok: false, reason: 'fact_not_completed' }
    const memory = op.input.eligibleMemory === false ? null : op.input.memory
    if (!memory || typeof memory.quote !== 'string' || !src.text.includes(memory.quote) || memory.quote.length < 4) return { ok: true, empty: true }
    return store.transaction(s => {
      const id = 'appraisal:' + ref
      if (s.appraisals[id]) return { ok: true, duplicate: true }
      const object = ['preference', 'dislike'].includes(memory.kind) && /(?:喜欢|讨厌|爱喝|爱吃)\s*([^。！？；，,\n]{2,60})/.exec(memory.quote)
      const key = topicKey(object ? object[1].replace(/了$/, '') : memory.topic || memory.label || memory.quote), prior = Object.values(s.appraisals).filter(a => a.key === key && a.status === 'active')
      const correction = memory.kind === 'dislike' || /其实|改了|不再|不要|别再|取消|不想/.test(src.text)
      const row = { id, key, kind: memory.kind, quote: memory.quote.slice(0, 240), sourceRefs: [ref], eventAt: src.ts, committedAt: now(), status: 'active',
        interpretation: ['preference', 'dislike'].includes(memory.kind) ? 'explicit_preference' : 'concern_evidence', relationDelta: 0 }
      if (row.interpretation === 'explicit_preference') row.expiresAt = src.ts + 180 * 86400000
      s.appraisals[id] = row
      const newerCorrection = prior.find(a => a.eventAt > src.ts)
      if (newerCorrection) { row.status = 'superseded'; row.supersededBy = newerCorrection.id; return { ok: true, ignoredLateInterpretation: true } }
      if (correction || ['preference', 'dislike'].includes(memory.kind)) prior.filter(a => correction || a.interpretation === 'explicit_preference').forEach(a => { a.status = 'superseded'; a.supersededBy = id })
      if (memory.kind === 'plan' && src.ts + 7 * 86400000 > now()) {
        const existing = Object.values(s.concerns).find(c => c.key === key && c.status === 'open')
        if (!existing && Object.values(s.concerns).filter(c => c.status === 'open').length < 4) s.concerns['concern:' + ref] = {
          id: 'concern:' + ref, key, quote: row.quote, sourceRefs: [ref], eventAt: src.ts, status: 'open', nextCheckAt: Math.max(src.ts + 3600000, now()), expiresAt: src.ts + 7 * 86400000,
          exitCondition: 'user_cancel_or_resolve_or_expiry', lastPresentedAt: 0 }
        if (/小记|笔记|作品|故事|整理/.test(memory.quote) && Object.values(s.projects).filter(p => ['planned', 'active', 'paused'].includes(p.status)).length < 2) {
          const pid = 'project:' + ref
          s.projects[pid] = { id: pid, key, sourceRefs: [ref], quote: row.quote, status: 'planned', virtual: true, step: 0, results: [], createdAt: now(), expiresAt: src.ts + 7 * 86400000 }
        }
      }
      if (correction || memory.kind === 'resolved') for (const c of Object.values(s.concerns)) if (c.key === key || c.quote.includes(memory.topic || '\0')) {
        c.status = memory.kind === 'resolved' ? 'resolved' : 'cancelled'; c.closedAt = now(); c.correctionRef = ref
      }
      if (correction) for (const p of Object.values(s.projects)) if (p.key === key && p.status !== 'completed') { p.status = 'abandoned'; p.correctionRef = ref }
      return { ok: true, appraisalId: id }
    }, 'appraisal')
  }
  function projection() {
    const s = store.snapshot(), ts = now()
    return { concerns: Object.values(s.concerns).filter(c => c.status === 'open' && c.expiresAt > ts).slice(0, 4),
      projects: Object.values(s.projects).filter(p => ['planned', 'active', 'paused'].includes(p.status) && p.expiresAt > ts && !(p.nextCheckAt > ts)).slice(0, 2),
      preferences: Object.values(s.appraisals).filter(a => a.interpretation === 'explicit_preference' && a.status === 'active' && (!a.expiresAt || a.expiresAt > ts)).slice(-12),
      results: Object.values(s.operations).filter(o => o.type === 'action' && o.status === 'completed' && o.effect !== 'read').slice(-4).map(o => ({ id: o.id, capabilityId: o.capabilityId, effect: o.effect, eventAt: o.updatedAt, receipt: o.receipt, sourceRefs: o.sourceRefs })) }
  }
  function select(candidates, policy = {}) {
    const ts = now(), s = store.snapshot(), p = projection(), excluded = []
    if (policy.busy || policy.hidden || policy.quietUntil > ts || ts - s.policy.lastAutomatic < 600000) return { selected: null, reason: 'availability_or_shared_budget', excluded }
    const unique = new Map()
    for (const c of candidates.slice(0, 40)) {
      let reason = c.expiresAt && c.expiresAt <= ts ? 'expired' : (c.sourceRefs || []).some(r => store.deleted(r)) ? 'source_deleted' :
        c.capabilityId && !(policy.capabilities || []).some(a => a.id === c.capabilityId) ? 'capability_unavailable' : null
      const negative = p.preferences.find(a => a.kind === 'dislike' && topicKey(c.topic || c.text).includes(a.key))
      if (negative) reason = 'explicit_dislike:' + negative.id
      if (reason) { excluded.push({ id: c.id, reason }); continue }
      const key = c.coalesceKey || c.id, positive = p.preferences.find(a => a.kind === 'preference' && topicKey(c.topic || c.text).includes(a.key))
      const score = Math.min(10, c.priority || 0) + (positive ? 2 : 0)
      if (!unique.has(key) || unique.get(key).score < score) unique.set(key, { candidate: c, score, evidence: positive && positive.id || null })
    }
    const sorted = [...unique.values()].sort((a, b) => b.score - a.score || String(a.candidate.id).localeCompare(String(b.candidate.id)))
    return sorted.length ? { selected: sorted[0].candidate, score: sorted[0].score, evidence: sorted[0].evidence,
      ranked: sorted.slice(0, 6).map(r => ({ id: r.candidate.id, score: r.score, evidence: r.evidence })), excluded } : { selected: null, reason: 'no_legal_opportunity', ranked: [], excluded }
  }
  function presented(id) {
    return store.transaction(s => { s.policy.lastAutomatic = now(); if (s.concerns[id]) { s.concerns[id].lastPresentedAt = now(); s.concerns[id].nextCheckAt = now() + 86400000 }; return { ok: true } }, 'attention_delivery')
  }
  function stepProject(id, operationId) {
    const op = store.operation(operationId)
    if (!op || op.status !== 'dispatched' || op.capabilityId !== 'life.virtual-project') return { ok: false, reason: 'project_authorization' }
    return store.transaction(s => {
      const p = s.projects[id]
      if (!p || !['planned', 'active', 'paused'].includes(p.status) || p.expiresAt <= now() || p.sourceRefs.some(r => store.deleted(r))) return { ok: false, reason: 'project_unavailable' }
      if (p.results.some(r => r.operationId === operationId)) return { ok: true, value: p.results.find(r => r.operationId === operationId) }
      const src = s.sources[p.sourceRefs[0]]
      if (!src) return { ok: false, reason: 'project_source_missing' }
      const result = { operationId, step: p.step + 1, virtual: true, scope: 'virtual_material', quotedRole: 'user', ownerTaskCompleted: false,
        kind: p.step === 0 ? 'material_selected' : 'virtual_notebook', text: src.text.slice(0, 240), sourceRefs: p.sourceRefs, eventAt: now(), hash: digest(src.text.slice(0, 240)) }
      p.results.push(result); p.step++; p.status = p.step >= 2 ? 'completed' : 'paused'; p.lastOperationId = operationId
      if (p.status === 'completed') p.completedAt = now()
      return { ok: true, value: result }
    }, 'project_step')
  }
  function reconcileLife(life, correctionRef) {
    const updates = (life.threads || []).filter(t => t.lastMessageRef === correctionRef && ['resolved', 'cancelled'].includes(t.status) || t.lastMessageRef === correctionRef && t.deferUntil)
    if (!updates.length) return { ok: true, empty: true }
    return store.transaction(s => {
      for (const thread of updates) for (const concern of Object.values(s.concerns)) if (concern.sourceRefs.includes(thread.messageRef)) {
        concern.sourceRefs = [...new Set(concern.sourceRefs.concat(correctionRef))]
        if (thread.deferUntil && thread.status === 'open') concern.nextCheckAt = thread.deferUntil
        else { concern.status = thread.status; concern.closedAt = now(); concern.correctionRef = correctionRef }
        for (const project of Object.values(s.projects)) if (project.sourceRefs.includes(thread.messageRef) && project.status !== 'completed') {
          project.sourceRefs = [...new Set(project.sourceRefs.concat(correctionRef))]
          project.status = thread.status === 'open' ? 'paused' : 'abandoned'; project.nextCheckAt = thread.deferUntil || null
        }
      }
      return { ok: true }
    }, 'life_concern_reconciliation')
  }
  return { observeFact, projection, select, presented, stepProject, reconcileLife }
}
module.exports = { createDomain, topicKey }
