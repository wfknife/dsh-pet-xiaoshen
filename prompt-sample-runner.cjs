'use strict'
// Isolated module instances: no real history, memory writes, life executor or renderer globals.
const fs=require('fs'),path=require('path'),vm=require('vm')
async function run({config,provider}){
 const rows=[],now=Date.now(),runId='isolated-'+new Date(now).toISOString(),window={}
 const localStorage={getItem(){return null},setItem(){}}
 const box=vm.createContext({window,console,Date,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,localStorage})
 window.PromptConfig={text:(id,f)=>config.texts[id]??f,controls:()=>config.controls,revision:()=>config.revision}
 window.pet={llmDirect:async p=>{
   const at=new Date().toISOString(),r=await provider({...p,promptStage:'TEST_'+p.promptStage,promptRevision:config.revision})
   rows.push({at,kind:'本轮隔离测试 · 人工素材 · 不写正式历史',runId,stage:p.promptStage,revision:config.revision,model:r.model,
     temperature:p.temperature,max_tokens:p.maxTokens,messages:p.messages||[{role:'system',content:p.system||''},...(p.history||[]).map(h=>({role:h.role,content:h.text||h.content})),{role:'user',content:p.user||''}],
     response:r.text||null,error:r.ok?null:r.error||r.reason,completion:r.completion})
   return r
 }}
 for(const p of ['dialogue/slots.js','dialogue/context-selection.js','life/state-tier.js','life/conversation-policy.js','dialogue/aigateway.js','dialogue/gen2.js','diary/diary-gen2.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'renderer',p),'utf8'),box,{filename:p})
 window.PetLifeModule=require('./renderer/life/pet-life.js')
 const date=new Date(now),day=[date.getFullYear(),date.getMonth()+1,date.getDate()].join('-')
 const persona={identity:{displayName:'测试小深'},stableTraits:{},speechBaseline:{},preferences:{}}
 const life={ready:true,artifacts:[],activities:[],conversations:[],threads:[],recentContacts:[],experiences:[]}
 const context={personaProjection:persona,persona,selfState:{satiety:72,thirst:68,energy:80},emotion:{derivedMood:'neutral',values:{}},runtimeFacts:{},relevantMemories:[],petLife:life}
 const outcomes={}
 async function scenario(name,fn){try{outcomes[name]=await fn()}catch(e){outcomes[name]={ok:false,error:e.message}}}
 await scenario('M1',async()=>{const r=await window.Gen2.chatReply({context,userText:'今天把课程笔记整理完了，想给自己放半小时假，随便聊聊吧。',history:[],life,messageRef:runId+'-m1'});if(r.metadataPromise)await r.metadataPromise;const {metadataPromise,...plain}=r;return plain})
 await scenario('M2',()=>window.Gen2.proactiveDecideSay({context,life,action:'seek_attention',candidates:[{id:'test-curiosity',source:'self_activity',text:'我正在构思一张虚拟小画，犹豫画一颗会发光的石头还是一片透明的叶子，想听听对方会怎么选。这是本次测试设定的想法，不是已完成活动。',date:day,fresh:true,forms:['share','question','invite']}],recentOpenings:[]}))
 const before=rows.length;outcomes.M3=await window.AIGateway.request({role:'expression',userText:'验证已删除备用路径'});outcomes.M3.modelCalls=rows.length-before
 rows.push({at:new Date().toISOString(),kind:'隔离验证 · 无模型调用',runId,stage:'M3_removed',revision:config.revision,messages:[],response:JSON.stringify(outcomes.M3)})
 await scenario('M4',()=>window.AIGateway.lifePlan({persona,selfState:context.selfState,emotion:context.emotion,context:life,memories:[{id:'test-memory-1',content:'测试用户说过喜欢雨后泥土的气味',date:day}]}))
 await scenario('M5',async()=>{
   const ctx={diaryDay:day,importantEvents:[{kind:'animation',text:'测试素材：桌宠在虚拟桌面完成一次伸展动画。'},{kind:'thought',text:'测试素材：想到把发光石头画成一盏小夜灯，还没有开始画。'},{kind:'conversation',text:'测试素材：用户说今天整理完了课程笔记。'}],characterSnapshot:context,experience:{relationshipFeeling:'自然熟悉',emotionalTone:'平静'}}
   window.CharacterSnapshot={toDiaryContext:()=>context}
   vm.runInContext(fs.readFileSync(path.join(__dirname,'renderer/diary/diary-engine.js'),'utf8'),box)
   window.DiaryEngine.init({aiEnabled:true,outputs:[],save(){}})
   return window.DiaryEngine.generate({force:true,now,targetDiaryDay:day,diaryTime:'00:00',events:ctx.importantEvents,memoryRefs:[],calendar:{date:day,festival:[]}})
 })
 return {runId,at:new Date().toISOString(),revision:config.revision,isolated:true,rows,outcomes}
}
module.exports={run}
