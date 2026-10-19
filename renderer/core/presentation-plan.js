(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.PresentationPlan = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  function create(options = {}) {
    const now = options.now || Date.now, owners = new Map(), recent = []
    let seq = 0, visible = true
    function note(token, phase, detail) {
      const row = { owner: token.owner, token: token.id, channel: token.channel, phase, at: now(), ...detail }
      recent.push(row); if (recent.length > 100) recent.shift()
      if (options.receipt) { try { const p = options.receipt(row); if (p && p.catch) p.catch(() => {}) } catch (_) {} }
    }
    function current(token) { return !!(token && visible && owners.get(token.channel) === token && (!token.isCurrent || token.isCurrent())) }
    function claim(plan) {
      const old = owners.get(plan.channel)
      if (!visible || plan.isCurrent && !plan.isCurrent()) return { ok: false, reason: 'presentation_cancelled' }
      if (old && current(old) && old.priority > plan.priority && !plan.force) return { ok: false, reason: 'presentation_priority' }
      if (old) note(old, 'interrupted', { reason: 'new_owner' })
      const token = { id: ++seq, owner: plan.owner, channel: plan.channel, priority: plan.priority || 0, isCurrent: plan.isCurrent }
      owners.set(plan.channel, token); note(token, 'generated', { semanticId: plan.semanticId || null }); return { ok: true, token }
    }
    function stage(token, phase, detail = {}) {
      if (!['published', 'playback_started', 'playback_completed', 'playback_failed', 'audio_failed'].includes(phase)) return { ok: false, reason: 'presentation_phase' }
      if (!current(token)) return { ok: false, reason: 'stale_presentation' }
      note(token, phase, detail)
      if (['playback_completed', 'playback_failed'].includes(phase)) owners.delete(token.channel)
      return { ok: true }
    }
    return { claim, stage, current, cancel(owner, reason = 'cancelled') { for (const [channel, token] of owners) if (!owner || token.owner === owner) { note(token, 'interrupted', { reason }); owners.delete(channel) } },
      setVisible(value) { visible = !!value; if (!visible) this.cancel(null, 'hidden') }, snapshot: () => ({ visible, owners: [...owners.values()].map(t => ({ owner: t.owner, channel: t.channel, priority: t.priority })), recent: recent.slice() }) }
  }
  return { create }
})
