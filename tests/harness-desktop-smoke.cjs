'use strict'
// Real main/preload/renderer and adapter. No model calls or formal pet data.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const root = path.resolve(__dirname, '..')
const main = process.env.DESKPET_ACCEPTANCE_MAIN || path.join(root, 'main.js')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-test-harness-live-'))
process.env.DESKPET_CHARACTER_TRIAL_DATA = temporary
process.env.DESKPET_CHARACTER_KERNEL = 'candidate'
process.env.DESKPET_ATTACH_DESKTOP = '1'
let finished = false
function finish(result) {
  if (finished) return
  finished = true
  console.log(JSON.stringify({ ...result, main, isolatedData: temporary }))
  app.exit(result.ok ? 0 : 1)
}
require(main)
app.whenReady().then(async () => {
  try {
    let window, status
    for (let i = 0; i < 120; i++) {
      window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('index.html'))
      if (window && !window.webContents.isLoading()) {
        status = await window.webContents.executeJavaScript('window.pet.harnessStatus()')
        if (status.harness?.usable) break
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!status?.harness?.usable) throw Error('automatic_attach_failed:' + JSON.stringify(status))
    const manual = await window.webContents.executeJavaScript('window.pet.harnessEnsure()')
    if (!manual.ok || manual.cookie !== undefined) throw Error('unsafe_or_failed_manual_attach')
    let text
    for (let i = 0; i < 30; i++) {
      text = await window.webContents.executeJavaScript('document.getElementById("harness-status").textContent')
      if (text.includes('已接入')) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!text.includes('已接入')) throw Error('settings_status_stale:' + text)
    finish({ ok: true, automatic: true, endpoint: status.harness.endpoint, mode: status.harness.mode,
      totalSessions: status.work?.total, manualCookieExposed: false, settingsText: text })
  } catch (error) { finish({ ok: false, error: error.message }) }
})
setTimeout(() => finish({ ok: false, error: 'timeout' }), 55000).unref()
