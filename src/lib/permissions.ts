/**
 * 调用大模型接口需要跨域权限。
 * manifest 里只声明了网易云，LLM 的 baseUrl 由用户填，
 * 所以这里在运行时按需申请最小范围（仅该 origin）。
 */

export async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  let origin: string
  try {
    const parsed = new URL(baseUrl)
    origin = `${parsed.origin}/*`
  } catch {
    throw new Error(`模型接口地址不合法：${baseUrl}`)
  }

  const pattern = { origins: [origin] }
  if (await chrome.permissions.contains(pattern)) return true
  return chrome.permissions.request(pattern)
}
