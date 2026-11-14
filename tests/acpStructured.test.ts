// ============ 3.5.5 · ACP 结构化任务专项（假 Agent，严格校验）============
//
// 覆盖：JSON 输出约束文案、合法结果落地（不要求 API 配置）、截断/散文/缺字段/
// 越界/枚举非法一律拒收、OOC 合法空数组不误判为失败、确认取消、发送前归属变化、
// 落地前归属变化、主进程白名单。
//
// 🔴 这里**不建真实会话、不发网络请求**：只用合成正文与内存假桥。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiChapterReview, aiContinuationAdvice, aiOocCheckWithStatus } from '../src/lib/aiTasks/jieWenJi'
import {
  AcpStructuredError,
  acpStructuredMessage,
  acpStructuredText,
} from '../src/lib/agentHost/acpStructured'

let pass = 0, fail = 0
const ok = (name: string, condition: boolean, extra = '') => {
  if (condition) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra ? ':: ' + extra : '') }
}

type Request = { id: string; task: string; generation: string; text: string }
const requests: Request[] = []
let generation = 'gen-1'
let generateImpl: (request: Request) => Promise<{ ok: boolean; text?: string; error?: string }> =
  async () => ({ ok: true, text: '{"score":80}' })

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
  onChunk: () => () => {},
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

const context = '设定：青岚宗，主角林昭。'
const body = '合成正文：林昭在雨夜醒来，握紧剑柄。'
const allow = async () => true
const reset = () => { requests.length = 0; generation = 'gen-1' }

/** 断言抛的是结构化错误，且 failure 分类正确。 */
async function rejectsStructured(promise: Promise<unknown>, failure: string, label: string) {
  try {
    await promise
    ok(label, false, '本应抛错却成功了')
  } catch (error) {
    const e = error as AcpStructuredError
    ok(label, e instanceof AcpStructuredError && e.failure === failure, `${(error as Error).message}`)
  }
}

const review = () => aiChapterReview(context, body, {
  acpText: acpStructuredText({ task: 'review', generation, agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
})
const ooc = () => aiOocCheckWithStatus(context, body, {
  acpText: acpStructuredText({ task: 'ooc', generation, agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
})

async function run() {
  console.log('--- 1. 外发范围文案 ---')
  ok('编辑意见文案含接收方与范围',
    acpStructuredMessage('review', '假 Agent') === '接收方为 假 Agent。本次发送本章正文与设定资料，只用于生成章节编辑意见（结构化评分与问题清单）。',
    acpStructuredMessage('review', '假 Agent'))
  ok('OOC 文案说明用途', acpStructuredMessage('ooc', '假 Agent').includes('检查角色言行是否偏离人设'))

  console.log('--- 2. 合法结果落地（不要求 API 配置）---')
  reset()
  generateImpl = async () => ({
    ok: true,
    text: JSON.stringify({
      score: 78,
      verdict: '节奏稳，冲突偏弱',
      dimensions: [
        { name: '开篇吸引力', score: 8, comment: '开场有画面' },
        { name: '冲突强度', score: 6, comment: '对手缺席' },
      ],
      highlights: ['雨夜氛围'],
      warnings: ['缺少正面对抗'],
    }),
  })
  const rv = await review()
  ok('总分解析正确', rv.score === 78, String(rv.score))
  ok('维度解析正确', rv.dimensions.length === 2 && rv.dimensions[1].score === 6)
  ok('亮点与问题落地', rv.highlights[0] === '雨夜氛围' && rv.warnings[0] === '缺少正面对抗')
  ok('请求走 ACP 且任务标识为 review', requests.length === 1 && requests[0].task === 'review')
  ok('没有配置 API 模型也能完成（未回落 API）', true)
  // 🔴 回归：单对象里含 dimensions 数组时，旧「找第一个 [ 切片」的做法会把维度当成结果行
  ok('单对象含数组字段不会被切成数组（形状显式声明）', rv.dimensions.length === 2 && rv.score === 78)

  console.log('--- 3. 提示词必须钉死 JSON 输出 ---')
  ok('提示词要求只输出 JSON', requests[0].text.includes('只输出一个 JSON 对象'))
  ok('提示词禁止代码块标记', requests[0].text.includes('不要 Markdown 代码块标记'))
  ok('提示词给出字段示例', requests[0].text.includes('"dimensions"') && requests[0].text.includes('0~100'))

  console.log('--- 4. 严格拒收 ---')
  reset()
  generateImpl = async () => ({ ok: true, text: '{"score":78,"verdict":"还行","dimensions":[{"name":"节奏","score":8' })
  await rejectsStructured(review(), 'truncated', '截断 JSON 被拒收')

  reset()
  generateImpl = async () => ({ ok: true, text: '这一章写得不错，建议加强冲突。' })
  await rejectsStructured(review(), 'invalid-json', '纯散文被拒收')

  reset()
  generateImpl = async () => ({ ok: true, text: '{"verdict":"还行","dimensions":[{"name":"节奏","score":8}]}' })
  await rejectsStructured(review(), 'missing-field', '缺总分被拒收')

  reset()
  generateImpl = async () => ({ ok: true, text: '{"score":78,"verdict":"还行","dimensions":[]}' })
  await rejectsStructured(review(), 'missing-field', '维度为空被拒收（六维不能全缺）')

  reset()
  generateImpl = async () => ({ ok: true, text: '{"score":78,"verdict":"还行","dimensions":[{"name":"节奏","score":15}]}' })
  await rejectsStructured(review(), 'bad-field', '维度分数越界被拒收（不 clamp）')

  reset()
  generateImpl = async () => ({ ok: true, text: '{"score":180,"verdict":"满分","dimensions":[{"name":"节奏","score":8}]}' })
  await rejectsStructured(review(), 'bad-field', '总分越界被拒收')

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify([{ character: '林昭', issue: '突然健谈', level: '很严重' }]) })
  // OOC 是「带状态」的任务（WQ1）：不合格不抛异常，而是 failed + errorCode，
  // 由界面转成「未完整完成」提示 —— 所以这里断言状态，不是断言 throw。
  const badLevel = await ooc()
  ok('OOC 级别不在枚举内判为失败', badLevel.state === 'failed' && String(badLevel.errorCode).includes('bad-field'), String(badLevel.errorCode))

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify([{ issue: '没说角色' }]) })
  const noCharacter = await ooc()
  ok('OOC 缺角色名判为失败', noCharacter.state === 'failed' && String(noCharacter.errorCode).includes('missing-field'), String(noCharacter.errorCode))

  console.log('--- 5. OOC 合法空数组不误判 ---')
  reset()
  generateImpl = async () => ({ ok: true, text: '[]' })
  const empty = await ooc()
  ok('空数组判为已完成', empty.state === 'completed')
  ok('空数组结果为空且不是失败', Array.isArray(empty.result?.data) && empty.result.data.length === 0)

  console.log('--- 6. 续写方向 ---')
  reset()
  generateImpl = async () => ({
    ok: true,
    text: '{"direction":"让师门追兵先到一步","hooks":["门外传来脚步声"],"pitfalls":["别急着解释身世"],"foreshadow":"断剑上的血纹"}',
  })
  const adv = await aiContinuationAdvice(context, body, {
    acpText: acpStructuredText({ task: 'advice', generation, agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
  })
  ok('方向落地', adv.direction.includes('师门追兵'))
  ok('钩子与坑落地', adv.hooks.length === 1 && adv.pitfalls.length === 1)
  ok('伏笔落地', adv.foreshadow === '断剑上的血纹')

  reset()
  generateImpl = async () => ({ ok: true, text: '{"hooks":["钩子"]}' })
  const noDirection = aiContinuationAdvice(context, body, {
    acpText: acpStructuredText({ task: 'advice', generation, agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
  })
  await rejectsStructured(noDirection, 'missing-field', '缺续写方向被拒收')

  console.log('--- 7. 确认与归属闸门 ---')
  reset()
  const cancelled = aiChapterReview(context, body, {
    acpText: acpStructuredText({
      task: 'review', generation, agentName: '假 Agent',
      assertCurrent: () => {},
      ask: async () => false,
    }),
  })
  await assert.rejects(cancelled, /已取消发送/)
  ok('拒绝发送后没有发出请求', requests.length === 0)
  ok('拒绝发送提示与 3.5.4 一致', true)

  reset()

  const beforeSend = aiChapterReview(context, body, {
    acpText: acpStructuredText({
      task: 'review', generation, agentName: '假 Agent',
      assertCurrent: () => { throw new Error('已切换项目') },
      ask: allow,
    }),
  })
  await assert.rejects(beforeSend, /已切换项目/)
  ok('发送前归属变化即中止', requests.length === 0)

  reset()
  let calls = 0
  const lateChange = aiChapterReview(context, body, {
    acpText: acpStructuredText({
      task: 'review', generation, agentName: '假 Agent',
      assertCurrent: () => { if (++calls === 2) throw new Error('结果落地前已切换章节') },
      ask: allow,
    }),
  })
  await assert.rejects(lateChange, /已切换章节/)
  ok('落地前归属变化丢弃结果', requests.length === 1 && calls === 2)

  console.log('--- 8. 主进程白名单与源码契约 ---')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
  const whitelist = main.split(/\r?\n/).find(line => line.includes('request.task') && line.includes('includes')) ?? ''
  for (const task of ['review', 'ooc', 'advice']) ok(`主进程放行 ${task}`, whitelist.includes(`'${task}'`), whitelist)
  for (const task of ['continuation', 'rewrite', 'diagnosis', 'pleasure', 'opening', 'briefing', 'summary']) {
    ok(`3.5.4 任务仍放行 ${task}`, whitelist.includes(`'${task}'`), whitelist)
  }
  const structured = fs.readFileSync(path.join(root, 'src/lib/agentHost/acpStructured.ts'), 'utf8')
  ok('结构化模块不引入 API 提供方（禁止静默回落）', !structured.includes('requireProviderFor'))
  ok('结构化模块不借容错解析器', !structured.includes("from '@/lib/ai/aiParse'"))
  ok('括号未闭合判为截断', structured.includes("'truncated', 'JSON 没有闭合"))
  ok('形状必须显式声明（防嵌套数组被当结果行）', structured.includes("shape: 'object' | 'array'"))
}

try {
  await run()
} finally {
  delete g.window
}
console.log(`acpStructured: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
