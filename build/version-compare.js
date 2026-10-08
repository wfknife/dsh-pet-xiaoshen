/* VersionCompare — shared version comparison + installer filename parsing.
 *
 * Single source of truth for:
 *   - compareVersions(a, b): semver-correct when both sides are valid semver,
 *     otherwise falls back to the legacy numeric comparator (never throws).
 *   - parseVersionFromName(name): extract the full version (including prerelease)
 *     from installer filenames.
 *
 * Used by:
 *   - main process (require, IPC update:check / checkForUpdatesAuto / hasInstaller)
 *   - tests (require the same file; no copied implementations)
 *
 * Never depends on electron-updater's internal node_modules path.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.VersionCompare = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  let semver = null
  try { semver = require('semver') } catch (err) { semver = null }

  /** Legacy numeric comparator. Used for invalid/legacy versions and when
   *  semver is unavailable. Tolerates null/undefined/garbage; never throws. */
  function compareVersionsLegacy(a, b) {
    const pa = String(a == null ? '' : a).split('.').map((n) => parseInt(n, 10) || 0)
    const pb = String(b == null ? '' : b).split('.').map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0)
      if (d !== 0) return d
    }
    return 0
  }

  /** semver-correct compare when both valid; legacy fallback otherwise. */
  function compareVersions(a, b) {
    if (semver && typeof semver.valid === 'function') {
      try {
        const va = semver.valid(String(a == null ? '' : a).trim())
        const vb = semver.valid(String(b == null ? '' : b).trim())
        if (va && vb) {
          if (semver.gt(va, vb)) return 1
          if (semver.lt(va, vb)) return -1
          return 0
        }
      } catch (err) { /* fall through to legacy */ }
    }
    return compareVersionsLegacy(a, b)
  }

  /** true when the version is valid semver (used by callers that need gating). */
  function isValidVersion(v) {
    if (!semver || typeof semver.valid !== 'function') return false
    try { return !!semver.valid(String(v == null ? '' : v).trim()) } catch (err) { return false }
  }

  /** prerelease identifiers or null (e.g. '2.0.0-rc.1' -> ['rc', 1]) */
  function prereleaseOf(v) {
    if (!semver || typeof semver.prerelease !== 'function') return null
    try { return semver.prerelease(String(v == null ? '' : v).trim()) } catch (err) { return null }
  }

  /**
   * Extract the full version (incl. prerelease) from an installer filename.
   * Supported shapes:
   *   deskpet-setup-1.1.28.exe            -> 1.1.28
   *   deskpet-setup-2.0.0-rc.1.exe        -> 2.0.0-rc.1
   *   deskpet-setup-clean-2.0.0-beta.3.exe-> 2.0.0-beta.3
   *   桌宠小深 Setup 1.1.17.exe            -> 1.1.17
   * Returns null when nothing matches.
   */
  function parseVersionFromName(name) {
    if (typeof name !== 'string' || !name) return null
    const m = name.match(/(?:deskpet-setup(?:-clean)?-|Setup\s+)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?\.exe$/)
    return m ? m[1] : null
  }

  return { compareVersions, compareVersionsLegacy, isValidVersion, prereleaseOf, parseVersionFromName }
})
