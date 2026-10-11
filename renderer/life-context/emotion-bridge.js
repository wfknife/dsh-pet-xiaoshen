/* LifeEmotionBridge — 第二期 F2「情绪底子」桥（纯函数 / 零 I/O / 无行为出口）
 *
 * 上位约束：P3-life-context-boundary-final-v1-20260918.md v1.1 §4 + F0F7 设计 §0.3/§3.3
 *   情绪 = 上一次角色化理解留下的底子 + 这一轮对事件的进一步解释结果
 *   流程：事件/证据 → 角色化解释 → 形成/调整情绪 → 情绪作为下一轮解释的底子 → 进入选择
 *   **两条来源并存**：① 既有事件规则  ② **本轮最终采纳的那一条意义**（不是全部候选的平均）
 *
 * 硬边界（第二期施工单 §0 + W9）：
 *   - **禁止** `情绪值达到 X → 自动行为`
 *   - **禁止** 情绪变化 → 自动调用现有 PresencePolicy / IntentEngine / 任何行为入口
 *   - 本模块**只输出** `values / deltas / reasons`；不输出任何动作、命令、发言、事件
 *
 * ⚠ 与既有 3.1 `renderer/emotion/emotion-engine.js` 的差异（**已按用户裁决：不改既有文件、在新增层报告**）：
 *   - 施工单原写"沿用四条事件规则"，实测既有实现是**九条**（多 explicit_failure / explicit_interruption /
 *     low_energy / long_activity / rest）⇒ 本模块**镜像全部九条**（以既有实现为准）
 *   - 既有实现是**五个维度**（含 `annoyance`）⇒ 本模块镜像五维（施工单只点名四维）
 *   - 既有实现的**有状态机制不镜像**（见 NOT_MIRRORED）：owner_interaction 冷却/递减、loneliness 增长规则、
 *     needs→fatigue 桥、low_energy 冷却、已处理事件 id 去重 —— 它们属既有引擎，避免在本层重造第二个情绪引擎
 *   - 情绪增量（采纳意义 → 维度）是本层**新增**，施工单 §6 ⟨建议初值⟩，用户已接受
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeEmotionBridge = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const BRIDGE_VERSION = 'life-emotion-bridge/1'

  // 镜像既有 3.1 DIMENSIONS（五个维度，baseline + halfLifeMs 逐值一致）
  const DIMENSIONS = {
    happiness: { baseline: 0.5, halfLifeMs: 90 * 60 * 1000 },
    loneliness: { baseline: 0.1, halfLifeMs: 360 * 60 * 1000 },
    excitement: { baseline: 0.1, halfLifeMs: 45 * 60 * 1000 },
    annoyance: { baseline: 0.0, halfLifeMs: 60 * 60 * 1000 },
    fatigue: { baseline: 0.2, halfLifeMs: 180 * 60 * 1000 }
  }
  const DIMENSION_LIST = Object.keys(DIMENSIONS)

  // 镜像既有 3.1 EVENT_RULES（九条，delta 与 ruleId 逐值一致）
  const EVENT_RULES = {
    owner_interaction: { ruleId: 'EMO-OWNER-01', delta: { happiness: 0.05, loneliness: -0.05 } },
    task_complete: { ruleId: 'EMO-TASK-01', delta: { happiness: 0.06, excitement: 0.05 } },
    special_milestone: { ruleId: 'EMO-MILESTONE-01', delta: { happiness: 0.1, excitement: 0.12 } },
    explicit_failure: { ruleId: 'EMO-FAILURE-01', delta: { annoyance: 0.07, excitement: -0.03 } },
    explicit_interruption: { ruleId: 'EMO-INTERRUPT-01', delta: { annoyance: 0.05 } },
    low_energy: { ruleId: 'EMO-LOWENERGY-01', delta: { fatigue: 0.05 } },
    long_activity: { ruleId: 'EMO-LONGACT-01', delta: { fatigue: 0.03, excitement: -0.02 } },
    rest: { ruleId: 'EMO-REST-01', delta: { fatigue: -0.08 } },
    sleep: { ruleId: 'EMO-SLEEP-01', delta: { fatigue: -0.15, happiness: 0.03 } }
  }

  // 本层新增：采纳意义的倾向 → 情绪增量（施工单 §6 ⟨建议初值⟩，用户已接受）
  const TENDENCY_DELTAS = {
    平静: { fatigue: -0.02, happiness: 0.01 },
    在意: { loneliness: -0.03, happiness: 0.01 },
    好奇: { excitement: 0.04, happiness: 0.02 },
    轻松: { happiness: 0.04, fatigue: -0.03 },
    亲近: { loneliness: -0.05, happiness: 0.03 }
  }
  const TENDENCY_LIST = Object.keys(TENDENCY_DELTAS)

  const MAX_STEP_DELTA = 0.12 // 单次 step、**单维度**上限
  const NOT_MIRRORED = [
    'owner_interaction cooldown 30s + diminishing [1.0,0.6,0.35,0.2] + 10min 窗口',
    'loneliness 增长规则（2h idle 后每 30min +0.01）',
    'needs→fatigue 桥（low_energy cooldown 30min，不复制 energy）',
    '已处理事件 id 去重（MAX_PROCESSED_EVENT_IDS=200）',
    'denied sources 白名单（ai/dialogue/chat/diary/ui/game/expression/intent/relationship/memory/behavior/vision）'
  ]

  function clamp01(n) {
    const v = Number(n)
    if (!Number.isFinite(v)) return 0
    return Math.max(0, Math.min(1, v))
  }
  function round4(n) { return Math.round(Number(n) * 10000) / 10000 }
  function clone(o) { return JSON.parse(JSON.stringify(o)) }

  function defaultValues() {
    const v = {}
    DIMENSION_LIST.forEach((d) => { v[d] = DIMENSIONS[d].baseline })
    return v
  }

  function normalizeValues(values) {
    const out = {}
    DIMENSION_LIST.forEach((d) => {
      const raw = values && typeof values[d] === 'number' ? values[d] : DIMENSIONS[d].baseline
      out[d] = round4(clamp01(raw))
    })
    return out
  }

  // 指数衰减（与既有实现同口径：按真实流逝时间、半衰期）
  function decay(values, elapsedMs) {
    const v = normalizeValues(values)
    const ms = Number(elapsedMs)
    if (!Number.isFinite(ms) || ms <= 0) return { values: v, applied: [] }
    const applied = []
    const out = {}
    DIMENSION_LIST.forEach((d) => {
      const base = DIMENSIONS[d].baseline
      const half = DIMENSIONS[d].halfLifeMs
      const k = Math.pow(0.5, ms / half)
      const next = base + (v[d] - base) * k
      out[d] = round4(clamp01(next))
      applied.push({ dimension: d, from: v[d], to: out[d], kind: 'decay', elapsedMs: ms })
    })
    return { values: out, applied }
  }

  function applyEventRules(values, events) {
    const v = normalizeValues(values)
    const amounts = {}
    const applied = []
    const list = Array.isArray(events) ? events : []
    list.forEach((ev) => {
      const key = typeof ev === 'string' ? ev : (ev && (ev.kind || ev.rule)) || null
      const rule = key ? EVENT_RULES[key] : null
      if (!rule) { applied.push({ kind: 'event', id: key, skipped: true, reason: 'unknown_rule' }); return }
      Object.keys(rule.delta).forEach((d) => { amounts[d] = (amounts[d] || 0) + rule.delta[d] })
      applied.push({ kind: 'event', id: key, ruleId: rule.ruleId, delta: clone(rule.delta) })
    })
    return { values: v, amounts, applied }
  }

  function applyAdoptedMeaning(values, adopted) {
    const v = normalizeValues(values)
    const amounts = {}
    const applied = []
    if (!adopted || typeof adopted !== 'object') return { values: v, amounts, applied }
    const tendency = adopted.tendency
    const base = TENDENCY_DELTAS[tendency]
    if (!base) {
      applied.push({ kind: 'adopted', id: adopted.candidateId || null, skipped: true, reason: 'unknown_tendency:' + String(tendency) })
      return { values: v, amounts, applied }
    }
    const conf = clamp01(typeof adopted.confidence === 'number' ? adopted.confidence : 0.5)
    const scale = round4(0.5 + 0.5 * conf)
    const delta = {}
    Object.keys(base).forEach((d) => { delta[d] = round4(base[d] * scale) })
    Object.keys(delta).forEach((d) => { amounts[d] = (amounts[d] || 0) + delta[d] })
    applied.push({
      kind: 'adopted',
      id: adopted.candidateId || null,
      ruleId: adopted.ruleId || null,
      tendency,
      confidence: conf,
      scale,
      delta
    })
    return { values: v, amounts, applied }
  }

  // 主入口：事件规则 + 本轮采纳意义 → 新底子（可追溯）
  function step(values, input) {
    const i = input || {}
    const clock = i.clock || {}
    const nowTs = typeof clock.nowTs === 'number' ? clock.nowTs : 0
    const prevTs = typeof clock.prevTs === 'number' ? clock.prevTs : null
    let cur = normalizeValues(values)
    const deltas = []
    const reasons = []

    if (prevTs !== null && nowTs > prevTs) {
      const d = decay(cur, nowTs - prevTs)
      DIMENSION_LIST.forEach((dim) => {
        if (d.values[dim] !== cur[dim]) {
          deltas.push({ source: 'decay', dimension: dim, from: cur[dim], to: d.values[dim], elapsedMs: nowTs - prevTs })
        }
      })
      cur = d.values
    }

    const ev = applyEventRules(cur, i.events)
    const ad = applyAdoptedMeaning(cur, i.adopted)
    const amounts = {}
    DIMENSION_LIST.forEach((d) => { amounts[d] = round4((ev.amounts[d] || 0) + (ad.amounts[d] || 0)) })

    const clampedDims = []
    const nextValues = {}
    DIMENSION_LIST.forEach((d) => {
      const raw = amounts[d] || 0
      const applied = Math.max(-MAX_STEP_DELTA, Math.min(MAX_STEP_DELTA, raw))
      if (applied !== raw) clampedDims.push(d)
      const to = round4(clamp01(cur[d] + applied))
      nextValues[d] = to
      if (applied !== 0) {
        deltas.push({ source: 'step', dimension: d, from: cur[d], to, amountRaw: raw, amountApplied: applied })
      }
    })

    ev.applied.forEach((a) => {
      if (a.skipped) reasons.push('event:' + String(a.id) + ' → 跳过（' + a.reason + '）')
      else reasons.push('event:' + a.ruleId + '(' + a.id + ') → ' + JSON.stringify(a.delta))
    })
    ad.applied.forEach((a) => {
      if (a.skipped) reasons.push('adopted:' + String(a.id) + ' → 跳过（' + a.reason + '）')
      else reasons.push('adopted:' + String(a.id) + '(' + a.tendency + ', conf=' + a.confidence + ', scale=' + a.scale + ') → ' + JSON.stringify(a.delta))
    })
    if (clampedDims.length) reasons.push('clamped:' + clampedDims.join(',') + '（单次单维上限 ±' + MAX_STEP_DELTA + '）')

    return {
      engineVersion: BRIDGE_VERSION,
      nowTs,
      values: nextValues,
      deltas,
      reasons,
      clamped: clampedDims.length > 0,
      clampedDimensions: clampedDims,
      sources: { events: ev.applied, adopted: ad.applied }
    }
  }

  function assertNoBehaviorSurface() {
    // 结构性边界：本模块不导出任何行为面（供测试断言）
    const forbidden = ['say', 'speak', 'emit', 'dispatch', 'fire', 'run', 'execute', 'apply', 'notify', 'act', 'intent', 'presence']
    const keys = Object.keys(api || {})
    return { ok: keys.every((k) => forbidden.indexOf(k.toLowerCase()) < 0), keys }
  }

  const api = {
    BRIDGE_VERSION,
    DIMENSIONS,
    DIMENSION_LIST,
    EVENT_RULES,
    TENDENCY_DELTAS,
    TENDENCY_LIST,
    MAX_STEP_DELTA,
    NOT_MIRRORED,
    defaultValues,
    normalizeValues,
    decay,
    applyEventRules,
    applyAdoptedMeaning,
    step,
    assertNoBehaviorSurface
  }
  return api
})
