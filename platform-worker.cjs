'use strict'
// Trusted local code only. A worker is a failure/lifecycle boundary, NOT an OS sandbox.
const { parentPort, workerData } = require('node:worker_threads')
let extension
let rpcSequence = 0, activeHost = null
const requests = new Map()
const services = Object.freeze({ request: async (name, input) => {
  if (!(workerData.services || []).includes(name)) throw Error('host_service_denied')
  if (name === 'package.echo') return input
  if (!activeHost) throw Error('host_service_requires_operation')
  const id = ++rpcSequence
  return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); parentPort.postMessage({ type: 'service', id, name, input, executionId: activeHost }) })
} })
;(async () => {
  try {
    extension = require(workerData.entry)
    const data = extension.migrate && workerData.fromVersion !== workerData.targetVersion ? await extension.migrate(structuredClone(workerData.data), workerData.fromVersion) : workerData.data
    if (JSON.stringify(data).length > 65536) throw Error('namespace_budget')
    if (extension.start) await extension.start(services)
    parentPort.postMessage({ type: 'ready', data })
  } catch (e) { parentPort.postMessage({ type: 'failed', reason: e.message }) }
})()
parentPort.on('message', async message => {
  try {
    if (message.type === 'serviceResult') { const r = requests.get(message.id); if (r) { requests.delete(message.id); if (message.error) r.reject(Error(message.error)); else r.resolve(message.result) }; return }
    if (message.type === 'stop') { if (extension && extension.stop) await extension.stop(); parentPort.postMessage({ type: 'stopped' }); return }
    if (activeHost) throw Error('package_busy')
    activeHost = message.id
    const result = await extension.execute(message.capabilityId, message.input, services)
    if (JSON.stringify(result).length > 16000) throw Error('output_budget')
    parentPort.postMessage({ type: 'result', id: message.id, result })
  } catch (e) { parentPort.postMessage({ type: 'result', id: message.id, error: e.message }) }
  finally { if (message.type === 'execute' && activeHost === message.id) activeHost = null }
})
