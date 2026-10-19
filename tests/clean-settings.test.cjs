'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('actual clean transform keeps callable model settings and settings groups',()=>{
 const build=fs.readFileSync(path.join(__dirname,'../build/build-clean.mjs'),'utf8'),sandbox={};vm.createContext(sandbox);
 vm.runInContext(build.slice(build.indexOf('function stripBlocks('),build.indexOf('/* ---------- 备份原文件')),sandbox);
 const clean=sandbox.stripLines(sandbox.stripBlocks(fs.readFileSync(path.join(__dirname,'../renderer/pet.js'),'utf8'),['update','remote2','test']));let calls=0;
 const c={window:{ModelSettings:{refresh(){calls++}}},P:{soundEnabled:false,soundVolume:20,hydrateIntervalMin:45,soundEvents:{},diaryTime:'21:30'},cleanChecked:true,hideCleanFeatures(){},updateAutostartUI(){},$:id=>id==='tab-settings'?{dataset:{groupsReady:'1'}}:{}};vm.createContext(c);
 for(const name of ['refreshChatModelUI','refreshSceneModelUI']){const line=clean.split('\n').find(l=>l.includes('async function '+name+'('));assert.ok(line,'clean edition must retain '+name);vm.runInContext(line,c)}
 const start=clean.indexOf('  /* ---------- U2：设置页分组'),end=clean.indexOf("  $('btn-autostart').addEventListener",start);assert.ok(start>0&&end>start,'common settings group helpers must survive clean build');vm.runInContext(clean.slice(start,end),c);
 const a=clean.indexOf('  function updateSettingsUI()'),b=clean.indexOf('  function updateAutostartUI()',a);assert.ok(a>0&&b>a);vm.runInContext(clean.slice(a,b),c);c.updateSettingsUI();assert.equal(calls,2);
});
test('build cleanup restores pre-existing configuration and removes only generated marker files',()=>{
 const build=fs.readFileSync(path.join(__dirname,'../build/build-clean.mjs'),'utf8');const files=new Map([['marker','new'],['cfg','new'],['daily','new']]);
 const c={preservedBuildFiles:new Map([['marker','old-marker'],['cfg','old-config'],['daily',null]]),restore(){},marker:'marker',cfgFile:'cfg',root:'.',join:()=> 'daily',rmSync:f=>files.delete(f),writeFileSync:(f,b)=>files.set(f,b)};vm.createContext(c);vm.runInContext('try {} '+build.slice(build.lastIndexOf('} finally {')+2),c);assert.equal(files.get('cfg'),'old-config');assert.equal(files.get('marker'),'old-marker');assert.equal(files.has('daily'),false);
});
