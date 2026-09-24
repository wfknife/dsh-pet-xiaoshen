/* IdentityBoundary — U1 只读身份边界
 * 单一份欺骗性拟人关键词表，供 DialogueEngine / AIGateway 统一引用。
 * 当前为 U1 子串边界，非完整语义判定；后续 U2 再处理否定/假设句。
 * 只读；不写任何状态、不产生事实、不改变人格。
 */
window.IdentityBoundary = (function () {
  const FORBIDDEN_DECEPTIVE_IDENTITY = [
    '我是真人',
    '我是人类',
    '我是真正的人',
    '我有身体',
    '我有真实身体',
    '我有肉体',
    '我是现实中的人',
    '我真的生活在你的桌面'
  ]

  function isDeceptiveIdentityText(text) {
    const s = String(text || '').toLowerCase()
    return FORBIDDEN_DECEPTIVE_IDENTITY.some((bad) => s.indexOf(bad.toLowerCase()) >= 0)
  }

  return {
    FORBIDDEN_DECEPTIVE_IDENTITY,
    isDeceptiveIdentityText
  }
})()
