/* Perception Core · Observation（M0/M1 + H1）
 * 职责：把任意 Sensor 的原始信号转成不可变的 ObservationEvent（事实）。
 * 身份：observationId 供 evidenceRefs / DiaryEvent 引用；source 标识传感器。
 * 边界：本文件不得引用任何 Engine / Writer / Router / Detector。
 */
(function () {
  // 传感器 id 前缀：视 obs-* / 听 aobs-*
  const SENSOR_PREFIX = { vision: 'obs', hearing: 'aobs' }
  let seq = 0

  function localDateKey(ts) {
    const d = new Date(ts)
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  function nextObservationId(sensor, ts) {
    seq += 1
    return (SENSOR_PREFIX[sensor] || 'obs') + '-' + ts.toString(36) + '-' + seq
  }

  function hashOf(str) {
    return window.PresenceHash ? window.PresenceHash.hashOf(str) : ''
  }

  /** createObservation(sensor, signal, prevState) → ObservationEvent | null
   *  signal 由各传感器定义；共享层只补时间维度与 changed。
   *  prevState 为该传感器的状态分片（视：vision / 听：hearing）。 */
  function createObservation(sensor, signal, prevState) {
    if (!signal) return null
    const ts = Date.now()
    const p = prevState || {}
    const payload = Object.assign({}, signal)

    if (sensor === 'vision') {
      if (!payload.app) return null
      payload.app = String(payload.app)
      payload.cat = String(payload.cat || '其他')
      payload.changed = payload.app !== (p.lastApp || '')
    } else if (sensor === 'hearing') {
      // 只保留需要的元数据；标题/歌手仅存在于本条 observation（不落盘）
      payload.app = String(payload.app || '')
      payload.status = String(payload.status || 'Closed')
      payload.playing = payload.status === 'Playing'
      const clean = window.HearingVocab && window.HearingVocab.cleanMediaText
      payload.title = clean ? clean(payload.title) : String(payload.title || '')
      payload.artist = clean ? clean(payload.artist) : String(payload.artist || '')
      payload.album = clean ? clean(payload.album) : String(payload.album || '')
      payload.count = Number(payload.count) || 0
      payload.trackHash = payload.app && payload.title ? hashOf(payload.app + '|' + payload.artist + '|' + payload.title) : ''
      payload.artistHash = payload.artist && payload.title ? hashOf(payload.artist) : ''
      payload.changed = !!payload.trackHash && payload.trackHash !== (p.lastTrackHash || '')
    }

    payload.hour = new Date(ts).getHours()
    payload.dateKey = localDateKey(ts)
    return {
      schemaVersion: 1,
      id: nextObservationId(sensor, ts),
      ts: ts,
      source: sensor,
      confidence: 0.9,
      payload: payload,
    }
  }

  window.PresenceObservation = {
    createObservation: createObservation,
    localDateKey: localDateKey,
    SENSOR_PREFIX: SENSOR_PREFIX,
  }
})()
