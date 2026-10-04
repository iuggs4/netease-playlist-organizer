/**
 * 纯逻辑自测。
 *
 * 这些函数不依赖浏览器和网络，但一旦出错会静默污染所有分类结果，
 * 所以用真实断言盯住。改动 rules.ts / llm.ts / writer.ts 后请重跑：
 *
 *   npm run selftest
 */

import { decadeOf, guessLanguage, looksInstrumental } from '@/lib/classifier/rules'
import { extractJson, sampleGenreSongs } from '@/lib/classifier/llm'
import { cacheKeyFor, playlistNameCacheKeyFor, DEFAULT_SETTINGS } from '@/lib/store'
import { defaultDestinationFor } from '@/lib/writer'

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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
