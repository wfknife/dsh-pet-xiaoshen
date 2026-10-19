'use strict'
// Restore builds a fresh directory with the union of local and backup policy.
// It never switches the live pointer. Artifacts share the export integrity boundary.
const fs = require('node:fs')
const path = require('node:path')
const { hash } = require('../ids.cjs')
const { createExporter } = require('./export.cjs')
const { createPolicyStore } = require('./policy-store.cjs')
const { containedPath, inspectBundle } = require('./bundle.cjs')
const BACKUP_FORMAT = 1, DAILY_KEEP = 7, WEEKLY_KEEP = 4

function createBackupManager (deps) {
  const { paths, policyStore } = deps
  const clock = deps.now || Date.now, exporter = createExporter(deps)
  function listBackups () {
    if (!fs.existsSync(paths.backups)) return []
    return fs.readdirSync(paths.backups, { withFileTypes: true }).filter(e => e.isDirectory() && /^(daily|weekly)-/.test(e.name)).map(e => {
      try {
        const directory = containedPath(paths.backups, e.name), file = containedPath(directory, 'manifest.json')
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!['daily', 'weekly'].includes(manifest.kind) || manifest.name !== e.name) return null
        return { name: e.name, directory, file, manifest, at: Number(manifest.createdAt) || 0 }
      } catch (_) { return null }
    }).filter(Boolean).sort((a, b) => b.at - a.at)
  }
  function rotate () {
    const all = listBackups(), removed = []
    for (const item of [...all.filter(b => b.manifest.kind === 'daily').slice(DAILY_KEEP), ...all.filter(b => b.manifest.kind === 'weekly').slice(WEEKLY_KEEP)]) {
      // Verify the exact resolved directory before recursive deletion.
      const target = containedPath(paths.backups, item.name)
      fs.rmSync(target, { recursive: true, force: true })
      removed.push(item.name)
    }
    return { removed }
  }
  function create (options = {}) {
    const kind = options.kind === 'weekly' ? 'weekly' : 'daily', now = clock()
    fs.mkdirSync(paths.backups, { recursive: true })
    const name = kind + '-' + now + '-' + hash(String(now)).slice(0, 8)
    const result = exporter.exportPackage({ target: containedPath(paths.backups, name) })
    if (!result.ok) return result
    const manifest = { ...result.manifest, kind, name, createdAt: now }
    fs.writeFileSync(path.join(result.directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
    const verified = inspect(result.directory)
    if (!verified.ok) return { ok: false, reason: 'backup_verification_failed', inspected: verified }
    rotate()
    return { ...result, name, manifest }
  }
  function inspect (directory) {
    const result = inspectBundle(directory)
    return { ...result, policyBehindLocal: !!result.policy && result.policy.policyEpoch < policyStore.epoch() }
  }
  function restoreToNewDirectory (directory, targetDir) {
    const inspected = inspect(directory)
    if (!inspected.ok) return { ok: false, reason: 'backup_invalid', inspected }
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) return { ok: false, reason: 'target_not_empty' }
    fs.mkdirSync(targetDir, { recursive: true })
    const { files } = inspected.manifest
    for (const relative of [files.database.name, ...files.artifacts.map(a => 'artifacts/' + a.relativePath)]) {
      const target = containedPath(targetDir, relative)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(containedPath(directory, relative), target)
    }
    const local = policyStore.exportSidecar()
    const restored = createPolicyStore({ file: containedPath(targetDir, path.basename(paths.policyDb)), now: clock })
    try {
      restored.open()
      restored.mergeDeletionSet([...local.deletions, ...inspected.policy.deletions].map(d => d.sourceId), 'restore_union')
      for (const scope of new Set([...local.revocations, ...inspected.policy.revocations].map(r => r.scope))) restored.recordPermissionRevocation(scope, 'restore_union')
      // Pending tombstones replay against restored main data on first boot.
      return { ok: true, targetDir, mainDb: containedPath(targetDir, 'character.sqlite'), requiresPolicyRebuild: false,
        requiresCleanupOnOpen: restored.pendingCleanup().length > 0, deletionUnion: [...restored.deletedSet()] }
    } finally { restored.close() }
  }
  return { create, rotate, inspect, restoreToNewDirectory, listBackups, DAILY_KEEP, WEEKLY_KEEP }
}
module.exports = { createBackupManager, BACKUP_FORMAT, DAILY_KEEP, WEEKLY_KEEP }
