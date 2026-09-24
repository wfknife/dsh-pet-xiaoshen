/* DevStats — Phase 15 */
window.DevStats = (function () {
  const anim = {}
  const behaviors = {}
  let cooldownBlocks = 0
  let noveltyAdjustments = 0

  function recordAnimation(name, meta) {
    if (!name) return
    const a = anim[name] || { count: 0, cooldownBlocks: 0, noveltyAdjustments: 0 }
    a.count++
    if (meta && meta.cooldownBlocked) { a.cooldownBlocks++; cooldownBlocks++ }
    if (meta && meta.noveltyApplied) { a.noveltyAdjustments++; noveltyAdjustments++ }
    anim[name] = a
  }

  function recordCooldownBlock() { cooldownBlocks++ }
  function recordNoveltyAdjustment() { noveltyAdjustments++ }

  function recordBehavior(id) {
    if (id) behaviors[id] = (behaviors[id] || 0) + 1
  }

  function getStats() {
    return { animations: anim, behaviors, cooldownBlocks, noveltyAdjustments }
  }

  function reset() {
    for (const k of Object.keys(anim)) delete anim[k]
    for (const k of Object.keys(behaviors)) delete behaviors[k]
    cooldownBlocks = 0
    noveltyAdjustments = 0
  }

  return { recordAnimation, recordBehavior, recordCooldownBlock, recordNoveltyAdjustment, getStats, reset }
})()
