/* DiaryDay — single source of truth for the diary-day boundary.
 *
 * A DiaryDay is a local calendar day (YYYY-M-D).
 * diaryTime controls the writing schedule, never the ownership of events.
 *
 * Rules (diaryTime = '23:00'):
 *   22:59 / 23:00 -> current calendar day
 *   00:30 -> the next calendar day
 *
 * Used by:
 *   - main process  (CommonJS require, daily-timeline / segments / events)
 *   - renderer      (window.DiaryDay, pet.js / DiaryEngine)
 *   - tests         (pure functions, no DOM / no Electron)
 *
 * Boundary rules for this file:
 *   - no I/O, no state, no timezone conversion; Date local getters only.
 *   - never throws: invalid input falls back to the default boundary.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.DiaryDay = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_DIARY_TIME = '23:00'

  function pad2(n) { return String(n).padStart(2, '0') }

  function toDate(now) {
    if (now instanceof Date) {
      return Number.isNaN(now.getTime()) ? new Date() : now
    }
    if (typeof now === 'number' && Number.isFinite(now)) {
      const d = new Date(now)
      return Number.isNaN(d.getTime()) ? new Date() : d
    }
    if (typeof now === 'string' && now.trim()) {
      const d = new Date(now)
      return Number.isNaN(d.getTime()) ? new Date() : d
    }
    return new Date()
  }

  /** 'H:MM' / 'HH:MM' / '23:00' -> { hh, mm } (invalid -> default) */
  function parseDiaryTime(diaryTime) {
    const raw = String(diaryTime === undefined || diaryTime === null || diaryTime === '' ? DEFAULT_DIARY_TIME : diaryTime).trim()
    const m = raw.match(/^(\d{1,2}):(\d{1,2})$/)
    if (!m) {
      const d = DEFAULT_DIARY_TIME.split(':')
      return { hh: Number(d[0]), mm: Number(d[1]) }
    }
    let hh = Number(m[1])
    let mm = Number(m[2])
    if (!Number.isFinite(hh) || hh < 0 || hh > 23) hh = 23
    if (!Number.isFinite(mm) || mm < 0 || mm > 59) mm = 0
    return { hh: hh, mm: mm }
  }

  function calendarDateOf(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
  }

  /**
   * resolve(now, diaryTime) -> {
   *   diaryDay, calendarDate, previousDate, diaryTime,
   *   reached, crossed, boundaryMinutes, minutesIntoDay
   * }
   */
  function resolve(now, diaryTime) {
    const d = toDate(now)
    const t = parseDiaryTime(diaryTime)
    const calendarDate = calendarDateOf(d)
    const boundaryMinutes = t.hh * 60 + t.mm
    const minutesOfDay = d.getHours() * 60 + d.getMinutes()
    const reached = minutesOfDay >= boundaryMinutes
    const diaryDay = calendarDate
    return {
      diaryDay: diaryDay,
      calendarDate: calendarDate,
      previousDate: calendarDateOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)),
      diaryTime: pad2(t.hh) + ':' + pad2(t.mm),
      reached: reached,
      crossed: reached,
      boundaryMinutes: boundaryMinutes,
      minutesIntoDay: minutesOfDay,
    }
  }

  /** key(now, diaryTime) -> 'YYYY-M-D' */
  function key(now, diaryTime) {
    return resolve(now, diaryTime).diaryDay
  }

  /** isSame(nowA, nowB, diaryTime) -> boolean */
  function isSame(nowA, nowB, diaryTime) {
    return key(nowA, diaryTime) === key(nowB, diaryTime)
  }

  /** startOf(now) -> local midnight; Date constructors preserve local DST rules. */
  function startOf(now, diaryTime) {
    const r = resolve(now, diaryTime)
    const parts = r.diaryDay.split('-').map(Number)
    return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0)
  }

  // Recover timestamped material from the former evening-to-evening timeline.
  // Old saved diaries are immutable; only the active collector changes schema.
  function timelineForDate(timeline, now) {
    const d = toDate(now), start = startOf(d).getTime()
    const end = Math.min(d.getTime(), new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime())
    const t = timeline && typeof timeline === 'object' ? timeline : {}
    const events = (Array.isArray(t.events) ? t.events : []).filter(e => e && Number(e.ts) >= start && Number(e.ts) <= end)
    const segments = (Array.isArray(t.segments) ? t.segments : []).flatMap(s => {
      if (!s) return []
      // pushSegment stores ISO strings; numeric timestamps remain supported.
      const from = typeof s.start === 'number' ? s.start : Date.parse(s.start)
      const to = typeof s.end === 'number' ? s.end : Date.parse(s.end)
      if (!Number.isFinite(from) || !Number.isFinite(to)) return []
      const a = Math.max(start, from), b = Math.min(end, to)
      return b > a ? [{ ...s, start: typeof s.start === 'number' ? a : new Date(a).toISOString(),
        end: typeof s.end === 'number' ? b : new Date(b).toISOString(), minutes: Math.round((b - a) / 60000) }] : []
    })
    return { ...t, date: calendarDateOf(d), daySchemaVersion: 2, events, segments }
  }

  return {
    DEFAULT_DIARY_TIME: DEFAULT_DIARY_TIME,
    parseDiaryTime: parseDiaryTime,
    resolve: resolve,
    key: key,
    isSame: isSame,
    startOf: startOf,
    timelineForDate,
  }
})
