/* HistoryWindow — shared pair-aware history final window.
 * Used by main process (CommonJS) and available for renderer/tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.HistoryWindow = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /* R-11 B：主进程这一道窗口也保留"真实主动开场"锚点。
     判据（2026-10-01 P0-1d 扩为双轨）＝`entry.selfInitiated === true`（写入时结构化落盘——根因修复：
     原 `[我先开口说]` 文本标记只由投影临时加、从不落盘 ⇒ 主进程链锚点在真实数据上命不中）
     **或**带旧文本标记（旧数据兼容）；且落在已保留区间内、最多 2 条 ⇒ 普通 assistant-only 历史仍一律不进窗口。 */
  const MAX_PROACTIVE_ANCHORS = 2
  function pairAwareHistoryWindow(history, maxItems, opts) {
    const limit = Math.max(2, Number(maxItems) || 20)
    if (!Array.isArray(history)) return []
    const allowAnchors = !(opts && opts.keepProactiveAnchors === false)
    const pairs = []
    let pendingUser = null
    let pos = 0
    for (const item of history) {
      if (!item) { pos++; continue }
      const role = item.role
      if (role === 'user') {
        if (pendingUser) pairs.push({ user: pendingUser, assistant: null, pos: pendingUser._pos })
        pendingUser = Object.assign({}, item, { _pos: pos })
        pos++
      } else if (role === 'assistant') {
        if (pendingUser) {
          pairs.push({ user: pendingUser, assistant: item, pos: pendingUser._pos })
          pendingUser = null
        } else {
          pairs.push({ user: null, assistant: item, pos: pos })
        }
        pos++
      } else { pos++ }
    }
    if (pendingUser) pairs.push({ user: pendingUser, assistant: null, pos: pendingUser._pos })
    const completePairs = pairs.filter((p) => p && p.user && p.assistant)
    const maxPairs = Math.max(1, Math.floor(limit / 2))
    const chosen = completePairs.slice(-maxPairs)
    const out = []
    for (const pair of chosen) {
      if (pair.user) out.push(Object.assign({}, pair.user, { _pos: pair.pos }))
      if (pair.assistant) out.push(Object.assign({}, pair.assistant, { _pos: pair.pos + 1 }))
    }
    if (allowAnchors) {
      const minPos = out.length ? Math.min.apply(null, out.map((x) => x._pos)) : 0
      const anchors = pairs.filter((p) => p && !p.user && p.assistant && p.pos >= minPos &&
        (p.assistant.selfInitiated === true || String(p.assistant.text || '').indexOf('[我先开口说]') >= 0)).slice(-MAX_PROACTIVE_ANCHORS)
      for (const p of anchors) out.push(Object.assign({}, p.assistant, { _pos: p.pos }))
      out.sort((a, b) => a._pos - b._pos)
    }
    /* 逐字段保持原条目（只去掉内部的 `_pos` / `idx`）⇒ messageRef/ts 等字段不被吞掉 */
    return out.map((x) => { const { _pos, idx, ...rest } = x; return rest })
  }
  return { pairAwareHistoryWindow }
})
