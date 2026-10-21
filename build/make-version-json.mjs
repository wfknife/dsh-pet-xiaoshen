// make-version-json.mjs — 发布脚本：扫描 dist/ 最新安装包，生成 version.json，
// 连同安装包一起复制到发布目录（默认 ~/dsh-updates，经 remote bridge /updates/ + cpolar 分发）。
//
// 用法：node build/make-version-json.mjs [--note "更新说明"] [--out <dir>] [--dist <dir>]
//   --dist 供测试/构建指向隔离目录；默认 dist/
//
// P2-4：版本解析统一走 build/version-compare.js，完整保留 prerelease（2.0.0-rc.1 不截断）。
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseVersionFromName } = require('./version-compare.js')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distArg = process.argv.find((a) => a.startsWith('--dist='))?.slice(7)
const distDir = distArg ? (isAbsolute(distArg) ? distArg : join(root, distArg)) : join(root, 'dist')
const outDir = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || join(homedir(), 'dsh-updates')
const noteIdx = process.argv.indexOf('--note')
const noteFileIdx = process.argv.indexOf('--note-file')
// 更新说明：优先 --note-file <utf8文件>（PowerShell 传中文命令行会 ANSI 乱码，用文件避免）
let note = ''
if (noteFileIdx >= 0 && process.argv[noteFileIdx + 1]) {
  try { note = readFileSync(process.argv[noteFileIdx + 1], 'utf8').trim() } catch (err) { /* ignore */ }
}
if (!note && noteIdx >= 0) note = process.argv[noteIdx + 1] || ''

// 找最新安装包：dist/*.exe，排除 uninstaller / blockmap 等
const exes = readdirSync(distDir)
  .filter((n) => /\.exe$/.test(n) && !/uninstaller/i.test(n))
  .map((n) => ({ name: n, mtime: statSync(join(distDir, n)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

if (exes.length === 0) {
  console.error('[make-version-json] no installer found in', distDir)
  process.exit(1)
}

const exe = exes[0]
const src = join(distDir, exe.name)
// 对文件内容算 SHA-256（不能用文件名——否则 SHA 永远不变，校验形同虚设）
const sha256 = createHash('sha256').update(readFileSync(src)).digest('hex')
// P2-4：支持 1.1.28 / 2.0.0-rc.1 / 2.0.0-beta.3 / deskpet-setup-clean-... ；保留完整 prerelease
const version = parseVersionFromName(exe.name)
if (!version) {
  console.error('[make-version-json] cannot parse version from', exe.name)
  process.exit(1)
}

const manifest = {
  version,
  note,
  sha256,
  size: statSync(src).size,
  filename: exe.name,
  updatedAt: new Date().toISOString(),
}

mkdirSync(outDir, { recursive: true })
copyFileSync(src, join(outDir, exe.name))
writeFileSync(join(outDir, 'version.json'), JSON.stringify(manifest, null, 2), 'utf8')
// 同时写一份到 dist/ 便于开发机自查
writeFileSync(join(distDir, 'version.json'), JSON.stringify(manifest, null, 2), 'utf8')
// electron-updater 差分更新清单（latest.yml + blockmap 一起发布，供增量下载）
for (const extra of ['latest.yml', exe.name + '.blockmap']) {
  const f = join(distDir, extra)
  if (existsSync(f)) copyFileSync(f, join(outDir, extra))
}

console.log('[make-version-json] published v' + version)
console.log('  file    :', exe.name, '(' + Math.round(statSync(src).size / 1048576) + ' MB)')
console.log('  sha256  :', sha256)
console.log('  out dir :', outDir)
