import { artistNames } from '@/lib/classifier/rules'
import { getPlaylistTrackIds, getSongDetails, LIKED_SPECIAL_TYPE } from '@/lib/netease'
import type { PlaylistBrief } from '@/lib/types'
import type { DestinationChoice } from '@/lib/writer'
import { NcmRateLimitError } from '@/lib/rpc'

export interface ArtistPlaylistEvidence {
  playlistId: number
  playlistName: string
  trackCount: number
  artists: string[]
  error?: string
}

/** 每轮重新读取完整歌单；一个歌曲详情失败只影响包含它的歌单。 */
export async function scanArtistPlaylists(
  playlists: PlaylistBrief[],
  userId: number,
  onProgress?: (message: string) => void,
): Promise<ArtistPlaylistEvidence[]> {
  const writable = playlists.filter((playlist) => playlist.userId === userId && playlist.specialType !== LIKED_SPECIAL_TYPE)
  const entries: Array<{ evidence: ArtistPlaylistEvidence; ids: number[] }> = []
  for (const [index, playlist] of writable.entries()) {
    onProgress?.(`读取歌单 ${index + 1}/${writable.length}：《${playlist.name}》`)
    const evidence: ArtistPlaylistEvidence = {
      playlistId: playlist.id, playlistName: playlist.name, trackCount: 0, artists: [],
    }
    let ids: number[] = []
    try {
      ids = await getPlaylistTrackIds(playlist.id)
      evidence.trackCount = ids.length
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        evidence.error = '歌单包含无效歌曲 ID，无法完整识别。'
      } else if (ids.length !== playlist.trackCount) {
        evidence.error = `歌单列表显示 ${playlist.trackCount} 首，实际读取 ${ids.length} 首，请刷新后重新配对。`
      }
    } catch (error) {
      if (error instanceof NcmRateLimitError) throw error
      evidence.error = `读取歌单失败：${error instanceof Error ? error.message : String(error)}`
    }
    entries.push({ evidence, ids })
  }

  const ids = [...new Set(entries.filter((entry) => !entry.evidence.error).flatMap((entry) => entry.ids))]
  const artistsById = new Map<number, string[]>()
  const errorsById = new Map<number, string>()
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100)
    try {
      const songs = await getSongDetails(batch)
      const requested = new Set(batch)
      for (const song of songs) {
        if (requested.has(song.id)) artistsById.set(song.id, artistNames(song))
      }
    } catch (error) {
      if (error instanceof NcmRateLimitError) throw error
      const message = error instanceof Error ? error.message : String(error)
      for (const id of batch) errorsById.set(id, `读取歌曲详情失败：${message}`)
    }
    onProgress?.(`识别歌单歌曲 ${Math.min(index + 100, ids.length)}/${ids.length}`)
  }

  for (const entry of entries) {
    if (entry.evidence.error || entry.ids.length === 0) continue
    let common: string[] | undefined
    for (const id of entry.ids) {
      const artists = artistsById.get(id)
      const error = errorsById.get(id) ?? (!artists ? `歌曲 ${id} 的详情缺失。` : artists.length === 0 ? `歌曲 ${id} 缺少有效歌手信息。` : undefined)
      if (error) {
        entry.evidence.error = error
        break
      }
      common = common === undefined ? artists! : common.filter((artist) => artists!.includes(artist))
    }
    if (!entry.evidence.error) entry.evidence.artists = common ?? []
  }
  return entries.map((entry) => entry.evidence)
}

export interface ArtistDestinationResolution {
  destination?: DestinationChoice
  reason: string
  candidates: ArtistPlaylistEvidence[]
  needsConfirmation: boolean
}

export function resolveArtistDestination(
  artist: string,
  displayTitle: string,
  playlists: PlaylistBrief[],
  evidence: ArtistPlaylistEvidence[],
  manual?: DestinationChoice,
): ArtistDestinationResolution {
  if (manual) return { destination: manual, reason: '保留手动选择的目标歌单。', candidates: [], needsConfirmation: false }
  const writable = playlists.filter((playlist) => playlist.specialType !== LIKED_SPECIAL_TYPE)
  const matchingNames = writable.filter((playlist) => playlist.name === displayTitle)
  const candidateFor = (playlist: PlaylistBrief): ArtistPlaylistEvidence => evidence.find((item) => item.playlistId === playlist.id) ?? {
    playlistId: playlist.id, playlistName: playlist.name, trackCount: playlist.trackCount, artists: [],
  }
  if (matchingNames.length > 1) {
    return { reason: '存在多个同名歌单，请手动选择目标。', candidates: matchingNames.map(candidateFor), needsConfirmation: true }
  }
  if (matchingNames.length === 1) {
    return {
      destination: { kind: 'existing', playlistId: matchingNames[0].id },
      reason: `复用同名歌单《${displayTitle}》。`, candidates: [candidateFor(matchingNames[0])], needsConfirmation: false,
    }
  }
  const allowedIds = new Set(writable.map((playlist) => playlist.id))
  const candidates = evidence.filter((item) => allowedIds.has(item.playlistId) && !item.error && item.trackCount > 0 && item.artists.includes(artist))
  if (candidates.length > 1) {
    return { reason: `多个歌单的每首歌曲均包含${artist}，请手动选择目标。`, candidates, needsConfirmation: true }
  }
  const matched = candidates[0]
  if (matched?.artists.length > 1) {
    return { reason: `歌单《${matched.playlistName}》同时符合多位歌手，请手动确认对应关系。`, candidates, needsConfirmation: true }
  }
  if (matched) {
    return {
      destination: { kind: 'existing', playlistId: matched.playlistId },
      reason: `歌单《${matched.playlistName}》共 ${matched.trackCount} 首，全部包含${artist}。`, candidates, needsConfirmation: false,
    }
  }
  return { destination: { kind: 'new', playlistName: displayTitle }, reason: '没有同名或符合内容规则的已有歌单，将新建歌单。', candidates: [], needsConfirmation: false }
}
