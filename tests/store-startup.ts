import assert from 'node:assert/strict'
import { DEFAULT_DIMENSIONS, DEFAULT_SETTINGS, loadSettings, normalizeDimensions } from '@/lib/store'

export async function selftestStoreStartup(): Promise<void> {
  for (const invalid of [undefined, null, false, 12, 'artist', {}, { key: 'mood' }, [null, false, [], 'mood', { key: 'unknown', enabled: true }]]) {
    const dimensions = normalizeDimensions(invalid)
    assert.deepEqual(dimensions, DEFAULT_DIMENSIONS, '损坏的维度容器或成员回退完整默认定义')
    assert.equal(dimensions.filter((item) => item.enabled).length, 1, '始终只有一个有效维度启用')
    for (const dimension of dimensions) {
      assert.doesNotThrow(() => dimension.categories.some((category) => Array.from(category).length > 12))
      assert.doesNotThrow(() => dimension.categories.join('、'))
    }
  }

  for (const categories of [undefined, null, {}, '治愈', [null], ['治愈', {}], [1]]) {
    const dimensions = normalizeDimensions([{ key: 'mood', enabled: true, categories }])
    const selected = dimensions.find((item) => item.enabled)!
    assert.equal(selected.key, 'mood', '类别损坏不改变旧用户的维度选择')
    assert.deepEqual(selected.categories, DEFAULT_DIMENSIONS.find((item) => item.key === 'mood')!.categories, '缺失或非法类别回退该维度默认值')
    assert.doesNotThrow(() => selected.categories.some((category) => Array.from(category).length > 12))
    assert.doesNotThrow(() => selected.categories.join('、'))
  }

  const savedDimensions = [{
    key: 'language', label: { stale: true }, enabled: true, categories: ['自定义语种', '其他'],
    categoryHints: { 自定义语种: '用户说明', 其他: null },
    playlistNames: { 自定义语种: '用户歌单名', 其他: { invalid: true } },
  }]
  const snapshot = JSON.stringify(savedDimensions)
  const normalized = normalizeDimensions(savedDimensions)
  const selected = normalized.find((item) => item.enabled)!
  assert.equal(selected.key, 'language', '合法旧选择保留')
  assert.equal(selected.label, '语种', '渲染标签使用固定定义，避免把旧对象作为 React 子节点')
  assert.deepEqual(selected.categories, ['自定义语种', '其他'], '合法自定义类别保留')
  assert.deepEqual(selected.categoryHints, { 自定义语种: '用户说明' }, '合法说明保留，忽略损坏的值')
  assert.deepEqual(selected.playlistNames, { 自定义语种: '用户歌单名' }, '合法名称保留，忽略损坏的值')
  assert.equal(JSON.stringify(savedDimensions), snapshot, '规范化不修改传入的已保存数据')
  assert.notEqual(selected.categories, savedDimensions[0].categories, '返回类别与存储数据不共享可变数组')
  assert.deepEqual(normalizeDimensions([{ key: 'mood', enabled: true, categories: [] }]).find((item) => item.enabled)?.categories, [], '合法的空自定义类别保留')
  assert.equal(normalizeDimensions([{ key: 'era', enabled: 'true' }]).find((item) => item.enabled)?.key, 'artist', '非布尔启用值不影响默认选择')
  assert.equal(normalizeDimensions([
    { key: 'mood', enabled: true, categories: ['用户类别'] }, { key: 'genre', enabled: true, categories: ['旧曲风'] },
  ]).find((item) => item.enabled)?.key, 'genre', '旧版多个启用值仍沿用曲风优先规则')
  for (const key of ['artist', 'genre']) {
    const dynamic = normalizeDimensions([{ key, enabled: true, categories: ['旧类别'], playlistNames: { 旧类别: '旧名称' } }]).find((item) => item.key === key)!
    assert.deepEqual(dynamic.categories, [], '动态维度仍由当前来源生成类别')
    assert.equal(dynamic.playlistNames, undefined, '动态名称不跨来源复用')
  }

  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  let storedSettings: unknown
  let readError: Error | undefined
  let writes = 0
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      storage: { local: {
        get: async () => {
          if (readError) throw readError
          return { 'settings:v1': storedSettings }
        },
        set: async () => { writes++ },
        remove: async () => { writes++ },
      } },
    },
  })
  try {
    for (const invalid of [undefined, null, false, 12, '损坏设置', []]) {
      storedSettings = invalid
      assert.deepEqual(await loadSettings(), DEFAULT_SETTINGS, '顶层非对象设置安全回退默认值')
    }
    storedSettings = {
      apiKey: 'fixture-key', model: 'saved-model', dimensions: savedDimensions,
      minArtistSongs: 16, playlistNameStyle: 'custom', customPlaylistNameStyle: '用户风格',
    }
    const storedSnapshot = JSON.stringify(storedSettings)
    const settings = await loadSettings()
    assert.equal(settings.apiKey, 'fixture-key', '维度修复保留合法模型配置')
    assert.equal(settings.model, 'saved-model')
    assert.equal(settings.minArtistSongs, 16)
    assert.equal(settings.playlistNameStyle, 'custom')
    assert.equal(settings.customPlaylistNameStyle, '用户风格')
    assert.deepEqual(settings.dimensions, normalized, '加载设置复用同一维度校验')
    assert.equal(JSON.stringify(storedSettings), storedSnapshot, '读取时不修改原设置')
    assert.equal(writes, 0, '不自动写回或清除存储')

    readError = new Error('扩展存储读取失败')
    await assert.rejects(loadSettings(), (error: unknown) => error === readError, '读取失败原样交给界面初始化处理，不伪装为默认值成功')
    assert.equal(writes, 0, '读取失败也不覆盖或清空存储')
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
    else Reflect.deleteProperty(globalThis, 'chrome')
  }
}
