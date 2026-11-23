// ============ 固定采样模型（Kimi k2/k3、o1/o3、gpt-5、deepseek-r1…）============
//
// 【为什么专门一支】2026-11-23 用户实测：接 Kimi 调 kimi-k2.* 一律 400
//   `invalid temperature: only 1 is allowed for this model`。两个原因叠在一起：
//     ① 本项目默认温度 0.85、结构化任务 0.3，而这些模型把采样参数钉死，官方口径是"别传"；
//     ② 400 降级判据把含 `model` 的文案当硬失败（"模型写错了，别重试"），
//        于是连"撤掉温度重发"这一步都走不到 —— 用户直接看到原始 400。
// 这里把两处都钉住，并且**必须包含反例**：普通模型仍要正常发温度，
//   `kimi-k2-instruct` 不能被误当成固定采样（它接受任意温度，官方推荐 0.6）。
//
// 🔴 用真 HTTP 假端点，不打桩 fetch：判据吃的是**响应体文案**，打桩等于自己写自己的标准答案。
import http from 'node:http'
import { usesFixedSampling, shouldDegradeOn400, nextOpenAIFlags } from '../src/lib/aiCore/protocols/shared'
import { openaiChatDriver } from '../src/lib/aiCore/protocols/openaiChat'
import { anthropicDriver } from '../src/lib/aiCore/protocols/anthropic'
import { clearSamplingRejected, isSamplingRejected } from '../src/lib/aiCore/samplingGuard'
import type { AIProvider } from '../src/lib/aiCore/core'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① 模型识别 ----------
const FIXED = [
  'kimi-k2.5', 'kimi-k2.6', 'kimi-k2-0905-preview', 'kimi-k2-turbo-preview',
  'kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'kimi-k3', 'kimi-for-coding',
  'moonshotai/kimi-k2.6',                       // 聚合站前缀
  'o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o4-mini',
  'gpt-5', 'gpt-5-mini',
  'deepseek-r1', 'deepseek-ai/DeepSeek-R1',     // 大小写 / 前缀都要认
  'deepseek-reasoner',
]
const NORMAL = [
  'kimi-k2-instruct', 'kimi-k2-instruct-0905',  // 🔴 接受任意温度，不能被钳
  'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k',
  'kimi-latest',                                 // 未确证 ⇒ 交给 400 降级兜底，不在此强判
  'deepseek-chat', 'deepseek-v3',
  'gpt-4o', 'gpt-4o-mini', 'qwen3-235b-a22b', 'claude-3-7-sonnet', 'gemini-2.5-pro',
  'llama3.1', '',
]
for (const m of FIXED) ok(`固定采样 · ${m}`, usesFixedSampling(m) === true)
for (const m of NORMAL) ok(`普通模型 · ${m || '(空)'} 不钳`, usesFixedSampling(m) === false)

// ---------- ② 400 判据（Kimi 原话必须能降级） ----------
const KIMI_400 = '{"error":{"message":"invalid temperature: only 1 is allowed for this model","type":"invalid_request_error"}}'
ok('Kimi 原话（含 this model）⇒ 允许降级', shouldDegradeOn400(KIMI_400) === true)
ok('模型不存在 ⇒ 不降级', shouldDegradeOn400('model not found: kimi-x') === false)
ok('messages 结构错 ⇒ 不降级', shouldDegradeOn400('invalid messages: role must be one of') === false)
ok('密钥错 ⇒ 不降级', shouldDegradeOn400('invalid api key provided') === false)
ok('额度不足 ⇒ 不降级', shouldDegradeOn400('insufficient quota') === false)
ok('上下文超长 ⇒ 不降级', shouldDegradeOn400('context length exceeded') === false)
ok('空响应体 ⇒ 仍降级（老中转站兼容）', shouldDegradeOn400('') === true)
ok('未知参数 ⇒ 降级', shouldDegradeOn400('unsupported parameter: temperature') === true)

// ---------- ③ 降级顺序：采样被点名时不要先撤思考开关 ----------
{
  const next = nextOpenAIFlags({ thinkToggle: true, sampling: true, format: false }, KIMI_400)
  ok('400 指向温度 ⇒ 直接撤采样', next?.sampling === false, JSON.stringify(next))
  ok('  · 没有先浪费一次"撤思考开关"', next?.thinkToggle === true, JSON.stringify(next))
  const after = nextOpenAIFlags({ thinkToggle: true, sampling: false, format: false }, KIMI_400)
  ok('  · 采样已撤后再报错才轮到思考开关', after?.thinkToggle === false, JSON.stringify(after))
}

// ---------- ④ 端到端：请求体里到底发了什么 ----------
interface Seen { model: string; body: Record<string, unknown> }
const seen: Seen[] = []
/** 端点按"真实规则"拒绝：默认只对固定采样模型拒绝任意温度；用例 C 会临时改成"见温度就拒" */
let rejectTemp = (model: string) => usesFixedSampling(model)

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) } catch { /* 忽略 */ }
    const model = String(body.model ?? '')
    const url = req.url ?? ''
    seen.push({ model, body })

    // —— Anthropic Messages：一律拒绝温度，用来验"作者勾了不发 / 撞一次后不再发" ——
    if (url.includes('/messages')) {
      if ('temperature' in body) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { message: 'temperature: only 1 is allowed for this model' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn' }))
      return
    }

    const hasTemp = 'temperature' in body || 'top_p' in body || 'presence_penalty' in body || 'frequency_penalty' in body
    if (rejectTemp(model) && hasTemp) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid temperature: only 1 is allowed for this model', type: 'invalid_request_error' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      choices: [{ message: { content: '好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }))
  })
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const PORT = (server.address() as { port: number }).port
const ROOT = `http://127.0.0.1:${PORT}/v1`

const providerOf = (model: string, id = 'fake', extra: Partial<AIProvider> = {}): AIProvider => ({
  id, name: '假端点', type: 'openai', protocol: 'openai-chat', local: false,
  baseUrl: ROOT, apiKey: 'test-key', model, ...extra,
})
const reset = () => { seen.length = 0 }

// 用例 A：Kimi（固定采样）⇒ 首次请求就不带温度，一次成功
reset()
{
  const out = await openaiChatDriver.chat(providerOf('kimi-k2.5'), [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 0.85 })
  ok('A · kimi-k2.5 一次成功（不先撞 400）', out.content === '好' && seen.length === 1, `请求 ${seen.length} 次`)
  ok('A · 请求体不含 temperature', !('temperature' in seen[0].body), JSON.stringify(Object.keys(seen[0].body)))
  ok('A · 请求体不含 top_p / 惩罚项', !('top_p' in seen[0].body) && !('presence_penalty' in seen[0].body))
}

// 用例 B：普通模型 ⇒ 温度照发（证明没一刀切）
reset()
{
  await openaiChatDriver.chat(providerOf('deepseek-chat'), [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 0.85 })
  ok('B · deepseek-chat 仍下发 temperature=0.85', seen[0]?.body.temperature === 0.85, JSON.stringify(seen[0]?.body.temperature))
}

// 用例 C：表里没有的模型 + Kimi 风格 400 ⇒ 自动降级（B 兜底）
reset()
rejectTemp = () => true
{
  const out = await openaiChatDriver.chat(providerOf('some-gateway/kimi-pro'), [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 0.85 })
  ok('C · 未识别模型靠 400 降级救回来', out.content === '好' && seen.length === 2, `请求 ${seen.length} 次`)
  ok('C · 第一次带温度、第二次不带', 'temperature' in seen[0].body && !('temperature' in seen[1].body))
}
rejectTemp = (model: string) => usesFixedSampling(model)

// 用例 D：固定采样模型 + 结构化 JSON 任务（温度 0.3）也不能炸
reset()
{
  const out = await openaiChatDriver.chat(providerOf('kimi-k3'), [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 0.3 })
  ok('D · kimi-k3 的 JSON 低温任务同样不带温度', out.content === '好' && !('temperature' in seen[0].body), `请求 ${seen.length} 次`)
}

// ---------- ⑤ 作者开关 / 会话记忆（兜住"模型名认不出"的中转站） ----------
clearSamplingRejected('mb', 'deepseek-chat')
reset()
{
  const cfg = providerOf('deepseek-chat', 'mb', { disableSampling: true })
  const out = await openaiChatDriver.chat(cfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 0.85 })
  ok('E · 勾了「不发送采样参数」⇒ 普通模型也不发温度', out.content === '好' && !('temperature' in seen[0].body), `请求 ${seen.length} 次`)
}

clearSamplingRejected('mem', 'some-relay/kimi-pro-whatever')
rejectTemp = () => true   // 模拟"名字认不出的中转站"：见温度就拒
reset()
{
  const cfg = providerOf('some-relay/kimi-pro-whatever', 'mem')
  const out1 = await openaiChatDriver.chat(cfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 0.85 })
  ok('F1 · 未识别模型第一次：撞 400 后自动降级成功', out1.content === '好' && seen.length === 2, `请求 ${seen.length} 次`)
  ok('F2 · 已记进会话记忆', isSamplingRejected('mem', 'some-relay/kimi-pro-whatever') === true)

  reset()
  const out2 = await openaiChatDriver.chat(cfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 0.85 })
  ok('F3 · 第二次直接不发温度（只打 1 次，不再多花钱）', out2.content === '好' && seen.length === 1, `请求 ${seen.length} 次`)
  ok('F4 · 第二次请求体不含 temperature', !('temperature' in seen[0].body))
}

// 取消勾选 ⇒ 清掉记忆，下次重新真实试一次（否则永远不敢发）
clearSamplingRejected('mem', 'some-relay/kimi-pro-whatever')
ok('G · 清掉记忆后不再被视为"已拒绝"', isSamplingRejected('mem', 'some-relay/kimi-pro-whatever') === false)
rejectTemp = (model: string) => usesFixedSampling(model)

// ---------- ⑥ 三家官方协议同样尊重这个开关（以 Anthropic 为例） ----------
reset()
{
  const cfg: AIProvider = { ...providerOf('claude-test', 'anth', { disableSampling: true }), protocol: 'anthropic' }
  const out = await anthropicDriver.chat(cfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 1.5 })
  ok('H · Anthropic 勾选后不发 temperature', out.content === '好' && !('temperature' in seen[0].body), `请求 ${seen.length} 次`)
}

clearSamplingRejected('anth2', 'claude-thinking')
reset()
{
  const cfg: AIProvider = { ...providerOf('claude-thinking', 'anth2'), protocol: 'anthropic' }
  const out1 = await anthropicDriver.chat(cfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 1.5 })
  ok('I1 · Anthropic 撞 400 后降级救回', out1.content === '好' && seen.length === 2, `请求 ${seen.length} 次`)
  reset()
  const out2 = await anthropicDriver.chat(cfg, [{ role: 'user', content: 'hi' }], { timeoutMs: 8000, temperature: 1.5 })
  ok('I2 · 第二次直接不带温度（记忆生效）', out2.content === '好' && seen.length === 1 && !('temperature' in seen[0].body), `请求 ${seen.length} 次`)
}

server.close()
console.log(`\n———— fixedSampling：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exit(1)
