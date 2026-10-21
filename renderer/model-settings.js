/* Main process owns credentials and routes. This view never saves while rendering. */
window.ModelSettings=(function(){
 'use strict';const $=id=>document.getElementById(id);let state=null,selected=null,busy=false,refreshing=null,draft=null,scopeDirty=false;
 const errors={configuration_error:'配置文件无法读取，已保留原文件，请检查配置',unsupported_config_schema:'配置格式不受支持，已保留原文件',invalid_base_url:'地址需为不含账号或查询参数的 HTTP(S) 地址',invalid_model:'模型 ID 不能为空白或包含空白，最长 256 字符',invalid_key_header:'密钥请求头名称不合法',invalid_provider_id:'服务标识无效，请重新添加服务',last_provider:'至少需要保留一个服务连接；可以先添加新的服务再删除',unsupported_tool_call:'此文本功能收到了工具调用，未执行；请选择支持文本回复的模型',auth:'API Key 无效或认证方式不匹配，请检查密钥/认证方式。','auth-required':'服务要求认证：请填写 API Key，或在高级设置选择“无需认证”（本机服务）。',network:'无法连接服务：请确认服务已启动、地址和端口正确（本机 Ollama 默认 http://127.0.0.1:11434）。',timeout:'请求超时：模型可能正在加载，可重试或调大超时。',rate_limit:'请求受限或额度不足',no_key:'当前认证方式需要 API Key，请填写密钥。','no-key':'当前认证方式需要 API Key，请填写密钥。','no-model':'请选择模型或手动填写模型 ID',empty:'服务返回空内容：请更换模型或确认该模型支持文本对话。',model_invalid:'服务不识别该模型：请重新获取模型列表或检查模型名称。',endpoint_not_found:'地址不匹配或该服务没有模型列表接口，可手动填写模型 ID。',model_loading:'模型正在加载，请稍后重试。',provider_unavailable:'服务端错误，请稍后重试。',unsupported_protocol:'不支持的协议',provider_in_use:'此服务正在使用，请先更换 AI 模型或功能自定义配置',stale_model_route:'服务地址或协议已更改，请重新选择模型',save_failed:'保存失败，原配置已保留',stale_probe:'检测期间配置已改变，请重试',invalid_json:'服务没有返回有效 JSON',invalid_response:'服务响应格式与协议不符',provider_error:'服务返回了错误响应，请稍后重试或更换模型',invalid_request:'服务不支持这次请求参数，请更换模型或调整高级设置',response_too_large:'服务返回内容过大，请降低输出上限',aborted:'请求已取消',provider_truncated:'输出达到长度限制，请调整输出上限或模型',unsupported_content:'此功能包含当前协议尚不支持的消息内容',content_filter:'服务拒绝了内容',context_length:'输入超过模型的上下文限制'};
 function status(text,kind='info'){$('model-status').textContent=text;$('model-status').dataset.kind=kind}
 function failure(r){return errors[r&&r.error]||'操作失败：'+(r&&r.error||'未知错误')}
 function option(value,text){const o=document.createElement('option');o.value=value;o.textContent=text;return o}
 function profile(id){if(!state)return draft?.id===id?draft:null;return state.providers.find(p=>p.id===id)||(draft?.id===id?draft:null)}
 function changeNotice(r){if(!r)return '';const parts=[];if(r.keyCleared)parts.push('密钥已清除，请重新填写');if(r.authModeReset)parts.push('认证方式已重置为自动');if(r.modelCleared)parts.push('模型需重新选择');if(!parts.length)return r.scopeChanged?'地址/类型已更改，请重新获取模型列表':'';return '地址/类型已更改：'+parts.join('；')}
 // Placeholder tells the truth about whether a key is required for this endpoint now.
 function keyPlaceholder(){
  const auth=$('model-auth').value,p=profile(selected),hasStored=!scopeDirty&&!!(p&&p.hasKey);
  if(hasStored&&((p.keySource||'settings')==='settings'))return '已保存；留空不改';
  const keyRequired=!scopeDirty&&typeof p?.keyRequired==='boolean'?p.keyRequired:(auth==='bearer'||auth==='api-key');
  return keyRequired?'填写 API Key':'此服务可无需密钥（可选填）';
 }
 function updateProtocolHint(){
  const protocol=$('model-protocol').value;
  const hints={openai:'适用于 DeepSeek、OpenAI Chat Completions 及兼容服务。','openai-responses':'使用 OpenAI Responses 接口。',ollama:'连接本机 Ollama，无需密钥；也可填写远程 Ollama 地址。',anthropic:'使用 Anthropic Messages 接口，也支持兼容网关。',gemini:'使用 Gemini 原生接口，也支持兼容网关。'};
  $('model-protocol-hint').textContent=hints[protocol]||'';
 }
 function fillEditor(p){
  selected=p.id;$('model-provider-select').value=p.id;$('model-provider-delete').disabled=!state.providers.some(item=>item.id===p.id);
  for(const [id,key] of [['api-base-url','baseUrl'],['model-provider-name','name'],['model-default','model'],['model-protocol','protocol'],['model-auth','authMode'],['model-temperature','temperatureMode'],['model-token-param','tokenParameter'],['model-output-limit','maxOutputTokens'],['model-timeout','timeoutMs'],['model-thinking','thinkingMode'],['model-key-header','apiKeyHeader']])$(id).value=p[key]??'';
  $('api-key').value='';scopeDirty=false;
  $('api-key').placeholder=keyPlaceholder();$('api-clear-key').disabled=!p.hasKey;
  $('model-default-hint').textContent=p.discoveryError?'列表获取失败：'+(errors[p.discoveryError]||p.discoveryError):p.modelsAt?'已获取 '+(p.models||[]).length+' 个模型':'自动保存连接配置';
  updateProtocolHint();
  const dl=$('model-id-list');dl.textContent='';for(const id of p.models||[])dl.appendChild(option(id,id));
 }
 function setupGuidance(setup){
  const reason=setup&&setup.reason;
  if(reason==='no-provider'||reason==='provider_not_found'||!reason)return '还没有可用的 AI 服务：请在下方选择类型、填写服务地址和 API Key，然后点“获取模型列表”。';
  if(reason==='no-key')return '所选服务需要 API Key：请在下方填写密钥，然后点“获取模型列表”。';
  if(reason==='no-model')return '还没有选择模型：点“获取模型列表”，再点“使用此模型”。';
  return '还没有可用的 AI 模型：请选择服务并完成配置。';
 }
 function renderChoices(){
  const select=$('model-choice');select.textContent='';
  const current=state.defaultModel||{providerId:state.defaultProviderId,model:null};
  for(const p of state.providers){
   const models=new Set([p.model,...(p.models||[]),...Object.values(state.routes).filter(r=>r.effectiveProviderId===p.id).map(r=>r.effectiveModel),current.providerId===p.id?current.model:null].filter(Boolean));
   for(const model of models)select.appendChild(option(JSON.stringify({providerId:p.id,model}),model+' · '+p.name));
  }
  select.value=JSON.stringify({providerId:current.providerId,model:current.model});
  if(!select.value){select.prepend(option('','请获取模型列表'));select.value=''}
  $('model-choice-save').disabled=!select.value;$('model-test').disabled=!select.value;
  $('model-choice-hint').textContent=(current.model?'当前模型：'+current.model+' · '+(profile(current.providerId)?.name||'未知服务'):'尚未选择模型')+'（更换后点“使用此模型”生效）';
  const custom=Object.values(state.routes).filter(r=>!r.inherited).length;
  $('model-functions').querySelector('summary').textContent='功能自定义'+(custom?'（'+custom+' 项已自定义）':'');
 }
 function renderRoutes(){
  const root=$('model-routes');root.textContent='';
  for(const [role,label] of [['character','聊天与相关处理'],['proactive','主动交流与计划'],['diary','日记']]){
   const r=state.routes[role],row=document.createElement('div');row.className='ms-route';row.dataset.purpose=role;
   const name=document.createElement('label');name.textContent=label;name.htmlFor='model-mode-'+role;row.appendChild(name);
   const mode=document.createElement('input');mode.type='checkbox';mode.id=name.htmlFor;mode.checked=!r.inherited;mode.setAttribute('aria-label',label+'自定义');row.appendChild(mode);const modeLabel=document.createElement('label');modeLabel.htmlFor=mode.id;modeLabel.textContent='自定义';row.appendChild(modeLabel);
   const editor=document.createElement('div');editor.className='ms-route-editor';editor.hidden=!mode.checked;row.appendChild(editor);
   const providers=document.createElement('select');providers.className='dp-name-input';providers.setAttribute('aria-label',label+'的服务连接');for(const p of state.providers)providers.appendChild(option(p.id,p.name));providers.value=r.effectiveProviderId||state.defaultProviderId;editor.appendChild(providers);
   const input=document.createElement('input');input.className='dp-name-input';input.value=r.effectiveModel||'';input.placeholder='选择或输入模型 ID';input.setAttribute('aria-label',label+'的模型');const dl=document.createElement('datalist');dl.id='models-for-'+role;input.setAttribute('list',dl.id);editor.append(input,dl);
   function updateList(){dl.textContent='';for(const id of profile(providers.value)?.models||[])dl.appendChild(option(id,id))}updateList();providers.addEventListener('change',()=>{input.value=profile(providers.value)?.model||'';updateList()});
   const save=document.createElement('button');save.className='dp-mini-btn';save.textContent='保存自定义';const commit=()=>{if(!input.value.trim()){status('请选择或输入模型 ID');input.focus();return}action(()=>window.pet.modelConfig.route(role,{providerId:providers.value,model:input.value.trim()}),'自定义模型已保存')};save.addEventListener('click',commit);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();commit()}});editor.appendChild(save);
   mode.addEventListener('change',()=>{editor.hidden=!mode.checked;if(!mode.checked)action(()=>window.pet.modelConfig.route(role,{providerId:null,model:null,followDefault:true}),'此功能已跟随所选 AI 模型');else input.focus()});
   const hint=document.createElement('div');hint.className='dp-panel-hint';hint.style.overflowWrap='anywhere';hint.textContent=r.error?failure({error:r.error}):'当前：'+(r.effectiveModel||'未配置')+' · '+(profile(r.effectiveProviderId)?.name||'未配置');row.appendChild(hint);root.appendChild(row);
  }
 }
 async function refresh(force=false){
  if(refreshing)return refreshing;
  refreshing=(async()=>{const next=await window.pet.modelConfig.get();if(!next||!next.ok){status(failure(next),'error');return}
   state=next;const select=$('model-provider-select');select.textContent='';for(const p of state.providers)select.appendChild(option(p.id,p.name));
   const p=profile(selected)||profile(state.defaultProviderId)||state.providers[0];if(!p)return;
   select.value=p.id;
   if(force||!selected)fillEditor(p);
   // Preserve drafts in the editor; role rows refresh only after saved operations.
   if(force||!$('model-routes').children.length){renderRoutes();renderChoices()}
   if(force&&state.setup&&state.setup.ready===false)status(setupGuidance(state.setup));
  })().catch(()=>status('配置读取失败','error')).finally(()=>{refreshing=null});return refreshing;
 }
 async function action(run,message){if(busy)return;busy=true;$('model-settings-root').inert=true;status('处理中…');try{const r=await run();if(!r||!r.ok){status(failure(r)+(r&&r.notice?'（'+r.notice+'）':''),'error');return}await refresh(true);status((r&&r.message)||message||'已保存')}catch{status('操作失败，请重试','error')}finally{busy=false;$('model-settings-root').inert=false}}
 function init(){if(!$('model-settings-root')||!window.pet?.modelConfig)return;
  $('model-provider-select').addEventListener('change',()=>{const p=profile($('model-provider-select').value);if(p)fillEditor(p)});
  $('model-provider-new').addEventListener('click',()=>{
   const id='provider_'+Date.now().toString(36),base=profile(state.defaultProviderId)||{};
   draft={...base,id,name:'新服务',protocol:'openai',baseUrl:'https://api.deepseek.com',model:'',hasKey:false,keySource:'none',keyRequired:false,models:[],modelsAt:0,discoveryError:null,authMode:'auto'};
   $('model-provider-select').appendChild(option(id,'新服务（未保存）'));fillEditor(draft);$('model-provider-name').focus();status('填写服务信息后保存，即可获取模型列表');
  });
  $('model-auth').addEventListener('change',()=>{$('api-key').placeholder=keyPlaceholder()});
  $('api-base-url').addEventListener('change',()=>{
   if($('model-auth').value!=='auto')$('model-auth').value='auto';
   $('model-default').value='';scopeDirty=true;$('api-key').placeholder=keyPlaceholder();
  });
  $('model-choice').addEventListener('change',()=>{$('model-choice-save').disabled=!$('model-choice').value;$('model-test').disabled=!$('model-choice').value});
  $('model-protocol').addEventListener('change',()=>{const protocol=$('model-protocol').value;const defaults={openai:'https://api.deepseek.com','openai-responses':'https://api.openai.com/v1',ollama:'http://127.0.0.1:11434',anthropic:'https://api.anthropic.com/v1',gemini:'https://generativelanguage.googleapis.com/v1beta'};$('api-base-url').value=defaults[protocol];$('model-default').value='';$('api-key').value='';$('model-auth').value='auto';scopeDirty=true;updateProtocolHint();$('api-key').placeholder=keyPlaceholder()});
  const editorPatch=()=>({id:selected,name:$('model-provider-name').value.trim(),protocol:$('model-protocol').value,baseUrl:$('api-base-url').value.trim(),apiKey:$('api-key').value.trim(),authMode:$('model-auth').value,model:$('model-default').value.trim(),temperatureMode:$('model-temperature').value,tokenParameter:$('model-token-param').value,maxOutputTokens:Number($('model-output-limit').value),timeoutMs:Number($('model-timeout').value),thinkingMode:$('model-thinking').value,apiKeyHeader:$('model-key-header').value.trim()});
  $('api-save').addEventListener('click',()=>action(async()=>{
   const saved=await window.pet.modelConfig.save(editorPatch());if(!saved||!saved.ok)return saved;
   const notice=changeNotice(saved);status(notice||'连接已保存，正在获取模型列表…');
   let probe;try{probe=await window.pet.modelConfig.probe(selected)}catch{return {ok:false,error:'network',notice}}
   if(!probe||!probe.ok){await refresh(true);return {ok:false,error:(probe&&probe.error)||'network',notice}}
   return {ok:true,message:notice||'模型列表已更新；选择模型后点“使用此模型”才会生效'}
  }));
  $('api-clear-key').addEventListener('click',()=>action(()=>window.pet.modelConfig.save({id:selected,clearKey:true}),'密钥已清除'));
  $('model-choice-save').addEventListener('click',()=>{const value=$('model-choice').value;if(!value){status('请先获取模型列表并选择模型');return}action(()=>window.pet.modelConfig.setDefaultModel(JSON.parse(value)),'AI 模型已更新；自定义功能保持原选择')});
  $('model-provider-delete').addEventListener('click',async()=>{
   if(!selected)return;
   if(typeof window.confirm==='function'&&!window.confirm('删除这个 AI 服务连接？使用它的功能会跟随其它可用服务。'))return;
   await action(async()=>{const r=await window.pet.modelConfig.remove(selected);if(r&&r.ok)selected=null;return r},'连接已删除');
  });
  $('model-refresh').addEventListener('click',()=>action(()=>window.pet.modelConfig.probe(selected),'模型列表已更新；选择模型后点“使用此模型”才会生效'));
  $('model-test').addEventListener('click',()=>{const value=$('model-choice').value;if(!value)return;const choice=JSON.parse(value);action(()=>window.pet.modelConfig.test(choice.providerId,choice.model),'所选模型测试成功')});
  refresh(true).then(()=>{if(state&&(!state.setup||state.setup.ready!==false))status('配置已加载')});
 }
 init();return {refresh:()=>refresh(false),reload:()=>refresh(true)};
 })()
