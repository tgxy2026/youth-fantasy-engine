// 3.2.0 · WQ6 流式停滞 · 单测
//
// 盯三件事（方案 §16.7 验收项「首输出后停滞能结束等待」）：
//   ① 服务端发完几段就不来了 ⇒ **必须**结束等待，不能永久挂住（首 token 后总超时已被清掉）；
//   ② 心跳/注释行不算进展 —— 否则一个 10 秒发一次心跳的端点能让任务无限挂着；
//   ③ 有持续增量时不能误杀（慢模型是常态，不是故障）。
import { readSSE, AIStreamStalledError, isStreamStalled } from '@/lib/aiCore/transport'
import { chat } from '@/lib/ai'
import type { AIProvider } from '@/lib/ai'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const enc = new TextEncoder()

/** 造一个「发完这些片段就再也不动」的响应体（不 close ⇒ reader.read() 永久 pending） */
function stalledBody(parts: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const p of parts) c.enqueue(enc.encode(p)) },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 造一个「按间隔持续发、最后正常结束」的响应体 */
function pacedBody(parts: string[], gapMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      let i = 0
      const tick = () => {
        if (i >= parts.length) { c.close(); return }
        c.enqueue(enc.encode(parts[i++]))
        setTimeout(tick, gapMs)
      }
      tick()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const line = (s: string) => `data: ${JSON.stringify({ message: { content: s } })}\n`
/** OpenAI 兼容格式的增量行（chat() 的 openai 通道读 choices[0].delta.content） */
const oline = (s: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n`

const OPENAI: AIProvider = {
  id: 'oa', name: '云端兼容', type: 'openai', baseUrl: 'https://example.test/v1',
  apiKey: 'k', model: 'm', local: false,
}

async function main() {
  // ---------- 一、发完就停 ⇒ 结束等待 ----------
  {
    const got: string[] = []
    let err: unknown = null
    try {
      await readSSE(
        stalledBody([line('第一段'), line('第二段')]),
        obj => got.push((obj as { message: { content: string } }).message.content),
        undefined,
        { idleTimeoutMs: 60 },
      )
    } catch (e) { err = e }

    ok('① 停滞 ⇒ 抛 AIStreamStalledError（不再永久挂住）', isStreamStalled(err), String(err))
    const se = err as AIStreamStalledError
    ok('① 已收到的内容照常回调（片段不丢）', got.length === 2, JSON.stringify(got))
    ok('① 错误里记得住"收到了几段"', se.chunksBeforeStall === 2, String(se.chunksBeforeStall))
    ok('① 错误措辞是"停滞"而不是笼统的"超时"',
      /停滞/.test(se.message) && se.message.includes('2 段'), se.message)
  }

  // ---------- 二、心跳不算进展 ----------
  {
    let err: unknown = null
    try {
      await readSSE(
        stalledBody([': ping\n', ': keep-alive\n']),
        () => { throw new Error('心跳行不该被当成内容') },
        undefined,
        { idleTimeoutMs: 60 },
      )
    } catch (e) { err = e }
    ok('🔴 ② 只发心跳也算停滞（不能让心跳无限续命）', isStreamStalled(err), String(err))
    ok('② 心跳时记的是"一段内容都没来"', (err as AIStreamStalledError).chunksBeforeStall === 0)
    ok('② 措辞说明"没有返回任何内容"', /没有返回任何内容/.test((err as Error).message), (err as Error).message)
  }

  // ---------- 三、持续有增量 ⇒ 不误杀 ----------
  {
    let err: unknown = null
    let count = 0
    try {
      await readSSE(
        pacedBody([line('a'), line('b'), line('c'), line('d'), line('e')], 20),
        () => { count++ },
        undefined,
        { idleTimeoutMs: 60 }, // 总时长 100ms > 60ms，但每 20ms 就有进展
      )
    } catch (e) { err = e }
    ok('🔴 ③ 有持续增量时不误判停滞（慢模型不该被一刀切）', err === null, String(err))
    ok('③ 五段全部收到', count === 5, String(count))
  }

  // ---------- 四、不传空闲超时 ⇒ 保持旧行为 ----------
  {
    const p = readSSE(stalledBody([line('a')]), () => {}, undefined, {})
      .then(() => 'resolved', () => 'rejected')
    const raced = await Promise.race([
      p,
      new Promise<string>(r => setTimeout(() => r('pending'), 120)),
    ])
    ok('④ 不传 idleTimeoutMs ⇒ 不判定停滞（与 3.1.x 行为一致，不悄悄改语义）', raced === 'pending', raced)
  }

  // ---------- 五、chat() 端到端：错误不被错译成"超时" ----------
  {
    const real = globalThis.fetch
    let err: unknown = null
    try {
      globalThis.fetch = (async () => stalledBody([oline('前半段')])) as unknown as typeof fetch
      await chat(OPENAI, [{ role: 'user', content: 'hi' }], {
        onToken: () => {},
        timeoutMs: 5000,
        idleTimeoutMs: 60,
      })
    } catch (e) { err = e } finally { globalThis.fetch = real }
    ok('🔴 ⑤ chat() 把停滞原样抛出（不翻译成"接口响应超时"）', isStreamStalled(err), String(err))
    ok('⑤ 作者能看到"已收到 1 段后停滞"', /停滞/.test((err as Error).message), (err as Error).message)
    // 3.2.0 · WQ1 贯通：chat() 必须把已收片段挂在错误上（否则调用方无从「保留片段标 incomplete」）
    ok('🔴 ⑤ chat() 停滞错误带 partialText（片段随错误带出，不当场丢失）',
      (err as AIStreamStalledError).partialText === '前半段', JSON.stringify((err as AIStreamStalledError).partialText))
  }

  // ---------- 五b、askSoft 不吞停滞（WQ1 贯通） ----------
  {
    const real = globalThis.fetch
    let err: unknown = null
    try {
      globalThis.fetch = (async () => stalledBody([oline('写了半截')])) as unknown as typeof fetch
      const cfg = { ...OPENAI, type: 'openai' } as const
      const { askSoft } = await import('@/lib/editor/wordRange')
      await askSoft(cfg, 'sys', 'user', { signal: undefined as unknown as AbortSignal })
    } catch (e) { err = e } finally { globalThis.fetch = real }
    ok('🔴 ⑤b askSoft 不把停滞吞成空串（空串＝伪装成"模型没吐内容"）', isStreamStalled(err), String(err))
    ok('⑤b askSoft 上抛的停滞带片段', isStreamStalled(err) && (err as AIStreamStalledError).partialText === '写了半截',
      JSON.stringify(isStreamStalled(err) ? (err as AIStreamStalledError).partialText : null))
  }

  // ---------- 六、闸：生产路径必须真的传空闲超时 ----------
  {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/lib/aiCore/chat.ts', 'utf8')
    const hits = src.split('idleTimeoutMs: o.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS').length - 1
    ok('⑥ 两条通道都传了空闲超时（漏一条就等于那条会永久挂住）', hits === 2, String(hits))
    // 🔴 断了「两处各写一个数字」的漂移：传输层只是给真源起个名字，真源在 `ai/streaming`
    const tp = readFileSync('src/lib/aiCore/transport.ts', 'utf8')
    const sm = readFileSync('src/lib/ai/streaming.ts', 'utf8')
    ok('⑥ 空闲超时只有一个真源（传输层引用 DEFAULT_TIMEOUTS，不另写数字）',
      /STREAM_IDLE_TIMEOUT_MS = DEFAULT_TIMEOUTS\.idleTimeout/.test(tp) && !/STREAM_IDLE_TIMEOUT_MS = \d/.test(tp))
    ok('⑥ 真源取 120 秒（方案 §16.7 的初始建议）', /idleTimeout: 120_000/.test(sm))
  }

  console.log(`\n———— streamStall：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
