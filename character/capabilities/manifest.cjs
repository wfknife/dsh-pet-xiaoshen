'use strict'
/**
 * K5 CapabilityManifest v1 内置定义（总规 §17.1）。
 *
 * 每个 manifest 的 effect 决定崩溃后如何处理，因此它必须由宿主定义，
 * 不能由插件在运行时自报后即被信任。
 */

const { CAPABILITY_MANIFEST_VERSION } = require('../contracts.cjs')
const { hash } = require('../ids.cjs')

const HOST_API_VERSION = '1.0.0'

function manifest (definition) {
  return {
    schemaVersion: CAPABILITY_MANIFEST_VERSION,
    hostApiVersion: HOST_API_VERSION,
    dataSchemaVersion: 1,
    idempotency: 'local',
    cancel: 'supported',
    reconcile: 'supported',
    timeoutMs: 15000,
    maxInputBytes: 16 * 1024,
    maxOutputBytes: 64 * 1024,
    description: '',
    ...definition,
    packageHash: definition.packageHash || hash('builtin:' + definition.id + '@' + definition.version),
  }
}

const BUILTIN = Object.freeze([
  manifest({ id: 'presentation.animation', version: 1, providerId: 'character.presentation', effect: 'virtual',
    scopes: ['presentation:animation'], idempotency: 'local', cancel: 'best-effort', reconcile: 'unsupported', timeoutMs: 5000,
    description: '播放一个现有桌宠动画；只在真实 ended 回执后记作虚拟经历。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['name'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { presentationId: { type: 'string' } }, required: ['presentationId'] } }),
  /**
   * 本地虚拟休息：修改的是角色自身状态（internal），不产生任何对外事实。
   */
  manifest({
    id: 'virtual.rest_local',
    version: 1,
    providerId: 'character.builtin',
    effect: 'internal',
    scopes: ['character:state:write'],
    idempotency: 'local',
    cancel: 'supported',
    reconcile: 'supported',
    description: '让角色安静休息一段时间，按既有 NeedsSystem 规则恢复精力。',
    inputSchema: { type: 'object', properties: { minutes: { type: 'number', minimum: 1, maximum: 120 } }, required: ['minutes'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { minutes: { type: 'number', minimum: 1, maximum: 120 }, resting: { type: 'boolean' } }, required: ['minutes', 'resting'] },
    timeoutMs: 1000,
  }),

  /**
   * 虚拟笔记：写一个 artifact（staging + hash 后提交引用）。
   * 需要来源；没有来源就不能写，避免“编造经历”。
   */
  manifest({
    id: 'virtual.note',
    version: 1,
    providerId: 'character.builtin',
    effect: 'virtual',
    scopes: ['character:artifact:write'],
    idempotency: 'local',
    cancel: 'unsupported',
    reconcile: 'supported',
    description: '给自己写一条带来源的虚拟笔记，产物是可检索的 artifact。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        topicKey: { type: 'string', maxLength: 120 },
      },
      required: ['title', 'text'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { artifactId: { type: 'string' }, hash: { type: 'string' } }, required: ['artifactId', 'hash'] },
    timeoutMs: 10000,
  }),

  /**
   * 文本表现：一次发言是一次表现操作；发布成功 ≠ 领域动作成功（不变量 8）。
   */
  manifest({
    id: 'presentation.text',
    version: 1,
    providerId: 'character.presentation',
    effect: 'virtual',
    scopes: ['presentation:text'],
    idempotency: 'local',
    cancel: 'best-effort',
    reconcile: 'unsupported',
    description: '向主人展示一段文字（气泡/聊天）。这是表现，不是事实来源。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        semanticRef: { type: 'string', maxLength: 240 },
        animationHint: { type: 'string', maxLength: 60 },
      },
      required: ['text', 'semanticRef'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { presentationId: { type: 'string' } }, required: ['presentationId'] },
    timeoutMs: 5000,
  }),

  /** 感知：读操作。崩溃后可预算内重读，并标注新的观测时间。 */
  manifest({
    id: 'desktop.observe.foreground',
    version: 1,
    providerId: 'host.desktop',
    effect: 'read',
    scopes: ['os:foreground'],
    idempotency: 'local',
    cancel: 'best-effort',
    reconcile: 'supported',
    description: '读取当前前台应用标题（需要主人授权；旧标题不等于当前活动）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { app: { type: 'string' }, title: { type: 'string' }, observedAt: { type: 'number' } } },
    timeoutMs: 3000,
  }),

  manifest({
    id: 'desktop.observe.media',
    version: 1,
    providerId: 'host.desktop',
    effect: 'read',
    scopes: ['os:media'],
    idempotency: 'local',
    cancel: 'best-effort',
    reconcile: 'supported',
    description: '读取当前媒体播放元数据（不推断主人喜好）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { title: { type: 'string' }, artist: { type: 'string' }, observedAt: { type: 'number' } } },
    timeoutMs: 3000,
  }),

  /**
   * 外部任务派发（DSH Adapter）。默认 external-unknown：
   * 接受请求 ≠ 任务完成，产物返回必须有独立回执。
   */
  manifest({
    id: 'dsh.task.dispatch',
    version: 1,
    providerId: 'host.dsh',
    effect: 'external-unknown',
    scopes: ['dsh:task:create'],
    idempotency: 'none',
    cancel: 'best-effort',
    reconcile: 'supported',
    description: '向 DSH 派发一个任务。派活被接受、进行中、产物返回是三种不同事实。',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 }, workspace: { type: 'string', maxLength: 260 } },
      required: ['prompt'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { taskId: { type: 'string' }, accepted: { type: 'boolean' } }, required: ['accepted'] },
    timeoutMs: 30000,
    maxInputBytes: 32 * 1024,
  }),
])

function builtinManifests () {
  return BUILTIN.map(item => ({ ...item, scopes: item.scopes.slice() }))
}

function findBuiltin (id, version) {
  return BUILTIN.find(item => item.id === id && (version === undefined || item.version === version)) || null
}

/** 给模型看的裁剪目录：不含凭据、路径、内部 provider 细节。 */
function catalogView (manifests) {
  return (manifests || []).map(item => ({
    id: item.id,
    version: item.version,
    effect: item.effect,
    scopes: item.scopes,
    description: item.description,
    inputSchema: item.inputSchema,
  }))
}

module.exports = { HOST_API_VERSION, BUILTIN, builtinManifests, findBuiltin, catalogView, manifest }
