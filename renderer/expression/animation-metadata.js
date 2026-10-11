/* AnimationMetadata — 3.0 Runtime Experience Polish v1
 * Lightweight metadata for existing 2.0 animation assets.
 * This is not a new execution system and does not add resources.
 */
window.AnimationMetadata = (function () {
  const TAGS = {
    'work-busy': ['work', 'focus'], 'work-thinking': ['work', 'focus', 'calm'],
    'work-wait': ['work', 'wait'], 'work-organize': ['work', 'focus'],
    'work-success': ['happy', 'celebrate'], 'work-error': ['work', 'sad'],
    'whisper-idle': ['idle', 'calm'], 'whisper-screen': ['idle', 'observe'],
    'whisper-clean': ['idle', 'calm'], 'routine-brush': ['idle', 'routine'],
    'idle-breathe': ['idle', 'calm', 'welcome'],
    'idle-lookaround': ['idle', 'observe', 'welcome'],
    'idle-hum': ['idle', 'soft', 'social'],
    'idle-bubbles': ['idle', 'playful', 'social'],
    'happy-sway': ['happy', 'cheerful', 'social'],
    'happy-jump': ['happy', 'excited', 'celebrate'],
    'sleep-nap': ['rest', 'sleep', 'calm'],
    'tired-yawn': ['rest', 'tired', 'calm'],
    'click-tsundere': ['tease', 'social', 'playful'],
    'click-tickle': ['tease', 'social', 'playful'],
    'click-shy': ['shy', 'social'],
    'click-wave': ['welcome', 'social', 'happy'],
    'perform-curtsy': ['formal', 'social', 'calm'],
    'work-code': ['work', 'focus'],
    'work-think': ['work', 'focus', 'calm'],
    'eat-rice': ['eat', 'happy', 'social']
  }
  function get(name) {
    return Array.isArray(TAGS[name]) ? TAGS[name].slice() : []
  }
  return { TAGS, get }
})()
