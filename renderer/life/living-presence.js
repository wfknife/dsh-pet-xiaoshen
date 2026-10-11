/* Embodied expression: one local presentation policy, no model calls or owner
 * facts. Animation proposals become experiences only after the player's receipt. */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.LivingPresence = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  const DEFAULT_LINES = {
    idle: [], // Quiet presence is a valid activity. Conversation has its own motives.
    hungry: ['有点饿了，想吃点东西。', '想吃一口米饭。'],
    thirsty: ['想喝点水。'], sad: ['今天想慢一点。'],
    eat: ['这一口不错。', '吃饱了，舒服。'],
    send: ['交给我，我先看看。'], wake: [],
    happy: ['嘿，有点开心。'], surprise: ['咦？'],
    hydrate: ['歇一下，喝口水吧。'],
    levelup: ['又有一点进步了。'], workdone: ['做完了，结果放在这里。'],
    birthday: ['今天是我的生日，想留个小纪念。']
  }
  const ACTIONS = Object.freeze({
    'idle-stretch': '在桌面上伸了个懒腰', 'idle-mirror': '整理了一下自己的装扮',
    'idle-bubbles': '在桌面上玩了一会儿泡泡', 'idle-hum': '轻轻哼了一小段',
    'egg-rubik': '摆弄了一会儿魔方', 'egg-needlework': '做了一会儿小手工',
    'routine-brush': '整理好了自己的仪容', 'perform-dressup': '试了一下自己的装扮',
    'egg-juggling': '练了一小段杂耍'
  })
  const TONES = {
    calm: ['idle-breathe'], warm: ['click-wave', 'happy-sway'],
    thoughtful: ['work-think'], playful: ['click-tsundere', 'idle-bubbles'],
    soft: ['click-shy', 'whisper-idle'], serious: ['whisper-screen', 'idle-breathe']
  }
  function expression(metadata, available) {
    const e = metadata && metadata.expression || {}
    const tone = Object.hasOwn(TONES, e.tone) ? e.tone : 'calm'
    const names = Array.isArray(available) ? available : []
    const requested = typeof e.virtualAction === 'string' && Object.hasOwn(ACTIONS, e.virtualAction) ? e.virtualAction : null
    const pool = requested ? [requested] : TONES[tone]
    return { tone, animation: pool.find(x => names.includes(x)) || null,
      intensity: Math.max(0, Math.min(1, Number(e.intensity) || 0.3)), speechAct: metadata && metadata.speechAct || 'answer' }
  }
  function activityAnimation(life, available) {
    const active = life && (life.activeActivity || (life.activities || []).find(a => a.status === 'active'))
    if (!active) return null
    const mapping = { quiet_rest: ['sleep-nap'], revisit_memory: ['idle-lookaround', 'work-think'],
      chat_notes: ['work-organize'], curiosity_note: ['egg-rubik', 'idle-lookaround'],
      creative_play: ['egg-needlework', 'egg-rubik', 'idle-bubbles'], self_care: ['routine-brush', 'idle-mirror'] }
    return (mapping[active.kind] || []).find(x => available.includes(x)) || null
  }
  function createSession({ now = () => Date.now() } = {}) {
    let lastSpeech = 0, lastUser = 0, ambientCount = 0
    let utterance = null
    const recent = []
    function user() { lastUser = now(); ambientCount = 0 }
    function sameUtterance(source, token, at) { return token !== undefined && utterance && utterance.source === source && utterance.token === token && at - utterance.at < 90000 }
    function canSpeak({ source, text, token, hidden, busy, quietUntil = 0 } = {}) {
      if (source === 'ui' || source === 'character-chat') return { ok: true }
      const at = now()
      if (hidden || busy || quietUntil > at) return { ok: false, reason: 'not_available' }
      if (sameUtterance(source, token, at)) return { ok: true }
      if (at - lastUser < 90000 && lastUser > 0) return { ok: false, reason: 'conversation_settling' }
      if (ambientCount >= 2 || lastSpeech > 0 && at - lastSpeech < 8 * 60000) return { ok: false, reason: 'attention_budget' }
      const key = String(text || '').replace(/[\s，。！？~～…]/g, '')
      if (!key || recent.some(r => r.key === key && at - r.at < 6 * 3600000)) return { ok: false, reason: 'no_new_expression' }
      return { ok: true }
    }
    function spoken(source, text, token) {
      if (source === 'ui') return
      const at = now(), continuation = sameUtterance(source, token, at)
      lastSpeech = at
      if (source !== 'character-chat' && !continuation) ambientCount++
      if (!continuation) utterance = { source, token, at }
      recent.push({ key: String(text || '').replace(/[\s，。！？~～…]/g, ''), at: lastSpeech })
      if (recent.length > 24) recent.shift()
    }
    return { user, canSpeak, spoken, snapshot: () => ({ lastSpeech, lastUser, ambientCount }) }
  }
  return { DEFAULT_LINES, ACTIONS, expression, activityAnimation, createSession }
})
