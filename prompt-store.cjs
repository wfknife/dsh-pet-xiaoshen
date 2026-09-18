'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const catalog = require('./prompt-defaults.json')
const controls = { history: 'normal', memories: true, life: true, threads: true, dynamics: true }
function createPromptStore(dataDir) {
  const dir = path.join(dataDir, 'prompts'), file = path.join(dir, 'current.json'), good = path.join(dir, 'last-good.json')
  let last, stamp = '', error = null
  const defaults = () => ({ schema: 1, revision: 'defaults', savedAt: null, texts: Object.fromEntries(catalog.filter(x=>!x.readonly).map(x=>[x.id,x.text])), controls: {...controls} })
  function validate(v) {
    if (!v || v.schema !== 1 || typeof v.texts !== 'object' || !v.texts || Array.isArray(v.texts)) throw Error('提示词文件结构无效')
    const out=defaults()
    for(const item of catalog.filter(x=>!x.readonly)) {
      if(v.texts[item.id] === undefined) continue
      if(typeof v.texts[item.id] !== 'string' || v.texts[item.id].length>16000) throw Error('提示词过长或不是文字：'+item.title)
      out.texts[item.id]=v.texts[item.id]
    }
    const c=v.controls || {}
    if(c.history!==undefined && !['normal','isolate'].includes(c.history))throw Error('历史模式无效')
    for(const k of ['memories','life','threads','dynamics']) if(c[k]!==undefined && typeof c[k]!=='boolean')throw Error('上下文开关无效')
    out.controls={...controls,...Object.fromEntries(Object.keys(controls).filter(k=>c[k]!==undefined).map(k=>[k,c[k]]))}
    out.revision=typeof v.revision==='string'?v.revision:'imported';out.savedAt=v.savedAt || null
    return out
  }
  function atomic(target, v) {
    fs.mkdirSync(path.dirname(target),{recursive:true})
    const tmp=target+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp'
    fs.writeFileSync(tmp,JSON.stringify(v,null,2),'utf8')
    try {fs.renameSync(tmp,target)} catch(e) {try{fs.unlinkSync(tmp)}catch{};throw e}
  }
  function read() {
    try {
      const st=fs.statSync(file), next=st.mtimeMs+':'+st.size
      if(next!==stamp) {
        const candidate=validate(JSON.parse(fs.readFileSync(file,'utf8')))
        last=candidate;stamp=next;error=null
      }
    } catch(e) {
      if(!last) {
        try {last=validate(JSON.parse(fs.readFileSync(good,'utf8')))}catch{last=defaults()}
      }
      error=e.code==='ENOENT' && last.revision==='defaults' ? null : '加载失败，继续使用 '+last.revision+'：'+e.message
    }
    return {...structuredClone(last),error,dir}
  }
  function save(input, expectedRevision) {
    const before=read()
    if(expectedRevision && before.revision!==expectedRevision)throw Error('另一窗口已保存新版本，请先重新载入再修改')
    const next=validate(input)
    next.revision=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex')
    next.savedAt=new Date().toISOString()
    // Do not overwrite a damaged external file without preserving the exact bytes.
    if(before.error && fs.existsSync(file))fs.copyFileSync(file,path.join(dir,'invalid-'+Date.now()+'.json'))
    atomic(path.join(dir,'versions',next.revision+'.json'),next)
    atomic(good,next);atomic(file,next);stamp=''
    return read()
  }
  function versions() {
    try{return fs.readdirSync(path.join(dir,'versions')).filter(n=>/^[\w-]+\.json$/.test(n)).sort().reverse().slice(0,30).map(n=>n.slice(0,-5))}catch{return []}
  }
  function version(id) {
    if(!versions().includes(id))throw Error('没有这个保存版本')
    return validate(JSON.parse(fs.readFileSync(path.join(dir,'versions',id+'.json'),'utf8')))
  }
  function capture(record) {
    // Only an allowlist from the request body. Never persist credentials, URL or headers.
    const r={ at:new Date().toISOString(), kind:'真实请求（发送边界，不是模型输出）', stage:record.stage, revision:record.revision,
      model:record.model, temperature:record.temperature, max_tokens:record.max_tokens, messages:record.messages }
    const name=String(record.stage || 'other').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80)
    atomic(path.join(dir,'requests',name+'.json'),r)
  }
  function requests() {
    try{return fs.readdirSync(path.join(dir,'requests')).filter(n=>/^[\w-]+\.json$/.test(n)).map(n=>{
      try{return JSON.parse(fs.readFileSync(path.join(dir,'requests',n),'utf8'))}catch{return null}
    }).filter(Boolean).sort((a,b)=>b.at.localeCompare(a.at))}catch{return []}
  }
  function testRun(){try{return JSON.parse(fs.readFileSync(path.join(dir,'isolated-test-run.json'),'utf8'))}catch{return null}}
  function saveTestRun(v){atomic(path.join(dir,'isolated-test-run.json'),v);return v}
  return {read,save,defaults,catalog,versions,version,capture,requests,testRun,saveTestRun,dir}
}
module.exports={createPromptStore}
