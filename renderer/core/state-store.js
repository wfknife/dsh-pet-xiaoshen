/* StateStore — Phase 9
 * Renderer 侧持久化边界。底层仍走主进程 IPC；
 * 主进程已有 atomic save / field protection / backup，
 * 这里补充 schemaVersion、migrate 和基础 validate。
 */
window.StateStore = (function () {
  const SCHEMA_VERSION = 1

  function migrate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw || {}
    const out = { ...raw }
    if (typeof out.schemaVersion !== 'number') out.schemaVersion = SCHEMA_VERSION
    // 未知字段保留，不静默丢弃。
    // RelationshipState 由 RelationshipEngine 负责迁移/写入，StateStore 不直接修改它。
    return out
  }

  function validate(state) {
    const issues = []
    if (!state || typeof state !== 'object') issues.push('state is not object')
    if (state.stats && typeof state.stats === 'object') {
      for (const k of ['satiety', 'thirst', 'energy', 'mood']) {
        const v = state.stats[k]
        if (typeof v !== 'number' || Number.isNaN(v)) issues.push('stats.' + k + ' invalid')
      }
    } else {
      issues.push('stats missing')
    }
    if (typeof state.coins !== 'number') issues.push('coins not number')
    if (typeof state.level !== 'number') issues.push('level not number')
    if (state.diary && !Array.isArray(state.diary)) issues.push('diary not array')
    return issues
  }

  async function load() {
    const raw = await window.pet.stateLoad()
    const state = migrate(raw)
    return {
      state,
      issues: validate(state),
      schemaVersion: state.schemaVersion || SCHEMA_VERSION
    }
  }

  function save(state) {
    const safe = migrate(state)
    return window.pet.stateSave(safe)
  }

  return { SCHEMA_VERSION, migrate, validate, load, save }
})()
