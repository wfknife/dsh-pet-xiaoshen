'use strict'
/**
 * K6 日记投影：日记是**经历的文学投影**，不是新的事实源（总规 §5.3 / §15）。
 *
 * 规则：
 *  - 只读有效 Episode（status='active'）与已提交的 payload；
 *  - 已被遗忘的来源不得通过日记复活，渲染时按 policy 删除集过滤；
 *  - 不反向写入任何事实、关注或记忆。
 */

function parseBody (text) {
  if (typeof text !== 'string' || !text) return null
  try { return JSON.parse(text) } catch (_) { return { text } }
}

function dayKey (ts) {
  const date = new Date(ts)
  const pad = n => (n < 10 ? '0' : '') + n
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function buildDiary (gw, input) {
  const { characterId } = input
  const deleted = input.deleted instanceof Set ? input.deleted : new Set(input.deleted || [])
  const maxDays = Math.min(Number(input.limit) || 20, 100)
  const episodes = gw.listEpisodes(characterId, maxDays * 4)
  const dropped = []
  const days = new Map()

  for (const episode of episodes) {
    if (episode.status !== 'active') continue
    const refs = episode.sourceRefs || []
    if (refs.some(ref => deleted.has(ref))) {
      dropped.push({ episodeId: episode.episodeId, reason: 'source_forgotten' })
      continue
    }
    const key = dayKey(episode.occurredAt)
    if (!days.has(key)) days.set(key, [])
    const payload = episode.bodyRef ? gw.getPayload(episode.bodyRef) : null
    days.get(key).push({
      episodeId: episode.episodeId,
      world: episode.world,
      title: episode.title,
      occurredAt: episode.occurredAt,
      sourceRefs: refs,
      // 正文用于展示，但它是“经历记录”，不是可检索事实
      body: payload ? parseBody(payload.body) : null,
    })
  }

  const ordered = [...days.keys()].sort((a, b) => b.localeCompare(a)).slice(0, maxDays)
  return {
    ok: true,
    days: ordered.map(date => ({
      date,
      entries: days.get(date).sort((a, b) => b.occurredAt - a.occurredAt),
    })),
    dropped,
    truncatedDays: Math.max(0, days.size - ordered.length),
    note: '日记只读 Episode 投影；不得作为新事实源。',
  }
}

module.exports = { buildDiary, dayKey }
