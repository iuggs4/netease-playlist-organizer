import assert from 'node:assert/strict'
import { getPlaylistTrackIds, getUserPlaylists } from '@/lib/netease'
import {
  isWriteRequest, NcmError, NcmRateLimitError, RATE_LIMIT_COOLDOWN_MS,
  requestIntervalMs, RPC_CREATE_INTERVAL_MS, RPC_MIN_INTERVAL_MS, RPC_WRITE_INTERVAL_MS,
  type NcmRequest, type NcmRequestMessage, type NcmResponse,
} from '@/lib/rpc'

export async function selftestRateLimit(): Promise<void> {
  const create = { method: 'POST', path: '/api/playlist/create' } as const
  const append = { method: 'POST', path: '/api/playlist/manipulate/tracks' } as const
  const detail = { method: 'POST', path: '/api/v3/song/detail' } as const
  assert.equal(requestIntervalMs(create), 10_000, '创建歌单采用较慢节奏')
  assert.equal(requestIntervalMs(append), 3_000, '加歌和删歌采用写入节奏')
  assert.equal(requestIntervalMs(detail), 500, 'POST 歌曲详情依然属于读取')
  assert.equal(requestIntervalMs({ method: 'GET', path: '/api/v6/playlist/detail' }), RPC_MIN_INTERVAL_MS)
  assert.equal(RPC_CREATE_INTERVAL_MS, 10_000)
  assert.equal(RPC_WRITE_INTERVAL_MS, 3_000)
  assert.equal(isWriteRequest(create), true, '创建网络失败不能自动重放')
  assert.equal(isWriteRequest(append), true, '追加网络失败不能自动重放')
  assert.equal(isWriteRequest(detail), false, '只读请求保留有界重试')

  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  let response: NcmResponse = { ok: true, id: 'test', status: 200, data: { code: 405 } }
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: { tabs: { query: async () => [{ id: 1 }], sendMessage: async () => response } },
  })
  try {
    const expectRateLimit = async (code: number, retryAfterMs = RATE_LIMIT_COOLDOWN_MS) => {
      await assert.rejects(getUserPlaylists(1), (error: unknown) => {
        assert.ok(error instanceof NcmRateLimitError)
        assert.equal(error.code, code)
        assert.equal(error.retryAfterMs, retryAfterMs)
        assert.match(error.message, /冷却|等待/)
        return true
      })
    }
    await expectRateLimit(405)
    response = { ok: true, id: 'test', status: 200, data: { code: 429 } }
    await expectRateLimit(429)
    response = { ok: true, id: 'test', status: 429, data: null }
    await expectRateLimit(429)
    response = { ok: true, id: 'test', status: 429, data: '<html>Too many requests</html>' }
    await expectRateLimit(429)
    response = { ok: false, id: 'test', error: '冷却中，请稍后再试', code: 405, retryAfterMs: 12_345 }
    await expectRateLimit(405, 12_345)

    for (const failure of [
      { ok: true, id: 'test', status: 200, data: { code: 301 } },
      { ok: true, id: 'test', status: 500, data: { code: 500 } },
      { ok: true, id: 'test', status: 200, data: { code: 500, message: '操作失败' } },
      { ok: false, id: 'test', error: '通信失败' },
      { ok: true, id: 'test', status: 200, data: { code: 200 } },
      { ok: true, id: 'test', status: 200, data: { code: 200, playlist: [null] } },
    ] satisfies NcmResponse[]) {
      response = failure
      await assert.rejects(getUserPlaylists(1), (error: unknown) => {
        assert.ok(error instanceof NcmError)
        assert.equal(error instanceof NcmRateLimitError, false, '普通错误不进入冷却')
        return true
      })
    }

    for (const playlist of [undefined, {}, { tracks: [{ id: 1 }] }, { trackIds: [{ id: 1 }], trackCount: 2 }, { trackIds: [{ id: -1 }] }, { trackIds: {}, tracks: [] }]) {
      response = { ok: true, id: 'test', status: 200, data: { code: 200, playlist } }
      await assert.rejects(getPlaylistTrackIds(42), NcmError, '不完整目标快照不能被当作空歌单后重复写入')
    }
    response = { ok: true, id: 'test', status: 200, data: { code: 200, playlist: { trackIds: [], trackCount: 0 } } }
    assert.deepEqual(await getPlaylistTrackIds(42), [], '完整空歌单可正常读取')
    response = { ok: true, id: 'test', status: 200, data: { code: 200, playlist: { trackIds: {}, tracks: [{ id: 1 }], trackCount: 1 } } }
    assert.deepEqual(await getPlaylistTrackIds(42), [1], '仅使用确认为数组且数量完整的回退歌曲列表')

    const offsets: number[] = []
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async (_tabId: number, message: NcmRequestMessage) => {
          const offset = Number(message.req.params?.offset)
          offsets.push(offset)
          return { ok: true, id: message.id, status: 200, data: {
            code: 200, more: offset === 0,
            playlist: [{ id: offset + 1, name: '测试歌单', userId: 1, specialType: 0, trackCount: 0 }],
          } }
        },
      } },
    })
    assert.deepEqual((await getUserPlaylists(1)).map((item) => item.id), [1, 2], '同名核对前读取全部分页')
    assert.deepEqual(offsets, [0, 1], '按实际页长度推进，不跳过截断页')
  } finally {
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
    else Reflect.deleteProperty(globalThis, 'chrome')
  }

  await selftestContentTransport()
}

async function selftestContentTransport(): Promise<void> {
  const originals = ['chrome', 'document', 'fetch', 'setTimeout'].map((name) => (
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  ))
  const originalNow = Date.now
  let now = 100_000
  let listener: ((message: NcmRequestMessage, sender: chrome.runtime.MessageSender, reply: (response: NcmResponse) => void) => unknown) | undefined
  let status = 200
  let body = JSON.stringify({ code: 405 })
  let failures = 0
  const sentAt: number[] = []
  const stub = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, value })
  try {
    Date.now = () => now
    stub('document', { cookie: '' })
    stub('chrome', { runtime: { onMessage: { addListener: (callback: typeof listener) => { listener = callback } } } })
    stub('setTimeout', (callback: () => void, ms: number) => { now += ms; callback(); return 0 })
    stub('fetch', async () => {
      sentAt.push(now)
      if (failures > 0) { failures--; throw new Error('模拟网络断开') }
      return { status, text: async () => body }
    })
    await import('@/content/index')
    const request = (req: NcmRequest) => new Promise<NcmResponse>((resolve, reject) => {
      if (!listener) return reject(new Error('未注册 RPC listener'))
      listener({ type: 'NCM_REQUEST', id: 'transport-test', req }, {}, resolve)
    })
    const read = { method: 'GET', path: '/api/user/playlist' } as const
    const refused = await request(read)
    assert.ok(refused.ok, '第一次限流原样返回响应，由领域 API 解释')
    assert.deepEqual(refused.data, { code: 405 })
    const callsBeforeCooldown = sentAt.length
    now += 59_000
    const blocked = await request(read)
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.equal(blocked.code, 405)
      assert.equal(blocked.retryAfterMs, 1_000, '冷却错误携带剩余毫秒数')
    }
    assert.equal(sentAt.length, callsBeforeCooldown, '冷却期间不 fetch，也不等待整段冷却')
    now += 1_000
    body = JSON.stringify({ code: 200 })
    assert.equal((await request(read)).ok, true, '冷却到期允许重新计算')

    status = 429
    body = '<html>Too many requests</html>'
    const httpRefused = await request(read)
    assert.ok(httpRefused.ok)
    assert.equal(httpRefused.status, 429, 'HTTP 429 非 JSON 响应仍保留限流状态')
    const beforeHttpCooldown = sentAt.length
    assert.equal((await request(read)).ok, false)
    assert.equal(sentAt.length, beforeHttpCooldown)
    now += RATE_LIMIT_COOLDOWN_MS
    status = 200
    body = JSON.stringify({ code: 200 })

    for (const path of ['/api/playlist/create', '/api/playlist/manipulate/tracks']) {
      failures = 3
      const before = sentAt.length
      assert.equal((await request({ method: 'POST', path })).ok, false)
      assert.equal(sentAt.length - before, 1, '写入网络异常不自动重放')
    }
    failures = 2
    const beforeReadRetry = sentAt.length
    assert.equal((await request(read)).ok, true)
    assert.equal(sentAt.length - beforeReadRetry, 3, '读取网络异常保持最多三次尝试')

    for (const [path, interval] of [
      ['/api/playlist/create', RPC_CREATE_INTERVAL_MS],
      ['/api/playlist/manipulate/tracks', RPC_WRITE_INTERVAL_MS],
      ['/api/v3/song/detail', RPC_MIN_INTERVAL_MS],
    ] as const) {
      const previous = sentAt.at(-1)!
      await request({ method: 'POST', path })
      assert.ok(sentAt.at(-1)! - previous >= interval, '全局队列应用各类请求间隔')
    }
  } finally {
    Date.now = originalNow
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
}
