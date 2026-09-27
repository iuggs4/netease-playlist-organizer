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
  | { ok: false; id: string; error: string }

export const RPC_MAX_ATTEMPTS = 3
/** 请求最小间隔，用来规避风控。实测太激进会被限流。 */
export const RPC_MIN_INTERVAL_MS = 220
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
