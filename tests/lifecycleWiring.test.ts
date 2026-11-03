// ============ 3.2.0 · WQ6：生命周期旁路记录 ============
//
// 本轮**不接管超时语义**（那是下一轮、且有回归风险），只让生命周期成为真实调用的一部分：
//   ① 流式：记下**首字耗时**（作者最直观的"卡不卡"指标）；
//   ② 非流式：不写首字（整段一次到，写 0 是假数据）；
//   ③ 失败/取消：状态推进到 failed/cancelled，不给成功路径留假记录。
import { setUsageSink, type ChatUsage } from '@/lib/aiCore/usage'
import { chat } from '@/lib/aiCore/chat'
import type { AIProvider } from '@/lib/aiCore/core'
import { createLifecycle, transitionLifecycle, checkTimeouts, DEFAULT_TIMEOUTS } from '@/lib/ai/streaming'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const realFetch = globalThis.fetch
const provider = (over: Partial<AIProvider> = {}) => ({
  id: 'p', name: 'stub', type: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'stub', ...over,
} as AIProvider)

async function run(
  res: () => Response | Promise<Response>,
  opts: Parameters<typeof chat>[2] = {},
): Promise<{ usage: ChatUsage | null; text: string; err: unknown }> {
  const captured: ChatUsage[] = []
  setUsageSink(u => captured.push(u))
  globalThis.fetch = (async () => res()) as unknown as typeof fetch
  let text = '', err: unknown = null
  try {
    text = await chat(provider(), [{ role: 'user', content: '你好' }], opts)
  } catch (e) { err = e } finally {
    globalThis.fetch = realFetch
    setUsageSink(null)
  }
  return { usage: captured[0] ?? null, text, err }
}

async function main() {
  // ────────────────────────── ① 流式：记首字 ──────────────────────────
  {
    const chunks = [
      `data: ${JSON.stringify({ message: { content: '你' } })}\n\n`,
      `data: ${JSON.stringify({ message: { content: '好' } })}\n\n`,
      `data: ${JSON.stringify({ done: true, prompt_eval_count: 5, eval_count: 2 })}\n\n`,
    ].join('')
    const { text, err, usage } = await run(
      () => new Response(chunks, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
      { onToken: () => { /* 只要触发流式路径 */ } },
    )
    ok('① 流式调用成功', !err && text.includes('你'), `${err instanceof Error ? err.message : String(err)} / ${text}`)
    ok('🔴 首字耗时被记下（不是 undefined）', typeof usage?.firstByteMs === 'number', JSON.stringify(usage))
    ok('① 首字耗时非负', (usage?.firstByteMs ?? -1) >= 0, String(usage?.firstByteMs))
    ok('① 真实用量同时生效（两条记录不互相挤掉）',
      usage?.promptTokens === 5 && usage?.completionTokens === 2, JSON.stringify(usage))
  }

  // ────────────────────────── ② 非流式：不写首字 ──────────────────────────
  {
    const { usage, err } = await run(() => new Response(JSON.stringify({ message: { content: '好' } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    ok('② 非流式调用成功', !err)
    ok('🔴 非流式不写首字（0 是假数据）', usage?.firstByteMs === undefined, JSON.stringify(usage))
  }

  // ────────────────────────── ③ 失败路径也要记账 ──────────────────────────
  {
    const { err, usage } = await run(() => { throw new Error('boom') })
    ok('③ 连接失败会抛错（行为不变）', err instanceof Error)
    ok('③ 失败也上报一笔（便于复盘）', usage !== null, JSON.stringify(usage))
    ok('③ 失败不记首字', usage?.firstByteMs === undefined, JSON.stringify(usage))
  }

  // ────────────────────────── ④ 纯函数契约（不改但要有回归保护） ──────────────────────────
  {
    const lc = createLifecycle('r1')
    ok('④ 初始状态 pending', lc.status === 'pending')
    const s1 = transitionLifecycle(lc, 'first-byte', { firstByteAt: lc.startedAt + 1200 })
    ok('④ 首字节时间写进生命周期', s1.firstByteAt === lc.startedAt + 1200)
    ok('④ 首字节阶段不算结束', s1.finishedAt === undefined)
    const s2 = transitionLifecycle(s1, 'completed')
    ok('④ 终态才写 finishedAt', typeof s2.finishedAt === 'number')

    const fresh = createLifecycle('r2')
    ok('④ 刚建就检查超时：不超时', !checkTimeouts(fresh, DEFAULT_TIMEOUTS).timedOut)
    const old = { ...fresh, startedAt: Date.now() - DEFAULT_TIMEOUTS.totalTimeout - 1 }
    const t = checkTimeouts(old, DEFAULT_TIMEOUTS)
    ok('④ 总超时可被检出（旁路记录不改变这条判据）', t.timedOut && t.timeoutType === 'total', JSON.stringify(t))
  }
}

main().then(() => {
  globalThis.fetch = realFetch
  setUsageSink(null)
  console.log(`\nlifecycleWiring: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
