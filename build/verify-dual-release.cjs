/* 校验双渠道发行包（只读；用 extractAll 避免 extractFile 的嵌套路径问题）
 * 用法: node build/verify-dual-release.cjs */
const asar = require('@electron/asar')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { auditArchive } = require('./runtime-files.cjs')

const cos = path.join(__dirname, '..', 'dist', 'release', 'win-unpacked', 'resources', 'app.asar')
const clean = path.join(__dirname, '..', 'dist-clean', 'win-unpacked', 'resources', 'app.asar')
const norm = (x) => x.split('\\').join('/')
let pass = 0, fail = 0
const check = (label, ok, detail) => { console.log((ok ? '  OK   ' : '  FAIL ') + label + (detail ? '  — ' + detail : '')); ok ? pass++ : fail++ }

function inspect(p, label) {
  const list = asar.listPackage(p).map(norm)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-verify-'))
  asar.extractAll(p, tmp)
  const read = (rel) => { try { return fs.readFileSync(path.join(tmp, rel), 'utf8') } catch (e) { return null } }
  const main = read('main.js') || ''
  const dependencies = auditArchive(asar, p)
  check('运行依赖、角色 schema 与 Electron SQLite 完整', dependencies.ok, dependencies.ok ? '' : JSON.stringify(dependencies.missing))
  const adapter = read('official-harness.js') || ''
  check('包含 Desktop 动态端口自动发现', adapter.includes('function desktopEndpoints(') && adapter.includes('dsh-desktop-host'))
  const pet = read('renderer/pet.js') || ''
  const html = read('renderer/index.html') || ''
  const diary = read('renderer/diary/diary-gen2.js')
  const up = read('renderer/diary/diary-engine.js') || ''
  console.log('\n=== ' + label + ' ===')
  console.log('  entries=' + list.length + ' | main=' + main.length + ' pet=' + pet.length + ' html=' + html.length + ' diary-gen2=' + (diary ? diary.length : 'MISSING') + ' diary-engine=' + up.length)
  check('含日记修复①关思考（thinkingDisabled）', !!diary && /thinkingDisabled: true/.test(diary))
  check('含日记修复②修复失败留原因（aiRepairReason）', /aiRepairReason/.test(up))
  check('含模型自定义通道（custom-model-store.cjs）', list.some((x) => x.endsWith('/custom-model-store.cjs') || x === '/custom-model-store.cjs'))
  check('含可输入模型控件（model-id-list）', html.indexOf('model-id-list') >= 0)
  const hasUpdaterDep = list.some((x) => x.indexOf('node_modules/electron-updater') >= 0)
  const hasUpdateUI = /function updateCheckUI/.test(pet)
  const hasInit = /function initAutoUpdater/.test(main)
  console.log('  更新栈：依赖=' + hasUpdaterDep + ' 更新UI=' + hasUpdateUI + ' initAutoUpdater=' + hasInit)
  check('未打包开发工具（提示词管理器入口）', !list.some((x) => /prompt-manager-(main|preload)\.cjs$/.test(x)))
  fs.rmSync(tmp, { recursive: true, force: true })
  return { hasUpdaterDep, hasUpdateUI, hasInit, list }
}

const a = inspect(cos, 'COS 版')
check('COS版：保留更新检测', a.hasInit)
check('COS版：保留 electron-updater 依赖', a.hasUpdaterDep)
const b = inspect(clean, 'GitHub 纯净版')
check('纯净版：无 initAutoUpdater', !b.hasInit)
check('纯净版：无 electron-updater 依赖', !b.hasUpdaterDep)
check('纯净版：无更新 UI', !b.hasUpdateUI)

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
process.exitCode = fail ? 1 : 0
