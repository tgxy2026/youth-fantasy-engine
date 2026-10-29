// ============ 3.3.1 · P4：答疑的调用归属与回退 ============
//
// 这批用例守的是「这通电话打给谁、打不通怎么办」：
//   · 归属必须是**全局**（scope:'global' + projectId:null），不能混进当前小说的任务；
//   · 提示词必须**隔离**（skipUserSystem:true），不能把创作指令当成产品事实；
//   · 没召回到片段就**不许**问模型（没有依据的模型回答等于编）；
//   · 一次提交只发一次逻辑调用 —— 不自动重问、不修复 JSON 再问；
//   · 问题与回答**不落盘**（不碰 db / localStorage）。
import fs from 'node:fs'
import path from 'node:path'
import { ASK_RECALL_LIMIT, askHelpOnce, recallForAsk } from '../src/lib/aiTasks/helpAsk'
import type { chat, resolveProviderFor } from '../src/lib/ai'
import { getHelpArticle, HELP_INDEX, isHelpContentConsistent } from '../src/lib/help'
import { helpSourceSnapshot } from '../src/lib/aiTasks/helpAnswer'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const src = read('src/lib/aiTasks/helpAsk.ts')
const panel = read('src/components/help/AskPanel.tsx')
const center = read('src/components/help/HelpCenter.tsx')
const hub = read('src/components/app/ProjectHub.tsx')

// ---------- 召回：答疑与手册页同一套检索 ----------
{
  const hits = recallForAsk('字太小怎么放大')
  ok('真实问题能召回到片段', hits.length > 0, `${hits.length}`)
  ok('召回条数不超过答疑上限', hits.length <= ASK_RECALL_LIMIT, `${hits.length}/${ASK_RECALL_LIMIT}`)
  ok('召回的片段一定带文章 + 段落 id（来源可追溯的前提）',
    hits.every(hit => !!hit.articleId && !!hit.sectionId))

  ok('🔴 无关问题召回为空 —— 空召回会让答疑直接走「不问模型」分支',
    recallForAsk('量子纠缠的退相干时间').length === 0)
  ok('空白提问不召回', recallForAsk('   ').length === 0)
}

// ---------- 归属：全局 + 不落盘 ----------
{
  ok('🔴 调用归属是全局（scope:global 且 projectId:null）',
    /scope:\s*'global'/.test(src) && /projectId:\s*null/.test(src))
  ok('标了答疑任务类型（账本里能与创作任务区分）', /taskType:\s*'help-answer'/.test(src))
  ok('有独立的 intent，便于预算与诊断归因', /intent:\s*'help-answer'/.test(src))
  ok('🔴 提示词隔离：跳过作者的创作附加系统提示词', /skipUserSystem:\s*true/.test(src))
  ok('不改作者的模型配置（只在本次调用上跳过注入）',
    !/saveProviders|systemPrompt\s*:\s*''/.test(src))
  ok('🔴 不落盘：问题、回答、召回片段都不写库', !/from '@\/lib\/db'/.test(src) && !/localStorage|setMeta|putSetting/.test(src))
  ok('不把当前页签塞进提示词（页面标题不是产品事实）',
    !/buildHelpAnswerPrompt\([^)]*currentTabId/.test(src))
}

// ---------- 一次逻辑调用 ----------
{
  const calls = src.match(/\bchat\s*\(/g) ?? []
  ok('🔴 只有一处 chat 调用（一次提交至多一次逻辑调用）', calls.length === 1, `${calls.length}`)
  ok('没有自动重试 / 二次修 JSON 的循环', !/for\s*\(|while\s*\(/.test(src))
  ok('没有失败后换模型再问', !/resolveProviderFor\('create'\)|resolveProviderFor\('review'\)/.test(src))
  ok('走「整理」用途路由（答疑是低频短任务，不占创作模型）', /resolveProviderFor\('utility'\)/.test(src))
  ok('🔴 结构输出走协议声明（output/reasoning），不用旧 json:true（闸 outputProtocol ⑨）',
    /output:\s*'json-object'/.test(src) && /reasoning:\s*'off'/.test(src)
    && !/json:\s*true/.test(src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')))
  ok('作者可以停（把 signal 一路传下去）', /signal,?\s*\n?\s*\}\)/.test(src) || /signal[,}]/.test(src))
  ok('取消要如实返回 cancelled，不能说成失败', /isCancelled\(error\)/.test(src) && /kind:\s*'cancelled'/.test(src))
}

// ---------- 回退：答不出就给检索结果 ----------
{
  ok('🔴 没召回就提前返回，不请求模型', /if \(hits\.length === 0\) return \{ kind: 'no-recall'/.test(src))
  ok('没模型时不假装答过（kind=no-model 只带回片段）', /kind:\s*'no-model'/.test(src))
  ok('校验不过退回检索结果', /kind:\s*'fallback'/.test(src) && /readHelpAnswer\(raw, hits, fragments\)/.test(src))
}

// ---------- 目录、正文与索引在当前会话内不一致时不得发请求 ----------
{
  const entry = HELP_INDEX[0]
  const original = entry.text
  let providerReads = 0
  try {
    entry.text = `${original} 索引异常`
    ok('索引变化会触发一致性检查', !isHelpContentConsistent())
    const result = await askHelpOnce('字太小怎么放大', null, undefined, {
      resolveProviderFor: async () => { providerReads++; return null },
      chat: (async () => '{}') as typeof chat,
    })
    ok('索引不一致时不读取配置或发模型请求', result.kind === 'fallback' && providerReads === 0)
  } finally { entry.text = original }
  ok('恢复索引后当前会话可继续检查', isHelpContentConsistent())
}

// ---------- 配置读取与停止的真实异步时序（不访问模型或真实配置） ----------
{
  let calls = 0
  const fakeChat = (async () => { calls++; return '{}' }) as typeof chat
  const failed = await askHelpOnce('字太小怎么放大', null, undefined, {
    resolveProviderFor: async () => { throw new Error('配置读取失败') }, chat: fakeChat,
  })
  ok('配置读取失败时保留手册结果并说明失败',
    failed.kind === 'fallback' && failed.hits.length > 0 && /配置读取失败/.test(failed.message))
  ok('配置读取失败不会请求模型', calls === 0)

  let release!: (provider: Awaited<ReturnType<typeof resolveProviderFor>>) => void
  const providerPending = new Promise<Awaited<ReturnType<typeof resolveProviderFor>>>(resolve => { release = resolve })
  const controller = new AbortController()
  const pending = askHelpOnce('字太小怎么放大', null, controller.signal, {
    resolveProviderFor: () => providerPending, chat: fakeChat,
  })
  controller.abort()
  release({} as NonNullable<Awaited<ReturnType<typeof resolveProviderFor>>>)
  const stopped = await pending
  ok('读取配置期间停止会返回 cancelled', stopped.kind === 'cancelled')
  ok('停止之后不会发出迟到的模型请求', calls === 0)

  const alreadyStopped = new AbortController()
  alreadyStopped.abort()
  let reads = 0
  const cancelled = await askHelpOnce('字太小怎么放大', null, alreadyStopped.signal, {
    resolveProviderFor: async () => { reads++; return null }, chat: fakeChat,
  })
  ok('提问前已停止时不读取模型配置', cancelled.kind === 'cancelled' && reads === 0)

  let finishChat!: (value: string) => void
  const chatPending = new Promise<string>(resolve => { finishChat = resolve })
  const lateController = new AbortController()
  const lateResult = askHelpOnce('字太小怎么放大', null, lateController.signal, {
    resolveProviderFor: async () => ({} as NonNullable<Awaited<ReturnType<typeof resolveProviderFor>>>),
    chat: (() => chatPending) as typeof chat,
  })
  await Promise.resolve()
  lateController.abort()
  finishChat('{}')
  ok('模型忽略停止信号而迟到时仍返回 cancelled', (await lateResult).kind === 'cancelled')

  const hit = recallForAsk('字太小怎么放大')[0]
  const section = getHelpArticle(hit.articleId)!.sections.find(item => item.id === hit.sectionId)!
  const savedBody = section.body
  try {
    let modelCalls = 0
    const changedBeforeCall = await askHelpOnce('字太小怎么放大', null, undefined, {
      resolveProviderFor: async () => {
        section.body = ['读取模型配置时手册内容发生变化']
        return {} as NonNullable<Awaited<ReturnType<typeof resolveProviderFor>>>
      },
      chat: (async () => { modelCalls++; return '{}' }) as typeof chat,
    })
    ok('请求前手册变化时不发模型请求', changedBeforeCall.kind === 'fallback' && modelCalls === 0)
    section.body = savedBody
    const stale = await askHelpOnce('字太小怎么放大', null, undefined, {
      resolveProviderFor: async () => ({} as NonNullable<Awaited<ReturnType<typeof resolveProviderFor>>>),
      chat: (async () => {
        section.body = ['请求期间手册内容发生了变化']
        return JSON.stringify({ answer: '答', quotes: [savedBody.join('\n').slice(0, 20)] })
      }) as typeof chat,
    })
    ok('模型请求期间手册改变时不展示旧回答', stale.kind === 'fallback' && /发生变化/.test(stale.message))
    section.body = savedBody
    const answer = await askHelpOnce('字太小怎么放大', null, undefined, {
      resolveProviderFor: async () => ({} as NonNullable<Awaited<ReturnType<typeof resolveProviderFor>>>),
      chat: (async () => JSON.stringify({ answer: '答', quotes: [savedBody.join('\n').slice(0, 20)] })) as typeof chat,
    })
    const key = `${hit.articleId}/${hit.sectionId}`
    const originalSnapshot = answer.kind === 'answer' ? answer.sourceSnapshots[key] : undefined
    ok('成功回答保留对应来源快照', !!originalSnapshot && originalSnapshot === helpSourceSnapshot(hit.articleId, hit.sectionId))
    section.body = ['内容在展示回答之后发生变化']
    ok('旧答案可以检测展示之后的来源变化', !!originalSnapshot && originalSnapshot !== helpSourceSnapshot(hit.articleId, hit.sectionId))
  } finally { section.body = savedBody }
}

// ---------- 界面：入口用词、会话只在内存 ----------
{
  ok('入口统一叫「使用答疑助手」', /使用答疑助手/.test(center))
  ok('内部区分「查手册」与「问 AI」', /查手册/.test(center) && /问 AI/.test(center))
  ok('问 AI 面板常驻挂载（打开依据不丢对话）', /className=\{article \? 'hidden' : ''\}/.test(center))
  ok('🔴 会话只在组件内存（无持久化、无写库）',
    !/localStorage|sessionStorage|from '@\/lib\/db'/.test(panel))
  ok('对话可清空，且写明不影响统计', /清空/.test(panel) && /不会删除运行统计/.test(panel))
  ok('未配置模型时仍可提问，只是标注不是 AI 回答', /这一条不是 AI 回答/.test(panel))
  ok('回答必须展示依据并可点开原文', /依据（点开看原文那一段）/.test(panel))
  ok('输入法组合中不误发（中文打字不会打一半就发出去）', /isComposing/.test(panel))
  ok('停止后晚到的结果不许覆盖新一轮（代次校验）', /mine !== generation\.current/.test(panel))
  ok('项目管理页提供手册入口（未打开项目也能读）', /使用手册/.test(hub) && /projectOpen=\{false\}/.test(hub))
  ok('未打开项目时「前往功能」禁用并说明原因', /先打开一个项目，才能跳到这个功能页/.test(center))
}

console.log(`\n—— helpAsk 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
