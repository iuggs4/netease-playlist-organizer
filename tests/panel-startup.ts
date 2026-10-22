import assert from 'node:assert/strict'
import { isPanelReadyMessage, PANEL_STARTUP_TIMEOUT_MS } from '@/lib/panel-startup'

export function selftestPanelStartup(): void {
  const source = {} as Window
  const frame = { src: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html?startup=current-attempt', contentWindow: source }
  const ready = { data: { type: 'NCM_PANEL_READY', token: 'current-attempt' }, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', source }
  assert.equal(isPanelReadyMessage(ready, frame), true, '只接受当前 iframe 的启动成功通知')
  assert.equal(isPanelReadyMessage({ ...ready, source: {} as Window }, frame), false, '其他窗口不能消除加载提示')
  assert.equal(isPanelReadyMessage({ ...ready, origin: 'https://music.163.com' }, frame), false, '页面同类型消息不能伪造扩展启动成功')
  assert.equal(isPanelReadyMessage({ ...ready, origin: 'null' }, frame), false, '不接受不透明源伪造成功')
  assert.equal(isPanelReadyMessage({ ...ready, data: { ...ready.data, token: 'previous-attempt' } }, frame), false, '重载后旧页面迟到的 ready 不能确认本次启动')
  assert.equal(isPanelReadyMessage(ready, { ...frame, src: frame.src.split('?')[0] }), false, '缺少本次启动标识不能确认成功')
  assert.equal(isPanelReadyMessage({ ...ready, data: null }, frame), false, '无效消息不能确认启动')
  assert.equal(isPanelReadyMessage({ ...ready, data: { type: 'OTHER' } }, frame), false)
  assert.equal(isPanelReadyMessage(ready, { ...frame, contentWindow: null }), false)
  assert.equal(isPanelReadyMessage(ready, { ...frame, src: 'invalid-url' }), false)
  assert.equal(PANEL_STARTUP_TIMEOUT_MS, 15_000, '首次挂载超过 15 秒提供手动恢复')
}
