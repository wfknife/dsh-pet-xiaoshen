/* LifeFacts — F0「事实层」只读实现（第一期 / 甲方案：产品零接线）
 *
 * 目标：把"她看到了什么"变成**带身份、可追溯的事实**。
 * 边界（P3-life-context-boundary-final-v1-20260918.md v1.1 §3 + F0F7 阶段设计 §3.1）：
 *   - 三种身份必须彻底分开：fact / derived_observation / user_confirmed_fact
 *   - 每条事实可回溯：source + capturedAt + availability
 *   - 派生观测必带 derivation（from / rule / rawSource），且 rawPersisted 恒为 false
 *   - 原始窗口/网页标题、文件内容、键盘输入**永不落盘**（本模块结构上不接受这些字段）
 *   - 本模块**零 I/O、零网络、零写**：输入全注入，纯函数
 *
 * Used by:
 *   - build/test-life-context-f0-facts.cjs（离线契约 + 负控）
 *   - E:\dsh\tools\life-context-inspect.cjs（只读采集后调用）
 *   - 未来渲染层接线（本期不做）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeFacts = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const ENGINE_VERSION = 'life-facts/1'

  const KIND_FACT = 'fact'
  const KIND_DERIVED = 'derived_observation'
  const KIND_USER = 'user_confirmed_fact'
  const KINDS = [KIND_FACT, KIND_DERIVED, KIND_USER]

  const SOURCES = {
    FOREGROUND: 'foreground-collector',
    CLOCK: 'system-clock',
    MEDIA: 'media-session',
    USER: 'user-confirmation'
  }

  const AVAILABILITY = ['available', 'unavailable', 'stale']
  const RAW_SOURCES = ['facts-only', 'ephemeral']

  // 与 3.1 采集器一致：短于 5 分钟的活动段不记为事实（main.js 的 pushSegment 同口径）
  const SEGMENT_MIN_MS = 5 * 60 * 1000

  // 类别 → 家族（派生观测；不引入任何原文）
  const CATEGORY_FAMILIES = {
    work: ['开发工具', '文档'],
    media: ['音乐'],
    chat: ['聊天'],
    browser: ['浏览器']
  }

  // 隐私硬不变量：这些键名永远不允许出现在事实的 value 里（结构上排除原文落盘）
  const FORBIDDEN_VALUE_KEYS = ['title', 'windowTitle', 'pageTitle', 'url', 'filePath', 'fileName', 'rawText', 'content', 'keylog']

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }

  function pad2(n) { return String(n).padStart(2, '0') }

  function localClock(nowTs) {
    const d = new Date(nowTs)
    return {
      hour: d.getHours(),
      minute: d.getMinutes(),
      weekday: WEEKDAYS[d.getDay()],
      dateKey: d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(),
      hhmm: pad2(d.getHours()) + ':' + pad2(d.getMinutes()),
      isLateNight: d.getHours() >= 23 || d.getHours() < 5
    }
  }

  function keyPatternOk(key) { return typeof key === 'string' && /^[a-z][a-z0-9._-]*$/.test(key) }

  function hasForbiddenKey(obj, depth) {
    if (!obj || typeof obj !== 'object') return null
    if ((depth || 0) > 4) return null
    for (const k of Object.keys(obj)) {
      if (FORBIDDEN_VALUE_KEYS.indexOf(k) >= 0) return k
      if (obj[k] && typeof obj[k] === 'object') {
        const hit = hasForbiddenKey(obj[k], (depth || 0) + 1)
        if (hit) return hit
      }
    }
    return null
  }

  function validateFact(f) {
    const reasons = []
    if (!f || typeof f !== 'object') return { ok: false, reasons: ['not_object'] }
    if (KINDS.indexOf(f.kind) < 0) reasons.push('bad_kind:' + String(f.kind))
    if (!keyPatternOk(f.key)) reasons.push('bad_key')
    if (typeof f.source !== 'string' || !f.source) reasons.push('missing_source')
    if (typeof f.capturedAt !== 'number' || !Number.isFinite(f.capturedAt) || f.capturedAt <= 0) reasons.push('bad_capturedAt')
    if (AVAILABILITY.indexOf(f.availability) < 0) reasons.push('bad_availability')
    if (f.kind === KIND_DERIVED) {
      const d = f.derivation
      if (!d || typeof d !== 'object') reasons.push('derived_without_derivation')
      else {
        if (!Array.isArray(d.from) || d.from.length < 1 || d.from.some((x) => typeof x !== 'string' || !x)) reasons.push('derivation_from_invalid')
        if (typeof d.rule !== 'string' || !d.rule) reasons.push('derivation_rule_missing')
        if (RAW_SOURCES.indexOf(d.rawSource) < 0) reasons.push('derivation_rawSource_invalid')
      }
      if (f.rawPersisted !== false) reasons.push('derived_rawPersisted_must_be_false')
    }
    if (f.kind === KIND_USER && f.source !== SOURCES.USER) reasons.push('user_fact_source_must_be_user_confirmation')
    const forbidden = hasForbiddenKey(f.value)
    if (forbidden) reasons.push('forbidden_value_key:' + forbidden)
    return { ok: reasons.length === 0, reasons }
  }

  function makeFact(input) {
    const f = {
      id: input.id,
      kind: input.kind || KIND_FACT,
      key: input.key,
      value: input.value === undefined ? null : input.value,
      source: input.source,
      capturedAt: input.capturedAt,
      availability: input.availability || 'available'
    }
    if (f.kind === KIND_DERIVED) {
      f.derivation = input.derivation
      f.rawPersisted = false
    }
    const v = validateFact(f)
    if (!v.ok) throw new Error('invalid fact: ' + v.reasons.join(','))
    return Object.freeze(f)
  }

  function clockFact(nowTs) {
    return makeFact({
      id: 'f:clock.local:1',
      kind: KIND_FACT,
      key: 'clock.local',
      value: localClock(nowTs),
      source: SOURCES.CLOCK,
      capturedAt: nowTs
    })
  }

  function mediaFact(media, nowTs) {
    if (!media || typeof media !== 'object') return null
    const status = typeof media.status === 'string' ? media.status : 'Closed'
    const sinceTs = typeof media.sinceTs === 'number' && Number.isFinite(media.sinceTs) ? media.sinceTs : null
    return makeFact({
      id: 'f:media.state:1',
      kind: KIND_FACT,
      key: 'media.state',
      value: {
        status,
        sinceMs: sinceTs ? Math.max(0, nowTs - sinceTs) : null
      },
      source: SOURCES.MEDIA,
      capturedAt: nowTs,
      availability: status === 'Closed' ? 'unavailable' : 'available'
    })
  }

  /* P3 F0 第一阶段：activity.current —— collector 进行中段的**只读投影**。
     · 数据源 = 主进程把 collectSeg 快照挂在 timeline.open 上（瞬时键，不落盘）；本模块只读、不改 collector
     · 与 activity.segment 严格分离：独立 key / 不进 segmentFacts / 不占 seq / 不产生 f:activity.segment:* / 不生成 ledger ref
     · 只在存在合法 open 时产出一条；缺省/非法 ⇒ null（不伪造），旧数据行为逐字节不变
     · 语义只到"collector 此刻还在累积哪个类别"为止：无 end、无 duration、无用户行为/意义字段
     · 时间精度继承采样（约 ±30 秒，intervalMs=30000），asOfTs 即投影时刻 */
  function currentFact(timeline) {
    const o = timeline && timeline.open
    if (!o || typeof o !== 'object') return null
    const cat = typeof o.cat === 'string' ? o.cat : ''
    const startTs = (typeof o.startTs === 'number' && Number.isFinite(o.startTs) && o.startTs > 0) ? o.startTs : null
    const asOfTs = (typeof o.asOfTs === 'number' && Number.isFinite(o.asOfTs) && o.asOfTs > 0) ? o.asOfTs : null
    if (!cat || !startTs || !asOfTs) return null
    return makeFact({
      id: 'f:activity.current:1',
      kind: KIND_FACT,
      key: 'activity.current',
      value: { cat: cat, startTs: startTs, asOfTs: asOfTs },
      source: SOURCES.FOREGROUND,
      capturedAt: asOfTs
    })
  }

  function segmentMs(seg) {
    const s = typeof seg.startTs === 'number' ? seg.startTs : Date.parse(seg.start)
    const e = typeof seg.endTs === 'number' ? seg.endTs : Date.parse(seg.end)
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null
    return { startTs: s, endTs: e, durationMs: e - s }
  }

  function segmentFacts(timeline, nowTs) {
    const segments = timeline && Array.isArray(timeline.segments) ? timeline.segments : []
    const facts = []
    const skipped = []
    const seen = {}
    let seq = 0
    segments.forEach((seg, i) => {
      const t = segmentMs(seg || {})
      if (!t) { skipped.push({ index: i, reason: 'bad_time' }); return }
      const cat = typeof seg.app === 'string' && seg.app ? seg.app : null
      if (!cat) { skipped.push({ index: i, reason: 'no_category' }); return }
      const dedupeKey = cat + '|' + t.startTs + '|' + t.endTs
      if (seen[dedupeKey]) { skipped.push({ index: i, reason: 'duplicate' }); return }
      seen[dedupeKey] = true
      if (t.durationMs < SEGMENT_MIN_MS) { skipped.push({ index: i, reason: 'too_short', durationMs: t.durationMs }); return }
      seq += 1
      facts.push(makeFact({
        id: 'f:activity.segment:' + seq,
        kind: KIND_FACT,
        key: 'activity.segment',
        value: { cat, startTs: t.startTs, endTs: t.endTs, durationMs: t.durationMs },
        source: SOURCES.FOREGROUND,
        capturedAt: t.endTs,
        availability: nowTs && t.endTs > nowTs + 60 * 1000 ? 'stale' : 'available'
      }))
    })
    return { facts, skipped }
  }

  function familyFacts(segmentFactsList) {
    const out = []
    let seq = 0
    Object.keys(CATEGORY_FAMILIES).forEach((fam) => {
      const cats = CATEGORY_FAMILIES[fam]
      const from = segmentFactsList.filter((f) => cats.indexOf(f.value.cat) >= 0).map((f) => f.id)
      if (!from.length) return
      seq += 1
      const totalMs = segmentFactsList
        .filter((f) => cats.indexOf(f.value.cat) >= 0)
        .reduce((a, f) => a + f.value.durationMs, 0)
      out.push(makeFact({
        id: 'f:activity.family:' + seq,
        kind: KIND_DERIVED,
        key: 'activity.family',
        value: { family: fam, categories: cats.slice(), segmentCount: from.length, totalMs },
        source: SOURCES.FOREGROUND,
        capturedAt: Math.max.apply(null, segmentFactsList.filter((f) => cats.indexOf(f.value.cat) >= 0).map((f) => f.value.endTs)),
        derivation: { from, rule: 'category->family', rawSource: 'facts-only' }
      }))
    })
    return out
  }

  function buildFacts(input) {
    const opts = input || {}
    // 时钟必须由调用方注入；缺失时确定性取 0（**绝不读真实时间**，否则验收不可复现）
    const nowTs = typeof opts.nowTs === 'number' && Number.isFinite(opts.nowTs) ? opts.nowTs : 0
    const seg = segmentFacts(opts.timeline, nowTs)
    const fam = familyFacts(seg.facts)
    const extra = [clockFact(nowTs)]
    const mf = mediaFact(opts.media, nowTs)
    if (mf) extra.push(mf)
    /* P3 F0 第一阶段：activity.current 仅在 timeline.open 合法时追加（缺省零影响） */
    const cf = currentFact(opts.timeline)
    if (cf) extra.push(cf)
    const facts = seg.facts.concat(fam).concat(extra)
    facts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    facts.forEach((f) => {
      const v = validateFact(f)
      if (!v.ok) throw new Error('built invalid fact ' + f.id + ': ' + v.reasons.join(','))
    })
    return {
      engineVersion: ENGINE_VERSION,
      asOfTs: nowTs,
      facts,
      skipped: seg.skipped,
      notes: [
        'segment_min_ms=' + SEGMENT_MIN_MS,
        'families=' + Object.keys(CATEGORY_FAMILIES).join(','),
        'no_io=true'
      ]
    }
  }

  function indexById(facts) {
    const m = {}
    ;(facts || []).forEach((f) => { m[f.id] = f })
    return m
  }

  function byKey(facts, key) {
    return (facts || []).filter((f) => f.key === key)
  }

  function overlapping(facts, fromTs, toTs) {
    return (facts || []).filter((f) => f.key === 'activity.segment' && f.value.endTs > fromTs && f.value.startTs < toTs)
  }

  function summarize(facts) {
    const byKind = {}
    const byKeyCount = {}
    ;(facts || []).forEach((f) => {
      byKind[f.kind] = (byKind[f.kind] || 0) + 1
      byKeyCount[f.key] = (byKeyCount[f.key] || 0) + 1
    })
    return { total: (facts || []).length, byKind, byKey: byKeyCount }
  }

  return {
    ENGINE_VERSION,
    KIND_FACT,
    KIND_DERIVED,
    KIND_USER,
    KINDS,
    SOURCES,
    AVAILABILITY,
    RAW_SOURCES,
    SEGMENT_MIN_MS,
    CATEGORY_FAMILIES,
    FORBIDDEN_VALUE_KEYS,
    localClock,
    validateFact,
    makeFact,
    buildFacts,
    currentFact,
    indexById,
    byKey,
    overlapping,
    summarize
  }
})
