'use strict'
/**
 * K0 标识与摘要工具。所有 ID 都必须是“可在日志/来源表中定位”的稳定字符串，
 * 且不得接受原型污染型键名（沿用 platform-store 的既有约束）。
 */
const crypto = require('node:crypto')

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf'])

function isSafeId (value, maxLength = 240) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !FORBIDDEN.has(value)
}

function uuid () {
  return crypto.randomUUID()
}

function hash (value) {
  return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')
}

function shortHash (value) {
  return hash(value).slice(0, 16)
}

/**
 * 确定性 ID：同一 (prefix, 输入语义) 必须得到同一 ID，才能让恢复与去重成立。
 * 传入的种子必须已经包含所有区分维度；不要把“当前时间”混进确定性 ID。
 */
function deterministicId (prefix, seed) {
  return prefix + ':' + shortHash(typeof seed === 'string' ? seed : JSON.stringify(seed))
}

/**
 * 事实去重键：subject|predicate|scope。用于定位“同主体同属性”的旧断言，
 * 而不是用中文正则猜 topicKey（§13.2）。
 */
function assertionKey (subject, predicate, scope) {
  return [String(subject || ''), String(predicate || '').toLowerCase(), String(scope || 'owner')].join('|')
}

/** 归一化后的文本键：仅用于去重/模糊匹配，不参与事实真值判断。 */
function normalizedKey (text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：“”‘’（）《》【】…—\-_.!?,;:'"()\[\]{}]/g, '')
    .slice(0, 240)
}

/** 中文/英文混合关键词切分（第一版检索 Adapter 用，不是语义模型）。 */
function keywordList (text, limit = 24) {
  const raw = String(text || '').toLowerCase()
  const latin = raw.match(/[a-z0-9][a-z0-9_-]{1,30}/g) || []
  const cjk = raw.match(/[\u4e00-\u9fff]{2,6}/g) || []
  const out = []
  const seen = new Set()
  for (const word of [...latin, ...cjk]) {
    if (seen.has(word)) continue
    seen.add(word)
    out.push(word)
    if (out.length >= limit) break
  }
  return out
}

module.exports = { FORBIDDEN, isSafeId, uuid, hash, shortHash, deterministicId, assertionKey, normalizedKey, keywordList }
