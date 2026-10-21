'use strict'
// Run with the installed Electron executable, without creating a BrowserWindow.
const { app, utilityProcess } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-kernel-smoke-'))
app.setPath('userData', path.join(temporary, 'electron'))
let child, result, finishing = false
function finish(value) {
  if (finishing) return
  finishing = true; result = value
  process.stdout.write(JSON.stringify({ ...value, versions: process.versions, isolatedData: temporary }) + '\n')
  if (child) child.kill()
  app.quit()
}
app.whenReady().then(() => {
  child = utilityProcess.fork(path.join(__dirname, '../character/entry-kernel.cjs'), [], {
    env: { ...process.env, DESKPET_CHARACTER_MODE: 'candidate', DESKPET_CHARACTER_DATA_DIR: temporary }, stdio: 'pipe', serviceName: 'Isolated Kernel Acceptance',
  })
  child.on('message', message => {
    if (message.type === 'ready') finish({ ok: true, event: 'ready', info: message.info })
    if (message.type === 'fatal') finish({ ok: false, event: 'fatal', error: message.error })
  })
  child.on('exit', code => { if (!result) finish({ ok: false, event: 'exit_before_ready', code }) })
  setTimeout(() => finish({ ok: false, event: 'timeout' }), 15000).unref()
}).catch(error => finish({ ok: false, event: 'launcher_error', error: error.message }))
