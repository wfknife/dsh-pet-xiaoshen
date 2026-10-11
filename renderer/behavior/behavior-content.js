/* BehaviorContent — Phase 15
 * 轻量数据驱动行为定义。当前只迁移一小部分 Idle / Work / Interaction。
 */
window.BehaviorContent = {
  idle: {
    perform: {
      pool: ['idle-lookaround', 'idle-hum', 'idle-float', 'idle-mirror', 'idle-fan', 'idle-stretch', 'idle-bubbles', 'happy-sway'],
      weights: {
        'idle-lookaround': 20, 'idle-hum': 12, 'idle-float': 10, 'idle-mirror': 8,
        'idle-fan': 8, 'idle-stretch': 8, 'idle-bubbles': 6, 'happy-sway': 5
      },
      cooldowns: {
        'idle-mirror': 60000, 'idle-bubbles': 60000, 'happy-sway': 60000
      }
    }
  },
  work: {
    pool: ['work-code', 'work-think'],
    weights: { 'work-code': 80, 'work-think': 20 },
    cooldowns: { 'work-think': 30000 }
  },
  interaction: {
    click: {
      pool: ['click-tsundere', 'click-shy', 'click-tickle', 'click-wave', 'happy-jump'],
      weights: { 'click-tsundere': 20, 'click-shy': 20, 'click-tickle': 20, 'click-wave': 18, 'happy-jump': 10 },
      cooldowns: { 'happy-jump': 30000 }
    }
  },
  intent: {
    seek_attention: {
      pool: ['idle-lookaround', 'idle-hum', 'idle-bubbles', 'happy-sway'],
      weights: { 'idle-lookaround': 30, 'idle-hum': 25, 'idle-bubbles': 20, 'happy-sway': 15 },
      cooldowns: { 'idle-bubbles': 60000, 'happy-sway': 60000 }
    },
    rest: {
      pool: ['sleep-nap', 'tired-yawn', 'idle-breathe'],
      weights: { 'sleep-nap': 50, 'tired-yawn': 30, 'idle-breathe': 20 },
      cooldowns: { 'tired-yawn': 30000 }
    },
    tease_owner: {
      pool: ['click-tsundere', 'click-tickle', 'idle-hum', 'happy-jump'],
      weights: { 'click-tsundere': 35, 'click-tickle': 30, 'idle-hum': 20, 'happy-jump': 15 },
      cooldowns: { 'happy-jump': 30000 }
    },
    celebrate: {
      pool: ['happy-jump', 'happy-sway', 'perform-curtsy'],
      weights: { 'happy-jump': 40, 'happy-sway': 35, 'perform-curtsy': 25 },
      cooldowns: { 'happy-jump': 30000, 'happy-sway': 30000 }
    },
    comfort_owner: {
      pool: ['idle-breathe', 'perform-curtsy', 'idle-hum'],
      weights: { 'idle-breathe': 50, 'perform-curtsy': 30, 'idle-hum': 20 },
      cooldowns: {}
    },
    accompany_owner: {
      pool: ['idle-breathe', 'idle-lookaround', 'idle-hum'],
      weights: { 'idle-breathe': 50, 'idle-lookaround': 30, 'idle-hum': 20 },
      cooldowns: {}
    },
    comment_on_activity: {
      pool: ['idle-hum', 'idle-lookaround', 'idle-bubbles'],
      weights: { 'idle-hum': 40, 'idle-lookaround': 35, 'idle-bubbles': 25 },
      cooldowns: { 'idle-bubbles': 60000 }
    },
    observe_owner: {
      pool: ['idle-lookaround', 'idle-mirror', 'idle-breathe'],
      weights: { 'idle-lookaround': 50, 'idle-mirror': 30, 'idle-breathe': 20 },
      cooldowns: { 'idle-mirror': 60000 }
    }
  }
}
