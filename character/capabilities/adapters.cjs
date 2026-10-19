'use strict'
/**
 * K5 内置能力 Adapter 实现。
 *
 * 边界（总规 §17.1 / §20 K5）：
 *  - Adapter 只做“这件事本身”，不判断候选、不排序、不改角色身份；
 *  - 返回值必须区分：真的成功（有产物/hash）、明确失败（可安全重试）、
 *    未知（可能已经生效，只能核对）；
 *  - 虚拟产物先写 staging 再 rename，提交引用后才算成功（残留 staging 可清理）；
 *  - 外部文本一律标 `trust: external_content`，不因工具“建议下一步”就获得授权。
 */

const fs = require('node:fs')
const path = require('node:path')
const { hash, deterministicId } = require('../ids.cjs')

function safeName (text) {
  return String(text || '').replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 60) || 'note'
}

/**
 * @param {{paths: object, host: object, presentation: object, now: Function}} deps
 */
function createBuiltinAdapters (deps) {
  const paths = deps.paths
  const host = deps.host || {}
  const presentation = deps.presentation || {}
  const clock = deps.now

  function callHost (method, payload, signal) {
    if (!host || typeof host.request !== 'function') {
      return { ok: false, applied: false, reason: 'host_unavailable' }
    }
    return host.request(method, payload, { signal })
  }

  const restLocal = {
    id: 'virtual.rest_local',
    version: 1,
    provider: 'character.builtin',
    timeoutMs: 1000,
    async invoke (input, context) {
      const minutes = Math.max(1, Math.min(120, Number(input && input.minutes) || 15))
      return {
        ok: true,
        output: { minutes, resting: true },
        evidence: { kind: 'rest', minutes },
        occurredAt: clock(),
      }
    },
    /* 内部效果没有外部副作用，核对只需看已提交 state。 */
    async reconcile (operation) {
      return { applied: false, evidence: { note: 'internal_effect_has_no_external_state' } }
    },
  }

  const virtualNote = {
    id: 'virtual.note',
    version: 1,
    provider: 'character.builtin',
    timeoutMs: 10000,
    async invoke (input, context) {
      const sourceRefs = (context && context.sourceRefs) || []
      if (!sourceRefs.length) {
        // 没有来源就不写笔记：不允许“编造经历”。
        return { ok: false, applied: false, reason: 'source_required' }
      }
      const title = String((input && input.title) || '').slice(0, 120)
      const text = String((input && input.text) || '').slice(0, 4000)
      if (!title || !text) return { ok: false, applied: false, reason: 'note_content_empty' }

      const noteId = deterministicId('art', operationSeed(context, title, text, sourceRefs))
      const relative = path.posix.join('notes', noteId.replace(/[:]/g, '-') + '.json')
      const body = JSON.stringify({
        noteId, title, text, topicKey: (input && input.topicKey) || null,
        sourceRefs, world: 'virtual', createdAt: clock(),
      }, null, 2)
      const contentHash = hash(body)

      try {
        fs.mkdirSync(paths.staging, { recursive: true })
        const staged = path.join(paths.staging, noteId.replace(/[:]/g, '-') + '.' + process.pid + '.json')
        fs.writeFileSync(staged, body, 'utf8')
        createTaskIndex(context, { artifactId: noteId, relativePath: relative, hash: contentHash, sourceRefs })
        const target = path.join(paths.artifacts, relative)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.renameSync(staged, target)
        const verified = hash(fs.readFileSync(target)) === contentHash
        if (!verified) return { ok: false, applied: 'unknown', reason: 'artifact_hash_mismatch' }
        return {
          ok: true,
          output: { artifactId: noteId, hash: contentHash, relativePath: relative },
          artifactRefs: [noteId],
          evidence: { kind: 'virtual_note', relativePath: relative, contentHash, sourceRefs },
          occurredAt: clock(),
        }
      } catch (error) {
        return { ok: false, applied: 'unknown', reason: 'artifact_write_failed:' + String(error && error.code ? error.code : error).slice(0, 80) }
      }
    },
    async reconcile (operation, context) {
      // 虚拟产物可核对：staging/artifacts 里是否存在同名且 hash 一致的文件。
      const seed = (context && context.seed) || readTaskIndex(context)
      if (!seed?.relativePath || !seed.artifactId || !seed.hash) return { applied: 'unknown' }
      const target = path.join(paths.artifacts, seed.relativePath)
      if (!fs.existsSync(target)) return { applied: false }
      const contentHash = hash(fs.readFileSync(target))
      if (seed.hash && contentHash !== seed.hash) return { applied: false }
      return { applied: true, output: { artifactId: seed.artifactId, hash: contentHash, relativePath: seed.relativePath }, artifactRefs: [seed.artifactId], evidence: { sourceRefs: seed.sourceRefs || [] } }
    },
  }

  const presentationText = {
    id: 'presentation.text',
    version: 1,
    provider: 'character.presentation',
    timeoutMs: 5000,
    async invoke (input, context) {
      const text = String((input && input.text) || '').slice(0, 2000)
      if (!text) return { ok: false, applied: false, reason: 'text_empty' }
      if (!presentation || typeof presentation.publish !== 'function') {
        // 表现通道不可用时，领域动作不能被改成失败：这里报告“表现不可用”，
        // operation 仍然是一次真实的“生成并尝试发布”。
        return { ok: false, applied: false, reason: 'presentation_unavailable' }
      }
      const presentationId = deterministicId('pres', (context && context.operationId) + '|' + hash(text))
      const published = await presentation.publish({
        presentationId,
        operationId: context && context.operationId,
        channel: 'text',
        text,
        semanticRef: (input && input.semanticRef) || 'auto',
        animationHint: (input && input.animationHint) || null,
        epoch: context && context.epoch,
      })
      if (!published || published.ok !== true) {
        return { ok: false, applied: false, reason: 'presentation_rejected:' + String(published && published.reason || 'unknown') }
      }
      return {
        ok: true,
        output: { presentationId },
        evidence: { kind: 'presentation_published', presentationId, sourceRefs: context.sourceRefs || [] },
        occurredAt: clock(),
      }
    },
    async reconcile () {
      // 文本发布没有可核对的外部状态；不要把“可能已显示”当成确定事实。
      return { applied: 'unknown' }
    },
  }

  function observationAdapter (id, method, shape) {
    return {
      id,
      version: 1,
      provider: 'host.desktop',
      timeoutMs: 3000,
      async invoke (input, context) {
        const result = await Promise.resolve(callHost(method, {}, context.signal))
        if (!result || result.ok !== true) {
          return { ok: false, applied: false, reason: String(result && result.reason || 'sensor_unavailable') }
        }
        return { ok: true, output: shape(result.value || {}, clock()), evidence: { kind: 'sensor_read', sensor: id }, occurredAt: clock() }
      },
      async reconcile () {
        // read 类操作可以重读并标注新的观测时间；核对本身不产生业务事实。
        return { applied: 'unknown', evidence: { note: 'read_effect_reobserves' } }
      },
    }
  }
  const foreground = observationAdapter('desktop.observe.foreground', 'desktop.foreground', (value, now) => ({
    app: String(value.app || '').slice(0, 120),
    title: String(value.title || '').slice(0, 240),
    observedAt: Number(value.observedAt) || now,
    trust: 'sensor',
  }))
  const media = observationAdapter('desktop.observe.media', 'desktop.media', (value, now) => ({
    title: String(value.title || '').slice(0, 200),
    artist: String(value.artist || '').slice(0, 200),
    observedAt: Number(value.observedAt) || now,
    trust: 'sensor',
  }))

  const dshTask = {
    id: 'dsh.task.dispatch',
    version: 1,
    provider: 'host.dsh',
    timeoutMs: 30000,
    async invoke (input, context) {
      const result = await Promise.resolve(callHost('dsh.createTask', {
        prompt: String((input && input.prompt) || '').slice(0, 8000),
        workspace: input && input.workspace ? String(input.workspace).slice(0, 260) : undefined,
        operationId: context.operationId,
      }, context.signal))
      if (!result || result.ok !== true) {
        // 派发请求失败时也可能已经创建了任务 → 无幂等键的外部动作必须 unknown。
        const uncertain = !!(result && result.mayHaveApplied)
        return uncertain
          ? { ok: false, applied: 'unknown', reason: String(result.reason || 'dsh_dispatch_unclear') }
          : { ok: false, applied: false, reason: String(result && result.reason || 'dsh_unavailable') }
      }
      try { createTaskIndex(context, result) } catch (_) { return { ok: false, applied: 'unknown', reason: 'task_index_failed' } }
      return {
        ok: true,
        // “已被接受”不是“已完成”：output 只声明 accepted。
        output: { accepted: true, taskId: result.taskId ? String(result.taskId).slice(0, 160) : undefined },
        evidence: { kind: 'dsh_task_accepted', taskId: result.taskId || null },
        occurredAt: clock(),
      }
    },
    async reconcile (operation, context) {
      const index = readTaskIndex(context)
      if (!index || !index.taskId) return { applied: 'unknown' }
      const status = await Promise.resolve(callHost('dsh.taskStatus', { taskId: index.taskId }))
      if (!status || status.ok !== true) return { applied: 'unknown' }
      if (status.accepted === true) return { applied: true, output: { accepted: true, taskId: index.taskId }, evidence: { reconciled: true, state: status.state, completionConfirmed: false } }
      if (status.state === 'failed' || status.state === 'cancelled') return { applied: true, output: { accepted: true, taskId: index.taskId }, evidence: { reconciled: true, state: status.state } }
      // running / queued：已接受但未完成，继续保持 unknown，等待后续回执。
      return { applied: 'unknown' }
    },
  }

  // 任务索引让“派活已接受”有最小落盘记录，便于崩溃后核对（不放在角色主库）。
  function taskIndexPath (context) {
    const dir = path.join(paths.root, 'capability-index')
    const id = (context && context.operationId) || 'unknown'
    return path.join(dir, String(id).replace(/[:/\\]/g, '-') + '.json')
  }
  function createTaskIndex (context, result) {
      const file = taskIndexPath(context)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file + '.tmp', JSON.stringify({ ...result, operationId: context && context.operationId, at: clock() }), 'utf8')
      fs.renameSync(file + '.tmp', file)
  }
  function readTaskIndex (context) {
    try {
      const raw = fs.readFileSync(taskIndexPath(context), 'utf8')
      return JSON.parse(raw)
    } catch (_) { return null }
  }

  function operationSeed (context, title, text, sourceRefs) {
    return (context && context.operationId) + '|' + title + '|' + hash(text) + '|' + sourceRefs.join(',')
  }

  const map = {
    'presentation.animation': { version: 1, timeoutMs: 5000,
      async invoke(input, context) {
        if (!/^[a-z0-9-]{1,80}$/.test(input.name)) return { ok: false, applied: false, reason: 'animation_name_invalid' }
        const presentationId = deterministicId('pres', context.operationId + '|animation|' + input.name)
        const published = await presentation.publish({ presentationId, operationId: context.operationId, channel: 'animation', animationName: input.name, epoch: context.epoch })
        return published?.ok ? { ok: true, output: { presentationId }, evidence: { kind: 'animation_requested', name: input.name }, occurredAt: clock() } : { ok: false, applied: false, reason: published?.reason || 'presentation_unavailable' }
      }, reconcile: async () => ({ applied: 'unknown' }) },
    'virtual.rest_local': restLocal,
    'virtual.note': virtualNote,
    'presentation.text': presentationText,
    'desktop.observe.foreground': foreground,
    'desktop.observe.media': media,
    'dsh.task.dispatch': dshTask,
  }
  return map
}

module.exports = { createBuiltinAdapters }
