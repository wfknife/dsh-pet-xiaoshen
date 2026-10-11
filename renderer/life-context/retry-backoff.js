'use strict'
function createBackoff({ baseMs = 30000, maxMs = 300000 } = {}) {
  let failures = 0, nextAt = 0
  return {
    canTry: now => now >= nextAt,
    fail(now) { failures = Math.min(20, failures + 1); nextAt = now + Math.min(maxMs, baseMs * Math.pow(2, failures - 1)) },
    reset() { failures = 0; nextAt = 0 },
    snapshot: () => ({ failures, nextAt })
  }
}
module.exports = { createBackoff }
