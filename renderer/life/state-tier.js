/* 状态分档（v0.4 §4）：读取真实状态，产出任务专属的候选偏好与数据描述。
 * 原则：temperature 只控制采样随机性，不是情绪/人格开关；状态以**数据**进 prompt，不为每档写人设提示词。
 * 纯函数、零 IO；宠物需要值为0..100，emotion.values为0..1，缺项保持未知。 */
(function () {
  'use strict'

  function pick(obj, keys, dflt) {
    const o = obj || {}
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(100, v))
    }
    return dflt
  }

  /* 生成本轮状态快照（冻结用，调用方在一轮开始时取一次） */
  function snapshot(stateLike, emotion) {
    const happiness = emotion && emotion.values && emotion.values.happiness
    return {
      energy: pick(stateLike, ['energy', '精力'], null),
      fullness: pick(stateLike, ['satiety', 'fullness', '饱腹'], null),
      // thirst is the water reserve in pet stats: drinking increases it (0..100).
      hydration: pick(stateLike, ['thirst', 'hydration', '水分'], null),
      mood: typeof happiness === 'number' && Number.isFinite(happiness) ? Math.max(0, Math.min(1, happiness)) * 100 : null
    }
  }

  /* 任务分档：返回 { preferKinds, note }
   * preferKinds：希望决策层偏向的活动/话题形态（数据建议，不是硬指令）
   * note：给决策 prompt 的一行数据描述（不写人设、不写情绪化台词） */
  function tierFor(task, snap) {
    const s = snap || snapshot(null)
    const lowEnergy = s.energy != null && s.energy < 40
    const out = { preferKinds: [], note: '' }
    if (lowEnergy) {
      out.preferKinds.push('quiet_rest')
    }
    const value = v => v == null ? '未知' : v
    const bits = ['精力 ' + value(s.energy), '心情 ' + value(s.mood), '饱腹 ' + value(s.fullness), '水分 ' + value(s.hydration)]
    out.note = '状态：' + bits.join(' / ') + (lowEnergy ? '（偏累，倾向轻负担）' : '')
    return out
  }

  /* 给 prompt 的数据行（描述现状，不是台词） */
  function describe(tier) {
    if (!tier) return ''
    return '【状态分档】' + (tier.note || '') + (tier.preferKinds.length ? '；建议倾向：' + tier.preferKinds.join('、') : '')
  }

  try {
    window.StateTier = { snapshot: snapshot, tierFor: tierFor, describe: describe }
  } catch (e) { /* ignore */ }
})()
