/* Perception Sensors · Hearing · 词表（H1）
 * 职责：媒体来源 → 跨模态 topic；媒体状态归一化。
 * 为什么属于 hearing：应用归类是听觉传感器的知识；topic 名字是跨模态公共词汇。
 * 边界：本文件不得引用任何 Engine / Writer / Router / Detector。
 */
(function () {
  // Known players are classified; unidentified/browser sessions stay generic.
  const APP_TOPICS = {
    'cloudmusic': 'music', 'cloudmusic_reporter': 'music', 'qqmusic': 'music', 'spotify': 'music',
    'foobar2000': 'music', 'aimp': 'music', 'musicbee': 'music', 'netease': 'music', 'kugou': 'music',
    'potplayer': 'video', 'vlc': 'video', 'mpv': 'video', 'mpc-hc64': 'video', 'kmplayer': 'video',
    'msedge': 'media', 'chrome': 'media', 'firefox': 'media', 'bilibili': 'video',
  }

  function baseName(app) {
    const s = String(app || '').toLowerCase()
    const tail = s.split(/[\\/]/).pop() || s
    return tail.replace(/\.exe$/, '')
  }

  function topicOfMedia(app, mediaType) {
    const type = String(mediaType || '').toLowerCase()
    const name = baseName(app)
    // Browser Media Session metadata may label videos as Music; its type alone
    // is insufficient evidence for song/artist-specific statements.
    if (/^(msedge|chrome|chromium|firefox|brave|opera|vivaldi)([.!_ -]|$)/.test(name)) return type === 'video' ? 'video' : 'media'
    if (type === 'music') return 'music'
    if (type === 'video' || type === 'image') return 'video'
    return APP_TOPICS[name] || 'media'
  }

  function cleanMediaText(raw) {
    const text = String(raw || '').trim()
    // Corrupt bytes cannot be recovered reliably; never speak or hash them.
    if (/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]|\?{3,}/.test(text)) return ''
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if (cp >= 0xD800 && cp <= 0xDFFF) return ''
    }
    return text.replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '').replace(/\s+/g, ' ').slice(0, 160)
  }

  const PLAYING = 'Playing'

  function isPlaying(status) {
    return String(status || '') === PLAYING
  }

  window.HearingVocab = {
    APP_TOPICS: APP_TOPICS,
    baseName: baseName,
    topicOfMedia: topicOfMedia,
    cleanMediaText: cleanMediaText,
    isPlaying: isPlaying,
  }
})()
