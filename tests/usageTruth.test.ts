// ============ 3.2.0 · WQ7：真实 token 用量 ============
//
// MQ0 §16.8 记的缺口：「usage 真实性：chat.ts 成功上报未提取真实 token」。
// 本用例盯三件事：
//   ① 两条通道各自的字段被正确提取（Ollama prompt_eval_count/eval_count；
//      OpenAI 兼容 usage.prompt_tokens/completion_tokens）；
//   ② 拿不到真实值时**退回估算并标注** `tokensEstimated`（不许把估算冒充厂商账单）；
//   ③ 结束原因（finish_reason / done_reason）随用量一起带回。
import { setUsageSink, type ChatUsage } from '@/lib/aiCore/usage'
import { usageFromOllama, usageFromOpenAI, usageFromStreamChunk, mergeUsage, hasRealUsage } from '@/lib/aiCore/usageParse'
import { chat } from '@/lib/aiCore/chat'
import type { AIProvider } from '@/lib/aiCore/core'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const realFetch = globalThis.fetch

/** 用一次性 fetch 桩跑一次 chat，返回捕获到的用量 */
async function chatWithStub(
  provider: Partial<AIProvider>,
  payload: unknown,
  opts: { sse?: boolean } = {},
): Promise<ChatUsage | null> {
  const captured: ChatUsage[] = []
  setUsageSink(u => captured.push(u))
  const body = opts.sse
    ? `data: ${JSON.stringify(payload)}\n\n`
    : JSON.stringify(payload)
  globalThis.fetch = (async () => new Response(body, {
    status: 200,
    headers: { 'Content-Type': opts.sse ? 'text/event-stream' : 'application/json' },
  })) as unknown as typeof fetch
  try {
    await chat(
      { id: 'p', name: 'stub', type: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'stub', ...provider } as AIProvider,
      [{ role: 'user', content: '你好' }],
    )
  } catch {
    // 桩数据可能不足以走完全程；用量是否上报由调用方断言
  } finally {
    globalThis.fetch = realFetch
    setUsageSink(null)
  }
  return captured[0] ?? null
}

async function main() {
  // ────────────────────────── ① 字段提取 ──────────────────────────
  {
    const o = usageFromOllama({ prompt_eval_count: 123, eval_count: 45, done_reason: 'stop' })
    ok('① Ollama：prompt_eval_count → promptTokens', o.promptTokens === 123)
    ok('① Ollama：eval_count → completionTokens', o.completionTokens === 45)
    ok('① Ollama：done_reason → finishReason', o.finishReason === 'stop')

    const g = usageFromOpenAI({ usage: { prompt_tokens: 200, completion_tokens: 80 }, choices: [{ finish_reason: 'length' }] })
    ok('① OpenAI：prompt_tokens → promptTokens', g.promptTokens === 200)
    ok('① OpenAI：completion_tokens → completionTokens', g.completionTokens === 80)
    ok('① OpenAI：finish_reason → finishReason', g.finishReason === 'length')

    ok('① 缺字段 ⇒ 不编数字', !hasRealUsage(usageFromOllama({})) && !hasRealUsage(usageFromOpenAI({})))
    ok('① 非法值（负数/NaN/字符串）一律不采信',
      !hasRealUsage(usageFromOllama({ prompt_eval_count: -1, eval_count: Number.NaN }))
      && !hasRealUsage(usageFromOpenAI({ usage: { prompt_tokens: '200' } })))

    const merged = mergeUsage({ promptTokens: 1 }, { completionTokens: 2, finishReason: 'stop' })
    ok('① 流式分块合并保留两边', merged.promptTokens === 1 && merged.completionTokens === 2 && merged.finishReason === 'stop')
    ok('① 流式块按通道取字段',
      usageFromStreamChunk({ prompt_eval_count: 9 }, 'ollama').promptTokens === 9
      && usageFromStreamChunk({ usage: { completion_tokens: 7 } }, 'openai').completionTokens === 7)
  }

  // ────────────────────────── ② 真实用量优先 ──────────────────────────
  {
    const u = await chatWithStub({}, {
      message: { content: '好的' },
      prompt_eval_count: 321,
      eval_count: 12,
      done_reason: 'stop',
    })
    ok('🔴 有真实计数 ⇒ 上报真实值（不是估算）', u?.promptTokens === 321 && u?.completionTokens === 12, JSON.stringify(u))
    ok('🔴 真实值不打估算标', u?.tokensEstimated !== true, JSON.stringify(u))
    ok('② 结束原因一并上报', u?.finishReason === 'stop', JSON.stringify(u))
  }

  // ────────────────────────── ③ 拿不到 ⇒ 估算 + 标注 ──────────────────────────
  {
    const u = await chatWithStub({}, { message: { content: '好的' } })
    ok('③ 无计数 ⇒ 退回估算值', typeof u?.promptTokens === 'number' && u.promptTokens > 0, JSON.stringify(u))
    ok('🔴 估算必须打标（不能冒充厂商账单）', u?.tokensEstimated === true, JSON.stringify(u))
    ok('③ 估算时输出侧留空（不编一个字数）', u?.completionTokens === undefined, JSON.stringify(u))
  }

  // ────────────────────────── ④ OpenAI 兼容通道 ──────────────────────────
  {
    const u = await chatWithStub({ type: 'openai' }, {
      choices: [{ message: { content: '好的' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 88, completion_tokens: 9 },
    })
    ok('④ OpenAI 通道同样提取真实用量', u?.promptTokens === 88 && u?.completionTokens === 9, JSON.stringify(u))
    ok('④ OpenAI 通道不打估算标', u?.tokensEstimated !== true, JSON.stringify(u))
  }
}

main().then(() => {
  setUsageSink(null)
  globalThis.fetch = realFetch
  console.log(`\nusageTruth: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})
