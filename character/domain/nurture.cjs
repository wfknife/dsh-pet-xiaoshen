'use strict'
const { ITEMS, WORK_JOBS, LEVELS, AFF_LEVELS, ACHIEVEMENTS, photoDefinitions } = require('../../renderer/systems/nurture-rules.js')
const reducer = require('./reducer.cjs')
const clamp = value => Math.min(100, Math.max(0, Number(value) || 0))
function apply(state, action, now, random = Math.random) {
  let next = structuredClone(state)
  const n = next.nurture, legacy = next.legacyUnmapped || {}, events = []
  for (const key of ['inventory','daily','photos','achievements','workLog','workMinutes','workSessions','bestGameScore','gameWins','animSeen','streak','lastSeenDate','lastInteractionAt','lastPetBirthdayGreeted','lastBirthdayGreeted','birthdayCards']) {
    if (n[key] === undefined && legacy[key] !== undefined) n[key] = structuredClone(legacy[key])
  }
  n.inventory ||= { cookie: 3, drink: 0, toy: 0, feast: 0 }
  n.photos ||= {}; n.achievements ||= []; n.workLog ||= []; n.level ||= 1
  n.workMinutes ||= 0; n.workSessions ||= 0
  n.gameWins ||= []; n.animSeen ||= []
  const day = ts => { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() }
  const today = day(now), yesterday = day(new Date(new Date(now).setDate(new Date(now).getDate() - 1)).getTime())
  if (n.daily?.date !== today) {
    const streak = n.daily?.lastSign === yesterday ? (n.daily.signStreak || 0) + 1 : 1
    n.daily = { date: today, lastSign: today, signStreak: streak, tasks: ['chat','game','work'].map(id => ({ id, label: id, done: false })) }
    n.coins += Math.min(5 + streak * 5, 50)
  }
  if (n.lastSeenDate !== reducer.localDateKey(now)) {
    n.streak = n.lastSeenDate === reducer.localDateKey(now - 86400000) ? (n.streak || 0) + 1 : 1
    n.lastSeenDate = reducer.localDateKey(now)
    if (n.bootCount > 0) n.photos['morning-first'] = { ts: now }
  }
  function affection(amount) {
    next.relationship = reducer.applyRelationshipEvent(next, { eventId: action.commandId + ':aff:' + amount, source: 'pet-legacy', kind: 'legacy_affection', ts: now, delta: { affection: amount } }).state.relationship
  }
  function daily(id) {
    const task = n.daily.tasks.find(task => task.id === id)
    if (!task || task.done) return
    task.done = true
    if (n.daily.tasks.every(task => task.done)) { n.coins += 10; affection(1); n.photos['daily-summary'] ||= { ts: now } }
  }
  const fail = reason => ({ ok: false, reason })
  function exp(amount) {
    const before = n.level
    n.exp = (n.exp || 0) + amount
    n.level = Math.max(1, LEVELS.filter(level => n.exp >= level.exp).length)
    for (let level = before + 1; level <= n.level; level++) n.coins += 10 + level * 5
    if (n.level > before) next.needs.mood = clamp(next.needs.mood + 6)
  }
  function workReward(job) {
    const tier = Math.max(0, AFF_LEVELS.filter(level => next.relationship.affection >= level.min).length - 1)
    return Math.max(1, Math.round(job.reward * (1 + Math.max(0, n.level - 1) * 0.02 + tier * 0.05 +
      (next.needs.mood >= 75 ? 0.1 : next.needs.mood < 30 ? -0.1 : 0))))
  }
  function settleWork(early) {
    const work = n.work, job = WORK_JOBS.find(item => item.id === work.id)
    const ratio = Math.min(1, work.elapsedMs / (job.minutes * 60000))
    const coins = early ? Math.max(1, Math.round(workReward(job) * ratio * 0.5)) : workReward(job)
    const minutes = early ? Math.round(ratio * job.minutes) : job.minutes
    n.coins += coins; n.workMinutes += minutes; n.workSessions++; n.totalWorkDone++
    n.workLog.push({ date: reducer.localDateKey(now), id: job.id, name: job.name, coins, minutes, ts: now })
    n.workLog = n.workLog.slice(-50)
    daily('work'); n.lastInteractionAt = now
    n.photos['first-day'] ||= { ts: now }
    if (minutes >= 30) n.photos['hard-coding'] ||= { ts: now }
    events.push({ kind: 'work.completed', world: 'virtual', actor: 'character', observer: 'system', subject: 'character', jobId: job.id, coins, minutes, runId: work.runId })
    n.work = null
  }
  const date = new Date(now), birthday = String(next.preferences?.ownerBirthday || legacy.ownerBirthday || '').split('-').map(Number)
  for (const [who, due, marker, coins, mood, energy] of [
    ['character', date.getMonth() === 6 && date.getDate() === 17, 'lastPetBirthdayGreeted', 20, 15, 10],
    ['owner', date.getMonth() + 1 === birthday[1] && date.getDate() === birthday[2], 'lastBirthdayGreeted', 30, 10, 0],
  ]) if (due && n[marker] !== reducer.localDateKey(now)) {
    n[marker] = reducer.localDateKey(now); n.coins += coins; next.needs.mood = clamp(next.needs.mood + mood); next.needs.energy = clamp(next.needs.energy + energy)
    affection(5); n.photos[who === 'owner' ? 'owner-birthday' : 'pet-birthday'] ||= { ts: now }
    if (who === 'owner') {
      n.birthdayCards ||= []
      if (!n.birthdayCards.some(card => card.date === today)) n.birthdayCards.push(require('../../renderer/birthday-card-data.js').makeCard({ ...legacy, ...next.preferences, ...n, name: next.displayName || legacy.name, affection: next.relationship.affection }, today))
    }
    events.push({ kind: 'calendar.celebration', actor: 'character', observer: 'system', subject: who, world: 'virtual', runId: 'birthday:' + who + ':' + reducer.localDateKey(now) })
  }
  switch (action.kind) {
    case 'boot': n.bootCount++; n.photos['first-meet'] ||= { ts: now }; break
    case 'sign': break // the established automatic daily sign-in is idempotent above
    case 'chat': daily('chat'); n.lastInteractionAt = now; n.chatCountToday = n.chatCountDay === today ? (n.chatCountToday || 0) + 1 : 1; n.chatCountDay = today; break
    case 'touch':
      n.lastInteractionAt = now
      if (action.gesture === 'pet_click') {
        n.clickCount = now - (n.lastClickAt || 0) < 2000 ? (n.clickCount || 1) + 1 : 1
        n.lastClickAt = now
        if (n.clickCount >= 5) n.photos['shy-whale'] ||= { ts: now }
        else if (n.clickCount >= 3) n.photos['tsundere-3'] ||= { ts: now }
        else if (n.clickCount === 1) n.photos['head-pat'] ||= { ts: now }
      }
      break
    case 'water_drink': n.waterToday = n.waterDay === today ? (n.waterToday || 0) + 1 : 1; n.waterDay = today; next.needs.mood = clamp(next.needs.mood + 2); exp(2); n.photos['tea-serve'] ||= { ts: now }; break
    case 'animation_completed': if (!n.animSeen.includes(action.name)) n.animSeen.push(action.name); break
    case 'focus_start': n.focus = { mode: action.mode === 'break' ? 'break' : 'study', remainingMs: action.mode === 'break' ? 300000 : 1500000, paused: false }; break
    case 'focus_pause': if (n.focus) n.focus.paused = true; break
    case 'focus_resume': if (n.focus) n.focus.paused = false; break
    case 'game': {
      const game = action.game || {}, score = Math.max(0, Number(game.score) || 0), won = game.won === true
      let reward = 0, xp = 5
      if (['catch','snake'].includes(game.gameId)) { reward = won ? Math.floor(score / 2) : 0; if (game.gameId === 'catch') n.bestGameScore = Math.max(n.bestGameScore || 0, score) }
      else if (game.gameId === 't2048') reward = score >= 2048 ? 100 : score >= 1024 ? 50 : score >= 512 ? 25 : score >= 256 ? 15 : score >= 128 ? 8 : 0
      else if (game.gameId === 'guess') { reward = won ? 10 : 0; xp = won ? 5 : 0 }
      else if (game.gameId === 'ttt') reward = won ? 10 : game.draw === true ? 2 : 0
      else if (game.gameId === 'gomoku') { reward = won ? 15 : game.draw === true ? 5 : 0; xp = won ? 2 : 0 }
      else if (game.gameId === 'sudoku') { reward = won ? ({ easy: 30, mid: 60, hard: 120 }[game.level] || 30) : 0; xp = won ? 6 : 0 }
      else if (game.gameId === 'mines') {
        const level = { easy: [20,10], mid: [45,40], hard: [90,99] }[game.level]
        if (!level || !won) return fail('game_result_invalid')
        reward = level[0] + Math.max(0, Math.floor(level[1] * 10 / Math.max(1, Number(game.elapsedSeconds) || 1))); xp = 2
      }
      else return fail('game_rule_not_migrated')
      if (game.gameId !== 'gomoku' || won) n.totalGames++
      n.coins += reward; exp(xp)
      if (reward || (won && ['catch','snake'].includes(game.gameId))) { daily('game'); affection(1); n.photos['first-game'] ||= { ts: now }; n.lastInteractionAt = now }
      const milestone = game.gameId === 'snake' ? score >= 30 : game.gameId === 't2048' ? score >= 512 : won
      if (milestone && !n.gameWins.includes(game.gameId)) n.gameWins.push(game.gameId)
      const photo = { guess: 'guess-win', gomoku: 'gomoku-win', sudoku: 'sudoku-master', mines: 'mines-clear' }[game.gameId]
      if (won && photo) n.photos[photo] ||= { ts: now }
      if (game.gameId === 'snake' && score >= 30) n.photos['snake-king'] ||= { ts: now }
      if (game.gameId === 't2048' && score >= 512) n.photos['t2048-master'] ||= { ts: now }
      break
    }
    case 'buy': {
      const item = ITEMS[action.item]
      if (!item || n.coins < item.price) return fail('purchase_unavailable')
      n.coins -= item.price; n.inventory[action.item] = (n.inventory[action.item] || 0) + 1; break
    }
    case 'feed':
    case 'use_item': {
      const key = action.kind === 'feed' ? 'cookie' : action.item, item = ITEMS[key]
      if (!item || !(n.inventory[key] > 0)) return fail('item_unavailable')
      n.inventory[key]--
      if (key === 'blindbox') {
        const roll = random()
        if (roll < 0.3) n.coins += 5 + Math.floor(random() * 16)
        else if (roll < 0.6) for (const stat of ['satiety','mood','energy']) next.needs[stat] = clamp(next.needs[stat] + 15)
        else if (roll < 0.8) { const stat = ['satiety','mood','energy'][Math.floor(random() * 3)]; next.needs[stat] = clamp(next.needs[stat] - 10) }
        break
      }
      if (!item.effect) return fail('item_effect_missing')
      for (const [stat, delta] of Object.entries(item.effect)) {
        if (stat === 'affection') {
          affection(delta)
        } else next.needs[stat] = clamp(next.needs[stat] + delta)
      }
      if (['cookie','feast','noodle','cake','rice'].includes(key)) { n.feedCount++; exp(1); n.photos['first-cookie'] ||= { ts: now } }
      n.lastInteractionAt = now; break
    }
    case 'rest_start':
      if (n.work) return fail('work_in_progress')
      n.rest = { remainingMs: Math.min(120, Math.max(1, Number(action.minutes) || 10)) * 60000 }; break
    case 'rest_cancel': n.rest = null; break
    case 'work_start': {
      const job = WORK_JOBS.find(item => item.id === action.id)
      if (!job || n.work || n.rest || n.level < job.minLevel || next.relationship.affection < job.minAff) return fail('work_unavailable')
      for (const stat of ['satiety','energy','thirst']) if ((job.consume[stat] || 0) > 0 && next.needs[stat] - job.consume[stat] * job.minutes < 15) return fail('work_needs_insufficient')
      n.work = { id: job.id, runId: action.commandId, elapsedMs: 0, startedAt: now }; break
    }
    case 'work_cancel': if (n.work) { if (n.work.elapsedMs < 60000) n.work = null; else settleWork(true) }; break
    case 'tick': {
      const elapsedMs = Math.max(0, Math.min(30 * 60000, Number(action.elapsedMs) || 0)), minutes = elapsedMs / 60000
      if (n.focus && !n.focus.paused) {
        n.focus.remainingMs = Math.max(0, n.focus.remainingMs - elapsedMs)
        if (!n.focus.remainingMs) {
          if (n.focus.mode === 'study') { n.pomodoros++; n.coins += 5; exp(5) }
          n.focus = null
        }
      }
      if (n.work) {
        const job = WORK_JOBS.find(item => item.id === n.work.id)
        if (!job) return fail('work_definition_missing')
        const used = Math.min(elapsedMs, job.minutes * 60000 - n.work.elapsedMs)
        for (const [stat, delta] of Object.entries(job.consume)) next.needs[stat] = clamp(next.needs[stat] - delta * used / 60000)
        n.work.elapsedMs += used
        if (n.work.elapsedMs >= job.minutes * 60000) settleWork(false)
      } else if (n.rest) {
        const used = Math.min(elapsedMs, n.rest.remainingMs) / 60000
        next.needs.mood = clamp(next.needs.mood + 0.6 * used); next.needs.energy = clamp(next.needs.energy + 0.8 * used)
        n.rest.remainingMs -= used * 60000
        if (n.rest.remainingMs <= 0) n.rest = null
      } else next.needs = reducer.decayNeeds(next, minutes, { resting: next.attentionPolicy?.restUntil > now }).needs
      break
    }
    default: return fail('interaction_unknown')
  }
  const view = { ...legacy, ...next.preferences, ...n, stats: next.needs, affection: next.relationship.affection }
  for (const achievement of ACHIEVEMENTS) if (!n.achievements.includes(achievement.id) && achievement.check(view)) n.achievements.push(achievement.id)
  const hour = new Date(now).getHours()
  const Solar = require('../../renderer/lunar.js').Solar
  for (const photo of photoDefinitions({ now, Solar })) {
    if (n.photos[photo.id] || photo.event) continue
    if (photo.check?.(view) || (photo.time && ((hour >= photo.time[0] && hour < photo.time[1]) || (photo.time[0] > photo.time[1] && (hour >= photo.time[0] || hour < photo.time[1]))))) n.photos[photo.id] = { ts: now }
  }
  return { ok: true, state: next, events }
}
module.exports = { apply }
