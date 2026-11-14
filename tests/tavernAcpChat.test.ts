// ============ 3.5.5 · 酒馆 ACP 通道适配器专项（假 Agent）============
//
// 酒馆有 15 处 `deps.chatFn ?? chat`。本文件盯的是**这一层适配**是否正确，
// 而不是逐个入口重测酒馆业务（那些由 tavern* 系列既有用例覆盖）。
//
// 重点四件事：
//   ① 多轮 messages 拼成单段文本的口径（system 合并保序、角色标记、当前指令标记）；
//   ② 走 ACP 时**不需要 API 模型配置**，且不回落 `chat`；
//   ③ 服务端 JSON 模式不可用 ⇒ 只能写文字要求，**不放宽**调用方解析；
//   ④ 一轮多次调用共用一次授权（`createTavernConsent`），跨轮必须重新问。
import fs from 'node:fs'
import path from 'node:path'
import { makeTavernAcpChat, renderTavernPrompt, createTavernConsent } from '../src/lib/tavern/acpChat'
import { ACP_TAVERN_SYSTEM_HEADER, ACP_TAVERN_CURRENT_HEADER } from '../src/lib/tavern/acpChat'
import type { AIProvider } from '../src/lib/ai'

let pass = 0, fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

type Request = { id: string; task: string; generation: string; text: string }
const requests: Request[] = []
let generation = 'gen-1'
let generateImpl: (r: Request) => Promise<{ ok: boolean; text?: string; error?: string }> =
  async () => ({ ok: true, text: '好的。' })
let chunkSubscribers: ((chunk: { id: string; delta: string }) => void)[] = []

const fakeBridge = {
  status: async () => ({
    generation, selected: 'fake-agent',
    adapters: [{ id: 'fake-agent', name: '假 Agent', available: true }], ready: true,
  }),
  generate: async (request: Request) => {
    requests.push(request)
    return generateImpl(request)
  },
  cancel: async () => true,
  onChunk: (fn: (chunk: { id: string; delta: string }) => void) => {
    chunkSubscribers.push(fn)
    return () => { chunkSubscribers = chunkSubscribers.filter(x => x !== fn) }
  },
}

const g = globalThis as unknown as { window?: Record<string, unknown> }
g.window = {
  electronAgentHost: {
    modeStatus: async () => ({
      phase: 'stable', mode: 'acp', reason: '', busy: false, active: { api: 0, agent: 0, acp: 0 },
      ownsLock: false, lock: null, canRecover: false,
    }),
  },
  electronAcp: fakeBridge,
}

const reset = () => { requests.length = 0; generation = 'gen-1' }
const allow = async () => true

/** 假 provider —— 酒馆会把解析出来的模型一并传进来，适配器必须**忽略**它 */
/**
 * 假 provider：baseUrl 故意指向一个不存在的端口 ——
 * 若适配器偷偷回落到 `chat`，这里会直接连不上而失败。
 */
const fakeProvider = {
  id: 'p', name: '假模型', model: 'm', type: 'openai',
  baseUrl: 'http://127.0.0.1:1', apiKey: '', local: false,
} as unknown as AIProvider

function read(rel: string): string {
  try { return fs.readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

async function run() {
  // ---------------------------------------------------------------- 1. 拼接口径
  console.log('--- 1. 多轮 messages → 单段 ACP 输入 ---')
  {
    const prompt = renderTavernPrompt([
      { role: 'system', content: '你是青岚宗的剑修。' },
      { role: 'system', content: '回复不超过 200 字。' },
      { role: 'user', content: '你为何在此？' },
      { role: 'assistant', content: '我在等一个人。' },
      { role: 'user', content: '等谁？' },
    ])
    ok('两条 system 合并到最前且保持原顺序',
      prompt.startsWith(`${ACP_TAVERN_SYSTEM_HEADER}\n你是青岚宗的剑修。\n\n回复不超过 200 字。`), prompt.slice(0, 60))
    ok('历史带角色标记', prompt.includes('用户：你为何在此？') && prompt.includes('助手：我在等一个人。'))
    ok('最后一条用户消息标成当前指令',
      prompt.includes(`${ACP_TAVERN_CURRENT_HEADER}\n用户：等谁？`), prompt.slice(-60))
    ok('当前指令只出现一次', (prompt.match(new RegExp(ACP_TAVERN_CURRENT_HEADER, 'g')) ?? []).length === 1)

    const noTail = renderTavernPrompt([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A1' },
    ])
    ok('末条是 assistant 时不加当前指令标记', !noTail.includes(ACP_TAVERN_CURRENT_HEADER))

    const empty = renderTavernPrompt([{ role: 'user', content: '   ' }])
    ok('全空消息 ⇒ 空串（调用方据此报错，不白跑一次）', empty === '')

    const blankTail = renderTavernPrompt([
      { role: 'user', content: '说点什么' },
      { role: 'system', content: '  ' },
    ])
    ok('空白 system 被跳过，不产生空段', !blankTail.includes(`${ACP_TAVERN_SYSTEM_HEADER}\n\n`))

    const noSystem = renderTavernPrompt([{ role: 'user', content: '只有一句话' }])
    ok('没有 system 时不产生空标题段', !noSystem.includes(ACP_TAVERN_SYSTEM_HEADER), noSystem)
  }

  // ---------------------------------------------------------------- 2. 走 ACP 不走 chat
  console.log('--- 2. 走 ACP，不需要 API 配置 ---')
  {
    reset()
    generateImpl = async () => ({ ok: true, text: '（假回复）' })
    const runChat = makeTavernAcpChat({
      generation, agentName: '假 Agent', task: 'tavern-reply',
      scopeText: '本场对话历史与角色设定', purpose: '生成本轮剧情回复',
      ask: allow,
    })
    const out = await runChat(fakeProvider, [
      { role: 'system', content: '你是剑修。' },
      { role: 'user', content: '你好' },
    ])
    ok('返回 Agent 文本', out === '（假回复）', out)
    ok('请求走了 ACP 且任务标识为 tavern-reply', requests.length === 1 && requests[0].task === 'tavern-reply')
    ok('发出去的是拼好的单段文本', requests[0].text.includes('用户：你好'))
    ok('代次与当前代次一致', requests[0].generation === 'gen-1')

    // 假 provider 的 baseUrl 指向不存在的端口：若适配器偷偷回落 chat，这里会失败
    const degraded = await runChat(fakeProvider, [{ role: 'user', content: '再来' }])
    ok('🔴 不回落 chat（provider 不可达也能出结果）', degraded === '（假回复）')
    ok('两次都只走 ACP', requests.length === 2)
  }

  // ---------------------------------------------------------------- 3. JSON 只能靠文字要求
  console.log('--- 3. 结构化任务：只加文字要求，不放宽解析 ---')
  {
    reset()
    generateImpl = async () => ({ ok: true, text: '{"hp":80}' })
    const runChat = makeTavernAcpChat({
      generation, agentName: '假 Agent', task: 'tavern-vars',
      scopeText: '本轮两条对话与数值项', purpose: '结算本场数值',
      ask: allow,
    })
    await runChat(fakeProvider, [{ role: 'user', content: '结算' }], { json: true })
    ok('json: true ⇒ prompt 追加输出格式要求', requests[0].text.includes('【输出格式】'), requests[0].text.slice(-80))

    reset()
    await runChat(fakeProvider, [{ role: 'user', content: '结算' }], { output: 'json-object' })
    ok('output: json-object 同样追加', requests[0].text.includes('【输出格式】'))

    reset()
    await runChat(fakeProvider, [{ role: 'user', content: '写正文' }])
    ok('纯文本任务不追加格式要求', !requests[0].text.includes('【输出格式】'))

    // 温度/推理档位在这里传什么都不生效 —— 源码里必须写清楚，不能假装遵守
    const src = read('src/lib/tavern/acpChat.ts')
    ok('🔴 注释如实说明「不认温度与推理档位」', src.includes('不认温度与推理档位'))
    ok('🔴 注释如实说明「单轮压缩多轮」是降级不是等价', src.includes('单轮') && src.includes('不是等价'))
  }

  // ---------------------------------------------------------------- 4. 流式与取消
  console.log('--- 4. 流式与取消 ---')
  {
    reset()
    generateImpl = async () => {
      // 模拟运行层推块：先推两段，再返回完整文本
      for (const s of ['雨', '夜']) for (const fn of chunkSubscribers) fn({ id: requests[requests.length - 1].id, delta: s })
      return { ok: true, text: '雨夜' }
    }
    const runChat = makeTavernAcpChat({
      generation, agentName: '假 Agent', task: 'tavern-reply',
      scopeText: '本场对话', purpose: '回复', ask: allow,
    })
    let streamed = ''
    const out = await runChat(fakeProvider, [{ role: 'user', content: '开始' }], { onToken: d => { streamed += d } })
    ok('onToken 收到流式增量（打字效果保留）', streamed === '雨夜', JSON.stringify(streamed))
    ok('最终返回完整文本', out === '雨夜')

    // 取消：确认框点取消 ⇒ 抛「已取消发送。」，且**不发请求**
    reset()
    const deny = async () => false
    const cancelled = makeTavernAcpChat({
      generation, agentName: '假 Agent', task: 'tavern-reply',
      scopeText: '本场对话', purpose: '回复', ask: deny,
    })
    let thrown = ''
    try { await cancelled(fakeProvider, [{ role: 'user', content: '不要发' }]) } catch (e) { thrown = (e as Error).message }
    ok('拒绝授权 ⇒ 抛「已取消发送。」（不是静默成功）', thrown === '已取消发送。', thrown)
    ok('拒绝授权 ⇒ 一个请求都没发', requests.length === 0)

    // signal 透传：已 abort 的 signal 必须在发送前就拦住
    reset()
    const ac = new AbortController(); ac.abort()
    const allowed = makeTavernAcpChat({
      generation, agentName: '假 Agent', task: 'tavern-reply',
      scopeText: '本场对话', purpose: '回复', ask: allow,
    })
    let aborted = false
    try { await allowed(fakeProvider, [{ role: 'user', content: 'x' }], { signal: ac.signal }) } catch { aborted = true }
    ok('已取消的 signal ⇒ 抛错而不是照发', aborted)
    ok('已取消的 signal ⇒ 没有请求发出', requests.length === 0)
  }

  // ---------------------------------------------------------------- 5. 一轮一次授权
  console.log('--- 5. 授权次数（一轮一次，跨轮重问）---')
  {
    let asked = 0
    const consent = createTavernConsent(async () => { asked++; return true })

    reset()
    generateImpl = async () => ({ ok: true, text: 'ok' })
    const reply = makeTavernAcpChat({
      generation, agentName: 'A', task: 'tavern-reply', scopeText: 's', purpose: 'p', ask: consent,
    })
    const vars = makeTavernAcpChat({
      generation, agentName: 'A', task: 'tavern-vars', scopeText: 's', purpose: 'p', ask: consent,
    })
    await reply(fakeProvider, [{ role: 'user', content: '一' }])
    await vars(fakeProvider, [{ role: 'user', content: '二' }])
    ok('🔴 主回复 + 数值结算共用一次授权（只问一次）', asked === 1, String(asked))
    ok('两次请求都发出去了', requests.length === 2)

    // 跨轮必须重问：新 consent ⇒ 再问一次
    const consent2 = createTavernConsent(async () => { asked++; return true })
    const reply2 = makeTavernAcpChat({
      generation, agentName: 'A', task: 'tavern-reply', scopeText: 's', purpose: 'p', ask: consent2,
    })
    await reply2(fakeProvider, [{ role: 'user', content: '三' }])
    ok('🔴 新一轮重新确认（问过不等于永久免确认）', asked === 2, String(asked))

    // 拒绝后同一份 consent 必须保持「拒绝」，不能第二次偷偷放行
    let asked3 = 0
    const denyOnce = createTavernConsent(async () => { asked3++; return false })
    const blocked = makeTavernAcpChat({
      generation, agentName: 'A', task: 'tavern-vars', scopeText: 's', purpose: 'p', ask: denyOnce,
    })
    reset()
    for (let i = 0; i < 2; i++) {
      try { await blocked(fakeProvider, [{ role: 'user', content: 'x' }]) } catch { /* 预期 */ }
    }
    ok('拒绝只问一次，且后续调用仍被拒（不偷偷放行）', asked3 === 1 && requests.length === 0, `asked=${asked3} req=${requests.length}`)
  }

  // ---------------------------------------------------------------- 6. 主进程白名单与界面契约
  console.log('--- 6. 白名单与界面契约 ---')
  {
    const main = read('electron/main.cjs')
    for (const task of ['tavern-reply', 'tavern-vars', 'tavern-summary', 'tavern-aux']) {
      ok(`主进程放行 ${task}`, main.includes(`'${task}'`))
    }

    const bridge = read('src/lib/agentHost/acpBridge.ts')
    ok('AcpTask 覆盖酒馆四个标识', bridge.includes("'tavern-reply' | 'tavern-vars' | 'tavern-summary' | 'tavern-aux'"))

    const hook = read('src/components/tavern/useFreeTurn.ts')
    ok('🔴 自由对话按 ACP 就绪放行（未配 API 也能发）', hook.includes('const readyNow = aiReadyNow || acpReady'))
    ok('🔴 就绪与通道同进同退（不是只放行不换通道）', hook.includes('buildChat()') && hook.includes('chatFn: ch.reply'))
    ok('数值结算也走同一通道', hook.includes('chatFn: ch.vars'))
    ok('每轮新建 consent（不跨轮复用）', hook.includes('createTavernConsent(confirmDialog)'))
    ok('门禁提示区分 ACP 与未配模型', hook.includes('ACP 未连接'))
  }

  console.log(`\n=== tavernAcpChat：${pass} passed, ${fail} failed ===`)
  if (fail > 0) process.exit(1)
}

run().catch(e => { console.error(e); process.exit(1) })
