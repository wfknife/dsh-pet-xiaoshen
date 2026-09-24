// 成就独立窗口：从 pet-state.json 读取数据渲染成就墙
// 成就定义与 renderer/pet.js 的 ACHIEVEMENTS 保持一致（双端同源）
const ACHIEVEMENTS = [
  { id: 'first-work', name: '第一次派活', desc: '完成第一次工作', icon: '💼', check: (p) => p.totalWorkDone >= 1 },
  { id: 'work-10', name: '劳模管家', desc: '累计完成 10 次工作', icon: '🏅', check: (p) => p.totalWorkDone >= 10 },
  { id: 'work-50', name: '金牌劳模', desc: '累计完成 50 次工作', icon: '👑', check: (p) => p.totalWorkDone >= 50 },
  { id: 'gamer-10', name: '游戏达人', desc: '玩 10 局小游戏', icon: '🎮', check: (p) => p.totalGames >= 10 },
  { id: 'gamer-50', name: '游戏狂魔', desc: '玩 50 局小游戏', icon: '🕹️', check: (p) => p.totalGames >= 50 },
  { id: 'pomo-10', name: '专注学徒', desc: '完成 10 个番茄钟', icon: '🍅', check: (p) => p.pomodoros >= 10 },
  { id: 'pomo-50', name: '专注大师', desc: '完成 50 个番茄钟', icon: '🧘', check: (p) => p.pomodoros >= 50 },
  { id: 'streak-3', name: '三日之约', desc: '连续陪伴 3 天', icon: '📅', check: (p) => p.streak >= 3 },
  { id: 'streak-7', name: '一周陪伴', desc: '连续陪伴 7 天', icon: '💞', check: (p) => p.streak >= 7 },
  { id: 'streak-30', name: '不离不弃', desc: '连续陪伴 30 天', icon: '🏆', check: (p) => p.streak >= 30 },
  { id: 'feed-20', name: '干饭人', desc: '投喂 20 次', icon: '🍪', check: (p) => (p.feedCount || 0) >= 20 },
  { id: 'rich-300', name: '小富婆', desc: '金币达到 300', icon: '🪙', check: (p) => p.coins >= 300 },
  { id: 'level-5', name: '晋升之路', desc: '升到 5 级', icon: '⭐', check: (p) => p.level >= 5 },
  { id: 'work-min-60', name: '勤恳女仆', desc: '累计挂机工作 60 分钟', icon: '🧹', check: (p) => (p.workMinutes || 0) >= 60 },
  { id: 'work-min-600', name: '工作狂魔', desc: '累计挂机工作 600 分钟', icon: '⏰', check: (p) => (p.workMinutes || 0) >= 600 },
  { id: 'work-sess-20', name: '敬业员工', desc: '完成 20 次挂机工作', icon: '📋', check: (p) => (p.workSessions || 0) >= 20 },
]

async function main() {
  const grid = document.getElementById('grid')
  const countEl = document.getElementById('count')
  let state = {}
  try {
    state = (await window.pet.stateLoad()) || {}
  } catch (err) {
    countEl.textContent = '读取状态失败：' + (err && err.message)
    return
  }
  grid.innerHTML = '' // 2026-09-17：自动刷新前先清空，避免卡片越叠越多
  const unlocked = state.achievements || []
  const done = ACHIEVEMENTS.filter((a) => unlocked.includes(a.id)).length
  countEl.textContent = '已解锁 ' + done + ' / ' + ACHIEVEMENTS.length
  ACHIEVEMENTS.forEach((a) => {
    const un = !unlocked.includes(a.id)
    const card = document.createElement('div')
    card.className = 'card' + (un ? ' locked' : '')
    const icon = document.createElement('div')
    icon.className = 'icon'
    icon.textContent = a.icon
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = (un ? '🔒 ' : '✅ ') + a.name
    const desc = document.createElement('div')
    desc.className = 'desc'
    desc.textContent = a.desc
    const meta = document.createElement('div')
    meta.className = 'meta'
    if (!un && a.check && typeof a.check === 'function') {
      // 显示当前进度（对数值型成就）
      const progress = a.check(state) ? '已达成' : '未达成'
      meta.textContent = progress
    }
    card.appendChild(icon)
    card.appendChild(name)
    card.appendChild(desc)
    card.appendChild(meta)
    grid.appendChild(card)
  })
}

/* 成就墙自动刷新（原来只在窗口打开时读一次盘，
   打着游戏/工作时看它就是旧进度）。用"已解锁签名"做变更检测，变了才重画。 */
let watchTimer = null
let lastSig = ''
function sigOf(list) { return (list || []).slice().sort().join(',') }

async function tick() {
  try {
    const st = (await window.pet.stateLoad()) || {}
    const sig = sigOf(st.achievements || [])
    if (sig !== lastSig) { lastSig = sig; main() }
  } catch (err) { /* 读失败等下一轮 */ }
}

main().then(() => {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = setInterval(tick, 2500)
})
window.addEventListener('beforeunload', () => { if (watchTimer) clearInterval(watchTimer) })
