(function () {
  'use strict'
  let current=null
  function snapshot() {
    if(!current) {
      try {current=window.pet.prompts.snapshot()}catch {current={texts:{},controls:{},revision:'builtin'}}
      queueMicrotask(()=>{current=null})
    }
    return current
  }
  window.PromptConfig={
    text: (id,fallback) => {const v=snapshot().texts[id];return typeof v==='string'?v:fallback},
    controls: () => snapshot().controls || {},
    revision: () => snapshot().revision,
    snapshot
  }
})()
