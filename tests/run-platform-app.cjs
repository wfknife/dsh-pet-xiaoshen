'use strict'
// Real packaged Electron app + local synthetic provider. Own PID/data only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict')
const { spawn } = require('node:child_process'), WebSocket = require('ws')
const root = path.resolve(__dirname, '..'), record = path.resolve(root, '../research/virtual-character-20261014/implementation-p0-p8')
// A process-local TEMP root in the explicitly writable workspace avoids inherited
// Windows sandbox ACL failures; the existing test-edition canonical guards remain enabled.
const isolatedTemp = path.join(record, 'test-data/app-temp'); fs.mkdirSync(isolatedTemp, { recursive: true })
const directory = fs.mkdtempSync(path.join(isolatedTemp, 'deskpet-test-platform-'))
const requestLog = [], evidence = { directory, realProcess: true, modelService: 'local mock, no real model sampling', phases: [], resourceSamples: [] }
let providerMode = 'normal'
let child, socket, stdout = ''
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'synthetic-model' }] })); return }
  let raw = ''; for await (const part of req) raw += part
  const body = JSON.parse(raw); requestLog.push(body)
  const user = body.messages.at(-1).content
  const meta = user.includes('currentUserText')
  const planned = meta && user.includes('我打算整理一份小记')
  const content = meta ? JSON.stringify({ memory: planned ? { kind: 'plan', quote: '我打算整理一份小记', topic: '小记' } : { kind: 'preference', quote: '我喜欢无糖茶', topic: '无糖茶' } }) : '那先歇会儿，小记可以慢慢来。'
  if (providerMode === 'offline') { req.socket.destroy(); return }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: providerMode === 'truncated' ? '{"memory":' : content }, finish_reason: providerMode === 'truncated' ? 'length' : 'stop' }], usage: { completion_tokens: 20 } }))
})
const pause = ms => new Promise(r => setTimeout(r, ms))
async function waitFor(fn, label, timeout = 20000) {
  const begin = Date.now(); let last
  while (Date.now() - begin < timeout) { try { last = await fn(); if (last) return last } catch (e) { last = e.message }; await pause(200) }
  throw Error('timeout:' + label + ':' + JSON.stringify(last))
}
async function run() {
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const providerPort = server.address().port
  fs.writeFileSync(path.join(directory, 'pet-prefs.json'), JSON.stringify({ llmApi: { baseUrl: 'http://127.0.0.1:' + providerPort, apiKey: 'synthetic', credentialMode: 'own', model: 'synthetic-model' } }))
  fs.writeFileSync(path.join(directory, 'persona.json'), JSON.stringify({ schemaVersion: 2, identity: { displayName: '人工测试角色' } }))
  const debugServer = http.createServer(); await new Promise(r => debugServer.listen(0, '127.0.0.1', r)); const debugPort = debugServer.address().port; await new Promise(r => debugServer.close(r))
  const executable = path.join(record, 'candidate/win-unpacked/桌宠小深.exe')
  const isolation = require('../userdata-isolation.js').resolveUserData({ isPackaged: true, resourcesPath: path.join(path.dirname(executable), 'resources'),
    appDataPath: process.env.APPDATA, homedir: os.homedir(), tmpRoot: isolatedTemp, argv: ['--user-data-dir=' + directory], env: { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp }, devDir: path.join(root, 'data'), createTestDir: true })
  if (!isolation.ok || isolation.edition !== 'test') throw Error('preflight_isolation_refused')
  evidence.isolation = isolation; evidence.debugPort = debugPort
  const runEnv = { ...process.env, TEMP: isolatedTemp, TMP: isolatedTemp, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_ENABLE_STACK_DUMPING: '1' }; delete runEnv.ELECTRON_RUN_AS_NODE
  const testFlags = process.argv.includes('--native-startup-diagnostic') ? ['--no-sandbox', '--disable-gpu'] : []
  evidence.nativeDiagnosticFlags = testFlags
  child = spawn(executable, ['--user-data-dir=' + directory, '--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1', '--platform-test-hidden', ...testFlags], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: runEnv })
  child.stdout.on('data', p => { stdout += p }); child.stderr.on('data', p => { stdout += p }); evidence.pid = child.pid
  child.on('error', error => { evidence.spawnError = error.message })
  child.on('exit', (code, signal) => { evidence.exitCode = code; evidence.exitSignal = signal })
  const pages = await waitFor(async () => { if (child.exitCode !== null) throw Error('candidate_early_exit:' + child.exitCode); const r = await fetch('http://127.0.0.1:' + debugPort + '/json'); const j = await r.json(); return j.some(p => p.type === 'page') ? j : null }, 'debugger')
  const page = pages.find(p => p.type === 'page' && p.url.includes('index.html')) || pages.find(p => p.type === 'page')
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  let sequence = 0
  function evaluate(expression) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('message', listener); reject(Error('cdp_timeout')) }, 20000)
      function listener(raw) {
        const value = JSON.parse(raw); if (value.id !== id) return
        clearTimeout(timer); socket.off('message', listener)
        if (value.error || value.result && value.result.exceptionDetails) reject(Error(JSON.stringify(value.error || value.result.exceptionDetails)))
        else resolve(value.result.result.value)
      }
      socket.on('message', listener); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
  }
  const readiness = await waitFor(() => evaluate('(async()=>({ready:!!window.RoleRuntime&&!!window.PetLife&&window.PetLife.snapshot().ready, platform:window.PlatformCandidate}))()').then(x => x.ready && x.platform ? x : null), 'renderer ready')
  assert.equal(readiness.platform.enabled, true); evidence.phases.push({ phase: 'real candidate boot', ok: true })
  await evaluate(`document.getElementById('charc-input').value='我喜欢无糖茶，今天想先歇会儿。';document.getElementById('charc-send').click();true`)
  await waitFor(async () => {
    const history = await evaluate('window.pet.characterHistoryLoad()')
    return history.some(h => h.role === 'assistant') ? history : null
  }, 'actual user surface reply')
  const completed = await waitFor(async () => {
    if (!fs.existsSync(path.join(directory, 'character-platform.json'))) return null
    const p = JSON.parse(fs.readFileSync(path.join(directory, 'character-platform.json'))).payload
    return Object.values(p.operations).find(o => o.type === 'fact' && o.status === 'completed') || null
  }, 'durable fact and memory')
  assert.ok(completed.obligations.lifeApplied && completed.obligations.memoryPersisted)
  const memory = JSON.parse(fs.readFileSync(path.join(directory, 'memories.json')))
  assert.ok(memory.memories.some(m => (m.evidenceRefs || []).some(e => e.messageRef === completed.sourceRefs[0])))
  evidence.phases.push({ phase: 'UI->Runtime->Gen2->provider->history->PetLife->Memory persistence', ok: true, operation: completed.id })
  const sample = await evaluate('window.pet.getForegroundApp()'); evidence.desktopObservation = { available: !!sample, sourceType: sample && sample.sourceType, trust: sample && sample.trust }
  const installed = []
  for (const id of ['desktop-observer', 'virtual-notebook']) {
    const folder = path.join(root, 'trusted-extensions', id)
    const result = await evaluate('window.pet.platform.packageInstall(' + JSON.stringify(folder) + ')')
    assert.equal(result.ok, true, JSON.stringify(result)); installed.push(result)
  }
  evidence.phases.push({ phase: 'two actual local packages installed into isolated host', ok: true, installed })
  const byPackage = await evaluate('window.pet.getForegroundApp()')
  const host = JSON.parse(fs.readFileSync(path.join(directory, 'character-platform.json'))).payload
  assert.ok(Object.values(host.operations).some(o => o.provider === 'trusted.desktop-observer' && ['completed', 'failed'].includes(o.status)))
  evidence.phases.push({ phase: 'actual desktop provider selected through installed package', ok: true, observationAvailable: !!byPackage })
  await evaluate(`document.getElementById('charc-input').value='我打算整理一份小记。';document.getElementById('charc-send').click();true`)
  const project = await waitFor(async () => {
    const p = await evaluate('window.pet.platform.projection()'); return p.projects && p.projects[0] || null
  }, 'project from actual saved UI fact')
  await evaluate('window.RoleRuntime.setQuietUntil(Date.now()+600000);true')
  async function projectStep(number) {
    return evaluate(`window.RoleRuntime.submit({kind:'verify-project',origin:'user-feedback',id:${JSON.stringify('verify:' + project.id + ':' + number)}},async e=>{
      const r=window.CharacterCapabilities.create({store:window.pet.platform,authorize:(permit,effect)=>effect==='virtual'&&window.RoleRuntime.isAuthorized(permit)});
      r.register({id:'life.virtual-project',provider:'builtin.virtual-notebook',version:'1',effect:'virtual'},async(i,host)=>window.pet.platform.projectStep(i.projectId,host.operationId));
      return r.execute({id:${JSON.stringify('verify:' + project.id + ':' + number)},capabilityId:'life.virtual-project',effect:'virtual',input:{projectId:${JSON.stringify(project.id)}},sourceRefs:${JSON.stringify(project.sourceRefs)},deadline:Date.now()+30000},e);
    })`)
  }
  const firstStep = await projectStep(0); assert.equal(firstStep.ok, true, JSON.stringify(firstStep))
  const paused = await evaluate('window.pet.platform.projection()'); assert.equal(paused.projects[0].status, 'paused')
  const finalStep = await projectStep(1); assert.equal(finalStep.ok, true, JSON.stringify(finalStep))
  assert.equal((await evaluate('window.pet.platform.projection()')).projects.length, 0)
  const projectReceipts = JSON.parse(fs.readFileSync(path.join(directory, 'character-platform.json'))).payload
  assert.equal(projectReceipts.projects[project.id].results.length, 2)
  assert.ok(Object.values(projectReceipts.operations).some(o => o.capabilityId === 'life.virtual-project' && o.provider === 'trusted.virtual-notebook' && o.status === 'completed'))
  evidence.phases.push({ phase: 'saved plan -> real core authorization -> installed worker -> two virtual results -> future candidate removal', ok: true, projectId: project.id, outputVirtualOnly: true })
  for (const row of installed) {
    const originalFolder = path.join(root, 'trusted-extensions', row.id === 'trusted.desktop-observer' ? 'desktop-observer' : 'virtual-notebook')
    const manifest = JSON.parse(fs.readFileSync(path.join(originalFolder, 'manifest.json'))), originalCode = fs.readFileSync(path.join(originalFolder, 'entry.cjs'), 'utf8')
    const upgrade = path.join(directory, row.id + '-upgrade'); fs.mkdirSync(upgrade, { recursive: true })
    const code = originalCode + '\n// isolated compatible upgrade\n'; fs.writeFileSync(path.join(upgrade, 'entry.cjs'), code)
    manifest.version = '1.1.0'; manifest.files['entry.cjs'] = require('node:crypto').createHash('sha256').update(code).digest('hex'); fs.writeFileSync(path.join(upgrade, 'manifest.json'), JSON.stringify(manifest))
    assert.equal((await evaluate('window.pet.platform.packageInstall(' + JSON.stringify(upgrade) + ')')).ok, true)
    const broken = path.join(directory, row.id + '-broken'); fs.mkdirSync(broken, { recursive: true })
    const brokenCode = "module.exports={start:()=>{throw Error('isolated_startup_failure')}}"; fs.writeFileSync(path.join(broken, 'entry.cjs'), brokenCode)
    manifest.version = '2.0.0'; manifest.files['entry.cjs'] = require('node:crypto').createHash('sha256').update(brokenCode).digest('hex'); fs.writeFileSync(path.join(broken, 'manifest.json'), JSON.stringify(manifest))
    assert.equal((await evaluate('window.pet.platform.packageInstall(' + JSON.stringify(broken) + ')')).ok, false)
    assert.equal((await evaluate('window.pet.platform.packageRollback(' + JSON.stringify(row.id) + ')')).ok, true)
    assert.equal((await evaluate('window.pet.platform.packageDisable(' + JSON.stringify(row.id) + ')')).ok, true)
  }
  evidence.phases.push({ phase: 'both actual packages compatible upgrade, failed upgrade recovery, code/data rollback and disable', ok: true })
  for (const row of installed) assert.equal((await evaluate('window.pet.platform.packageUninstall(' + JSON.stringify(row.id) + ')')).ok, true)
  const originalAt = Date.now() - 86400000
  await evaluate('window.pet.characterHistoryAppend(' + JSON.stringify({ role: 'assistant', text: '这是合成的主动开场', selfInitiated: true, messageRef: 'synthetic:anchor' }) + ')')
  const history = await evaluate('window.pet.characterHistoryLoad()')
  const anchor = history.find(h => h.messageRef === 'synthetic:anchor'); assert.equal(anchor.selfInitiated, true)
  await evaluate('(async()=>{const history=await window.pet.characterHistoryLoad();return window.Gen2.chatReply({role:"chat",userText:"刚才那件事先放一放",messageRef:"synthetic:provider-check",scale:"normal",history,context:window.CharacterSnapshot.toCharacterAIContext("")})})()')
  assert.ok(requestLog.some(r => r.messages.some(m => m.role === 'system' && m.content.includes('synthetic:anchor') && m.content.includes('"selfInitiated":true'))))
  assert.ok(requestLog.some(r => r.messages.some(m => m.role === 'system' && m.content.includes('【本次相关语境】'))))
  evidence.phases.push({ phase: 'saved proactive selfInitiated/reference/time reach real HTTP request object', ok: true, anchorAt: anchor.ts, originalAtUnused: originalAt })
  for (const mode of ['truncated', 'offline']) {
    providerMode = mode
    const response = await evaluate('window.Gen2.turnMeta({userText:"我喜欢无糖茶。",history:[]})')
    assert.equal(response.ok, false); evidence.phases.push({ phase: 'actual provider ' + mode, ok: true, reason: response.reason })
  }
  providerMode = 'normal'
  const backup = await evaluate('window.pet.platform.export()'), forgottenRef = completed.sourceRefs[0]
  assert.equal((await evaluate('window.pet.platform.forget(' + JSON.stringify([forgottenRef]) + ')')).ok, true)
  assert.equal((await evaluate('window.pet.platform.restore(' + JSON.stringify(backup) + ')')).ok, true)
  assert.equal(await evaluate('window.pet.characterHistorySource(' + JSON.stringify(forgottenRef) + ')'), null)
  const projectedHistory = await evaluate('window.pet.characterHistoryLoad()')
  assert.equal(projectedHistory.find(row => row.messageRef === forgottenRef).sourcePermission, 'revoked')
  evidence.phases.push({ phase: 'actual backup -> forget -> restore does not revive source or provider permission', ok: true })
  const stableStart = Date.now()
  for (let n = 0; n < 6; n++) {
    const value = await evaluate('({heap:performance.memory&&performance.memory.usedJSHeapSize,runtime:window.RoleRuntime.snapshot(),platformContext:window.PlatformContext})')
    const stats = fs.statSync(path.join(directory, 'character-platform.json'))
    evidence.resourceSamples.push({ at: Date.now(), rendererHeapBytes: value.heap || null, pendingFacts: value.runtime.factJobs.length, queued: value.runtime.queued.length, storeBytes: stats.size })
    assert.ok(value.runtime.factJobs.length <= 8 && value.runtime.queued.length < 20 && stats.size < 4 * 1024 * 1024)
    await pause(10000)
  }
  evidence.stability = { durationMs: Date.now() - stableStart, passed: true, resourceBound: { rendererHeap: 'observed, no growth guarantee', queue: 20, pendingFacts: 8, storeBytes: 4194304 }, multiYearValidated: false }
  await evaluate('window.pet.quit();true')
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'candidate exit', 10000)
  evidence.phases.push({ phase: 'own candidate process shutdown', ok: true })
}
run().then(() => { evidence.ok = true }, e => { evidence.ok = false; evidence.error = e.message; process.exitCode = 1 }).finally(async () => {
  if (socket) socket.close()
  if (child && child.exitCode === null && child.signalCode === null) child.kill()
  server.close(); const rendered = JSON.stringify({ ...evidence, providerRequests: requestLog }, null, 2)
  fs.writeFileSync(path.join(record, 'actual-app-evidence-' + Date.now() + '.json'), rendered)
  fs.writeFileSync(path.join(record, 'actual-app-evidence.json'), rendered); fs.writeFileSync(path.join(record, 'actual-app.log'), stdout)
  console.log(JSON.stringify({ ok: evidence.ok, error: evidence.error || null, directory, phases: evidence.phases, stability: evidence.stability || null }))
})
