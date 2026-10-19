/* CharacterView — K6 表现层 Adapter（内核 PresentationIntent 的唯一渲染者）
 *
 * 职责（总规 §15）：
 *  - 接收内核下发的 intent（文本通道），在**仍属于本次 intent** 的前提下渲染；
 *  - 分通道回执：published / started / completed / failed / interrupted / degraded；
 *  - 用户插话或新 intent 到达时，旧 intent 只能被标 interrupted，不能被“重播”；
 *  - 没有可用媒体时降级为 idle 视觉并标 presentation_degraded，
 *    绝不因为表现失败把领域动作改成失败。
 *
 * 边界：
 *  - mode=off 时本文件不做任何事（不创建 DOM、不订阅、不发命令）。
 *  - 不读写角色状态，不生成文本，不改人格/风格。文本由内核提供。
 *  - 通过既有 .dp-bubble 样式渲染，但不接管 pet.js 的气泡 owner 逻辑：
 *    仅在 kernel 模式下启用，此时自主开口归内核所有。
 */
window.CharacterView = (function () {
  'use strict'

  const CHANNEL = 'text'
  const DISPLAY_MS_DEFAULT = 4200
  let started = false
  let mode = 'off'
  let epoch = null
  let characterId = null
  let current = null
  let unsubscribers = []
  let container = null
  let bubble = null
  let timer = null
  let generation = 0
  let hostGeneration = 0
  const seen = new Set()
  let animation = null
  function restoreIdleVisual() {
    const video = document.getElementById('anim-idle') || document.querySelector('.dp-anim[loop]')
    if (!video) return
    for (const item of document.querySelectorAll('.dp-anim')) item.classList.toggle('on', item === video)
    window.AnimationPlayer.play(video.id.replace(/^anim-/, ''), video, { once: false })
  }
  function animationReceipt(intent, phase, detail) {
    return pet().delivery({ presentationId: intent.presentationId, operationId: intent.operationId, channel: 'animation', phase,
      characterId, rendererSession: sessionId(), at: Date.now(), detail: detail || null })
  }
  function interruptAnimation(reason) {
    if (!animation) return
    const previous = animation; animation = null
    window.AnimationPlayer.stop(reason)
    void animationReceipt(previous, 'interrupted', { reason })
  }
  async function presentAnimation(intent) {
    interruptAnimation('superseded')
    const video = document.getElementById('anim-' + intent.animationName)
    if (!video || !window.AnimationPlayer) { await animationReceipt(intent, 'failed', { reason: 'asset_missing' }); return }
    animation = intent
    await animationReceipt(intent, 'published')
    if (animation !== intent) return
    for (const item of document.querySelectorAll('.dp-anim')) item.classList.toggle('on', item === video)
    window.AnimationPlayer.play(intent.animationName, video, { once: true,
      onStarted: () => { if (animation === intent) void animationReceipt(intent, 'started') },
      onEnded: () => { if (animation === intent) { animation = null; void animationReceipt(intent, 'completed'); restoreIdleVisual() } },
      onError: () => { if (animation === intent) { animation = null; void animationReceipt(intent, 'failed', { reason: 'media_error' }); restoreIdleVisual() } } })
  }

  const log = (...args) => { try { console.warn('[character-view]', ...args) } catch (err) { /* ignore */ } }

  function pet () {
    return (window.pet && window.pet.character) ? window.pet.character : null
  }

  function ensureContainer () {
    if (container && container.isConnected) return container
    const stage = document.getElementById('stage') || document.body
    container = document.createElement('div')
    container.id = 'character-view-layer'
    container.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:60'
    stage.appendChild(container)
    bubble = document.createElement('div')
    bubble.className = 'dp-bubble dp-chat-reply hidden'
    bubble.dataset.characterView = '1'
    bubble.style.pointerEvents = 'none'
    container.appendChild(bubble)
    return container
  }

  function hide () {
    if (!bubble) return
    bubble.classList.add('hidden')
    bubble.textContent = ''
    current = null
  }

  async function receipt (phase, extra, target = current) {
    const api = pet()
    if (!api || !target) return
    const row = {
      presentationId: target.presentationId,
      channel: CHANNEL,
      phase,
      operationId: target.operationId || null,
      characterId,
      rendererSession: sessionId(),
      at: Date.now(),
      detail: extra || null,
    }
    try {
      const result = await api.delivery(row)
      if (!result || result.ok !== true) log('delivery receipt rejected', phase, result && result.code)
    } catch (err) { log('delivery receipt failed', err && err.message) }
  }

  function sessionId () {
    if (!window.__characterViewSession) window.__characterViewSession = 'session-' + Math.random().toString(36).slice(2, 10)
    return window.__characterViewSession
  }

  /* 新 intent 到达：旧 intent 只能被标记 interrupted，不再继续显示。 */
  async function onPresentation (intent) {
    if (!intent || ![CHANNEL,'animation'].includes(intent.channel)) return
    if (!intent.presentationId || seen.has(intent.presentationId)) return
    if (Number(intent.generation) < hostGeneration) return
    if (typeof intent.expiresAt === 'number' && intent.expiresAt <= Date.now()) {
      log('expired intent dropped', intent.presentationId)
      return
    }
    if (epoch !== null && typeof intent.epoch === 'number' && intent.epoch !== epoch) {
      log('stale-epoch intent dropped', intent.presentationId)
      return
    }
    seen.add(intent.presentationId)
    if (seen.size > 256) seen.delete(seen.values().next().value)
    if (intent.channel === 'animation') return presentAnimation(intent)
    const turn = ++generation
    if (current && current.presentationId !== intent.presentationId) {
      await receipt('interrupted', { reason: 'superseded' })
    }
    if (turn !== generation) return
    ensureContainer()
    current = intent
    const text = String(intent.text || (intent.content && intent.content.text) || '').slice(0, 2000)
    if (!text) {
      await receipt('failed', { reason: 'empty_text' })
      return
    }
    bubble.textContent = text
    bubble.classList.remove('hidden')
    await receipt('published', null, intent)
    if (turn !== generation) return
    await receipt('started', null, intent)
    if (turn !== generation) return
    if (timer) { clearTimeout(timer); timer = null }
    let shown = 0
    try { shown = await showBeats(intent, text) } catch (err) { shown = 0 }
    if (turn !== generation) return
    if (shown === 0) {
      // 没有可用表现通道：如实标降级，而不是假装播放完成。
      await receipt('degraded', { reason: 'no_media_or_style' })
    }
    if (turn !== generation) return
    timer = setTimeout(() => {
      timer = null
      if (!current || current.presentationId !== intent.presentationId) return
      receipt('completed', { durationMs: DISPLAY_MS_DEFAULT })
      hide()
    }, Math.max(1200, Math.min(12000, DISPLAY_MS_DEFAULT + (intent.animationHint ? 600 : 0))))
    if (timer && timer.unref) timer.unref()
    return shown
  }

  /* 表现节拍：句级拆分沿用现有 UI 的粗略规则；不改变文本内容。 */
  async function showBeats (intent, text) {
    const parts = String(text).split(/(?<=[。！？!?…])/).map(part => part.trim()).filter(Boolean).slice(0, 6)
    let shown = 0
    for (const part of parts) {
      if (!current || current.presentationId !== intent.presentationId) break
      bubble.textContent = part
      bubble.classList.remove('hidden')
      shown++
      await new Promise(resolve => setTimeout(resolve, Math.min(2400, 520 + part.length * 28)))
    }
    return shown
  }

  async function refresh () {
    const api = pet()
    if (!api) return null
    try {
      const projection = await api.read({ kind: 'projection' })
      if (projection && projection.ok === true) {
        epoch = projection.epoch
        characterId = projection.characterId
        return projection
      }
    } catch (err) { log('projection read failed', err && err.message) }
    return null
  }

  async function start () {
    if (started) return { ok: true, reused: true }
    const api = pet()
    if (!api) return { ok: false, reason: 'bridge_unavailable' }
    let status = null
    try { status = await api.status() } catch (err) { status = null }
    mode = (status && status.mode) || 'off'
    if (mode !== 'active' && !status?.authority) {
      started = false
      return { ok: true, mode: 'off' }
    }
    ensureContainer()
    await refresh()
    unsubscribers.push(api.onPresentation(intent => { onPresentation(intent).catch(err => log('present failed', err && err.message)) }))
    unsubscribers.push(api.onEvent(event => {
      if (event && event.kind === 'ready' && event.info) {
        epoch = event.info.epoch
        characterId = event.info.characterId
      }
      if (event && ['crashed', 'presentation_revoked'].includes(event.kind)) {
        hostGeneration = Math.max(hostGeneration, Number(event.generation) || 0)
        interruptAnimation(event.kind)
        generation++
        // 内核崩溃：本地表现权立即失效，不再显示后续内容（不重播旧气泡）。
        if (current) receipt('interrupted', { reason: 'kernel_crashed' })
        hide()
      }
    }))
    started = true
    return { ok: true, mode }
  }

  function stop () {
    interruptAnimation('view_stopped')
    generation++
    for (const off of unsubscribers) { try { off() } catch (err) { /* ignore */ } }
    unsubscribers = []
    if (timer) { clearTimeout(timer); timer = null }
    hide()
    started = false
    return { ok: true }
  }

  function state () {
    return {
      started, mode, epoch, characterId,
      presenting: current ? { presentationId: current.presentationId, channel: CHANNEL } : null,
      hasBubble: !!bubble, animation: animation?.animationName || null,
    }
  }

  /* 必须等 DOM 就绪；失败不影响桌宠主流程。 */
  function boot () {
    try {
      start().catch(err => log('start failed', err && err.message))
    } catch (err) { log('boot failed', err && err.message) }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()

  return { start, stop, refresh, state, receipt, interruptAnimation, __onPresentation: onPresentation }
})()
