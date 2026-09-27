import type { Dimension, DimensionKey } from '@/lib/types'
import type { Settings } from '@/lib/store'

interface Props {
  settings: Settings
  onChange: (settings: Settings) => void
  onChangeAndSave: (settings: Settings) => void
  onNext: () => void
  onBack: () => void
  songCount: number
}

const DIM_HINT: Record<DimensionKey, string> = {
  mood: '情绪 / 场景 —— 依赖模型推断，主观性较强',
  genre: '曲风 —— 默认三类大类，分类名与最终歌单名分开',
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
}: Props) {
  const patch = (partial: Partial<Settings>) => onChange({ ...settings, ...partial })
  const patchDim = (key: DimensionKey, partial: Partial<Dimension>) =>
    patch({
      dimensions: settings.dimensions.map((dimension) =>
        dimension.key === key ? { ...dimension, ...partial } : dimension,
      ),
    })

  const activeDimension = settings.dimensions.find((dimension) => dimension.enabled)
  const batchCount = Math.ceil(songCount / Math.max(1, settings.batchSize))

  const chooseDimension = (key: DimensionKey) => {
    onChangeAndSave({
      ...settings,
      dimensions: settings.dimensions.map((dimension) => ({
        ...dimension,
        enabled: dimension.key === key,
      })),
    })
  }

  return (
    <>
      <div className="card">
        <h2>选择分类维度</h2>
        <p className="muted small">
          每次只运行一个维度，一首歌只会被分到该维度的一个类目。
        </p>

        {settings.dimensions.map((dimension) => (
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
                <span className="muted small" style={{ marginLeft: 8 }}>
                  {dimension.key}
                </span>
              </label>
              <span className="muted small">{DIM_HINT[dimension.key]}</span>
            </div>
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
          </div>
        ))}
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
          {settings.batchSize} 首估算，约 {batchCount} 次模型调用。
        </p>
      </div>

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
