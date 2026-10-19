'use strict'
// Installed Electron, real utilityProcess and native SQLite, including ASAR paths.
const { app, utilityProcess } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-kernel-smoke-'))
const entry = process.env.DESKPET_ACCEPTANCE_ENTRY || path.join(__dirname, '../character/entry-kernel.cjs')
app.setPath('userData', path.join(temporary, 'electron'))
let child, finished = false, seq = 0
const rounds = [], pending = new Map()
function finish(value) {
  if (finished) return
  finished = true
  process.stdout.write(JSON.stringify({ ...value, versions: process.versions, isolatedData: temporary, entry, rounds }) + '\n')
  if(child) child.kill()
  app.exit(value.ok ? 0 : 1)
}
function request(method, params) {
  const id = 'test:' + (++seq)
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.postMessage({type:'request',id,method,params})})
}
function spawn() {
  return new Promise((resolve,reject)=>{
    child = utilityProcess.fork(entry, [], { env: {...process.env, DESKPET_CHARACTER_KERNEL:'candidate', DESKPET_CHARACTER_DATA_DIR:temporary}, stdio:'pipe',serviceName:'Isolated Kernel Acceptance' })
    child.on('message', message=>{
      if(message.type==='ready') resolve(message.info)
      else if(message.type==='fatal') reject(Error(JSON.stringify(message.error)))
      else if(message.type==='response') { const p=pending.get(message.id);if(p){pending.delete(message.id);message.ok?p.resolve(message.value):p.reject(Error(JSON.stringify(message.error)))} }
      else if(message.type==='host-request') child.postMessage({type:'host-response',id:message.id,ok:false,error:{code:'acceptance_host_unavailable'}})
    })
  })
}
app.whenReady().then(async()=>{
  try {
    rounds.push(await spawn())
    const feed = await request('character.submit',{schemaVersion:1,commandId:'native:feed',characterId:rounds[0].characterId,kind:'owner.interaction',payload:{kind:'feed'}})
    if(!feed.ok) throw Error('feed_failed:'+JSON.stringify(feed))
    const before = await request('character.read',{})
    await request('character.shutdown',{})
    rounds.push(await spawn())
    const after = await request('character.read',{})
    if(after.state.nurture.feedCount!==before.state.nurture.feedCount || rounds[1].epoch<=rounds[0].epoch) throw Error('restart_persistence_failed')
    await request('character.shutdown',{})
    finish({ok:true,event:'ready_write_shutdown_restart',feedCount:after.state.nurture.feedCount})
  } catch(error) {finish({ok:false,error:error.message})}
})
setTimeout(()=>finish({ok:false,error:'timeout'}),20000).unref()
