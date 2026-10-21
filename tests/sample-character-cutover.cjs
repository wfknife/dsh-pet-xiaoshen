'use strict'
// Eight final-expression samples, one transport request per arm. Synthetic material only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto')
const root = path.resolve(__dirname, '..'), record = path.resolve(root, '../research/long-lived-character-cutover-20261018')
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
  if (arm === 'B') {
    const stylePolicy = require('../renderer/dialogue/style/style-policy.js').createPolicy(() => ({ rules: require('../renderer/dialogue/style/rules.json'), profiles: require('../renderer/dialogue/style/profiles.json') }))
    const slots = require('../renderer/dialogue/slots.js').createSlots({ PromptConfig: {text:(id,fallback)=>texts[id]??fallback}, ExpressionStylePolicy:stylePolicy })
    const style=await slots.styleSlot(item.task), reply=item.task==='M1_reply'
    const template=texts[item.task]||slots.join([slots.idSlot('小深',{honest:reply}),slots.voSlot(),slots.ftSlot(),style?texts[style.promptId]:'',reply?texts['m1.4c9d3ced5c']:texts['m2.6f027c6a99'],reply?texts['m1.935da7e303']:'只输出这一句话。'])
    const sourceId=item.candidate?.sourceKeys?.[0]||(reply?'synthetic:reply':null)
    const input={styleTemplate:template,context:{sections:{state:context.selfState,identity:context.personaProjection.identity,memories:[],concerns:[],observations:sourceId&&!reply?[{sourceId,kind:item.candidate.sourceType,payload:item.candidate}]:[]}},
      act:{kind:reply?'reply':'social_contact',userText:item.userText,focus:item.focus,goal:item.candidate?.text},sources:reply?[{sourceId,actor:'owner',world:'user_report',text:item.userText}]:[],
      evidenceRefs:sourceId?[sourceId]:[],history:[],form:reply?'reply':item.form}
    const messages=require('../character/cognition/express.cjs').buildExpressMessages(input)
    return {request:{system:messages[0].content,userText:messages[1].content},sourceHash:digest(fs.readFileSync(path.join(root,'character/cognition/express.cjs'))),input}
  }
  const requests = [], renderer = path.join(arm === 'A' ? before : root, 'renderer')
  const window = { PlatformCandidate: { enabled: true }, ContextProjector: require(path.join(renderer, 'dialogue/context-projector.js')), PetLifeModule: Life,
    SpeechChannel: arm === 'B' ? require('../renderer/core/speech-channel.js') : null,
    PromptConfig: { text: (id, fallback) => texts[id] ?? fallback, controls: () => ({}), revision: () => 'source-defaults-fixed' },
    ExpressionStylePolicy: require('../renderer/dialogue/style/style-policy.js').createPolicy(() => ({ rules: require('../renderer/dialogue/style/rules.json'), profiles: require('../renderer/dialogue/style/profiles.json') })),
    AIGateway: { generate: async request => { requests.push(request); return { ok: false, reason: 'capture_only' } } } }
  const sandbox = vm.createContext({ window, console, Date, setTimeout, clearTimeout })
  vm.runInContext(fs.readFileSync(path.join(root, 'renderer/dialogue/slots.js'), 'utf8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(renderer, 'dialogue/gen2.js'), 'utf8'), sandbox)
  if (item.task === 'M1_reply') await window.Gen2.chatReply({ context: structuredClone(context), userText: item.userText, history: [], scale: 'normal', messageRef: 'synthetic:reply', maxTokens: 500 })
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
    if (++armCalls > 1 || calls.length >= 12) throw Error('one_request_per_stage')
    const call = { label: active, request: JSON.parse(options.body), startedAt: new Date().toISOString() }
    calls.push(call)
    try { const response = await fetch(url, options), raw = await response.text(); call.httpStatus = response.status; call.response = raw; return { ok: response.ok, status: response.status, text: async () => raw } }
    catch (error) { call.error = error.name; throw error }
    finally { call.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(output, 'calls.json'), JSON.stringify(calls, null, 2)) }
  } })
  for (const item of cases) for (const arm of ['A', 'B']) {
    active = item.id + ':' + arm; armCalls = 0
    const captured = await capture(arm, item), p = captured.request
    const request = { model: route.model, messages: [{ role: 'system', content: p.system }, { role: 'user', content: p.userText }], temperature: 0.8, maxTokens: 500, timeoutMs: 45000, thinking: { type: 'disabled' } }
    const result = route.ok ? await client.complete(route.connection, request) : { ok: false, error: route.error }
    let grounding = null
    if(arm==='B'&&result.ok) {
      active=item.id+':B:semantic-audit';armCalls=0
      const gateway={parseJson:require('../character/cognition/model-gateway.cjs').createModelGateway({host:{},config:require('../character/config.cjs').createConfig()}).parseJson,
        complete:async p=>{if(p.task==='express')return result;const checked=await client.complete(route.connection,{model:route.model,messages:p.messages,temperature:0,maxTokens:3000,timeoutMs:45000,thinking:{type:'disabled'}});if(!checked.ok)throw Error(checked.error);return checked}}
      grounding=await require('../character/cognition/express.cjs').createExpresser({gateway}).express(captured.input)
    }
    results.push({ caseId: item.id, arm, input: item, context, sourceHash: captured.sourceHash, request, result,
      channelCheck: result.ok ? require('../renderer/core/speech-channel.js').validate(result.text) : null, grounding,
      humanEvaluation: { AI模板感: null, 小深角色一致性: null, 自然相处感: null, 陪伴模板感: null, 情绪是否过量: null } })
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify({ caseId: item.id, arm, ok: result.ok, error: result.error || null }))
  }
  const manifest = { at: new Date().toISOString(), actualCalls: calls.length, limit: 12, generationCalls:8, separateSemanticAudits:4, model: route.model, protocol: route.connection?.protocol,
    parameters: { temperature: 0.8, maxTokens: 500, timeoutMs: 45000, thinking: 'disabled' }, adopted: false,
    boundary: 'Only final M1_reply/M2_say prompts captured from real source; metadata/decision stages are not sampled. Fixed synthetic identity/context/candidates/focus/form. No production persona or chat transmitted. No regeneration or answer selection.' }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
  let md = '# 完整 A/B 表达样本\n\n状态：待用户评价。A=2026-10-18 施工前 renderer Gen2（已获 B 偏好的版本），B=本轮 Kernel 表达装配。比较固定合成事实下的最终表达，不替代桌面全链验收。\n\n' +
    '固定人工素材、上下文、候选、focus、form；同一模型 '+ route.model +'；temperature=0.8，maxTokens=500，thinking=disabled。每组每侧各请求一次；无重写、无挑选、无补抽。只生成最终正文，元数据和决策调用不在此比较内。\n\n'
  for (const item of cases) {
    md += '## ' + item.id + '\n\n'
    for (const row of results.filter(r => r.caseId === item.id)) md += '### ' + row.arm + '\n\n' + (row.result.ok ? row.result.text : '生成失败：' + row.result.error) + (row.grounding?'\n\n实际事实审查：'+(row.grounding.ok?'通过':'拦截：'+row.grounding.reason):'') + '\n\n'
    md += '可观察差异：____\n\n评价：AI模板感____；小深角色一致性____；自然相处感____；陪伴模板感____；情绪是否过量____。\n\n'
  }
  fs.writeFileSync(path.join(output, '全部样本.md'), md)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
