'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { emptyState, validState } = require('./renderer/life/pet-life.js')

function createStore(directory) {
  const file = path.join(directory, 'pet-life.json')
  let state = null, queue = Promise.resolve()
  async function load() {
    if (state) return { ok: true, state: JSON.parse(JSON.stringify(state)) }
    try {
      const raw = await fs.readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (!validState(parsed)) return { ok: false, error: 'life_invalid_state' }
      state = parsed
    } catch (err) {
      if (err.code !== 'ENOENT') return { ok: false, error: 'life_read_failed:' + String(err.code || err.message) }
      state = emptyState()
    }
    return { ok: true, state: JSON.parse(JSON.stringify(state)) }
  }
  function save(next, validateSource) {
    const job = queue.then(async () => {
      if (!validState(next)) return { ok: false, error: 'life_invalid_state' }
      const loaded = await load()
      if (!loaded.ok) return loaded
      if (next.revision !== state.revision + 1) return { ok: false, error: 'life_revision_conflict' }
      if (validateSource && !validateSource()) return { ok: false, error: 'life_source_invalid' }
      const text = JSON.stringify(next, null, 2)
      try {
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(file + '.tmp', text, 'utf8')
        await fs.rename(file + '.tmp', file)
        state = JSON.parse(text)
        return { ok: true, revision: state.revision }
      } catch (err) { return { ok: false, error: 'life_write_failed:' + String(err.code || err.message) } }
    })
    queue = job.catch(() => {})
    return job
  }
  return { load, save, flush: () => queue }
}
module.exports = { createStore }
