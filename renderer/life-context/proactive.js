/* LifeProactive — F7-A 主动联系（**离线纯函数 / 零 I/O / 不拥有任何选择权**）
 *
 * 上位约束：边界定稿 §E（主动联系）+ §5.10（F7 是唯一允许**替换**旧 Presence 的破例）
 * 用户 （施工单 v1.1 §12）：
 *   · R1 **甲**：`seek_attention` **映射**为主动联系唯一合法入口；**不得新增** `reach_owner` 等平行 intent
 *   · R3 **乙**：**"卡已实际呈现、用户未回复、后来被下一张卡替换" ⇒ skipped**；**从未真正呈现 ⇒ 保持 unread**
 *     （**不用纯超时**当略过，不得把"系统时间到了"伪装成"用户略过"）
 *   · 四状态用**新增专用 kind**：`kind = 'proactive-contact'`，`state = unread|viewed|replied|skipped`
 *     ⇒ **不复用** F3 的 `choice/gated/no-op`，不扩张 F3 语义
 *   · **R2**：`capEvent`（喂 `Autonomy.nextCapState`）**只在"真正发起"之后的 skipped/replied 才产生**；
 *     "选中未呈现"与"生成未发出的卡"一律**零事件**
 *   · 开关 / cap / 静默 / ownerBusy / 礼貌 一律是**执行抑制器**，**不是动机来源**：
 *     **F4 没选 `seek_attention` ⇒ 本模块发起数恒为 0**（不得自造第二套"什么时候该联系"的选择器）
 *
 * 本模块**只做三件事**：①执行抑制链判定（真值由调用方注入，不复制 F4 阈值）②四状态状态机（纯迁移）
 * ③把"真正发起/被略过/被回应"整理成可喂给既有 cap 状态机的事件与计数依据。
 * **不写任何状态**（无 I/O、无 require、不碰 window）——落账由 F7-B/C 接线层完成。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeProactive = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const PROACTIVE_VERSION = 'life-proactive/1'
  const CONTACT_KIND = 'proactive-contact'          // 新增专用 kind（F7 专属白名单）
  const STATES = ['unread', 'viewed', 'replied', 'skipped']
  /* PC-2：动作白名单 4 条——**全部取自既有 ASSET_POOL**（autonomy.js:32），
     不新造动作名。R1 甲原意**保留**：仍不得新增 `reach_owner` 之类平行 intent，F4 仍是唯一决策者、F7 仍是唯一抑制链。 */
  const LEGAL_ACTIONS = ['seek_attention', 'comment_on_activity', 'accompany_owner', 'celebrate']
  const PARALLEL_INTENT_FORBIDDEN = ['reach_owner', 'contact_owner', 'initiate_contact', 'proactive_contact_action']

  // 执行抑制器（**顺序固定**；开关最先，其余沿用 F4 `firstBlockingGate` 的次序：静默 > 忙碌 > 礼貌 > **额度** > 间隔）
  // F4-S2-B：第 5 项 `cap-exhausted` → **`no-credit`**（真值＝主动额度，与 autonomy 的 dailyCap **解耦**；
  // 位置不变 ⇒ 仍早于 interval；真值由 orchestrator 每 tick accrue 一次、与 F4 资格前置**同源**）
  /* P0-1c：family-recent＝**F7 本地第 7 槽**（无 F4 对应的主题族闸），置于链尾
     ——前 6 槽保持与 F4 firstBlockingGate 逐槽镜像不变；可见性由 A1 no-present 日志的
     suppressors JSON 保证，不依赖报因顺序。真值由 orchestrator 注入，本模块仍零 I/O 不拥有选择权。 */
  const SUPPRESSOR_ORDER = ['switch-off', 'quiet-hours', 'owner-busy', 'politeness-defer', 'no-credit', 'interval-not-elapsed', 'family-recent']

  const FORBIDDEN_SELECTOR_KEYS = ['choose', 'select', 'decide', 'rank', 'score', 'arbitrate', 'pick', 'motive']
  const FORBIDDEN_WRITE_KEYS = ['write', 'save', 'persist', 'commit', 'applydelta', 'mutate', 'update']
  const FORBIDDEN_SURFACE_KEYS = ['say', 'speak', 'emit', 'dispatch', 'fire', 'notify', 'presence', 'intent', 'act', 'play', 'send', 'run']

  /* P0-1c：主题族键（纯函数）——mem 载体原样；segment 载体按活动类别归并（resolve 查 fact value.cat，
     取不到 ⇒ 回落裸 ref＝旧行为）；其余 ref 原样。供 orchestrator（抑制器真值＋实例盖戳）与
     aigateway CC5（族级卡片）共用，单一来源在本模块。 */
  function familyKeyOf(ref0, resolve) {
    const r = String(ref0 || '')
    if (!r) return null
    if (r.indexOf('f:activity.segment:') === 0 || r.indexOf('tl:segment:') === 0) {
      let cat = null
      try { cat = (typeof resolve === 'function') ? resolve(r) : null } catch (err) { cat = null }
      return cat ? 'act:' + String(cat) : r
    }
    return r
  }
  function instanceId(chosenActionId, nowTs) {
    return 'pc:' + String(chosenActionId || '') + ':' + String(nowTs || 0).toString(36)
  }

  // ① 执行抑制链：**只判"能否呈现"**；前提是 F4 已经选好 seek_attention（否则直接 not-selected）
  function canInitiate(input) {
    const i = input || {}
    const d = i.decision || {}
    if (!d || d.outcome !== 'act' || LEGAL_ACTIONS.indexOf(d.chosenActionId) < 0) {
      return { ok: false, blockedBy: 'not-selected', reason: 'f4 未选择 ' + LEGAL_ACTIONS.join('/') }
    }
    const s = i.suppressors || {}
    const truth = {
      'switch-off': s.switchEnabled === false,
      'quiet-hours': s.quietHours === true,
      'owner-busy': s.ownerBusy === true,
      'politeness-defer': s.politenessDefer === true,
      'no-credit': s.noCredit === true,
      'family-recent': s.familyRecent === true,
      'interval-not-elapsed': s.intervalOk === false
    }
    for (const k of SUPPRESSOR_ORDER) if (truth[k]) return { ok: false, blockedBy: k, reason: 'suppressed:' + k }
    return { ok: true, blockedBy: null, reason: null }
  }

  // ② 状态机（纯迁移；非法迁移一律拒绝，不改状态）
  function present(input) {
    const i = input || {}
    const gate = canInitiate(i)
    if (!gate.ok) return { ok: false, reason: gate.blockedBy, instance: null }
    // 真正呈现：presented 必须由调用方明确报告（"生成卡"≠"卡已呈现"）
    if (i.presented !== true) return { ok: false, reason: 'not-presented', instance: null }
    const nowTs = Number(i.nowTs) || 0
    const openingText = (typeof i.opening === 'string') ? i.opening.trim() : ''
    const topicText = (typeof i.topic === 'string') ? i.topic.trim() : ''
    const inst = {
      id: i.id || instanceId(i.decision.chosenActionId, nowTs),
      kind: CONTACT_KIND,
      state: 'unread',
      chosenActionId: i.decision.chosenActionId,
      entryId: (i.decision && i.decision.entryId) || null,
      family: (typeof i.family === 'string' && i.family.trim()) ? i.family.trim().slice(0, 120) : null, // P0-1c：主题族键（记录与族级去重依据；不参与 F4 判定）
      createdAt: nowTs,
      presentedAt: nowTs,   // **只有这里**才叫"真正发起"
      viewedAt: null,
      repliedAt: null,
      skippedAt: null,
      supersededBy: null,
      /* F4-S5/S6：本次开场（AI 生成或 F6-A fallback）与主题——只做记录与去重依据，不参与任何判定 */
      topic: topicText ? topicText.slice(0, 200) : null,
      opening: openingText ? openingText.slice(0, 200) : null
    }
    return { ok: true, reason: null, instance: inst }
  }

  function view(inst, nowTs) {
    if (!inst || inst.state !== 'unread') return { ok: false, reason: 'illegal-transition', instance: inst || null }
    const out = Object.assign({}, inst, { state: 'viewed', viewedAt: Number(nowTs) || 0 })
    return { ok: true, reason: null, instance: out }
  }

  function reply(inst, nowTs) {
    if (!inst || (inst.state !== 'unread' && inst.state !== 'viewed')) return { ok: false, reason: 'illegal-transition', instance: inst || null }
    const out = Object.assign({}, inst, { state: 'replied', repliedAt: Number(nowTs) || 0 })
    return { ok: true, reason: null, instance: out }
  }

  // R3 乙：**仅**"已呈现(未回复)"的旧卡被下一张替换 ⇒ skipped；**未呈现一律不动**（V13）
  function supersede(inst, byId, nowTs) {
    if (!inst) return { ok: false, reason: 'no-instance', instance: null }
    if (inst.presentedAt === null || inst.presentedAt === undefined) {
      return { ok: true, reason: 'never-presented-stays-' + inst.state, instance: Object.assign({}, inst) }
    }
    if (inst.state !== 'unread') return { ok: true, reason: 'not-skippable:' + inst.state, instance: Object.assign({}, inst) }
    const out = Object.assign({}, inst, { state: 'skipped', skippedAt: Number(nowTs) || 0, supersededBy: byId || null })
    return { ok: true, reason: null, instance: out }
  }

  // ③ 供既有 cap 状态机使用的两份依据（**都只认"真正发起"**）
  function initiatedTimestamps(instances) {
    return (Array.isArray(instances) ? instances : [])
      .filter((x) => x && x.presentedAt !== null && x.presentedAt !== undefined)
      .map((x) => Number(x.presentedAt))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
  }

  // capEvent（喂 Autonomy.nextCapState）：**只有"真正发起之后"的 skipped/replied** 才产生
  function capEventsOf(instances) {
    const out = []
    ;(Array.isArray(instances) ? instances : []).forEach((x) => {
      if (!x || x.presentedAt === null || x.presentedAt === undefined) return   // 未真正呈现 ⇒ 零事件
      if (x.state === 'skipped') out.push({ event: 'ignored', atTs: Number(x.skippedAt) || null, id: x.id || null })
      else if (x.state === 'replied') out.push({ event: 'replied', atTs: Number(x.repliedAt) || null, id: x.id || null })
    })
    return out
  }

  // 状态机的不变量（供接线层与测试断言）
  function assertInvariants(instances) {
    const reasons = []
    ;(Array.isArray(instances) ? instances : []).forEach((x) => {
      if (!x || STATES.indexOf(x.state) < 0) { reasons.push('bad_state:' + (x && x.id)); return }
      if (x.kind !== CONTACT_KIND) reasons.push('bad_kind:' + x.id)
      if (x.state === 'unread' && x.viewedAt) reasons.push('unread_with_viewedAt:' + x.id)
      if (x.state === 'replied' && !x.repliedAt) reasons.push('replied_without_repliedAt:' + x.id)
      if (x.state === 'skipped' && (!x.skippedAt || x.presentedAt === null || x.presentedAt === undefined)) reasons.push('skipped_without_presentedAt:' + x.id)
      if (x.presentedAt !== null && x.presentedAt !== undefined && Number(x.presentedAt) < Number(x.createdAt)) reasons.push('presented_before_created:' + x.id)
    })
    return { ok: reasons.length === 0, reasons: reasons }
  }

  function keysHit(forbidden) {
    // **只检可调用面（导出的函数）**，不检数据常量：常量名会因含 'act'（proACTive/CONTACT/LEGAL_ACTIONS）
    // 或 'intent'（PARALLEL_INTENT_FORBIDDEN）造成假阳性——这是既踩过的"自指陷阱"。
    const all = api || {}
    const keys = Object.keys(all).filter((k) => !/^assert/.test(k) && typeof all[k] === 'function')
    const hits = keys.filter((k) => forbidden.some((f) => k.toLowerCase().indexOf(f) >= 0))
    return { ok: hits.length === 0, hits: hits, keys: keys }
  }
  const assertNoSecondSelector = () => keysHit(FORBIDDEN_SELECTOR_KEYS)
  const assertNoWriteBack = () => keysHit(FORBIDDEN_WRITE_KEYS)
  const assertNoSurface = () => keysHit(FORBIDDEN_SURFACE_KEYS)
  function assertNoParallelIntent() {
    const hits = PARALLEL_INTENT_FORBIDDEN.filter((n) => LEGAL_ACTIONS.indexOf(n) >= 0)
    const allowed = ['seek_attention', 'comment_on_activity', 'accompany_owner', 'celebrate']
    const outside = LEGAL_ACTIONS.filter((n) => allowed.indexOf(n) < 0)
    return { ok: hits.length === 0 && outside.length === 0 && LEGAL_ACTIONS.length === allowed.length, hits: hits, outside: outside, legal: LEGAL_ACTIONS.slice() }
  }
  function assertNoIO() { return { ok: true, io: [], note: 'no require / no fetch / no fs / no window' } }

  const api = {
    PROACTIVE_VERSION,
    CONTACT_KIND,
    STATES,
    LEGAL_ACTIONS,
    PARALLEL_INTENT_FORBIDDEN,
    SUPPRESSOR_ORDER,
    instanceId,
    familyKeyOf,
    canInitiate,
    present,
    view,
    reply,
    supersede,
    initiatedTimestamps,
    capEventsOf,
    assertInvariants,
    assertNoSecondSelector,
    assertNoWriteBack,
    assertNoSurface,
    assertNoParallelIntent,
    assertNoIO
  }
  return api
})
