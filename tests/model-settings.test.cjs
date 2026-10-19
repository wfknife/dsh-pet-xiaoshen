const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {createModelConfig}=require('../model-config.cjs');
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.style={};this.dataset={};this._value='';}
 set textContent(v){this.text=v;this.children=[]}get textContent(){return this.text||''}
 set value(v){this._value=v}get value(){return this.tag==='select'&&!this.children.some(x=>x.value===this._value)?'':this._value}
 appendChild(e){this.children.push(e);return e}append(...es){this.children.push(...es)}prepend(e){this.children.unshift(e)}
 setAttribute(k,v){this[k]=v}addEventListener(k,f){this.listeners[k]=f}focus(){}querySelector(){return this.summary||(this.summary=new Element('summary'))}
 async fire(k){await this.listeners[k]?.({preventDefault(){}})}
}
async function setup(probeError){
 let prefs={};const config=createModelConfig({read:()=>structuredClone(prefs),write:p=>{prefs={...prefs,...p};return true}}),calls=[];
 const html=fs.readFileSync(require.resolve('../renderer/index.html'),'utf8'),elements={};for(const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g))elements[match[2]]=new Element(match[1]);
 const api={get:async()=>config.view(),save:async p=>{calls.push('save');return config.saveProvider(p)},probe:async id=>{calls.push('probe');const p=config.view().providers.find(p=>p.id===id);const result=probeError?{ok:false,error:probeError}:{ok:true,models:['real-a','real-b']};config.setModels(id,result,p.revision);return result},route:async(...args)=>config.setRoute(...args),setDefaultModel:async p=>config.setDefaultModel(p)};
 const context={window:{pet:{modelConfig:api}},document:{getElementById:id=>elements[id],createElement:t=>new Element(t)}};vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/model-settings.js'),'utf8'),context);await context.window.ModelSettings.reload();return {elements,config,calls};
}
test('saving connection automatically fetches actual models without selecting first result',async()=>{
 const {elements:e,config,calls}=await setup();e['api-base-url'].value='http://localhost:11434';e['model-protocol'].value='ollama';
 await e['api-save'].fire('click');assert.deepEqual(calls,['save','probe']);assert.ok(e['model-choice'].children.some(x=>x.textContent.startsWith('real-a')));assert.equal(config.resolve('character').error,'no-model');
 e['model-choice'].value=JSON.stringify({providerId:'legacy',model:'real-b'});await e['model-choice-save'].fire('click');for(const role of ['character','diary','proactive'])assert.equal(config.resolve(role).model,'real-b');
 const row=e['model-routes'].children[0],toggle=row.children[1],editor=row.children[3];assert.equal(toggle.type,'checkbox');assert.equal(editor.hidden,true);toggle.checked=true;await toggle.fire('change');assert.equal(editor.hidden,false);assert.equal(editor.children[1].listeners.blur,undefined);
});
test('failed discovery keeps saved connection and explains failure with manual fallback',async()=>{
 const {elements:e,config,calls}=await setup('auth');e['api-base-url'].value='https://example.test/v1';await e['api-save'].fire('click');assert.deepEqual(calls,['save','probe']);assert.equal(config.view().providers[0].baseUrl,'https://example.test/v1');assert.match(e['model-status'].textContent,/认证失败/);assert.equal(e['model-settings-root'].inert,false);assert.ok(e['model-default']);
});
