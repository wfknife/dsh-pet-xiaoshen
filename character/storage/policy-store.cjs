'use strict'
/**
 * K1 独立遗忘/撤权账本（policy store）。
 *
 * 为什么单独一个库（§11.3）：删除决定必须**先于**任何可回滚内容生效，且不能
 * 因为主库恢复、旧备份回灌或清理中途崩溃而复活。因此：
 *   1) 先把 (sourceId, deletionEpoch, requestedAt) 提交到 policy 库，立即生效；
 *   2) 主库随后做失效、派生物清理、job 取消；
 *   3) 崩溃恢复时先加载 policy，再补清理；不等待清理完成才阻止检索。
 *
 * 两个库不宣称跨库原子：一旦 policy 提交成功，读取侧必须把相关来源视为不可用，
 * 即使主库清理还没跑完。
 */

const fs = require('node:fs')
const path = require('node:path')
const { openDatabase } = require('./driver.cjs')
const { hash } = require('../ids.cjs')

const POLICY_SCHEMA = `
CREATE TABLE IF NOT EXISTS policy_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deletions (
  source_id TEXT PRIMARY KEY,
  deletion_epoch INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  cleaned_at INTEGER
);
CREATE INDEX IF NOT EXISTS deletions_epoch ON deletions (deletion_epoch);
CREATE TABLE IF NOT EXISTS permission_revocations (
  revocation_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revocations_scope ON permission_revocations (scope);
CREATE TABLE IF NOT EXISTS cleanup_progress (
  source_id TEXT PRIMARY KEY,
  deletion_epoch INTEGER NOT NULL,
  completed_at INTEGER,
  detail_json TEXT
);
`

/**
 * @param {{file: string, now?: Function, readonly?: boolean, preferredDriver?: string}} options
 */
function createPolicyStore (options) {
  const file = options && options.file
  if (typeof file !== 'string' || !file) throw new Error('policy_store: file required')
  const clock = typeof options.now === 'function' ? options.now : Date.now
  let db = null
  let cache = { epoch: 0, deleted: new Set(), revocations: [] }
  let cacheStamp = -1

  const api = {
    file,
    get driver () { return db ? db.driver : null },
    open () {
      if (db) return { ok: true, reused: true }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      db = openDatabase({ file, readonly: !!options.readonly, preferred: options.preferredDriver })
      db.exec(POLICY_SCHEMA)
      db.run("INSERT INTO policy_meta (key, value) VALUES ('policy_schema', '1') ON CONFLICT(key) DO NOTHING", [])
      return { ok: true }
    },

    _ensure () {
      if (!db) throw new Error('policy_store_not_open')
    },

    _reload () {
      api._ensure()
      const epochRow = db.get("SELECT value FROM policy_meta WHERE key = 'deletion_epoch'")
      const epoch = epochRow ? Number(epochRow.value) || 0 : 0
      if (epoch === cacheStamp) return cache
      const deleted = new Set(db.all('SELECT source_id FROM deletions').map(row => row.source_id))
      const revocations = db.all('SELECT * FROM permission_revocations ORDER BY revoked_at ASC').map(row => ({
        revocationId: row.revocation_id, scope: row.scope, revokedAt: row.revoked_at, reason: row.reason,
      }))
      cache = { epoch, deleted, revocations }
      cacheStamp = epoch
      return cache
    },

    /** 当前删除世代。恢复较旧备份时用它与备份内记录的 epoch 做并集判断。 */
    epoch () {
      const state = api._reload()
      api._ensure()
      const value = db.get("SELECT value FROM policy_meta WHERE key = 'deletion_epoch'")
      return value ? Number(value.value) || 0 : state.epoch
    },

    isDeleted (sourceId) {
      if (!sourceId) return false
      return api._reload().deleted.has(sourceId)
    },

    deletedSet () {
      return new Set(api._reload().deleted)
    },

    /**
     * 提交删除决定（立即生效）。返回新的 deletionEpoch。
     * 空输入不推进 epoch，避免用无意义世代号掩盖真实变更。
     */
    recordDeletion (sourceIds, reason) {
      api._ensure()
      const ids = Array.from(new Set((sourceIds || []).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 240)))
      if (!ids.length) return { ok: true, epoch: api.epoch(), added: 0 }
      const at = clock()
      db.exec('BEGIN IMMEDIATE')
      try {
        const current = Number((db.get("SELECT value FROM policy_meta WHERE key = 'deletion_epoch'") || {}).value) || 0
        const next = current + 1
        let added = 0
        for (const sourceId of ids) {
          const result = db.run(
            'INSERT INTO deletions (source_id, deletion_epoch, requested_at, reason, cleaned_at) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(source_id) DO NOTHING',
            [sourceId, next, at, String(reason || 'user_request').slice(0, 200)],
          )
          if (result && (result.changes === undefined || result.changes > 0)) added++
        }
        db.run("INSERT INTO policy_meta (key, value) VALUES ('deletion_epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(next)])
        db.exec('COMMIT')
        cacheStamp = -1
        return { ok: true, epoch: next, added }
      } catch (error) {
        try { db.exec('ROLLBACK') } catch (_) {}
        throw error
      }
    },

    recordPermissionRevocation (scope, reason) {
      api._ensure()
      const id = 'rev:' + hash(String(scope) + ':' + clock())
      db.run('INSERT INTO permission_revocations (revocation_id, scope, revoked_at, reason) VALUES (?, ?, ?, ?)',
        [id, String(scope).slice(0, 240), clock(), String(reason || 'user_request').slice(0, 200)])
      cacheStamp = -1
      return { ok: true, revocationId: id }
    },

    isScopeRevoked (scope) {
      return api._reload().revocations.some(row => row.scope === scope)
    },

    revocations () {
      return api._reload().revocations.slice()
    },

    /** 清理进度：崩溃后凭它补做未完成的清理，而不是重新判定“是否忘记”。 */
    markCleaned (sourceIds) {
      api._ensure()
      const at = clock()
      for (const sourceId of sourceIds || []) {
        const row = db.get('SELECT deletion_epoch FROM deletions WHERE source_id = ?', [sourceId])
        if (!row) continue
        db.run(
          `INSERT INTO cleanup_progress (source_id, deletion_epoch, completed_at, detail_json) VALUES (?, ?, ?, NULL)
           ON CONFLICT(source_id) DO UPDATE SET completed_at = excluded.completed_at, deletion_epoch = excluded.deletion_epoch`,
          [sourceId, row.deletion_epoch, at],
        )
        db.run('UPDATE deletions SET cleaned_at = ? WHERE source_id = ? AND cleaned_at IS NULL', [at, sourceId])
      }
    },

    pendingCleanup () {
      api._ensure()
      return db.all('SELECT source_id, deletion_epoch FROM deletions WHERE cleaned_at IS NULL').map(row => ({
        sourceId: row.source_id, deletionEpoch: row.deletion_epoch,
      }))
    },

    listDeletions (limit = 500) {
      api._ensure()
      return db.all('SELECT * FROM deletions ORDER BY deletion_epoch DESC LIMIT ?', [Math.min(Number(limit) || 500, 2000)]).map(row => ({
        sourceId: row.source_id, deletionEpoch: row.deletion_epoch, requestedAt: row.requested_at,
        reason: row.reason, cleanedAt: row.cleaned_at,
      }))
    },

    /**
     * 恢复协议：本地 policy 与备份 sidecar 的删除集取并集（§11.3 第 5 条）。
     * 备份更旧时不会因为“本地没记过”而复活内容。
     */
    mergeDeletionSet (sourceIds, reason) {
      const incoming = (sourceIds || []).filter(Boolean)
      if (!incoming.length) return { ok: true, epoch: api.epoch(), added: 0 }
      return api.recordDeletion(incoming, reason || 'restore_union')
    },

    /** 导出包必须携带 policy epoch，导入方据此判断“是否知道后来的删除”。 */
    exportSidecar () {
      api._ensure()
      return {
        policyEpoch: api.epoch(),
        deletions: db.all('SELECT * FROM deletions ORDER BY deletion_epoch, source_id').map(row => ({
          sourceId: row.source_id, deletionEpoch: row.deletion_epoch, requestedAt: row.requested_at,
          reason: row.reason, cleanedAt: row.cleaned_at,
        })),
        revocations: api.revocations(),
        exportedAt: clock(),
      }
    },

    health () {
      try {
        api._ensure()
        return {
          ok: true,
          epoch: api.epoch(),
          deletionCount: db.get('SELECT COUNT(*) AS c FROM deletions').c,
          pendingCleanup: db.get('SELECT COUNT(*) AS c FROM deletions WHERE cleaned_at IS NULL').c,
          revocationCount: db.get('SELECT COUNT(*) AS c FROM permission_revocations').c,
        }
      } catch (error) { return { ok: false, reason: error.message } }
    },

    close () {
      if (db) { try { db.close() } catch (_) {} }
      db = null
      cache = { epoch: 0, deleted: new Set(), revocations: [] }
      cacheStamp = -1
    },
  }
  return api
}

module.exports = { createPolicyStore, POLICY_SCHEMA }
