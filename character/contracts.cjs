'use strict'
/**
 * K0 协议契约：Event / Command / Operation / Receipt / Projection / CapabilityManifest。
 *
 * 本文件只做两件事：
 *  1) 固定枚举与 schemaVersion（跨进程、跨版本的字符串常量唯一来源）；
 *  2) 提供纯校验函数（返回 {ok, code, detail}，不抛异常、不写状态）。
 *
 * 约束（总规 §9.3 不变量 2/3/4/8）：
 *  - 模型产出的对象只能作为 proposal，本文件的校验通过不等于授权；
 *  - 校验失败必须能归类，调用方据此区分“用户输入错误”“版本冲突”“不可用”。
 *
 * 无运行时验证授权：本文件是静态契约，未被任何测试执行过。
 */

const PROTOCOL_VERSION = 1
const EVENT_SCHEMA_VERSION = 1
const STATE_SCHEMA_VERSION = 1
const CAPABILITY_MANIFEST_VERSION = 1
const COMMAND_SCHEMA_VERSION = 1
const PROJECTION_VERSION = 1

/** 世界类型：现实观察 / 主人自述 / 虚拟 / 系统 / 派生（§10.2） */
const WORLDS = Object.freeze(['user_report', 'desktop_observed', 'virtual', 'system', 'derived'])
/** 信任等级：主人陈述 / 传感器 / 回执 / 解释（§10.2） */
const TRUST = Object.freeze(['owner_statement', 'sensor', 'receipt', 'interpretation'])
/** 保留类别（§10.2） */
const RETENTION = Object.freeze(['ephemeral', 'episode', 'identity', 'operation'])
/** 来源权限状态 */
const PERMISSION = Object.freeze(['granted', 'revoked', 'expired', 'unknown'])
/** 结论状态（Assertion） */
const ASSERTION_STATUS = Object.freeze(['current', 'superseded', 'conflicted', 'invalidated', 'expired'])
/** 记忆生命周期（§5.3 / §13.3）：降权 ≠ 冷归档 ≠ 遗忘 */
const MEMORY_LIFECYCLE = Object.freeze(['active', 'fading', 'archived', 'forgotten'])
/** Concern 状态（§10.3） */
const CONCERN_STATUS = Object.freeze(['open', 'deferred', 'resolved', 'cancelled', 'expired', 'invalidated'])
/** Project 状态（§10.3） */
const PROJECT_STATUS = Object.freeze(['proposed', 'active', 'paused', 'completed', 'abandoned', 'expired', 'invalidated'])
/** Operation 状态机（§12.3） */
const OPERATION_STATES = Object.freeze([
  'proposed', 'authorized', 'rejected', 'expired', 'cancelled',
  'dispatched', 'cancel_requested', 'succeeded', 'failed', 'unknown', 'abandoned',
])
/** 副作用类别与崩溃后处理（§12.3 表） */
const EFFECTS = Object.freeze(['read', 'internal', 'virtual', 'external-idempotent', 'external-unknown'])
const IDEMPOTENCY = Object.freeze(['local', 'provider-key', 'none'])
const CANCELABILITY = Object.freeze(['supported', 'best-effort', 'unsupported'])
const RECONCILE = Object.freeze(['supported', 'unsupported'])
/** 表现通道与相位（§15）：发布 ≠ 开始 ≠ 播放完成 */
const CHANNELS = Object.freeze(['text', 'voice', 'animation', 'video', 'artifact'])
const DELIVERY_PHASES = Object.freeze(['published', 'started', 'completed', 'failed', 'interrupted', 'degraded'])
/** 行为来源与候选种类（§14.1） */
const OPPORTUNITY_KINDS = Object.freeze(['need', 'concern_due', 'project_step', 'world_change', 'interest', 'owner_reminder', 'social_contact'])
/** 用户可见的降级/失败类别（§18.2） */
const FAILURE_CLASSES = Object.freeze([
  'invalid_input', 'conflict', 'stale_epoch', 'not_authorized', 'source_forgotten',
  'capability_missing', 'budget_exhausted', 'storage_unavailable', 'read_only',
  'model_unavailable', 'provider_timeout', 'operation_unknown', 'presentation_degraded',
])

const OPERATION_TRANSITIONS = Object.freeze({
  proposed: ['authorized', 'rejected', 'expired', 'cancelled'],
  authorized: ['dispatched', 'cancelled', 'expired'],
  dispatched: ['succeeded', 'failed', 'unknown', 'cancel_requested'],
  cancel_requested: ['succeeded', 'failed', 'unknown', 'cancelled'],
  unknown: ['succeeded', 'failed', 'abandoned'],
  rejected: [],
  expired: [],
  cancelled: [],
  succeeded: [],
  failed: [],
  abandoned: [],
})

/** 允许“不调用模型就直接确定性执行”的 effect 类别 */
const DETERMINISTIC_EFFECTS = Object.freeze(['read', 'internal', 'virtual'])

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)

function nonEmptyString (value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function boundedString (value, max) {
  return typeof value === 'string' && value.length <= max
}
function finiteInt (value) {
  return Number.isSafeInteger(value)
}
function positiveInt (value) {
  return Number.isSafeInteger(value) && value > 0
}
function oneOf (value, list) {
  return list.includes(value)
}
function stringList (value, maxItems, maxLen) {
  return Array.isArray(value) && value.length <= maxItems &&
    value.every(item => nonEmptyString(item, maxLen))
}

function fail (code, detail) {
  return { ok: false, code, ...(detail === undefined ? {} : { detail }) }
}
const OK = Object.freeze({ ok: true })

/**
 * EventEnvelope 校验（§10.2）。payloadRef 必须指向可删除的 payload，
 * 事件头本身不含正文。
 */
function validateEvent (event) {
  if (!plain(event)) return fail('invalid_input', 'event_not_object')
  if (!nonEmptyString(event.eventId, 200)) return fail('invalid_input', 'event_id')
  if (!nonEmptyString(event.characterId, 200)) return fail('invalid_input', 'character_id')
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) return fail('invalid_input', 'event_schema_version')
  if (!nonEmptyString(event.kind, 120)) return fail('invalid_input', 'event_kind')
  if (!oneOf(event.world, WORLDS)) return fail('invalid_input', 'event_world')
  if (!oneOf(event.trust, TRUST)) return fail('invalid_input', 'event_trust')
  if (!oneOf(event.retentionClass, RETENTION)) return fail('invalid_input', 'event_retention')
  if (!nonEmptyString(event.sourceId, 200)) return fail('invalid_input', 'event_source_id')
  if (event.payloadRef !== null && event.payloadRef !== undefined && !nonEmptyString(event.payloadRef, 200)) return fail('invalid_input', 'event_payload_ref')
  for (const field of ['occurredAt', 'observedAt', 'committedAt']) if (!finiteInt(event[field])) return fail('invalid_input', 'event_' + field)
  if (!nonEmptyString(event.timezone, 80)) return fail('invalid_input', 'event_timezone')
  if (!nonEmptyString(event.correlationId, 200)) return fail('invalid_input', 'event_correlation_id')
  if (event.causationId !== undefined && event.causationId !== null && !nonEmptyString(event.causationId, 200)) return fail('invalid_input', 'event_causation_id')
  if (event.evidenceRefs !== undefined && !stringList(event.evidenceRefs, 64, 240)) return fail('invalid_input', 'event_evidence_refs')
  return OK
}

/**
 * Command 校验（§9.1 深接口）。命令是唯一写入口：取消、纠正、遗忘、导入、
 * 暂停主动行为都必须是 command，不得另开写通道。
 * kind 白名单在 kernel 中按 owner 授权二次校验，这里只保证结构合法。
 */
const COMMAND_KINDS = Object.freeze([
  'owner.message', 'owner.control', 'owner.forget', 'owner.correct', 'owner.reminder', 'owner.suppress',
  'presentation.receipt', 'operation.receipt', 'capability.result', 'world.observation',
  'activity.receipt', 'identity.update', 'settings.update', 'import.run', 'export.run',
  'behavior.tick', 'growth.update', 'system.suspend', 'system.resume', 'system.pause',
  'package.manage', 'capability.invoke', 'owner.interaction',
])

function validateCommand (command) {
  if (!plain(command)) return fail('invalid_input', 'command_not_object')
  if (!nonEmptyString(command.commandId, 200)) return fail('invalid_input', 'command_id')
  if (command.schemaVersion !== COMMAND_SCHEMA_VERSION) return fail('invalid_input', 'command_schema_version')
  if (!nonEmptyString(command.kind, 80)) return fail('invalid_input', 'command_kind')
  if (!COMMAND_KINDS.includes(command.kind)) return fail('invalid_input', 'command_kind_unknown')
  if (!nonEmptyString(command.characterId, 200)) return fail('invalid_input', 'command_character_id')
  if (command.expectedEpoch !== undefined && command.expectedEpoch !== null && !finiteInt(command.expectedEpoch)) return fail('invalid_input', 'command_epoch')
  if (command.expectedRevision !== undefined && command.expectedRevision !== null && !finiteInt(command.expectedRevision)) return fail('invalid_input', 'command_expected_revision')
  if (!plain(command.payload)) return fail('invalid_input', 'command_payload')
  if (command.at !== undefined && !finiteInt(command.at)) return fail('invalid_input', 'command_at')
  return OK
}

/** Operation 结构校验（§12.3）。授权范围来自宿主，不接受调用方自报。 */
function validateOperation (operation) {
  if (!plain(operation)) return fail('invalid_input', 'operation_not_object')
  if (!nonEmptyString(operation.operationId, 200)) return fail('invalid_input', 'operation_id')
  if (!nonEmptyString(operation.characterId, 200)) return fail('invalid_input', 'operation_character_id')
  if (!nonEmptyString(operation.capabilityId, 160)) return fail('invalid_input', 'operation_capability_id')
  if (!positiveInt(operation.capabilityVersion)) return fail('invalid_input', 'operation_capability_version')
  if (!nonEmptyString(operation.provider, 160)) return fail('invalid_input', 'operation_provider')
  if (!oneOf(operation.effect, EFFECTS)) return fail('invalid_input', 'operation_effect')
  if (!oneOf(operation.status, OPERATION_STATES)) return fail('invalid_input', 'operation_status')
  if (!nonEmptyString(operation.inputHash, 128)) return fail('invalid_input', 'operation_input_hash')
  if (!finiteInt(operation.epoch)) return fail('invalid_input', 'operation_epoch')
  if (operation.deadline !== null && operation.deadline !== undefined && !finiteInt(operation.deadline)) return fail('invalid_input', 'operation_deadline')
  return OK
}

/**
 * 成功回执必须结构化（§12.3）：没有 receipt 的 succeeded 不是成功。
 * effect 为 external-* 时必须能追溯到 provider/version。
 */
function validateReceipt (receipt) {
  if (!plain(receipt)) return fail('invalid_input', 'receipt_not_object')
  if (!nonEmptyString(receipt.operationId, 200)) return fail('invalid_input', 'receipt_operation_id')
  if (!nonEmptyString(receipt.provider, 160)) return fail('invalid_input', 'receipt_provider')
  if (!oneOf(receipt.effect, EFFECTS)) return fail('invalid_input', 'receipt_effect')
  if (!finiteInt(receipt.occurredAt)) return fail('invalid_input', 'receipt_occurred_at')
  if (receipt.artifactRefs !== undefined && !stringList(receipt.artifactRefs, 32, 240)) return fail('invalid_input', 'receipt_artifact_refs')
  if (receipt.evidence !== undefined && !plain(receipt.evidence)) return fail('invalid_input', 'receipt_evidence')
  return OK
}

/** 表现回执：生成 / 发布 / 播放完成分别记账（§15）。 */
function validateDelivery (delivery) {
  if (!plain(delivery)) return fail('invalid_input', 'delivery_not_object')
  if (!nonEmptyString(delivery.presentationId, 200)) return fail('invalid_input', 'delivery_presentation_id')
  if (!oneOf(delivery.channel, CHANNELS)) return fail('invalid_input', 'delivery_channel')
  if (!oneOf(delivery.phase, DELIVERY_PHASES)) return fail('invalid_input', 'delivery_phase')
  if (delivery.operationId !== undefined && delivery.operationId !== null && !nonEmptyString(delivery.operationId, 200)) return fail('invalid_input', 'delivery_operation_id')
  if (delivery.rendererSession !== undefined && delivery.rendererSession !== null && !nonEmptyString(delivery.rendererSession, 200)) return fail('invalid_input', 'delivery_renderer_session')
  if (!finiteInt(delivery.at)) return fail('invalid_input', 'delivery_at')
  return OK
}

/**
 * PresentationIntent（§15）：正文/声音/动画绑定同一表现身份与 epoch。
 */
function validatePresentationIntent (intent) {
  if (!plain(intent)) return fail('invalid_input', 'intent_not_object')
  if (!nonEmptyString(intent.id, 200)) return fail('invalid_input', 'intent_id')
  if (!oneOf(intent.channel, CHANNELS)) return fail('invalid_input', 'intent_channel')
  if (!finiteInt(intent.epoch)) return fail('invalid_input', 'intent_epoch')
  if (!finiteInt(intent.expiresAt)) return fail('invalid_input', 'intent_expires_at')
  if (!nonEmptyString(intent.semanticRef, 240)) return fail('invalid_input', 'intent_semantic_ref')
  if (intent.contentRef !== undefined && intent.contentRef !== null && !nonEmptyString(intent.contentRef, 240)) return fail('invalid_input', 'intent_content_ref')
  if (intent.operationId !== undefined && intent.operationId !== null && !nonEmptyString(intent.operationId, 200)) return fail('invalid_input', 'intent_operation_id')
  if (intent.priority !== undefined && !finiteInt(intent.priority)) return fail('invalid_input', 'intent_priority')
  return OK
}

/**
 * CapabilityManifest v1（§17.1）。宿主以本校验 + 授权表共同决定能否派发；
 * manifest 自称 effect=read 不构成信任。
 */
function validateCapabilityManifest (manifest) {
  if (!plain(manifest)) return fail('invalid_input', 'manifest_not_object')
  if (!nonEmptyString(manifest.id, 160)) return fail('invalid_input', 'manifest_id')
  if (!positiveInt(manifest.version)) return fail('invalid_input', 'manifest_version')
  if (manifest.schemaVersion !== CAPABILITY_MANIFEST_VERSION) return fail('invalid_input', 'manifest_schema_version')
  if (!nonEmptyString(manifest.providerId, 160)) return fail('invalid_input', 'manifest_provider_id')
  if (!oneOf(manifest.effect, EFFECTS)) return fail('invalid_input', 'manifest_effect')
  if (!stringList(manifest.scopes, 32, 120)) return fail('invalid_input', 'manifest_scopes')
  if (!plain(manifest.inputSchema)) return fail('invalid_input', 'manifest_input_schema')
  if (!plain(manifest.outputSchema)) return fail('invalid_input', 'manifest_output_schema')
  if (!oneOf(manifest.idempotency, IDEMPOTENCY)) return fail('invalid_input', 'manifest_idempotency')
  if (!oneOf(manifest.cancel, CANCELABILITY)) return fail('invalid_input', 'manifest_cancel')
  if (!oneOf(manifest.reconcile, RECONCILE)) return fail('invalid_input', 'manifest_reconcile')
  if (!positiveInt(manifest.timeoutMs) || manifest.timeoutMs > 120000) return fail('invalid_input', 'manifest_timeout')
  if (!positiveInt(manifest.maxInputBytes) || !positiveInt(manifest.maxOutputBytes)) return fail('invalid_input', 'manifest_bytes')
  if (!nonEmptyString(manifest.hostApiVersion, 20)) return fail('invalid_input', 'manifest_host_api')
  if (!positiveInt(manifest.dataSchemaVersion)) return fail('invalid_input', 'manifest_data_schema')
  if (!nonEmptyString(manifest.packageHash, 128)) return fail('invalid_input', 'manifest_package_hash')
  if (manifest.scopes.length === 0) return fail('invalid_input', 'manifest_scopes_empty')
  return OK
}

/**
 * Projection（§9.1 read）最小形状：UI 只能渲染投影，不持有第二份权威状态。
 */
function validateProjection (projection) {
  if (!plain(projection)) return fail('invalid_input', 'projection_not_object')
  if (projection.projectionVersion !== PROJECTION_VERSION) return fail('invalid_input', 'projection_version')
  if (!nonEmptyString(projection.characterId, 200)) return fail('invalid_input', 'projection_character_id')
  if (!finiteInt(projection.revision)) return fail('invalid_input', 'projection_revision')
  if (!finiteInt(projection.seq)) return fail('invalid_input', 'projection_seq')
  if (!finiteInt(projection.epoch)) return fail('invalid_input', 'projection_epoch')
  if (!plain(projection.state)) return fail('invalid_input', 'projection_state')
  return OK
}

/** 观测（感知 Adapter → Observation）必须带 freshness，旧标题不等于当前活动。 */
function validateObservation (observation) {
  if (!plain(observation)) return fail('invalid_input', 'observation_not_object')
  if (!nonEmptyString(observation.observationId, 200)) return fail('invalid_input', 'observation_id')
  if (!nonEmptyString(observation.kind, 80)) return fail('invalid_input', 'observation_kind')
  if (!finiteInt(observation.observedAt)) return fail('invalid_input', 'observation_observed_at')
  if (!finiteInt(observation.freshUntil)) return fail('invalid_input', 'observation_fresh_until')
  if (!plain(observation.payload)) return fail('invalid_input', 'observation_payload')
  if (observation.freshUntil <= observation.observedAt) return fail('invalid_input', 'observation_freshness')
  return OK
}

/** 状态转移合法性（Operation）。unknown 不得直接改回 authorized 盲发。 */
function canTransition (from, to) {
  const allowed = OPERATION_TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

module.exports = {
  PROTOCOL_VERSION,
  EVENT_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION,
  COMMAND_SCHEMA_VERSION,
  CAPABILITY_MANIFEST_VERSION,
  PROJECTION_VERSION,
  WORLDS,
  TRUST,
  RETENTION,
  PERMISSION,
  ASSERTION_STATUS,
  MEMORY_LIFECYCLE,
  CONCERN_STATUS,
  PROJECT_STATUS,
  OPERATION_STATES,
  OPERATION_TRANSITIONS,
  EFFECTS,
  DETERMINISTIC_EFFECTS,
  IDEMPOTENCY,
  CANCELABILITY,
  RECONCILE,
  CHANNELS,
  DELIVERY_PHASES,
  OPPORTUNITY_KINDS,
  FAILURE_CLASSES,
  COMMAND_KINDS,
  canTransition,
  validateEvent,
  validateCommand,
  validateOperation,
  validateReceipt,
  validateDelivery,
  validatePresentationIntent,
  validateCapabilityManifest,
  validateProjection,
  validateObservation,
  plain,
  nonEmptyString,
  boundedString,
  finiteInt,
  positiveInt,
  oneOf,
  stringList,
}
