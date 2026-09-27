/**
 * panel 侧的网易云领域 API。
 *
 * 所有请求都通过 content script 走同源代理，这里只负责
 * 「找到承载请求的标签页」+「把响应解析成领域模型」。
 */

import type {
  NeteaseProfile,
  PlaylistBrief,
  Song,
} from '@/lib/types'
import type { NcmRequest, NcmRequestMessage, NcmResponse } from '@/lib/rpc'
import { NCM_AUTH_ERROR_CODES, NcmError } from '@/lib/rpc'

const MUSIC_ORIGIN = 'https://music.163.com'

/** 单次批量取歌曲详情的数量。实测 100 稳定，取 200 会被截断。 */
const SONG_DETAIL_BATCH = 100
/** 每次往歌单加歌的数量上限 */
export const TRACK_ADD_BATCH = 100

let seq = 0

/** 找到一个已打开的 music.163.com 标签页。没有的话明确报错引导用户打开。 */
export async function findMusicTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: `${MUSIC_ORIGIN}/*` })
  const usable = tabs.find((t) => t.id != null)
  if (!usable?.id) {
    throw new NcmError(
      '没有找到已打开的网易云音乐标签页。请先打开 https://music.163.com 并保持登录，再回到本页面。',
    )
  }
  return usable.id
}

async function callNcm(req: NcmRequest): Promise<unknown> {
  const tabId = await findMusicTabId()
  const msg: NcmRequestMessage = { type: 'NCM_REQUEST', id: `r${seq++}`, req }

  let res: NcmResponse
  try {
    res = (await chrome.tabs.sendMessage(tabId, msg)) as NcmResponse
  } catch {
    // content script 尚未注入（例如页面刚打开），提示刷新
    throw new NcmError(
      '无法与网易云页面通信，请刷新一下 music.163.com 页面后重试。',
    )
  }

  if (!res?.ok) {
    throw new NcmError(res?.error ?? '未知错误')
  }

  const body = res.data as { code?: number; message?: string } | null
  if (body && typeof body.code === 'number' && NCM_AUTH_ERROR_CODES.has(body.code)) {
    throw new NcmError(
      body.code === 250 || body.code === 301
        ? '登录态已失效，请到 music.163.com 重新登录。'
        : `网易云返回错误 ${body.code}：${body.message ?? ''}`,
      body.code,
    )
  }
  return res.data
}

const raw = (path: string, params?: Record<string, string | number>) =>
  callNcm({ path, method: 'GET', params })

const post = (path: string, params?: Record<string, string | number>) =>
  callNcm({ path, method: 'POST', params })

/** 当前登录状态。未登录时网易返回 account/profile 均为 null。 */
export async function getProfile(): Promise<NeteaseProfile | null> {
  const data = (await raw('/api/w/nuser/account/get', { timestamp: Date.now() })) as {
    account?: { id?: number } | null
    profile?: { userId?: number; nickname?: string; avatarUrl?: string } | null
  } | null

  const userId = data?.profile?.userId ?? data?.account?.id
  if (!userId) return null
  return {
    userId,
    nickname: data?.profile?.nickname ?? `用户 ${userId}`,
    avatarUrl: data?.profile?.avatarUrl,
  }
}

/** 用户全部歌单。「我喜欢的音乐」用 specialType === 5 识别。 */
export async function getUserPlaylists(uid: number): Promise<PlaylistBrief[]> {
  const data = (await raw('/api/user/playlist', {
    uid,
    limit: 1000,
    offset: 0,
    timestamp: Date.now(),
  })) as { playlist?: PlaylistBrief[] } | null

  return (data?.playlist ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    specialType: p.specialType,
    trackCount: p.trackCount,
    userId: p.userId,
  }))
}

export const LIKED_SPECIAL_TYPE = 5

export function pickLikedPlaylist(list: PlaylistBrief[]): PlaylistBrief | null {
  return list.find((p) => p.specialType === LIKED_SPECIAL_TYPE) ?? null
}

/**
 * 取歌单的全部歌曲 ID。
 * n=0 时 tracks 为空但 trackIds 是完整的 —— 这是最省流量的取法，
 * 已实测 965 首的歌单返回 965 个 id，与 trackCount 一致。
 */
export async function getPlaylistTrackIds(playlistId: number): Promise<number[]> {
  const data = (await raw('/api/v6/playlist/detail', {
    id: playlistId,
    n: 0,
    timestamp: Date.now(),
  })) as {
    playlist?: { trackIds?: Array<{ id: number }>; tracks?: Array<{ id: number }> }
  } | null

  const pl = data?.playlist
  if (!pl) return []

  const ids = pl.trackIds?.map((t) => t.id) ?? pl.tracks?.map((t) => t.id) ?? []
  // 网易会返回少量无效 id（已下架等），去重后交给调用方
  return [...new Set(ids)]
}

interface RawSong {
  id: number
  name: string
  ar?: Array<{ name: string }>
  artists?: Array<{ name: string }>
  al?: { id: number; name: string; publishTime?: number }
  album?: { id: number; name: string; publishTime?: number }
  dt?: number
  duration?: number
  publishTime?: number
}

function toSong(s: RawSong): Song {
  const album = s.al ?? s.album
  return {
    id: s.id,
    name: s.name,
    artists: (s.ar ?? s.artists ?? []).map((a) => a.name),
    album: album?.name ?? '',
    albumId: album?.id ?? 0,
    publishTime: s.publishTime ?? album?.publishTime,
    duration: s.dt ?? s.duration ?? 0,
  }
}

/**
 * 批量取歌曲详情。
 * 用 POST /api/v3/song/detail（c=[{id},...]）而不是 GET ?ids=[]，
 * 因为后者会把 URL 撑得过长。
 */
export async function getSongDetails(
  ids: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<Song[]> {
  const out: Song[] = []
  for (let i = 0; i < ids.length; i += SONG_DETAIL_BATCH) {
    const batch = ids.slice(i, i + SONG_DETAIL_BATCH)
    const c = JSON.stringify(batch.map((id) => ({ id })))
    const data = (await post('/api/v3/song/detail', { c })) as {
      songs?: RawSong[]
    } | null
    for (const s of data?.songs ?? []) out.push(toSong(s))
    onProgress?.(Math.min(i + SONG_DETAIL_BATCH, ids.length), ids.length)
  }
  return out
}

/** 直接取「我喜欢的音乐」的歌曲 ID（比走歌单详情更直接） */
export async function getLikedSongIds(uid: number): Promise<number[]> {
  const data = (await raw('/api/song/like/get', {
    uid,
    timestamp: Date.now(),
  })) as { ids?: number[] } | null
  return [...new Set(data?.ids ?? [])]
}

/** 新建歌单，返回新歌单 id */
export async function createPlaylist(name: string): Promise<number> {
  const data = (await post('/api/playlist/create', { name })) as {
    id?: number
    playlist?: { id?: number }
  } | null
  const id = data?.playlist?.id ?? data?.id
  if (!id) throw new NcmError(`创建歌单「${name}」失败：网易未返回歌单 id`)
  return id
}

export async function addTracksToPlaylist(
  playlistId: number,
  trackIds: number[],
): Promise<void> {
  for (let i = 0; i < trackIds.length; i += TRACK_ADD_BATCH) {
    const batch = trackIds.slice(i, i + TRACK_ADD_BATCH)
    await post('/api/playlist/manipulate/tracks', {
      op: 'add',
      pid: playlistId,
      // 网易这里要求 trackIds 是 JSON 字符串
      trackIds: JSON.stringify(batch),
      imme: 'true',
    })
  }
}

export async function removeTracksFromPlaylist(
  playlistId: number,
  trackIds: number[],
): Promise<void> {
  for (let i = 0; i < trackIds.length; i += TRACK_ADD_BATCH) {
    const batch = trackIds.slice(i, i + TRACK_ADD_BATCH)
    await post('/api/playlist/manipulate/tracks', {
      op: 'del',
      pid: playlistId,
      trackIds: JSON.stringify(batch),
    })
  }
}
