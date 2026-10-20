// ============ 复核：思考模式的开关策略（2026-10-03） ============
//
// 复核结论：原先只有十来处显式 `think: false`，而 `json: true` 的结构化任务有 32 处 ——
// 其余在本地 Ollama 路径上**一直开着思考**。而实测（本文件上方注释）本地思考型模型
// 思考开 ⇒ 50.5s / 思考链 12687 字 / **content 只剩 271 字且被截断** ⇒ JSON 必残。
// 所以统一在 `chat()` 归一：**JSON 任务默认关思考，长文创作保持思考**。
// 本测试用桩 fetch 抓真实请求体，把四条策略钉死。
import { chat } from '../src/lib/ai'
import type { AIProvider } from '../src/lib/ai'
import { readAiModule, readAllSrc } from './sourceScan'
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (n: string, c: boolean, e = '') => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, '::', e) } }

const OLLAMA: AIProvider = {
  id: 'ollama-test', name: '本地 Ollama', type: 'ollama',
  baseUrl: 'http://127.0.0.1:11434', apiKey: '', model: 'qwen3:8b', local: true,
}

/** 抓一次请求体（桩 fetch，非流式 → 返回 message.content） */
async function captureBody(opts: Parameters<typeof chat>[2]): Promise<Record<string, unknown>> {
  const real = globalThis.fetch
  let body: Record<string, unknown> = {}
  try {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body ?? '{}'))
      return new Response(JSON.stringify({ message: { content: 'ok' } }), { status: 200 })
    }) as unknown as typeof fetch
    await chat(OLLAMA, [{ role: 'user', content: 'hi' }], { timeoutMs: 5000, ...opts })
  } finally {
    globalThis.fetch = real
  }
  return body
}

async function main() {
  // ① JSON 任务 ⇒ 明确下发 think:false（本次调优的核心）
  const j = await captureBody({ json: true })
  ok('🔴 JSON 任务下发 think:false（本地思考型模型不再截断 JSON）', j.think === false, JSON.stringify(j))

  // ② 长文创作（无 json）⇒ 不下发该字段，保持模型默认
  const t = await captureBody({})
  ok('🔴 长文创作不下发 think（思考型模型照旧思考）', t.think === undefined, JSON.stringify(t))

  // ③ 逃生口：显式 think:true ⇒ 也不下发（等于保持模型默认 = 保留思考）
  const e = await captureBody({ json: true, think: true })
  ok('显式 think:true 是逃生口（不下发字段，保留思考）', e.think === undefined, JSON.stringify(e))
  const e2 = await captureBody({ json: true, think: false })
  ok('显式 think:false 也照样关', e2.think === false, JSON.stringify(e2))

  // ④ 温度口径没被这次改动带偏：JSON 走低温、长文走 provider 默认
  const tempOf = (b: Record<string, unknown>) => (b.options as { temperature?: number } | undefined)?.temperature
  ok('JSON 任务仍是低温 0.3', tempOf(j) === 0.3, JSON.stringify(j.options))
  ok('长文任务不受 JSON 低温影响', typeof tempOf(t) === 'number' && tempOf(t) !== 0.3, JSON.stringify(t.options))

  // ⑤ 策略写在统一入口，不在各调用点各写一份
  // 🔴 读**整个 ai 模块**（门面 + aiCore/*）：think 归中规则随拆分搬进了 aiCore/chat.ts，
  //    只读门面会静默失明（2026-10-04 踩过）。
  const src = readAiModule()
  // 🔴 断言语义而不是字面量：3.2.0 · WQ5 把「要不要思考」的判定搬进了
  //    `ai/outputProtocol.ts`（与「要不要 JSON」解耦后必然如此），chat() 只负责调用它。
  //    这里钉两件事：① chat() 确实走协议解析；② 判据只有那一处（不许在 chat() 里另写一份）。
  ok('🔴 归中规则在 chat() 入口一处（经 outputProtocol.resolveOutputProtocol）',
    /resolveOutputProtocol\(/.test(src) && /const think = protocol\.think/.test(src)
    && !/opts\.json \? false : undefined/.test(src))
  // 🔴 判据文件不属 `readAiModule()` 的范围（它只读门面 + aiCore/*），所以单独读 ——
  //    别为了这一条去改 `readAiModule`，那会牵动其它十几道闸的取证范围。
  const protoSrc = readFileSync('src/lib/ai/outputProtocol.ts', 'utf8')
  ok('🔴 think 判据只在 outputProtocol 一处（think=false/true/undefined 由 reasoning 推）',
    /reasoning === 'off'/.test(protoSrc) && /const think = d\.think !== undefined/.test(protoSrc))
  ok('🔴 ollama 路径只认 ===false（true 与 undefined 都不下发）', /if \(think === false\) body\.think = false/.test(src))

  // ⑥ 结构化任务盘点：**真实扫描**（原写法 `const jsonCount = 32; ok(..., jsonCount === 32)`
  //    是自己和自己比，永远为真 —— 典型的假绿，2026-10-20 自查改掉）
  // 🔴 这是个**棘轮**（只许降，不许升）：WQ5 每迁一处 `json:true` → 显式 `output/reasoning`，
  //    就把 BASELINE 调小；数字**超过**基线说明有人又加回了旧写法，需要重走一次协议声明。
  //    2026-10-20 第二次迁移：43 → 13（剩下的是 chat() 兼容包装 1 处 + 6 处酒馆
  //    （红线文档缺失，未动）+ 6 处注释）。
  const countJson = (src: string) => src.split('json: true').length - 1
  const jsonCount = countJson(readAllSrc())
  const JSON_BASELINE = 13
  ok(`结构化任务旧写法只许减少（当前 ${jsonCount} 处 json:true，上限 ${JSON_BASELINE}）`,
    jsonCount <= JSON_BASELINE, String(jsonCount))

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed')
  if (fail > 0) process.exit(1)
}
main().catch(e => { console.log('FAIL 未捕获异常:', e?.stack ?? e); process.exit(1) })
