// 生日贺卡存档窗口：读取 pet-state.json 的 birthdayCards 历史，可切换查看历年贺卡
(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)

  function applyTheme(theme) {
    document.body.className = (window.__BIRTHDAY_CARD && window.__BIRTHDAY_CARD.THEMES.indexOf(theme) >= 0)
      ? theme
      : 'theme-paper'
  }

  // 渲染某一年的贺卡
  function renderCard(card) {
    if (!card) return
    applyTheme(card.theme)
    $('greet').textContent = '🎂 ' + card.date + ' 生日贺卡'
    $('salute').textContent = card.salute
    $('body').textContent = card.body
    $('sign').textContent = card.sign
    $('letter-sub').textContent = '好感度 ' + (card.aff || 0) + ' · ' + (card.affTier || '')
  }

  // 历史选择条
  function renderArchive(cards, activeDate) {
    const wrap = $('archive')
    wrap.innerHTML = ''
    if (!cards.length) {
      const d = document.createElement('div')
      d.className = 'arch-empty'
      d.textContent = '还没有生日贺卡。等主人过生日那天，小深会亲手写一封～'
      wrap.appendChild(d)
      return
    }
    // 新→旧排序
    const sorted = [...cards].sort((a, b) => (a.date < b.date ? 1 : -1))
    sorted.forEach((c) => {
      const btn = document.createElement('button')
      btn.className = 'arch-btn' + (c.date === activeDate ? ' active' : '')
      btn.textContent = c.date
      btn.addEventListener('click', () => {
        document.querySelectorAll('.arch-btn').forEach((b) => b.classList.remove('active'))
        btn.classList.add('active')
        renderCard(c)
      })
      wrap.appendChild(btn)
    })
    if (activeDate) {
      const active = sorted.find((c) => c.date === activeDate)
      if (active) renderCard(active)
      else renderCard(sorted[0])
    } else {
      renderCard(sorted[0])
    }
  }

  async function main() {
    let state = {}
    try {
      state = (await window.pet.stateLoad()) || {}
    } catch (err) { /* 读不到就用默认值 */ }
    const cards = Array.isArray(state.birthdayCards) ? state.birthdayCards : []
    // 优先定位今天/最近的一张（数组按时间先后追加，最新的在末尾）
    const now = new Date()
    const todayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate()
    const active = cards.some((c) => c.date === todayKey) ? todayKey : (cards.length ? cards[cards.length - 1].date : '')
    const owner = (state.ownerName || '主人').trim()
    $('head-sub').textContent = owner + ' 的贺卡档案 · 共 ' + cards.length + ' 张'
    renderArchive(cards, active)
  }

  main()
})()
