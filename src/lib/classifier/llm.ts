/**
 * LLM 分类层：负责情绪和曲风，并复核语种。
 *
 * 网易云没有可用的曲风/情绪标签接口（/api/song/tags 已实测 404），
 * 唯一拿得到的元数据是 歌名 / 歌手 / 专辑 / 发行时间，
 * 所以这两类判断只能交给模型，并且要接受"准确率有上限"这一事实。
 */

import type { Dimension, DimensionKey, Song } from '@/lib/types'
import { decadeOf, guessLanguage, looksInstrumental } from './rules'

export interface ClassifyOutcome {
  category: string
  /** manual = 用户在预览界面手改过 */
  source: 'rules' | 'llm' | 'manual'
  reason?: string
}

export type SongOutcome = Partial<Record<DimensionKey, ClassifyOutcome>>

/** 判断一个维度是否值得交给 LLM（年代用规则就够，问了也是浪费） */
export function needsLlm(dim: Dimension): boolean {
  return dim.key !== 'era'
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
  return [
    '你是资深音乐编辑，负责给歌曲归类。',
    '只依据歌名、歌手、专辑名和发行年份推断，不要臆造曲风。',
    '如果实在无法判断某个维度，该字段返回 null。',
    '',
    '归类规则：',
    stringifyDims(dims),
    '',
    '严格只输出 JSON，不要任何解释文字、不要 markdown 代码块。',
    '输出格式：每首歌包含 id 和本次启用的维度字段，字段值必须是上面列出的类目之一。例如：{"results":[{"id":123,"genre":"流行与节奏"}]}。',
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
  for (const c of dim.categories) {
    if (c.toLowerCase() === lower) return c
  }
  // 宽松匹配：模型有时会写成「流行 Pop」这类
  for (const c of dim.categories) {
    if (lower.includes(c.toLowerCase())) return c
  }
  return null
}

export interface ClassifyChunkOptions {
  baseUrl: string
  apiKey: string
  model: string
  dims: Dimension[]
  signal?: AbortSignal
}

async function callChat(
  opts: ClassifyChunkOptions,
  songs: Song[],
): Promise<LlmResult[]> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: buildSystemPrompt(opts.dims) },
        { role: 'user', content: buildUserPrompt(songs, opts.dims) },
      ],
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(
      `模型接口返回 ${res.status}：${detail.slice(0, 200) || res.statusText}`,
    )
  }

  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error('模型没有返回内容')

  const parsed = extractJson(content)
  const results = parsed.results
  if (!Array.isArray(results)) throw new Error('模型返回的 JSON 缺少 results 数组')
  return results
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
