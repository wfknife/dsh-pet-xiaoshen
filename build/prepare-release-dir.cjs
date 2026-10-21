/* prepare-release-dir.cjs — 生成本地发布目录（双渠道），并清理同名旧包
 * 用法: node build/prepare-release-dir.cjs
 * 产出:
 *   releases/cos-<version>/    ← 上传 COS：exe + blockmap + latest.yml + version.json
 *   releases/github-<version>/ ← 上传 GitHub Release：仅干净 exe（+SHA256 文本）
 * 说明: electron-builder 的 latest.yml 在 --dir/nsis 组合下不总是生成，这里按其格式补齐。 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { parseVersionFromName } = require('./version-compare.js')

const root = path.join(__dirname, '..')
const relDir = path.join(root, 'releases')
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

function pickExe(dir) {
  if (!fs.existsSync(dir)) return null
  const list = fs.readdirSync(dir)
    .filter((n) => /\.exe$/.test(n) && !/uninstaller/i.test(n))
    .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return list.length ? path.join(dir, list[0].n) : null
}

function digest(buf) {
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    sha512: crypto.createHash('sha512').update(buf).digest('base64'),
  }
}

function latestYml(version, name, size, sha512) {
  return ['version: ' + version, 'files:', '  - url: ' + name, '    sha512: ' + sha512,
    '    size: ' + size, 'path: ' + name, 'sha512: ' + sha512,
    "releaseDate: '" + new Date().toISOString() + "'", ''].join('\n')
}

/* ---------- A: COS 版 ---------- */
const cosExe = pickExe(path.join(root, 'dist', 'release'))
if (cosExe) {
  const name = path.basename(cosExe)
  const version = parseVersionFromName(name) || pkgVersion
  const buf = fs.readFileSync(cosExe)
  const d = digest(buf)
  const out = path.join(relDir, 'cos-' + version)
  fs.mkdirSync(out, { recursive: true })
  fs.copyFileSync(cosExe, path.join(out, name))
  const bm = cosExe + '.blockmap'
  if (fs.existsSync(bm)) fs.copyFileSync(bm, path.join(out, name + '.blockmap'))
  fs.writeFileSync(path.join(out, 'latest.yml'), latestYml(version, name, buf.length, d.sha512), 'utf8')
  fs.writeFileSync(path.join(out, 'version.json'), JSON.stringify(
    { version, note: '', sha256: d.sha256, size: buf.length, filename: name, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  /* 清理 dist 根目录里同名旧包与过期清单（避免误发布旧版本） */
  const stale = [
    path.join(root, 'dist', name),
    path.join(root, 'dist', name + '.blockmap'),
    path.join(root, 'dist', 'version.json'),
    path.join(root, 'dist', 'latest.yml'),
  ]
  const removed = []
  for (const f of stale) { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.basename(f)) } }
  console.log('[COS] ' + name + '  v' + version + '  ' + buf.length + ' B')
  console.log('  sha256 = ' + d.sha256)
  console.log('  sha512 = ' + d.sha512)
  console.log('  out    = ' + out)
  if (removed.length) console.log('  清理 dist 根目录同名旧物: ' + removed.join(', '))
} else { console.error('[COS] 未找到 dist/release 下的安装包') }

/* ---------- B: GitHub 纯净版 ---------- */
const cleanExe = pickExe(path.join(root, 'dist-clean'))
if (cleanExe) {
  const name = path.basename(cleanExe)
  const version = parseVersionFromName(name) || pkgVersion
  const buf = fs.readFileSync(cleanExe)
  const d = digest(buf)
  const out = path.join(relDir, 'github-' + version)
  fs.mkdirSync(out, { recursive: true })
  fs.copyFileSync(cleanExe, path.join(out, name))
  fs.writeFileSync(path.join(out, name + '.sha256.txt'), d.sha256 + '  ' + name + '\n', 'utf8')
  console.log('[GitHub] ' + name + '  v' + version + '  ' + buf.length + ' B')
  console.log('  sha256 = ' + d.sha256)
  console.log('  out    = ' + out)
} else { console.error('[GitHub] 未找到 dist-clean 下的安装包') }
