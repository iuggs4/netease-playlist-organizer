import assert from 'node:assert/strict'
import { resolveArtistDestination, scanArtistPlaylists, type ArtistPlaylistEvidence } from '@/lib/artist-playlists'
import type { NcmRequestMessage } from '@/lib/rpc'
import type { PlaylistBrief } from '@/lib/types'

export async function selftestArtistPlaylists(): Promise<void> {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  const tracks = new Map<number, number[]>([
    [1, [1, 2]], [2, [2, 3]], [3, [1, 4]], [4, []], [5, [1, 2]],
    [6, [999]], [7, [998]], [8, [5]], [9, [6]],
  ])
  const artists = new Map<number, string[]>([
    [1, [' A ', 'A', '']], [2, ['A', 'B']], [3, ['A', 'B']], [4, ['B']], [6, []],
  ])
  const failedPlaylists = new Set([10])
  const failedSongs = new Set<number>()
  const playlistReads: number[] = []
  const detailReads: number[][] = []
  const playlist = (id: number, count: number, name = `歌单 ${id}`): PlaylistBrief => ({
    id, name, trackCount: count, specialType: 0, userId: 7,
  })
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async (_tabId: number, message: NcmRequestMessage) => {
          const { path, params } = message.req
          let data: unknown
          if (path === '/api/v6/playlist/detail') {
            const id = Number(params?.id)
            playlistReads.push(id)
            data = failedPlaylists.has(id)
              ? { code: 500, message: '模拟歌单读取失败' }
              : { code: 200, playlist: { trackIds: (tracks.get(id) ?? []).map((trackId) => ({ id: trackId })) } }
          } else if (path === '/api/v3/song/detail') {
            const ids = (JSON.parse(String(params?.c)) as Array<{ id: number }>).map((item) => item.id)
            detailReads.push(ids)
            data = ids.some((id) => failedSongs.has(id))
              ? { code: 500, message: '模拟歌曲详情读取失败' }
              : {
                  code: 200,
                  songs: ids.filter((id) => artists.has(id)).map((id) => ({
                    id, name: `歌曲 ${id}`, ar: artists.get(id)!.map((name) => ({ name })),
                  })),
                }
          } else {
            throw new Error(`配对自测不应访问 ${path}`)
          }
          return { ok: true, id: message.id, status: 200, data }
        },
      },
    },
  })
  try {
    const lists = [
      playlist(1, 2, '开车听'), playlist(2, 2), playlist(3, 2), playlist(4, 0), playlist(5, 3),
      { ...playlist(6, 1), userId: 8 }, { ...playlist(7, 1), specialType: 5 },
      playlist(8, 1), playlist(9, 1), playlist(10, 1),
    ]
    const progress: string[] = []
    const evidence = await scanArtistPlaylists(lists, 7, (message) => progress.push(message))
    const byId = new Map(evidence.map((item) => [item.playlistId, item]))
    assert.deepEqual(byId.get(1)?.artists, ['A'], '每首歌包含 A 即可识别，去空名与重复名')
    assert.deepEqual(byId.get(2)?.artists, ['A', 'B'], '全是 A/B 合唱时保留双方证据')
    assert.deepEqual(byId.get(3)?.artists, [], '混合不同歌手时不自动匹配')
    assert.deepEqual(byId.get(4)?.artists, [], '空歌单不识别')
    assert.match(byId.get(5)?.error ?? '', /3 首.*2 首/, '数量不一致不将部分内容当作完整证据')
    assert.equal(byId.get(5)?.trackCount, 2, '证据记录实际读取歌曲数')
    assert.equal(byId.has(6), false, '其他用户歌单不参与')
    assert.equal(byId.has(7), false, '喜欢列表不参与')
    assert.equal(playlistReads.includes(6) || playlistReads.includes(7), false, '不读取不允许的歌单')
    assert.match(byId.get(8)?.error ?? '', /详情缺失/, '缺失任意歌曲详情不匹配')
    assert.match(byId.get(9)?.error ?? '', /歌手信息/, '缺失任意歌手信息不匹配')
    assert.match(byId.get(10)?.error ?? '', /读取歌单失败/, '歌单失败保留错误且不阻止其他歌单')
    assert.equal(new Set(detailReads.flat()).size, detailReads.flat().length, '同一次扫描只读取每首歌的详情一次')
    assert.ok(progress.length > 0, '扫描报告进度')

    const ownLists = lists.filter((item) => item.userId === 7)
    const pureOnly = [byId.get(1)!]
    assert.deepEqual(resolveArtistDestination('A', 'A', ownLists, pureOnly).destination, { kind: 'existing', playlistId: 1 }, '任意歌单名按内容配对')
    assert.match(resolveArtistDestination('A', 'A', ownLists, pureOnly).reason, /开车听.*2 首.*全部包含A/, '显示内容识别依据')
    assert.deepEqual(resolveArtistDestination('C', 'C', ownLists, evidence).destination, { kind: 'new', playlistName: 'C' }, '没有匹配时新建完整名字')
    assert.equal(resolveArtistDestination('A', 'A', ownLists, evidence).needsConfirmation, true, '多个内容匹配必须手动确认')
    const shared = resolveArtistDestination('A', 'A', ownLists, [byId.get(2)!])
    assert.equal(shared.needsConfirmation, true, '歌单同时属于多个歌手必须确认')
    assert.equal(shared.destination, undefined, '有歧义时不返回自动目标')
    assert.equal(shared.candidates[0]?.playlistId, 2)
    const named = playlist(11, 2, 'A')
    assert.deepEqual(resolveArtistDestination('A', 'A', [...ownLists, named], evidence).destination, { kind: 'existing', playlistId: 11 }, '同名优先于内容匹配')
    assert.equal(resolveArtistDestination('A', 'A', [named, playlist(12, 0, 'A')], []).needsConfirmation, true, '多个同名歌单不任意选择')
    const manual = { kind: 'existing' as const, playlistId: 3 }
    assert.deepEqual(resolveArtistDestination('A', 'A', [...ownLists, named], evidence, manual).destination, manual, '手动目标优先于自动选择')
    const manualNew = { kind: 'new' as const, playlistName: '我的新歌单' }
    assert.deepEqual(resolveArtistDestination('A', 'A', [...ownLists, named], evidence, manualNew).destination, manualNew, '手动新建名称保持不变')
    const liked = { ...playlist(13, 2, 'A'), specialType: 5 }
    const likedEvidence: ArtistPlaylistEvidence = { playlistId: 13, playlistName: 'A', trackCount: 2, artists: ['A'] }
    assert.deepEqual(resolveArtistDestination('A', 'A', [liked], [likedEvidence]).destination, { kind: 'new', playlistName: 'A' }, '同名与内容均不能选中喜欢列表')
    assert.deepEqual(resolveArtistDestination('A', 'A', [], pureOnly).destination, { kind: 'new', playlistName: 'A' }, '当前可写歌单之外的旧证据不参与')

    tracks.set(1, [1, 4])
    const refreshed = await scanArtistPlaylists([lists[0]], 7)
    assert.deepEqual(refreshed[0].artists, [], '重新配对读取最新歌曲内容，不复用上轮识别')
    assert.equal(playlistReads.filter((id) => id === 1).length, 2, '每轮重新读取目标歌单 ID')

    detailReads.length = 0
    const manyIds = Array.from({ length: 101 }, (_, index) => 1000 + index)
    tracks.set(20, manyIds)
    tracks.set(21, [manyIds[0], manyIds[100]])
    for (const id of manyIds) artists.set(id, ['C'])
    const batched = await scanArtistPlaylists([playlist(20, 101), playlist(21, 2)], 7)
    assert.deepEqual(batched.map((item) => item.artists), [['C'], ['C']], '超过 100 首的歌单完整识别')
    assert.deepEqual(detailReads.map((batch) => batch.length), [100, 1], '详情去重后按 100 首分批')
    assert.equal(detailReads.flat().length, 101)

    detailReads.length = 0
    tracks.set(20, manyIds.slice(0, 100))
    tracks.set(22, [9000])
    failedSongs.add(9000)
    const partialFailure = await scanArtistPlaylists([playlist(20, 100), playlist(22, 1)], 7)
    assert.deepEqual(partialFailure[0].artists, ['C'], '一个详情批次失败不影响其他完整歌单')
    assert.match(partialFailure[1].error ?? '', /读取歌曲详情失败/, '失败批次不能产生配对证据')
    assert.deepEqual(partialFailure[1].artists, [])
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
    else Reflect.deleteProperty(globalThis, 'chrome')
  }
}
