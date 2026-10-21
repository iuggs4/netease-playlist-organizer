import type { NeteaseProfile } from '@/lib/types'

interface Props {
  profile: NeteaseProfile | null
  busy: boolean
  cachedCount: number
  onRefresh: () => void
  onNext: () => void
  onClearCache: () => Promise<void>
}

export default function ConnectStep({
  profile,
  busy,
  cachedCount,
  onRefresh,
  onNext,
  onClearCache,
}: Props) {
  return (
    <>
      <div className="step-content">
        <section className="card connection-card">
          <span className="connection-mark" aria-hidden="true">♪</span>
          <div className="connection-copy">
            <span className={`badge ${profile ? 'ok' : ''}`}>{profile ? '已连接网易云' : '等待连接'}</span>
            <h2 className="connection-name" title={profile?.nickname}>{profile?.nickname ?? '先登录，再开始整理'}</h2>
            <p className="muted small">保持已登录的 music.163.com 标签页打开，即可使用当前账号。</p>
          </div>
        </section>
        <section className="card">
          <h2>你的音乐仍在原处</h2>
          <p className="muted small">喜欢列表和来源歌单会保留。核对分类结果后，才会向你选择的目标歌单追加歌曲。</p>
          <p className="muted small">无需提供网易云账号密码；按歌手分类也无需配置 AI。</p>
        </section>
        <details className="card">
          <summary>本地分类缓存 · {cachedCount} 首</summary>
          <p className="muted small">模型分类结果保存在当前浏览器，更换模型后自动隔离。歌手分类直接读取歌曲资料。</p>
          <button className="ghost" onClick={() => void onClearCache()} disabled={busy || cachedCount === 0}>清空缓存</button>
        </details>
      </div>
      <footer className="step-actions">
        <button onClick={onRefresh} disabled={busy}>{busy ? '检测中…' : '重新检测'}</button>
        <button className="primary" onClick={onNext} disabled={!profile || busy}>
          选择来源歌单
        </button>
      </footer>
    </>
  )
}
