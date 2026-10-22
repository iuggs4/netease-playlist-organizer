/** 设置项与分类缓存的本地持久化。 */

import type { Dimension, DimensionKey, PlaylistNameStyle } from '@/lib/types'

const SETTINGS_KEY = 'settings:v1'
const CACHE_KEY = 'classify-cache:v1'
const PLAYLIST_NAME_CACHE_KEY = 'playlist-name-cache:v1'

export interface Settings {
  /** OpenAI 兼容接口，例如 https://api.deepseek.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
  dimensions: Dimension[]
  /** 曲风动态分类的最大类目数 */
  maxGenreCategories: number
  /** 来源歌单中歌手至少拥有的不同歌曲数（包含边界） */
  minArtistSongs: number
  playlistNameStyle: PlaylistNameStyle
  customPlaylistNameStyle: string
  /** 每批送给模型的歌曲数 */
  batchSize: number
  /** 并发请求数 */
  concurrency: number
  /** 写入前是否需要二次确认 */
  dryRun: boolean
}

export const DEFAULT_DIMENSIONS: Dimension[] = [
  {
    key: 'artist',
    label: '歌手',
    enabled: true,
    categories: [],
  },
  {
    key: 'mood',
    label: '情绪',
    enabled: false,
    categories: ['治愈', '伤感', '热血', '放松', '深夜', '通勤', '运动', '欢快'],
  },
  {
    key: 'genre',
    label: '曲风',
    enabled: false,
    categories: [],
  },
  {
    key: 'language',
    label: '语种',
    enabled: false,
    categories: ['华语', '欧美', '日系', '韩流'],
  },
  {
    key: 'era',
    label: '年代',
    enabled: false,
    categories: ['60年代及更早', '70年代', '80年代', '90年代', '00年代', '10年代', '20年代'],
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export function normalizeDimensions(savedDimensions?: unknown): Dimension[] {
  const savedList = Array.isArray(savedDimensions) ? savedDimensions.filter(isRecord) : []
  const merged = DEFAULT_DIMENSIONS.map((fallback) => {
    const saved = savedList.find((dimension) => dimension.key === fallback.key)
    if (!saved) return { ...fallback, categories: [...fallback.categories] }

    if (fallback.key === 'genre' || fallback.key === 'artist') {
      // 动态类别必须由当前来源歌单重新生成。
      return { ...fallback, categories: [], categoryHints: undefined, playlistNames: undefined }
    }

    return {
      ...fallback,
      categories: Array.isArray(saved.categories) && saved.categories.every((category): category is string => typeof category === 'string')
        ? [...saved.categories]
        : [...fallback.categories],
      categoryHints: { ...fallback.categoryHints, ...stringRecord(saved.categoryHints) },
      playlistNames: { ...fallback.playlistNames, ...stringRecord(saved.playlistNames) },
    }
  })

  // 先保留旧用户的选择，避免新增默认维度覆盖已保存的设置。
  const savedEnabled = savedList.filter((dimension) => dimension.enabled === true && merged.some((item) => item.key === dimension.key))
  const selectedKey =
    savedEnabled.find((dimension) => dimension.key === 'genre')?.key ?? savedEnabled[0]?.key ?? 'artist'

  return merged.map((dimension) => ({
    ...dimension,
    enabled: dimension.key === selectedKey,
  }))
}

const PLAYLIST_NAME_STYLES: PlaylistNameStyle[] = [
  'japanese-literary', 'concise', 'retro-record', 'cinematic', 'custom',
]

function isPlaylistNameStyle(value: unknown): value is PlaylistNameStyle {
  return typeof value === 'string' && PLAYLIST_NAME_STYLES.includes(value as PlaylistNameStyle)
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  dimensions: DEFAULT_DIMENSIONS,
  maxGenreCategories: 3,
  minArtistSongs: 10,
  playlistNameStyle: 'concise',
  customPlaylistNameStyle: '',
  batchSize: 20,
  concurrency: 3,
  dryRun: true,
}

export function normalizeMinArtistSongs(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_SETTINGS.minArtistSongs
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY)
  const stored = isRecord(got) ? got[SETTINGS_KEY] : undefined
  const saved = isRecord(stored) ? stored : {}
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    minArtistSongs: normalizeMinArtistSongs(saved?.minArtistSongs),
    maxGenreCategories: Math.min(
      8,
      Math.max(2, Math.round(Number(saved?.maxGenreCategories) || DEFAULT_SETTINGS.maxGenreCategories)),
    ),
    playlistNameStyle: isPlaylistNameStyle(saved?.playlistNameStyle)
      ? saved.playlistNameStyle
      : DEFAULT_SETTINGS.playlistNameStyle,
    customPlaylistNameStyle: String(saved?.customPlaylistNameStyle ?? '').slice(0, 120),
    dimensions: normalizeDimensions(saved?.dimensions),
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s })
}

/** 单首歌的分类结果（按维度存） */
export type CachedClass = Partial<Record<DimensionKey, { category: string | string[]; source: string }>>
type CacheShape = Record<string, CachedClass>

/** 缓存按模型、接口地址和分类定义隔离，修改提示或类别后不会误用旧结果。 */
export function cacheKeyFor(
  baseUrl: string,
  model: string,
  songId: number,
  dimensions: Dimension[],
): string {
  const schema = JSON.stringify(
    dimensions.map((dimension) => ({
      key: dimension.key,
      categories: dimension.categories,
      categoryHints: dimension.categoryHints ?? {},
    })),
  )
  const input = `classifier-v2|${baseUrl}|${model}|${schema}`
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `v2|${(hash >>> 0).toString(16)}|${songId}`
}

export async function loadCache(): Promise<CacheShape> {
  const got = await chrome.storage.local.get(CACHE_KEY)
  return (got[CACHE_KEY] as CacheShape | undefined) ?? {}
}

export async function mergeCache(patch: CacheShape): Promise<void> {
  const current = await loadCache()
  await chrome.storage.local.set({ [CACHE_KEY]: { ...current, ...patch } })
}

export async function clearCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY)
}

export async function cacheSize(): Promise<number> {
  return Object.keys(await loadCache()).filter((key) => key.startsWith('v2|')).length
}

const GENRE_SCHEMES_KEY = 'genre-schemes:v1'
type GenreSchemes = Record<string, { model: string; maxCategories: number; dimension: Dimension }>

function genreSchemeKey(playlistId: number, model: string, maxCategories: number): string {
  return `${playlistId}|${model}|${maxCategories}`
}

export function playlistNameCacheKeyFor(
  baseUrl: string,
  model: string,
  dimension: Dimension,
  style: PlaylistNameStyle,
  customStyle: string,
): string {
  const input = JSON.stringify({
    version: 'playlist-name-v1',
    baseUrl,
    model,
    key: dimension.key,
    categories: dimension.categories,
    categoryHints: dimension.categoryHints ?? {},
    style,
    customStyle: style === 'custom' ? customStyle.trim() : '',
  })
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

export async function loadPlaylistNameSuggestions(
  baseUrl: string,
  model: string,
  dimension: Dimension,
  style: PlaylistNameStyle,
  customStyle: string,
): Promise<Record<string, string> | null> {
  const stored = await chrome.storage.local.get(PLAYLIST_NAME_CACHE_KEY)
  const cache = (stored[PLAYLIST_NAME_CACHE_KEY] as Record<string, Record<string, string>> | undefined) ?? {}
  const names = cache[playlistNameCacheKeyFor(baseUrl, model, dimension, style, customStyle)]
  if (!names || dimension.categories.some((category) => !names[category])) return null
  return names
}

export async function savePlaylistNameSuggestions(
  baseUrl: string,
  model: string,
  dimension: Dimension,
  style: PlaylistNameStyle,
  customStyle: string,
  names: Record<string, string>,
): Promise<void> {
  const stored = await chrome.storage.local.get(PLAYLIST_NAME_CACHE_KEY)
  const cache = (stored[PLAYLIST_NAME_CACHE_KEY] as Record<string, Record<string, string>> | undefined) ?? {}
  const key = playlistNameCacheKeyFor(baseUrl, model, dimension, style, customStyle)
  await chrome.storage.local.set({ [PLAYLIST_NAME_CACHE_KEY]: { ...cache, [key]: names } })
}

export async function loadGenreScheme(
  playlistId: number,
  model: string,
  maxCategories: number,
): Promise<Dimension | null> {
  const stored = await chrome.storage.local.get(GENRE_SCHEMES_KEY)
  const schemes = (stored[GENRE_SCHEMES_KEY] as GenreSchemes | undefined) ?? {}
  const entry = schemes[genreSchemeKey(playlistId, model, maxCategories)]
  if (!entry || entry.dimension.categories.length === 0) return null
  if (entry.dimension.categories.length > maxCategories) return null
  return entry.dimension
}

export async function saveGenreScheme(
  playlistId: number,
  model: string,
  maxCategories: number,
  dimension: Dimension,
): Promise<void> {
  const stored = await chrome.storage.local.get(GENRE_SCHEMES_KEY)
  const schemes = (stored[GENRE_SCHEMES_KEY] as GenreSchemes | undefined) ?? {}
  const key = genreSchemeKey(playlistId, model, maxCategories)
  await chrome.storage.local.set({
    [GENRE_SCHEMES_KEY]: {
      ...schemes,
      [key]: { model, maxCategories, dimension },
    },
  })
}
