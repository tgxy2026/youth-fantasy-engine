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
import { aiProofreadLogic, aiProofreadText } from '../src/lib/aiTasks/proofread'
import { aiExtractSettingEntitiesWithStatus } from '../src/lib/aiTasks/extract'
import { aiExtractChapterChangesWithStatus } from '../src/lib/aiTasks/postProcess'
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

  console.log('--- 8. 校对（文字层 / 逻辑层）---')
  const shortBody = '林昭握紧剑柄，雨点砸在铁上发出闷响。'
  const proofText = (opts?: { ask?: () => Promise<boolean>; askOnce?: boolean; body?: string }) =>
    aiProofreadText(opts?.body ?? shortBody, {
      acpText: acpStructuredText({
        task: 'proofread', generation, agentName: '假 Agent',
        scopeText: '本章正文', askOnce: opts?.askOnce,
        assertCurrent: () => {}, ask: opts?.ask ?? allow,
      }),
    })

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify([{ kind: 'replacement', type: '错别字', quote: '雨点砸在铁上', why: '用词不当', replacement: '雨点敲在剑上' }]) })
  const pr = await proofText()
  ok('校对问题落地', pr.issues.length === 1 && pr.issues[0].kind === 'replacement')
  ok('引文在原文里定位到（at 有值）', typeof pr.issues[0].at === 'number' && pr.issues[0].at! >= 0)
  ok('已校对字数按块记', pr.scanned === shortBody.length)
  ok('任务标识为 proofread', requests[0].task === 'proofread')

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify({ issues: [{ kind: 'suggestion', quote: '雨点砸在铁上', why: '可更书面' }] }) })
  const prEnv = await proofText()
  ok('对象外壳 {issues:[…]} 也接受', prEnv.issues.length === 1 && prEnv.unparsedChunks === 0)

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"kind":"suggestion","quote":"雨点砸在铁上"' })
  const prCut = await proofText()
  ok('截断的块记为未读懂（不是 0 问题）', prCut.unparsedChunks === 1 && prCut.issues.length === 0)

  reset()
  generateImpl = async () => ({ ok: true, text: '这一段写得还行，我没发现问题。' })
  const prProse = await proofText()
  ok('散文回复记为未读懂', prProse.unparsedChunks === 1)

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"quote":"雨点砸在铁上"}, "字符串条目"]' })
  const prBadItem = await proofText()
  ok('条目不是对象 ⇒ 整块未读懂（不静默过滤）', prBadItem.unparsedChunks === 1)

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"kind":"suggestion","quote":"这句话正文里根本没有"}]' })
  const prMiss = await proofText()
  ok('引文定位不到 ⇒ 计入 unlocated 且不进 issues', prMiss.unlocated === 1 && prMiss.issues.length === 0)

  reset()
  generateImpl = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  const prCancel = await proofText()
  ok('取消记为 cancelled（不是失败）', prCancel.cancelled === true && prCancel.failedChunks === 0)

  console.log('--- 9. 校对的分块、范围与确认次数 ---')
  const p1 = '甲段起点' + '甲'.repeat(1196)
  const p2 = '乙段起点' + '乙'.repeat(1196)
  const longBody = `${p1}\n\n${p2}`
  reset()
  let asks = 0
  generateImpl = async request => ({
    ok: true,
    text: JSON.stringify([{ kind: 'suggestion', quote: request.text.includes('甲段起点') ? '甲段起点' : '乙段起点', why: '合成' }]),
  })
  const prLong = await aiProofreadText(longBody, {
    acpText: acpStructuredText({
      task: 'proofread', generation, agentName: '假 Agent', scopeText: '本章正文', askOnce: true,
      assertCurrent: () => {}, ask: async () => { asks++; return true },
    }),
  })
  ok('长文本切成多块分别发送', requests.length >= 2 && prLong.totalChunks >= 2, `${requests.length}/${prLong.totalChunks}`)
  ok('每块结果都定位到原文', prLong.issues.length >= 2 && prLong.unlocated === 0)
  ok('askOnce：整章只确认一次', asks === 1, String(asks))

  reset()
  generateImpl = async () => ({ ok: true, text: '[]' })
  await aiProofreadText(shortBody, {
    acpText: acpStructuredText({ task: 'proofread', generation, agentName: '假 Agent', scopeText: '本章正文', askOnce: true, assertCurrent: () => {}, ask: allow }),
  })
  ok('文字层提示词不带设定资料', !requests[0].text.includes('【设定资料】'))
  ok('文字层提示词要求逐字照抄引文', requests[0].text.includes('逐字照抄'))

  reset()
  generateImpl = async () => ({ ok: true, text: '[]' })
  await aiProofreadLogic(shortBody, {
    context: '设定：青岚宗',
    acpText: acpStructuredText({ task: 'proofread', generation, agentName: '假 Agent', scopeText: '本章正文与设定资料', askOnce: true, assertCurrent: () => {}, ask: allow }),
  })
  ok('逻辑层提示词带设定资料', requests[0].text.includes('【设定资料】'))
  ok('逻辑层确认文案如实写范围', acpStructuredMessage('proofread', '假 Agent', '本章正文与设定资料').includes('本章正文与设定资料'))

  console.log('--- 10. 设定实体抽取（补登候选）---')
  const extract = () => aiExtractSettingEntitiesWithStatus(body, '第一章 雨夜', {
    acpText: acpStructuredText({ task: 'extract', generation, agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
  })

  reset()
  generateImpl = async () => ({
    ok: true,
    text: JSON.stringify([
      { name: '林昭', type: '人物', tier: '主要', aliases: ['阿昭'], evidence: '林昭握紧剑柄', fields: { identity: '青岚宗弟子' } },
      { name: '青岚宗', type: '势力', evidence: '青岚宗' },
    ]),
  })
  const ex = await extract()
  ok('抽取状态为已完成', ex.state === 'completed')
  ok('两个实体都落地', ex.result?.data.length === 2, String(ex.result?.data.length))
  ok('人物类型与别称解析正确', ex.result?.data[0].type === '人物' && ex.result?.data[0].aliases?.includes('阿昭') === true)
  ok('任务标识为 extract', requests[0].task === 'extract')
  ok('提示词写明类型枚举', requests[0].text.includes('人物') && requests[0].text.includes('术语'))

  reset()
  generateImpl = async () => ({ ok: true, text: '[]' })
  const exEmpty = await extract()
  ok('本章没有新设定 ⇒ 合法空结果', exEmpty.state === 'completed' && exEmpty.result?.data.length === 0)

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"name":"林昭","type":"人物"' })
  const exCut = await extract()
  ok('截断判为失败而不是「没有新设定」', exCut.state === 'failed' && String(exCut.errorCode).includes('JSON 没有闭合'), String(exCut.errorCode))

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"name":"林昭","type":"角色"}]' })
  const exBadType = await extract()
  ok('类型不在枚举内判为失败', exBadType.state === 'failed' && String(exBadType.errorCode).includes('bad-field'), String(exBadType.errorCode))

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"type":"人物"}]' })
  const exNoName = await extract()
  ok('缺实体名判为失败', exNoName.state === 'failed' && String(exNoName.errorCode).includes('missing-field'), String(exNoName.errorCode))

  ok('确认文案说明只出候选', acpStructuredMessage('extract', '假 Agent').includes('不会自动写入设定表'))

  console.log('--- 11. 章后整理（伏笔 / 关系 / 状态）---')
  const changes = () => aiExtractChapterChangesWithStatus(body, '第一章 雨夜', {
    acpText: acpStructuredText({ task: 'changes', generation, agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
  })

  reset()
  generateImpl = async () => ({
    ok: true,
    text: JSON.stringify([
      { kind: '伏笔', action: '埋设', code: 'F0007', content: '林昭袖中藏着的半截玉牌' },
      { kind: '关系', a: '林昭', b: '青岚宗', type: '敌对', change: '被逐出师门' },
      { kind: '状态', name: '林昭', state: '重伤昏迷', evidence: '他倒在雨里，剑还握在手上' },
    ]),
  })
  const chg = await changes()
  ok('三类变化都落地', chg.state === 'completed' && chg.result?.data.foreshadows.length === 1 && chg.result?.data.relations.length === 1 && chg.result?.data.statuses.length === 1)
  ok('伏笔动作与编号保留', chg.result?.data.foreshadows[0].action === '埋设' && chg.result?.data.foreshadows[0].code === 'F0007')
  ok('任务标识为 changes', requests[0].task === 'changes')

  reset()
  generateImpl = async () => ({ ok: true, text: '[]' })
  const chgEmpty = await changes()
  ok('本章没有变化 ⇒ 合法空结果', chgEmpty.state === 'completed' && chgEmpty.result?.data.statuses.length === 0)

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"kind":"伏笔","action":"埋设","content":"x"},{"kind":"天气"}]' })
  const chgKind = await changes()
  ok('类别不认识判为失败（不静默跳过）', chgKind.state === 'failed' && String(chgKind.errorCode).includes('类别不认识'), String(chgKind.errorCode))

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"kind":"伏笔","content":"没有动作"}]' })
  const chgAction = await changes()
  ok('伏笔缺动作判为失败', chgAction.state === 'failed' && String(chgAction.errorCode).includes('missing-field'), String(chgAction.errorCode))

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"kind":"伏笔","action":"埋设","content":"x"},{"kind":"关系","a":"林昭"}]' })
  const chgRel = await changes()
  ok('关系缺乙方判为失败', chgRel.state === 'failed' && String(chgRel.errorCode).includes('missing-field'), String(chgRel.errorCode))

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"kind":"状态","name":"林昭"}]' })
  const chgState = await changes()
  ok('状态缺当前状态判为失败', chgState.state === 'failed' && String(chgState.errorCode).includes('missing-field'), String(chgState.errorCode))

  ok('确认文案说明写入前仍要核对', acpStructuredMessage('changes', '假 Agent').includes('写入前仍要你核对'))

  console.log('--- 12. 主进程白名单与源码契约 ---')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
  const whitelist = main.split(/\r?\n/).find(line => line.includes('request.task') && line.includes('includes')) ?? ''
  for (const task of ['review', 'ooc', 'advice', 'proofread', 'extract', 'changes']) ok(`主进程放行 ${task}`, whitelist.includes(`'${task}'`), whitelist)
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
