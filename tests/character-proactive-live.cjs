'use strict'
// Real desktop and configured model. Synthetic preconditions are explicitly seeded;
// this is not evidence of four hours of unattended wall-clock operation.
const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const scenario=process.argv.find(x=>x.startsWith('--case='))?.slice(7)||'no-event'
const tag=process.argv.find(x=>x.startsWith('--tag='))?.slice(6)||'first'
if(!['game','animation','no-event','conversation','quiet','owner-reminder'].includes(scenario))throw Error('unknown_case')
const root=path.resolve(__dirname,'..'),out=path.resolve(root,'../research/long-lived-character-cutover-20261018/logs')
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'deskpet-test-proactive-'))
process.env.DESKPET_CHARACTER_TRIAL_DATA=dataDir;process.env.DESKPET_CHARACTER_KERNEL='candidate'
fs.copyFileSync(path.join(root,'data/pet-prefs.json'),path.join(dataDir,'pet-prefs.json'))
const report={scenario,dataDir,seeded:true,startedAt:new Date().toISOString(),modelOutputs:[],errors:[]}
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const provider=require('../model-provider.cjs'),create=provider.createClient
provider.createClient=(...args)=>{const c=create(...args),complete=c.complete;c.complete=async(...args)=>{const r=await complete(...args);report.modelOutputs.push({ok:r.ok,text:r.text,error:r.error});return r};return c}
let finished=false
function finish(ok,reason){if(finished)return;finished=true;Object.assign(report,{ok,reason,finishedAt:new Date().toISOString()});fs.writeFileSync(path.join(out,'proactive-'+scenario+'-'+tag+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({scenario,ok,reason,history:report.history,modelCalls:report.modelOutputs.length}));app.quit()}
app.on('web-contents-created',(_,wc)=>wc.on('console-message',(_,level,message)=>{if(level>=2)report.errors.push(message)}))
;(async()=>{
  const {createKernel}=require('../character/runtime/kernel.cjs'),{resolvePaths,createConfig}=require('../character/config.cjs')
  const k=createKernel({dataDir,paths:resolvePaths({dataDir,mode:'candidate'}),config:createConfig(),bootstrapLegacy:true})
  const started=k.start();if(!started.ok)throw Error('seed_failed:'+JSON.stringify(started))
  const now=Date.now(),characterId=k.info().characterId
  await k.submit({schemaVersion:1,characterId,commandId:'seed:owner',kind:'owner.message',payload:{messageRef:'seed:owner',text:scenario==='owner-reminder'?'请稍后提醒我喝水。':'前面的闲聊先到这里。',ts:now-14400001}})
  if(scenario==='owner-reminder')await k.submit({schemaVersion:1,characterId,commandId:'seed:reminder',kind:'owner.reminder',payload:{subject:'按主人要求提醒喝水',dueAt:now,sourceRefs:['seed:owner']}})
  if(['game','animation'].includes(scenario))await k.submit({schemaVersion:1,characterId,commandId:'seed:event',kind:'world.observation',payload:{observation:{observationId:'seed:'+scenario,sourceId:'seed:'+scenario,kind:scenario==='game'?'game.completed':'animation.completed',observedAt:now,freshUntil:now+3600000,payload:scenario==='game'?{world:'virtual',actor:'owner',observer:'character',subject:'owner',occurredAt:now,sourceType:'game.completed',game:{gameId:'snake',won:true,score:42}}:{world:'virtual',actor:'character',observer:'system',subject:'character',occurredAt:now,sourceType:'animation.completed',animationName:'idle-stretch'}}}})
  k._internals.store.transaction(g=>{const s=g.getState(characterId);s.body.needs={energy:85,satiety:85,thirst:85,mood:85};s.body.attentionPolicy={lastContactAt:0,quietUntil:scenario==='quiet'?now+3600000:0,conversation:{lastOwnerAt:now-14400001,phase:'inactive',surfaceOpen:scenario==='conversation',leaseUntil:0}};g.writeState({...s,characterId,revision:s.revision+1})})
  await k.stop()
  require('../main.js')
  await app.whenReady()
  let win
  for(let i=0;i<100;i++){win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html'));if(win&&!win.webContents.isLoading())break;await sleep(100)}
  if(!win)throw Error('window_missing')
  const run=code=>win.webContents.executeJavaScript(code,true)
  // Keep the user's real pointer from opening this synthetic chat surface.
  win.setPosition(-5000,-5000);win.setIgnoreMouseEvents(true)
  await run(`window.pet.character.submit({kind:'owner.control',payload:{action:'${scenario==='conversation'?'conversation_start':'conversation_end'}'}})`)
  let captured=false
  for(let i=0;i<160;i++){
    if(!win.webContents.isLoading()){
      const view=await run('window.CharacterView?.state()')
      if(view?.presenting&&!captured){fs.writeFileSync(path.join(out,'proactive-'+scenario+'-'+tag+'.png'),(await win.webContents.capturePage()).toPNG());captured=true}
    }
    await sleep(100)
  }
  report.status=await run('window.pet.character.status()');report.projection=await run('window.pet.character.read()');report.history=(await run("window.pet.character.read({kind:'history'})")).history;report.operations=await run("window.pet.character.read({kind:'operations'})");report.uiCaptured=captured
  const contacts=report.history.filter(x=>x.role==='assistant')
  if(['conversation','quiet'].includes(scenario)&&contacts.length)throw Error('contact_gate_bypassed')
  if(contacts.length>1)throw Error('repeated_contact')
  if(scenario==='owner-reminder'&&(!contacts.length||!captured))throw Error('reminder_not_presented')
  finish(true,null)
})().catch(e=>finish(false,e.message))
setTimeout(()=>finish(false,'deadline'),40000).unref()
