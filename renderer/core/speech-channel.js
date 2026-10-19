(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SpeechChannel = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'
  // Channel validation, not a prose rewrite. Ordinary parenthetical explanations remain valid.
  function validate(text) {
    const value = String(text || '')
    const directions = /(?:[（(][^（）()\n]{0,35}(?:歪头|伸懒腰|眨眼|摇尾|凑近|抬头|低头|微笑|轻笑|点头|抱住|看着你|心想|心里想)[^（）()\n]{0,35}[）)]|\*[^*\n]{0,35}(?:歪头|伸懒腰|眨眼|微笑|心想)[^*\n]{0,35}\*)/
    return directions.test(value) ? { ok: false, reason: 'stage_direction_in_speech' } : { ok: true }
  }
  return { validate }
})
