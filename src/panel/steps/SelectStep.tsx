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
    <tr
      key={p.id}
      onClick={() => onSelect(p)}
      style={{
        cursor: 'pointer',
        background: selected?.id === p.id ? 'var(--accent-soft)' : undefined,
      }}
    >
      <td>{p.name}</td>
      <td className="muted">{p.trackCount} 首</td>
      <td>
        {p.specialType === LIKED_SPECIAL_TYPE && <span className="badge">我喜欢的音乐</span>}
      </td>
    </tr>
  )

  return (
    <div className="card">
      <h2>选择要分类的歌单</h2>
      <p className="muted small">通常选「我喜欢的音乐」。</p>

      <table style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>歌单</th>
            <th>数量</th>
            <th />
          </tr>
        </thead>
        <tbody>{[...liked, ...mine].map(renderRow)}</tbody>
      </table>

      <div className="row between wrap" style={{ marginTop: 16 }}>
        <span className="muted small">
          {songMsg || (songs.length > 0 ? `已加载 ${songs.length} 首` : '尚未读取歌曲')}
        </span>
        <div className="row">
          <button onClick={onLoadSongs} disabled={!selected || busy}>
            {busy ? '读取中…' : '读取歌曲'}
          </button>
          <button className="primary" onClick={onNext} disabled={songs.length === 0}>
            下一步
          </button>
        </div>
      </div>
    </div>
  )
}
