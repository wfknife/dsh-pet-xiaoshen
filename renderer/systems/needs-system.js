/* NeedsSystem — Phase 8
 * 统一负责 satiety / thirst / energy / mood 随时间变化。
 */
window.NeedsSystem = (function () {
  function decay(P, elapsedMin, ctx) {
    const c = ctx || {}
    const sleepy = !!c.sleepy
    const running = !!c.running
    const resting = !!c.resting
    const clamp = (v) => Math.min(100, Math.max(0, v))
    // Rest and a visible nap recover energy; an external agent running is activity,
    // not an energy source. Manual timed rest retains its existing caller branch.
    P.stats.satiety = clamp(P.stats.satiety - (resting ? 0.12 : 0.22) * elapsedMin)
    P.stats.mood = clamp(P.stats.mood + (resting ? 0.6 : sleepy ? 0.1 : -0.15) * elapsedMin)
    P.stats.energy = clamp(P.stats.energy + (resting ? 0.8 : sleepy ? 0.6 : running ? -0.3 : -0.2) * elapsedMin)
    P.stats.thirst = clamp(P.stats.thirst - (resting ? 0.12 : 0.18) * elapsedMin)
    return P.stats
  }

  return { decay }
})()
