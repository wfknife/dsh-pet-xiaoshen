(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.EvidenceClaims = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  const day = ts => { const d = new Date(ts); return [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-') }
  const normalizeDay = value => { const n = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(value || '')); return n ? n.slice(1).map(Number).join('-') : value ? day(value) : null }
  const clean = text => String(text || '').replace(/^(主人说|主人|我|你说)/, '').replace(/这件事.*$|这句话我.*$|，我.*$|。.*$/g, '').replace(/[\s，。！？：、；,.!?;:「」]/g, '')
  function check(text, input = {}) {
    const life = input.life || {}, candidate = input.candidate || {}, now = input.nowTs || Date.now()
    if (/我[^。！？]{0,10}(这两天|这几天|这段时间).{0,12}(也在|一直|翻|整理|做|想)/.test(text)) {
      const days = new Set((life.experiences || []).filter(e => ['started', 'completed', 'resumed'].includes(e.kind)).map(e => normalizeDay(e.day || e.ts)).filter(Boolean))
      if (days.size < 2) return { ok: false, reason: 'self_history_unsupported' }
    }
    const sources = (life.conversations || []).map(t => ({ date: normalizeDay(t.ts), text: t.userText }))
    if (candidate.material && candidate.material.text) sources.push({ date: normalizeDay(candidate.material.date), text: candidate.material.text })
    for (const sentence of String(text).split(/[。！？\n]/).filter(Boolean)) {
      const owner = /(你|主人)(?:今天|昨天|刚才)?(?:跟我)?说(?:过(?:的)?话)?|(?:昨天|今天|刚才)那句话/.exec(sentence)
      if (!owner) continue
      const prefix = sentence.slice(0, owner.index + owner[0].length), dates = prefix.match(/今天|昨天|刚才/g)
      if (!dates || !dates.length) continue
      const want = day(now - (dates.at(-1) === '昨天' ? 86400000 : 0))
      let claim = sentence.slice(owner.index + owner[0].length).replace(/^[过的]*话[—\-：:]*/, '').replace(/^[—\-：:]*/, '')
      claim = clean(claim)
      if (!claim || !sources.some(s => s.date === want && clean(s.text).includes(claim))) return { ok: false, reason: 'owner_time_evidence_unsupported', wantDay: want }
    }
    return { ok: true }
  }
  return { check }
})
