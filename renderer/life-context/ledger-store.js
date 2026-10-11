/* LifeLedgerStore — F3 的**存储适配器**（本模块是账本链上唯一允许 I/O 的地方）
 *
 * 硬边界（第二期施工单 §1 / §5-W5）：
 *   - 账本核心 `ledger.js` 零 I/O；存储由本模块注入
 *   - **路径守卫**：只允许写"显式传入的 recovery 测试根"（默认 `E:\dsh\recovery\_life-context`）；
 *     命中 `%APPDATA%\deskpet-xiaoshen`、`pet-state.json`、`pet-prefs.json`、Memory、日记、相册 ⇒ **一律拒绝**
 *   - 第二期**只用于测试**；正式生产落点后置到 F4（换 adapter，不重写账本）
 *   - 写盘后**回读断言**（字节数一致）——"写完没写回"这类事故必须当场炸
 *
 * 仅 Node 侧使用（UMD 仅为风格一致；渲染层不需要加载它）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeLedgerStore = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const fs = require('fs')
  const path = require('path')

  const DEFAULT_ALLOWED_ROOT = 'E:\\dsh\\recovery\\_life-context'
  const FORBIDDEN_MARKERS = [
    'deskpet-xiaoshen', 'appdata', 'pet-state', 'pet-prefs', 'pet.log',
    'programs\\deskpet', '\\.dsh\\', '\\memory\\', '\\memory.db', '\\diary', '\\photos', '\\sessions', '\\storages'
  ]

  function normalize(p) {
    return path.resolve(String(p || '')).replace(/\//g, '\\').toLowerCase()
  }

  function guardPath(filePath, opts) {
    const reasons = []
    const o = opts || {}
    if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, reasons: ['empty_path'] }
    const resolved = path.resolve(filePath)
    const norm = normalize(resolved)
    const root = path.resolve(o.allowedRoot || DEFAULT_ALLOWED_ROOT)
    const normRoot = normalize(root)
    FORBIDDEN_MARKERS.forEach((m) => { if (norm.indexOf(m) >= 0) reasons.push('forbidden_marker:' + m) })
    if (!(norm === normRoot || norm.indexOf(normRoot + '\\') === 0)) reasons.push('outside_allowed_root')
    if (!/\.json$/.test(norm)) reasons.push('must_be_json')
    try { if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) reasons.push('is_directory') } catch (err) { /* ignore */ }
    return { ok: reasons.length === 0, resolved, root, reasons }
  }

  /* ---------- F5-B：生产模式守卫（安全功能；**不删旧禁令词**，只作精确放行） ---------- */

  const PRODUCTION_FILE_NAME = 'life-context.json'
  const PRODUCTION_FORBIDDEN_SIBLINGS = [
    'pet-state.json', 'pet-state.backup.json', 'pet-prefs.json', 'memories.json', 'memory.db',
    'daily-timeline.json', 'diary-settings.json', 'character-chat-history.json', 'persona.json',
    'remote.json', 'update-state.json', 'win-state.json'
  ]

  /* 生产守卫：**精确文件名白名单**（只放行 life-context.json）+ 目录必须 == 注入的 dataDir
     + 兄弟文件一律拒绝（即便名字被改）。test 模式继续走 guardPath（旧禁令词原样保留）。 */
  function guardProductionPath(filePath, opts) {
    const reasons = []
    const o = opts || {}
    if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, reasons: ['empty_path'] }
    const resolved = path.resolve(filePath)
    const dataDir = o.dataDir ? path.resolve(o.dataDir) : null
    const base = path.basename(resolved)
    const lower = base.toLowerCase()
    if (!dataDir) reasons.push('missing_data_dir')
    else if (path.dirname(resolved) !== dataDir) reasons.push('outside_data_dir')
    if (lower !== PRODUCTION_FILE_NAME) reasons.push('not_allowlisted_file:' + base)
    PRODUCTION_FORBIDDEN_SIBLINGS.forEach((s) => { if (lower === s) reasons.push('forbidden_sibling:' + s) })
    if (!/\.json$/.test(lower)) reasons.push('must_be_json')
    try { if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) reasons.push('is_directory') } catch (err) { /* ignore */ }
    return { ok: reasons.length === 0, resolved, dataDir, reasons }
  }

  function createFileStore(input) {
    const i = input || {}
    const filePath = i.filePath
    const mode = i.mode === 'production' ? 'production' : 'test'
    const allowedRoot = i.allowedRoot || DEFAULT_ALLOWED_ROOT
    const dataDir = i.dataDir ? path.resolve(i.dataDir) : null
    const guard = mode === 'production'
      ? (p) => guardProductionPath(p, { dataDir: dataDir })
      : (p) => guardPath(p, { allowedRoot: allowedRoot })
    const g = guard(filePath)
    if (!g.ok) throw new Error('ledger-store refused (' + mode + '): ' + g.reasons.join(','))
    const resolved = g.resolved

    function describe() {
      return mode === 'production'
        ? { filePath: resolved, dataDir: dataDir, mode: 'production' }
        : { filePath: resolved, allowedRoot: path.resolve(allowedRoot), mode: 'recovery-test-only' }
    }

    function load() {
      const g2 = guard(resolved)
      if (!g2.ok) throw new Error('ledger-store refused on load: ' + g2.reasons.join(','))
      if (!fs.existsSync(resolved)) return { ok: true, existed: false, state: null }
      const txt = fs.readFileSync(resolved, 'utf8')
      const j = JSON.parse(txt)
      if (!j || typeof j !== 'object') throw new Error('ledger-store load: not an object')
      if (!Array.isArray(j.entries)) throw new Error('ledger-store load: missing entries[]')
      if (!Array.isArray(j.auditLog)) j.auditLog = []
      return { ok: true, existed: true, state: j, bytes: Buffer.byteLength(txt, 'utf8') }
    }

    function save(state) {
      const g2 = guard(resolved)
      if (!g2.ok) throw new Error('ledger-store refused on save: ' + g2.reasons.join(','))
      const txt = JSON.stringify(state, null, 1)
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
      const tmp = resolved + '.tmp'
      fs.writeFileSync(tmp, txt, 'utf8')
      fs.renameSync(tmp, resolved)
      const back = fs.readFileSync(resolved, 'utf8')
      if (back.length !== txt.length) throw new Error('ledger-store save readback mismatch: ' + back.length + ' != ' + txt.length)
      return { ok: true, filePath: resolved, bytes: Buffer.byteLength(back, 'utf8') }
    }

    return { describe, load, save, guardPath: guard }
  }

  return { DEFAULT_ALLOWED_ROOT, FORBIDDEN_MARKERS, PRODUCTION_FILE_NAME, PRODUCTION_FORBIDDEN_SIBLINGS, guardPath, guardProductionPath, createFileStore }
})
