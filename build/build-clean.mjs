/* === AUTO-HEADER:BEGIN ===
 * [用途分类] BUILD — BUILD - 构建/打包/发布流程脚本（有副作用，勿当测试跑）
 * [安全性]   HAS-SIDE-EFFECTS | 会写 dist/**、重打 asar、生成发行产物
 * [怎么跑]   只在明确构建流程里按顺序调用
 * [行为特征] 起子进程 / Electron
 * [自动生成] 本头部由 E:\dsh\tools\inject-script-headers.cjs 生成；修改脚本时请保留，不要手删。
 * [约定]     ① 本文件若是 TEST/LIVE，只允许被"回归清单"或人工点名调用；
 * ② 若被误当测试批量跑，可能改写源码/产物。
 === AUTO-HEADER:END === */
// build-clean.mjs — 构建纯净版（物理剔除：更新/远程桥/诊断包导出）
// 流程：临时替换根目录的 main.js/preload.js/renderer/*（剔除版）→ electron-builder 打包 → 恢复原文件
// 产物：dist-clean/deskpet-setup-clean-<version>.exe（独立安装，不覆盖日常版）
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const marker = join(root, 'build', 'clean-edition.json')
const cfgFile = join(root, 'build', 'electron-builder-clean.json')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

/* ---------- 剔除工具 ---------- */
function stripBlocks(text, names) {
  let out = text
  for (const n of names) {
    out = out.replace(new RegExp(`/\\* CLEAN-STRIP:BEGIN ${n} \\*/[\\s\\S]*?/\\* CLEAN-STRIP:END ${n} \\*/`, 'g'), '')
  }
  return out
}
function stripLines(text) {
  // LINES 成对块 + 单行 LINE 标记
  let out = text.replace(/\/\* CLEAN-STRIP:LINES-START \*\/[\s\S]*?\/\* CLEAN-STRIP:LINES-END \*\//g, '')
  out = out.replace(/^.*\/\* CLEAN-STRIP:LINE \*\/.*$/gm, '')
  return out
}

/* ---------- 备份原文件 ---------- */
const filesToSwap = ['main.js', 'preload.js', 'renderer/pet.js', 'renderer/index.html']
// 安全校验：磁盘上的原文件必须是"完整版"（含 handleRemote/updateCheckUI/test 钩子等特征），
// 否则说明上次构建失败没恢复（剔除版污染），此时备份会"固坏"——直接中止，要求先恢复。
const mainRaw = readFileSync(join(root, 'main.js'), 'utf8')
const petRaw = readFileSync(join(root, 'renderer/pet.js'), 'utf8')
const preRaw = readFileSync(join(root, 'preload.js'), 'utf8')
const integrityHits = [
  mainRaw.includes('function initAutoUpdater'),   // 主进程：更新
  petRaw.includes('function updateCheckUI'),      // 渲染层：更新 UI
  petRaw.includes('window.__petTest'),            // 渲染层：测试钩子
  preRaw.includes('updateConfig'),                // preload：更新 API
]
if (!integrityHits.every(Boolean)) {
  console.error('[build-clean] 中止：原文件不完整（上次构建未恢复？），需先恢复完整源码')
  console.error('  缺失项:', integrityHits.map((h, i) => h ? '' : ['handleRemote', 'initAutoUpdater', 'diagnostic:export', 'updateCheckUI', '__petTest', 'updateConfig', 'remoteInfo', 'remote.html'][i]).filter(Boolean).join(', '))
  process.exit(2)
}
const backup = new Map()
for (const f of filesToSwap) {
  backup.set(f, readFileSync(join(root, f), 'utf8'))
}
// remote.html 会被删除，单独备份（可能不存在则跳过）
const REMOTE_HTML = join(root, 'renderer', 'remote.html')
const remoteHtmlBackup = existsSync(REMOTE_HTML) ? readFileSync(REMOTE_HTML, 'utf8') : null
let restored = false
const restore = () => {
  if (restored) return // 幂等：无论 exit/finally 多少次只恢复一次，防止重复写回剔除版
  restored = true
  for (const [f, text] of backup) writeFileSync(join(root, f), text)
  if (remoteHtmlBackup !== null) writeFileSync(REMOTE_HTML, remoteHtmlBackup)
  console.log('[build-clean] restored originals')
}
// process.exit(1) 不触发 finally，但一定触发 exit 事件 → 用 exit 保底
process.on('exit', restore)

try {
  /* ---------- main.js：剔除 remote/update/diag + LINES + LINE ---------- */
  let main = readFileSync(join(root, 'main.js'), 'utf8')
  main = stripBlocks(main, ['remote', 'remote2', 'update', 'diag'])
  main = stripLines(main)
  main = main.replace(/^.*require\('electron-updater'\).*$/gm, '')
  writeFileSync(join(root, 'main.js'), main)

  /* ---------- pet.js：剔除 update 块 + remote2 块 + test 钩子 + LINE ---------- */
  let pet = readFileSync(join(root, 'renderer', 'pet.js'), 'utf8')
  pet = stripBlocks(pet, ['update', 'remote2', 'test'])
  pet = stripLines(pet)
  // 剔除后 hideCleanFeatures 无条件隐藏（updateConfig IPC 已不存在）
  pet = pet.replace(
    /function hideCleanFeatures\(\) \{[\s\S]*?\n  \}/,
    `function hideCleanFeatures() {
    if (cleanChecked) return
    cleanChecked = true
    isCleanEdition = true
    document.querySelectorAll('[data-clean-hidden]').forEach((el) => { el.remove() })
  }`
  )
  writeFileSync(join(root, 'renderer', 'pet.js'), pet)

  /* ---------- index.html：删除 更新/诊断/远程访问 三块（连续段落，稳健删除） ---------- */
  let html = readFileSync(join(root, 'renderer', 'index.html'), 'utf8')
  // 三块是连续的：从「🔄 软件更新」小节到「🔔 提示音」小节前。
  // 删除起止标注：起始 = "🔒 软件更新"所在 dp-care-sub（含 data-clean-hidden="update" 的第一个元素），
  // 结束 = 下一个不带 data-clean-hidden 的 dp-care-sub（🔔 提示音）。
  const startMark = '<div class="dp-care-sub" data-clean-hidden="update">'
  const endMark = '<div class="dp-care-sub">🔔 提示音</div>'
  const si = html.indexOf(startMark)
  const ei = html.indexOf(endMark)
  if (si >= 0 && ei > si) {
    html = html.slice(0, si) + html.slice(ei)
    console.log('[build-clean] index.html: 更新/诊断/远程访问 三块已整体删除')
  } else {
    console.log('[build-clean] WARN: index.html 标记未找到，跳过删除')
  }
  writeFileSync(join(root, 'renderer', 'index.html'), html)

  /* ---------- preload.js：删除 update/remote/diagnostic 暴露 ---------- */
  let pre = readFileSync(join(root, 'preload.js'), 'utf8')
  pre = pre.replace(/^.*(updateConfig|updateSetConfig|updateCheck|updateDownload|updateInstall|updateHasInstaller|onUpdateProgress|onUpdateAvailable|diagnosticExport|remoteInfo|onRemotePetCommand|sendRemotePetCommandResult).*$/gm, '')
  writeFileSync(join(root, 'preload.js'), pre)

  /* ---------- remote.html：删除手机远程 PWA 页面（远程桥已剔除，页面无用） ---------- */
  try { rmSync(join(root, 'renderer', 'remote.html'), { force: true }) } catch (err) { /* ignore */ }
  console.log('[build-clean] remote.html removed')

  /* ---------- electron-builder 配置 ---------- */
  writeFileSync(marker, JSON.stringify({ edition: 'clean', version }, null, 2), 'utf8')
  writeFileSync(join(root, 'build', 'daily-collector.json'), JSON.stringify({ edition: 'clean-daily', version }, null, 2), 'utf8')
  const cfg = {
    ...(pkg.build || {}),
    appId: 'com.deskpet.xiaoshen-clean',
    productName: '桌宠小深纯净版',
    directories: { ...(pkg.build?.directories || {}), output: 'dist-clean' },
    artifactName: 'deskpet-setup-clean-${version}.${ext}',
    nsis: {
      ...((pkg.build && pkg.build.nsis) || {}),
      shortcutName: '桌宠小深纯净版',
      artifactName: 'deskpet-setup-clean-${version}.${ext}',
    },
    files: ['main.js', 'state-store.cjs', 'custom-model-store.cjs', 'pet-life-store.cjs', 'official-harness.js', 'preload.js', 'renderer/**/*', '!renderer/prompt-manager*', 'package.json', '!build/**', '!node_modules/electron-updater/**', '!node_modules/elevate/**'],
    extraResources: [
      ...((pkg.build && pkg.build.extraResources) || []),
      { from: 'build/clean-edition.json', to: 'clean-edition.json' },
      { from: 'build/daily-collector.json', to: 'daily-collector.json' },
    ],
  }
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8')

  /* ---------- 构建 ---------- */
  console.log('[build-clean] building (files temporarily swapped to clean variant)...')
  const r = spawnSync('node', ['node_modules/electron-builder/out/cli/cli.js', '--win', 'nsis', '--config', cfgFile, '-p', 'never'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('[build-clean] FAILED, status', r.status)
    process.exit(1)
  }
  console.log('[build-clean] done, version', version)
  console.log('  产物: dist-clean/deskpet-setup-clean-' + version + '.exe')
} finally {
  restore()
  rmSync(marker, { force: true })
  rmSync(join(root, 'build', 'daily-collector.json'), { force: true })
  rmSync(cfgFile, { force: true })
}
