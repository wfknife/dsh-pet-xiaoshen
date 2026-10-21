'use strict'
// Protocol adapters share validation, deadlines and truthful result semantics.
// No file access, Electron, global credentials, provider fallback or prompt editing.
const PROTOCOLS=['openai','openai-responses','ollama','anthropic','gemini'];
const DEFAULTS={openai:'https://api.deepseek.com','openai-responses':'https://api.openai.com/v1',ollama:'http://127.0.0.1:11434',anthropic:'https://api.anthropic.com/v1',gemini:'https://generativelanguage.googleapis.com/v1beta'};
// Loopback only. Never treat private/LAN addresses as keyless: an intranet gateway may require auth.
const LOOPBACK=/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|\[::ffff:127(?:\.\d{1,3}){3}\])$/i;
const local=base=>{try{return LOOPBACK.test(new URL(base).hostname)}catch{return false}};
const validModel=id=>typeof id==='string'&&!!id.trim()&&id===id.trim()&&id.length<=256&&!/[\s\x00-\x1f\x7f]/.test(id);
function normalizeConnection(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))return {ok:false,error:'invalid_connection'};
 const protocol=input.protocol||'openai';if(!PROTOCOLS.includes(protocol))return {ok:false,error:'unsupported_protocol'};
 let u;try{u=new URL(String(input.baseUrl||DEFAULTS[protocol]).trim());if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error()}catch{return {ok:false,error:'invalid_base_url'}};
 let p=u.pathname.replace(/\/+$/,'');
 if(protocol==='openai'){p=p.replace(/\/chat\/completions$/,'');if(!p&&u.hostname!=='api.deepseek.com')p='/v1'}
 if(protocol==='openai-responses'){p=p.replace(/\/responses$/,'');if(!p)p='/v1'}
 if(protocol==='ollama')p=p.replace(/\/api\/(chat|tags)$/,'').replace(/\/(api|v1)$/,'');
 if(protocol==='anthropic'){p=p.replace(/\/messages$/,'');if(!p)p='/v1'}
 if(protocol==='gemini'){p=p.replace(/\/models(?:\/[^/]+:generateContent)?$/,'');if(!p)p='/v1beta'}
 const baseUrl=u.origin+p;
 const authMode=input.authMode||(input.allowNoKey===true?'none':'auto');if(!['auto','none','bearer','api-key'].includes(authMode))return {ok:false,error:'invalid_auth_mode'};
 if(input.model&&!validModel(input.model))return {ok:false,error:'invalid_model'};
 const temperatureMode=input.temperatureMode||'auto',tokenParameter=input.tokenParameter||'auto';
 if(!['auto','omit','send'].includes(temperatureMode)||!['auto','max_tokens','max_completion_tokens','none'].includes(tokenParameter))return {ok:false,error:'invalid_parameter_mode'};
 const apiKeyHeader=String(input.apiKeyHeader||'').trim();if(apiKeyHeader&&(!/^[a-z][a-z0-9-]{0,63}$/i.test(apiKeyHeader)||/^(host|cookie|content-length|connection)$/i.test(apiKeyHeader)))return {ok:false,error:'invalid_key_header'};
 const positive=(n,def,max)=>Number.isFinite(Number(n))&&Number(n)>0?Math.min(Math.round(Number(n)),max):def;
 return {ok:true,value:{protocol,baseUrl,apiKey:String(input.apiKey||'').trim(),apiKeyHeader,authMode,model:input.model||'',temperatureMode,tokenParameter,
   timeoutMs:positive(input.timeoutMs,120000,600000),maxOutputTokens:positive(input.maxOutputTokens,4096,65536),thinkingMode:input.thinkingMode==='deepseek'?'deepseek':'auto',temps:input.temps&&typeof input.temps==='object'?{...input.temps}:{}}};
}
// Explicit auth modes require a key. `auto` is optional: send the key when present, otherwise try
// keyless and let the server answer truthfully (401 => auth-required, not a silent no-key refusal).
// `none` never needs and never sends a key. Protocol capability (Ollama native) is keyless regardless
// of whether the address is loopback or LAN.
function needsKey(c){return c.authMode==='bearer'||c.authMode==='api-key'}
function headers(c){const h={'content-type':'application/json',accept:'application/json'};
 if(c.protocol==='anthropic')h['anthropic-version']='2023-06-01';
 if(c.apiKey&&c.authMode!=='none'){
  if(c.authMode==='bearer'||(c.authMode==='auto'&&['openai','openai-responses','ollama'].includes(c.protocol)))h.authorization='Bearer '+c.apiKey;
  else {const name=c.apiKeyHeader||(c.protocol==='gemini'?'x-goog-api-key':'x-api-key');h[name]=c.apiKey}
 }return h}
function sentAuthHeader(c,h){
 if(!c.apiKey||c.authMode==='none')return false;
 if(h.authorization||h['x-api-key']||h['x-goog-api-key'])return true;
 return !!(c.apiKeyHeader&&h[c.apiKeyHeader]);
}
function classify(status,detail,sentAuth){
 if(status===401||status===403)return sentAuth?'auth':'auth-required';
 if(status===429)return 'rate_limit';
 if(status>=500&&/load(?:ing)?[^.]{0,24}model|model[^.]{0,24}load|正在加载/i.test(detail))return 'model_loading';
 if(status>=500)return 'provider_unavailable';
 if(/context.{0,30}(length|limit|window)|too many tokens|prompt.{0,20}too long/i.test(detail))return 'context_length';
 if((status===400||status===404)&&/model/i.test(detail)&&/(not found|does not exist|unknown|not support|invalid|unavailable)/i.test(detail))return 'model_invalid';
 if(status===404)return 'endpoint_not_found';if(status===400||status===422)return 'invalid_request';return 'http_'+status;
}
function textParts(parts){return (parts||[]).filter(p=>p&&p.thought!==true&&(p.type==='text'||(!p.type&&typeof p.text==='string'))).map(p=>p.text||'').join('')}
function completion(reason,tokens,reasoningTokens=0){return {finishReason:reason||'unknown',tokens:Number(tokens)||0,reasoningTokens:Number(reasoningTokens)||0}}
function parse(protocol,j){
 let text,meta;
 if(protocol==='openai'){
  const c=j&&j.choices&&j.choices[0];if(!c||!c.message)return {error:'invalid_response'};
  if(c.message.refusal)return {error:'content_filter'};
  text=Array.isArray(c.message.content)?textParts(c.message.content):typeof c.message.content==='string'?c.message.content:'';
  if(!text&&c.message.tool_calls?.length)return {error:'unsupported_tool_call'};
  meta=completion(c.finish_reason,j.usage&&j.usage.completion_tokens,j.usage&&j.usage.completion_tokens_details&&j.usage.completion_tokens_details.reasoning_tokens);
 }else if(protocol==='openai-responses'){
  if(!j||!Array.isArray(j.output))return {error:'invalid_response'};
  if(j.status==='failed')return {error:'provider_error'};
  const parts=j.output.filter(o=>o.type==='message').flatMap(o=>o.content||[]);
  if(parts.some(p=>p.type==='refusal'))return {error:'content_filter'};
  text=parts.filter(p=>p.type==='output_text').map(p=>p.text||'').join('');
  if(!text&&j.output.some(o=>o.type==='function_call'))return {error:'unsupported_tool_call'};
  meta=completion(j.status==='incomplete'?'length':'stop',j.usage&&j.usage.output_tokens,j.usage&&j.usage.output_tokens_details&&j.usage.output_tokens_details.reasoning_tokens);
 }else if(protocol==='ollama'){
  if(!j||!j.message)return {error:j&&j.error?'provider_error':'invalid_response'};
  text=typeof j.message.content==='string'?j.message.content:'';if(!text&&j.message.tool_calls?.length)return {error:'unsupported_tool_call'};meta=completion(j.done===false||j.done_reason==='length'?'length':j.done_reason||(j.done===true?'stop':'unknown'),j.eval_count);
 }else if(protocol==='anthropic'){
  if(!j||!Array.isArray(j.content))return {error:'invalid_response'};
  text=textParts(j.content);if(!text&&j.content.some(x=>x.type==='tool_use'))return {error:'unsupported_tool_call'};meta=completion(j.stop_reason==='max_tokens'?'length':j.stop_reason==='refusal'?'content_filter':j.stop_reason,j.usage&&j.usage.output_tokens);
 }else{
  const c=j&&j.candidates&&j.candidates[0];if(!c)return {error:j&&j.promptFeedback&&j.promptFeedback.blockReason?'content_filter':'invalid_response'};
  text=textParts(c.content&&c.content.parts);meta=completion(c.finishReason==='MAX_TOKENS'?'length':['SAFETY','RECITATION','PROHIBITED_CONTENT','BLOCKLIST','SPII'].includes(c.finishReason)?'content_filter':c.finishReason,j.usageMetadata&&j.usageMetadata.candidatesTokenCount,j.usageMetadata&&j.usageMetadata.thoughtsTokenCount);
 }
 if(meta.finishReason==='content_filter')return {error:'content_filter',completion:meta};
 if(['length','max_tokens'].includes(meta.finishReason))return {error:'provider_truncated',completion:meta};
 if(!text||!text.trim())return {error:'empty',completion:meta};return {text:text.trim(),completion:meta};
}
// Thinking models count hidden reasoning tokens against num_predict. The pet needs visible text, so
// Ollama defaults to thinking disabled unless the caller explicitly asks for it; when thinking is
// requested the output budget gets headroom so the visible answer still fits.
function ollamaThinking(request){const t=request&&request.thinking;return !!(t&&t.type==='enabled')}
function build(c,r,opts={}){
 const maxTokens=Math.min(r.maxTokens||1024,c.maxOutputTokens),temp=r.temperature==null?c.temps[r.purpose]:r.temperature;
 const temperature=c.temperatureMode!=='omit'&&!opts.omitTemperature&&temp!=null?Number(temp):undefined;
 let endpoint,body;const systems=r.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),conversation=r.messages.filter(m=>m.role!=='system');
 if(c.protocol==='openai'){
  endpoint='/chat/completions';body={model:r.model,messages:r.messages,stream:false};const param=opts.tokenParameterOverride||(c.tokenParameter==='auto'?'max_tokens':c.tokenParameter);if(param!=='none')body[param]=maxTokens;
  if(temperature!==undefined)body.temperature=temperature;
  if(r.thinking&&(c.thinkingMode==='deepseek'||new URL(c.baseUrl).hostname==='api.deepseek.com'))body.thinking={type:r.thinking.type==='disabled'?'disabled':'enabled'};
 }else if(c.protocol==='openai-responses'){
  endpoint='/responses';body={model:r.model,input:r.messages,max_output_tokens:maxTokens,stream:false,store:false};if(temperature!==undefined)body.temperature=temperature;
 }else if(c.protocol==='ollama'){
  const think=ollamaThinking(r)&&!opts.thinkDisabled&&!opts.omitThink;
  const headroom=Math.min(4096,Math.max(1024,maxTokens));
  const budget=Math.min(65536,think?maxTokens+headroom:maxTokens);
  endpoint='/api/chat';body={model:r.model,messages:r.messages,stream:false,options:{num_predict:budget}};
  if(!opts.omitThink)body.think=think;
  if(temperature!==undefined)body.options.temperature=temperature;
 }else if(c.protocol==='anthropic'){
  endpoint='/messages';body={model:r.model,max_tokens:maxTokens,messages:conversation};if(systems)body.system=systems;if(temperature!==undefined)body.temperature=temperature;
 }else{
  endpoint='/models/'+encodeURIComponent(r.model.replace(/^models\//,''))+':generateContent';
  body={contents:conversation.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]})),generationConfig:{maxOutputTokens:maxTokens}};
  if(systems)body.systemInstruction={parts:[{text:systems}]};if(temperature!==undefined)body.generationConfig.temperature=temperature;
 }
 return {url:c.baseUrl+endpoint,body};
}
function createClient({fetch:transport=globalThis.fetch}={}){
 async function exchange(c,url,opts,timeoutMs){
  const h=headers(c),sentAuth=sentAuthHeader(c,h);
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),timeoutMs||c.timeoutMs);
  const abort=()=>ctl.abort(); if(opts.signal?.aborted)ctl.abort();else opts.signal?.addEventListener('abort',abort,{once:true});
  try{
   const res=await transport(url,{...opts,headers:h,signal:ctl.signal,redirect:'error',credentials:'omit',cache:'no-store'});
   const text=typeof res.text==='function'?await res.text():JSON.stringify(await res.json());
   if(text.length>2*1024*1024)return {ok:false,error:'response_too_large'};
   if(!res.ok)return {ok:false,error:classify(res.status,text,sentAuth),status:res.status,unsupportedTemperature:(res.status===400||res.status===422)&&/temperature/i.test(text)&&/not supported|unsupported|not allowed|only.{0,12}default/i.test(text),useCompletionTokens:(res.status===400||res.status===422)&&/max_tokens/i.test(text)&&/max_completion_tokens/i.test(text)&&/not supported|unsupported|use.*instead/i.test(text),retryWithoutThink:(res.status===400||res.status===422)&&/think/i.test(text)&&/not support|unsupported|unknown|invalid/i.test(text)};
   try{return {ok:true,json:JSON.parse(text)}}catch{return {ok:false,error:'invalid_json'}}
  }catch(e){return {ok:false,error:opts.signal?.aborted?'aborted':ctl.signal.aborted?'timeout':'network'}}finally{clearTimeout(timer);opts.signal?.removeEventListener('abort',abort)}
 }
 async function complete(input,request={}){
  if(!request||typeof request!=='object')return {ok:false,error:'invalid_request'};
  const n=normalizeConnection(input);if(!n.ok)return n;const c=n.value,model=request.model||c.model;
  const fail=(error,extra={})=>({ok:false,error,provider:'direct',protocol:c.protocol,model:model||null,...extra});
  if(!validModel(model))return fail(model?'invalid_model':'no-model');if(needsKey(c)&&!c.apiKey)return fail('no-key');
  if(!Array.isArray(request.messages)||!request.messages.length)return fail('empty_messages');
  if(request.messages.some(m=>!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'))return fail('unsupported_content');
  if(!request.messages.some(m=>m.role==='user'))return fail('empty_messages');
  if(JSON.stringify(request.messages).length>96000)return fail('provider_context_budget');
  if(request.maxTokens!=null&&(!Number.isFinite(Number(request.maxTokens))||Number(request.maxTokens)<1))return fail('invalid_max_tokens');
  if(request.temperature!=null&&(!Number.isFinite(Number(request.temperature))||Number(request.temperature)<0||Number(request.temperature)>2))return fail('invalid_temperature');
  const r={...request,model},timeout=Math.max(1,Math.min(Number(request.timeoutMs)||c.timeoutMs,c.timeoutMs,600000)),started=Date.now();
  const opts={omitTemperature:false,tokenParameterOverride:null,omitThink:false,thinkDisabled:false};
  const thinkingRequested=c.protocol==='ollama'&&ollamaThinking(r);
  for(let attempt=0;attempt<3;attempt++){
   const built=build(c,r,opts),remaining=timeout-(Date.now()-started);if(remaining<=0)return fail('timeout');
   const result=await exchange(c,built.url,{method:'POST',body:JSON.stringify(built.body),signal:request.signal},remaining);
   if(!result.ok){
    if(!opts.omitTemperature&&c.temperatureMode==='auto'&&result.unsupportedTemperature){opts.omitTemperature=true;continue}
    if(!opts.tokenParameterOverride&&c.protocol==='openai'&&c.tokenParameter==='auto'&&result.useCompletionTokens){opts.tokenParameterOverride='max_completion_tokens';continue}
    // Older Ollama builds may reject the `think` field: retry once without it.
    if(c.protocol==='ollama'&&!opts.omitThink&&result.retryWithoutThink){opts.omitThink=true;continue}
    return fail(result.error,{...(result.status?{status:result.status}:{})})
   }
   const p=parse(c.protocol,result.json);
   if(p.error){
    // Capability degradation: a thinking model ate the budget / returned only hidden reasoning.
    // Retry once with thinking disabled, but never override an explicit caller request.
    if(c.protocol==='ollama'&&!thinkingRequested&&!opts.thinkDisabled&&!opts.omitThink&&(p.error==='provider_truncated'||p.error==='empty')&&attempt<2){opts.thinkDisabled=true;continue}
    return fail(p.error,{...(p.completion?{completion:p.completion}:{})})
   }
   return {ok:true,provider:'direct',protocol:c.protocol,model,text:p.text,completion:p.completion,...(opts.omitTemperature?{temperatureOmitted:true}:{}),...(opts.tokenParameterOverride?{tokenParameter:opts.tokenParameterOverride}:{}),...(opts.thinkDisabled?{thinkingDisabled:true}:{})};
  }return fail('invalid_request');
 }
 async function discover(input){
  const n=normalizeConnection(input);if(!n.ok)return n;const c=n.value;if(needsKey(c)&&!c.apiKey)return {ok:false,error:'no-key',models:[]};
  const endpoint=c.protocol==='ollama'?'/api/tags':'/models',models=[];let cursor=null;
  for(let page=0;page<5;page++){
   const url=new URL(c.baseUrl+endpoint);if(cursor)url.searchParams.set(c.protocol==='gemini'?'pageToken':'after_id',cursor);
   const r=await exchange(c,url.href,{method:'GET'},Math.min(c.timeoutMs,10000));if(!r.ok)return {ok:false,error:r.error,models:[],...(r.status?{status:r.status}:{})};
   const j=r.json;
   // Compatible servers use data / models / bare arrays; Ollama native uses models[].name.
   const items=Array.isArray(j)?j:Array.isArray(j&&j.data)?j.data:Array.isArray(j&&j.models)?j.models:null;
   if(!items)return {ok:false,error:'invalid_response',models:[]};
   for(const m of items){let id=typeof m==='string'?m:m&&(m.id||m.name||m.model);if(c.protocol==='gemini'&&Array.isArray(m.supportedGenerationMethods)&&!m.supportedGenerationMethods.includes('generateContent'))continue;if(c.protocol==='gemini'&&typeof id==='string')id=id.replace(/^models\//,'');if(validModel(id)&&!models.includes(id)&&models.length<200)models.push(id)}
   cursor=c.protocol==='gemini'?j.nextPageToken:c.protocol==='anthropic'&&j.has_more?j.last_id:null;if(!cursor||models.length>=200)break;
  }return {ok:true,models};
 }
 return {complete,discover};
}
module.exports={PROTOCOLS,DEFAULTS,normalizeConnection,validModel,isLocal:local,needsKey,createClient};
