/* Perception Core · Pipeline（M0/M1/M2 + H3）
 * 流程：Sensors → Observation → Detector 链（每传感器一条） → Presence Router → Writers
 * 单一定时器 + 单一 Router 调用 + 单一 commit 点。
 * 边界：本文件不直接调用任何 Engine；所有引擎调用只能发生在 core/writers.js。
 */
(function () {
  const BASE_TICK_MS = 5000

  const SENSORS = {
    vision: {
      slice: 'vision',
      detectors: function () { return window.VisionDetectors },
      poll: function () { return window.pet.getForegroundApp() },
      label: function (sig) { return sig.app + '/' + (sig.cat || '其他') },
    },
    hearing: {
      slice: 'hearing',
      detectors: function () { return window.HearingDetectors },
      // helper 首个快照到达前（ageMs < 0）不产出观察，避免启动瞬间产生"空媒体"假事件
      poll: async function () {
        const ms = await window.pet.getMediaSession()
        if (!ms || Number(ms.ageMs) < 0) return null
        return ms
      },
      label: function (sig) { return (sig.app || 'none') + '/' + (sig.status || 'Closed') },
    },
  }

  let timer = null
  let ctxRef = null
  let lastPoll = {}

  function ensureState(P) {
    return window.PresenceState.ensureState(P)
  }

  function runDetectors(sensorId, obs, slice) {
    const spec = SENSORS[sensorId]
    const D = spec.detectors()
    if (!D || !D.DETECTORS) return { events: [], state: slice }
    let state = slice
    let events = []
    for (let i = 0; i < D.DETECTORS.length; i++) {
      const r = D.DETECTORS[i].detect(state, obs)
      events = events.concat(r.events)
      state = r.nextState
    }
    return { events: events, state: state }
  }

  /** 多传感器一轮：一次 observation 集合 → 一次 Router 调用 → 一次执行 */
  function perceiveAll(P, items) {
    ensureState(P)
    const O = window.PresenceObservation
    const R = window.PresenceRouter
    const W = window.PresenceWriters
    if (!O || !R || !W) return null
    const st = P.perceptionState
    const obsList = []
    let allEvents = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const spec = SENSORS[item.sensor]
      if (!spec) continue
      const obs = O.createObservation(item.sensor, item.signal, st[spec.slice])
      if (!obs) continue
      obsList.push(obs)
      const r = runDetectors(item.sensor, obs, st[spec.slice])
      st[spec.slice] = r.state
      allEvents = allEvents.concat(r.events)
    }
    if (!obsList.length) return null

    const minConf = Number(P.perceptionConfig.confidenceMin) || 0.5
    allEvents = allEvents.filter(function (e) { return Number(e.confidence || 0) >= minConf })

    const routed = R.plan(allEvents, st.shared, Date.now(), P.perceptionConfig.speech)
    st.shared = routed.shared
    const results = W.executePlans(routed.plans, Object.assign({ P: P }, ctxRef || {}))
    return { observation: obsList[0], observations: obsList, events: allEvents, plans: routed.plans, results: results }
  }

  /** 兼容入口：单条视信号（测试与旧调用方） */
  function perceive(P, signal) {
    return perceiveAll(P, [{ sensor: 'vision', signal: signal }])
  }

  function describePlans(plans, results) {
    const byEvent = {}
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (!byEvent[r.eventId]) byEvent[r.eventId] = []
      byEvent[r.eventId].push(r)
    }
    const parts = []
    for (let i = 0; i < plans.length; i++) {
      const p = plans[i]
      const kinds = p.contributors.map(function (c) { return c.kind + '(' + c.topic + ')'; }).join('+')
      let s = kinds + ' | '
      const rs = []
      for (let j = 0; j < results.length; j++) {
        if (results[j].reactionId === p.reactionId) rs.push(results[j])
      }
      if (!rs.length) {
        s += p.throttled ? 'express:' + p.throttled : 'no-channel'
      } else {
        s += rs.map(function (r) {
          let t = r.channel + ':' + (r.result.ok ? 'ok' : (r.result.reason || r.result.skipped))
          if (r.channel === 'express' && r.result.expression) {
            const ex = r.result.expression
            t += '[' + (ex.candidate || ex.reason || '?') + ']'
          }
          return t
        }).join(' ')
      }
      parts.push(s)
    }
    return parts.join(' ; ')
  }

  function logOut(out) {
    if (!out || !out.events.length) return
    const obsLabel = out.observations.map(function (o) {
      return o.source + ' ' + SENSORS[o.source].label(o.payload)
    }).join(' + ')
    console.log('perception: ' + obsLabel + ' → ' + describePlans(out.plans, out.results))
  }

  /** 单一定时器：所有传感器共享（每传感器按自己的间隔采样） */
  function start(P, ctx) {
    ensureState(P)
    if (ctx) ctxRef = ctx
    if (timer) return
    timer = setInterval(function () { tickAll(P) }, BASE_TICK_MS)
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null }
    lastPoll = {}
  }

  async function tickAll(P) {
    ensureState(P)
    if (!P.perceptionConfig.enabled) return null
    const now = Date.now()
    const sensors = P.perceptionConfig.sensors || {}
    const items = []
    const ids = Object.keys(SENSORS)
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const cfg = sensors[id]
      if (!cfg || cfg.enabled === false) continue
      const iv = Number(cfg.intervalMs) || 30000
      if (now - (lastPoll[id] || 0) < iv) continue
      lastPoll[id] = now
      if (!window.pet || typeof SENSORS[id].poll !== 'function') continue
      try {
        const signal = await SENSORS[id].poll()
        if (signal) items.push({ sensor: id, signal: signal })
      } catch (err) {
        console.log('perception: sensor ' + id + ' err ' + (err && err.message))
      }
    }
    if (!items.length) return null
    const out = perceiveAll(P, items)
    logOut(out)
    return out
  }

  /** 兼容入口：只采视（旧测试） */
  async function tick(P) {
    ensureState(P)
    if (!P.perceptionConfig.enabled) return null
    if (!window.pet || typeof window.pet.getForegroundApp !== 'function') {
      console.log('perception: no api')
      return null
    }
    try {
      const fg = await window.pet.getForegroundApp()
      if (!fg || !fg.app) { console.log('perception: no fg'); return null }
      const out = perceive(P, fg)
      logOut(out)
      return out
    } catch (err) {
      console.log('perception: err ' + (err && err.message))
      return null
    }
  }

  window.PresencePipeline = {
    SCHEMA_VERSION: 2,
    BASE_TICK_MS: BASE_TICK_MS,
    SENSORS: SENSORS,
    DEFAULT_CONFIG: window.PresenceState.DEFAULT_CONFIG,
    DEFAULT_SHARED: window.PresenceState.DEFAULT_SHARED,
    DEFAULT_VISION: window.PresenceState.DEFAULT_VISION,
    DEFAULT_HEARING: window.PresenceState.DEFAULT_HEARING,
    DEFAULT_STATE: window.PresenceState.defaultState(),
    ensureState: ensureState,
    perceive: perceive,
    perceiveAll: perceiveAll,
    tick: tick,
    tickAll: tickAll,
    start: start,
    stop: stop,
  }
})()
