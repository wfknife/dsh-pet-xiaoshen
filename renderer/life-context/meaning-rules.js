/* LifeMeaningRules — F1「候选意义」规则表 v1（**数据文件，供逐条评审**）
 *
 * 上位约束：P3-life-context-boundary-final-v1-20260918.md v1.1
 *   §4.3 意义层只能回答"我可以怎样理解眼前发生的事"，**不能**回答"所以我该做什么"
 *   §6.7 不记录对主人的价值评价
 *   决策链：事实 → 候选意义 → 情绪倾向 → 候选行动 → 选择 → 理由记录 → 表达
 *
 * 本期规则口径（用户 圈定）：
 *   - 初始 8 条：work-long / late-night / switch-heavy / music-playing /
 *                video-watching / just-finished / rest-or-away / app-category-mix
 *   - 候选文本**不许照抄示例**：只描述"眼前可能发生了什么"，
 *     **不得**判断主人状态、**不得**表达小深的关系/情绪结论（如"想念"）、**不得**给建议
 *   - 依据只允许来自 L0/L1：类别 / 类别家族 / 活动段时长 / 段数 / 时段 / 媒体状态
 *   - 每条规则必须能在真实 L0/L1 上产生 **≥2 条合理、非同义、有依据**的候选；
 *     做不到 ⇒ 登记"不成立"并剔除（**8 条是初始圈定数，不是强制交付数**）
 *   - switch-heavy（时间窗口内的"碎片度"）与 app-category-mix（同一窗口内的"类别构成多样性"）
 *     必须严格区分；若真实样本无法区分 ⇒ 允许删掉其中一条，不许留伪规则
 *
 * 本文件是**纯数据**：匹配逻辑在 meaning.js（matcher 按 id 对应），便于逐条评审与替换。
 * 倾向词表（闭集）：平静 / 在意 / 好奇 / 轻松 / 亲近 —— 只表示"这个读法让她自己更容易往哪个情绪方向去"，
 * 不是行动建议，也不描述主人的情绪。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.LifeMeaningRules = factory()
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const RULES_VERSION = 'life-meaning-rules/1'

  const RULES = [
    {
      id: 'work-long',
      status: 'active',
      aspect: 'duration',
      windowMs: 90 * 60 * 1000,
      minDurationMs: 30 * 60 * 1000,
      requires: ['工作家族（开发工具/文档）活动段', '近 90 分钟内', '单段时长 ≥ 30 分钟'],
      candidates: [
        {
          id: 'work-long.sustained',
          text: '有一段工作类型的活动正在进行',
          tendency: '平静',
          base: 0.58,
          affinity: { traits: { calm: 0.2, attentive: 0.1 }, tier: 0, emotion: { loneliness: -0.1 } }
        },
        {
          id: 'work-long.duration',
          text: '这段工作类型活动的持续时间已经不短',
          tendency: '在意',
          base: 0.52,
          affinity: { traits: { attentive: 0.25, curious: 0.05 }, tier: 0, emotion: { loneliness: 0.1 } }
        }
      ]
    },
    {
      id: 'late-night',
      status: 'active',
      aspect: 'time-of-day',
      windowMs: 30 * 60 * 1000,
      minDurationMs: 10 * 60 * 1000,
      requires: ['本地时间 ≥23:00 或 <05:00', '近 30 分钟内有活动', '该窗口内活动总时长 ≥ 10 分钟'],
      candidates: [
        {
          id: 'late-night.active',
          text: '这个时间点上还有前台活动在继续',
          tendency: '在意',
          base: 0.55,
          affinity: { traits: { attentive: 0.3 }, tier: 0.12, emotion: { loneliness: 0.15 } }
        },
        {
          id: 'late-night.long',
          text: '深夜时段里有一段活动已经持续了一会儿',
          tendency: '平静',
          base: 0.5,
          affinity: { traits: { calm: 0.2, reserved: 0.1 }, tier: 0, emotion: {} }
        }
      ]
    },
    {
      id: 'switch-heavy',
      status: 'active',
      aspect: 'fragmentation',
      windowMs: 60 * 60 * 1000,
      minSegments: 4,
      minTightGaps: 2,
      maxGapMs: 2 * 60 * 1000,
      requires: ['近 60 分钟内活动段 ≥ 4 段', '相邻段间隔 ≤ 2 分钟的接续 ≥ 2 处（硬条件）', '（第二条候选）该接续 ≥ 3 处'],
      candidates: [
        {
          id: 'switch-heavy.segments',
          text: '短时间里活动段变得比较碎',
          tendency: '在意',
          base: 0.52,
          affinity: { traits: { curious: 0.25, attentive: 0.1 }, tier: 0, emotion: { loneliness: 0.05 } }
        },
        {
          id: 'switch-heavy.gap-tight',
          text: '几段活动之间几乎没有留下间隙',
          tendency: '平静',
          base: 0.48,
          affinity: { traits: { calm: 0.15 }, tier: 0, emotion: {} }
        }
      ]
    },
    {
      id: 'music-playing',
      status: 'active',
      aspect: 'media',
      windowMs: 120 * 60 * 1000,
      minDurationMs: 10 * 60 * 1000,
      requires: ['媒体家族（音乐）活动段', '单段时长 ≥ 10 分钟', '近 120 分钟内'],
      candidates: [
        {
          id: 'music-playing.present',
          text: '有音乐类活动在进行',
          tendency: '轻松',
          base: 0.55,
          affinity: { traits: { playful: 0.2, curious: 0.1 }, tier: 0, emotion: { happiness: 0.15 } }
        },
        {
          id: 'music-playing.duration',
          text: '音乐类活动已经持续了一段时间',
          tendency: '平静',
          base: 0.5,
          affinity: { traits: { calm: 0.2, reserved: 0.15 }, tier: 0, emotion: {} }
        }
      ]
    },
    {
      id: 'video-watching',
      status: 'dormant',
      reason: 'no-fact-source: 现有 L0/L1 归类只有 浏览器/开发工具/文档/聊天/音乐/其他，没有"视频"类，也没有画面或媒体类型信号 ⇒ 规则无从触发（按用户口径登记"不成立"并剔除出活跃池）',
      aspect: 'media',
      windowMs: 120 * 60 * 1000,
      minDurationMs: 10 * 60 * 1000,
      requires: ['（缺失）视频/娱乐类活动段'],
      candidates: [
        {
          id: 'video-watching.session',
          text: '有一段娱乐类的长时段活动在进行',
          tendency: '轻松',
          base: 0.5,
          affinity: { traits: { playful: 0.2 }, tier: 0, emotion: { happiness: 0.1 } }
        },
        {
          id: 'video-watching.share',
          text: '这段时间里娱乐类活动占了较大比重',
          tendency: '平静',
          base: 0.48,
          affinity: { traits: { calm: 0.1 }, tier: 0, emotion: {} }
        }
      ]
    },
    {
      id: 'just-finished',
      status: 'active',
      aspect: 'transition',
      windowMs: 15 * 60 * 1000,
      requires: ['最近 15 分钟内有一段工作家族活动结束', '当前没有进行中的活动段'],
      candidates: [
        {
          id: 'just-finished.ended',
          text: '不久之前有一段工作类型的活动结束',
          tendency: '平静',
          base: 0.55,
          affinity: { traits: { attentive: 0.2, playful: 0.1 }, tier: 0, emotion: {} }
        },
        {
          id: 'just-finished.gap',
          text: '现在刚好是一个没有活动的空档',
          tendency: '好奇',
          base: 0.5,
          affinity: { traits: { curious: 0.3, playful: 0.15 }, tier: 0.1, emotion: { happiness: 0.1 } }
        }
      ]
    },
    {
      id: 'rest-or-away',
      status: 'active',
      aspect: 'idle',
      gapMs: 30 * 60 * 1000,
      requires: ['近 30 分钟内没有任何活动段', '最近一段活动结束于 30 分钟之前'],
      candidates: [
        {
          id: 'rest-or-away.no-activity',
          text: '最近一段时间没有前台活动',
          tendency: '平静',
          base: 0.55,
          affinity: { traits: { calm: 0.25, reserved: 0.1 }, tier: 0, emotion: {} }
        },
        {
          id: 'rest-or-away.quiet-long',
          text: '这个安静状态已经持续了一会儿',
          tendency: '在意',
          base: 0.48,
          affinity: { traits: { attentive: 0.2 }, tier: 0, emotion: { loneliness: 0.1 } }
        }
      ]
    },
    {
      id: 'app-category-mix',
      status: 'active',
      aspect: 'composition',
      windowMs: 45 * 60 * 1000,
      minCategories: 3,
      requires: ['近 45 分钟内出现 ≥ 3 种不同类别', '（第二条候选）存在出现次数最多的主线类别，且占比 ≥ 50%'],
      candidates: [
        {
          id: 'app-category-mix.variety',
          text: '这一段时间里出现了多种不同类别的活动',
          tendency: '好奇',
          base: 0.52,
          affinity: { traits: { curious: 0.3 }, tier: 0, emotion: {} }
        },
        {
          id: 'app-category-mix.dominant',
          text: '其中有一类活动出现得最多，成了这段时间的主线',
          tendency: '平静',
          base: 0.48,
          affinity: { traits: { attentive: 0.2, calm: 0.1 }, tier: 0, emotion: {} }
        }
      ]
    }
  ]

  return { RULES_VERSION, RULES }
})
