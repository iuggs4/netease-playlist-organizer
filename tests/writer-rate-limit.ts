import assert from 'node:assert/strict'
import { applyWritePlan, type ApplyProgress, type CategoryPlan } from '@/lib/writer'
import { NcmRateLimitError } from '@/lib/rpc'
import type { NcmRequest, NcmRequestMessage } from '@/lib/rpc'
import type { PlaylistBrief } from '@/lib/types'

export async function selftestWriterRateLimit(): Promise<void> {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  const originalNow = Object.getOwnPropertyDescriptor(Date, 'now')!
  const originalSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout')!
  const originalClearTimeout = Object.getOwnPropertyDescriptor(globalThis, 'clearTimeout')!
  let now = 0
  let timerId = 0
  const cancelledTimers = new Set<unknown>()
  let respond: (request: NcmRequest) => unknown | Promise<unknown>
  const requests: Array<{ request: NcmRequest; at: number }> = []

  Object.defineProperty(Date, 'now', { ...originalNow, value: () => now })
  Object.defineProperty(globalThis, 'setTimeout', {
    ...originalSetTimeout,
    value: (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
      const id = ++timerId
      queueMicrotask(() => {
        if (!cancelledTimers.has(id)) {
          now += Math.max(0, delay)
          callback(...args)
        }
      })
      return id
    },
  })
  Object.defineProperty(globalThis, 'clearTimeout', {
    ...originalClearTimeout,
    value: (id: unknown) => { cancelledTimers.add(id) },
  })
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async (_tabId: number, message: NcmRequestMessage) => {
          requests.push({ request: message.req, at: now })
          const data = await respond(message.req)
          return { ok: true, id: message.id, status: 200, data }
        },
      },
    },
  })

  const plan = (ids: number[], playlistId: number | null = 42): CategoryPlan => ({
    destinationKey: playlistId ? `existing:${playlistId}` : 'new:测试歌手',
    playlistName: '测试歌手', existingPlaylistId: playlistId ?? undefined,
    sourceCategories: ['歌手 · 测试歌手'], songIds: ids, toAdd: ids,
    action: playlistId ? 'append' : 'create',
  })
  const playlist = (id: number, userId = 7, specialType = 0): PlaylistBrief => ({
    id, name: '测试歌手', userId, specialType, trackCount: 0,
  })
  const idsIn = (request: NcmRequest): number[] => JSON.parse(String(request.params?.trackIds)) as number[]
  const callsTo = (path: string) => requests.filter(({ request }) => request.path === path)
  const reset = () => { requests.length = 0; now = 0 }
  const unexpected = (request: NcmRequest): never => {
    throw new Error(`限流自测不应访问 ${request.path}`)
  }

  try {
    const accepted = new Set<number>()
    const addBatches: number[][] = []
    const progress: ApplyProgress[] = []
    respond = (request) => {
      if (request.path === '/api/v6/playlist/detail') {
        return { code: 200, playlist: { trackIds: [...accepted].map((id) => ({ id })) } }
      }
      if (request.path === '/api/playlist/manipulate/tracks') {
        const ids = idsIn(request)
        addBatches.push(ids)
        if (addBatches.length === 1) {
          accepted.add(ids[0])
          return { code: 405, message: '操作过于频繁' }
        }
        ids.forEach((id) => accepted.add(id))
        return { code: 200 }
      }
      return unexpected(request)
    }
    const allIds = Array.from({ length: 205 }, (_, index) => index + 1)
    await applyWritePlan([plan(allIds)], { onProgress: (item) => progress.push(item) })
    assert.deepEqual(addBatches, [
      allIds.slice(0, 100), allIds.slice(1, 100), allIds.slice(100, 200), allIds.slice(200),
    ], '405 后刷新目标，只重试尚未接受的当前批次，后续批次仍按 100 首写入')
    assert.deepEqual([...accepted], allIds, '部分接受后恢复，最终没有漏歌')
    assert.ok(callsTo('/api/v6/playlist/detail').length >= 2, '首次核对后，重试前再次读取目标内容')
    assert.ok(progress.some((item) => (item.retryInSeconds ?? 0) > 0), '冷却通过进度回调报告剩余秒数')
    const addTimes = callsTo('/api/playlist/manipulate/tracks').map((item) => item.at)
    assert.ok(addTimes[1] - addTimes[0] >= 60_000, '首次重试至少冷却 60 秒')

    reset()
    const createdCallbacks: Array<[string, number]> = []
    respond = (request) => {
      if (request.path === '/api/playlist/create') return { code: 405, message: '创建被限流' }
      if (request.path === '/api/user/playlist') {
        assert.equal(Number(request.params?.uid), 7, '按当前用户刷新歌单')
        return { code: 200, playlist: [playlist(88), playlist(89, 7, 5), playlist(90, 8)] }
      }
      if (request.path === '/api/v6/playlist/detail') {
        assert.equal(Number(request.params?.id), 88)
        return { code: 200, playlist: { trackIds: [{ id: 1 }] } }
      }
      if (request.path === '/api/playlist/manipulate/tracks') {
        assert.equal(Number(request.params?.pid), 88, '恢复到新发现的已有目标')
        assert.deepEqual(idsIn(request), [2, 3], '复用目标后也排除已有歌曲')
        return { code: 200 }
      }
      return unexpected(request)
    }
    await applyWritePlan([plan([1, 2, 3], null)], {
      userId: 7, onCreated: (name, id) => createdCallbacks.push([name, id]),
    })
    assert.equal(callsTo('/api/playlist/create').length, 1, '创建限流后发现唯一同名目标，不再次创建')
    assert.deepEqual(createdCallbacks, [['测试歌手', 88]], '复用已创建目标也立刻保存 ID')

    reset()
    const repeatedProgress: ApplyProgress[] = []
    respond = (request) => {
      if (request.path === '/api/playlist/create') return { code: 405, message: '持续限流' }
      if (request.path === '/api/user/playlist') return { code: 200, playlist: [] }
      return unexpected(request)
    }
    await assert.rejects(
      applyWritePlan([plan([1], null)], { userId: 7, onProgress: (item) => repeatedProgress.push(item) }),
      (error: unknown) => error instanceof NcmRateLimitError && error.code === 405,
      '两次恢复后仍限流时停止并保留错误',
    )
    const creates = callsTo('/api/playlist/create')
    assert.equal(creates.length, 3, '每次操作最多重试两次')
    assert.ok(creates[1].at - creates[0].at >= 60_000, '第一次创建重试冷却 60 秒')
    assert.ok(creates[2].at - creates[1].at >= 120_000, '第二次创建重试冷却 120 秒')
    assert.ok(repeatedProgress.some((item) => (item.retryInSeconds ?? 0) >= 120), '第二次冷却显示增加后的剩余时间')

    reset()
    respond = (request) => {
      if (request.path === '/api/playlist/create') return { code: 405, message: '创建被限流' }
      if (request.path === '/api/user/playlist') return { code: 200, playlist: [playlist(88), playlist(89)] }
      return unexpected(request)
    }
    await assert.rejects(
      applyWritePlan([plan([1], null)], { userId: 7 }),
      (error: unknown) => error instanceof Error && /手动|重新选择|多个|同名/.test(error.message),
      '多个同名目标需要手动选择',
    )
    assert.equal(callsTo('/api/playlist/create').length, 1, '同名歧义不盲目再次创建')
    assert.equal(callsTo('/api/playlist/manipulate/tracks').length, 0, '同名歧义不写入任意候选')

    reset()
    const savedBeforeFailure: number[] = []
    respond = (request) => {
      if (request.path === '/api/playlist/create') return { code: 200, playlist: { id: 99 } }
      if (request.path === '/api/v6/playlist/detail') return { code: 200, playlist: { trackIds: [] } }
      if (request.path === '/api/playlist/manipulate/tracks') return { code: 500, message: '普通写入失败' }
      return unexpected(request)
    }
    await assert.rejects(applyWritePlan([plan([1], null), plan([2], null)], {
      userId: 7, onCreated: (_name, id) => savedBeforeFailure.push(id),
    }), /500/, '非限流错误立即交还给用户')
    assert.deepEqual(savedBeforeFailure, [99], '追加失败前已回传新建歌单 ID')
    assert.equal(callsTo('/api/playlist/create').length, 1, '失败后不创建后续歌单')
    assert.equal(callsTo('/api/playlist/manipulate/tracks').length, 1, '500 不自动重复追加')
    assert.equal(now, 0, '普通错误不进入冷却重试')

    reset()
    respond = (request) => {
      if (request.path === '/api/playlist/create') throw new Error('网络断开，结果未知')
      return unexpected(request)
    }
    await assert.rejects(applyWritePlan([plan([1], null)], { userId: 7 }), /通信|网络/, '结果未知的创建失败不自动重发')
    assert.equal(callsTo('/api/playlist/create').length, 1, '未知网络错误只创建一次')
    assert.equal(now, 0, '未知网络错误不进入冷却重试')

    reset()
    const abortController = new AbortController()
    let sawCooldown = false
    respond = (request) => {
      if (request.path === '/api/playlist/manipulate/tracks') return { code: 405, message: '等待中取消' }
      if (request.path === '/api/v6/playlist/detail') return { code: 200, playlist: { trackIds: [] } }
      return unexpected(request)
    }
    await assert.rejects(applyWritePlan([plan([1]), plan([2])], {
      signal: abortController.signal,
      onProgress: (item) => {
        if (!sawCooldown && (item.retryInSeconds ?? 0) > 0) {
          sawCooldown = true
          queueMicrotask(() => abortController.abort())
        }
      },
    }), (error: unknown) => error instanceof Error && error.name === 'AbortError', '冷却期间取消返回 AbortError')
    assert.equal(sawCooldown, true, '取消发生在冷却阶段')
    assert.equal(callsTo('/api/playlist/manipulate/tracks').length, 1, '取消后不重试，也不处理后续目标')
  } finally {
    Object.defineProperty(Date, 'now', originalNow)
    Object.defineProperty(globalThis, 'setTimeout', originalSetTimeout)
    Object.defineProperty(globalThis, 'clearTimeout', originalClearTimeout)
    if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
    else Reflect.deleteProperty(globalThis, 'chrome')
  }
}
