/* Animation Player — Phase 2
 * 只负责媒体播放生命周期：play/stop/cleanup、ended/error 信号。
 * 不负责“决定播哪个”，由上层 Animation Director / 旧兼容层处理。
 */
window.AnimationPlayer = (function () {
  let current = null

  function clearCurrent() {
    if (!current) return
    const v = current.video
    try {
      if (v.onended) v.onended = null
      if (v.onerror) v.onerror = null
      if (!v.paused) v.pause()
    } catch (err) { /* ignore */ }
    current = null
  }

  function play(name, video, opts) {
    const options = opts || {}
    const once = !!options.once
    const onEnded = typeof options.onEnded === 'function' ? options.onEnded : null
    const onError = typeof options.onError === 'function' ? options.onError : null

    clearCurrent()
    if (!video) return false

    video.loop = !once
    video.muted = true
    video.playsInline = true
    try { if (video.ended || video.currentTime > 0) video.currentTime = 0 } catch (err) { /* ignore */ }

    const run = { name, video, once, onEnded, onError, suspended: false }
    current = run
    const handleEnded = () => {
      const active = current === run
      if (active) {
        current = null
        try { video.onended = null; video.onerror = null } catch (err) { /* ignore */ }
      }
      if (onEnded && active) onEnded()
    }
    const handleError = () => {
      const active = current === run
      if (active) {
        current = null
        try { video.onended = null; video.onerror = null } catch (err) { /* ignore */ }
        try { video.pause() } catch (err) { /* ignore */ }
      }
      if (onError && active) onError()
    }
    video.onended = once ? handleEnded : null
    video.onerror = handleError

    run.fail = handleError
    try {
      const p = video.play()
      if (p && typeof p.catch === 'function') p.catch(() => {
        if (current !== run || run.suspended) return
        try {
          video.muted = true
          const p2 = video.play()
          if (p2 && typeof p2.catch === 'function') p2.catch(handleError)
        } catch (err) { handleError() }
      })
    } catch (err) { handleError(); return false }
    return true
  }

  function stop(reason) {
    clearCurrent()
    return true
  }

  function pause() {
    if (current && current.video) {
      current.suspended = true
      try { current.video.pause() } catch (err) { /* ignore */ }
    }
  }

  function resume() {
    const run = current
    if (!run || !run.suspended) return false
    run.suspended = false
    try {
      const p = run.video.play()
      if (p && typeof p.catch === 'function') p.catch(() => { if (current === run && !run.suspended) run.fail() })
    } catch (err) { run.fail() }
    return true
  }

  function getCurrent() {
    return current ? { name: current.name, video: current.video } : null
  }

  function destroy() {
    clearCurrent()
  }

  return { play, stop, pause, resume, getCurrent, destroy }
})()
