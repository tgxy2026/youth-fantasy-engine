/**
 * 整章改写 · 落库安全边界
 *
 * 为什么要闸：改写会**覆盖作者正文**，是本项目里唯一直接改既有原文的动作。
 * 三条边界必须钉死，任一破了都是数据事故：
 *   ① 只动 content / wordCount / updatedAt —— 标题 / 状态 / 卷属 / 排序一律不碰；
 *   ② 写前**必存快照**（旧稿要能恢复）；
 *   ③ **同步章节台账**（否则「章节总表」与项目字数停在旧值上）。
 * 另测两个纯函数：cleanChapterOutput（剥围栏 / 前言）与 listRewriteCandidates 的叙事顺序。
 */
import * as db from '../src/lib/db'
import {
  applyChapterRewrite, expectedRewriteWords, isSuspectRewrite, listRewriteCandidates,
} from '../src/lib/chapterRewrite'
import { CHAPTER_REWRITE_META, cleanChapterOutput, type ChapterRewriteAction } from '../src/lib/aiTasks'
import { __resetMockStores } from './mock-memory'
import fs from 'node:fs'
import type { Chapter, Volume } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

__resetMockStores()
const proj = await db.createProject('改写闸测试')
db.setCurrentProject(proj.id)

const vol = (id: string, order: number, title: string): Volume =>
  ({ id, projectId: proj.id, order, title, description: '', createdAt: 0 })
const chap = (id: string, volumeId: string, order: number, title: string, content: string, excl?: boolean): Chapter => ({
  id, projectId: proj.id, volumeId, order, title, content,
  summary: '', status: '草稿', wordCount: content.length, createdAt: 0, updatedAt: 0,
  ...(excl ? { excludeFromNumbering: true } : {}),
})

await db.saveVolume(vol('v1', 0, '第一卷'))
await db.saveVolume(vol('v2', 1, '第二卷'))
await db.saveChapter(chap('prologue', 'v1', 0, '序章', '序章正文。'.repeat(20), true))
await db.saveChapter(chap('c2', 'v1', 1, '第一章 起', '原文一。'.repeat(60)))
await db.saveChapter(chap('c3', 'v2', 0, '第二章 承', '原文二。'.repeat(60)))

// ---------- ① 候选列表：按 (卷序, 章序) 展平，序号不计「不计入序号」的章 ----------
{
  const cands = await listRewriteCandidates()
  ok('候选按真实叙事顺序列出（跨卷正确）',
    cands.map(c => c.chapter.id).join(',') === 'prologue,c2,c3',
    cands.map(c => c.chapter.id).join(','))
  ok('🔴 「不计入序号」的序章序号为 0，其余从 1 连续',
    cands.map(c => c.no).join(',') === '0,1,2',
    cands.map(c => c.no).join(','))
}

// ---------- ② 落库：只动三个字段 ----------
{
  const before = (await db.getAllChapters()).find(c => c.id === 'c2') as Chapter
  const next = '改写后的正文。'.repeat(80)
  const { words } = await applyChapterRewrite('c2', next)
  const after = (await db.getAllChapters()).find(c => c.id === 'c2') as Chapter
  ok('正文被整体替换', after.content === next.trim())
  ok('字数按新正文重算', after.wordCount === words && words > 0, `${words}`)
  ok('updatedAt 已刷新', after.updatedAt >= before.updatedAt)
  ok('🔴 标题 / 状态 / 卷属 / 排序一律没动（改写不改章节身份）',
    after.title === before.title && after.status === before.status &&
    after.volumeId === before.volumeId && after.order === before.order,
    `${after.title}/${after.status}/${after.volumeId}/${after.order}`)
  ok('其它章节没被牵连', ((await db.getAllChapters()).find(c => c.id === 'c3') as Chapter).content === '原文二。'.repeat(60))
}

// ---------- ③ 快照：旧稿可恢复 ----------
{
  const snaps = await db.getSnapshots('c2')
  ok('🔴 写前留了旧稿快照（旧稿内容可在「时光机」里找回）',
    snaps.some(s => s.content === '原文一。'.repeat(60)),
    `${snaps.length} 版`)
}

// ---------- ④ 章节台账同步 ----------
{
  const rows = await db.getTableRows('chapter-vol-v1')
  const row = rows.find(r => r.id === 'ch-c2')
  const words = ((await db.getAllChapters()).find(c => c.id === 'c2') as Chapter).wordCount
  ok('🔴 章节台账的「字数」跟着更新（否则章节总表停在旧值）',
    !!row && row.data['字数'] === String(words),
    row ? `台账=${row.data['字数']} 章节=${words}` : '没找到台账行')
  ok('台账标题仍是原标题', !!row && row.data['章节标题'] === '第一章 起')
}

// ---------- ⑤ 拒绝空结果（绝不把正文清空） ----------
{
  const good = ((await db.getAllChapters()).find(c => c.id === 'c2') as Chapter).content
  let threw = false
  try { await applyChapterRewrite('c2', '   \n  ') } catch { threw = true }
  ok('空结果直接抛错、不落盘', threw)
  ok('拒绝后正文原样还在', ((await db.getAllChapters()).find(c => c.id === 'c2') as Chapter).content === good)
  let threw2 = false
  try { await applyChapterRewrite('不存在的章', '正文') } catch { threw2 = true }
  ok('章节不存在时抛错（不新建幽灵章）', threw2)
}

// ---------- ⑥ 纯函数：cleanChapterOutput ----------
{
  ok('剥掉 markdown 围栏', !cleanChapterOutput('```\n正文内容\n```').includes('```'), cleanChapterOutput('```\n正文内容\n```'))
  ok('剥掉「好的，以下是…」开场',
    cleanChapterOutput('好的，以下是改写后的正文：\n\n真正的正文') === '真正的正文',
    cleanChapterOutput('好的，以下是改写后的正文：\n\n真正的正文'))
  ok('正文原样不被误伤（含中文引号与冒号）',
    cleanChapterOutput('他说：「走。」然后转身离开。') === '他说：「走。」然后转身离开。')
  ok('CRLF 归一化', !cleanChapterOutput('第一段\r\n第二段').includes('\r'))
}

// ---------- ⑦ 结果异常保护（直接调真实函数，不再写"镜像断言" —— 镜像会随实现悄悄漂移） ----------
// 判据是「与**期望字数**的差距」，不是「相对原文的固定占比」。后者有两处结构性缺陷（2026-09-19 修）：
//   ① 正常**精简**必被误判 —— 压到目标字数必然远低于原文（原文 3800 → 目标 1200 只占 31.6%）；
//   ② **扩写**方向的严重缩水漏判（原文 2000 / 目标 6000，只给 1500 占原文 75%，不报异常）。
{
  const at = (a: ChapterRewriteAction, from: number, target?: number) => expectedRewriteWords(a, from, target)

  ok('期望字数 · 润色＝原文长度（不看目标字数）', at('polish', 2886, 3000) === 2886)
  ok('期望字数 · 扩写 / 精简 / 改写＝面板填的目标字数',
    at('expand', 2886, 5200) === 5200 && at('condense', 2886, 1200) === 1200 && at('rewrite', 2886, 3000) === 3000)
  ok('期望字数 · 没填目标时退回原文长度（不会把期望算成 0 → 一切皆可疑）', at('expand', 2886) === 2886)

  ok('🔴 模型只吐 1 个字（原文 2886）判定为异常', isSuspectRewrite(2886, 1, at('polish', 2886)))
  ok('🔴 精简压到目标 1200 字不再被误判（旧口径按"原文 35%"必锁住替换）',
    !isSuspectRewrite(2886, 1200, at('condense', 2886, 1200)))
  ok('🔴 扩写缩水（目标 6000 只给 1500）现在能判出异常（旧口径漏判）',
    isSuspectRewrite(2886, 1500, at('expand', 2886, 6000)))
  ok('正常润色（2886 → 3000）不误判', !isSuspectRewrite(2886, 3000, at('polish', 2886)))
  ok('精简却越改越长（目标 1200 给 4200）判为异常', isSuspectRewrite(2886, 4200, at('condense', 2886, 1200)))
  ok('短章不套用该保护（原文 600 字以内不判异常）', !isSuspectRewrite(400, 50, at('polish', 400)))

  // C1（2.4.2）拆分后：实现分散在 7 个文件 —— 拼接后再断言（口径不变）
  const panel = [
    'src/components/CreativeWritingPanel.tsx',
    'src/components/creativeWritingParts.tsx',
    'src/components/useCreativeWritingModel.ts',
    'src/components/CreativeSetupSection.tsx',
    'src/components/CreativeFlowSections.tsx',
    'src/components/CreativeRewriteSection.tsx',
    'src/components/CreativeDialogs.tsx',
  ].map(f => fs.readFileSync(f, 'utf8')).join('\n')
  ok('🔴 异常结果在界面上被锁住替换（不是只弹个提示就放开）',
    /disabled=\{!!s\.rewrite\.suspect\}/.test(panel))
}

// ---------- ⑧ 动作元数据 ----------
{
  ok('润色不要目标字数（改了字数就不是润色了）', CHAPTER_REWRITE_META.polish.needWords === false)
  ok('扩写 / 精简 / 改写都要目标字数',
    CHAPTER_REWRITE_META.expand.needWords && CHAPTER_REWRITE_META.condense.needWords && CHAPTER_REWRITE_META.rewrite.needWords)
  ok('四种动作都有中文标签与说明',
    (['polish', 'expand', 'condense', 'rewrite'] as const).every(k => !!CHAPTER_REWRITE_META[k].label && !!CHAPTER_REWRITE_META[k].hint))
}

// ---------- ⑨ 改写纪律是「动作 × 章位置」矩阵（不是只按"章位置"分） ----------
// 老大 2026-09-19 要求：历史章不产生新设定是对的，但**不只"改写"这一档**要管 —— 扩写可能凭空造设定
// （「一柄剑」→「师父所赠的断岳剑」）、精简可能删掉设定交代（「得自青云宗的储物戒」→「储物戒」），
// 两者在历史章同样必须冻结。反过来「最新章」也不能无差别放开：润色本来就不增删情节，
// 被当成"可重排场景 / 可改写局部走向"是越权授权 —— 两份规则打架时模型会挑宽松的那条。
{
  // ⚠️ 2026-09-19 D1：三条改写纪律提示词已从 aiTasks.ts 拆到 aiTasks/rewrite.ts（随域走）。
  const src = fs.readFileSync('src/lib/aiTasks/rewrite.ts', 'utf8')
  ok('🔴 历史章纪律按动作分节（润色 / 扩写 / 精简 / 改写四档各有边界）',
    ['「润色」：只换字不换事', '「扩写」：', '「精简」：', '「改写」：只改叙述方式'].every(s => src.includes(s)))
  ok('🔴 历史章 · 扩写：描写层可加、信息层不可加（防"凭空造设定"）',
    src.includes('描写层可以加，信息层不可以加'))
  ok('🔴 历史章 · 精简：承载设定交代的句子一律保留（防"删掉来历"）',
    src.includes('承载设定交代的句子一律保留'))
  ok('🔴 最新章：只有「改写」档可放开，润色 / 扩写 / 精简仍守各自纪律（消除越权授权）',
    src.includes('只有「改写」这一档可以放开手脚') && src.includes('不因「最新章」而放宽'))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
