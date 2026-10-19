(function(root,factory){if(typeof module==="object"&&module.exports)module.exports=factory();else root.NurtureRules=factory()})(typeof window!=="undefined"?window:globalThis,function(){
'use strict'
// Existing product constants extracted without changing their values.
const ITEMS = {
    // ---- 餐点 ----
    cookie: { name: '小饼干', icon: '🍪', desc: '饱食度 +20', price: 10, effect: { satiety: 20 }, category: 'meal' },
    rice: { name: '女仆手作饭团', icon: '🍙', desc: '饱食+20 心情+5', price: 16, effect: { satiety: 20, mood: 5 }, category: 'meal' },
    noodle: { name: '海鲜乌冬', icon: '🍜', desc: '饱食+25 精力-5（鲜甜，女仆拿手）', price: 12, effect: { satiety: 25, energy: -5 }, category: 'meal' },
    cake: { name: '奶油蛋糕', icon: '🍰', desc: '心情+10 饱食+10', price: 22, effect: { mood: 10, satiety: 10 }, category: 'meal' },
    feast: { name: '豪华大餐', icon: '🍱', desc: '饱食+35 心情+15 精力+15', price: 40, effect: { satiety: 35, mood: 15, energy: 15 }, category: 'meal' },
    // ---- 饮品 ----
    water: { name: '矿泉水', icon: '💧', desc: '口渴度 +30', price: 8, effect: { thirst: 30 }, category: 'drink' },
    milk: { name: '热牛奶', icon: '🥛', desc: '口渴+25 精力+8', price: 14, effect: { thirst: 25, energy: 8 }, category: 'drink' },
    tea: { name: '茉莉花茶', icon: '🍵', desc: '口渴+25 心情+8（女仆泡茶手艺）', price: 16, effect: { thirst: 25, mood: 8 }, category: 'drink' },
    juice: { name: '鲜榨果汁', icon: '🧃', desc: '口渴+30 心情+10', price: 18, effect: { thirst: 30, mood: 10 }, category: 'drink' },
    milktea: { name: '珍珠奶茶', icon: '🧋', desc: '心情+15 精力+5', price: 18, effect: { mood: 15, energy: 5 }, category: 'drink' },
    coffee: { name: '浓缩咖啡', icon: '☕', desc: '精力+15 心情-5（苦）', price: 8, effect: { energy: 15, mood: -5 }, category: 'drink' },
    cola: { name: '蜂蜜柚子茶', icon: '🍋', desc: '口渴+25 心情+5', price: 12, effect: { thirst: 25, mood: 5 }, category: 'drink' },
    // ---- 心意礼物（加好感度/心情，定价远高于普通道具）----
    hairpin: { name: '蝴蝶结发饰', icon: '🎀', desc: '好感 +2，心情 +5', price: 60, effect: { affection: 2, mood: 5 }, category: 'gift' },
    flower: { name: '深海花束', icon: '💐', desc: '好感 +3，心情 +8', price: 90, effect: { affection: 3, mood: 8 }, category: 'gift' },
    bracelet: { name: '星砂手链', icon: '📿', desc: '好感 +4，心情 +6', price: 130, effect: { affection: 4, mood: 6 }, category: 'gift' },
    brooch: { name: '珍珠胸针', icon: '🪸', desc: '好感 +6，心情 +10（女仆珍品）', price: 220, effect: { affection: 6, mood: 10 }, category: 'gift' },
    // ---- 娱乐 ----
    toy: { name: '鲸鱼玩偶', icon: '🐳', desc: '心情 +20（同类相吸）', price: 10, effect: { mood: 20 }, category: 'fun' },
    drink: { name: '能量汽水', icon: '🥤', desc: '精力 +25', price: 15, effect: { energy: 25 }, category: 'fun' },
    blindbox: { name: '神秘盲盒', icon: '🎁', desc: '随机效果 + 随机金币', price: 15, effect: null, category: 'fun' },
  }
const WORK_JOBS = [
    {
      id: 'clean', name: '打扫房间', icon: '🧹', minutes: 10, reward: 15,
      desc: '把桌面擦得闪闪发亮，扫除灰尘和烦恼',
      consume: { energy: 0.8 }, minLevel: 1, minAff: 0,
    },
    {
      id: 'tea', name: '泡茶待客', icon: '☕', minutes: 15, reward: 20,
      desc: '沏一壶好茶，招待来访的客人（还有自己）',
      consume: { thirst: 0.9, mood: -0.2 }, minLevel: 1, minAff: 0,
    },
    {
      id: 'tidy', name: '整理书房', icon: '📚', minutes: 20, reward: 28,
      desc: '把书本按高矮排好，给主人的桌面腾出空间',
      consume: { energy: 0.9, satiety: 0.3 }, minLevel: 2, minAff: 0,
    },
    {
      id: 'garden', name: '庭院园艺', icon: '🌿', minutes: 30, reward: 40,
      desc: '给窗台上的小花浇水、松土、修剪',
      consume: { satiety: 0.7, thirst: 0.6 }, minLevel: 4, minAff: 10,
    },
    {
      id: 'cook', name: '烹饪大餐', icon: '🍳', minutes: 45, reward: 60,
      desc: '煎一份鲸鱼娘特制松饼，香气飘满整个桌面',
      consume: { satiety: 0.8, energy: 0.6 }, minLevel: 6, minAff: 30,
    },
    {
      id: 'laundry', name: '洗衣熨烫', icon: '👕', minutes: 25, reward: 35,
      desc: '把衣物洗得香喷喷，再一件件熨平',
      consume: { energy: 0.8, thirst: 0.4 }, minLevel: 3, minAff: 0,
    },
    {
      id: 'sew', name: '缝纫修补', icon: '🧵', minutes: 30, reward: 42,
      desc: '针线在指尖翻飞，补好主人心爱的衣物',
      consume: { energy: 0.7, mood: -0.3 }, minLevel: 0, minAff: 50,
    },
    {
      id: 'shop', name: '采购跑腿', icon: '🛒', minutes: 40, reward: 55,
      desc: '出门采买新鲜的食材和日用品',
      consume: { satiety: 0.7, energy: 0.7 }, minLevel: 5, minAff: 0,
    },
    {
      id: 'petcare', name: '照顾宠物', icon: '🐾', minutes: 20, reward: 30,
      desc: '给毛茸茸的小伙伴喂食、梳毛、陪玩',
      consume: { mood: -0.4, energy: 0.3 }, minLevel: 0, minAff: 75,
    },
  ]
const LEVELS = [
    { exp: 0, title: '实习女仆' },
    { exp: 50, title: '见习管家' },
    { exp: 150, title: '初级管家' },
    { exp: 300, title: '中级管家' },
    { exp: 500, title: '高级管家' },
    { exp: 800, title: '金牌管家' },
    { exp: 1200, title: '首席管家' },
    { exp: 1800, title: '深海传说' },
  ]
const AFF_LEVELS = [
    { min: 0, name: '初识' },
    { min: 25, name: '熟悉' },
    { min: 50, name: '亲近' },
    { min: 75, name: '信赖' },
    { min: 100, name: '羁绊' },
  ]
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
function photoDefinitions(options = {}) {
  const NativeDate = globalThis.Date
  const Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [options.now === undefined ? NativeDate.now() : options.now])) }; static now() { return options.now === undefined ? NativeDate.now() : options.now } }
  const R = { get awayDaysAway() { return options.getAway ? options.getAway() : options.awayDaysAway || 0 } }
  const petName = options.getName || (() => '小深')
  const isLunarFestival = (month, day) => { try { const d = new Date(), l = options.Solar.fromYmd(d.getFullYear(), d.getMonth()+1, d.getDate()).getLunar(); return l.getMonth() === month && l.getDay() === day } catch (_) { return false } }
  return [
    // 📖 时光流
    { id: 'first-meet', name: '初次见面', cat: '时光流', desc: '初次见面那天，你轻轻点了下我', event: 'first-boot' },
    { id: 'morning-first', name: '早安第一眼', cat: '时光流', desc: '每天第一眼的对视，早安', event: 'day-first-open' },
    { id: 'noon-tea', name: '午后茶歇', cat: '时光流', desc: '午后的阳光里，一起喝杯茶', time: [13, 15] },
    { id: 'dusk-sunset', name: '傍晚夕阳', cat: '时光流', desc: '夕阳西下，我们一起看橘色天空', time: [17, 19] },
    { id: 'late-night', name: '深夜作伴', cat: '时光流', desc: '夜深了，还陪着你', time: [22, 24] },
    { id: 'dawn-watch', name: '凌晨守候', cat: '时光流', desc: '凌晨的世界很安静，我在', time: [0, 4] },
    { id: 'overtime-night', name: '加班夜', cat: '时光流', desc: '深夜加班，我也加班陪你', check: (p) => p.totalWorkDone >= 1 && new Date().getHours() >= 22 },
    { id: 'weekend-lazy', name: '周末懒散', cat: '时光流', desc: '周末了，一起瘫在沙发放空', check: () => { const d = new Date().getDay(); return d === 0 || d === 6 } },
    { id: 'winter-stove', name: '冬日暖炉', cat: '时光流', desc: '冬天缩在暖炉边，暖洋洋', check: () => { const m = new Date().getMonth() + 1; return m === 12 || m === 1 || m === 2 } },
    { id: 'spring-promise', name: '春天约定', cat: '时光流', desc: '春天的樱花落在肩头，约定好了', check: () => { const m = new Date().getMonth() + 1; return m === 3 || m === 4 } },
    /* （设计稿《相册场景清单》里写了但没实现的场景 + 少量新增场景）。
       全部为 check 型（每 60s 心跳扫描）或事件型 —— 都**确实可触发**，不写死条件。 */
    { id: 'night-owl', name: '熬夜搭子', cat: '时光流', desc: '过了 23 点还没睡，我陪你到最后', time: [23, 24] },
    { id: 'cherry-blossom', name: '秋的故事', cat: '时光流', desc: '秋天枫叶红了，一起在落叶铺的路上走走吧', check: () => { const m = new Date().getMonth() + 1; return m === 10 || m === 11 }, },
    { id: 'rainy-window', name: '雨天在家', cat: '时光流', desc: '外面下着雨，我们就在家待着（梅雨季的陪伴）', check: () => { const m = new Date().getMonth() + 1; return m >= 5 && m <= 9 }, },
    { id: 'stargaze', name: '一起看星星', cat: '时光流', desc: '凌晨两点的窗外，星星很亮', check: () => { const h = new Date().getHours(); return h >= 0 && h < 2 }, },
    // 🏠 生活琐事（动画事件）
    { id: 'clean-time', name: '打扫时间', cat: '生活琐事', desc: '卷起袖子，把房间收拾得干干净净', event: 'clean-done' },
    { id: 'tea-serve', name: '端茶送水', cat: '生活琐事', desc: '该喝水啦，我端过来了', event: 'water-drink' },
    { id: 'bubble-time', name: '彩虹泡泡', cat: '生活琐事', desc: '偶然吹起的泡泡，五彩斑斓', check: (p) => (p.animSeen || []).includes('idle-bubbles') },
    { id: 'mirror-look', name: '照镜子', cat: '生活琐事', desc: '偷看镜子里的自己，整理发梢', check: (p) => (p.animSeen || []).includes('idle-mirror') },
    { id: 'hum-moment', name: '哼歌时刻', cat: '生活琐事', desc: '心情好时，哼哼小曲', check: (p) => (p.animSeen || []).includes('idle-hum') },
    { id: 'fan-breeze', name: '扇风纳凉', cat: '生活琐事', desc: '给你扇扇风，凉快一下', check: (p) => (p.animSeen || []).includes('idle-fan') },
    { id: 'stretch-time', name: '伸懒腰', cat: '生活琐事', desc: '陪你一起伸个懒腰', check: (p) => (p.animSeen || []).includes('idle-stretch') },
    { id: 'little-chef', name: '小厨师', cat: '生活琐事', desc: '系上围裙，给你露一手', check: (p) => (p.animSeen || []).filter(n => n.startsWith('eat-') && !n.includes('caught')).length >= 1 },
    { id: 'sleep-story', name: '睡前故事', cat: '生活琐事', desc: '夜深了，给你讲个小故事再睡', check: (p) => (p.stats && p.stats.energy < 30) && new Date().getHours() >= 21 },
    /* 设计稿 #18 #19 #30 #54 #63 + 新增场景（全部可触发） */
    { id: 'lunch-bento', name: '美味便当', cat: '生活琐事', desc: '午饭时间到，给你做了便当', check: (p) => (p.feedCount || 0) >= 1 && (() => { const h = new Date().getHours(); return h >= 11 && h < 13 })() },
    { id: 'head-pat', name: '摸头杀', cat: '生活琐事', desc: '被摸摸头，眯起眼睛蹭手心', event: 'head-pat' },
    { id: 'new-term-note', name: '新学期寄语', cat: '生活琐事', desc: '课程表排好了，抱着书等你上课', check: (p) => (p.schedule || []).length >= 1 },
    { id: 'sneeze', name: '打喷嚏', cat: '生活琐事', desc: '哈啾！有点着凉了，揉揉鼻头', check: (p) => (p.stats && p.stats.energy < 40) && (() => { const h = new Date().getHours(); return h >= 0 && h < 6 })() },
    // 🎮 一起玩
    { id: 'first-game', name: '初次入局', cat: '一起玩', desc: '陪主人玩的第一个游戏', event: 'game-play' },
    { id: 'gomoku-win', name: '棋逢对手', cat: '一起玩', desc: '五子棋赢啦！不服再来', check: (p) => (p.gameWins || []).includes('gomoku') },
    { id: 'guess-win', name: '同猜数字', cat: '一起玩', desc: '猜数字猜中了，默契满分', check: (p) => (p.gameWins || []).includes('guess') },
    { id: 'mines-clear', name: '扫雷英雄', cat: '一起玩', desc: '扫雷通关！长舒一口气', check: (p) => (p.gameWins || []).includes('mines') },
    { id: 'victory-10', name: '胜者欢呼', cat: '一起玩', desc: '玩了十局游戏，举着小旗欢呼', check: (p) => p.totalGames >= 10 },
    { id: 't2048-master', name: '数字达人', cat: '一起玩', desc: '2048 合出 512，反应真快', check: (p) => (p.gameWins || []).includes('t2048') },
    { id: 'snake-king', name: '贪吃蛇王', cat: '一起玩', desc: '贪吃蛇吃得越来越长', check: (p) => (p.gameWins || []).includes('snake') },
    { id: 'sudoku-master', name: '数独挑战', cat: '一起玩', desc: '数独解出来啦！', check: (p) => (p.gameWins || []).includes('sudoku') },
    { id: 'tickle-battle', name: '挠痒大战', cat: '一起玩', desc: '被挠得笑到缩成一团', check: (p) => (p.animSeen || []).includes('click-tickle') },
    { id: 'tsundere-moment', name: '撒娇时刻', cat: '一起玩', desc: '哼哼，别过头去——其实很开心', check: (p) => (p.animSeen || []).includes('click-tsundere') },
    { id: 'caught-eating', name: '偷吃被抓', cat: '一起玩', desc: '偷吃零食被主人抓个正着', check: (p) => (p.animSeen || []).includes('eat-caught') },
    // 💼 一起工作
    { id: 'first-day', name: '第一天上班', cat: '一起工作', desc: '第一次给主人干活，紧张又认真', check: (p) => (p.workSessions || 0) >= 1 },
    { id: 'hard-coding', name: '认真敲码', cat: '一起工作', desc: '一干就是半小时，超认真', check: (p) => (p.workMinutes || 0) >= 30 },
    { id: 'diligent-maid', name: '勤奋女仆', cat: '一起工作', desc: '累计工作 60 分钟，擦擦汗继续', check: (p) => (p.workMinutes || 0) >= 60 },
    { id: 'exhausted-maid', name: '累瘫了', cat: '一起工作', desc: '累计工作 600 分钟，趴桌上还想着干', check: (p) => (p.workMinutes || 0) >= 600 },
    { id: 'model-worker', name: '劳模认证', cat: '一起工作', desc: '完成 20 次工作，戴上劳模小帽', check: (p) => (p.workSessions || 0) >= 20 },
    { id: 'top-employee', name: '满级宠臣', cat: '一起工作', desc: '完成 50 次工作，闪闪发光', check: (p) => (p.workSessions || 0) >= 50 },
    { id: 'pomo-master', name: '番茄大师', cat: '一起工作', desc: '完成 10 个番茄钟，专注度拉满', check: (p) => (p.pomodoros || 0) >= 10 },
    { id: 'efficient-lunch', name: '高效午餐', cat: '一起工作', desc: '边吃饭边盯屏幕，效率大师', check: (p) => (p.animSeen || []).some(n => n.startsWith('eat-') && (p.workMinutes || 0) > 0) },
    { id: 'remember-me', name: '帮我记住', cat: '一起工作', desc: '都记下来，绝不忘记', check: (p) => (p.memos || []).length >= 1 },
    { id: 'schedule-manager', name: '日程管家', cat: '一起工作', desc: '整周的行程都排上了，安排得明明白白', check: (p) => (p.schedule || []).length >= 5 },
    // 🎉 节日纪念
    { id: 'owner-birthday', name: '生日快乐', cat: '节日纪念', desc: '主人的生日！蛋糕准备好了', event: 'owner-birthday' },
    { id: 'pet-birthday', cat: '节日纪念', event: 'pet-birthday', get name() { try { return petName() + '的生日' } catch (e) { return '生日' } }, get desc() { try { return petName() + '自己的小小庆祝日' } catch (e) { return '自己的小小庆祝日' } } },
    { id: 'new-year', name: '新年快乐', cat: '节日纪念', desc: '新年第一天，穿红围裙拜年', check: () => { const d = new Date(); return d.getMonth() === 0 && d.getDate() === 1 } },
    { id: 'reunion-night', name: '团圆年', cat: '节日纪念', desc: '春节啦，一起吃年夜饭', check: () => isLunarFestival(1, 1) },
    { id: 'lantern-festival', name: '元宵花灯', cat: '节日纪念', desc: '提着灯笼，看花灯亮起来', check: () => isLunarFestival(1, 15) },
    { id: 'dragon-boat', name: '端午粽香', cat: '节日纪念', desc: '粽子煮好啦，切开尝尝', check: () => isLunarFestival(5, 5) },
    { id: 'mid-autumn', name: '中秋赏月', cat: '节日纪念', desc: '月亮好圆，一起吃月饼', check: () => isLunarFestival(8, 15) },
    { id: 'christmas-night', name: '圣诞夜', cat: '节日纪念', desc: '戴上圣诞帽，圣诞快乐', check: () => { const d = new Date(); return d.getMonth() === 11 && d.getDate() >= 24 && d.getDate() <= 25 } },
    { id: 'halloween', name: '万圣节', cat: '节日纪念', desc: '不给糖就捣蛋～', check: () => { const d = new Date(); return d.getMonth() === 9 && d.getDate() === 31 } },
    { id: 'school-start', name: '开学第一天', cat: '节日纪念', desc: '新学期开始啦，要加油', event: 'schedule-add' },
    // 😊 情绪时刻
    { id: 'flying-happy', name: '开心到飞起', cat: '情绪时刻', desc: '好感度满格，开心得飘起来', check: (p) => (p.affection || 0) >= 100 },
    { id: 'tsundere-3', name: '哼哼傲娇', cat: '情绪时刻', desc: '连点三次才知道你想逗我', event: 'click-3' },
    { id: 'shy-whale', name: '害羞小鲸', cat: '情绪时刻', desc: '被逗到脸红，把头埋起来', event: 'click-5' },
    { id: 'miss-you', name: '想你了', cat: '情绪时刻', desc: '一天没见，趴在窗边嘀咕', check: (p) => {
      // 融合判定：A=这次启动**距上次启动 ≥3 天**（用启动时快照 R.awayDaysAway）；
      //          B=常开桌宠但 ≥72h 无互动（lastInteractionAt）
      // 满足其一即触发——覆盖"不常开"和"常开不理我"两类用户。
      // ⚠ A 分支此前恒为假 —— checkPhotoUnlocks 开头会先 updateStreak
      //   把 P.lastSeenDate 写成今天，等这里再算 dayGap 就永远是 0。
      //   现在改成用"启动时捕获的离开天数"（loadState 里先算好，见 R.awayDaysAway），
      //   与 lastSeenDate 的更新顺序解耦。
      // lastInteractionAt===0 表示"无记录"（旧数据/首次），不触发 B。
      const away = (typeof R !== 'undefined' && R && typeof R.awayDaysAway === 'number') ? R.awayDaysAway : 0
      const interactionGap = p.lastInteractionAt ? (Date.now() - p.lastInteractionAt) / 3600000 : Infinity
      return away >= 3 || (p.lastInteractionAt > 0 && interactionGap >= 72)
    } },
    { id: 'sad-moment', name: '委屈巴巴', cat: '情绪时刻', desc: '状态不太好，委屈得想哭', check: (p) => p.stats && p.stats.mood < 30 },
    { id: 'full-energy', name: '元气满满', cat: '情绪时刻', desc: '饱饱的、心情好、精神足', check: (p) => p.stats && p.stats.satiety > 80 && p.stats.mood > 80 && p.stats.energy > 80 },
    { id: 'sleepy-eyes', name: '困到睁不开', cat: '情绪时刻', desc: '眼皮打架，还是想陪你', check: (p) => p.stats && p.stats.energy < 20 },
    { id: 'praised', name: '被夸害羞', cat: '情绪时刻', desc: '被主人夸了，脸有点红', event: 'praised' },
    // 🌱 成长养成
    { id: 'first-cookie', name: '第一块饼干', cat: '成长养成', desc: '第一次喂食，舍不得吃', check: (p) => (p.feedCount || 0) >= 1 },
    { id: 'big-eater', name: '干饭小鲸', cat: '成长养成', desc: '喂食 20 次，胃口超好', check: (p) => (p.feedCount || 0) >= 20 },
    { id: 'piggy-bank', name: '存钱罐', cat: '成长养成', desc: '金币攒到 300，抱紧存钱罐', check: (p) => (p.coins || 0) >= 300 },
    { id: 'rich-girl', name: '小富婆', cat: '成长养成', desc: '金币破千，数钱数到手软', check: (p) => (p.coins || 0) >= 1000 },
    { id: 'three-days', name: '连续守护', cat: '成长养成', desc: '连续陪伴 3 天，慢慢习惯你', check: (p) => (p.streak || 0) >= 3 },
    { id: 'week-promise', name: '一周之约', cat: '成长养成', desc: '连续陪伴 7 天，约定好了', check: (p) => (p.streak || 0) >= 7 },
    { id: 'month-bond', name: '一个月羁绊', cat: '成长养成', desc: '连续陪伴 30 天，早就离不开', check: (p) => (p.streak || 0) >= 30 },
    { id: 'level-up', name: '升级啦', cat: '成长养成', desc: '升到 5 级，头顶发光', check: (p) => (p.level || 0) >= 5 },
    /* 死路：原条件 `level >= 10` 永远不成立（等级表只有 8 档 ⇒ lv 恒 ≤ 8）。
       先改成"满级（Lv.8 · 深海传说）"，**确实可达**；将来若加了 9/10 级（长期方案 C），
       把这里跟着调回 10 即可 —— 两处都在本文件，改一行。 */
    { id: 'deep-sea', name: '深海传说', cat: '成长养成', desc: '升到满级 Lv.8「深海传说」，庄重地行个礼', check: (p) => (p.level || 0) >= 8 },
    /* 成长/进度类（都可触发） */
    /* 番茄钟**不写 workLog**（`focusComplete` 只加 P.pomodoros + diaryEvent），
       所以这里用累计番茄数 + "到晚上 18 点后"来判定"今天连做三个"。 */
    // 💌 特别记忆
    { id: 'surprise-gift', name: '惊喜礼物', cat: '特别记忆', desc: '好感度升档，藏了份小礼物', event: 'affection-up' },
    { id: 'diary-time', name: '日记时光', cat: '特别记忆', desc: '写下第一篇日记，记录今天', check: (p) => ((Array.isArray(p.diaryOutputs) ? p.diaryOutputs.length : 0) > 0) || ((Array.isArray(p.diary) ? p.diary.length : 0) > 0) }, // 2026-09-26 AL-3：P.diary 是 legacy（新版写 P.diaryOutputs）⇒ 条件与写成功路径一致
    { id: 'reunion-moment', name: '重逢时刻', cat: '特别记忆', desc: '好久不见，扑上来抱住你', check: (p) => !!p.lastReunionDate },
    { id: 'daily-summary', name: '今日小结', cat: '特别记忆', desc: '今天的任务全完成啦', event: 'daily-all-done' },
    { id: 'thanks-company', name: '谢谢陪伴', cat: '特别记忆', desc: '陪伴一百个日日夜夜，谢谢你', check: (p) => (p.bootCount || 0) >= 100 },
    { id: 'peaceful-time', name: '岁月静好', cat: '特别记忆', desc: '深夜还在待机，岁月静好', check: () => { const h = new Date().getHours(); return h >= 22 } },
    /* 钱包/陪伴类（可触发） */
    { id: 'empty-pocket', name: '钱包空空', cat: '特别记忆', desc: '金币见底了…我会省着点的', check: (p) => (typeof p.coins === 'number') && p.coins <= 10 },
    { id: 'movie-night', name: '一起看电影', cat: '特别记忆', desc: '十一点了还在放片子，我陪你看完', check: () => { const h = new Date().getHours(); return h === 23 } },
    /* 今天和小深的聊天次数（`P.chatCountToday` 由发送路径按天计数） */
    { id: 'chat-ten', name: '陪我聊聊', cat: '特别记忆', desc: '今天和我说了好多话，我记着呢', check: (p) => (p.chatCountToday || 0) >= 10 },
  ]
}
const UI_PREFERENCE_FIELDS = Object.freeze(['ownerName','ownerBirthday','todos','schedule','memos','semesterStart','firedClasses','hydrateEnabled','hydrateIntervalMin','lastHydrate','waterToday','waterDay','soundEnabled','soundEvents','soundVolume','uiScale','petScale','customLines','disabledGroups','lines','diaryTime'])
return { ITEMS, WORK_JOBS, LEVELS, AFF_LEVELS, ACHIEVEMENTS, UI_PREFERENCE_FIELDS, photoDefinitions }
})
