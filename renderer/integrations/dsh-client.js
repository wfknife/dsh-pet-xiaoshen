/* DSHClient — Phase 11
 * 渲染层统一 DSH 请求边界。所有现有 window.pet.api 调用都会自动经过这里。
 * 提供 timeout / error 包装，保留原始 IPC 行为不变。
 */
window.DSHClient = (function () {
  const rawApi = window.pet && typeof window.pet.api === 'function'
    ? window.pet.api.bind(window.pet)
    : null
  const semanticApi = window.pet && typeof window.pet.dshCall === 'function'
    ? window.pet.dshCall.bind(window.pet)
    : rawApi
  const DEFAULT_TIMEOUT = 8000
  let mockMode = 'off'
  let mockCalls = 0

  function setMockMode(mode) { mockMode = mode || 'off'; mockCalls = 0 }
  function getMockMode() { return { mode: mockMode, calls: mockCalls } }


  async function request(method, payload, opts) {
    if (!rawApi && mockMode === 'off') throw new Error('DSHClient: window.pet.api unavailable')
    if (mockMode !== 'off') {
      mockCalls++
      if (mockMode === 'unavailable') throw new Error('DSH mock: unavailable')
      if (mockMode === 'timeout') { await new Promise((r) => setTimeout(r, 300)); throw new Error('DSH mock: timeout') }
      if (mockMode === 'invalid') return { result: { ok: false, error: 'mock invalid response' } }
      if (mockMode === 'disconnect') throw new Error('DSH mock: disconnected')
    }
    const timeout = (opts && opts.timeout) || DEFAULT_TIMEOUT
    let timer = null
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DSH timeout: ' + method)), timeout)
    })
    try {
      return await Promise.race([semanticApi(method, payload || {}), timeoutPromise])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function sessionList() { return request('session.list', {}) }
  function sessionCreate(payload) { return request('session.create', payload || {}) }
  function sessionRename(payload) { return request('session.rename', payload || {}) }
  function sessionArchive(payload) { return request('session.archive', payload || {}) }
  function sessionHistory(payload) { return request('session.history', payload || {}) }
  function sessionPrompt(payload) { return request('session.prompt', payload || {}) }
  function workspaceList() { return request('workspace.list', {}) }
  function workspaceArchive(payload) { return request('workspace.archiveSession', payload || {}) }
  function agentPresetList() { return request('agentPreset.list', {}) }
  function agentPresetSelect(payload) { return request('agentPreset.select', payload || {}) }
  function sessionModels(payload) { return request('session.models', payload || {}) }
  function sessionSelectModel(payload) { return request('session.selectModel', payload || {}) }

  // 接管现有 window.pet.api：所有旧调用自动获得 timeout，不改变返回值结构。
  if (rawApi) {
    window.pet.api = (method, payload) => request(method, payload)
  }

  return { request, sessionList, sessionCreate, sessionRename, sessionArchive, sessionHistory, sessionPrompt, workspaceList, workspaceArchive, agentPresetList, agentPresetSelect, sessionModels, sessionSelectModel, setMockMode, getMockMode }
})()
