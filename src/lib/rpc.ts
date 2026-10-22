/**
 * panel ↔ content script 的 RPC 协议。
 *
 * 为什么要绕这一层：网易云接口没有 CORS 头，也不支持 JSONP，
 * 从扩展页面直接 fetch 既可能被跨域拦，也可能因 cookie 的 SameSite
 * 策略拿不到登录态。而 content script 运行在 music.163.com 里，
 * 发出去的就是真正的同源请求 —— cookie、__csrf 全部天然可用。
 */

export interface NcmRequest {
  path: string
  method: 'GET' | 'POST'
  params?: Record<string, string | number>
}

export interface NcmRequestMessage {
  type: 'NCM_REQUEST'
  id: string
  req: NcmRequest
}

export type NcmResponse =
  | { ok: true; id: string; status: number; data: unknown }
  | { ok: false; id: string; error: string; code?: number; retryAfterMs?: number }

export const RPC_MAX_ATTEMPTS = 3
/** 保守的客户端节奏，不是网易云公布的接口限额。 */
export const RPC_MIN_INTERVAL_MS = 500
export const RPC_WRITE_INTERVAL_MS = 3_000
export const RPC_CREATE_INTERVAL_MS = 10_000
export const RATE_LIMIT_COOLDOWN_MS = 60_000

export function isWriteRequest(req: NcmRequest): boolean {
  return req.method === 'POST' && (
    req.path === '/api/playlist/create' || req.path === '/api/playlist/manipulate/tracks'
  )
}

export function requestIntervalMs(req: NcmRequest): number {
  if (!isWriteRequest(req)) return RPC_MIN_INTERVAL_MS
  return req.path === '/api/playlist/create' ? RPC_CREATE_INTERVAL_MS : RPC_WRITE_INTERVAL_MS
}

/** 服务端返回 301 / 250 通常意味着登录态失效 */
export const NCM_AUTH_ERROR_CODES = new Set([301, 250, -462])

export class NcmError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'NcmError'
  }
}

export class NcmRateLimitError extends NcmError {
  constructor(
    message: string,
    readonly retryAfterMs: number = RATE_LIMIT_COOLDOWN_MS,
    code = 405,
  ) {
    super(message, code)
    this.name = 'NcmRateLimitError'
  }
}
