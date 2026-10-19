'use strict'
/*
 * DeskPet Test UserData Isolation — P1-A.1
 *
 * 目的：让 **isolated test build** 能把 userData 精确定向到临时测试目录，
 * 同时保证 **production / clean 构建的 userData 解析行为与 6d8a963 完全一致**（零外部输入）。
 *
 * 铁律：
 *   1) 生产 / 纯净分支**绝不读取** DSHPET_TEST_USER_DATA、--user-data-dir、test marker 配置；
 *   2) 只有 `resources/test-edition.json` 存在且 `edition === 'test'` 时，才允许 env/CLI 参与解析；
 *   3) 测试目录必须通过 G1–G4 守卫 + **canonical(realpath) 守卫**，任一失败 ⇒ fail-fast（绝不回落到生产目录）；
 *   4) 清理同样必须重新 canonicalize 并重新过守卫，否则只报告不删除。
 *
 * 本模块纯逻辑（fs/path 全部可注入），零网络、零进程动作、零状态写入（除显式 createDir）。
 */
const os = require('os')
const pathDefault = require('path')
const fsDefault = require('fs')

const TEST_MARKER = 'test-edition.json'
const CLEAN_MARKER = 'clean-edition.json'
const TEST_MARKER_EDITION = 'test'
const DEFAULT_TEST_TEMPLATE = '%TEMP%\\deskpet-test-edition'
const RUN_ID_RE = /^deskpet-test-[A-Za-z0-9._-]{2,}$/

const PROD_DIR_NAME = 'deskpet-xiaoshen'
const CLEAN_DIR_NAME = 'deskpet-clean'

/* ---------------------------------------------------------------------------
 * 基础工具
 * ------------------------------------------------------------------------- */

function toPathFn(ctx) { return (ctx && ctx.path) || pathDefault }
function toFsFn(ctx) { return (ctx && ctx.fs) || fsDefault }

/* 可靠的 containment 判断（不用裸 startsWith；Windows 大小写不敏感） */
function isInsideOrEqual(parent, child, p) {
  const P = p || pathDefault
  if (typeof parent !== 'string' || typeof child !== 'string' || !parent || !child) return false
  const rel = P.relative(P.resolve(parent), P.resolve(child))
  if (rel === '') return true
  if (P.isAbsolute(rel)) return false
  const parts = rel.split(/[\\/]+/)
  const isWin = P.sep === '\\'
  for (const seg of parts) {
    const s = isWin ? seg.toLowerCase() : seg
    const dotdot = isWin ? '..' : '..'
    if (s === dotdot) return false
  }
  return true
}

function samePath(a, b, p) {
  const P = p || pathDefault
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ra = P.resolve(a)
  const rb = P.resolve(b)
  return P.sep === '\\' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
}

/* 展开 %TEMP% / %APPDATA% / %USERPROFILE%（大小写不敏感） */
function expandTemplate(tpl, env) {
  const e = env || {}
  return String(tpl || '').replace(/%([A-Za-z_]+)%/g, (m, name) => {
    const key = String(name).toUpperCase()
    if (key === 'TEMP' || key === 'TMP') return e.TEMP || e.TMP || ''
    if (key === 'APPDATA') return e.APPDATA || ''
    if (key === 'USERPROFILE') return e.USERPROFILE || e.HOME || ''
    return m
  })
}

/* 从 argv 提取 --user-data-dir（支持 = 形式与空格形式；取最后一个） */
function parseUserDataArgv(argv) {
  const list = Array.isArray(argv) ? argv : []
  let found = null
  for (let i = 0; i < list.length; i++) {
    const a = String(list[i] || '')
    if (a.startsWith('--user-data-dir=')) found = a.slice('--user-data-dir='.length)
    else if (a === '--user-data-dir' && i + 1 < list.length && !String(list[i + 1] || '').startsWith('--')) found = String(list[i + 1])
  }
  return found && found.trim() ? found.trim() : null
}

/* ---------------------------------------------------------------------------
 * G1–G4 路径守卫（作用于"将要使用的路径文本"）
 * ------------------------------------------------------------------------- */
function checkGuards(requested, ctx) {
  const P = toPathFn(ctx)
  const refusals = []
  const tmpRoot = (ctx && ctx.tmpRoot) || os.tmpdir()
  const appDataPath = (ctx && ctx.appDataPath) || ''
  const homedir = (ctx && ctx.homedir) || os.homedir()

  if (typeof requested !== 'string' || !requested.trim()) {
    refusals.push('not-a-string')
    return { ok: false, refusals, resolved: null }
  }
  const resolved = P.resolve(requested)

  /* G1 绝对路径 */
  if (!P.isAbsolute(requested)) refusals.push('G1-not-absolute')

  /* G2 必须位于 os.tmpdir() 之下 */
  if (!isInsideOrEqual(tmpRoot, resolved, P)) refusals.push('G2-outside-tmp')

  /* G3 不得等于/位于生产目录 */
  const forbidden = []
  if (appDataPath) {
    forbidden.push(P.join(appDataPath, PROD_DIR_NAME))
    forbidden.push(P.join(appDataPath, CLEAN_DIR_NAME))
  }
  if (homedir) forbidden.push(P.join(homedir, '.dsh'))
  for (const f of forbidden) {
    if (isInsideOrEqual(f, resolved, P)) refusals.push('G3-inside-forbidden:' + f)
  }

  /* G4 目录名必须含 run id */
  if (!RUN_ID_RE.test(P.basename(resolved))) refusals.push('G4-missing-run-id')

  return { ok: refusals.length === 0, refusals, resolved, forbidden }
}

/* canonical(realpath) 守卫：先建目录（可选）→ realpath → 对 canonical 路径重跑 G2/G3(+G1) */
function canonicalGuard(requested, ctx, opts) {
  const o = opts || {}
  const P = toPathFn(ctx)
  const fsx = toFsFn(ctx)
  const base = checkGuards(requested, ctx)
  if (!base.ok) return { ok: false, refusals: base.refusals.concat(['guard-before-canonical']), canonical: null, resolved: base.resolved }

  const target = base.resolved
  try {
    if (o.create) fsx.mkdirSync(target, { recursive: true })
    if (!fsx.existsSync(target)) return { ok: false, refusals: ['canonical-target-missing'], canonical: null, resolved: target }
  } catch (err) {
    return { ok: false, refusals: ['canonical-mkdir-failed:' + ((err && err.code) || 'error')], canonical: null, resolved: target }
  }
  let canonical = null
  try {
    canonical = fsx.realpathSync ? fsx.realpathSync(target) : target
  } catch (err) {
    return { ok: false, refusals: ['canonical-realpath-failed:' + ((err && err.code) || 'error')], canonical: null, resolved: target }
  }
  if (typeof canonical !== 'string' || !canonical) return { ok: false, refusals: ['canonical-empty'], canonical: null, resolved: target }
  /* 对 canonical 路径重跑守卫（防止 symlink / junction / reparse point 指向生产目录） */
  const again = checkGuards(canonical, ctx)
  if (!again.ok) {
    return { ok: false, refusals: again.refusals.concat(['guard-after-canonical']), canonical, resolved: target }
  }
  return { ok: true, refusals: [], canonical, resolved: target }
}

/* ---------------------------------------------------------------------------
 * 主编排：resolveUserData
 *   input: { isPackaged, resourcesPath, appDataPath, homedir, tmpRoot, argv, env,
 *            path, fs, createTestDir }
 *   return:{ ok, edition, dir, canonicalDir, source, refusals, marker }
 * ------------------------------------------------------------------------- */
function resolveUserData(input) {
  const i = input || {}
  const P = toPathFn(i)
  const fsx = toFsFn(i)
  const exists = typeof i.existsSync === 'function' ? i.existsSync : (p) => { try { return fsx.existsSync(p) } catch (e) { return false } }
  const readText = typeof i.readFileSync === 'function' ? i.readFileSync : (p) => fsx.readFileSync(p, 'utf8')
  const appDataPath = i.appDataPath || ''
  const tmpRoot = i.tmpRoot || os.tmpdir()
  const homedir = i.homedir || os.homedir()
  const ctx = { path: P, fs: fsx, tmpRoot, appDataPath, homedir }

  const base = { ok: true, edition: 'production', dir: null, canonicalDir: null, source: 'default', refusals: [], marker: null }

  /* 开发态：保持现状（main.js 不 setPath，DATA_DIR=__dirname/data） */
  if (!i.isPackaged) {
    if (i.env && i.env.DESKPET_CHARACTER_TRIAL_DATA) {
      const guard = canonicalGuard(i.env.DESKPET_CHARACTER_TRIAL_DATA, ctx, { create: i.createTestDir === true })
      return Object.assign({}, base, { ok: guard.ok, edition: 'test', source: 'character-trial',
        dir: guard.canonical, canonicalDir: guard.canonical, refusals: guard.refusals })
    }
    return Object.assign({}, base, { edition: 'dev', source: 'dev-dir', dir: i.devDir || null })
  }

  const resourcesPath = i.resourcesPath || ''
  const testMarkerPath = P.join(resourcesPath, TEST_MARKER)
  const cleanMarkerPath = P.join(resourcesPath, CLEAN_MARKER)
  const hasTestMarker = exists(testMarkerPath)

  if (hasTestMarker) {
    let marker = null
    try {
      marker = JSON.parse(readText(testMarkerPath))
    } catch (err) {
      return Object.assign({}, base, { ok: false, edition: 'test', source: 'test:marker', marker: null, refusals: ['test-marker-invalid-json'] })
    }
    if (!marker || marker.edition !== TEST_MARKER_EDITION) {
      return Object.assign({}, base, { ok: false, edition: 'test', source: 'test:marker', marker, refusals: ['test-marker-bad-edition'] })
    }
    /* ★ 只有到这里（marker 存在且 edition==='test'）才允许读取 env / CLI / marker 模板 */
    const fromEnv = i.env && typeof i.env.DSHPET_TEST_USER_DATA === 'string' && i.env.DSHPET_TEST_USER_DATA.trim()
      ? i.env.DSHPET_TEST_USER_DATA.trim()
      : null
    const fromCli = parseUserDataArgv(i.argv)
    const fromMarker = marker.userDataTemplate ? expandTemplate(marker.userDataTemplate, i.env || {}) : ''
    const requested = fromEnv || fromCli || fromMarker || ''
    const source = fromEnv ? 'test:env' : (fromCli ? 'test:cli' : 'test:default')
    const guard = canonicalGuard(requested, ctx, { create: i.createTestDir === true })
    if (!guard.ok) {
      return Object.assign({}, base, { ok: false, edition: 'test', dir: guard.resolved, canonicalDir: guard.canonical, source, marker, refusals: guard.refusals })
    }
    return Object.assign({}, base, {
      ok: true,
      edition: 'test',
      dir: guard.resolved,
      canonicalDir: guard.canonical,
      source,
      marker,
      refusals: [],
    })
  }

  /* 纯净版：现状语义，零 env/argv 读取 */
  if (exists(cleanMarkerPath)) {
    return Object.assign({}, base, {
      edition: 'clean',
      dir: P.join(appDataPath, CLEAN_DIR_NAME),
      canonicalDir: P.join(appDataPath, CLEAN_DIR_NAME),
      source: 'clean-marker',
    })
  }

  /* 生产：现状语义，零 env/argv 读取 */
  return Object.assign({}, base, {
    edition: 'production',
    dir: P.join(appDataPath, PROD_DIR_NAME),
    canonicalDir: P.join(appDataPath, PROD_DIR_NAME),
    source: 'default',
  })
}

/* ---------------------------------------------------------------------------
 * 清理守卫：只允许删除 tempRoot 下的测试目录；canonical 重新校验；失败只报告
 * ------------------------------------------------------------------------- */
function assertSafeCleanupTarget(target, ctx) {
  const guard = canonicalGuard(target, ctx, { create: false })
  if (!guard.ok) return { ok: false, canonical: guard.canonical, refusals: guard.refusals }
  /* 额外：canonical 必须是"普通目录"且不是驱动器根 */
  const P = toPathFn(ctx)
  if (samePath(guard.canonical, P.parse(guard.canonical).root, P)) {
    return { ok: false, canonical: guard.canonical, refusals: ['cleanup-is-drive-root'] }
  }
  if (!RUN_ID_RE.test(P.basename(guard.canonical))) {
    return { ok: false, canonical: guard.canonical, refusals: ['cleanup-missing-run-id'] }
  }
  return { ok: true, canonical: guard.canonical, refusals: [] }
}

/* ---------------------------------------------------------------------------
 * 构建标记自检：test 构建必须有 test marker；production/clean 绝不能有
 * ------------------------------------------------------------------------- */
function checkEditionMarkers(kind, resourcesDir, io) {
  const P = (io && io.path) || pathDefault
  const fsx = (io && io.fs) || fsDefault
  const errors = []
  const hasTest = fsx.existsSync(P.join(resourcesDir, TEST_MARKER))
  const hasClean = fsx.existsSync(P.join(resourcesDir, CLEAN_MARKER))
  if (kind === 'test') {
    if (!hasTest) errors.push('test-edition.json missing')
    else {
      try {
        const m = JSON.parse(fsx.readFileSync(P.join(resourcesDir, TEST_MARKER), 'utf8'))
        if (!m || m.edition !== TEST_MARKER_EDITION) errors.push('test-edition.json bad edition')
      } catch (err) { errors.push('test-edition.json invalid json') }
    }
  } else if (kind === 'production') {
    if (hasTest) errors.push('production build must NOT contain test-edition.json')
    if (hasClean) errors.push('production build must NOT contain clean-edition.json')
  } else if (kind === 'clean') {
    if (hasTest) errors.push('clean build must NOT contain test-edition.json')
    if (!hasClean) errors.push('clean build must contain clean-edition.json')
  } else {
    errors.push('unknown edition kind: ' + kind)
  }
  return { ok: errors.length === 0, errors }
}

module.exports = {
  TEST_MARKER,
  CLEAN_MARKER,
  TEST_MARKER_EDITION,
  DEFAULT_TEST_TEMPLATE,
  PROD_DIR_NAME,
  CLEAN_DIR_NAME,
  isInsideOrEqual,
  samePath,
  expandTemplate,
  parseUserDataArgv,
  checkGuards,
  canonicalGuard,
  resolveUserData,
  assertSafeCleanupTarget,
  checkEditionMarkers,
}
