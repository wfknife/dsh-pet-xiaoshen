'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const http = require('node:http'), crypto = require('node:crypto')
const harness = require('../official-harness.js')
const vm = require('node:vm')

test('attach authenticates the discovered dynamic Desktop port with matching cookie authority', async t => {
  const secret = crypto.randomBytes(32), seen = []
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-harness-'))
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'records:\n  client-connection/browser-session:\n    payload:\n      secret: ' + secret.toString('base64url') + '\n')
  const server = http.createServer((req, res) => {
    const cookie = req.headers.cookie
    if (!cookie) { res.writeHead(401); res.end(); return }
    const [version, body, sig] = cookie.slice(cookie.indexOf('=') + 1).split('.')
    const payload = JSON.parse(Buffer.from(body, 'base64url'))
    seen.push(payload.authority)
    const valid = version === 'v1' && payload.authority === req.headers.host &&
      sig === crypto.createHmac('sha256', secret).update(body).digest('base64url')
    res.writeHead(valid ? 200 : 401); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }) })
  const port = server.address().port
  const result = await harness.attach({ dshHome: home, discover: async () => ({ endpoints: [{ port, pid: 123, address: '127.0.0.1' }] }) })
  assert.equal(result.ok, true, result.reason)
  assert.equal(result.baseUrl, 'http://127.0.0.1:' + port)
  assert.deepEqual(seen, ['127.0.0.1:' + port])
})

test('a reachable endpoint rejecting the current credential is not reported as attached', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-harness-reject-'))
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'records:\n  client-connection/browser-session:\n    payload:\n      secret: ' + crypto.randomBytes(32).toString('base64url') + '\n')
  const server = http.createServer((req, res) => { res.writeHead(401); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }) })
  const result = await harness.attach({ dshHome: home, discover: async () => ({ endpoints: [{ port: server.address().port, pid: 123, address: '127.0.0.1' }] }) })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'authentication_failed')
  assert.equal(result.cookie, null)
})

test('discovery accepts only validated loopback listeners owned by the Desktop host', () => {
  const parsed = harness.desktopEndpoints({ endpoints: [
    { port: 60317, pid: 18924, address: '127.0.0.1' },
    { port: 60317, pid: 18924, address: '127.0.0.1' },
    { port: 0, pid: 1, address: '127.0.0.1' },
    { port: 65536, pid: 1, address: '127.0.0.1' },
    { port: 60318, pid: 0, address: '127.0.0.1' },
    { port: 60319, pid: 1, address: '0.0.0.0' },
    { port: 60320, pid: 1, address: '192.168.1.2' },
  ] })
  assert.deepEqual(parsed, [{ port: 60317, pid: 18924, address: '127.0.0.1' }])
})

test('a Desktop using a custom DSH home supplies its own credential directory', () => {
  const endpoints = harness.desktopEndpoints({ endpoints: [{ port: 40321, pid: 42, address: '127.0.0.1' }],
    hosts: [{ pid: 42, commandLine: '"F:\\Apps\\DeepSeek Harness.exe" --expose-internals "F:\\Apps\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js" "F:\\Apps\\dsh" "G:\\Custom Home\\profiles\\desktop"' }] })
  // win32 paths are retained on Windows, the platform shipped by this app.
  if (process.platform === 'win32') assert.equal(endpoints[0].dshHome, 'G:\\Custom Home')
})

test('clean edition permits connection while lifecycle operations stay forbidden', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
  const start = source.indexOf('function dshConnectionForbidden()')
  const end = source.indexOf('/** 唯一 lifecycle', start)
  const context = vm.createContext({ CLEAN_EDITION: true, TEST_EDITION: false, ISOLATED_TEST: false, process: { env: {} } })
  vm.runInContext(source.slice(start, end), context)
  assert.equal(context.dshConnectionForbidden(), null)
  assert.equal(context.dshLifecycleForbidden().error, 'edition_forbidden')
})

function hostFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
  let endpoint = null, usable = false, stopped = false, attaches = 0, starts = 0, userStopped = false
  const compat = { baseUrl: 'http://127.0.0.1:19387', authCookie: null,
    onDshStarted() { this.authCookie = null },
    async compatibilityGate() { return { usable, mode: usable ? 'new' : null } } }
  const context = vm.createContext({ require: id => require(path.resolve(__dirname, '..', id)), Date,
    DSH_HOME_DIR: 'fixture', win: null, log() {}, setTimeout() {}, setInterval() {},
    dshConnectionForbidden: () => null, getUpdateManager: () => ({ dshUserStopped: () => userStopped }),
    getDshCompat: () => compat, stopDshStream() { context.dshStopped = true },
    startStream() { starts++ }, scheduleDshReconnect() {}, dshStopped: stopped,
    officialHarness: () => ({ attach: async () => { attaches++; await Promise.resolve();
      if (!endpoint) return { ok: false, reason: 'desktop_offline' }
      usable = true
      return { ok: true, baseUrl: endpoint, cookie: 'private-cookie', expiresAt: Date.now() + 1000, probe: { status: 200 } }
    } }),
  })
  vm.runInContext(source.slice(source.indexOf('let officialHarnessState ='), source.indexOf('/* ---------- window ---------- */')), context)
  return { context, compat, endpoint: value => { endpoint = value; usable = false },
    stop: value => { userStopped = value }, counts: () => ({ attaches, starts }) }
}

test('automatic watch connects a late Desktop and rediscovers its port after restart', async () => {
  const f = hostFixture()
  await f.context.attachOfficialHarness('boot')
  assert.equal(f.counts().starts, 0)
  // Advance the retry boundary without relying on wall-clock sleeps.
  vm.runInContext('officialHarnessRetry.reset()', f.context)
  f.endpoint('http://127.0.0.1:40123')
  await f.context.harnessWatchTick()
  assert.equal(f.compat.baseUrl, 'http://127.0.0.1:40123')
  f.endpoint('http://127.0.0.1:51234')
  await f.context.harnessWatchTick()
  assert.equal(f.compat.baseUrl, 'http://127.0.0.1:51234')
  assert.equal(f.counts().starts, 2)
  await f.context.harnessWatchTick()
  assert.equal(f.counts().attaches, 3, 'healthy connection must not be reattached every tick')
})

test('overlapping manual/watch attach shares a job and IPC results contain no cookie', async () => {
  const f = hostFixture(); f.endpoint('http://127.0.0.1:41234')
  const [a, b] = await Promise.all([f.context.attachOfficialHarness('manual'), f.context.attachOfficialHarness('watch')])
  assert.equal(f.counts().attaches, 1)
  assert.equal(a.ok, true); assert.equal(b.ok, true)
  assert.equal(a.cookie, undefined)
  assert.equal(f.compat.authCookie, 'private-cookie')
  f.stop(true); await f.context.attachOfficialHarness('watch')
  assert.equal(f.counts().attaches, 1, 'explicit stop must prevent automatic reconnect')
})

test('clean attachment does not require the physically stripped update manager', async () => {
  const f = hostFixture(); delete f.context.getUpdateManager
  f.endpoint('http://127.0.0.1:42222')
  const result = await f.context.attachOfficialHarness('boot')
  assert.equal(result.ok, true)
  assert.equal(f.context.harnessUserStopped(), false)
})

test('Desktop approval events reach the renderer when the optional remote bridge is absent', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8')
  const socket = new (require('node:events').EventEmitter)(); socket.close = () => {}
  const sent = []; let callback
  const compat = { mode: 'new', stop() {}, async connectEvents(cb) { callback = cb; return socket } }
  const context = vm.createContext({ getDshCompat: () => compat, log() {}, setTimeout() {}, clearTimeout() {},
    win: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } } })
  vm.runInContext(source.slice(source.indexOf('let dshSocket ='), source.indexOf('/* ---------- P4-P1/P4-P2：官方 Desktop 接入')), context)
  await context.startStream()
  const frame = { type: 'server-request', rpcId: 'fixture:approval', payload: { type: 'approval/requested' } }
  assert.doesNotThrow(() => callback(frame))
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'pet-stream')
  context.stopDshStream(); callback(frame)
  assert.equal(sent.length, 1, 'events from the old connection must be ignored')
})
