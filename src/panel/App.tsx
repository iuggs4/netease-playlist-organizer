import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dimension, NeteaseProfile, PlaylistBrief, PlaylistNameStyle, Song } from '@/lib/types'
import type { Settings } from '@/lib/store'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  cacheSize,
  clearCache,
  loadGenreScheme,
  saveGenreScheme,
  loadPlaylistNameSuggestions,
  savePlaylistNameSuggestions,
} from '@/lib/store'
import {
  getPlaylistTrackIds,
  getProfile,
  getSongDetails,
  getUserPlaylists,
  pickLikedPlaylist,
} from '@/lib/netease'
import { categoriesOf, classifySongs, groupByDimension, replaceArtistCategory, type ClassifyProgress } from '@/lib/classifier'
import { artistSongCounts } from '@/lib/classifier/rules'
import { resolveArtistDestination, scanArtistPlaylists, type ArtistDestinationResolution } from '@/lib/artist-playlists'
import {
  discoverGenreDimension,
  generatePlaylistNameSuggestions,
  type SongOutcome,
} from '@/lib/classifier/llm'
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
  connect: '登录连接',
  select: '来源歌单',
  configure: '分类规则',
  classify: '分类进度',
  preview: '核对导入',
}

const STEP_HINTS: Record<Step, string> = {
  connect: '连接已登录的网易云账号，开始整理你的音乐。',
  select: '选择歌曲来源，原歌单和喜欢列表都会保留。',
  configure: '选择一种分类方式，设置本次整理规则。',
  classify: '查看分类进度，完成后核对歌曲与目标歌单。',
  preview: '核对歌曲、配对依据和追加数量，再确认导入。',
}

const STEP_ORDER: Step[] = ['connect', 'select', 'configure', 'classify', 'preview']
const PLAYLIST_NAME_STYLE_LABELS: Record<PlaylistNameStyle, string> = {
  'japanese-literary': '日式文学',
  concise: '简洁直白',
  'retro-record': '复古唱片',
  cinematic: '电影感 / 氛围感',
  custom: '自定义',
}

function classificationRunKey(
  playlistId: number,
  songs: Song[],
  dimension: Dimension,
  settings: Pick<Settings, 'baseUrl' | 'model' | 'minArtistSongs'>,
): string {
  return JSON.stringify({
    version: 'classifier-v2',
    playlistId,
    songs: songs.map((song) => ({
      id: song.id,
      name: song.name,
      artists: song.artists,
      album: song.album,
      publishTime: song.publishTime,
    })),
    baseUrl: settings.baseUrl,
    model: settings.model,
    key: dimension.key,
    minArtistSongs: dimension.key === 'artist' ? settings.minArtistSongs : undefined,
    categories: dimension.categories,
    categoryHints: dimension.categoryHints ?? {},
  })
}

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
  const [activeDimension, setActiveDimension] = useState<Dimension | null>(null)
  const [regenerateGenreScheme, setRegenerateGenreScheme] = useState(false)
  const [progress, setProgress] = useState<ClassifyProgress | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [outcomes, setOutcomes] = useState<Map<number, SongOutcome>>(new Map())

  const [plans, setPlans] = useState<CategoryPlan[]>([])
  const [destinations, setDestinations] = useState<Record<string, DestinationChoice>>({})
  const [artistResolutions, setArtistResolutions] = useState<Record<string, ArtistDestinationResolution>>({})
  const [scanWarnings, setScanWarnings] = useState<string[]>([])
  const [planMessage, setPlanMessage] = useState('')
  const [applyLog, setApplyLog] = useState<string[]>([])

  const abortRef = useRef<AbortController | null>(null)
  const classifiedRunKeyRef = useRef<string | null>(null)
  const manualDestinationsRef = useRef<Record<string, DestinationChoice>>({})

  const invalidateClassification = useCallback(() => {
    classifiedRunKeyRef.current = null
    manualDestinationsRef.current = {}
    setActiveDimension(null)
    setOutcomes(new Map())
    setDestinations({})
    setArtistResolutions({})
    setPlans([])
    setProgress(null)
    setScanWarnings([])
    setPlanMessage('')
  }, [])

  const updateSettings = (next: Settings) => {
    if (next.minArtistSongs !== settings.minArtistSongs) invalidateClassification()
    setSettings(next)
  }

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
    invalidateClassification()
    setSongs([])
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
  }, [selected, appendLog, invalidateClassification])

  const startClassify = useCallback(async (forceReclassify = false) => {
    if (songs.length === 0) return
    const configuredDimension = settings.dimensions.find((dimension) => dimension.enabled)
    if (!configuredDimension) {
      setError('请先选择一个分类维度。')
      return
    }
    if (!selected) {
      setError('请先选择来源歌单。')
      return
    }
    if (configuredDimension.key !== 'artist' && settings.playlistNameStyle === 'custom' && !settings.customPlaylistNameStyle.trim()) {
      setError('请填写自定义歌单命名风格，或选择一个预设风格。')
      return
    }

    setError(null)
    setLog([])
    setProgress(null)
    setPlans([])
    setArtistResolutions({})
    setScanWarnings([])
    setPlanMessage('')
    setBusy(true)
    try {
      if (configuredDimension.key !== 'artist') {
        const ok = await ensureHostPermission(settings.baseUrl)
        if (!ok) throw new Error('未授予模型接口的访问权限，无法调用大模型。')
      }
      await saveSettings(settings)
      const controller = new AbortController()
      abortRef.current = controller
      setStep('classify')

      let dimension = configuredDimension
      if (configuredDimension.key === 'artist') {
        const counts = artistSongCounts(songs)
        dimension = { ...configuredDimension, categories: [...counts].filter(([, count]) => count >= settings.minArtistSongs).map(([artist]) => artist) }
        appendLog(`至少 ${settings.minArtistSongs} 首：保留 ${dimension.categories.length} 位歌手，跳过 ${counts.size - dimension.categories.length} 位，无需 AI`)
      }
      if (configuredDimension.key === 'genre') {
        setProgress({ done: 0, total: songs.length, cached: 0, failed: 0, message: '正在分析当前歌单的曲风分布…' })
        const cachedScheme = regenerateGenreScheme
          ? null
          : await loadGenreScheme(selected.id, settings.model, settings.maxGenreCategories)
        if (cachedScheme) {
          dimension = cachedScheme
          appendLog(`复用已保存的曲风方案（${dimension.categories.length} 类）`)
        } else {
          dimension = await discoverGenreDimension({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            maxCategories: settings.maxGenreCategories,
            songs,
            signal: controller.signal,
          })
          await saveGenreScheme(selected.id, settings.model, settings.maxGenreCategories, dimension)
          appendLog(`AI 根据当前歌单生成了 ${dimension.categories.length} 类曲风方案`)
        }
        setRegenerateGenreScheme(false)
      }

      let playlistNames: Record<string, string>
      const needsNameModel =
        dimension.key !== 'artist' && (
          settings.playlistNameStyle !== 'concise' ||
          dimension.categories.some((category) => Array.from(category).length > 12)
        )
      if (!needsNameModel) {
        playlistNames = Object.fromEntries(dimension.categories.map((category) => [category, category]))
      } else {
        setProgress({ done: 0, total: songs.length, cached: 0, failed: 0, message: '正在按所选风格生成歌单名建议…' })
        const cachedNames = await loadPlaylistNameSuggestions(
          settings.baseUrl,
          settings.model,
          dimension,
          settings.playlistNameStyle,
          settings.customPlaylistNameStyle,
        )
        if (cachedNames) {
          playlistNames = cachedNames
          appendLog('复用已保存的歌单名建议')
        } else {
          playlistNames = await generatePlaylistNameSuggestions({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            dimension,
            style: settings.playlistNameStyle,
            customStyle: settings.customPlaylistNameStyle,
            signal: controller.signal,
          })
          await savePlaylistNameSuggestions(
            settings.baseUrl,
            settings.model,
            dimension,
            settings.playlistNameStyle,
            settings.customPlaylistNameStyle,
            playlistNames,
          )
          appendLog(`AI 按「${PLAYLIST_NAME_STYLE_LABELS[settings.playlistNameStyle]}」风格生成了歌单名建议`)
        }
      }
      dimension = { ...dimension, playlistNames }

      const runSettings: Settings = {
        ...settings,
        dimensions: settings.dimensions.map((item) =>
          item.key === dimension.key ? dimension : { ...item, enabled: false },
        ),
      }
      const runKey = classificationRunKey(selected.id, songs, dimension, settings)
      const canReuseResults =
        !forceReclassify && classifiedRunKeyRef.current === runKey && outcomes.size === songs.length
      setActiveDimension(dimension)
      if (canReuseResults) {
        const previousNames = activeDimension?.key === dimension.key
          ? activeDimension.playlistNames ?? {}
          : {}
        setDestinations((previous) => {
          const next = { ...previous }
          for (const category of dimension.categories) {
            const choice = next[category]
            const previousSuggestion = previousNames[category] ?? category
            if (choice?.kind === 'new' && choice.playlistName === previousSuggestion) {
              next[category] = { kind: 'new', playlistName: playlistNames[category] ?? category }
            }
          }
          return next
        })
        setProgress({
          done: songs.length,
          total: songs.length,
          cached: 0,
          failed: 0,
          message: '分类结果未改变，仅更新歌单名建议',
        })
        appendLog('沿用现有分类结果，仅更新歌单名建议')
      } else {
        manualDestinationsRef.current = {}
        setDestinations({})
        setOutcomes(new Map())
        const result = await classifySongs(songs, runSettings, {
          signal: controller.signal,
          onProgress: (p) => setProgress(p),
        })
        setOutcomes(result.outcomes)
        classifiedRunKeyRef.current = result.failedBatches === 0 ? runKey : null
        if (result.failedBatches > 0) {
          appendLog(`注意：有 ${result.failedBatches} 首未能得到分类结果`)
        }
      }
      setCachedCount(await cacheSize())
      appendLog('分类结束')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }, [songs, selected, settings, regenerateGenreScheme, outcomes, activeDimension, appendLog])

  const stopClassify = useCallback(() => {
    abortRef.current?.abort()
    appendLog('已请求停止')
  }, [appendLog])

  const buildPlan = useCallback(async () => {
    setBusy(true)
    setError(null)
    setApplyLog([])
    setPlans([])
    setScanWarnings([])
    setPlanMessage('正在刷新目标歌单…')
    try {
      const dimension = activeDimension ?? settings.dimensions.find((item) => item.enabled)
      if (!dimension) throw new Error('请先选择一个分类维度。')
      if (!profile) throw new Error('请先重新检测网易云登录状态。')
      const currentPlaylists = await getUserPlaylists(profile.userId)
      setPlaylists(currentPlaylists)
      const writablePlaylists = currentPlaylists.filter((playlist) => playlist.userId === profile.userId && playlist.specialType !== 5)

      const grouped = groupByDimension(songs, outcomes, dimension)
      const evidence = dimension.key === 'artist' && [...grouped.values()].some((list) => list.length > 0)
        ? await scanArtistPlaylists(writablePlaylists, profile.userId, setPlanMessage)
        : []
      setScanWarnings(evidence.filter((item) => item.error).map((item) => `《${item.playlistName}》：${item.error}`))
      const groups: Parameters<typeof buildWritePlan>[0]['groups'] = []
      const resolvedDestinations: Record<string, DestinationChoice> = {}
      const resolutions: Record<string, ArtistDestinationResolution> = {}
      const unresolved: string[] = []
      for (const category of dimension.categories) {
        const categorySongs = grouped.get(category) ?? []
        if (categorySongs.length === 0) continue
        const displayTitle = dimension.playlistNames?.[category] ?? category
        let destination: DestinationChoice
        if (dimension.key === 'artist') {
          const resolution = resolveArtistDestination(category, displayTitle, writablePlaylists, evidence, manualDestinationsRef.current[category])
          resolutions[category] = resolution
          if (!resolution.destination) {
            unresolved.push(category)
            continue
          }
          destination = resolution.destination
        } else {
          destination = destinations[category] ?? defaultDestinationFor(displayTitle, writablePlaylists)
        }
        if (dimension.key !== 'artist' && destination.kind === 'new') {
          destination = defaultDestinationFor(destination.playlistName.trim(), writablePlaylists)
        }
        resolvedDestinations[category] = destination
        groups.push({
          dimension: dimension.key,
          dimensionLabel: dimension.label,
          category,
          displayTitle,
          songs: categorySongs,
          destination,
        })
      }
      setArtistResolutions(resolutions)
      setDestinations(resolvedDestinations)
      if (unresolved.length > 0) {
        throw new Error(`请先为「${unresolved.join('、')}」明确选择已有歌单或新建歌单，再重新计算计划。`)
      }
      appendLog('正在读取目标歌单，计算追加计划…')
      setPlanMessage('正在计算目标歌单中尚未包含的歌曲…')
      const built = await buildWritePlan({ groups, existingPlaylists: writablePlaylists })
      setPlans(built)
      appendLog(`生成 ${built.length} 条导入计划`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPlans([])
    } finally {
      setPlanMessage('')
      setBusy(false)
    }
  }, [songs, outcomes, settings.dimensions, activeDimension, profile, destinations, appendLog])

  const applyPlan = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await applyWritePlan(plans, {
        onCreated: (playlistName, playlistId) => {
          for (const [category, choice] of Object.entries(destinations)) {
            if (choice.kind === 'new' && choice.playlistName.trim() === playlistName) {
              manualDestinationsRef.current[category] = { kind: 'existing', playlistId }
            }
          }
          setDestinations((previous) => Object.fromEntries(
            Object.entries(previous).map(([category, choice]) => [
              category,
              choice.kind === 'new' && choice.playlistName.trim() === playlistName
                ? { kind: 'existing', playlistId } as DestinationChoice
                : choice,
            ]),
          ))
        },
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
      setError(`导入已停止：${err instanceof Error ? err.message : String(err)} 请重新计算计划后再试。`)
    } finally {
      setPlans([])
      setBusy(false)
    }
  }, [plans, connect, destinations])

  const updateSongCategory = useCallback(
    (songId: number, dimKey: Settings['dimensions'][number]['key'], category: string, previousCategory = '') => {
      if (dimKey === 'artist' && category && !activeDimension?.categories.includes(category)) return
      setOutcomes((prev) => {
        const next = new Map(prev)
        const entry = { ...(next.get(songId) ?? {}) }
        if (dimKey === 'artist') {
          entry.artist = { category: replaceArtistCategory(entry.artist?.category, previousCategory, category), source: 'manual' }
        } else if (category) {
          entry[dimKey] = { category, source: 'manual' }
        } else {
          delete entry[dimKey]
        }
        next.set(songId, entry)
        return next
      })
      setPlans([])
    },
    [activeDimension],
  )

  const mergeCategory = useCallback((source: string, target: string) => {
    if (!activeDimension || source === target || !activeDimension.categories.includes(source) || !activeDimension.categories.includes(target)) return
    const dimensionKey = activeDimension.key
    setOutcomes((previous) => {
      const next = new Map(previous)
      for (const [songId, outcome] of next) {
        if (categoriesOf(outcome[dimensionKey]?.category).includes(source)) {
          next.set(songId, {
            ...outcome,
            [dimensionKey]: {
              category: dimensionKey === 'artist'
                ? replaceArtistCategory(outcome.artist?.category, source, target)
                : target,
              source: 'manual',
            },
          })
        }
      }
      return next
    })
    setActiveDimension((previous) => {
      if (!previous || previous.key !== dimensionKey) return previous
      const categoryHints = { ...previous.categoryHints }
      const playlistNames = { ...previous.playlistNames }
      delete categoryHints[source]
      delete playlistNames[source]
      return {
        ...previous,
        categories: previous.categories.filter((category) => category !== source),
        categoryHints,
        playlistNames,
      }
    })
    setDestinations((previous) => {
      const next = { ...previous }
      if (!next[target] && next[source]) next[target] = next[source]
      delete next[source]
      return next
    })
    delete manualDestinationsRef.current[source]
    setArtistResolutions({})
    setPlans([])
  }, [activeDimension])

  const currentIndex = STEP_ORDER.indexOf(step)
  const canGo = useMemo(
    () => ({
      select: profile != null,
      configure: songs.length > 0,
      classify: songs.length > 0,
      preview: !busy && outcomes.size > 0,
    }),
    [profile, songs.length, outcomes.size, busy],
  )

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="row between">
          <div className="heading-copy">
            <span className="section-kicker">歌单整理工作台</span>
            <h1>{STEP_LABELS[step]}</h1>
          </div>
          <span className="step-counter">{currentIndex + 1} / {STEP_ORDER.length}</span>
        </div>
        <p className="sub">{STEP_HINTS[step]}</p>
      <nav className="steps" aria-label="整理步骤">
        {STEP_ORDER.map((s, i) => (
          <button
            type="button"
            key={s}
            className={`step-button ${s === step ? 'active' : i < currentIndex ? 'done' : ''}`}
            aria-current={s === step ? 'step' : undefined}
            disabled={busy || !(i <= currentIndex || canGo[s as keyof typeof canGo])}
            onClick={() => {
              if (!busy && (i <= currentIndex || canGo[s as keyof typeof canGo])) {
                setStep(s)
                if (s === 'preview') void buildPlan()
              }
            }}
          >
            <span className="step-number" aria-hidden="true">{i + 1}</span>
            <span className="step-label">{STEP_LABELS[s]}</span>
          </button>
        ))}
      </nav>
      </header>

      {error && <div className="err app-error" role="alert">{error}</div>}

      <main className="app-main" aria-busy={busy}>
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
          onSelect={(playlist) => {
            if (playlist.id !== selected?.id) {
              invalidateClassification()
              setSongs([])
              setSongMsg('')
            }
            setSelected(playlist)
          }}
          onLoadSongs={() => void loadSongs()}
          onNext={() => setStep('configure')}
        />
      )}

      {step === 'configure' && (
        <ConfigureStep
          settings={settings}
          onChange={updateSettings}
          onChangeAndSave={(next: Settings) => {
            updateSettings(next)
            void saveSettings(next)
          }}
          onNext={() => void startClassify()}
          onBack={() => setStep('select')}
          songCount={songs.length}
          regenerateGenreScheme={regenerateGenreScheme}
          onRegenerateGenreSchemeChange={setRegenerateGenreScheme}
        />
      )}

      {step === 'classify' && (
        <ClassifyStep
          progress={progress}
          busy={busy}
          log={log}
          total={songs.length}
          onStop={stopClassify}
          onRetry={() => void startClassify(true)}
          onNext={() => {
            setStep('preview')
            void buildPlan()
          }}
        />
      )}

      {step === 'preview' && (
        <PreviewStep
          songs={songs}
          outcomes={outcomes}
          settings={{
            ...settings,
            dimensions: settings.dimensions.map((dimension) =>
              activeDimension?.key === dimension.key
                ? activeDimension
                : { ...dimension, enabled: false },
            ),
          }}
          playlists={playlists.filter((playlist) => playlist.userId === profile?.userId)}
          destinations={destinations}
          artistResolutions={artistResolutions}
          scanWarnings={scanWarnings}
          planMessage={planMessage}
          plans={plans}
          busy={busy}
          applyLog={applyLog}
          onDestinationChange={(category, choice) => {
            manualDestinationsRef.current[category] = choice
            setDestinations((previous) => ({ ...previous, [category]: choice }))
            setArtistResolutions((previous) => ({
              ...previous,
              [category]: { destination: choice, reason: '已手动选择目标，重新计算时保留。', candidates: [], needsConfirmation: false },
            }))
            setPlans([])
          }}
          onSongCategoryChange={updateSongCategory}
          onMergeCategory={mergeCategory}
          onRebuildPlan={() => void buildPlan()}
          onApply={() => void applyPlan()}
          onBack={() => setStep('classify')}
        />
      )}
      </main>
    </div>
  )
}
