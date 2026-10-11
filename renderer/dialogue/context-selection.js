(function(root) {
  'use strict'
  const settings=()=>root.PromptConfig?root.PromptConfig.controls():{}
  const clean=s=>String(s||'').replace(/主人|最近|现在|今天|刚才|一下|这个|那个|什么|怎么样|怎么|我们|你们|自己|的|了|呢|吗|呀|[\s，。！？、；：,.!?]/g,'')
  function related(a,b) {
    const x=clean(a),y=clean(b);if(x.length<2||y.length<2)return false
    let n=0;const seen=new Set()
    for(let i=0;i+1<x.length;i++){const g=x.slice(i,i+2);if(!seen.has(g)&&y.includes(g))n++;seen.add(g)}
    return n>=2 || (Math.min(x.length,y.length)<=4 && n>=1)
  }
  function recentHistory(history,c) {
    const all=Array.isArray(history)?history:[]
    if(c.history!=='isolate')return all
    const recent=all.slice(-4),anchor=[...all].reverse().find(h=>h.selfInitiated===true)
    return anchor&&!recent.includes(anchor)?[anchor,...recent]:recent
  }
  function chat(payload) {
    const p=payload||{},c=settings(),ctx={...(p.context||{})},history=recentHistory(p.history,c),text=String(p.userText||'')
    const follow=/那(?:个|件|次|局|事|之后)|刚才|之前|后来|接着|继续|为什么|怎么(?:了|样)|还记得/.test(text)
    const recent=history.slice(-3).map(h=>h.text||'').join(' '),query=text+(follow?' '+recent:'')
    const askingLife=/最近|近况|干(?:了|什么|嘛)|做(?:了|什么)|活动|玩(?:了|什么)|过得/.test(text)
    const askedRecall=/记得|记忆|以前|上次|昨天|前天|喜欢|偏好|计划|约定/.test(text)
    const said=history.filter(h=>h.role==='assistant').slice(-3).map(h=>h.text||'').join(' ')
    const pick=e=>{const t=e.text||e.content||e.wish||JSON.stringify(e.material||{});return (askingLife||related(query,t))&&(follow||askedRecall||!related(said,t))}
    ctx.relevantMemories=c.memories===false?[]:((ctx.relevantMemories||ctx.memories)||[]).filter(m=>related(query,m.content||m.text)||(askedRecall&&related(text,m.topic||''))).slice(0,3)
    ctx.memories=ctx.relevantMemories
    ctx.expressionDynamics=c.dynamics!==false
    // Preserve internal state for the guard and life executor. Only its expression projection is optional.
    ctx.expressState=c.dynamics!==false && /你.*(?:心情|累|饿|渴|困|精神|感觉|状态)|心情怎么样/.test(text)
    const life=p.life?{...p.life,artifacts:c.life===false?[]:(p.life.artifacts||[]).filter(pick),activities:c.life===false?[]:(p.life.activities||[]).filter(pick)}:p.life
    const frame=p.frame?{...p.frame,openThreads:c.threads===false?[]:(p.frame.openThreads||[]).filter(t=>related(query,t.quote||t.label))}:p.frame
    return {...p,context:ctx,history,life,frame}
  }
  function proactive(payload) {
    const p=payload||{},c=settings(),context={...(p.context||{}),expressionDynamics:c.dynamics!==false}
    if(c.memories===false){context.memories=[];context.relevantMemories=[]}
    const candidates=(p.candidates||[]).filter(x=>!(c.memories===false&&(x.source==='memory'||x.kind==='revisit_memory'))&&!(c.life===false&&['self_activity','self_experience'].includes(x.source))&&!(c.threads===false&&x.source==='unfinished_conversation'))
    return {...p,context,candidates,recentOpenings:c.history==='isolate'?(p.recentOpenings||[]).slice(-1):p.recentOpenings}
  }
  const api={chat,proactive,recentHistory,related}
  if(typeof module==='object'&&module.exports)module.exports=api
  else root.ContextSelection=api
})(typeof window!=='undefined'?window:globalThis)
