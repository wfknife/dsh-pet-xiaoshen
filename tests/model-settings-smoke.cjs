// Isolated renderer smoke test: no application startup, credentials or real requests.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const profile=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'deskpet-model-ui-'));
app.setPath('userData',profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:390,height:1200,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false,offscreen:true}});
 const source=fs.readFileSync(path.join(root,'renderer/index.html'),'utf8');
 const start=source.indexOf('          <div id="model-settings-root"'),end=source.indexOf('          <div class="dp-care-sub">💬',start);
 const css=fs.readFileSync(path.join(root,'renderer/pet.css'),'utf8')+'\n'+fs.readFileSync(path.join(root,'renderer/model-settings.css'),'utf8');
 const html='<html><meta charset="utf-8"><style>'+css+'\nhtml,body{margin:0;overflow:auto;height:auto;background:#f6f9fc}body{box-sizing:border-box;padding:16px;width:360px;font-family:Arial,sans-serif}</style><body>'+source.slice(start,end)+'</body></html>';
 const preview=path.join(profile,'preview.html');fs.writeFileSync(preview,html);await win.loadFile(preview);
 await win.webContents.executeJavaScript(`
 window.calls=[];window.cfg={ok:true,defaultProviderId:'service',defaultModel:{providerId:'service',model:null},providers:[{id:'service',name:'我的 AI 服务',protocol:'openai',baseUrl:'https://example.test/v1',model:'',models:[],modelsAt:0,hasKey:false,authMode:'auto'}],routes:Object.fromEntries(['character','proactive','diary'].map(r=>[r,{inherited:true}]))};
 window.pet={modelConfig:{get:async()=>structuredClone(cfg),save:async p=>{calls.push('save');let x=cfg.providers.find(y=>y.id===p.id);if(!x){x={id:p.id,name:p.name||'新服务',protocol:p.protocol||'openai',baseUrl:p.baseUrl||'',model:'',models:[],modelsAt:0,hasKey:false,authMode:'auto'};cfg.providers.push(x)}Object.assign(x,p);return {ok:true}},probe:async id=>{calls.push('probe');const x=cfg.providers.find(y=>y.id===id)||cfg.providers[0];x.models=['chat-model-large','chat-model-fast'];x.modelsAt=1;return {ok:true}},setDefaultModel:async p=>{cfg.defaultModel=p;for(const r of Object.values(cfg.routes)){r.effectiveModel=p.model;r.effectiveProviderId=p.providerId}return {ok:true}},test:async(...args)=>{calls.push(args);return {ok:true}}}};void 0;
 `);
 await win.webContents.executeJavaScript(fs.readFileSync(path.join(root,'renderer/model-settings.js'),'utf8')+';void 0');
 await win.webContents.executeJavaScript('window.ModelSettings.reload()');
 const run=code=>win.webContents.executeJavaScript(code);
 await run(`document.getElementById('api-save').click()`);
 // Wait on renderer condition, without interacting with production app.
 for(let i=0;i<50;i++){if(await run(`calls.includes('probe')&&!document.getElementById('model-settings-root').inert`))break;await new Promise(r=>setTimeout(r,20))}
 const result=await run(`(()=>{const s=document.getElementById('model-choice');s.value=JSON.stringify({providerId:'service',model:'chat-model-fast'});s.dispatchEvent(new Event('change'));document.getElementById('model-choice-save').click();return {calls,options:[...s.options].map(x=>x.textContent),overflow:[...document.querySelectorAll('.model-settings *')].some(x=>x.getBoundingClientRect().right>document.body.getBoundingClientRect().right)}})()`);
 if(!result.calls.includes('probe'))throw Error(JSON.stringify(result));
 for(const protocol of ['openai','openai-responses','anthropic','gemini','ollama']){
  const changed=await run(`(()=>{const type=document.getElementById('model-protocol');if(![...type.options].some(o=>o.value==='${protocol}'))throw Error('Missing protocol');type.value='${protocol}';type.dispatchEvent(new Event('change'));document.getElementById('api-save').click();return {address:document.getElementById('api-base-url').value}})()`);
  for(let i=0;i<50;i++){if(await run(`!document.getElementById('model-settings-root').inert`))break;await new Promise(r=>setTimeout(r,20))}
  const saved=await run(`cfg.providers[0].protocol`);if(saved!==protocol)throw Error('Protocol not saved: '+protocol);
  if(protocol==='ollama'&&changed.address!=='http://127.0.0.1:11434')throw Error('Missing Ollama address');
 }
 const preset=await run(`(()=>{const type=document.getElementById('model-protocol');type.value='openai';type.dispatchEvent(new Event('change'));return {protocol:type.value,address:document.getElementById('api-base-url').value,keyPlaceholder:document.getElementById('api-key').placeholder}})()`);
 if(preset.protocol!=='openai'||preset.address!=='https://api.deepseek.com')throw Error('Protocol selector did not fill defaults: '+JSON.stringify(preset));
 if(!preset.keyPlaceholder)throw Error('Missing key placeholder');

 await run(`document.getElementById('model-functions').open=false`);
 await run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))`);
 await new Promise(r=>setTimeout(r,300));
 const image=await win.webContents.capturePage();fs.mkdirSync(path.join(root,'tests','artifacts'),{recursive:true});fs.writeFileSync(path.join(root,'tests/artifacts/model-settings.png'),image.toPNG());
 for(const width of [280,360]){
  const layout=await run(`(()=>{document.body.style.width='${width}px';document.getElementById('model-connections').open=true;document.getElementById('model-mode-character').click();return {overflow:[...document.querySelectorAll('.model-settings *')].some(x=>x.getBoundingClientRect().right>document.body.getBoundingClientRect().right),hidden:document.querySelector('.ms-route-editor').hidden}})()`);
  if(layout.overflow)throw Error('Overflow at '+width);
 }
 console.log('PASS: all five protocol selectors save and fetch models, Ollama local address, key placeholder, concrete model selection, 280/360px layouts; screenshot tests/artifacts/model-settings.png');app.quit();
}).catch(error=>{console.error(error.message);app.exit(1)});
