/* Perception Core · State（M0/M1/M2 + H1）
 * 职责：状态信封与迁移 —— perceptionState 的 schemaVersion 2 权威。
 * 结构：{ schemaVersion:2, shared, vision, hearing }
 *   shared  = PresenceState：跨模态簿记（lastSaidAt 按 topic / lastReactionAt / mergeUntil）
 *   vision  = VisionState
 *   hearing = HearingState（H1 接入；只落哈希与日期，不落曲名原文）
 * 迁移：v1 扁平 perceptionState → v2（lastSaidAt 由类别键转为 topic 键）
 * 边界：本文件不得引用任何 Engine / Writer / Router / Detector。
 */
(function () {
  const SCHEMA_VERSION = 2

  const DEFAULT_CONFIG = {
    enabled: false,
    intervalMs: 30000,
    confidenceMin: 0.5,
    // H3：说话节流（跨模态共用）
    speech: { globalCooldownMs: 60000, mergeWindowMs: 8000 },
    // 每传感器独立开关与采样间隔（视与听互不牵连）
    sensors: {
      vision: { enabled: true, intervalMs: 30000 },
      hearing: { enabled: false, intervalMs: 10000 },
    },
  }

  const DEFAULT_SHARED = {
    lastSaidAt: {},
    lastReactionAt: 0,
    mergeUntil: {}, // topic → 合并窗截止时间
    lastReactionId: '',
  }

  const DEFAULT_VISION = {
    lastApp: '',
    lastCat: '',
    catSince: 0,
    catAccum: {},
    catDays: {},
    lastSeenTs: 0,
    firedForDwell: {},
    firedToday: {},
    firedForPref: {},
  }

  const DEFAULT_HEARING = {
    lastApp: '',
    lastTrackHash: '',
    lastArtistHash: '',
    playState: 'Closed',
    trackSince: 0,
    pausedSince: 0,
    artistDays: {},
    trackRepeats: {},
    firedFor: {},
  }

  const VISION_FIELDS = Object.keys(DEFAULT_VISION)
  const HEARING_FIELDS = Object.keys(DEFAULT_HEARING)

  function clone(o) { return JSON.parse(JSON.stringify(o)) }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }

  function normalizeShared(raw) {
    const out = clone(DEFAULT_SHARED)
    if (!isObj(raw)) return out
    if (isObj(raw.lastSaidAt)) {
      for (const k of Object.keys(raw.lastSaidAt)) {
        const v = Number(raw.lastSaidAt[k])
        if (Number.isFinite(v) && v > 0) out.lastSaidAt[k] = v
      }
    }
    if (isObj(raw.mergeUntil)) {
      for (const k of Object.keys(raw.mergeUntil)) {
        const v = Number(raw.mergeUntil[k])
        if (Number.isFinite(v) && v > 0) out.mergeUntil[k] = v
      }
    }
    const lr = Number(raw.lastReactionAt)
    out.lastReactionAt = Number.isFinite(lr) ? lr : 0
    out.lastReactionId = typeof raw.lastReactionId === 'string' ? raw.lastReactionId : ''
    return out
  }

  function pickFields(raw, fields, defaults) {
    const out = clone(defaults)
    if (!isObj(raw)) return out
    for (const k of fields) {
      if (!(k in raw)) continue
      const v = raw[k]
      if (isObj(defaults[k])) out[k] = isObj(v) ? clone(v) : clone(defaults[k])
      else if (Array.isArray(defaults[k])) out[k] = Array.isArray(v) ? v.slice() : []
      else if (typeof defaults[k] === 'number') out[k] = Number(v) || 0
      else out[k] = v === undefined || v === null ? defaults[k] : v
    }
    return out
  }

  function normalizeVision(raw) { return pickFields(raw, VISION_FIELDS, DEFAULT_VISION) }
  function normalizeHearing(raw) { return pickFields(raw, HEARING_FIELDS, DEFAULT_HEARING) }

  /** 配置规范化：旧配置补齐 speech / sensors（不覆盖已有值） */
  function normalizeConfig(raw) {
    const out = clone(DEFAULT_CONFIG)
    if (!isObj(raw)) return out
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    if (Number(raw.intervalMs) > 0) out.intervalMs = Number(raw.intervalMs)
    if (Number(raw.confidenceMin) > 0) out.confidenceMin = Number(raw.confidenceMin)
    if (isObj(raw.speech)) {
      if (Number(raw.speech.globalCooldownMs) >= 0) out.speech.globalCooldownMs = Number(raw.speech.globalCooldownMs)
      if (Number(raw.speech.mergeWindowMs) >= 0) out.speech.mergeWindowMs = Number(raw.speech.mergeWindowMs)
    }
    if (isObj(raw.sensors)) {
      for (const id of Object.keys(out.sensors)) {
        const s = raw.sensors[id]
        if (!isObj(s)) continue
        if (typeof s.enabled === 'boolean') out.sensors[id].enabled = s.enabled
        if (Number(s.intervalMs) > 0) out.sensors[id].intervalMs = Number(s.intervalMs)
      }
    }
    // 兼容：旧配置只有 intervalMs（视为视的采样间隔）
    if (Number(raw.intervalMs) > 0) out.sensors.vision.intervalMs = Number(raw.intervalMs)
    return out
  }

  /** v1（扁平）→ v2：lastSaidAt 由类别键迁移为 topic 键 */
  function migrateV1(old) {
    const vision = normalizeVision(old)
    const shared = clone(DEFAULT_SHARED)
    const toTopic = (window.VisionVocab && typeof window.VisionVocab.topicOfCategory === 'function')
      ? window.VisionVocab.topicOfCategory
      : function (c) { return c }
    const src = isObj(old) && isObj(old.lastSaidAt) ? old.lastSaidAt : {}
    for (const key of Object.keys(src)) {
      const topic = toTopic(key)
      const ts = Number(src[key]) || 0
      if (!(ts > 0)) continue
      if (!(shared.lastSaidAt[topic] > ts)) shared.lastSaidAt[topic] = ts
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      shared: shared,
      vision: vision,
      hearing: clone(DEFAULT_HEARING),
    }
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      shared: clone(DEFAULT_SHARED),
      vision: clone(DEFAULT_VISION),
      hearing: clone(DEFAULT_HEARING),
    }
  }

  /** 幂等补齐 Config / State，并把 v1 状态迁移为 v2 */
  function ensureState(P) {
    P.perceptionConfig = normalizeConfig(P.perceptionConfig)
    const st = P.perceptionState
    if (!isObj(st)) { P.perceptionState = defaultState(); return P.perceptionState }
    if (st.schemaVersion !== SCHEMA_VERSION || !isObj(st.shared) || !isObj(st.vision)) {
      P.perceptionState = migrateV1(st)
      return P.perceptionState
    }
    st.shared = normalizeShared(st.shared)
    st.vision = normalizeVision(st.vision)
    st.hearing = normalizeHearing(st.hearing)
    return st
  }

  window.PresenceState = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    DEFAULT_SHARED: DEFAULT_SHARED,
    DEFAULT_VISION: DEFAULT_VISION,
    DEFAULT_HEARING: DEFAULT_HEARING,
    defaultState: defaultState,
    migrateV1: migrateV1,
    normalizeConfig: normalizeConfig,
    normalizeShared: normalizeShared,
    normalizeVision: normalizeVision,
    normalizeHearing: normalizeHearing,
    ensureState: ensureState,
  }
})()
