import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NeteaseProfile, PlaylistBrief, Song } from '@/lib/types'
import type { Settings } from '@/lib/store'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, cacheSize, clearCache } from '@/lib/store'
import {
  getPlaylistTrackIds,
  getProfile,
  getSongDetails,
  getUserPlaylists,
  pickLikedPlaylist,
} from '@/lib/netease'
import { classifySongs, groupByDimension, type ClassifyProgress } from '@/lib/classifier'
import type { SongOutcome } from '@/lib/classifier/llm'
import {
  applyWritePlan,
  buildWritePlan,
  defaultDestinationFor,
  type ApplyProgress,
  type CategoryPlan,
  type DestinationChoice,
} from '@/lib/writer'
import { ensureHostPermission } from '@/lib/permissions'
import ConnectStep from './steps/ConnectStep'
import SelectStep from './steps/SelectStep'
import ConfigureStep from './steps/ConfigureStep'
import ClassifyStep from './steps/ClassifyStep'
import PreviewStep from './steps/PreviewStep'

export type Step = 'connect' | 'select' | 'configure' | 'classify' | 'preview'

const STEP_LABELS: Record<Step, string> = {
  connect: '1 登录',
  select: '2 选歌单',
  configure: '3 配置',
  classify: '4 分类',
  preview: '5 预览与写入',
}

const STEP_ORDER: Step[] = ['connect', 'select', 'configure', 'classify', 'preview']

export default function App() {
  const [step, setStep] = useState<Step>('connect')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [profile, setProfile] = useState<NeteaseProfile | null>(null)
  const [playlists, setPlaylists] = useState<PlaylistBrief[]>([])
  const [selected, setSelected] = useState<PlaylistBrief | null>(null)
  const [cachedCount, setCachedCount] = useState(0)

  const [songs, setSongs] = useState<Song[]>([])
  const [songMsg, setSongMsg] = useState('')

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [progress, setProgress] = useState<ClassifyProgress | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [outcomes, setOutcomes] = useState<Map<number, SongOutcome>>(new Map())

  const [plans, setPlans] = useState<CategoryPlan[]>([])
  const [destinations, setDestinations] = useState<Record<string, DestinationChoice>>({})
  const [applyLog, setApplyLog] = useState<string[]>([])

  const abortRef = useRef<AbortController | null>(null)

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-199), line])
  }, [])

  useEffect(() => {
    void (async () => {
      setSettings(await loadSettings())
      setCachedCount(await cacheSize())
    })()
  }, [])

  /** 连接网易云：确认登录并拉取歌单 */
  const connect = useCallback(
    async (quiet = false) => {
      setError(null)
      if (!quiet) setBusy(true)
      try {
        const me = await getProfile()
        setProfile(me)
        if (!me) {
          if (!quiet) {
            setError('未检测到网易云登录态。请先在浏览器里登录 music.163.com，再点「重新检测」。')
          }
          return
        }
        const list = await getUserPlaylists(me.userId)
        setPlaylists(list)
        const liked = pickLikedPlaylist(list)
        if (liked) setSelected((prev) => prev ?? liked)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!quiet) setBusy(false)
      }
    },
    [],
  )

  useEffect(() => {
    void connect(true)
  }, [connect])

  /** 拉取所选歌单的全部歌曲详情 */
  const loadSongs = useCallback(async () => {
    if (!selected) return
    setBusy(true)
    setError(null)
    setSongMsg('读取歌曲列表…')
    try {
      const ids = await getPlaylistTrackIds(selected.id)
      appendLog(`歌单「${selected.name}」共 ${ids.length} 首`)
      setSongMsg(`拉取 ${ids.length} 首歌曲详情…`)
      const details = await getSongDetails(ids, (done, total) => {
        setSongMsg(`拉取歌曲详情 ${done}/${total}`)
      })
      setSongs(details)
      setSongMsg(`已加载 ${details.length} 首`)
      appendLog(`成功获取 ${details.length} 首详情`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSongMsg('')
    } finally {
      setBusy(false)
    }
  }, [selected, appendLog])

  const startClassify = useCallback(async () => {
    if (songs.length === 0) return
    setError(null)
    setLog([])
    setProgress(null)
    setPlans([])
    setDestinations({})
    setBusy(true)
    try {
      const ok = await ensureHostPermission(settings.baseUrl)
      if (!ok) {
        throw new Error('未授予模型接口的访问权限，无法调用大模型。')
      }
      await saveSettings(settings)
      const controller = new AbortController()
      abortRef.current = controller
      setStep('classify')

      const result = await classifySongs(songs, settings, {
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p)
        },
      })
      setOutcomes(result.outcomes)
      setCachedCount(await cacheSize())
      if (result.failedBatches > 0) {
        appendLog(`注意：有 ${result.failedBatches} 首未能得到分类结果`)
      }
      appendLog('分类结束')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }, [songs, settings, appendLog])

  const stopClassify = useCallback(() => {
    abortRef.current?.abort()
    appendLog('已请求停止')
  }, [appendLog])

  const buildPlan = useCallback(async (
    selectedDestinations: Record<string, DestinationChoice> = destinations,
  ) => {
    setBusy(true)
    setError(null)
    setApplyLog([])
    try {
      const dimension = settings.dimensions.find((item) => item.enabled)
      if (!dimension) throw new Error('请先选择一个分类维度。')

      const grouped = groupByDimension(songs, outcomes, dimension)
      const groups: Parameters<typeof buildWritePlan>[0]['groups'] = []
      const resolvedDestinations: Record<string, DestinationChoice> = {}
      for (const category of dimension.categories) {
        const displayTitle = dimension.playlistNames?.[category] ?? category
        const destination =
          selectedDestinations[category] ?? defaultDestinationFor(displayTitle, playlists)
        resolvedDestinations[category] = destination
        const categorySongs = grouped.get(category) ?? []
        if (categorySongs.length === 0) continue
        groups.push({
          dimension: dimension.key,
          dimensionLabel: dimension.label,
          category,
          displayTitle,
          songs: categorySongs,
          destination,
        })
      }
      setDestinations(resolvedDestinations)
      appendLog('正在读取目标歌单，计算追加计划…')
      const built = await buildWritePlan({ groups, existingPlaylists: playlists })
      setPlans(built)
      appendLog(`生成 ${built.length} 条导入计划`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPlans([])
    } finally {
      setBusy(false)
    }
  }, [songs, outcomes, settings.dimensions, playlists, destinations, appendLog])

  const applyPlan = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await applyWritePlan(plans, {
        onProgress: (p: ApplyProgress) => {
          setApplyLog((prev) => [
            ...prev.slice(-199),
            `[${p.index + 1}/${p.total}] ${p.playlistName} — ${p.message}`,
          ])
        },
      })
      setApplyLog((prev) => [
        ...prev,
        `完成：新建 ${result.created} 个，更新 ${result.updated} 个，写入 ${result.songWrites} 首`,
      ])
      await connect(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [plans, connect])

  const updateSongCategory = useCallback(
    (songId: number, dimKey: Settings['dimensions'][number]['key'], category: string) => {
      setOutcomes((prev) => {
        const next = new Map(prev)
        const entry = { ...(next.get(songId) ?? {}) }
        if (category) {
          entry[dimKey] = { category, source: 'manual' }
        } else {
          delete entry[dimKey]
        }
        next.set(songId, entry)
        return next
      })
      setPlans([])
    },
    [],
  )

  const currentIndex = STEP_ORDER.indexOf(step)
  const canGo = useMemo(
    () => ({
      select: profile != null,
      configure: songs.length > 0,
      classify: songs.length > 0,
      preview: outcomes.size > 0,
    }),
    [profile, songs.length, outcomes.size],
  )

  return (
    <>
      <h1>分类并导入</h1>
      <p className="sub">选择来源歌单，分类后指定目标。</p>

      <div className="steps">
        {STEP_ORDER.map((s, i) => (
          <span
            key={s}
            className={s === step ? 'active' : i < currentIndex ? 'done' : ''}
            onClick={() => {
              if (i <= currentIndex || canGo[s as keyof typeof canGo]) setStep(s)
            }}
          >
            {STEP_LABELS[s]}
          </span>
        ))}
      </div>

      {error && <div className="err">{error}</div>}

      {step === 'connect' && (
        <ConnectStep
          profile={profile}
          busy={busy}
          cachedCount={cachedCount}
          onRefresh={() => void connect()}
          onNext={() => setStep('select')}
          onClearCache={async () => {
            await clearCache()
            setCachedCount(0)
            appendLog('已清空分类缓存')
          }}
        />
      )}

      {step === 'select' && (
        <SelectStep
          playlists={playlists}
          selected={selected}
          songs={songs}
          songMsg={songMsg}
          busy={busy}
          onSelect={setSelected}
          onLoadSongs={() => void loadSongs()}
          onNext={() => setStep('configure')}
        />
      )}

      {step === 'configure' && (
        <ConfigureStep
          settings={settings}
          onChange={setSettings}
          onChangeAndSave={(next: Settings) => {
            setSettings(next)
            void saveSettings(next)
          }}
          onNext={() => void startClassify()}
          onBack={() => setStep('select')}
          songCount={songs.length}
        />
      )}

      {step === 'classify' && (
        <ClassifyStep
          progress={progress}
          busy={busy}
          log={log}
          total={songs.length}
          onStop={stopClassify}
          onRetry={() => void startClassify()}
          onNext={() => {
            setStep('preview')
            void buildPlan({})
          }}
        />
      )}

      {step === 'preview' && (
        <PreviewStep
          songs={songs}
          outcomes={outcomes}
          settings={settings}
          playlists={playlists}
          destinations={destinations}
          plans={plans}
          busy={busy}
          applyLog={applyLog}
          onDestinationChange={(category, choice) => {
            setDestinations((previous) => ({ ...previous, [category]: choice }))
            setPlans([])
          }}
          onSongCategoryChange={updateSongCategory}
          onRebuildPlan={() => void buildPlan(destinations)}
          onApply={() => void applyPlan()}
          onBack={() => setStep('classify')}
        />
      )}
    </>
  )
}
