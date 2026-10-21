'use strict'
// At most 24 actual isolated requests, including all provider retries. No production writes.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto')
const root = path.resolve(__dirname, '..'), record = path.resolve(root, '../research/virtual-character-20261014/implementation-p0-p8')
const output = path.join(record, 'model-samples'); fs.mkdirSync(output, { recursive: true })
const finalCandidate = process.argv.includes('--final-candidate')
const protocolCandidate = process.argv.includes('--current-protocol')
const ledgerFile = path.join(output, 'calls.json')
const ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile)) : { limit: 24, calls: [], stopped: false }
const installed = path.join(process.env.APPDATA, 'deskpet-xiaoshen')
const prefs = fs.existsSync(path.join(installed, 'pet-prefs.json')) ? JSON.parse(fs.readFileSync(path.join(installed, 'pet-prefs.json'))) : {}
const configuration = prefs.llmApi || {}
const credentials = path.join(os.homedir(), '.dsh', '.credentials.yaml')
let inherited = ''
if (fs.existsSync(credentials)) inherited = (fs.readFileSync(credentials, 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(sk-[A-Za-z0-9]+)/) || [])[1] || ''
const key = configuration.apiKey || (!configuration.baseUrl || configuration.baseUrl === 'https://api.deepseek.com' ? inherited : '')
const registry = require('../model-registry.js')
const model = configuration.model || prefs.modelPrefs && prefs.modelPrefs.character || prefs.chatModel || registry.modelFor('character')
const baseUrl = configuration.baseUrl || 'https://api.deepseek.com'
// Safer sampling boundary: NEVER read or transmit installed persona/prompts.
// Both arms use the same source-code fallback prompts and synthetic identity.
const texts = {}, currentPrompt = null
const persona = { identity: { displayName: '人工测试角色' } }
const now = new Date('2026-10-14T18:00:00+08:00').getTime()
let label = null, halted = ledger.stopped
const hash = content => crypto.createHash('sha256').update(content).digest('hex')
function saveLedger() { fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2)) }
const sourceMain = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const main = vm.createContext({ console, URL, AbortController, setTimeout, clearTimeout, ModelRegistry: registry,
  pairAwareHistoryWindow: require('../renderer/memory/history-window.js').pairAwareHistoryWindow,
  llmApiPref: () => ({ baseUrl, apiKey: key, model, temps: configuration.temps || {} }), recordDirectModelUse() {},
  fetch: async (url, options) => {
    if (halted || ledger.calls.length >= ledger.limit) throw Error('isolated_sampling_stopped')
    const id = ledger.calls.length + 1, call = { id, label, startedAt: new Date().toISOString(), request: JSON.parse(options.body) }
    ledger.calls.push(call); saveLedger()
    try {
      const response = await fetch(url, options), raw = await response.text()
      call.finishedAt = new Date().toISOString(); call.httpStatus = response.status
      try { call.response = JSON.parse(raw) } catch (_) { call.response = raw }
      if (!response.ok) { halted = true; ledger.stopped = true; ledger.stopReason = 'service_failed:' + response.status }
      saveLedger()
      return { ok: response.ok, status: response.status, text: async () => raw, json: async () => JSON.parse(raw) }
    } catch (e) { call.finishedAt = new Date().toISOString(); call.error = e.message; halted = true; ledger.stopped = true; ledger.stopReason = 'service_failed:' + e.message; saveLedger(); throw e }
  } })
vm.runInContext(sourceMain.slice(sourceMain.indexOf('async function callDirectLLM('), sourceMain.indexOf("ipcMain.handle('llm:direct'")), main)
function browser(version) {
  const requests = [], metadata = []
  const window = { PlatformCandidate: { enabled: version === 'B' }, PromptConfig: { text: (id, fallback) => typeof texts[id] === 'string' ? texts[id] : fallback,
    controls: () => currentPrompt && currentPrompt.controls || {}, revision: () => currentPrompt && currentPrompt.revision || 'defaults' },
    ExpressionStylePolicy: require('../renderer/dialogue/style/style-policy.js').createPolicy(() => ({ rules: JSON.parse(fs.readFileSync(path.join(root, 'renderer/dialogue/style/rules.json'))), profiles: JSON.parse(fs.readFileSync(path.join(root, 'renderer/dialogue/style/profiles.json'))) })),
    PetLifeModule: require('../renderer/life/pet-life.js'), ContextProjector: require('../renderer/dialogue/context-projector.js'),
    EvidenceClaims: version === 'B' ? require('../renderer/dialogue/evidence-claims.js') : null,
    pet: { llmDirect: async p => { requests.push(p); return main.callDirectLLM(p) } } }
  const sandbox = vm.createContext({ window, console, Date, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} } })
  const baseline = path.join(record, 'baseline/files/renderer')
  for (const file of ['dialogue/slots.js', 'life/state-tier.js', 'life/conversation-policy.js', 'dialogue/aigateway.js', 'dialogue/gen2.js']) {
    const source = fs.readFileSync(path.join(version === 'A' ? baseline : path.join(root, 'renderer'), file), 'utf8')
    vm.runInContext(source, sandbox, { filename: version + ':' + file })
  }
  window.ConversationPolicy = sandbox.ConversationPolicy
  return { window, requests, metadata }
}
const history = [{ role: 'user', text: '我今天打算整理一份小记。', messageRef: 'synthetic:user:earlier', ts: now - 86400000 },
  { role: 'assistant', text: '那份小记要是还想接着整理，我们可以慢慢来。', messageRef: 'synthetic:assistant:earlier', ts: now - 86400000 + 1000 },
  { role: 'assistant', text: '上次说的小记，后来你想怎么收尾？', messageRef: 'synthetic:proactive:1', selfInitiated: true, ts: now - 3600000 }]
const context = { capturedAt: now, personaProjection: persona.core || persona, selfState: { energy: 28, satiety: 70, thirst: 75 }, emotion: { derivedMood: 'tired' },
  runtimeFacts: { capturedAt: now }, recentInteractions: history,
  platform: { concerns: [{ id: 'concern:synthetic', quote: '整理一份小记', status: 'open', sourceRefs: ['synthetic:user:earlier'], nextCheckAt: now, expiresAt: now + 3600000 }],
    results: [{ id: 'operation:synthetic', effect: 'virtual', eventAt: now - 120000, sourceRefs: ['synthetic:user:earlier'], receipt: { virtual: true, kind: 'virtual_notebook', text: '小记材料已整理；仅存在桌宠世界。' } }] } }
const cases = [
  { id: 'chat-continuity', task: 'M1_reply', userText: '我刚才已经说了，小记暂时不整理了，想先歇会儿。' },
  { id: 'chat-current-state', task: 'M1_reply', userText: '你今天有什么想接着做的小事？' },
  { id: 'proactive-old-source', task: 'M2_say', candidate: { id: 'candidate:old', text: '昨天主人说打算整理一份小记，尚无完成证据。', date: '2026-10-13', fresh: false, sourceKeys: ['synthetic:user:earlier'], forms: ['share'] }, focus: '昨天未完的小记', form: 'share' },
  { id: 'proactive-virtual-result', task: 'M2_say', candidate: { id: 'candidate:virtual', text: '桌宠世界里完成了虚拟小记的材料整理，没有写真实文件。', date: '2026-10-14', fresh: true, sourceKeys: ['operation:synthetic'], forms: ['share'] }, focus: '虚拟小记材料', form: 'share' }
]
async function run() {
  const results = (finalCandidate || protocolCandidate) && fs.existsSync(path.join(output, 'results.json')) ? JSON.parse(fs.readFileSync(path.join(output, 'results.json'))).map(r => ({ phase: 'initial-candidate', ...r })) : []
  if (!key) { ledger.stopped = true; ledger.stopReason = 'no_existing_model_credentials'; saveLedger() }
  for (const item of cases.filter(c => protocolCandidate ? c.id === 'proactive-virtual-result' : !finalCandidate || c.id !== 'chat-continuity')) for (const version of ['A', 'B']) {
    label = (finalCandidate ? 'final:' : '') + item.id + ':' + version
    if (halted || !key || ledger.calls.length >= ledger.limit) { results.push({ caseId: item.id, version, status: 'not_generated', reason: ledger.stopReason || 'call_budget' }); continue }
    const b = browser(version), first = ledger.calls.length + 1
    let result, meta
    try {
      if (item.task === 'M1_reply') {
        const frame = b.window.ConversationPolicy.analyzeTurn({ userText: item.userText, messageRef: 'synthetic:' + item.id, nowTs: now, life: {} })
        result = await b.window.Gen2.chatReply({ role: 'chat', userText: item.userText, messageRef: 'synthetic:' + item.id, context: structuredClone(context), history: structuredClone(history), frame, scale: 'normal', maxTokens: 1536,
          onMetadata: promise => b.metadata.push(promise) })
        meta = await Promise.all(b.metadata)
      } else {
        const candidate = structuredClone(item.candidate), p = { context: structuredClone(context), recentOpenings: [], history: structuredClone(history), candidates: [candidate] }
        const raw = { speak: true, candidateId: candidate.id, focus: item.focus, form: item.form }
        const v = b.window.PetLifeModule.validateDecision({ ...raw, opening: item.focus }, [candidate])
        result = await b.window.Gen2.proactiveSay({ ok: true, prepared: { p, raw, v } })
      }
    } catch (e) { result = { ok: false, reason: e.message } }
    results.push({ phase: protocolCandidate ? 'current-protocol' : finalCandidate ? 'final-candidate' : 'initial-candidate', generationHash: hash(fs.readFileSync(path.join(version === 'A' ? path.join(record, 'baseline/files/renderer') : path.join(root, 'renderer'), 'dialogue/gen2.js'))),
      caseId: item.id, version, task: item.task, fixedInput: item, fixedContext: context, history, model, callIds: ledger.calls.slice(first - 1).map(c => c.id), result, metadata: meta || [], requests: b.requests,
      humanEvaluation: { AI模板感: null, 小深角色一致性: null, 自然相处感: null, 陪伴模板感: null, 情绪是否过量: null } })
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
  const manifest = { sourceVersions: { A: hash(fs.readFileSync(path.join(record, 'baseline/files/renderer/dialogue/gen2.js'))), B: hash(fs.readFileSync(path.join(root, 'renderer/dialogue/gen2.js'))) },
    model, baseUrl, calls: ledger.calls.length, limit: ledger.limit, budgetRemaining: Math.max(0, ledger.limit - ledger.calls.length), stopped: ledger.stopped,
    stopReason: ledger.stopReason || (ledger.calls.length >= ledger.limit ? 'call_budget_exhausted' : null), protocol: 'fixed focus/form/candidate and same model/generation parameters; M1_meta parallel in both versions', inputPolicy: 'fully synthetic identity/history/context and source-code fallback prompts; installed persona/prompts never read or transmitted', limitations: ['does not evaluate current private persona/prompt configuration'], adopted: false }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  let markdown = '# 全部固定 A/B 模型样本\n\n状态：待用户评价；工程测试不判定表达采用。原始请求、每次响应与失败均在 calls.json/results.json。\n\n' +
    `模型：${model}；实际请求 ${ledger.calls.length}/24；停止原因：${ledger.stopReason || '无'}。\n\n`
  for (const row of results) markdown += `## ${row.phase || 'initial-candidate'} / ${row.caseId} / ${row.version}\n\n${row.result ? row.result.text || row.result.opening || JSON.stringify(row.result) : row.reason}\n\n` +
    '评价：AI模板感____；小深角色一致性____；自然相处感____；陪伴模板感____；情绪是否过量____。\n\n'
  fs.writeFileSync(path.join(output, '全部样本.md'), markdown)
  console.log(JSON.stringify({ actualCalls: ledger.calls.length, model, stopReason: ledger.stopReason || null, results: results.map(r => ({ caseId: r.caseId, version: r.version, ok: r.result && r.result.ok, reason: r.reason || r.result && r.result.reason || null })), output }))
}
run().catch(e => { console.error(e.message); process.exitCode = 1 })
