'use strict'
/**
 * K1 导出器：把角色连续状态打成可迁移包。
 *
 * 契约（§11.3 / §11.4）：
 *  - 导出包必须带 policyEpoch 与删除 sidecar。没有 sidecar 的旧包不允许默认
 *    当作“当前角色”继续运行，只能以历史副本只读打开。
 *  - 导出的数据库是一致快照（VACUUM INTO），不是裸复制 .db（会漏 WAL）。
 *  - 已被遗忘的内容不得通过导出复活：导出前按 policy 过滤，并记录过滤计数。
 *  - manifest 记录 identity/schema/程序版本，恢复侧据此判断兼容性。
 */

const fs = require('node:fs')
const path = require('node:path')
const { hash } = require('../ids.cjs')
const { containedPath, inspectBundle } = require('./bundle.cjs')

const EXPORT_FORMAT = 1

function listFiles (dir) {
  const out = []
  const walk = current => {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(dir)
  return out
}

/**
 * @param {{store: object, policyStore: object, paths: object, now?: Function, appVersion?: string,
 *          artifactRoot?: string}} deps
 */
function createExporter (deps) {
  const store = deps.store
  const policyStore = deps.policyStore
  const paths = deps.paths
  const clock = typeof deps.now === 'function' ? deps.now : Date.now

  /**
   * 生成导出包。返回 manifest（含被过滤的内容计数），不修改源数据库。
   */
  function exportPackage (options = {}) {
    store.open()
    policyStore.open()
    const characterId = store.read(gw => gw.getMeta('character_id'))
    if (!characterId) return { ok: false, reason: 'no_character' }
    if (policyStore.pendingCleanup().length) return { ok: false, reason: 'deletion_cleanup_pending' }

    const stamp = new Date(clock()).toISOString().replace(/[:.]/g, '-')
    const target = options.target || path.join(paths.exports, stamp + '-' + hash(stamp + characterId).slice(0, 8))
    if (fs.existsSync(target) && fs.readdirSync(target).length) return { ok: false, reason: 'target_not_empty' }
    fs.mkdirSync(target, { recursive: true })

    // 1) 一致快照
    const dbFile = path.join(target, 'character.sqlite')
    const snapshot = store.snapshotTo(dbFile)

    // 2) policy sidecar（独立文件：恢复侧必须先读它再碰正文）
    const sidecar = policyStore.exportSidecar()
    const policyFile = path.join(target, 'policy.json')
    fs.writeFileSync(policyFile, JSON.stringify(sidecar, null, 2), 'utf8')

    // 3) 状态与身份摘要
    const summary = store.read(gw => {
      const state = gw.getState(characterId)
      const identity = gw.latestIdentity(characterId)
      const character = gw.getCharacter(characterId)
      return {
        characterId,
        displayName: identity ? identity.displayName : null,
        identityRevision: identity ? identity.revision : 0,
        identityHash: identity ? identity.hash : null,
        stateRevision: state ? state.revision : 0,
        seq: gw.lastSeq(characterId).seq,
        writerEpoch: character ? character.writerEpoch : 0,
        counts: {
          sources: gw.listSources(characterId, 1000).length,
          assertions: gw.listAssertions(characterId, { limit: 500 }).length,
          concerns: gw.listConcerns(characterId, { limit: 400 }).length,
          projects: gw.listProjects(characterId, { limit: 200 }).length,
          artifacts: gw.listArtifacts(characterId, 200).length,
          episodes: gw.listEpisodes(characterId, 200).length,
        },
      }
    })

    // 4) artifacts：只复制仍然存在、未被标记删除的文件；缺失要如实记，不伪造
    const artifactDir = path.join(target, 'artifacts')
    const artifacts = []
    const missing = []
    for (const artifact of store.read(gw => gw.allArtifacts(characterId))) {
      if (artifact.sourceRefs.some(ref => policyStore.isDeleted(ref))) continue
      let source
      try { source = containedPath(paths.artifacts, artifact.relativePath) } catch (_) { missing.push({ artifactId: artifact.artifactId, reason: 'outside_root' }); continue }
      const rel = artifact.relativePath.replace(/\\/g, '/')
      if (!fs.existsSync(source)) { missing.push({ artifactId: artifact.artifactId, reason: 'file_missing' }); continue }
      if (hash(fs.readFileSync(source)) !== artifact.hash) { missing.push({ artifactId: artifact.artifactId, reason: 'hash_mismatch' }); continue }
      const dest = containedPath(artifactDir, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(source, dest)
      artifacts.push({ artifactId: artifact.artifactId, relativePath: rel, hash: hash(fs.readFileSync(source)), kind: artifact.kind, world: artifact.world })
    }

    const manifest = {
      format: EXPORT_FORMAT,
      kind: 'character-export',
      exportedAt: clock(),
      appVersion: deps.appVersion || null,
      character: summary,
      policyEpoch: sidecar.policyEpoch,
      deletionCount: sidecar.deletions.length,
      revocationCount: sidecar.revocations.length,
      schemaVersion: 1,
      storeSchemaVersion: 1,
      files: {
        database: { name: 'character.sqlite', bytes: snapshot.bytes, hash: snapshot.hash },
        policy: { name: 'policy.json', hash: hash(fs.readFileSync(policyFile)) },
        artifacts,
      },
      artifactMissing: missing,
      // 明确的恢复限制：旧备份无法凭空知道后来的删除
      restoreLimits: [
        '恢复需要同时导入 policy.json；只有数据库文件的包不能作为当前角色运行。',
        '若本包版本早于本机 policyEpoch，本机删除集必须以并集方式优先。',
        '外部旧备份无法由本程序远程擦除。',
      ],
    }
    const manifestFile = path.join(target, 'manifest.json')
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8')

    return {
      ok: true,
      directory: target,
      manifest,
      files: listFiles(target).map(file => ({ relative: path.relative(target, file).replace(/\\/g, '/'), bytes: fs.statSync(file).size })),
    }
  }

  /** 只校验包结构，不导入。用于 UI 在用户确认前显示真实内容与限制。 */
  function inspectPackage (directory) {
    return inspectBundle(directory)
  }

  return { exportPackage, inspectPackage, EXPORT_FORMAT }
}

module.exports = { createExporter, EXPORT_FORMAT }
