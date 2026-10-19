'use strict'
const fs=require('node:fs'),path=require('node:path');
// Optional standalone prompt-manager entry is deliberately excluded from releases.
const optional=new Set(['prompt-manager-main.cjs','prompt-sample-runner.cjs']);
// utilityProcess entry points are dynamic paths, not require() edges.
const roots=['main.js','preload.js','platform-worker.cjs','character/entry-kernel.cjs'];
function imports(text){return [...text.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map(m=>m[2]).filter(id=>id.startsWith('.'))}
function inspect(read,exists,rootFiles=roots){const visited=new Set(),missing=[];
 function walk(file){file=file.replace(/\\/g,'/');if(visited.has(file)||optional.has(file))return;visited.add(file);if(!exists(file)){missing.push({from:null,module:file});return}
  if(!/\.(c?js|mjs)$/.test(file))return;
  for(const id of imports(read(file))){const base=path.posix.normalize(path.posix.join(path.posix.dirname(file),id));if(optional.has(base))continue;const resolved=[base,base+'.js',base+'.cjs',base+'.json',base+'/index.js'].find(exists);if(!resolved){missing.push({from:file,module:base});continue}walk(resolved)}
 }
 for(const r of rootFiles)walk(r);return {ok:missing.length===0,files:[...visited].sort(),missing};
}
function runtimeFiles(root){const r=inspect(f=>fs.readFileSync(path.join(root,f),'utf8'),f=>{try{return fs.statSync(path.join(root,f)).isFile()}catch{return false}});if(!r.ok)throw Error('Runtime dependencies missing: '+JSON.stringify(r.missing));return r.files.filter(f=>!f.startsWith('renderer/'))}
function auditArchive(asar,archive){const entries=new Set(asar.listPackage(archive).map(f=>f.replace(/\\/g,'/').replace(/^\//,'')));const read=f=>asar.extractFile(archive,f.split('/').join(path.sep)).toString('utf8');const rootFiles=['main.js','preload.js','character/entry-kernel.cjs'];if(read('main.js').includes("require('./platform-packages.cjs')"))rootFiles.push('platform-worker.cjs');const result=inspect(read,f=>entries.has(f),rootFiles);for(const required of ['character/storage/schema.sql'])if(!entries.has(required)){result.ok=false;result.missing.push({from:'character/storage/store.cjs',module:required})}const binding=path.join(archive+'.unpacked','node_modules','better-sqlite3','build','Release','better_sqlite3.node');if(!fs.existsSync(binding)){result.ok=false;result.missing.push({from:'character/storage/driver.cjs',module:binding})}return result}
module.exports={runtimeFiles,auditArchive};
