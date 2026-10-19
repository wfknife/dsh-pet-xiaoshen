'use strict'
/*
 * Official Harness Desktop Adapter（Phase 4-P1 / P4-P2）
 *
 * 桌宠与「官方 DeepSeek Harness Desktop」的**唯一耦合点**。职责：
 *   1) 检测：安装、进程及 Desktop Host 实际的本机监听端口（全部只读）；
 * 2) 接入：接入正在运行的 Desktop 自己的服务，兼容旧版 19387 与新版动态端口——
 *      读本机凭据文件里的会话签名密钥，自签一枚 HMAC cookie 交给上层 dsh-compat。
 *      dsh-compat 本来就是 cookie 认证、本来就走 `/api/remote.mux` ⇒ 协议层零改动；
 *   3) 停止记账：pid 文件 + 路径身份校验，停止只允许杀本 adapter 曾经拉起的进程。
 *
 * 自拉能力（`ensureStarted` / `track`）：**当前没有自动调用点**。用户口径是「桌面端启动
 *   或存在时就接入，不自己拉起 3080」⇒ 开机与轮询路径一律只 attach。这套自拉代码保留
 *   但休眠；若要启用必须显式接线并在契约门里登记，不要散落回业务层。
 *
 * 硬边界：
 *   - 绝不写入官方安装目录、绝不改官方注册表/更新配置；
 *   - **绝不占用 19387**（占用会让 Desktop Host 启动失败）；
 *   - 不读写官方 profile / sessions / storages —— 只读 `.credentials.yaml` 取密钥；
 *   - 密钥**只驻内存**：不落盘、不进日志、不上报；每次认证失败都重读重签，不长期缓存；
 *   - 所有函数失败隔离：任何异常都折回结构化结果，绝不向上抛出影响桌宠其他功能。
 *
 * 版本适配策略：安装位置来自卸载表注册表（官方升级后自动跟随），bin.js 路径按
 * 「安装根 + resources/app.asar/dsh/...」模式推导并**实测存在**。认证配方照抄官方
 * `dsh-client-connection`（cookie 名 = `dsh-auth-`+b64url(sha256(authority))，值 =
 * `v1.<b64url(payload)>.<b64url(hmacSHA256(secret, body))>`）。官方未来改布局或改配方时
 * 这里失败并显式报告，改这一个文件即可适配。
 */
const { spawn, spawnSync } = require('child_process')
const crypto = require('crypto')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { tokenizeCommandLine } = require('./dsh-lifecycle.js')

const DISPLAY_NAME = 'DeepSeek Harness'
const DEFAULT_PROFILE = 'pet'      // 桌宠自持实例专用自定义 profile（web 模板派生）
const TEMPLATE_PROFILE = 'web'     // 初始化模板（shipped）

/* ---------- Desktop 自身服务（19387）的接入常量：照抄官方 dsh-client-connection，rc.2 实测 ---------- */
const AUTHORITY = '127.0.0.1:19387'   // 旧版回退端点；新版由 Host 进程的监听端口发现
const AUTH_RECORD_KEY = 'client-connection/browser-session'
const CREDENTIALS_FILE = '.credentials.yaml'
const COOKIE_MAX_AGE_DAYS = 30        // 官方 cookieMaxAgeDays 默认 30；超过会被拒
const SECRET_BYTES = 32

/* ------------------------------ 只读工具 ------------------------------ */

function runPowerShell(script, timeoutMs) {
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: timeoutMs || 8000, windowsHide: true })
    if (r.status !== 0) return null
    const out = String(r.stdout || '').trim()
    return out || null
  } catch (e) {
    return null
  }
}

function resolveDshHome(opts) {
  try {
    if (opts && typeof opts.dshHome === 'string' && opts.dshHome) return opts.dshHome
  } catch (e) { /* ignore */ }
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

function profilePath(dshHome, name) {
  return path.join(dshHome, 'profiles', name)
}

/* asar 内部文件存在性：Electron 主进程的 fs 天然支持 .asar 路径；
   plain node（测试/工具上下文）回退为只读解析 asar 头逐层查目录。 */
function asarContains(asarFilePath, innerRel) {
  try {
    const fd = fs.openSync(asarFilePath, 'r')
    try {
      const b = Buffer.alloc(16)
      fs.readSync(fd, b, 0, 16, 0)
      const headerSize = b.readUInt32LE(4)
      const jsLen = b.readUInt32LE(12)
      const json = Buffer.alloc(jsLen)
      fs.readSync(fd, json, 0, jsLen, 16)
      const header = JSON.parse(json.toString('utf8'))
      let node = header
      for (const part of innerRel.split('/')) {
        node = node && node.files && node.files[part]
        if (!node) return false
      }
      return !!(node && !node.files)
    } finally { fs.closeSync(fd) }
  } catch (e) { return false }
}

function resolveSpawnReady(binPath) {
  try { if (fs.existsSync(binPath)) return true } catch (e) { /* fall through */ }
  const m = String(binPath || '').match(/^(.*[\\/]app\.asar)[\\/](.*)$/)
  if (m) return asarContains(m[1], m[2].replace(/\\/g, '/'))
  return false
}

/* ------------------------------ 检测（全部只读） ------------------------------ */

let detectCache = { at: 0, value: null }
const DETECT_TTL_MS = 5000
let detectionJob = null
const DETECT_SCRIPT = "$o=@{};" +
  "$it=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '" + DISPLAY_NAME + "*' } | Select-Object -First 1;" +
  "if($it){$o.loc=[string]$it.InstallLocation;$o.ver=[string]$it.DisplayVersion};" +
  "$p=Get-Process -Name '" + DISPLAY_NAME + "' -ErrorAction SilentlyContinue;" +
  "if($p){$o.pids=@($p | ForEach-Object {$_.Id});$exe=$p | Where-Object {$_.Path} | Select-Object -First 1 -ExpandProperty Path;if($exe){$o.exe=[string]$exe;if(!$o.ver){$o.ver=[string](Get-Item -LiteralPath $exe).VersionInfo.FileVersion}}};" +
  // Only inspect listeners owned by the official GUI's Desktop Host child.
  // Do not scan arbitrary local ports or send credentials to unrelated servers.
  "$hosts=@(Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.CommandLine -match '[\\\\/]@deepseek-ai[\\\\/]dsh-desktop-host[\\\\/]lib[\\\\/]index\\.js' });" +
  "$hostIds=@($hosts | ForEach-Object {$_.ProcessId});" +
  "$o.hosts=@($hosts | ForEach-Object { @{pid=$_.ProcessId;commandLine=$_.CommandLine} });" +
  "$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue);" +
  "$o.endpoints=@($listeners | Where-Object { $_.OwningProcess -in $hostIds -and $_.LocalAddress -eq '127.0.0.1' } | ForEach-Object { @{port=$_.LocalPort;pid=$_.OwningProcess;address=$_.LocalAddress} });" +
  "if($listeners | Where-Object { $_.LocalPort -eq 19387 -and $_.LocalAddress -eq '127.0.0.1' }){$o.p19387=$true};" +
  "ConvertTo-Json -Compress -InputObject $o"

function desktopEndpoints(discovery) {
  const seen = new Set()
  return (Array.isArray(discovery && discovery.endpoints) ? discovery.endpoints : []).filter(item => {
    if (!item || item.address !== '127.0.0.1' || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535 ||
      !Number.isInteger(item.pid) || item.pid < 1 || seen.has(item.port)) return false
    seen.add(item.port)
    return true
  }).map(({ port, pid, address, dshHome }) => {
    const host = (Array.isArray(discovery.hosts) ? discovery.hosts : []).find(host => host.pid === pid)
    if (host) {
      const args = tokenizeCommandLine(host.commandLine)
      const entry = args.findIndex(arg => /[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]index\.js$/i.test(arg))
      const profile = entry >= 0 ? args[entry + 2] : null
      if (profile && /[\\/]profiles[\\/]desktop[\\/]?$/i.test(profile) && path.win32.isAbsolute(profile)) {
        dshHome = path.win32.dirname(path.win32.dirname(profile.replace(/[\\/]$/, '')))
      }
    }
    return { port, pid, address, ...(typeof dshHome === 'string' && path.isAbsolute(dshHome) ? { dshHome } : {}) }
  })
}

function detect(opts) {
  const now = Date.now()
  if (detectCache.value && now - detectCache.at < DETECT_TTL_MS) return detectCache.value
  return resolveDetection(runPowerShell(DETECT_SCRIPT), opts, now)
}

// UI/heartbeat callers use this path: registry/process discovery must not block
// Electron's main event loop. Share the same five-second cache and one probe.
async function detectAsync(opts) {
  if (!(opts && opts.refresh) && detectCache.value && Date.now() - detectCache.at < DETECT_TTL_MS) return detectCache.value
  if (detectionJob) return detectionJob
  detectionJob = new Promise(resolve => {
    let child, timer, text = '', done = false
    const finish = raw => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(resolveDetection(raw, opts, Date.now()))
    }
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', DETECT_SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      timer = setTimeout(() => { try { child.kill() } catch (err) {} finish(null) }, 8000)
      child.stdout.on('data', chunk => { if (text.length < 131072) text += chunk.toString('utf8') })
      child.on('error', () => finish(null))
      child.on('close', code => finish(code === 0 ? text.trim() : null))
    } catch (err) { finish(null) }
  }).then(async result => {
    // Process/registry visibility is not proof of endpoint availability.
    const port = result.endpoints[0]?.port || 19387
    const probe = await probeDesktop({ port, timeoutMs: 1500 })
    result.endpoint = probe.state !== 'offline' ? 'http://127.0.0.1:' + port : null
    result.endpointOnline = probe.state !== 'offline'
    // Retained only for older status consumers; never alias a dynamic port to 19387.
    if (port === 19387) result.port19387 = probe.state !== 'offline'
    return result
  }).finally(() => { detectionJob = null })
  return detectionJob
}

function resolveDetection(qRaw, opts, now) {
  const result = {
    installed: false,
    installPath: null,
    exePath: null,
    asarBinPath: null,
    spawnReady: false,
    version: null,
    running: false,
    runningPids: [],
    port19387: false,
    endpoints: [],
    endpoint: null,
    endpointOnline: false,
    profileExists: false,
    error: null,
  }
  try {
    let q = {}
    try { if (qRaw) q = JSON.parse(qRaw) } catch (e) { q = {} }
    let installPath = typeof q.loc === 'string' && q.loc.trim() ? q.loc.trim() : null
    if ((!installPath || !fs.existsSync(path.join(installPath, DISPLAY_NAME + '.exe'))) && typeof q.exe === 'string' && path.basename(q.exe).toLowerCase() === (DISPLAY_NAME + '.exe').toLowerCase() && fs.existsSync(q.exe)) {
      installPath = path.dirname(q.exe)
    }
    if (!installPath) {
      // 卸载表缺失时的标准安装位置兜底（不硬编码盘符）
      const fallback = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', DISPLAY_NAME)
      if (fs.existsSync(path.join(fallback, DISPLAY_NAME + '.exe'))) installPath = fallback
    }
    if (installPath) {
      result.installed = true
      result.installPath = installPath
      result.exePath = path.join(installPath, DISPLAY_NAME + '.exe')
      result.asarBinPath = path.join(installPath, 'resources', 'app.asar', 'dsh',
        'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      let exeOk = false
      try { exeOk = fs.existsSync(result.exePath) } catch (e) { exeOk = false }
      result.installed = exeOk
      // 版本：注册表 DisplayVersion 优先；缺失时读 exe FileVersion（只读）
      result.version = (typeof q.ver === 'string' && q.ver.trim()) ? q.ver.trim() : null
      // Version comes from the same probe; never spawn a second synchronous
      // PowerShell merely to paint the settings page.
      let binOk = false
      try { binOk = resolveSpawnReady(result.asarBinPath) } catch (e) { binOk = false }
      result.spawnReady = binOk
      if (!binOk && result.installed) result.error = 'asar_bin_missing（官方布局可能已升级，需适配本文件路径模式）'
    }
    result.running = Array.isArray(q.pids) && q.pids.length > 0
    result.runningPids = Array.isArray(q.pids) ? q.pids : []
    result.port19387 = q.p19387 === true
    result.endpoints = desktopEndpoints(q)
    try { result.profileExists = fs.existsSync(profilePath(resolveDshHome(opts), DEFAULT_PROFILE)) } catch (e) { result.profileExists = false }
  } catch (e) {
    result.error = String((e && e.message) || e)
  }
  detectCache = { at: now, value: result }
  return result
}

/* ------------------------------ 接入：读签名密钥 + 自签 cookie（密钥只驻内存） ------------------------------ */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 从 `$DSH_HOME/.credentials.yaml` 取 `client-connection/browser-session` 的签名密钥。
 *  刻意**不引入 YAML 依赖**（打包面风险）：该文件结构固定，用定宽块扫描取 `secret:`，
 *  并强制 base64url 解码后正好 32 字节；任何不符一律 fail-closed 返回 null。
 *  ⚠️ 返回值是密钥本身，调用方**不得**写日志／落盘／上报。 */
function readSessionSecret(dshHome) {
  try {
    const file = path.join(dshHome, CREDENTIALS_FILE)
    if (!fs.existsSync(file)) return { secret: null, reason: 'credentials_missing' }
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    const i = lines.findIndex((l) => l.trim() === AUTH_RECORD_KEY + ':')
    if (i < 0) return { secret: null, reason: 'record_absent' }
    const keyIndent = lines[i].length - lines[i].trimStart().length
    let value = null
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (!line.trim()) continue
      const indent = line.length - line.trimStart().length
      if (indent <= keyIndent) break                    // 走出这个记录块
      const m = line.match(/^\s*secret:\s*(.+?)\s*$/)
      if (m) { value = m[1].replace(/^["']|["']$/g, ''); break }
    }
    if (!value) return { secret: null, reason: 'secret_absent' }
    const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (bytes.length !== SECRET_BYTES) return { secret: null, reason: 'secret_bad_length' }
    return { secret: bytes, reason: null }
  } catch (e) {
    return { secret: null, reason: 'read_error' }
  }
}

/** 自签一枚与会话等价的 cookie（配方照抄官方 client-connection）。
 *  返回 { header, name, expiresAt }；header 形如 `dsh-auth-<hash>=v1.<body>.<sig>`。 */
function signCookie(secretBytes, authority, ttlMs) {
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + ttlMs }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64url(crypto.createHmac('sha256', secretBytes).update(body).digest())
  const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest())
  return { header: name + '=v1.' + body + '.' + sig, name, expiresAt: payload.expiresAt }
}

/** 只读探测 Desktop 的 Host：**401 就是「在线」信号**，不需要任何凭据。
 *  opts 可传 { port, timeoutMs }（也可直接传 timeoutMs 数字，向后兼容）——
 *  端口做成参数是为了**可测**：测试要能指向一个确定关闭的端口来验证 offline 分支。
 *  返回 { state: 'offline' | 'unauthorized' | 'ok' | 'http_<code>', status }。 */
function probeDesktop(opts) {
  const o = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {})
  const port = Number(o.port) > 0 ? Number(o.port) : 19387
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 3000
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    try {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: timeoutMs,
          headers: o.cookie ? { Cookie: o.cookie } : {} },
        (res) => {
          try { res.resume() } catch (e) { /* ignore */ }
          const code = res.statusCode
          finish({ state: code === 401 ? 'unauthorized' : (code >= 200 && code < 400 ? 'ok' : 'http_' + code), status: code })
        },
      )
      req.on('timeout', () => { try { req.destroy() } catch (e) { /* ignore */ } ; finish({ state: 'offline', status: null, error: 'timeout' }) })
      req.on('error', (e) => finish({ state: 'offline', status: null, error: String((e && e.code) || (e && e.message) || e) }))
      req.end()
    } catch (e) { finish({ state: 'offline', status: null, error: String((e && e.message) || e) }) }
  })
}

/** 接入正在运行的 Desktop：探测在线 → 读密钥 → 自签 cookie。
 *  返回 { ok, baseUrl, cookie, authority, expiresAt, probe, reason }。
 *  刻意**不在这里**替上层验证"协议可用"——那是 dsh-compat.compatibilityGate() 的职责，
 *  两边重复实现会立刻漂移。 */
async function attach(opts) {
  const o = opts || {}
  const out = { ok: false, reason: null, baseUrl: null, cookie: null, authority: AUTHORITY, expiresAt: null, probe: null }
  try {
    const discovery = await (o.discover || detectAsync)({ ...o, refresh: true })
    const endpoints = desktopEndpoints(discovery)
    if (!endpoints.some(endpoint => endpoint.port === 19387)) endpoints.push({ port: 19387 })
    out.reason = 'desktop_offline'
    for (const endpoint of endpoints.slice(0, 5)) {
      const { port } = endpoint
      const probe = await probeDesktop({ port, timeoutMs: o.timeoutMs })
      if (probe.state === 'offline') { if (!out.probe) out.probe = probe; continue }
      out.probe = probe
      const got = readSessionSecret(endpoint.dshHome || resolveDshHome(o))
      if (!got.secret) { out.reason = got.reason || 'secret_unavailable'; return out }
      const authority = '127.0.0.1:' + port
      const signed = signCookie(got.secret, authority, COOKIE_MAX_AGE_DAYS * 24 * 3600 * 1000)
      const authenticated = await probeDesktop({ port, timeoutMs: o.timeoutMs, cookie: signed.header })
      if (authenticated.status !== 200) { out.reason = 'authentication_failed'; continue }
      Object.assign(out, { ok: true, reason: null, cookie: signed.header, expiresAt: signed.expiresAt,
        authority, baseUrl: 'http://' + authority, probe: authenticated })
      if (o.log) o.log('official harness attach ready', JSON.stringify({ baseUrl: out.baseUrl, expiresAt: out.expiresAt, probe: out.probe }))
      break
    }
    return out
  } catch (e) {
    out.reason = 'exception'
    out.error = String((e && e.message) || e)
    return out
  }
}

/* ------------------------------ pid 记账（停止身份校验的依据） ------------------------------ */

function readPidFile(pidFile) {
  try {
    if (!pidFile || !fs.existsSync(pidFile)) return null
    const n = Number(String(fs.readFileSync(pidFile, 'utf8')).trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch (e) { return null }
}
function writePidFile(pidFile, pid) {
  try { if (pidFile) fs.writeFileSync(pidFile, String(pid || ''), 'utf8') } catch (e) { /* ignore */ }
}
function clearPidFile(pidFile) {
  try { if (pidFile && fs.existsSync(pidFile)) fs.unlinkSync(pidFile) } catch (e) { /* ignore */ }
}

function isAlivePid(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  return runPowerShell("if(Get-Process -Id " + n + " -ErrorAction SilentlyContinue){'1'}else{'0'}", 5000) === '1'
}

/** 重新认领：pid 文件缺失/失效时，3080 监听者中 cmdline 精确匹配
 *  「官方 exe + 我们的 bin.js + --profile <pet>」的进程即视为本 adapter 的实例。 */
function adoptRunning(d, opts) {
  const o = opts || {}
  if (!d || !d.exePath || !(d.port || o.port)) return null
  const port = d.port || o.port || 3080
  try {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const pids = []
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.match(new RegExp(':' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)'))
      if (m) pids.push(m[1])
    }
    if (!pids.length) return null
    const profile = o.profile || DEFAULT_PROFILE
    const q = runPowerShell(
      "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" -ErrorAction SilentlyContinue | " +
      "Where-Object { $_.CommandLine -like '*dsh\\lib\\bin.js*' -and $_.CommandLine -like '*--profile " + profile + "*' } | " +
      "Select-Object -First 1 -ExpandProperty ProcessId", 8000)
    const pid = Number(q)
    if (!Number.isFinite(pid) || pid <= 0) return null
    if (pids.indexOf(String(pid)) < 0) return null
    writePidFile(o.pidFile, pid)
    if (o.log) o.log('official harness adopted', JSON.stringify({ pid, port }))
    return pid
  } catch (e) { return null }
}

/** 只认领不拉起：gate 已可用（实例在跑）时补齐 pid 记账。 */
function track(opts) {
  const o = opts || {}
  try {
    const pid = readPidFile(o.pidFile)
    if (pid && isAlivePid(pid)) return { ok: true, skipped: 'tracked', pid }
    if (pid) clearPidFile(o.pidFile)
    const d = detect(o)
    if (!d.installed) return { ok: false, reason: 'not_installed' }
    const adopted = adoptRunning(Object.assign({}, d, { port: o.port || 3080 }), o)
    if (adopted) return { ok: true, skipped: 'adopted', pid: adopted }
    return { ok: false, reason: 'not_owned' } // 3080 上不是我们的实例（可能是用户自己的 DSH）→ 不接管
  } catch (e) {
    return { ok: false, reason: 'exception', error: String((e && e.message) || e) }
  }
}

/* ------------------------------ 启动桌宠自持实例 ------------------------------ */

function ensureStarted(opts) {
  const o = opts || {}
  try {
    const d = detect(o)
    if (!d.installed) return { ok: false, reason: 'not_installed', detect: d }
    if (!d.spawnReady) return { ok: false, reason: 'spawn_not_ready', detect: d }
    // 已在跑：pid 文件在且活着 → 幂等跳过；文件缺失 → 先按 cmdline 身份重新认领
    let existingPid = readPidFile(o.pidFile)
    if (!existingPid) {
      const adopted = adoptRunning(Object.assign({}, d, { port: o.port || 3080 }), o)
      if (adopted) return { ok: true, skipped: 'adopted', pid: adopted }
    } else if (!isAlivePid(existingPid)) {
      clearPidFile(o.pidFile)
      existingPid = null
    } else {
      return { ok: true, skipped: 'already_running', pid: existingPid }
    }
    const dshHome = resolveDshHome(o)
    const profile = o.profile || DEFAULT_PROFILE
    const profileDir = profilePath(dshHome, profile)
    let profileReady = false
    try { profileReady = fs.existsSync(profileDir) } catch (e) { profileReady = false }
    const args = ['--expose-internals', d.asarBinPath, '--profile', profile]
    if (!profileReady) args.push('--from-default-profile', TEMPLATE_PROFILE)
    args.push('--no-open', '--port', String(o.port || 3080))
    // token 语义：compat.captureToken 读取日志里第一条 `dsh web: …?token=` 行 ⇒ 起前清空旧日志
    if (o.logPath) { try { fs.writeFileSync(o.logPath, '') } catch (e) { /* ignore */ } }
    let fd = null
    if (o.logPath) {
      try { fd = fs.openSync(o.logPath, 'a') } catch (e) { fd = null }
    }
    const env = Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome })
    const child = spawn(d.exePath, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
      windowsHide: true,
      cwd: dshHome,
    })
    if (fd !== null) { try { fs.closeSync(fd) } catch (e) { /* ignore */ } }
    if (!child || !child.pid) return { ok: false, reason: 'spawn_failed', detect: d }
    try { child.unref() } catch (e) { /* ignore */ }
    try {
      child.on('error', (err) => { if (o.log) o.log('official harness child error', err && err.message) })
    } catch (e) { /* ignore */ }
    writePidFile(o.pidFile, child.pid)
    if (o.log) o.log('official harness spawned', JSON.stringify({ pid: child.pid, profile, fromDefaultProfile: !profileReady, port: o.port || 3080, exe: d.exePath }))
    return { ok: true, pid: child.pid, profile, fromDefaultProfile: !profileReady, port: o.port || 3080 }
  } catch (e) {
    if (o.log) o.log('official harness spawn threw', e && e.message)
    return { ok: false, reason: 'exception', error: String((e && e.message) || e) }
  }
}

/* ------------------------------ 停止（只认本 adapter 记账的 pid + 路径身份校验） ------------------------------ */

function stopOwned(opts) {
  const o = opts || {}
  try {
    const pid = readPidFile(o.pidFile)
    if (!pid) return { ok: false, reason: 'not_owned' }
    const d = detect(o)
    if (!d.exePath) return { ok: false, reason: 'not_owned' }
    // 身份校验：该 pid 的可执行路径必须精确等于官方 exe（防 pid 复用误杀）
    const q = runPowerShell("$x=Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\" -ErrorAction SilentlyContinue; if($x -and $x.ExecutablePath -eq '" + d.exePath.replace(/'/g, "''") + "'){'1'}else{'0'}", 6000)
    if (q !== '1') { clearPidFile(o.pidFile); return { ok: false, reason: 'identity_mismatch', pid } }
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true })
    clearPidFile(o.pidFile)
    if (o.log) o.log('official harness stopped', JSON.stringify({ pid }))
    return { ok: true, killed: 1, pid }
  } catch (e) {
    return { ok: false, reason: 'exception', error: String((e && e.message) || e) }
  }
}

/* ------------------------------ 状态汇总（全部只读） ------------------------------ */

function status(opts) {
  const o = opts || {}
  const d = detect(o)
  const pid = readPidFile(o.pidFile)
  const pidAlive = pid ? isAlivePid(pid) : false
  if (pid && !pidAlive) clearPidFile(o.pidFile)
  return Object.assign({}, d, { owned: { pid: pidAlive ? pid : null, alive: pidAlive } })
}

async function statusAsync(opts) {
  await detectAsync(opts)
  return status(opts)
}

// Explicit user button: open the official GUI (single-instance focus is owned by
// Harness itself). This never starts a CLI host or creates a legacy web shortcut.
async function openDesktop(opts) {
  const o = opts || {}
  try {
    const d = await detectAsync(o)
    if (!d.installed || !d.exePath) return { ok: false, reason: 'not_installed' }
    const error = await o.openPath(d.exePath)
    return error ? { ok: false, reason: 'open_failed' } : { ok: true }
  } catch (err) { return { ok: false, reason: 'open_failed' } }
}

module.exports = {
  detect, detectAsync, attach, probeDesktop, signCookie, readSessionSecret,
  desktopEndpoints,
  ensureStarted, stopOwned, status, statusAsync, openDesktop, track, adoptRunning,
  AUTHORITY, DEFAULT_PROFILE, TEMPLATE_PROFILE,
}
