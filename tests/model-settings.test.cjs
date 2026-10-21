const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {createModelConfig}=require('../model-config.cjs');
const SCRIPT=fs.readFileSync(require.resolve('../renderer/model-settings.js'),'utf8');
const HTML=fs.readFileSync(require.resolve('../renderer/index.html'),'utf8');
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.style={};this.dataset={};this._value='';}
 set textContent(v){this.text=v;this.children=[]}get textContent(){return this.text||''}
 set value(v){this._value=v}get value(){return this.tag==='select'&&!this.children.some(x=>x.value===this._value)?'':this._value}
 appendChild(e){this.children.push(e);return e}append(...es){this.children.push(...es)}prepend(e){this.children.unshift(e)}
 setAttribute(k,v){this[k]=v}addEventListener(k,f){this.listeners[k]=f}focus(){}querySelector(){return this.summary||(this.summary=new Element('summary'))}
 async fire(k){await this.listeners[k]?.({preventDefault(){}})}
}
// Parse the settings markup into fake elements; select options are kept so value reads behave like a browser.
function elements(){
 const found={};for(const match of HTML.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g))found[match[2]]=new Element(match[1]);
 for(const match of HTML.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
  const el=found[match[1]];if(!el)continue;
  for(const opt of match[2].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)){const o=new Element('option');o.value=opt[1];o.textContent=opt[2];el.appendChild(o)}
 }
 return found;
}
function load(found,win){const context={window:win,document:{getElementById:id=>found[id],createElement:t=>new Element(t)}};vm.runInNewContext(SCRIPT,context);return context}
// Integration harness: real model-config.cjs + mocked probe transport, like before.
async function setup(probeError){
 let prefs={};const config=createModelConfig({read:()=>structuredClone(prefs),write:p=>{prefs={...prefs,...p};return true}}),calls=[];const e=elements();
 const api={get:async()=>config.view(),save:async p=>{calls.push('save');return config.saveProvider(p)},probe:async id=>{calls.push('probe');const p=config.view().providers.find(p=>p.id===id);const result=probeError?{ok:false,error:probeError}:{ok:true,models:['real-a','real-b']};config.setModels(id,result,p.revision);return result},route:async(...args)=>config.setRoute(...args),setDefaultModel:async p=>config.setDefaultModel(p)};
 const context=load(e,{pet:{modelConfig:api}});await context.window.ModelSettings.reload();return {elements:e,config,calls};
}
function provider(over={}){return {id:'legacy',name:'DeepSeek',protocol:'openai',baseUrl:'https://api.deepseek.com',model:'',models:[],modelsAt:0,hasKey:false,keySource:'none',keyRequired:false,keyless:true,authMode:'auto',discoveryError:null,revision:1,...over}}
const ROUTES=()=>({character:{inherited:true,providerId:null,model:null,effectiveProviderId:'legacy',effectiveModel:null,error:null},proactive:{inherited:true,providerId:null,model:null,effectiveProviderId:'legacy',effectiveModel:null,error:null},diary:{inherited:true,providerId:null,model:null,effectiveProviderId:'legacy',effectiveModel:null,error:null}});
const clone=o=>JSON.parse(JSON.stringify(o));
// Contract-shaped mock of window.pet.modelConfig (view/save/probe/defaultModel/remove).
function mockApi(config,opts){
 const calls=[];
 const api={
  get:async()=>({ok:true,...clone({providers:config.providers,defaultProviderId:config.defaultProviderId,defaultModel:config.defaultModel,routes:config.routes,setup:config.setup})}),
  save:async patch=>{
   calls.push({call:'save',patch});
   if(opts.save)return opts.save(patch,config,calls);
   let p=config.providers.find(x=>x.id===patch.id);
   if(!p){p=provider({id:patch.id,name:patch.name||'新服务',protocol:patch.protocol||'openai',baseUrl:patch.baseUrl||'',model:'',hasKey:false,keySource:'none'});config.providers.push(p)}
   if(patch.apiKey){p.hasKey=true;p.keySource='settings';p.keyRequired=p.authMode==='bearer'||p.authMode==='api-key'}
   if(patch.clearKey){p.hasKey=false;p.keySource='none'}
   for(const k of ['name','protocol','baseUrl','authMode','model'])if(patch[k]!==undefined)p[k]=patch[k];
   p.revision=(p.revision||0)+1;
   return {ok:true}
  },
  probe:async id=>{
   calls.push({call:'probe',id});
   if(opts.probe)return opts.probe(id,config,calls);
   const p=config.providers.find(x=>x.id===id);
   if(p){p.models=Array.isArray(opts.models)?opts.models.slice():['qwen3:4b','llama3'];p.modelsAt=1}
   return {ok:true,models:(p&&p.models)||[]}
  },
  setDefaultModel:async value=>{calls.push({call:'setDefaultModel',value});config.defaultModel={providerId:value.providerId,model:value.model};for(const r of Object.values(config.routes)){r.effectiveProviderId=value.providerId;r.effectiveModel=value.model}return {ok:true}},
  setDefault:async id=>{calls.push({call:'setDefault',id});return {ok:true}},
  route:async(role,value)=>{calls.push({call:'route',role,value});return {ok:true}},
  remove:async id=>{calls.push({call:'remove',id});if(opts.remove)return opts.remove(id,config,calls);config.providers=config.providers.filter(p=>p.id!==id);config.defaultProviderId=(config.providers[0]||{}).id||null;return {ok:true}},
  test:async(...args)=>{calls.push({call:'test',args});return {ok:true}}
 };
 return {api,calls};
}
async function setupMock(opts={}){
 const e=elements(),config={providers:opts.providers||[provider()],defaultProviderId:opts.defaultProviderId||'legacy',defaultModel:opts.defaultModel||{providerId:'legacy',model:null},routes:opts.routes||ROUTES(),setup:opts.setup||{ready:false,reason:'no-model',providerId:'legacy'}};
 if(!config.providers.some(p=>p.id===config.defaultProviderId))config.defaultProviderId=config.providers[0].id;
 const {api,calls}=mockApi(config,opts);const context=load(e,{pet:{modelConfig:api},confirm:opts.confirm});
 await context.window.ModelSettings.reload();return {elements:e,config,calls,window:context.window};
}
test('saving connection automatically fetches actual models without selecting first result',async()=>{
 const {elements:e,config,calls}=await setup();e['api-base-url'].value='http://localhost:11434';e['model-protocol'].value='ollama';
 await e['api-save'].fire('click');assert.deepEqual(calls,['save','probe']);assert.ok(e['model-choice'].children.some(x=>x.textContent.startsWith('real-a')));assert.equal(config.resolve('character').error,'no-model');
 e['model-choice'].value=JSON.stringify({providerId:'legacy',model:'real-b'});await e['model-choice-save'].fire('click');for(const role of ['character','diary','proactive'])assert.equal(config.resolve(role).model,'real-b');
 const row=e['model-routes'].children[0],toggle=row.children[1],editor=row.children[3];assert.equal(toggle.type,'checkbox');assert.equal(editor.hidden,true);toggle.checked=true;await toggle.fire('change');assert.equal(editor.hidden,false);assert.equal(editor.children[1].listeners.blur,undefined);
});
test('failed discovery keeps saved connection and explains failure with manual fallback',async()=>{
 const {elements:e,config,calls}=await setup('auth');e['api-base-url'].value='https://example.test/v1';await e['api-save'].fire('click');assert.deepEqual(calls,['save','probe']);assert.equal(config.view().providers[0].baseUrl,'https://example.test/v1');assert.match(e['model-status'].textContent,/API Key 无效或认证方式不匹配/);assert.equal(e['model-settings-root'].inert,false);assert.ok(e['model-default']);
});
test('changing protocol resets auth mode, clears the model and never keeps the Ollama placeholder',async()=>{
 const {elements:e}=await setupMock({providers:[provider({name:'本机 Ollama',protocol:'ollama',baseUrl:'http://127.0.0.1:11434',authMode:'none',keySource:'keyless',keyRequired:false,keyless:true})]});
 assert.match(e['api-key'].placeholder,/可选填/);
 e['model-auth'].value='none';e['model-default'].value='qwen3:4b';e['model-protocol'].value='openai';
 await e['model-protocol'].fire('change');
 assert.equal(e['model-auth'].value,'auto');assert.equal(e['model-default'].value,'');assert.equal(e['api-base-url'].value,'https://api.deepseek.com');
 assert.match(e['api-key'].placeholder,/可选填/);assert.doesNotMatch(e['api-key'].placeholder,/无需填写/);
 e['model-auth'].value='bearer';await e['model-auth'].fire('change');assert.equal(e['api-key'].placeholder,'填写 API Key');
});
test('changing service address resets auth mode and clears the model',async()=>{
 const {elements:e}=await setupMock();
 e['model-auth'].value='none';e['model-default'].value='some-model';e['api-base-url'].value='https://example.test/v1';
 await e['api-base-url'].fire('change');
 assert.equal(e['model-auth'].value,'auto');assert.equal(e['model-default'].value,'');assert.match(e['api-key'].placeholder,/可选填/);
});
test('save reports cleared key/model after a scope change instead of a generic success',async()=>{
 const {elements:e,calls}=await setupMock({providers:[provider({hasKey:true,keySource:'settings',keyRequired:false})],save:async(patch,config)=>{Object.assign(config.providers[0],{hasKey:false,keySource:'none',authMode:'auto',model:''});return {ok:true,scopeChanged:true,keyCleared:true,authModeReset:true,modelCleared:true}}});
 assert.equal(e['api-key'].placeholder,'已保存；留空不改');
 e['api-base-url'].value='https://api.openai.com/v1';await e['api-save'].fire('click');
 const text=e['model-status'].textContent;
 assert.match(text,/地址\/类型已更改/);assert.match(text,/密钥已清除/);assert.match(text,/模型需重新选择/);
 assert.deepEqual(calls.map(c=>c.call),['save','probe']);assert.equal(e['api-key'].placeholder,'此服务可无需密钥（可选填）');
});
test('discovery failures map auth-required and empty to plain-language guidance',async()=>{
 let env=await setupMock({probe:async()=>({ok:false,error:'auth-required'})});
 env.elements['api-base-url'].value='https://api.openai.com/v1';await env.elements['api-save'].fire('click');
 assert.match(env.elements['model-status'].textContent,/服务要求认证/);assert.match(env.elements['model-status'].textContent,/无需认证/);
 env=await setupMock({probe:async()=>({ok:false,error:'empty'})});
 env.elements['api-base-url'].value='https://api.openai.com/v1';await env.elements['api-save'].fire('click');
 assert.match(env.elements['model-status'].textContent,/服务返回空内容/);
});
test('every contract error code maps to an actionable plain-language message',async()=>{
 const expected={auth:/API Key 无效/, 'no-key':/需要 API Key/, network:/无法连接服务/, timeout:/请求超时/, empty:/返回空内容/, model_invalid:/不识别该模型/, endpoint_not_found:/地址不匹配/, model_loading:/模型正在加载/, provider_unavailable:/服务端错误/};
 for(const [code,pattern] of Object.entries(expected)){
  const env=await setupMock({probe:async()=>({ok:false,error:code})});
  env.elements['api-base-url'].value='https://api.openai.com/v1';await env.elements['api-save'].fire('click');
  assert.match(env.elements['model-status'].textContent,pattern,code);
 }
});
test('delete asks for confirmation first and explains the last-provider guard',async()=>{
 let env=await setupMock({confirm:()=>true,remove:async()=>({ok:false,error:'last_provider'})});
 await env.elements['model-provider-delete'].fire('click');
 assert.equal(env.calls.filter(c=>c.call==='remove').length,1);assert.match(env.elements['model-status'].textContent,/至少需要保留一个服务连接/);
 env=await setupMock({confirm:()=>false});
 await env.elements['model-provider-delete'].fire('click');
 assert.equal(env.calls.filter(c=>c.call==='remove').length,0);
});
test('initial status guides a new user when setup is not ready',async()=>{
 const {elements:e}=await setupMock({setup:{ready:false,reason:'no-provider',providerId:'legacy'}});
 assert.match(e['model-status'].textContent,/还没有可用的 AI 服务/);
});
