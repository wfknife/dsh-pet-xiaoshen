{
/* P1：Job Object 生命周期开关（默认关；开启后 stopDsh 只杀宿主、由 job 回收整树） */
function dshJobMode() {
  /* P1 收口：默认启用（宿主内建 Job）；DESKPET_DSH_JOB=0 显式关闭；宿主建 job 失败会自动降级 */
  return String(process.env.DESKPET_DSH_JOB || "1") !== "0"
}

/* P1-K.2 P1：取回层模式（legacy=自研下载器；pacote=pacote manifest + 自研 hop 下载 + pacote 解包校验） */
const { app, BrowserWindow, ipcMain, screen, shell, dialog, Tray, Menu, nativeImage, powerMonitor, utilityProcess } = require('electron')
// A launcher may close its console pipe while the desktop app stays alive.
// EPIPE is not an application failure; preserve every other stream error.
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') stream.on('error', err => { if (err.code !== 'EPIPE') throw err })
}
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')
const http = require('http')
const crypto = require('crypto')
const { createStateStore } = require('./state-store.cjs')
const { pairAwareHistoryWindow } = require('./renderer/memory/history-window.js')
const { createDshCompat, DSH_COMPAT_VERSION } = require('./dsh-compat.js')
const ModelValidatorReal = require('./model-validator-real.js')
const DshLifecycle = require('./dsh-lifecycle.js')
const DiaryDay = require('./renderer/diary/diary-day.js')
const VersionCompare = require('./build/version-compare.js')
const ModelRegistry = require('./model-registry.js')
const { createUpdateManager } = require('./update-manager.js')
const { resolveUserData } = require('./userdata-isolation.js')
const { spawnSync, spawn } = require('child_process')
const { StringDecoder } = require('node:string_decoder')
/* P4-P1：Official Harness Adapter——桌宠与官方 DeepSeek Harness 的唯一耦合点。
   惰性 require：纯净版构建不打包该文件，所有调用点都先过 dshLifecycleForbidden/
   editionForbidden 闸，因此 clean 版永远不会执行到 require。 */
function officialHarness() { return require('./official-harness.js') }

// DSH endpoint override for packaged-client verification against an
// independent DSH instance. Business code does not see this value; the
// Compatibility Layer owns all protocol details. Normal linkage targets the
// official Desktop Host; explicit isolated tests keep their independent port.
/* P1-K.2.1：BASE / WEB_URL 见下方 TEST_EDITION 之后的隔离注入块 */

// DSH session 工作目录（可用环境变量 DSH_WORKSPACE 覆盖；默认取用户主目录下的 dsh-workspace）

const WORKSPACE_PATH = process.env.DSH_WORKSPACE || path.join(require('os').homedir(), 'dsh-workspace')
// 打包安装后 userData 必须独立于开发版（否则单实例锁/缓存与开发实例冲突），
// 且用 ASCII 路径避免中文目录名带来的缓存权限问题
/* P1-A.1：userData 解析统一入口。
   production / clean 分支不读任何 env / CLI（与 6d8a963 运行时语义一致）；
   只有 resources/test-edition.json 存在且 edition==='test' 时才允许 env/CLI，且必须通过 G1–G4 + canonical 守卫。
   守卫失败 ⇒ fail-fast（exit 2），绝不回落到生产目录。 */
const UDR = resolveUserData({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appDataPath: app.getPath('appData'),
  homedir: require('os').homedir(),
  tmpRoot: require('os').tmpdir(),
  argv: process.argv,
  env: process.env,
  devDir: path.join(__dirname, 'data'),
  createTestDir: true,
})
const TEST_EDITION = UDR.edition === 'test'
/* P1-K.2.1 测试隔离注入（只在 test edition + 显式测试参数时生效；生产默认行为完全不变）
   优先级：TEST_DSH_HOME > homedir()/.dsh ；TEST_DSH_PORT > 3080
   只有三件套齐全（test userData + 独立 HOME + 独立端口≠3080）才算"完整隔离"，才解除 DSH 生命周期/执行闸 */
const TEST_DSH_HOME = TEST_EDITION && process.env.TEST_DSH_HOME && String(process.env.TEST_DSH_HOME).trim()
  ? path.resolve(String(process.env.TEST_DSH_HOME).trim())
  : null
const TEST_DSH_PORT_RAW = TEST_EDITION && process.env.TEST_DSH_PORT ? String(process.env.TEST_DSH_PORT).trim() : ''
const TEST_DSH_PORT = /^\d{3,5}$/.test(TEST_DSH_PORT_RAW) ? Number(TEST_DSH_PORT_RAW) : null
const ISOLATED_TEST = !!(TEST_EDITION && TEST_DSH_HOME && TEST_DSH_PORT && TEST_DSH_PORT !== 3080)
const DSH_PORT = TEST_DSH_PORT || 3080
/* 隔离运行时 BASE 由测试端口决定；日常/开发测试入口默认连接官方 Desktop Host。
   显式 endpoint override 仍保留，桌面端接入成功后使用 adapter 返回的地址与认证。 */
const BASE = (!ISOLATED_TEST && process.env.DSH_BASE_URL && String(process.env.DSH_BASE_URL).trim())
  || ('http://127.0.0.1:' + (ISOLATED_TEST ? DSH_PORT : 19387))
const WEB_URL = BASE
if (!UDR.ok) {
  const msg = 'userData isolation refused: ' + JSON.stringify(UDR.refusals) + ' requested=' + String(UDR.dir || '-')
  try { console.error('[deskpet] ' + msg) } catch (e) { /* ignore */ }
  try {
    const failDir = UDR.edition === 'test' && UDR.dir ? UDR.dir : app.getPath('userData')
    fs.mkdirSync(failDir, { recursive: true })
    fs.appendFileSync(path.join(failDir, 'isolated-mode-fail.log'), new Date().toISOString() + ' ' + msg + String.fromCharCode(10), 'utf8')
  } catch (e) { /* ignore */ }
  /* fail-fast：绝不 fallback 到 production userData */
  app.exit(2)
} else if (UDR.edition !== 'dev') {
  app.setPath('userData', UDR.dir)
}
const RUNTIME_INFO = { edition: UDR.edition, userDataSource: UDR.source, dataDir: app.getPath('userData') }
// 数据目录：打包后落在用户目录（安装目录无写权限）
const DATA_DIR = UDR.edition !== 'dev' ? app.getPath('userData') : path.join(__dirname, 'data')
const CHARACTER_TRIAL = UDR.ok && UDR.source === 'character-trial' && characterKernelMode() === 'candidate'
const platformStore = require('./platform-store.cjs').createStore(DATA_DIR, { migrate: TEST_EDITION && !CHARACTER_TRIAL,
  readOnly: CHARACTER_TRIAL || characterKernelMode() === 'active' })

/* ===== 长驻角色内核 Host（K2/K8）：默认 mode=off，不改变当前正式行为 =====
   开关：DESKPET_CHARACTER_KERNEL=off|candidate|active（默认 off）。
   candidate 使用隔离目录 <DATA_DIR>/character-candidate，可整目录丢弃回退；
   active 使用 <DATA_DIR>/character，只有用户明确切换后才允许（步骤见
   research-library/topics/long-lived-character/implementation/PROGRESS.md）。
   mode=off 时下列 handler 全部返回 off，不启动子进程、不写任何新文件。 */
function characterKernelMode() {
  return require('./character/config.cjs').readMode(process.env)
}
/* 内核能力授权来自主人许可，不由插件或模型自报。
   本地虚拟动作（改自身状态、写自己的笔记、说话）是既有产品行为的延续；
   操作系统感知与任何外部副作用都必须由 prefs.characterKernel.scopes 明确追加。 */
function characterGrantedScopes() {
  const base = ['character:state:write', 'character:artifact:write', 'presentation:text', 'presentation:animation']
  try {
    const prefs = loadPrefsFile() || {}
    const extra = prefs.characterKernel && Array.isArray(prefs.characterKernel.scopes)
      ? prefs.characterKernel.scopes.filter(scope => typeof scope === 'string' && /^[a-z0-9:_.-]{3,120}$/i.test(scope))
      : []
    return Array.from(new Set([...base, ...extra]))
  } catch (err) { return base }
}
const characterHost = require('./character/host.cjs').createHost({
  dataDir: DATA_DIR,
  isolatedTrial: CHARACTER_TRIAL,
  utilityProcess,
  logger: (...args) => log('[character]', ...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a)))),
  webContentsProvider: () => (win && win.webContents && !win.webContents.isDestroyed() ? [win.webContents] : []),
  handlers: {
    'model.complete': async (params, context) => {
      const result = await callDirectLLM({
        purpose: params && params.purpose ? String(params.purpose).slice(0, 40) : 'character',
        messages: Array.isArray(params && params.messages) ? params.messages.slice(0, 12) : [],
        maxTokens: Number(params && params.maxTokens) || 700,
        temperature: params && params.temperature !== undefined ? params.temperature : 0.4,
        timeoutMs: Number(params && params.timeoutMs) || 45000,
        promptStage: 'character-kernel',
        signal: context.signal,
      })
      if (!result || result.ok !== true) return { ok: false, reason: String(result && result.error || 'model_unavailable').slice(0, 200) }
      return { ok: true, text: String(result.text || result.reply || ''), model: String(result.model || 'unknown') }
    },
    'prompts.snapshot': () => ({ ok: true, value: promptStore.read() }),
    'capability.grants': () => ({ ok: true, scopes: characterGrantedScopes() }),
    'desktop.foreground': async () => {
      if (!characterGrantedScopes().includes('os:foreground')) return { ok: false, reason: 'scope_not_granted' }
      const value = sampleForegroundApp()
      if (!value) return { ok: false, reason: 'sensor_unavailable' }
      return { ok: true, value: { ...value, observedAt: Date.now() } }
    },
    'desktop.media': async () => {
      if (!characterGrantedScopes().includes('os:media')) return { ok: false, reason: 'scope_not_granted' }
      const session = pickMediaSession(smtcSnapshot && smtcSnapshot.sessions)
      if (!session) return { ok: false, reason: 'media_session_unavailable' }
      return { ok: true, value: { title: session.title || '', artist: session.artist || '', observedAt: smtcSnapshot.ts || Date.now() } }
    },
    /* DSH 任务是真实外部副作用：默认不启用。启用条件与核对方式见 PROGRESS.md K5 待执行项。 */
    'dsh.createTask': async (input, context) => {
      if (!characterGrantedScopes().includes('dsh:task:create') || !characterGrantedScopes().includes('external:dispatch')) return { ok: false, reason: 'scope_not_granted', mayHaveApplied: false }
      if (TEST_EDITION && !ISOLATED_TEST) return { ok: false, reason: 'isolated_dsh_required', mayHaveApplied: false }
      let dispatched = false
      try {
        const compat = getDshCompat(), options = { signal: context.signal }
        const created = await compat.sessionCreate({ cwd: input.workspace || WORKSPACE_PATH }, options)
        const taskId = created?.result?.ok && created.result.value?.sessionId
        if (!taskId) return { ok: false, reason: 'dsh_session_create_failed', mayHaveApplied: false }
        // An existing user conversation is never reused for character work.
        dispatched = true
        const accepted = await compat.sessionPrompt({ sessionId: taskId, mode: 'queue', content: [{ type: 'text', text: input.prompt }] }, options)
        return accepted?.result?.ok ? { ok: true, taskId } : { ok: false, reason: 'dsh_dispatch_rejected', mayHaveApplied: false }
      } catch (error) { return { ok: false, reason: String(error.code || error.message).slice(0, 160), mayHaveApplied: dispatched } }
    },
    'dsh.taskStatus': async (input, context) => {
      if (!characterGrantedScopes().includes('dsh:task:create') || (TEST_EDITION && !ISOLATED_TEST)) return { ok: false, reason: 'scope_not_granted' }
      const listed = await getDshCompat().sessionList({ signal: context.signal })
      const session = listed?.result?.ok && listed.result.value?.items?.find(item => item.sessionId === input.taskId)
      return session ? { ok: true, accepted: true, state: session.running ? 'running' : 'idle_completion_unverified' } : { ok: false, reason: 'task_not_found' }
    },
    'presentation.publish': intent => characterHost.publishPresentation(intent),
  },
})
/* 无论 mode 与否都注册 bridge：mode=off 时返回 kernel_off，让 renderer 能明确判断
   而不是收到 “No handler registered”。 */
try { characterHost.registerIpc(ipcMain) } catch (err) { log('[character] registerIpc failed', err && err.message) }
ipcMain.on('character:boot', event => { event.returnValue = { authority: CHARACTER_TRIAL, mode: characterKernelMode() } })
ipcMain.handle('character:perception', (event, enabled) => {
  if (!win || event.sender !== win.webContents || (enabled !== undefined && typeof enabled !== 'boolean')) return { ok: false, reason: 'not_authorized' }
  if (enabled !== undefined) {
    const prefs = loadPrefsFile() || {}, kernel = prefs.characterKernel || {}
    const scopes = (kernel.scopes || []).filter(scope => !['os:foreground','os:media'].includes(scope))
    if (enabled) scopes.push('os:foreground','os:media')
    if (!savePrefsFile({ characterKernel: { ...kernel, scopes } })) return { ok: false, reason: 'preferences_write_failed' }
  }
  return { ok: true, enabled: characterGrantedScopes().includes('os:foreground') }
})
require('./character/legacy-bridge.cjs').installBoundary(ipcMain, {
  owns: () => CHARACTER_TRIAL || characterKernelMode() === 'active',
  route: async (method, event, args) => {
    if (method === 'minesweeper:reward') {
      const input = args[0]
      if (!mineWin || event.sender !== mineWin.webContents || !input?.ok || typeof input.eventId !== 'string' || !['easy','mid','hard'].includes(input.level)) return { ok: false, reason: 'not_authorized' }
      const at = Date.now(), sourceId = String(input.eventId).slice(0,160)
      return characterHost.submit({ commandId: 'observe:' + sourceId, kind: 'world.observation', payload: { observation: { observationId: sourceId, sourceId, kind: 'game.completed', observedAt: at, freshUntil: at + 3600000,
        payload: { actor: 'owner', observer: 'character', subject: 'owner', world: 'virtual', sourceType: 'game.completed', occurredAt: at, game: { gameId: 'mines', won: true, level: input.level, elapsedSeconds: Math.max(1, Number(input.time) || 1) } } } } })
    }
    const cardRead = ['state:load', 'state:read'].includes(method) && cardWin && event.sender === cardWin.webContents
    if ((!win || event.sender !== win.webContents) && !cardRead) return { ok: false, reason: 'not_authorized' }
    if (method === 'characterHistory:load') return (await characterHost.read({ kind: 'history' })).history || []
    if (method === 'diary:timeline') return characterHost.read({ kind: 'diary' })
    if (method === 'state:load' || method === 'state:read') {
      const projection = await characterHost.read({ kind: 'projection' }), body = projection.state
      const state = body ? { ...body.legacyUnmapped, ...body.preferences, ...body.nurture, name: body.displayName || projection.displayName,
        stats: body.needs, relationship: body.relationship, affection: body.relationship?.affection } : null
      return method === 'state:load' ? state : { ok: !!state, state, status: state ? 'ok' : 'kernel_unavailable' }
    }
    if (method === 'memory:load') return characterHost.read({ kind: 'memory' })
    if (method === 'platform:forget') return characterHost.submit({ kind: 'owner.forget', payload: { sourceIds: args[0] } })
    if (method === 'proactive:setEnabled') return characterHost.submit({ kind: 'system.pause', payload: { paused: !args[0] } })
    if (method === 'proactive:getEnabled') return { enabled: !(await characterHost.read()).paused }
    if (method === 'platform:info') return { ok: true, enabled: false, authority: 'kernel' }
    if (method === 'platform:capabilities') return characterHost.read({ kind: 'capabilities' })
    if (method === 'platform:capabilityInvoke') {
      const input = args[0] || {}
      return characterHost.submit({ commandId: String(input.requestId || ''), kind: 'capability.invoke',
        payload: { capabilityId: input.capabilityId, input: input.input, sourceRefs: input.sourceRefs || [] } })
    }
    if (method === 'clean:run') return { ok: false, error: '角色接管模式下已停用旧系统清理入口。外部任务须通过已授权的能力执行。' }
    if (method === 'platform:projection') return characterHost.read()
    if (method === 'platform:operation') return (await characterHost.read({ kind: 'operations' })).operations?.find(item => item.operationId === args[0]) || null
    if (method.startsWith('platform:package')) {
      const action = method.slice('platform:package'.length).toLowerCase()
      return characterHost.submit({ kind: 'package.manage', payload: action === 'install' ? { action, folder: args[0], trusted: true } : { action, id: args[0] } })
    }
    if (method === 'lifeContext:getEnabled' || method === 'diary:enabled') return { enabled: false, authority: 'kernel' }
    return { ok: false, reason: 'kernel_authority', method }
  },
})
/* 旧 IPC → 内核的唯一权威切换点（K8）。off 时完全不介入。 */
const characterBridge = require('./character/legacy-bridge.cjs').createBridge({
  host: characterHost,
  mode: characterKernelMode(),
  logger: (...args) => log('[character-bridge]', ...args.map(a => (typeof a === 'string' ? a : JSON.stringify(a)))),
})
const platformDomain = require('./platform-domain.cjs').createDomain(platformStore)
ipcMain.handle('platform:capabilityInvoke', () => ({ ok: false, reason: 'kernel_authority_required' }))
function platformResult(fn) { try { return fn() } catch (e) { return { ok: false, reason: e.message } } }
ipcMain.handle('platform:info', () => platformResult(() => ({ ok: true, enabled: TEST_EDITION, health: platformStore.health(), policy: platformStore.snapshot().policy })))
ipcMain.handle('platform:factBegin', (_e, input) => platformResult(() => platformStore.beginFact(input)))
ipcMain.handle('platform:extraction', (_e, ref, result) => platformResult(() => platformStore.extraction(ref, result)))
ipcMain.handle('platform:recover', async () => {
  try {
    const result = platformStore.recoverOperations(), state = platformStore.snapshot()
    const life = await petLifeStore.load()
    if (!life || !life.ok) throw Error(life && life.error || 'life_recovery_failed')
    const missing = Object.values(state.operations).filter(op => op.type === 'fact' && op.status === 'completed' && op.input && !op.obligations.domainApplied)
    for (const op of missing.slice(0, 8)) {
      platformDomain.observeFact(op.sourceRefs[0]); platformDomain.reconcileLife(life.state, op.sourceRefs[0]); platformStore.advanceFact(op.sourceRefs[0], 'domainApplied')
    }
    return { ...result, domainBacklog: Math.max(0, missing.length - 8) }
  } catch (e) { return { ok: false, reason: e.message } }
})
ipcMain.handle('platform:export', () => TEST_EDITION ? platformResult(() => platformStore.backup()) : { ok: false, reason: 'candidate_test_edition_required' })
ipcMain.handle('platform:restore', (_e, backup) => TEST_EDITION ? platformResult(() => platformStore.restore(backup)) : { ok: false, reason: 'candidate_test_edition_required' })
ipcMain.handle('platform:factState', (_e, ref) => platformResult(() => platformStore.operation('fact:' + ref)))
ipcMain.handle('platform:factAdvance', async (_e, ref, step, detail) => {
  try {
    const result = platformStore.advanceFact(ref, step, detail)
    if (step === 'memoryPersisted') {
      platformDomain.observeFact(ref)
      const life = await petLifeStore.load()
      if (!life || !life.ok) throw Error(life && life.error || 'life_reconciliation_failed')
      platformDomain.reconcileLife(life.state, ref)
      platformStore.advanceFact(ref, 'domainApplied')
    }
    return result
  } catch (e) { return { ok: false, reason: e.message } }
})
ipcMain.handle('platform:pendingFacts', () => platformResult(() => platformStore.pendingFacts()))
ipcMain.handle('platform:forget', (event, refs) => {
  const guarded = characterBridge.guard('platform:forget')
  if (guarded) return guarded
  const selected = Array.isArray(refs) ? refs.slice(0, 240) : []
  const result = platformResult(() => platformStore.forget(selected))
  if (result && result.ok) event.sender.send('characterPlatform:invalidated', { refs: selected })
  return result
})
ipcMain.handle('platform:operationBegin', (_e, proposal) => platformResult(() => platformStore.beginOperation(proposal)))
ipcMain.handle('platform:operationUpdate', (_e, id, status, receipt) => platformResult(() => platformStore.updateOperation(id, status, receipt)))
ipcMain.handle('platform:operation', (_e, id) => platformResult(() => platformStore.operation(id)))
ipcMain.handle('platform:projection', () => platformResult(() => platformDomain.projection()))
ipcMain.handle('platform:select', (_e, candidates, policy) => platformResult(() => platformDomain.select(candidates, policy)))
ipcMain.handle('platform:presented', (_e, id) => platformResult(() => platformDomain.presented(id)))
ipcMain.handle('platform:projectStep', async (_e, id, operationId) => {
  if (!TEST_EDITION) return { ok: false, reason: 'candidate_test_edition_required' }
  const parent = platformStore.operation(operationId)
  if (!parent || parent.status !== 'dispatched' || parent.capabilityId !== 'life.virtual-project') return { ok: false, reason: 'project_authorization' }
  const authority = {}; candidateAuthorities.add(authority)
  const result = await desktopCapabilities.execute({ id: 'delegated:' + operationId, capabilityId: 'life.virtual-project', effect: 'virtual', input: { projectId: id }, sourceRefs: parent.sourceRefs, deadline: Date.now() + 30000 }, authority)
  candidateAuthorities.delete(authority)
  return result && result.ok ? { ok: true, value: result.receipt.value } : result
})
ipcMain.handle('platform:delivery', (_e, row) => platformResult(() => platformStore.transaction(s => {
  s.diagnostics.push({ type: 'presentation', owner: String(row.owner || '').slice(0, 180), channel: row.channel, phase: row.phase,
    semanticId: row.semanticId || null, at: row.at, token: row.token })
  return { ok: true }
}, 'presentation_receipt')))
const promptStore = require('./prompt-store.cjs').createPromptStore(DATA_DIR)
try { if (!fs.existsSync(path.join(promptStore.dir, 'current.json'))) promptStore.save(promptStore.defaults()) } catch (e) { console.warn('[prompts]', e.message) }
ipcMain.on('prompts:snapshot', event => { event.returnValue = promptStore.read() })
const STATE_FILE = path.join(DATA_DIR, 'pet-state.json')
const PERSONA_FILE = path.join(DATA_DIR, 'persona.json')
const CHARACTER_HISTORY_FILE = path.join(DATA_DIR, 'character-chat-history.json')
const MEMORY_FILE = path.join(DATA_DIR, 'memories.json')
const MEMORY_BACKUP = path.join(DATA_DIR, 'memories.backup.json')
const STATE_BACKUP = path.join(DATA_DIR, 'pet-state.backup.json')
const nurtureStateStore = createStateStore(DATA_DIR)
const WIN_STATE_FILE = path.join(DATA_DIR, 'win-state.json')
const LOG_FILE = path.join(DATA_DIR, 'pet.log')
const SELFTEST_FLAG = path.join(DATA_DIR, 'selftest.flag')
const KOFFI_ENABLED = !fs.existsSync(SELFTEST_FLAG)

// 纯净版（无更新/无远程桥/无诊断包）：打包时在 resources/ 附带 clean-edition.json 即开启。
// 日常版/测试版不带此文件 → 三项功能全保留，零影响。
const CLEAN_EDITION = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'clean-edition.json'))
// 纯本机日记系统（事件采集+聚合+时间线）：独立开关 daily-collector.json（与纯净版解耦，
// 便于测试版单独验证日记功能而保留更新/远程/诊断；日常版不带此文件则完全关闭）
const DIARY_COLLECTOR = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'daily-collector.json'))
// 日记运行时开关（设置面板可开/关；默认 = 构建标记，持久化到 diary-settings.json）
const DIARY_SETTINGS_FILE = path.join(DATA_DIR, 'diary-settings.json')
let diaryEnabledCache = null
function isDiaryEnabled() {
  if (diaryEnabledCache === null) {
    try {
      const st = JSON.parse(fs.readFileSync(DIARY_SETTINGS_FILE, 'utf8'))
      diaryEnabledCache = st && typeof st.enabled === 'boolean' ? st.enabled : DIARY_COLLECTOR
    } catch (err) {
      diaryEnabledCache = DIARY_COLLECTOR
    }
  }
  return diaryEnabledCache
}
function saveDiaryEnabled(v) {
  diaryEnabledCache = !!v
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(DIARY_SETTINGS_FILE, JSON.stringify({ enabled: diaryEnabledCache }))
  } catch (err) {
    /* CC-3 / P0：**不许伪造成功** —— 原为静默忽略写失败，
       导致「开关本次会话开着、重启后丢失且无提示」。现改为：如实返回 false ＋ 留一条日志。 */
    try { log('diary settings save failed', err && err.message) } catch (e2) { /* 日志失败不改变返回值 */ }
    return false
  }
  return true
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 已有实例在运行：立即退出，避免整段 main.js 再次执行（闪窗/抢端口/抢日志）
  app.quit()
  process.exit(0)
} else {
  // 用户再次双击图标时，把已有窗口叫到前台
  app.on('second-instance', () => {
    try {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    } catch (err) { /* ignore */ }
  })
}

const MODES = {
  pet: [220, 380],
  chat: [430, 640],
  mini: [64, 64],
}

/* ---------- crash-proof logging ---------- */

let consoleBroken = false

process.stdout.on('error', () => { consoleBroken = true })
process.stderr.on('error', () => { consoleBroken = true })

function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map((a) => {
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch (err) { return String(a) }
  }).join(' ')
  if (!consoleBroken) {
    try { console.log(line) } catch (err) { consoleBroken = true }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const fsPromises = require('fs/promises')
    fsPromises.appendFile(LOG_FILE, line + '\n').catch(() => {})
  } catch (err) { /* never crash because of logging */ }
}

process.on('uncaughtException', (err) => {
  log('uncaughtException', (err && err.stack) || String(err))
})

/* ---------- window / display helpers ---------- */

let win = null
let mode = 'pet'
let drag = null
let dragTimer = null

let unionCache = null
let unionCacheTime = 0

function unionWorkArea() {
  const now = Date.now()
  if (unionCache && now - unionCacheTime < 1000) return unionCache
  let u = null
  screen.getAllDisplays().forEach((d) => {
    const wa = d.workArea
    if (!u) {
      u = { x: wa.x, y: wa.y, r: wa.x + wa.width, b: wa.y + wa.height }
    } else {
      u.x = Math.min(u.x, wa.x)
      u.y = Math.min(u.y, wa.y)
      u.r = Math.max(u.r, wa.x + wa.width)
      u.b = Math.max(u.b, wa.y + wa.height)
    }
  })
  const result = { x: u.x, y: u.y, width: u.r - u.x, height: u.b - u.y }
  unionCache = result
  unionCacheTime = now
  return result
}

function clampPos(x, y, w, h) {
  if (!Number.isFinite(x)) x = 0
  if (!Number.isFinite(y)) y = 0
  const u = unionWorkArea()
  const MARGIN = 40
  return {
    x: Math.min(Math.max(x, u.x - w + MARGIN), u.x + u.width - MARGIN),
    y: Math.min(Math.max(y, u.y - h + MARGIN), u.y + u.height - MARGIN),
  }
}

function setMode(m, anchor) {
  if (!MODES[m] || !win) return
  log('setMode ->', m, anchor || '')
  const old = win.getBounds()
  const [curW, curH] = MODES[mode]
  const [w, h] = MODES[m]
  mode = m
  let nx, ny
  if (anchor === 'left') {
    // 锚定左下角（窗口底部+左缘不变）：窗口向右上扩展。
    // 人物贴底(left:0,bottom:36) → 屏幕位置保持不变；气泡在头顶上方有空间。
    nx = old.x
    ny = old.y - (h - curH)
  } else {
    // 默认锚定右下角（历史行为）
    nx = old.x + curW - w
    ny = old.y + curH - h
  }
  const p = clampPos(nx, ny, w, h)
  win.setBounds({ x: p.x, y: p.y, width: w, height: h })
  saveWinState()
}

/* ---------- position persistence ---------- */

function loadWinState() {
  try {
    if (fs.existsSync(WIN_STATE_FILE)) {
      let raw = fs.readFileSync(WIN_STATE_FILE, 'utf8')
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1) // 容错带 BOM 的文件
      return JSON.parse(raw)
    }
  } catch (err) {
    log('win-state load error', err && err.message)
  }
  return null
}

function saveWinState() {
  try {
    if (!win) return
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const [x, y] = win.getPosition()
    // 统一存「小深模式」下的位置锚点：右下角不变，把任意模式的左上角换算回 pet 尺寸
    const [curW, curH] = MODES[mode] || MODES.pet
    const [pw, ph] = MODES.pet
    fs.writeFileSync(WIN_STATE_FILE + '.tmp', JSON.stringify({ x: x + curW - pw, y: y + curH - ph }))
    fs.renameSync(WIN_STATE_FILE + '.tmp', WIN_STATE_FILE)
  } catch (err) {
    log('win-state save error', err && err.message)
  }
}

/* ---------- DSH Compatibility Layer ---------- */

/* DSH RPC allowlist（Phase 12）：DSHClient 白名单语义通道 */
let pendingDshRequests = 0

const DSH_METHOD_ALLOWLIST = new Set([
  'session.list', 'session.create', 'session.rename', 'session.archive', 'session.history',
  'session.prompt', 'session.models', 'session.selectModel',
  'workspace.list', 'workspace.archiveSession',
  'agentPreset.list', 'agentPreset.select',
  /* 权限：DSH 没有"选权限"的 RPC —— 选项清单走 catalog，
     改档位走 commands/execute 执行 host 命令 `/permission <preset>`。 */
  'permissionPresets.catalog', 'commands.execute'
])

let dshCompat = null
function getDshCompat() {
  if (!dshCompat) {
    dshCompat = createDshCompat({
      baseUrl: BASE,
      dshStartLogPath: (process.env.DSH_START_LOG && String(process.env.DSH_START_LOG).trim()) || path.join(app.getPath('userData'), 'dsh-start.log'),
      mode: (process.env.DSH_PROTOCOL || 'auto'),
      log,
    })
    /* 必修 1/2：compat 的停止/重启必须使用本应用的强身份判定（唯一 kill 入口） */
    dshCompat.setOwnershipVerifier(async (port) => {
      const cls = await classifyDshPort(port, { cache: false })
      return {
        ok: cls.state === 'owned',
        state: cls.state,
        owned: cls.ownedPids,
        unsafe: cls.unsafePids,
        reasons: cls.reasons,
      }
    })
  }
  return dshCompat
}

async function api(method, payload, timeoutMs) {
  pendingDshRequests++
  const timeout = timeoutMs || 8000
  // P2-8：外层 race 到点后必须真正取消在途请求（AbortController），
  // 否则 compat 层的 socket 会一直挂到它自己的预算用完才释放。
  const ctl = new AbortController()
  try {
    const p = getDshCompat().api(method, payload, { signal: ctl.signal })
    if (!timeout || timeout <= 0) return await p
    let timer
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { ctl.abort() } catch (e) { /* ignore */ }
          reject(new Error('DSH timeout: ' + method))
        }, timeout)
      }),
    ]).finally(() => { if (timer) clearTimeout(timer) })
  } finally {
    pendingDshRequests--
  }
}

// 回答 DSH 推送的交互（授权 / 提问）。Compatibility Layer 负责把旧
// /api/respond 或新 /api/$events/result 都转换成统一逻辑。
async function apiRespond(payload) {
  return getDshCompat().respond(payload)
}

/* ---------- DSH 下行流（WebSocket）：授权/提问交互转发给渲染层 ---------- */

let dshSocket = null
let dshReconnectTimer = null
let dshStreamGeneration = 0
let dshStopped = false
let dshStreamErrLast = null // A10 降噪：最近一次下行流错误串（null＝无未决错误）
let dshStreamErrRuns = 0 // A10 降噪：该错误串连续出现次数

async function startStream() {
  if (dshStopped) return
  if (dshSocket) return // active socket 单活
  const gen = ++dshStreamGeneration
  const compat = getDshCompat()
  try {
    const sock = await compat.connectEvents((frame) => {
      if (gen !== dshStreamGeneration || dshStopped) return
      if (!frame) return
      const env = frame
      const f = env && env.payload
      /* R1：先把待批准/待回答事项缓存到**主进程**，再考虑转发给渲染层 ——
         桌宠窗口不在时，手机端仍能只读看到"有东西在等你批准"（但批准只能回电脑做）。 */
      if (typeof remoteNotePending === 'function') remoteNotePending(env)
      if (env && env.type === 'server-request' && f && (
        f.type === 'approval/requested' || f.type === 'approval/resolved' ||
        f.type === 'question/requested' || f.type === 'question/resolved'
      )) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('pet-stream', { rpcId: env.rpcId, payload: f })
        }
      }
    })
    if (gen !== dshStreamGeneration || dshStopped) { try { sock.close() } catch (e) {} return }
    dshSocket = sock
    log('dsu stream connected (mode=' + (compat.mode || 'auto') + ')')
    if (dshStreamErrLast !== null) {
      // A10 降噪：恢复连接时汇总被压住的重复错误，然后复位
      if (dshStreamErrRuns > 1) log('dsu stream recovered; suppressed repeats:', dshStreamErrLast, '×' + dshStreamErrRuns)
      dshStreamErrLast = null
      dshStreamErrRuns = 0
    }
    sock.on('close', () => {
      if (dshSocket === sock) dshSocket = null
      log('dsu stream closed, reconnecting in 5s')
      if (!dshStopped) scheduleDshReconnect()
    })
  } catch (err) {
    if (gen !== dshStreamGeneration || dshStopped) return
    // Protocol incompatibility is NOT "process death": do not infinite-restart DSH.
    /* A10 降噪：重连每 5s 一次，同一错误（如 "DSH protocol not available"）
       曾在 pet.log 刷 1 万+行。按错误串去重：同串连续出现只计数；串变化先补一条被压总量；
       连接恢复时在 connected 分支汇总复位。首现行与门禁行保留，监控口径不变。 */
    const msg = (err && err.message) || String(err)
    if (msg === dshStreamErrLast) {
      dshStreamErrRuns++
    } else {
      if (dshStreamErrLast !== null) log('dsu stream error (suppressed)', dshStreamErrLast, '×' + dshStreamErrRuns)
      dshStreamErrLast = msg
      dshStreamErrRuns = 1
      log('dsu stream error', msg)
      log('dsu compatibility gate', JSON.stringify(await getDshCompat().compatibilityGate()))
    }
    scheduleDshReconnect()
  }
}

function scheduleDshReconnect() {
  if (dshStopped) return // 显式 shutdown 后不得再排重连
  if (dshReconnectTimer) return // 只允许一个 reconnect timer
  dshReconnectTimer = setTimeout(() => {
    dshReconnectTimer = null
    startStream()
  }, 5000)
}

function stopDshStream() {
  dshStopped = true // 必须先置停止标志：socket close 是异步的，close 回调不得再 schedule
  if (dshReconnectTimer) { clearTimeout(dshReconnectTimer); dshReconnectTimer = null }
  if (dshSocket) { try { dshSocket.close() } catch (err) { /* ignore */ } dshSocket = null }
  try { if (dshCompat) dshCompat.stop() } catch (err) { /* ignore */ }
  dshStreamGeneration++
}

/* ---------- P4-P1/P4-P2：官方 Desktop 接入（探测 + 认证注入；**不自拉实例**） ---------- */
let officialHarnessState = { lastAttach: null, lastAttachFail: null, readyProbe: null, watchTicks: 0 }
const officialHarnessRetry = require('./renderer/life-context/retry-backoff.js').createBackoff()
let harnessWatchTimer = null
let harnessAttachJob = null
const HARNESS_WATCH_MS = 30000

function harnessUserStopped() {
  // Clean has no service lifecycle/update manager and cannot set a stop flag.
  return typeof getUpdateManager === 'function' && getUpdateManager().dshUserStopped() === true
}

/** 把上层 dsh-compat 指向官方 Desktop 的 Host，并注入自签 cookie。
 *  dsh-compat 本来就是 cookie 认证、本来就走 `/api/remote.mux` ⇒ 这里只改两个字段，
 *  协议 / 会话 / 事件 / 汇报卡那一整条链一行都不用动。
 *  用户口径＝「桌面端启动或存在时就接入，不自己拉起 3080」⇒ 探测不到或取不到密钥时
 *  只返回结构化原因并落日志，**绝不起 3080**。
 * G1：早退/失败路径过去不落日志 ⇒ pet.log 里"没跑"和"跑了被拒"长得一样。 */
function attachOfficialHarness(reason) {
  if (harnessAttachJob) return harnessAttachJob
  harnessAttachJob = performHarnessAttach(reason).finally(() => { harnessAttachJob = null })
  return harnessAttachJob
}

async function performHarnessAttach(reason) {
  if (reason === 'manual') officialHarnessRetry.reset()
  if (reason === 'watch' && !officialHarnessRetry.canTry(Date.now())) return { ok: false, error: 'retry_cooldown' }
  const fb = dshConnectionForbidden()
  if (fb) {
    log('official harness attach skipped', JSON.stringify({ reason, skipped: 'edition_forbidden', edition: fb.edition }))
    return { ok: false, error: 'edition_forbidden' }
  }
  if (harnessUserStopped()) {
    /* 必修 8 语义原样保留：用户显式停止过 ⇒ 自动路径不再接入（手动「重新检测并接入」会清掉该标记） */
    log('official harness attach skipped', JSON.stringify({ reason, skipped: 'user_stopped' }))
    return { ok: false, error: 'user_stopped' }
  }
  try {
    const r = await officialHarness().attach({ dshHome: DSH_HOME_DIR, log })
    if (!r || !r.ok) {
      officialHarnessRetry.fail(Date.now())
      officialHarnessState.lastAttachFail = { at: Date.now(), reason, why: (r && r.reason) || 'no_result', probe: (r && r.probe) || null }
      log('official harness attach failed', JSON.stringify({ reason, why: r && r.reason, probe: r && r.probe, error: r && r.error }))
      return r || { ok: false, error: 'no_result' }
    }
    // Invalidate old/pending streams before rotating endpoint or credentials.
    stopDshStream()
    const c = getDshCompat()
    /* 顺序很重要：onDshStarted() 会把 authCookie 清成 null 并清 mode/探测缓存（它是给"自拉"流程
       设计的）⇒ **必须先清缓存，再注入 baseUrl 与 cookie**，否则刚签好的 cookie 会被自己擦掉
       （2026-09-30 首轮上机实测：attach 成功但 gate 恒 unusable，根因即此）。 */
    try { c.onDshStarted() } catch (e) { /* ignore */ }
    c.baseUrl = r.baseUrl
    c.authCookie = r.cookie
    const gate = await c.compatibilityGate()
    dshStopped = false
    if (!gate.usable) {
      officialHarnessRetry.fail(Date.now())
      officialHarnessState.lastAttachFail = { at: Date.now(), reason, why: 'protocol_unavailable', probe: r.probe }
      scheduleDshReconnect()
      return { ok: false, reason: 'protocol_unavailable' }
    }
    officialHarnessState.lastAttach = { at: Date.now(), reason, baseUrl: r.baseUrl, expiresAt: r.expiresAt, probe: r.probe }
    officialHarnessState.lastAttachFail = null
    officialHarnessRetry.reset()
    log('official harness attached', JSON.stringify({ reason, baseUrl: r.baseUrl, expiresAt: r.expiresAt }))
    if (win && !win.isDestroyed()) win.webContents.send('harness:changed')
    try { startStream() } catch (e) { /* ignore */ }
    setTimeout(probeOfficialHarnessReady, 1500)
    // Auth cookies stay in the main process; IPC callers receive status only.
    return { ok: true, baseUrl: r.baseUrl, expiresAt: r.expiresAt }
  } catch (e) {
    officialHarnessRetry.fail(Date.now())
    log('official harness attach threw', e && e.message)
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 后台轮询：Desktop 起/停/换密钥都跟着变。已连上就什么都不做
 *  （省掉每拍重读密钥与重签；cookie 在 Desktop 重启后依然有效，因为密钥是持久的）。 */
async function harnessWatchTick() {
  try {
    officialHarnessState.watchTicks++
    if (dshConnectionForbidden()) return
    if (!officialHarnessRetry.canTry(Date.now())) return
    const gate = await getDshCompat().compatibilityGate()
    if (gate && gate.usable) { officialHarnessRetry.reset(); return }
    await attachOfficialHarness('watch')
  } catch (e) { officialHarnessRetry.fail(Date.now()) /* 轮询失败绝不影响桌宠其他功能 */ }
}

function startHarnessWatch() {
  if (harnessWatchTimer) return
  harnessWatchTimer = setInterval(() => { harnessWatchTick() }, HARNESS_WATCH_MS)
  try { if (harnessWatchTimer.unref) harnessWatchTimer.unref() } catch (e) { /* ignore */ }
  log('official harness watch started', JSON.stringify({ everyMs: HARNESS_WATCH_MS }))
}

async function probeOfficialHarnessReady() {
  try {
    const gate = await getDshCompat().compatibilityGate()
    officialHarnessState.readyProbe = { at: Date.now(), usable: !!(gate && gate.usable), mode: gate && gate.mode }
    log('official harness readiness probe', JSON.stringify(officialHarnessState.readyProbe))
  } catch (e) { log('official harness readiness probe err', e && e.message) }
}

/* ---------- window ---------- */

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea
  const [w, h] = MODES.pet
  const saved = loadWinState()
  const p = clampPos(
    saved && Number.isFinite(saved.x) ? saved.x : wa.x + wa.width - w - 24,
    saved && Number.isFinite(saved.y) ? saved.y : wa.y + wa.height - h - 24,
    w,
    h,
  )
  win = new BrowserWindow({
    show: !TEST_EDITION || !app.commandLine.hasSwitch('platform-test-hidden'),
    width: w,
    height: h,
    x: p.x,
    y: p.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    title: 'deskpet',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)
  // 透明窗口默认点击穿透。
  // 不再用 `{ forward: true }` 把桌面鼠标移动转发进渲染进程（那会造成
  // 每秒上千次转发 + 逐事件 DOM 判定 ⇒ 鼠标/前台窗口顿挫）；改由主进程 60ms 轮询光标、
  // 经 `pet:mousePos` 推"窗口内相对坐标"给渲染层做命中判定（见下方鼠标位置守卫）。
  // 渲染层仍通过 pet:setClickThrough 在「可交互区」临时关闭穿透。
  try {
    win.setIgnoreMouseEvents(true, { forward: false })
  } catch (err) { /* 老版本 API 无 forward，忽略 */ }
  win.webContents.on('console-message', (_e, level, message) => {
    log('[renderer:' + level + ']', message)
  })

  let lastInputLog = 0
  win.webContents.on('before-input-event', (_event, input) => {
    const now = Date.now()
    if (now - lastInputLog > 1000) {
      lastInputLog = now
      log('input-event', input.type, input.key || '', input.button || '')
    }
  })

  win.on('blur', () => {
    saveWinState()
    drag = null
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  log('window created at', p.x, p.y)
}

/* ---------- 系统托盘 ---------- */

let tray = null

function trayIconPath() {
  const cand = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'build', 'icon.ico')
  return fs.existsSync(cand) ? cand : null
}

function createTray() {
  try {
    const ico = trayIconPath()
    if (!ico) { log('tray icon missing, skip tray'); return }
    const img = nativeImage.createFromPath(ico)
    tray = new Tray(img.resize({ width: 16, height: 16 }))
    tray.setToolTip('桌宠小深')
    // 托盘命令发给渲染层处理（状态在渲染层）；退出由主进程直接执行
    const send = (cmd, value) => {
      try {
        if (win && !win.isDestroyed()) win.webContents.send('tray:command', { cmd, value })
      } catch (err) { /* ignore */ }
    }
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏 桌宠', click: () => send('toggle-mini') },
      { type: 'separator' },
      { label: '按钮大小', submenu: [
        { label: '标准', click: () => send('ui-scale', 1) },
        { label: '大', click: () => send('ui-scale', 1.15) },
        { label: '特大', click: () => send('ui-scale', 1.3) },
        { label: '小', click: () => send('ui-scale', 0.9) },
      ] },
      { label: '桌宠大小', submenu: [
        { label: '小', click: () => send('pet-scale', 0.75) },
        { label: '标准', click: () => send('pet-scale', 1) },
        { label: '大', click: () => send('pet-scale', 1.25) },
      ] },
      { type: 'separator' },
      { label: '声音：开关提示音', click: () => send('toggle-sound') },
      { type: 'separator' },
      { label: '📷 相册', click: () => openAlbum() },
      { label: '🏆 成就', click: () => openAchievements() },
      { label: '💌 生日贺卡', click: () => openBirthdayCard() },
      { label: '🎤 台词池设置', click: () => send('line-settings') },
      { type: 'separator' },
      { label: '退出桌宠', click: () => app.quit() },
    ]))
    tray.on('click', () => {
      try {
        if (win && !win.isDestroyed()) { win.show(); win.focus() }
      } catch (err) { /* ignore */ }
    })
    log('system tray ready')
  } catch (err) {
    log('tray create failed', err && err.message)
  }
}

app.whenReady().then(() => {
  createWindow()
  /* P1-A.1 test edition：S2/S3 硬关（不写 ~/.dsh、不连 3080、不占 8787、不触网） */
  /* P1-K.2.5：完整隔离（test userData + TEST_DSH_HOME + TEST_DSH_PORT）时按生产语义启用凭据兼容与事件流，
     使 verifyActive 的 protocolUsable 能被真实确认；非隔离测试版仍然硬关（不写 ~/.dsh / 不连 3080）。 */
  if (!dshConnectionForbidden()) {
    // 官方 Desktop 管理共享凭据格式；启动联动只读接入，不替旧 CLI 重写其凭据。
    // Establish discovery/authentication before opening the event stream.
    /* P4-P2：官方 Harness 接入 —— **只接入，不自拉实例**（用户口径）。
       开机先附一次；失败不影响桌宠其他功能；Desktop 起/停由下面的 30s 轮询跟随。 */
    attachOfficialHarness('boot')
    startHarnessWatch()
  } else {
    log('test edition (非隔离): DSH credential-compat & event-stream are disabled')
  }
  /* CLEAN-STRIP:LINES-START */
  if (!CLEAN_EDITION && !TEST_EDITION) {
    initAutoUpdater()
    setTimeout(checkForUpdatesAuto, 6000)
  }
  /* CLEAN-STRIP:LINES-END */
  // 纯本机日记系统（事件采集+聚合+时间线）：默认按构建标记，设置面板可开/关
  if (isDiaryEnabled()) {
    startDailyCollector()
  }
  ipcMain.handle('diary:enabled', () => ({ enabled: isDiaryEnabled() }))
  ipcMain.handle('diary:setEnabled', (_e, v) => {
    /* CC-3 / P0：回执如实（承 CC-2 同款纪律）。写盘失败时 ok=false，但**本次会话内的开关状态照旧生效**
       （保持原语义：内存 cache 先改），只是不再向渲染层谎报"已保存"。 */
    const savedOk = saveDiaryEnabled(!!v)
    if (isDiaryEnabled()) startDailyCollector()
    else stopDailyCollector()
    log('diary enabled set:', isDiaryEnabled())
    return { ok: savedOk === true, enabled: isDiaryEnabled() }
  })
  createTray()
  // 鼠标位置守卫：
  // 原来靠 `setIgnoreMouseEvents(true, { forward: true })` 把桌面鼠标移动转发给渲染层做命中判定，
  // 高刷屏 + 高回报率鼠标下每秒上千次转发与逐事件 DOM 判定，实机表现为"鼠标/前台窗口偶发顿挫、
  // 而底层动态壁纸不受影响"。现在改为**主进程按 60ms 轮询光标**，把"窗口内相对坐标"推给渲染层
  // （通道 `pet:mousePos`），于是可以安全关掉 forward（见上面 setIgnoreMouseEvents 调用）——
  // 交互保留，转发洪泛消失。顺带把原来"仅通知移出窗口"的 400ms 守卫升级为同一条轮询。
  setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return
      const b = win.getBounds()
      const c = screen.getCursorScreenPoint()
      const rx = c.x - b.x
      const ry = c.y - b.y
      const inside = rx >= 0 && rx < b.width && ry >= 0 && ry < b.height
      if (inside) {
        // 相对坐标 = 屏幕坐标 - 窗口左上角；与旧 mousemove 的 clientX/clientY 同一坐标系
        win.webContents.send('pet:mousePos', rx, ry)
      } else {
        win.webContents.send('pet:mouseOutside')
      }
    } catch (err) { /* ignore */ }
  }, 60)
  log('displays', screen.getAllDisplays().map((d) => ({
    x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height,
    scale: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id,
  })))
  log('desktop union', unionWorkArea())
  // 开发模式热重载：renderer 文件变化自动刷新窗口（改 UI 即时生效，免 kill/重启）
  if (!app.isPackaged) {
    try {
      if (!CHARACTER_TRIAL) fs.watch(path.join(__dirname, 'renderer'), { recursive: true }, (_ev, f) => {
        if (!win || win.isDestroyed()) return
        if (f && /\.(js|css|html)$/.test(String(f))) {
          log('dev hot-reload:', f)
          win.webContents.reload()
        }
      })
    } catch (err) { log('dev watch failed', err && err.message) }
  }
})

app.on('window-all-closed', () => app.quit())

let memoryFlushDone = false
app.on('before-quit', (event) => {
  saveWinState()
  stopSmtcHelper() // H0：常驻 helper 随主进程退出
  try {
    const st = loadStateFile() || {}
    st.lastExitTime = Date.now()
    saveStateFile(st)
  } catch (err) { log('before-quit lastExitTime save err', err && err.message) }
  if (memoryFlushDone) return
  if (!win || win.isDestroyed()) {
    event.preventDefault()
    characterHost.stop().finally(() => { memoryFlushDone = true; app.quit() })
    return
  }
  event.preventDefault()
  let finished = false
  const finish = async () => {
    if (finished) return
    finished = true
    await characterHost.stop()
    memoryFlushDone = true
    app.quit()
  }
  setTimeout(finish, 3000)
  ipcMain.once('app:before-quit-flush-done', finish)
  try {
    win.webContents.send('app:before-quit-flush')
  } catch (err) {
    finish()
  }
})

/* ---------- IPC ---------- */

ipcMain.handle('api', (_e, method, payload) => api(method, payload))
ipcMain.handle('dsh:call', (_e, method, payload) => {
  if (!DSH_METHOD_ALLOWLIST.has(String(method || ''))) {
    throw new Error('DSH method not allowed: ' + String(method))
  }
  return api(method, payload)
})

// DSH Compatibility Layer diagnostics / explicit test hooks.
ipcMain.handle('dshCompat:probe', async () => {
  const c = getDshCompat()
  return await c.probe()
})
ipcMain.handle('dshCompat:gate', async () => {
  const c = getDshCompat()
  return await c.compatibilityGate()
})
ipcMain.handle('dshCompat:setMode', async (_e, mode) => {
  if (mode !== 'old' && mode !== 'new' && mode !== 'auto') throw new Error('invalid dsh protocol mode')
  process.env.DSH_PROTOCOL = mode || 'auto'
  getDshCompat().forceMode = mode || 'auto'
  getDshCompat().onDshStarted()
  return { ok: true, mode: mode || 'auto' }
})
ipcMain.handle('dshCompat:sessionList', async () => getDshCompat().sessionList())
ipcMain.handle('dshCompat:sessionHistory', async (_e, p) => getDshCompat().sessionHistory(p))
ipcMain.handle('dshCompat:sessionPrompt', async (_e, p) => getDshCompat().sessionPrompt(p))
ipcMain.handle('dshCompat:workspaceList', async () => getDshCompat().workspaceList())
ipcMain.handle('dshCompat:models', async () => getDshCompat().sessionModels({}))
ipcMain.handle('dshCompat:agentPresets', async () => getDshCompat().agentPresets({}))


ipcMain.handle('diag:simulateDaily', (_e, nowTs) => simulateDailyDay({ date: '2000-01-01', segments: [{ app: 'old' }], events: [{ kind: 'old' }] }, Number(nowTs) || Date.now()))

ipcMain.handle('diag:runtime', () => ({
    dshSocket: !!dshSocket,
    dshReconnectTimer: !!dshReconnectTimer,
    socketCount: dshSocket ? 1 : 0,
    reconnectTimerCount: dshReconnectTimer ? 1 : 0,
    pendingDshRequests
  }))

/* P4-P1：官方 Desktop 检测（只读）+ 桌宠自持实例状态 + 共享任务感知。
   三段各自 try/catch：任一检测失败只影响对应字段，绝不影响桌宠其他功能。 */
ipcMain.handle('harness:status', async () => {
  const out = { official: null, harness: null, work: null, error: null }
  try {
    const fb = dshConnectionForbidden()
    out.official = fb
      ? { unavailable: true, edition: fb.edition }
      : await officialHarness().statusAsync({ dshHome: DSH_HOME_DIR, pidFile: path.join(app.getPath('userData'), 'official-harness.pid'), log })
  } catch (e) { out.error = 'official:' + String(e && e.message) }
  try {
    const gate = await getDshCompat().compatibilityGate()
    out.harness = {
      usable: !!(gate && gate.usable),
      mode: gate && gate.mode,
      auth: gate && gate.capabilities && gate.capabilities.auth,
      endpoint: getDshCompat().baseUrl || null,
      attach: officialHarnessState.lastAttach,
      attachFail: officialHarnessState.lastAttachFail,
      readyProbe: officialHarnessState.readyProbe,
      watchTicks: officialHarnessState.watchTicks,
      userStopped: harnessUserStopped(),
    }
  } catch (e) { out.error = (out.error ? out.error + ' | ' : '') + 'harness:' + String(e && e.message) }
  // 感知：共享会话库（~/.dsh）里 running 的任务——官方 Desktop 起的任务同样在此可见
  try {
    if (out.harness && out.harness.usable) {
      const resp = await getDshCompat().sessionList()
      const items = (resp && resp.result && resp.result.ok && resp.result.value && resp.result.value.items) || []
      out.work = { running: items.filter((s) => s && s.running).map((s) => s.sessionId), total: items.length }
    }
  } catch (e) { out.work = { error: String(e && e.message) } }
  return out
})

ipcMain.handle('harness:ensure', async () => {
  /* 手动按钮＝「重新检测并接入」：清 userStopped、重读密钥重签 cookie，**不自拉实例** */
  try { if (typeof getUpdateManager === 'function') getUpdateManager().setDshUserStopped(false) } catch (e) { /* ignore */ }
  const r = await attachOfficialHarness('manual')
  if (r && r.ok) {
    if (dshStopped) { dshStopped = false; try { startStream() } catch (e) { /* ignore */ } }
  }
  return r
})

ipcMain.handle('app:workspacePath', () => WORKSPACE_PATH)

// 窗口点击穿透：true = 透明区不挡鼠标（穿透），false = 正常捕获
// 穿透态不再转发桌面鼠标移动（forward:false）：命中判定改由主进程
// 60ms 轮询光标 + `pet:mousePos` 推送相对坐标完成（见下方鼠标位置守卫的注释）。
ipcMain.on('pet:setClickThrough', (_e, enabled) => {
  if (!win || win.isDestroyed()) return
  try {
    win.setIgnoreMouseEvents(!!enabled, { forward: false })
  } catch (err) {
    try { win.setIgnoreMouseEvents(!!enabled) } catch (err2) { /* ignore */ }
  }
})

ipcMain.handle('respond', (_e, payload) => apiRespond(payload))

/* ---------- 开机自启 ---------- */

const STARTUP_DIR = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
const PET_VBS = path.join(STARTUP_DIR, 'DeskPet 桌宠.vbs')
const DSH_VBS = path.join(STARTUP_DIR, 'DeepSeek Harness 服务.vbs')
const DSH_LNK = path.join(STARTUP_DIR, 'DeepSeek Harness 服务.lnk')

function vbsEscape(s) {
  return String(s).replace(/"/g, '""')
}

// wscript 按 ANSI 解读无 BOM 的 UTF-8 文件，含中文路径会变成乱码（80070002）。
// 统一用 UTF-16LE + BOM 写 .vbs，wscript 可靠识别。
function writeVbsFile(p, content) {
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(content, 'utf16le')]))
}

/* 这份 vbs 的启动命令是否指向**当前正在运行的 exe**。
   （关闭开关时只允许删本实例的自启条目，避免测试版误删正式版留下的条目。） */
function pointsToCurrentExe(p) {
  try {
    const t = readVbsText(p)
    if (!t) return false
    return t.toLowerCase().indexOf(process.execPath.toLowerCase()) >= 0
  } catch (err) { return false }
}

/* 自启条目"是不是我们生成的"判定。除了标记头，还要认**指向本应用 exe 的旧条目**：
   2026-09-13 曾由一次性部署脚本写过一份 `DeskPet 桌宠.vbs`（内容只有一行启动本应用 exe，
   没有 `' deskpet-managed:` 标记）。旧判定只看标记 ⇒ 认不出来 ⇒ 设置页永远显示"关"，
   而用户点一下反而把**正在生效**的自启删掉（2026-09-17 实测发现）。 */
function isOurPetAutostart(p) {
  if (isDeskPetVbs(p, 'pet')) return true
  return pointsToCurrentExe(p)
}

/* 当前版本是否允许管理开机自启（设置页要用它把"没开"和"这个版本管不了"分开说） */
function autostartSupported() { return editionForbidden() === null }

function autostartGet() {
  const pet = isOurPetAutostart(PET_VBS)
  /* DSH 自启条目按策略"不再新建/不再刷新"（见 autostartSet 注释）⇒ 它的存在与否
不参与开关状态的判定；2026-09-29 旧 DSH 脱钩后桌宠不再创建/管理 DSH 自启，此处只读展示。 */
  const dsh = fs.existsSync(DSH_VBS) || fs.existsSync(DSH_LNK)
  return { enabled: pet, pet, dsh, supported: autostartSupported() }
}

function autostartSet(enabled) {
  /* 必修 3：测试版/纯净版不得写真实启动项。注意 in-memory 那份 vbs 不会被删，
     所以这里只报告"管不了"，绝不谎报"已关闭"（2026-09-17 修正）。 */
  const fb = editionForbidden()
  if (fb) return Object.assign({ enabled: isOurPetAutostart(PET_VBS), pet: false, dsh: false, supported: false }, fb)
  if (enabled) {
    try {
      const cmd = '"' + process.execPath + '" "' + app.getAppPath() + '"'
      const vbs = 'CreateObject("Wscript.Shell").Run "' + vbsEscape(cmd) + '", 0, False'
      if (fs.existsSync(PET_VBS) && !isOurPetAutostart(PET_VBS)) {
        log('autostart: pet vbs is not deskpet-managed, keep it untouched')
      } else {
        writeVbsFile(PET_VBS, vbsHeader('pet') + vbs)
        log('autostart: pet vbs written')
      }
    } catch (err) {
      log('autostart pet write error', err && err.message)
    }
  } else {
    /* 关闭：只删**属于本实例**的桌宠条目。
       2026-09-17：`DeskPet 桌宠.vbs` 这个文件名是全机共用的 —— 测试版/日常版/纯净版
       都会指向同一个 Startup 路径。如果按文件名无脑删，测试版里点一下"关闭自启"
       就会把**日常版/正式版**留下的自启条目删掉（用户完全无法预期）。
       判据：只当这份 vbs 的启动命令指向"当前正在运行的 exe"时才算本实例的。
       */
    try {
      if (fs.existsSync(PET_VBS)) {
        if (pointsToCurrentExe(PET_VBS)) {
          fs.unlinkSync(PET_VBS)
          log('autostart removed', path.basename(PET_VBS))
        } else {
          log('autostart: pet vbs belongs to another instance, keep it untouched')
        }
      }
    } catch (err) { /* ignore */ }
  }
  return autostartGet()
}

ipcMain.handle('autostart:get', () => autostartGet())
ipcMain.handle('autostart:set', (_e, enabled) => autostartSet(!!enabled))



/* CLEAN-STRIP:BEGIN update */
/* ---------- 更新检测（参考 Bigfish latest.json：version 清单 + 启动检查 + 提示下载） ---------- */

const UPDATE_CFG_FILE = path.join(DATA_DIR, 'update-config.json')
// 默认更新源：腾讯云 COS 公有读桶。
// 域名若变，设置页改一次即可；输入框留空并保存 = 禁用检查
const UPDATE_DEFAULT_BASE = 'https://deskpet-updates-1470499795.cos.ap-guangzhou.myqcloud.com'

function loadUpdateConfig() {
  try { return JSON.parse(fs.readFileSync(UPDATE_CFG_FILE, 'utf8')) } catch (err) { return {} }
}
function saveUpdateConfig(cfg) {
  try { fs.writeFileSync(UPDATE_CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8') } catch (err) { /* ignore */ }
}
// 生效的更新源：用户显式清空（''）→ 禁用；未配置 → 默认 COS 地址
function effectiveUpdateBase(cfg) {
  if (cfg && typeof cfg.baseUrl === 'string') return cfg.baseUrl
  return UPDATE_DEFAULT_BASE
}


/* ---------- Update & Compatibility Manager · P0-A（只读可见性 + 模型状态基础） ----------
   只做「读取 / 展示」：不升级 DSH、不装 candidate、不改配置、不自动切模型、不重启。 */
const UPDATE_STATE_FILE = path.join(DATA_DIR, 'update-state.json')
let updateManager = null
/* ---------- P1-B：Production Validation Gate（构建期 + 运行期双层开关） ----------
   默认关闭，且必须**同时**满足：
     1) 构建常量 ModelValidatorReal.PRODUCTION_TIER_ENABLED === true（默认 false）
     2) 非测试版（test edition 恒 false，P1-A.1 隔离）
     3) 运行期显式 flag：DESKPET_ENABLE_PRODUCTION_VALIDATION === '1'
   任一条不满足 ⇒ production tier 关闭（离线/mock 层完全不受影响）。 */
function productionTierGateOpen() {
  if (ModelValidatorReal.PRODUCTION_TIER_ENABLED !== true) return false
  if (TEST_EDITION) return false
  return process.env.DESKPET_ENABLE_PRODUCTION_VALIDATION === '1'
}

/* 校验环境（**只含哈希/版本，绝不含 key**）：endpoint 锁死，key 仅以 8 位哈希参与 env 指纹 */
function modelValidationEnv() {
  const key = readDshKey()
  return {
    endpoint: ModelValidatorReal.LOCKED_ENDPOINT,
    appVersion: app.getVersion(),
    dshCompatVersion: DSH_COMPAT_VERSION,
    keyIdHash8: key ? ModelValidatorReal.hash8('deskpet-model-validation|' + key) : null,
  }
}

/* real tier 唯一执行器：key 只在此处读取、只向下传给 real client，绝不外传/IPC/落盘。
   成本硬约束由 real client 保证：≤1 请求、0 重试、output ≤8 tokens、timeout ≤20s。 */
async function runRealModelValidation(req) {
  const r = req && typeof req === 'object' ? req : {}
  const key = readDshKey()
  if (!key) return { ok: false, error: 'no-key', checks: null, provenance: null }
  try {
    return await ModelValidatorReal.runRealValidation({
      modelId: r.modelId,
      purpose: r.purpose,
      key,
      timeoutMs: ModelValidatorReal.TIMEOUT_MS,
    })
  } catch (err) {
    return { ok: false, error: 'runner_threw', detail: (err && err.message) || 'unknown', checks: null, provenance: null }
  }
}

function getUpdateManager() {
  if (!updateManager) {
    updateManager = createUpdateManager({
      stateFile: UPDATE_STATE_FILE,
      log,
      readKey: readDshKey,
      modelsUrl: 'https://api.deepseek.com/models',
      /* P1-B：production tier 组合根（默认关闭；real 执行器与 env 由 main 注入，manager 不接触 key） */
      productionTierEnabled: productionTierGateOpen,
      envProvider: modelValidationEnv,
      realRunner: runRealModelValidation,
      runtimeInfo: () => RUNTIME_INFO,
      // 只读缓存快照：不做 resolveMode(true) 之类的探测，避免设置页触发网络
      compatInfo: () => {
        const c = getDshCompat()
        return { mode: c.mode, capabilities: c.capabilities, usable: !!c.mode && !!c.capabilities.protocolUsable }
      },
    })
  }
  return updateManager
}

// 模型状态快照（同步、无网络）——设置页首屏
ipcMain.handle('update:statusSnapshot', () => getUpdateManager().status())
// DeepSeek 官方模型目录只读探测（timeout + 缓存 + 频率限制；失败绝不阻塞）
ipcMain.handle('update:modelStatus', (_e, opts) => getUpdateManager().probeModels({ force: !!(opts && opts.force) }))
// B3：模型发现快照（只读、无网络、无写盘；declared/listed/discovered/conflicts/lifecycle/routeState）
ipcMain.handle('update:modelDiscovery', () => getUpdateManager().modelDiscovery())
// B4：模型候选资格（只读、无网络、无写盘、无迁移；三态门与理由码，派生值现算）
ipcMain.handle('update:modelCandidates', () => getUpdateManager().candidatesView())
// B4：验证证据记录（只读事实；含派生 state，便于审计）
ipcMain.handle('update:modelValidation', () => getUpdateManager().validationView())
// P1-A：用户显式触发的 offline/mock 验证（写路径；结构化参数、限流、审计；不联网、不迁移、不改 declared）
/* P1-B：production tier 走异步唯一入口；offline/mock 保持既有同步路径不变 */
ipcMain.handle('update:modelValidate', async (_e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {}
  const mgr = getUpdateManager()
  if (o.requestedTier === 'production') return mgr.runProductionValidation(o)
  return mgr.runModelValidation(o)
})

// P1-B：只读计划（零网络、零写盘、零记录）
ipcMain.handle('update:productionValidationPlan', (_e, opts) => getUpdateManager().productionValidationPlan(opts))

// P2-4：版本比较唯一实现 = build/version-compare.js（semver 优先，非法版本回退旧数值比较）。
// main / 测试共用，禁止在本文件内再复制一份比较器。
function compareVersions(a, b) {
  return VersionCompare.compareVersions(a, b)
}

async function fetchUpdateJson(baseUrl) {
  const url = String(baseUrl || '').replace(/\/+$/, '') + '/updates/version.json'
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 10000)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    clearTimeout(t)
    if (!res.ok) return null
    return await res.json()
  } catch (err) {
    clearTimeout(t)
    return null
  }
}

ipcMain.handle('update:config', () => {
  if (CLEAN_EDITION) return { baseUrl: '', current: app.getVersion(), clean: true }
  const cfg = loadUpdateConfig()
  return { baseUrl: effectiveUpdateBase(cfg), current: app.getVersion() }
})

ipcMain.handle('update:setConfig', (_e, baseUrl) => {
  if (CLEAN_EDITION) return { ok: false, error: '纯净版不支持更新' }
  // 显式留空 = 禁用检查（存 ''）；其余存原值
  saveUpdateConfig({ baseUrl: String(baseUrl || '').trim() })
  // 关键：改地址后立即刷新 electron-updater 的 feed，
  // 否则差分下载仍走启动时的旧源（1.1.16 曾因此从旧源拉取失败）
  initAutoUpdater()
  return { ok: true }
})

ipcMain.handle('update:check', async () => {
  if (CLEAN_EDITION) return { ok: false, error: '纯净版不支持更新' }
  const cfg = loadUpdateConfig()
  const baseUrl = effectiveUpdateBase(cfg)
  if (!baseUrl) return { ok: false, error: '未配置更新源地址（设置 → 更新 → 填写公网地址）' }
  const info = await fetchUpdateJson(baseUrl)
  if (!info || !info.version) return { ok: false, error: '无法获取更新信息（网络不通或地址不对）' }
  const current = app.getVersion()
  const hasUpdate = compareVersions(info.version, current) > 0
  return {
    ok: true,
    hasUpdate,
    current,
    latest: info.version,
    note: info.note || '',
    sha256: info.sha256 || '',
    size: info.size || 0,
    filename: info.filename || '',
  }
})

// 差分下载（electron-updater）：利用 blockmap 只拉取与旧版不同的数据块，
// node/dsh/动画等不变部分不重复下载（183MB 安装包实际只下几 MB 差异）。
// 首次更新本地无旧包缓存时会退化为全量下载；之后均走增量。
ipcMain.handle('update:download', async () => {
  if (CLEAN_EDITION) return { ok: false, error: '纯净版不支持更新' }
  const cfg = loadUpdateConfig()
  const baseUrl = effectiveUpdateBase(cfg)
  if (!baseUrl) return { ok: false, error: '未配置更新源地址' }
  try {
    // electron-updater 必须先 checkForUpdates 再 downloadUpdate（否则报 "Please check update first"）
    const check = await autoUpdater.checkForUpdates()
    // 关键：checkForUpdates 可能因 feed 版本判定/灰度等原因返回 isUpdateAvailable=false，
    // 此时 updateInfoAndProvider 未设置，直接 downloadUpdate 会报 "Please check update first"。
    // 我们的 version.json 检查已确认有新版本 → 这种情况直接走下方全量兜底下载。
    if (!check || !check.updateInfo || check.isUpdateAvailable === false) {
      throw new Error('no update info or updater says no update, falling back to full')
    }
    await autoUpdater.downloadUpdate()
    if (win && !win.isDestroyed()) win.webContents.send('update:progress', { pct: 100 })
    return { ok: true, method: 'differential' }
  } catch (err) {
    log('differential download failed, falling back to full', err && err.message)
    // 兜底：完整下载 + SHA-256 校验
    const info = await fetchUpdateJson(baseUrl)
    if (!info || !info.filename) return { ok: false, error: '获取更新信息失败' }
    const url = baseUrl.replace(/\/+$/, '') + '/updates/' + encodeURIComponent(info.filename)
    const dir = path.join(app.getPath('userData'), 'updates')
    fs.mkdirSync(dir, { recursive: true })
    const dest = path.join(dir, info.filename)
    try {
      const res = await fetch(url)
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status }
      const total = Number(res.headers.get('content-length')) || info.size || 0
      const reader = res.body.getReader()
      const ws = fs.createWriteStream(dest)
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.length
        ws.write(Buffer.from(value))
        if (total && win && !win.isDestroyed()) {
          win.webContents.send('update:progress', { pct: Math.min(99, Math.round((received / total) * 100)) })
        }
      }
      ws.end()
      // 关键：等待写盘真正完成再校验——ws.end() 是异步的，183MB 流式写完前
      // readFileSync 会读到残缺文件导致 SHA 必失败（1.1.16/1.1.17 朋友的"下载损坏"根因）
      await new Promise((resolve, reject) => {
        ws.on('finish', resolve)
        ws.on('error', reject)
      })
      if (win && !win.isDestroyed()) win.webContents.send('update:progress', { pct: 100 })
      if (info.sha256) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
        if (hash.toLowerCase() !== String(info.sha256).toLowerCase()) {
          fs.rmSync(dest, { force: true })
          return { ok: false, error: 'SHA-256 校验失败（下载损坏或被篡改），请重试' }
        }
      }
      return { ok: true, path: dest, filename: info.filename, method: 'full' }
    } catch (err2) {
      return { ok: false, error: err2 && err2.message }
    }
  }
})

// 找到本地可用的升级安装包：
// 1) electron-updater 差分下载的 pending 目录（updaterCacheDirName = deskpet-updater）
// 2) 全量兜底下载的 userData\updates 目录
function findInstallerCandidates() {
  const out = []
  try {
    // electron-updater 缓存：%LOCALAPPDATA%\deskpet-updater\pending\
    const pendingDir = path.join(app.getPath('appData'), '..', 'Local', 'deskpet-updater', 'pending')
    if (fs.existsSync(pendingDir)) {
      fs.readdirSync(pendingDir).filter((n) => /^deskpet-setup-[\d.]+\.exe$/i.test(n)).forEach((n) => out.push(path.join(pendingDir, n)))
    }
  } catch (err) { log('findInstaller pending err', err && err.message) }
  try {
    const dir = path.join(app.getPath('userData'), 'updates')
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).filter((n) => n.endsWith('.exe')).forEach((n) => out.push(path.join(dir, n)))
    }
  } catch (err) { log('findInstaller updates err', err && err.message) }
  // 按文件名版本号排序，取最新
  out.sort((a, b) => {
    const va = (a.match(/([\d.]+)\.exe$/) || [])[1] || ''
    const vb = (b.match(/([\d.]+)\.exe$/) || [])[1] || ''
    return compareVersions(vb, va)
  })
  return out
}

// 查询本地是否已有指定版本（或更高）的安装包——用于"检查更新时直接显示安装按钮"
ipcMain.handle('update:hasInstaller', (_e, version) => {
  if (CLEAN_EDITION) return { ok: true, has: false }
  try {
    const exes = findInstallerCandidates()
    if (!exes.length) return { ok: true, has: false }
    if (!version) return { ok: true, has: true, path: exes[0] }
    const best = exes[0]
    const v = (best.match(/([\d.]+)\.exe$/) || [])[1] || ''
    return { ok: true, has: compareVersions(v, version) >= 0, path: best, version: v }
  } catch (err) {
    return { ok: false, error: err && err.message }
  }
})


/* P1-K2-FIX · 更新/部署**生命周期停止**（不写 userStopped）
 *
 * 与"用户主动停止"（ipcMain 'dsh:stop'）的**唯一区别**在持久化语义：
 *   - 用户主动停止：setDshUserStopped(true) ⇒ 启动/向导不再自动拉起后端
 *   - 本通道（更新/部署生命周期）：只用 stopOwnedDshForLifecycle()，**绝不写 userStopped**；
 *     且**不改变已有值**（用户之前若显式停过，标记保持 true，本通道不读改、不清除）
 *
 * 为什么需要它：N-3 部署 / 自更新安装前，必须"把后端停下来让出应用树"，但这是**流程性停止**，
 * 不代表用户表达"我不想用后端"。若误写标记，新版启动后不会自动拉起 DSH，还要人工再点一次「重启 DSH」。
 * 停止动作复用同一条 owned-DSH 通道（ownership 校验 + Job/legacy 语义），并与 start/restart/stop/update
 * 共用同一把 lifecycle 互斥（kind='stop'，state=stopping）——不与用户停止各用一套。
 */
async function runDshMaintenanceStop() {
  const fb = dshLifecycleForbidden()
  if (fb) return fb
  const lc = dshLifecycle()
  const got = lc.acquire('stop', { by: 'tray-maintenance' })
  if (!got.ok) return { ok: false, error: 'busy', holder: got.holder, state: got.state }
  try {
    const stop = await stopOwnedDshForLifecycle()
    let was = null
    try { was = getUpdateManager().dshUserStopped() === true } catch (e) { was = null }
    const ok = !!(stop && stop.ok === true)
    try { getUpdateManager().dshRecordAudit('dsh-maintenance-stop', 'ok=' + String(ok) + ' via=' + String((stop && stop.via) || '-') + ' userStoppedKept=' + String(was)) } catch (e) { /* ignore */ }
    if (!ok) return { ok: false, error: (stop && stop.error) || 'stop_failed', via: (stop && stop.via) || null, userStoppedTouched: false }
    try { stopDshStream() } catch (e) { /* ignore */ }
    dshStopped = true
    return { ok: true, stopped: true, killed: (stop && stop.killed) || 0, via: (stop && stop.via) || null, userStoppedTouched: false, userStoppedWas: was }
  } finally { lc.release('stop') }
}

/* 托盘入口：执行维护停止，并把结果明确告知操作者（成功才可继续部署） */
async function runMaintenanceStopFromTray() {
  let r = null
  try { r = await runDshMaintenanceStop() } catch (e) { r = { ok: false, error: 'threw', detail: (e && e.message) || String(e) } }
  const ok = !!(r && r.ok === true)
  const detail = ok
    ? '后端（DSH）已停止。\n\n· 未写入「用户已停止」标记 —— 启动新版后后端会按既有策略自动拉起\n· 现在可以退出桌宠并执行部署 / 更新'
    : '后端未能停止，已取消，未做任何修改。\n\n原因：' + String((r && (r.error || r.detail)) || 'unknown') + '\n\n请勿在此时覆盖应用目录（被占用的文件会导致「部分覆盖」）。'
  try {
    await dialog.showMessageBox({
      type: ok ? 'info' : 'error',
      buttons: ['知道了'],
      defaultId: 0,
      title: ok ? '维护：后端已停止' : '维护：停止后端失败',
      message: ok ? '可以开始部署 / 更新' : '停止失败，请勿继续',
      detail: detail,
    })
  } catch (e) { log('maintenance stop dialog err', e && e.message) }
  log('maintenance stop result ' + JSON.stringify(r).slice(0, 300))
}
ipcMain.handle('update:install', async (_e, opts) => {
  if (CLEAN_EDITION) return { ok: false, error: '纯净版不支持更新' }
  // 方案：不再依赖 electron-updater 内部 pending 状态（quitAndInstall 在无 pending 时静默无动作，  // 就是 1.1.18/1.1.19"点击安装没反应"的根因）。改为：
  // 1) 确认（渲染层自绘确认卡 → 传 confirmed:true；或主进程无 parent dialog 兜底）
  // 2) 显式找到本地安装包（差分 pending 或全量兜底目录）
  // 3) spawn 静默安装（/S --updated --force-run /D=当前安装目录），装完自动重启新版
  const exes = findInstallerCandidates()
  if (!exes.length) return { ok: false, error: '未找到本地升级安装包，请先点击「下载」' }
  const installer = exes[0]
  const version = (installer.match(/([\d.]+)\.exe$/) || [])[1] || '?'
  // 确认弹窗（注意：不传 win 作为 parent！桌宠窗口是 transparent+frame:false+alwaysOnTop，
  // 以它为 parent 的模态 dialog 在 Electron 33 上不显示且永久挂起 —— 1.1.22"点安装没反应"根因）
  const installDir = path.dirname(app.getPath('exe'))
  let confirmed = !!(opts && opts.confirmed)
  if (!confirmed) {
    try {
      const r = await dialog.showMessageBox({
        type: 'question',
        buttons: ['取消', '立即更新'],
        defaultId: 1,
        cancelId: 0,
        title: '更新桌宠小深',
        message: '发现新版本 v' + version + '，是否立即安装？',
        detail: '安装过程会自动关闭桌宠，完成后自动重新打开。\n安装期间请勿关机或断开网络。',
      })
      confirmed = r.response === 1
    } catch (err) {
      log('update install dialog err', err && err.message)
    }
  }
  if (!confirmed) return { ok: false, cancelled: true, error: '用户取消' }
  // 显式静默安装（参数与 electron-updater 官方 doInstall 同集合，但**顺序修正**）：
  //   --updated /S --force-run [--package-file=<安装包>] /D=<安装目录>
  // 说明：--force-run 让安装器装完自动启动新版（assisted installer 静默更新时
  // MUI_FINISHPAGE_RUN 不执行，靠它触发 doStartApp）；--package-file 对齐官方，
  // 让更新模式（--updated）正确识别包数据，避免完成后启动异常。
  // 顺序要求：NSIS 的 `/D=` 必须放在最后——它会把其后的命令行整段当作安装目录；
  // 若 `--package-file=` 排在它后面，安装目录会被拼成畸形路径（应用装到错误位置）。
  log('update:install explicit installer', installer, 'dir=', installDir)
  try {
    const args = ['--updated', '/S', '--force-run', '--package-file=' + installer, '/D=' + installDir]
    const child = spawn(installer, args, {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (err) {
    log('update:install spawn err', err && err.message)
    return { ok: false, error: err && err.message }
  }
  // 给安装器 1 秒启动时间，然后退出桌宠（安装器 --force-run 会在完成后启动新版）
  setTimeout(() => {
    try { app.quit() } catch (err) { /* ignore */ }
  }, 1200)
  return { ok: true, installing: true, version }
})

/* ---------- 更新检测（version.json 检查 + electron-updater 差分下载） ---------- */

// electron-updater 初始化：generic feed（差分下载用），事件转发给渲染层
function initAutoUpdater() {
  try {
    const base = effectiveUpdateBase(loadUpdateConfig())
    if (!base) return
    autoUpdater.setFeedURL({ provider: 'generic', url: base.replace(/\/+$/, '') + '/updates' })
    autoUpdater.autoDownload = false
    /* 置 false：退出应用时 electron-updater 不再自行安装，避免与本文件 update:install 的
       显式 spawn 形成两条并发安装链（对同一安装目录同时卸载+安装）。安装只走显式那一条。 */
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.on('download-progress', (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('update:progress', { pct: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', () => {
      if (win && !win.isDestroyed()) win.webContents.send('update:downloaded')
    })
    autoUpdater.on('error', (err) => {
      log('updater error', err && err.message)
      if (win && !win.isDestroyed()) win.webContents.send('update:error', { msg: err && err.message })
    })
  } catch (err) {
    log('initAutoUpdater failed', err && err.message)
  }
}

// 启动后自动检查一次（Bigfish 同款时机），有新版时通知渲染层弹提示
function checkForUpdatesAuto() {
  const cfg = loadUpdateConfig()
  const baseUrl = effectiveUpdateBase(cfg)
  if (!baseUrl) return
  fetchUpdateJson(baseUrl).then((info) => {
    if (!info || !info.version) return
    if (compareVersions(info.version, app.getVersion()) > 0) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('update:available', { latest: info.version, note: info.note || '' })
      }
    }
  }).catch(() => { /* 静默 */ })
}
/* CLEAN-STRIP:END update */

/* ---------- 日常聊天 AI（微型聊天框 → 专用 DSH 会话，人设 + 联网搜索） ---------- */

const CHAT_SESSION_FILE = path.join(DATA_DIR, 'chat-session.json')

// Character Chat 的 Persona 单一来源已迁移到 PersonaCore。
// 这里只保留 DSH Agent/Work 辅助会话所需的模型选择，不再维护第二套 Character Persona。
/* The chat/agent panel is a user-configured DSH session. The pet does not change its model;
   DSH owns that choice. Pet model selection only applies to the pet's own direct AI surfaces. */

/* ---------- 用户可选的 Chat 模型（用户偏好） ----------
   落点分工（2026-09-17）：
     · 可选清单与合法性判定 = ModelRegistry（纯函数白名单，renderer 只渲染不判定）
     · 用户选择 = 独立文件 pet-prefs.json，**只由主进程读写**（渲染层的 pet-state.json 保存
       是整对象覆盖，两处写同一文件会互相丢键；偏好与游戏状态生命周期不同，分开更稳）
     · 生效点 = callDirectLLM（Character Chat 直连）；DSH 会话模型由用户在 DSH 内配置
   取值语义：null / '' = 未设偏好 = **跟随最新 Flash**（registry 的 GA 判定，将来换新自动跟）；
             已设 = 用户显式选定的 ID（模型 ID 与端点绑定保存，失败保留选择并报告错误）。 */
const PET_PREFS_FILE = path.join(DATA_DIR, 'pet-prefs.json')




function readModelPrefs() {
  try { const p = JSON.parse(fs.readFileSync(PET_PREFS_FILE, 'utf8')); if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('invalid preferences'); return p }
  catch (e) { if (e.code === 'ENOENT') return {}; throw Error('configuration_error') }
}
function getModelConfig() { return require('./model-config.cjs').createModelConfig({ read: readModelPrefs, write: savePrefsFile, legacyKey: readDshKey }) }
function getModelClient() {
  let electronNet = null
  try { const electron = require('electron'); if (electron.app && electron.app.isReady()) electronNet = electron.net } catch (e) { /* Node contract tests use their injected fetch */ }
  // Chromium follows system/PAC proxy settings; keep transport out of protocol adapters.
  return require('./model-provider.cjs').createClient({ fetch: (url, options) => electronNet && electronNet.fetch ? electronNet.fetch(url, Object.assign({}, options, { bypassCustomProtocolHandlers: true })) : fetch(url, options) })
}
function selectableForProvider(id) {
  const view = getModelConfig().view(); if (!view.ok) return []
  const p = view.providers.find(p => p.id === id); if (!p) return []
  const ids = p.models.slice()
  if (p.protocol === 'openai' && /^https:\/\/api\.deepseek\.com(?:\/v1)?$/.test(p.baseUrl)) for (const m of ModelRegistry.selectableModels()) if (!ids.includes(m.id)) ids.push(m.id)
  for (const r of Object.values(view.routes)) if (r.effectiveProviderId === id && r.model && !ids.includes(r.model)) ids.push(r.model)
  return ids.map(id => ({ id, name: id, custom: true }))
}
async function discoverModelProvider(id) {
  const config = getModelConfig(), p = config.getProvider(id); if (!p.ok) return p
  const r = await getModelClient().discover(p.connection), stored = config.setModels(id, r, p.revision)
  log('model discovery', JSON.stringify({ provider: id, protocol: p.connection.protocol, ok: !!r.ok, error: r.error || null, count: (r.models || []).length }))
  if (!stored.ok) return stored
  return Object.assign({}, r, { view: stored.view })
}
ipcMain.handle('modelConfig:get', () => getModelConfig().view())
ipcMain.handle('modelConfig:defaultModel', (_e, value) => getModelConfig().setDefaultModel(value))
ipcMain.handle('modelConfig:save', (_e, p) => {
  const r = getModelConfig().saveProvider(p)
  if (r && r.ok) {
    log('model config save', JSON.stringify({ provider: p && p.id || null, protocol: p && p.protocol || null, scopeChanged: !!r.scopeChanged, keyCleared: !!r.keyCleared, authModeReset: !!r.authModeReset, modelCleared: !!r.modelCleared, defaultCleared: r.defaultCleared || 0, routesCleared: r.routesCleared || 0 }))
  } else if (r) log('model config save failed', JSON.stringify({ provider: p && p.id || null, error: r.error || null }))
  return r
})
ipcMain.handle('modelConfig:default', (_e, id) => getModelConfig().setDefault(id))
ipcMain.handle('modelConfig:remove', (_e, id) => getModelConfig().removeProvider(id))
ipcMain.handle('modelConfig:route', (_e, role, value) => getModelConfig().setRoute(role, value))
ipcMain.handle('modelConfig:probe', (_e, id) => discoverModelProvider(id))
ipcMain.handle('modelConfig:test', async (_e, id, model) => {
  const p = getModelConfig().getProvider(id); if (!p.ok) return p
  return getModelClient().complete(p.connection, { model: model || p.connection.model, messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 32, timeoutMs: 30000 })
})

function loadPrefsFile() {
  try { return JSON.parse(fs.readFileSync(PET_PREFS_FILE, 'utf8')) } catch (err) { return {} }
}

/* 取值：`modelPrefs.<purpose>` 优先；character 兼容旧的顶层 `chatModel` 键。
   已保存的合法 ID 保留；模型下线或端点故障时报告实际错误，不抹除用户选择。 */


function chatModelPref() { const r = getModelConfig().resolve('character'); return r.preference || null }

/* M2：**按场景**取用户偏好。只有 `CONFIGURABLE_PURPOSES`（真有独立直连调用点
   的档）才认偏好；expression/vision/work 一律返回 null（不给没接线的通道配旋钮）。 */
function modelPrefFor(purpose) { const r = getModelConfig().resolve(purpose); return r.preference || null }

/* 写入某档偏好（'' = 恢复"跟随最新 Flash"）。返回 { ok, error }。 */
function writeModelPref(purpose, rawId) {
  const view = getModelConfig().view(); if (!view.ok) return view
  const route = view.routes[purpose] || {}
  return getModelConfig().setRoute(purpose, { providerId: route.providerId, model: rawId || null })
}

function savePrefsFile(patch) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const cur = loadPrefsFile()
    const next = Object.assign({}, cur, patch || {})
    const tmp = PET_PREFS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    fs.renameSync(tmp, PET_PREFS_FILE)
    return true
  } catch (err) {
    log('prefs save error', err && err.message)
    return false
  }
}

/* 连接凭据只留在主进程；旧用户可继续沿用官方端点的共享凭据，新端点必须自配 Key。 */




function llmApiPref() {
  const config = getModelConfig(), view = config.view()
  if (!view.ok) return { baseUrl: '', apiKey: '', model: '', temps: {}, configError: view.error }
  const r = config.getProvider(view.defaultProviderId)
  return r.ok ? Object.assign({}, r.connection, { allowNoKey: !require('./model-provider.cjs').needsKey(r.connection), keySource: view.providers.find(p => p.id === view.defaultProviderId).keySource }) : { baseUrl: '', apiKey: '', model: '', temps: {}, configError: r.error }
}

function llmApiView() {
  const c = llmApiPref()
  const { apiKey, ...safe } = c
  return Object.assign(safe, { hasKey: !!apiKey, effectiveModel: effectiveChatModel() })
}

/* ---------- 端点模型：让"配置页的地址"决定"可选模型" ----------
   设置页可填任意 baseUrl/key，而模型选择器的选项原本只有写死的 DeepSeek 白名单
   （model-registry.js USER_SELECTABLE）；第三方服务商下的模型 ID 需能填。
   做法：白名单保持不动；自定义/端点探测到的 ID 走 custom-model-store.cjs，
   在"读取允许清单 / 视图 / 校验"三处并入。 */
let customModelStoreInstance = null
function customModelStore() {
  if (!customModelStoreInstance) {
    const { createCustomModelStore } = require('./custom-model-store.cjs')
    customModelStoreInstance = createCustomModelStore({ file: path.join(DATA_DIR, 'custom-models.json') })
  }
  return customModelStoreInstance
}
function allowedModelsFor(baseUrlOverride) {
  const base = typeof baseUrlOverride === 'string' ? baseUrlOverride : llmApiPref().baseUrl
  const v = customModelStore().view(base)
  return { endpointModels: v.endpointModels, userModels: v.confirmed }
}
function modelViewOptions() {
  const a = allowedModelsFor()
  return { endpointModels: a.endpointModels, userModels: a.userModels }
}
function customModelMeta() {
  const base = llmApiPref().baseUrl
  const v = customModelStore().view(base)
  return { baseUrl: base, endpointModels: v.endpointModels.slice(0, 80), endpointError: v.endpointError, endpointOkAt: v.endpointOkAt, confirmed: v.confirmed.slice() }
}
function modelIdPromise(raw, setter) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return { ok: true, empty: true }
  const a = allowedModelsFor()
  if (ModelRegistry.isSelectable(s, a)) return { ok: true, id: s }
  if (!ModelRegistry.isValidModelId(s)) return { ok: false, error: 'invalid-model-id' }
  const r = setter(s)
  if (r && r.ok === false) return { ok: false, error: r.error || 'store-failed' }
  return { ok: true, id: s }
}

/* 探测用户配置的 baseUrl 的 /models：永不抛错；结果按端点落盘（不含密钥）。 */
async function probeCustomModels(force) {
  const config = getModelConfig(), view = config.view(); if (!view.ok) return view
  const profile = view.providers.find(p => p.id === view.defaultProviderId)
  if (!force && profile.modelsAt && profile.models.length && Date.now() - profile.modelsAt < 600000) return { ok: true, listed: profile.models.slice(), cached: true, baseUrl: profile.baseUrl }
  const r = await discoverModelProvider(view.defaultProviderId)
  return Object.assign({}, r, { listed: r.models || [], baseUrl: profile.baseUrl })
}

function saveLLMApiConfig(value) {
  const config = getModelConfig(), view = config.view(); if (!view.ok) return view
  const patch = Object.assign({}, value || {}, { id: view.defaultProviderId })
  if (typeof patch.allowNoKey === 'boolean') patch.authMode = patch.allowNoKey ? 'none' : 'auto'
  const r = config.saveProvider(patch)
  return r.ok ? { ok: true, view: llmApiView() } : r
}

/* U4-c：主动策略用户调参（pet-prefs.json → proactiveTuning）；空/非法逐字回退默认。 */
function policyTuningFromPrefs() {
  const cur = loadPrefsFile()
  const t = (cur && typeof cur.proactiveTuning === 'object' && cur.proactiveTuning) || {}
  const out = {}
  const dailyCap = Number(t.dailyCap)
  if (Number.isFinite(dailyCap) && dailyCap >= 1 && dailyCap <= 16) out.dailyCap = Math.round(dailyCap)
  const from = Number(t.quietFrom), to = Number(t.quietTo)
  if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && from <= 23 && to >= 0 && to <= 23) {
    out.quietHours = { from: Math.round(from), to: Math.round(to) }
  }
  const minIv = Number(t.minIntervalMinutes)
  if (Number.isFinite(minIv) && minIv >= 5 && minIv <= 240) {
    const m = Math.round(minIv) * 60 * 1000
    out.intervalLadderMs = [m, m * 2, m * 3, Math.round(m * 4.5)]
  }
  return out
}

/* F7-B：主动联系专属开关（pet-prefs.json → proactive.enabled；**默认 false**；主进程唯一读写 owner；首版不加 UI）。
   口径：开关只是**执行抑制器**，不产生动机——F4 未选 seek_attention 时它开与不开都发起 0 次。 */
function proactiveEnabled() {
  const p = loadPrefsFile()
  const v = p && p.proactive
  return !!(v && v.enabled === true)
}
function writeProactiveEnabled(flag) {
  const cur = loadPrefsFile()
  const prev = (cur && cur.proactive && typeof cur.proactive === 'object') ? cur.proactive : {}
  return savePrefsFile({ proactive: Object.assign({}, prev, { enabled: !!flag }) })
}

/* 端点作用域的有效默认模型：用户配置的模型 > 端点探测到的第一支模型 > 官方最新 Flash。
   探测结果按 baseUrl 落盘（custom-model-store），故默认值随配置的提供商变化。 */
function effectiveDefaultModel() {
  const view = getModelConfig().view(); if (!view.ok) return null
  const p = view.providers.find(p => p.id === view.defaultProviderId)
  return p.model || (p.protocol === 'openai' && /^https:\/\/api\.deepseek\.com(?:\/v1)?$/.test(p.baseUrl) ? ModelRegistry.latestFlashId() : null)
}

/* 生效的 Chat 模型：Chat 偏好 → 未设则用"默认模型"（见 effectiveDefaultModel）。
   派活相关的会话模型由**派活面板 / 会话自身**管理，这里不再读 work 偏好（避免两处都能改）。 */
function effectiveChatModel() { const r = getModelConfig().resolve('character'); return r.ok ? r.model : null }

/* M2 视图：只上架"真有调用点"的档（chat/diary），每档给"偏好 / 实际生效 / 是否跟随默认"。 */
function modelPrefView() {
  const view = getModelConfig().view(); if (!view.ok) return view
  return { ok: true, selectable: selectableForProvider(view.defaultProviderId), custom: customModelMeta(), purposes: ['character','diary','proactive'].map(purpose => {
    const r = getModelConfig().resolve(purpose), route = view.routes[purpose]
    return { purpose, preference: route.model, providerId: route.providerId, effective: r.model || null, effectiveName: r.model || '未配置', following: !route.model, overridden: false, error: r.ok ? null : r.error }
  }) }
}

/* 设置页用：可选清单 + 当前生效 + 是否"跟随最新"。非法/已下线的偏好已在此处回退。 */
function chatModelView() {
  const r = getModelConfig().resolve('character'), view = getModelConfig().view()
  return { ok: view.ok, preference: view.ok ? view.routes.character.model : null, effective: r.model || null, effectiveName: r.model || '未配置', effectiveLifecycle: 'unknown', following: !r.preference, overridden: false, error: r.ok ? null : r.error, selectable: selectableForProvider(r.providerId), custom: customModelMeta() }
}

ipcMain.handle('chatModel:get', () => chatModelView())

/* Chat 档偏好只作用于桌宠自己的直连 AI 功能；DSH 会话的模型由用户在 DSH 内配置，桌宠不改。 */
async function applyModelPrefToChatSession() { return 'direct-only' }

ipcMain.handle('chatModel:set', async (_e, id) => {
  const raw = String(id == null ? '' : id).trim()
  /* '' = 恢复"跟随最新 Flash"（显式选择，不是默认值）；
     其余须过「官方白名单 ∪ 端点作用域 ∪ 用户已确认」；自定义 ID 形状合法即记入 store。 */
  const j = modelIdPromise(raw, (v) => customModelStore().confirm(v))
  if (!j.ok) return { ok: false, error: j.error, view: chatModelView() }
  if (raw && !j.empty) customModelStore().setSelected('character', raw)
  const w = writeModelPref('character', raw)
  if (!w.ok) return { ok: false, error: w.error, view: chatModelView() }
  /* 立即生效（用户要求"选完就用"，不重启）：直连路径每次请求都重读偏好；
     DSH 会话是**会话属性**，必须显式改一次。 */
  const applied = await applyModelPrefToChatSession()
  return { ok: true, applied, view: chatModelView() }
})

/* M2：按场景（chat/diary/expression/vision/work）读写模型偏好。 */
ipcMain.handle('modelPref:get', () => modelPrefView())

ipcMain.handle('modelPref:set', async (_e, purpose, id) => {
  const p = ModelRegistry.isConfigurablePurpose(purpose) ? purpose : ''
  if (!p) return { ok: false, error: 'not-configurable', view: modelPrefView() }
  const raw = String(id == null ? '' : id).trim()
  const j = modelIdPromise(raw, (v) => customModelStore().confirm(v))
  if (!j.ok) return { ok: false, error: j.error, view: modelPrefView() }
  if (raw && !j.empty) customModelStore().setSelected(p, raw)
  const w = writeModelPref(p, raw)
  if (!w.ok) return { ok: false, error: w.error, view: modelPrefView() }
  const applied = p === 'character' ? await applyModelPrefToChatSession() : 'not-applicable'
  return { ok: true, applied, view: modelPrefView() }
})

/* 探测当前配置的 baseUrl 有哪些模型（只读 /models，结果按端点落盘）。
   失败不阻塞——界面仍可手动填自定义模型 ID；本接口不返回也不记录密钥。 */
ipcMain.handle('model:probe', async (_e, force) => {
  const r = await probeCustomModels(force === true)
  return Object.assign({}, r, { custom: customModelMeta() })
})

/* ---------- 会话权限档位 ----------
   背景：派活面板的「🔐 权限」下拉此前**永远是空的**且切换无效：
     ① 选项原来读 `projections.values.permissions.options` —— DSH 的 permissions 投影**只有 currentValue**，
        所以 options 恒为 []；选项其实来自另一个 RPC `permissionPresets/catalog`；
     ② 切换原来用 `session.prompt` 发一句文本 `/permission <v>` —— prompt 只把文本当用户消息入队，
        **不解释斜杠命令**，于是命令从未执行，而 prompt 仍返回 accepted=true ⇒ 界面还会假报"已切换"。
   现在：选项走 catalog、当前值走投影、切换走 host 命令（`commands/execute`）。 */
function sessionPermissionValue(item) {
  try {
    const v = item && item.projections && item.projections.values
    const p = v && v.permissions
    return p && typeof p.currentValue === 'string' ? p.currentValue : null
  } catch (err) { return null }
}

/* 权限视图（选项 + 当前值 + 会话是否在跑）：IPC 与手机端 HTTP 路由共用同一实现 */
async function permissionView(sessionId) {
  try {
    const cat = await api('permissionPresets.catalog', {})
    const options = (cat && cat.result && cat.result.ok && cat.result.value && cat.result.value.options) || []
    let current = null
    let running = false
    const sid = String(sessionId || '')
    if (sid) {
      const lr = await api('session.list', {})
      const items = (lr && lr.result && lr.result.ok && lr.result.value && lr.result.value.items) || []
      const item = items.find((s) => s.sessionId === sid)
      if (item) { current = sessionPermissionValue(item); running = !!item.running }
    }
    return { ok: true, options, current, running }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'permission catalog failed' }
  }
}

ipcMain.handle('permission:get', async (_e, sessionId) => permissionView(sessionId))

/* 切换权限：**唯一实现**（IPC 与手机端 HTTP 路由共用，避免两条路径行为不一致） */
async function permissionSet(payload) {
  const p = payload || {}
  const sessionId = String(p.sessionId || '')
  const value = String(p.value || p.permission || '')
  if (!sessionId || !value) return { ok: false, error: 'bad-request' }
  /* 白名单：只允许 catalog 里给出的档位（不把任意字符串拼进命令行） */
  try {
    const cat = await api('permissionPresets.catalog', {})
    const options = (cat && cat.result && cat.result.ok && cat.result.value && cat.result.value.options) || []
    const allowed = options.map((o) => (o && (o.value || o.id)) || '').filter(Boolean)
    if (allowed.length && allowed.indexOf(value) < 0) return { ok: false, error: 'permission-not-allowed' }
  } catch (err) { /* catalog 读不到时继续（命令本身仍会被 host 校验） */ }
  try {
    const r = await api('commands.execute', { agentId: sessionId, line: '/permission ' + value, submittedAttachments: [] })
    /* 诊断留痕：只记 rpc 结果的**结构**，不记内容/凭据（命令是常量，不含用户数据） */
    try {
      const shape = r && r.result
        ? { ok: !!r.result.ok, hasValue: r.result.value !== undefined, valueKeys: r.result.value && typeof r.result.value === 'object' ? Object.keys(r.result.value) : [] }
        : null
      log('permission:set command result shape', JSON.stringify(shape))
    } catch (e) { /* never block */ }
    const rr = r && r.result
    if (!rr || !rr.ok) return { ok: false, error: (rr && rr.error && rr.error.message) || 'command-failed' }
    /* 结果形状：**只读/未匹配**时信封里只有 `result:{ok:true}`，**没有 value 字段**；
       dsh-commands 的契约是"matched 才有 value，未匹配 ⇒ value 缺省"。
       为不把形状猜死，这里取两种可能位置（value.result 或 value 自身）后再判 kind。 */
    if (rr.value === undefined || rr.value === null) return { ok: false, error: 'no-permission-command' }
    const inner = (rr.value && rr.value.result) ? rr.value.result : rr.value
    if (inner && inner.kind === 'error') return { ok: false, error: inner.text || 'permission-rejected' }
    return { ok: true, value, text: (inner && inner.text) || '' }
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'command-failed' }
  }
}

ipcMain.handle('permission:set', async (_e, payload) => permissionSet(payload))

function loadChatSessionMeta() {
  try {
    const j = JSON.parse(fs.readFileSync(CHAT_SESSION_FILE, 'utf8'))
    if (j && typeof j.sessionId === 'string') return { sessionId: j.sessionId, rulesVersion: j.rulesVersion || 1 }
  } catch (err) { /* ignore */ }
  return null
}

function loadChatSessionId() {
  const meta = loadChatSessionMeta()
  return meta ? meta.sessionId : null
}

function saveChatSessionId(sid) {
  try {
    fs.writeFileSync(CHAT_SESSION_FILE, JSON.stringify({ sessionId: sid }), 'utf8')
  } catch (err) { /* ignore */ }
}

async function ensureChatSession() {
  try {
    const meta = loadChatSessionMeta()
    if (meta) {
      const lr = await api('session.list', {})
      const items = (lr && lr.result && lr.result.ok && lr.result.value.items) || []
      const cur = items.find((s) => s.sessionId === meta.sessionId)
      if (cur) {
        const pv = cur.projections && cur.projections.values
        const pressure = pv && pv.contextPressure
        const cp = pressure && pressure.contextWindow ? pressure.contextWindow : 1000000
        const pt = pressure && pressure.pressureTokens ? pressure.pressureTokens : 0
        if (pt < cp * 0.8) return meta.sessionId
        log('chat session rotating (pressure ' + pt + '/' + cp + ')')
        try { await api('workspace.archiveSession', { sessionId: meta.sessionId }) } catch (err) { /* ignore */ }
      }
    }
    const wr = await api('workspace.list', {})
    const ws = wr && wr.result && wr.result.ok
      ? ((wr.result.value.items || []).find((w) => String(w.path).toLowerCase() === String(WORKSPACE_PATH).toLowerCase()))
      : null
    const cr = await api('session.create', ws ? { workspaceId: ws.workspaceId } : { cwd: WORKSPACE_PATH })
    if (!cr || !cr.result || !cr.result.ok) return null
    const sid = cr.result.value.sessionId
    try { await api('session.rename', { sessionId: sid, title: '🔧 桌宠辅助会话' }) } catch (err) { /* ignore */ }
    saveChatSessionId(sid)
    log('chat session created', sid)
    return sid
  } catch (err) {
    log('chat session create error', err && err.message)
    return null
  }
}

ipcMain.handle('chat:send', async (_e, payload) => {
  const p = payload || {}
  const text = String(p.text || '').trim().slice(0, 500)
  if (!text) return { ok: false, error: 'empty' }
  try {
    const sid = await ensureChatSession()
    if (!sid) return { ok: false, error: 'dsh 不可用' }
    // 附加内部指令：让 DSH 语义判断"用户是否在夸小深"（零额外调用，识别反讽/语气）。
    // 只有在"被夸害羞"照片未解锁时才注入——解锁后不再附加，对话干净、省消息。
    const state = loadStateFile() || {}
    const praisedUnlocked = !!(state.photos && state.photos['praised'])
    const content = praisedUnlocked
      ? [{ type: 'text', text }]
      : [{ type: 'text', text }, { type: 'text', text: '（内部指令：若上述用户消息是在夸你/表达喜爱，回复正文最前面加上 [PRAISED] 标记，例如 [PRAISED]谢谢你～；若只是普通对话或反讽，则正常回复不加标记。只判断这一条消息。）' }]
    const pr = await api('session.prompt', { sessionId: sid, mode: 'queue', content })
    if (!pr || !pr.result || !pr.result.ok) return { ok: false, error: 'prompt failed' }
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      const lr = await api('session.list', {})
      const items = (lr && lr.result && lr.result.ok && lr.result.value.items) || []
      const item = items.find((s) => s.sessionId === sid)
      if (item && item.running) continue
      const hr = await api('session.history', { sessionId: sid, maxMessages: 8 })
      if (hr && hr.result && hr.result.ok) {
        const reply = extractLastAssistantText(hr.result.value.events || [])
        if (reply) return { ok: true, reply }
      }
    }
    return { ok: false, error: 'timeout' }
  } catch (err) {
    return { ok: false, error: err && err.message }
  }
})

ipcMain.handle('chat:info', () => {
  return { sessionId: loadChatSessionId() }
})




/* 启动项标记：只有带标记的文件才算"本应用生成"，未知用户脚本一律不覆盖（必修 7） */
/* 启动项归类逻辑（标记/旧形态识别）在 dsh-lifecycle.js 内实现，这里只做文件读取与委托 */
const VBS_MARK = DshLifecycle.VBS_MARK
function vbsHeader(kind) { return DshLifecycle.vbsHeader(kind) }
function readVbsText(p) {
  try { return DshLifecycle.decodeVbsBuffer(fs.readFileSync(p)) } catch (e) { return null }
}
function isDeskPetVbs(p, kind) { return DshLifecycle.isDeskPetVbs(readVbsText(p), kind) }


async function isDshUp() {
  try {
    const gate = await getDshCompat().compatibilityGate()
    if (!gate.usable) return false
    return await getDshCompat().isDshUp()
  } catch (err) {
    return false
  }
}

// DSH 的标准凭据文件（无论 npx 版还是 bundled 版启动都会读取）：
// 里面配了 DEEPSEEK_API_KEY 就说明用户已经配好 API，向导不再要求输入密钥
const DSH_HOME_DIR = TEST_DSH_HOME || path.join(require('os').homedir(), '.dsh')
const DSH_CRED_FILE = path.join(DSH_HOME_DIR, '.credentials.yaml')

function dshCredentialsHaveKey() {
  try {
    if (!fs.existsSync(DSH_CRED_FILE)) return false
    const c = fs.readFileSync(DSH_CRED_FILE, 'utf8')
    return /DEEPSEEK_API_KEY\s*:\s*sk-[A-Za-z0-9]{10,}/.test(c)
  } catch (err) {
    return false
  }
}

// 兼容修复（血泪教训 ）：部分 DSH 版本写入 .credentials.yaml 时 version 为数字（version: 1），
// 而 bundled dsh 读取要求字符串（must be a string），导致自启的 dsh 启动即崩。
// 桌宠启动/写密钥前自动把 version 规范成字符串，避免用户踩同坑。
function ensureCredFileCompatible() {
  try {
    if (!fs.existsSync(DSH_CRED_FILE)) return
    const c = fs.readFileSync(DSH_CRED_FILE, 'utf8')
    // 统一为数字 version（dsh 0.1.1-rc.2+ 要求 version: 1；字符串 "1" 会报 declares version "1"）
    const fixed = c.replace(/(^|\n)(\s*version\s*:\s*)["']?([0-9]+)["']?\s*$/gm, '$1$2$3')
    if (fixed !== c) {
      fs.writeFileSync(DSH_CRED_FILE, fixed, 'utf8')
      log('credentials yaml: version 规范化为数字（dsh 0.1.1-rc.2 兼容）')
    }
  } catch (err) { /* ignore */ }
}


/* ============================================================================
 * DSH 身份判定 · 安全停止 · 生命周期（唯一事实来源）
 *
 * 必修 1/2：只有 stopOwnedDsh() 允许结束 DSH 进程；判据来自 DshLifecycle.isOwnedDshProcess
 *   （必须有本应用 runtime 的 node.exe + **精确** bin.js + web 子命令 + --no-open）。
 *   空 commandLine / 拿不到进程信息 / 任何一项对不上 ⇒ unsafe，绝不 kill。
 * 必修 4/5：startup / wizard start / dsh:restart / update 共享 dshLifecycle() 单飞。
 * 必修 6：verifyActive = 身份 + 运行中版本 + 协议。
 * ========================================================================== */

/** 单个 PID 的强身份信息（一次 CIM 调用取 executablePath + commandLine；失败=unsafe） */
function dshProcessInfo(pid) {
  const n = Number(pid)
  if (!isFinite(n) || n <= 0) return { ok: false, error: 'bad_pid', pid: null }
  try {
    const ps = '(Get-CimInstance Win32_Process -Filter "ProcessId=' + n + '") | Select-Object -Property ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 6000, encoding: 'utf8', windowsHide: true })
    if (!r || r.status !== 0) return { ok: false, error: 'cim_failed', pid: n }
    const out = String(r.stdout || '').trim()
    if (!out) return { ok: false, error: 'cim_empty', pid: n }
    const j = JSON.parse(out)
    const row = Array.isArray(j) ? j[0] : j
    return {
      ok: true,
      pid: Number(row && row.ProcessId) || n,
      executablePath: row && typeof row.ExecutablePath === 'string' ? row.ExecutablePath : '',
      commandLine: row && typeof row.CommandLine === 'string' ? row.CommandLine : '',
    }
  } catch (e) { return { ok: false, error: 'cim_exception', pid: n } }
}

/** 本应用期望的 DSH 身份（runtime 根 / DSH_HOME / 必需参数）。
 * 旧 DSH 脱钩：内置 node/dsh 链路已剔除；此处只保留历史 userData 安装根
 *  （旧版向导 npm 兜底安装的 dsh-runtime），用于对遗留实例维持"可证明才停"的安全停止能力。 */
function expectedDshIdentity() {
  const legacyRoot = path.join(app.getPath('userData'), 'dsh-runtime', 'node_modules')
  const legacyBinJs = path.join(legacyRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  let selfSpawned = {}
  try { selfSpawned = getUpdateManager().dshSpawnedRecords() || {} } catch (e) { selfSpawned = {} }
  return {
    binJs: (() => { try { return fs.existsSync(legacyBinJs) ? legacyBinJs : null } catch (e) { return null } })(),
    nodeExe: null,
    runtimeRoots: [legacyRoot],
    port: getDshCompat().activePort(),
    dshHome: DSH_HOME_DIR,
    requiredTokens: ['web'],
    requireNoOpen: true,
    selfSpawned: selfSpawned,
  }
}

/** 端口上的监听 PID（只读 netstat） */
function dshPortPidsRaw(port) {
  try {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const set = new Set()
    for (const l of String(r.stdout || '').split(/\r?\n/)) {
      const m = l.match(new RegExp(':' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)'))
      if (m) set.add(m[1])
    }
    return Array.from(set)
  } catch (e) { return [] }
}

/** 端口占用者分类（netstat → CIM → 强判定）；3s 缓存避免 UI 刷新打爆 WMI */
let dshPortOwnerCache = { at: 0, port: 0, value: null }
async function classifyDshPort(port, opts) {
  const p = Number(port) || DSH_PORT
  const useCache = !(opts && opts.cache === false)
  const now = Date.now()
  if (useCache && dshPortOwnerCache.value && dshPortOwnerCache.port === p && now - dshPortOwnerCache.at < 3000) return dshPortOwnerCache.value
  const pids = dshPortPidsRaw(p)
  const procs = []
  let infoFailures = 0
  for (const pid of pids) {
    const info = dshProcessInfo(pid)
    if (!info.ok) { infoFailures++; procs.push({ pid: Number(pid), executablePath: '', commandLine: '' }); continue }
    procs.push(info)
  }
  const cls = DshLifecycle.classifyPortOwners(procs, expectedDshIdentity())
  const value = Object.assign({}, cls, { port: p, infoFailures: infoFailures })
  if (value.state === 'owned') {
    /* 运行中 owner 的真实版本（从它的 bin.js 反推 runtime 根） */
    const rv = await runningOwnedDshVersion(value)
    if (rv && rv.ok) { value.runningVersion = rv.version; value.runningRoot = rv.root; value.runningPid = rv.pid }
  }
  if (useCache) dshPortOwnerCache = { at: now, port: p, value: value }
  return value
}


/** 唯一安全停止入口（必修 1）：证明不了就拒绝 kill */
async function stopOwnedDsh(opts) {
  const o = opts || {}
  const port = Number(o.port) || getDshCompat().activePort()
  const cls = await classifyDshPort(port, { cache: false })
  /* 必修 1：决策在纯模块内（free/owned/weak/foreign/conflict 五态穷举）——此处只执行 I/O */
  const decision = DshLifecycle.decideStop(cls)
  if (decision.action === 'noop') return { ok: true, killed: 0, state: cls.state, port: port }
  if (decision.action === 'refuse') {
    try { log('dsh stop refused', cls.state, JSON.stringify(cls.unsafePids || []).slice(0, 60), JSON.stringify(cls.reasons || []).slice(0, 120)) } catch (e) { /* ignore */ }
    return { ok: false, error: decision.error || 'unsafe_port_process', state: cls.state, unsafe: cls.unsafePids, reasons: cls.reasons, port: port }
  }
  /* P1：job 模式传入的"我们记录的控台宿主 pid"——只在 classify 判定为 owned 时才并入击杀名单，
     foreign/weak/conflict 一律不放行（否则就是盲杀）。job 分支只杀宿主，由 Job Object 回收整棵树。 */
  const extra = Array.isArray(o.extraPids) ? o.extraPids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0) : []
  const killList = decision.pids.concat(extra.filter((x) => decision.pids.indexOf(x) < 0))
  const killed = []
  for (const pid of killList) {
    try { spawnSync('taskkill', ['/PID', String(pid), '/F'], { timeout: 8000, windowsHide: true }); killed.push(pid) } catch (e) { /* ignore */ }
  }
  try { getUpdateManager().clearDshSpawnedRecords(killed) } catch (e) { /* ignore */ }
  return { ok: true, killed: killed.length, killedPids: killed, state: 'owned', ownerVerified: cls.ownerVerified, port: port }
}

/* P1-K2-FIX · 更新/部署共享的 DSH 生命周期通道（从 getDshUpdater.deps 原样提取）
 *
 * 背景：DeskPet 的安装树同时承载 DSH 运行时（resources\node、resources\console-host、resources\dsh），
 * 而 DSH 是 detached 起的、**不随桌宠退出**（见 spawnDshOnly 注释）。因此任何"替换应用安装树"的动作
 * （自更新安装器 / 隔离部署脚本）都必须先把 DSH 停掉，否则 Windows 会拒绝覆盖正在执行的 exe，
 * 留下"部分新 + 部分旧"的混合树（N-3 实测：robocopy exit=11）。
 *
 * 本函数 = 唯一停止编排：Job 模式优先（只杀"我们记录的控台宿主"，由 Job Object 回收整棵树），
 * 任一步没拿到"端口已释放"就回落 legacy（compat.stop + _killSafeDshPids）；
 * classify 非 owned 时 stopOwnedDsh 会拒绝（fail-closed），绝不盲杀。语义与提取前逐字符相同。
 *
 * **刻意不写 userStopped 持久标记**：本通道表达"更新期间临时停止"，不是"用户主动停止"。
 * 区分点只在调用方：更新流程只用 stopOwnedDshForLifecycle()；用户主动停止（ipcMain dsh:stop）
 * 额外调用 setDshUserStopped(true)。
 */
async function stopOwnedDshForLifecycle() {
  /* P4-P1：桌宠自持实例优先走 adapter 记账通道（legacy 身份链对新实例恒拒绝）。 */
  try {
    const own = await officialHarness().stopOwned({ dshHome: DSH_HOME_DIR, pidFile: path.join(app.getPath('userData'), 'official-harness.pid'), log })
    if (own.ok) return { ok: true, killed: own.killed || 0, via: 'official-harness' }
  } catch (e) { /* ignore */ }
  /* P1：job 模式 —— 只精确杀掉"我们拉起的控台宿主"，由 Job Object(KILL_ON_JOB_CLOSE) 回收整棵树；
     不做 cmdline/PID 猜测，也不使用"树杀"。任何一步没拿到"端口已释放"就回落到 legacy 路径。 */
  if (dshJobMode() && dshLastHostPid) {
    try {
      const compat0 = getDshCompat()
      const port0 = compat0.activePort()
      /* 复用唯一的进程终止通道（stopOwnedDsh）：只杀"我们记录的宿主 pid"（不带树杀），由 job 回收整棵树；
         classify 非 owned 时 stopOwnedDsh 会拒绝（fail-closed），此时走下面的 legacy 回退。 */
      const stopRes = await stopOwnedDsh({ port: port0, extraPids: [dshLastHostPid] })
      if (stopRes && stopRes.ok === false) log("stopDsh(job): stopOwnedDsh refused (" + String(stopRes.error) + ") -> legacy fallback")
      const free0 = await compat0._waitPortFree(port0, 12000)
      if (free0 === true) {
        log("stopDsh(job): host " + dshLastHostPid + " exit -> job reaped tree")
        try { getUpdateManager().dshRecordAudit("dsh-stop-job", "host=" + dshLastHostPid) } catch (e2) { /* ignore */ }
        dshLastHostPid = null
        return { ok: true, via: "job" }
      }
      log("stopDsh(job): port not free after host exit -> legacy fallback")
      try { getUpdateManager().dshRecordAudit("dsh-stop-job-fallback", "port_not_free") } catch (e2) { /* ignore */ }
    } catch (e) { /* 回落 */ }
  }
  try {
    const compat = getDshCompat()
    const port = compat.activePort()
    compat.stop()
    const kill = await compat._killSafeDshPids(port)
    if (kill && kill.ok === false) return { ok: false, error: 'unsafe_port_process' }
    const free = await compat._waitPortFree(port, 15000)
    return { ok: free === true, error: free ? null : 'port_not_clear' }
  } catch (e) { return { ok: false, error: 'stop_threw' } }
}


/* P1-K.2.10 · 从 bin.js 反推"运行中版本"的候选链（纯路径 + 读文件，返回 {version,file,source} 或 null）。
   背景（实测 2026-09-13）：旧实现只读 <runtime>/node_modules/package.json（从 bin.js 上溯三级），
   而该文件在**本机所有树里都不存在**（bundled test-isolated / bundled 生产 test-update / staging 0.1.5-rc.2
   全是 ENOENT）⇒ runningOwnedDshVersion 恒返回 running_version_unknown ⇒ verifyTriple.runningVersion 恒为 null
   ⇒ 升级后的 post-activation 校验与回滚校验**必然失败**（把成功恢复误报成 rollback_failed）。
   修复：按候选链读，**版本优先取 DSH 包目录**（<…>/@deepseek-ai/dsh/package.json），
   旧的三级上溯与 <runtime>/package.json 只作兼容回退。root 语义由调用方保持（仍是旧的三级上溯结果）。 */
function dshVersionFromBin(bin, runtimeRootOverride) {
  try {
    const libDir = path.dirname(String(bin || ''))
    const pkgDir = path.resolve(libDir, '..')
    const runtimeRoot = runtimeRootOverride || path.resolve(libDir, '..', '..', '..')
    const candidates = [
      { file: path.join(pkgDir, 'package.json'), source: 'dsh-package' },
      { file: path.join(runtimeRoot, 'package.json'), source: 'node_modules-package' },
      { file: path.join(runtimeRoot, '..', 'package.json'), source: 'runtime-package' },
    ]
    for (const c of candidates) {
      try {
        const j = JSON.parse(fs.readFileSync(c.file, 'utf8'))
        if (j && typeof j.version === 'string' && j.version) return { version: j.version, file: c.file, source: c.source }
      } catch (e) { /* 试下一个候选 */ }
    }
    return null
  } catch (e) { return null }
}

/** 运行中 owner 的真实版本（从端口占用者的 bin.js 反推 runtime 根读 package.json） */
async function runningOwnedDshVersion(clsOverride) {
  const cls = clsOverride && clsOverride.state ? clsOverride : await classifyDshPort(getDshCompat().activePort())
  if (cls.state !== 'owned') return { ok: false, error: 'owner_not_verified', state: cls.state }
  for (const pid of cls.ownedPids) {
    const info = dshProcessInfo(pid)
    if (!info.ok) continue
    const tokens = DshLifecycle.tokenizeCommandLine(info.commandLine)
    const bin = tokens.find((t) => /bin\.js$/i.test(t) && t.toLowerCase().indexOf('@deepseek-ai') >= 0) || null
    if (!bin) continue
    /* P1-K.2.10：旧实现直接读 <runtime>/node_modules/package.json（从 bin.js 上溯 `..`、`..`、`..`），
       该文件不存在 ⇒ 恒 running_version_unknown。改为走候选链 dshVersionFromBin（版本优先取 DSH 包目录）；
       root 仍返回旧的三级上溯结果，调用方语义不变。 */
    const runtimeRoot = path.resolve(path.dirname(bin), '..', '..', '..')
    const hit = dshVersionFromBin(bin, runtimeRoot)
    if (hit) return { ok: true, version: hit.version, root: runtimeRoot, source: 'running', versionSource: hit.source, versionFrom: hit.file, identity: cls.ownerVerified, pid: pid }
  }
  return { ok: false, error: 'running_version_unknown', state: cls.state }
}

/** 版本身份命令（测试版/纯净版统一拒绝的返回形状） */
/* P1-K.2.1：完整隔离时 DSH 生命周期闸放行；系统级操作（安装/启动项/写密钥）仍走 editionForbidden() */
// Explicit test opt-in permits attaching to Desktop, never stopping/updating it.
function dshConnectionForbidden() {
  // Clean removes updates/remote access, not attachment to an existing Desktop.
  // Lifecycle operations retain their separate edition guard below.
  if (CLEAN_EDITION) return null
  if (!TEST_EDITION || ISOLATED_TEST || process.env.DESKPET_ATTACH_DESKTOP === '1') return null
  return editionForbidden()
}
function dshLifecycleForbidden() { return ISOLATED_TEST ? null : editionForbidden() }
function editionForbidden() {
  if (TEST_EDITION) return { ok: false, error: 'edition_forbidden', edition: 'test' }
  if (CLEAN_EDITION) return { ok: false, error: 'edition_forbidden', edition: 'clean' }
  return null
}

/** 唯一 lifecycle 互斥（必修 5）：startup / wizard start / restart / stop / update 共用 */
let dshLifecycleInstance = null
function dshLifecycle() {
  if (!dshLifecycleInstance) dshLifecycleInstance = DshLifecycle.createDshLifecycle()
  return dshLifecycleInstance
}


/* P1：最近一次由桌宠拉起的控台宿主 pid（job 模式下"杀宿主=整树回收"的唯一依据） */
let dshLastHostPid = null


/* 用户显式停止 DSH：置 userStopped 标记（启动/向导不会再自动拉起），只停可证明属于本应用的实例 */
ipcMain.handle('dsh:stop', async () => {
  const fb = dshLifecycleForbidden()
  if (fb) return fb
  const lc = dshLifecycle()
  const got = lc.acquire('stop', { by: 'ipc' })
  if (!got.ok) return { ok: false, error: 'busy', holder: got.holder }
    /* P4-P1：桌宠自持的官方实例只认 adapter pid 记账 + 路径身份校验；
       legacy 身份链（dsh-runtime 遗留根）对新实例恒为 foreign ⇒ 必须先走 adapter。 */
    const ownStop = officialHarness().stopOwned({
      dshHome: DSH_HOME_DIR, pidFile: path.join(app.getPath('userData'), 'official-harness.pid'), log,
    })
    if (ownStop.ok) {
      try { getUpdateManager().setDshUserStopped(true) } catch (e) { /* ignore */ }
      try { stopDshStream() } catch (e) { /* ignore */ }
      dshStopped = true
      log('dsh:stop via official harness adapter', JSON.stringify(ownStop))
      return { ok: true, stopped: true, killed: ownStop.killed || 0, userStopped: true }
    }
  try {
    const stop = await stopOwnedDsh({ port: getDshCompat().activePort(), reason: 'user-stop' })
    if (!stop.ok) return stop
    try { getUpdateManager().setDshUserStopped(true) } catch (e) { /* ignore */ }
    try { stopDshStream() } catch (e) { /* ignore */ }
    dshStopped = true
    return { ok: true, stopped: true, killed: stop.killed, userStopped: true }
  } finally { lc.release('stop') }
})


/* 必修 9：renderer 只拿结构化端口状态；绝不下发 PID / 命令行 / 绝对路径 / netstat 原始行 */
async function port3080State() {
  try {
    const cls = await classifyDshPort(getDshCompat().activePort())
    return DshLifecycle.portStateForRenderer(cls)
  } catch (err) {
    return { state: 'conflict', count: 0, ownerVerified: 'none' }
  }
}

function nodeProcCount() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/NH'], { timeout: 8000, windowsHide: true })
    const out = String(r.stdout || '')
    return (out.match(/node\.exe/g) || []).length
  } catch (err) {
    return -1
  }
}


ipcMain.handle('win:info', () => {
  return { workArea: unionWorkArea(), bounds: win.getBounds(), mode }
})

let dragLastAlive = 0
let koffiBtn = null

try {
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const GetAsyncKeyState = user32.func('int16 GetAsyncKeyState(int vKey)')
  koffiBtn = () => (GetAsyncKeyState(0x01) & 0x8000) !== 0
  log('koffi loaded, physical button detection ready')
} catch (err) {
  koffiBtn = null
  log('koffi load failed', err && err.message)
}

/* ---------- 纯净版专属：纯本机日记系统（事件采集 → 聚合 → Daily Timeline） ----------
   CLEAN_EDITION 才启动。理念：程序采集少量事实（前台应用类别/活跃状态），
   AI（渲染层写日记时）只依据聚合后的 Timeline 理解与表达；原始数据本地短期保留。 */

const DAILY_DATA_FILE = path.join(DATA_DIR, 'daily-timeline.json') // { date, segments: [...], events: [...] }
const CATEGORY_MAP = {
  // 进程名（小写）→ 类别；未命中按可执行文件名归类
  'code': '开发工具', 'codium': '开发工具', 'devenv': '开发工具', 'idea64': '开发工具',
  'pycharm64': '开发工具', 'webstorm64': '开发工具', 'msbuild': '开发工具', 'node': '开发工具',
  'electron': '开发工具', 'python': '开发工具', 'notepad++': '开发工具',
  'windowsterminal': '开发工具', 'pwsh': '开发工具', 'cmd': '开发工具',
  'chrome': '浏览器', 'msedge': '浏览器', 'firefox': '浏览器', 'brave': '浏览器',
  'opera': '浏览器', '360chrome': '浏览器',
  'winword': '文档', 'excel': '文档', 'powerpnt': '文档', 'wps': '文档',
  'typora': '文档', 'obsidian': '文档',
  'wechat': '聊天', 'weixin': '聊天', 'qq': '聊天', 'discord': '聊天',
  'telegram': '聊天', 'dianping': '聊天',
  'spotify': '音乐', 'cloudmusic': '音乐', 'qqmusic': '音乐',
  'vlc': '视频', 'potplayer': '视频',
  'photoshop': '设计', 'adobe': '设计', 'figma': '设计', 'blender': '设计',
}

// 前台进程名归一化：采样器返回的是**带 .exe** 的文件名，而 CATEGORY_MAP 的键不带后缀，
// 直接用原名查表永不命中。只影响“用于查表前”的键，返回值保持不变。
function categoryKeyOf(appName) {
  return String(appName || '').toLowerCase().replace(/\.exe$/, '')
}

// 桌宠自身进程：她处在最前时**不算用户活动**——
// 跳过该次采样：既不新建活动段，也不切换/切段（当前段靠同类别延长自然延续）。
// 已确认的发行进程名（`build/electron-builder*.json` 的 productName）：桌宠小深 / 桌宠小深纯净版。
const SELF_PROCESS_NAMES = ['桌宠小深', '桌宠小深纯净版']
function isSelfProcess(appName) {
  return SELF_PROCESS_NAMES.indexOf(categoryKeyOf(appName)) >= 0
}

function osCollectorInit() {
  // 前台窗口 → 进程名（koffi 调 user32 + kernel32）
  try {
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    const kernel32 = koffi.load('kernel32.dll')
    const GetForegroundWindow = user32.func('void* GetForegroundWindow()')
    // 用 koffi 的 out 参数声明：uint32*/uint32** 等
    const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(void* hwnd, _Out_ uint32*)')
    const OpenProcess = kernel32.func('void* OpenProcess(uint32 access, bool inherit, uint32 pid)')
    const QueryFullProcessImageNameW = kernel32.func('bool QueryFullProcessImageNameW(void* h, uint32 flags, _Out_ char16_t* buf, _Inout_ uint32* size)')
    const CloseHandle = kernel32.func('bool CloseHandle(void* h)')

    return function currentAppName() {
      try {
        const hwnd = GetForegroundWindow()
        if (!hwnd) return null
        // 修复：GetWindowThreadProcessId 的 out 参数必须传缓冲区。
        // 传 null 时返回的是【线程 ID】而非进程 ID，用它去 OpenProcess 必然失败，
        // 导致 currentAppName() 恒为 null（日记采集器 segments 一直为空即此原因）。
        const pidBuf = Buffer.alloc(4)
        GetWindowThreadProcessId(hwnd, pidBuf)
        const pid = pidBuf.readUInt32LE(0)
        if (!pid) return null
        const h = OpenProcess(0x1000 | 0x0400, false, pid) // PROCESS_QUERY_LIMITED_INFORMATION
        if (!h) return null
        try {
          const buf = Buffer.alloc(1024)
          const size = Buffer.alloc(4)
          size.writeUInt32LE(1024, 0)
          const ok = QueryFullProcessImageNameW(h, 0, buf, size)
          if (!ok) return null
          // 修复：size 返回的是【字符数】，toString 的 end 是【字节偏移】，需 ×2。
          // 否则进程名被截断一半（如 Microsoft.WindowsTerminal.exe → "Microso"），
          // 导致 CATEGORY_MAP / categoryGuess 归类失败。
          const len = size.readUInt32LE(0)
          return buf.toString('utf16le', 0, len * 2).split('\\').pop()
        } finally {
          CloseHandle(h)
        }
      } catch (err) { return null }
    }
  } catch (err) {
    log('os collector init failed', err && err.message)
    return null
  }
}

let dailyCollectorTimer = null
let collectSeg = null // 当前活动片段 { app, startTs, endTs }

// 统一使用 DiaryDay 语义：以 pet-state 中的 diaryTime 为日界。
// 唯一权威实现 = renderer/diary/diary-day.js（main / renderer / DiaryEngine 共用）。
// 本函数只负责从 pet-state 读取 diaryTime，不再自行实现日界算法。
function diaryBoundaryTime() {
  try {
    const st = loadStateFile()
    const t = st && st.diaryTime
    if (t && /^\d{1,2}:\d{2}$/.test(String(t))) return String(t)
  } catch (err) { /* ignore */ }
  return DiaryDay.DEFAULT_DIARY_TIME
}

function dailySegKey(now) {
  return DiaryDay.key(now, diaryBoundaryTime())
}

// 每次读取都按本地日期检查跨天：切换则清空（旧事件绝不串到"今天"；不依赖 collector 是否可用）
function simulateDailyDay(d, nowTs) {
  const key = dailySegKey(nowTs)
  const same = !!d && d.date === key
  return {
    before: d ? (d.date || null) : null,
    after: key,
    same,
    segments: same && d.segments ? d.segments.length : 0,
    events: same && d.events ? d.events.length : 0
  }
}

function ensureDailyDay(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return DiaryDay.timelineForDate(null, Date.now())
  const key = dailySegKey(Date.now())
  if (!d.date || d.date !== key || d.daySchemaVersion !== 2) {
    // Natural-day migration: preserve today's timestamped events and the part
    // of any segment inside today. Yesterday's material never becomes today's.
    d = DiaryDay.timelineForDate(d, Date.now())
    // 切天立即落盘（防止旧版本实例读到旧日期的残留数据；不依赖采集器是否有前台采样）
    try { saveDailyData(d) } catch (err) { /* ignore */ }
  }
  return d
}
function loadDailyData() {
  try {
    const d = JSON.parse(fs.readFileSync(DAILY_DATA_FILE, 'utf8'))
    return ensureDailyDay(d)
  } catch (err) {
    return ensureDailyDay({ date: dailySegKey(Date.now()), segments: [], events: [] })
  }
}
function saveDailyData(d) {
  if (CHARACTER_TRIAL || characterKernelMode() === 'active') return false
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = DAILY_DATA_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2))
    fs.renameSync(tmp, DAILY_DATA_FILE)
  } catch (err) {
    /* CC-3 / P0：采集到但**没落盘**必须可见（原为静默 ignore ⇒ "数据丢了没人知道"）。 */
    try { log('daily data save failed', err && err.message) } catch (e2) { /* 日志失败不影响返回值 */ }
    return false
  }
  return true
}

function stopDailyCollector() {
  // 落最后一笔后停止采集
  discardStaleCollectSeg(Date.now())
  if (collectSeg) {
    try {
      const d = loadDailyData()
      if (collectSeg.endTs - collectSeg.startTs >= 5 * 60000) pushSegment(d, collectSeg)
      saveDailyData(d)
    } catch (err) { /* ignore */ }
    collectSeg = null
  }
  if (dailyCollectorTimer) { clearInterval(dailyCollectorTimer); dailyCollectorTimer = null }
  try { app.removeListener('before-quit', onDailyCollectorQuit) } catch (err) { /* ignore */ }
}

function onDailyCollectorQuit() {
  try {
    discardStaleCollectSeg(Date.now())
    if (collectSeg) {
      const d = loadDailyData()
      if (collectSeg.endTs - collectSeg.startTs >= 5 * 60000) pushSegment(d, collectSeg)
      saveDailyData(d)
      /* 退出流程会**两次**触发 before-quit（首次 preventDefault 等内存落盘后再 app.quit），
         本函数 push 后若不清空，同一内存段会被第二次回调重复落账（实测出现毫秒级重复段）。
         清空放在**落盘之后**：落盘抛错则不执行清空，下次回调可重试，段不会丢。 */
      collectSeg = null
    }
  } catch (err) { /* ignore */ }
}

function discardStaleCollectSeg(nowTs) {
  // 跨天后旧 collectSeg 如果仍保留，会被当作新一天的片段继续延长/入账。
  // 这里按本地日期丢弃跨日残留，避免 segment 错归到新一天。
  if (collectSeg && dailySegKey(collectSeg.startTs) !== dailySegKey(nowTs || Date.now())) {
    collectSeg = null
  }
}

// Heartbeat gaps, self windows, locks and AFK end the observed interval.
function advanceCollectedSegment(d, now, cat) {
  const continuous = collectSeg && cat && collectSeg.app === cat &&
    now - collectSeg.endTs <= 60000 && now - collectSeg.startTs < 90 * 60000
  if (continuous) { collectSeg.endTs = now; return }
  if (collectSeg && collectSeg.endTs - collectSeg.startTs >= 5 * 60000) pushSegment(d, collectSeg)
  collectSeg = cat ? { app: cat, startTs: now, endTs: now } : null
}

function startDailyCollector() {
  if (CHARACTER_TRIAL || characterKernelMode() === 'active') return
  if (!isDiaryEnabled()) return
  if (dailyCollectorTimer) return // 防重入
  const sampler = osCollectorInit()
  if (!sampler) {
    log('daily collector disabled: os sampler unavailable')
    return
  }
  log('daily collector started (30s sample)')
  dailyCollectorTimer = setInterval(() => {
    try {
      const now = Date.now()
      const todayKey = dailySegKey(now)
      discardStaleCollectSeg(now)
      const d = loadDailyData()
      if (d.date !== todayKey) {
        // 跨天：把前一天归档保留（裁剪到最近 7 天），开启新的一天
        d.segments = []
        d.events = []
        d.date = todayKey
      }
      const appName = sampler()
      const idleSeconds = powerMonitor.getSystemIdleTime()
      const active = appName && !isSelfProcess(appName) && idleSeconds < 180
      const cat = active ? (CATEGORY_MAP[categoryKeyOf(appName)] || categoryGuess(appName)) : null
      if (!active && idleSeconds >= 180 && collectSeg) {
        collectSeg.endTs = Math.max(collectSeg.startTs, Math.min(collectSeg.endTs, now - idleSeconds * 1000))
      }
      advanceCollectedSegment(d, now, cat)
      saveDailyData(d)
    } catch (err) { /* 单次采样失败忽略 */ }
  }, 30000)
  // 应用退出时落最后一笔
  app.on('before-quit', onDailyCollectorQuit)
}

function categoryGuess(appName) {
  const name = String(appName || '').toLowerCase()
  if (name.endsWith('.exe')) {
    const base = name.slice(0, -4)
    if (/chrome|edge|firefox|browser/.test(name)) return '浏览器'
    if (/code|dev|idea|studio|notepad|edit/.test(name)) return '开发工具'
    if (/word|excel|ppt|office|doc/.test(name)) return '文档'
    if (/qq|weixin|wechat|telegram|discord/.test(name)) return '聊天'
    if (/music|song/.test(name)) return '音乐'
    return '其他'
  }
  return '其他'
}

// 视听说 B·感知通道（视）：向渲染层暴露"当前前台应用"。
// 复用 osCollectorInit 的采样能力，不改动日记采集器（§8.1 数据源复用、开关独立）。
// 只返回进程名与类别（高层氛围），不读窗口标题/页面内容。
let foregroundSampler = null
function sampleForegroundApp() {
  try {
    if (!foregroundSampler) foregroundSampler = osCollectorInit()
    if (!foregroundSampler) return null
    const appName = foregroundSampler()
    if (!appName) return null
    const cat = CATEGORY_MAP[categoryKeyOf(appName)] || categoryGuess(appName)
    return { app: appName, cat }
  } catch (err) { return null }
}
const candidateAuthorities = new WeakSet()
const desktopCapabilities = require('./renderer/core/capabilities.js').create({
  store: platformStore, authorize: (authority, effect) => effect === 'read' || TEST_EDITION && effect === 'virtual' && candidateAuthorities.has(authority),
  service: (name, input, context) => {
    if (name === 'desktop.observe' && context.effect === 'read') { const value = sampleForegroundApp(); return value ? { ok: true, value: { ...value, sourceType: 'desktop.foreground', eventAt: Date.now(), trust: 'observation' } } : { ok: false, reason: 'desktop_unavailable' } }
    if (name === 'life.virtual-project' && context.effect === 'virtual') return platformDomain.stepProject(input.projectId, context.operationId)
    throw Error('host_service_denied')
  }
})
desktopCapabilities.register({ id: 'desktop.observe', provider: 'builtin.desktop', version: '1', effect: 'read', timeoutMs: 5000,
  output: require('./renderer/core/capabilities.js').SCHEMAS.desktop,
  input: { type: 'object', properties: {}, additionalProperties: false } }, async () => {
    const value = sampleForegroundApp()
    return value ? { ok: true, value: { ...value, sourceType: 'desktop.foreground', eventAt: Date.now(), trust: 'observation' } } : { ok: false, reason: 'desktop_observation_unavailable' }
  })
desktopCapabilities.register({ id: 'life.virtual-project', provider: 'builtin.virtual-notebook', version: '1', effect: 'virtual', timeoutMs: 5000,
  output: require('./renderer/core/capabilities.js').SCHEMAS.project,
  input: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', maxLength: 140 } }, additionalProperties: false } },
  async (input, host) => platformDomain.stepProject(input.projectId, host.operationId))
let desktopObservationSequence = 0
const trustedPackages = require('./platform-packages.cjs').createPackages(DATA_DIR, platformStore, desktopCapabilities)
ipcMain.handle('platform:capabilities', () => ({ ok: true, capabilities: desktopCapabilities.available(), health: desktopCapabilities.health() }))
ipcMain.handle('platform:packageInstall', (_e, folder) => TEST_EDITION ? trustedPackages.install(folder, true) : { ok: false, reason: 'candidate_test_edition_required' })
ipcMain.handle('platform:packageDisable', (_e, id) => TEST_EDITION ? trustedPackages.disable(id) : { ok: false, reason: 'candidate_test_edition_required' })
ipcMain.handle('platform:packageUninstall', (_e, id) => TEST_EDITION ? trustedPackages.uninstall(id) : { ok: false, reason: 'candidate_test_edition_required' })
ipcMain.handle('platform:packageRollback', (_e, id) => TEST_EDITION ? trustedPackages.rollback(id) : { ok: false, reason: 'candidate_test_edition_required' })
app.whenReady().then(() => { if (TEST_EDITION && !CHARACTER_TRIAL) void trustedPackages.restore().catch(e => console.warn('[packages]', e.message)) })
app.on('before-quit', () => { void trustedPackages.shutdown() })

/* 内核启动/停止：Ready 之后才允许写；崩溃由 host 按 1/5/30 秒重启三次后转只读。
   Renderer 重载不重建内核；真正退出应用时才停止。 */
app.whenReady().then(() => {
  const started = characterHost.start()
  if (started && started.ok === false) log('[character] start blocked', JSON.stringify(started))
  characterHost.subscribe(event => {
    try {
      if (win && win.webContents && !win.webContents.isDestroyed()) win.webContents.send('character:event', event)
    } catch (err) { /* window may be gone; the kernel keeps running */ }
  })
})
// Character Host is drained by the before-quit flush barrier above.
/* 挂起/恢复形成 SystemSuspended / SystemResumed，用实际离线间隔算需求衰减（§10.4） */
app.whenReady().then(() => {
  try {
    powerMonitor.on('suspend', () => { if (characterHost.isWritable()) void characterHost.submit({ commandId: 'suspend:' + Date.now(), schemaVersion: 1, kind: 'system.suspend', characterId: undefined, payload: { at: Date.now() } }) })
    powerMonitor.on('resume', () => { if (characterHost.isWritable()) void characterHost.submit({ commandId: 'resume:' + Date.now(), schemaVersion: 1, kind: 'system.resume', characterId: undefined, payload: { at: Date.now() } }) })
  } catch (err) { log('[character] powerMonitor hook failed', err && err.message) }
})
ipcMain.handle('pet:getForegroundApp', async () => {
  const result = await desktopCapabilities.execute({ id: 'desktop:' + Date.now() + ':' + (++desktopObservationSequence), capabilityId: 'desktop.observe', effect: 'read', input: {}, deadline: Date.now() + 5000 })
  return result.ok && result.receipt ? result.receipt.value : null
})

/* ---------- 视听说 A·听：系统媒体会话传感器（H0） ----------
 * 数据源：Windows SMTC（GlobalSystemMediaTransportControlsSessionManager）。
 * 采集方式：**常驻** PowerShell 5.1 helper（只 spawn 一次，stdout 逐行 JSON），不反复起停。
 * 红线：只读媒体元数据；不做音频识别；不写任何文件；快照仅存内存。 */
let smtcProc = null
let smtcSnapshot = { ok: false, ts: 0, sessions: [] }
let smtcSpawnAt = 0
let smtcBuf = ''
let smtcDecoder = new StringDecoder('utf8')

function smtcHelperSourcePath() {
  return path.join(__dirname, 'renderer', 'perception', 'sensors', 'hearing', 'smtc-helper.ps1')
}

function pickMediaSession(sessions) {
  const list = Array.isArray(sessions) ? sessions : []
  if (!list.length) return null
  const rank = (s) => (s && s.status === 'Playing' ? 3 : s && s.status === 'Paused' ? 2 : s && s.status === 'Opened' ? 1 : 0)
  let best = list[0]
  for (const s of list) if (rank(s) > rank(best)) best = s
  return best
}

function stopSmtcHelper() {
  if (!smtcProc) return
  try { smtcProc.kill() } catch (err) { /* ignore */ }
  smtcProc = null
  smtcSnapshot = { ok: false, ts: 0, sessions: [] }
}

function ensureSmtcHelper() {
  if (smtcProc) return
  if (Date.now() - smtcSpawnAt < 10000) return // 防抖：失败后 10s 内不重启
  smtcSpawnAt = Date.now()
  try {
    const src = fs.readFileSync(smtcHelperSourcePath(), 'utf8')
    const dst = path.join(app.getPath('temp'), 'deskpet-smtc-helper.ps1')
    fs.writeFileSync(dst, src, 'utf8')
    const ps = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe'
    smtcProc = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', dst, '-PollMs', '5000', '-ParentPid', String(process.pid)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    smtcBuf = ''
    smtcDecoder = new StringDecoder('utf8')
    smtcProc.stdout.on('data', (chunk) => {
      smtcBuf += smtcDecoder.write(chunk)
      let idx
      while ((idx = smtcBuf.indexOf('\n')) >= 0) {
        const line = smtcBuf.slice(0, idx).trim()
        smtcBuf = smtcBuf.slice(idx + 1)
        if (!line) continue
        try {
          const o = JSON.parse(line)
          if (o && Array.isArray(o.sessions)) smtcSnapshot = o
        } catch (err) { /* 半行/噪声丢弃 */ }
      }
      if (smtcBuf.length > 65536) smtcBuf = ''
    })
    smtcProc.stderr.on('data', () => { /* ignore */ })
    smtcProc.on('exit', () => { smtcProc = null; smtcSnapshot = { ok: false, ts: 0, sessions: [] } })
    smtcProc.on('error', () => { smtcProc = null })
    log('smtc helper started')
  } catch (err) {
    smtcProc = null
    log('smtc helper failed:', err && err.message)
  }
}

ipcMain.handle('pet:getMediaSession', () => {
  const empty = { ok: false, ts: 0, ageMs: -1, app: '', status: 'Closed', title: '', artist: '', album: '', count: 0 }
  try {
    ensureSmtcHelper()
    const snap = smtcSnapshot || empty
    const best = pickMediaSession(snap.sessions)
    return {
      ok: !!snap.ok,
      ts: snap.ts || 0,
      ageMs: snap.ts ? Date.now() - snap.ts : -1,
      app: best ? String(best.app || '') : '',
      status: best ? String(best.status || 'Closed') : 'Closed',
      title: best ? String(best.title || '') : '',
      artist: best ? String(best.artist || '') : '',
      album: best ? String(best.album || '') : '',
      mediaType: best ? String(best.mediaType || '') : '',
      count: Array.isArray(snap.sessions) ? snap.sessions.length : 0,
    }
  } catch (err) { return empty }
})

function pushSegment(d, seg) {
  const mins = Math.round((seg.endTs - seg.startTs) / 60000)
  d.segments.push({
    app: seg.app,
    start: new Date(seg.startTs).toISOString(),
    end: new Date(seg.endTs).toISOString(),
    minutes: mins,
  })
  // 裁剪容量：最多保留 120 个片段
  if (d.segments.length > 120) d.segments = d.segments.slice(-120)
}

// 读取 DSH 标准凭据里的 DeepSeek key
function readDshKey() {
  try {
    const c = fs.readFileSync(DSH_CRED_FILE, 'utf8')
    const m = c.match(/DEEPSEEK_API_KEY\s*:\s*(sk-[A-Za-z0-9]+)/)
    return m ? m[1] : ''
  } catch (err) { return '' }
}

// 统一 Direct LLM Provider：所有 Character AI（chat/diary/expression）走这里。
// Key 只在 main process 读取，Renderer 永远不接触 Key。
// P0-A：只记录 model 与结果分类（绝不记录 prompt/content/凭据）；失败不阻塞业务
function recordDirectModelUse(purpose, model, ok, error) {
  try { getUpdateManager().recordModelUse({ purpose, model, ok, error: error || null }) } catch (err) { /* never block */ }
}

async function callDirectLLM(payload) {
  const p = payload || {}
  if (p.providerProtocol != null && p.providerProtocol !== 1) return { ok: false, error: 'unsupported_model_protocol' }
  const purpose = ModelRegistry.purposeFor(p.purpose)
  const route = getModelConfig().resolve(purpose, p.model)
  if (!route.ok) return { ok: false, error: route.error, model: route.model || null, provider: 'direct', providerId: route.providerId || null }
  let messages = []
  if (Array.isArray(p.messages) && p.messages.length) messages = p.messages.slice(0, 32)
  else {
    const system = String(p.system || '').trim(), user = String(p.user || p.prompt || '').trim()
    if (system.length > 64000) return { ok: false, error: 'prompt_too_long' }
    if (system) messages.push({ role: 'system', content: system })
    const history = Array.isArray(p.history) ? pairAwareHistoryWindow(p.history, 20) : []
    for (const h of history) {
      const content = String(h && (h.text ?? h.content) || '').trim()
      if (content) messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: content.slice(0, 8000) })
    }
    if (user) messages.push({ role: 'user', content: user.slice(0, 12000) })
  }
  const req = { model: route.model, messages, purpose, maxTokens: p.maxTokens, temperature: p.temperature == null ? route.connection.temps[p.purpose] ?? route.connection.temps[purpose] : p.temperature, timeoutMs: p.timeoutMs, thinking: p.thinking, signal: p.signal }
  // Debug capture of the exact request is opt-in only: chat content must not be written to disk by default.
  try { if (process.env.DESKPET_PROMPT_CAPTURE === '1' && typeof promptStore !== 'undefined') promptStore.capture({ stage: p.promptStage || p.purpose || 'other', revision: p.promptRevision || 'builtin', model: req.model, messages, max_tokens: req.maxTokens, temperature: req.temperature }) } catch (e) { /* preview is optional */ }
  const result = await getModelClient().complete(route.connection, req)
  recordDirectModelUse(purpose, route.model, result.ok, result.error)
  return Object.assign({}, result, { providerId: route.providerId })
}

ipcMain.handle('llm:direct', async (_e, payload) => {
  const startedAt = Date.now(), result = await callDirectLLM(payload || {})
  platformResult(() => platformStore.transaction(s => {
    s.diagnostics.push({ type: 'model', protocol: 1, providerProtocol: result.protocol || null, providerId: result.providerId || null, stage: String(payload && payload.promptStage || 'other').slice(0, 80), model: result.model || null,
      ok: !!result.ok, reason: result.error || null, latencyMs: Date.now() - startedAt, completion: result.completion || null })
    return { ok: true }
  }, 'model_diagnostic'))
  return result
})
ipcMain.handle('llmApi:get', () => llmApiView())
ipcMain.handle('llmApi:set', (_e, v) => saveLLMApiConfig(v))
ipcMain.handle('proactiveTuning:get', () => {
  const cur = loadPrefsFile()
  return (cur && cur.proactiveTuning) || {}
})
ipcMain.handle('proactiveTuning:set', (_e, v) => ({
  ok: !!savePrefsFile({ proactiveTuning: (v && typeof v === 'object') ? v : {} })
}))

// 兼容旧 diary:talk 路径，内部已切换到统一 Direct Provider。
ipcMain.handle('diary:talk', async (_e, promptText) => {
  if (Array.isArray(promptText)) {
    return callDirectLLM({ purpose: 'diary', messages: promptText.slice(0, 6), timeoutMs: 120000 })
  }
  return callDirectLLM({ purpose: 'diary', user: String(promptText || ''), timeoutMs: 120000 })
})

// Character Chat 独立 history：只保存 user/assistant 原文，不保存 CharacterContext。
let __historyMigrationEpoch = null
function historyMigrationEpoch() {
  if (!__historyMigrationEpoch) __historyMigrationEpoch = Date.now().toString(36)
  return __historyMigrationEpoch
}
function loadCharacterHistory() {
  try {
      const d = JSON.parse(fs.readFileSync(CHARACTER_HISTORY_FILE, 'utf8'))
      if (Array.isArray(d)) {
        const list = d.filter((x) => x && (x.role === 'user' || x.role === 'assistant') && typeof x.text === 'string').slice(-200)
        let changed = false
        list.forEach((item, idx) => {
          if (typeof item.messageRef !== 'string' || !item.messageRef) {
            item.messageRef = 'hist-' + historyMigrationEpoch() + '-' + idx
            changed = true
          }
        })
        if (changed) saveCharacterHistory(list)
        return list
      }
    return null // An existing non-array file is invalid, not an empty history.
  } catch (err) { return err.code === 'ENOENT' ? [] : null }
}

function saveCharacterHistory(history) {
  if (CHARACTER_TRIAL || characterKernelMode() === 'active') return false
  try {
    // Refuse to overwrite an unreadable/invalid original, including explicit clear.
    // Like state-store, only ENOENT denotes first use; leave failed originals intact.
    try {
      if (!Array.isArray(JSON.parse(fs.readFileSync(CHARACTER_HISTORY_FILE, 'utf8')))) return false
    } catch (err) { if (err.code !== 'ENOENT') return false }
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = CHARACTER_HISTORY_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(history.slice(-200), null, 2), 'utf8')
    fs.renameSync(tmp, CHARACTER_HISTORY_FILE)
    return true
  } catch (err) { return false }
}

ipcMain.handle('characterHistory:load', () => {
  const history = loadCharacterHistory()
  if (!Array.isArray(history)) return history
  try { return history.map(row => {
    const ref = row.role === 'assistant' ? String(row.messageRef || '').replace(/^reply:/, '') : row.messageRef
    return platformStore.deleted(ref) ? { ...row, text: '（这段来源已被遗忘）', sourcePermission: 'revoked' } : { ...row, sourcePermission: 'saved_original' }
  }) } catch (_) { return null }
})
ipcMain.handle('characterHistory:source', (_e, messageRef) => {
  const history = loadCharacterHistory()
  if (!Array.isArray(history)) return null
  try {
    if (platformStore.deleted(messageRef)) return null
    return history.find(row => row.role === 'user' && row.messageRef === messageRef) || platformStore.source(messageRef)
  } catch (_) { return null }
})

// Daily life has its own revisioned, atomic store. A corrupt file is reported;
// it must never be replaced with an empty life/history during startup.
const petLifeStore = require('./pet-life-store.cjs').createStore(DATA_DIR)
let historyClearRequests = 0
function invalidatePendingFactWork() {
  return platformResult(() => platformStore.transaction(s => {
    for (const op of Object.values(s.operations)) if (op.type === 'fact' && op.status === 'pending' && !op.obligations.lifeApplied) { op.status = 'invalidated'; delete op.input }
    return { ok: true }
  }, 'history_clear'))
}
ipcMain.handle('petLife:load', async () => {
  const result = await petLifeStore.load()
  if (!result || !result.ok) return result
  return platformResult(() => ({ ...result, state: platformStore.filterLife(result.state) }))
})
ipcMain.handle('petLife:save', (_e, state, source) => {
  const guarded = characterBridge.guard('petLife:save')
  if (guarded) return { ok: false, error: guarded.reason }
  return petLifeStore.save(platformStore.filterLife(state), source ? () => {
    const history = loadCharacterHistory()
    try {
      const row = Array.isArray(history) && (history.find(row => row.role === 'user' && row.messageRef === source.messageRef) || platformStore.source(source.messageRef))
      return historyClearRequests === 0 && !platformStore.deleted(source.messageRef) && row && row.ts === source.ts && row.text === source.text
    } catch (_) { return false }
  } : null)
})
/* ===== R-11 前缀学舌小修=====
   背景：投影层会**临时**给人造前缀——`[MM-DD HH:MM]`（时间标签）、`[我先开口说]`（她先开口）、
   `[关系] …（实例 …）`（回应关系行）；实测 200 条历史里有 2 条 **assistant** 正文把它们学舌写进了正文。
   这里在**唯一写入点**剥掉**行首**的已知前缀，切断「前缀 → 落盘 → 再喂模型」的自我强化。
   边界：①**只用于 assistant**（调用方保证；绝不改主人输入）②只剥**行首**、只剥已知模式、循环剥叠层
   ③剥完为空则原样返回（不吞内容）④非字符串/异常一律原样返回。 */
function stripProjectionPrefixes(text) {
  try {
    if (typeof text !== 'string') return text
    const original = text
    let t = text
    const patterns = [
      /^\s*\[\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*/,   // [09-26 17:25] / [9-6 7:05:30]
      /^\s*\[\d{4}-\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*/, // [2026-9-26 17:25]
      /^\s*\[我先开口说\]\s*/,                                        // [我先开口说]
      /^\s*\[关系\][^\n]*\n?\s*/                                     // [关系] …（实例 …）整行
    ]
    for (let round = 0; round < 6; round++) {
      let changed = false
      for (let i = 0; i < patterns.length; i++) {
        if (patterns[i].test(t)) { t = t.replace(patterns[i], ''); changed = true }
      }
      if (!changed) break
    }
    return t.trim() ? t : original
  } catch (err) { return text }
}
ipcMain.handle('characterHistory:append', (_e, entry) => {
  const guarded = characterBridge.guard('characterHistory:append')
  if (guarded) return guarded
  const h = loadCharacterHistory()
  if (!Array.isArray(h)) return { ok: false, error: 'history_read_failed' }
  if (entry && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.text === 'string' && entry.text.trim()) {
    /* R-11 小修：**只对 assistant** 剥行首投影前缀（`[MM-DD HH:MM]`／`[我先开口说]`／`[关系] …`），主人输入原样保留 */
    const rawText = String(entry.text).trim()
    const item = { role: entry.role, text: (entry.role === 'assistant' ? stripProjectionPrefixes(rawText) : rawText).slice(0, 8000), ts: Date.now() }
    if (entry.messageRef) {
      const existing = h.find(row => row.messageRef === entry.messageRef)
      if (existing) {
        if (existing.role !== item.role || existing.text !== item.text) return { ok: false, reason: 'history_conflict', count: h.length }
        if (existing.role === 'user') {
          const retained = platformResult(() => platformStore.acceptSource(existing))
          if (!retained || retained.ok === false) return retained
        }
        return { ok: existing.role === item.role && existing.text === item.text, count: h.length }
      }
    }
    if (typeof entry.messageRef === 'string' && entry.messageRef) item.messageRef = entry.messageRef
    if (entry.selfInitiated === true) item.selfInitiated = true /* P0-1d（2026-10-01）：主动开场锚点结构化保留（文本标记仍被剥，两机制独立） */
    h.push(item)
  }
  /* CC-2：**不许伪造成功**——写盘失败必须如实回报 ok:false。
     今天零行为变化（渲染层 4 个调用点均不看 ok）；本项只把"写失败"变成可观测事实。 */
  const savedOk = saveCharacterHistory(h)
  if (savedOk) {
    const item = h.at(-1)
    if (item && item.role === 'user' && item.messageRef) {
      const retained = platformResult(() => platformStore.acceptSource(item))
      if (!retained || retained.ok === false) return retained
    }
  }
  /* candidate 模式：把主人消息镜像给隔离内核（单向；内核结果不回写旧 store）。
     active 模式：上面已由 guard 拦截，此处置为 no-op。
     只有确实落盘成功的 user 行才镜像，避免把一次失败的保存“记进另一个库”。 */
  if (savedOk) {
    const last = h.at(-1)
    if (last && last.role === 'user' && last.messageRef) {
      try { characterBridge.mirrorOwnerMessage('characterHistory:append', [last]) } catch (err) { log('[character-bridge] mirror failed', err && err.message) }
    }
  }
  return { ok: savedOk === true, count: h.length }
})
ipcMain.handle('characterHistory:clear', async e => {
  // Finish already-started life commits before invalidating their source.
  historyClearRequests++
  try {
    await petLifeStore.flush()
    const pending = invalidatePendingFactWork()
    if (!pending || pending.ok === false) return pending
    const savedOk = saveCharacterHistory([])
    if (savedOk === true) e.sender.send('characterHistory:invalidated', { reason: 'history_cleared' })
    return { ok: savedOk === true, count: 0 }
  } finally { historyClearRequests-- }
})

// 供渲染层读取当日时间线（纯净版日记用）
ipcMain.handle('diary:timeline', () => {
  const d = loadDailyData()
  return { date: d.date, segments: d.segments, events: d.events }
})

// 渲染层事件入流（桌宠互动 → 日记素材）：聊天/喂食/游戏/工作/备忘/主人标记等
// P3：meta 为可选可溯源信息（感知通道用 {eventId, observationId, kind, cat}），白名单落盘
/* CC-3 / P0：`diary:event` 是 `ipcMain.on`（单向、无回执），
   所以失败**不能靠回执暴露** ⇒ 改为"稳定标记日志 ＋ 进程内计数"，让"采集到但没落盘"从不可见变可见。
   **保持 on 单向语义不变**（不改 preload / 渲染层调用方式）。 */
let diaryEventSaveFailures = 0
ipcMain.on('diary:event', (_e, kind, text, meta) => {
  if (!isDiaryEnabled()) return
  try {
    const d = loadDailyData()
    if (!Array.isArray(d.events)) d.events = []
    const ev = { ts: Date.now(), kind: String(kind || '').slice(0, 20), text: String(text || '').slice(0, 120) }
    if (meta && typeof meta === 'object') {
      ev.meta = {
        eventId: String(meta.eventId || '').slice(0, 80),
        observationId: String(meta.observationId || '').slice(0, 80),
        kind: String(meta.kind || '').slice(0, 30),
        cat: String(meta.cat || '').slice(0, 20),
        source: String(meta.source || '').slice(0, 12)
      }
    }
    d.events.push(ev)
    if (d.events.length > 200) d.events = d.events.slice(-200)
    /* CC-3 / P0：saveDailyData 现已如实返回 bool ⇒ "采集到但没落盘"必须留痕（原为静默）。 */
    if (saveDailyData(d) !== true) {
      diaryEventSaveFailures++
      try { log('diary event not persisted', 'failures=' + diaryEventSaveFailures) } catch (e2) { /* ignore */ }
    }
  } catch (err) {
    diaryEventSaveFailures++
    try { log('diary event failed', 'failures=' + diaryEventSaveFailures, err && err.message) } catch (e2) { /* ignore */ }
  }
})

// 忘掉今天：清空当天的采集数据（日记正文/记忆由渲染层删除）
ipcMain.handle('diary:forgetToday', () => {
  try {
    const d = loadDailyData()
    d.segments = []
    d.events = []
    return { ok: saveDailyData(d) === true }
  } catch (err) {
    return { ok: false }
  }
})


function endDrag(reason) {
  if (!drag && !dragTimer) return
  if (reason) log('drag ended:', reason)
  drag = null
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  saveWinState()
  try { win.webContents.send('drag-ended') } catch (err) { /* ignore */ }
}

ipcMain.on('win:dragStart', () => {
  const [x, y] = win.getPosition()
  const c = screen.getCursorScreenPoint()
  drag = { ox: x, oy: y, cx: c.x, cy: c.y, startTs: Date.now(), stabilized: false }
  dragLastAlive = Date.now()
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = setInterval(applyDrag, 8)
  log('drag start', JSON.stringify({ ox: x, oy: y, cx: c.x, cy: c.y }))
})

ipcMain.on('win:dragAlive', () => {
  if (drag) dragLastAlive = Date.now()
})

function applyDrag() {
  if (!drag) return
  if (!drag.stabilized) {
    // 起步稳定缓冲：40ms（原 120ms 让拖拽显得"不跟手"）；防按下瞬间光标抖动导致窗口跳变
    if (Date.now() - drag.startTs < 40) return
    const [x, y] = win.getPosition()
    const c = screen.getCursorScreenPoint()
    drag.ox = x
    drag.oy = y
    drag.cx = c.x
    drag.cy = c.y
    drag.stabilized = true
    log('drag stabilized', JSON.stringify({ ox: x, oy: y, cx: c.x, cy: c.y }))
    return
  }
  if (KOFFI_ENABLED && koffiBtn && !koffiBtn() && Date.now() - dragLastAlive > 250) {
    endDrag('button up + silence')
    return
  }
  if (Date.now() - dragLastAlive > 3000) {
    endDrag('heartbeat timeout')
    return
  }
  const c = screen.getCursorScreenPoint()
  const [W, H] = MODES[mode]
  const p = clampPos(drag.ox + (c.x - drag.cx), drag.oy + (c.y - drag.cy), W, H)
  /* DPI fix: never read back the drifting size — pin to the mode's constant size. */
  win.setBounds({ x: p.x, y: p.y, width: W, height: H })
}

ipcMain.on('win:dragEnd', () => {
  endDrag('renderer dragEnd')
})

ipcMain.on('win:setPos', (_e, x, y) => {
  if (drag) return
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const [W, H] = MODES[mode]
  const p = clampPos(Math.round(x), Math.round(y), W, H)
  win.setBounds({ x: p.x, y: p.y, width: W, height: H })
})

ipcMain.on('win:setMode', (_e, m, anchor) => setMode(m, anchor))

/* ---------- 台词池设置独立窗口 ---------- */

let linesWin = null

ipcMain.on('lines:open', () => {
  try {
    log('lines:open received')
    if (linesWin && !linesWin.isDestroyed()) {
      log('lines: reusing existing window')
      linesWin.show()
      linesWin.focus()
      return
    }
    linesWin = new BrowserWindow({
      width: 460,
      height: 560,
      resizable: true,
      title: '台词池设置 · 桌宠小深',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    linesWin.show()
    linesWin.loadFile(path.join(__dirname, 'renderer', 'lines.html'))
    log('lines: window created')
    linesWin.on('closed', () => { linesWin = null })
  } catch (err) {
    log('lines window open error', err && err.message)
  }
})

// 台词数据读写：独立窗口 ↔ 主进程（pet-state.json），改后通知桌宠渲染层刷新
ipcMain.handle('lines:load', () => {
  return nurtureStateStore.linesRead()
})

function commitLines(command) {
  const result = nurtureStateStore.updateLines(command)
  if (result.ok) for (const target of [win, linesWin]) {
    try { if (target && !target.isDestroyed()) target.webContents.send('lines:changed', result) }
    catch (err) { log('lines change notification failed', err && err.message) }
  }
  return result
}
ipcMain.handle('lines:update', (_e, command) => commitLines(command))

ipcMain.handle('lines:save', (_e, customLines, disabledGroups) => {
  const current = nurtureStateStore.linesRead()
  if (!current.ok) return current
  return commitLines({ commandId: 'legacy-lines-' + crypto.randomUUID(), expectedRevision: current.revision,
    lines: current.lines, customLines: Array.isArray(customLines) ? customLines : current.customLines,
    disabledGroups: Array.isArray(disabledGroups) ? disabledGroups : current.disabledGroups })
})

/* ---------- 扫雷独立游戏窗口 ---------- */

let mineWin = null

// 成就独立窗口（托盘打开，展示全部成就 + 解锁进度）
let achWin = null

function openAchievements() {
  try {
    if (achWin && !achWin.isDestroyed()) {
      log('achievements: reusing existing window')
      achWin.show()
      achWin.focus()
      return
    }
    log('achievements: creating window')
    achWin = new BrowserWindow({
      width: 560,
      height: 620,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      title: '成就 · 桌宠小深',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    achWin.loadFile(path.join(__dirname, 'renderer', 'achievements.html'))
    achWin.on('closed', () => { achWin = null })
  } catch (err) {
    log('achievements open error', err && err.message)
  }
}

ipcMain.on('achievements:open', () => openAchievements())

// 相册独立窗口（托盘打开，展示照片墙：已解锁照片/剪影占位/大图预览）
let albumWin = null

function openAlbum() {
  try {
    if (albumWin && !albumWin.isDestroyed()) {
      log('album: reusing existing window')
      albumWin.show()
      albumWin.focus()
      return
    }
    log('album: creating window')
    albumWin = new BrowserWindow({
      width: 640,
      height: 700,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      title: '相册 · 桌宠小深',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    albumWin.loadFile(path.join(__dirname, 'renderer', 'album.html'))
    albumWin.on('closed', () => { albumWin = null })
  } catch (err) {
    log('album open error', err && err.message)
  }
}

ipcMain.on('album:open', () => openAlbum())

// 照片大图查看器窗口（相册点击缩略图打开，独立大窗口展示照片）
let photoViewWin = null

function openPhotoView(id) {
  try {
    if (photoViewWin && !photoViewWin.isDestroyed()) {
      photoViewWin.show()
      photoViewWin.focus()
      return
    }
    log('album view: creating window for', id)
    photoViewWin = new BrowserWindow({
      width: 560,
      height: 780,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      title: '照片 · 桌宠小深',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    photoViewWin.loadFile(path.join(__dirname, 'renderer', 'photo-viewer.html'), { query: { id: id || '' } })
    photoViewWin.on('closed', () => { photoViewWin = null })
  } catch (err) {
    log('album view open error', err && err.message)
  }
}

ipcMain.on('album:view', (_e, id) => openPhotoView(id))

ipcMain.on('album:viewClose', () => {
  try {
    if (photoViewWin && !photoViewWin.isDestroyed()) photoViewWin.close()
  } catch (err) { /* ignore */ }
})

// 生日贺卡独立窗口（用户生日时，桌宠气泡点「查收」打开，书信格式）
let cardWin = null

function openBirthdayCard() {
  try {
    if (cardWin && !cardWin.isDestroyed()) {
      log('birthday-card: reusing existing window')
      cardWin.show()
      cardWin.focus()
      return
    }
    log('birthday-card: creating window')
    cardWin = new BrowserWindow({
      width: 620,
      height: 780,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      title: '生日贺卡 · 桌宠小深',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    cardWin.loadFile(path.join(__dirname, 'renderer', 'birthday-card.html'))
    cardWin.on('closed', () => { cardWin = null })
  } catch (err) {
    log('birthday-card open error', err && err.message)
  }
}

ipcMain.on('birthday-card:open', () => openBirthdayCard())

// 清洁：安全清理系统垃圾（仅临时文件 + 回收站等安全项，不碰系统关键目录）
// 通过 DSH 的 agent 会话发指令执行，回报释放空间
let cleanRunning = false

ipcMain.handle('clean:run', async () => {
  if (cleanRunning) return { ok: false, error: '清理正在进行中，请稍候' }
  cleanRunning = true
  try {
    // 1) 找一个可用会话（优先 running 的 cordis/standard，否则任意非 blank）
    let sid = null
    try {
      const lr = await api('session.list', {})
      if (lr && lr.result && lr.result.ok) {
        const items = lr.result.value.items || []
        const pick = items.find((s) => s.running && s.agentPreset !== 'minimal') ||
          items.find((s) => !s.blank && s.agentPreset !== 'minimal') ||
          items.find((s) => !s.blank)
        if (pick) sid = pick.sessionId
      }
    } catch (err) { log('clean session.list err', err && err.message) }
    if (!sid) {
      // 2) 没有可用会话就新建一个
      try {
        const cr = await api('session.create', {})
        if (cr && cr.result && cr.result.ok) sid = cr.result.value.sessionId
      } catch (err) { log('clean session.create err', err && err.message) }
    }
    if (!sid) return { ok: false, error: '无法连接 DeepSeek，清理失败' }
    // 3) 发清理指令（安全项：仅清用户 TEMP 与回收站）
    const prompt = '请执行一次安全的系统垃圾清理，只做以下两件事：' +
      '1) 清空系统临时目录（%TEMP% 与 %LOCALAPPDATA%\\Temp 下可删除的文件与子目录，跳过被占用的文件）；' +
      '2) 清空回收站。' +
      '不要执行任何其他系统修改、不要清缓存、不要卸载、不要动系统关键目录。' +
      '完成后用一句话汇报：清理了多少个临时文件、释放了多少空间（如果算得出来）。'
    const sr = await api('session.prompt', {
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    })
    const ok = !!(sr && sr.result && sr.result.ok)
    return ok
      ? { ok: true, note: '已派发给 DeepSeek 执行安全清理，结果会以汇报卡形式送达' }
      : { ok: false, error: ((sr && sr.result && sr.result.error && sr.result.error.message) || 'DeepSeek 未响应') }
  } catch (err) {
    log('clean run err', err && err.message)
    return { ok: false, error: err && err.message }
  } finally {
    cleanRunning = false
  }
})

ipcMain.on('minesweeper:open', () => {
  try {
    if (mineWin && !mineWin.isDestroyed()) {
      log('minesweeper: reusing existing window')
      mineWin.show()
      mineWin.focus()
      return
    }
    log('minesweeper: creating window')
    mineWin = new BrowserWindow({
      width: 1280,
      height: 720,
      resizable: true,
      maximizable: true,
      fullscreenable: false,
      title: '扫雷 · 桌宠小深',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    mineWin.loadFile(path.join(__dirname, 'renderer', 'minesweeper.html'))
    mineWin.on('closed', () => { mineWin = null })
  } catch (err) {
    log('minesweeper open error', err && err.message)
  }
})

// 扫雷金币结算：独立窗口 → 主进程 → 转发给桌宠渲染层记账
ipcMain.on('minesweeper:reward', (_e, payload) => {
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('minesweeper:reward', payload || {})
    }
  } catch (err) { /* ignore */ }
})

// 真实桌面目录：OneDrive 重定向桌面的机器上 os.homedir()\Desktop 不是真实桌面，
// 快捷方式会建到"假桌面"，每次点击都重建（朋友机器 bug 根因）。
function desktopDir() {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', '[Environment]::GetFolderPath("Desktop")'], { timeout: 10000, encoding: 'utf8', windowsHide: true })
    const p = String(r.stdout || '').trim()
    if (p && fs.existsSync(p)) return p
  } catch (err) { /* ignore */ }
  return path.join(require('os').homedir(), 'Desktop')
}

ipcMain.handle('openWeb', async () => {
  const r = await officialHarness().openDesktop({ dshHome: DSH_HOME_DIR, openPath: p => shell.openPath(p) })
  log('Harness Desktop open', r.ok ? 'ok' : r.reason)
  return r
})
ipcMain.on('pet:animationSource', () => { shell.openExternal('https://github.com/PC2005-cloud/dsh-pet').catch(() => {}) })

ipcMain.on('app:quit', () => {
  stopDshStream()
  app.quit()
})

/* ---------- nurture state persistence ---------- */

// Recovery and commits are owned by state-store.cjs. Healthy reads never undo
// explicit deletion; corrupted primaries are preserved before backup recovery.
let stateRecoveryReceipt = null
function readStateFile() {
  const result = nurtureStateStore.read()
  if (!result.ok) log('state load blocked', result.status, result.reason)
  else if (result.status === 'recovered') {
    stateRecoveryReceipt = { recoveredFrom: result.recoveredFrom, preservedPath: result.preservedPath || null, recoveredAt: Date.now() }
    log('state recovered from', result.recoveredFrom)
  }
  // Internal diary/history reads may repair the file before the renderer loads.
  // Preserve the receipt until the main renderer receives its typed read result.
  return stateRecoveryReceipt ? { ...result, recovery: { ...stateRecoveryReceipt } } : result
}
function readRendererStateFile(event) {
  const result = readStateFile()
  if (result.ok && win && event && event.sender === win.webContents) stateRecoveryReceipt = null
  return result
}
function loadStateFile() {
  const result = readStateFile()
  return result.ok ? result.state : null
}
// 状态字段级审计：每次保存记录关键字段，任何"被修改/被覆盖"都有日志可查
let lastStateAudit = ''
function logStateAudit(state) {
  try {
    const sig = [state.level, state.coins, state.totalGames, state.totalWorkDone, state.pomodoros, state.feedCount, state.bootCount,
      (state.diary || []).length, (state.memories || []).length, state.photos ? Object.keys(state.photos).length : 0,
      (state.gameWins || []).length].join('/')
    if (sig !== lastStateAudit) {
      lastStateAudit = sig
      log('state audit: level=' + state.level + ' coins=' + state.coins + ' games=' + state.totalGames + ' work=' + state.totalWorkDone +
        ' pomo=' + state.pomodoros + ' feed=' + state.feedCount + ' boot=' + state.bootCount + ' diary=' + (Array.isArray(state.diaryOutputs) && state.diaryOutputs.length ? state.diaryOutputs.length : (state.diary || []).length) /* P2/D4-4：真值（原只数 legacy 恒 0＝谎报） */ +
        ' mem=' + (state.memories || []).length + ' photos=' + (state.photos ? Object.keys(state.photos).length : 0) + ' wins=' + (state.gameWins || []).length)
    }
  } catch (err) { /* ignore */ }
}

function saveStateFile(state) {
  if (CHARACTER_TRIAL || characterKernelMode() === 'active') return false
  const result = nurtureStateStore.saveLegacy(state)
  if (!result.ok) { log('state save blocked', result.reason); return false }
  if (result.backupWarning) log('state backup mirror failed', result.backupWarning)
  logStateAudit(result.state)
  return true
}
ipcMain.handle('persona:load', () => {
  try {
    if (fs.existsSync(PERSONA_FILE)) return JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'))
  } catch (err) { /* ignore */ }
  return null
})
ipcMain.handle('persona:save', (_e, data) => {
  const guarded = characterBridge.guard('persona:save')
  if (guarded) return false
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = PERSONA_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, PERSONA_FILE)
    return true
  } catch (err) {
    return false
  }
})

function loadMemoryFile() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return platformStore.filterMemory(JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')))
  } catch (err) { /* corrupted primary falls through to backup */ }
  try {
    if (fs.existsSync(MEMORY_BACKUP)) return platformStore.filterMemory(JSON.parse(fs.readFileSync(MEMORY_BACKUP, 'utf8')))
  } catch (err) { /* ignore */ }
  return null
}

function saveMemoryFile(data) {
  if (CHARACTER_TRIAL || characterKernelMode() === 'active') return false
  try {
    const forgotten = (data && data.memories || []).filter(m => m.status === 'suppressed' && m.suppression)
      .flatMap(m => [(m.id || ''), m.id ? 'mem:' + m.id : '', ...(m.evidenceRefs || []).map(e => e && (e.messageRef || e.eventRef))].filter(Boolean))
    if (forgotten.length) platformStore.forget(forgotten, 'memory_removed')
    data = platformStore.filterMemory(data)
    fs.mkdirSync(DATA_DIR, { recursive: true })
    if (fs.existsSync(MEMORY_FILE)) {
      try { fs.copyFileSync(MEMORY_FILE, MEMORY_BACKUP) } catch (err) { /* backup best-effort */ }
    }
    const tmp = MEMORY_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, MEMORY_FILE)
    return true
  } catch (err) {
    return false
  }
}

ipcMain.handle('memory:load', () => loadMemoryFile())
ipcMain.handle('memory:save', (_e, data) => {
  const guarded = characterBridge.guard('memory:save')
  if (guarded) return false
  return saveMemoryFile(data)
})

ipcMain.handle('state:load', () => loadStateFile())
ipcMain.handle('state:read', event => readRendererStateFile(event))
ipcMain.handle('state:save', (_e, state) => {
  const guarded = characterBridge.guard('state:save')
  if (guarded) return false
  return saveStateFile(state)
})

ipcMain.handle('pickImage', async () => {
  try {
    const res = await dialog.showOpenDialog(win, {
      title: '选择要发送的图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      properties: ['openFile'],
    })
    if (res.canceled || !res.filePaths.length) return null
    const src = res.filePaths[0]
    const buf = fs.readFileSync(src)
    if (buf.length > 7 * 1024 * 1024) {
      return { error: '图片超过 5MB，请换一张小一点的' }
    }
    const ext = path.extname(src).toLowerCase().replace('.', '') || 'png'
    const imagesDir = path.join(DATA_DIR, 'images')
    fs.mkdirSync(imagesDir, { recursive: true })
    const dest = path.join(imagesDir, 'pet-' + Date.now().toString(36) + '.' + ext)
    fs.writeFileSync(dest, buf)
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }
    return { name: path.basename(src), path: dest, mime: mimeMap[ext] || 'image/png', data: buf.toString('base64') }
  } catch (err) {
    log('pickImage error', err && err.message)
    return null
  }
})


/* ---------- F5-B：Life Context 真实接线（编排层在主进程 = 组合根；纯追加） ----------
   边界（施工单 v1.3 §10 / §2.2）：
     · **唯一读取**：lifeContextEnabled()（读 pet-prefs.json 的 lifeContext.enabled，缺省 true）
     · **唯一写入**：ipc 'lifeContext:setEnabled'（渲染层不得自己读写 pet-prefs）
     · 落盘路径只在主进程解析：path.join(DATA_DIR, 'life-context.json')（与 pet-state.json 同源口径）
     · 编排层=orchestrator.js（原子提交：写盘成功才发布状态）；本段不产生任何对外开口（N5）
     · 与 isDiaryEnabled() **完全解耦**（日记开关只是能力事实 write.diary 的真值来源）
     · 禁止回流：本段只写 life-context.json，绝不触碰 pet-state / Memory / diary / album */
const LIFE_CONTEXT_FILE = path.join(DATA_DIR, 'life-context.json')

function lifeContextEnabled() {
  const prefs = loadPrefsFile()
  const lc = prefs && prefs.lifeContext && typeof prefs.lifeContext === 'object' ? prefs.lifeContext : null
  // 只有显式 false 才关（缺省开，用户 拍板"甲"）
  return !(lc && lc.enabled === false)
}

function writeLifeContextEnabled(v) {
  const cur = loadPrefsFile()
  const lc = Object.assign({}, (cur.lifeContext && typeof cur.lifeContext === 'object') ? cur.lifeContext : {})
  lc.enabled = !!v
  if (!savePrefsFile({ lifeContext: lc })) return { ok: false, error: 'save-failed' }
  log('life context enabled set:', lifeContextEnabled())
  return { ok: true, enabled: lifeContextEnabled() }
}

let __lifeContextModules = null
function lifeContextModules() {
  if (!__lifeContextModules) {
    __lifeContextModules = {
      facts: require('./renderer/life-context/facts.js'),
      meaning: require('./renderer/life-context/meaning.js'),
      rules: require('./renderer/life-context/meaning-rules.js'),
      bridge: require('./renderer/life-context/emotion-bridge.js'),
      autonomy: require('./renderer/life-context/autonomy.js'),
      policy: require('./renderer/life-context/autonomy-policy.js'),
      ledger: require('./renderer/life-context/ledger.js'),
      store: require('./renderer/life-context/ledger-store.js'),
      selfKnowledge: require('./renderer/life-context/self-knowledge.js'),
      expression: require('./renderer/life-context/expression.js'),
      orchestrator: require('./renderer/life-context/orchestrator.js'),
      foregroundObservation: require('./renderer/life-context/foreground-observation.js'),
    proactive: require('./renderer/life-context/proactive.js')
    }
  }
  return __lifeContextModules
}

let __lifeContextSession = null
function lifeContextSession() {
  if (__lifeContextSession) return __lifeContextSession
  const M = lifeContextModules()
  const store = M.store.createFileStore({ mode: 'production', filePath: LIFE_CONTEXT_FILE, dataDir: DATA_DIR })
  const loaded = store.load()
  const st = loaded && loaded.state ? loaded.state : null
  const meta = (st && st.meta && typeof st.meta === 'object') ? st.meta : {}
  const ledgerState = M.ledger.createState({ entries: (st && st.entries) || [], auditLog: (st && st.auditLog) || [] })
  // 未知顶层键原样保留（前向兼容）：非保留键挂回 ledgerState，orchestrator 的 buildPayload 会带回去
  Object.keys(st || {}).forEach((k) => {
    if (['schemaVersion', 'version', 'entries', 'auditLog', 'meta', 'passthrough'].indexOf(k) < 0) ledgerState[k] = st[k]
  })
  const emotion = (meta.emotion && meta.emotion.values) ? { values: meta.emotion.values, updatedAt: meta.emotion.updatedAt || 0, version: meta.emotion.version || 0 } : null
  __lifeContextSession = M.orchestrator.createSession({
    deps: { facts: M.facts, meaning: M.meaning, bridge: M.bridge, autonomy: M.autonomy, ledger: M.ledger, selfKnowledge: M.selfKnowledge, proactive: M.proactive, foregroundObservation: M.foregroundObservation },
    policy: M.policy.normalizePolicy(policyTuningFromPrefs()),
    rules: M.rules.RULES,
    ledgerState: ledgerState,
    emotion: emotion,
    cap: meta.cap || null,
    meta: meta,
    lastPersistTs: Number(meta.lastPersistTs) || 0,
    selfProcessNames: SELF_PROCESS_NAMES,
    writer: {
      save: (payload) => {
        try {
          const r = store.save(payload)
          return { ok: true, bytes: r.bytes }
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err) }
        }
      }
    }
  })
  return __lifeContextSession
}

/* 一轮 tick：输入来自渲染层（候选池/开关/权限）；事实来自主进程既有 daily-timeline（只读） */
/* F6-B：表达上限（硬闸，不截断）——取值来源＝ S2 既有 diction 兜底 maxChars（state-expression.js:286）。
   超限 ⇒ F6-A 判不可表达 ⇒ 该条**不注入**（用户 2026-09-20 圈定③）。 */
const EXPRESSION_MAX_CHARS = 40

/* 施工：NULL_GATE（insufficient-candidates）的**无语义副作用可观测性**。
   背景：该状态被刻意排除在账本之外（"没有构成选择" ⇒ 不写条目；gated 只留必要系统状态），
   于是"心跳跑了但本轮没有合格候选"在日志里毫无痕迹，无法与"心跳没跑 / 进程不在"区分。
   做法：只加一条**节流日志**（复用既有 log 通道，不新增日志协议）：
   - 节流窗口复用编排层既有常量 DEFAULT_META_THROTTLE_MS（5 分钟），不新造阈值；
   - 两个计数器只活在内存、只被本函数读写：不落盘、不进账本、不被任何决策读取，重启后重新计数
     （只影响日志密度，不影响任何行为）；
   - 只读本轮 tick 结果，不修改它、不改变任何 outcome/gate 判定。 */
let nullGateLogTs = 0
let nullGateSuppressed = 0
function nullGateObservable(r, nowTs) {
  try {
    if (!r || r.ok !== true || !r.decision) return false
    if (!(r.decision.outcome === 'gated' && r.decision.gate === 'insufficient-candidates')) return false
    let win = 0
    try {
      const M = lifeContextModules()
      const v = M && M.orchestrator ? Number(M.orchestrator.DEFAULT_META_THROTTLE_MS) : 0
      if (Number.isFinite(v) && v > 0) win = v
    } catch (err) { win = 0 }
    if (win > 0 && nullGateLogTs > 0 && (nowTs - nullGateLogTs) < win) { nullGateSuppressed += 1; return false }
    const extra = nullGateSuppressed > 0 ? '（本窗口另有 ' + nullGateSuppressed + ' 次同类未记录）' : ''
    nullGateSuppressed = 0
    nullGateLogTs = nowTs
    log('life-context null-gate: insufficient-candidates（本轮没有构成选择；不写账本）' + extra)
    return true
  } catch (err) { return false }
}

/* P3-C2-F1：最近经历只读投影（只服务 Chat）。
   数据只来自本会话 in-memory 快照的 experiences 顶层区；不重算、不检索、不调 AI、不写任何东西。
   最多 3 条、按时间升序；保留 eventId / kind / category / ts / text（text 由渲染层按模板生成）。 */
function lifeContextRecentExperiences(session, nowTs) {
  try {
    const snap = session && typeof session.snapshot === 'function' ? session.snapshot() : null
    const store = (snap && snap.ledgerState && snap.ledgerState.experiences) || null
    const all = (store && Array.isArray(store.entries)) ? store.entries.slice() : []
    const items = all.sort(function (a, b) { return (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0) }).slice(-3).map(function (x) {
      return {
        eventId: String((x && x.eventId) || ''),
        kind: String((x && x.kind) || ''),
        category: String((x && x.category) || ''),
        ts: Number((x && x.ts) || 0),
        text: String((x && x.text) || '')
      }
    })
    return { asOfTs: nowTs, items: items, count: all.length }
  } catch (err) { return { asOfTs: nowTs, items: [], count: 0 } }
}

function runLifeContextTick(payload) {
  if (!lifeContextEnabled()) return { ok: false, skipped: true, reason: 'life-context-disabled' }
  const p = payload || {}
  const nowTs = Date.now()
  try {
    const session = lifeContextSession()
    const timeline = loadDailyData()
    /* P3 F0 第一阶段：open segment 只读投影。
       collectSeg 是"进行中活动"的唯一权威来源；这里只把快照挂到**本轮瞬时**的 timeline.open 上：
       · 不落盘（本对象绝不回写 daily-timeline，collector 各写盘路径各自 loadDailyData 不受影响）
       · 不进 segments、不占 seq、不产生任何 ledger ref、不改 collector 判定/5min/90min/日界
       · facts 侧仅据此生成独立 key activity.current；F1 本轮不消费（契约 test-life-context-f0-current-activity）。 */
    if (collectSeg) timeline.open = { cat: collectSeg.app, startTs: collectSeg.startTs, asOfTs: nowTs }
    const r = session.tick({
      nowTs: nowTs,
      timeline: timeline,
      media: p.media || null,
      static: p.static || null,
      runtime: p.runtime || {},
      permission: p.permission || {},
      declared: p.declared || null,
      pool: Array.isArray(p.pool) ? p.pool : [],
      events: Array.isArray(p.events) ? p.events : [],
      gates: p.gates || {},
      dutyEvidence: Array.isArray(p.dutyEvidence) ? p.dutyEvidence : [],
      proactiveEnabled: proactiveEnabled(),
      /* F7-B：capEvent 由主动联系四状态产生（**只在真正 initiated 之后**）；main 从待消费队首注入，
         成功提交后由编排层记入 consumed（同一原子提交）。F7 之前恒为 null。 */
      capEvent: (function () {
        try { const ps = session.proactiveState(nowTs); return (ps && ps.pendingCapEvents && ps.pendingCapEvents[0]) || null } catch (err) { return null }
      })()
    })
    if (!r.ok) log('life-context tick failed:', r.reason, JSON.stringify(r.detail || null))
    /* 施工：NULL_GATE 可观测性（只加节流日志；不写账本 / 不写状态 / 不参与判定）。
       详见 nullGateObservable 注释。 */
    nullGateObservable(r, nowTs)
    /* F6-B：F6-A 的只读结果（文本解析 + 出口闸都在 F6-A 侧；此处只搬运，不重新解释）
       时效：与本次 tick **同拍**取用 in-memory 账本视图 ⇒ 最多落后 1 个 heartbeat；不另建缓存/刷新链。 */
    let expressible = null
    try {
      const M = lifeContextModules()
      const snap = session.snapshot()
      const view = M.ledger.exportView(snap.ledgerState, { nowTs: nowTs, validOnly: true })
      expressible = M.expression.buildExpressible(
        { view: view, rules: M.rules.RULES, capabilities: r.self || null, nowTs: nowTs, diction: { maxChars: EXPRESSION_MAX_CHARS } },
        { selfKnowledge: M.selfKnowledge }
      )
    } catch (err) { expressible = null }
    /* P3-C1：只读「最近活动」快照。
       数据只来自本函数**已经读取**的 Daily Timeline（不改 timeline schema、不新增采集/感知、不动 5 分钟落账阈值）。
       段在 timeline 里只有**类别**粒度（pushSegment 存的是 cat）⇒ 这里只表达"最近活动"，不包装成"当前正在做什么"；
       保留时间戳与 asOfTs，供 Chat 明确数据新鲜度。取最近 3 条，避免把 prompt 撑长。 */
    const realitySegments = (Array.isArray(timeline && timeline.segments) ? timeline.segments.slice(-3) : []).map(function (s) {
      const st = Date.parse(s && s.start)
      const en = Date.parse(s && s.end)
      return { cat: String((s && s.app) || ''), startTs: Number.isFinite(st) ? st : null, endTs: Number.isFinite(en) ? en : null, minutes: Number(s && s.minutes) || 0 }
    }).filter(function (s) { return !!s.cat && Number.isFinite(s.startTs) && Number.isFinite(s.endTs) })
    const reality = { asOfTs: nowTs, segments: realitySegments }
    /* P3-C2-F1：最近经历（只读投影；与 reality 同拍取用 in-memory 快照 ⇒ 最多落后 1 个 heartbeat） */
    const experiences = lifeContextRecentExperiences(session, nowTs)
    return {
      ok: !!r.ok,
      reason: r.reason || null,
      detail: r.detail || null,
      outcome: r.decision ? r.decision.outcome : null,
      gate: r.decision ? r.decision.gate : null,
      entryKind: r.entry ? r.entry.kind : null,
      persisted: !!r.persisted,
      actsToday: (r.actsToday || []).length,
      proactive: r.proactive || null,
      proactiveInitiatedToday: r.proactive ? r.proactive.initiatedToday : 0,
      capabilities: r.self ? { asOfTs: r.self.asOfTs, items: r.self.items, conflicts: r.self.conflicts } : null,
      reality: reality,
      experiences: experiences,
      expressible: expressible
    }
  } catch (err) {
    log('life-context tick error:', err && err.message)
    return { ok: false, reason: 'tick-error', detail: String((err && err.message) || err) }
  }
}

/* F7-B：主动联系开关（主进程唯一读写）与四状态写入入口（唯一）。
   写操作一律以实际提交结果为成功依据；失败如实回 reason，绝不伪造成功。 */
ipcMain.handle('proactive:getEnabled', () => ({ enabled: proactiveEnabled() }))
ipcMain.handle('proactive:setEnabled', (_e, v) => { const ok = writeProactiveEnabled(!!v); return { ok: !!ok, enabled: proactiveEnabled() } })
ipcMain.handle('lifeContext:proactiveEvent', (_e, evt) => {
  try {
    // The switch may change while an AI opening is being generated.
    if (evt && evt.type === 'present' && !proactiveEnabled()) return { ok: false, reason: 'disabled', persisted: false }
    const r = lifeContextSession().recordProactiveEvent(evt || {})
    /* A1：四态迁移落日志——呈现/查看/回复/替换在 pet.log 可审计；
       choice→instance 丢弃对账在渲染层 [proactive] no-present 行（施工单 P0-1 §子批 a）。 */
    try { log('[proactive] state', (evt && evt.type) || '-', (evt && evt.id) || '-', 'ok=' + (!!r.ok), 'reason=' + (r.reason || '-'), 'persisted=' + (!!r.persisted)) } catch (e) { /* ignore */ }
    return { ok: !!r.ok, reason: r.reason || null, persisted: !!r.persisted, instance: r.instance || null, initiatedToday: r.initiatedToday }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String((err && err.message) || err) }
  }
})

/* P3-C2-F1：经历的写入入口（唯一）。写操作以实际提交结果为成功依据，失败如实回 reason。 */
ipcMain.handle('lifeContext:experience', (_e, entry) => {
  try {
    const r = lifeContextSession().recordExperience(entry || {})
    return { ok: !!r.ok, reason: r.reason || null, duplicate: !!r.duplicate, persisted: !!r.persisted, count: r.count }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String((err && err.message) || err) }
  }
})

/* P3-F0：前台变化观察旁路的写入入口（唯一）。
   独立顶层区 foregroundObservations；自进程（SELF_PROCESS_NAMES 注入）/ 锁屏分类 / 稳定 eventId /
   ±30s 精度声明 / 容量上限 全部由旁路模块在会话内裁决；写操作以实际提交结果为成功依据，失败如实回 reason。 */
/* P1-1/P1-4：前台观察旁路归档——主进程侧逐条 append 到
   foreground-archive/<本地日>.jsonl：完整历史与渲染层 200 条环形解耦（环形照旧零改动）；
   按小时聚合落一行日志（感知采集量此前成功/失败都零观测）。 */
const FG_ARCHIVE_DIR = path.join(DATA_DIR, 'foreground-archive')
let fgArchiveHour = null
let fgArchiveCount = 0
function archiveForegroundObservation(entry) {
  try {
    if (!entry || typeof entry !== 'object') return
    const now = new Date()
    const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    const hour = day + ' ' + String(now.getHours()).padStart(2, '0') + 'h'
    fs.mkdirSync(FG_ARCHIVE_DIR, { recursive: true })
    fs.appendFileSync(path.join(FG_ARCHIVE_DIR, day + '.jsonl'), JSON.stringify(entry) + "\n")
    if (fgArchiveHour === null) fgArchiveHour = hour
    if (hour !== fgArchiveHour) {
      try { log('[perception] fg-obs', fgArchiveCount, 'entries in', fgArchiveHour) } catch (e) { /* ignore */ }
      fgArchiveHour = hour
      fgArchiveCount = 0
    }
    fgArchiveCount++
  } catch (err) {
    try { log('[perception] fg-obs archive failed', err && err.message) } catch (e) { /* ignore */ }
  }
}
ipcMain.handle('lifeContext:foregroundObservation', (_e, entry) => {
  try {
    const r = lifeContextSession().recordForegroundObservation(entry || {})
    archiveForegroundObservation(entry || {}) /* P1-1/P1-4：旁路归档＋小时计数 */
    return { ok: !!r.ok, reason: r.reason || null, duplicate: !!r.duplicate, persisted: !!r.persisted, count: r.count }
  } catch (err) {
    return { ok: false, reason: 'error', detail: String((err && err.message) || err) }
  }
})

function lifeContextStatus() {
  let existed = false
  let bytes = 0
  try { if (fs.existsSync(LIFE_CONTEXT_FILE)) { existed = true; bytes = fs.statSync(LIFE_CONTEXT_FILE).size } } catch (err) { /* ignore */ }
  let ticks = null
  try { ticks = __lifeContextSession ? __lifeContextSession.status() : null } catch (err) { /* ignore */ }
  return { enabled: lifeContextEnabled(), file: LIFE_CONTEXT_FILE, existed: existed, bytes: bytes, ticks: ticks }
}

ipcMain.handle('lifeContext:getEnabled', () => ({ enabled: lifeContextEnabled() }))
ipcMain.handle('lifeContext:setEnabled', (_e, v) => writeLifeContextEnabled(!!v))
ipcMain.handle('lifeContext:status', () => lifeContextStatus())
ipcMain.handle('lifeContext:tick', (_e, payload) => runLifeContextTick(payload))


}
