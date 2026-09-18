'use strict'
/*
 * DeskPet · DSH 生命周期与身份判定（唯一事实来源）
 *
 * 本模块是**纯逻辑**：不做任何 I/O。
 *   - netstat / CIM(进程信息) / taskkill / spawn 全部由 main.js 注入
 *   - 因此身份判定与生命周期互斥可以脱离 Electron 直接单测
 *
 * 设计目标（对应 Startup & DSH Detection 审计的必修 1/2/4/5/6/9）：
 *   · 只有一个"哪些 PID 属于本应用的 DSH"判据（替换此前的三套实现与子串启发式）
 *   · 证明不了 ⇒ unsafe，绝不 kill
 *   · 只有一个 lifecycle 互斥（startup / wizard start / restart / update 共用）
 *   · verifyActive = 身份 + 版本 + 协议（禁止只看磁盘 package.json）
 *   · renderer 只拿结构化端口状态（无 PID / 命令行 / 绝对路径）
 */

/* ---------------- 常量 ---------------- */
const LIFECYCLE_STATES = ['idle', 'starting', 'ready', 'stopping', 'restarting', 'updating']
const PORT_STATES = ['free', 'owned', 'foreign', 'starting', 'conflict']
const VERDICTS = ['exact', 'owned', 'weak', 'unsafe']
const KIND_TO_STATE = { start: 'starting', restart: 'restarting', update: 'updating', stop: 'stopping' }

/* ---------------- 路径/命令行工具 ---------------- */
function normPath(p) {
  const s = String(p === null || p === undefined ? '' : p)
  if (!s) return ''
  return s.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Windows 命令行分词（支持双引号；不处理单引号/转义，够用且可解释） */
function tokenizeCommandLine(s) {
  const out = []
  let cur = ''
  let q = false
  for (const ch of String(s === null || s === undefined ? '' : s)) {
    if (ch === '"') { q = !q; continue }
    if (!q && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
      if (cur) { out.push(cur); cur = '' }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function isInsideOrEqual(parent, child) {
  const p = normPath(parent)
  const c = normPath(child)
  if (!p || !c) return false
  return c === p || c.indexOf(p + '\\') === 0
}

/* ---------------- 身份判定（必修 2） ---------------- */
/**
 * 归一化期望身份。
 * expected = {
 *   binJs,              // 本应用实际解析出的 bin.js 绝对路径（必须提供）
 *   nodeExe,            // 本应用 bundled node.exe 绝对路径（可空）
 *   runtimeRoots[],     // 本应用 runtime 根目录（至少一个）
 *   port,               // 期望端口（默认 3080）
 *   dshHome,            // 本应用使用的 DSH_HOME（用于 self-spawn 指纹比对）
 *   requiredTokens[],   // 必须作为独立 token 出现（默认 ['web']）
 *   requireNoOpen,      // 额外要求 '--no-open' 独立 token
 *   selfSpawned,        // { [pid]: { binJs, dshHome, at } } 本应用亲手 spawn 的记录
 * }
 */
function normalizeExpected(expected) {
  const e = expected && typeof expected === 'object' ? expected : {}
  const roots = []
  if (Array.isArray(e.runtimeRoots)) for (const r of e.runtimeRoots) if (typeof r === 'string' && r) roots.push(r)
  if (typeof e.runtimeRoot === 'string' && e.runtimeRoot) roots.push(e.runtimeRoot)
  return {
    binJs: typeof e.binJs === 'string' && e.binJs ? e.binJs : null,
    nodeExe: typeof e.nodeExe === 'string' && e.nodeExe ? e.nodeExe : null,
    runtimeRoots: roots,
    port: Number(e.port) || 3080,
    dshHome: typeof e.dshHome === 'string' && e.dshHome ? e.dshHome : null,
    requiredTokens: Array.isArray(e.requiredTokens) && e.requiredTokens.length ? e.requiredTokens.map((t) => String(t).toLowerCase()) : ['web'],
    requireNoOpen: e.requireNoOpen === true,
    selfSpawned: e.selfSpawned && typeof e.selfSpawned === 'object' ? e.selfSpawned : {},
  }
}

/**
 * 单一身份判定入口（必修 2）。
 * 接受两种调用形态：isOwnedDshProcess({pid,executablePath,commandLine}, expected)
 *                isOwnedDshProcess(pid, { ...expected, procInfo: { [pid]: proc } })
 * 返回 { ok, verdict, reasons[], evidence{} }；ok=true 仅当 verdict ∈ {exact, owned}。
 */
function isOwnedDshProcess(pidOrProc, expected) {
  const e = normalizeExpected(expected)
  let proc = null
  if (pidOrProc && typeof pidOrProc === 'object') {
    proc = pidOrProc
  } else {
    const infos = expected && expected.procInfo && typeof expected.procInfo === 'object' ? expected.procInfo : {}
    proc = infos[String(pidOrProc)] || infos[pidOrProc] || null
  }
  const reasons = []
  const evidence = {
    pid: proc && proc.pid !== undefined && proc.pid !== null ? proc.pid : (typeof pidOrProc !== 'object' ? pidOrProc : null),
    exeInRuntime: false, nodeMatched: false, binJsMatched: false,
    web: false, noOpen: false, requiredTokensMissing: [],
    dshHome: 'unverifiable', selfSpawned: false,
    /* 是否"看起来是 DSH"（任何安装）：用于把"别的安装的 DSH"与"完全无关的进程"区分开 */
    looksLikeDsh: false,
  }
  if (!proc || typeof proc !== 'object') {
    return { ok: false, verdict: 'unsafe', reasons: ['no-process-info'], evidence }
  }
  const cmd = typeof proc.commandLine === 'string' ? proc.commandLine : ''
  const exe = typeof proc.executablePath === 'string' ? proc.executablePath : ''
  evidence.pid = proc.pid !== undefined && proc.pid !== null ? proc.pid : evidence.pid

  /* 空 commandLine ⇒ unsafe（必修 2 明文要求） */
  if (!cmd.trim()) return { ok: false, verdict: 'unsafe', reasons: ['empty-command-line'], evidence }
  /* 拿不到本应用 bin.js ⇒ 无参照物，绝不判定为 owned */
  if (!e.binJs) return { ok: false, verdict: 'unsafe', reasons: ['no-expected-binjs'], evidence }
  /* 期望身份本身必须落在自己的 runtime 内（防御：调用方给出错误 expected） */
  if (e.runtimeRoots.length && !e.runtimeRoots.some((r) => isInsideOrEqual(r, e.binJs))) {
    return { ok: false, verdict: 'unsafe', reasons: ['expected-binjs-outside-runtime'], evidence }
  }

  /* ① executablePath 必须来自本应用 runtime */
  const exeInRoot = e.runtimeRoots.some((r) => isInsideOrEqual(r, exe))
  const exeIsNode = e.nodeExe ? normPath(exe) === normPath(e.nodeExe) : false
  evidence.exeInRuntime = exeInRoot || exeIsNode
  if (!evidence.exeInRuntime) reasons.push('exe-not-in-app-runtime')

  const tokens = tokenizeCommandLine(cmd)
  const lowerTokens = tokens.map((t) => t.toLowerCase())

  /* ② commandLine 必须包含**精确的** bin.js 绝对路径 */
  const wantBin = normPath(e.binJs)
  evidence.binJsMatched = tokens.some((t) => normPath(t) === wantBin)
  if (!evidence.binJsMatched) reasons.push('binjs-not-matched')

  /* ③ 必须是 web 子命令 */
  evidence.web = lowerTokens.indexOf('web') >= 0
  if (!evidence.web) reasons.push('not-web-subcommand')

  /* ④ node.exe 必须一致（若调用方给了 nodeExe） */
  if (e.nodeExe) {
    const wantNode = normPath(e.nodeExe)
    evidence.nodeMatched = tokens.some((t) => normPath(t) === wantNode) || normPath(exe) === wantNode
    if (!evidence.nodeMatched) reasons.push('node-not-matched')
  } else {
    evidence.nodeMatched = evidence.exeInRuntime
  }

  /* ⑤ 额外必需 token（默认 web 已在③；--no-open 可选强制） */
  for (const t of e.requiredTokens) {
    if (t === 'web') continue
    if (lowerTokens.indexOf(t) < 0) evidence.requiredTokensMissing.push(t)
  }
  evidence.noOpen = lowerTokens.indexOf('--no-open') >= 0
  if (e.requireNoOpen && !evidence.noOpen) evidence.requiredTokensMissing.push('--no-open')
  if (evidence.requiredTokensMissing.length) reasons.push('required-token-missing')

  /* ⑥ self-spawn 指纹：本应用亲手起的 PID ⇒ 可判定 exact（并能证明 DSH_HOME 一致） */
  const rec = e.selfSpawned[String(evidence.pid)] || e.selfSpawned[evidence.pid]
  if (rec && typeof rec === 'object') {
    const recBinOk = !rec.binJs || normPath(rec.binJs) === wantBin
    const recHomeOk = !e.dshHome || !rec.dshHome || normPath(rec.dshHome) === normPath(e.dshHome)
    evidence.selfSpawned = recBinOk
    if (recBinOk && recHomeOk) evidence.dshHome = e.dshHome ? 'match' : 'recorded'
    else if (recBinOk) { evidence.dshHome = 'mismatch'; reasons.push('dsh-home-mismatch') }
  }

  /* "看起来是 DSH"：命令行里出现 @deepseek-ai/dsh/.../bin.js 且是 web 子命令 */
  evidence.looksLikeDsh = !!tokens.find((t) => /@deepseek-ai[\\/]dsh[\\/][^"']*bin\.js$/i.test(t)) && evidence.web

  /* 判定：强证据 = ①+②+③+④(一致)+ 必需 token 齐备 */
  const strong = evidence.exeInRuntime && evidence.binJsMatched && evidence.web && evidence.nodeMatched &&
    evidence.requiredTokensMissing.length === 0
  if (strong) {
    const exact = evidence.selfSpawned && (evidence.dshHome === 'match' || evidence.dshHome === 'recorded')
    /* owned 但存在提示性原因（例如 DSH_HOME 不一致）时保留原因，便于审计 */
    return { ok: true, verdict: exact ? 'exact' : 'owned', reasons: exact ? [] : reasons.slice(0, 8), evidence }
  }
  /* 弱：来自本应用 runtime 且 bin.js 对得上，但缺少我们要求的参数（不 kill，但可用于"已有实例"判定） */
  const weak = evidence.exeInRuntime && evidence.binJsMatched && evidence.web
  return { ok: false, verdict: weak ? 'weak' : 'unsafe', reasons, evidence }
}

/* ---------------- 端口占用分类（必修 1/9） ---------------- */
/**
 * classifyPortOwners(procs, expected)
 * procs = [{ pid, executablePath, commandLine }]（调用方用 netstat + CIM 填好）
 * 返回 { state, count, ownerVerified, ownedPids, weakPids, unsafePids, reasons[] }
 *   free      端口无监听
 *   owned     全部可证明属于本应用
 *   weak      存在本应用 runtime 的实例但缺少必需参数（不 kill）
 *   foreign   存在无法证明的占用者（绝不 kill）
 *   conflict  混合（既有可证明的、也有不可证明的）（绝不 kill）
 */
function classifyPortOwners(procs, expected) {
  const list = Array.isArray(procs) ? procs.filter((p) => p && typeof p === 'object') : []
  if (!list.length) {
    return { state: 'free', count: 0, ownerVerified: 'none', ownedPids: [], weakPids: [], unsafePids: [], otherDshPids: [], foreignKind: null, reasons: [] }
  }
  const ownedPids = []
  const weakPids = []
  const unsafePids = []
  const otherDshPids = []
  const reasons = []
  let exactCount = 0
  for (const p of list) {
    const r = isOwnedDshProcess(p, expected)
    const pid = p.pid !== undefined && p.pid !== null ? p.pid : null
    if (r.verdict === 'exact') { ownedPids.push(pid); exactCount++; continue }
    if (r.verdict === 'owned') { ownedPids.push(pid); continue }
    if (r.verdict === 'weak') { weakPids.push(pid); continue }
    unsafePids.push(pid)
    if (r.evidence && r.evidence.looksLikeDsh === true) otherDshPids.push(pid)
    for (const x of r.reasons) if (reasons.indexOf(x) < 0 && reasons.length < 8) reasons.push(x)
  }
  const allOwned = ownedPids.length === list.length
  const state = allOwned ? 'owned' : (unsafePids.length && ownedPids.length) ? 'conflict'
    : unsafePids.length ? 'foreign' : 'weak'
  const ownerVerified = !ownedPids.length ? 'none' : (exactCount === ownedPids.length ? 'exact' : 'strong')
  /* non-dsh 优先（更严格）：只要存在"完全无关的进程"就算非 DSH 占用 */
  const foreignKind = !unsafePids.length ? null : (unsafePids.length > otherDshPids.length ? 'non-dsh' : 'dsh-other-install')
  return { state, count: list.length, ownerVerified, ownedPids, weakPids, unsafePids, otherDshPids, foreignKind, reasons }
}

/** renderer 可见的端口状态：白名单字段，绝不含 PID / 命令行 / 路径 */
function portStateForRenderer(cls) {
  const c = cls && typeof cls === 'object' ? cls : {}
  const state = PORT_STATES.indexOf(c.state) >= 0 ? c.state : 'conflict'
  return {
    state,
    count: Number(c.count) || 0,
    ownerVerified: ['exact', 'strong', 'none'].indexOf(c.ownerVerified) >= 0 ? c.ownerVerified : 'none',
  }
}

/* ---------------- 停止决策（必修 1：证明不了就拒绝 kill） ---------------- */
/**
 * decideStop(classification) → 纯决策：
 *   free     ⇒ { action:'noop' }
 *   owned    ⇒ { action:'kill', pids }（只对可证明的 PID）
 *   weak/foreign/conflict ⇒ { action:'refuse', error }（绝不 kill）
 */
function decideStop(classification) {
  const c = classification && typeof classification === 'object' ? classification : {}
  const state = PORT_STATES.indexOf(c.state) >= 0 ? c.state : 'conflict'
  if (state === 'free') return { action: 'noop', state: state, pids: [] }
  if (state === 'owned') return { action: 'kill', state: state, pids: Array.isArray(c.ownedPids) ? c.ownedPids.filter((p) => Number(p) > 0) : [] }
  if (state === 'weak') return { action: 'refuse', state: state, error: 'not_provably_owned', pids: [] }
  return { action: 'refuse', state: state, error: 'unsafe_port_process', pids: [] }
}

/* ---------------- 自启脚本归类（必修 7） ---------------- */
/** 只有带本应用标记的启动项才允许被刷新；未知用户脚本一律不动 */
const VBS_MARK = "' deskpet-managed:"
function vbsHeader(kind) { return VBS_MARK + ' ' + String(kind || 'x') + ' autostart (regenerated by DeskPet)' + String.fromCharCode(10) }
/** UTF-16LE(BOM) 或 UTF-8 文本解码 */
function decodeVbsBuffer(buf) {
  try {
    if (!buf) return null
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8')
    if (b[0] === 0xFF && b[1] === 0xFE) return b.toString('utf16le').replace(/^\uFEFF/, '')
    return b.toString('utf8')
  } catch (e) { return null }
}
/** 是本应用生成的启动项吗（必须同时带标记与对应 kind） */
function isDeskPetVbs(text, kind) {
  const t = typeof text === 'string' ? text : ''
  if (!t || t.indexOf(VBS_MARK) < 0) return false
  /* kind 必须出现在标记行内（避免 'pet' 命中 'DeskPet' 这类子串） */
  return !kind || t.indexOf(VBS_MARK + ' ' + String(kind) + ' ') >= 0
}
/**
 * 旧版（本应用历史上写过的 `cmd /c chcp … && node … bin.js web` 形态）：
 * 只有**引用了本应用 runtime**（binJs / runtimeRoot）或 `cmd /c dsh web` 形态才认定为"我们的"，
 * 否则视为用户自己的脚本 ⇒ 不迁移、不覆盖。
 */
function isLegacyDeskPetDshVbs(text, ctx) {
  const t = typeof text === 'string' ? text : ''
  if (!t || t.indexOf('chcp') < 0) return false
  const c = ctx && typeof ctx === 'object' ? ctx : {}
  if (typeof c.binJs === 'string' && c.binJs && t.indexOf(c.binJs) >= 0) return true
  if (typeof c.runtimeRoot === 'string' && c.runtimeRoot && t.indexOf(c.runtimeRoot) >= 0) return true
  return t.indexOf('cmd /c') >= 0 && t.indexOf('dsh web') >= 0
}
/* ---------------- lifecycle 互斥（必修 4/5/10） ---------------- */
/**
 * 单一 mutex：startup / wizard start / dsh:restart / update 共用。
 * acquire 失败返回 { ok:false, error:'busy', holder }；调用方必须 try/finally release。
 */
function createDshLifecycle() {
  let holder = null
  let state = 'idle'
  return {
    state() { return state },
    holder() { return holder ? { kind: holder.kind, at: holder.at } : null },
    busy() { return holder !== null },
    status() { return { state, busy: holder !== null, holder: holder ? { kind: holder.kind, at: holder.at } : null } },
    acquire(kind, meta) {
      const k = typeof kind === 'string' && kind ? kind : 'unknown'
      if (holder) return { ok: false, error: 'busy', holder: { kind: holder.kind, at: holder.at }, state }
      holder = { kind: k, at: Date.now(), meta: meta && typeof meta === 'object' ? meta : null }
      state = KIND_TO_STATE[k] || 'starting'
      return { ok: true, kind: k, state }
    },
    release(kind) {
      if (holder && typeof kind === 'string' && kind && holder.kind !== kind) {
        return { ok: false, error: 'not_holder', holder: { kind: holder.kind, at: holder.at } }
      }
      const released = holder ? holder.kind : null
      holder = null
      state = 'idle'
      return { ok: true, released }
    },
    /** 仅用于外部观测态（ready 等），不改变持有关系 */
    report(next) {
      if (LIFECYCLE_STATES.indexOf(next) < 0) return false
      if (holder && next !== KIND_TO_STATE[holder.kind]) return false
      state = next
      return true
    },
  }
}

/* ---------------- 三重验证（必修 6） ---------------- */
/**
 * verifyTriple({ identity, runningVersion, wantVersion, protocolUsable })
 *   identity ∈ {exact, owned, strong, weak, unsafe, none}（兼容 classifier 的 ownerVerified）
 * 规则：身份必须可证明 ∧ 运行中版本可得 ∧（若给了期望版本则必须一致）∧ 协议可用
 */
function verifyTriple(input) {
  const i = input && typeof input === 'object' ? input : {}
  const reasons = []
  const identity = i.identity === 'strong' ? 'owned' : i.identity
  if (identity !== 'exact' && identity !== 'owned') reasons.push('identity-not-verified')
  const rv = typeof i.runningVersion === 'string' && i.runningVersion ? i.runningVersion : null
  if (!rv) reasons.push('running-version-unknown')
  if (rv && typeof i.wantVersion === 'string' && i.wantVersion && rv !== i.wantVersion) reasons.push('version-mismatch')
  if (i.protocolUsable !== true) reasons.push('protocol-unusable')
  return {
    ok: reasons.length === 0,
    reasons,
    identity: identity || 'none',
    runningVersion: rv,
    wantVersion: typeof i.wantVersion === 'string' ? i.wantVersion : null,
    protocolUsable: i.protocolUsable === true,
  }
}

module.exports = {
  LIFECYCLE_STATES, PORT_STATES, VERDICTS, KIND_TO_STATE,
  normPath, tokenizeCommandLine, isInsideOrEqual,
  normalizeExpected, isOwnedDshProcess, classifyPortOwners, portStateForRenderer, decideStop,
  VBS_MARK, vbsHeader, decodeVbsBuffer, isDeskPetVbs, isLegacyDeskPetDshVbs,
  createDshLifecycle, verifyTriple,
}
