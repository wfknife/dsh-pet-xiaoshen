'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Worker } = require('node:worker_threads')
const { digest } = require('./platform-store.cjs')
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
function createPackages(directory, store, registry, options = {}) {
  const root = path.resolve(directory, 'trusted-packages'), live = new Map(), timeout = options.timeoutMs || 5000
  function safeName(id) { return /^[a-z][a-z0-9.-]{2,80}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id) }
  function inspect(folder) {
    const real = fs.realpathSync(folder), manifest = JSON.parse(fs.readFileSync(path.join(real, 'manifest.json'), 'utf8'))
    if (!safeName(manifest.id) || !/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.hostApi !== 1 || !Array.isArray(manifest.capabilities) || manifest.capabilities.length > 8 || !manifest.files || !manifest.files[manifest.entry]) throw Error('package_manifest')
    if ((manifest.depends || []).some(id => !store.snapshot().packages[id] || !store.snapshot().packages[id].enabled)) throw Error('package_dependency')
    if ((manifest.services || []).some(name => !['package.echo', 'desktop.observe', 'life.virtual-project'].includes(name))) throw Error('package_service_denied')
    if (Object.keys(manifest.files).length > 64) throw Error('package_file_budget')
    for (const [rel, hash] of Object.entries(manifest.files)) {
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).some(s => ['..', '', '.'].includes(s))) throw Error('package_path')
      const f = fs.realpathSync(path.join(real, rel)), sub = path.relative(real, f)
      if (sub.startsWith('..') || path.isAbsolute(sub) || fs.lstatSync(path.join(real, rel)).isSymbolicLink() || hashFile(f) !== hash) throw Error('package_integrity')
    }
    return { manifest, folder: real, hash: digest(manifest) }
  }
  async function start(pkg, data, fromVersion) {
    const worker = new Worker(path.join(__dirname, 'platform-worker.cjs'), { workerData: { entry: path.join(pkg.folder, pkg.manifest.entry), data, fromVersion, targetVersion: pkg.manifest.version, services: pkg.manifest.services || [] }, resourceLimits: { maxOldGenerationSizeMb: 32 } })
    const pending = new Map(); let sequence = 0, closed = false
    function fail(reason) { closed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error(reason)) }; pending.clear() }
    worker.on('error', e => fail('worker_error:' + e.message))
    worker.on('exit', () => fail('worker_exit'))
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void worker.terminate(); reject(Error('package_start_timeout')) }, timeout)
      worker.on('message', message => {
        if (message.type === 'service') {
          const item = pending.get(message.executionId)
          if (!item || !item.host) { worker.postMessage({ type: 'serviceResult', id: message.id, error: 'host_service_denied' }); return }
          Promise.resolve().then(() => item.host.request(message.name, message.input)).then(result => {
            if (!closed) worker.postMessage({ type: 'serviceResult', id: message.id, result })
          }, e => { if (!closed) worker.postMessage({ type: 'serviceResult', id: message.id, error: e.message }) })
        }
        if (message.type === 'ready') { clearTimeout(timer); resolve(message.data) }
        if (message.type === 'failed') { clearTimeout(timer); void worker.terminate(); reject(Error(message.reason)) }
        if (message.type === 'result') {
          const item = pending.get(message.id); if (!item) return
          pending.delete(message.id); clearTimeout(item.timer)
          if (message.error) item.reject(Error(message.error)); else item.resolve(message.result)
        }
      })
      worker.once('error', e => { clearTimeout(timer); reject(e) })
      worker.once('exit', code => { clearTimeout(timer); reject(Error('package_start_exit:' + code)) })
    })
    const migrated = await ready
    return { migrated, worker, isHealthy: () => !closed,
      drain: async () => {
        const until = Date.now() + timeout + 1000
        while (pending.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20))
        if (pending.size) throw Error('package_drain_timeout')
      },
      execute: (id, input, host) => new Promise((resolve, reject) => {
        if (closed || pending.size >= 8) { reject(Error('package_unavailable')); return }
        const key = ++sequence, timer = setTimeout(() => { pending.delete(key); reject(Error('package_timeout')); fail('package_timeout'); void worker.terminate() }, timeout)
        pending.set(key, { resolve, reject, timer, host }); worker.postMessage({ type: 'execute', id: key, capabilityId: id, input })
      }),
      stop: async () => { fail('package_stopped'); worker.postMessage({ type: 'stop' }); await worker.terminate() }
    }
  }
  function register(pkg, runner) {
    const registrations = []
    try {
      for (const c of pkg.manifest.capabilities) registrations.push(registry.register({ ...c, provider: pkg.manifest.id, version: pkg.manifest.version,
        packageHash: pkg.hash, services: (c.services || []).filter(s => (pkg.manifest.services || []).includes(s)), available: runner.isHealthy, timeoutMs: timeout, priority: c.priority || -1 }, (input, host) => runner.execute(c.id, input, host)))
      return registrations
    } catch (error) { registrations.forEach(remove => remove()); throw error }
  }
  async function drain(item) {
    if (!item) return
    item.unregister.forEach(remove => remove())
    try { await item.runner.drain() }
    catch (error) { item.unregister = register(item.pkg, item.runner); throw error }
  }
  async function install(folder, trusted) {
    if (trusted !== true) return { ok: false, reason: 'trusted_local_only' }
    let runner, unregister = []
    try {
      const inspected = inspect(folder), m = inspected.manifest, previous = store.snapshot().packages[m.id]
      if (previous?.enabled && previous.hash === inspected.hash && live.get(m.id)?.runner.isHealthy()) return { ok: true, id: m.id, version: m.version, hash: inspected.hash, reused: true }
      if (previous?.version === m.version && previous.hash !== inspected.hash) throw Error('package_version_content_conflict')
      const staged = path.join(root, m.id, inspected.hash)
      fs.mkdirSync(staged, { recursive: true })
      fs.copyFileSync(path.join(inspected.folder, 'manifest.json'), path.join(staged, 'manifest.json'))
      for (const rel of Object.keys(m.files)) { fs.mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true }); fs.copyFileSync(path.join(inspected.folder, rel), path.join(staged, rel)) }
      const pkg = inspect(staged), data = store.snapshot().namespaces[m.id] || {}
      runner = await start(pkg, structuredClone(data), previous && previous.version || null)
      // New code is healthy and namespace migration succeeded before active pointer changes.
      const old = live.get(m.id)
      await drain(old)
      try { unregister = register(pkg, runner) } catch (e) {
        if (old) old.unregister = register(old.pkg, old.runner)
        throw e
      }
      try {
        store.transaction(s => {
          s.packages[m.id] = { id: m.id, version: m.version, hash: pkg.hash, folder: path.relative(root, staged), hostApi: 1, enabled: true,
            installedAt: Date.now(), previous: previous ? { ...previous, previous: undefined } : null, dataBackup: structuredClone(data), receipt: { contentVerified: true, trustedLocal: true } }
          s.namespaces[m.id] = runner.migrated; return { ok: true }
        }, 'package_activate')
      } catch (e) { unregister.forEach(fn => fn()); if (old) old.unregister = register(old.pkg, old.runner); throw e }
      live.set(m.id, { pkg, runner, unregister }); if (old) await old.runner.stop()
      return { ok: true, id: m.id, version: m.version, hash: pkg.hash }
    } catch (e) { if (runner) await runner.stop(); return { ok: false, reason: e.message } }
  }
  async function disable(id) {
    const item = live.get(id)
    if (item) await drain(item)
    try { store.transaction(s => { if (s.packages[id]) s.packages[id].enabled = false; return { ok: true } }, 'package_disable') }
    catch (error) { if (item) item.unregister = register(item.pkg, item.runner); throw error }
    if (item) { live.delete(id); await item.runner.stop() }
    return { ok: true }
  }
  async function uninstall(id) {
    const dependents = Object.values(store.snapshot().packages).filter(p => p.enabled && p.id !== id && live.get(p.id) && (live.get(p.id).pkg.manifest.depends || []).includes(id))
    if (dependents.length) return { ok: false, reason: 'package_required' }
    await disable(id)
    store.transaction(s => { if (s.packages[id]) { s.packages[id].uninstalledAt = Date.now(); s.packages[id].status = 'uninstalled' }; return { ok: true } }, 'package_uninstall')
    // Keep immutable installed bytes, receipts and own data for explicit rollback/export.
    return { ok: true, dataRetained: true }
  }
  async function rollback(id) {
    const current = store.snapshot().packages[id]
    if (!current || !current.previous) return { ok: false, reason: 'rollback_unavailable' }
    const prior = current.previous, inspected = inspect(path.join(root, prior.folder))
    let runner
    try {
      runner = await start(inspected, structuredClone(current.dataBackup || {}), prior.version)
      const old = live.get(id); await drain(old)
      let unregister
      try { unregister = register(inspected, runner) }
      catch (error) { if (old) old.unregister = register(old.pkg, old.runner); throw error }
      try { store.transaction(s => { s.packages[id] = { ...prior, enabled: true }; s.namespaces[id] = runner.migrated; return { ok: true, externalEffectsRolledBack: false } }, 'package_rollback') }
      catch (e) { unregister.forEach(fn => fn()); if (old) old.unregister = register(old.pkg, old.runner); throw e }
      live.set(id, { pkg: inspected, runner, unregister }); if (old) await old.runner.stop()
      return { ok: true, externalEffectsRolledBack: false }
    } catch (e) { if (runner) await runner.stop(); return { ok: false, reason: e.message } }
  }
  async function restore() {
    const results = []
    for (const row of Object.values(store.snapshot().packages).filter(p => p.enabled)) {
      try {
        const pkg = inspect(path.join(root, row.folder)); if (pkg.hash !== row.hash) throw Error('installed_content_changed')
        const runner = await start(pkg, store.snapshot().namespaces[row.id] || {}, row.version)
        live.set(row.id, { pkg, runner, unregister: register(pkg, runner) }); results.push({ id: row.id, ok: true })
      } catch (e) { results.push({ id: row.id, ok: false, reason: e.message }); registry.disable(row.id) }
    }
    return results
  }
  async function shutdown() { for (const item of live.values()) { item.unregister.forEach(fn => fn()); await item.runner.stop() }; live.clear() }
  return { install, disable, uninstall, rollback, restore, shutdown, health: () => ({ active: [...live.keys()], trustedOnly: true, osSandbox: false }) }
}
module.exports = { createPackages }
