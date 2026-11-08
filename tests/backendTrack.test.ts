// ============ 3.4.3 · P4：后端轨契约 / 三轨路由 / 注册表 / chat() 显式闸 ============
//
// P1 隔离原型（.workbuddy/tmp/p1-agent-track-343）结论的产品化回归：
//   ① 未配置 / 未显式选择 ⇒ 保底轨纯透传（逐字一致）；
//   ② 自动静默 / 无人值守 ⇒ 永不路由 Agent（条款硬闸）；
//   ③ 能力不足 / json-string ⇒ 跳过留痕，绝不静默返回空；
//   ④ text 只拼 message 事件（plan/tool/diff 过程文本结构上混不进正文）；
//   ⑤ 增强轨仅手动 + 显式；产物是 descriptor，回写走导入通道；
//   ⑥ 取消保留已收片段；暂停恢复不重复发事件；
//   ⑦ 额度口径：订阅 / 按量分开记账（路由账本 + 用量账本）。
// chat() 闸用真本机 HTTP 假端点（照 protocolDegrade 的先例，不打桩 fetch）。
import assert from 'node:assert/strict'
import http from 'node:http'
import { chat } from '../src/lib/aiCore/chat'
import { setUsageSink, type ChatUsage } from '../src/lib/aiCore/usage'
import { isCancelled } from '../src/lib/aiCore/transport'
import { defineAgentBackend, assertBackendCapabilities, type BackendArtifact, type BackendEvent, type BackendSession, type BackendTask, type RecordedBackendEvent } from '../src/lib/aiCore/backend/contract'
import { createBackendRouter, BackendTrackSkipError, type AgentRunResult, type RouteCall, type RouteLedgerEntry } from '../src/lib/aiCore/backend/router'
import { registerAgentBackend, unregisterAgentBackend, getAgentBackend, listAgentBackends, backendTrackStatus } from '../src/lib/aiCore/backend/registry'
import type { DriverCapabilities } from '../src/lib/aiCore/protocols/contract'
import type { AIProvider } from '../src/lib/aiCore/core'

let pass = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { console.error(`FAIL ${name}${extra ? ' :: ' + extra : ''}`); process.exitCode = 1 }
}

// ---------- 受控假 Agent（脚本驱动；暂停/恢复/取消语义与 P1 原型一致） ----------
const AGENT_CAPS: DriverCapabilities = { stream: true, cancel: true, multiTurn: true, embedding: false, latency: 'high', unattended: false, quota: 'subscription' }

function fakeBackend(script: BackendEvent[], caps?: Partial<DriverCapabilities>, id = 'fake-agent') {
  const sessions: BackendSession[] = []
  const backend = defineAgentBackend({
    id, label: `假 Agent ${id}`,
    capabilities: { ...AGENT_CAPS, ...caps },
    async createSession(task: BackendTask) {
      let cursor = 0
      let draining = false
      const waiters: (() => void)[] = []
      const session = {
        id: `s${sessions.length + 1}`, taskId: task.id, state: 'open',
        events: [] as RecordedBackendEvent[], artifacts: [] as BackendArtifact[],
        sent: [] as string[],
        emit(event: BackendEvent) {
          this.events.push({ ...event, sessionId: this.id, at: this.events.length } as RecordedBackendEvent)
          if (event.kind === 'artifact') this.artifacts.push(event.artifact)
        },
        async drain() {
          if (draining) return
          draining = true
          try {
            while (cursor < script.length && this.state === 'open') {
              this.emit(script[cursor++])
              await new Promise(r => setTimeout(r, 1))
              if ((this.state as string) === 'paused') await new Promise<void>(resolve => waiters.push(resolve))
            }
            if (this.state === 'open') {
              (this as { state: string }).state = 'finished'
              this.emit({ kind: 'state', text: 'finished' })
            }
          } finally { draining = false }
        },
        async send(text: string) {
          if (this.state !== 'open') throw new Error(`状态 ${this.state} 不能 send`)
          this.sent.push(text)
          await this.drain()
          return { events: this.events, artifacts: this.artifacts }
        },
        pause() {
          if (this.state !== 'open') throw new Error('不能 pause')
          ;(this as { state: string }).state = 'paused'
          this.emit({ kind: 'state', text: 'paused' })
        },
        resume() {
          if (this.state !== 'paused') throw new Error('不能 resume')
          ;(this as { state: string }).state = 'open'
          this.emit({ kind: 'state', text: 'open' })
          while (waiters.length) waiters.shift()!()
        },
        cancel() {
          if (this.state === 'closed') return
          ;(this as { state: string }).state = 'cancelled'
          this.emit({ kind: 'state', text: 'cancelled' })
          while (waiters.length) waiters.shift()!()
        },
        close() { (this as { state: string }).state = 'closed' },
      }
      sessions.push(session as unknown as BackendSession)
      return session as unknown as BackendSession
    },
  })
  return { backend, sessions }
}

const TEXT_SCRIPT: BackendEvent[] = [
  { kind: 'plan', text: '拆解任务' },
  { kind: 'tool', text: 'read_chapters' },
  { kind: 'message', text: '正文甲' },
  { kind: 'diff', text: '建议修改' },
  { kind: 'message', text: '正文乙' },
  { kind: 'artifact', artifact: { kind: 'suggestions', path: '建议.md' } },
]
const MSG = [{ role: 'user' as const, content: '写点什么' }]

// ============ ① 契约校验 ============
{
  assert.throws(() => assertBackendCapabilities({ ...AGENT_CAPS, quota: 'free' as never }, 'x'), /quota 非法/)
  const { quota, ...partial } = AGENT_CAPS
  assert.throws(() => assertBackendCapabilities(partial as never, 'x'), /缺键/)
  assert.throws(() => assertBackendCapabilities({ ...AGENT_CAPS, cancel: 'yes' as never }, 'x'), /必须是布尔值/)
  ok('契约校验：缺键 / 非法枚举即抛', true)
}

// ============ ② 注册表 ============
{
  ok('注册表出厂为空（未配置如实）', backendTrackStatus().available === false && listAgentBackends().length === 0)
  const { backend } = fakeBackend(TEXT_SCRIPT)
  registerAgentBackend(backend)
  ok('注册后可查、状态如实', getAgentBackend('fake-agent') === backend && backendTrackStatus().backends[0].quota === 'subscription')
  assert.throws(() => registerAgentBackend(backend), /重复注册/)
  unregisterAgentBackend('fake-agent')
  assert.throws(() => unregisterAgentBackend('fake-agent'), /未注册/)
  ok('重复注册 / 注销不存在均抛，不静默', backendTrackStatus().available === false)
}

// ============ ③ 路由：保底轨透传与硬闸 ============
{
  const calls: unknown[] = []
  const runBaseline = async (call: RouteCall) => { calls.push(call); return '协议轨回文' }
  const { backend } = fakeBackend(TEXT_SCRIPT)
  const ledger: RouteLedgerEntry[] = []
  const router = createBackendRouter<string>({ runBaseline, baselineQuota: 'metered', agentBackend: backend, ledger })

  const r1 = await router.route({ id: 't1', kind: 'long-text', consumes: 'text' }, { messages: MSG })
  ok('未显式选择 ⇒ 保底轨纯透传（配置了 Agent 也一样）', r1.track === 'baseline' && r1.result === '协议轨回文' && calls.length === 1)
  ok('保底轨账本记按量口径', ledger.at(-1)!.quota === 'metered' && ledger.at(-1)!.action === 'ran')

  const r2 = await router.route({ id: 't2', kind: 'auto-silent', consumes: 'text', select: 'agent' }, { messages: MSG })
  ok('自动静默链显式选 Agent 也强制保底', r2.track === 'baseline' && calls.length === 2)
  const r3 = await router.route({ id: 't3', kind: 'long-text', consumes: 'text', select: 'agent', requires: { unattended: true } }, { messages: MSG })
  ok('requires.unattended ⇒ 强制保底', r3.track === 'baseline')

  const r4 = await router.route({ id: 't4', kind: 'sync-json', consumes: 'json-string', select: 'agent' }, { messages: MSG })
  ok('json-string 硬闸：跳过留痕 agent-no-clean-json', r4.action === 'skipped' && r4.reason === 'agent-no-clean-json' && r4.result === null && ledger.at(-1)!.action === 'skipped')

  const r5 = await router.route({ id: 't5', kind: 'long-text', consumes: 'text', select: 'agent', requires: { embedding: true } }, { messages: MSG })
  ok('能力不足 ⇒ 跳过留痕 missing-capabilities', r5.action === 'skipped' && r5.reason === 'missing-capabilities:embedding')

  const r6 = await router.route({ id: 't6', kind: 'long-text', consumes: 'text', select: 'agent' }, { messages: MSG })
  const run6 = r6.result as AgentRunResult
  ok('显式选 Agent + text ⇒ 只拼 message 事件', r6.track === 'adapt' && run6.text === '正文甲正文乙' && !run6.text!.includes('拆解任务') && !run6.text!.includes('建议修改'))
  ok('Agent 轨账本记订阅口径（不许报成按量）', ledger.at(-1)!.quota === 'subscription' && ledger.at(-1)!.backend === 'fake-agent')

  const r7 = await router.route({ id: 't7', kind: 'enhance', consumes: 'artifacts', manual: true, select: 'agent' }, { messages: MSG })
  const run7 = r7.result as AgentRunResult
  ok('增强轨：手动+显式 ⇒ 产物 descriptor', r7.track === 'enhance' && run7.artifacts.length === 1 && run7.artifacts[0].path === '建议.md')
  const r8 = await router.route({ id: 't8', kind: 'enhance', consumes: 'artifacts', select: 'agent' }, { messages: MSG })
  ok('增强轨非手动 ⇒ 跳过留痕', r8.action === 'skipped' && r8.reason === 'enhance-requires-manual-explicit-agent')
  const r9 = await router.route({ id: 't9', kind: 'enhance', consumes: 'artifacts', manual: true }, { messages: MSG })
  ok('增强轨未显式选 Agent ⇒ 跳过留痕', r9.action === 'skipped')

  const noBase = createBackendRouter<string>({ runBaseline: null })
  await assert.rejects(() => noBase.route({ id: 't10', kind: 'long-text', consumes: 'text' }, { messages: MSG }), /保底轨不可用/)
  ok('保底轨不可用 ⇒ 如实抛错并记 failed', noBase.ledger.at(-1)!.action === 'failed')
  const failing = createBackendRouter<string>({ runBaseline: async () => { throw new Error('offline') } })
  await assert.rejects(() => failing.route({ id: 'fail', kind: 'long-text', consumes: 'text' }, { messages: MSG }), /offline/)
  ok('协议轨异常记失败而非遗漏账本', failing.ledger.at(-1)?.action === 'failed')
  const brokenBackend = { ...backend, async createSession(): Promise<BackendSession> { throw new Error('session failed') } }
  const failingAgent = createBackendRouter<string>({ runBaseline, agentBackend: brokenBackend })
  await assert.rejects(() => failingAgent.route({ id: 'fail-agent', kind: 'long-text', consumes: 'text', select: 'agent' }, { messages: MSG }), /session failed/)
  ok('Agent 创建会话异常记失败', failingAgent.ledger.at(-1)?.action === 'failed')
  const noAgent = createBackendRouter<string>({ runBaseline })
  const r11 = await noAgent.route({ id: 't11', kind: 'long-text', consumes: 'text', select: 'agent' }, { messages: MSG })
  ok('未注册后端显式选 Agent ⇒ 跳过留痕 no-agent-backend', r11.action === 'skipped' && r11.reason === 'no-agent-backend')
}

// ============ ④ 会话生命周期：取消保留片段 / 暂停恢复不重复 ============
{
  const { backend, sessions } = fakeBackend(TEXT_SCRIPT)
  const s = await backend.createSession({ id: 'c', kind: 'long-text', consumes: 'text' })
  const sending = s.send('go')
  s.cancel()
  await sending
  ok('取消保留已收片段并置 cancelled', s.state === 'cancelled' && s.events.some(e => e.kind === 'plan') && !s.events.some(e => e.kind === 'state' && e.text === 'finished'))
  ok('取消后事件流仍在（不丢片段）', s.events.some(e => e.kind === 'state' && e.text === 'cancelled'))
  s.close()

  const s2 = await backend.createSession({ id: 'p', kind: 'long-text', consumes: 'text' })
  const p2 = s2.send('go')
  s2.pause()
  await new Promise(r => setTimeout(r, 10))
  const before = s2.events.filter(e => e.kind === 'plan').length
  s2.resume()
  await p2
  const after = s2.events.filter(e => e.kind === 'plan').length
  ok('暂停恢复不重复发事件', before === after && after === 1)
  s2.close()
  void sessions
}

// ============ ⑤ chat() 显式闸（真本机 HTTP 假端点） ============
const seenBodies: Record<string, unknown>[] = []
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => {
    seenBodies.push(JSON.parse(raw || '{}'))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: '协议轨真回文' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }))
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const port = (server.address() as import('node:net').AddressInfo).port
const provider: AIProvider = { id: 't', name: '测试', type: 'openai', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'test-model', contextWindow: 8000 }

const usages: ChatUsage[] = []
setUsageSink(u => usages.push(u))
try {
  // 默认（不传 agent）⇒ 协议轨，与 3.4.2 逐字一致；用量带按量口径
  const plain = await chat(provider, MSG)
  ok('chat() 默认仍走协议轨', plain === '协议轨真回文' && seenBodies.length === 1)
  ok('协议轨用量记 quota=metered', usages.at(-1)!.quota === 'metered' && usages.at(-1)!.source === 'openai')

  // 显式 opt-in + text ⇒ Agent 轨；不碰 HTTP
  const { backend, sessions } = fakeBackend(TEXT_SCRIPT)
  registerAgentBackend(backend)
  const httpBefore = seenBodies.length
  const agentText = await chat(provider, MSG, { agent: { task: { id: 'a1', kind: 'long-text', consumes: 'text', manual: true } } })
  ok('chat() 显式 Agent + text ⇒ 只回 message 正文', agentText === '正文甲正文乙' && seenBodies.length === httpBefore)
  ok('Agent 轨用量记 source=agent + quota=subscription', usages.at(-1)!.source === 'agent' && usages.at(-1)!.quota === 'subscription')

  // json-string ⇒ 抛 BackendTrackSkipError + 用量留痕
  await assert.rejects(
    () => chat(provider, MSG, { agent: { task: { id: 'a2', kind: 'sync-json', consumes: 'json-string', manual: true } } }),
    (e: unknown) => e instanceof BackendTrackSkipError && e.reason === 'agent-no-clean-json',
  )
  ok('json-string 经 chat() 闸：抛错留痕不伪装成功', usages.at(-1)!.finishReason === 'skipped:agent-no-clean-json' && usages.at(-1)!.source === 'agent')

  const sessionsBefore = sessions.length
  for (const structured of [{ json: true }, { output: 'json-schema' as const }]) {
    await assert.rejects(() => chat(provider, MSG, { ...structured, agent: { task: { id: 'mismatch', kind: 'long-text', consumes: 'text' } } }), (e: unknown) => e instanceof BackendTrackSkipError && e.reason === 'agent-no-clean-json')
  }
  ok('JSON 参数与任务声明不一致仍强制硬闸', sessions.length === sessionsBefore && usages.at(-1)?.finishReason === 'skipped:agent-no-clean-json')
  await assert.rejects(() => chat(provider, MSG, { agent: { task: { id: 'art', kind: 'enhance', consumes: 'artifacts', manual: true } } }), (e: unknown) => e instanceof BackendTrackSkipError && e.reason === 'agent-artifact-requires-session')
  ok('chat 拒绝无法返回的产物任务并留痕', usages.at(-1)?.finishReason === 'skipped:agent-artifact-requires-session')
  const controller = new AbortController()
  let listeners = 0
  const add = controller.signal.addEventListener.bind(controller.signal)
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => { listeners++; return add(...args) }) as AbortSignal['addEventListener']
  controller.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => { listeners--; return remove(...args) }) as AbortSignal['removeEventListener']
  await chat(provider, MSG, { signal: controller.signal, agent: { task: { id: 'cleanup', kind: 'long-text', consumes: 'text' } } })
  ok('Agent 完成后移除取消监听器', listeners === 0)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(() => chat(provider, MSG, { signal: aborted.signal, agent: { task: { id: 'cancel-first', kind: 'long-text', consumes: 'text' } } }), (e: unknown) => isCancelled(e))
  ok('提前取消即使 send 抛错仍保留取消口径', usages.at(-1)?.finishReason === 'cancelled')

  // auto-silent ⇒ 强制保底（真发 HTTP）
  const silent = await chat(provider, MSG, { agent: { task: { id: 'a3', kind: 'auto-silent', consumes: 'text' } } })
  ok('auto-silent 经 chat() 闸仍强制保底', silent === '协议轨真回文' && seenBodies.length === httpBefore + 1)

  // 取消 ⇒ AICancelled（不拿片段冒充完成）；脚本足够长，保证 abort 落在流中段
  const slow = fakeBackend(Array.from({ length: 50 }, (_, i) => ({ kind: 'message' as const, text: `片段${i}` })), undefined, 'slow-agent')
  registerAgentBackend(slow.backend)
  const ac = new AbortController()
  const pending = chat(provider, MSG, { signal: ac.signal, agent: { task: { id: 'a4', kind: 'long-text', consumes: 'text', manual: true }, backendId: 'slow-agent' } })
  setTimeout(() => ac.abort(), 5)
  await assert.rejects(() => pending, (e: unknown) => isCancelled(e))
  ok('signal 取消映射 session.cancel 并抛 AICancelled', true)
  unregisterAgentBackend('slow-agent')

  // 无 message 正文 ⇒ 如实报错，不返回空串
  const empty = fakeBackend([{ kind: 'plan', text: '只说不做' }], undefined, 'empty-agent')
  registerAgentBackend(empty.backend)
  await assert.rejects(
    () => chat(provider, MSG, { agent: { task: { id: 'a5', kind: 'long-text', consumes: 'text', manual: true }, backendId: 'empty-agent' } }),
    /没有产出正文内容/,
  )
  ok('Agent 无 message 正文 ⇒ 如实报错（不空串冒充）', usages.at(-1)?.finishReason === 'error')
  unregisterAgentBackend('empty-agent')
  unregisterAgentBackend('fake-agent')

  // 未注册任何后端 + 显式 opt-in ⇒ no-agent-backend 留痕
  await assert.rejects(
    () => chat(provider, MSG, { agent: { task: { id: 'a6', kind: 'long-text', consumes: 'text', manual: true } } }),
    (e: unknown) => e instanceof BackendTrackSkipError && e.reason === 'no-agent-backend',
  )
  ok('未注册后端经 chat() 闸 ⇒ 跳过留痕', usages.at(-1)!.finishReason === 'skipped:no-agent-backend')
} finally {
  setUsageSink(null)
  await new Promise<void>(r => server.close(() => r()))
}

console.log(`\n${pass} 项通过，${process.exitCode ? '存在失败' : '全部通过'}`)
if (process.exitCode) process.exit(1)