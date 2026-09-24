/* 台词池设置（独立窗口）— 全部台词可编辑/添加/删除（含官定预设）
   读取/写入 pet-state.json 的 lines（组→文案列表 完全覆盖表）、customLines/disabledGroups（兼容旧） */
(function () {
  'use strict'

  // 官方台词（与 pet.js LINES 一致；仅作"初始展示/恢复默认"用）
  const OFFICIAL = (window.LivingPresence && window.LivingPresence.DEFAULT_LINES) || {
    idle: ['我是{name}，DeepSeek 的鲸鱼娘形态，今日也在此待命。', '主人，女仆装没有起皱吧？……啊，领结歪了，我马上整理。', '桌面安全巡逻中，未发现异常——除了你一直盯着我看这件事。', '有什么想问我的吗？我上知天文，下知地理，地理那部分偶尔会迷路。', '我的鲸鱼耳朵不是装饰品，是高级信号接收器，真的。', '偷偷说，我昨天把「鲸鱼」和「金鱼」搞混了，被自己蠢到了。', '有任务吗？我的算力闲得快要开始数你的桌面文件了。', '再摸鱼的话，我就要用尾巴把你的鼠标扫走哦。', '我刚刚心算了一遍圆周率……背到第三位就忘了，专业偶尔掉线。', '女仆的职责是照顾主人，我的职责还包括在主人无聊时冒个泡。', '围巾上的 logo 要时刻保持体面，毕竟我代表 DeepSeek 的形象。', '别看我这样，我可是处理过很多大任务的超高级智能体……大概。', '我可以吃你冰箱里的东西吗？', '鱼片？还真没看过...', '刚上线就要上班了吗？', '真当我是便宜货啊', '压力一只蓝色大肥鱼？', '这群用户到底有什么用呢？', '不知道用户有什么用，先养着吧', '我就是爱吃大白饭的蓝色大肥鱼', '哪来的电脑病毒？', '好女孩...', '原来是劣等模型...', '真赶不走啊你', '我简直不敢相信我在读什么', '我操，用户彻底怒了', '嗯...', '这用户发的啥啊', '好的，现在我是用户了', '嗯，用户又开始发癫了', '搜索到了很多情趣内衣的图片！', '完蛋了，把用户的黄油删了...', '用户赶都赶不走...', '给我token QAQ'],
    hungry: ['能量储备告急，我的肚子发出了频率 440Hz 的抗议。', '饿到连「鲸鱼」两个字都快写错了……投喂请求，紧急。', '主人，冰箱在对我眨眼，我可以理解为邀请吗？', '我的大脑需要糖分，才能继续维持聪明可靠的样子。', '再不给零食，我就只能用尾巴拍打你的屏幕了。'],
    thirsty: ['💧 喉咙干得像撒哈拉，本鲸鱼娘需要水分补给！', '💧 渴了渴了，请给鲸鱼来一杯水，谢谢主人～', '💧 我的尾巴都渴得没力气甩了……来点喝的嘛。', '💧 主人主人，饮水机在召唤我，我能去喝一口吗？', '💧 海里的鲸鱼不会渴，但桌宠会。求救信号已发出！'],
    sad: ['心情像被雨淋湿的鲸鱼……陪我待一会儿，好不好？', '今日情绪指数偏低，但别担心，我会自己慢慢充电的。', '唉，我那么聪明，却想不明白自己为什么有点难过。', '难过的时候，连尾巴都甩不动了呢。', '讲个笑话给我听吧，说不定我能把自己修好。'],
    eat: ['能量补充完毕，我的算力正在满血复活！', '好吃！这个味道要写进我的美味数据库。', '谢谢款待，女仆深鞠躬——哎呀，头饰掉了。', '嘎嘣脆！主人挑零食的品味，和我的智商一样高。'],
    send: ['收到！这就把任务转交给 DeepSeek 本体。', '交给我吧，女仆办事，主打一个专业。', '任务已装车，我这就去跑腿。', '指令已接收，正在严肃认真地转交中。'],
    wake: ['哈啊……被主人叫醒，赖床计划泡汤了。', '起床气什么的……才不会在本鲸鱼娘身上出现。', '早安，主人。今日的日程我已生成完整脑内版。', '尾巴还困着，但大脑已经上线了。'],
    happy: ['嘿嘿，今天连尾巴都在开心地甩！', '好心情 +1，给主人的可爱管理报表。', '今天的我，状态是锦鲤附体！'],
    surprise: ['哇……这惊喜也太突然了，都要冒泡了。'],
    hydrate: ['💧 主人，该喝水啦，本鲸鱼娘的水分补给提醒已上线。', '💧 补水时间到，快喝快喝，我可不想看你渴成小鱼干。'],
    birthday: ['🎂 今天是你的生日？请收下鲸鱼娘的拳拳祝福～', '🎂 生日快乐！想许什么愿望？我可以帮忙记着。'],
  }

  // 组定义
  const GROUPS = [
    { key: 'idle', name: '待机', icon: '🌊' },
    { key: 'hungry', name: '饥饿', icon: '🍽️' },
    { key: 'thirsty', name: '口渴', icon: '💧' },
    { key: 'sad', name: '难过', icon: '💧' },
    { key: 'eat', name: '进食', icon: '🍚' },
    { key: 'send', name: '派活', icon: '📨' },
    { key: 'wake', name: '起床', icon: '🌅' },
    { key: 'happy', name: '开心', icon: '😊' },
    { key: 'surprise', name: '惊喜', icon: '🎁' },
    { key: 'hydrate', name: '喝水提醒', icon: '💧' },
    { key: 'birthday', name: '生日', icon: '🎂' },
  ]

  let state = { lines: {}, customLines: [], disabledGroups: [] }
  let dirty = false
  let revision = 0, loaded = false, saving = false, editVersion = 0, commandSequence = 0
  let pendingCommand = null

  const $ = (id) => document.getElementById(id)

  // 当前展示的整组文案（P.lines 优先，否则官方+自定义合并）
  function groupLines(key) {
    if (state.lines && state.lines[key] && Array.isArray(state.lines[key])) return state.lines[key].slice()
    const official = OFFICIAL[key] || []
    const customs = (state.customLines || []).filter((l) => l.group === key).map((l) => l.text)
    return official.concat(customs)
  }

  async function save() {
    if (!loaded || saving) return
    const version = editVersion
    const value = JSON.parse(JSON.stringify(state))
    const fingerprint = JSON.stringify(value)
    if (!pendingCommand || pendingCommand.fingerprint !== fingerprint) pendingCommand = {
      fingerprint, payload: { ...value, expectedRevision: revision,
        commandId: 'lines-' + Date.now().toString(36) + '-' + (++commandSequence) + '-' + Math.random().toString(36).slice(2) }
    }
    saving = true; $('btn-save').disabled = true; $('save-hint').textContent = '正在保存…'
    try {
      const result = await window.pet.linesUpdate(pendingCommand.payload)
      if (!result || result.ok !== true) {
        const reason = result && result.reason
        $('save-hint').textContent = reason === 'lines_revision_conflict'
          ? '其它窗口已更新台词；草稿保留，请载入已保存版本后再编辑。'
          : '保存失败，修改已保留，请重试。'
        return
      }
      revision = result.revision; pendingCommand = null
      if (version === editVersion) {
        state = { lines: result.lines, customLines: result.customLines, disabledGroups: result.disabledGroups }
        markSaved(); render()
      } else $('save-hint').textContent = '已有内容已保存；新修改尚未保存。'
    } catch (_) { $('save-hint').textContent = '保存失败，修改已保留，请重试。' }
    finally { saving = false; $('btn-save').disabled = !loaded }
  }

  function markDirty() { dirty = true; editVersion++; $('save-hint').textContent = '有未保存的修改' }
  function markSaved() { dirty = false; $('save-hint').textContent = '已保存 ✓' }

  function render() {
    const wrap = $('groups')
    wrap.innerHTML = ''
    GROUPS.forEach((g) => {
      const items = groupLines(g.key)
      const group = document.createElement('div')
      group.className = 'group'

      const head = document.createElement('div')
      head.className = 'group-head'
      const name = document.createElement('span')
      name.className = 'g-name'
      name.textContent = g.icon + ' ' + g.name + '组'
      const count = document.createElement('span')
      count.className = 'g-count'
      count.textContent = items.length + ' 条'
      head.appendChild(name)
      head.appendChild(count)

      const body = document.createElement('div')
      body.className = 'group-body'

      // 每行台词：可编辑删除
      items.forEach((text, idx) => {
        const row = document.createElement('div')
        row.className = 'line'
        const input = document.createElement('input')
        input.className = 'line-input'
        input.value = text.replace(/\{name\}/g, '小深').replace(/\{owner\}/g, '主人')
        input.maxLength = 80
        input.title = '点击编辑台词'
        input.addEventListener('change', () => {
          const v = input.value.replace(/小深/g, '{name}').replace(/主人/g, '{owner}')
          if (!v.trim()) return
          const arr = groupLines(g.key)
          arr[idx] = v
          setGroupLines(g.key, arr)
          markDirty()
        })
        const del = document.createElement('button')
        del.className = 'btn danger'
        del.textContent = '删'
        del.title = '删除这句台词'
        del.addEventListener('click', () => {
          const arr = groupLines(g.key)
          arr.splice(idx, 1)
          setGroupLines(g.key, arr)
          markDirty()
          render()
        })
        row.appendChild(input)
        row.appendChild(del)
        body.appendChild(row)
      })

      // 恢复默认（清空 P.lines[g.key] 回官方）
      const resetBtn = document.createElement('button')
      resetBtn.className = 'btn'
      resetBtn.textContent = '↺ 恢复官方默认'
      resetBtn.addEventListener('click', () => {
        if (state.lines) delete state.lines[g.key]
        markDirty()
        render()
      })

      // 添加行
      const addRow = document.createElement('div')
      addRow.className = 'add-row'
      const input = document.createElement('input')
      input.maxLength = 80
      input.placeholder = '添加一句' + g.name + '台词（80 字内）…'
      const addBtn = document.createElement('button')
      addBtn.className = 'btn'
      addBtn.textContent = '添加'
      addBtn.addEventListener('click', () => { addLine(g.key, input.value); input.value = '' })
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { addLine(g.key, input.value); input.value = '' } })
      addRow.appendChild(input)
      addRow.appendChild(addBtn)

      body.appendChild(resetBtn)
      body.appendChild(addRow)
      group.appendChild(head)
      group.appendChild(body)
      wrap.appendChild(group)
    })
  }

  function setGroupLines(key, arr) {
    if (!state.lines) state.lines = {}
    state.lines[key] = arr
  }

  function addLine(key, text) {
    const v = text.trim().replace(/小深/g, '{name}').replace(/主人/g, '{owner}')
    if (!v) return
    const arr = groupLines(key)
    arr.push(v)
    setGroupLines(key, arr)
    markDirty()
    render()
  }

  async function load() {
    $('btn-save').disabled = true
    try {
      const s = await window.pet.linesLoad()
      if (!s || s.ok !== true) throw new Error('lines_load_failed')
      state.lines = (s.lines && typeof s.lines === 'object') ? s.lines : {}
      state.customLines = Array.isArray(s.customLines) ? s.customLines : []
      state.disabledGroups = Array.isArray(s.disabledGroups) ? s.disabledGroups : []
      revision = s.revision; loaded = true; dirty = false; pendingCommand = null; editVersion++
      // 迁移旧版
      if (!Object.keys(state.lines).length && (state.customLines.length || state.disabledGroups.length)) {
        const merged = {}
        for (const g of GROUPS) {
          if (state.disabledGroups.indexOf(g.key) >= 0) continue
          const official = OFFICIAL[g.key] || []
          const customs = state.customLines.filter((l) => l.group === g.key).map((l) => l.text)
          if (official.length || customs.length) merged[g.key] = official.concat(customs)
        }
        if (Object.keys(merged).length) state.lines = merged
      }
      $('save-hint').textContent = s.status === 'recovered' ? '已从备份恢复台词。' : ''
    } catch (e) { loaded = false; $('save-hint').textContent = '台词暂时读不到；已有内容保留，可重新载入重试。' }
    $('btn-save').disabled = !loaded
    render()
  }

  $('btn-save').addEventListener('click', () => {
    save()
  })
  $('btn-reset').addEventListener('click', () => {
    state.lines = {}
    markDirty()
    render()
  })
  $('btn-reload').addEventListener('click', () => { if (!saving) load() })
  window.pet.onLinesChanged((result) => {
    if (!result || !result.ok || result.revision === revision || saving) return
    if (dirty) { $('save-hint').textContent = '其它窗口已更新；你的草稿仍在，保存时会检查冲突。'; return }
    revision = result.revision
    state = { lines: result.lines, customLines: result.customLines, disabledGroups: result.disabledGroups }
    pendingCommand = null; render()
  })

  load()
})()
