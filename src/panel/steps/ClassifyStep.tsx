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
      <div className="step-content">
      <div className="card">
        <div className="row between wrap">
          <h2 style={{ margin: 0 }}>{busy ? '正在整理歌曲' : done > 0 ? '本轮分类已结束' : '准备分类'}</h2>
          <strong className="progress-value">{pct}%</strong>
        </div>

        <div className="bar" role="progressbar" aria-label="歌曲分类进度" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ marginTop: 12 }}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="muted small" role="status" style={{ marginTop: 8 }}>
          {progress?.message ?? '准备中…'}
        </p>

        <div className="summary-grid">
          <div><strong title={`${done} / ${total}`}>{done} / {total}</strong><span>已处理歌曲</span></div>
          <div><strong>{progress?.cached ?? 0}</strong><span>复用缓存</span></div>
          <div><strong>{progress?.failed ?? 0}</strong><span>未得到结果</span></div>
        </div>
      </div>

      {log.length > 0 && (
        <details className="card">
          <summary>查看运行日志 · {log.length} 条</summary>
          <div className="log">{log.join('\n')}</div>
        </details>
      )}
      </div>
      <footer className="step-actions">
          {busy ? (
            <>
            <span className="muted small action-status">收起浮窗后任务继续</span>
            <button onClick={onStop}>停止</button>
            </>
          ) : (
            <>
              <button onClick={onRetry}>重新分类</button>
              <button className="primary" onClick={onNext} disabled={done === 0}>
                查看结果
              </button>
            </>
          )}
      </footer>
    </>
  )
}
