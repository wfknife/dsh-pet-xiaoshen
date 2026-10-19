'use strict'
// Shared export/backup boundary. Package paths and hashes are untrusted input.
const fs = require('node:fs')
const path = require('node:path')
const { hash } = require('../ids.cjs')
const { openDatabase } = require('./driver.cjs')

function containedPath (root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes(':')) throw new Error('unsafe_bundle_path')
  const base = path.resolve(root), target = path.resolve(base, relative)
  const rel = path.relative(base, target)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('unsafe_bundle_path')
  if (fs.existsSync(base)) {
    const realBase = fs.realpathSync(base)
    let ancestor = target
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
    const realRel = path.relative(realBase, fs.realpathSync(ancestor))
    if (realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) throw new Error('unsafe_bundle_symlink')
  }
  return target
}

function inspectBundle (directory) {
  let manifest, policy, db
  const checks = []
  try {
    manifest = JSON.parse(fs.readFileSync(containedPath(directory, 'manifest.json'), 'utf8'))
    if (manifest.format !== 1 || manifest.schemaVersion !== 1 || !['character-export', 'daily', 'weekly'].includes(manifest.kind)) throw new Error('unsupported_format')
    const files = manifest.files
    if (!files || files.database?.name !== 'character.sqlite' || files.policy?.name !== 'policy.json' || !Array.isArray(files.artifacts)) throw new Error('manifest_shape_invalid')
    for (const [label, relative, expected] of [
      ['database', files.database.name, files.database.hash], ['policy', files.policy.name, files.policy.hash],
      ...files.artifacts.map(a => [a.artifactId, 'artifacts/' + a.relativePath, a.hash]),
    ]) {
      const file = containedPath(directory, relative)
      checks.push({ file: label, ok: typeof expected === 'string' && fs.existsSync(file) && hash(fs.readFileSync(file)) === expected })
    }
    if (!checks.every(c => c.ok)) throw new Error('bundle_hash_mismatch')
    policy = JSON.parse(fs.readFileSync(containedPath(directory, files.policy.name), 'utf8'))
    if (!Number.isSafeInteger(policy.policyEpoch) || policy.policyEpoch < 0 || !Array.isArray(policy.deletions) || !Array.isArray(policy.revocations) ||
      policy.deletions.some(d => typeof d.sourceId !== 'string' || !d.sourceId || d.sourceId.length > 240) ||
      policy.revocations.some(r => typeof r.scope !== 'string' || !r.scope) || manifest.policyEpoch !== policy.policyEpoch) throw new Error('policy_invalid')
    db = openDatabase({ file: containedPath(directory, files.database.name), readonly: true })
    if (Object.values(db.get('PRAGMA integrity_check'))[0] !== 'ok') throw new Error('database_integrity_failed')
    const characterId = db.get("SELECT value FROM meta WHERE key = 'character_id'")?.value
    if (!characterId || characterId !== (manifest.character?.characterId || manifest.characterId)) throw new Error('character_mismatch')
    return { ok: true, usableAsCurrent: true, manifest, policy, checks }
  } catch (error) {
    return { ok: false, usableAsCurrent: false, reason: error.message, manifest, policy, checks }
  } finally { if (db) db.close() }
}
module.exports = { containedPath, inspectBundle }
