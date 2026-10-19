/* V0.1 selects prompt references only; it never reads or rewrites dialogue. */
(function (root) {
  'use strict'
  const STAGES = { M1_reply: 'reply_v01', M2_say: 'proactive_v01' }

  function createPolicy(loadResources) {
    const ready = Promise.resolve().then(loadResources).then(({ rules, profiles }) => {
      if (rules.schema !== 1 || profiles.schema !== 1 || !Array.isArray(rules.rules) || rules.rules.length !== 7) throw Error('invalid rules')
      const ids = new Set(rules.rules.map(r => r.id))
      if (ids.size !== 7 || rules.rules.some(r => !/^ESL-00[1-7]$/.test(r.id))) throw Error('invalid rule ids')
      if (!profiles.profiles || Object.keys(profiles.profiles).length !== 2) throw Error('invalid profiles')
      const selected = {}
      for (const [stage, profile] of Object.entries(STAGES)) {
        const p = profiles.profiles[profile]
        if (!p || p.stage !== stage || typeof p.promptId !== 'string' || !p.promptId.trim() ||
            !Array.isArray(p.rules) || p.rules.length !== 7 || new Set(p.rules).size !== 7 || p.rules.some(id => !ids.has(id))) throw Error('invalid profile')
        selected[stage] = Object.freeze({ profile, promptId: p.promptId })
      }
      return Object.freeze(selected)
    }).catch(() => null)
    return Object.freeze({
      async select(stage) {
        if (!Object.prototype.hasOwnProperty.call(STAGES, stage)) return null
        const selected = await ready
        return selected ? selected[stage] : null
      }
    })
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createPolicy }
  } else {
    const scriptUrl = document.currentScript && document.currentScript.src
    root.ExpressionStylePolicy = createPolicy(async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      try {
        const read = async name => {
          const response = await root.fetch(new URL(name, scriptUrl), { signal: controller.signal })
          if (!response.ok) throw Error('style resource unavailable')
          return response.json()
        }
        const [rules, profiles] = await Promise.all([read('rules.json'), read('profiles.json')])
        return { rules, profiles }
      } finally { clearTimeout(timeout) }
    })
  }
})(typeof window !== 'undefined' ? window : this)
