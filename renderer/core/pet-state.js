/* PetState — Phase 4
 * 先建立面向字段的状态外壳，兼容旧的全局 P。
 * 后续新功能应尽量通过 PetState 读写，最终再逐步迁移旧调用。
 */
window.PetState = (function () {
  // Kernel-owned values are read-only even for an old callback that still holds P.
  // Only apply() can refresh this projection; no arbitrary snapshot is submitted.
  function projection(base) {
    const owned = new Set(['stats','relationship','emotion','affection','coins','exp','level','inventory','daily','photos','achievements','bootCount','streak','lastSeenDate','lastInteractionAt','feedCount','totalGames','totalWorkDone','pomodoros','gameWins','animSeen','bestGameScore','workLog','workMinutes','workSessions','chatCountDay','chatCountToday','memories','diary','diaryOutputs','birthdayCards','lastBirthdayGreeted','lastPetBirthdayGreeted','waterToday','waterDay','clickCount','lastClickAt'])
    const cache = new WeakMap()
    function readonly(value) {
      if (!value || typeof value !== 'object') return value
      if (!cache.has(value)) cache.set(value, new Proxy(value, { get: (o, k) => readonly(o[k]), set: () => true, deleteProperty: () => true, defineProperty: () => false }))
      return cache.get(value)
    }
    return { state: new Proxy(base, { get: (o, k) => owned.has(k) ? readonly(o[k]) : o[k], set: (o, k, v) => { if (!owned.has(k)) o[k] = v; return true } }),
      apply: patch => Object.assign(base, patch) }
  }
  function getPath(obj, path) {
    if (!path) return obj
    return String(path).split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj)
  }
  function setPath(obj, path, value) {
    const parts = String(path).split('.')
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]
      if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {}
      cur = cur[key]
    }
    cur[parts[parts.length - 1]] = value
    return true
  }
  function create(base) {
    return {
      raw: base,
      get(path) { return getPath(base, path) },
      set(path, value) { return setPath(base, path, value) },
      patch(obj) {
        if (!obj || typeof obj !== 'object') return false
        Object.assign(base, obj)
        return true
      },
      snapshot() { return JSON.parse(JSON.stringify(base)) }
    }
  }
  return { create, projection }
})()
