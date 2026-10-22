import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

class PanelErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(typeof error === 'string' ? error : '界面渲染失败。') }
  }

  componentDidMount() {
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'NCM_PANEL_READY', token: new URLSearchParams(window.location.search).get('startup') }, 'https://music.163.com')
    }
  }

  render() {
    if (this.state.error) {
      return <div className="step-content"><section className="card" role="alert">
        <h2>面板遇到错误</h2>
        <p>请重新加载面板；如果刚更新了扩展，请刷新网易云网页。</p>
        <p className="err">{this.state.error.message || '界面未能正常显示。'}</p>
        <a href="./panel.html">重新加载面板</a>
        <p className="muted small">已完成的写入会保留，恢复后请重新计算导入计划。</p>
      </section></div>
    }
    return this.props.children
  }
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('缺少 #root 容器')
}

createRoot(container).render(
  <React.StrictMode>
    <PanelErrorBoundary><App /></PanelErrorBoundary>
  </React.StrictMode>,
)
