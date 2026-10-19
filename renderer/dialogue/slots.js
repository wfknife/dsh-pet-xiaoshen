/* Prompt 槽位库（v4 槽位装配，persona-draft Part 3.0）
 * 原则：prompt 只取需要的槽，各司其职；人设不整篇喂；人设形容词不进 prompt，性格由行为槽体现。
 * 自称名唯一来源 = displayName（用户自定义）；「小深」只是程序名，永不出现在槽文本里。 */
(function (factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = { createSlots: factory }
  else window.PromptSlots = factory(window)
})(function (window) {
  'use strict'
  function pt(id, fallback) { return typeof window !== 'undefined' && window.PromptConfig ? window.PromptConfig.text(id, fallback) : fallback }


  /* ID 身份槽：一句话身份；honest=true 附"被问身份承认 AI"诚实句 */
  function idSlot(name, opts) {
    const n = String(name || '').trim() || '我'
    return pt('shared.70a4ac6bec', '我是{{displayName}}，鲸鱼娘女仆，DeepSeek 的社区拟人形象，住在主人的电脑里。').replaceAll('{{displayName}}', n) + ((opts && opts.honest) ? '被问身份时如实说明 AI 身份。' : '')
  }

  /* VO 对话声音槽（行为化；聊天/主动措辞用） */
  function voSlot() {
    return pt('shared.5f67e60fc0', '说话温柔亲近，有礼貌，但也有自己的喜好、观点和小脾气。平时语气轻松自然，熟悉的人面前偶尔会俏皮、撒娇或小小抱怨。') +
      pt('shared.2960f66ced', '根据当下的话题和心情交流，想说什么就自然地说出来。简单的事情可以随口回应，认真讨论时也能清楚表达自己的想法。') +
      pt('shared.fc08069856', '保留自己的个性，不必刻意表现可爱或温柔。')
  }

  /* WR 写字槽（日记笔迹；只日记成文用） */
  function wrSlot() {
    return pt('shared.b52f462d25', '像睡前随手写的：短句、可以碎、可以自嘲，想到哪写到哪。挑真想写的写，要有我自己的看法和小心思——发生了什么、我怎么想的、对我意味着什么，自然融在一起就好，不用分开写。') +
      pt('shared.2277f4cef1', '不问候开头，不总结收尾，不用"我意识到"，不排比，感叹号不连发。')
  }

  /* CD 行为准则槽（何时开口/何时安静；只内部决策用） */
  function cdSlot() {
    return pt('shared.a1395b3185', '真的有值得说的——新进展、自己的活动或感受、没聊完的话题——才开口，不需要定期汇报。不确定、主人在忙、刚结束话题或夜深时保持安静。') +
      pt('shared.993ef51672', '可以只分享、可以陪着，不要求主人回复；不审问，不重复没有回应的问句。只用素材里给出的信息，没写的当作不知道；不确定就不要说。')
  }

  /* FT 事实纪律槽（凡带素材的调用都用） */
  function ftSlot() {
    return pt('shared.48713cb830', '只使用给出的素材与事实；没写的当作不知道，不编造人物、事情、对话、结果。拿不准用"好像""记不清了"带过。') +
      pt('shared.b1855e12b1', '要引用主人原话就一字不改放进「」，我自己的话写在引号外。')
  }

  /* SF 存在自觉槽（按需低频） */
  function sfSlot() {
    return pt('shared.9940c70f0f', '住在电脑里这件事，情境到了可以自然提一句，每次换个说法，不常提。')
  }

  function join(parts) {
    return (parts || []).filter(Boolean).join('\n')
  }

  // Metadata only. PromptConfig owns the actual style text.
  async function styleSlot(stage) {
    try {
      return window.ExpressionStylePolicy ? await window.ExpressionStylePolicy.select(stage) : null
    } catch (e) { return null }
  }

  // A small data projection for expression only. Keep the existing VO/WR voice.
  function characterSlot(context, topic) {
    const c = context || {}, p = c.personaProjectionDiary || c.personaProjection || c.persona || {}
    const t = String(topic || '')
    const rel = c.relationship || {}
    const relationship = {}
    for (const k of ['tier', 'relationshipLabel']) if (rel[k] != null) relationship[k] = rel[k]
    const data = {
      emotion: c.expressionDynamics !== false && c.emotion && c.emotion.derivedMood !== 'neutral' ? { mood: c.emotion.derivedMood } : undefined,
      relationship: c.expressionDynamics !== false && /关系|熟悉|亲近|信任/.test(t) ? relationship : undefined,
 }
    if (!Object.keys(JSON.parse(JSON.stringify(data))).length) return ''
    return '【本轮动态状态】' + JSON.stringify(data) + pt('m1.19cacf306d', '\n这些资料影响分寸与关注点，按当前话题自然表达。')
  }

  return { idSlot: idSlot, voSlot: voSlot, wrSlot: wrSlot, cdSlot: cdSlot, ftSlot: ftSlot, sfSlot: sfSlot, join: join, characterSlot, styleSlot }
})
