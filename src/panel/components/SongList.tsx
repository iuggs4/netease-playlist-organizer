import type { Dimension, Song } from '@/lib/types'

interface Props {
  songs: Song[]
  category: string
  dimension: Dimension
  busy: boolean
  onCategoryChange: (songId: number, dim: Dimension['key'], category: string, previousCategory: string) => void
}

export default function SongList({ songs, category, dimension, busy, onCategoryChange }: Props) {
  return (
    <ul className="songlist" aria-label={`${category || '未分类'}歌曲`}>
      {songs.map((song) => {
        const artists = song.artists.filter(Boolean).join(' / ') || '歌手信息缺失'
        return (
          <li className="song-row" key={song.id}>
            <details className="song-info">
              <summary className="song-summary" title={`${song.name}\n${artists}`}>
                <span className="song-heading">
                  <span className="song-title">{song.name}</span>
                  <span className="song-chevron" aria-hidden="true">⌄</span>
                </span>
                <span className="song-artists" title={artists}>{artists}</span>
              </summary>
              <dl className="song-details">
                <div><dt>歌名</dt><dd>{song.name}</dd></div>
                <div><dt>歌手</dt><dd>{artists}</dd></div>
                <div><dt>专辑</dt><dd>{song.album || '专辑信息缺失'}</dd></div>
              </dl>
            </details>
            <div className="song-assignment">
              <span className="field-caption" aria-hidden="true">歌曲归属</span>
              <select
                value={category}
                title={category || '未分类'}
                aria-label={`调整${song.name}在${category || '未分类'}中的归属`}
                disabled={busy}
                onChange={(event) => onCategoryChange(song.id, dimension.key, event.target.value, category)}
              >
                {dimension.categories.map((option) => <option key={option} value={option}>{option}</option>)}
                <option value="">未分类</option>
              </select>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
