/** 设置项与分类缓存的本地持久化。 */

import type { Dimension, DimensionKey } from '@/lib/types'

const SETTINGS_KEY = 'settings:v1'
const CACHE_KEY = 'classify-cache:v1'

export interface Settings {
  /** OpenAI 兼容接口，例如 https://api.deepseek.com/v1 */
  baseUrl: string
  apiKey: string
  model: string
  dimensions: Dimension[]
  /** 每批送给模型的歌曲数 */
  batchSize: number
  /** 并发请求数 */
  concurrency: number
  /** 写入前是否需要二次确认 */
  dryRun: boolean
}

export const DEFAULT_DIMENSIONS: Dimension[] = [
  {
    key: 'mood',
    label: '情绪',
    enabled: false,
    categories: ['治愈', '伤感', '热血', '放松', '深夜', '通勤', '运动', '欢快'],
  },
  {
    key: 'genre',
    label: '曲风',
    enabled: true,
    categories: ['流行与节奏', '摇滚与原声', '电子与器乐'],
    categoryHints: {
      '流行与节奏': '流行、R&B、Soul、说唱、舞曲等以节奏和主流歌曲表达为主的作品',
      '摇滚与原声': '摇滚、独立、朋克、金属、民谣、乡村及原声演奏等',
      '电子与器乐': '电子、EDM、氛围、古典、爵士、纯器乐及影视/游戏配乐等',
    },
    playlistNames: {
      '流行与节奏': '暮色中的唱片',
      '摇滚与原声': '潮声与旧弦',
      '电子与器乐': '无人的月台',
    },
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

const LEGACY_DEFAULT_GENRE_CATEGORIES = [
  '流行', '摇滚', '民谣', '电子', '说唱', '国风', 'ACG', 'R&B', '爵士', '古典', '纯音乐',
]

function normalizeDimensions(savedDimensions?: Dimension[]): Dimension[] {
  const merged = DEFAULT_DIMENSIONS.map((fallback) => {
    const saved = savedDimensions?.find((d) => d.key === fallback.key)
    if (!saved) return { ...fallback }

    const isUncustomizedLegacyGenre =
      saved.key === 'genre' &&
      saved.categories.length === LEGACY_DEFAULT_GENRE_CATEGORIES.length &&
      saved.categories.every((category, index) => category === LEGACY_DEFAULT_GENRE_CATEGORIES[index])

    return {
      ...fallback,
      ...saved,
      categories: isUncustomizedLegacyGenre ? fallback.categories : saved.categories,
      playlistNames: { ...fallback.playlistNames, ...saved.playlistNames },
    }
  })

  // 旧版本保存过多个 enabled=true。优先默认曲风，其次沿用第一个已启用维度。
  const selectedKey =
    (merged.find((d) => d.key === 'genre' && d.enabled)?.key ??
      merged.find((d) => d.enabled)?.key ??
      'genre') as Dimension['key']

  return merged.map((dimension) => ({
    ...dimension,
    enabled: dimension.key === selectedKey,
  }))
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  dimensions: DEFAULT_DIMENSIONS,
  batchSize: 20,
  concurrency: 3,
  dryRun: true,
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY)
  const saved = got[SETTINGS_KEY] as Partial<Settings> | undefined
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    dimensions: normalizeDimensions(saved?.dimensions),
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s })
}

/** 单首歌的分类结果（按维度存） */
export type CachedClass = Partial<Record<DimensionKey, { category: string; source: string }>>
type CacheShape = Record<string, CachedClass>

/** 缓存 key 含模型名 —— 换模型后必须重新分类，不能复用旧结果。 */
export function cacheKeyFor(model: string, songId: number): string {
  return `${model}|${songId}`
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
  return Object.keys(await loadCache()).length
}
