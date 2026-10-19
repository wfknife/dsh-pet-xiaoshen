'use strict'
/*
 * DeskPet Model Registry — Update & Compatibility Manager · P0-A（声明/状态）+ B3（发现/验证/路由）
 *
 * 单一来源（single source of truth）：所有 Direct Provider（Character Chat /
 * Diary / Expression）与 DSH 会话（Work/Agent）的模型 ID 都从这里取，
 * 业务代码里不再散落字面量。
 *
 * 纯函数 + **零 I/O**：不联网、不读写文件、不执行进程动作、不修改任何状态。
 * 「发现」只做分类与建议，**绝不自动迁移**（AUTO_MIGRATION_ENABLED 恒为 false，
 * DECLARED 从本模块外永不可写）。
 *
 * 元数据来源（人工核对，随版本发布更新）：
 * - DeepSeek 官方 changelog （V4.1-Flash GA = deepseek-flash；
 *     V4 Flash / V4 Flash Vision Exp 已下线，旧 ID 作为兼容别名被临时路由到
 * V4.1 Flash；deepseek-v4-pro 将于 12:00 起路由到 V4.1 Flash）
 * - 本机 DSH 客户端模型目录（~/.dsh/settings.yaml， 刷新）
 */

const REGISTRY_VERSION = 2
const META_SOURCE = 'deepseek-changelog-2026-09-10'
/* 硬闸：模型迁移/切换**永不自动执行**。任何调用方都不得据此改 DECLARED。 */
const AUTO_MIGRATION_ENABLED = false
/* 视图/状态有界化：官方目录最多接受 200 个 ID，未收录（discovered）最多 100 条 */
const MAX_LISTED_IDS = 200
const MAX_DISCOVERED = 100

/* 用途 → **声明**模型 ID（当前阶段 = 保持现状，迁移绝不由本模块自动执行）。
   ★ M1（2026-09-18）结论：**不动这里的值**。
     · "默认最新 Flash / 可自动跟随新 Flash" 由**生效档**实现（`main.js` 的 `effectiveChatModel()`：
       用户偏好 → 否则 `latestFlashId()`），与这里的"声明档"是两件事；
     · 声明档一旦是别名，B3 会把它作为 `declared-alias` 冲突**显式上报**并给迁移建议
       （`actionRequired=recommended`，`autoMigrationEnabled=false`）——迁移必须由用户显式触发。
     · 若把声明档直接改成 `latestFlashId()`，等于让本模块"自动迁移"，与 B3 的边界冲突。
   vision 档：GA Flash 原生多模态；专有 `deepseek-v4-flash-vision-exp` 已下线且未验证，不采用。 */
const DECLARED = {
  character: 'deepseek-v4-flash', // Character Chat（mini chat）——DirectLLM
  diary: 'deepseek-v4-flash', // 日记（DirectLLM）
  expression: 'deepseek-v4-flash', // 表达/演出（DirectLLM）
  vision: 'deepseek-v4-flash', // 感知/看图（GA Flash 原生多模态；专有 Vision-Exp 已下线）
  work: 'deepseek-v4-flash', // DSH 会话模型（Work/Agent/summary）
  /* F4-S5：主动开场话题生成。**默认跟随 character 档**
     （见 modelFor 的 follow 规则）⇒ 不新增用户设置项、不上架设置页。 */
  proactive: 'deepseek-v4-flash',
}

/* 本地已知模型元数据。字段：
     lifecycle  ga / alias / routed / retired / unknown（本地元数据生命周期）
     verified   该 ID 的生命周期元数据是否已人工核对确认（unknown 一律 false）
                —— 未验证的 ID 不产生任何迁移建议，也不进入"可信"集合
     recommended 建议迁移目标（仅建议；绝不自动应用）
     routeAfter 官方公布的路由生效时刻（ISO-8601 带时区；绝对时间比较） */
const KNOWN_MODELS = {
  'deepseek-flash': {
    name: 'DeepSeek-V4.1-Flash (GA)',
    lifecycle: 'ga',
    verified: true, // 官方 changelog 明确给出的 GA ID（元数据已核对）
    recommended: null,
    note: '官方 GA 模型 ID（2026-09-10 起），原生多模态、1M 上下文',
    routeAfter: null,
    source: META_SOURCE,
  },
  'deepseek-v4-flash': {
    name: 'DeepSeek-V4-Flash (legacy)',
    lifecycle: 'alias',
    verified: true, // 当前 DeskPet 声明在用，行为已知
    recommended: 'deepseek-flash',
    note: 'V4 Flash 已下线；该 ID 作为兼容别名被临时路由到 V4.1 Flash（官方未公布别名失效日期）',
    routeAfter: null,
    source: META_SOURCE,
  },
  'deepseek-v4-pro': {
    name: 'DeepSeek-V4-Pro',
    lifecycle: 'routed',
    verified: true, // 官方明确公布路由计划（元数据已核对）
    recommended: 'deepseek-flash',
    note: '官方计划有序下线：2026-09-14 12:00（北京时间）起请求全部路由到 V4.1 Flash 并按新单价计费',
    routeAfter: '2026-09-14T12:00:00+08:00',
    source: META_SOURCE,
  },
  'deepseek-v4-flash-vision-exp': {
    name: 'DeepSeek-V4-Flash-Vision-Exp (experimental)',
    lifecycle: 'alias',
    verified: false, // 实验 ID：本地未验证其调用路径与稳定性 → 不产生迁移建议
    recommended: 'deepseek-flash',
    note: '实验模型已下线；该 ID 作为兼容别名被临时路由到 V4.1 Flash（未验证，不据此做任何动作）',
    routeAfter: null,
    source: META_SOURCE,
  },
}

const UNKNOWN_META = {
  name: null,
  lifecycle: 'unknown',
  verified: false,
  recommended: null,
  note: '本地元数据未收录该模型（不据此做任何动作）',
  routeAfter: null,
  source: null,
}

/* 用户可选：**白名单**。
   只收录"本地元数据已核对（verified）且可用"的 ID —— 用户偏好只能落在这里。
   生命周期判定仍由 KNOWN_MODELS 决定：
     · 名单里已下线的 ID（alias）被标为"兼容别名，实际路由到新 GA"，**可继续选**（它仍能出结果）；
     · retired / verified=false 的 ID 直接不可选（filterSelectable 过滤）。
   新增可选模型只改这里 + KNOWN_MODELS，不改任何调用点。
   「默认档」= latestFlashId()（当前 = 最新 Flash 的 GA ID）；Pro 一律只做显式选项，
   Pro 永不被任何"自动跟随新模型"逻辑选中（AUTO_MIGRATION_ENABLED 恒 false 是同一道闸）。 */
const USER_SELECTABLE = ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro']

/* 「最新 Flash 档」：GA 且 verified。用**条件筛选**而不是写死 ID，
   这样将来发布新 Flash（GA + verified）时，"跟随最新 Flash"自动指向新 ID。
   ⚠ 本函数只用于**生效档/默认档**（如 Chat 未设偏好时），**不写回 DECLARED**。 */
function latestFlashId() {
  for (const id of Object.keys(KNOWN_MODELS)) {
    const m = KNOWN_MODELS[id]
    if (m.verified === true && m.lifecycle === 'ga') return id
  }
  return DECLARED.character
}

/* 用户可选白名单：过滤掉 retired 与本地未核对的 ID；顺序按 USER_SELECTABLE 声明。
   每项带 usable/recommendedTarget/advanced 三个派生字段，供 UI 直接渲染。 */
function selectableModels(opts) {
  const out = []
  for (const id of USER_SELECTABLE) {
    if (!isKnown(id)) continue
    const m = KNOWN_MODELS[id]
    if (m.verified !== true) continue
    if (m.lifecycle === 'retired') continue
    out.push({
      id,
      name: m.name || id,
      lifecycle: m.lifecycle,
      usable: true,
      /* recommendedTarget 只对**已下线/被替代**的 ID 有意义（别名）。
         routed 是"官方计划路由"，含义不同（到点后请求实际由目标模型服务），
         由 routeAfter/routeState 表达，不能与别名混为一谈 —— 否则 UI 会把
         "选了 Pro" 说成"Pro 只是别名"。 */
      recommendedTarget: m.lifecycle === 'alias' && typeof m.recommended === 'string' && m.recommended ? m.recommended : null,
      routeAfter: m.routeAfter || null,
      note: m.note || '',
      advanced: m.lifecycle === 'routed' || m.lifecycle === 'retired',
    })
  }
  /* （用户口径「根据自己配置的提供商与 api 自动探测改选项」）：
     若端点探测成功（endpointModels 非空），**选项以该端点的实际模型为准**——
     官方白名单里不在端点列表中的项（如已下线的兼容别名）不再出现，避免选了用不了。
     探测不可用（无端点信息）时退回官方白名单，行为与改动前一致。 */
  try {
    const ep = Array.isArray((opts || {}).endpointModels) ? (opts || {}).endpointModels : null
    if (ep && ep.length) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (!ep.some((x) => String(x) === out[i].id)) out.splice(i, 1)
      }
    }
  } catch (err) { /* 过滤失败不影响白名单渲染 */ }
  /* 并入"端点 ∪ 用户已确认"的自定义 ID（与官方项按 id 去重；自定义项显式标 custom）。 */
  try {
    for (const item of modelsForEndpoint(opts)) {
      if (out.some((x) => x.id === item.id)) continue
      out.push(item)
    }
  } catch (err) { /* 合并失败不影响官方白名单渲染 */ }
  return out
}

/* 用户偏好是否被允许（白名单判定，落点必须在主进程；renderer 只渲染）。
   2026-10-10（用户选 C 档）：允许「白名单 ∪ 端点作用域模型 ∪ 用户自定义」——
   opts.endpointModels = 该 baseUrl 下探测到的模型 ID（第三方服务商）；
   opts.userModels     = 用户已确认的自定义 ID。判定仍只在主进程。 */
function isSelectable(id, opts) {
  const s = String(id == null ? '' : id).trim()
  if (!s) return false
  if (selectableModels(opts).some((m) => m.id === s)) return true
  return isValidModelId(s) && userSelectableModels(opts).indexOf(s) >= 0
}

/* 自定义模型 ID 的形状校验：非空、≤256、不含空白/控制字符；斜杠允许用于模型命名空间。 */
function isValidModelId(id) {
  const s = String(id == null ? '' : id).trim()
  if (!s || s.length > 256) return false
  if (/[\s\x00-\x1f\x7f]/.test(s)) return false
  return true
}

/* 端点作用域内的模型 ID（探测结果 ∪ 已确认），按出现顺序去重。 */
function userSelectableModels(opts) {
  const o = opts || {}
  const out = []
  const push = (x) => {
    const s = String(x == null ? '' : x).trim()
    if (!s) return
    if (!isValidModelId(s)) return
    if (out.indexOf(s) >= 0) return
    out.push(s)
  }
  const confirmed = Array.isArray(o.userModels) ? o.userModels : USER_SELECTABLE
  for (const x of confirmed) push(x)
  const endpoint = Array.isArray(o.endpointModels) ? o.endpointModels : []
  for (const x of endpoint) push(x)
  return out
}

/* 按端点构造可直接渲染的条目：**只含用户自定义 / 端点探测到的 ID**
   （官方白名单由 selectableModels 自己出，这里不重复隐式带入）；不在 KNOWN_MODELS 里的一律标 unknown。 */
function modelsForEndpoint(opts) {
  const o = opts || {}
  const known = o.endpointModels || null
  const list = userSelectableModels({ userModels: o.userModels || [], endpointModels: o.endpointModels || [] })
  return list.map((id) => {
    const meta = metaFor(id)
    return {
      id,
      name: meta.name || id,
      lifecycle: meta.lifecycle,
      verified: meta.verified === true,
      usable: true,
      recommendedTarget: null,
      routeAfter: null,
      note: meta.note || '',
      advanced: false,
      custom: !isKnown(id),
      listedInEndpoint: Array.isArray(known) ? known.indexOf(id) >= 0 : false,
    }
  })
}

const LIFECYCLES = ['ga', 'alias', 'routed', 'retired', 'unknown']
const STATES = ['ga', 'alias', 'routed', 'retired', 'unknown', 'listed-unverified']

/* 渲染层/历史调用传入的 purpose 字符串 → 规范用途。
   四档（+ 表达档）：character / diary / expression / vision / work。
   vision 明确收口到「看图/视觉」类字符串，避免误吞 work/summary。 */
function purposeFor(raw) {
  const s = String(raw == null ? '' : raw).toLowerCase()
  /* F4-S5：主动开场（proactiveTopic 专用；必须排在其它关键词之前，避免被通用规则吞掉） */
  if (s.includes('proactive')) return 'proactive'
  if (s.includes('diary') || s.includes('journal')) return 'diary'
  if (s.includes('express') || s.includes('perform')) return 'expression'
  if (s.includes('work') || s.includes('agent') || s.includes('summary')) return 'work'
  if (s.includes('vision') || s.includes('image') || s.includes('visual') || s.includes('screenshot') || s.includes('ocr')) return 'vision'
  return 'character'
}

/* 用户**可配置**的场景（原则：能选就明写能选；**没有真实调用点的档一律不给用户选**）。
   · character = Chat 直连（`pet.js` → `AIGateway.request({role:'chat'})`）
   · diary     = 日记直连（`diary-engine.js` → `role:'diary'`）
   不给用户选的档（声明槽保留、将来接线即有位置，但**不上架**）：
   · expression = `DialogueEngine.tryAI()` 的旁路存在，但 `aiEnabled` 默认 false 且全仓无人
                 调用 `setAIEnabled(true)` ⇒ 实际不可达（给没接线的通道配档位 = 假控件）
   · vision     = 当前**没有任何直连视觉调用**（感知的 vision 是本地检测器，不调 LLM）
   · work       = DSH 辅助会话模型由**派活面板/会话本身**管理，设置页不再重复一个旋钮 */
const CONFIGURABLE_PURPOSES = ['character', 'diary']

function configurablePurposes() {
  return CONFIGURABLE_PURPOSES.slice()
}

function isConfigurablePurpose(p) {
  return CONFIGURABLE_PURPOSES.indexOf(p) >= 0
}

/* 用途清单（**声明层**，顺序按声明表）——注意：声明 ≠ 可配置；
   设置页只上架 `configurablePurposes()`。 */
function purposeList() {
  return Object.keys(DECLARED)
}

function isPurpose(p) {
  return Object.prototype.hasOwnProperty.call(DECLARED, p)
}

/* 用途 → 模型 ID（唯一取用入口）。未知用途退化为 character：绝不返回空值。 */
function modelFor(purpose) {
  const key = isPurpose(purpose) ? purpose : 'character'
  /* F4-S5：proactive 明确**跟随 character 档**（默认同模型；character 档位变化时自动跟随）。 */
  if (key === 'proactive') return modelFor('character')
  const id = DECLARED[key]
  return typeof id === 'string' && id ? id : DECLARED.character
}

/* 声明表的只读快照（永远是副本：调用方改不动 DECLARED） */
function declared() {
  return Object.assign({}, DECLARED)
}

function sanitizeMeta(m) {
  const o = m && typeof m === 'object' ? m : {}
  const lifecycle = LIFECYCLES.indexOf(o.lifecycle) >= 0 ? o.lifecycle : 'unknown'
  return {
    name: typeof o.name === 'string' ? o.name.slice(0, 120) : null,
    lifecycle,
    verified: o.verified === true,
    recommended: typeof o.recommended === 'string' && o.recommended ? o.recommended.slice(0, 64) : null,
    note: typeof o.note === 'string' ? o.note.slice(0, 240) : '',
    routeAfter: typeof o.routeAfter === 'string' && o.routeAfter ? o.routeAfter.slice(0, 40) : null,
    source: typeof o.source === 'string' ? o.source.slice(0, 80) : null,
  }
}

/* opts.meta 仅用于测试/未来动态元数据注入：不传则用本地人工核对表。 */
function metaFor(id, metaOverride) {
  if (metaOverride && typeof metaOverride === 'object') return sanitizeMeta(metaOverride)
  const m = KNOWN_MODELS[id]
  return m ? Object.assign({}, m) : Object.assign({}, UNKNOWN_META)
}

function isKnown(id) {
  return Object.prototype.hasOwnProperty.call(KNOWN_MODELS, id)
}

function allKnownIds() {
  return Object.keys(KNOWN_MODELS)
}

function metaVerified(id) {
  return isKnown(id) && KNOWN_MODELS[id].verified === true
}

/* 迁移建议目标必须"本地已收录且已验证"；否则建议被抑制（绝不建议迁移到未验证模型）。 */
function recommendationTarget(id) {
  return { known: isKnown(id), verified: metaVerified(id) }
}

/* B3：路由计划状态 —— **绝对时间比较**（Date.parse 归一为 epoch ms）。
   routeState: scheduled（未到）/ due（恰好到点）/ passed（已过）/ invalid（元数据不可解析）/
               null（没有路由计划）。绝不做字符串/本地化时间比较。 */
function routeStateFor(routeAfter, nowMs) {
  const out = { routeAfter: null, routeDue: null, routeState: null, routeInvalid: false }
  if (typeof routeAfter !== 'string' || !routeAfter.trim()) return out
  const ms = Date.parse(routeAfter)
  if (!Number.isFinite(ms)) {
    out.routeAfter = routeAfter
    out.routeState = 'invalid'
    out.routeInvalid = true
    return out
  }
  const n = Number(nowMs)
  const now = Number.isFinite(n) ? n : Date.now()
  out.routeAfter = routeAfter
  out.routeDue = ms
  out.routeState = now < ms ? 'scheduled' : (now === ms ? 'due' : 'passed')
  return out
}

/* 状态分类（六态，优先级固定）：
     1 retired / alias / routed —— 本地生命周期元数据优先（与目录是否列出无关）
     2 listed-unverified —— 官方目录列出但本地无元数据（或本地 GA 元数据不可信/已从目录消失）
     3 unknown          —— 本地未收录且目录未列出（或尚未探测）
     4 ga               —— 本地 GA 元数据且可信（verified && 未被目录否定）
   注意 unknown/listed-unverified 一律 actionRequired='none'、recommended=null、migration=null。 */
function classifyState(known, m, listed, trusted) {
  if (m.lifecycle === 'retired') return 'retired'
  if (m.lifecycle === 'alias') return 'alias'
  if (m.lifecycle === 'routed') return 'routed'
  if (!known) return listed === true ? 'listed-unverified' : 'unknown'
  if (m.lifecycle === 'ga') return trusted ? 'ga' : 'listed-unverified'
  return listed === true ? 'listed-unverified' : 'unknown'
}

/* 单模型状态。listedIds 为 null 表示"尚未探测官方目录"（不猜测）。
   actionRequired: none | recommended | required —— 仅用于展示/建议，不触发任何执行。 */
function statusFor(id, opts) {
  const o = opts || {}
  const listedIds = Array.isArray(o.listedIds) ? o.listedIds : null
  const n = Number(o.nowMs)
  const nowMs = Number.isFinite(n) ? n : Date.now()
  const hasMetaOverride = !!(o.meta && typeof o.meta === 'object')
  const known = hasMetaOverride ? true : isKnown(id)
  const m = metaFor(id, o.meta)
  const listed = listedIds ? listedIds.indexOf(id) >= 0 : null
  const verified = known && m.verified === true
  /* trusted：本地已验证，且官方目录未明确否定它（未探测视为可信） */
  const trusted = verified && listed !== false
  const listedButUnverified = listed === true && !verified
  const reasons = []

  /* 迁移建议（**仅建议**）：必须同时满足
       ① 本地显式生命周期元数据（alias/routed/retired）且该条元数据 verified=true；
       ② 目标已收录且 verified=true；
       ③ 目标 ≠ 自身。
     任何一条不满足 → 抑制（未知/未验证模型永不产生迁移推荐）。 */
  const rawRecommended = known && m.verified === true &&
    (m.lifecycle === 'alias' || m.lifecycle === 'routed' || m.lifecycle === 'retired')
    ? m.recommended
    : null
  let recommended = null
  let recommendedSuppressed = false
  if (rawRecommended && rawRecommended !== id) {
    const target = recommendationTarget(rawRecommended)
    if (target.known && target.verified) recommended = rawRecommended
    else {
      recommendedSuppressed = true
      reasons.push('建议目标 ' + rawRecommended + ' 未通过本地验证，已抑制迁移建议')
    }
  } else if (m.recommended) {
    recommendedSuppressed = true
    reasons.push('本地元数据未验证或目标无效，已抑制迁移建议')
  }

  const route = routeStateFor(m.routeAfter, nowMs)
  const state = classifyState(known, m, listed, trusted)

  let actionRequired = 'none'
  if (m.lifecycle === 'retired') {
    actionRequired = 'required'
    reasons.push('模型已下线')
  }
  if (m.lifecycle === 'alias') {
    if (verified && recommended) {
      if (actionRequired === 'none') actionRequired = 'recommended'
      reasons.push('当前为兼容别名，实际路由到 ' + recommended)
    } else if (verified) {
      reasons.push('当前为兼容别名，但无可信的迁移目标')
    } else {
      reasons.push('兼容别名（本地元数据未验证，不产生迁移建议）')
    }
  }
  if (route.routeState && verified) {
    if (route.routeState === 'scheduled') {
      if (actionRequired === 'none') actionRequired = 'recommended'
      reasons.push('官方已公布路由计划：' + route.routeAfter + '（未到）')
    } else if (route.routeState === 'due') {
      if (actionRequired === 'none') actionRequired = 'recommended'
      reasons.push('路由计划到点：' + route.routeAfter)
    } else if (route.routeState === 'passed') {
      if (actionRequired === 'none') actionRequired = 'recommended'
      reasons.push('路由计划已过：' + route.routeAfter + '（本地元数据需刷新）')
    }
  } else if (route.routeState === 'invalid') {
    reasons.push('routeAfter 无法解析（本地元数据错误）：' + route.routeAfter)
  } else if (route.routeState && !verified) {
    reasons.push('存在路由计划（' + route.routeAfter + '，状态 ' + route.routeState + '）但本地元数据未验证，不产生动作建议')
  }
  if (listed === false && m.lifecycle !== 'alias') {
    actionRequired = 'required'
    reasons.push('官方模型目录中已不存在该 ID')
  }
  if (listed === false && m.lifecycle === 'alias') reasons.push('官方模型目录中已不再列出（别名为临时路由）')
  if (listed === true && state === 'ga' && actionRequired === 'none') reasons.push('官方目录中存在，且为 GA')
  if (listedButUnverified) reasons.push('官方目录列出但本地未验证（不产生推荐/不自动切换）')
  if (listed === null) reasons.push('尚未探测官方模型目录')
  if (!known) reasons.push('本地元数据未收录（discovered）')

  const migration = recommended
    ? {
        from: id,
        to: recommended,
        mode: actionRequired === 'required' ? 'required' : 'recommended',
        autoApply: false,
        requiresUserAction: true,
      }
    : null

  return {
    id,
    known,
    name: m.name,
    lifecycle: m.lifecycle,
    listed,
    verified,
    trusted,
    listedButUnverified,
    state,
    recommended,
    recommendedSuppressed,
    note: m.note,
    routeAfter: route.routeAfter,
    routeDue: route.routeDue,
    routeState: route.routeState,
    routeInvalid: route.routeInvalid,
    source: m.source,
    actionRequired,
    migration,
    autoMigrationEnabled: AUTO_MIGRATION_ENABLED,
    reasons,
  }
}

function maxAction(list) {
  if (list.indexOf('required') >= 0) return 'required'
  if (list.indexOf('recommended') >= 0) return 'recommended'
  return 'none'
}

/* 全部用途状态（供设置页/管理器展示）+ B3：全已知模型表与 discovered（目录里出现但本地未收录）。
   listedIds 为 null 时只展示声明与本地元数据（不猜测目录）。 */
function statusForAll(opts) {
  const o = opts || {}
  const n = Number(o.nowMs)
  const nowMs = Number.isFinite(n) ? n : Date.now()
  const base = {
    listedIds: Array.isArray(o.listedIds) ? o.listedIds.filter((x) => typeof x === 'string').slice(0, MAX_LISTED_IDS) : null,
    nowMs,
  }
  const purposes = {}
  for (const purpose of Object.keys(DECLARED)) {
    purposes[purpose] = Object.assign({ purpose }, statusFor(modelFor(purpose), base))
  }
  const ids = new Set(allKnownIds())
  for (const p of Object.keys(DECLARED)) ids.add(modelFor(p))
  const lifecycle = {}
  for (const id of ids) lifecycle[id] = statusFor(id, base)
  const discovered = (base.listedIds || [])
    .filter((id) => !isKnown(id))
    .slice(0, MAX_DISCOVERED)
    .map((id) => statusFor(id, base))

  const declaredIds = Object.keys(DECLARED).map((p) => modelFor(p))
  const entries = Object.keys(lifecycle).map((id) => Object.assign({ id }, lifecycle[id]))
  const pickRoute = (arr) => arr
    .filter((e) => e.routeDue !== null && e.routeDue !== undefined && Number.isFinite(Number(e.routeDue)))
    .sort((a, b) => Number(a.routeDue) - Number(b.routeDue))[0] || null
  const chosen = pickRoute(entries.filter((e) => declaredIds.indexOf(e.id) >= 0)) || pickRoute(entries)

  return {
    registryVersion: REGISTRY_VERSION,
    metaSource: META_SOURCE,
    autoMigrationEnabled: AUTO_MIGRATION_ENABLED,
    declared: declared(),
    listedIds: base.listedIds ? base.listedIds.slice() : null,
    purposes,
    lifecycle,
    discovered,
    states: STATES.slice(),
    routeId: chosen ? chosen.id : null,
    routeDue: chosen ? chosen.routeDue : null,
    routeState: chosen ? chosen.routeState : null,
    actionRequired: maxAction(Object.keys(purposes).map((p) => purposes[p].actionRequired)),
    discoveredCount: discovered.length,
  }
}

module.exports = {
  REGISTRY_VERSION,
  META_SOURCE,
  AUTO_MIGRATION_ENABLED,
  MAX_LISTED_IDS,
  MAX_DISCOVERED,
  DECLARED,
  KNOWN_MODELS,
  USER_SELECTABLE,
  declared,
  modelFor,
  purposeFor,
  purposeList,
  CONFIGURABLE_PURPOSES,
  configurablePurposes,
  isConfigurablePurpose,
  isPurpose,
  metaFor,
  isKnown,
  metaVerified,
  allKnownIds,
  routeStateFor,
  statusFor,
  statusForAll,
  latestFlashId,
  selectableModels,
  isSelectable,
  isValidModelId,
  userSelectableModels,
  modelsForEndpoint,
}
