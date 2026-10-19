'use strict'
/**
 * K4 CharacterState 纯 reducer。所有权：内核在事务内调用，renderer 不得写。
 *
 * 迁移纪律（总规 §3.3 保留清单 / §20 K4）：
 *  - NeedsSystem.decay 的系数原样迁入，不改数值规则。
 *  - RelationshipEngine 的维度、档位、每日上限、冷却与“禁止来源”集合原样迁入，
 *    并去掉它对 window/PetStateApi 的全局依赖（改为纯数据进出）。
 *  - 本文件不产生任何 I/O、不读时钟；时间由调用方作为参数传入。
 */

const { STATE_SCHEMA_VERSION } = require('../contracts.cjs')

const clamp = (value, min, max) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

const RELATIONSHIP_TIERS = Object.freeze([
  { min: 0, label: '初识' },
  { min: 25, label: '熟悉' },
  { min: 50, label: '亲近' },
  { min: 75, label: '信赖' },
  { min: 100, label: '羁绊' },
])

/** 与现有 RelationshipEngine.RULES 一致：只保留 dailyCap / cooldownMs。 */
const RELATIONSHIP_RULES = Object.freeze({
  interaction: { dailyCap: 30, cooldownMs: 30 * 1000 },
  play: { dailyCap: 20, cooldownMs: 10 * 1000 },
  feed: { dailyCap: 15, cooldownMs: 10 * 1000 },
  gift: { dailyCap: 10, cooldownMs: 0 },
  work: { dailyCap: 20, cooldownMs: 20 * 1000 },
  daily_company: { dailyCap: 1, cooldownMs: 0 },
  milestone: { dailyCap: 10, cooldownMs: 0 },
  promise_kept: { dailyCap: 10, cooldownMs: 0 },
  negative: { dailyCap: 20, cooldownMs: 0 },
  legacy_affection: { dailyCap: 200, cooldownMs: 0 },
  custom: { dailyCap: 100, cooldownMs: 0 },
})

/** 模型/对话/日记等不得直接改关系值（保留既有边界）。 */
const RELATIONSHIP_DENIED_SOURCES = Object.freeze([
  'ai', 'dialogue', 'chat', 'diary', 'emotion', 'intent', 'expression', 'memory', 'behavior', 'perception', 'vision',
])

const TIER_MAX_DAYS = 7
const MAX_APPLIED_EVENTS = 300

function localDateKey (ts) {
  const date = new Date(ts)
  const pad = n => (n < 10 ? '0' : '') + n
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function initialRelationship (affection) {
  return {
    affection: clamp(affection === undefined ? 0 : affection, 0, 100),
    familiarity: 0,
    trust: 0,
    lastPositiveInteractionAt: null,
    lastRelationshipEventAt: null,
    version: 1,
    appliedEvents: [],
    daily: {},
    lastEventAt: {},
    changes: [],
    stats: { applied: 0, idempotentRejected: 0, rateLimited: 0, deniedSource: 0, invalid: 0, lastEventId: null, lastTs: null },
  }
}

/** 初始状态。identityHash 把状态钉到具体身份版本上（不变量 7）。 */
function initialState (options = {}) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    identityHash: options.identityHash || null,
    displayName: options.displayName || null,
    nurture: {
      level: 0, coins: 0, exp: 0, bootCount: 0, totalGames: 0, totalWorkDone: 0, pomodoros: 0, feedCount: 0,
      ...(options.nurture || {}),
    },
    needs: {
      satiety: clamp(options.needs && options.needs.satiety !== undefined ? options.needs.satiety : 80, 0, 100),
      thirst: clamp(options.needs && options.needs.thirst !== undefined ? options.needs.thirst : 80, 0, 100),
      energy: clamp(options.needs && options.needs.energy !== undefined ? options.needs.energy : 80, 0, 100),
      mood: clamp(options.needs && options.needs.mood !== undefined ? options.needs.mood : 70, 0, 100),
    },
    affect: { mood: 'neutral', intensity: 0, updatedAt: 0 },
    relationship: initialRelationship(),
    interests: {},
    attentionPolicy: { quietUntil: 0, lastAutomaticAt: 0 },
    legacyUnmapped: {},
  }
}

/**
 * 需求衰减：与 renderer/systems/needs-system.js 的 decay 逐项一致。
 * @param {object} state
 * @param {number} elapsedMin 经过的分钟数（调用方已按离线上限裁剪）
 * @param {{sleepy?: boolean, running?: boolean, resting?: boolean}} ctx
 */
function decayNeeds (state, elapsedMin, ctx = {}) {
  const minutes = Number(elapsedMin)
  if (!Number.isFinite(minutes) || minutes <= 0) return state
  const next = { ...state, needs: { ...state.needs } }
  const sleepy = !!ctx.sleepy
  const running = !!ctx.running
  const resting = !!ctx.resting
  const c = v => clamp(v, 0, 100)
  next.needs.satiety = c(next.needs.satiety - (resting ? 0.12 : 0.22) * minutes)
  next.needs.mood = c(next.needs.mood + (resting ? 0.6 : sleepy ? 0.1 : -0.15) * minutes)
  next.needs.energy = c(next.needs.energy + (resting ? 0.8 : sleepy ? 0.6 : running ? -0.3 : -0.2) * minutes)
  next.needs.thirst = c(next.needs.thirst - (resting ? 0.12 : 0.18) * minutes)
  return next
}

/**
 * 离线衰减：首版上限 8 小时（§10.4）。挂起/恢复的实际间隔由内核计算。
 */
function decayForOffline (state, offlineMs, maxHours, ctx) {
  const hours = Math.max(0, Number(offlineMs) || 0) / 3600000
  const capped = Math.min(hours, Number.isFinite(Number(maxHours)) ? Number(maxHours) : 8)
  return decayNeeds(state, capped * 60, ctx)
}

function deriveTier (affection) {
  const value = clamp(affection, 0, 100)
  let index = 0
  for (let i = 0; i < RELATIONSHIP_TIERS.length; i++) if (value >= RELATIONSHIP_TIERS[i].min) index = i
  return index
}

function relationshipSnapshot (state) {
  const rel = state.relationship
  return {
    affection: rel.affection,
    familiarity: rel.familiarity,
    trust: rel.trust,
    tier: deriveTier(rel.affection),
    label: RELATIONSHIP_TIERS[deriveTier(rel.affection)].label,
  }
}

/** 兼容旧键（2026-9-3）与规范键（2026-09-03）混合的日桶读取。 */
function dayBucket (rel, ts) {
  const key = localDateKey(ts)
  if (!rel.daily[key]) rel.daily[key] = { events: {}, deltas: { affection: 0, familiarity: 0, trust: 0 } }
  const keys = Object.keys(rel.daily).sort()
  while (keys.length > TIER_MAX_DAYS) delete rel.daily[keys.shift()]
  return { key, day: rel.daily[key] }
}

/**
 * 关系事件（纯函数）。规则与 RelationshipEngine.applyEvent 对齐：
 * 空 delta / 禁止来源 / 重复 eventId / 每日上限 / 冷却 一律不改变数值，只累加计数。
 * @returns {{state: object, applied: boolean, reason: string, delta?: object, snapshot?: object}}
 */
function applyRelationshipEvent (state, event, options = {}) {
  const rel = {
    ...state.relationship,
    appliedEvents: state.relationship.appliedEvents.slice(),
    daily: JSON.parse(JSON.stringify(state.relationship.daily)),
    lastEventAt: { ...state.relationship.lastEventAt },
    changes: state.relationship.changes.slice(),
    stats: { ...state.relationship.stats },
  }
  const ts = Number(event && event.ts) || Number(options.now) || 0
  const kind = String((event && event.kind) || 'custom')
  const rule = RELATIONSHIP_RULES[kind] || RELATIONSHIP_RULES.custom
  const source = String((event && event.source) || 'system').toLowerCase()
  const eventId = String((event && event.eventId) || '').trim() || (kind + ':' + ts)

  const raw = (event && event.delta) || {}
  const delta = {}
  for (const key of ['affection', 'familiarity', 'trust']) {
    const value = Number(raw[key])
    if (Number.isFinite(value) && value !== 0) delta[key] = clamp(value, -100, 100)
  }

  const result = applied => ({ state: { ...state, relationship: rel }, ...applied })
  if (!Object.keys(delta).length) { rel.stats.invalid++; return result({ applied: false, reason: 'empty_delta' }) }
  if (RELATIONSHIP_DENIED_SOURCES.includes(source)) {
    rel.stats.deniedSource++
    return result({ applied: false, reason: 'denied_source', source })
  }
  if (rel.appliedEvents.includes(eventId)) {
    rel.stats.idempotentRejected++
    return result({ applied: false, reason: 'duplicate', eventId })
  }
  const { day } = dayBucket(rel, ts)
  const usedToday = day.events[kind] || 0
  if (rule.dailyCap && usedToday >= rule.dailyCap) {
    rel.stats.rateLimited++
    return result({ applied: false, reason: 'daily_cap', cap: rule.dailyCap, kind })
  }
  const lastAt = rel.lastEventAt[kind] || 0
  if (rule.cooldownMs && ts - lastAt < rule.cooldownMs) {
    rel.stats.rateLimited++
    return result({ applied: false, reason: 'cooldown', remainingMs: rule.cooldownMs - (ts - lastAt), kind })
  }

  const before = relationshipSnapshot({ relationship: rel })
  if (delta.affection) rel.affection = clamp(rel.affection + delta.affection, 0, 100)
  if (delta.familiarity) rel.familiarity = clamp(rel.familiarity + delta.familiarity, 0, 100)
  if (delta.trust) rel.trust = clamp(rel.trust + delta.trust, 0, 100)
  const after = relationshipSnapshot({ relationship: rel })

  if ((delta.affection || 0) > 0 || (delta.familiarity || 0) > 0 || (delta.trust || 0) > 0) rel.lastPositiveInteractionAt = ts
  rel.lastRelationshipEventAt = ts
  rel.version++
  rel.stats.applied++
  rel.stats.lastEventId = eventId
  rel.stats.lastTs = ts
  day.events[kind] = usedToday + 1
  day.deltas.affection += delta.affection || 0
  day.deltas.familiarity += delta.familiarity || 0
  day.deltas.trust += delta.trust || 0
  rel.lastEventAt[kind] = ts
  rel.appliedEvents.push(eventId)
  if (rel.appliedEvents.length > MAX_APPLIED_EVENTS) rel.appliedEvents.splice(0, rel.appliedEvents.length - MAX_APPLIED_EVENTS)
  rel.changes.unshift({ eventId, kind, source, ts, delta: { ...delta }, before, after })
  if (rel.changes.length > 50) rel.changes.length = 50

  return result({ applied: true, reason: 'ok', delta: { ...delta }, eventId, snapshot: after })
}

/** 情绪/表达状态：只由确定性规则更新，不让模型直接写（§9.3 不变量 2）。 */
function applyAffect (state, affect, now) {
  const next = { ...state.affect }
  if (affect && typeof affect.mood === 'string') next.mood = affect.mood.slice(0, 30)
  if (affect && Number.isFinite(Number(affect.intensity))) next.intensity = clamp(affect.intensity, 0, 1)
  next.updatedAt = Number(now) || next.updatedAt || 0
  return { ...state, affect: next }
}

/** 数值养成：喂食/工作/游戏等既有入口仍在主进程，内核只记录变化结果。 */
function applyNurture (state, patch) {
  if (!patch || typeof patch !== 'object') return state
  const nurture = { ...state.nurture }
  for (const key of ['level', 'coins', 'exp', 'bootCount', 'totalGames', 'totalWorkDone', 'pomodoros', 'feedCount']) {
    if (Number.isFinite(Number(patch[key]))) nurture[key] = Number(patch[key])
  }
  return { ...state, nurture }
}

module.exports = {
  RELATIONSHIP_TIERS,
  RELATIONSHIP_RULES,
  RELATIONSHIP_DENIED_SOURCES,
  clamp,
  localDateKey,
  deriveTier,
  relationshipSnapshot,
  initialRelationship,
  initialState,
  decayNeeds,
  decayForOffline,
  applyRelationshipEvent,
  applyAffect,
  applyNurture,
}
