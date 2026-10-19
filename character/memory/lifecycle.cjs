'use strict'
/**
 * K3 记忆生命周期：降权 / 冷归档 / 遗忘 是三个不同动作（总规 §5.3 / §13.3）。
 *
 *  - 降权（fading）：降低主动提起概率，仍可检索。
 *  - 冷归档（archived）：离开热索引，只有明确回忆请求才可检索。
 *  - 遗忘（forgotten）：撤销使用权，清除内容与派生物，永不可取回。
 *
 * 遗忘协议（§11.3）：
 *   1) policy 库先提交删除决定（立即生效，外部库）；
 *   2) 主库把来源标 revoked，并沿 evidence_edges 处理派生物：
 *      无剩余独立支持 → invalidated；仍有独立支持 → 重算而不是盲删；
 *   3) 取消相关 job，清除 payload 正文；
 *   4) 记录清理进度；崩溃恢复时先读 policy 再补清理。
 */

const { MEMORY_LIFECYCLE } = require('../contracts.cjs')

const MEMORY_TRANSITIONS = Object.freeze({
  active: ['fading', 'archived', 'forgotten'],
  fading: ['active', 'archived', 'forgotten'],
  archived: ['active', 'forgotten'],
  forgotten: [],
})

function canTransitionMemory (from, to) {
  const allowed = MEMORY_TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

/**
 * 计算某个派生物在删除集下的剩余支持来源。
 * 只有真实来源（sources 表里存在）才算支持；派生物之间的引用（supersedes 等）不算。
 */
function remainingSupport (gw, derivedId, deleted) {
  const edges = gw.listEvidenceSources(derivedId)
  const support = []
  const dropped = []
  for (const edge of edges) {
    if (edge.relation !== 'supports' && edge.relation !== 'origin') continue
    const source = gw.getSource(edge.source_id)
    if (!source) continue
    if (source.permission !== 'granted') { dropped.push(edge.source_id); continue }
    if (deleted.has(edge.source_id)) dropped.push(edge.source_id)
    else support.push(edge.source_id)
  }
  return { support, dropped }
}

/**
 * 遗忘主流程。policy 提交先于清理；清理失败不回滚删除决定。
 * @param {{gw: object, policyStore: object, characterId: string, sourceIds: string[], reason: string, now: number, seq: number}} input
 */
function forget (input) {
  const { gw, policyStore, characterId, now, seq } = input
  const sourceIds = Array.from(new Set((input.sourceIds || []).filter(id => typeof id === 'string' && id.length > 0)))
  if (!sourceIds.length) return { ok: true, forgotten: [], invalidated: [], recomputed: [], policyEpoch: policyStore.epoch() }

  // 1) 删除决定立即生效（独立库；即使下面清理失败也不复活）
  const recorded = policyStore.recordDeletion(sourceIds, input.reason || 'user_request')
  const deleted = policyStore.deletedSet()

  const invalidated = []
  const recomputed = []
  const touched = new Set()

  // 2) 主库：来源失效 + 派生物处理
  for (const sourceId of sourceIds) {
    const source = gw.getSource(sourceId)
    if (source) {
      gw.setSourcePermission(sourceId, 'revoked')
      if (source.payloadRef) gw.deletePayload(source.payloadRef)
    }
    for (const edge of gw.listDerivedBySource(sourceId)) {
      if (touched.has(edge.derived_id)) continue
      touched.add(edge.derived_id)
      const state = remainingSupport(gw, edge.derived_id, deleted)
      if (state.support.length === 0) {
        gw.invalidateDerived(edge.derived_id, seq)
        invalidated.push(edge.derived_id)
      } else {
        // 仍有独立来源：重算而非盲删；记录剩余支持，便于审查（C07）。
        // Removing evidence must not turn a historical/superseded assertion current again.
        recomputed.push({ derivedId: edge.derived_id, remainingSources: state.support })
      }
    }
  }

  // 3) 取消指向被遗忘来源的待办 job（不再规划、不再派发）
  let cancelledJobs = 0
  for (const sourceId of sourceIds) cancelledJobs += gw.cancelJobsMatching(characterId, sourceId)

  // The caller marks policy cleanup complete only AFTER the main transaction commits.
  // A crash/rollback here must leave a pending policy entry for restart recovery.
  gw.removeObservationsBySources(sourceIds)
  for (const plan of gw.listActivePlans(characterId)) {
    if (plan.steps.some(step => (step.args?.evidenceRefs || []).some(ref => deleted.has(ref)))) gw.patchPlan(plan.planId, { status: 'cancelled', cancelReason: 'source_forgotten' })
  }
  for (const concern of gw.listConcerns(characterId, { limit: 400 })) {
    if ((concern.sourceRefs || []).some(ref => deleted.has(ref))) gw.putConcern({ ...concern, status: 'invalidated', nextCheckAt: null, revision: concern.revision + 1 })
  }
  for (const project of gw.listProjects(characterId, { limit: 200 })) {
    if ((project.sourceRefs || []).some(ref => deleted.has(ref))) gw.putProject({ ...project, status: 'invalidated', nextWakeAt: null, revision: project.revision + 1 })
  }
  for (const artifact of gw.allArtifacts(characterId)) if (artifact.sourceRefs.some(ref => deleted.has(ref))) gw.markArtifactDeleted(artifact.artifactId)
  const state = gw.getState(characterId)
  if (state) {
    for (const [key, interest] of Object.entries(state.body.interests || {})) if ((interest.sourceRefs || []).some(ref => deleted.has(ref))) delete state.body.interests[key]
    gw.writeState({ ...state, characterId, revision: state.revision + 1 })
  }

  return {
    ok: true,
    forgotten: sourceIds,
    invalidated,
    recomputed,
    cancelledJobs,
    policyEpoch: recorded.epoch,
    characterId,
  }
}

/**
 * 撤销某项权限（例如主人说“不要记录播放器信息”）：权限进入 policy 账本，
 * 受影响来源转 revoked，派生内容按遗忘同一套传播处理（§14.4 示例）。
 */
function revokePermission (input) {
  const { gw, policyStore, scope, sourceIds, now, seq } = input
  policyStore.recordPermissionRevocation(scope, input.reason || 'owner_request')
  const affected = (sourceIds || []).filter(id => !!gw.getSource(id))
  const result = affected.length ? forget({ gw, policyStore, characterId: input.characterId, sourceIds: affected, reason: 'permission_revoked:' + scope, now, seq }) : { ok: true, forgotten: [] }
  return { ok: true, scope, revokedSources: affected, ...result }
}

/** 降权：只改检索/主动提起策略，不删内容。 */
function fade (gw, assertionId, seq) {
  return setLifecycle(gw, assertionId, 'fading', seq)
}
/** 冷归档：离开热索引，仍可按明确回忆检索。 */
function archive (gw, assertionId, seq) {
  return setLifecycle(gw, assertionId, 'archived', seq)
}
/** 从冷归档恢复为可主动提起。 */
function reactivate (gw, assertionId, seq) {
  return setLifecycle(gw, assertionId, 'active', seq)
}

function setLifecycle (gw, assertionId, target, seq) {
  if (!MEMORY_LIFECYCLE.includes(target)) return { ok: false, reason: 'lifecycle_unknown', target }
  const assertion = gw.getAssertion(assertionId)
  if (!assertion) return { ok: false, reason: 'assertion_missing' }
  if (target === 'forgotten') return { ok: false, reason: 'use_forget_command' }
  if (assertion.memoryLifecycle === 'forgotten') return { ok: false, reason: 'already_forgotten' }
  if (!canTransitionMemory(assertion.memoryLifecycle, target)) {
    return { ok: false, reason: 'lifecycle_transition_invalid', from: assertion.memoryLifecycle, to: target }
  }
  gw.setAssertionStatus(assertionId, assertion.status, seq, target)
  return { ok: true, assertionId, from: assertion.memoryLifecycle, to: target }
}

/**
 * 冷归档维护：把长期未被检索的活动断言转 archived。只处理有明确 created_seq 的断言，
 * 不动被关注/项目引用的记录（由调用方传入 pinned 集合）。
 */
function archiveCold (gw, { characterId, before, pinned, limit, seq }) {
  const pinnedSet = pinned instanceof Set ? pinned : new Set(pinned || [])
  const rows = gw.listAssertions(characterId, { status: 'current', lifecycleIn: ['active'], limit: limit || 100 })
  const archived = []
  for (const row of rows) {
    if (pinnedSet.has(row.assertionId)) continue
    if (!(row.updatedSeq < before)) continue
    gw.setAssertionStatus(row.assertionId, 'current', seq, 'archived')
    archived.push(row.assertionId)
  }
  return { ok: true, archived }
}

/** 冷归档恢复索引时用：明确回忆可检索 archived，但 forgotten 永远不可。 */
function recallableLifecycles (explicit) {
  return explicit ? ['active', 'fading', 'archived'] : ['active', 'fading']
}

module.exports = {
  MEMORY_TRANSITIONS,
  canTransitionMemory,
  remainingSupport,
  forget,
  revokePermission,
  fade,
  archive,
  reactivate,
  archiveCold,
  recallableLifecycles,
}
