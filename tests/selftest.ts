/**
 * 纯逻辑自测。
 *
 * 这些函数不依赖浏览器和网络，但一旦出错会静默污染所有分类结果，
 * 所以用真实断言盯住。改动 rules.ts / llm.ts / writer.ts 后请重跑：
 *
 *   npm run selftest
 */

import { artistNames, artistSongCounts, decadeOf, guessLanguage, looksInstrumental } from '@/lib/classifier/rules'
import { extractJson, generatePlaylistNameSuggestions, needsLlm, sampleGenreSongs } from '@/lib/classifier/llm'
import { categoriesOf, classifySongs, groupByDimension, replaceArtistCategory } from '@/lib/classifier'
import { cacheKeyFor, loadSettings, normalizeDimensions, normalizeMinArtistSongs, playlistNameCacheKeyFor, DEFAULT_SETTINGS, type CachedClass } from '@/lib/store'
import { selftestArtistPlaylists } from './artist-playlists'
import { applyWritePlan, buildWritePlan, defaultDestinationFor, type CategoryWriteGroup } from '@/lib/writer'
import { getUserPlaylists } from '@/lib/netease'
import type { Dimension, PlaylistBrief } from '@/lib/types'
import type { NcmRequestMessage } from '@/lib/rpc'

let pass = 0
let fail = 0

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ✅ ${label}`)
  } else {
    fail++
    console.log(`  ❌ ${label}\n     期望 ${e}\n     实际 ${a}`)
  }
}

const at = (year: number) => new Date(`${year}-06-01T00:00:00Z`).getTime()
const song = (name: string, artist: string) => ({
  id: 1,
  name,
  artists: [artist],
  album: '',
  albumId: 0,
  duration: 0,
})

console.log('— decadeOf：年代必须 100% 准，因为它不走模型 —')
eq('1993 → 90年代', decadeOf(at(1993)), '90年代')
eq('2003 → 00年代', decadeOf(at(2003)), '00年代')
eq('2018 → 10年代', decadeOf(at(2018)), '10年代')
eq('2021 → 20年代', decadeOf(at(2021)), '20年代')
// 回归用例：1970 之前的时间戳是负数，曾因 `<= 0` 守卫被误判为无效
eq('1969 → 60年代及更早（负数时间戳）', decadeOf(at(1969)), '60年代及更早')
eq('1975 → 70年代', decadeOf(at(1975)), '70年代')
eq('1985 → 80年代', decadeOf(at(1985)), '80年代')
eq('缺失 → null', decadeOf(undefined), null)
eq('0 → null', decadeOf(0), null)

console.log('— guessLanguage：拿不准必须返回 null 交给模型 —')
eq('中文 → 华语', guessLanguage(song('晴天', '周杰伦')), '华语')
eq('假名 → 日语', guessLanguage(song('なんでもないや', 'RADWIMPS')), '日语')
eq('谚文 → 韩语', guessLanguage(song('밤편지', '아이유')), '韩语')
eq('纯拉丁 → 英语', guessLanguage(song('Shape of You', 'Ed Sheeran')), '英语')
eq('数字符号 → null', guessLanguage(song('888', '?!')), null)

console.log('— looksInstrumental —')
eq('OST 命中', looksInstrumental(song('Main Theme OST', 'X')), true)
eq('普通歌不误判', looksInstrumental(song('晴天', '周杰伦')), false)

console.log('— 动态曲风分类样本 —')
const sampleList = Array.from({ length: 10 }, (_, id) => ({ ...song(`track-${id}`, 'artist'), id }))
eq('均匀抽样覆盖歌单首尾', sampleGenreSongs(sampleList, 4).map((item) => item.id), [0, 3, 6, 9])
eq('不超过上限时保留全部歌曲', sampleGenreSongs(sampleList, 20).length, 10)

console.log('— 分类缓存隔离 —')
const genreDimension = {
  key: 'genre' as const,
  label: '曲风',
  enabled: true,
  categories: ['流行'],
  categoryHints: { 流行: '主流流行音乐' },
}
eq(
  '相同配置得到相同缓存键',
  cacheKeyFor('https://api.example.com/v1', 'model-a', 1, [genreDimension]) ===
    cacheKeyFor('https://api.example.com/v1', 'model-a', 1, [genreDimension]),
  true,
)
eq(
  '分类说明变化时隔离旧缓存',
  cacheKeyFor('https://api.example.com/v1', 'model-a', 1, [genreDimension]) !==
    cacheKeyFor('https://api.example.com/v1', 'model-a', 1, [
      { ...genreDimension, categoryHints: { 流行: '另一套定义' } },
    ]),
  true,
)
eq(
  '歌单名变化不影响分类缓存',
  cacheKeyFor('https://api.example.com/v1', 'model-a', 1, [genreDimension]) ===
    cacheKeyFor('https://api.example.com/v1', 'model-a', 1, [
      { ...genreDimension, playlistNames: { 流行: '雨中唱片' } },
    ]),
  true,
)
eq('默认命名风格为简洁直白', DEFAULT_SETTINGS.playlistNameStyle, 'concise')
const nameKey = (style: 'concise' | 'custom', custom: string) =>
  playlistNameCacheKeyFor('https://api.example.com/v1', 'model-a', genreDimension, style, custom)
eq('相同命名配置复用名称缓存', nameKey('custom', '季节意象') === nameKey('custom', '季节意象'), true)
eq('切换命名风格隔离名称缓存', nameKey('concise', '') !== nameKey('custom', '季节意象'), true)
eq('修改自定义描述隔离名称缓存', nameKey('custom', '季节意象') !== nameKey('custom', '复古唱片'), true)

console.log('— extractJson：模型返回格式容错 —')
eq('纯 JSON', extractJson('{"results":[{"id":1,"mood":"治愈"}]}'), {
  results: [{ id: 1, mood: '治愈' }],
})
eq('```json 围栏', extractJson('```json\n{"results":[{"id":1}]}\n```'), {
  results: [{ id: 1 }],
})
eq('围栏无语言标记', extractJson('```\n{"results":[]}\n```'), { results: [] })
eq(
  '前后带解释文字',
  extractJson('好的，结果如下：\n{"results":[{"id":2}]}\n以上就是全部。'),
  { results: [{ id: 2 }] },
)
eq('results 缺失 → undefined', extractJson('{"foo":1}').results, undefined)

console.log('— 目标歌单选择 —')
const existingPlaylist = {
  id: 42,
  name: '暮色中的唱片',
  specialType: 0,
  trackCount: 8,
  userId: 7,
}
eq('同名已有歌单默认选复用', defaultDestinationFor('暮色中的唱片', [existingPlaylist]), {
  kind: 'existing',
  playlistId: 42,
})
eq('无同名歌单默认新建', defaultDestinationFor('潮声与旧弦', [existingPlaylist]), {
  kind: 'new',
  playlistName: '潮声与旧弦',
})
eq(
  '我喜欢的音乐不会被默认选作目标',
  defaultDestinationFor('我喜欢的音乐', [
    { id: 99, name: '我喜欢的音乐', specialType: 5, trackCount: 30, userId: 7 },
  ]),
  { kind: 'new', playlistName: '我喜欢的音乐' },
)

console.log('— 歌手分类：无需 Chrome 存储、网络或 API Key —')
const artistSongs = [
  { ...song('独唱', 'A'), id: 1 },
  { ...song('合唱', 'A'), id: 2, artists: [' A ', 'B', 'A', '', ' '] },
  { ...song('资料缺失', ''), id: 3, artists: [] },
]
const artistDimension: Dimension = {
  key: 'artist', label: '歌手', enabled: true,
  categories: [...new Set(artistSongs.flatMap(artistNames))],
}
const artistSettings = { ...DEFAULT_SETTINGS, minArtistSongs: 1, dimensions: [artistDimension], apiKey: '', baseUrl: 'invalid-model-url' }
const artistResult = await classifySongs(artistSongs, artistSettings)
eq('独唱只有一个归属', artistResult.outcomes.get(1)?.artist?.category, ['A'])
eq('合唱包含每位歌手，去空并去重', artistResult.outcomes.get(2)?.artist?.category, ['A', 'B'])
eq('缺失歌手保持未分类', artistResult.outcomes.get(3)?.artist?.category, [])
eq('歌手分类不调用模型', needsLlm(artistDimension), false)
eq('年代仍使用规则', needsLlm({ ...artistDimension, key: 'era' }), false)
eq('曲风仍使用模型', needsLlm(genreDimension), true)
eq('旧分类字符串仍可读取', categoriesOf('流行'), ['流行'])
const artistGroups = groupByDimension(artistSongs, artistResult.outcomes, artistDimension)
eq('预览与写入共用 A 的分组', artistGroups.get('A')?.map((item) => item.id), [1, 2])
eq('合唱也出现在 B 的分组', artistGroups.get('B')?.map((item) => item.id), [2])
eq('修改 A 的归属时保留 B', replaceArtistCategory(['A', 'B'], 'A', 'C'), ['B', 'C'])
eq('移除 A 的归属时保留 B', replaceArtistCategory(['A', 'B'], 'A', ''), ['B'])
eq('合并到已有归属时不重复', replaceArtistCategory(['A', 'B'], 'A', 'B'), ['B'])
eq('未分类歌曲可手动归类', replaceArtistCategory(undefined, '', 'A'), ['A'])
eq('歌手名不按分隔符猜拆分', artistNames({ ...song('示例', 'A/B, C') }), ['A/B, C'])
const longArtist = 'This Is A Very Long Artist Name'
eq('长歌手名和自定义风格也不调用 AI', await generatePlaylistNameSuggestions({
  baseUrl: 'invalid-model-url', apiKey: '', model: '',
  dimension: { ...artistDimension, categories: [longArtist] }, style: 'custom', customStyle: '',
}), { [longArtist]: longArtist })

console.log('— 歌手数量门槛：来源不同歌曲数，包含边界 —')
const thresholdSongs = Array.from({ length: 11 }, (_, index) => ({
  ...song(`门槛歌曲 ${index + 1}`, '十一'), id: 500 + index,
  artists: [...(index < 9 ? ['九'] : []), ...(index < 10 ? ['十'] : []), '十一', ...(index === 10 ? ['合唱嘉宾', '合唱嘉宾', ' '] : [])],
}))
const repeatedSongs = [...thresholdSongs, thresholdSongs[0], thresholdSongs[10]]
eq('重复歌曲与重复歌手不增加计数', [...artistSongCounts(repeatedSongs)], [['九', 9], ['十', 10], ['十一', 11], ['合唱嘉宾', 1]])
const thresholdDimension: Dimension = { ...artistDimension, categories: ['十', '十一'] }
const thresholdResult = await classifySongs(repeatedSongs, { ...artistSettings, minArtistSongs: 10, dimensions: [thresholdDimension] })
eq('9 首排除，10 和 11 首保留', thresholdResult.outcomes.get(500)?.artist?.category, ['十', '十一'])
eq('未达门槛的合唱嘉宾排除，另一位歌手保留', thresholdResult.outcomes.get(510)?.artist?.category, ['十一'])
const thresholdGroups = groupByDimension(repeatedSongs, thresholdResult.outcomes, thresholdDimension)
eq('预览歌曲数量按 ID 去重', [...thresholdGroups].map(([artist, list]) => [artist, list.length]), [['十', 10], ['十一', 11]])
const higherThreshold = await classifySongs(thresholdSongs, { ...artistSettings, minArtistSongs: 11 })
eq('修改门槛后重新计算归属', higherThreshold.outcomes.get(500)?.artist?.category, ['十一'])
const manualFiltered = new Map(thresholdResult.outcomes)
manualFiltered.set(500, { artist: { category: replaceArtistCategory(['十'], '十', '九'), source: 'manual' } })
eq('共享分组不会恢复被门槛移除的歌手分类', groupByDimension(thresholdSongs, manualFiltered, thresholdDimension).has('九'), false)
eq('合并到达标歌手保持归属去重', replaceArtistCategory(['十', '十一'], '十', '十一'), ['十一'])
eq('默认门槛包含10首', DEFAULT_SETTINGS.minArtistSongs, 10)
eq('合法门槛1保留', normalizeMinArtistSongs(1), 1)
eq('非法门槛与旧设置使用默认10', [undefined, 0, -1, 1.5, NaN, Infinity, '10'].map(normalizeMinArtistSongs), [10, 10, 10, 10, 10, 10, 10])

console.log('— 只读扫描与歌单内容配对 —')
try {
  await selftestArtistPlaylists()
  eq('内容扫描、严格配对、歧义与刷新断言', true, true)
} catch (error) {
  console.error(error)
  eq('内容扫描、严格配对、歧义与刷新断言', false, true)
}

console.log('— 新旧设置兼容 —')
eq('新安装默认选择歌手', normalizeDimensions().find((item) => item.enabled)?.key, 'artist')
eq('旧用户的年代选择保留', normalizeDimensions([
  { ...artistDimension, key: 'era', categories: ['90年代'] },
]).find((item) => item.enabled)?.key, 'era')
eq('旧用户的曲风选择保留', normalizeDimensions([genreDimension]).find((item) => item.enabled)?.key, 'genre')
eq('旧设置自动补入歌手入口', normalizeDimensions([genreDimension]).some((item) => item.key === 'artist'), true)
eq('上次的歌手名单不跨来源保存', normalizeDimensions([artistDimension]).find((item) => item.key === 'artist')?.categories, [])

console.log('— 模拟网易云：目标去重、写入失败与重新计算 —')
const mockPlaylists: PlaylistBrief[] = [{ ...existingPlaylist, trackCount: 1 }]
const mockTracks = new Map<number, Set<number>>([[42, new Set([1])]])
let createCount = 0
let rejectNextAdd = false
const legacyCache: Record<string, CachedClass> = {
  [cacheKeyFor(DEFAULT_SETTINGS.baseUrl, DEFAULT_SETTINGS.model, 1, [genreDimension])]: {
    genre: { category: '流行', source: 'llm' },
  },
}
let savedMinimum: unknown = undefined
Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    storage: { local: { get: async () => ({ 'classify-cache:v1': legacyCache, 'settings:v1': { minArtistSongs: savedMinimum, dimensions: [genreDimension] } }) } },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async (_tabId: number, message: NcmRequestMessage) => {
        const { path, params } = message.req
        let data: unknown
        if (path === '/api/user/playlist') {
          data = { code: 200, playlist: mockPlaylists }
        } else if (path === '/api/v6/playlist/detail') {
          data = { code: 200, playlist: { trackIds: [...(mockTracks.get(Number(params?.id)) ?? [])].map((id) => ({ id })) } }
        } else if (path === '/api/playlist/create') {
          const id = 100 + createCount++
          mockPlaylists.push({ id, name: String(params?.name), specialType: 0, trackCount: 0, userId: 7 })
          mockTracks.set(id, new Set())
          data = { code: 200, playlist: { id } }
        } else if (path === '/api/playlist/manipulate/tracks') {
          if (rejectNextAdd) {
            rejectNextAdd = false
            data = { code: 500, message: '模拟写入失败' }
          } else {
            const tracks = mockTracks.get(Number(params?.pid))!
            for (const id of JSON.parse(String(params?.trackIds)) as number[]) tracks.add(id)
            data = { code: 200 }
          }
        } else {
          throw new Error(`自测不应访问 ${path}`)
        }
        return { ok: true, id: message.id, status: 200, data }
      },
    },
  },
})
eq('旧设置自动补入门槛10', (await loadSettings()).minArtistSongs, 10)
savedMinimum = 20
eq('已保存的门槛保留', (await loadSettings()).minArtistSongs, 20)
eq('加载新设置保留旧分类选择', (await loadSettings()).dimensions.find((item) => item.enabled)?.key, 'genre')
mockTracks.set(42, new Set(thresholdSongs.slice(0, 9).map((item) => item.id)))
const thresholdPlan = await buildWritePlan({
  groups: [{ dimension: 'artist', dimensionLabel: '歌手', category: '十', displayTitle: '十', songs: thresholdGroups.get('十')!, destination: { kind: 'existing', playlistId: 42 } }],
  existingPlaylists: mockPlaylists,
})
eq('来源有10首、目标已有9首时仍达标并只追加1首', thresholdPlan[0].toAdd, [509])
mockTracks.set(42, new Set([1]))
const legacyResult = await classifySongs([artistSongs[0]], { ...DEFAULT_SETTINGS, dimensions: [genreDimension] })
eq('旧模型缓存保留单值结果', legacyResult.outcomes.get(1)?.genre?.category, '流行')
const sharedGroups: CategoryWriteGroup[] = [...artistGroups].map(([category, songs]) => ({
  dimension: 'artist', dimensionLabel: '歌手', category, displayTitle: category,
  songs, destination: { kind: 'existing', playlistId: 42 },
}))
const sharedPlan = await buildWritePlan({ groups: sharedGroups, existingPlaylists: mockPlaylists })
eq('多个歌手映射同一目标只生成一条计划', sharedPlan.length, 1)
eq('合唱重叠和目标已有歌曲均去重', sharedPlan[0].toAdd, [2])
await applyWritePlan(sharedPlan)
eq('重复计算不会再次添加已存在歌曲', (await buildWritePlan({ groups: sharedGroups, existingPlaylists: mockPlaylists }))[0].action, 'none')

const newGroups: CategoryWriteGroup[] = [
  { ...sharedGroups[0], songs: [artistSongs[1]], destination: { kind: 'new', playlistName: 'A' } },
  { ...sharedGroups[1], destination: { kind: 'new', playlistName: 'B' } },
]
const newPlan = await buildWritePlan({ groups: newGroups, existingPlaylists: mockPlaylists })
let createdId: number | undefined
rejectNextAdd = true
try {
  await applyWritePlan(newPlan, { onCreated: (_name, id) => { createdId = id } })
  eq('API 非成功结果应终止写入', false, true)
} catch (error) {
  eq('API 非成功结果应终止写入', error instanceof Error && error.message.includes('500'), true)
}
eq('加歌失败前保存新建目标 ID', createdId, 100)
eq('失败后不再创建后续歌单', createCount, 1)
const refreshedPlaylists = await getUserPlaylists(7)
const retryGroups = newGroups.map((group) => ({
  ...group, destination: defaultDestinationFor(group.displayTitle, refreshedPlaylists),
}))
const retryPlan = await buildWritePlan({ groups: retryGroups, existingPlaylists: refreshedPlaylists })
eq('重试复用已创建目标', retryPlan[0].existingPlaylistId, 100)
await applyWritePlan(retryPlan)
eq('重试只创建尚未创建的 B', createCount, 2)
eq('重试成功把合唱写入 A', [...mockTracks.get(100)!], [2])
eq('重试成功把合唱也写入 B', [...mockTracks.get(101)!], [2])

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
