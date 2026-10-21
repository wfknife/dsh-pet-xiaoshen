'use strict'
// Targeted live-main-chain check. Real Electron + real main/preload/renderer +
// configured model, synthetic chat, canonical temporary userData. No legacy data.
const { app, BrowserWindow, utilityProcess } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '..')
const output = path.resolve(root, '../research/long-lived-character-cutover-20261018/logs')
const outputBase = process.env.DESKPET_ACCEPTANCE_REPORT || 'desktop-live'
const mainTarget = process.env.DESKPET_ACCEPTANCE_MAIN || path.join(root,'main.js')
const resume = process.argv.includes('--resume')
const previous = resume ? JSON.parse(fs.readFileSync(path.join(output, outputBase+'.json'))) : null
const dataDir = previous?.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-test-character-live-'))
process.env.DESKPET_CHARACTER_TRIAL_DATA = dataDir
process.env.DESKPET_CHARACTER_KERNEL = 'candidate'
// Existing authorized model configuration is used only in this temporary copy.
if (!resume) fs.copyFileSync(path.join(root, 'data/pet-prefs.json'), path.join(dataDir, 'pet-prefs.json'))
let kernelChild, holdPresentation = false, heldPresentation = null
const fork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (...args) => {
  const child = fork(...args)
  if (String(args[0]).endsWith('entry-kernel.cjs')) {
    kernelChild = child
    child.on('message', message => { if (holdPresentation && message.type==='request' && message.method==='presentation.publish') heldPresentation={id:message.id,...message.params} })
    const post=child.postMessage.bind(child)
    child.postMessage=message=>{if(holdPresentation && message.type==='response' && message.id===heldPresentation?.id)return;post(message)}
  }
  return child
}
const report = { dataDir, runtime: process.versions, errors: [], stages: [] }
// Capture only this harness's synthetic generation outputs, never connection data.
const provider = require(path.join(path.dirname(mainTarget),'model-provider.cjs')), createClient = provider.createClient
provider.createClient = (...args) => {
  const client = createClient(...args), complete = client.complete
  client.complete = async (...args) => {
    const result = await complete(...args)
    ;(report.modelOutputs ||= []).push({ ok: result.ok, text: result.text, error: result.error })
    return result
  }
  return client
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let finished = false
function finish(ok, reason) {
  if (finished) return
  finished = true
  Object.assign(report, { ok, reason, completedAt: new Date().toISOString() })
  report.mainTarget=mainTarget
  fs.writeFileSync(path.join(output, outputBase+(resume?'-restart':'')+'.json'), JSON.stringify(report, null, 2))
  process.stdout.write(JSON.stringify({ ok, reason, dataDir, stages: report.stages }) + '\n')
  app.quit()
}
app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (_event, level, message) => { if (level >= 2) report.errors.push(String(message).slice(0, 600)) })
  contents.on('render-process-gone', (_event, detail) => report.errors.push('renderer_gone:' + detail.reason))
})
require(mainTarget)
app.whenReady().then(async () => {
  try {
    let win
    for (let i = 0; i < 100; i++) {
      win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html'))
      if (win && !win.webContents.isLoading()) break
      await sleep(100)
    }
    if (!win) throw Error('desktop_window_missing')
    const run = code => win.webContents.executeJavaScript(code, true)
    let status
    for (let i = 0; i < 100; i++) {
      status = await run('window.pet?.character?.status()')
      if (status?.state === 'ready') break
      await sleep(100)
    }
    if (!status?.writable || !status.authority) throw Error('kernel_not_authoritative_in_trial:' + JSON.stringify(status))
    report.stages.push('electron_kernel_ready')
    report.before = await run('({runtime:window.RoleRuntime.snapshot(),view:window.CharacterView.state()})')
    if (report.before.runtime.authority !== 'kernel') throw Error('legacy_runtime_still_running')
    report.stages.push('renderer_kernel_authority')
    if (resume) {
      report.history = (await run("window.pet.character.read({kind:'history'})")).history
      report.projection = await run("window.pet.character.read()")
      if (report.history.length !== previous.history.length || report.projection.state.nurture.feedCount !== previous.afterRecovery.state.nurture.feedCount) throw Error('app_restart_state_changed')
      if (report.history.some(row => row.messageRef === 'recovery:deleted')) throw Error('deleted_source_resurrected')
      if ((await run('window.CharacterView.state()')).presenting) throw Error('app_restart_replayed_speech')
      if(previous.unknownOperation && !(await run("window.pet.character.read({kind:'operations'})")).operations.some(op=>op.operationId===previous.unknownOperation.operationId&&op.status==='unknown'))throw Error('unknown_operation_lost')
      report.stages.push('app_restart_no_replay_state_and_tombstone_preserved'); finish(true, null); return
    }
    await run(`document.getElementById('mini-chat-input').value='请记住：我最喜欢的饮料是红茶。这是一条隔离验收消息，请只回复“收到”。';document.getElementById('mini-chat-send').click()`)
    for (let i = 0; i < 180; i++) {
      const history = await run("window.pet.character.read({kind:'history'})")
      if (history.history?.some(row => row.role === 'assistant')) { report.history = history.history; break }
      await sleep(500)
    }
    report.status = await run("window.pet.character.read({kind:'status'})")
    report.operations = await run("window.pet.character.read({kind:'operations'})")
    report.view = await run('window.CharacterView.state()')
    fs.writeFileSync(path.join(output, outputBase+'.png'), (await win.webContents.capturePage()).toPNG())
    if (!report.history) throw Error('owner_reply_missing')
    report.stages.push('user_kernel_model_history')
    const ids = report.operations.operations.map(op => op.operationId)
    report.stages.push('presentation_operations:' + ids.length)
    const submit = (kind, payload, commandId) => run(`window.pet.character.submit(${JSON.stringify({ schemaVersion: 1, kind, payload, commandId })})`)
    await submit('owner.interaction', {kind:'feed'}, 'live:feed')
    const fed = await run('window.pet.character.read()')
    await submit('owner.interaction', {kind:'feed'}, 'live:feed')
    if ((await run('window.pet.character.read()')).state.nurture.feedCount !== fed.state.nurture.feedCount) throw Error('duplicate_feed_reward')
    await submit('owner.interaction', {kind:'animation',name:'idle-stretch'}, 'live:animation')
    for (let i=0;i<100;i++) { if ((await run('window.pet.character.read()')).state.nurture.animSeen.includes('idle-stretch')) break; await sleep(100) }
    report.animation = await run('window.pet.character.read()')
    if (!report.animation.state.nurture.animSeen.includes('idle-stretch')) throw Error('animation_completion_missing')
    report.stages.push('real_animation_completion_and_nurture_once')
    await submit('owner.message', {messageRef:'recovery:deleted',text:'这是一条随后删除的隔离测试消息。'}, 'live:deleted-input')
    await submit('owner.forget', {sourceIds:['recovery:deleted']}, 'live:forget')
    const oldEpoch = (await run('window.pet.character.status()')).epoch
    holdPresentation=true
    await run("void window.pet.character.submit({commandId:'live:uncertain-animation',kind:'owner.interaction',payload:{kind:'animation',name:'idle-stretch'}})")
    for(let i=0;i<50&&!heldPresentation;i++)await sleep(20)
    if(!heldPresentation)throw Error('uncertain_presentation_not_dispatched')
    report.beforeCrashOperation=(await run("window.pet.character.read({kind:'operations'})")).operations.find(op=>op.operationId===heldPresentation.operationId)
    if(report.beforeCrashOperation?.status!=='dispatched')throw Error('unknown_fixture_not_in_flight')
    kernelChild.kill()
    holdPresentation=false
    for (let i=0;i<150;i++) { const s=await run('window.pet.character.status()'); if(s.state==='ready' && s.epoch>oldEpoch) break; await sleep(100) }
    report.kernelRecovery = await run('window.pet.character.status()')
    if (report.kernelRecovery.epoch <= oldEpoch) throw Error('kernel_restart_missing')
    win.webContents.reload()
    await sleep(1200)
    for(let i=0;i<100;i++) { if(!win.webContents.isLoading() && (await run('window.CharacterView?.state()'))?.started) break; await sleep(100) }
    report.afterRecovery = await run('window.pet.character.read()')
    report.unknownOperation=(await run("window.pet.character.read({kind:'operations'})")).operations.find(op=>op.operationId===heldPresentation.operationId)
    if(report.unknownOperation?.status!=='unknown')throw Error('uncertain_operation_was_replayed_or_falsely_completed')
    report.history = (await run("window.pet.character.read({kind:'history'})")).history
    report.diary = await run("window.pet.character.read({kind:'diary'})")
    report.memory = await run("window.pet.character.read({kind:'memory'})")
    if (!JSON.stringify(report.memory).includes('红茶')) throw Error('sourced_owner_memory_missing')
    if (report.afterRecovery.state.nurture.feedCount !== fed.state.nurture.feedCount || report.history.some(row=>row.messageRef==='recovery:deleted')) throw Error('recovery_state_or_tombstone_failed')
    if ((await run('window.CharacterView.state()')).presenting) throw Error('reload_replayed_speech')
    report.stages.push('kernel_crash_renderer_reload_no_replay_forget_preserved')
    finish(true, null)
  } catch (error) { finish(false, error.message) }
})
setTimeout(() => finish(false, 'desktop_deadline'), 110000).unref()
