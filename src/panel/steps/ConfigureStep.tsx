import { useEffect, useState } from 'react'
import type { Dimension, DimensionKey } from '@/lib/types'
import type { Settings } from '@/lib/store'
import { normalizeMinArtistSongs } from '@/lib/store'

interface Props {
  settings: Settings
  onChange: (settings: Settings) => void
  onChangeAndSave: (settings: Settings) => void
  onNext: () => void
  onBack: () => void
  songCount: number
  regenerateGenreScheme: boolean
  onRegenerateGenreSchemeChange: (value: boolean) => void
}

const DIM_HINT: Record<DimensionKey, string> = {
  artist: '歌手 —— 按歌曲资料分组，合唱归入每位歌手，无需 AI',
  mood: '情绪 / 场景 —— 依赖模型推断，主观性较强',
  genre: '曲风 —— AI 根据当前歌单生成最多 N 个风格类目',
  language: '语种 —— Unicode 预判后交模型复核',
  era: '年代 —— 按发行时间计算，不消耗模型 token',
}

export default function ConfigureStep({
  settings,
  onChange,
  onChangeAndSave,
  onNext,
  onBack,
  songCount,
  regenerateGenreScheme,
  onRegenerateGenreSchemeChange,
}: Props) {
  const patch = (partial: Partial<Settings>) => onChange({ ...settings, ...partial })
  const patchDim = (key: DimensionKey, partial: Partial<Dimension>) =>
    patch({
      dimensions: settings.dimensions.map((dimension) =>
        dimension.key === key ? { ...dimension, ...partial } : dimension,
      ),
    })

  const activeDimension = settings.dimensions.find((dimension) => dimension.enabled)
  const isArtist = activeDimension?.key === 'artist'
  const [showMoreDimensions, setShowMoreDimensions] = useState(false)
  const primaryOrder: DimensionKey[] = ['artist', 'genre', 'mood', 'language']
  const primaryDimensions = primaryOrder
    .map((key) => settings.dimensions.find((dimension) => dimension.key === key))
    .filter((dimension): dimension is Dimension => Boolean(dimension))
  const moreDimensions = settings.dimensions.filter((dimension) => !primaryOrder.includes(dimension.key))

  useEffect(() => {
    if (activeDimension?.key === 'era') setShowMoreDimensions(true)
  }, [activeDimension?.key])

  const batchCount = Math.ceil(songCount / Math.max(1, settings.batchSize))
  const estimatedCalls =
    (activeDimension?.key === 'era' ? 0 : batchCount) +
    (activeDimension?.key === 'genre' ? 1 : 0) +
    (settings.playlistNameStyle !== 'concise' ||
    activeDimension?.categories.some((category) => Array.from(category).length > 12)
      ? 1
      : 0)

  const chooseDimension = (key: DimensionKey) => {
    onChangeAndSave({
      ...settings,
      dimensions: settings.dimensions.map((dimension) => ({
        ...dimension,
        enabled: dimension.key === key,
      })),
    })
  }

  const renderDimension = (dimension: Dimension) => (
    <div key={dimension.key} style={{ marginTop: 14 }}>
      <div className="row between wrap">
        <label style={{ margin: 0 }}>
          <input
            type="radio"
            name="classification-dimension"
            checked={dimension.enabled}
            onChange={() => chooseDimension(dimension.key)}
            style={{ marginRight: 6 }}
          />
          <strong>{dimension.label}</strong>
        </label>
        <span className="muted small">{DIM_HINT[dimension.key]}</span>
      </div>
      {dimension.key === 'artist' ? (
        <div style={{ marginTop: 8 }}>
          <label htmlFor="min-artist-songs">歌手最少歌曲数（含此数量）</label>
          <input
            id="min-artist-songs"
            type="number"
            min={1}
            step={1}
            value={settings.minArtistSongs}
            disabled={!dimension.enabled}
            onChange={(event) => patch({ minArtistSongs: normalizeMinArtistSongs(Number(event.target.value)) })}
          />
          <p className="muted small">
            默认 10 首。按来源歌单的不同歌曲计数，合唱分别计入每位歌手；不足门槛的歌手跳过，原列表保留。
            预览时会扫描已有歌单：全部歌曲都包含该歌手时，才能按内容配对；有歧义时由你选择。
          </p>
        </div>
      ) : dimension.key === 'genre' ? (
        <div className="grid2" style={{ marginTop: 8 }}>
          <div>
            <label>最多曲风类别数（2–8）</label>
            <input
              type="number"
              min={2}
              max={8}
              value={settings.maxGenreCategories}
              disabled={!dimension.enabled}
              onChange={(event) => {
                const value = Math.round(Number(event.target.value)) || 3
                patch({ maxGenreCategories: Math.min(8, Math.max(2, value)) })
              }}
            />
          </div>
          <label className="muted small" style={{ display: 'flex', alignItems: 'center', margin: 0 }}>
            <input
              type="checkbox"
              checked={regenerateGenreScheme}
              disabled={!dimension.enabled}
              onChange={(event) => onRegenerateGenreSchemeChange(event.target.checked)}
              style={{ marginRight: 6 }}
            />
            重新分析并生成曲风方案
          </label>
          <p className="muted small" style={{ gridColumn: '1 / -1', margin: 0 }}>
            首次从当前歌单均匀抽样生成方案（最多 120 首）；之后复用已保存方案，勾选可重新分析。
          </p>
        </div>
      ) : (
        <textarea
          style={{ marginTop: 6, minHeight: 54 }}
          value={dimension.categories.join('、')}
          disabled={!dimension.enabled}
          onChange={(event) =>
            patchDim(dimension.key, {
              categories: event.target.value
                .split(/[、,，\n]/)
                .map((value) => value.trim())
                .filter(Boolean),
            })
          }
        />
      )}
    </div>
  )

  return (
    <>
      <div className="card">
        <h2>选择分类维度</h2>
        <p className="muted small">
          每次只运行一个维度。歌手分类支持合唱多归属，其他维度每首歌归入一个类目。
        </p>

        {primaryDimensions.map(renderDimension)}
        {moreDimensions.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <button className="ghost" onClick={() => setShowMoreDimensions((open) => !open)}>
              {showMoreDimensions ? '收起更多维度' : '更多维度'}
              {activeDimension && moreDimensions.some((dimension) => dimension.key === activeDimension.key)
                ? `（当前：${activeDimension.label}）`
                : ''}
            </button>
            {showMoreDimensions && moreDimensions.map(renderDimension)}
          </div>
        )}
      </div>

      {!isArtist && <>
      <div className="card">
        <h2>歌单命名风格</h2>
        <p className="muted small">
          只影响新建歌单的名称建议，不改变分类结果；预览时仍可逐个修改名称。建议不超过 12 字。
        </p>
        <label>选择风格</label>
        <select
          style={{ width: '100%' }}
          value={settings.playlistNameStyle}
          onChange={(event) => patch({ playlistNameStyle: event.target.value as Settings['playlistNameStyle'] })}
        >
          <option value="concise">简洁直白（默认）</option>
          <option value="japanese-literary">日式文学</option>
          <option value="retro-record">复古唱片</option>
          <option value="cinematic">电影感 / 氛围感</option>
          <option value="custom">自定义描述</option>
        </select>
        {settings.playlistNameStyle === 'custom' && (
          <div style={{ marginTop: 10 }}>
            <label>描述你想要的命名风格</label>
            <textarea
              maxLength={120}
              style={{ width: '100%', minHeight: 72 }}
              value={settings.customPlaylistNameStyle}
              placeholder="例如：带季节和天气意象，安静克制，不超过 8 个汉字"
              onChange={(event) => patch({ customPlaylistNameStyle: event.target.value })}
            />
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              {settings.customPlaylistNameStyle.length}/120
            </p>
          </div>
        )}
      </div>

      <div className="card">
        <h2>模型设置</h2>
        <p className="muted small">
          设置保存到当前 Chrome 的本地扩展存储中，之后打开插件无需重新填写。
        </p>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div>
            <label>接口地址</label>
            <input
              type="text"
              style={{ width: '100%' }}
              value={settings.baseUrl}
              onChange={(event) => patch({ baseUrl: event.target.value })}
            />
          </div>
          <div>
            <label>模型名</label>
            <input
              type="text"
              style={{ width: '100%' }}
              value={settings.model}
              onChange={(event) => patch({ model: event.target.value })}
            />
          </div>
          <div>
            <label>API Key</label>
            <input
              type="password"
              style={{ width: '100%' }}
              value={settings.apiKey}
              placeholder="sk-..."
              onChange={(event) => patch({ apiKey: event.target.value })}
            />
          </div>
          <div>
            <label>每批歌曲数</label>
            <input
              type="number"
              min={5}
              max={50}
              value={settings.batchSize}
              onChange={(event) => patch({ batchSize: Number(event.target.value) || 20 })}
            />
          </div>
          <div>
            <label>并发请求数</label>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.concurrency}
              onChange={(event) => patch({ concurrency: Number(event.target.value) || 1 })}
            />
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>
          当前维度：{activeDimension?.label ?? '未选择'}；{songCount} 首歌，按每批{' '}
          {settings.batchSize} 首估算，约 {estimatedCalls} 次模型调用；已有方案或名称缓存时会更少。
        </p>
      </div>
      </>}

      <div className="row between">
        <button onClick={onBack}>上一步</button>
        <div className="row">
          <button onClick={() => onChangeAndSave(settings)}>保存设置</button>
          <button className="primary" onClick={onNext} disabled={!activeDimension || songCount === 0}>
            开始分类
          </button>
        </div>
      </div>
    </>
  )
}
