'use strict'
/**
 * K1 SQLite 驱动适配。
 *
 * 为什么是适配层而不是直接 require('better-sqlite3'）：
 *  - Electron 33 / Node 20 使用 ABI 130 的 better-sqlite3；系统 Node 24
 *    使用 node:sqlite，避免 Electron binding 污染 Node 工具的 ABI。
 *  - 因此这里按候选顺序解析驱动，并把差异收敛到统一门面：
 *      exec(sql) / all(sql, params) / get(sql, params) / run(sql, params) / close()
 *  - 只使用位置参数 `?`，不使用命名参数（两种驱动的命名语法不一致）。
 *
 * 事务语义：一律显式 `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`，不依赖驱动私有
 * transaction helper，保证两个驱动行为一致，且“单写者 + 立即写锁”是显式的。
 *
 * build/prepare-native.cjs 在 postinstall / beforePack 准备目标 Electron binding；
 * 三个发行配置将该模块加入 asarUnpack，实际打包验证另有日志。
 */

// Node tools use their built-in SQLite; Electron 33 uses its ABI-specific native
// binding. Installing the Electron binding must not break ordinary Node tools.
const DRIVER_CANDIDATES = ['node:sqlite', 'better-sqlite3']

function tryRequire (name) {
  try {
    // eslint-disable-next-line global-require
    return { ok: true, mod: require(name) }
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) }
  }
}

/**
 * 探测可用驱动。返回所有候选的可用性，便于把“为什么用不了”如实写进诊断，
 * 而不是在日志里变成一个没有解释的空对象。
 */
function probeDrivers () {
  const report = []
  for (const name of DRIVER_CANDIDATES) {
    const got = tryRequire(name)
    if (!got.ok) {
      report.push({ name, available: false, reason: got.error.slice(0, 200) })
      continue
    }
    if (name === 'better-sqlite3') {
      const ctor = got.mod && (typeof got.mod === 'function' ? got.mod : got.mod.default)
      let handle
      try {
        if (typeof ctor !== 'function') throw new Error('export_not_constructor')
        handle = new ctor(':memory:')
        handle.prepare('SELECT 1').get()
        report.push({ name, available: true, reason: null })
      } catch (error) { report.push({ name, available: false, reason: String(error.message).slice(0, 200) }) }
      finally { if (handle) handle.close() }
    } else {
      const DatabaseSync = got.mod && got.mod.DatabaseSync
      report.push({ name, available: typeof DatabaseSync === 'function', reason: typeof DatabaseSync === 'function' ? null : 'DatabaseSync_missing' })
    }
  }
  return report
}

function resolveDriver (preferred) {
  const order = preferred ? [preferred, ...DRIVER_CANDIDATES.filter(n => n !== preferred)] : DRIVER_CANDIDATES
  for (const name of order) {
    const got = tryRequire(name)
    if (!got.ok) continue
    if (name === 'better-sqlite3') {
      const ctor = got.mod && (typeof got.mod === 'function' ? got.mod : got.mod.default)
      if (typeof ctor === 'function') return { name, kind: 'better-sqlite3', ctor }
    } else if (name === 'node:sqlite') {
      if (got.mod && typeof got.mod.DatabaseSync === 'function') return { name, kind: 'node:sqlite', ctor: got.mod.DatabaseSync }
    }
  }
  return null
}

/**
 * 打开数据库并返回统一门面。
 * @param {{file: string, readonly?: boolean, preferred?: string, timeoutMs?: number}} options
 */
function openDatabase (options) {
  const file = options && options.file
  if (typeof file !== 'string' || !file) throw new Error('driver: file required')
  const resolved = resolveDriver(options.preferred)
  if (!resolved) {
    const report = probeDrivers()
    const error = new Error('driver_unavailable')
    error.code = 'storage_unavailable'
    error.diagnostics = report
    throw error
  }

  let handle
  if (resolved.kind === 'better-sqlite3') {
    handle = new resolved.ctor(file, { readonly: !!options.readonly, timeout: options.timeoutMs || 5000 })
  } else {
    handle = new resolved.ctor(file, { readOnly: !!options.readonly, timeout: options.timeoutMs || 5000 })
  }

  const cache = new Map()
  function prepare (sql) {
    // better-sqlite3 的 Statement 可复用；node:sqlite 的 StatementSync 同样可复用，
    // 但两种驱动的绑定都是惰性的，缓存原始 statement 是安全的。
    let statement = cache.get(sql)
    if (!statement) {
      statement = handle.prepare(sql)
      cache.set(sql, statement)
    }
    return statement
  }

  const api = {
    driver: resolved.name,
    file,
    exec (sql) { handle.exec(sql) },
    all (sql, params = []) { return prepare(sql).all(...params) },
    get (sql, params = []) {
      const row = prepare(sql).get(...params)
      return row === undefined ? null : row
    },
    run (sql, params = []) { return prepare(sql).run(...params) },
    /** 只读 PRAGMA / 单值查询 */
    scalar (sql, params = []) {
      const row = api.get(sql, params)
      if (!row) return null
      const keys = Object.keys(row)
      return keys.length ? row[keys[0]] : null
    },
    close () {
      cache.clear()
      if (typeof handle.close === 'function') handle.close()
    },
    /**
     * 一致性快照备份：VACUUM INTO 在单个读事务内生成一致副本（包含 WAL 中
     * 已提交内容，因此不需要像裸复制那样额外搬 WAL）。目标路径用字面量，
     * 因为 VACUUM 不是普通 prepared statement，两种驱动的支持不一致。
     */
    snapshotTo (target) {
      const literal = String(target).replace(/'/g, "''")
      api.exec("VACUUM INTO '" + literal + "'")
    },
  }

  // WAL / 外键 / 持久性：单内核写入者依赖这三条（§11.1）。
  if (!options.readonly) {
    try { api.exec('PRAGMA journal_mode = WAL') } catch (_) { /* 只读介质或已存在 */ }
    api.exec('PRAGMA synchronous = FULL')
    api.exec('PRAGMA foreign_keys = ON')
    api.exec('PRAGMA busy_timeout = 5000')
  }

  return api
}

module.exports = { DRIVER_CANDIDATES, probeDrivers, resolveDriver, openDatabase }
