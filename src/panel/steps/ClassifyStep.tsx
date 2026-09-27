import type { ClassifyProgress } from '@/lib/classifier'

interface Props {
  progress: ClassifyProgress | null
  busy: boolean
  log: string[]
  total: number
  onStop: () => void
  onRetry: () => void
  onNext: () => void
}

export default function ClassifyStep({
  progress,
  busy,
  log,
  total,
  onStop,
  onRetry,
  onNext,
}: Props) {
  const done = progress?.done ?? 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <>
      <div className="card">
        <div className="row between wrap">
          <h2 style={{ margin: 0 }}>分类中</h2>
          <span className="muted small">
            {done} / {total}（命中缓存 {progress?.cached ?? 0}，未出结果 {progress?.failed ?? 0}）
          </span>
        </div>

        <div className="bar" style={{ marginTop: 12 }}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          {progress?.message ?? '准备中…'}
        </p>

        <div className="row" style={{ marginTop: 14 }}>
          {busy ? (
            <button onClick={onStop}>停止</button>
          ) : (
            <>
              <button onClick={onRetry}>重新分类</button>
              <button className="primary" onClick={onNext} disabled={done === 0}>
                查看结果
              </button>
            </>
          )}
        </div>
      </div>

      {log.length > 0 && (
        <div className="card">
          <h2>运行日志</h2>
          <div className="log">{log.join('\n')}</div>
        </div>
      )}
    </>
  )
}
