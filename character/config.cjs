'use strict'
/**
 * K0 配置与开关语义（总规 §20 K0“整理数据路径与开关”）。
 *
 * 关键纪律：
 *  - 本模块绝不自动把正式数据目录切到新结构。默认 `off`，正式写入仍归旧 JSON 路径。
 *  - candidate 模式使用**隔离候选目录** `character-candidate/`，可整目录丢弃回退；
 *    active 模式使用 `character/`，只有用户明确切换（K8）后才允许。
 *  - 所有数值都是版本化的初始参数，不是“最优值”。改参数要连同版本号一起改。
 */

const path = require('node:path')

const CONFIG_VERSION = 1

/** 内核运行模式。off = 完全不启动（当前默认）；candidate = 隔离目录试运行；active = 主写者。 */
const KERNEL_MODES = Object.freeze(['off', 'candidate', 'active'])

function readMode (env) {
  const raw = String((env && env.DESKPET_CHARACTER_KERNEL) || '').trim().toLowerCase()
  if (!raw) return 'off'
  if (KERNEL_MODES.includes(raw)) return raw
  // 拼错的开关不得静默变成开启。
  return 'off'
}

/**
 * 解析内核数据目录。
 * @param {{dataDir: string, mode?: string}} input
 */
function resolvePaths (input) {
  const dataDir = input && input.dataDir
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('character_paths: dataDir required')
  const mode = KERNEL_MODES.includes(input.mode) ? input.mode : 'off'
  const root = mode === 'active' ? path.join(dataDir, 'character') : path.join(dataDir, 'character-candidate')
  return {
    mode,
    root,
    mainDb: path.join(root, 'character.sqlite'),
    policyDb: path.join(root, 'character-policy.sqlite'),
    artifacts: path.join(root, 'artifacts'),
    staging: path.join(root, 'staging'),
    backups: path.join(root, 'backups'),
    exports: path.join(root, 'exports'),
    legacyReadOnly: true,
  }
}

/**
 * 默认参数。分组注释标明来源条目，便于与总规对齐。
 * 这些数字全部未经运行验证（见 UNVERIFIED.md）。
 */
const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  // §11.4 数据生命周期
  retention: {
    foregroundObservationHours: 24,
    debugLogDays: 7,
    hotEventIndexDays: 90,
    permissionGrantDays: 365,
  },
  // §10.4 时间语义
  time: {
    maxOfflineDecayHours: 8,
    reminderSweepMs: 30000,
    clockSkewToleranceMs: 120000,
  },
  // §11.4 / §12.2 调度
  scheduler: {
    maxCatchUpCandidates: 1,
    leaseMs: 60000,
    jobMaxAttempts: 5,
    heartbeatMs: 60000,
  },
  // §14.2 候选与切换
  behavior: {
    switchMargin: 0.5,
    topCandidatesForModel: 3,
    maxAutonomousProjects: 2,
    maxOpenNonOwnerConcerns: 8,
    defaultConcernExpiryDays: 7,
    ownerCommitmentReviewDays: 30,
    minContactIntervalMs: 10 * 60 * 1000,
    maxPlanSteps: 3,
    planStepTimeoutMs: 10 * 60 * 1000,
  },
  // §14.3 模型成本
  budget: {
    autonomousHourly: 4,
    autonomousDaily: 20,
    reflectionDaily: 1,
    proactiveHourly: 2,
    proactiveDaily: 8,
  },
  // §13.3 检索预算
  retrieval: {
    decisionCandidates: 8,
    expressionCandidates: 3,
    explicitRecallCandidates: 12,
    archivedRecallCandidates: 6,
  },
  // §16 成长上限
  growth: {
    minIndependentSources: 3,
    minSpanDays: 2,
    dailyInterestDelta: 0.05,
    minReflectionSources: 2,
  },
  // §12.3 能力
  capability: {
    defaultTimeoutMs: 15000,
    maxTimeoutMs: 120000,
    circuitFailureThreshold: 3,
    circuitWindowMs: 10 * 60 * 1000,
    circuitCooldownMs: 5 * 60 * 1000,
  },
})

function createConfig (overrides) {
  const base = JSON.parse(JSON.stringify(DEFAULTS))
  if (!overrides || typeof overrides !== 'object') return base
  for (const [section, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[section] && typeof base[section] === 'object') {
      Object.assign(base[section], value)
    }
  }
  return base
}

module.exports = { CONFIG_VERSION, KERNEL_MODES, DEFAULTS, readMode, resolvePaths, createConfig }
