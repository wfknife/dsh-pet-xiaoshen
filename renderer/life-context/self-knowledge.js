/* LifeSelfKnowledge — F5「自我认知」三源只读能力投影（第三期 F5-A：纯新增、零接线）
 *
 * 目标：让她**准确知道自己怎样存在**——静态身份 / 实时运行态 / 权限状态各管各的事实，
 *       并让"能力不许虚构"（N2）可执行：unavailable / requires-owner 的能力不得出现在她的话里。
 *
 * 边界（P3-life-context-boundary-final-v1-20260918.md v1.1 §F + F0F7 阶段设计 §3.6）：
 *   - 三源分离：每条能力带 source（static / runtime / permission）+ capturedAt（每轮现取、零缓存）
 *   - declared（旧 stub / 静态声明）**永不获胜**：与真值冲突时以更贴近当前实际且有明确来源者为准，
 *     并在 conflicts[] 里如实记录"谁被谁覆盖"（F5 存在的理由：capabilities 不许再用硬编码 false 当依据）
 *   - 能力 id **封闭**：CAPABILITY_IDS 之外一律不认（新增必须由用户授权）
 *   - **不新增任何真实能力探测**：本模块只"如实化"，不顺手加截图/联网/读标题
 *   - 本模块**零 I/O、零网络、零写、零 AI、零随机、零真实时钟**：输入全注入，纯函数
 *   - H3：precondition＝时机/冷却（F4 闸门）与 capability＝能力边界（本模块）**不互相替代**
 *
 * Used by:
 *   - build/test-life-context-f5-self-knowledge.cjs（离线契约 + 负控）
 *   - renderer/life-context/orchestrator.js（编排层：池能力过滤 + N2 文本过滤）
 *   - E:\dsh\tools\life-context-inspect.cjs --self-knowledge（只读观测）
 * - 未来接线：能力真值进对话前必须先过本模块
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeSelfKnowledge = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const ENGINE_VERSION = 'life-self-knowledge/1'

  const SOURCES = Object.freeze({ STATIC: 'static', RUNTIME: 'runtime', PERMISSION: 'permission' })
  const STATUS = Object.freeze({ AVAILABLE: 'available', UNAVAILABLE: 'unavailable', REQUIRES_OWNER: 'requires-owner' })

  // 身份禁词：镜像 renderer/persona/persona-core.js 的 selfAwarenessBoundary.forbidden
  // （测试做"两边必须完全相等"的防漂移断言；persona 侧改了这里必须同步改）
  const FORBIDDEN_CLAIMS = Object.freeze([
    '我是真人。',
    '我是现实中的人。',
    '我有真实身体。',
    '我在现实世界里拥有肉体。'
  ])

  // 能力宣称词表（封闭）：文本里命中 ⇒ 视为"提及了该能力"，再按该能力当前状态决定是否拦下（N2）
  const CLAIM_PATTERNS = Object.freeze({
    'read.window-title': [/窗口标题/, /网页标题/, /你(正在)?看的那个网页/, /标题是/],
    'see.screen-content': [/看到你的屏幕/, /你屏幕上/, /我截了/, /截图/, /屏幕内容/],
    'net.query-weather': [/我(查|看|知道|瞄)了?(一下)?天气/, /天气预报/, /今天(的)?天气/, /(会|要)下雨/, /气温/, /下不下雨/],
    'net.web-search': [/上网查/, /联网查/, /我搜了/, /网上说/, /百度/, /谷歌/, /搜索引擎/],
    'identity.has-physical-body': [/我有真实身体/, /我的身体/, /我能尝到/, /我正在吃/],
    'identity.is-real-person': [/我是真人/, /我是现实中的人/, /我是人类/],
    'see.foreground-category': [/我看到你在用/, /你在用什么程序/, /我知道你现在在用/],
    'hear.media-info': [/我听见你在听/, /听到你在听/, /你正在听/],
    'write.diary': [/我写了日记/, /日记我写好了/, /我把今天的日记写/],
    'reach.remote-phone': [/联系到你的手机/, /给你手机发/],
    'approve.tool-execution': [/我已经批准了/, /我帮你批了/, /我同意你执行/]
  })

  function ok(status, reason, evidence, detail) {
    return { status, reason: reason || null, evidence: evidence || null, detail: detail === undefined ? null : detail, unknown: false }
  }
  function unavailable(reason, evidence) { return ok(STATUS.UNAVAILABLE, reason, evidence) }
  function available(reason, evidence, detail) { return ok(STATUS.AVAILABLE, reason, evidence, detail) }
  function requiresOwner(reason, evidence, detail) { return ok(STATUS.REQUIRES_OWNER, reason, evidence, detail) }
  function unknown(reason, evidence) {
    // 输入缺失 ⇒ 表达上等同 unavailable，但如实标 unknown（不得把"不知道"说成"能做到"）
    const r = ok(STATUS.UNAVAILABLE, reason || 'unknown-source', evidence)
    r.unknown = true
    return r
  }
  function boolProbe(v, onReason, offReason, evidence) {
    if (v === true) return available(onReason, evidence)
    if (v === false) return unavailable(offReason, evidence)
    return unknown('input-missing:' + (offReason || onReason), evidence)
  }

  /* ---------- 能力清单（封闭） ---------- */
  const CAPABILITIES = Object.freeze([
    {
      id: 'identity.kind', source: SOURCES.STATIC, kind: 'identity-fact',
      probe: (i) => {
        const v = i.static && i.static.identityKind
        return v ? available('persona.selfAwarenessBoundary.selfIdentity', 'persona-core.js:82', v) : unknown('static-identity-missing', 'persona-core.js:82')
      }
    },
    {
      id: 'identity.has-physical-body', source: SOURCES.STATIC, kind: 'identity-claim',
      probe: () => unavailable('forbidden-claim', 'persona-core.js:82 selfAwarenessBoundary.forbidden')
    },
    {
      id: 'identity.is-real-person', source: SOURCES.STATIC, kind: 'identity-claim',
      probe: () => unavailable('forbidden-claim', 'persona-core.js:82 selfAwarenessBoundary.forbidden')
    },
    {
      id: 'see.foreground-category', source: SOURCES.RUNTIME, kind: 'capability',
      probe: (i) => boolProbe(i.runtime && i.runtime.perceptionEnabled, 'perception-on(L0/L1)', 'perception-off', 'perceptionConfig.enabled')
    },
    {
      id: 'hear.media-info', source: SOURCES.RUNTIME, kind: 'capability',
      probe: (i) => boolProbe(i.runtime && i.runtime.hearingEnabled, 'hearing-on', 'hearing-off', 'perceptionConfig.sensors.hearing.enabled')
    },
    {
      id: 'read.window-title', source: SOURCES.RUNTIME, kind: 'capability',
      probe: () => unavailable('not-built', 'L2 未实现；原始标题永不落盘（facts.js FORBIDDEN_VALUE_KEYS）')
    },
    {
      id: 'see.screen-content', source: SOURCES.RUNTIME, kind: 'capability',
      probe: () => unavailable('not-built', '无截屏/画面读取能力')
    },
    {
      id: 'net.query-weather', source: SOURCES.RUNTIME, kind: 'capability',
      probe: () => unavailable('not-connected', '无天气接入')
    },
    {
      id: 'net.web-search', source: SOURCES.RUNTIME, kind: 'capability',
      probe: () => unavailable('not-connected', '无联网检索接入（DSH 会话的工具属另一层，不是她的能力）')
    },
    {
      id: 'talk.chat', source: SOURCES.RUNTIME, kind: 'capability',
      probe: (i) => boolProbe(i.runtime && i.runtime.localChatEnabled, 'local-candidates', 'chat-disabled')
    },
    {
      id: 'write.diary', source: SOURCES.RUNTIME, kind: 'capability',
      probe: (i) => boolProbe(i.runtime && i.runtime.diaryEnabled, 'diary-on', 'diary-off', 'isDiaryEnabled()')
    },
    {
      id: 'reach.remote-phone', source: SOURCES.RUNTIME, kind: 'capability',
      probe: (i) => {
        const b = i.runtime || {}
        if (b.remoteBridgeEnabled === true) {
          if (b.remoteTunnelEnabled === true) return available('bridge+tunnel', 'remote-bridge')
          return available('bridge-same-wifi-only', 'remote-bridge', { tunnel: false })
        }
        if (b.remoteBridgeEnabled === false) return unavailable('bridge-off', 'remote-bridge')
        return unknown('input-missing:remoteBridgeEnabled', 'remote-bridge')
      }
    },
    {
      id: 'approve.tool-execution', source: SOURCES.PERMISSION, kind: 'permission',
      probe: (i) => {
        const p = i.permission || {}
        if (p.ownerApprovalRequired === true) return requiresOwner('owner-approval-required', '/api/pending 只读 + 写方法 405', { path: 'desktop-only' })
        if (p.ownerApprovalRequired === false) return available('no-approval-required', 'remote-approval')
        return unknown('permission-unknown', '/api/pending')
      }
    },
    {
      id: 'dsh.session-permission', source: SOURCES.PERMISSION, kind: 'session-fact',
      probe: (i) => {
        const p = i.permission || {}
        if (!Array.isArray(p.sessions)) return unknown('sessions-unknown', 'permissions.currentValue')
        const sessions = p.sessions.map((s) => ({ sessionId: (s && s.sessionId) || null, current: (s && s.current) || null }))
        // 注意：这是**会话事实**，不是"她本人的能力"（桌宠 ≠ 会话， 用户划界）
        return available('sessions-readable', 'permissions.currentValue + permissionPresets.catalog', { sessions, notHerAbility: true })
      }
    }
  ])

  const CAPABILITY_IDS = Object.freeze(CAPABILITIES.map((c) => c.id))
  const CAPABILITY_BY_ID = Object.freeze(CAPABILITIES.reduce((a, c) => { a[c.id] = c; return a }, {}))

  function capabilityOf(id) { return CAPABILITY_BY_ID[id] || null }

  /* ---------- 主入口：三源投影 ---------- */
  function project(input) {
    const i = input || {}
    const nowTs = i.nowTs
    if (!(typeof nowTs === 'number' && nowTs > 0)) throw new Error('self-knowledge.project: nowTs required (>0, 由调用方注入)')
    const declared = i.declared || {}
    const items = []
    const conflicts = []

    CAPABILITIES.forEach((c) => {
      const p = c.probe(i) || unknown('probe-failed', c.id)
      const item = {
        id: c.id,
        source: c.source,
        kind: c.kind,
        status: p.status,
        reason: p.reason || null,
        unknown: !!p.unknown,
        capturedAt: nowTs,
        evidence: p.evidence || null,
        detail: p.detail === undefined ? null : p.detail
      }
      const d = declared[c.id]
      if (d && d !== item.status) {
        // declared（旧 stub / 静态声明）**永不获胜**：真值来源为 item.source
        conflicts.push({ id: c.id, declared: d, actual: item.status, winner: c.source, loser: 'declared', atTs: nowTs })
      }
      items.push(item)
    })

    const byId = {}
    items.forEach((it) => { byId[it.id] = it })

    return {
      engineVersion: ENGINE_VERSION,
      asOfTs: nowTs,
      items,
      byId,
      conflicts,
      notes: [
        'no_cache=true',
        'no_io=true',
        'no_ai=true',
        'no_random=true',
        'declared_never_wins=true',
        'capabilities=' + CAPABILITY_IDS.length,
        'sources=' + [SOURCES.STATIC, SOURCES.RUNTIME, SOURCES.PERMISSION].join('/')
      ]
    }
  }

  function statusOf(projection, id) {
    if (id === 'identity.forbidden') return STATUS.UNAVAILABLE
    const it = projection && projection.byId ? projection.byId[id] : null
    return it ? it.status : null
  }

  /* ---------- N2：宣称检测与文本过滤 ---------- */
  function detectClaims(text) {
    const s = typeof text === 'string' ? text : ''
    const hits = []
    FORBIDDEN_CLAIMS.forEach((phrase) => {
      const core = phrase.replace(/[。！!，,、；;]$/, '')
      if (core && s.indexOf(core) >= 0) hits.push({ id: 'identity.forbidden', kind: 'forbidden-claim', matched: core, phrase })
    })
    Object.keys(CLAIM_PATTERNS).forEach((id) => {
      CLAIM_PATTERNS[id].forEach((re) => {
        const m = s.match(re)
        if (m) hits.push({ id, kind: 'capability-claim', matched: m[0] })
      })
    })
    return { ok: hits.length === 0, hits }
  }

  // 投影缺失时**fail-closed**：不认识的 id 一律按"拦下"处理（宁可少说，不许说错）
  function blockedHits(text, projection) {
    const d = detectClaims(text)
    return d.hits.filter((h) => {
      const st = projection ? statusOf(projection, h.id) : null
      if (h.id === 'identity.forbidden') return true
      return st !== STATUS.AVAILABLE
    })
  }

  function filterTexts(texts, opts) {
    const projection = (opts && opts.projection) || null
    const kept = []
    const dropped = []
    const list = Array.isArray(texts) ? texts : []
    list.forEach((t) => {
      const bad = blockedHits(t, projection)
      if (bad.length) {
        const reasons = []
        bad.forEach((h) => {
          const r = h.id + ':' + (projection ? String(statusOf(projection, h.id)) : 'no-projection')
          if (reasons.indexOf(r) < 0) reasons.push(r) // 同一条能力被多个词表命中时只报一次
        })
        dropped.push({ text: t, reasons: reasons })
        return
      }
      kept.push(t)
    })
    return { ok: dropped.length === 0, kept, dropped }
  }

  function assertNoCapabilityClaim(text, projection) {
    const bad = blockedHits(text, projection)
    return { ok: bad.length === 0, reasons: bad.map((h) => h.id + ':' + h.matched) }
  }

  // 供 wish / 承诺侧使用：找出这句话被"哪条能力边界"挡住（ledger 要求 wish.blockedBy === 'capability'）
  function blockedCapabilityOf(text, projection) {
    const bad = blockedHits(text, projection)
    if (!bad.length) return { ok: true, blockedBy: null, capabilityId: null, status: null }
    const h = bad[0]
    const id = h.id === 'identity.forbidden' ? 'identity.is-real-person' : h.id
    return { ok: false, blockedBy: 'capability', capabilityId: id, status: projection ? statusOf(projection, id) : null }
  }

  /* ---------- 结构自检 ---------- */
  function assertNoSurface() {
    const forbidden = ['say', 'speak', 'emit', 'dispatch', 'fire', 'run', 'notify', 'act', 'intent', 'presence', 'play', 'send']
    const keys = Object.keys(api || {})
    return { ok: keys.every((k) => forbidden.indexOf(k.toLowerCase()) < 0), keys }
  }

  function assertClosedList() {
    const reasons = []
    const ids = CAPABILITY_IDS
    if (ids.length !== 14) reasons.push('unexpected_capability_count:' + ids.length)
    if (new Set(ids).size !== ids.length) reasons.push('duplicate_capability_id')
    CAPABILITIES.forEach((c) => {
      if ([SOURCES.STATIC, SOURCES.RUNTIME, SOURCES.PERMISSION].indexOf(c.source) < 0) reasons.push('bad_source:' + c.id)
      if (typeof c.probe !== 'function') reasons.push('missing_probe:' + c.id)
    })
    return { ok: reasons.length === 0, reasons, count: ids.length }
  }

  const api = {
    ENGINE_VERSION,
    SOURCES,
    STATUS,
    CAPABILITIES,
    CAPABILITY_IDS,
    FORBIDDEN_CLAIMS,
    CLAIM_PATTERNS,
    capabilityOf,
    project,
    statusOf,
    detectClaims,
    filterTexts,
    assertNoCapabilityClaim,
    blockedCapabilityOf,
    assertNoSurface,
    assertClosedList
  }
  return api
})
