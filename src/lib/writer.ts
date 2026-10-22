/**
 * 安全、幂等地把分类结果追加到用户选择的目标歌单。
 *
 * 用户可为每个分类选择已有歌单或新建歌单；多个分类可以有意映射到同一目标，
 * 写入前会按目标合并歌曲并去重。已有歌单只追加，不移除其中任何歌曲。
 */

import type { DimensionKey, PlaylistBrief, Song } from '@/lib/types'
import {
  addTracksToPlaylist,
  createPlaylist,
  getPlaylistTrackIds,
  getUserPlaylists,
  TRACK_ADD_BATCH,
} from '@/lib/netease'
import { NcmRateLimitError, RATE_LIMIT_COOLDOWN_MS } from '@/lib/rpc'

export type DestinationChoice =
  | { kind: 'existing'; playlistId: number }
  | { kind: 'new'; playlistName: string }

export interface CategoryWriteGroup {
  dimension: DimensionKey
  dimensionLabel: string
  category: string
  /** 面向用户的建议歌单名（可与内部分类名不同） */
  displayTitle: string
  songs: Song[]
  destination: DestinationChoice
}

export interface CategoryPlan {
  destinationKey: string
  playlistName: string
  /** 新建时为空，已有歌单时为目标歌单 ID */
  existingPlaylistId?: number
  /** 合并到此目标的分类名称 */
  sourceCategories: string[]
  songIds: number[]
  toAdd: number[]
  action: 'create' | 'append' | 'none'
}

export function defaultDestinationFor(
  displayTitle: string,
  existingPlaylists: PlaylistBrief[],
): DestinationChoice {
  const matched = existingPlaylists.find(
    (playlist) => playlist.name === displayTitle && playlist.specialType !== 5,
  )
  return matched
    ? { kind: 'existing', playlistId: matched.id }
    : { kind: 'new', playlistName: displayTitle }
}

interface DestinationAggregate {
  key: string
  playlistName: string
  existingPlaylistId?: number
  sourceCategories: Set<string>
  songIds: Set<number>
}

/**
 * 只读地计算导入计划：已有目标只补缺失歌曲；新目标会在用户确认写入时创建。
 * 若多个类目映射到同一歌单，会先合并歌曲集合，再统一计算差集。
 */
export async function buildWritePlan(options: {
  groups: CategoryWriteGroup[]
  existingPlaylists: PlaylistBrief[]
}): Promise<CategoryPlan[]> {
  const playlistById = new Map(options.existingPlaylists.map((playlist) => [playlist.id, playlist]))
  const playlistByName = new Map(
    options.existingPlaylists.flatMap((playlist): Array<[string, PlaylistBrief]> =>
      playlist.specialType === 5 ? [] : [[playlist.name, playlist]],
    ),
  )
  const aggregateByKey = new Map<string, DestinationAggregate>()

  for (const group of options.groups) {
    if (group.songs.length === 0) continue

    let key: string
    let playlistName: string
    let existingPlaylistId: number | undefined

    if (group.destination.kind === 'existing') {
      const target = playlistById.get(group.destination.playlistId)
      if (!target) {
        throw new Error(`找不到所选目标歌单（id=${group.destination.playlistId}），请重新选择。`)
      }
      if (target.specialType === 5) {
        throw new Error('「我喜欢的音乐」不能作为分类导入目标，请选择其他歌单。')
      }
      key = `existing:${target.id}`
      playlistName = target.name
      existingPlaylistId = target.id
    } else {
      playlistName = group.destination.playlistName.trim()
      if (!playlistName) {
        throw new Error(`「${group.category}」的新歌单名称不能为空。`)
      }
      if (playlistByName.has(playlistName)) {
        throw new Error(`歌单「${playlistName}」已经存在，请改选该歌单或使用其他名称。`)
      }
      key = `new:${playlistName}`
    }

    let aggregate = aggregateByKey.get(key)
    if (!aggregate) {
      aggregate = {
        key,
        playlistName,
        existingPlaylistId,
        sourceCategories: new Set<string>(),
        songIds: new Set<number>(),
      }
      aggregateByKey.set(key, aggregate)
    }

    aggregate.sourceCategories.add(`${group.dimensionLabel} · ${group.category}`)
    for (const song of group.songs) aggregate.songIds.add(song.id)
  }

  const plans: CategoryPlan[] = []
  for (const aggregate of aggregateByKey.values()) {
    const songIds = [...aggregate.songIds]
    const currentIds = aggregate.existingPlaylistId
      ? new Set(await getPlaylistTrackIds(aggregate.existingPlaylistId))
      : new Set<number>()
    const toAdd = songIds.filter((id) => !currentIds.has(id))

    let action: CategoryPlan['action']
    if (aggregate.existingPlaylistId) {
      action = toAdd.length > 0 ? 'append' : 'none'
    } else {
      action = songIds.length > 0 ? 'create' : 'none'
    }

    plans.push({
      destinationKey: aggregate.key,
      playlistName: aggregate.playlistName,
      existingPlaylistId: aggregate.existingPlaylistId,
      sourceCategories: [...aggregate.sourceCategories],
      songIds,
      toAdd,
      action,
    })
  }

  return plans
}

export interface ApplyProgress {
  index: number
  total: number
  playlistName: string
  message: string
  retryInSeconds?: number
}

function checkStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已停止导入', 'AbortError')
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  checkStopped(signal)
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }
    const cancel = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      reject(new DOMException('已停止导入', 'AbortError'))
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

async function retryRateLimited<T>(
  operation: (attempt: number) => Promise<T>,
  notify: (message: string, retryInSeconds?: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    checkStopped(signal)
    try {
      return await operation(attempt)
    } catch (error) {
      if (!(error instanceof NcmRateLimitError)) throw error
      if (attempt >= 2) {
        throw new NcmRateLimitError('网易云仍在限制操作频率，本次已停止。请等待更长时间后重新计算计划，避免连续点击重试。', error.retryAfterMs, error.code)
      }
      const deadline = Date.now() + Math.max(error.retryAfterMs, RATE_LIMIT_COOLDOWN_MS * 2 ** attempt)
      while (Date.now() < deadline) {
        checkStopped(signal)
        const remaining = deadline - Date.now()
        const seconds = Math.ceil(remaining / 1000)
        notify(`网易云限制操作频率，等待 ${seconds} 秒后核对目标并重试（${attempt + 1}/2）`, seconds)
        await pause(Math.min(1000, remaining), signal)
      }
      notify('冷却结束，正在重新核对目标歌单…')
    }
  }
}

export async function applyWritePlan(
  plans: CategoryPlan[],
  hooks: {
    onProgress?: (progress: ApplyProgress) => void
    onCreated?: (playlistName: string, playlistId: number) => void
    signal?: AbortSignal
    userId?: number
  } = {},
): Promise<{ created: number; updated: number; songWrites: number }> {
  const effective = plans.filter((plan) => plan.action !== 'none')
  let created = 0
  let updated = 0
  let songWrites = 0

  for (let index = 0; index < effective.length; index++) {
    checkStopped(hooks.signal)
    const plan = effective[index]
    let playlistId = plan.existingPlaylistId
    const notify = (message: string, retryInSeconds?: number) => hooks.onProgress?.({
      index, total: effective.length, playlistName: plan.playlistName, message, retryInSeconds,
    })

    if (!playlistId) {
      const target = await retryRateLimited(async (attempt) => {
        if (attempt > 0) {
          if (!hooks.userId) throw new Error('缺少登录用户信息，无法核对已创建歌单。请重新检测登录并计算计划。')
          const current = await getUserPlaylists(hooks.userId)
          checkStopped(hooks.signal)
          const matches = current.filter((item) => item.userId === hooks.userId && item.specialType !== 5 && item.name === plan.playlistName)
          if (matches.length > 1) throw new Error(`存在多个「${plan.playlistName}」歌单，请重新计算计划并手动选择目标。`)
          if (matches.length === 1) {
            notify('已找到同名目标，复用该歌单并核对缺少的歌曲')
            return { id: matches[0].id, created: false }
          }
        }
        checkStopped(hooks.signal)
        notify(`新建歌单「${plan.playlistName}」（写入已减速）`)
        return { id: await createPlaylist(plan.playlistName), created: true }
      }, notify, hooks.signal)
      playlistId = target.id
      hooks.onCreated?.(plan.playlistName, playlistId)
      if (target.created) created++
      else updated++
    } else {
      updated++
    }

    // 重试和复用刚发现的目标均以完整来源集合计算差集，避免部分成功后重发。
    const currentIds = new Set(await retryRateLimited(() => getPlaylistTrackIds(playlistId!), notify, hooks.signal))
    const pending = [...new Set(plan.songIds)].filter((id) => !currentIds.has(id))
    for (let offset = 0; offset < pending.length; offset += TRACK_ADD_BATCH) {
      const batch = pending.slice(offset, offset + TRACK_ADD_BATCH)
      await retryRateLimited(async (attempt) => {
        const existing = attempt > 0 ? new Set(await getPlaylistTrackIds(playlistId!)) : currentIds
        checkStopped(hooks.signal)
        const missing = batch.filter((id) => !existing.has(id))
        if (missing.length === 0) return
        notify(`追加 ${missing.length} 首，第 ${Math.floor(offset / TRACK_ADD_BATCH) + 1}/${Math.ceil(pending.length / TRACK_ADD_BATCH)} 批（保留原有歌曲）`)
        await addTracksToPlaylist(playlistId!, missing)
        songWrites += missing.length
      }, notify, hooks.signal)
    }

    checkStopped(hooks.signal)
    notify('完成')
  }

  return { created, updated, songWrites }
}
