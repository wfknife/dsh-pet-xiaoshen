/* RuntimeDiagnostics — Phase 16 dev tool */
window.RuntimeDiagnostics = (function () {
  async function get() {
    const main = window.pet && window.pet.runtimeDiag ? await window.pet.runtimeDiag().catch(() => null) : null
    const eventListeners = {}
    if (window.EventBus && window.EventBus.events) {
      for (const ev of window.EventBus.events()) eventListeners[ev] = window.EventBus.listeners(ev)
    }
    return {
      main,
      local: {
        schedulerOwners: window.Scheduler ? window.Scheduler.owners() : [],
        schedulerCount: window.Scheduler ? window.Scheduler.owners().length : 0,
        eventListeners,
        eventCount: Object.keys(eventListeners).length,
        currentAnimation: window.AnimationPlayer && window.AnimationPlayer.getCurrent() ? window.AnimationPlayer.getCurrent().name : null,
        currentBehavior: window.BehaviorDirector ? window.BehaviorDirector.getCurrent() : null,
        animationRunSeq: (typeof window.AnimationDirector !== 'undefined') ? null : null,
        devStats: window.DevStats ? window.DevStats.getStats() : null,
        relationship: window.RelationshipEngine ? window.RelationshipEngine.getDiagnostics() : null,
        memory: window.MemoryEngine ? window.MemoryEngine.getDiagnostics() : null,
        memoryRetrieval: window.MemoryRetrieval ? window.MemoryRetrieval.getDiagnostics() : null,
        emotion: window.EmotionEngine ? window.EmotionEngine.getDiagnostics() : null,
        intent: window.IntentEngine ? window.IntentEngine.getDiagnostics() : null,
        expression: window.ExpressionEngine ? window.ExpressionEngine.getDiagnostics() : null,
        dialogue: window.DialogueEngine ? window.DialogueEngine.getDiagnostics() : null,
        aiGateway: window.AIGateway ? window.AIGateway.getDiagnostics() : null,
        diary: window.DiaryEngine ? window.DiaryEngine.getDiagnostics() : null,
        characterSnapshot: window.CharacterSnapshot ? window.CharacterSnapshot.build() : null
      }
    }
  }
  return { get }
})()
