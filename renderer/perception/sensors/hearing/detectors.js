/* Perception Sensors · Hearing · Detectors
 * 职责：从 (hearingState, observation) 推导 A1–A6 SemanticEvent。**纯函数，不修改入参 state**。
 * 统一签名：detect(state, observation) → { events, nextState }
 * 边界：不得引用任何 Engine / Writer / Router；也不做节流（由 Presence Router 负责）。
 *
 * 事件：A1 media_start / A2 media_stop / A3 track_repeat / A4 listening_dwell
 *       A5 taste_across_days / A6 media_paused
 * 链序：H1..H5 只读上一轮快照 → H6 在链尾做**快照簿记**（唯一更新 playState/trackSince/哈希）。
 * 隐私：状态里只落哈希与日期，不落曲名/歌手原文（原文仅存在于 observation 内，用于当期表达）。
 */
(function () {
  const MIN = 60 * 1000
  const REPEAT_WINDOW_MIN = 60      // A3：同一首在 60 分钟内重复播放
  const DWELL_MIN = 20              // A4：连续收听 ≥20 分钟
  const TASTE_DAYS = 3              // A5：同一歌手跨 ≥3 天
  const PAUSE_MIN = 10              // A6：连续暂停 ≥10 分钟
  const DAYS_KEEP = 14
  const REPEATS_KEEP = 12

  function vocab() { return window.HearingVocab || {} }

  function topicOf(payload) {
    const v = vocab()
    return v.topicOfMedia ? v.topicOfMedia(payload && payload.app, payload && payload.mediaType) : 'media'
  }

  function semanticEvent(obs, kind, payload) {
    return window.PresenceEvents.semanticEvent(obs, kind, payload, topicOf(obs.payload))
  }

  function fired(state) { return Object.assign({}, state.firedFor || {}) }

  /* H1：播放开始 / 停止 → A1 / A2 */
  const H1 = {
    name: 'media-change',
    detect: function (state, obs) {
      const events = []
      const next = Object.assign({}, state)
      const p = obs.payload
      const wasPlaying = vocab().isPlaying ? vocab().isPlaying(state.playState) : state.playState === 'Playing'
      if (p.playing && (!wasPlaying || p.changed)) {
        events.push(semanticEvent(obs, 'A1_media_start', {
          app: p.app, title: p.title, artist: p.artist, trackHash: p.trackHash, artistHash: p.artistHash,
        }))
      } else if (!p.playing && wasPlaying) {
        events.push(semanticEvent(obs, 'A2_media_stop', { app: p.app, trackHash: p.trackHash, artistHash: p.artistHash }))
      }
      return { events: events, nextState: next }
    },
  }

  /* H2：重复播放 → A3 */
  const H2 = {
    name: 'track-repeat',
    detect: function (state, obs) {
      const events = []
      const next = Object.assign({}, state)
      const p = obs.payload
      const wasPlaying = vocab().isPlaying ? vocab().isPlaying(state.playState) : state.playState === 'Playing'
      if (!p.playing || !p.trackHash) return { events: events, nextState: next }
      if (!(p.changed || !wasPlaying)) return { events: events, nextState: next }

      const repeats = Object.assign({}, state.trackRepeats || {})
      const prev = repeats[p.trackHash] || { count: 0, lastAt: 0 }
      const count = Number(prev.count || 0) + 1
      repeats[p.trackHash] = { count: count, lastAt: obs.ts }
      // 裁剪：只保留最近 REPEATS_KEEP 条哈希记录
      const keys = Object.keys(repeats)
      if (keys.length > REPEATS_KEEP) {
        keys.sort(function (a, b) { return (repeats[a].lastAt || 0) - (repeats[b].lastAt || 0) })
        for (let i = 0; i < keys.length - REPEATS_KEEP; i++) delete repeats[keys[i]]
      }
      next.trackRepeats = repeats

      const within = obs.ts - Number(prev.lastAt || 0) <= REPEAT_WINDOW_MIN * MIN
      if (count >= 2 && within) {
        events.push(semanticEvent(obs, 'A3_track_repeat', {
          app: p.app, title: p.title, artist: p.artist, trackHash: p.trackHash, count: count,
        }))
      }
      return { events: events, nextState: next }
    },
  }

  /* H3：连续收听时长 → A4（每 topic 每天一次） */
  const H3 = {
    name: 'listening-dwell',
    detect: function (state, obs) {
      const events = []
      const next = Object.assign({}, state)
      const p = obs.payload
      if (!p.playing || !state.trackSince) return { events: events, nextState: next }
      const topic = topicOf(p)
      const f = fired(state)
      const key = 'A4:' + topic
      if (f[key] === p.dateKey) return { events: events, nextState: next }
      const dwellMs = obs.ts - Number(state.trackSince)
      if (dwellMs >= DWELL_MIN * MIN) {
        events.push(semanticEvent(obs, 'A4_listening_dwell', {
          app: p.app, artist: p.artist, dwellMs: dwellMs, topic: topic,
        }))
        f[key] = p.dateKey
      }
      next.firedFor = f
      return { events: events, nextState: next }
    },
  }

  /* H4：跨天口味 → A5（每歌手一次） */
  const H4 = {
    name: 'taste-days',
    detect: function (state, obs) {
      const events = []
      const next = Object.assign({}, state)
      const p = obs.payload
      const f = fired(state)
      if (!p.playing || !p.artistHash || topicOf(p) !== 'music') return { events: events, nextState: next }

      const artistDays = Object.assign({}, state.artistDays || {})
      const days = (artistDays[p.artistHash] || []).slice()
      if (days.indexOf(p.dateKey) < 0) days.push(p.dateKey)
      artistDays[p.artistHash] = days.slice(-DAYS_KEEP)
      next.artistDays = artistDays

      const key = 'A5:' + p.artistHash
      if (days.length >= TASTE_DAYS && !f[key]) {
        events.push(semanticEvent(obs, 'A5_taste_across_days', {
          app: p.app, artist: p.artist, artistHash: p.artistHash, days: days.length,
        }))
        f[key] = true
      }
      next.firedFor = f
      return { events: events, nextState: next }
    },
  }

  /* H5：长时间暂停 → A6（每天一次） */
  const H5 = {
    name: 'media-paused',
    detect: function (state, obs) {
      const events = []
      const next = Object.assign({}, state)
      const p = obs.payload
      const f = fired(state)
      if (p.playing || !state.pausedSince) return { events: events, nextState: next }
      if (f.A6 === p.dateKey) return { events: events, nextState: next }
      const pausedMs = obs.ts - Number(state.pausedSince)
      if (pausedMs >= PAUSE_MIN * MIN) {
        events.push(semanticEvent(obs, 'A6_media_paused', { app: p.app, pausedMs: pausedMs }))
        f.A6 = p.dateKey
        next.firedFor = f
      }
      return { events: events, nextState: next }
    },
  }

  /* H6：快照簿记（链尾，唯一更新 playState / lastTrackHash / trackSince / pausedSince）
     放在链尾的原因：H1–H5 必须看到"上一轮"的 playState 才能判断状态迁移。 */
  const H6 = {
    name: 'snapshot-bookkeeping',
    detect: function (state, obs) {
      const next = Object.assign({}, state)
      const p = obs.payload
      const wasPlaying = vocab().isPlaying ? vocab().isPlaying(state.playState) : state.playState === 'Playing'

      next.lastApp = p.app
      next.playState = p.status
      if (p.trackHash) next.lastTrackHash = p.trackHash
      if (p.artistHash) next.lastArtistHash = p.artistHash

      if (p.playing) {
        // 换曲或从非播放进入 → 重新计时
        if (p.changed || !wasPlaying) next.trackSince = obs.ts
        else if (!state.trackSince) next.trackSince = obs.ts
        next.pausedSince = 0
      } else {
        if (wasPlaying && !state.pausedSince) next.pausedSince = obs.ts
        next.trackSince = 0
      }
      return { events: [], nextState: next }
    },
  }

  window.HearingDetectors = {
    DETECTORS: [H1, H2, H3, H4, H5, H6],
    THRESHOLDS: {
      REPEAT_WINDOW_MIN: REPEAT_WINDOW_MIN,
      DWELL_MIN: DWELL_MIN,
      TASTE_DAYS: TASTE_DAYS,
      PAUSE_MIN: PAUSE_MIN,
    },
    topicOf: topicOf,
  }
})()
