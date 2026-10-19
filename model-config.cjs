'use strict'
const P=require('./model-provider.cjs');
const ROLES=['character','diary','proactive'];
const scope=p=>p.protocol+' '+p.baseUrl;
const clone=x=>JSON.parse(JSON.stringify(x));
const idValid=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,48}$/.test(id);
function createModelConfig({read,write,legacyKey=()=>''}){
 function load(){
  const prefs=read()||{};
  if(prefs.modelConfig){const cfg=clone(prefs.modelConfig);if(cfg.schemaVersion!==1||!Array.isArray(cfg.providers)||!cfg.providers.length||cfg.providers.length>20||!cfg.routes||typeof cfg.routes!=='object'||cfg.providers.some(p=>!p||!idValid(p.id)||!P.normalizeConnection(p).ok)||new Set(cfg.providers.map(p=>p.id)).size!==cfg.providers.length||!cfg.providers.some(p=>p.id===cfg.defaultProviderId))throw Error('unsupported_config_schema');return cfg}
  const old=prefs.llmApi||{},n=P.normalizeConnection(old);if(!n.ok)throw Error(n.error);
  const provider={id:'legacy',name:'原有连接',...n.value,credentialMode:old.credentialMode==='own'?'own':'legacy',revision:1,models:[],modelsAt:0,discoveryError:null};
  const cfg={schemaVersion:1,defaultProviderId:'legacy',providers:[provider],routes:{}};
  for(const role of ['character','diary']){const model=prefs.modelPrefs&&prefs.modelPrefs[role]||role==='character'&&prefs.chatModel||null;cfg.routes[role]={providerId:model?'legacy':null,model:P.validModel(model)?model:null,scope:model?scope(provider):null}}
  return cfg;
 }
 function save(cfg){return write({modelConfig:cfg})?{ok:true,view:view()}:{ok:false,error:'save_failed'}}
 function guarded(fn){try{return fn()}catch(e){return {ok:false,error:e.message==='unsupported_config_schema'?e.message:'configuration_error'}}}
 function resolveFrom(cfg,role,explicitModel){
  if(role==='expression'||role==='vision')role='character';if(!ROLES.includes(role))role='character';
  let route=cfg.routes[role]||{};
  if(cfg.defaultModel&&!route.providerId&&!route.model)route={providerId:cfg.defaultModel.providerId,model:cfg.defaultModel.model,scope:cfg.defaultModel.scope};
  if(role==='proactive'&&!route.providerId&&!route.model&&!route.followDefault)return resolveFrom(cfg,'character',explicitModel);
  const inheritedProvider=role==='proactive'&&!route.followDefault?resolveFrom(cfg,'character').providerId:cfg.defaultProviderId;
  const id=route.providerId||inheritedProvider,p=cfg.providers.find(p=>p.id===id);if(!p)return {ok:false,error:'provider_not_found'};
  const n=P.normalizeConnection(p);if(!n.ok)return n;const c=n.value;
  if(!c.apiKey&&p.credentialMode==='legacy'&&c.protocol==='openai'&&['https://api.deepseek.com','https://api.deepseek.com/v1'].includes(c.baseUrl))c.apiKey=legacyKey()||'';
  if(route.model&&route.scope&&route.scope!==scope(c)&&!explicitModel)return {ok:false,error:'stale_model_route',providerId:id,model:route.model};
  const model=explicitModel||route.model||c.model||(c.protocol==='openai'&&['https://api.deepseek.com','https://api.deepseek.com/v1'].includes(c.baseUrl)?'deepseek-flash':null);
  if(!model)return {ok:false,error:'no-model',providerId:id,connection:c,model:null};
  return {ok:true,providerId:id,model,connection:c,preference:route.model||null,inherited:!route.providerId&&!route.model};
 }
 function resolve(role,explicitModel){return guarded(()=>resolveFrom(load(),role,explicitModel))}
 function view(){return guarded(()=>{const cfg=load();return {ok:true,schemaVersion:1,defaultProviderId:cfg.defaultProviderId,protocols:P.PROTOCOLS.slice(),providers:cfg.providers.map(p=>{
   const n=P.normalizeConnection(p).value,hasInherited=!n.apiKey&&p.credentialMode==='legacy'&&n.protocol==='openai'&&['https://api.deepseek.com','https://api.deepseek.com/v1'].includes(n.baseUrl)&&!!legacyKey();
   const {apiKey,...safe}=n;return {...safe,id:p.id,name:p.name,revision:p.revision,hasKey:!!apiKey||hasInherited,keySource:apiKey?'settings':hasInherited?'legacy':'none',models:(p.models||[]).slice(0,200),modelsAt:p.modelsAt||0,discoveryError:p.discoveryError||null}
  }),defaultModel:cfg.defaultModel||{providerId:cfg.defaultProviderId,model:resolveFrom({...cfg,routes:{}},'character').model||null},routes:Object.fromEntries(ROLES.map(role=>{const r=resolveFrom(cfg,role),route=cfg.routes[role]||{};return [role,{providerId:route.providerId||null,model:route.model||null,effectiveProviderId:r.providerId||null,effectiveModel:r.model||null,error:r.ok?null:r.error,inherited:!route.providerId&&!route.model}]}))}})}
 function saveProvider(patch={}){return guarded(()=>{
  const cfg=load(),id=patch.id;if(!idValid(id))return {ok:false,error:'invalid_provider_id'};
  const index=cfg.providers.findIndex(p=>p.id===id),previous=index>=0?cfg.providers[index]:null;
  if(!previous&&cfg.providers.length>=20)return {ok:false,error:'too_many_providers'};
  const merged={...(previous||{}),...patch};
  if(patch.protocol&&previous&&patch.protocol!==previous.protocol&&patch.baseUrl==null)merged.baseUrl=P.DEFAULTS[patch.protocol];
  // Secret is deliberately not copied from a renderer view. Blank means retain.
  merged.apiKey=String(patch.apiKey||'').trim()||(previous&&previous.apiKey)||'';
  const n=P.normalizeConnection(merged);if(!n.ok)return n;
  const changed=previous&&scope(previous)!==scope(n.value);
  if(changed){if(!patch.apiKey)n.value.apiKey='';if(patch.model==null)n.value.model=''}
  if(patch.clearKey===true)n.value.apiKey='';
  const p={id,name:String(patch.name==null?previous&&previous.name||id:patch.name).trim().slice(0,80)||id,...n.value,
   credentialMode:changed||patch.clearKey===true||patch.apiKey?'own':previous&&previous.credentialMode||'own',revision:(previous&&previous.revision||0)+1,
   models:!changed&&!patch.apiKey&&patch.clearKey!==true&&previous?previous.models||[]:[],modelsAt:!changed&&!patch.apiKey&&patch.clearKey!==true&&previous?previous.modelsAt||0:0,discoveryError:null};
  if(index>=0)cfg.providers[index]=p;else cfg.providers.push(p);return save(cfg);
 })}
 function setRoute(role,patch={}){return guarded(()=>{const cfg=load();if(!ROLES.includes(role))return {ok:false,error:'invalid_role'};
  const providerId=patch.providerId||null;if(providerId&&!cfg.providers.some(p=>p.id===providerId))return {ok:false,error:'provider_not_found'};
  const model=typeof patch.model==='string'?patch.model.trim():null;if(model&&!P.validModel(model))return {ok:false,error:'invalid_model'};
  const inheritedProvider=role==='proactive'?resolveFrom(cfg,'character').providerId:cfg.defaultProviderId;
  const provider=cfg.providers.find(p=>p.id===(providerId||inheritedProvider));if(!provider)return {ok:false,error:'provider_not_found'};
  cfg.routes[role]={providerId,model:model||null,scope:model?scope(provider):null,followDefault:patch.followDefault===true};return save(cfg);
 })}
 function setDefault(id){return guarded(()=>{const cfg=load();if(!cfg.providers.some(p=>p.id===id))return {ok:false,error:'provider_not_found'};cfg.defaultProviderId=id;return save(cfg)})}
 function setDefaultModel(patch={}){return guarded(()=>{
  const cfg=load(),p=cfg.providers.find(p=>p.id===patch.providerId),model=typeof patch.model==='string'?patch.model.trim():'';
  if(!p)return {ok:false,error:'provider_not_found'};
  if(!model||!P.validModel(model))return {ok:false,error:'invalid_model'};
  cfg.defaultProviderId=p.id;cfg.defaultModel={providerId:p.id,model,scope:scope(p)};
  return save(cfg);
 })}
 function removeProvider(id){return guarded(()=>{const cfg=load();if(cfg.defaultProviderId===id||Object.values(cfg.routes).some(r=>r.providerId===id))return {ok:false,error:'provider_in_use'};cfg.providers=cfg.providers.filter(p=>p.id!==id);return save(cfg)})}
 function getProvider(id){return guarded(()=>{const cfg=load(),p=cfg.providers.find(p=>p.id===id);if(!p)return {ok:false,error:'provider_not_found'};const r=resolveFrom({...cfg,routes:{character:{providerId:id}}},'character');return {ok:true,connection:r.connection||P.normalizeConnection(p).value,revision:p.revision}})}
 function setModels(id,result,revision){return guarded(()=>{const cfg=load(),p=cfg.providers.find(p=>p.id===id);if(!p)return {ok:false,error:'provider_not_found'};if(p.revision!==revision)return {ok:false,error:'stale_probe'};
  if(result.ok){p.models=[...new Set((result.models||[]).filter(P.validModel))].slice(0,200);p.modelsAt=Date.now();p.discoveryError=null}else p.discoveryError=result.error||'discovery_failed';return save(cfg);
 })}
 return {view,resolve,saveProvider,setRoute,setDefault,setDefaultModel,removeProvider,getProvider,setModels};
}
module.exports={createModelConfig,ROLES};
