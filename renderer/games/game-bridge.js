/* GameBridge — Phase 13
 * 最小游戏领域事件出口。只负责产生 game.completed 领域事实，
 * 不改变现有游戏奖励/规则。
 */
window.GameBridge = (function () {
  function complete(payload) {
    const p = payload || {}
    const gameId = String(p.gameId || 'unknown')
    const eventId = p.eventId || ('game:' + gameId + ':' + (Date.now()) + ':' + (p.score || 0))
    if (window.EventBus) {
      window.EventBus.emitOnce('game.completed', {
        eventId,
        gameId,
        score: Number(p.score) || 0,
        won: !!p.won,
        draw: p.draw === true, level: p.level, elapsedSeconds: p.elapsedSeconds,
        ts: Date.now()
      }, eventId)
    }
    return true
  }
  return { complete }
})()
