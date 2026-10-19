/* 扫雷（独立窗口）— 经典扫雷，三档难度，通关按难度+耗时结算金币发回桌宠 */
(function () {
  'use strict'
  const LEVELS = {
    easy: { rows: 9, cols: 9, mines: 10, reward: 20 },
    mid: { rows: 16, cols: 16, mines: 40, reward: 45 },
    hard: { rows: 16, cols: 30, mines: 99, reward: 90 },
  }
  let lv = 'easy'
  let grid = []
  let revealed = 0
  let flags = 0
  let over = false
  let started = false
  let timer = 0
  let timerInt = null
  let firstOpen = true
  let gameRunId

  const board = document.getElementById('board')
  const resultEl = document.getElementById('result')
  const minesLeftEl = document.getElementById('mines-left')
  const timerEl = document.getElementById('timer')

  function initGrid() {
    gameRunId = 'mines:' + Date.now() + ':' + Math.random().toString(36).slice(2,8)
    const { rows, cols, mines } = LEVELS[lv]
    grid = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ mine: false, open: false, flag: false, n: 0 }))
    )
    revealed = 0
    flags = 0
    over = false
    started = false
    firstOpen = true
    timer = 0
    if (timerInt) clearInterval(timerInt)
    timerInt = null
    minesLeftEl.textContent = String(mines)
    timerEl.textContent = '0'
    resultEl.textContent = ''
    render()
  }

  function placeMines(safeR, safeC) {
    const { rows, cols, mines } = LEVELS[lv]
    let placed = 0
    while (placed < mines) {
      const r = Math.floor(Math.random() * rows)
      const c = Math.floor(Math.random() * cols)
      if (grid[r][c].mine || (r === safeR && c === safeC)) continue
      grid[r][c].mine = true
      placed++
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c].mine) continue
        grid[r][c].n = countAround(r, c, (g) => g.mine)
      }
    }
  }

  function countAround(r, c, pred) {
    let n = 0
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue
        const rr = r + dr, cc = c + dc
        if (rr >= 0 && rr < grid.length && cc >= 0 && cc < grid[0].length && pred(grid[rr][cc])) n++
      }
    }
    return n
  }

  function startTimer() {
    if (started) return
    started = true
    timerInt = setInterval(() => {
      timer++
      timerEl.textContent = String(timer)
    }, 1000)
  }

  function openCell(r, c) {
    if (over || grid[r][c].open || grid[r][c].flag) return
    if (firstOpen) { firstOpen = false; placeMines(r, c); startTimer() }
    grid[r][c].open = true
    revealed++
    if (grid[r][c].mine) {
      grid[r][c].mineHit = true
      return lose()
    }
    if (grid[r][c].n === 0) {
      // 洪水翻开
      const stack = [[r, c]]
      while (stack.length) {
        const [rr, cc] = stack.pop()
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue
            const nr = rr + dr, nc = cc + dc
            if (nr >= 0 && nr < grid.length && nc >= 0 && nc < grid[0].length && !grid[nr][nc].open && !grid[nr][nc].mine && !grid[nr][nc].flag) {
              grid[nr][nc].open = true
              revealed++
              if (grid[nr][nc].n === 0) stack.push([nr, nc])
            }
          }
        }
      }
    }
    checkWin()
  }

  function toggleFlag(r, c) {
    if (over || grid[r][c].open) return
    if (firstOpen) { firstOpen = false; placeMines(r, c); startTimer() }
    grid[r][c].flag = !grid[r][c].flag
    flags += grid[r][c].flag ? 1 : -1
    minesLeftEl.textContent = String(LEVELS[lv].mines - flags)
    render()
  }

  function checkWin() {
    const { rows, cols, mines } = LEVELS[lv]
    if (revealed === rows * cols - mines) {
      over = true
      if (timerInt) clearInterval(timerInt)
      const reward = LEVELS[lv].reward
      const bonus = Math.max(0, Math.floor((LEVELS[lv].mines * 10) / Math.max(1, timer)))
      const total = reward + bonus
      resultEl.textContent = '🎉 通关！+🪙 ' + total + '（基础 ' + reward + ' + 速通奖励 ' + bonus + '）'
      window.pet.minesweeperReward({ ok: true, eventId: gameRunId, level: lv, total, reward, bonus, time: timer })
      render()
    }
  }

  function lose() {
    over = true
    if (timerInt) clearInterval(timerInt)
    resultEl.textContent = '💥 踩雷了…再来一局'
    // 显示所有雷
    grid.forEach((row) => row.forEach((g) => { if (g.mine && !g.open) g.open = true }))
    render()
  }

  function render() {
    const { rows, cols } = LEVELS[lv]
    board.style.gridTemplateColumns = 'repeat(' + cols + ', 26px)'
    board.innerHTML = ''
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c]
        const el = document.createElement('div')
        el.className = 'cell'
        if (cell.open) {
          el.classList.add('open')
          if (cell.mine) {
            el.textContent = '💣'
            if (cell.mineHit) el.classList.add('mine-hit')
          } else if (cell.n > 0) {
            el.textContent = String(cell.n)
            el.classList.add('c' + cell.n)
          }
        } else if (cell.flag) {
          el.classList.add('flag')
          el.textContent = '⚑'
        }
        el.addEventListener('click', () => { if (!over) openCell(r, c); render() })
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!over) toggleFlag(r, c) })
        board.appendChild(el)
      }
    }
  }

  document.querySelectorAll('.btn[data-level]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.btn[data-level]').forEach((x) => x.classList.remove('active'))
      b.classList.add('active')
      lv = b.dataset.level
      initGrid()
    })
  })
  document.getElementById('btn-restart').addEventListener('click', initGrid)
  initGrid()
})()
