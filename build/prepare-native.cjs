'use strict'
// Used by npm postinstall and every electron-builder edition. Never accept a
// Node-ABI binding as proof that the Electron utility process can open SQLite.
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
async function prepare(context) {
  const version = context?.electronVersion || require('electron/package.json').version
  const arch = context ? require('builder-util').Arch[context.arch] : process.arch
  const cwd = path.dirname(require.resolve('better-sqlite3/package.json'))
  const args = [require.resolve('prebuild-install/bin.js'), '--runtime=electron', '--target=' + version, '--arch=' + arch]
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true, timeout: 120000 })
  if (result.status !== 0) {
    // Source compilation is a legitimate fallback; never silently ship a binding
    // that was built for the host Node version.
    const { rebuild } = await import('@electron/rebuild')
    await rebuild({ buildPath: root, electronVersion: version, arch, onlyModules: ['better-sqlite3'], force: true })
  }
  console.log('[native] prepared better-sqlite3 for Electron ' + version + ' / ' + arch)
}
module.exports = prepare
if (require.main === module) prepare().catch(error => { console.error(error); process.exitCode = 1 })
