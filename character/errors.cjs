'use strict'
/**
 * K0 错误分类。目的：让上层能区分“输入错了”“版本冲突”“此刻不可用”
 * 与“内部错误”，而不是把所有失败压成一个字符串（§18.2 / §12.3）。
 */

const { FAILURE_CLASSES } = require('./contracts.cjs')

/** 拒绝 = 命令未被接受，没有任何持久副作用。 */
const REJECTED = 'rejected'
/** 冲突 = 结构合法但与既有状态/去重键矛盾，需调用方修正。 */
const CONFLICT = 'conflict'
/** 不可用 = 依赖缺失（存储/模型/能力），稍后可重试。 */
const UNAVAILABLE = 'unavailable'
/** 内部 = 实现缺陷或未预期异常，必须留证据。 */
const INTERNAL = 'internal'

class CharacterError extends Error {
  /**
   * @param {string} failureClass one of REJECTED/CONFLICT/UNAVAILABLE/INTERNAL
   * @param {string} code 机器可读代码，见 contracts.FAILURE_CLASSES
   * @param {object} [detail]
   */
  constructor (failureClass, code, detail) {
    super(code + (detail ? ':' + JSON.stringify(detail) : ''))
    this.name = 'CharacterError'
    this.failureClass = failureClass
    this.code = code
    this.detail = detail === undefined ? null : detail
    this.retryable = failureClass === UNAVAILABLE
    // 只有 rejected/conflict 是“用户可理解、无需上报”的正常结果。
    this.expected = failureClass === REJECTED || failureClass === CONFLICT
  }

  toReply () {
    return { ok: false, code: this.code, failureClass: this.failureClass, retryable: this.retryable, detail: this.detail }
  }
}

const rejected = (code, detail) => new CharacterError(REJECTED, code, detail)
const conflict = (code, detail) => new CharacterError(CONFLICT, code, detail)
const unavailable = (code, detail) => new CharacterError(UNAVAILABLE, code, detail)
const internal = (code, detail) => new CharacterError(INTERNAL, code, detail)

/** 把任意异常规范成 CharacterError，保证 IPC 边界不会透出堆栈。 */
function normalize (error) {
  if (error instanceof CharacterError) return error
  const code = error && typeof error.code === 'string' && FAILURE_CLASSES.includes(error.code)
    ? error.code
    : 'internal_error'
  return internal(code, error && error.message ? String(error.message).slice(0, 400) : undefined)
}

/** 供 host/IPC 使用：永不抛，只返回结构化结果。 */
function capture (fn) {
  try {
    const value = fn()
    if (value && typeof value.then === 'function') {
      return value.then(v => ({ ok: true, value: v }), e => ({ ok: false, error: normalize(e).toReply() }))
    }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: normalize(error).toReply() }
  }
}

module.exports = {
  REJECTED,
  CONFLICT,
  UNAVAILABLE,
  INTERNAL,
  CharacterError,
  rejected,
  conflict,
  unavailable,
  internal,
  normalize,
  capture,
}
