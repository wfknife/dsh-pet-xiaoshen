'use strict'
const P=require('./model-provider.cjs');
const ROLES=['character','diary','proactive'];
const OFFICIAL_DEEPSEEK=['https://api.deepseek.com','https://api.deepseek.com/v1'];
const scope=p=>p.protocol+' '+p.baseUrl;
const clone=x=>JSON.parse(JSON.stringify(x));
const idValid=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,48}$/.test(id);
function createModelConfig({read,write,legacyKey=()=>''}){
 function load(){
  const prefs=read()||{};
  if(prefs.modelConfig){
   const cfg=clone(prefs.modelConfig);
   if(cfg.schemaVersion!==1||!Array.isArray(cfg.providers)||!cfg.providers.length||cfg.providers.length>20||!cfg.routes||typeof cfg.routes!=='object'||new Set(cfg.providers.map(p=>p&&p.id)).size!==cfg.providers.length)throw Error('unsupported_config_schema');
   // Normalise stored records instead of rejecting slightly older files: models may be null,
   // authMode may be absent, and old scope fields may be stale after a provider edit.
   for(const p of cfg.providers){
    if(!p||!idValid(p.id))throw Error('unsupported_config_schema');
    const n=P.normalizeConnection(p);if(!n.ok)throw Error('unsupported_config_schema');
    Object.assign(p,{name:String(p.name||p.id).slice(0,80),...n.value,credentialMode:p.credentialMode==='legacy'?'legacy':'own',revision:Number.isFinite(Number(p.revision))?Number(p.revision):1,models:Array.isArray(p.models)?p.models.filter(P.validModel).slice(0,200):[],modelsAt:Number(p.modelsAt)||0,discoveryError:typeof p.discoveryError==='string'?p.discoveryError:null});
   }
   if(!cfg.providers.some(p=>p.id===cfg.defaultProviderId))cfg.defaultProviderId=cfg.providers[0].id;
   // In-memory self-heal (never written on load): drop stale route/default scopes left by old builds.
   for(const role of Object.keys(cfg.routes)){
    const r=cfg.routes[role];if(!r||typeof r!=='object'){delete cfg.routes[role];continue}
    const p=cfg.providers.find(p=>p.id===r.providerId);
    if(r.providerId&&!r.model){r.providerId=null;r.scope=null;r.followDefault=true;continue}
    if(r.providerId&&!p){r.providerId=null;r.model=null;r.scope=null;continue}
    if(r.model&&!r.scope){r.model=null;continue}
    if(r.scope&&p&&r.scope!==scope(p)){r.model=null;r.scope=null}
   }
   if(cfg.defaultModel){
    const p=cfg.providers.find(p=>p.id===cfg.defaultModel.providerId);
    if(!p||(cfg.defaultModel.scope&&cfg.defaultModel.scope!==scope(p)))cfg.defaultModel=null;
   }
   return cfg;
  }
  const old=prefs.llmApi||{},n=P.normalizeConnection(old);if(!n.ok)throw Error(n.error);
  const fresh=!prefs.llmApi&&!prefs.chatModel&&(!prefs.modelPrefs||typeof prefs.modelPrefs!=='object');
  const provider={id:'legacy',name:fresh?'AI 服务':'原有连接',...n.value,credentialMode:old.credentialMode==='own'?'own':'legacy',revision:1,models:[],modelsAt:0,discoveryError:null};
  const cfg={schemaVersion:1,defaultProviderId:'legacy',providers:[provider],routes:{}};
  for(const role of ['character','diary']){const model=prefs.modelPrefs&&prefs.modelPrefs[role]||role==='character'&&prefs.chatModel||null;cfg.routes[role]={providerId:model?'legacy':null,model:P.validModel(model)?model:null,scope:model?scope(provider):null}}
  return cfg;
 }
 function save(cfg){return write({modelConfig:cfg})?{ok:true,view:view()}:{ok:false,error:'save_failed'}}
 function guarded(fn){try{return fn()}catch(e){return {ok:false,error:e.message==='unsupported_config_schema'?e.message:'configuration_error'}}}
 function inheritedKey(p,n){return !n.apiKey&&p.credentialMode==='legacy'&&n.protocol==='openai'&&OFFICIAL_DEEPSEEK.includes(n.baseUrl)&&!!legacyKey()}
 function resolveFrom(cfg,role,explicitModel){
  if(role==='expression'||role==='vision')role='character';if(!ROLES.includes(role))role='character';
  let route=cfg.routes[role]||{};
  // A provider-only route (no explicit model) is a leftover half-custom state, not a choice of model:
  // let it inherit the selected default model so saving a new model actually takes effect.
  if(route.providerId&&!route.model)route={};
  if(cfg.defaultModel&&!route.providerId&&!route.model)route={providerId:cfg.defaultModel.providerId,model:cfg.defaultModel.model,scope:cfg.defaultModel.scope};
  if(role==='proactive'&&!route.providerId&&!route.model&&!route.followDefault)return resolveFrom(cfg,'character',explicitModel);
  const inheritedProvider=role==='proactive'&&!route.followDefault?resolveFrom(cfg,'character').providerId:cfg.defaultProviderId;
  const id=route.providerId||inheritedProvider,p=cfg.providers.find(p=>p.id===id);if(!p)return {ok:false,error:'provider_not_found'};
  const n=P.normalizeConnection(p);if(!n.ok)return n;const c=n.value;
  if(inheritedKey(p,c))c.apiKey=legacyKey()||'';
  if(route.model&&route.scope&&route.scope!==scope(c)&&!explicitModel)return {ok:false,error:'stale_model_route',providerId:id,model:route.model};
  const model=explicitModel||route.model||c.model||(c.protocol==='openai'&&OFFICIAL_DEEPSEEK.includes(c.baseUrl)?'deepseek-flash':null);
  if(!model)return {ok:false,error:'no-model',providerId:id,connection:c,model:null};
  return {ok:true,providerId:id,model,connection:c,preference:route.model||null,inherited:!route.providerId&&!route.model};
 }
 function resolve(role,explicitModel){return guarded(()=>resolveFrom(load(),role,explicitModel))}
 function providerView(cfg,p){
  const n=P.normalizeConnection(p).value,hasInherited=inheritedKey(p,n);
  const {apiKey,...safe}=n;
  const keyRequired=P.needsKey(n);
 // "keyless" means the endpoint is expected to work without a key (Ollama native, explicit no-auth,
 // or a loopback local service); explicit bearer/api-key modes still need one.
 const keyless=!keyRequired&&(n.authMode==='none'||n.protocol==='ollama'||P.isLocal(n.baseUrl));
 const keySource=apiKey?'settings':hasInherited?'legacy':keyless?'keyless':'none';
  return {...safe,id:p.id,name:p.name,revision:p.revision,hasKey:!!apiKey||hasInherited,keySource,keyRequired,keyless,models:(p.models||[]).slice(0,200),modelsAt:p.modelsAt||0,discoveryError:p.discoveryError||null};
 }
 function keylessCapable(c){return !P.needsKey(c)&&(c.authMode==='none'||c.protocol==='ollama'||P.isLocal(c.baseUrl))}
 function view(){return guarded(()=>{const cfg=load();
  const providers=cfg.providers.map(p=>providerView(cfg,p));
  let defaultModel=cfg.defaultModel;
  if(!defaultModel){const r=resolveFrom({...cfg,routes:{}},'character');defaultModel={providerId:cfg.defaultProviderId,model:r.ok?r.model:null}}
  const character=resolveFrom(cfg,'character');
  const ready=!!(character.ok&&(!!character.connection.apiKey||keylessCapable(character.connection)));
  const setup={ready,reason:character.ok?(ready?'ok':'no-key'):(character.error==='no-model'?'no-model':character.error||'no-provider'),providerId:character.providerId||cfg.defaultProviderId};
  return {ok:true,schemaVersion:1,defaultProviderId:cfg.defaultProviderId,protocols:P.PROTOCOLS.slice(),providers,defaultModel,setup,routes:Object.fromEntries(ROLES.map(role=>{const r=resolveFrom(cfg,role),route=cfg.routes[role]||{};return [role,{providerId:route.providerId||null,model:route.model||null,effectiveProviderId:r.providerId||null,effectiveModel:r.model||null,error:r.ok?null:r.error,inherited:!route.providerId&&!route.model}]}))}})}
 function saveProvider(patch={}){return guarded(()=>{
  const cfg=load(),id=patch.id;if(!idValid(id))return {ok:false,error:'invalid_provider_id'};
  const index=cfg.providers.findIndex(p=>p.id===id),previous=index>=0?cfg.providers[index]:null;
  if(!previous&&cfg.providers.length>=20)return {ok:false,error:'too_many_providers'};
  const merged={...(previous||{}),...patch};
  if(patch.protocol&&previous&&patch.protocol!==previous.protocol&&patch.baseUrl==null)merged.baseUrl=P.DEFAULTS[patch.protocol];
  const n=P.normalizeConnection(merged);if(!n.ok)return n;
  const newScope=scope(n.value),prevScope=previous?scope(previous):null,scopeChanged=!!previous&&prevScope!==newScope;
  const explicitKey=typeof patch.apiKey==='string'&&patch.apiKey.trim()!=='',clearKey=patch.clearKey===true;
  const authExplicit=!!previous&&patch.authMode!==undefined&&patch.authMode!==previous.authMode;
  const keycleared=scopeChanged&&!explicitKey&&!clearKey&&!!(previous&&previous.apiKey);
  // Secret never travels to a new endpoint unless the user supplied it for that save.
  const apiKey=clearKey?'':explicitKey?String(patch.apiKey).trim():scopeChanged?'':(previous&&previous.apiKey)||'';
  // An auth method belongs to an endpoint: reset on scope change unless deliberately changed now.
  let authMode=patch.authMode||(previous&&previous.authMode)||n.value.authMode||'auto';
  const authModeReset=scopeChanged&&!authExplicit;if(authModeReset)authMode='auto';
  // A model id belongs to an endpoint too: clear on scope change unless the user typed a new one.
  let model=patch.model!=null?String(patch.model).trim():(previous&&previous.model)||'';
  if(scopeChanged&&(!patch.model||(previous&&patch.model===previous.model)))model='';
  const name=String(patch.name==null?(previous&&previous.name||id):patch.name).trim().slice(0,80)||id;
  // Keep the legacy shared-credential inheritance unless the user now owns the credential.
  const credentialMode=(clearKey||explicitKey)?'own':(previous&&previous.credentialMode)||'own';
  const freshModels=scopeChanged||explicitKey||clearKey;
  const p={id,name,...n.value,apiKey,authMode,model,credentialMode,revision:(previous&&previous.revision||0)+1,
   models:freshModels?[]:(previous&&previous.models)||[],modelsAt:freshModels?0:(previous&&previous.modelsAt)||0,discoveryError:null};
  let defaultCleared=0,routesCleared=0;
  if(scopeChanged){
   if(cfg.defaultModel&&cfg.defaultModel.providerId===id&&cfg.defaultModel.scope!==newScope){cfg.defaultModel=null;defaultCleared++}
   for(const role of Object.keys(cfg.routes)){const rt=cfg.routes[role];if(rt&&rt.providerId===id&&(rt.scope!==newScope||!rt.model)){cfg.routes[role]={providerId:null,model:null,scope:null,followDefault:true};routesCleared++}}
  }
  if(index>=0)cfg.providers[index]=p;else cfg.providers.push(p);
  const saved=save(cfg);if(!saved.ok)return saved;
  return {...saved,scopeChanged,keyCleared:keycleared,authModeReset,modelCleared:scopeChanged&&!model,defaultCleared,routesCleared};
 })}
 function setRoute(role,patch={}){return guarded(()=>{const cfg=load();if(!ROLES.includes(role))return {ok:false,error:'invalid_role'};
  const providerId=patch.providerId||null;if(providerId&&!cfg.providers.some(p=>p.id===providerId))return {ok:false,error:'provider_not_found'};
  const model=typeof patch.model==='string'?patch.model.trim():null;if(model&&!P.validModel(model))return {ok:false,error:'invalid_model'};
  const inheritedProvider=role==='proactive'?resolveFrom(cfg,'character').providerId:cfg.defaultProviderId;
  const provider=cfg.providers.find(p=>p.id===(providerId||inheritedProvider));if(!provider)return {ok:false,error:'provider_not_found'};
  cfg.routes[role]={providerId,model:model||null,scope:model?scope(provider):null,followDefault:patch.followDefault===true};return save(cfg)
 })}
 function setDefault(id){return guarded(()=>{const cfg=load();if(!cfg.providers.some(p=>p.id===id))return {ok:false,error:'provider_not_found'};cfg.defaultProviderId=id;return save(cfg)})}
 function setDefaultModel(patch={}){return guarded(()=>{
  const cfg=load(),p=cfg.providers.find(p=>p.id===patch.providerId),model=typeof patch.model==='string'?patch.model.trim():'';
  if(!p)return {ok:false,error:'provider_not_found'};
  if(!model||!P.validModel(model))return {ok:false,error:'invalid_model'};
  cfg.defaultProviderId=p.id;cfg.defaultModel={providerId:p.id,model,scope:scope(p)};
  return save(cfg)
 })}
 function removeProvider(id){return guarded(()=>{
  const cfg=load();if(!cfg.providers.some(p=>p.id===id))return {ok:false,error:'provider_not_found'};
  if(cfg.providers.length<=1)return {ok:false,error:'last_provider'};
  cfg.providers=cfg.providers.filter(p=>p.id!==id);
  let routesCleared=0;
  for(const role of Object.keys(cfg.routes)){const r=cfg.routes[role];if(r&&r.providerId===id){r.providerId=null;r.model=null;r.scope=null;routesCleared++}}
  if(cfg.defaultModel&&cfg.defaultModel.providerId===id)cfg.defaultModel=null;
  if(cfg.defaultProviderId===id)cfg.defaultProviderId=cfg.providers[0].id;
  const saved=save(cfg);if(!saved.ok)return saved;
  return {...saved,routesCleared,defaultProviderId:cfg.defaultProviderId};
 })}
 function getProvider(id){return guarded(()=>{const cfg=load(),p=cfg.providers.find(p=>p.id===id);if(!p)return {ok:false,error:'provider_not_found'};const r=resolveFrom({...cfg,routes:{character:{providerId:id}}},'character');return {ok:true,connection:r.connection||P.normalizeConnection(p).value,revision:p.revision,provider:providerView(cfg,p)}})}
 function setModels(id,result,revision){return guarded(()=>{const cfg=load(),p=cfg.providers.find(p=>p.id===id);if(!p)return {ok:false,error:'provider_not_found'};if(p.revision!==revision)return {ok:false,error:'stale_probe'};
  if(result.ok){p.models=[...new Set((result.models||[]).filter(P.validModel))].slice(0,200);p.modelsAt=Date.now();p.discoveryError=null}else p.discoveryError=result.error||'discovery_failed';return save(cfg)
 })}
 return {view,resolve,saveProvider,setRoute,setDefault,setDefaultModel,removeProvider,getProvider,setModels}
}
module.exports={createModelConfig,ROLES,scopeOf:scope};
