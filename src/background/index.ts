interface ToggleFloatingPanelMessage {
  type: 'TOGGLE_FLOATING_PANEL'
}

async function toggleFloatingPanel(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_FLOATING_PANEL' } satisfies ToggleFloatingPanelMessage)
    return true
  } catch {
    // 标签页刚加载时 content script 可能还没注入，调用方可以稍后重试。
    return false
  }
}

chrome.action.onClicked.addListener(async (activeTab) => {
  const activeUrl = activeTab.url ?? ''
  if (activeTab.id != null && /^https?:\/\/music\.163\.com\//.test(activeUrl)) {
    const sent = await toggleFloatingPanel(activeTab.id)
    if (sent) return

    // 如果网易云刚加载完，等 content script 注入后再发一次。
    await new Promise((resolve) => setTimeout(resolve, 500))
    await toggleFloatingPanel(activeTab.id)
    return
  }

  const musicTabs = await chrome.tabs.query({ url: 'https://music.163.com/*' })
  const existing = musicTabs.find((tab) => tab.id != null)
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { active: true })
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true })
    }
    const sent = await toggleFloatingPanel(existing.id)
    if (!sent) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await toggleFloatingPanel(existing.id)
    }
    return
  }

  // 没有网易云标签页时先打开站点；用户登录后再点扩展图标即可打开浮窗。
  await chrome.tabs.create({ url: 'https://music.163.com/' })
})
