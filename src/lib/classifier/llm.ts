/**
 * LLM 分类层：负责情绪和曲风，并复核语种。
 *
 * 网易云没有可用的曲风/情绪标签接口（/api/song/tags 已实测 404），
 * 唯一拿得到的元数据是 歌名 / 歌手 / 专辑 / 发行时间，
 * 所以这两类判断只能交给模型，并且要接受"准确率有上限"这一事实。
 */

import type { Dimension, DimensionKey, PlaylistNameStyle, Song } from '@/lib/types'
import { decadeOf, guessLanguage, looksInstrumental } from './rules'

export interface ClassifyOutcome {
  category: string | string[]
  /** manual = 用户在预览界面手改过 */
  source: 'rules' | 'llm' | 'manual'
  reason?: string
}

export type SongOutcome = Partial<Record<DimensionKey, ClassifyOutcome>>

/** 判断一个维度是否值得交给 LLM（年代用规则就够，问了也是浪费） */
export function needsLlm(dim: Dimension): boolean {
  return dim.key !== 'era' && dim.key !== 'artist'
}

interface LlmResult {
  id: number
  [k: string]: unknown
}

/** 模型返回的 JSON 外层信封（运行时仍会校验 results 是否存在） */
export interface LlmEnvelope {
  results?: LlmResult[]
}

/** 送给模型的单首歌载荷 */
interface LlmSongPayload {
  id: number
  name: string
  artist: string
  album: string
  era?: string
  languageHint?: string
  note?: string
}

function stringifyDims(dims: Dimension[]): string {
  return dims
    .map((dimension) => {
      const choices = dimension.categories
        .map((category) => {
          const hint = dimension.categoryHints?.[category]
          return hint ? `${category}（${hint}）` : category
        })
        .join(' / ')
      return `- ${dimension.key}（${dimension.label}）只能取以下值之一：${choices}`
    })
    .join('\n')
}

function buildSystemPrompt(dims: Dimension[]): string {
  const exampleDimension = dims[0]
  const exampleCategory = exampleDimension?.categories[0]
  const example = exampleDimension && exampleCategory
    ? `{"results":[{"id":123,"${exampleDimension.key}":"${exampleCategory}"}]}`
    : '{"results":[{"id":123}]}'
  return [
    '你是资深音乐编辑，负责给歌曲归类。',
    '只依据歌名、歌手、专辑名和发行年份推断，不要臆造曲风。',
    '如果实在无法判断某个维度，该字段返回 null。',
    '每首歌对每个维度只选一个最符合的主类别，不要输出多个类别。',
    '',
    '归类规则：',
    stringifyDims(dims),
    '',
    '严格只输出 JSON，不要任何解释文字、不要 markdown 代码块。',
    `输出格式：每首歌包含 id 和本次启用的维度字段，字段值必须是上面列出的类目之一。例如：${example}。`,
  ].join('\n')
}

function buildUserPrompt(songs: Song[], dims: Dimension[]): string {
  const keys = dims.map((d) => d.key)
  const payload = songs.map((s) => {
    const item: LlmSongPayload = {
      id: s.id,
      name: s.name,
      artist: s.artists.join(' / '),
      album: s.album,
    }
    // 把规则层的可信结论作为提示喂进去，提高一致性和准确率
    if (keys.includes('era')) {
      const d = decadeOf(s.publishTime)
      if (d) item.era = d
    }
    if (keys.includes('language')) {
      const g = guessLanguage(s)
      if (g) item.languageHint = g
    }
    if (looksInstrumental(s)) item.note = '疑似纯音乐'
    return item
  })

  return [
    `请给下面 ${songs.length} 首歌分类，只返回 JSON。`,
    'era 字段已由系统给出，原样保留即可；languageHint 仅供参考，你可以推翻。',
    '',
    JSON.stringify(payload),
  ].join('\n')
}

/** 模型可能返回 ```json 包裹的内容，或前后带解释文字，这里做容错提取。 */
export function extractJson(text: string): LlmEnvelope {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : text).trim()
  try {
    return JSON.parse(candidate) as LlmEnvelope
  } catch {
    // 退一步：截取第一个 { 到最后一个 }
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as LlmEnvelope
    }
    throw new Error('模型返回的内容不是合法 JSON')
  }
}

function normalize(raw: unknown, dim: Dimension): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v) return null
  const lower = v.toLowerCase()
  const exact = dim.categories.find((category) => category.toLowerCase() === lower)
  if (exact) return exact
  // 宽松匹配时优先匹配最长类目，避免「电子」抢先匹配「电子舞曲」。
  const matches = dim.categories
    .filter((category) => lower.includes(category.toLowerCase()))
    .sort((left, right) => right.length - left.length)
  return matches[0] ?? null
}

export interface ClassifyChunkOptions {
  baseUrl: string
  apiKey: string
  model: string
  dims: Dimension[]
  signal?: AbortSignal
}

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

async function requestChatCompletion(
  options: { baseUrl: string; apiKey: string; model: string; signal?: AbortSignal },
  messages: ChatMessage[],
  temperature = 0.2,
): Promise<string> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({ model: options.model, temperature, messages }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`模型接口返回 ${response.status}：${detail.slice(0, 200) || response.statusText}`)
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error('模型没有返回内容')
  return content
}

async function callChat(
  opts: ClassifyChunkOptions,
  songs: Song[],
): Promise<LlmResult[]> {
  const content = await requestChatCompletion(
    opts,
    [
      { role: 'system', content: buildSystemPrompt(opts.dims) },
      { role: 'user', content: buildUserPrompt(songs, opts.dims) },
    ],
  )
  const parsed = extractJson(content)
  const results = parsed.results
  if (!Array.isArray(results)) throw new Error('模型返回的 JSON 缺少 results 数组')
  return results
}

export interface GenreCategorySuggestion {
  name: string
  description: string
}

/** 均匀抽样覆盖歌单首尾，避免为生成类别把整张大歌单塞进一个请求。 */
export function sampleGenreSongs(songs: Song[], limit = 120): Song[] {
  if (songs.length <= limit) return songs
  if (limit <= 1) return [songs[0]]
  const sample: Song[] = []
  for (let index = 0; index < limit; index++) {
    const sourceIndex = Math.round((index * (songs.length - 1)) / (limit - 1))
    sample.push(songs[sourceIndex])
  }
  return sample
}

/** 根据当前来源歌单的均匀样本生成稳定的曲风类别定义。 */
export async function discoverGenreDimension(options: {
  baseUrl: string
  apiKey: string
  model: string
  maxCategories: number
  songs: Song[]
  signal?: AbortSignal
}): Promise<Dimension> {
  if (options.songs.length === 0) throw new Error('来源歌单没有歌曲，无法生成曲风分类。')
  if (!options.apiKey.trim()) throw new Error('请先填写模型 API Key，再生成曲风分类。')

  const sample = sampleGenreSongs(options.songs)
  const system = [
    '你是音乐策展人。根据给定歌单的代表性歌曲样本，为整张歌单设计不超过指定数量的主曲风分类。',
    '分类要依据音乐风格本身，不要按语种、年代、情绪、是否有人声或编曲形式单独分组。',
    '类别应尽量互斥、边界清楚并覆盖主要曲风；不要为凑数制造小类。若歌曲整体风格集中，可以少于上限。',
    '不要创建“其他 / 杂项 / 不确定”兜底类别；无法归入时，后续分类允许返回 null。',
    '类别名称简短直白且不超过 12 字，description 说明主要纳入与排除范围。只设计分类，不生成歌单名。',
    '只依据歌名、歌手和专辑信息推断；样本不足以支持的风格不要臆造。',
    '严格只输出 JSON，不要 Markdown 或其他解释。',
    '格式：{"categories":[{"name":"曲风类别","description":"分类边界"}]}',
  ].join('\n')
  const user = [
    `来源歌单共 ${options.songs.length} 首。本次最多生成 ${options.maxCategories} 类。`,
    `以下 ${sample.length} 首为从整张歌单均匀抽取的代表样本：`,
    JSON.stringify(sample.map((song) => ({
      name: song.name,
      artists: song.artists,
      album: song.album,
    }))),
  ].join('\n\n')

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await requestChatCompletion(
        options,
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        0.2,
      )
      const parsed = extractJson(content) as { categories?: unknown }
      if (!Array.isArray(parsed.categories)) throw new Error('模型生成的曲风方案缺少 categories 数组。')
      if (parsed.categories.length < 1 || parsed.categories.length > options.maxCategories) {
        throw new Error(`模型生成了 ${parsed.categories.length} 类，超出 1–${options.maxCategories} 类范围。`)
      }

      const categories: GenreCategorySuggestion[] = []
      const seen = new Set<string>()
      for (const raw of parsed.categories) {
        if (!raw || typeof raw !== 'object') throw new Error('曲风类别格式无效。')
        const item = raw as Record<string, unknown>
        const name = typeof item.name === 'string' ? item.name.trim() : ''
        const description = typeof item.description === 'string' ? item.description.trim() : ''
        if (!name || !description) {
          throw new Error('每个曲风类别都必须提供名称和分类说明。')
        }
        if (Array.from(name).length > 12 || description.length > 240) {
          throw new Error('模型生成的类别名称或说明过长，请重新生成。')
        }
        const key = name.toLocaleLowerCase()
        if (seen.has(key)) throw new Error(`模型生成了重复的类别「${name}」。`)
        seen.add(key)
        categories.push({ name, description })
      }

      return {
        key: 'genre',
        label: '曲风',
        enabled: true,
        categories: categories.map((category) => category.name),
        categoryHints: Object.fromEntries(categories.map((category) => [category.name, category.description])),
      }
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const PLAYLIST_NAME_STYLE_GUIDANCE: Record<Exclude<PlaylistNameStyle, 'custom'>, string> = {
  concise: '名称直接、清楚地概括类目，少用修饰词和意象。',
  'japanese-literary': '含蓄、克制，带有日式文学作品常见的季节、天气、街道或日常意象，不要模仿具体作家。',
  'retro-record': '带复古唱片、旧时光、磁带或模拟质感，避免堆砌年代标签。',
  cinematic: '像电影片名或场景标题，富有画面感与氛围，但保持简短。',
}

/** 仅根据类目生成名称建议，不修改类目及分类边界。 */
export async function generatePlaylistNameSuggestions(options: {
  baseUrl: string
  apiKey: string
  model: string
  dimension: Dimension
  style: PlaylistNameStyle
  customStyle: string
  signal?: AbortSignal
}): Promise<Record<string, string>> {
  const categories = options.dimension.categories
  if (categories.length === 0) return {}
  if (options.dimension.key === 'artist') {
    return Object.fromEntries(categories.map((category) => [category, category]))
  }
  if (options.style === 'concise' && categories.every((category) => Array.from(category).length <= 12)) {
    return Object.fromEntries(categories.map((category) => [category, category]))
  }
  if (!options.apiKey.trim()) throw new Error('请先填写模型 API Key，再生成歌单名建议。')
  if (options.style === 'custom' && !options.customStyle.trim()) {
    throw new Error('请填写自定义歌单命名风格，或选择一个预设风格。')
  }

  const styleGuidance = options.style === 'custom'
    ? `严格遵循用户提供的风格描述：${options.customStyle.trim()}`
    : PLAYLIST_NAME_STYLE_GUIDANCE[options.style]
  const system = [
    '你是歌单命名编辑，只负责为给定分类生成歌单名称，不得改写或合并分类。',
    styleGuidance,
    '每个名称不超过 12 个汉字/字符，简短、易读、彼此不同。',
    '不要输出序号、引号、曲风解释或其他文字，只输出 JSON。',
    '格式：{"names":[{"category":"原类目名","title":"歌单名"}]}',
  ].join('\n')
  const user = JSON.stringify(categories.map((category) => ({
    category,
    boundary: options.dimension.categoryHints?.[category] ?? '',
  })))

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await requestChatCompletion(
        options,
        [{ role: 'system', content: system }, { role: 'user', content: user }],
        0.5,
      )
      const parsed = extractJson(content) as { names?: unknown }
      if (!Array.isArray(parsed.names)) throw new Error('模型生成的歌单名缺少 names 数组。')
      const result: Record<string, string> = {}
      const usedTitles = new Set<string>()
      for (const raw of parsed.names) {
        if (!raw || typeof raw !== 'object') throw new Error('歌单名建议格式无效。')
        const item = raw as Record<string, unknown>
        const category = typeof item.category === 'string' ? item.category.trim() : ''
        const title = typeof item.title === 'string' ? item.title.trim() : ''
        if (!categories.includes(category) || !title || Array.from(title).length > 12) {
          throw new Error('模型生成了无效类目或超过 12 字的歌单名，请重试。')
        }
        if (result[category]) throw new Error(`模型重复生成了类目「${category}」的歌单名。`)
        const titleKey = title.toLocaleLowerCase()
        if (usedTitles.has(titleKey)) throw new Error('模型生成了重复歌单名，请重试。')
        result[category] = title
        usedTitles.add(titleKey)
      }
      if (categories.some((category) => !result[category])) {
        throw new Error('模型没有为每个类目生成歌单名。')
      }
      return result
    } catch (error) {
      if (options.signal?.aborted) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 带重试的单批分类 */
export async function classifyChunk(
  opts: ClassifyChunkOptions,
  songs: Song[],
  attempts = 2,
): Promise<Map<number, SongOutcome>> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const results = await callChat(opts, songs)
      const byId = new Map(songs.map((s) => [s.id, s]))
      const out = new Map<number, SongOutcome>()

      for (const r of results) {
        const song = byId.get(Number(r.id))
        if (!song) continue
        const outcome: SongOutcome = {}
        for (const dim of opts.dims) {
          if (!needsLlm(dim)) continue
          const value = normalize(r[dim.key], dim)
          if (value) outcome[dim.key] = { category: value, source: 'llm' }
        }
        out.set(song.id, outcome)
      }
      return out
    } catch (err) {
      if (opts.signal?.aborted) throw err
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
