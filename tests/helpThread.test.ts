// ============ 3.3.1 · §5.5：连续追问的参考主题 ============
//
// 这批用例守的是「追问到底在问什么」这件事：
//   · 「那怎么保存」「这个也需要模型吗」必须**重新检索**，不能只把上次回答塞给模型；
//   · 追问不再让「当前打开的这一页」加权压过上一轮主题；
//   · 作者点名的主题优先于当前页（本页加权不许改写排序）；
//   · 只有**校验通过**的回答才能成为下一轮主题；失败输出、未校验流一律不进上下文；
//   · 上一轮回答不能当本轮依据 —— 拿上轮的原文当 quote 必须被判「对不上」。
import fs from 'node:fs'
import path from 'node:path'
import {
  ASK_CLARIFY_TEXT, HELP_ARTICLES, SELF_TOPIC_SCORE, buildThreadContextLine, buildTopicQuery,
  getHelpArticle, hasStrongAnaphora, looksLikeFollowUp, routeAskRecall, searchHelp, topicFromAnswer,
} from '../src/lib/help'
import { askHelpOnce } from '../src/lib/aiTasks/helpAsk'
import { buildHelpAnswerPrompt, prepareHelpPromptFragments } from '../src/lib/aiTasks/helpAnswer'
import type { chat, resolveProviderFor } from '../src/lib/ai'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const threadSrc = read('src/lib/help/thread.ts')
const askSrc = read('src/lib/aiTasks/helpAsk.ts')
const panel = read('src/components/help/AskPanel.tsx')

/** 从真实手册里造一个「上一轮已验证」的主题（用最长的一段正文，保证够当依据） */
function topicFrom(articleId: string, question: string) {
  const article = getHelpArticle(articleId)
  const body = article?.sections[0]?.body.join('\n') ?? ''
  return { question, answer: body.slice(0, 200), articleIds: [articleId], titles: [article?.title ?? articleId] }
}
const articleWith = (needle: string) => HELP_ARTICLES.find(article => article.title.includes(needle))!

// ---------- 指代判定 ----------
{
  ok('「那怎么保存」是追问（强指代「那」）', looksLikeFollowUp('那怎么保存', null))
  ok('「这个也需要模型吗」是追问（强指代「这个」）', looksLikeFollowUp('这个也需要模型吗', null))
  ok('「它会不会丢」是追问', looksLikeFollowUp('它会不会丢', null))
  ok('🔴「还有哪些快捷键」没有可信主题时**不算**追问（弱指代不能把新问题拖回旧主题）',
    !looksLikeFollowUp('还有哪些快捷键', null))
  const topic = topicFrom(articleWith('字太小').id, '字太小怎么放大')
  ok('有可信主题时「也」可以作为追问信号', looksLikeFollowUp('缩放也是这样吗', topic) || looksLikeFollowUp('也支持快捷键吗', topic))
  ok('自带主题的问题不算追问', !looksLikeFollowUp('世界设定怎么新建条目', null))
  ok('空白输入不算追问', !looksLikeFollowUp('   ', null))
  ok('强指代判据对外可单独用', hasStrongAnaphora('这个功能在哪') && !hasStrongAnaphora('怎么导出'))
}

// ---------- 补充查询与提示词上下文 ----------
{
  const topic = topicFrom(articleWith('字太小').id, '字太小怎么放大')
  const query = buildTopicQuery(topic)
  ok('补充查询包含上一问原话', query.includes('字太小怎么放大'))
  ok('补充查询包含上一轮依据的文章标题', query.includes(topic.titles[0]))
  ok('补充查询只用本机检索，不含模型改写', !/model|chat/i.test(query))

  const line = buildThreadContextLine(topic)!
  ok('🔴 上下文行写明「只用于理解指代」', /只用于理解/.test(line))
  ok('🔴 上下文行写明「不能当作事实」', /不能当作事实/.test(line))
  ok('🔴 上下文行禁止引用片段之外的原文', /片段之外/.test(line))
  ok('没有主题时不生成上下文行', buildThreadContextLine(null) === null)

  const hits = searchHelp('字太小怎么放大', { limit: 3 })
  const without = buildHelpAnswerPrompt('字太小怎么放大', hits)
  const withLine = buildHelpAnswerPrompt('字太小怎么放大', hits, prepareHelpPromptFragments(hits), line)
  ok('不带追问上下文时提示词里没有「上一轮」', !/上一轮/.test(without.user))
  ok('带追问上下文时「上一轮」出现在 user 内容里', /上一轮/.test(withLine.user))
  ok('系统指令不因追问而改变（校验口径不能放松）', withLine.system === without.system)
}

// ---------- 主题只能由已验证回答构造 ----------
{
  const topic = topicFromAnswer('字太小怎么放大', '在设置里调界面缩放', [
    { articleId: articleWith('字太小').id }, { articleId: articleWith('字太小').id },
  ])!
  ok('由回答构造的主题带文章 id', topic.articleIds.length === 1 && !!topic.articleIds[0])
  ok('同一篇文章只记一次', topic.articleIds.length === 1)
  ok('主题带文章标题（界面显示「接着上一问」用）', topic.titles.length === 1 && topic.titles[0].length > 0)
  ok('🔴 没有依据的回答造不出主题（不污染下一轮）',
    topicFromAnswer('随便问问', '模型胡说的内容', []) === null)
  ok('回答正文被截断保存', topic.answer.length <= 240)
}

// ---------- 召回：追问时不再让本页加权压过上一问 ----------
{
  const zoom = articleWith('字太小')
  const topic = topicFrom(zoom.id, '字太小怎么放大')
  // 从「角色」页问一句「那模型呢」：追问 ⇒ 主查询不加本页权重
  const follow = routeAskRecall('那模型呢', 'char-main', topic)
  ok('追问被识别', follow.followUp)
  ok('追问借用上一问主题（界面显示「本次参考」）', !!follow.usedTopic && follow.usedTopic.articleIds[0] === zoom.id)
  ok('补充来的片段排在主查询之后（不抢作者这次问的主题）',
    follow.hits.length > 0 && follow.fromTopic.every(key => !`${follow.hits[0].articleId}/${follow.hits[0].sectionId}`.includes(key) || follow.hits.length === 1))
  ok('🔴 追问的召回里能找到上一问那篇文章（重新检索过，不是只把上次回答塞给模型）',
    follow.hits.some(hit => hit.articleId === zoom.id))

  // 无主题的含糊指代 ⇒ 澄清，且不请求模型
  const vague = routeAskRecall('它在哪里', 'char-main', null)
  ok('🔴 含糊指代且没有可信主题时要求澄清', vague.needsClarify)
  ok('澄清不返回任何「可当答案」的片段依据', vague.hits.length === 0)
}

// ---------- 显式主题优先于当前页加权 ----------
{
  // 在真实手册里找一个例子：本页加权把「作者点名的那篇」挤到了后面
  const tabCandidates = [...new Set(HELP_ARTICLES.flatMap(article => article.tabIds))].slice(0, 24)
  // 问题用「作者会怎么说」而不是文章标题：标题与文章一一对应，本页加权永远改不动排序，
  // 真正会被加权改写的是「弱命中的自然问句」（如「敏感词检查」在正文页）。
  const questions = [
    ...HELP_ARTICLES.map(article => article.title),
    '怎么保存', '保存', '备份', '导出', '导入', '快捷键', '模型怎么配', '校对怎么用', '角色卡怎么建',
    '术语重名怎么合并', '伏笔怎么记', '地图怎么画', '大纲怎么排', '时间线怎么用', '图鉴怎么改', '云同步',
    '打赏', '新手引导', '手册在哪', '字太小', '复制失败', '拆书', '酒馆怎么开始', '灵感', '敏感词检查',
    '设定变更', '进度怎么记',
  ]
  let found: { question: string; tabId: string; plain: string; weighted: string } | null = null
  for (const question of questions) {
    for (const tabId of tabCandidates) {
      const plain = searchHelp(question, { currentTabId: null, limit: 6 })
      const weighted = searchHelp(question, { currentTabId: tabId, limit: 6 })
      const top = plain[0]
      if (!top || top.score < SELF_TOPIC_SCORE || !weighted[0]) continue
      if (weighted[0].articleId === top.articleId) continue
      if (top.tabIds.includes(tabId)) continue
      found = { question, tabId, plain: top.articleId, weighted: weighted[0].articleId }
      break
    }
    if (found) break
  }
  if (found) {
    const routed = routeAskRecall(found.question, found.tabId, null)
    ok(`🔴 点名主题不被本页加权顶掉（「${found.question}」在 ${found.tabId} 页点名「${found.plain}」）`,
      routed.hits[0]?.articleId === found.plain,
      `实际 ${routed.hits[0]?.articleId}，加权排序会给出 ${found.weighted}`)
  } else {
    ok('记录：当前手册数据里没有出现「本页加权改变排序」的例子，该规则由静态守卫保证',
      /显式主题优先/.test(threadSrc) && /top\.articleId !== primary\[0\]\.articleId/.test(threadSrc))
  }
}

// ---------- 追问全链路：澄清不问模型、上轮原文不能当本轮依据 ----------
{
  let chats = 0
  const noProvider = async () => null
  const countedChat = (async () => { chats++; return '{}' }) as typeof chat
  const deps = { resolveProviderFor: noProvider as typeof resolveProviderFor, chat: countedChat }

  const clarify = await askHelpOnce('它在哪里', 'char-main', undefined, deps)
  ok('🔴 含糊指代返回 clarify（先本地澄清）', clarify.kind === 'clarify')
  ok('澄清文案与判据同源（界面不另写一份）', clarify.kind === 'clarify' && clarify.message === ASK_CLARIFY_TEXT)
  ok('澄清时一次模型请求都没发', chats === 0)

  const zoom = articleWith('字太小')
  const topic = topicFrom(zoom.id, '字太小怎么放大')
  const noModel = await askHelpOnce('那怎么改回来', 'editor', undefined, deps, { lastTopic: topic })
  ok('追问在有可信主题时正常走召回（不再澄清）', noModel.kind === 'no-model' || noModel.kind === 'no-recall')
  ok('结果带回本轮参考主题', !!noModel.topic && noModel.topic.articleIds[0] === zoom.id)

  // 上轮回答里的原文，如果不在**本次**片段里，就不能当依据
  const previousOnly = HELP_ARTICLES.find(article => {
    const text = article.sections[0]?.body.join('') ?? ''
    return article.id !== zoom.id && text.length >= 20
  })!
  const foreignQuote = previousOnly.sections[0].body.join('').slice(0, 24)
  const attempted = await askHelpOnce('那怎么改回来', 'editor', undefined, {
    resolveProviderFor: async () => ({} as NonNullable<Awaited<ReturnType<typeof resolveProviderFor>>>),
    chat: (async () => JSON.stringify({ answer: '拿上一轮的原文当依据', quotes: [foreignQuote] })) as typeof chat,
  }, { lastTopic: topic })
  ok('🔴 引用上一轮（不在本次片段里）的原文 ⇒ 判「对不上」，不显示为答案',
    attempted.kind === 'fallback' && /无法核对|对不上/.test(attempted.message),
    attempted.kind)
}

// ---------- 编排接线 ----------
{
  ok('🔴 答疑主流程走「追问感知」召回（不是裸 recallForAsk）',
    /routeAskRecall\(question, currentTabId/.test(askSrc))
  ok('澄清在请求模型之前就返回（没有先花一次调用再让作者澄清）',
    /needsClarify\) return \{ kind: 'clarify'/.test(askSrc))
  ok('上一轮上下文只在「真的用了主题」时才进提示词',
    /buildThreadContextLine\(topic\)/.test(askSrc))
}

// ---------- 界面接线 ----------
{
  ok('🔴 面板把「上一轮已验证主题」传给提问', /askHelpOnce\([^)]*\{ lastTopic \}\)/.test(panel))
  ok('只有 answer 分支才更新主题（失败输出不进上下文）',
    /if \(result\.kind === 'answer'\) \{\s*\n\s*const topic = topicFromAnswer/.test(panel))
  ok('清空对话同时清空参考主题', /setTurns\(\[\]\); setLastTopic\(null\)/.test(panel))
  ok('面板会渲染「接着上一问」的参考主题', /data-help-topic/.test(panel) && /接着上一问/.test(panel))
  ok('面板会渲染澄清选项（点了按那篇重新问）', /data-help-clarify/.test(panel) && /result\.options\.map/.test(panel))
  ok('🔴 澄清与「手册没写」措辞分开（不能混成一句）',
    /result\.kind === 'clarify'/.test(panel) && /本地手册里没有找到直接对应的段落/.test(panel))
  ok('混版本不再摆一个点了也没用的「换用本地手册检索」按钮', !/>\s*换用本地手册检索\s*</.test(panel))
}

console.log(`\n用例结束：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
