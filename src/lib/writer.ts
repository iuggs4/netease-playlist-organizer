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
} from '@/lib/netease'

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
}

export async function applyWritePlan(
  plans: CategoryPlan[],
  hooks: { onProgress?: (progress: ApplyProgress) => void; signal?: AbortSignal } = {},
): Promise<{ created: number; updated: number; songWrites: number }> {
  const effective = plans.filter((plan) => plan.action !== 'none')
  let created = 0
  let updated = 0
  let songWrites = 0

  for (let index = 0; index < effective.length; index++) {
    if (hooks.signal?.aborted) break
    const plan = effective[index]
    let playlistId = plan.existingPlaylistId

    if (!playlistId) {
      hooks.onProgress?.({
        index,
        total: effective.length,
        playlistName: plan.playlistName,
        message: `新建歌单「${plan.playlistName}」`,
      })
      playlistId = await createPlaylist(plan.playlistName)
      created++
    } else {
      updated++
    }

    if (plan.toAdd.length > 0) {
      hooks.onProgress?.({
        index,
        total: effective.length,
        playlistName: plan.playlistName,
        message: `追加 ${plan.toAdd.length} 首（保留歌单原有歌曲）`,
      })
      await addTracksToPlaylist(playlistId, plan.toAdd)
      songWrites += plan.toAdd.length
    }

    hooks.onProgress?.({
      index: index + 1,
      total: effective.length,
      playlistName: plan.playlistName,
      message: '完成',
    })
  }

  return { created, updated, songWrites }
}
