'use strict'
// Eight final-expression samples, one transport request per arm. Synthetic material only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto')
const root = path.resolve(__dirname, '..'), record = path.resolve(root, '../research/long-lived-character-acceptance-20261017')
const output = path.join(record, 'model-samples'), before = path.join(record, 'before')
const P = require('../model-provider.cjs'), Life = require('../renderer/life/pet-life.js')
const digest = x => crypto.createHash('sha256').update(x).digest('hex')
const now = Date.parse('2026-10-18T14:00:00+08:00')
const texts = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(root, 'prompt-defaults.json'))).map(p => [p.id, p.text]))
const context = { capturedAt: now, personaProjection: { identity: { displayName: '小深' } }, selfState: { energy: 75, satiety: 80, thirst: 75 }, emotion: { derivedMood: 'neutral' }, runtimeFacts: { capturedAt: now }, recentInteractions: [] }
const cases = [
  { id: 'owner-game', task: 'M2_say', focus: '主人刚结束的一局贪吃蛇', form: 'share', candidate: { id: 'game:1', text: '主人在桌宠程序里玩了贪吃蛇，这一局结束了，得分42。', actor: 'owner', observer: 'character', subject: 'owner', world: 'virtual', sourceType: 'game.completed', forms: ['share'], sourceKeys: ['event:game:1'], originTs: now - 60000, date: '2026-10-18', fresh: true } },
  { id: 'character-animation', task: 'M2_say', focus: '桌宠刚才放松了一下', form: 'share', candidate: { id: 'animation:1', text: '桌宠角色刚播放了伸懒腰动画。没有现实世界活动。', actor: 'character', observer: 'system', subject: 'character', world: 'virtual', sourceType: 'animation.completed', forms: ['share'], sourceKeys: ['event:animation:1'], originTs: now - 60000, date: '2026-10-18', fresh: true } },
  { id: 'no-new-event', task: 'M2_say', focus: '随意闲聊', form: 'share', candidate: { id: 'social:1', kind: 'social_contact', text: '已有真实互动，当前交流已结束，可轻松闲聊，也可保持安静。没有新的经历可供声称。', actor: 'character', observer: 'system', subject: 'relationship', world: 'system', forms: ['share'], sourceKeys: [], originTs: now - 14400000, opportunity: { reason: 'relationship_reconnect', lastOwnerAt: now - 14400000 } } },
  { id: 'ordinary-chat', task: 'M1_reply', userText: '终于忙完了，想坐下来随便聊两句。', focus: null, form: null },
]
async function capture(arm, item) {
  const requests = [], renderer = path.join(arm === 'A' ? before : root, 'renderer')
  const window = { PlatformCandidate: { enabled: true }, ContextProjector: require(path.join(renderer, 'dialogue/context-projector.js')), PetLifeModule: Life,
    SpeechChannel: arm === 'B' ? require('../renderer/core/speech-channel.js') : null,
    PromptConfig: { text: (id, fallback) => texts[id] ?? fallback, controls: () => ({}), revision: () => 'source-defaults-fixed' },
    ExpressionStylePolicy: require('../renderer/dialogue/style/style-policy.js').createPolicy(() => ({ rules: require('../renderer/dialogue/style/rules.json'), profiles: require('../renderer/dialogue/style/profiles.json') })),
    AIGateway: { generate: async request => { requests.push(request); return { ok: false, reason: 'capture_only' } } } }
  const sandbox = vm.createContext({ window, console, Date, setTimeout, clearTimeout })
  vm.runInContext(fs.readFileSync(path.join(root, 'renderer/dialogue/slots.js'), 'utf8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(renderer, 'dialogue/gen2.js'), 'utf8'), sandbox)
  if (item.task === 'M1_reply') await window.Gen2.chatReply({ context: structuredClone(context), userText: item.userText, history: [], scale: 'normal', messageRef: 'synthetic:reply', maxTokens: 600 })
  else {
    const candidate = structuredClone(item.candidate), raw = { speak: true, candidateId: candidate.id, focus: item.focus, form: item.form }
    const v = Life.validateDecision({ ...raw, opening: item.focus }, [candidate])
    await window.Gen2.proactiveSay({ ok: true, prepared: { p: { context: structuredClone(context), candidates: [candidate], history: [], nowTs: now, recentOpenings: [] }, raw, v } })
  }
  const request = requests.find(r => r.promptStage === item.task)
  if (!request) throw Error('sample_prompt_not_captured:' + item.id + ':' + arm)
  return { request, sourceHash: digest(fs.readFileSync(path.join(renderer, 'dialogue/gen2.js'))) }
}
async function main() {
  if (fs.existsSync(path.join(output, 'results.json'))) {
    const prior = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json')))
    if (prior.actualCalls !== 0 || fs.existsSync(path.join(output, 'attempt-0-no-key'))) throw Error('samples_already_recorded_no_regeneration')
    fs.mkdirSync(path.join(output, 'attempt-0-no-key'))
    for (const name of ['results.json', 'manifest.json', '全部样本.md']) fs.copyFileSync(path.join(output, name), path.join(output, 'attempt-0-no-key', name))
  }
  fs.mkdirSync(output, { recursive: true })
  const installedPrefs = path.join(process.env.APPDATA, 'deskpet-xiaoshen', 'pet-prefs.json')
  const prefsFile = fs.existsSync(installedPrefs) ? installedPrefs : path.join(root, 'data/pet-prefs.json')
  const prefs = fs.existsSync(prefsFile) ? JSON.parse(fs.readFileSync(prefsFile)) : {}
  const config = require('../model-config.cjs').createModelConfig({ read: () => prefs, write: () => { throw Error('production_write_forbidden') }, legacyKey: () => {
    const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
    return fs.existsSync(file) ? (fs.readFileSync(file, 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(sk-[A-Za-z0-9]+)/) || [])[1] || '' : ''
  } })
  const route = config.resolve('character'), results = [], calls = []
  let active = null, armCalls = 0
  const client = P.createClient({ fetch: async (url, options) => {
    if (++armCalls > 1 || calls.length >= 8) throw Error('one_generation_per_arm')
    const call = { label: active, request: JSON.parse(options.body), startedAt: new Date().toISOString() }
    calls.push(call)
    try { const response = await fetch(url, options), raw = await response.text(); call.httpStatus = response.status; call.response = raw; return { ok: response.ok, status: response.status, text: async () => raw } }
    catch (error) { call.error = error.name; throw error }
    finally { call.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'calls.json'), JSON.stringify(calls, null, 2)) }
  } })
  for (const item of cases) for (const arm of ['A', 'B']) {
    active = item.id + ':' + arm; armCalls = 0
    const captured = await capture(arm, item), p = captured.request
    const request = { model: route.model, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.userText }], temperature: 0.8, maxTokens: 600, timeoutMs: 45000, thinking: { type: 'disabled' } }
    const result = route.ok ? await client.complete(route.connection, request) : { ok: false, error: route.error }
    results.push({ caseId: item.id, arm, input: item, context, sourceHash: captured.sourceHash, request, result,
      channelCheck: result.ok ? require('../renderer/core/speech-channel.js').validate(result.text) : null,
      humanEvaluation: { AI模板感: null, 小深角色一致性: null, 自然相处感: null, 陪伴模板感: null, 情绪是否过量: null } })
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify({ caseId: item.id, arm, ok: result.ok, error: result.error || null }))
  }
  const manifest = { at: new Date().toISOString(), actualCalls: calls.length, limit: 8, model: route.model, protocol: route.connection?.protocol,
    parameters: { temperature: 0.8, maxTokens: 600, timeoutMs: 45000, thinking: 'disabled' }, adopted: false,
    boundary: 'Only final M1_reply/M2_say prompts captured from real source; metadata/decision stages are not sampled. Fixed synthetic identity/context/candidates/focus/form. No production persona or chat transmitted. No regeneration or answer selection.' }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  let md = '# 完整 A/B 表达样本\n\n状态：待用户评价。A=本轮修复前快照，B=本轮候选。不是新 Kernel 全链运行验收。\n\n' +
    '固定人工素材、上下文、候选、focus、form；同一模型 '+ route.model +'；temperature=0.8，maxTokens=600，thinking=disabled。每组每侧各请求一次；无重写、无挑选、无补抽。只生成最终正文，元数据和决策调用不在此比较内。\n\n'
  for (const item of cases) {
    md += '## ' + item.id + '\n\n'
    for (const row of results.filter(r => r.caseId === item.id)) md += '### ' + row.arm + '\n\n' + (row.result.ok ? row.result.text : '生成失败：' + row.result.error) + '\n\n'
    md += '可观察差异：____\n\n评价：AI模板感____；小深角色一致性____；自然相处感____；陪伴模板感____；情绪是否过量____。\n\n'
  }
  fs.writeFileSync(path.join(output, '全部样本.md'), md)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
