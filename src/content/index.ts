/**
 * content script：唯一负责发网易云 HTTP 请求的地方。
 *
 * 它跑在 music.163.com 的同源上下文里，因此：
 *  - 不受 CORS 限制（网易云根本不返回 access-control-allow-origin）
 *  - cookie 自动携带，且能直接读 __csrf
 * 同时内置串行队列 + 最小间隔，避免批量操作触发风控。
 */

import type { NcmRequest, NcmRequestMessage, NcmResponse } from '@/lib/rpc'
import { isWriteRequest, NcmRateLimitError, RATE_LIMIT_COOLDOWN_MS, requestIntervalMs, RPC_MAX_ATTEMPTS } from '@/lib/rpc'
import { clampPanelPosition } from '@/lib/floating-layout'

const BASE = 'https://music.163.com'

/**
 * 只允许访问 /api/ 下的路径。
 * panel 传来的 path 是拼接进 URL 的，做前缀白名单可以确保
 * 请求永远不会被打到 music.163.com 以外的主机或非预期端点。
 */
const ALLOWED_PATH = /^\/api\/[A-Za-z0-9/_\-.]*$/

function readCsrf(): string {
  const m = document.cookie.match(/(?:^|;\s*)__csrf=([^;]+)/)
  return m ? m[1] : ''
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 全局串行队列：保证请求之间有间隔，不会并发轰接口。 */
let chain: Promise<unknown> = Promise.resolve()
let lastAt = 0
let cooldownUntil = 0

function checkCooldown(): void {
  const remaining = cooldownUntil - Date.now()
  if (remaining > 0) {
    throw new NcmRateLimitError(
      `网易云操作过于频繁，冷却中，请 ${Math.ceil(remaining / 1000)} 秒后重新计算计划。`,
      remaining,
    )
  }
}

function enqueue<T>(req: NcmRequest, task: () => Promise<T>): Promise<T> {
  checkCooldown()
  const run = async (): Promise<T> => {
    checkCooldown()
    const wait = requestIntervalMs(req) - (Date.now() - lastAt)
    if (wait > 0) {
      await sleep(wait)
    }
    checkCooldown()
    try {
      return await task()
    } finally {
      lastAt = Date.now()
    }
  }
  chain = chain.then(run, run)
  return chain as Promise<T>
}

async function send(req: NcmRequest): Promise<{ status: number; data: unknown }> {
  if (!ALLOWED_PATH.test(req.path)) {
    throw new Error(`拒绝非法请求路径：${req.path}`)
  }

  const params = { ...req.params }
  const csrf = readCsrf()
  if (csrf) {
    params.csrf_token = csrf
  }

  let url: URL
  try {
    url = new URL(req.path, BASE)
  } catch {
    throw new Error(`无法解析请求路径：${req.path}`)
  }
  if (url.origin !== BASE) {
    throw new Error(`请求目标越界：${url.origin}`)
  }
  const init: RequestInit = {
    method: req.method,
    credentials: 'include',
    headers: { Referer: `${BASE}/` },
  }

  if (req.method === 'POST') {
    init.headers = {
      ...(init.headers as Record<string, string>),
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    init.body = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString()
  } else {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  }

  const res = await fetch(url.toString(), init)
  if (res.status === 429) cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
  const text = await res.text()
  if (!text) return { status: res.status, data: null }

  // 网易云用 text/plain 返回 JSON，不能依赖 res.json()
  try {
    const data: unknown = JSON.parse(text)
    const code = (data as { code?: number } | null)?.code
    if (code === 405 || code === 429) cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
    return { status: res.status, data }
  } catch {
    if (res.status === 429) return { status: res.status, data: null }
    throw new Error(`响应不是 JSON（HTTP ${res.status}）`)
  }
}

async function sendWithRetry(req: NcmRequest) {
  checkCooldown()
  let lastErr: unknown
  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
    try {
      return await enqueue(req, () => send(req))
    } catch (err) {
      // 写入结果不确定时先刷新核对，不能因网络异常直接重放。
      if (err instanceof NcmRateLimitError || isWriteRequest(req)) throw err
      lastErr = err
    }
    if (attempt < RPC_MAX_ATTEMPTS) {
      await sleep(attempt * 600)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

interface ToggleFloatingPanelMessage {
  type: 'TOGGLE_FLOATING_PANEL'
}

let floatingHost: HTMLDivElement | null = null
let floatingRoot: ShadowRoot | null = null
let panelCollapsed = false
let panelExpanded = false
let suppressNextToggleClick = false

function keepPanelInViewport(): void {
  if (!floatingHost) return
  const position = clampPanelPosition(floatingHost.getBoundingClientRect(), {
    width: window.innerWidth, height: window.innerHeight,
  })
  floatingHost.style.left = `${position.left}px`
  floatingHost.style.top = `${position.top}px`
  floatingHost.style.right = 'auto'
  floatingHost.style.bottom = 'auto'
}

function setPanelCollapsed(collapsed: boolean): void {
  if (!floatingHost || !floatingRoot) return
  panelCollapsed = collapsed
  const shell = floatingRoot.querySelector<HTMLElement>('.floating-window')
  const frame = floatingRoot.querySelector<HTMLIFrameElement>('.panel-frame')
  const button = floatingRoot.querySelector<HTMLButtonElement>('.collapse-button')
  if (!shell || !frame || !button) return

  shell.classList.toggle('collapsed', collapsed)
  frame.hidden = collapsed
  button.title = collapsed ? '展开歌单分类浮窗' : '收起浮窗（任务继续）'
  button.setAttribute('aria-label', button.title)
}

function toggleFloatingPanel(): void {
  if (!floatingHost || !floatingRoot) {
    createFloatingPanel()
    return
  }
  setPanelCollapsed(!panelCollapsed)
}

function createFloatingPanel(): void {
  floatingHost = document.createElement('div')
  floatingHost.id = 'netease-distribute-songs-floating-root'
  floatingHost.style.position = 'fixed'
  floatingHost.style.right = '12px'
  floatingHost.style.bottom = '12px'
  floatingHost.style.zIndex = '2147483647'
  floatingHost.style.pointerEvents = 'auto'
  floatingRoot = floatingHost.attachShadow({ mode: 'closed' })
  floatingRoot.innerHTML = `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      .floating-window {
        display: flex;
        flex-direction: column;
        width: min(640px, calc(100vw - 24px));
        height: min(720px, calc(100vh - 24px));
        min-width: min(320px, calc(100vw - 24px));
        min-height: min(260px, calc(100vh - 24px));
        overflow: hidden;
        background: #f7f8fa;
        border: 1px solid rgba(255, 255, 255, .9);
        border-radius: 18px;
        box-shadow: 0 14px 42px rgba(28, 35, 48, .22), 0 2px 8px rgba(28, 35, 48, .08);
        color: #252a32;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
        transition: border-radius .2s ease, box-shadow .2s ease;
      }
      .floating-window.expanded {
        width: min(960px, calc(100vw - 24px));
        height: calc(100vh - 24px);
      }
      .toolbar {
        height: 48px;
        min-height: 48px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 12px;
        background: rgba(255, 255, 255, .96);
        border-bottom: 1px solid #eceef2;
        cursor: grab;
        user-select: none;
      }
      .toolbar:active { cursor: grabbing; }
      .brand-mark {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        border-radius: 10px;
        background: #e54843;
        color: #fff;
        font-size: 17px;
        font-weight: 700;
      }
      .title-wrap { display: flex; flex: 1; min-width: 0; flex-direction: column; line-height: 1.2; }
      .title, .hint { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .title { font-size: 13px; font-weight: 650; letter-spacing: .01em; }
      .hint { margin-top: 2px; color: #9298a3; font-size: 10px; }
      button {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        border: 0;
        border-radius: 50%;
        background: #f3f4f6;
        color: #6f7682;
        font: 20px/1 -apple-system, BlinkMacSystemFont, sans-serif;
        cursor: pointer;
        transition: background .15s ease, color .15s ease, transform .15s ease;
      }
      button:hover { background: #eceef2; color: #343a43; }
      button:focus-visible { outline: 2px solid #e54843; outline-offset: 3px; }
      .panel-frame {
        display: block;
        flex: 1;
        width: 100%;
        min-height: 0;
        border: 0;
        background: #f7f8fa;
      }
      .panel-frame[hidden] { display: none; }
      .floating-window.collapsed {
        width: 48px;
        height: 48px;
        min-width: 48px;
        min-height: 48px;
        border: 0;
        border-radius: 50%;
        background: linear-gradient(145deg, #f05b55, #d93632);
        box-shadow: 0 8px 24px rgba(211, 58, 49, .34);
      }
      .collapsed .toolbar {
        position: relative;
        justify-content: center;
        width: 48px;
        height: 48px;
        min-height: 48px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
      }
      .collapsed .brand-mark, .collapsed .title-wrap, .collapsed .expand-button { display: none; }
      .collapse-symbol { display: grid; place-items: center; }
      .music-symbol { display: none; width: 20px; height: 20px; }
      .collapsed .collapse-button {
        position: absolute;
        inset: 0;
        width: 48px;
        height: 48px;
        border-radius: 50%;
        background: transparent;
        color: #fff;
      }
      .collapsed .collapse-symbol { display: none; }
      .collapsed .music-symbol { display: block; }
      .collapsed .collapse-button:hover { background: rgba(255, 255, 255, .12); color: #fff; }
      @media (prefers-reduced-motion: reduce) {
        .floating-window, button { transition: none; }
      }
    </style>
    <section class="floating-window" aria-label="网易云红心歌单分类">
      <header class="toolbar" title="拖动此处移动浮窗">
        <span class="brand-mark" aria-hidden="true">♪</span>
        <span class="title-wrap">
          <span class="title">歌单整理</span>
          <span class="hint">网易云音乐 · 收起后任务继续</span>
        </span>
        <button class="expand-button" type="button" title="展开为宽面板" aria-label="展开为宽面板" aria-pressed="false">⤢</button>
        <button class="collapse-button" type="button" title="收起浮窗（任务继续）" aria-label="收起浮窗（任务继续）">
          <span class="collapse-symbol">−</span>
          <svg class="music-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </button>
      </header>
      <iframe class="panel-frame" title="网易云红心歌单分类面板"></iframe>
    </section>
  `

  const frame = floatingRoot.querySelector<HTMLIFrameElement>('.panel-frame')
  const header = floatingRoot.querySelector<HTMLElement>('.toolbar')
  const collapseButton = floatingRoot.querySelector<HTMLButtonElement>('.collapse-button')
  const expandButton = floatingRoot.querySelector<HTMLButtonElement>('.expand-button')
  const shell = floatingRoot.querySelector<HTMLElement>('.floating-window')
  if (!frame || !header || !collapseButton || !expandButton || !shell) return

  let normalPosition: { left: number; top: number } | null = null
  expandButton.addEventListener('click', () => {
    if (!floatingHost) return
    if (!panelExpanded) {
      const rect = floatingHost.getBoundingClientRect()
      normalPosition = { left: rect.left, top: rect.top }
    }
    panelExpanded = !panelExpanded
    shell.classList.toggle('expanded', panelExpanded)
    expandButton.textContent = panelExpanded ? '⤡' : '⤢'
    expandButton.title = panelExpanded ? '还原浮窗尺寸' : '展开为宽面板'
    expandButton.setAttribute('aria-label', expandButton.title)
    expandButton.setAttribute('aria-pressed', String(panelExpanded))
    if (!panelExpanded && normalPosition) {
      floatingHost.style.left = `${normalPosition.left}px`
      floatingHost.style.top = `${normalPosition.top}px`
    }
    keepPanelInViewport()
  })

  frame.src = chrome.runtime.getURL('panel.html')
  collapseButton.addEventListener('click', (event) => {
    if (suppressNextToggleClick) {
      suppressNextToggleClick = false
      event.preventDefault()
      return
    }
    setPanelCollapsed(!panelCollapsed)
  })

  header.addEventListener('pointerdown', (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest('button') && !panelCollapsed) return
    const rect = floatingHost?.getBoundingClientRect()
    if (!rect || !floatingHost) return

    const startX = event.clientX
    const startY = event.clientY
    const startLeft = rect.left
    const startTop = rect.top
    let didMove = false
    floatingHost.style.left = `${startLeft}px`
    floatingHost.style.top = `${startTop}px`
    floatingHost.style.right = 'auto'
    floatingHost.style.bottom = 'auto'

    const move = (moveEvent: PointerEvent) => {
      if (!floatingHost || moveEvent.pointerId !== event.pointerId) return
      if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 8) didMove = true
      const bounds = floatingHost.getBoundingClientRect()
      const position = clampPanelPosition({
        left: startLeft + moveEvent.clientX - startX,
        top: startTop + moveEvent.clientY - startY,
        width: bounds.width, height: bounds.height,
      }, { width: window.innerWidth, height: window.innerHeight })
      floatingHost.style.left = `${position.left}px`
      floatingHost.style.top = `${position.top}px`
    }
    const stop = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== event.pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (didMove && panelCollapsed) {
        suppressNextToggleClick = true
        window.setTimeout(() => { suppressNextToggleClick = false }, 100)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  })

  document.documentElement.appendChild(floatingHost)
  setPanelCollapsed(false)
  new ResizeObserver(keepPanelInViewport).observe(shell)
  window.addEventListener('resize', keepPanelInViewport)
  keepPanelInViewport()
}

chrome.runtime.onMessage.addListener(
  (
    msg: NcmRequestMessage | ToggleFloatingPanelMessage,
    _sender,
    sendResponse: (response: NcmResponse | { ok: true }) => void,
  ) => {
    if (msg?.type === 'TOGGLE_FLOATING_PANEL') {
      toggleFloatingPanel()
      sendResponse({ ok: true })
      return false
    }
    if (msg?.type !== 'NCM_REQUEST') return false

    sendWithRetry(msg.req)
      .then(({ status, data }) =>
        sendResponse({ ok: true, id: msg.id, status, data } satisfies NcmResponse),
      )
      .catch((err: unknown) =>
        sendResponse({
          ok: false,
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
          ...(err instanceof NcmRateLimitError ? { code: err.code, retryAfterMs: err.retryAfterMs } : {}),
        } satisfies NcmResponse),
      )

    return true // 异步响应
  },
)
