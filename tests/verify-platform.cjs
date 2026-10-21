'use strict'
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..'), record = path.resolve(root, '../research/virtual-character-20261014/implementation-p0-p8')
const checks = [
  ['runtime-and-platform', ['--test', 'tests/test-character-runtime.cjs', 'tests/test-character-runtime-chat.cjs', 'tests/test-character-runtime-integration.cjs', 'tests/test-platform.cjs']],
  ['life-continuity', ['build/test-pet-life-continuity.cjs']], ['v04-closure', ['build/test-v04-closure.cjs']],
  ['history-receipts', ['build/test-life-context-cc2-honest-receipt.cjs']], ['expression-style-boundary', ['build/test-expression-style-v01.cjs']],
  ['existing-state-recovery', ['build/test-living-state-store.cjs']]
]
const results = [], directory = path.join(record, 'verification-' + Date.now()); fs.mkdirSync(directory, { recursive: true })
for (const [name, args] of checks) {
  const started = Date.now(), result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true })
  const output = (result.stdout || '') + (result.stderr || '')
  fs.writeFileSync(path.join(directory, name + '.log'), output)
  results.push({ name, command: 'node ' + args.join(' '), exitCode: result.status, durationMs: Date.now() - started, log: path.join(directory, name + '.log') })
  console.log(name + ': ' + (result.status === 0 ? 'PASS' : 'FAIL'))
}
const syntax = ['main.js', 'preload.js', 'platform-store.cjs', 'platform-domain.cjs', 'platform-packages.cjs', 'platform-worker.cjs',
  'renderer/pet.js', 'renderer/core/character-runtime.js', 'renderer/core/capabilities.js', 'renderer/core/presentation-plan.js', 'renderer/animation/animation-player.js',
  'renderer/dialogue/context-projector.js', 'renderer/dialogue/evidence-claims.js', 'renderer/dialogue/gen2.js', 'renderer/dialogue/aigateway.js', 'renderer/life/pet-life.js', 'renderer/memory/memory-engine.js']
for (const file of syntax) { const r = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' }); if (r.status !== 0) results.push({ name: 'syntax:' + file, exitCode: r.status, error: r.stderr }) }
const whitespace = spawnSync('git', ['diff', '--check'], { cwd: root, encoding: 'utf8' }); fs.writeFileSync(path.join(directory, 'diff-check.log'), (whitespace.stdout || '') + (whitespace.stderr || ''))
results.push({ name: 'git-diff-check', command: 'git diff --check', exitCode: whitespace.status })
fs.writeFileSync(path.join(record, 'verification-results.json'), JSON.stringify({ directory, checkedAt: new Date().toISOString(), syntaxFiles: syntax.length, checks: results, passed: results.every(r => r.exitCode === 0) }, null, 2))
if (results.some(r => r.exitCode !== 0)) process.exitCode = 1
