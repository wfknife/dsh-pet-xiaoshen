/* MemoryRetrieval — v3.3 Batch C
 * Read-only retrieval v2: tokenizer, keyword score, topic fit, freshness,
 * retrieval score, status visibility, open historical path, memory context.
 * Does not mutate memory or store data.
 */
window.MemoryRetrieval = (function () {
  const MAX_MEMORY_RECALL = 3
  const MAX_MEMORY_CONTEXT_CHARS = 1200
  const MAX_MEMORY_ITEM_CHARS = 300
  let retrievalCount = 0
  let emptyCount = 0

  function deepCopy(obj) {
    if (obj === null || typeof obj !== 'object') return obj
    try { return JSON.parse(JSON.stringify(obj)) } catch (err) { return { ...obj } }
  }

  function clamp(v, min, max) {
    const n = Number(v)
    if (!Number.isFinite(n)) return min || 0
    return Math.min(max, Math.max(min, n))
  }

  function tokenize(text) {
    const s = String(text || '').toLowerCase()
    const tokens = []
    const seen = new Set()
    const add = (t) => { if (t && !seen.has(t)) { seen.add(t); tokens.push(t) } }
    const cnPhrases = s.match(/[\u4e00-\u9fff]+/g) || []
    for (const phrase of cnPhrases) {
      if (phrase.length <= 4) add(phrase)
      for (let i = 0; i < phrase.length - 1; i++) add(phrase.slice(i, i + 2))
    }
    const en = s.match(/[a-z0-9]+/g) || []
    for (const t of en) add(t)
    return tokens
  }

  function keywordScore(content, query, queryTokens) {
    const qTokens = queryTokens || tokenize(query)
    if (!qTokens.length) return 0
    const mTokens = new Set(tokenize(content))
    let matched = 0
    for (const t of qTokens) if (mTokens.has(t)) matched++
    const raw = matched / qTokens.length
    if (raw >= 0.80) return 1.00
    if (raw >= 0.50) return 0.75
    if (raw >= 0.25) return 0.50
    if (raw > 0) return 0.25
    return 0
  }

  function topicFit(memory, query) {
    if (!query || !memory) return 0
    const hasSubject = !!memory.subjectKey && !!query.subjectKey && memory.subjectKey === query.subjectKey
    const hasProperty = !!memory.propertyKey && !!query.propertyKey && memory.propertyKey === query.propertyKey
    const hasValue = !!memory.valueKey && !!query.valueKey && memory.valueKey === query.valueKey
    if (hasSubject && hasProperty && hasValue) return 1.00
    if (hasSubject && hasProperty) return 0.75
    if (hasProperty) return 0.60
    if (hasValue) return 0.80
    return 0
  }

  function freshness(memory, now) {
    const ref = memory.lastMentionedAt || memory.updatedAt || memory.createdAt || now
    const ageDays = Math.max(0, (now - ref) / 86400000)
    return Math.exp(-ageDays / 30)
  }

  function calculateScore(memory, query, now, eff, queryTokens) {
    const kw = keywordScore(
      String(memory.content || '') + ' ' + (memory.tags || []).join(' ') + ' ' + (memory.valueKey || ''),
      String((query && query.text) || query || ''), queryTokens
    )
    const tf = topicFit(memory, query)
    const strength = Number(eff !== undefined ? eff : (memory.effectiveStrength || memory.strength || 0))
    return clamp(
      0.45 * kw + 0.15 * tf + 0.15 * strength + 0.10 * (memory.importance || 0) + 0.10 * (memory.confidence || 0) + 0.05 * freshness(memory, now),
      0, 1
    )
  }

  function parseQuery(input) {
    if (typeof input === 'string') {
      const parsed = window.MemoryQuery && typeof window.MemoryQuery.parseMemoryQuery === 'function'
        ? window.MemoryQuery.parseMemoryQuery(input)
        : { intent: 'none', subjectKey: null, propertyKey: null, valueKey: null, historical: false, includeSuperseded: false }
      return Object.assign({}, parsed, { text: input })
    }
    if (input && typeof input === 'object') {
      const q = input
      const parsed = window.MemoryQuery && typeof window.MemoryQuery.parseMemoryQuery === 'function' ? window.MemoryQuery.parseMemoryQuery(q.text || '') : null
      return {
        text: q.text || '',
        intent: q.intent || (parsed && parsed.intent) || 'none',
        subjectKey: q.subjectKey || (parsed && parsed.subjectKey) || null,
        propertyKey: q.propertyKey || (parsed && parsed.propertyKey) || null,
        valueKey: q.valueKey || (parsed && parsed.valueKey) || null,
        historical: !!(q.historical !== undefined ? q.historical : (parsed && parsed.historical)),
        includeSuperseded: !!(q.includeSuperseded !== undefined ? q.includeSuperseded : (parsed && parsed.includeSuperseded)),
        type: q.type || null,
        tags: q.tags || []
      }
    }
    return { text: '', intent: 'none', subjectKey: null, propertyKey: null, valueKey: null, historical: false, includeSuperseded: false }
  }

  function allowedStatus(query) {
    if (query.historical || query.includeSuperseded) return ['active', 'fading', 'archived', 'suppressed']
    if (query.intent === 'recall' || query.intent === 'current_preference' || query.intent === 'past_episode' || query.intent === 'past_relationship') return ['active', 'fading']
    return ['active']
  }

  function isOpenHistorical(query) {
    return query.intent === 'past_episode' || query.intent === 'past_relationship' || (query.historical && !query.valueKey && !query.propertyKey)
  }

  function isEmptyQuery(query) {
    if (!query) return true
    if (typeof query === 'string') return !String(query).trim()
    if (typeof query === 'object') {
      const q = query
      return !String(q.text || '').trim() && !q.intent && !q.subjectKey && !q.propertyKey && !q.valueKey && !q.historical && !q.type
    }
    return false
  }

  function retrieve(query, options) {
    const opts = options || {}
    if (isEmptyQuery(query)) {
      const emptyQ = (typeof query === 'object' && query) ? query : {}
      const all = window.MemoryEngine ? window.MemoryEngine.getMemories() : []
      let list = all.filter((m) => m.status === 'active' && !m.supersededBy && m.status !== 'suppressed' && m.status !== 'archived')
      if (opts.type || emptyQ.type) list = list.filter((m) => m.type === (opts.type || emptyQ.type))
      const emptyTags = Array.isArray(emptyQ.tags) ? [...emptyQ.tags] : []
      if (Array.isArray(opts.tags) && opts.tags.length) emptyTags.push(...opts.tags)
      if (emptyTags.length) list = list.filter((m) => (m.tags || []).some((t) => emptyTags.indexOf(t) >= 0))
      const limit = Math.max(1, Math.min(Number(opts.limit || MAX_MEMORY_RECALL), 50))
      const out = list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit).map((m) => deepCopy(m))
      retrievalCount++
      if (!out.length) emptyCount++
      return out
    }
    const parsed = parseQuery(query)
    const now = Date.now()
    const all = window.MemoryEngine ? window.MemoryEngine.getMemories() : []
    const allowed = allowedStatus(parsed)
    let list = all.filter((m) => allowed.indexOf(m.status) >= 0)
    if (!parsed.includeSuperseded && !opts.includeSuperseded) {
      list = list.filter((m) => !m.supersededBy)
    }
    list = list.filter((m) => m.status !== 'archived' && m.status !== 'suppressed')
    if (opts.type) list = list.filter((m) => m.type === opts.type)
    else if (parsed.type) list = list.filter((m) => m.type === parsed.type)
    if (opts.tags && opts.tags.length) list = list.filter((m) => (m.tags || []).some((t) => opts.tags.indexOf(t) >= 0))

    const openHistorical = opts.openHistorical !== undefined ? !!opts.openHistorical : isOpenHistorical(parsed)
    if (openHistorical) {
      if (parsed.intent === 'past_episode') list = list.filter((m) => m.type === 'episode')
      if (parsed.intent === 'past_relationship') list = list.filter((m) => m.type === 'relationship')
    }

    // The query is identical for every candidate; segment it once per retrieval.
    const queryTokens = tokenize(parsed.text)
    const scored = list.map((m) => {
      const eff = window.MemoryEngine && typeof window.MemoryEngine.effectiveStrength === 'function'
        ? window.MemoryEngine.effectiveStrength(m, now)
        : (m.strength || 0)
      const score = calculateScore(m, parsed, now, eff, queryTokens)
      return { memory: m, score, eff }
    })

    let results
    if (openHistorical) {
      results = scored.sort((a, b) => b.score - a.score).slice(0, (opts.limit || MAX_MEMORY_RECALL))
    } else {
      const threshold = parsed.historical ? 0.30 : (Number(opts.threshold) || 0.45)
      results = scored.filter((x) => x.score >= threshold).sort((a, b) => b.score - a.score).slice(0, (opts.limit || MAX_MEMORY_RECALL))
    }

    retrievalCount++
    if (!results.length) emptyCount++
    return results.map((x) => deepCopy(x.memory))
  }

  function recent(options) {
    const opts = options || {}
    const all = window.MemoryEngine ? window.MemoryEngine.getMemories() : []
    const list = all.filter((m) => m.status === 'active' && !m.supersededBy)
    return deepCopy(list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, Math.max(1, Math.min(Number(opts.limit || MAX_MEMORY_RECALL), 50))))
  }

  function count(options) {
    const all = window.MemoryEngine ? window.MemoryEngine.getMemories(options) : []
    return all.length
  }

  function buildMemoryContext(memories) {
    const mems = Array.isArray(memories) ? memories : []
    if (!mems.length) return ''
    const lines = ['[Memory Context — 关于主人的过去记忆]', '', '这些内容来自主人过去的对话或事件。', '它们不是小深自己的 Persona，也不代表当前现实。', '']
    let budget = MAX_MEMORY_CONTEXT_CHARS
    for (const m of mems.slice(0, MAX_MEMORY_RECALL)) {
      let item = String((m.date ? m.date + '：' : '') + (m.content || m.text || '')).slice(0, MAX_MEMORY_ITEM_CHARS)
      const confidence = Number(m.confidence) || 0
      const level = confidence >= 0.80 ? '（确定）' : (confidence >= 0.45 ? '（较确定）' : '（模糊）')
      item += ' ' + level
      if (item.length > budget) item = item.slice(0, budget)
      if (!item) continue
      lines.push('- ' + item)
      budget -= item.length
      if (budget <= 0) break
    }
    return lines.join('\n')
  }

  function getDiagnostics() {
    return {
      retrievalCount,
      emptyRetrievalCount: emptyCount,
      maxMemoryRecall: MAX_MEMORY_RECALL,
      maxMemoryContextChars: MAX_MEMORY_CONTEXT_CHARS,
      maxMemoryItemChars: MAX_MEMORY_ITEM_CHARS,
      readOnly: true
    }
  }

  return {
    MAX_MEMORY_RECALL,
    MAX_MEMORY_CONTEXT_CHARS,
    MAX_MEMORY_ITEM_CHARS,
    tokenize,
    keywordScore,
    topicFit,
    freshness,
    calculateScore,
    retrieve,
    search: retrieve,
    recent,
    count,
    buildMemoryContext,
    getDiagnostics,
    diagnostics: getDiagnostics
  }
})()
