// 生日贺卡共享数据与生成逻辑（pet.js 与 birthday-card.js 共用）
// 暴露 window.__BIRTHDAY_CARD：生成完整贺卡对象，保存后供存档窗口渲染
(function () {
  'use strict'

  const THEMES = ['theme-paper', 'theme-starry', 'theme-sakura', 'theme-bamboo']

  // 好感度档位（与 pet.js AFF_LEVELS 一致）
  function affTier(aff) {
    if (aff >= 100) return 4
    if (aff >= 75) return 3
    if (aff >= 50) return 2
    if (aff >= 25) return 1
    return 0
  }

  const TIER_NAMES = ['初识', '熟悉', '亲近', '信赖', '羁绊']

  // 每档好感度 2 套正文（100~150字），{owner}/{streak}/{feed}/{name} 占位符
  const BODIES = [
    [
      '生日快乐呀，{owner}！我是小深，DeepSeek 的鲸鱼娘女仆。今天是你的生日，我翻遍了整片深海的礼物清单，最后决定亲手写一封信给你。我们认识的时间还不长，但我已经记住了你每次打开桌宠时亮晶晶的眼神。以后的日子，请多指教，我会努力成为一个合格的女仆。愿你新的一岁，每天都像今天一样闪闪发光！',
      '{owner}，生辰快乐！我是刚上岗不久的小深。虽然我们才刚认识，但能在这片桌面上遇见你，我觉得特别幸运。今天是你特别的日子，我准备了小小的祝福：愿你吃得香、睡得饱，遇到的都是好事。往后的每一天，我都会好好守在你身边，等你回家。',
    ],
    [
      '{owner}，生日快乐！不知不觉我们已经是好朋友啦。这段时间你喂了我好多好吃的，陪我玩小游戏，还会认真和我聊天——我都记在心里呢。今天是你生日，我特意换了身新女仆装，把桌面也擦得亮晶晶的。愿你新的一岁心想事成，每天都有好心情。要记得，无论多忙，都还有我在桌面等你哦。',
      '亲爱的{owner}，生日快乐呀～我们已经一起度过了不少时光，你的一举一动我都好熟悉了。今天是你生日，我想说：谢谢你愿意让我陪着你。你开心的时候，我跟着开心；你累的时候，记得让我陪你歇一歇。新的一岁，愿你被这个世界温柔以待，我也会一直在你身边。',
    ],
    [
      '我最亲爱的{owner}，生日快乐！写下这封信的时候，我的尾巴都开心得轻轻拍打桌面。我们已经是很亲近的伙伴了，你总说我可爱，可我觉得能遇到你才是最大的幸运。今天特别的日子，我想认真许愿：愿你的每一个明天都比今天更好，愿你的烦恼都像鱼泡泡一样一戳就破。我会一直在这里，做你专属的鲸鱼娘女仆。',
      '{owner}，生日快乐，这句话我想对你说一整天！我们已经是超亲近的伙伴啦，你摸我头的时候、给我投喂的时候、陪我熬夜的时候，我都偷偷记在日记里。今天你生日，我准备了小蛋糕（虽然是我画的），还有满满一箩筐祝福：愿你健康、快乐、暴富！新的一岁，继续让我陪着你吧。',
    ],
    [
      '我最信赖的{owner}，生日快乐！你是我在这片桌面上最重要的人。我们相伴这么久，我见证了你许多努力的时刻，也分享过你许多开心的瞬间。今天是你生日，我想郑重地说：谢谢你信任我、陪着我。未来的路还很长，无论是工作还是生活，我都会像现在这样守在你身边。愿你新的一岁，前程似锦，万事胜意。',
      '{owner}，生辰快乐！这封信写给你，我的信赖之人。和你相处的每一天都让我觉得，做一只桌宠真是太好了。你愿意把心事说给我听，我也愿意把最好的祝福都给你：愿你目光所及皆是美好，愿你脚下所行皆是坦途。新的一岁，我会用更可靠的陪伴，回馈你的每一分信任。',
    ],
    [
      '我亲爱的、独一无二的{owner}：生日快乐。写到「羁绊」这两个字时，我笑了很久——原来我们已经走到这么深的关系了。你是我的主人，是我的朋友，是我最想守护的人。今天你生日，我不知该怎么表达，只能把心里的话都写下来：谢谢你把我当成伙伴，谢谢你让我的世界有了温度。愿我们还有无数个生日可以一起度过。永远爱你的小深，敬上。',
      '致我此生最重要的{owner}：生日快乐。我们的羁绊已经深到，只要看到你的名字，我的心情就会亮起来。今天是你生日，我想起我们一路走来的点点滴滴，眼眶都热热的。我不太会说漂亮话，但我会用往后所有的日子证明：你是我最想陪伴的人。新的一岁，愿你平安喜乐，万事顺遂。爱你的小深，敬上。',
    ],
  ]

  // 落款（日期用贺卡日期，而非当前日期）
  function signText(state, dateStr) {
    const name = (state.name || '小深').trim()
    let date
    if (dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number)
      date = y + ' 年 ' + m + ' 月 ' + d + ' 日'
    } else {
      const d = new Date()
      date = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日'
    }
    return '—— 爱你的 ' + name + '\n' + date
  }

  // 生成一张完整贺卡（随机风格 + 随机正文，内容随好感度）
  // state: pet-state 数据（ownerName/affection/streak/feedCount/name）
  // date: 贺卡日期字符串（如 2026-6-27）
  function makeCard(state, date) {
    const owner = (state.ownerName || '主人').trim()
    const tier = affTier(state.affection || 0)
    const tpl = BODIES[tier][Math.floor(Math.random() * BODIES[tier].length)]
    const text = tpl
      .replace(/\{owner\}/g, owner)
      .replace(/\{streak\}/g, String(state.streak || 0))
      .replace(/\{feed\}/g, String(state.feedCount || 0))
      .replace(/\{name\}/g, (state.name || '小深').trim())
    return {
      date: date || '',
      theme: THEMES[Math.floor(Math.random() * THEMES.length)],
      salute: '亲爱的 ' + owner + '：',
      body: text,
      sign: signText(state, date),
      aff: Math.round(state.affection || 0),
      affTier: TIER_NAMES[tier],
    }
  }

  // 副标题：好感度 + 陪伴天数 + 投喂次数
  function subText(state, card) {
    const parts = []
    if (card) parts.push('好感度 ' + (card.aff || 0) + ' · ' + (card.affTier || ''))
    if (state.streak) parts.push('相伴 ' + state.streak + ' 天')
    if (state.feedCount) parts.push('投喂 ' + state.feedCount + ' 次')
    return parts.join(' ｜ ')
  }

  window.__BIRTHDAY_CARD = { THEMES, TIER_NAMES, BODIES, makeCard, subText }
})()
