import type { PlaylistBrief, Song } from '@/lib/types'
import { LIKED_SPECIAL_TYPE } from '@/lib/netease'

interface Props {
  playlists: PlaylistBrief[]
  selected: PlaylistBrief | null
  songs: Song[]
  songMsg: string
  busy: boolean
  onSelect: (p: PlaylistBrief) => void
  onLoadSongs: () => void
  onNext: () => void
}

export default function SelectStep({
  playlists,
  selected,
  songs,
  songMsg,
  busy,
  onSelect,
  onLoadSongs,
  onNext,
}: Props) {
  const liked = playlists.filter((p) => p.specialType === LIKED_SPECIAL_TYPE)
  const mine = playlists.filter((p) => p.specialType !== LIKED_SPECIAL_TYPE)

  const renderRow = (p: PlaylistBrief) => (
    <label
      key={p.id}
      className={`playlist-option ${selected?.id === p.id ? 'selected' : ''}`}
    >
      <input type="radio" name="source-playlist" checked={selected?.id === p.id} disabled={busy} onChange={() => onSelect(p)} />
      <span className="playlist-copy">
        <strong className="truncate" title={p.name}>{p.name}</strong>
        <span className="muted small">{p.specialType === LIKED_SPECIAL_TYPE ? '我喜欢的音乐 · 推荐来源' : '已有歌单'}</span>
      </span>
      <span className="playlist-count">{p.trackCount} 首</span>
    </label>
  )

  return (
    <>
      <div className="step-content">
        <section className="card">
          <h2>从哪个歌单开始？</h2>
          <p className="muted small">通常选择「我喜欢的音乐」。选好后读取歌曲，再设置分类规则。</p>
          <div className="playlist-options" role="radiogroup" aria-label="来源歌单">
            {[...liked, ...mine].map(renderRow)}
          </div>
          {playlists.length === 0 && <p className="empty-state">暂无可用歌单，请返回登录连接页重新检测。</p>}
        </section>
      </div>
      <footer className="step-actions">
        <span className="action-status muted small" role="status">
          {songMsg || (songs.length > 0 ? `已加载 ${songs.length} 首` : '尚未读取歌曲')}
        </span>
        <div className="actions-group">
          <button onClick={onLoadSongs} disabled={!selected || busy}>
            {busy ? '读取中…' : '读取歌曲'}
          </button>
          <button className="primary" onClick={onNext} disabled={songs.length === 0 || busy}>
            下一步
          </button>
        </div>
      </footer>
    </>
  )
}
