/* Perception Sensors · Vision · Detectors（M0/M1 迁移自 renderer/perception/detectors.js）
 * 职责：从 (visionState, observation) 推导 SemanticEvent。**纯函数，不修改入参 state**。
 * 统一签名：detect(state, observation) → { events, nextState }
 * 边界：本文件不得引用任何 Engine / Writer / Router；也不得做节流（M3 已移交 Presence Router）。
 * 事件：E1 app_switch / E2 category_dwell / E3 long_activity / E4 late_night / E5 absence_return / E6 preference
 */
(function () {
  const MIN = 60 * 1000
  const DWELL_E2_MIN = 10
  const DWELL_E3_MIN = 60
  const ABSENCE_MIN = 30
  const PREF_DAYS = 3
  const CAT_DAYS_KEEP = 14

  function semanticEvent(obs, kind, payload) {
    return window.PresenceEvents.semanticEvent(obs, kind, payload, topicOf(payload && payload.cat))
  }

  /** M4：视的类别 → 跨模态公共键 topic（听接入后靠它做合并与共享冷却） */
  function topicOf(cat) {
    return (window.VisionVocab && typeof window.VisionVocab.topicOfCategory === 'function')
      ? window.VisionVocab.topicOfCategory(cat)
      : 'other'
  }

  /* D1：切换 / 回归（纯发现，不做节流） */
  const D1 = {
    name: 'switch',
    detect: function (state, obs) {
      const events = []
      const next = Object.assign({}, state)
      const app = obs.payload.app
      const cat = obs.payload.cat
      if (app !== state.lastApp) {
        if (state.lastSeenTs && obs.ts - state.lastSeenTs >= ABSENCE_MIN * MIN) {
          events.push(semanticEvent(obs, 'E5_absence_return', { app: app, cat: cat }))
        } else if (state.lastApp) {
          events.push(semanticEvent(obs, 'E1_app_switch', { app: app, cat: cat }))
        }
        next.lastApp = app
      }
      next.lastSeenTs = obs.ts
      return { events: events, nextState: next }
    },
  }

  /* D2：停留时长 → E2 / E3 */
  const D2 = {
    name: 'dwell',
    detect: function (state, obs) {
      const events = []
      const next = Object.assign({}, state)
      const cat = obs.payload.cat
      if (cat !== state.lastCat) {
        next.lastCat = cat
        next.catSince = obs.ts
        next.catAccum = Object.assign({}, state.catAccum)
        next.firedForDwell = Object.assign({}, state.firedForDwell)
      }
      const catSince = next.catSince || obs.ts
      const dwellMs = obs.ts - catSince
      const fired = Object.assign({}, next.firedForDwell || {})
      // E3（长时）优先：命中 E3 时同时标记 E2，避免同一类别既发 E2 又发 E3
      if (dwellMs >= DWELL_E3_MIN * MIN && fired.E3 !== cat) {
        events.push(semanticEvent(obs, 'E3_long_activity', { cat: cat, dwellMs: dwellMs }))
        fired.E3 = cat
        fired.E2 = cat
      } else if (dwellMs >= DWELL_E2_MIN * MIN && fired.E2 !== cat) {
        events.push(semanticEvent(obs, 'E2_category_dwell', { cat: cat, dwellMs: dwellMs }))
        fired.E2 = cat
      }
      next.firedForDwell = fired
      return { events: events, nextState: next }
    },
  }

  /* D3：时段 / 跨天偏好 → E4 / E6 */
  const D3 = {
    name: 'temporal',
    detect: function (state, obs) {
      const events = []
      const next = Object.assign({}, state)
      const h = obs.payload.hour
      const cat = obs.payload.cat
      const dateKey = obs.payload.dateKey

      // E4 深夜活跃（每日一次）
      const firedToday = Object.assign({}, state.firedToday)
      if ((h >= 22 || h < 6) && firedToday.E4 !== dateKey) {
        events.push(semanticEvent(obs, 'E4_late_night', { cat: cat, hour: h }))
        firedToday.E4 = dateKey
      }
      next.firedToday = firedToday

      // E6 跨天同类 ≥ PREF_DAYS 天
      const catDays = Object.assign({}, state.catDays)
      const days = (catDays[cat] || []).slice()
      if (days.indexOf(dateKey) < 0) days.push(dateKey)
      catDays[cat] = days.slice(-CAT_DAYS_KEEP)
      next.catDays = catDays
      const firedForPref = Object.assign({}, state.firedForPref)
      if (catDays[cat].length >= PREF_DAYS && !firedForPref[cat]) {
        events.push(semanticEvent(obs, 'E6_preference', { cat: cat, days: catDays[cat].length }))
        firedForPref[cat] = true
      }
      next.firedForPref = firedForPref
      return { events: events, nextState: next }
    },
  }

  window.VisionDetectors = {
    DETECTORS: [D1, D2, D3],
    topicOf: topicOf,
    THRESHOLDS: {
      DWELL_E2_MIN: DWELL_E2_MIN,
      DWELL_E3_MIN: DWELL_E3_MIN,
      ABSENCE_MIN: ABSENCE_MIN,
      PREF_DAYS: PREF_DAYS,
    },
  }
})()
