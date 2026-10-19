const { contextBridge, ipcRenderer } = require('electron')
const characterBoot = ipcRenderer.sendSync('character:boot') || { authority: false }

let __historyEpoch = Date.now().toString(36)
let __historySeq = 0
function __nextMessageRef() {
  __historySeq += 1
  return 'chat-' + __historyEpoch + '-' + __historySeq
}

contextBridge.exposeInMainWorld('pet', {
  platform: {
    info: () => ipcRenderer.invoke('platform:info'),
    factBegin: input => ipcRenderer.invoke('platform:factBegin', input),
    extraction: (ref, result) => ipcRenderer.invoke('platform:extraction', ref, result),
    recover: () => ipcRenderer.invoke('platform:recover'),
    export: () => ipcRenderer.invoke('platform:export'),
    restore: backup => ipcRenderer.invoke('platform:restore', backup),
    factState: ref => ipcRenderer.invoke('platform:factState', ref),
    factAdvance: (ref, step, detail) => ipcRenderer.invoke('platform:factAdvance', ref, step, detail),
    pendingFacts: () => ipcRenderer.invoke('platform:pendingFacts'),
    forget: refs => ipcRenderer.invoke('platform:forget', refs),
    operationBegin: proposal => ipcRenderer.invoke('platform:operationBegin', proposal),
    operationUpdate: (id, status, receipt) => ipcRenderer.invoke('platform:operationUpdate', id, status, receipt),
    beginOperation: proposal => ipcRenderer.invoke('platform:operationBegin', proposal),
    updateOperation: (id, status, receipt) => ipcRenderer.invoke('platform:operationUpdate', id, status, receipt),
    operation: id => ipcRenderer.invoke('platform:operation', id),
    projection: () => ipcRenderer.invoke('platform:projection'),
    capabilities: () => ipcRenderer.invoke('platform:capabilities'),
    invokeCapability: input => ipcRenderer.invoke('platform:capabilityInvoke', input),
    select: (candidates, policy) => ipcRenderer.invoke('platform:select', candidates, policy),
    presented: id => ipcRenderer.invoke('platform:presented', id),
    projectStep: (id, operationId) => ipcRenderer.invoke('platform:projectStep', id, operationId),
    delivery: row => ipcRenderer.invoke('platform:delivery', row),
    onInvalidated: callback => ipcRenderer.on('characterPlatform:invalidated', (_event, data) => callback(data)),
    packageInstall: folder => ipcRenderer.invoke('platform:packageInstall', folder),
    packageDisable: id => ipcRenderer.invoke('platform:packageDisable', id),
    packageUninstall: id => ipcRenderer.invoke('platform:packageUninstall', id),
    packageRollback: id => ipcRenderer.invoke('platform:packageRollback', id)
  },
  prompts: { snapshot: () => ipcRenderer.sendSync('prompts:snapshot') },
  /* 长驻角色内核的唯一桥（总规 §9.1 / §19 迁移表）。
     只暴露 submit/read/cancel/subscribe 语义：**不暴露任意状态写**，
     renderer 不能提交整个角色对象，也不能自报权限。默认 mode=off 时全部返回 kernel_off。 */
  character: {
    perception: enabled => ipcRenderer.invoke('character:perception', enabled),
    authority: characterBoot.authority === true,
    observe: event => ipcRenderer.invoke('character:observe', event),
    status: () => ipcRenderer.invoke('character:status'),
    submit: command => ipcRenderer.invoke('character:submit', command),
    read: query => ipcRenderer.invoke('character:read', query || {}),
    cancel: payload => ipcRenderer.invoke('character:cancel', payload || {}),
    onPresentation: callback => {
      const listener = (_event, intent) => callback(intent)
      ipcRenderer.on('character:presentation', listener)
      return () => ipcRenderer.removeListener('character:presentation', listener)
    },
    onEvent: callback => {
      const listener = (_event, event) => callback(event)
      ipcRenderer.on('character:event', listener)
      return () => ipcRenderer.removeListener('character:event', listener)
    },
    delivery: row => ipcRenderer.invoke('character:submit', {
      commandId: 'delivery:' + String(row && row.presentationId || '') + ':' + String(row && row.channel || '') + ':' + String(row && row.phase || ''),
      schemaVersion: 1,
      kind: 'presentation.receipt',
      characterId: row && row.characterId,
      payload: { delivery: row },
    }),
  },
  api: (method, payload) => ipcRenderer.invoke('api', method, payload),
  dshCall: (method, payload) => ipcRenderer.invoke('dsh:call', method, payload),
  modelConfig: {
    setDefaultModel: value => ipcRenderer.invoke('modelConfig:defaultModel', value),
    get: () => ipcRenderer.invoke('modelConfig:get'),
    save: value => ipcRenderer.invoke('modelConfig:save', value),
    setDefault: id => ipcRenderer.invoke('modelConfig:default', id),
    remove: id => ipcRenderer.invoke('modelConfig:remove', id),
    route: (role, value) => ipcRenderer.invoke('modelConfig:route', role, value),
    probe: id => ipcRenderer.invoke('modelConfig:probe', id),
    test: (id, model) => ipcRenderer.invoke('modelConfig:test', id, model)
  },
  llmApi: {
    get: () => ipcRenderer.invoke('llmApi:get'),
    set: (v) => ipcRenderer.invoke('llmApi:set', v)
  },
  proactiveTuning: {
    get: () => ipcRenderer.invoke('proactiveTuning:get'),
    set: (v) => ipcRenderer.invoke('proactiveTuning:set', v)
  },
  dshCompat: {
    probe: () => ipcRenderer.invoke('dshCompat:probe'),
    gate: () => ipcRenderer.invoke('dshCompat:gate'),
    setMode: (mode) => ipcRenderer.invoke('dshCompat:setMode', mode),
    sessionList: () => ipcRenderer.invoke('dshCompat:sessionList'),
    sessionHistory: (p) => ipcRenderer.invoke('dshCompat:sessionHistory', p),
    sessionPrompt: (p) => ipcRenderer.invoke('dshCompat:sessionPrompt', p),
    workspaceList: () => ipcRenderer.invoke('dshCompat:workspaceList'),
    models: () => ipcRenderer.invoke('dshCompat:models'),
    agentPresets: () => ipcRenderer.invoke('dshCompat:agentPresets'),
  },
  dsh: {
    list: () => ipcRenderer.invoke('dsh:call', 'session.list', {}),
    create: (payload) => ipcRenderer.invoke('dsh:call', 'session.create', payload || {}),
    rename: (payload) => ipcRenderer.invoke('dsh:call', 'session.rename', payload || {}),
    archive: (payload) => ipcRenderer.invoke('dsh:call', 'workspace.archiveSession', payload || {}),
    history: (payload) => ipcRenderer.invoke('dsh:call', 'session.history', payload || {}),
    prompt: (payload) => ipcRenderer.invoke('dsh:call', 'session.prompt', payload || {}),
    workspaceList: () => ipcRenderer.invoke('dsh:call', 'workspace.list', {}),
    models: (payload) => ipcRenderer.invoke('dsh:call', 'session.models', payload || {}),
    selectModel: (payload) => ipcRenderer.invoke('dsh:call', 'session.selectModel', payload || {}),
    agentPresetList: () => ipcRenderer.invoke('dsh:call', 'agentPreset.list', {}),
    agentPresetSelect: (payload) => ipcRenderer.invoke('dsh:call', 'agentPreset.select', payload || {})
  },
  state: {
    load: () => ipcRenderer.invoke('state:load'),
    save: (s) => ipcRenderer.invoke('state:save', s)
  },
  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    info: () => ipcRenderer.invoke('chat:info')
  },
  respond: (payload) => ipcRenderer.invoke('respond', payload),
  workspacePath: () => ipcRenderer.invoke('app:workspacePath'),
  runtimeDiag: () => ipcRenderer.invoke('diag:runtime'),
  simulateDaily: (ts) => ipcRenderer.invoke('diag:simulateDaily', ts),
  diaryTimeline: () => ipcRenderer.invoke('diary:timeline'),
  diaryEnabled: () => ipcRenderer.invoke('diary:enabled'),
  diarySetEnabled: (v) => ipcRenderer.invoke('diary:setEnabled', !!v),
  diaryEvent: (kind, text, meta) => ipcRenderer.send('diary:event', kind, text, meta || null),
  diaryForgetToday: () => ipcRenderer.invoke('diary:forgetToday'),
  diaryTalk: (t) => ipcRenderer.invoke('diary:talk', t),
  getForegroundApp: () => ipcRenderer.invoke('pet:getForegroundApp'),
  getMediaSession: () => ipcRenderer.invoke('pet:getMediaSession'),
  llmDirect: (payload) => ipcRenderer.invoke('llm:direct', payload),
  /* F5-B：Life Context（主进程是唯一 I/O 方；渲染层只提交本轮输入、读状态与总开关） */
  lifeContextTick: (payload) => ipcRenderer.invoke('lifeContext:tick', payload || {}),
  lifeContextStatus: () => ipcRenderer.invoke('lifeContext:status'),
  lifeContextGetEnabled: () => ipcRenderer.invoke('lifeContext:getEnabled'),
  lifeContextSetEnabled: (v) => ipcRenderer.invoke('lifeContext:setEnabled', !!v),
  /* F7-B：主动联系（开关由 main 唯一持有；四状态事件走同一个原子提交入口） */
  proactiveGetEnabled: () => ipcRenderer.invoke('proactive:getEnabled'),
  proactiveSetEnabled: (v) => ipcRenderer.invoke('proactive:setEnabled', !!v),
  proactiveEvent: (evt) => ipcRenderer.invoke('lifeContext:proactiveEvent', evt || {}),
  /* P3-C2-F1：经历写入（渲染层 Perception Writer 的唯一出口；去重与落盘由主进程裁决） */
  experienceEvent: (entry) => ipcRenderer.invoke('lifeContext:experience', entry || {}),
  /* P3-F0：前台变化观察旁路写入（独立顶层区；自进程/锁屏/容量/稳定 ID 由主进程裁决） */
  foregroundObservationEvent: (entry) => ipcRenderer.invoke('lifeContext:foregroundObservation', entry || {}),
  /* 用户可选的聊天模型：取可选清单/当前生效值，或写入偏好（'' = 恢复跟随最新 Flash）。
     合法性判定在主进程白名单里，renderer 只负责渲染与提交。 */
  chatModelGet: () => ipcRenderer.invoke('chatModel:get'),
  chatModelSet: (id) => ipcRenderer.invoke('chatModel:set', id),
  /* C 档：探测用户配置端点有哪些模型（第三方服务商支持） */
  modelProbe: (force) => ipcRenderer.invoke('model:probe', !!force),
  /* M2：按场景（chat/diary/expression/vision/work）读写模型偏好。
     同样只提交，合法性判定在主进程白名单里。 */
  modelPrefGet: () => ipcRenderer.invoke('modelPref:get'),
  modelPrefSet: (purpose, id) => ipcRenderer.invoke('modelPref:set', purpose, id),
  /* 会话权限档位：选项来自 DSH permissionPresets/catalog 、当前值来自
     session.list 投影、切换走 host 命令 `/permission <preset>` —— 三步都在主进程完成。 */
  permissionGet: (sessionId) => ipcRenderer.invoke('permission:get', sessionId),
  permissionSet: (payload) => ipcRenderer.invoke('permission:set', payload),
  characterHistoryLoad: () => ipcRenderer.invoke('characterHistory:load'),
  characterHistorySource: (messageRef) => ipcRenderer.invoke('characterHistory:source', messageRef),
  onCharacterHistoryInvalidated: (cb) => ipcRenderer.on('characterHistory:invalidated', (_e, detail) => cb(detail)),
  petLifeLoad: () => ipcRenderer.invoke('petLife:load'),
  petLifeSave: (state, source) => ipcRenderer.invoke('petLife:save', state, source),
  nextMessageRef: () => __nextMessageRef(),
  characterHistoryAppend: (entry) => {
    const base = entry && typeof entry === 'object' ? entry : {}
    const withRef = { ...base }
    if (!withRef.messageRef) withRef.messageRef = __nextMessageRef()
    return ipcRenderer.invoke('characterHistory:append', withRef)
  },
  characterHistoryClear: () => ipcRenderer.invoke('characterHistory:clear'),
  onStreamFrame: (cb) => ipcRenderer.on('pet-stream', (_e, frame) => cb(frame)),
  autostartGet: () => ipcRenderer.invoke('autostart:get'),
  autostartSet: (v) => ipcRenderer.invoke('autostart:set', v),
  dshStop: () => ipcRenderer.invoke('dsh:stop'),
  harnessStatus: () => ipcRenderer.invoke('harness:status'),
  harnessEnsure: () => ipcRenderer.invoke('harness:ensure'),
  onHarnessChanged: callback => {
    const listener = () => { if (typeof callback === 'function') callback() }
    ipcRenderer.on('harness:changed', listener)
    return () => ipcRenderer.removeListener('harness:changed', listener)
  },
  updateConfig: () => ipcRenderer.invoke('update:config'),
  updateSetConfig: (baseUrl) => ipcRenderer.invoke('update:setConfig', baseUrl),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: (opts) => ipcRenderer.invoke('update:install', opts),
  updateHasInstaller: (version) => ipcRenderer.invoke('update:hasInstaller', version),
  // P0-A 更新与兼容状态（只读；不做任何升级/切换动作）
  ucStatusSnapshot: () => ipcRenderer.invoke('update:statusSnapshot'),
  ucModelStatus: (opts) => ipcRenderer.invoke('update:modelStatus', opts),
  ucModelDiscovery: () => ipcRenderer.invoke('update:modelDiscovery'),
  ucModelCandidates: () => ipcRenderer.invoke('update:modelCandidates'),
  ucModelValidation: () => ipcRenderer.invoke('update:modelValidation'),
  ucModelValidate: (opts) => ipcRenderer.invoke('update:modelValidate', opts),
  // P1-B：只读生产校验计划（零网络/零写盘）
  ucProductionValidationPlan: (opts) => ipcRenderer.invoke('update:productionValidationPlan', opts),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => { if (typeof cb === 'function') cb(p) }),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => { if (typeof cb === 'function') cb(info) }),
  onTrayCommand: (cb) => ipcRenderer.on('tray:command', (_e, data) => { if (typeof cb === 'function') cb(data) }),
  minesweeperOpen: () => ipcRenderer.send('minesweeper:open'),
  /* 相册此前只有托盘能打开（album:open 这个 IPC 在渲染层没有调用者）。
     这里补上桥，设置页就能给一个入口。 */
  albumOpen: () => ipcRenderer.send('album:open'),
  minesweeperReward: (payload) => ipcRenderer.send('minesweeper:reward', payload),
  onMinesweeperReward: (cb) => ipcRenderer.on('minesweeper:reward', (_e, data) => { if (typeof cb === 'function') cb(data) }),
  linesOpen: () => ipcRenderer.send('lines:open'),
  achievementsOpen: () => ipcRenderer.send('achievements:open'),
  birthdayCardOpen: () => ipcRenderer.send('birthday-card:open'),
  cleanRun: () => ipcRenderer.invoke('clean:run'),
  linesLoad: () => ipcRenderer.invoke('lines:load'),
  linesUpdate: (command) => ipcRenderer.invoke('lines:update', command),
  linesSave: (customLines, disabledGroups) => ipcRenderer.invoke('lines:save', customLines, disabledGroups),
  onLinesChanged: (cb) => ipcRenderer.on('lines:changed', (_e, value) => { if (typeof cb === 'function') cb(value) }),
  chatSend: (payload) => ipcRenderer.invoke('chat:send', payload),
  chatInfo: () => ipcRenderer.invoke('chat:info'),
  info: () => ipcRenderer.invoke('win:info'),
  dragStart: () => ipcRenderer.send('win:dragStart'),
  dragMove: (dx, dy) => ipcRenderer.send('win:dragMove', dx, dy),
  dragAlive: () => ipcRenderer.send('win:dragAlive'),
  dragEnd: () => ipcRenderer.send('win:dragEnd'),
  onDragEnded: (cb) => ipcRenderer.on('drag-ended', () => cb()),
  setMode: (m, anchor) => ipcRenderer.send('win:setMode', m, anchor),
  setClickThrough: (enabled) => ipcRenderer.send('pet:setClickThrough', !!enabled),
  // 主进程 60ms 轮询光标后推送"窗口内相对坐标"，
  // 替代原先靠 `forward: true` 转发整个桌面 mousemove 的做法（那会造成每秒上千次事件洪泛）。
  onMousePos: (cb) => ipcRenderer.on('pet:mousePos', (_e, x, y) => { if (typeof cb === 'function') cb(x, y) }),
  onMouseOutside: (cb) => ipcRenderer.on('pet:mouseOutside', () => { if (typeof cb === 'function') cb() }),
  openWeb: () => ipcRenderer.invoke('openWeb'),
  openAnimationSource: () => ipcRenderer.send('pet:animationSource'),
  stateLoad: () => ipcRenderer.invoke('state:load'),
  stateRead: () => ipcRenderer.invoke('state:read'),
  stateSave: (s) => ipcRenderer.invoke('state:save', s),
  memoryLoad: () => ipcRenderer.invoke('memory:load'),
  memorySave: (data) => ipcRenderer.invoke('memory:save', data),
  personaLoad: () => ipcRenderer.invoke('persona:load'),
  personaSave: (data) => ipcRenderer.invoke('persona:save', data),
  photoViewOpen: (id) => ipcRenderer.send('album:view', id),
  closePhotoView: () => ipcRenderer.send('album:viewClose'),
  pickImage: () => ipcRenderer.invoke('pickImage'),
  quit: () => ipcRenderer.send('app:quit'),
  onBeforeQuitFlush: (cb) => ipcRenderer.on('app:before-quit-flush', () => { if (typeof cb === 'function') cb() }),
  beforeQuitFlushDone: () => ipcRenderer.send('app:before-quit-flush-done'),
})
