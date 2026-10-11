// 相册独立窗口：从 pet-state.json 读取已解锁照片，渲染照片墙（剪影/分类/大图预览）
// 照片定义与 renderer/pet.js 的 PHOTOS 保持一致（双端同源）
const PHOTOS = [
  { id: 'first-meet', name: '初次见面', cat: '时光流', desc: '初次见面那天，你轻轻点了下我' },
  { id: 'morning-first', name: '早安第一眼', cat: '时光流', desc: '每天第一眼的对视，早安' },
  { id: 'noon-tea', name: '午后茶歇', cat: '时光流', desc: '午后的阳光里，一起喝杯茶' },
  { id: 'dusk-sunset', name: '傍晚夕阳', cat: '时光流', desc: '夕阳西下，我们一起看橘色天空' },
  { id: 'late-night', name: '深夜作伴', cat: '时光流', desc: '夜深了，还陪着你' },
  { id: 'dawn-watch', name: '凌晨守候', cat: '时光流', desc: '凌晨的世界很安静，我在' },
  { id: 'overtime-night', name: '加班夜', cat: '时光流', desc: '深夜加班，我也加班陪你' },
  { id: 'weekend-lazy', name: '周末懒散', cat: '时光流', desc: '周末了，一起瘫在沙发放空' },
  { id: 'winter-stove', name: '冬日暖炉', cat: '时光流', desc: '冬天缩在暖炉边，暖洋洋' },
  { id: 'spring-promise', name: '春天约定', cat: '时光流', desc: '春天的樱花落在肩头，约定好了' },
  { id: 'night-owl', name: '熬夜搭子', cat: '时光流', desc: '过了 23 点还没睡，我陪你到最后' },
  { id: 'cherry-blossom', name: '秋的故事', cat: '时光流', desc: '秋天枫叶红了，一起在落叶铺的路上走走吧' },
  { id: 'rainy-window', name: '雨天在家', cat: '时光流', desc: '外面下着雨，我们就在家待着（梅雨季的陪伴）' },
  { id: 'stargaze', name: '一起看星星', cat: '时光流', desc: '凌晨两点的窗外，星星很亮' },
  { id: 'clean-time', name: '打扫时间', cat: '生活琐事', desc: '卷起袖子，把房间收拾得干干净净' },
  { id: 'tea-serve', name: '端茶送水', cat: '生活琐事', desc: '该喝水啦，我端过来了' },
  { id: 'bubble-time', name: '彩虹泡泡', cat: '生活琐事', desc: '偶然吹起的泡泡，五彩斑斓' },
  { id: 'mirror-look', name: '照镜子', cat: '生活琐事', desc: '偷看镜子里的自己，整理发梢' },
  { id: 'hum-moment', name: '哼歌时刻', cat: '生活琐事', desc: '心情好时，哼哼小曲' },
  { id: 'fan-breeze', name: '扇风纳凉', cat: '生活琐事', desc: '给你扇扇风，凉快一下' },
  { id: 'stretch-time', name: '伸懒腰', cat: '生活琐事', desc: '陪你一起伸个懒腰' },
  { id: 'little-chef', name: '小厨师', cat: '生活琐事', desc: '系上围裙，给你露一手' },
  { id: 'sleep-story', name: '睡前故事', cat: '生活琐事', desc: '夜深了，给你讲个小故事再睡' },
  { id: 'lunch-bento', name: '美味便当', cat: '生活琐事', desc: '午饭时间到，给你做了便当' },
  { id: 'head-pat', name: '摸头杀', cat: '生活琐事', desc: '被摸摸头，眯起眼睛蹭手心' },
  { id: 'new-term-note', name: '新学期寄语', cat: '生活琐事', desc: '课程表排好了，抱着书等你上课' },
  { id: 'sneeze', name: '打喷嚏', cat: '生活琐事', desc: '哈啾！有点着凉了，揉揉鼻头' },
  { id: 'first-game', name: '初次入局', cat: '一起玩', desc: '陪主人玩的第一个游戏' },
  { id: 'gomoku-win', name: '棋逢对手', cat: '一起玩', desc: '五子棋赢啦！不服再来' },
  { id: 'guess-win', name: '同猜数字', cat: '一起玩', desc: '猜数字猜中了，默契满分' },
  { id: 'mines-clear', name: '扫雷英雄', cat: '一起玩', desc: '扫雷通关！长舒一口气' },
  { id: 'victory-10', name: '胜者欢呼', cat: '一起玩', desc: '玩了十局游戏，举着小旗欢呼' },
  { id: 't2048-master', name: '数字达人', cat: '一起玩', desc: '2048 合出 512，反应真快' },
  { id: 'snake-king', name: '贪吃蛇王', cat: '一起玩', desc: '贪吃蛇吃得越来越长' },
  { id: 'sudoku-master', name: '数独挑战', cat: '一起玩', desc: '数独解出来啦！' },
  { id: 'tickle-battle', name: '挠痒大战', cat: '一起玩', desc: '被挠得笑到缩成一团' },
  { id: 'tsundere-moment', name: '撒娇时刻', cat: '一起玩', desc: '哼哼，别过头去——其实很开心' },
  { id: 'caught-eating', name: '偷吃被抓', cat: '一起玩', desc: '偷吃零食被主人抓个正着' },
  { id: 'first-day', name: '第一天上班', cat: '一起工作', desc: '第一次给主人干活，紧张又认真' },
  { id: 'hard-coding', name: '认真敲码', cat: '一起工作', desc: '一干就是半小时，超认真' },
  { id: 'diligent-maid', name: '勤奋女仆', cat: '一起工作', desc: '累计工作 60 分钟，擦擦汗继续' },
  { id: 'exhausted-maid', name: '累瘫了', cat: '一起工作', desc: '累计工作 600 分钟，趴桌上还想着干' },
  { id: 'model-worker', name: '劳模认证', cat: '一起工作', desc: '完成 20 次工作，戴上劳模小帽' },
  { id: 'top-employee', name: '满级宠臣', cat: '一起工作', desc: '完成 50 次工作，闪闪发光' },
  { id: 'pomo-master', name: '番茄大师', cat: '一起工作', desc: '完成 10 个番茄钟，专注度拉满' },
  { id: 'efficient-lunch', name: '高效午餐', cat: '一起工作', desc: '边吃饭边盯屏幕，效率大师' },
  { id: 'remember-me', name: '帮我记住', cat: '一起工作', desc: '记在小本本上，绝不忘记' },
  { id: 'schedule-manager', name: '日程管家', cat: '一起工作', desc: '整周的行程都排上了，安排得明明白白' },
  { id: 'owner-birthday', name: '生日快乐', cat: '节日纪念', desc: '主人的生日！蛋糕准备好了' },
  { id: 'pet-birthday', name: '小深的生日', cat: '节日纪念', desc: '小深自己的小小庆祝日' },
  { id: 'new-year', name: '新年快乐', cat: '节日纪念', desc: '新年第一天，穿红围裙拜年' },
  { id: 'reunion-night', name: '团圆年', cat: '节日纪念', desc: '春节啦，一起吃年夜饭' },
  { id: 'lantern-festival', name: '元宵花灯', cat: '节日纪念', desc: '提着灯笼，看花灯亮起来' },
  { id: 'dragon-boat', name: '端午粽香', cat: '节日纪念', desc: '粽子煮好啦，切开尝尝' },
  { id: 'mid-autumn', name: '中秋赏月', cat: '节日纪念', desc: '月亮好圆，一起吃月饼' },
  { id: 'christmas-night', name: '圣诞夜', cat: '节日纪念', desc: '戴上圣诞帽，圣诞快乐' },
  { id: 'halloween', name: '万圣节', cat: '节日纪念', desc: '不给糖就捣蛋～' },
  { id: 'school-start', name: '开学第一天', cat: '节日纪念', desc: '新学期开始啦，要加油' },
  { id: 'flying-happy', name: '开心到飞起', cat: '情绪时刻', desc: '好感度满格，开心得飘起来' },
  { id: 'tsundere-3', name: '哼哼傲娇', cat: '情绪时刻', desc: '连点三次才知道你想逗我' },
  { id: 'shy-whale', name: '害羞小鲸', cat: '情绪时刻', desc: '被逗到脸红，把头埋起来' },
  { id: 'miss-you', name: '想你了', cat: '情绪时刻', desc: '一天没见，趴在窗边嘀咕' },
  { id: 'sad-moment', name: '委屈巴巴', cat: '情绪时刻', desc: '状态不太好，委屈得想哭' },
  { id: 'full-energy', name: '元气满满', cat: '情绪时刻', desc: '饱饱的、心情好、精神足' },
  { id: 'sleepy-eyes', name: '困到睁不开', cat: '情绪时刻', desc: '眼皮打架，还是想陪你' },
  { id: 'praised', name: '被夸害羞', cat: '情绪时刻', desc: '被主人夸了，脸有点红' },
  { id: 'first-cookie', name: '第一块饼干', cat: '成长养成', desc: '第一次喂食，舍不得吃' },
  { id: 'big-eater', name: '干饭小鲸', cat: '成长养成', desc: '喂食 20 次，胃口超好' },
  { id: 'piggy-bank', name: '存钱罐', cat: '成长养成', desc: '金币攒到 300，抱紧存钱罐' },
  { id: 'rich-girl', name: '小富婆', cat: '成长养成', desc: '金币破千，数钱数到手软' },
  { id: 'three-days', name: '连续守护', cat: '成长养成', desc: '连续陪伴 3 天，慢慢习惯你' },
  { id: 'week-promise', name: '一周之约', cat: '成长养成', desc: '连续陪伴 7 天，约定好了' },
  { id: 'month-bond', name: '一个月羁绊', cat: '成长养成', desc: '连续陪伴 30 天，早就离不开' },
  { id: 'level-up', name: '升级啦', cat: '成长养成', desc: '升到 5 级，头顶发光' },
  { id: 'deep-sea', name: '深海传说', cat: '成长养成', desc: '升到满级 Lv.8「深海传说」，庄重地行个礼' },
  { id: 'surprise-gift', name: '惊喜礼物', cat: '特别记忆', desc: '好感度升档，藏了份小礼物' },
  { id: 'diary-time', name: '日记时光', cat: '特别记忆', desc: '写下第一篇日记，记录今天' },
  { id: 'reunion-moment', name: '重逢时刻', cat: '特别记忆', desc: '好久不见，扑上来抱住你' },
  { id: 'daily-summary', name: '今日小结', cat: '特别记忆', desc: '今天的任务全完成啦' },
  { id: 'thanks-company', name: '谢谢陪伴', cat: '特别记忆', desc: '陪伴一百个日日夜夜，谢谢你' },
  { id: 'peaceful-time', name: '岁月静好', cat: '特别记忆', desc: '深夜还在待机，岁月静好' },
  { id: 'empty-pocket', name: '钱包空空', cat: '特别记忆', desc: '金币见底了…我会省着点的' },
  { id: 'movie-night', name: '一起看电影', cat: '特别记忆', desc: '十一点了还在放片子，我陪你看完' },
  { id: 'chat-ten', name: '陪我聊聊', cat: '特别记忆', desc: '今天和我说了好多话，我记着呢' }
]

let curCat = '全部'
let state = {}
/* 相册窗口打开期间自动刷新（原来只在打开时读一次盘，
   打着游戏看相册会一直是旧进度）。用"已解锁签名"做变更检测，变了才重画。 */
let lastSig = ''
let watchTimer = null

function madeSig(unlocked) {
  return Object.keys(unlocked || {}).sort().join(',')
}

function startWatch() {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = setInterval(async () => {
    try {
      const st = (await window.pet.stateLoad()) || {}
      const sig = madeSig(st.photos || {})
      if (sig !== lastSig) main()
    } catch (err) { /* 读失败就等下一轮 */ }
  }, 2500)
}
window.addEventListener('beforeunload', () => { if (watchTimer) clearInterval(watchTimer) })

async function main() {
  const grid = document.getElementById('grid')
  const countEl = document.getElementById('count')
  const catsEl = document.getElementById('cats')
  try {
    state = (await window.pet.stateLoad()) || {}
  } catch (err) {
    countEl.textContent = '读取状态失败：' + (err && err.message)
    return
  }
  const unlocked = state.photos || {}

  // 分类 tab（每次重建，避免重复堆叠）
  catsEl.innerHTML = ''
  const cats = ['全部', ...new Set(PHOTOS.map((p) => p.cat))]
  cats.forEach((c) => {
    const btn = document.createElement('button')
    btn.className = 'cat-btn' + (c === curCat ? ' active' : '')
    btn.textContent = c
    btn.addEventListener('click', () => { curCat = c; main() })
    catsEl.appendChild(btn)
  })

  const list = PHOTOS.filter((p) => curCat === '全部' || p.cat === curCat)
  const done = list.filter((p) => unlocked[p.id]).length
  /* 计数只统计**规则表里存在**的 id（原来用 Object.keys(unlocked).length，
     会把历史遗留/已删除规则的 key 也算进去，数字对不上）。 */
  const unlockedInTable = PHOTOS.filter((p) => unlocked[p.id]).length
  countEl.textContent = (curCat === '全部'
    ? '已解锁 ' + unlockedInTable + ' / ' + PHOTOS.length
    : '本类 ' + done + ' / ' + list.length)
  lastSig = madeSig(unlocked)

  grid.innerHTML = ''
  list.forEach((p) => {
    const un = !unlocked[p.id]
    const card = document.createElement('div')
    card.className = 'photo-card' + (un ? ' locked' : '')
    const wrap = document.createElement('div')
    wrap.className = 'photo-wrap'
    if (un) {
      // 统一剪影：深灰渐变 + 相机剪影图标 + 锁
      const sil = document.createElement('div')
      sil.className = 'sil'
      sil.textContent = '📷'
      wrap.appendChild(sil)
    } else {
      const img = document.createElement('img')
      img.src = 'photos/' + p.id + '.webp'
      img.draggable = false
      img.addEventListener('dragstart', (e) => e.preventDefault())
      img.onerror = () => { wrap.innerHTML = '<div class="sil">📷</div>' } // 缺图兜底
      wrap.appendChild(img)
      const date = document.createElement('div')
      date.className = 'date'
      const d = new Date(unlocked[p.id].ts || Date.now())
      date.textContent = (d.getMonth() + 1) + '/' + d.getDate()
      wrap.appendChild(date)
    }
    const name = document.createElement('div')
    name.className = 'name'
    /* （用户定）：未解锁**照样显示真名**（不打 ???）——
       名字本身就是"这张是什么"的钩子，遮掉反而看不懂。
       画面仍旧藏起来（📷 剪影），描述改成"还没遇到这一幕"，实现条件放在提示行。 */
    name.textContent = un ? '🔒 ' + p.name : p.name
    const desc = document.createElement('div')
    desc.className = 'desc'
    desc.textContent = un ? '还没遇到这一幕' : p.desc
    card.appendChild(wrap)
    card.appendChild(name)
    card.appendChild(desc)
    if (un) {
      const hint = document.createElement('div')
      hint.className = 'hint'
      hint.textContent = hintText(p)
      card.appendChild(hint)
    } else {
      const meta = document.createElement('div')
      meta.className = 'meta'
      meta.textContent = '已解锁'
      card.appendChild(meta)
    }
    card.addEventListener('click', () => {
      if (un) return
      // 点击缩略图 → 打开大图查看器窗口（照片放大展示）
      if (window.pet && window.pet.photoViewOpen) window.pet.photoViewOpen(p.id)
    })
    grid.appendChild(card)
  })
}

// 未解锁条件的提示文案（与 pet.js 条件对应，此处做静态文案）
function hintText(p) {
const hints = {
  'first-meet': '初次启动时解锁',
  'morning-first': '每天第一次打开桌宠',
  'noon-tea': '13:00~15:00 打开桌宠',
  'dusk-sunset': '17:00~19:00 打开桌宠',
  'late-night': '22:00 后打开桌宠',
  'dawn-watch': '0:00~4:00 使用桌宠',
  'overtime-night': '22:00 后完成一次工作',
  'weekend-lazy': '周末打开桌宠',
  'winter-stove': '冬季（12~2月）打开桌宠',
  'spring-promise': '春天（3~4月）打开桌宠',
  'clean-time': '完成一次清洁',
  'tea-serve': '确认喝水提醒',
  'bubble-time': '播放吹泡泡动画',
  'mirror-look': '播放照镜子动画',
  'hum-moment': '播放哼歌动画',
  'fan-breeze': '播放扇风动画',
  'stretch-time': '播放伸懒腰动画',
  'little-chef': '播放进食表演动画',
  'sleep-story': '晚上 21 点后精神不佳时',
  'first-game': '玩一局任意小游戏',
  'gomoku-win': '五子棋赢一局',
  'guess-win': '猜数字赢一局',
  'mines-clear': '扫雷通关',
  'victory-10': '累计玩 10 局游戏',
  't2048-master': '2048 合出 512',
  'snake-king': '贪吃蛇得分 30+',
  'sudoku-master': '完成一局数独',
  'tickle-battle': '播放挠痒动画',
  'tsundere-moment': '播放傲娇动画',
  'caught-eating': '播放偷吃动画',
  'first-day': '完成第一次工作',
  'hard-coding': '单次工作 30 分钟以上',
  'diligent-maid': '累计工作 60 分钟',
  'exhausted-maid': '累计工作 600 分钟',
  'model-worker': '完成 20 次工作',
  'top-employee': '完成 50 次工作',
  'pomo-master': '完成 10 个番茄钟',
  'efficient-lunch': '工作期间进食',
  'remember-me': '添加一条备忘录',
  'schedule-manager': '添加一个日程',
  'owner-birthday': '主人生日当天打开',
  'pet-birthday': '7月17日小深生日',
  'new-year': '元旦当天打开',
  'reunion-night': '春节（1月）打开',
  'lantern-festival': '元宵（1月下旬~2月）打开',
  'dragon-boat': '端午节（6月）打开',
  'mid-autumn': '中秋（9月下旬）打开',
  'christmas-night': '圣诞夜（12/24~25）打开',
  'halloween': '万圣节（10/31）打开',
  'school-start': '开学/添加课程',
  'flying-happy': '好感度达到 100',
  'tsundere-3': '快速连点小深 3 次',
  'shy-whale': '快速连点小深 5 次',
  'miss-you': '超过一天没打开小深',
  'sad-moment': '心情低于 30',
  'full-energy': '饱食/心情/精力都大于 80',
  'sleepy-eyes': '精力低于 20',
  'praised': '聊天中夸奖小深',
  'first-cookie': '第一次喂食',
  'big-eater': '累计喂食 20 次',
  'piggy-bank': '金币达到 300',
  'rich-girl': '金币达到 1000',
  'three-days': '连续陪伴 3 天',
  'week-promise': '连续陪伴 7 天',
  'month-bond': '连续陪伴 30 天',
  'level-up': '升到 5 级',
  'deep-sea': '升到满级 Lv.8「深海传说」',
  'surprise-gift': '好感度提升一层',
  'diary-time': '写第一篇日记',
  'reunion-moment': '久别重逢',
  'daily-summary': '当天完成全部互动任务',
  'thanks-company': '陪伴 100 个日夜',
  'peaceful-time': '深夜 22 点后待机',
  /* 照片的提示文案（与 pet.js 的 check 条件一一对应） */
  'night-owl': '23 点后还开着桌宠',
  'cherry-blossom': '秋天（10~11 月）打开',
  'rainy-window': '梅雨季（5~9 月）打开',
  'stargaze': '凌晨 0~2 点打开',
  'lunch-bento': '11~13 点之间喂她吃点东西',
  'head-pat': '轻轻点她一下（不是连点）',
  'new-term-note': '课程表里添加第一节课',
  'sneeze': '凌晨 0~6 点且精力低于 40',
  'empty-pocket': '金币掉到 10 以下',
  'movie-night': '23 点整还开着（一起看电影）',
  'chat-ten': '一天里和她说满 10 句话',
}
  return hints[p.id] || '达成隐藏条件解锁'
}

function showPreview(p, ts) {
  // 已更换为独立大图窗口（photoViewOpen），此函数保留兼容
}

document.getElementById('pv-close').addEventListener('click', () => {
  document.getElementById('preview').classList.add('hidden')
})
document.getElementById('preview').addEventListener('click', (e) => {
  if (e.target === document.getElementById('preview')) {
    document.getElementById('preview').classList.add('hidden')
  }
})

main()
startWatch()
