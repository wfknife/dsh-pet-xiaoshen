/* RelationshipSystem — 2.0 compatibility facade
 * Now delegates all writes and reads to RelationshipEngine (3.0-03).
 * Existing callers of RelationshipSystem.get/add/tier continue to work.
 */
window.RelationshipSystem = (function () {
  function engine() {
    return window.RelationshipEngine || null
  }

  function add(P, amount) {
    const e = engine()
    if (e && typeof e.addAffection === 'function') {
      return e.addAffection(P, amount, { source: 'relationship-system', kind: 'legacy_affection', ruleId: 'REL-LEGACY-AFFECTION' })
    }
    // Engine is loaded before this facade in normal index order.
    return (P && P.affection) || 0
  }

  function tier(P) {
    const e = engine()
    if (e && typeof e.deriveTier === 'function') {
      const s = e.get(P)
      return s && typeof s.tier === 'number' ? s.tier : e.deriveTier(P && P.affection)
    }
    const a = (P && P.affection) || 0
    if (a < 25) return 0
    if (a < 50) return 1
    if (a < 75) return 2
    return 3
  }

  function get(P) {
    const e = engine()
    if (e && typeof e.get === 'function') return e.get(P)
    const a = (P && P.affection) || 0
    return { affection: a, tier: tier(P) }
  }

  return { add, tier, get }
})()
