// 渲染层到桌面网络桥的取消、并发身份及旧桥兼容。
import assert from 'node:assert/strict'

type Reply = { ok: true; status: number; statusText: string; text: string } | { ok: false; error: string }
const calls: { id?: string; resolve: (result: Reply) => void }[] = []
const cancelled: string[] = []
const bridge = {
  fetch: (_url: string, init?: { requestId?: string }) => new Promise<Reply>(resolve => calls.push({ id: init?.requestId, resolve })),
  cancel: async (id: string) => { cancelled.push(id); calls.find(call => call.id === id)?.resolve({ ok: false, error: '已取消' }); return { ok: true } },
}
Object.defineProperty(globalThis, 'window', { value: { electronNet: bridge }, configurable: true })
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, configurable: true })
const { netFetch } = await import('../src/lib/app/desktop')
const okReply: Reply = { ok: true, status: 200, statusText: 'OK', text: '结果' }

const before = new AbortController()
before.abort()
assert.deepEqual(await netFetch('http://127.0.0.1', undefined, before.signal), { ok: false, error: '已取消' })
assert.equal(calls.length, 0, '已经取消时不得发起请求')

const first = new AbortController(), second = new AbortController()
const p1 = netFetch('http://127.0.0.1/a', undefined, first.signal)
const p2 = netFetch('http://127.0.0.1/b', undefined, second.signal)
assert.ok(calls[0].id && calls[1].id && calls[0].id !== calls[1].id, '并发请求应有不同标识')
first.abort()
assert.deepEqual(await p1, { ok: false, error: '已取消' })
assert.deepEqual(cancelled, [calls[0].id], '取消不得影响另一个请求')
calls[1].resolve(okReply)
assert.deepEqual(await p2, okReply)

// 旧 preload 没有 cancel：不得提前返回或误报迟到成功，等旧桥回执后再返回取消。
Object.assign(bridge, { cancel: undefined })
const legacy = new AbortController()
const p3 = netFetch('http://127.0.0.1/c', undefined, legacy.signal)
legacy.abort()
const state = await Promise.race([p3.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('pending'), 50))])
assert.equal(state, 'pending', '旧桥未确认完成前不能提前释放在途任务')
calls[2].resolve(okReply)
assert.deepEqual(await p3, { ok: false, error: '已取消' })
console.log('NET_FETCH_CANCELLATION_PASS: pre-abort, isolated concurrent requests, legacy bridge')
