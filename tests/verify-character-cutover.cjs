'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), record = path.resolve(root, '../research/long-lived-character-cutover-20261018')
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]) }
const baseline = path.join(record, 'before'), sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const beforeFiles=files(baseline), existing=new Set(beforeFiles.map(f=>path.relative(baseline,f)))
const topFiles=dir=>fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>path.join(dir,e.name))
const currentSources=[...topFiles(root),...files(path.join(root,'character')),...topFiles(path.join(root,'build')),...topFiles(path.join(root,'tests')),path.join(root,'renderer/systems/nurture-rules.js')].filter(f=>/\.(js|cjs|mjs|json|sql)$/.test(f))
const changes = [...beforeFiles.map(file => { const relative = path.relative(baseline, file), current = path.join(root, relative); return { file: relative.replaceAll('\\', '/'), before: sha(file), after: fs.existsSync(current) ? sha(current) : null } }).filter(r => r.before !== r.after),
  ...currentSources.filter(f=>!existing.has(path.relative(root,f))).map(file=>({file:path.relative(root,file).replaceAll('\\','/'),before:null,after:sha(file)}))]
const selected = [...files(path.join(root, 'character')).filter(f => f.endsWith('.cjs')), ...changes.filter(r => r.after && /\.(js|cjs|mjs)$/.test(r.file)).map(r => path.join(root, r.file)), ...files(path.join(root, 'tests')).filter(f => /(?:character-acceptance|character-experience|character-cutover|sample-character-cutover|character-electron-smoke|character-packaged-smoke|character-desktop-smoke|character-proactive-live)/.test(path.basename(f))), path.join(root, 'renderer/core/speech-channel.js')]
const checked = [...new Set(selected)].map(file => { const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true }); return { file: path.relative(root, file).replaceAll('\\', '/'), hash: sha(file), ok: r.status === 0, error: r.status ? r.stderr : null } })
const result = { at: new Date().toISOString(), beforeHead: 'a92a330815c17ce64d3e42d65f1e914fd5216639', changes, checked, ok: checked.every(c => c.ok) }
fs.writeFileSync(path.join(record, 'source-verification.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ comparedChangedFiles: changes.length, syntaxFiles: checked.length, ok: result.ok, failures: checked.filter(c => !c.ok) }))
process.exitCode = result.ok ? 0 : 1
