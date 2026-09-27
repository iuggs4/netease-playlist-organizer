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
    <div className="card">
      <h2>连接网易云</h2>
      <p className="muted small">
        本插件复用你浏览器里已有的登录态，不会索取账号密码，也不保存你的凭证到任何服务器。
        请确保已有一个打开并登录的 <code>music.163.com</code> 标签页。
      </p>

      <div className="row between wrap" style={{ marginTop: 14 }}>
        <div>
          {profile ? (
            <>
              <span className="badge ok">已登录</span>
              <span style={{ marginLeft: 8 }}>{profile.nickname}</span>
              <span className="muted small" style={{ marginLeft: 8 }}>
                uid {profile.userId}
              </span>
            </>
          ) : (
            <span className="badge">未检测到登录态</span>
          )}
        </div>
        <div className="row">
          <button onClick={onRefresh} disabled={busy}>
            {busy ? '检测中…' : '重新检测'}
          </button>
          <button className="primary" onClick={onNext} disabled={!profile}>
            下一步
          </button>
        </div>
      </div>

      <div className="row between wrap" style={{ marginTop: 18 }}>
        <span className="muted small">已缓存 {cachedCount} 首歌的分类结果（换模型会自动失效）</span>
        <button className="ghost" onClick={() => void onClearCache()} disabled={busy || cachedCount === 0}>
          清空缓存
        </button>
      </div>
    </div>
  )
}
