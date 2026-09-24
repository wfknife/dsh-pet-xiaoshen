/* AnimationHistory — Phase 14
 * 记录每个动画的 firstSeen / lastSeen / count / recent，
 * 为 weighted candidate selection 提供新鲜度与去重依据。
 */
window.AnimationHistory = (function () {
  const map = {}
  const recent = []

  function note(name) {
    if (!name) return
    const now = Date.now()
    const h = map[name] || { firstSeen: now, lastSeen: 0, count: 0 }
    h.lastSeen = now
    h.count += 1
    map[name] = h
    const idx = recent.indexOf(name)
    if (idx >= 0) recent.splice(idx, 1)
    recent.push(name)
    if (recent.length > 50) recent.shift()
  }

  function get(name) { return map[name] ? { ...map[name] } : null }
  function has(name) { return !!map[name] }

  function noveltyMultiplier(name) {
    const h = get(name)
    if (!h) return 1.3 // 从未出现：小幅加权
    const now = Date.now()
    const age = now - h.lastSeen
    if (age < 60000) return 0.4 // 刚看过：降低权重
    if (age < 600000) return 0.7
    if (h.count <= 1) return 1.2
    return 1.0
  }

  function cooldownRemaining(name, cooldownMs) {
    const h = get(name)
    if (!h || !cooldownMs) return 0
    const remain = cooldownMs - (Date.now() - h.lastSeen)
    return remain > 0 ? remain : 0
  }

  function reset() {
    for (const k of Object.keys(map)) delete map[k]
    recent.length = 0
  }

  return { note, get, has, noveltyMultiplier, cooldownRemaining, reset }
})()
