'use strict'
/**
 * K2 Character Kernel：单角色、单写者、可恢复的命令处理器。
 *
 * 结构（总规 §9.1 / §12）：
 *   submit(command)  校验 → 单事务提交（事件/状态/实体/outbox/job）→ 返回已提交回执
 *   read(query)      同一 revision 的只读投影
 *   subscribe(cursor) 提交后推送 delta（不重播旧气泡）
 *
 * 硬约束：
 *  - 事务内绝不做模型调用、能力派发、动画播放（不变量 9）；
 *  - 旧 epoch 的结果不能提交；命令去重键冲突必须明确冲突而不是覆盖；
 *  - 取消只阻止后到的**发布**，不抹去已经发生的结果（不变量 5）；
 *  - 没有合法候选就等待，不编造经历（§4.5）。
 */

const { createStore } = require('../storage/store.cjs')
const { createPolicyStore } = require('../storage/policy-store.cjs')
const { createImporter } = require('../storage/import-legacy.cjs')
const { createExporter } = require('../storage/export.cjs')
const { createRegistry } = require('../capabilities/registry.cjs')
const { createExecutor } = require('../capabilities/executor.cjs')
const { createBuiltinAdapters } = require('../capabilities/adapters.cjs')
const { builtinManifests, catalogView, findBuiltin } = require('../capabilities/manifest.cjs')
const { createRetriever } = require('../memory/retriever.cjs')
const { createProjector } = require('../context/projector.cjs')
const { createCandidateBuilder } = require('../behavior/candidates.cjs')
const { createRules } = require('../behavior/rules.cjs')
const { getRecipe, recipesForKind, listRecipes, validateProposedPlan } = require('../behavior/recipes.cjs')
const planMachine = require('../behavior/plan.cjs')
const lifecycle = require('../memory/lifecycle.cjs')
const admission = require('../memory/admission.cjs')
const reducer = require('../domain/reducer.cjs')
const lifeDomain = require('../domain/life.cjs')
const growth = require('../domain/growth.cjs')
const { createModelGateway } = require('../cognition/model-gateway.cjs')
const { createDecider } = require('../cognition/decide.cjs')
const { createExpresser } = require('../cognition/express.cjs')
const { createExtractor } = require('../cognition/extract.cjs')
const { createReflector } = require('../cognition/reflect.cjs')
const { buildDiary } = require('../projections/diary.cjs')
const { createSlots } = require('../../renderer/dialogue/slots.js')
const stylePolicy = require('../../renderer/dialogue/style/style-policy.js').createPolicy(() => ({
  rules: require('../../renderer/dialogue/style/rules.json'), profiles: require('../../renderer/dialogue/style/profiles.json'),
}))
const contracts = require('../contracts.cjs')
const { CharacterError, rejected, conflict, unavailable, normalize } = require('../errors.cjs')
const { deterministicId, hash, isSafeId, uuid } = require('../ids.cjs')

const JOB_KINDS = Object.freeze(['needs_tick', 'owner_reply', 'extract_fact', 'behavior_tick', 'concern_check', 'reflection', 'maintenance'])
/** 这些 job 自己管理终态/下一次调度；不能在 executeJob 末尾再标 done。 */
const SELF_SCHEDULING_JOBS = new Set(['needs_tick', 'owner_reply', 'behavior_tick', 'concern_check', 'maintenance', 'extract_fact'])
const VISIBLE_COMMANDS = Object.freeze(['owner.message', 'owner.control', 'owner.forget', 'owner.correct', 'owner.reminder'])

/**
 * @param {{paths: object, config: object, host: object, now?: Function, logger?: Function,
 *          presentation?: object, mode?: string}} deps
 */
function createKernel (deps) {
  const paths = deps.paths
  const config = deps.config
  const host = deps.host || {}
  const mode = deps.mode || paths.mode || 'candidate'
  const clock = typeof deps.now === 'function' ? deps.now : Date.now
  const log = typeof deps.logger === 'function' ? deps.logger : () => {}

  const store = createStore({ file: paths.mainDb, now: clock })
  const policyStore = createPolicyStore({ file: paths.policyDb, now: clock })
  const registry = createRegistry({ config, now: clock })
  const adapters = createBuiltinAdapters({ paths, host, presentation: deps.presentation, now: clock })
  const executor = createExecutor({ registry, adapters, config, now: clock })
  const gateway = createModelGateway({ host, config, now: clock })
  const retriever = createRetriever({ config, now: clock })
  const projector = createProjector({ config, retriever, now: clock })
  const candidates = createCandidateBuilder({ config, now: clock })
  const rules = createRules({ config, now: clock })
  const decider = createDecider({ gateway, config })
  const expresser = createExpresser({ gateway })
  const extractor = createExtractor({ gateway, config })
  const reflector = createReflector({ gateway, config })
  const importer = createImporter({ store, policyStore, dataDir: deps.dataDir, now: clock })
  const exporter = createExporter({ store, policyStore, paths, now: clock })
  // Reuse the installed package/worker lifecycle. Only its persistence adapter
  // changes: activation records and namespaces now commit in the Kernel DB.
  const packageStore = {
    snapshot: () => store.read(gw => safeJson(gw.getMeta('packages:v1')) || { packages: {}, namespaces: {} }),
    transaction: fn => store.transaction(gw => {
      const state = safeJson(gw.getMeta('packages:v1')) || { packages: {}, namespaces: {} }
      const result = fn(state)
      gw.setMeta('packages:v1', JSON.stringify(state))
      return result
    }),
  }
  const packageRegistry = {
    register(definition, invoke) {
      const parts = String(definition.version).split('.').map(Number)
      if (parts.length !== 3 || parts.some(n => !Number.isInteger(n) || n < 0 || n >= 10000)) throw Error('package_version_invalid')
      const version = parts[0] * 100000000 + parts[1] * 10000 + parts[2] + 1
      if (findBuiltin(definition.id)) throw Error('package_builtin_override_denied')
      const manifest = require('../capabilities/manifest.cjs').manifest({ id: definition.id, version,
        providerId: definition.provider, packageHash: definition.packageHash, effect: definition.effect,
        scopes: ['package:' + definition.provider], cancel: 'best-effort', reconcile: 'unsupported',
        inputSchema: definition.input || { type: 'object', additionalProperties: true },
        outputSchema: definition.output || { type: 'object', additionalProperties: true }, timeoutMs: definition.timeoutMs })
      const registered = registry.register(manifest)
      if (!registered.ok) throw Error(registered.code)
      adapters[definition.id + '@' + version] = { version, timeoutMs: definition.timeoutMs,
        async invoke(input, context) {
          if (definition.available && !definition.available()) return { ok: false, applied: false, reason: 'package_unavailable' }
          const output = await invoke(input, { operationId: context.operationId, request: async (service, value) => {
            if (context.signal?.aborted || stopped) throw Error('operation_cancelled')
            if (!(definition.services || []).includes(service)) throw Error('package_service_denied')
            if (service === 'package.echo') return value
            // Services are delegated through another authorized operation, never
            // through the retired renderer/platform domain.
            const project = service === 'life.virtual-project' ? store.read(gw => gw.getProject(value?.projectId)) : null
            if (service === 'life.virtual-project' && (!project || project.characterId !== characterId || !['active','proposed'].includes(project.status))) throw Error('project_not_active')
            if (project && project.recipeId !== 'virtual_note') throw Error('project_recipe_not_supported_by_notebook')
            const id = service === 'desktop.observe' ? 'desktop.observe.foreground' : project ? 'virtual.note' : null
            if (!id) throw Error('package_service_unavailable')
            const result = await invokeCapability({ capabilityId: id, input: project ? { title: project.goal.slice(0,120), text: '虚拟项目记录：' + project.goal, topicKey: project.projectId } : {}, sourceRefs: project ? project.sourceRefs : context.sourceRefs,
              dedupeKey: context.operationId + '|service|' + service })
            if (!result.ok) throw Error(result.code || 'package_service_failed')
            if (project) {
              store.transaction(gw => {
                const latest = gw.getProject(project.projectId)
                if (!latest || latest.revision !== project.revision || !['active','proposed'].includes(latest.status) || project.sourceRefs.some(ref => policyStore.isDeleted(ref))) throw Error('project_invalidated')
                gw.putProject({ ...latest, status: 'completed', stepCursor: latest.stepCursor + 1,
                  artifactRefs: [...new Set([...(latest.artifactRefs || []), result.output.artifactId])], revision: latest.revision + 1, nextWakeAt: null })
              })
              return { operationId: result.operation.operationId, step: project.stepCursor + 1, virtual: true, kind: 'virtual_notebook',
                text: ('虚拟笔记：' + project.goal).slice(0,240), sourceRefs: project.sourceRefs, eventAt: clock(), hash: result.output.hash,
                quotedRole: 'user', ownerTaskCompleted: false, artifactId: result.output.artifactId }
            }
            return result.output
          } })
          return { ok: true, output, evidence: { packageHash: definition.packageHash, release: definition.version, operationId: context.operationId }, occurredAt: clock() }
        },
        reconcile: async () => ({ applied: 'unknown' }),
      }
      return () => registry.disable(definition.id, version)
    },
    disable(provider) { for (const item of registry.list()) if (item.providerId === provider) registry.disable(item.id, item.version) },
  }
  const packages = require('../../platform-packages.cjs').createPackages(paths.root, packageStore, packageRegistry)

  let characterId = null
  let epoch = 0
  let ready = false
  let readOnly = false
  let paused = false
  let chain = Promise.resolve()
  let packageChain = Promise.resolve()
  let packagesReady = Promise.resolve([])
  const asyncCommands = new Map()
  const listeners = new Set()
  const inflight = new Set()
  let turnAbort = null
  let schedulerTimer = null
  let stopped = false
  let autonomyGeneration = 0
  let behaviorRunning = false
  let replyAbort = null
  let replyGeneration = 0

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  function start () {
    let opened
    try {
      opened = store.open()
    } catch (error) {
      // 驱动缺失（better-sqlite3 未安装且无 node:sqlite）会在这里抛出。
      // 这是**明确失败**：不允许静默降级回 JSON 写入。
      readOnly = true
      ready = false
      return { ok: false, code: error && error.code || 'storage_unavailable', reason: error && error.message, diagnostics: error && error.diagnostics }
    }
    if (!opened.ok) {
      readOnly = true
      ready = false
      return { ok: false, code: opened.code || 'storage_unavailable', reason: opened.reason }
    }
    try {
      policyStore.open()
    } catch (error) {
      readOnly = true
      ready = false
      return { ok: false, code: 'policy_store_unavailable', reason: error && error.message }
    }
    if (deps.bootstrapLegacy && !store.read(gw => gw.getMeta('character_id'))) {
      const imported = importer.run()
      if (!imported.ok) return { ok: false, code: 'legacy_bootstrap_failed', reason: imported.reason }
    }
    const registration = registry.registerAll(builtinManifests())
    const failed = registration.filter(item => item.ok !== true)
    if (failed.length) log('capability registration failed', JSON.stringify(failed))

    const started = store.transaction(gw => {
      characterId = gw.getMeta('character_id')
      if (!characterId) {
        characterId = 'char-' + uuid()
        gw.setMeta('character_id', characterId)
        gw.putCharacter({ characterId, identityRevision: 1, revision: 0, writerEpoch: 0, createdAt: clock() })
      }
      const previous = gw.getCharacter(characterId)
      const bumped = gw.bumpEpoch(characterId)
      epoch = bumped.writerEpoch
      const state = gw.getState(characterId)
      if (!state) {
        gw.writeState({
          characterId, revision: 1, identityRevision: previous ? previous.identityRevision : 1,
          schemaVersion: contracts.STATE_SCHEMA_VERSION, body: reducer.initialState({}), seq: 0,
        })
      }
      // 恢复顺序：先 policy（删除决定），再补清理，再恢复 jobs/operations（§11.3 / §12.1）
      const pendingCleanup = policyStore.pendingCleanup()
      lifecycle.forget({ gw, policyStore, characterId, sourceIds: pendingCleanup.map(item => item.sourceId), reason: 'recovery_cleanup', now: clock(), seq: gw.lastSeq(characterId).seq })
      gw.reclaimAllLeases(characterId)
      recoverOperations(gw)
      gw.setMeta('needs:last_tick', clock())
      return { revision: gw.getState(characterId).revision, seq: gw.lastSeq(characterId).seq, cleanup: pendingCleanup.length, previousEpoch: previous ? previous.writerEpoch : 0, bumpedEpoch: epoch }
    })

    policyStore.markCleaned(policyStore.pendingCleanup().map(item => item.sourceId))
    paused = !!store.read(gw => gw.getState(characterId).body.attentionPolicy?.autonomyPaused)
    ready = true
    applyNurture({ kind: 'boot', commandId: 'boot:' + epoch })
    packagesReady = packages.restore().then(results => { if (results.some(result => !result.ok)) log('package restore incomplete', JSON.stringify(results)); return results })
    track(packagesReady)
    registerDefaultJobs()
    scheduleNextWake()
    return { ok: true, characterId, epoch, revision: store.read(gw => gw.getState(characterId).revision), seq: started.seq, recoveredCleanup: started.cleanup, mode }
  }

  /**
   * 崩溃恢复：不重放历史网络调用，只把状态改成“需要核对/已失败”，
   * 并把未完成的 job 交回调度（§18.2 Kernel 崩溃行）。
   */
  function recoverOperations (gw) {
    for (const operation of gw.listOperations(characterId, ['authorized', 'dispatched', 'cancel_requested'])) {
      if (operation.status === 'authorized') {
        // 未派发：可安全作废（没有外部效果的可能）。
        gw.patchOperation(operation.operationId, { status: 'expired', unknownReason: 'expired_on_restart' })
        continue
      }
      if (operation.effect === 'read') {
        gw.patchOperation(operation.operationId, { status: 'failed', unknownReason: 'read_in_flight_on_restart' })
      } else {
        gw.patchOperation(operation.operationId, { status: 'unknown', unknownReason: 'kernel_restart_before_receipt' })
      }
    }
    for (const plan of gw.listActivePlans(characterId)) {
      // 旧 epoch 的计划不得继续提交；转 paused 并保留原因。
      if (plan.epoch !== epoch) {
        gw.patchPlan(plan.planId, { status: 'paused', cancelReason: 'epoch_changed_on_restart' })
      }
    }
    // 租约已在 start() 中由 reclaimAllLeases 统一收回；到期 job 由调度器重新认领，
    // 这里不再重复处理，避免与 runSchedulerOnce 竞争同一行。
  }

  function registerDefaultJobs () {
    const now = clock()
    store.transaction(gw => {
      gw.putJob({ jobId: deterministicId('job', characterId + '|needs_tick'), dedupeKey: characterId + '|needs_tick',
        characterId, kind: 'needs_tick', dueAt: now + 60000, payloadRef: null })
      gw.putJob({ jobId: deterministicId('job', characterId + '|concern_check|boot'), dedupeKey: characterId + '|concern_check',
        characterId, kind: 'concern_check', dueAt: now + 1000, payloadRef: null })
      gw.putJob({
        jobId: deterministicId('job', characterId + '|behavior_tick|boot'),
        dedupeKey: characterId + '|behavior_tick',
        characterId, kind: 'behavior_tick', dueAt: now + 5000, payloadRef: null,
      })
      gw.putJob({
        jobId: deterministicId('job', characterId + '|maintenance|boot'),
        dedupeKey: characterId + '|maintenance',
        characterId, kind: 'maintenance', dueAt: now + 60000, payloadRef: null,
      })
      return { ok: true }
    })
  }

  async function stop () {
    stopped = true
    autonomyGeneration++
    if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null }
    if (turnAbort) { try { turnAbort.abort() } catch (_) {} turnAbort = null }
    if (replyAbort) replyAbort.abort()
    replyGeneration++
    executor.cancelAll()
    ready = false
    await Promise.allSettled([...inflight])
    await packages.shutdown()
    store.close()
    policyStore.close()
    return { ok: true }
  }

  /* ------------------------------------------------------------------ *
   * 订阅
   * ------------------------------------------------------------------ */

  function subscribe (cursor, listener) {
    const entry = { cursor: Number(cursor) || 0, listener }
    listeners.add(entry)
    return () => listeners.delete(entry)
  }

  function emit (kind, detail) {
    if (!listeners.size) return
    let payload = null
    try {
      payload = read({ kind: 'projection' })
    } catch (error) { log('emit projection failed', error.message) }
    const delta = { kind, detail, projection: payload, at: clock() }
    for (const entry of Array.from(listeners)) {
      try {
        entry.listener(delta)
        if (payload) entry.cursor = payload.seq
      } catch (error) { listeners.delete(entry) }
    }
  }

  /* ------------------------------------------------------------------ *
   * 命令入口
   * ------------------------------------------------------------------ */

  function submit (command) {
    if (command && ['package.manage','capability.invoke'].includes(command.kind)) {
      const signature = hash({ kind: command.kind, payload: command.payload })
      const pending = asyncCommands.get(command.commandId)
      if (pending) return pending.signature === signature ? pending.task : Promise.resolve({ ok: false, code: 'command_conflict' })
      const task = command.kind === 'package.manage' ? packageChain.then(() => handleSubmit(command)) : handleSubmit(command)
      if (command.kind === 'package.manage') packageChain = task.catch(() => {})
      asyncCommands.set(command.commandId, { signature, task })
      track(task.finally(() => asyncCommands.delete(command.commandId)))
      return task
    }
    // 串行化：同一时刻只有一个命令在写；但模型等待不持锁（不是全局互斥）。
    const task = chain.then(() => handleSubmit(command))
    chain = task.catch(() => {})
    return task
  }

  async function handleSubmit (command) {
    const validation = contracts.validateCommand(command)
    if (!validation.ok) return { ok: false, code: validation.code, failureClass: 'rejected', detail: validation.detail }
    if (!ready) return { ok: false, code: readOnly ? 'read_only' : 'storage_unavailable', failureClass: 'unavailable' }
    if (command.characterId !== characterId) return { ok: false, code: 'character_mismatch', failureClass: 'rejected' }

    const inputHash = hash({ kind: command.kind, payload: command.payload })
    const prior = store.read(gw => gw.getCommandReceipt(command.commandId))
    if (prior) {
      if (prior.inputHash !== inputHash) return { ok: false, code: 'command_conflict', failureClass: 'conflict' }
      return { ok: true, replayed: true, ...prior.result }
    }
    if (command.expectedEpoch !== undefined && command.expectedEpoch !== null && command.expectedEpoch !== epoch) {
      return { ok: false, code: 'stale_epoch', failureClass: 'conflict', detail: { current: epoch, expected: command.expectedEpoch } }
    }
    if (command.expectedRevision != null && command.expectedRevision !== store.read(gw => gw.getState(characterId).revision)) {
      return { ok: false, code: 'stale_revision', failureClass: 'conflict' }
    }

    try {
      // Export performs filesystem snapshot work; all domain commands and their
      // idempotency receipt commit together. No model/network await under this lock.
      const commit = () => store.transaction(gw => {
        const result = dispatchCommand(command, inputHash)
        if (result && typeof result.then === 'function') throw new Error('async_command_in_transaction')
        if (result && result.ok) gw.putCommandReceipt({ commandId: command.commandId, inputHash, acceptedAt: clock(), result })
        return result
      })
      const animation = command.kind === 'owner.interaction' && command.payload.kind === 'animation'
      const asyncCommand = animation || ['package.manage', 'capability.invoke'].includes(command.kind)
      const result = asyncCommand ? await (command.kind === 'package.manage' ? managePackage(command.payload) : invokeCapability(animation ? { capabilityId: 'presentation.animation', input: { name: command.payload.name }, dedupeKey: command.commandId } : { ...command.payload, dedupeKey: command.commandId })) : command.kind === 'export.run' ? handleExport(command) : commit()
      if (result && result.ok) {
        if (command.kind === 'export.run' || asyncCommand) store.transaction(gw => gw.putCommandReceipt({ commandId: command.commandId, inputHash, acceptedAt: clock(), result }))
        if (result.forgotten) policyStore.markCleaned(result.forgotten)
        if (result.revoked && result.revoked.forgotten) policyStore.markCleaned(result.revoked.forgotten)
        emit(command.kind, { commandId: command.commandId })
      }
      return result
    } catch (error) {
      const normalized = normalize(error)
      log('command failed', command.kind, normalized.code, normalized.detail ? JSON.stringify(normalized.detail) : '')
      if (!normalized.expected) return { ok: false, code: normalized.code, failureClass: 'internal', detail: normalized.detail }
      return normalized.toReply()
    }
  }

  function dispatchCommand (command, inputHash) {
    switch (command.kind) {
      case 'owner.message': return handleOwnerMessage(command, inputHash)
      case 'owner.interaction': return handleInteraction(command)
      case 'owner.control': return handleOwnerControl(command)
      case 'owner.forget': return handleForget(command)
      case 'owner.correct': return handleCorrection(command)
      case 'owner.reminder': return handleReminder(command)
      case 'owner.suppress': return handleSuppress(command)
      case 'growth.update': return handleGrowthUpdate(command)
      case 'presentation.receipt': return handlePresentationReceipt(command)
      case 'operation.receipt': return handleOperationReceipt(command)
      case 'capability.result': return handleOperationReceipt(command)
      case 'world.observation': return handleObservation(command)
      case 'activity.receipt': return handleActivityReceipt(command)
      case 'identity.update': return handleIdentityUpdate(command)
      case 'settings.update': return handleSettingsUpdate(command)
      case 'import.run': return handleImport(command)
      case 'export.run': return handleExport(command)
      case 'behavior.tick': enqueueNextTick(clock()); return { ok: true, scheduled: true }
      case 'system.suspend': return handleSuspend(command)
      case 'system.resume': return handleResume(command)
      case 'system.pause': return handlePause(command)
      default: return { ok: false, code: 'command_kind_unsupported', failureClass: 'rejected' }
    }
  }

  async function managePackage(payload) {
    await packagesReady
    if (stopped) return { ok: false, code: 'kernel_stopped' }
    const action = payload.action
    if (!['install', 'disable', 'uninstall', 'rollback'].includes(action)) return { ok: false, code: 'package_action_invalid' }
    // The host supplies the trusted-local approval; the model cannot submit this
    // command and package declarations cannot manufacture grants.
    const result = action === 'install' ? await packages.install(payload.folder, payload.trusted === true) : await packages[action](payload.id)
    return result
  }

  function handleInteraction(command) {
    if (!['feed','use_item','buy','rest_start','rest_cancel','work_start','work_cancel','sign','touch','water_drink','focus_start','focus_pause','focus_resume'].includes(command.payload.kind)) throw rejected('interaction_not_allowed')
    return store.transaction(gw => {
      const now = clock(), prior = Number(gw.getMeta('needs:last_tick')) || now
      applyNurture({ kind: 'tick', elapsedMs: now - prior, commandId: 'elapsed:' + now })
      gw.setMeta('needs:last_tick', now)
      return applyNurture({ ...command.payload, commandId: command.commandId })
    })
  }
  function applyNurture(action) {
    return store.transaction(gw => {
      const state = gw.getState(characterId)
      const changed = require('../domain/nurture.cjs').apply(state.body, action, clock())
      if (!changed.ok) throw rejected(changed.reason)
      gw.writeState({ ...state, characterId, revision: state.revision + 1, body: changed.state })
      for (const event of changed.events) handleObservation({ payload: { observation: { observationId: event.runId + ':done', sourceId: event.runId + ':done',
        kind: event.kind, observedAt: clock(), freshUntil: clock() + 3600000, payload: { ...event, occurredAt: clock(), sourceType: event.kind } } } })
      return { ok: true, revision: state.revision + 1 }
    })
  }
  async function runNeedsTick() {
    const now = clock()
    store.transaction(gw => {
      const prior = Number(gw.getMeta('needs:last_tick')) || now
      applyNurture({ kind: 'tick', elapsedMs: now - prior, commandId: 'elapsed:' + now })
      gw.setMeta('needs:last_tick', now)
      gw.rescheduleJob({ jobId: deterministicId('job', characterId + '|needs_tick'), dedupeKey: characterId + '|needs_tick',
        characterId, kind: 'needs_tick', dueAt: now + 60000, payloadRef: null })
    })
    emit('state.needs', {})
    // The old perception loop is retired. Sampling and its receipt use the same
    // capability authorization/ledger as every other action.
    const scopes = await grantedScopesFromHost()
    for (const [scope, capabilityId, kind] of [['os:foreground','desktop.observe.foreground','foreground'],['os:media','desktop.observe.media','media']]) {
      if (!scopes.has(scope) || stopped) continue
      const sampled = await invokeCapability({ capabilityId, input: {}, dedupeKey: 'observe:' + kind + ':' + now })
      if (!sampled.ok || stopped) continue
      const sourceId = 'observation:' + sampled.operation.operationId
      handleObservation({ payload: { observation: { sourceId, observationId: sourceId, kind, observedAt: now, freshUntil: now + 60000,
        payload: { ...sampled.output, actor: 'unknown', observer: 'system', subject: kind === 'media' ? 'media_session' : 'foreground_application', world: 'desktop_observed', sourceType: kind, occurredAt: now } } } })
    }
  }

  async function invokeCapability(payload) {
    await packagesReady
    if (stopped) return { ok: false, code: 'kernel_stopped' }
    const grantedScopes = await grantedScopesFromHost()
    const manifest = registry.get(payload.capabilityId, payload.capabilityVersion)
    if (!manifest) return { ok: false, code: 'capability_missing' }
    const sourceRefs = Array.isArray(payload.sourceRefs) ? payload.sourceRefs : []
    if (sourceRefs.some(ref => policyStore.isDeleted(ref))) return { ok: false, code: 'source_forgotten' }
    const prepared = store.transaction(gw => executor.prepare(gw, { characterId, capabilityId: manifest.id, capabilityVersion: manifest.version,
      input: payload.input || {}, sourceRefs, grantedScopes, allowExternal: grantedScopes.has('external:dispatch'),
      epoch, now: clock(), dedupeKey: payload.dedupeKey }))
    if (!prepared.ok) return prepared
    if (prepared.reused) {
      const receipt = prepared.operation.receiptRef ? store.read(gw => safeJson(gw.getPayload(prepared.operation.receiptRef)?.body)) : null
      return { ok: prepared.operation.status === 'succeeded', reused: true, operation: prepared.operation, output: receipt?.output, code: prepared.operation.status }
    }
    const dispatched = store.transaction(gw => executor.markDispatchStart(gw, prepared.operation.operationId, clock()))
    if (!dispatched.ok) return dispatched
    const result = await executor.dispatch(dispatched.operation, { input: payload.input || {}, sourceRefs })
    if (stopped) return { ok: false, code: 'kernel_stopped' }
    const settled = store.transaction(gw => {
      const settled = executor.settle(gw, { operationId: dispatched.operation.operationId, result, now: clock() })
      if (settled.ok && !settled.duplicate) applyInternalEffect(gw, settled.operation, result)
      return settled
    })
    return { ok: settled.ok && result.outcome === 'succeeded', code: result.error || result.unknownReason,
      operation: settled.operation, output: result.output, receipt: result.receipt }
  }

  /* ------------------------------------------------------------------ *
   * 主人消息：先持久化来源，再回执；抽取是独立 job
   * ------------------------------------------------------------------ */

  function handleOwnerMessage (command) {
    const payload = command.payload
    const text = typeof payload.text === 'string' ? payload.text.slice(0, 8000) : ''
    const messageRef = isSafeId(payload.messageRef, 160) ? payload.messageRef : null
    if (!text.trim()) throw rejected('message_empty')
    if (!messageRef) throw rejected('message_ref_required')
    const ts = Number(payload.ts) || clock()
    if (policyStore.isDeleted(messageRef)) throw rejected('source_forgotten')

    // 用户插话：取消当前自动模型请求（不取消已提交事实）
    if (turnAbort) { try { turnAbort.abort() } catch (_) {} turnAbort = null }
    if (replyAbort) replyAbort.abort()
    replyGeneration++
    autonomyGeneration++
    const previousSource = store.read(gw => gw.getSource(messageRef))
    if (previousSource && previousSource.sourceHash !== hash(text)) throw conflict('source_conflict', messageRef)

    const result = store.transaction(gw => {
      const payloadRef = gw.putPayload(JSON.stringify({ text }), 'episode')
      const source = gw.putSource({
        sourceId: messageRef, characterId, sourceKind: 'owner_message', world: 'user_report',
        trust: 'owner_statement', permission: 'granted', payloadRef, sourceHash: hash(text),
        occurredAt: ts, observedAt: clock(),
      })
      const event = gw.appendEvent({
        eventId: deterministicId('evt', characterId + '|owner.message|' + messageRef),
        characterId, kind: 'owner.message', sourceId: messageRef, sourceEventId: messageRef,
        payloadRef, world: 'user_report', trust: 'owner_statement',
        correlationId: messageRef, occurredAt: ts, observedAt: clock(), committedAt: clock(),
        timezone: payload.timezone || 'Asia/Shanghai', retentionClass: 'episode', evidenceRefs: [messageRef],
      })
      const state = gw.getState(characterId)
      const body = state.body
      body.attentionPolicy = { ...(body.attentionPolicy || {}), conversation: {
        ...(body.attentionPolicy?.conversation || {}),
        phase: 'active', lastOwnerAt: clock(), sessionId: payload.sessionId || messageRef,
        leaseUntil: clock() + 120000, messageRef,
      } }
      for (const plan of gw.listActivePlans(characterId)) gw.patchPlan(plan.planId, planMachine.halt(plan, 'owner_input', clock()))
      gw.writeState({ characterId, revision: state.revision + 1, identityRevision: state.identityRevision, schemaVersion: state.schemaVersion, body, seq: event.seq })
      // 事实抽取：sourceId + extractorVersion 去重（§13.1）
      const dedupeKey = characterId + '|extract_fact|' + messageRef + '|' + extractor.EXTRACTOR_VERSION
      gw.putJob({
        jobId: deterministicId('job', dedupeKey), dedupeKey, characterId, kind: 'extract_fact',
        dueAt: clock() + 500, payloadRef: JSON.stringify({ sourceId: messageRef }),
      })
      if (!previousSource) {
        applyNurture({ kind: 'chat', commandId: command.commandId })
        const replyKey = characterId + '|owner_reply|' + messageRef
        gw.putJob({ jobId: deterministicId('job', replyKey), dedupeKey: replyKey, characterId,
          kind: 'owner_reply', dueAt: clock(), payloadRef: JSON.stringify({ sourceId: messageRef, epoch }) })
      }
      return { ok: true, seq: event.seq, revision: state.revision + 1, sourceId: messageRef, duplicateSource: !!previousSource }
    })
    scheduleNextWake()
    return { ok: true, accepted: { seq: result.seq, revision: result.revision, sourceId: messageRef } }
  }

  /* ------------------------------------------------------------------ *
   * 控制 / 遗忘 / 纠正
   * ------------------------------------------------------------------ */

  function handleOwnerControl (command) {
    const action = String(command.payload.action || '')
    if (['conversation_start', 'visibility', 'quiet_until'].includes(action)) {
      autonomyGeneration++
      if (turnAbort) turnAbort.abort()
      return store.transaction(gw => {
        const state = gw.getState(characterId), policy = state.body.attentionPolicy || {}
        if (action === 'conversation_start') policy.conversation = { ...(policy.conversation || {}), phase: 'active', surfaceOpen: true, leaseUntil: clock() + 120000 }
        if (action === 'visibility') policy.hidden = command.payload.visible === false
        if (action === 'quiet_until') policy.quietUntil = Math.max(clock(), Number(command.payload.until) || clock())
        state.body.attentionPolicy = policy
        gw.writeState({ ...state, characterId, revision: state.revision + 1 })
        return { ok: true }
      })
    }
    if (action === 'conversation_end') {
      return store.transaction(gw => {
        const state = gw.getState(characterId), policy = state.body.attentionPolicy || {}
        const previous = policy.conversation || {}
        if (command.payload.sessionId && previous.sessionId !== command.payload.sessionId) return { ok: false, code: 'conversation_session_mismatch' }
        state.body.attentionPolicy = { ...policy, conversation: { ...previous, phase: 'closed', surfaceOpen: false, leaseUntil: 0, endedAt: clock() } }
        gw.writeState({ ...state, characterId, revision: state.revision + 1 })
        enqueueNextTick(clock() + 1000)
        return { ok: true, conversationEnded: true }
      })
    }
    if (action === 'cancel_auto') {
      autonomyGeneration++
      if (turnAbort) { try { turnAbort.abort() } catch (_) {} turnAbort = null }
      return store.transaction(gw => {
        const plans = gw.listActivePlans(characterId)
        for (const plan of plans) for (const step of plan.steps || []) if (step.operationId) executor.cancel(step.operationId)
        for (const plan of plans) gw.patchPlan(plan.planId, planMachine.halt(plan, 'owner_cancelled', clock()))
        if (plans.length) gw.appendEvent({
          eventId: deterministicId('evt', characterId + '|control.cancel|' + command.commandId),
          characterId, kind: 'behavior.cancelled', sourceId: null, sourceEventId: null, payloadRef: null,
          world: 'system', trust: 'owner_statement', correlationId: command.commandId,
          occurredAt: clock(), observedAt: clock(), committedAt: clock(), timezone: 'Asia/Shanghai',
          retentionClass: 'episode', evidenceRefs: [],
        })
        return { ok: true, cancelledPlans: plans.map(plan => plan.planId) }
      })
    }
    if (action === 'release_presentation') {
      return handleOwnerControl({ ...command, payload: { action: 'cancel_auto' } })
    }
    if (action === 'pause_autonomy' || action === 'resume_autonomy') {
      return handlePause({ payload: { paused: action === 'pause_autonomy' } })
    }
    throw rejected('control_action_unknown', action)
  }

  function handleForget (command) {
    replyGeneration++
    if (replyAbort) replyAbort.abort()
    executor.cancelAll()
    autonomyGeneration++
    if (turnAbort) turnAbort.abort()
    const sourceIds = Array.isArray(command.payload.sourceIds) ? command.payload.sourceIds.filter(id => isSafeId(id, 240)) : []
    if (!sourceIds.length) throw rejected('forget_source_ids_required')
    const deletedSet = policyStore.deletedSet()
    const missing = sourceIds.filter(id => !store.read(gw => gw.getSource(id)))
    const result = store.transaction(gw => lifecycle.forget({
      gw, policyStore, characterId, sourceIds, reason: command.payload.reason || 'owner_request', now: clock(), seq: gw.lastSeq(characterId).seq + 1,
    }))
    return { ok: true, ...result, unknownSourceIds: missing, alreadyDeleted: sourceIds.filter(id => deletedSet.has(id)) }
  }

  function handleCorrection (command) {
    const payload = command.payload
    if (!isSafeId(payload.messageRef, 160)) throw rejected('correction_source_required')
    const text = typeof payload.text === 'string' ? payload.text.slice(0, 4000) : ''
    const source = store.read(gw => gw.getSource(payload.messageRef))
    if (!source) throw rejected('correction_source_missing')
    if (source.sourceKind !== 'owner_message' || source.permission !== 'granted' || policyStore.isDeleted(payload.messageRef)) throw rejected('correction_source_invalid')
    if (text && source.sourceHash !== hash(text)) throw rejected('correction_source_mismatch')
    autonomyGeneration++
    if (replyAbort) replyAbort.abort()
    replyGeneration++
    if (turnAbort) turnAbort.abort()
    // 纠正来源本身必须是真的主人陈述；然后由抽取 job 重新抽取新候选。
    const result = store.transaction(gw => {
      const dedupeKey = characterId + '|correction|' + command.commandId
      gw.putJob({
        jobId: deterministicId('job', dedupeKey), dedupeKey, characterId, kind: 'extract_fact',
        dueAt: clock(), payloadRef: JSON.stringify({ sourceId: payload.messageRef, correction: true, hint: payload.hint || null }),
      })
      return { ok: true, scheduled: true, sourceHashMatches: source.sourceHash === hash(text || '') }
    })
    scheduleNextWake()
    return result
  }

  function handleReminder (command) {
    const payload = command.payload
    const subject = String(payload.subject || '').slice(0, 200)
    if (!subject) throw rejected('reminder_subject_required')
    const now = clock()
    return store.transaction(gw => {
      const existing = gw.listConcerns(characterId, { statusIn: ['open'], limit: 200 })
      const cap = lifeDomain.canOpenConcern({ existing, config })
      if (!cap.ok) throw conflict(cap.reason, cap)
      const concernId = deterministicId('concern', characterId + '|reminder|' + subject + '|' + (payload.dueAt || now))
      const concern = gw.putConcern({
        concernId, characterId, topicKey: 'reminder:' + hash(subject).slice(0, 16), subject,
        desiredOutcome: String(payload.desiredOutcome || '按主人说的提醒').slice(0, 400),
        status: 'open', priority: 0.8, origin: 'owner', createdAt: now,
        nextCheckAt: Number(payload.dueAt) || now, expiresAt: Number(payload.expiresAt) || lifeDomain.expiryFor({ origin: 'owner', expiresAt: payload.expiresAt }, config, now),
        lastContactAt: null, exitCondition: 'owner_confirms_done', revision: 1,
        body: { createdBy: 'owner_reminder' }, sourceRefs: payload.sourceRefs || [], updatedSeq: 0,
      })
      return { ok: true, concern }
    })
  }

  /**
   * 主人明确“不要”：立即约束行为，不等累计（§16）。
   * 只压制该方向的兴趣与候选，不删除已有经历。
   */
  function handleSuppress (command) {
    const payload = command.payload
    const topicKey = String(payload.topicKey || '').slice(0, 120)
    if (!topicKey) throw rejected('suppress_topic_required')
    return store.transaction(gw => {
      const result = growth.applyExplicitConstraint(gw, {
        characterId, topicKey, reason: payload.reason || 'owner_request',
        sourceRefs: payload.sourceRefs || [], now: clock(),
      })
      if (!result.ok) throw rejected(result.reason)
      // 若主人同时要求停止某类感知，把相关来源按遗忘协议处理。
      if (payload.revokeScope) {
        const revoke = lifecycle.revokePermission({
          gw, policyStore, characterId, scope: String(payload.revokeScope).slice(0, 240),
          sourceIds: payload.sourceIds || [], reason: 'owner_suppress', now: clock(),
          seq: gw.lastSeq(characterId).seq + 1,
        })
        return { ok: true, interest: result.interest, revoked: revoke }
      }
      return { ok: true, interest: result.interest }
    })
  }

  /**
   * 成长提交：只接受**已经校验过**的提案（来自反思或主人的显式命令）。
   * 模型不能直接产生可提交的成长事件。
   */
  function handleGrowthUpdate (command) {
    const payload = command.payload
    const proposal = growth.validateReflectionProposal(payload.proposal, config)
    if (!proposal.ok) throw rejected(proposal.reason, { have: proposal.have, need: proposal.need })
    const value = proposal.value
    if (value.kind === 'none') return { ok: true, applied: false, kind: 'none' }
    if (value.kind === 'interest') {
      return store.transaction(gw => {
        const result = growth.applyInterestUpdate(gw, {
          characterId, topicKey: value.topicKey, delta: value.delta,
          sourceRefs: value.sourceRefs, sourceTimestamps: payload.sourceTimestamps || [],
          config, now: clock(),
        })
        if (!result.ok) throw rejected(result.reason, result)
        return { ok: true, applied: true, interest: result.interest, growthId: result.growthId }
      })
    }
    // relationship_note / skill_revision：只记录提案，不改数值、不授予能力。
    return store.transaction(gw => {
      gw.putReflection({
        reflectionId: deterministicId('reflect', JSON.stringify(value)), characterId,
        status: 'pending', body: value, sourceRefs: value.sourceRefs || [],
        createdSeq: gw.lastSeq(characterId).seq + 1,
      })
      return { ok: true, applied: false, recorded: value.kind }
    })
  }


  /* ------------------------------------------------------------------ *
   * 回执：表现与操作分别记账
   * ------------------------------------------------------------------ */

  function handlePresentationReceipt (command) {
    const delivery = command.payload.delivery || command.payload
    const validation = contracts.validateDelivery(delivery)
    if (!validation.ok) throw rejected(validation.code, validation.detail)
    return store.transaction(gw => {
      const inserted = gw.putDelivery({
        presentationId: delivery.presentationId, channel: delivery.channel, phase: delivery.phase,
        operationId: delivery.operationId || null, rendererSession: delivery.rendererSession || null,
        seq: gw.lastSeq(characterId).seq, at: Number(delivery.at) || clock(), detail: delivery.detail || null,
      })
      if (delivery.channel === 'animation' && delivery.phase === 'completed') {
        const operation = gw.getOperation(delivery.operationId)
        if (!operation || operation.capabilityId !== 'presentation.animation' || operation.epoch !== epoch) throw rejected('animation_receipt_not_authorized')
        const sourceId = 'animation:' + delivery.presentationId
        const at = Number(delivery.at) || clock()
        if (!policyStore.isDeleted(sourceId) && !gw.getSource(sourceId)) {
          applyNurture({ kind: 'animation_completed', name: delivery.detail?.animationName, commandId: command.commandId })
          handleObservation({ payload: { observation: { observationId: sourceId, sourceId, kind: 'animation.completed', observedAt: at, freshUntil: at + 3600000,
          payload: { actor: 'character', observer: 'system', subject: 'character', world: 'virtual', sourceType: 'animation.completed', animationName: delivery.detail?.animationName, occurredAt: at } } } })
        }
      }
      // 表现失败不把领域动作改成失败（不变量 8）——只记 delivery。
      return { ok: true, recorded: inserted }
    })
  }

  function handleOperationReceipt (command) {
    const payload = command.payload
    const operationId = String(payload.operationId || '')
    const operation = store.read(gw => gw.getOperation(operationId))
    if (!operation) throw rejected('operation_missing', operationId)
    if (operation.epoch !== epoch) {
      // 旧 epoch 的结果不得提交为新事实，但也不能丢弃真实结果：
      // 记一条 system 事件说明“迟到的旧结果被隔离”。
      store.transaction(gw => gw.appendEvent({
        eventId: deterministicId('evt', characterId + '|stale_result|' + operationId + '|' + (payload.at || '')),
        characterId, kind: 'operation.stale_result', sourceId: null, sourceEventId: null,
        payloadRef: gw.putPayload(JSON.stringify({ operationId, result: payload.result || null }), 'operation'),
        world: 'system', trust: 'receipt', correlationId: operationId,
        occurredAt: clock(), observedAt: clock(), committedAt: clock(), timezone: 'Asia/Shanghai',
        retentionClass: 'operation', evidenceRefs: [],
      }))
      return { ok: false, code: 'stale_epoch', failureClass: 'conflict' }
    }
    const settled = store.transaction(gw => {
      const result = executor.settle(gw, { operationId, result: payload.result || {}, now: clock() })
      if (!result.ok) return result
      if (!result.duplicate) applyInternalEffect(gw, result.operation, payload.result || {})
      return result
    })
    if (!settled.ok) throw conflict(settled.code, settled.detail)
    if (!settled.duplicate) queueMicrotask(() => track(continuePlanForOperation(settled.operation)))
    scheduleNextWake()
    return { ok: true, operation: settled.operation }
  }

  function handleObservation (command) {
    const observation = command.payload.observation || command.payload
    const validation = contracts.validateObservation(observation)
    if (!validation.ok) throw rejected(validation.code, validation.detail)
    return store.transaction(gw => {
      // 观测本身也必须有来源，否则无法在遗忘时传播。
      const sourceId = observation.sourceId || deterministicId('obs', observation.observationId)
      if (policyStore.isDeleted(sourceId)) throw rejected('source_forgotten')
      const previous = gw.getSource(sourceId)
      if (previous && (previous.permission !== 'granted' || previous.sourceHash !== hash(observation.payload))) throw conflict('observation_source_conflict')
      if (!previous) {
        const payloadRef = gw.putPayload(JSON.stringify(observation.payload), 'ephemeral')
        gw.putSource({
          sourceId, characterId, sourceKind: 'observation', world: contracts.WORLDS.includes(observation.payload.world) ? observation.payload.world : 'desktop_observed', trust: 'sensor',
          permission: 'granted', payloadRef, sourceHash: hash(observation.payload),
          occurredAt: observation.observedAt, observedAt: clock(),
        })
      }
      gw.putObservation({ observationId: observation.observationId, characterId, kind: observation.kind,
        payload: observation.payload, observedAt: observation.observedAt, freshUntil: observation.freshUntil, sourceId })
      if (['game.completed','animation.completed','work.completed','calendar.celebration'].includes(observation.kind)) {
        if (!previous && observation.kind === 'game.completed') {
          const changed = require('../domain/nurture.cjs').apply(gw.getState(characterId).body, { kind: 'game', game: observation.payload.game, commandId: sourceId }, clock())
          if (changed.ok) { const state = gw.getState(characterId); gw.writeState({ ...state, revision: state.revision + 1, body: changed.state }) }
        }
        const bodyRef = gw.putPayload(JSON.stringify(observation.payload), 'episode')
        const event = gw.appendEvent({ eventId: deterministicId('evt', sourceId), characterId, kind: observation.kind, sourceId,
          sourceEventId: observation.observationId, payloadRef: bodyRef, world: observation.payload.world, trust: 'receipt', correlationId: sourceId,
          occurredAt: observation.payload.occurredAt || observation.observedAt, observedAt: observation.observedAt, committedAt: clock(), timezone: 'Asia/Shanghai', retentionClass: 'episode', evidenceRefs: [sourceId] })
        admission.applyEpisode(gw, { characterId, sourceId, kind: observation.kind, title: observation.kind, body: observation.payload,
          world: observation.payload.world, occurredAt: observation.payload.occurredAt || observation.observedAt, seq: event.seq, sourceRefs: [sourceId] })
      }
      return { ok: true, sourceId }
    })
  }

  function handleActivityReceipt (command) {
    const payload = command.payload
    const title = String(payload.title || '').slice(0, 160)
    if (!title) throw rejected('activity_title_required')
    return store.transaction(gw => {
      const seq = gw.lastSeq(characterId).seq + 1
      const result = admission.applyEpisode(gw, {
        characterId, sourceId: payload.sourceId || deterministicId('act', title + clock()),
        kind: 'activity', title, world: payload.world === 'desktop_observed' ? 'desktop_observed' : 'virtual',
        body: payload.body || {}, occurredAt: Number(payload.occurredAt) || clock(), seq,
        sourceRefs: payload.sourceRefs || [],
      })
      return { ok: true, episodeId: result.episodeId }
    })
  }

  function handleIdentityUpdate (command) {
    const payload = command.payload
    const displayName = typeof payload.displayName === 'string' ? payload.displayName.trim().slice(0, 80) : null
    const definition = payload.definition && typeof payload.definition === 'object' ? payload.definition : null
    if (!displayName && !definition) throw rejected('identity_update_empty')
    return store.transaction(gw => {
      const character = gw.getCharacter(characterId)
      const latest = gw.latestIdentity(characterId)
      const nextRevision = (latest ? latest.revision : 0) + 1
      const definitionValue = definition || (latest ? latest.definition : {})
      gw.putIdentityRevision({
        characterId, revision: nextRevision,
        displayName: displayName || (latest ? latest.displayName : '小深'),
        definition: definitionValue, hash: hash(definitionValue),
        reason: 'owner_update', sourceRefs: payload.sourceRefs || [], createdAt: clock(),
      })
      gw.putCharacter({ ...character, identityRevision: nextRevision })
      const state = gw.getState(characterId)
      gw.writeState({
        characterId, revision: state.revision + 1, identityRevision: nextRevision,
        schemaVersion: state.schemaVersion, body: { ...state.body, identityHash: hash(definitionValue), displayName: displayName || state.body.displayName }, seq: gw.lastSeq(characterId).seq,
      })
      return { ok: true, identityRevision: nextRevision }
    })
  }

  function handleSettingsUpdate (command) {
    const payload = command.payload
    return store.transaction(gw => {
      const state = gw.getState(characterId)
      const body = { ...state.body }
      const policy = { ...(body.attentionPolicy || {}) }
      if (payload.preferences !== undefined) {
        const allowed = require('../../renderer/systems/nurture-rules.js').UI_PREFERENCE_FIELDS
        if (!payload.preferences || Array.isArray(payload.preferences) || typeof payload.preferences !== 'object' ||
          Object.keys(payload.preferences).some(key => !allowed.includes(key)) || JSON.stringify(payload.preferences).length > 64000) throw rejected('preference_fields_invalid')
        body.preferences = { ...body.preferences, ...payload.preferences }
      }
      if (Number.isFinite(Number(payload.quietUntil))) policy.quietUntil = Number(payload.quietUntil)
      if (payload.autonomyPaused !== undefined) { paused = !!payload.autonomyPaused; policy.autonomyPaused = paused }
      body.attentionPolicy = policy
      gw.writeState({ characterId, revision: state.revision + 1, identityRevision: state.identityRevision, schemaVersion: state.schemaVersion, body, seq: gw.lastSeq(characterId).seq })
      return { ok: true, attentionPolicy: policy, paused }
    })
  }

  function handleImport (command) {
    if (mode === 'active') throw rejected('import_requires_candidate_mode')
    const result = importer.run({ force: command.payload.force === true })
    return { ok: result.ok === true, code: result.ok ? undefined : result.reason, import: result }
  }

  function handleExport (command) {
    const result = exporter.exportPackage({})
    if (!result.ok) throw new CharacterError('unavailable', 'export_failed', result.reason)
    return { ok: true, export: { directory: result.directory, manifest: result.manifest } }
  }

  function handleSuspend (command) {
    autonomyGeneration++
    replyGeneration++
    if (replyAbort) replyAbort.abort()
    if (turnAbort) turnAbort.abort()
    executor.cancelAll()
    const at = Number(command.payload.at) || clock()
    return store.transaction(gw => {
      const state = gw.getState(characterId)
      const body = { ...state.body, attentionPolicy: { ...(state.body.attentionPolicy || {}), suspendedAt: at } }
      gw.writeState({ characterId, revision: state.revision + 1, identityRevision: state.identityRevision, schemaVersion: state.schemaVersion, body, seq: gw.lastSeq(characterId).seq })
      gw.appendEvent({
        eventId: deterministicId('evt', characterId + '|suspend|' + at), characterId, kind: 'system.suspended',
        sourceId: null, sourceEventId: null, payloadRef: null, world: 'system', trust: 'receipt',
        correlationId: 'suspend', occurredAt: at, observedAt: at, committedAt: clock(),
        timezone: 'Asia/Shanghai', retentionClass: 'episode', evidenceRefs: [],
      })
      return { ok: true, suspendedAt: at }
    })
  }

  function handleResume (command) {
    const at = Number(command.payload.at) || clock()
    return store.transaction(gw => {
      // Offline decay is separate from activity progress: sleep must not earn work/focus rewards.
      gw.setMeta('needs:last_tick', String(at))
      const state = gw.getState(characterId)
      const body = { ...state.body }
      const policy = { ...(body.attentionPolicy || {}) }
      const suspendedAt = Number(policy.suspendedAt) || null
      delete policy.suspendedAt
      body.attentionPolicy = policy
      let decayed = body
      if (suspendedAt && at > suspendedAt) {
        // 离线衰减：首版上限 8 小时，公式沿用现有 NeedsSystem
        decayed = reducer.decayForOffline(body, at - suspendedAt, config.time.maxOfflineDecayHours, {})
      }
      gw.writeState({ characterId, revision: state.revision + 1, identityRevision: state.identityRevision, schemaVersion: state.schemaVersion, body: decayed, seq: gw.lastSeq(characterId).seq })
      // 关闭期间不自动“做完”虚拟项目；转 paused，回来后按剩余步骤继续（§10.4）
      for (const project of gw.listProjects(characterId, { statusIn: ['active'], limit: 50 })) {
        gw.putProject({ ...project, status: 'paused', revision: project.revision + 1, updatedSeq: gw.lastSeq(characterId).seq })
      }
      // 到期提醒合并为最多一条恢复后候选（不逐条补发）
      let merged = 0
      const overdue = gw.listConcerns(characterId, { statusIn: ['open', 'deferred'], dueBefore: at, limit: 100 })
      for (const concern of overdue) {
        if (merged === 0) {
          gw.putConcern({ ...concern, nextCheckAt: at, revision: concern.revision + 1, updatedSeq: gw.lastSeq(characterId).seq })
          merged++
        } else {
          gw.putConcern({ ...concern, status: 'deferred', nextCheckAt: at + 3600000, revision: concern.revision + 1, updatedSeq: gw.lastSeq(characterId).seq })
        }
      }
      return { ok: true, resumedAt: at, offlineMs: suspendedAt ? at - suspendedAt : 0, mergedReminders: merged, needs: decayed.needs }
    })
  }

  function handlePause (command) {
    paused = command.payload.paused !== false
    autonomyGeneration++
    if (turnAbort) turnAbort.abort()
    store.transaction(gw => {
      const state = gw.getState(characterId)
      state.body.attentionPolicy = { ...state.body.attentionPolicy, autonomyPaused: paused }
      gw.writeState({ ...state, characterId, revision: state.revision + 1 })
    })
    return { ok: true, paused }
  }

  /* ------------------------------------------------------------------ *
   * 读投影
   * ------------------------------------------------------------------ */

  function read (query = {}) {
    if (!ready) return { ok: false, code: readOnly ? 'read_only' : 'not_ready' }
    const kind = query.kind || 'projection'
    return store.read(gw => {
      const character = gw.getCharacter(characterId)
      const state = gw.getState(characterId)
      const seq = gw.lastSeq(characterId).seq
      const deleted = policyStore.deletedSet()
      if (kind === 'status') {
        return {
          ok: true, characterId, epoch, mode, readOnly, paused,
          revision: state ? state.revision : 0, seq,
          capabilities: registry.health(), policy: policyStore.health(),
          model: gateway.stats(), driver: store.driver,
        }
      }
      if (kind === 'deliveries') {
        return { ok: true, deliveries: Array.isArray(query.presentationIds) ? query.presentationIds.flatMap(id => gw.listDeliveries(id)) : [] }
      }
      if (kind === 'history') return { ok: true, history: historyProjection(gw, deleted, query.limit || 100) }
      if (kind === 'packages') return { ok: true, ...packageStore.snapshot(), health: packages.health() }
      if (kind === 'capabilities') return { ok: true, capabilities: catalogView(registry.list()), health: registry.health() }
      if (kind === 'memory') return { ok: true, schemaVersion: 2, memories: gw.listAssertions(characterId, { statusIn: ['current'], limit: 200 })
        .filter(item => !(item.sourceRefs || []).some(ref => deleted.has(ref)))
        .map(item => ({ id: item.assertionId, content: item.subject + ' / ' + item.predicate + ': ' + (typeof item.value === 'string' ? item.value : JSON.stringify(item.value)),
          status: 'active', strength: item.confidence || 0.7, evidenceRefs: (item.sourceRefs || []).map(messageRef => ({ messageRef })), sourceRefs: item.sourceRefs, world: item.world })) }
      if (kind === 'operations') {
        return { ok: true, operations: gw.listOperations(characterId, query.statuses || null, query.limit || 50) }
      }
      if (kind === 'diary') {
        return buildDiary(gw, { characterId, deleted, limit: query.limit || 20 })
      }
      if (kind === 'context') {
        const projection = projector.project(gw, {
          characterId, purpose: query.purpose || 'decision', query: query.query || '',
          deleted, explicitRecall: !!query.explicitRecall,
          capabilityCatalog: catalogView(registry.list()),
          observations: gw.listFreshObservations(characterId, clock(), 10),
          maxChars: query.maxChars,
        })
        return projection
      }
      // 默认 projection：UI 只渲染这里的内容
      const identity = gw.latestIdentity(characterId)
      const concerns = gw.listConcerns(characterId, { statusIn: ['open', 'deferred'], limit: 20 })
      const projects = gw.listProjects(characterId, { statusIn: ['proposed', 'active', 'paused'], limit: 10 })
      const deliveries = Array.isArray(query.presentationIds) ? query.presentationIds.flatMap(id => gw.listDeliveries(id)) : []
      const projection = {
        ok: true,
        projectionVersion: contracts.PROJECTION_VERSION,
        characterId,
        displayName: identity ? identity.displayName : null,
        revision: state ? state.revision : 0,
        seq,
        epoch,
        identityRevision: character ? character.identityRevision : 0,
        state: state ? state.body : null,
        episodes: gw.listEpisodes(characterId, 30).filter(row => !(row.sourceRefs || []).some(ref => deleted.has(ref)))
          .map(row => ({ id: row.episodeId, title: row.title, text: safeJson(row.bodyRef && gw.getPayload(row.bodyRef)?.body)?.text || row.title,
            sourceRefs: row.sourceRefs, world: row.world, createdAt: row.occurredAt })),
        concerns: concerns.map(concern => ({
          concernId: concern.concernId, subject: concern.subject, status: concern.status,
          nextCheckAt: concern.nextCheckAt, origin: concern.origin, priority: concern.priority,
        })),
        projects: projects.map(project => ({
          projectId: project.projectId, goal: project.goal, status: project.status,
          recipeId: project.recipeId, stepCursor: project.stepCursor, nextWakeAt: project.nextWakeAt,
        })),
        plans: gw.listActivePlans(characterId).map(plan => ({
          planId: plan.planId, recipeId: plan.recipeId, status: plan.status, stepCursor: plan.stepCursor,
        })),
        deliveries,
        policyEpoch: policyStore.epoch(),
        mode,
        paused,
        readOnly,
      }
      return projection
    })
  }

  /* ------------------------------------------------------------------ *
   * 调度：jobs 表是安排本身，timer 只是唤醒器
   * ------------------------------------------------------------------ */

  function scheduleNextWake () {
    if (stopped || !ready) return
    let nextDue = null
    try { nextDue = store.read(gw => gw.nextDueAt(characterId)) } catch (error) { return }
    if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null }
    if (nextDue === null) return
    const delay = Math.max(50, Math.min(nextDue - clock(), 60000))
    schedulerTimer = setTimeout(() => {
      schedulerTimer = null
      track(runSchedulerOnce())
    }, delay)
    if (schedulerTimer.unref) schedulerTimer.unref()
  }

  async function runSchedulerOnce () {
    if (stopped || !ready) return { ok: false, code: 'not_ready' }
    const now = clock()
    const due = store.transaction(gw => {
      // 先回收超时租约：崩溃或异常退出会让 job 停在 leased，不回收就永远不再执行。
      gw.reclaimExpiredLeases(now)
      const jobs = gw.listDueJobs(characterId, now, 4)
      const claimed = []
      for (const job of jobs) {
        if (gw.claimJob(job.jobId, epoch, now + config.scheduler.leaseMs)) claimed.push(job)
      }
      return claimed
    })
    for (const job of due) { if (stopped) break; await executeJob(job) }
    scheduleNextWake()
    return { ok: true, processed: due.length }
  }

  async function executeJob (job) {
    try {
      if (paused && !['maintenance', 'needs_tick', 'extract_fact', 'owner_reply'].includes(job.kind)) {
        store.transaction(gw => gw.retryJob(job.jobId, clock() + 300000, 'autonomy_paused', job.attempts))
        return
      }
      if (job.kind === 'needs_tick') await runNeedsTick()
      else if (job.kind === 'owner_reply') await runOwnerReply(job)
      else if (job.kind === 'extract_fact') await runExtraction(job)
      else if (job.kind === 'behavior_tick') await runBehaviorTick({ trigger: 'job' })
      else if (job.kind === 'concern_check') await runConcernCheck()
      else if (job.kind === 'reflection') await runReflection()
      else if (job.kind === 'maintenance') await runMaintenance()
      else store.transaction(gw => gw.finishJob(job.jobId, 'failed', 'unknown_job_kind'))
      // 只有“不自己重排下一次”的 job 才在这里结束。
      // behavior_tick / concern_check / maintenance 会通过 rescheduleJob 把同一行改成未来的 pending，
      // 若这里再无条件 settle 成 done，会把下一次调度吞掉。
      if (SELF_SCHEDULING_JOBS.has(job.kind) === false) {
        store.transaction(gw => gw.settleJob(job.jobId, 'done', null))
      }
    } catch (error) {
      const attempts = (job.attempts || 0) + 1
      const backoff = Math.min(3600000, 30000 * Math.pow(2, Math.min(attempts, 6)))
      store.transaction(gw => {
        if (attempts >= config.scheduler.jobMaxAttempts) gw.finishJob(job.jobId, 'failed', String(error && error.code || error.message || 'job_failed').slice(0, 200))
        else gw.retryJob(job.jobId, clock() + backoff, String(error && error.code || error.message || 'job_failed').slice(0, 200), attempts)
      })
    }
  }

  /* ------------------------------------------------------------------ *
   * 事实抽取 job
   * ------------------------------------------------------------------ */

  function historyProjection(gw, deleted, limit) {
    return gw.listEvents(characterId, Math.min(500, Math.max(1, Number(limit) || 100))).reverse()
      .filter(event => ['owner.message', 'character.reply', 'character.contact', 'assistant.utterance'].includes(event.kind) &&
        !(event.evidenceRefs || []).some(ref => deleted.has(ref)))
      .flatMap(event => {
        const body = event.payloadRef && gw.getPayload(event.payloadRef)
        const value = body && safeJson(body.body)
        return value?.text ? [{ role: event.kind === 'owner.message' ? 'user' : 'assistant', text: value.text,
          messageRef: event.correlationId, ts: event.occurredAt, sourceRefs: event.evidenceRefs || [] }] : []
      }).sort((a, b) => a.ts - b.ts)
  }

  async function runOwnerReply(job) {
    const payload = safeJson(job.payloadRef) || {}, sourceId = payload.sourceId
    const generation = replyGeneration, policyEpoch = policyStore.epoch()
    const controller = new AbortController()
    const settleJob = (status, reason) => store.transaction(gw => gw.finishJob(job.jobId, status, reason))
    const current = () => !stopped && !controller.signal.aborted && generation === replyGeneration &&
      policyEpoch === policyStore.epoch() && !policyStore.isDeleted(sourceId) &&
      store.read(gw => gw.getState(characterId).body.attentionPolicy?.conversation?.messageRef === sourceId)
    // A resumed job cannot replay a potentially visible response from an old
    // process. The accepted source remains available in history for an explicit retry.
    if (payload.epoch !== epoch || !current()) { settleJob('cancelled', 'reply_superseded_or_restarted'); return }
    replyAbort = controller
    try {
      const snapshot = store.read(gw => {
        const source = gw.getSource(sourceId)
        const text = source?.payloadRef && safeJson(gw.getPayload(source.payloadRef)?.body)?.text
        return { text, history: historyProjection(gw, policyStore.deletedSet(), 24),
          context: projector.project(gw, { characterId, purpose: 'expression', query: text || '',
            deleted: policyStore.deletedSet(), observations: gw.listFreshObservations(characterId, clock(), 10) }) }
      })
      if (!snapshot.text) { settleJob('cancelled', 'source_missing'); return }
      const style = await styleTemplateFromHost('M1_reply')
      if (!style.ok) throw new Error(style.reason)
      const refs = [...new Set([sourceId, ...snapshot.history.flatMap(row => row.sourceRefs || []), ...(snapshot.context.sections.memories || []).flatMap(m => m.evidenceRefs || []),
        ...(snapshot.context.sections.observations || []).map(o => o.sourceId)])]
      const expressed = await expresser.express({ context: snapshot.context, act: { kind: 'reply', userText: snapshot.text },
        history: snapshot.history.filter(row => row.messageRef !== sourceId),
        sources: [{ sourceId, world: 'user_report', actor: 'owner', text: snapshot.text }],
        evidenceRefs: refs, styleTemplate: style.template, form: 'reply', signal: controller.signal })
      if (!current() || refs.some(ref => policyStore.isDeleted(ref))) { settleJob('cancelled', 'reply_invalidated'); return }
      if (!expressed.ok) throw new Error(expressed.reason)
      const input = { text: expressed.text, semanticRef: 'reply:' + sourceId }
      const scopes = await grantedScopesFromHost()
      if (!current()) { settleJob('cancelled', 'reply_invalidated'); return }
      const prepared = store.transaction(gw => executor.prepare(gw, { characterId, capabilityId: 'presentation.text',
        capabilityVersion: 1, input, sourceRefs: refs, grantedScopes: scopes, allowExternal: false,
        epoch, now: clock(), dedupeKey: 'reply:' + sourceId }))
      if (!prepared.ok) throw new Error(prepared.code)
      if (prepared.reused) { settleJob('done', 'already_dispatched'); return }
      const dispatched = store.transaction(gw => executor.markDispatchStart(gw, prepared.operation.operationId, clock()))
      if (!dispatched.ok) throw new Error(dispatched.code)
      const result = await executor.dispatch(dispatched.operation, { input, sourceRefs: refs })
      if (stopped) return
      store.transaction(gw => {
        executor.settle(gw, { operationId: dispatched.operation.operationId, result, now: clock() })
        if (result.outcome === 'succeeded' && current() && !refs.some(ref => policyStore.isDeleted(ref))) {
          const bodyRef = gw.putPayload(JSON.stringify({ text: expressed.text }), 'episode')
          const event = gw.appendEvent({ eventId: deterministicId('evt', characterId + '|reply|' + sourceId), characterId,
            kind: 'character.reply', sourceId: null, sourceEventId: null, payloadRef: bodyRef, world: 'derived', trust: 'interpretation',
            correlationId: sourceId, occurredAt: clock(), observedAt: clock(), committedAt: clock(), timezone: 'Asia/Shanghai', retentionClass: 'episode', evidenceRefs: refs })
          const episodeId = deterministicId('episode', 'reply|' + sourceId)
          gw.insertEpisode({ episodeId, characterId, world: 'derived', title: '对话', bodyRef, occurredAt: clock(), createdSeq: event.seq, sourceRefs: refs })
          for (const ref of refs) gw.addEvidence(episodeId, ref, 'conversation_context', event.seq)
        }
        gw.finishJob(job.jobId, result.outcome === 'succeeded' ? 'done' : 'failed', result.error || result.unknownReason || null)
      })
      emit('owner.reply', { sourceId, outcome: result.outcome })
    } catch (error) {
      if (!stopped) { settleJob('failed', String(error.code || error.message).slice(0, 200)); emit('owner.reply', { sourceId, outcome: 'failed', reason: error.code || error.message }) }
    } finally { if (replyAbort === controller) replyAbort = null }
  }

  async function runExtraction (job) {
    const payload = safeJson(job.payloadRef)
    const sourceId = payload && payload.sourceId
    const source = store.read(gw => gw.getSource(sourceId))
    if (!source) {
      store.transaction(gw => gw.finishJob(job.jobId, 'cancelled', 'source_missing'))
      return
    }
    if (policyStore.isDeleted(sourceId) || source.permission === 'revoked') {
      store.transaction(gw => gw.finishJob(job.jobId, 'cancelled', 'source_forgotten'))
      return
    }
    const body = source.payloadRef ? store.read(gw => gw.getPayload(source.payloadRef)) : null
    const text = body ? (safeJson(body.body) || {}).text : null
    if (!text) {
      store.transaction(gw => gw.finishJob(job.jobId, 'failed', 'source_text_unavailable'))
      return
    }
    const budgetKey = 'extract:' + windowKey(clock(), 3600000)
    const allowed = store.transaction(gw => gw.consumeBudget(budgetKey, characterId, 'extract', clock(), config.budget.autonomousHourly * 4))
    if (!allowed.allowed) {
      store.transaction(gw => gw.retryJob(job.jobId, clock() + 600000, 'budget_exhausted', job.attempts))
      return
    }
    let extraction
    try {
      extraction = await extractor.extract({ sourceText: text, occurredAt: source.occurredAt, timezone: 'Asia/Shanghai' })
    } catch (error) {
      store.transaction(gw => gw.retryJob(job.jobId, clock() + 120000, 'model_failed', job.attempts))
      return
    }
    if (!extraction.ok) {
      store.transaction(gw => gw.retryJob(job.jobId, clock() + 120000, extraction.reason, job.attempts))
      return
    }
    const applied = store.transaction(gw => {
      const seq = gw.lastSeq(characterId).seq + 1
      const results = []
      for (const candidate of extraction.accepted) {
        if (policyStore.isDeleted(sourceId)) break
        results.push(admission.applyCandidate(gw, { characterId, sourceId, seq, now: clock(), candidate }))
        gw.appendEvent({
          eventId: deterministicId('evt', characterId + '|fact|' + JSON.stringify([sourceId, candidate.subject, candidate.predicate])),
          characterId, kind: 'memory.assertion', sourceId, sourceEventId: candidate.subject + ':' + candidate.predicate,
          payloadRef: null, world: 'derived', trust: 'interpretation', correlationId: sourceId,
          occurredAt: source.occurredAt, observedAt: clock(), committedAt: clock(), timezone: 'Asia/Shanghai',
          retentionClass: 'episode', evidenceRefs: [sourceId],
        })
      }
      gw.finishJob(job.jobId, 'done', null)
      return { accepted: results.length, rejected: extraction.rejected.length, results }
    })
    emit('memory.assertion', applied)
  }

  /* ------------------------------------------------------------------ *
   * 行为闭环
   * ------------------------------------------------------------------ */

  async function runBehaviorTick (options = {}) {
    if (behaviorRunning) return { ok: true, action: 'wait', reason: 'decision_in_flight' }
    behaviorRunning = true
    try { return await evaluateBehavior(options) } finally { behaviorRunning = false }
  }
  async function evaluateBehavior (options = {}) {
    if (!ready) return { ok: false, code: 'not_ready' }
    if (paused) return { ok: false, code: 'autonomy_paused' }
    const generation = autonomyGeneration
    const existingPlan = store.read(gw => gw.listActivePlans(characterId)[0])
    if (existingPlan) { enqueueNextTick(clock() + 60000); return { ok: true, action: 'wait', reason: 'plan_in_progress' } }
    const now = clock()
    const deleted = policyStore.deletedSet()
    const observations = store.read(gw => gw.listFreshObservations(characterId, now, 10))
    const built = store.read(gw => candidates.build(gw, { characterId, now, deleted, observations }))
    if (!built.opportunities.length) {
      enqueueNextTick(now + 30 * 60000)
      return { ok: true, action: 'wait', reason: 'no_opportunity', suppressed: built.suppressed }
    }

    const grantedScopes = await grantedScopesFromHost()
    const availableCapabilities = new Set()
    const capabilityEffects = {}
    for (const manifest of registry.list()) {
      const authorization = registry.authorize(manifest.id, { version: manifest.version, grantedScopes, allowExternal: false, now })
      if (authorization.ok) { availableCapabilities.add(manifest.id); capabilityEffects[manifest.id] = manifest.effect }
    }

    const recent = store.read(gw => ({
      kinds: new Set(gw.listActivePlans(characterId).map(plan => plan.recipeId)),
      ids: new Set(gw.listActivePlans(characterId).map(plan => plan.opportunityId).filter(Boolean)),
      timestamps: new Map(),
    }))
    const state = store.read(gw => gw.getState(characterId))
    const policy = (state && state.body && state.body.attentionPolicy) || {}
    const budget = store.read(gw => ({
      autonomousRemaining: config.budget.autonomousHourly - gw.readBudget('auto:' + windowKey(now, 3600000)),
      contactRemaining: Math.min(config.budget.proactiveHourly - gw.readBudget('contact:' + windowKey(now, 3600000)), config.budget.proactiveDaily - gw.readBudget('contact-day:' + windowKey(now, 86400000))),
    }))

    const filtered = rules.filter(built.opportunities, {
      now,
      deleted,
      availableCapabilities,
      capabilityEffects,
      quietUntil: Number(policy.quietUntil) || 0,
      ownerBusy: conversationActive(policy, now),
      budget,
      recentKinds: recent.kinds,
      recentOpportunityIds: recent.ids,
      recentTimestamps: recent.timestamps,
      preferenceFit: {},
    })

    if (!filtered.legal.length) {
      enqueueNextTick(now + 15 * 60000)
      return { ok: true, action: 'wait', reason: 'no_legal_candidate', rejected: filtered.rejected }
    }

    const activePlan = store.read(gw => gw.listActivePlans(characterId)[0] || null)
    const selection = rules.select(filtered.legal, { current: activePlan ? { utility: 0.5 } : null })

    /* ---- 需要模型的场合才调用模型（无合法候选不调用） ---- */
    let decision = null
    if (!activePlan) {
      const modelAllowed = store.transaction(gw => gw.consumeBudget('auto:' + windowKey(now, 3600000), characterId, 'decide', now, config.budget.autonomousHourly))
      if (modelAllowed.allowed) {
        const context = store.read(gw => projector.project(gw, {
          characterId, purpose: 'decision', query: selection.selected.goal, deleted,
          capabilityCatalog: catalogView(registry.list().filter(manifest => availableCapabilities.has(manifest.id))),
          observations,
        }))
        try {
          turnAbort = typeof AbortController === 'function' ? new AbortController() : null
          const decided = await decider.decide({
            context,
            candidates: rules.forModel(filtered.legal),
            recipeViews: [...new Set(rules.forModel(filtered.legal).flatMap(item => recipesForKind(item.kind)))].map(id => {
              const recipe = getRecipe(id)
              return { recipeId: recipe.recipeId, version: recipe.version, steps: recipe.steps.map(step => ({ stepId: step.id, type: step.type, capabilityId: step.capabilityId || null })), label: recipe.label }
            }),
            maxPlanSteps: config.behavior.maxPlanSteps,
            // The model may select any legal candidate. The top numeric choice
            // being a quiet note must not forbid a different legal contact.
            mayContactOwner: filtered.legal.some(candidate => candidate.mayContactOwner),
            asOf: now,
            signal: turnAbort ? turnAbort.signal : undefined,
          })
          if (decided.ok) decision = decided.decision
        } catch (error) {
          log('decide failed', error.code || error.message)
        } finally { turnAbort = null }
      }
    }
    if (stopped || generation !== autonomyGeneration) { enqueueNextTick(clock() + 120000); return { ok: true, action: 'wait', reason: 'decision_invalidated' } }

    if (decision && decision.action === 'wait') {
      enqueueNextTick(now + 20 * 60000)
      return { ok: true, action: 'wait', reason: 'model_wait' }
    }

    const opportunity = decision && decision.opportunityId
      ? filtered.legal.find(item => item.opportunityId === decision.opportunityId) || selection.selected
      : selection.selected
    const recipeId = decision && decision.recipeId ? decision.recipeId : recipesForKind(opportunity.kind)[0]
    if (!recipeId) {
      enqueueNextTick(now + 20 * 60000)
      return { ok: true, action: 'wait', reason: 'no_recipe_for_kind' }
    }
    const recipe = getRecipe(recipeId)
    if (!recipe) {
      enqueueNextTick(now + 20 * 60000)
      return { ok: true, action: 'wait', reason: 'recipe_missing' }
    }
    if (!recipe.originKinds.includes(opportunity.kind) || recipe.requiredCapabilities.some(id => !availableCapabilities.has(id))) return { ok: false, code: 'recipe_not_authorized_for_opportunity' }
    if (recipe.mayContactOwner && !decision) { enqueueNextTick(now + 120000); return { ok: true, action: 'wait', reason: 'contact_requires_decision' } }

    const created = store.transaction(gw => {
      const basePlan = planMachine.createPlan({ characterId, opportunity, recipe, epoch, now })
      const plan = enrichPlanSteps(basePlan, opportunity)
      gw.putPlan({
        planId: plan.planId, characterId, opportunityId: plan.opportunityId, recipeId: plan.recipeId,
        recipeVersion: plan.recipeVersion, status: plan.status, stepCursor: 0, steps: plan.steps,
        epoch, now,
      })
      gw.appendEvent({
        eventId: deterministicId('evt', characterId + '|plan.start|' + plan.planId), characterId,
        kind: 'behavior.plan_started', sourceId: null, sourceEventId: null, payloadRef: null,
        world: 'system', trust: 'interpretation', correlationId: plan.planId,
        occurredAt: now, observedAt: now, committedAt: now, timezone: 'Asia/Shanghai',
        retentionClass: 'episode', evidenceRefs: opportunity.evidenceRefs || [],
      })
      return plan
    })
    await advancePlan(created.planId, { opportunity })
    return { ok: true, action: 'plan', planId: created.planId, recipeId: recipe.recipeId, selected: opportunity.opportunityId, rejected: filtered.rejected, trace: selection.trace }
  }

  /**
   * 推进一步计划。条件步同步评估；能力步先提交 operation，再在事务外派发。
   */
  async function advancePlan (planId, options = {}) {
    let plan = store.read(gw => gw.getPlan(planId))
    if (!plan) return { ok: false, code: 'plan_missing' }
    if (stopped || !['active', 'waiting'].includes(plan.status)) return { ok: true, status: plan.status }
    const generation = autonomyGeneration
    if (planMachine.staleForEpoch(plan, epoch)) {
      store.transaction(gw => gw.patchPlan(planId, { status: 'paused', cancelReason: 'stale_epoch' }))
      return { ok: false, code: 'stale_epoch' }
    }
    const recipe = getRecipe(plan.recipeId, plan.recipeVersion)
    if (!recipe) {
      store.transaction(gw => gw.patchPlan(planId, { status: 'failed', cancelReason: 'recipe_missing' }))
      return { ok: false, code: 'recipe_missing' }
    }

    const context = store.read(gw => buildPlanContext(gw, plan))
    if (context.evidenceRefs.some(ref => policyStore.isDeleted(ref))) {
      store.transaction(gw => gw.patchPlan(planId, planMachine.halt(plan, 'source_forgotten', clock())))
      return { ok: false, code: 'source_forgotten' }
    }
    const next = planMachine.planNext(plan, context)
    if (next.kind === 'halted') return { ok: true, status: plan.status }
    if (next.kind === 'waiting') return { ok: true, status: 'waiting', reason: next.reason }
    if (next.kind === 'done') {
      const completion = lifeDomain.projectCompletion(plan, { recipe, artifactRefs: context.artifactRefs, receipts: context.receipts })
      if (!completion.ok) { store.transaction(gw => gw.patchPlan(planId, { status: 'failed', cancelReason: completion.reason })); enqueueNextTick(clock() + 1800000); return completion }
      store.transaction(gw => {
        gw.patchPlan(planId, { status: 'completed' })
        // Recording an observation is not the same as mentioning it to the owner.
        // served:<opportunity> prevents repeated notes; contact-topic:<source> tracks speech.
        gw.setMeta('served:' + plan.opportunityId, String(clock()))
        if (context.concern) gw.putConcern({ ...context.concern, lastContactAt: clock(), nextCheckAt: clock() + (recipe.nextCheckMs || 21600000), revision: context.concern.revision + 1 })
        if (context.project) gw.putProject({ ...context.project, status: 'completed', stepCursor: context.project.stepCursor + 1, artifactRefs: context.artifactRefs, revision: context.project.revision + 1, nextWakeAt: null })
        gw.appendEvent({
          eventId: deterministicId('evt', characterId + '|plan.done|' + planId), characterId, kind: 'behavior.plan_completed',
          sourceId: null, sourceEventId: null, payloadRef: null, world: 'system', trust: 'interpretation',
          correlationId: planId, occurredAt: clock(), observedAt: clock(), committedAt: clock(),
          timezone: 'Asia/Shanghai', retentionClass: 'episode', evidenceRefs: [],
        })
      })
      enqueueNextTick(clock() + (Number(recipe.nextCheckMs) || 1800000))
      return { ok: true, status: 'completed', completion }
    }
    if (next.kind === 'condition') {
      const now = clock()
      if (next.result.ok) {
        store.transaction(gw => gw.patchPlan(planId, planMachine.markStepResult(plan, next.step.stepId, { outcome: 'succeeded' }, now)))
        return advancePlan(planId, options)
      }
      // 条件不满足是正常结果：整个计划按“不值得继续”结束，而不是失败重试。
      store.transaction(gw => {
        gw.patchPlan(planId, planMachine.markStepResult(plan, next.step.stepId, { outcome: 'cancelled', reason: 'condition_not_met' }, now))
      })
      return { ok: true, status: 'cancelled', reason: 'condition_not_met', detail: next.result }
    }

    /* ---- 能力步 ---- */
    const step = next.step
    const manifest = registry.get(step.capabilityId)
    if (!manifest) {
      store.transaction(gw => gw.patchPlan(planId, { status: 'failed', cancelReason: 'capability_missing' }))
      return { ok: false, code: 'capability_missing', detail: step.capabilityId }
    }
    let input
    if (step.capabilityId === 'presentation.text') {
      const expressed = await buildExpressionFor({ plan, context, opportunity: options.opportunity })
      if (!expressed.ok) {
        store.transaction(gw => gw.patchPlan(planId, planMachine.markStepResult(plan, step.stepId, { outcome: 'failed', reason: expressed.reason }, clock())))
        return { ok: false, code: expressed.reason }
      }
      input = { text: expressed.text, semanticRef: 'plan:' + plan.planId }
    } else if (step.capabilityId === 'virtual.note') {
      const note = buildNoteInput({ plan, context, opportunity: options.opportunity })
      if (!note.ok) {
        store.transaction(gw => gw.patchPlan(planId, planMachine.markStepResult(plan, step.stepId, { outcome: 'cancelled', reason: note.reason }, clock())))
        return { ok: false, code: note.reason }
      }
      input = note.input
    } else {
      input = step.capabilityId === 'virtual.rest_local' ? { minutes: 15 } : step.args || {}
    }

    const grantedScopes = await grantedScopesFromHost()
    const latest = store.read(gw => gw.getPlan(planId))
    if (stopped || generation !== autonomyGeneration || !latest || latest.status !== 'active') return { ok: false, code: 'plan_invalidated' }
    if (recipe.mayContactOwner && conversationActive(store.read(gw => gw.getState(characterId).body.attentionPolicy || {}), clock())) return { ok: false, code: 'conversation_active' }
    const allowExternal = false
    const prepared = store.transaction(gw => {
      if (recipe.mayContactOwner) {
        if (!gw.consumeBudget('contact:' + windowKey(clock(), 3600000), characterId, 'contact', clock(), config.budget.proactiveHourly).allowed ||
            !gw.consumeBudget('contact-day:' + windowKey(clock(), 86400000), characterId, 'contact', clock(), config.budget.proactiveDaily).allowed) throw rejected('contact_budget_exhausted')
      }
      const result = executor.prepare(gw, {
        characterId, capabilityId: step.capabilityId, capabilityVersion: manifest.version,
        input, sourceRefs: context.evidenceRefs,
        grantedScopes, allowExternal, now: clock(), epoch,
        planRevision: 1, dedupeKey: planId + '|' + step.stepId + '|' + plan.stepCursor,
      })
      if (!result.ok) return result
      gw.patchPlan(planId, planMachine.markStepRunning(plan, step.stepId, result.operation.operationId, clock()))
      return result
    })
    if (!prepared.ok) {
      store.transaction(gw => gw.patchPlan(planId, { status: 'waiting', cancelReason: prepared.code }))
      return { ok: false, code: prepared.code, detail: prepared.detail }
    }
    if (prepared.reused) {
      // 已存在的 operation：按既有状态决定，不重复派发。
      // 若它已经有终态回执，直接推进计划；否则等回执（不能卡在 waiting 不动）。
      await continuePlanForOperation(prepared.operation)
      return { ok: true, status: 'reused', operationId: prepared.operation.operationId, operationStatus: prepared.operation.status }
    }

    const dispatched = store.transaction(gw => executor.markDispatchStart(gw, prepared.operation.operationId, clock()))
    if (!dispatched.ok) return dispatched
    const task = (async () => {
      const result = await executor.dispatch(dispatched.operation, {
        input, sourceRefs: context.evidenceRefs,
        services: {},
      })
      if (stopped) return { ok: false, code: 'kernel_stopped' }
      const settled = store.transaction(gw => {
        const applied = executor.settle(gw, { operationId: dispatched.operation.operationId, result, now: clock() })
        if (applied.ok && !applied.duplicate) {
          applyInternalEffect(gw, applied.operation, result)
          if (applied.operation.status === 'succeeded' && step.capabilityId === 'presentation.text' &&
              !context.evidenceRefs.some(ref => policyStore.isDeleted(ref))) {
            const bodyRef = gw.putPayload(JSON.stringify({ text: input.text }), 'episode')
            const episodeId = deterministicId('episode', 'contact|' + applied.operation.operationId)
            const event = gw.appendEvent({ eventId: deterministicId('evt', episodeId), characterId,
              kind: 'character.contact', sourceId: null, sourceEventId: null, payloadRef: bodyRef,
              world: 'derived', trust: 'interpretation', correlationId: applied.operation.operationId,
              occurredAt: clock(), observedAt: clock(), committedAt: clock(), timezone: 'Asia/Shanghai',
              retentionClass: 'episode', evidenceRefs: context.evidenceRefs })
            gw.insertEpisode({ episodeId, characterId, world: 'derived', title: '主动交流', bodyRef,
              occurredAt: clock(), createdSeq: event.seq, sourceRefs: context.evidenceRefs })
            for (const ref of context.evidenceRefs) gw.addEvidence(episodeId, ref, 'conversation_context', event.seq)
          }
        }
        return applied
      })
      registry.recordOutcome(manifest.id, settled.ok && settled.operation && settled.operation.status === 'succeeded', clock())
      await continuePlanForOperation(settled.operation || dispatched.operation)
      return settled
    })()
    track(task)
    return { ok: true, status: 'dispatched', operationId: dispatched.operation.operationId }
  }

  /**
   * 把候选的 concernId / projectId 写入每个步骤的 args，
   * 这样计划后续推进时（没有候选对象在手）仍能定位关注与项目。
   */
  function enrichPlanSteps (plan, opportunity) {
    const refs = {
      concernId: (opportunity && opportunity.concernId) || null,
      projectId: (opportunity && opportunity.projectId) || null,
      evidenceRefs: (opportunity && opportunity.evidenceRefs) || [],
      opportunity: opportunity || null,
    }
    return {
      ...plan,
      steps: plan.steps.map(step => ({ ...step, args: { ...(step.args || {}), ...refs } })),
    }
  }

  function buildPlanContext (gw, plan) {
    const state = gw.getState(characterId)
    const observations = gw.listFreshObservations(characterId, clock(), 10)
    const firstStepArgs = (plan.steps && plan.steps[0] && plan.steps[0].args) || {}
    const concern = firstStepArgs.concernId ? gw.getConcern(firstStepArgs.concernId) : null
    const project = firstStepArgs.projectId ? gw.getProject(firstStepArgs.projectId) : null

    /* 只认**本计划**产生的产物：operation 的 dedupeKey 以 planId 开头。
       否则“历史上恰好有别的笔记”会让 artifact_exists 误判成功（U-11 第 1 行）。 */
    const allReceipts = gw.listOperations(characterId, ['succeeded'], 50)
    const planOperations = allReceipts.filter(operation => typeof operation.dedupeKey === 'string' && operation.dedupeKey.startsWith(plan.planId + '|'))
    const artifactRefs = new Set()
    const receipts = []
    for (const operation of planOperations) {
      receipts.push({ operationId: operation.operationId, effect: operation.effect, capabilityId: operation.capabilityId })
      if (!operation.receiptRef) continue
      const payload = gw.getPayload(operation.receiptRef)
      if (!payload) continue
      let receipt = null
      try { receipt = JSON.parse(payload.body) } catch (_) { receipt = null }
      for (const ref of (receipt && receipt.artifactRefs) || []) artifactRefs.add(ref)
    }
    return {
      now: clock(),
      state: state ? state.body : null,
      observations,
      artifactRefs: Array.from(artifactRefs),
      receipts,
      concern,
      project,
      evidenceRefs: firstStepArgs.evidenceRefs || [],
    }
  }

  async function continuePlanForOperation (operation) {
    if (!operation || operation.planRevision === null) return
    const plans = store.read(gw => gw.listActivePlans(characterId))
    const plan = plans.find(item => item.steps.some(step => step.operationId === operation.operationId))
    if (!plan) return
    const step = plan.steps.find(item => item.operationId === operation.operationId)
    if (!step) return
    const outcome = operation.status === 'succeeded'
      ? { outcome: 'succeeded' }
      : operation.status === 'unknown'
        ? { outcome: 'unknown', reason: operation.unknownReason }
        : { outcome: 'failed', reason: operation.unknownReason || 'failed', recoveryPolicy: (getRecipe(plan.recipeId, plan.recipeVersion) || {}).recoveryPolicy }
    store.transaction(gw => gw.patchPlan(plan.planId, planMachine.markStepResult(plan, step.stepId, outcome, clock())))
    if (operation.status === 'succeeded') {
      await advancePlan(plan.planId)
    } else if (operation.status === 'unknown') {
      // unknown：进入 waiting，等待核对；不自动重发（C09）
      enqueueConcernCheck(clock() + config.scheduler.heartbeatMs)
    } else {
      enqueueNextTick(clock() + 1800000)
    }
  }

  /** internal 效果：由内核在事务内应用到角色状态（数值规则不变）。 */
  function applyInternalEffect (gw, operation, result) {
    if (!operation || operation.status !== 'succeeded' || result.outcome !== 'succeeded') return
    const state = gw.getState(characterId)
    if (!state) return
    if (operation.capabilityId === 'virtual.rest_local') {
      const minutes = Number(result.output && result.output.minutes) || 15
      const nextBody = { ...state.body, nurture: { ...state.body.nurture, rest: { remainingMs: minutes * 60000 } }, attentionPolicy: { ...state.body.attentionPolicy, restUntil: clock() + minutes * 60000 } }
      gw.writeState({
        characterId, revision: state.revision + 1, identityRevision: state.identityRevision,
        schemaVersion: state.schemaVersion, body: nextBody, seq: gw.lastSeq(characterId).seq,
      })
    }
    if (operation.capabilityId === 'virtual.note') {
      const refs = result.receipt?.evidence?.sourceRefs || []
      // An already-created file is a truthful effect, but forgetting during the
      // operation must prevent its late receipt from re-admitting it as memory.
      if (refs.some(ref => policyStore.isDeleted(ref))) {
        const path = require('node:path'), fs = require('node:fs')
        const target = path.resolve(paths.artifacts, String(result.output?.relativePath || ''))
        const relative = path.relative(paths.artifacts, target)
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) { try { fs.unlinkSync(target) } catch (error) { if (error.code !== 'ENOENT') log('forgotten artifact cleanup pending', error.code) } }
        return
      }
      const artifactId = result.output && result.output.artifactId
      if (artifactId) {
        gw.putArtifact({
          artifactId, characterId, kind: 'virtual_note',
          relativePath: String(result.output.relativePath || ''), hash: String(result.output.hash || ''),
          world: 'virtual', sourceRefs: (result.receipt && result.receipt.evidence && result.receipt.evidence.sourceRefs) || [],
          createdAt: clock(), verified: true,
        })
      }
    }
    if (operation.capabilityId === 'presentation.text') {
      for (const ref of result.receipt?.evidence?.sourceRefs || []) gw.setMeta('contact-topic:' + ref, String(clock()))
      const body = { ...state.body, attentionPolicy: { ...state.body.attentionPolicy, lastContactAt: clock() } }
      gw.writeState({ ...state, characterId, revision: state.revision + 1, body })
    }
  }

  function buildNoteInput ({ plan, context, opportunity }) {
    const refs = context.evidenceRefs || []
    const fresh = (context.observations || []).filter(item => item.freshUntil > clock() && refs.includes(item.sourceId))
    if (!refs.length && !fresh.length) return { ok: false, reason: 'note_without_source' }
    const source = fresh[0]
    const title = source ? ('观察：' + String(source.kind)) : '一点记录'
    const text = source
      ? '刚才注意到 ' + JSON.stringify(source.payload).slice(0, 400)
      : '记下刚才那件事（来源：' + refs.join('、') + '）'
    return { ok: true, input: { title: title.slice(0, 120), text: text.slice(0, 4000), topicKey: (opportunity && opportunity.kind) || 'note' } }
  }

  async function buildExpressionFor ({ plan, context, opportunity }) {
    const selected = opportunity || plan.steps[0]?.args?.opportunity || {}
    const generation = autonomyGeneration
    const style = await styleTemplateFromHost()
    if (!style.ok) return { ok: false, reason: style.reason }
    const projection = store.read(gw => projector.project(gw, { characterId, purpose: 'expression', query: selected.goal || '', deleted: policyStore.deletedSet(), observations: gw.listFreshObservations(characterId, clock(), 10).filter(row => (context.evidenceRefs || []).includes(row.sourceId)) }))
    const act = {
      kind: selected.kind, goal: selected.goal,
      opportunity: { reasons: selected.reasons || [], lastOwnerAt: selected.lastOwnerAt || null },
      focus: selected.focus || context.concern?.subject || null,
      facts: projection.sections.memories || [],
    }
    const controller = new AbortController()
    turnAbort = controller
    const expressed = await expresser.express({
      context: projection,
      act,
      evidenceRefs: context.evidenceRefs || [],
      styleTemplate: style.template,
      form: selected.kind === 'social_contact' ? 'casual_chat' : 'share',
      signal: controller.signal,
    })
    if (turnAbort === controller) turnAbort = null
    if (generation !== autonomyGeneration || stopped) return { ok: false, reason: 'expression_invalidated' }
    if (!expressed.ok) return { ok: false, reason: expressed.reason }
    return { ok: true, text: expressed.text }
  }

  async function styleTemplateFromHost (stage = 'M2_say') {
    if (!host || typeof host.request !== 'function') return { ok: false, reason: 'host_unavailable' }
    try {
      const result = await host.request('prompts.snapshot', {})
      if (!result || result.ok !== true || !result.value) return { ok: false, reason: 'prompts_unavailable' }
      const texts = result.value.texts || {}
      // 复用现有表达模板，不在内核里另写一套风格。
      const identity = store.read(gw => gw.latestIdentity(characterId))
      const name = identity?.displayName || '我'
      const slots = createSlots({ PromptConfig: { text: (id, fallback) => typeof texts[id] === 'string' ? texts[id] : fallback }, ExpressionStylePolicy: stylePolicy })
      const style = await slots.styleSlot(stage)
      const reply = stage === 'M1_reply'
      const template = texts[stage] || slots.join([slots.idSlot(name, { honest: reply }), slots.voSlot(),
        slots.ftSlot(), style ? texts[style.promptId] : '',
        reply ? texts['m1.4c9d3ced5c'] : texts['m2.6f027c6a99'], reply ? texts['m1.935da7e303'] : '只输出这一句话。'])
      if (!template || !String(template).trim()) return { ok: false, reason: 'style_template_missing' }
      return { ok: true, template: String(template), revision: result.value.revision || null }
    } catch (error) { return { ok: false, reason: 'prompts_request_failed' } }
  }

  async function grantedScopesFromHost () {
    if (!host || typeof host.request !== 'function') return new Set()
    try {
      const result = await host.request('capability.grants', {})
      if (!result || result.ok !== true) return new Set()
      const installed = Object.values(packageStore.snapshot().packages).filter(item => item.enabled && item.receipt?.trustedLocal).map(item => 'package:' + item.id)
      return new Set([...(Array.isArray(result.scopes) ? result.scopes : []), ...installed].filter(scope => !policyStore.isScopeRevoked(scope)))
    } catch (_) { return new Set() }
  }

  function enqueueNextTick (dueAt) {
    store.transaction(gw => gw.rescheduleJob({
      jobId: deterministicId('job', characterId + '|behavior_tick|next'),
      dedupeKey: characterId + '|behavior_tick',
      characterId, kind: 'behavior_tick', dueAt: Math.max(clock() + 1000, dueAt), payloadRef: null,
    }))
    scheduleNextWake()
  }

  function enqueueConcernCheck (dueAt) {
    store.transaction(gw => gw.rescheduleJob({
      jobId: deterministicId('job', characterId + '|concern_check'),
      dedupeKey: characterId + '|concern_check',
      characterId, kind: 'concern_check', dueAt: Math.max(clock() + 1000, dueAt), payloadRef: null,
    }))
    scheduleNextWake()
  }

  async function runConcernCheck () {
    const now = clock()
    const due = store.read(gw => gw.listConcerns(characterId, { statusIn: ['open', 'deferred'], dueBefore: now, limit: 20 }))
    const expired = []
    for (const concern of due) {
      if (concern.expiresAt && concern.expiresAt <= now) {
        store.transaction(gw => gw.putConcern({ ...concern, status: 'expired', nextCheckAt: null, revision: concern.revision + 1, updatedSeq: gw.lastSeq(characterId).seq }))
        expired.push(concern.concernId)
      }
    }
    // 核对未决 operation（unknown → reconcile）
    const unknowns = store.read(gw => gw.listOperations(characterId, ['unknown'], 10))
    for (const operation of unknowns) {
      const result = await executor.reconcile(operation, { now })
      if (result.outcome === 'unknown') continue
      store.transaction(gw => {
        const settled = executor.settle(gw, { operationId: operation.operationId, result, now: clock() })
        if (settled.ok && !settled.duplicate) applyInternalEffect(gw, settled.operation, result)
        return settled
      })
    }
    enqueueConcernCheck(now + config.time.reminderSweepMs)
    return { ok: true, expired: expired.length, reconciled: unknowns.length }
  }

  async function runReflection () {
    const now = clock()
    const allowed = store.transaction(gw => gw.consumeBudget('reflect:' + windowKey(now, 86400000), characterId, 'reflect', now, config.budget.reflectionDaily))
    if (!allowed.allowed) return { ok: false, code: 'budget_exhausted' }
    const episodes = store.read(gw => gw.listEpisodes(characterId, 12))
    if (episodes.length < config.growth.minReflectionSources) return { ok: true, proposed: false, reason: 'insufficient_episodes' }
    const state = store.read(gw => gw.getState(characterId))
    let proposal = null
    try {
      const reflected = await reflector.reflect({
        episodes, now, interests: (state && state.body && state.body.interests) || {},
      })
      if (reflected.ok) proposal = reflected.proposal
    } catch (error) {
      log('reflect failed', error.code || error.message)
    }
    if (!proposal) {
      return store.transaction(gw => {
        const created = growth.proposeReflection(gw, { characterId, now, config, seq: gw.lastSeq(characterId).seq + 1 })
        return { ok: true, ...created, modelProposal: false }
      })
    }
    const validated = growth.validateReflectionProposal(proposal, config)
    if (!validated.ok) {
      return store.transaction(gw => {
        const created = growth.proposeReflection(gw, { characterId, now, config, seq: gw.lastSeq(characterId).seq + 1 })
        return { ok: true, ...created, modelProposal: true, rejected: validated.reason }
      })
    }
    const value = validated.value
    if (value.kind === 'none') return { ok: true, applied: false, kind: 'none' }
    if (value.kind === 'interest') {
      const sourceTimestamps = episodes
        .filter(episode => (episode.sourceRefs || []).some(ref => value.sourceRefs.includes(ref)))
        .map(episode => episode.occurredAt)
      const reflectionId = deterministicId('reflect', JSON.stringify(value))
      const applied = store.transaction(gw => {
        // 反思记录与状态变更同一事务：账本里必须能看出“这条提案被采用/被拒”。
        gw.putReflection({
          reflectionId, characterId, status: 'pending', body: value,
          sourceRefs: value.sourceRefs, createdSeq: gw.lastSeq(characterId).seq + 1,
        })
        const result = growth.applyInterestUpdate(gw, {
          characterId, topicKey: value.topicKey, delta: value.delta,
          sourceRefs: value.sourceRefs, sourceTimestamps, config, now,
        })
        gw.decideReflection(reflectionId, result.ok ? 'applied' : 'rejected', result.ok ? 'interest_updated' : String(result.reason || 'rejected'))
        return { ...result, reflectionId }
      })
      return { ok: applied.ok, applied: applied.ok, reason: applied.reason || null, interest: applied.interest || null, reflectionId: applied.reflectionId }
    }
    // 关系说明与 Skill 候选只落 pending，不自动改数值、不授予能力。
    return store.transaction(gw => {
      gw.putReflection({
        reflectionId: deterministicId('reflect', JSON.stringify(value)), characterId, status: 'pending',
        body: value, sourceRefs: value.sourceRefs, createdSeq: gw.lastSeq(characterId).seq + 1,
      })
      return { ok: true, applied: false, recorded: value.kind }
    })
  }

  async function runMaintenance () {
    const now = clock()
    return store.transaction(gw => {
      // 观测过期清理（热数据生命周期）
      gw.purgeObservations(now - config.retention.foregroundObservationHours * 3600000)
      // 冷归档：长期未用的活动断言转 archived
      const pinned = new Set()
      for (const concern of gw.listConcerns(characterId, { statusIn: ['open', 'deferred'], limit: 200 })) {
        for (const ref of concern.sourceRefs || []) pinned.add(ref)
      }
      const archived = lifecycle.archiveCold(gw, {
        characterId, before: gw.lastSeq(characterId).seq - 5000, pinned,
        limit: 50, seq: gw.lastSeq(characterId).seq,
      })
      gw.rescheduleJob({
        jobId: deterministicId('job', characterId + '|maintenance|next'), dedupeKey: characterId + '|maintenance',
        characterId, kind: 'maintenance', dueAt: now + 3600000, payloadRef: null,
      })
      return { ok: true, archived: archived.archived.length }
    })
  }

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function windowKey (ts, spanMs) {
    const bucket = Math.floor(ts / spanMs)
    return spanMs + ':' + bucket
  }
  function conversationActive (policy, now) {
    const session = policy.conversation || {}
    return !!policy.suspendedAt || !!policy.hidden || !!session.surfaceOpen || (session.phase === 'active' && session.leaseUntil > now)
  }
  function track (promise) {
    inflight.add(promise)
    promise.then(() => inflight.delete(promise), error => { inflight.delete(promise); log('background_failed', error.message) })
    return promise
  }

  function safeJson (value) {
    if (value === null || value === undefined) return null
    if (typeof value === 'object') return value
    try { return JSON.parse(value) } catch (_) { return null }
  }

  return {
    start,
    stop,
    submit,
    read,
    subscribe,
    isReady: () => ready && !readOnly,
    info: () => ({ characterId, epoch, ready, readOnly, paused, mode, driver: store.driver }),
    _internals: { store, policyStore, registry, executor, importer, exporter, projector, candidates, rules, planMachine, runSchedulerOnce, runBehaviorTick, advancePlan },
  }
}

module.exports = { createKernel, JOB_KINDS, VISIBLE_COMMANDS }
