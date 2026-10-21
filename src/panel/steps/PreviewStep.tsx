import { useState } from 'react'
import type { DimensionKey, PlaylistBrief, Song } from '@/lib/types'
import type { Settings } from '@/lib/store'
import type { SongOutcome } from '@/lib/classifier/llm'
import { groupByDimension } from '@/lib/classifier'
import { artistSongCounts } from '@/lib/classifier/rules'
import type { ArtistDestinationResolution } from '@/lib/artist-playlists'
import type { CategoryPlan, DestinationChoice } from '@/lib/writer'
import { defaultDestinationFor } from '@/lib/writer'
import SongList from '../components/SongList'

interface Props {
  songs: Song[]
  outcomes: Map<number, SongOutcome>
  settings: Settings
  playlists: PlaylistBrief[]
  destinations: Record<string, DestinationChoice>
  artistResolutions: Record<string, ArtistDestinationResolution>
  scanWarnings: string[]
  planMessage: string
  plans: CategoryPlan[]
  busy: boolean
  applyLog: string[]
  onDestinationChange: (category: string, choice: DestinationChoice) => void
  onSongCategoryChange: (songId: number, dim: DimensionKey, category: string, previousCategory: string) => void
  onMergeCategory: (source: string, target: string) => void
  onRebuildPlan: () => void
  onApply: () => void
  onBack: () => void
}

function targetValue(choice: DestinationChoice): string {
  return choice.kind === 'existing' ? `existing:${choice.playlistId}` : 'new'
}

export default function PreviewStep({
  songs,
  outcomes,
  settings,
  playlists,
  destinations,
  artistResolutions,
  scanWarnings,
  planMessage,
  plans,
  busy,
  applyLog,
  onDestinationChange,
  onSongCategoryChange,
  onMergeCategory,
  onRebuildPlan,
  onApply,
  onBack,
}: Props) {
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({})
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const dim = settings.dimensions.find((dimension) => dimension.enabled)
  const availableTargets = playlists.filter((playlist) => playlist.specialType !== 5)
  const hasChanges = plans.some((plan) => plan.action !== 'none')

  if (!dim) {
    return <div className="err">没有选择分类维度，请返回配置页选择一个维度。</div>
  }

  const buckets = groupByDimension(songs, outcomes, dim)
  const classifiedIds = new Set([...buckets.values()].flatMap((list) => list.map((song) => song.id)))
  const unclassified = songs.filter((song) => !classifiedIds.has(song.id))
  const skippedArtists = dim.key === 'artist'
    ? [...artistSongCounts(songs)].filter(([, count]) => count < settings.minArtistSongs)
    : []
  const toggleSongs = (category: string, open: boolean) => {
    setExpandedCategories((previous) => {
      const next = new Set(previous)
      if (open) next.add(category)
      else next.delete(category)
      return next
    })
  }

  const renderSongs = (category: string, list: Song[]) => (
    <SongList songs={list} category={category} dimension={dim} busy={busy} onCategoryChange={onSongCategoryChange} />
  )
  const unresolvedCount = Object.values(artistResolutions).filter((resolution) => resolution.needsConfirmation).length

  return (
    <>
      <div className="step-content">
      <div className="card">
            <h2>{dim.label}分类结果</h2>
            <p className="muted small" style={{ margin: '5px 0 0' }}>
              本次仅运行一个维度。每个类目可导入已有歌单或新建歌单；未分类歌曲不会自动导入。
              {dim.key === 'artist' && `仅保留来源歌单中至少 ${settings.minArtistSongs} 首的歌手。合唱分别计数；调整当前归属会保留其他歌手归属。`}
            </p>
        <div className="summary-grid">
          <div><strong>{songs.length}</strong><span>来源歌曲</span></div>
          <div><strong>{[...buckets.values()].filter((list) => list.length > 0).length}</strong><span>非空分类</span></div>
          <div><strong>{plans.length ? plans.reduce((sum, plan) => sum + plan.toAdd.length, 0) : '—'}</strong><span>计划追加</span></div>
        </div>
        {unresolvedCount > 0 && <p className="notice">还有 {unresolvedCount} 个分类需要明确选择目标，完成后重新计算计划。</p>}
      </div>

      {planMessage && <div className="card muted small" role="status">{planMessage}</div>}

      {scanWarnings.length > 0 && (
        <div className="card">
          <details>
            <summary>有 {scanWarnings.length} 个歌单未参与内容识别</summary>
            {scanWarnings.map((warning) => <p key={warning} className="muted small">{warning}</p>)}
          </details>
        </div>
      )}

      {skippedArtists.length > 0 && (
        <div className="card">
          <details>
            <summary>未达门槛：跳过 {skippedArtists.length} 位歌手</summary>
            <p className="muted small">来源歌单中不足 {settings.minArtistSongs} 首，不为这些歌手生成导入任务。原列表保留。</p>
            {skippedArtists.map(([artist, count]) => <p key={artist} className="muted small">{artist}：{count} 首，少于 {settings.minArtistSongs} 首</p>)}
          </details>
        </div>
      )}

      {dim.key === 'artist' && dim.categories.length === 0 && (
        <div className="card muted small">没有歌手达到数量门槛。可返回配置调整最少歌曲数后重新分类。</div>
      )}

      {[...buckets.entries()].map(([category, list]) => {
        const suggestedTitle = dim.playlistNames?.[category] ?? category
        const resolution = artistResolutions[category]
        const choice = destinations[category] ?? (resolution?.needsConfirmation ? undefined : defaultDestinationFor(suggestedTitle, availableTargets))
        const title = choice?.kind === 'existing'
          ? availableTargets.find((playlist) => playlist.id === choice.playlistId)?.name ?? suggestedTitle
          : choice?.playlistName

        return (
          <section className="card category-card" key={category}>
            <div className="row between wrap">
              <h2 className="category-title truncate" title={category}>{category}</h2>
              <span className="badge">{list.length} 首</span>
            </div>
            {dim.categoryHints?.[category] && (
              <p className="muted small" style={{ margin: '5px 0 0' }}>
                分类范围：{dim.categoryHints[category]}
              </p>
            )}
            {dim.playlistNames?.[category] && (
              <p className="muted small" style={{ margin: '3px 0 0' }}>
                歌单名建议：{dim.playlistNames[category]}
              </p>
            )}
            {resolution && (
              <p className={`small ${resolution.needsConfirmation ? 'err' : 'muted'}`}>
                {resolution.reason}
                {resolution.needsConfirmation && resolution.candidates.length > 0 && (
                  <span> 候选：{resolution.candidates.map((candidate) => `《${candidate.playlistName}》（${candidate.trackCount} 首）`).join('、')}。请选择目标。</span>
                )}
              </p>
            )}
            {dim.categories.length > 1 && (dim.key !== 'artist' || expandedCategories.has(category)) && (
              <div className="row wrap merge-controls" style={{ marginTop: 8 }}>
                <span className="muted small">合并此类到</span>
                <select
                  aria-label={`${category}的合并目标`}
                  disabled={busy}
                  value={mergeTargets[category] ?? ''}
                  onChange={(event) =>
                    setMergeTargets((previous) => ({ ...previous, [category]: event.target.value }))
                  }
                >
                  <option value="">保持独立</option>
                  {dim.categories.filter((target) => target !== category).map((target) => (
                    <option key={target} value={target}>{target}</option>
                  ))}
                </select>
                <button
                  className="ghost"
                  disabled={busy || !mergeTargets[category]}
                  onClick={() => {
                    const target = mergeTargets[category]
                    if (target) {
                      onMergeCategory(category, target)
                      setMergeTargets((previous) => {
                        const next = { ...previous }
                        delete next[category]
                        return next
                      })
                    }
                  }}
                >
                  合并
                </button>
              </div>
            )}

            <div className="grid2" style={{ marginTop: 10 }}>
              <div>
                <label>导入目标</label>
                <select
                  aria-label={`${category}的导入目标`}
                  style={{ width: '100%' }}
                  disabled={busy}
                  value={choice ? targetValue(choice) : 'unresolved'}
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === 'new') {
                      onDestinationChange(category, { kind: 'new', playlistName: suggestedTitle })
                    } else {
                      const playlistId = Number(value.replace('existing:', ''))
                      onDestinationChange(category, { kind: 'existing', playlistId })
                    }
                  }}
                >
                  {!choice && <option value="unresolved" disabled>请选择目标歌单</option>}
                  <option value="new">新建歌单</option>
                  {availableTargets.map((playlist) => (
                    <option key={playlist.id} value={`existing:${playlist.id}`}>
                      使用已有：{playlist.name}（{playlist.trackCount} 首）
                    </option>
                  ))}
                </select>
              </div>
              {choice?.kind === 'new' ? (
                <div>
                  <label>新歌单名称</label>
                  <input
                    aria-label={`${category}的新歌单名称`}
                    type="text"
                    disabled={busy}
                    style={{ width: '100%' }}
                    value={choice.playlistName}
                    onChange={(event) =>
                      onDestinationChange(category, {
                        kind: 'new',
                        playlistName: event.target.value,
                      })
                    }
                  />
                </div>
              ) : (
                <div>
                  <label>目标歌单</label>
                  <div className="target-name truncate" title={title}>{title ?? '请选择目标歌单'}</div>
                </div>
              )}
            </div>

            {list.length > 0 ? (
              <details style={{ marginTop: 8 }} onToggle={(event) => toggleSongs(category, event.currentTarget.open)}>
                <summary>歌曲明细 · {list.length} 首<span className="summary-hint">点击歌名查看完整信息</span></summary>
                {expandedCategories.has(category) && renderSongs(category, list)}
              </details>
            ) : (
              <p className="muted small">该类目为空，不会创建或更新歌单。</p>
            )}
          </section>
        )
      })}

      {unclassified.length > 0 && (
        <div className="card">
          <details onToggle={(event) => toggleSongs('', event.currentTarget.open)}>
            <summary className="muted">未分类 {unclassified.length} 首（默认不导入，可手动归类）</summary>
            {expandedCategories.has('') && renderSongs('', unclassified)}
          </details>
        </div>
      )}

      <div className="card">
        <h2>导入计划</h2>
        <p className="muted small">
          已有歌单只追加歌曲、跳过重复项，不会移除原有内容。多个类目可以合并到同一个目标歌单。
        </p>
        {plans.length === 0 && <p className="muted small">调整目标或归属后，请重新计算计划，再核对追加数量。</p>}
      </div>

      {plans.length > 0 && !hasChanges && (
        <div className="card muted small">分类出的歌曲已经都在所选目标歌单中，无需追加。</div>
      )}

      {plans.length > 0 && (
        <div className="card">
          <h2>写入预览</h2>
          <table className="plan-table">
            <colgroup><col style={{ width: '28%' }} /><col style={{ width: '30%' }} /><col style={{ width: '14%' }} /><col style={{ width: '14%' }} /><col style={{ width: '14%' }} /></colgroup>
            <thead>
              <tr>
                <th>目标歌单</th>
                <th>来源类目</th>
                <th className="number-cell">歌曲</th>
                <th className="number-cell">追加</th>
                <th>动作</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.destinationKey}>
                  <td className="truncate" title={plan.playlistName}>{plan.playlistName}</td>
                  <td className="truncate muted" title={plan.sourceCategories.join('、')}>{plan.sourceCategories.join('、')}</td>
                  <td className="number-cell muted">{plan.songIds.length}</td>
                  <td className="number-cell muted">{plan.toAdd.length}</td>
                  <td>
                    <span className={`badge ${plan.action}`}>
                      {plan.action === 'create' ? '新建' : plan.action === 'append' ? '追加' : '已包含'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="plan-cards">
            {plans.map((plan) => (
              <article className="plan-card" key={plan.destinationKey}>
                <div className="row between">
                  <strong className="truncate" title={plan.playlistName}>{plan.playlistName}</strong>
                  <span className={`badge ${plan.action}`}>{plan.action === 'create' ? '新建' : plan.action === 'append' ? '追加' : '已包含'}</span>
                </div>
                <p className="truncate muted small" title={plan.sourceCategories.join('、')}>{plan.sourceCategories.join('、')}</p>
                <div className="row between small"><span>分类歌曲 {plan.songIds.length} 首</span><strong>将追加 {plan.toAdd.length} 首</strong></div>
              </article>
            ))}
          </div>
        </div>
      )}

      {applyLog.length > 0 && (
        <details className="card">
          <summary>查看导入日志 · {applyLog.length} 条</summary>
          <div className="log">{applyLog.join('\n')}</div>
        </details>
      )}
      </div>
      <footer className="step-actions">
        <button onClick={onBack} disabled={busy}>上一步</button>
        <div className="actions-group">
          <button onClick={onRebuildPlan} disabled={busy}>重新计算计划</button>
          <button className="primary" onClick={onApply} disabled={busy || !hasChanges || unresolvedCount > 0}>确认导入</button>
        </div>
      </footer>
    </>
  )
}
