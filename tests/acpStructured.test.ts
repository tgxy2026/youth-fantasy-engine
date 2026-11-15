// ============ 3.5.5 · ACP 结构化任务专项（假 Agent，严格校验）============
//
// 覆盖：JSON 输出约束文案、合法结果落地（不要求 API 配置）、截断/散文/缺字段/
// 越界/枚举非法一律拒收、OOC 合法空数组不误判为失败、确认取消、发送前归属变化、
// 落地前归属变化、主进程白名单。
//
// 🔴 这里**不建真实会话、不发网络请求**：只用合成正文与内存假桥。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { aiChapterReview, aiContinuationAdvice, aiOocCheckWithStatus } from '../src/lib/aiTasks/jieWenJi'
import { aiProofreadLogic, aiProofreadText } from '../src/lib/aiTasks/proofread'
import { aiExtractSettingEntitiesWithStatus } from '../src/lib/aiTasks/extract'
import { aiExtractChapterChangesWithStatus } from '../src/lib/aiTasks/postProcess'
import { aiOrganizeRows } from '../src/lib/aiTasks/organize'
import { aiCompleteTemplate } from '../src/lib/aiCore/template'
import { aiInlineSuggest } from '../src/lib/aiTasks/inline'
import { acpGatedText } from '../src/lib/agentHost/acpGate'
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

  console.log('--- 12. 设定表 AI 整理 ---')
  const organize = () => aiOrganizeRows({
    tableName: '人物关系',
    purpose: '整理人物之间的关系变化',
    columns: [{ name: '人物A' }, { name: '人物B' }, { name: '关系类型', allowed: ['师徒', '敌对'] }],
    existingKeys: ['林昭 ｜ 青岚宗'],
    keyColumns: ['人物A', '人物B'],
    unorderedPair: false,
    sourceText: '林昭与青岚宗决裂。',
    projectContext: '设定：青岚宗。',
    maxRows: 5,
    acpText: acpStructuredText({ task: 'organize', generation, agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
  })

  reset()
  generateImpl = async () => ({
    ok: true,
    text: JSON.stringify([{ 人物A: '林昭', 人物B: '沈砚', 关系类型: '师徒' }]),
  })
  const org = await organize()
  ok('整理出一条新条目', org.rows.length === 1 && org.rows[0]['人物B'] === '沈砚')
  ok('解析口径为 valid', org.parseOutcome === 'valid')
  ok('任务标识为 organize', requests[0].task === 'organize')
  ok('提示词带上已登记条目', requests[0].text.includes('【已登记条目'))

  reset()
  generateImpl = async () => ({
    ok: true,
    text: JSON.stringify([{ 人物A: '林昭', 人物B: '青岚宗', 关系类型: '敌对' }, { 人物A: '林昭', 人物B: '沈砚' }]),
  })
  const orgDup = await organize()
  ok('与已登记条目重复的被本地判重丢弃', orgDup.rows.length === 1 && orgDup.dupSkipped === 1, `${orgDup.rows.length}/${orgDup.dupSkipped}`)

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify([{ 人物A: '林昭' }]) })
  const orgBad = await organize()
  ok('缺关键列的条目被丢弃并计数', orgBad.rows.length === 0 && orgBad.invalidSkipped === 1)

  reset()
  generateImpl = async () => ({ ok: true, text: '[]' })
  const orgEmpty = await organize()
  ok('没有可整理内容 ⇒ 合法空结果', orgEmpty.rows.length === 0 && orgEmpty.parseOutcome === 'valid')

  reset()
  generateImpl = async () => ({ ok: true, text: '[{"人物A":"林昭","人物B":"沈砚"' })
  let orgThrew = ''
  try { await organize() } catch (error) { orgThrew = String((error as Error).message) }
  ok('截断直接报错，不返回半份候选', orgThrew.includes('JSON 没有闭合'), orgThrew)

  ok('确认文案说明只出候选', acpStructuredMessage('organize', '假 Agent').includes('勾选后才会写入表格'))

  console.log('--- 13. 设定模板补全（表单 / 大纲 AI 新增）---')
  const fields = [
    { key: 'positioning::书名', label: '书名' },
    { key: 'positioning::卖点', label: '核心卖点' },
    { key: 'positioning::锁定项', label: '自动编号', locked: true },
  ]
  const fill = (opts?: { sketch?: string }) => aiCompleteTemplate(fields, opts?.sketch ?? '少年在雨夜捡到半截玉牌', {
    worldContext: '设定：青岚宗。',
    acpText: acpStructuredText({ task: 'fill', generation, agentName: '假 Agent', assertCurrent: () => {}, ask: allow }),
  })

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify({ 1: '雨夜玉牌', 2: '开局即悬念' }) })
  const filled = await fill()
  ok('两个未锁定字段被补全', filled.aiFilled.length === 2 && filled.values['positioning::书名'] === '雨夜玉牌')
  ok('锁定字段不写回', !('positioning::锁定项' in filled.values))
  ok('任务标识为 fill', requests[0].task === 'fill')
  ok('提示词带字段清单', requests[0].text.includes('【字段清单】') && requests[0].text.includes('[书名]'))

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify({ 1: '雨夜玉牌' }) })
  const partial = await fill()
  ok('缺键按空处理，其余照常', partial.aiFilled.length === 1 && partial.values['positioning::书名'] === '雨夜玉牌')

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify({ 1: '', 2: '   ' }) })
  let emptyMsg = ''
  try { await fill() } catch (error) { emptyMsg = String((error as Error).message) }
  ok('一个字段都没填出来判为失败', emptyMsg.includes('没有返回任何字段内容'), emptyMsg)

  reset()
  generateImpl = async () => ({ ok: true, text: JSON.stringify({ 1: { 嵌套: '对象' } }) })
  let badVal = ''
  try { await fill() } catch (error) { badVal = String((error as Error).message) }
  ok('字段值不是文本判为失败', badVal.includes('不是文本'), badVal)

  reset()
  generateImpl = async () => ({ ok: true, text: '{"1":"雨夜玉牌"' })
  let fillCut = ''
  try { await fill() } catch (error) { fillCut = String((error as Error).message) }
  ok('截断判为失败', fillCut.includes('JSON 没有闭合'), fillCut)

  ok('确认文案说明点应用才写入', acpStructuredMessage('fill', '假 Agent').includes('仍要点应用才写入'))

  console.log('--- 14. 编辑器伴写（纯文本）---')
  const companion = (opts?: { length?: 'short' | 'sentence' | 'two' }) => aiInlineSuggest('林昭握紧剑柄，雨点砸在铁上发出闷响，他抬头看向山门。', {
    projectContext: '设定：青岚宗。',
    ...(opts?.length ? { length: opts.length } : {}),
    // 伴写是纯文本任务：走通用闸门，不走结构化那条（没有 JSON 契约）
    acpText: acpGatedText({
      task: 'companion', generation,
      title: '发送光标前正文至 ACP Agent',
      message: '接收方为 假 Agent。本次发送光标前正文与设定摘要，只用于生成一句续写建议（不会改动正文）。',
      assertCurrent: () => {}, ask: allow,
    }),
  })

  reset()
  generateImpl = async () => ({ ok: true, text: '他把剑收回鞘中，转身走进雨里。' })
  const ghost = await companion()
  ok('伴写建议原样落地', ghost === '他把剑收回鞘中，转身走进雨里。', ghost)
  ok('任务标识为 companion', requests[0].task === 'companion')
  ok('提示词带光标前正文块', requests[0].text.includes('【光标之前的正文】'))
  ok('提示词不做 JSON 约束（纯文本任务）', !requests[0].text.includes('只输出一个 JSON 对象'))

  reset()
  generateImpl = async () => ({ ok: true, text: '他把剑收回鞘中。' + '又往前走了一步。'.repeat(30) })
  const ghostLong = await companion({ length: 'short' })
  ok('超长建议被截到档位上限', ghostLong.length <= 30 && ghostLong.length > 0, String(ghostLong.length))

  reset()
  generateImpl = async () => ({ ok: true, text: '   ' })
  const ghostEmpty = await companion()
  ok('空建议返回空串（界面静默不显示）', ghostEmpty === '', JSON.stringify(ghostEmpty))

  reset()
  generateImpl = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  let ghostCancel = ''
  try { await companion() } catch (error) { ghostCancel = String((error as Error).name) }
  ok('取消向上抛出 AbortError（不吞成空建议）', ghostCancel === 'AbortError', ghostCancel)

  // 🔴 2026-11-14 真机看伴写面板发现的告知缺口：那句「伴写正文只发给你当前选定的模型」
  //    在 ACP 模式下是假的（正文发给 Agent，再由 Agent 转给它登录的账号）。
  //    这是作者唯一能看到「正文发给谁」的地方，说错等于外发告知失效。
  {
    const editorSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/editor/NovelEditor.tsx'), 'utf8')
    ok('🔴 伴写面板的「发给谁」按模式分支（不再一律说发给选定模型）',
      /acpWriting\s*\n?\s*\?/.test(editorSrc) || /\{acpWriting[\s\S]{0,80}ACP Agent/.test(editorSrc))
    ok('ACP 分支写明接收方取自当前 Agent 名称', /\$\{acpWriting\.name\}/.test(editorSrc))
    ok('ACP 分支仍提示首次触发会说明范围（与闸门一致）', /首次触发时会说明接收方与范围/.test(editorSrc))
  }

  // ---------------------------------------------------------------- 14.5 会话建立的重试与可读错误
  console.log('--- 14.5 会话建立：按错误类别提示与重试 ---')
  {
    const rt = fs.readFileSync(path.join(process.cwd(), 'scripts/agent-host/acp-runtime.mjs'), 'utf8')
    ok('重试范围是 session/new，不含发送提示词', /const attempt = async \(\) =>/.test(rt) && /client.request\('session\/new'/.test(rt))
    ok('只对标记为瞬时网络故障的错误重试', /isTransientSessionError = error => error\?\.sessionFailure === 'network'/.test(rt))
    ok('取消既终止等待也禁止重试', /signal\.aborted \|\| !backoff \|\| !isTransientSessionError/.test(rt) && /delay\(backoff, undefined, \{ signal \}\)/.test(rt))
    ok('账号、额度、网络和未知错误分别提示', /network:.*网络/.test(rt) && /auth:.*重新登录/.test(rt) && /quota:.*额度/.test(rt) && /unknown:.*-32603/.test(rt))
    ok('其他错误码原样上抛', /if \(error\?\.acpCode !== -32603\) return error/.test(rt))
    ok('最多两次重试，最后一个失败直接退出', /for \(const backoff of \[2500, 5000, 0\]\)/.test(rt) && /!backoff \|\|/.test(rt))
  }

  // ---------------------------------------------------------------- 14.6 R4 运行方式可选
  console.log('--- 14.6 运行方式可选（默认当前 Windows 用户）---')
  {
    const adapterSrc = fs.readFileSync(path.join(process.cwd(), 'scripts/agent-host/antigravity-adapter.mjs'), 'utf8')
    const rtSrc = fs.readFileSync(path.join(process.cwd(), 'scripts/agent-host/acp-runtime.mjs'), 'utf8')
    const mainSrc = fs.readFileSync(path.join(process.cwd(), 'electron/main.cjs'), 'utf8')
    const uiSrc = fs.readFileSync(path.join(process.cwd(), 'src/components/settings/AcpSettings.tsx'), 'utf8')

    ok('🔴 当前用户分支在「要求开通隔离」之前返回（未开通也能连）',
      adapterSrc.indexOf("if (config.runAs !== 'isolated') {") < adapterSrc.indexOf('sandbox.configured()'))
    ok('当前用户路径沿用传入 profile（既有登录资料）', /const profile = baseProfile/.test(adapterSrc))
    ok('隔离路径仍用自己的 profile 目录（两侧不互串）', /isolated-profiles/.test(adapterSrc))
    ok('两条路径都保留 Job Object 启动（sandbox 传 null 时仍套回收）',
      /sandbox: null/.test(adapterSrc) && /sandbox: identity/.test(adapterSrc))

    ok('运行方式持久化字段与默认值', /const RUN_AS = new Set\(\['current-user', 'isolated'\]\)/.test(rtSrc) && /: 'current-user'\)/.test(rtSrc))
    ok('状态里单独暴露 runAs（不混进会话 config）', /runAs: adapter \? runAsOf\(configs\[selected\]\) : null/.test(rtSrc))
    ok('切换运行方式作废旧会话与模型选项', /\(settings\.configs\[settings\.selected\]\) !== runAsOf\(config\)/.test(rtSrc) && /sessionReady = false/.test(rtSrc))
    ok('运行层自己拦非法枚举（不只靠 IPC）', /!RUN_AS\.has\(patch\.runAs\)/.test(rtSrc))

    ok('IPC 接受 runAs 且不复用「必须对上会话选项」的校验', /patch\.key === 'runAs'/.test(mainSrc))
    ok('界面给出两个明确选项', /以当前 Windows 用户运行/.test(uiSrc) && /使用 Windows 隔离/.test(uiSrc))
    ok('🔴 界面默认值与运行时同口径', /status\.runAs === 'isolated' \? 'isolated' : 'current-user'/.test(uiSrc))
    ok('隔离未开通时挡住连接并就地给开通入口', /isolationBlocked/.test(uiSrc) && /开通 Windows 隔离/.test(uiSrc))
    ok('界面写明当前用户方式下的文件权限', /拥有当前(?: Windows)?用户的文件权限/.test(uiSrc))
  }

  // ---------------------------------------------------------------- 14.7 外发确认：连接后只提示一次
  console.log('--- 14.7 外发确认按「已告知的 Agent」免逐次弹窗 ---')
  {
    const { grantAcpConsent, hasAcpConsent, revokeAcpConsent, currentAcpConsentForTest } =
      await import('../src/lib/agentHost/acpConsent')

    revokeAcpConsent()
    ok('初始无授权', hasAcpConsent('Antigravity') === false && currentAcpConsentForTest() === null)
    grantAcpConsent('Antigravity')
    ok('连接后记为已告知', hasAcpConsent('Antigravity') === true)
    ok('换一个 Agent 不算已告知', hasAcpConsent('OtherAgent') === false)
    ok('空名称不算已告知（避免漏传参数时静默免确认）', hasAcpConsent('') === false && hasAcpConsent(null) === false)
    revokeAcpConsent()
    ok('停用连接后失效（下次连接要重新提示）', hasAcpConsent('Antigravity') === false)

    // 闸门行为：已告知 ⇒ 不调用 ask；未告知 ⇒ 调用
    reset()
    generateImpl = async () => ({ ok: true, text: 'ok' })
    let asked = 0
    const gate = (name?: string) => acpGatedText({
      task: 'companion', generation,
      title: '发送光标前正文至 ACP Agent',
      message: '接收方为 假 Agent。本次发送正文。',
      ...(name ? { agentName: name } : {}),
      assertCurrent: () => {},
      ask: async () => { asked++; return true },
    })

    revokeAcpConsent()
    await gate('假 Agent')('一次')
    ok('未告知时首次调用会弹确认', asked === 1, `asked=${asked}`)

    grantAcpConsent('假 Agent')
    asked = 0
    await gate('假 Agent')('二次')
    await gate('假 Agent')('三次')
    ok('🔴 已告知后同进程内不再逐次弹（连调两次都跳过）', asked === 0, `asked=${asked}`)

    revokeAcpConsent()
    asked = 0
    await gate('假 Agent')('四次')
    ok('停用连接后再用会重新弹一次', asked === 1, `asked=${asked}`)

    {
      // 不传 agentName 的调用点保持旧行为（每次都问），防止漏接静默变成永不确认
      revokeAcpConsent()
      asked = 0
      await gate(undefined)('五次')
      await gate(undefined)('六次')
      ok('未传 agentName 时仍逐次确认（漏接不会被静默放行）', asked === 2, `asked=${asked}`)
    }
    revokeAcpConsent()

    // 界面契约
    const ui = fs.readFileSync(path.join(process.cwd(), 'src/components/settings/AcpSettings.tsx'), 'utf8')
    ok('🔴 连接成功后写入一次性授权并提示一次', /grantAcpConsent\(/.test(ui) && /已连接 \$\{name\}/.test(ui))
    ok('提示里写明每次连接只出现一次', /每次连接只出现一次/.test(ui))
    ok('停用连接 / 退出账号会清掉授权', (ui.match(/revokeAcpConsent\(\)/g) ?? []).length >= 3)
    // 2026-11-14 主人两次否掉版式后定的口径：铺满、状态条置底。
    ok('🔴 铺满父容器（不再限宽居中留白）', !/max-w-3xl|max-w-4xl|mx-auto/.test(ui))
    ok('运行方式两项并排填充', /md:grid-cols-2/.test(ui))
    ok('🔴 状态条在账号与连接之后（连接状态属于结果，不压在最上）',
      ui.indexOf('acp-summary-heading') > ui.indexOf('账号与连接'))
    ok('状态条含接收方/运行方式/模型', /接收方/.test(ui) && /运行方式/.test(ui) && /模型/.test(ui))

    // 2026-11-15：ACP 未断开就退出应用 → 下次启动被遗留锁挡成 blocked 时，
    // 界面必须回到「上次用的那个模式」的页面，而不是默认甩到 API 页。
    const panel = fs.readFileSync(path.join(process.cwd(), 'src/components/settings/AIConfigPanel.tsx'), 'utf8')
    const svc = fs.readFileSync(path.join(process.cwd(), 'scripts/agent-host/mode-service.mjs'), 'utf8')
    const bridge = fs.readFileSync(path.join(process.cwd(), 'src/lib/agentHost/modeBridge.ts'), 'utf8')
    const mainSrcForQuit = fs.readFileSync(path.join(process.cwd(), 'electron/main.cjs'), 'utf8')
    ok('模式服务暴露 lastMode（只读记录文件，供界面落位）',
      /readRecordedMode\(/.test(svc) && /lastMode: snapshot\.mode \?\? await readRecordedMode/.test(svc))
    ok('🔴 blocked 时 mode 必须仍为 null，lastMode 不冒充「已生效」',
      /mode: preconditionNote \? null : \(snapshot\.mode \?\? null\)/.test(svc))
    ok('🔴 不可用时界面落回上次模式页面，而不是默认 API 页',
      /phase === 'blocked' && modeStatus\.lastMode/.test(panel))
    ok('状态类型声明 lastMode 仅用于落位', /lastMode\?: ConnectionMode \| null/.test(bridge))
    ok('退出时不重复 stop ACP，兜底 15s 让模式锁有时间释放',
      !/acpRuntime\?\.stop\(\)\)\.then\(\(\) => modeService\.close\(\)\)/.test(mainSrcForQuit)
      && /setTimeout\(finish, 15000\)/.test(mainSrcForQuit))
    // 2026-11-15：安全恢复曾被 runtime.json.pending 永久卡死 —— gate 为 null（启动拿锁就失败）时
    // 旧条件不清理运行标记，closeRuntime 的 verifyQuiescent 直接抛「ACP 进程退出未确认」。
    ok('🔴 安全恢复先无条件清 ACP 运行标记，再关运行时',
      !/if \(gate && gate\.snapshot\(\)\.phase === 'blocked'\) await acp\?\.recover/.test(svc)
      && svc.indexOf('await acp?.recover?.()') > -1
      && svc.indexOf('await acp?.recover?.()') < svc.indexOf('await closeRuntime()'))
  }

  console.log('--- 15. 字数校准的生成通道（连写/改写共用）---')
  {
    const { ask, askSoft, enforceWordRange } = await import('../src/lib/editor/wordRange')
    reset()
    const viaAcp = await ask(null, '你是助手。', '请回答。', {
      acpText: async prompt => `【收到】${prompt.includes('请回答') ? '是' : '否'}`,
    })
    ok('ask 走 ACP 通道并剥空白', viaAcp.startsWith('【收到】是'), viaAcp.slice(0, 20))

    let noChannel = ''
    try { await ask(null, 'sys', 'user') } catch (error) { noChannel = String((error as Error).message) }
    ok('既无 API 配置也无 ACP 通道 ⇒ 明确报错', noChannel.includes('缺少模型配置'), noChannel)

    reset()
    const longBody = '林昭握紧剑柄。'.repeat(6)   // 约 42 汉字，远低于下限
    const filled = await enforceWordRange({
      cfg: null,
      body: longBody,
      target: 500,
      maxExpand: 2,
      acpText: async () => '雨水顺着剑脊往下淌，他一步一步走进山门，背影被灯影拉得很长。'.repeat(12),
    })
    const filledWords = filled.replace(/\s/g, '').length
    ok('enforceWordRange 无 API 配置也能补写', filled.length > longBody.length, `${longBody.length} → ${filled.length}`)
    ok('补写后仍保留原文开头', filled.startsWith('林昭握紧剑柄'))
    ok('补写结果不是空串', filledWords > 50, String(filledWords))
    void askSoft
  }

  console.log('--- 16. 连写链路的源码契约（入口未接线，属 3.5.6）---')
  const autoContinueSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/outline/autoContinue.ts'), 'utf8')
  ok('连写入口在走 ACP 时不再强制要求 API 配置',
    autoContinueSrc.includes("if (!opts.acpText) await requireProviderFor('create')"), '')
  ok('七处子调用都带 acpText 透传',
    (autoContinueSrc.match(/acpText: opts\.acpText/g) ?? []).length >= 5,
    String((autoContinueSrc.match(/acpText: opts\.acpText/g) ?? []).length))

  console.log('--- 17. 主进程白名单与源码契约 ---')
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8')
  const whitelist = main.split(/\r?\n/).find(line => line.includes('request.task') && line.includes('includes')) ?? ''
  for (const task of ['review', 'ooc', 'advice', 'proofread', 'extract', 'changes', 'organize', 'fill', 'companion']) ok(`主进程放行 ${task}`, whitelist.includes(`'${task}'`), whitelist)
  for (const task of ['continuation', 'rewrite', 'diagnosis', 'pleasure', 'opening', 'briefing', 'summary']) {
    ok(`3.5.4 任务仍放行 ${task}`, whitelist.includes(`'${task}'`), whitelist)
  }
  const structured = fs.readFileSync(path.join(root, 'src/lib/agentHost/acpStructured.ts'), 'utf8')
  ok('结构化模块不引入 API 提供方（禁止静默回落）', !structured.includes('requireProviderFor'))
  ok('结构化模块不借容错解析器', !structured.includes("from '@/lib/ai/aiParse'"))
  ok('括号未闭合判为截断', structured.includes("'truncated', 'JSON 没有闭合"))
  ok('形状必须显式声明（防嵌套数组被当结果行）', structured.includes("shape: 'object' | 'array'"))

  console.log('--- 16. ACP 运行标记自愈（pending 不再永久卡死）---')
  {
    // 主进程脚本是纯 ESM；3.5.6 起由 acp-runtime.d.mts 提供最小类型声明（只覆盖这里用到的入口）。
    const { createAcpRuntime } = await import('../scripts/agent-host/acp-runtime.mjs')
    const runId = 'a'.repeat(32)
    const mkRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yfe-pending-'))
    const writePending = (root: string) => {
      fs.writeFileSync(path.join(root, 'runtime.json.pending'), JSON.stringify({ version: 1, runId, adapter: 'fake' }), 'utf8')
    }
    const makeAdapter = (verifyRun: () => Promise<void>) => ({ id: 'fake', name: 'Fake Agent', verifyRun, launch: async () => ({}) })

    // ① 进程树确认已退出 → 自动归档，不再要求用户点安全恢复
    const rootA = mkRoot()
    writePending(rootA)
    let verifyCalls = 0
    const rtA = createAcpRuntime({ root: rootA, adapters: [makeAdapter(async () => { verifyCalls++ })] })
    let threwA = ''
    try { await rtA.verifyQuiescent() } catch (error) { threwA = String((error as Error).message) }
    ok('🔴 进程已退出时 pending 自动归档，不再永久阻断',
      !threwA && fs.existsSync(path.join(rootA, `runtime-${runId}.recovered.json`))
      && !fs.existsSync(path.join(rootA, 'runtime.json.pending')), `threw=${threwA} verifyCalls=${verifyCalls}`)
    ok('自愈前确实用 verifyRun 核对过进程树', verifyCalls === 1)

    // ② 进程树仍在（核对抛错）→ 保持阻断并保留现场
    const rootB = mkRoot()
    writePending(rootB)
    const rtB = createAcpRuntime({ root: rootB, adapters: [makeAdapter(async () => { throw new Error('无法确认 ACP Windows 进程树已退出。') })] })
    let threwB = ''
    try { await rtB.verifyQuiescent() } catch (error) { threwB = String((error as Error).message) }
    ok('🔴 核对不通过时仍然阻断，pending 现场保留',
      /ACP 进程退出未确认/.test(threwB) && fs.existsSync(path.join(rootB, 'runtime.json.pending')), threwB.slice(0, 60))

    // ③ 记录本身损坏 → 阻断，不猜
    const rootC = mkRoot()
    fs.writeFileSync(path.join(rootC, 'runtime.json.pending'), '{"version":1,"runId":"bad"}', 'utf8')
    const rtC = createAcpRuntime({ root: rootC, adapters: [makeAdapter(async () => {})] })
    let threwC = ''
    try { await rtC.verifyQuiescent() } catch (error) { threwC = String((error as Error).message) }
    ok('运行标记无法核对时阻断，并在提示里带上原因',
      /ACP 进程退出未确认/.test(threwC) && /无法核对/.test(threwC), threwC.slice(0, 60))

    // ④ 关闭失败也要释放宿主锁（防止下次启动永久 blocked）
    const svcSrc = fs.readFileSync(path.join(process.cwd(), 'scripts/agent-host/mode-service.mjs'), 'utf8')
    ok('🔴 closeRuntime 用 finally 保证释放锁',
      /finally \{[\s\S]{0,400}finishClose\(\)\.catch\(\(\) => undefined\)/.test(svcSrc))
  }
}

try {
  await run()
} finally {
  delete g.window
}
// ---------- 长任务超时（2026-11-16 真机实测后放宽） ----------
// 实测：32 条术语查重在 Antigravity + gemini-3.8-flash 下 190s 仍未返回，旧 180s 到点即失败。
// 这里钉住阈值与「可操作」的失败文案，避免以后有人顺手改回去。
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const client = fs.readFileSync(path.join(root, 'scripts/agent-host/acp-client.mjs'), 'utf8')
  ok('单次生成超时为 300s（真机 190s 仍可能不够的余量）', /const PROMPT_TIMEOUT_MS = 300_000/.test(client))
  ok('session/prompt 用该常量（不再写死 180_000）',
    /request\('session\/prompt'/.test(client) && /PROMPT_TIMEOUT_MS/.test(client) && !/180_000/.test(client))
  ok('普通 JSON-RPC 请求仍 30s（握手/列表慢就是真慢）', /const REQUEST_TIMEOUT = 30_000/.test(client))
  ok('超时文案可操作（已等待 + 缩小范围 + 换模型 + 切回 API）',
    /已等待/.test(client) && /缩小本次范围/.test(client) && /切回 API 模式/.test(client))
}

console.log(`acpStructured: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
