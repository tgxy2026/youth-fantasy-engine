// ============ 3.5.4 · ACP 纯文本入口专项（假 Agent）============
//
// 覆盖：任务标识白名单、发送前确认文案（接收方 + 实际资料范围）、发送前/落地前
// 代次与归属校验、失败、空结果、取消后迟到分片、确认取消、切换归属。
// 只使用合成作品与内存假桥，不建真实 ACP 会话、不发网络请求。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acpWrite, acpWritingContext } from '../src/lib/agentHost/acpBridge'
import { acpReportMessage, acpReportText } from '../src/lib/agentHost/acpReport'
import { aiBriefing, aiChapterSummary, aiEditorDiagnosis, aiOpeningCheck, aiPleasureCheck } from '../src/lib/aiTasks/jieWenJi'

let pass = 0, fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, '::', extra) }
}

type Request = { id: string; task: string; generation: string; text: string }
const requests: Request[] = []
const cancelled: string[] = []
const confirmer: string[] = []
let chunkHandlers = new Set<(chunk: { id: string; delta: string }) => void>()
let mode: 'acp' | 'api' = 'acp'
let generation = 'gen-1'
let generateImpl: (request: Request) => Promise<{ ok: boolean; text?: string; error?: string }> =
  async () => ({ ok: true, text: '合成报告' })

function pushChunk(id: string, delta: string) {
  for (const handler of [...chunkHandlers]) handler({ id, delta })
}

const fakeBridge = {
  status: async () => ({
    generation, selected: 'fake-agent',
    adapters: [{ id: 'fake-agent', name: '假 Agent', available: true }], ready: true,
  }),
  generate: async (request: Request) => {
    requests.push(request)
    return generateImpl(request)
  },
  cancel: async (id: string) => { cancelled.push(id); return true },
  onChunk: (handler: (chunk: { id: string; delta: string }) => void) => {
    chunkHandlers.add(handler)
    return () => { chunkHandlers.delete(handler) }
  },
}

const g = globalThis as unknown as { window?: Record<string, unknown> }
g.window = {
  electronAgentHost: {
    modeStatus: async () => ({
      phase: 'stable', mode, reason: '', busy: false, active: { api: 0, agent: 0, acp: 0 },
      ownsLock: false, lock: null, canRecover: false,
    }),
  },
  electronAcp: fakeBridge,
}

const reset = () => { requests.length = 0; cancelled.length = 0; confirmer.length = 0; chunkHandlers = new Set(); generation = 'gen-1'; mode = 'acp' }
const confirmAllow = async () => true
const allow = () => { confirmer.push('allow'); return confirmAllow() }

async function run() {
  console.log('--- 1. 模式上下文与任务标识 ---')
  reset()
  const ctx = await acpWritingContext()
  ok('稳定 ACP 模式返回上下文', ctx?.generation === 'gen-1' && ctx?.name === '假 Agent' && ctx?.ready === true)
  mode = 'api'
  ok('API 模式不走 ACP 分支', await acpWritingContext() === null)
  mode = 'acp'

  const body = '合成正文：少年在雨夜醒来。'
  const context = '设定：青岚宗。'
  const report = '## 报告\n- 合成结论'

  console.log('--- 2. 五个入口的任务标识、输入契约与结果契约 ---')
  const cases: { task: string; run: () => Promise<string>; expect: string }[] = [
    {
      task: 'diagnosis', expect: '【本章正文】',
      run: async () => (await aiEditorDiagnosis(context, body, {
        acpText: acpReportText({ task: 'diagnosis', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
      })).report,
    },
    {
      task: 'pleasure', expect: '【本章正文】',
      run: async () => (await aiPleasureCheck(context, body, {
        acpText: acpReportText({ task: 'pleasure', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
      })).report,
    },
    {
      task: 'opening', expect: '【作品开头（前三章或已有章节）】',
      run: async () => (await aiOpeningCheck(context, body, {
        acpText: acpReportText({ task: 'opening', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
      })).report,
    },
    {
      task: 'briefing', expect: '【当前章节 / 进度】',
      run: async () => (await aiBriefing(context, body, {
        acpText: acpReportText({ task: 'briefing', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
      })).report,
    },
    {
      task: 'summary', expect: '【本章正文】',
      run: () => aiChapterSummary(body, {
        acpText: acpReportText({ task: 'summary', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
      }),
    },
  ]
  for (const item of cases) {
    reset()
    generateImpl = async () => ({ ok: true, text: report })
    const text = await item.run()
    ok(`${item.task} 使用专用任务标识`, requests.length === 1 && requests[0].task === item.task, JSON.stringify(requests))
    ok(`${item.task} 发送实际资料范围`, requests[0].text.includes(item.expect) && requests[0].text.includes(body), requests[0]?.text?.slice(0, 120))
    ok(`${item.task} 返回纯文本结果`, text.includes('合成结论'))
  }

  console.log('--- 3. 发送前确认文案 ---')
  reset()
  const confirmed: string[] = []
  const confirmRecord = async (options: { message: string }) => { confirmed.push(options.message); return true }
  generateImpl = async () => ({ ok: true, text: report })
  await aiEditorDiagnosis(context, body, {
    acpText: acpReportText({ task: 'diagnosis', generation: 'gen-1', agentName: '假 Agent', brief: true, assertCurrent: () => {}, ask: confirmRecord }),
  })
  ok('综合诊断简略模式如实写压缩摘要', confirmed[0]?.includes('假 Agent') && confirmed[0]?.includes('本章压缩摘要') && !confirmed[0]?.includes('本章正文'), confirmed[0])
  ok('确认文案标注接收方', acpReportMessage('pleasure', '假 Agent').includes('接收方为 假 Agent'))
  ok('确认文案标注实际资料范围', acpReportMessage('opening', '假 Agent').includes('作品开头'))

  reset()
  requests.length = 0
  await assert.rejects(
    aiChapterSummary(body, { acpText: acpReportText({ task: 'summary', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: async () => false }) }),
    /已取消发送/,
  )
  ok('作者拒绝确认时不外发', requests.length === 0)

  console.log('--- 4. 失败与空结果 ---')
  reset()
  generateImpl = async () => ({ ok: false, error: 'ACP 连接失败' })
  await assert.rejects(
    aiPleasureCheck(context, body, { acpText: acpReportText({ task: 'pleasure', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: allow }) }),
    /ACP 连接失败/,
  )
  ok('请求失败如实抛错', true)

  reset()
  generateImpl = async () => ({ ok: true, text: '   ' })
  await assert.rejects(
    aiEditorDiagnosis(context, body, { acpText: acpReportText({ task: 'diagnosis', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: allow }) }),
    /没有返回可用诊断报告/,
  )
  ok('空结果不当作成功', true)

  console.log('--- 5. 取消与迟到分片 ---')
  reset()
  let started: () => void = () => {}
  const ready = new Promise<void>(resolve => { started = resolve })
  generateImpl = request => new Promise(resolve => {
    started()
    setTimeout(() => { pushChunk(request.id, '迟到分片'); resolve({ ok: true, text: '迟到结果' }) }, 25)
  })
  const controller = new AbortController()
  const tokens: string[] = []
  const pending = acpWrite('summary', 'gen-1', body, { signal: controller.signal, onToken: delta => tokens.push(delta) })
  await ready
  controller.abort()
  await assert.rejects(pending, /aborted|取消/)
  await new Promise(resolve => setTimeout(resolve, 40))
  ok('取消调用 acp:cancel', cancelled.length === 1 && cancelled[0] === requests[0].id)
  ok('取消后的迟到分片被丢弃', tokens.length === 0, JSON.stringify(tokens))

  console.log('--- 6. 切换归属与代次 ---')
  reset()
  let current = true
  generateImpl = async () => { current = false; return { ok: true, text: report } }
  await assert.rejects(
    aiChapterSummary(body, { acpText: acpReportText({ task: 'summary', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => { if (!current) throw new Error('项目或存储空间已切换') }, ask: allow }) }),
    /已切换/,
  )
  ok('切换项目后拒绝迟到结果', true)

  reset()
  generateImpl = async () => { generation = 'gen-2'; return { ok: true, text: report } }
  await assert.rejects(
    aiBriefing(context, body, { acpText: acpReportText({ task: 'briefing', generation: 'gen-1', agentName: '假 Agent', assertCurrent: () => {}, ask: allow }) }),
    /已变化/,
  )
  ok('ACP 设置代次变化后拒绝结果', true)

  console.log('--- 7. 主进程白名单与源码契约 ---')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
  const whitelist = main.split(/\r?\n/).find(line => line.includes('request.task') && line.includes('includes')) ?? ''
  for (const task of ['continuation', 'rewrite', 'diagnosis', 'pleasure', 'opening', 'briefing', 'summary']) {
    ok(`主进程放行 ${task}`, whitelist.includes(`'${task}'`), whitelist)
  }
  ok('主进程白名单按 request.task 校验', whitelist.includes('.includes(request.task)'), whitelist)
  ok('主进程仍拒绝未知任务', main.includes('ACP 写作请求无效'))
}

try {
  await run()
} finally {
  delete g.window
}
console.log(`acpPlainText: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1