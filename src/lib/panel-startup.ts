export const PANEL_STARTUP_TIMEOUT_MS = 15_000

export function isPanelReadyMessage(
  event: Pick<MessageEvent, 'data' | 'origin' | 'source'>,
  frame: Pick<HTMLIFrameElement, 'src' | 'contentWindow'>,
): boolean {
  if (!frame.contentWindow || event.source !== frame.contentWindow || event.data?.type !== 'NCM_PANEL_READY') return false
  try {
    const url = new URL(frame.src)
    const token = url.searchParams.get('startup')
    return !!url.host && !!token && event.data.token === token &&
      event.origin !== 'null' && event.origin === `${url.protocol}//${url.host}`
  } catch {
    return false
  }
}
