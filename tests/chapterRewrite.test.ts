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
import { applyChapterRewrite, listRewriteCandidates } from '../src/lib/chapterRewrite'
import { CHAPTER_REWRITE_META, cleanChapterOutput } from '../src/lib/aiTasks'
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

// ---------- ⑦ 结果异常保护（纯判定：阈值口径写死在 creativeSession，这里锁住它） ----------
{
  const suspect = (srcLen: number, outLen: number) => srcLen > 600 && outLen < srcLen * 0.35
  ok('🔴 模型只吐 1 个字（原文 2886）判定为异常', suspect(2886, 1))
  ok('正常扩写（2886 → 4500）不误判', !suspect(2886, 4500))
  ok('正常精简（压到 40% 原文）不误判', !suspect(2886, 1200))
  ok('短章不套用该保护（原文 600 字以内不判异常）', !suspect(400, 50))
  const panel = fs.readFileSync('src/components/CreativeWritingPanel.tsx', 'utf8')
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

console.log(`\n${fail === 0 ? '✅' : '❌'} 共 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`)
if (fail) process.exit(1)
