/**
 * 分类编排：缓存复用 → 规则层直出 → LLM 分批 → 回写缓存。
 */

import type { Dimension, DimensionKey, Song } from '@/lib/types'
import type { Settings, CachedClass } from '@/lib/store'
import { cacheKeyFor, loadCache, mergeCache } from '@/lib/store'
import { decadeOf } from './rules'
import { classifyChunk, needsLlm, type SongOutcome } from './llm'

export interface ClassifyProgress {
  done: number
  total: number
  cached: number
  failed: number
  message?: string
}

export interface ClassifyResult {
  outcomes: Map<number, SongOutcome>
  failedBatches: number
}

type CacheShape = Record<string, CachedClass>

/** 把缓存里的维度结果恢复成 SongOutcome */
function fromCache(cached: CachedClass): SongOutcome {
  const out: SongOutcome = {}
  for (const [key, value] of Object.entries(cached)) {
    if (value) {
      out[key as DimensionKey] = {
        category: value.category,
        source: value.source as 'rules' | 'llm' | 'manual',
      }
    }
  }
  return out
}

function toCache(entry: SongOutcome): CachedClass {
  const out: CachedClass = {}
  for (const [key, value] of Object.entries(entry)) {
    if (value) out[key as DimensionKey] = { category: value.category, source: value.source }
  }
  return out
}

/** 并发执行一个任务列表，保持结果顺序无关但限制同时在跑的数量 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const size = Math.max(1, Math.min(concurrency, items.length))
  const runners: Array<Promise<void>> = []

  for (let workerIndex = 0; workerIndex < size; workerIndex++) {
    runners.push(
      (async () => {
        while (cursor < items.length) {
          const index = cursor++
          await worker(items[index], index)
        }
      })(),
    )
  }

  await Promise.all(runners)
}

export async function classifySongs(
  songs: Song[],
  settings: Settings,
  hooks: {
    onProgress?: (p: ClassifyProgress) => void
    signal?: AbortSignal
  } = {},
): Promise<ClassifyResult> {
  const { onProgress, signal } = hooks
  // 只处理启用中的维度
  const dims = settings.dimensions.filter((d) => d.enabled)
  const outcomes = new Map<number, SongOutcome>()
  const cache = await loadCache()
  const cachePatch: CacheShape = {}

  let cached = 0
  const pending: Song[] = []

  for (const song of songs) {
    const cacheKey = cacheKeyFor(settings.baseUrl, settings.model, song.id, dims)
    const hit = cache[cacheKey]
    const merged: SongOutcome = hit ? fromCache(hit) : {}

    // 年代永远由规则直出，既准又零成本，不缓存也不问模型
    if (dims.some((d) => d.key === 'era')) {
      const decade = decadeOf(song.publishTime)
      if (decade) merged.era = { category: decade, source: 'rules' }
    }

    outcomes.set(song.id, merged)

    const llmDims = dims.filter(needsLlm)
    const missing = llmDims.some((d) => !merged[d.key])
    if (!missing) {
      cached++
      continue
    }
    pending.push(song)
  }

  const total = songs.length
  let done = cached
  let failed = 0
  onProgress?.({ done, total, cached, failed, message: `命中缓存 ${cached} 首` })

  if (pending.length > 0) {
    const llmDims = dims.filter(needsLlm)
    if (llmDims.length > 0 && !settings.apiKey.trim()) {
      throw new Error('尚未填写模型 API Key，无法分类情绪/曲风。请到「设置」填写后再开始。')
    }

    const batches: Song[][] = []
    for (let i = 0; i < pending.length; i += settings.batchSize) {
      batches.push(pending.slice(i, i + settings.batchSize))
    }

    onProgress?.({
      done,
      total,
      cached,
      failed,
      message: `需分类 ${pending.length} 首，共 ${batches.length} 批`,
    })

    await runPool(batches, settings.concurrency, async (batch) => {
      if (signal?.aborted) return
      try {
        const result = await classifyChunk(
          {
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            dims: llmDims,
            signal,
          },
          batch,
        )
        for (const [songId, entry] of result) {
          const existing = outcomes.get(songId) ?? {}
          outcomes.set(songId, { ...existing, ...entry })
        }
      } catch {
        failed += batch.length
      } finally {
        done += batch.length
        onProgress?.({ done, total, cached, failed })
      }
    })

    // 只把模型确实给出答案的部分写回缓存，未分类的留给下次重试
    for (const song of pending) {
      const entry = outcomes.get(song.id)
      if (entry && Object.keys(entry).length > 0) {
        cachePatch[cacheKeyFor(settings.baseUrl, settings.model, song.id, dims)] = toCache(entry)
      }
    }
    if (Object.keys(cachePatch).length > 0) {
      await mergeCache(cachePatch)
    }
  }

  onProgress?.({
    done: total,
    total,
    cached,
    failed,
    message: failed > 0 ? `完成，其中 ${failed} 首未得到结果` : '分类完成',
  })

  return { outcomes, failedBatches: failed }
}

/** 按维度把歌曲分组，供预览和写歌单使用 */
export function groupByDimension(
  songs: Song[],
  outcomes: Map<number, SongOutcome>,
  dimension: Dimension,
): Map<string, Song[]> {
  const groups = new Map<string, Song[]>()
  for (const category of dimension.categories) groups.set(category, [])

  for (const song of songs) {
    const entry = outcomes.get(song.id)?.[dimension.key]
    if (!entry) continue
    const bucket = groups.get(entry.category)
    if (bucket) bucket.push(song)
  }
  return groups
}
