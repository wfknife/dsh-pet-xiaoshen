/* BehaviorDirector — Phase 7
 * 第一阶段：把“状态 → 选哪个动画”的选择逻辑从 pet.js 抽出来。
 * 之后会继续扩展：Preconditions / Priority / Weight / Cooldown / Sequence / Dialogue / Memory。
 */
window.BehaviorDirector = (function () {
  let currentBehavior = 'idle'
  let activeIntentKind = null

  function selectFromPool(pool, opts) {
    const options = opts || {}
    if (!Array.isArray(pool) || !pool.length) return ''
    const now = Date.now()
    const cooldown = Number(options.cooldown) || 0
    let sawBlocked = false, sawNovelty = false
    let candidates = pool.map((anim) => {
      const custom = options.weight && options.weight[anim] != null ? Number(options.weight[anim]) : 1
      const historyRemain = window.AnimationHistory ? window.AnimationHistory.cooldownRemaining(anim, cooldown) : 0
      const novelty = window.AnimationHistory ? window.AnimationHistory.noveltyMultiplier(anim) : 1
      if (historyRemain > 0) sawBlocked = true
      else if (novelty !== 1) sawNovelty = true
      const weight = historyRemain > 0 ? 0 : Math.max(0.01, custom * novelty)
      return { anim, weight }
    })
    const usable = candidates.filter((c) => c.weight > 0)
    if (!usable.length) candidates = pool.map((anim) => {
      const novelty = window.AnimationHistory ? window.AnimationHistory.noveltyMultiplier(anim) : 1
      return { anim, weight: Math.max(0.01, novelty) }
    })
    else candidates = usable
    let total = 0
    for (const c of candidates) total += c.weight
    let r = Math.random() * total
    for (const c of candidates) {
      r -= c.weight
      if (r <= 0) return c.anim
    }
    return candidates[candidates.length - 1].anim
  }

  function chooseFromContent(key, ctx) {
    const c = window.BehaviorContent || {}
    let node = c
    for (const part of String(key || '').split('.')) node = node && node[part]
    if (!node || !Array.isArray(node.pool) || !node.pool.length) return ''
    const vals = node.cooldowns ? Object.values(node.cooldowns) : []
    const pick = selectFromPool(node.pool, { weight: node.weights || undefined, cooldown: vals.length ? Math.max(0, ...vals) : 0 })
    if (window.DevStats) {
      window.DevStats.recordBehavior(key)
      window.DevStats.recordAnimation(pick, { noveltyApplied: !!(window.AnimationHistory && window.AnimationHistory.get(pick)) })
    }
    return pick
  }

  function pickStateAnimation(mood, ctx) {
    const groups = (ctx && ctx.groups) || {}
    let group = groups[mood] || groups.idle || []
    const rnd = (ctx && ctx.random) || Math.random
    if (mood === 'working') group = group.filter(n => n !== 'work-wait' && n !== 'work-organize')
    if (mood === 'working' && ctx && ctx.organizing) group = ['work-organize']
    if (mood === 'working' && ctx && ctx.waiting) group = ['work-wait']
    // A completed clip chooses a different candidate in the same real state.
    if (ctx && ctx.previous && group.length > 1) group = group.filter(n => n !== ctx.previous)
    if (Array.isArray(group) && group.length) {
      return group[Math.floor(rnd() * group.length)]
    }
    return (ctx && ctx.idleMain) || 'idle-breathe'
  }

  function ambientPool(ctx) {
    const r = (ctx && ctx.R) || {}, s = (ctx && ctx.P && ctx.P.stats) || {}
    if (r.running || r.dragging || r.hidden || r.sleepy || r.chatOpen || r.busy) return []
    if (s.energy < 25) return ['tired-yawn', 'idle-stretch', 'whisper-idle']
    if (s.thirst < 30) return ['idle-lookaround', 'whisper-idle']
    if (s.satiety < 30) return ['word-whattoeat', 'whisper-idle']
    if (s.mood < 30) return ['whisper-idle', 'idle-breathe']
    const pool = ['idle-lookaround', 'idle-mirror', 'idle-stretch', 'whisper-idle', 'whisper-screen', 'whisper-clean', 'perform-dressup']
    if (s.energy >= 60 && s.mood >= 60) pool.push('idle-hum', 'idle-bubbles', 'egg-rubik', 'egg-needlework', 'egg-juggling', 'happy-sway')
    const hour = ctx && Number.isFinite(ctx.hour) ? ctx.hour : new Date().getHours()
    if (hour >= 6 && hour < 10 && s.energy >= 25) pool.push('routine-brush')
    return pool
  }

  function clickAnimation(ctx) {
    const s = (ctx && ctx.P && ctx.P.stats) || {}, n = Number(ctx && ctx.count) || 1
    if (s.energy < 25) return 'click-shy'
    if (n >= 5) return 'click-tickle'
    if (n >= 3) return 'click-tsundere'
    return selectFromPool(['click-wave', 'click-shy'], { cooldown: 15000 })
  }

  function setCurrent(behavior) {
    currentBehavior = behavior || 'idle'
    return currentBehavior
  }

  function getCurrent() {
    return currentBehavior
  }

  function intentToMood(kind) {
    switch (kind) {
      case 'rest': return 'sleepy'
      case 'celebrate': return 'happy'
      case 'tease_owner': return 'happy'
      case 'respond_to_event':
      case 'comfort_owner':
      case 'seek_attention':
      case 'accompany_owner':
      case 'comment_on_activity':
      case 'observe_owner':
      case 'idle':
      default:
        return 'idle'
    }
  }

  function setActiveIntent(snapshot) {
    activeIntentKind = snapshot && snapshot.activeKind ? snapshot.activeKind : null
    return activeIntentKind
  }

  function getActiveIntent() { return activeIntentKind }

  function planForIntent(snapshot) {
    const kind = snapshot && snapshot.activeKind ? snapshot.activeKind : null
    if (!kind) {
      return { ok: false, reason: 'no_active_intent', intentKind: null, behavior: null, fallback: null }
    }
    const intentContent = window.BehaviorContent && window.BehaviorContent.intent
      ? window.BehaviorContent.intent[kind]
      : null
    if (!intentContent || !Array.isArray(intentContent.pool) || !intentContent.pool.length) {
      // Safe 2.0 compatibility fallback, explicitly marked; does not create a second
      // high-level decision because the fallback is derived from the same active Intent.
      return {
        ok: true,
        intentKind: kind,
        behavior: null,
        fallback: {
          reason: 'no_dedicated_behavior_content',
          mood: intentToMood(kind),
          legacyOnly: true
        }
      }
    }
    const cooldowns = intentContent.cooldowns ? Object.values(intentContent.cooldowns) : []
    const picked = selectFromPool(intentContent.pool, {
      weight: intentContent.weights || undefined,
      cooldown: cooldowns.length ? Math.max(0, ...cooldowns) : 0
    })
    if (!picked) {
      return {
        ok: true,
        intentKind: kind,
        behavior: null,
        fallback: {
          reason: 'no_available_candidate_after_cooldown',
          mood: intentToMood(kind),
          legacyOnly: true
        }
      }
    }
    return {
      ok: true,
      intentKind: kind,
      behavior: {
        key: 'intent.' + kind,
        candidate: picked,
        mode: 'once',
        contentKey: kind
      },
      fallback: null,
      legacyOnly: false
    }
  }

  function reconsider(ctx) {
    const c = ctx || {}
    const R = c.R || {}
    if (activeIntentKind && activeIntentKind !== 'idle') {
      return { mood: intentToMood(activeIntentKind) }
    }
    if (R.running) return { mood: 'working' }
    return { mood: 'idle' }
  }

  return { ambientPool, clickAnimation, pickStateAnimation, selectFromPool, chooseFromContent, setCurrent, getCurrent, setActiveIntent, getActiveIntent, planForIntent, getPlan: planForIntent, intentToMood, reconsider }
})()
