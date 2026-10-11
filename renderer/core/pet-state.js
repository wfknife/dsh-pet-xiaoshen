/* PetState — Phase 4
 * 先建立面向字段的状态外壳，兼容旧的全局 P。
 * 后续新功能应尽量通过 PetState 读写，最终再逐步迁移旧调用。
 */
window.PetState = (function () {
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
  return { create }
})()
