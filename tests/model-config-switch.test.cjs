'use strict'
// Independent switch-matrix regression suite for the model-access compatibility fix.
// Contract: E:\dsh\_diag-deskpet\implementation\CONTRACT.md §3 (state machine).
// Real model-config.cjs, in-memory temp prefs, injected legacy key, zero network.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createModelConfig } = require('../model-config.cjs')

const SECRET = 'legacy-inherited-secret'
const KEY_A = 'own-key-A'
const KEY_C = 'own-key-C'

function manager(initial = {}, { legacyKey = () => SECRET } = {}) {
  let prefs = structuredClone(initial)
  let failWrite = false
  const writes = []
  const c = createModelConfig({
    read: () => structuredClone(prefs),
    write: patch => {
      if (failWrite) return false
      prefs = { ...prefs, ...structuredClone(patch) }
      writes.push(Object.keys(patch))
      return true
    },
    legacyKey,
  })
  return {
    c,
    prefs: () => structuredClone(prefs),
    writes: () => writes.slice(),
    failWrites: () => { failWrite = true },
  }
}
const viewProvider = (m, id) => m.c.view().providers.find(p => p.id === id)
const storedProvider = (m, id) => m.prefs().modelConfig.providers.find(p => p.id === id)
const noSecrets = (value, secrets = [SECRET, KEY_A, KEY_C]) =>
  !secrets.some(secret => JSON.stringify(value).includes(secret))

// A cloud provider as produced by the migrated legacy prefs (official DeepSeek, shared key inheritance).
function legacyCloudPrefs() {
  return { llmApi: { baseUrl: 'https://api.deepseek.com' }, unrelated: { keep: true } }
}
function explicitCloudPrefs() {
  return {
    modelConfig: {
      schemaVersion: 1,
      defaultProviderId: 'p',
      providers: [{
        id: 'p', name: 'Cloud A', protocol: 'openai', baseUrl: 'https://a.test/v1',
        apiKey: KEY_A, authMode: 'auto', model: 'model-a', credentialMode: 'own', revision: 3,
        models: ['model-a'], modelsAt: 111, discoveryError: null,
      }],
      routes: { character: { providerId: 'p', model: 'model-a', scope: 'openai https://a.test/v1' } },
      defaultModel: { providerId: 'p', model: 'model-a', scope: 'openai https://a.test/v1' },
    },
  }
}

test('cloud -> local Ollama -> cloud round trip: auth reset, key cleared, legacy inheritance retained, scoped models invalidated', () => {
  const m = manager(legacyCloudPrefs())
  // Precondition: migrated official cloud resolves through the injected legacy key.
  const before = m.c.resolve('character')
  assert.equal(before.ok, true)
  assert.equal(before.connection.apiKey, SECRET)
  assert.equal(viewProvider(m, 'legacy').keySource, 'legacy')
  assert.equal(viewProvider(m, 'legacy').keyRequired, false)

  // Switch the same connection to local Ollama (address + protocol change).
  const toOllama = m.c.saveProvider({
    id: 'legacy', name: '本机 Ollama', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434',
    authMode: 'none', model: 'qwen3.5:4b',
  })
  assert.equal(toOllama.ok, true)
  assert.equal(toOllama.scopeChanged, true)
  // The migrated legacy provider stores no own key (it inherits the shared DSH key), so there is
  // nothing to clear; keyCleared must still not claim a key was discarded.
  assert.equal(toOllama.keyCleared, false)
  assert.equal(toOllama.authModeReset, false, 'explicitly changed authMode must be kept')
  assert.equal(storedProvider(m, 'legacy').apiKey, '')
  assert.equal(storedProvider(m, 'legacy').credentialMode, 'legacy')
  assert.equal(storedProvider(m, 'legacy').authMode, 'none')
  assert.equal(m.c.setDefaultModel({ providerId: 'legacy', model: 'qwen3.5:4b' }).ok, true)
  assert.equal(m.c.setRoute('diary', { providerId: 'legacy', model: 'qwen3.5:4b' }).ok, true)
  const local = m.c.resolve('character')
  assert.equal(local.ok, true)
  assert.equal(local.model, 'qwen3.5:4b')
  assert.equal(local.connection.apiKey, '')
  assert.equal(local.connection.authMode, 'none')

  // Switch back to the official cloud by changing only protocol/address (the user-reported path).
  const back = m.c.saveProvider({ id: 'legacy', protocol: 'openai', baseUrl: 'https://api.deepseek.com' })
  assert.equal(back.ok, true)
  assert.equal(back.scopeChanged, true)
  assert.equal(back.authModeReset, true, 'authMode=auto must be restored on scope change')
  assert.equal(back.modelCleared, true)
  assert.equal(back.defaultCleared, 1, 'defaultModel scoped to the old endpoint must be invalidated')
  assert.equal(back.routesCleared, 1, 'route scoped to the old endpoint must be invalidated')
  assert.equal(storedProvider(m, 'legacy').authMode, 'auto')
  assert.equal(storedProvider(m, 'legacy').apiKey, '')
  assert.equal(storedProvider(m, 'legacy').credentialMode, 'legacy', 'legacy shared-key inheritance returns')
  assert.equal(storedProvider(m, 'legacy').model, '')
  assert.equal(m.prefs().modelConfig.defaultModel, null)
  assert.equal(m.prefs().modelConfig.routes.diary.model, null)
  assert.equal(m.prefs().modelConfig.routes.diary.scope, null)

  // No stale_model_route: the cloud resolves again through the inherited shared key.
  const after = m.c.resolve('character')
  assert.equal(after.ok, true)
  assert.notEqual(after.error, 'stale_model_route')
  assert.equal(after.connection.apiKey, SECRET)
  const view = m.c.view()
  assert.equal(view.setup.ready, true)
  assert.equal(view.providers.find(p => p.id === 'legacy').keySource, 'legacy')
  assert.equal(noSecrets(view), true, 'view must never expose keys')

  // A fresh manager (restart) over the same prefs must not resurrect the stale scope either.
  const restarted = manager(m.prefs()).c
  for (const role of ['character', 'diary', 'proactive']) assert.notEqual(restarted.resolve(role).error, 'stale_model_route')
  assert.equal(restarted.resolve('character').ok, true)

  // Same round trip with a provider that owns a stored key: the key is cleared with keyCleared:true
  // and never travels to the Ollama endpoint or back. (No explicit role route here: a role route with
  // providerId set is a deliberate custom selection and does not inherit defaultModel.)
  const ownPrefs = explicitCloudPrefs()
  ownPrefs.modelConfig.routes = {}
  const own = manager(ownPrefs)
  const ownToOllama = own.c.saveProvider({ id: 'p', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434' })
  assert.equal(ownToOllama.ok, true)
  assert.equal(ownToOllama.scopeChanged, true)
  assert.equal(ownToOllama.keyCleared, true)
  assert.equal(ownToOllama.authModeReset, true)
  assert.equal(ownToOllama.modelCleared, true)
  assert.equal(ownToOllama.defaultCleared, 1)
  assert.equal(ownToOllama.routesCleared, 0)
  assert.equal(storedProvider(own, 'p').apiKey, '')
  assert.equal(storedProvider(own, 'p').credentialMode, 'own')
  const ownLocal = own.c.resolve('character')
  assert.equal(ownLocal.ok, false)
  assert.equal(ownLocal.error, 'no-model')
  assert.equal(ownLocal.connection.apiKey, '', 'old cloud key must not be sent to the local endpoint')
  const ownBack = own.c.saveProvider({ id: 'p', protocol: 'openai', baseUrl: 'https://a.test/v1' })
  assert.equal(ownBack.ok, true)
  assert.equal(ownBack.scopeChanged, true)
  assert.equal(ownBack.authModeReset, true)
  assert.equal(storedProvider(own, 'p').apiKey, '', 'cleared key must not resurrect on the way back')
  assert.equal(own.c.setDefaultModel({ providerId: 'p', model: 'model-a' }).ok, true)
  assert.equal(own.c.resolve('character').model, 'model-a')
  assert.equal(noSecrets(own.c.view()), true)
})

test('cloud A -> cloud B: endpoint-bound key/model/default/route are cleared and reported', () => {
  const m = manager(explicitCloudPrefs())
  assert.equal(m.c.resolve('character').model, 'model-a')

  const moved = m.c.saveProvider({ id: 'p', baseUrl: 'https://b.test/v1' })
  assert.equal(moved.ok, true)
  assert.equal(moved.scopeChanged, true)
  assert.equal(moved.keyCleared, true)
  assert.equal(moved.authModeReset, true)
  assert.equal(moved.modelCleared, true)
  assert.equal(moved.defaultCleared, 1)
  assert.equal(moved.routesCleared, 1)
  const p = storedProvider(m, 'p')
  assert.equal(p.apiKey, '')
  assert.equal(p.model, '')
  assert.deepEqual(p.models, [])
  assert.equal(p.modelsAt, 0)
  assert.equal(p.discoveryError, null)
  assert.equal(viewProvider(m, 'p').hasKey, false)
  assert.equal(m.prefs().modelConfig.defaultModel, null)
  assert.equal(m.prefs().modelConfig.routes.character.model, null)
  assert.equal(m.prefs().modelConfig.routes.character.scope, null)
  const unresolved = m.c.resolve('character')
  assert.notEqual(unresolved.error, 'stale_model_route')
  assert.equal(unresolved.error, 'no-model', 'cloud B has no model yet and must not borrow cloud A model')

  // Explicit key + model supplied in the same scope-change save are kept, authMode change is explicit.
  const withKey = m.c.saveProvider({ id: 'p', baseUrl: 'https://c.test/v1', apiKey: KEY_C, authMode: 'bearer', model: 'model-c' })
  assert.equal(withKey.ok, true)
  assert.equal(withKey.keyCleared, false)
  assert.equal(withKey.authModeReset, false)
  assert.equal(withKey.modelCleared, false)
  const p2 = storedProvider(m, 'p')
  assert.equal(p2.apiKey, KEY_C)
  assert.equal(p2.authMode, 'bearer')
  assert.equal(p2.credentialMode, 'own')
  assert.equal(p2.model, 'model-c')
  const resolved = m.c.resolve('character')
  assert.equal(resolved.ok, true)
  assert.equal(resolved.model, 'model-c')
  assert.equal(resolved.connection.apiKey, KEY_C)
  assert.equal(viewProvider(m, 'p').keyRequired, true)
  assert.equal(noSecrets(m.c.view()), true)
})

test('address-only edit on the same normalised scope keeps key/model/auth; a real host change clears them', () => {
  const m = manager(explicitCloudPrefs())
  // Only a trailing slash changes; protocol + normalised baseUrl are identical => same scope.
  const cosmetic = m.c.saveProvider({ id: 'p', name: 'Cloud A (renamed)', baseUrl: 'https://a.test/v1/' })
  assert.equal(cosmetic.ok, true)
  assert.equal(cosmetic.scopeChanged, false)
  assert.equal(cosmetic.keyCleared, false)
  assert.equal(cosmetic.authModeReset, false)
  assert.equal(cosmetic.modelCleared, false)
  let p = storedProvider(m, 'p')
  assert.equal(p.apiKey, KEY_A, 'blank key means retain on an unchanged endpoint')
  assert.equal(p.model, 'model-a')
  assert.equal(p.authMode, 'auto')
  assert.equal(p.credentialMode, 'own')
  assert.equal(p.models.length, 1, 'discovery cache survives a no-op scope edit')
  assert.equal(m.c.resolve('character').model, 'model-a')

  const realEdit = m.c.saveProvider({ id: 'p', baseUrl: 'https://other.test/v1' })
  assert.equal(realEdit.scopeChanged, true)
  assert.equal(realEdit.keyCleared, true)
  assert.equal(realEdit.modelCleared, true)
  p = storedProvider(m, 'p')
  assert.equal(p.apiKey, '')
  assert.equal(p.model, '')
  assert.deepEqual(p.models, [])
})

test('authMode and key survive when deliberately changed; blank key retains; explicit clear removes', () => {
  const m = manager(legacyCloudPrefs())
  const bearer = m.c.saveProvider({ id: 'legacy', authMode: 'bearer', apiKey: 'key-x' })
  assert.equal(bearer.ok, true)
  assert.equal(bearer.scopeChanged, false)
  assert.equal(storedProvider(m, 'legacy').authMode, 'bearer')
  assert.equal(storedProvider(m, 'legacy').apiKey, 'key-x')
  assert.equal(storedProvider(m, 'legacy').credentialMode, 'own')
  assert.equal(m.c.resolve('character').connection.apiKey, 'key-x')

  const toNone = m.c.saveProvider({ id: 'legacy', authMode: 'none' })
  assert.equal(toNone.authModeReset, false)
  assert.equal(storedProvider(m, 'legacy').authMode, 'none')
  assert.equal(storedProvider(m, 'legacy').apiKey, 'key-x', 'auth-mode edit alone must not drop the key')
  assert.equal(m.c.resolve('character').connection.apiKey, 'key-x')

  const rotated = m.c.saveProvider({ id: 'legacy', apiKey: 'key-y' })
  assert.equal(rotated.ok, true)
  assert.equal(storedProvider(m, 'legacy').apiKey, 'key-y')
  assert.equal(storedProvider(m, 'legacy').authMode, 'none')

  assert.equal(m.c.saveProvider({ id: 'legacy', clearKey: true }).ok, true)
  assert.equal(storedProvider(m, 'legacy').apiKey, '')
  assert.equal(viewProvider(m, 'legacy').hasKey, false)
  assert.equal(noSecrets(m.c.view()), true)
})

test('delete provider in use reassigns default/routes instead of silently stranding them; last provider refused', () => {
  const m = manager(legacyCloudPrefs())
  assert.equal(m.c.saveProvider({ id: 'local', name: 'Local', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' }).ok, true)
  assert.equal(m.c.setDefaultModel({ providerId: 'local', model: 'qwen3.5:4b' }).ok, true)
  assert.equal(m.c.setRoute('diary', { providerId: 'local', model: 'qwen3.5:4b' }).ok, true)
  assert.equal(m.c.resolve('character').providerId, 'local')

  const removed = m.c.removeProvider('local')
  assert.equal(removed.ok, true, 'a referenced provider must be removable once dependencies are cleared')
  const view = m.c.view()
  assert.equal(view.defaultProviderId, 'legacy')
  assert.equal(view.routes.diary.providerId, null)
  assert.equal(view.routes.diary.error, null)
  assert.equal(m.prefs().modelConfig.defaultModel, null)
  assert.equal(m.c.resolve('character').providerId, 'legacy')
  assert.equal(m.c.resolve('character').ok, true)

  // Deleting the last remaining provider is refused with a distinct code.
  const last = m.c.removeProvider('legacy')
  assert.equal(last.ok, false)
  assert.equal(last.error, 'last_provider')

  // delete -> re-add is allowed and starts from a clean provider scope. The default provider was
  // reassigned to the first remaining provider on delete, so select the re-added one explicitly.
  assert.equal(m.c.saveProvider({ id: 'local', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' }).ok, true)
  assert.equal(m.c.setDefault('local').ok, true)
  assert.equal(m.c.resolve('character').model, 'qwen3.5:4b')

  // A config with a single provider also refuses the last-provider delete.
  const single = manager(legacyCloudPrefs()).c
  assert.equal(single.removeProvider('legacy').error, 'last_provider')
  assert.equal(single.view().providers.length, 1)
})

test('write -> reload persistence: switched config and routes survive a new manager instance', () => {
  const m = manager(legacyCloudPrefs())
  m.c.saveProvider({ id: 'local', name: '本机 Ollama', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' })
  m.c.setDefaultModel({ providerId: 'local', model: 'qwen3.5:4b' })
  m.c.setRoute('diary', { providerId: 'local', model: 'qwen3.5:4b' })
  m.c.saveProvider({ id: 'cloud', name: 'Cloud', protocol: 'openai', baseUrl: 'https://cloud.test/v1', apiKey: 'cloud-secret-key', authMode: 'bearer', model: 'cloud-model' })

  const n = manager(m.prefs())
  const view = n.c.view()
  assert.equal(view.ok, true)
  assert.equal(view.defaultProviderId, 'local')
  assert.equal(n.c.resolve('character').model, 'qwen3.5:4b')
  assert.equal(n.c.resolve('chat').model, 'qwen3.5:4b')
  assert.equal(n.c.resolve('diary').model, 'qwen3.5:4b')
  assert.equal(view.providers.find(p => p.id === 'cloud').hasKey, true)
  assert.equal(view.providers.find(p => p.id === 'cloud').keySource, 'settings')
  assert.equal(view.providers.find(p => p.id === 'cloud').keyRequired, true)
  assert.equal(noSecrets(view, [SECRET, 'cloud-secret-key']), true)
  assert.deepEqual(n.prefs().unrelated, { keep: true })
})

test('legacy prefs (llmApi/chatModel/modelPrefs) migrate read-only and unrelated keys survive later writes', () => {
  const m = manager({
    llmApi: { baseUrl: 'https://api.deepseek.com', apiKey: 'own-secret', model: 'chat-model', credentialMode: 'own', temps: { character: 0.5 } },
    chatModel: 'chat-model',
    modelPrefs: { diary: 'diary-model' },
    unrelated: { keep: true },
    another: 42,
  })
  const view = m.c.view()
  assert.equal(view.ok, true)
  assert.equal(view.providers.length, 1)
  const legacy = view.providers[0]
  assert.equal(legacy.id, 'legacy')
  assert.equal(legacy.protocol, 'openai')
  assert.equal(legacy.baseUrl, 'https://api.deepseek.com')
  assert.equal(legacy.hasKey, true)
  assert.equal(legacy.keySource, 'settings')
  assert.equal(legacy.authMode, 'auto')
  assert.equal(m.c.resolve('character').model, 'chat-model')
  assert.equal(m.c.resolve('diary').model, 'diary-model')
  assert.equal(m.c.resolve('proactive').model, 'chat-model')
  assert.equal(m.prefs().modelConfig, undefined, 'migration must be read-only')
  assert.equal(noSecrets(view, [SECRET, 'own-secret']), true)

  // First write persists modelConfig but must keep every unrelated legacy key.
  assert.equal(m.c.setDefaultModel({ providerId: 'legacy', model: 'deepseek-flash' }).ok, true)
  const after = m.prefs()
  assert.equal(after.modelConfig.schemaVersion, 1)
  assert.equal(after.modelConfig.providers[0].id, 'legacy')
  assert.equal(after.modelConfig.providers[0].credentialMode, 'own')
  assert.deepEqual(after.unrelated, { keep: true })
  assert.equal(after.another, 42)
  assert.equal(after.chatModel, 'chat-model')
  assert.deepEqual(after.modelPrefs, { diary: 'diary-model' })
  assert.equal(m.c.resolve('diary').model, 'diary-model')

  // Prefs without credentialMode migrate as legacy and inherit the shared key on the official host only.
  const legacyKeyOnly = manager({ llmApi: { baseUrl: 'https://api.deepseek.com' } })
  assert.equal(legacyKeyOnly.c.resolve('character').connection.apiKey, SECRET)
  assert.equal(legacyKeyOnly.prefs().modelConfig, undefined)
  const foreign = manager({ llmApi: { baseUrl: 'https://third.test/v1' } })
  assert.equal(foreign.c.resolve('character').connection.apiKey, '')
  assert.equal(foreign.c.view().providers[0].keySource, 'none')
})

test('load healing: models:null, missing authMode and stale defaultModel/route scopes never yield stale_model_route', () => {
  const initial = {
    unrelated: { keep: true },
    modelConfig: {
      schemaVersion: 1,
      defaultProviderId: 'legacy',
      providers: [{
        id: 'legacy', name: '原有连接', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
        credentialMode: 'legacy', revision: 4, models: null, modelsAt: 0, discoveryError: 'auth',
      }],
      routes: {
        character: { providerId: 'legacy', model: 'qwen3.5:4b', scope: 'ollama http://127.0.0.1:11434' },
        diary: { providerId: 'legacy', model: null, scope: null },
      },
      defaultModel: { providerId: 'legacy', model: 'qwen3.5:4b', scope: 'ollama http://127.0.0.1:11434' },
    },
  }
  const m = manager(initial)
  const view = m.c.view()
  assert.equal(view.ok, true)
  const p = view.providers.find(x => x.id === 'legacy')
  assert.equal(Array.isArray(p.models), true, 'models:null must be normalised to an array')
  assert.equal(p.models.length, 0)
  assert.equal(p.authMode, 'auto', 'missing authMode must default to auto')
  const character = m.c.resolve('character')
  assert.equal(character.ok, true)
  assert.notEqual(character.error, 'stale_model_route')
  assert.ok(character.model)
  for (const role of ['character', 'diary', 'proactive']) assert.notEqual(m.c.resolve(role).error, 'stale_model_route')
  // Healing is in-memory only: the stored file is untouched by load()/view()/resolve().
  assert.deepEqual(m.prefs(), initial)
  assert.equal(m.writes().length, 0)

  // Retry with a stale defaultModel but no route scopes at all.
  const staleDefaultOnly = manager({
    modelConfig: {
      schemaVersion: 1, defaultProviderId: 'legacy',
      providers: [{ id: 'legacy', name: 'x', protocol: 'openai', baseUrl: 'https://api.deepseek.com', credentialMode: 'legacy', revision: 1, models: [], modelsAt: 0, discoveryError: null }],
      routes: {}, defaultModel: { providerId: 'legacy', model: 'qwen3.5:4b', scope: 'ollama http://127.0.0.1:11434' },
    },
  })
  assert.equal(staleDefaultOnly.c.resolve('character').ok, true)
  assert.notEqual(staleDefaultOnly.c.resolve('character').error, 'stale_model_route')
  const healedView = staleDefaultOnly.c.view()
  assert.equal(healedView.defaultModel == null || healedView.defaultModel.scope !== 'ollama http://127.0.0.1:11434', true)

  // Discovery bookkeeping keeps working on the normalised config.
  const rev = viewProvider(m, 'legacy').revision
  assert.equal(m.c.setModels('legacy', { ok: true, models: ['m1', 'm2'] }, rev).ok, true)
  assert.deepEqual(viewProvider(m, 'legacy').models, ['m1', 'm2'])
})

test('setup readiness is derived from the character route (ok / no-model / no-key)', () => {
  // A fresh user with no shared DSH key: a cloud auto endpoint is NOT ready — it would only
  // produce auth-required at request time, so onboarding must ask for a key or local Ollama.
  const fresh = manager({}, { legacyKey: () => '' }).c.view()
  assert.equal(fresh.setup.ready, false)
  assert.equal(fresh.setup.reason, 'no-key')
  assert.equal(fresh.setup.providerId, 'legacy')
  assert.equal(fresh.providers[0].keyless, false)

  // Shared legacy key on the official host makes the same state ready.
  const inherited = manager(legacyCloudPrefs()).c.view()
  assert.equal(inherited.setup.ready, true)
  assert.equal(inherited.setup.reason, 'ok')

  const m = manager(legacyCloudPrefs(), { legacyKey: () => '' })
  assert.equal(m.c.saveProvider({ id: 'third', name: 'Third', protocol: 'openai', baseUrl: 'https://third.test/v1' }).ok, true)
  assert.equal(m.c.setDefault('third').ok, true)
  const noModel = m.c.view().setup
  assert.equal(noModel.ready, false)
  assert.equal(noModel.reason, 'no-model', 'no-model is reserved for a model that genuinely does not resolve')
  assert.equal(noModel.providerId, 'third')

  assert.equal(m.c.saveProvider({ id: 'third', authMode: 'bearer', model: 'chat-model' }).ok, true)
  const noKey = m.c.view().setup
  assert.equal(noKey.ready, false)
  assert.equal(noKey.reason, 'no-key')
  assert.equal(noKey.providerId, 'third')

  assert.equal(m.c.saveProvider({ id: 'third', apiKey: 'real-key' }).ok, true)
  const nowReady = m.c.view().setup
  assert.equal(nowReady.ready, true)
  assert.equal(nowReady.reason, 'ok')

  // A keyless native Ollama provider is ready without any key.
  const local = manager({}, { legacyKey: () => '' })
  assert.equal(local.c.saveProvider({ id: 'local', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' }).ok, true)
  assert.equal(local.c.setDefault('local').ok, true)
  const ollama = local.c.view()
  assert.equal(ollama.providers.find(p => p.id === 'local').keyless, true)
  assert.equal(ollama.providers.find(p => p.id === 'local').keySource, 'keyless')
  assert.equal(ollama.setup.ready, true)
  assert.equal(ollama.setup.reason, 'ok')
  assert.equal(local.c.resolve('character').model, 'qwen3.5:4b')
})

test('failed atomic write keeps the previous whole configuration and returns save_failed', () => {
  const m = manager(legacyCloudPrefs())
  m.c.saveProvider({ id: 'local', protocol: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' })
  const before = m.prefs()
  m.failWrites()
  const r = m.c.saveProvider({ id: 'local', baseUrl: 'https://other.test/v1' })
  assert.equal(r.ok, false)
  assert.equal(r.error, 'save_failed')
  assert.deepEqual(m.prefs(), before)
})
