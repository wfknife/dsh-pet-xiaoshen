/* LifeForegroundObservation — F0 活动感知保真度 · 前台变化观察旁路（第一阶段）
 *
 * 目标：只记录"某一时刻，感知到前台从 A 变成 B"这一**保真事实**，
 * 把 F0 segment 目前丢掉的现实信息（同类别切换 / <5min 变化 / 进行中 / 具体进程身份）先保存下来。
 *
 * 边界（**独立旁路，零消费**）：
 *   - 不是用户行为判断 / 活动意义 / 情绪 / 选择 / 自主行为——禁止把 foreground change 解释成"用户进行了某项活动"
 *   - 本模块不被 F1/F2/F3/F4/F6/F7 任何一层读取（新旁路存在 ≠ 旧系统开始消费）
 *   - 不进 experiences / ledger / facts / events / emotion / relationship 顶层区——独立顶层区 foregroundObservations
 *   - 零 I/O、零网络、零 AI、零真实时钟（ts 必须注入）；纯函数
 *
 * 数据来源约束：
 *   - 生产链路 = perception vision E1_app_switch 的真实 foreground 检测结果（writers 旁挂喂入）
 *   - 禁止从 pet.log 文本反解析 / express 结果 / AI 输出 / F1 结果 / F4 choice 反推
 *
 * 时间精度（**硬声明**）：
 *   - vision 采样 intervalMs=30000 ⇒ ts 是"采样观测时刻"，精度约 ±30 秒
 *   - 每条记录携带 tsPrecisionMs=30000；禁止把它伪装成毫秒级真实发生时间
 *
 * 边界处理：
 *   - 自进程（注入的 SELF_PROCESS_NAMES，与 main.js isSelfProcess 同口径）⇒ 拒绝写入，且不推进 lastTo（折叠）
 *   - 锁屏（LockApp.exe）⇒ 记录但打 special='lock-screen' 区分；不得标成"用户活动"，不得赋予任何离开/返回类行为意义
 *   - 无前台（app 为空）⇒ 拒绝；不定义成某种活动事件（与现有 !appName 跳过采样行为一致）
 *   - 重复：只记录变化（to === lastTo 拒）；eventId 去重；eventId 由 source+ts+foreground identity 构成，禁数组序号
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeForegroundObservation = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const STORE_VERSION = 'life-fg-obs-store/1'
  const SOURCE = 'perception-vision'      // E1_app_switch 的感知来源（稳定身份成分之一）
  const TS_PRECISION_MS = 30000            // 声明：约 ±30 秒（vision.intervalMs）
  const MAX_ENTRIES = 200                  // 有限容量：超出只保留最新 N 条（同 experiences 的 slice(-MAX) 做法）
  const LOCK_APPS = ['lockapp']            // 锁屏前台进程（categoryKeyOf 归一：小写去 .exe）

  // 与 main.js categoryKeyOf 同口径：小写 + 去 .exe
  function categoryKeyOf(appName) {
    return String(appName || '').toLowerCase().replace(/\.exe$/, '')
  }

  /* 稳定 eventId：source + ts + foreground identity（from>to）——不依赖数组位置/序号，
     同一变化（同 ts 同 from 同 to）重放 ⇒ 同 id ⇒ 去重；重新加载/裁剪后按字段重算不变。 */
  function eventIdOf(r) {
    const ts36 = Number(r.ts).toString(36)
    const from = r.from ? categoryKeyOf(r.from) : 'none'
    const to = categoryKeyOf(r.to)
    return 'fgo:' + String(r.source || SOURCE) + ':' + ts36 + ':' + from + '>' + to
  }

  function isLockScreen(app) {
    const k = categoryKeyOf(app)
    return LOCK_APPS.indexOf(k) >= 0
  }

  /* 自进程判定：注入 selfNames（生产 = main.js 的 SELF_PROCESS_NAMES），与 isSelfProcess 同口径。
     未注入 ⇒ 不做自进程过滤（测试/最小场景）；生产链路必须注入。 */
  function isSelfApp(app, selfNames) {
    if (!Array.isArray(selfNames) || !selfNames.length) return false
    const k = categoryKeyOf(app)
    return selfNames.some(function (n) { return categoryKeyOf(n) === k })
  }

  /* 构造一条观察记录（校验 + 分类 + 稳定身份 + 精度声明）。
     input: { ts, to, from, category, source?, gap? }
     opts:  { selfNames?: string[] }
     gap=true（2026-09-23 断档保真）：来自"观测流中断 ≥30min 后重新观察到前台"的信号（E5 贡献者，
       kind 仅作匹配，其命名不进入任何字段）⇒ from **强制 null**（前态未知），不信任调用方传入的 from。
     ⇒ { ok: true, record } | { ok: false, reason } */
  function buildRecord(input, opts) {
    const i = input || {}
    const o = opts || {}
    const ts = Number(i.ts)
    if (!Number.isFinite(ts) || ts <= 0) return { ok: false, reason: 'bad_ts' }
    const to = String(i.to || '')
    if (!to) return { ok: false, reason: 'no-foreground' }     // 无前台窗口：不写、不解释
    if (isSelfApp(to, o.selfNames)) return { ok: false, reason: 'self-process' } // 自进程：不写、不作 to
    const gap = i.gap === true
    const from = gap ? null : (i.from ? String(i.from) : null)
    const record = {
      eventId: '',           // 先占位后填（字段构成见 eventIdOf）
      ts: ts,
      tsPrecisionMs: TS_PRECISION_MS,
      source: String(i.source || SOURCE),
      from: from,
      to: to,
      category: String(i.category || ''),
      special: isLockScreen(to) ? 'lock-screen' : null
    }
    record.eventId = eventIdOf(record)
    return { ok: true, record: record }
  }

  /* 规范化存储区（旧数据没有 foregroundObservations 顶层区 ⇒ 安全按空集合处理，禁止伪造默认事件填充） */
  function createStore(raw) {
    const s = raw && typeof raw === 'object' ? raw : {}
    return {
      version: String(s.version || STORE_VERSION),
      entries: Array.isArray(s.entries) ? s.entries.slice() : [],
      lastTo: typeof s.lastTo === 'string' && s.lastTo ? s.lastTo : null
    }
  }

  /* 追加（唯一写入口的纯内核）：
     ① 变化判定：to === lastTo ⇒ 同一前台状态持续 ⇒ 拒（只记录变化）
     ② eventId 去重：同 id 重放 ⇒ 拒
     ③ 容量：按 ts 升序裁剪，只保留最新 MAX_ENTRIES 条
     opts.gap=true（断档首态）：from 必须为 null（与 buildRecord 一致），跳过 from-mismatch 链校验
       与 no-change 判定——断档后重新观察到前台本身就是事实（即便与 lastTo 同名，如自进程折叠后的边角），
       eventId 去重仍然生效，不产生重复。
     ⇒ { ok, store, duplicate? , reason? } */
  function append(store, record, opts) {
    const o = opts || {}
    const gap = o.gap === true
    const st = createStore(store)
    const expectedFrom = o.from !== undefined ? o.from : st.lastTo
    if (!record || !record.eventId) return { ok: false, reason: 'bad_record' }
    if (gap) {
      if (record.from !== null) return { ok: false, reason: 'gap-must-be-null-from' }
    } else if ((record.from || null) !== (expectedFrom || null)) {
      // from 必须与链一致（调用方用 store.lastTo 构造；不一致说明状态错位）
      return { ok: false, reason: 'from-mismatch' }
    }
    if (!gap && st.lastTo && categoryKeyOf(record.to) === categoryKeyOf(st.lastTo)) {
      return { ok: false, reason: 'no-change' }
    }
    if (st.entries.some(function (x) { return x && x.eventId === record.eventId })) {
      return { ok: true, store: st, duplicate: true, reason: 'duplicate-eventId' }
    }
    let entries = st.entries.concat([record])
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice().sort(function (a, b) {
        return (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0)
      }).slice(-MAX_ENTRIES)
    }
    return {
      ok: true,
      store: { version: st.version, entries: entries, lastTo: String(record.to) },
      duplicate: false
    }
  }

  /* 断链：断档信号到达时使 lastTo 失效 ⇒ 下一条记录 from=null（新链起点）。
     纯函数：entries 不动，只置 lastTo=null。changed=false 表示本就断开（幂等，无需写盘）。 */
  function breakChain(store) {
    const st = createStore(store)
    if (st.lastTo === null) return { ok: true, changed: false, store: st }
    return { ok: true, changed: true, store: { version: st.version, entries: st.entries, lastTo: null } }
  }

  return {
    STORE_VERSION,
    SOURCE,
    TS_PRECISION_MS,
    MAX_ENTRIES,
    LOCK_APPS,
    categoryKeyOf,
    eventIdOf,
    isLockScreen,
    isSelfApp,
    buildRecord,
    createStore,
    append,
    breakChain
  }
})
