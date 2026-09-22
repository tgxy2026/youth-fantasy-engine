/**
 * B3（2.4.1）AI 辅助占比统计 —— 单测
 *
 * 重点验三件事：
 *   ① 记账是**纯函数**（不改原对象）、脏数据能归一、非正数不记账；
 *   ② 占比口径诚实：AI 产出多于现存正文时**封顶 100%** 并打 `cappedByEdits` 标记；
 *   ③ 🔴 **守门**：那几条"AI 写进正文"的主路径必须调用了 `withAiAssist` ——
 *      这是防漏的关键（`saveChapter` 有 15 个调用点，逐个手挂必漏）。
 */
import { readFileSync } from 'node:fs'
import {
  AI_SOURCE_KINDS, emptyAiAssist, normalizeAiAssist,
  withAiAssist, foldPendingAi, aiRatio, summarizeAiAssist, buildAiDisclosureDraft,
} from '../src/lib/aiAssist'
import type { Chapter } from '../src/lib/types'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mk = (content: string, aiAssist?: Chapter['aiAssist']): Chapter => ({
  id: 'c1', projectId: 'p1', volumeId: 'v1', order: 1, title: '第一章',
  content, summary: '', status: 'draft' as Chapter['status'],
  wordCount: 0, createdAt: 0, updatedAt: 0, aiAssist,
})

console.log('\n▶ aiAssist')

// ---------- 1) 空值与归一 ----------
{
  const e = emptyAiAssist()
  ok('空统计：四类都是 0', AI_SOURCE_KINDS.every(k => e.chars[k] === 0 && e.times[k] === 0))
  ok('空统计：updatedAt 为 0', e.updatedAt === 0)

  ok('归一：undefined → 空统计', normalizeAiAssist(undefined).chars.generated === 0)
  ok('归一：null → 空统计', normalizeAiAssist(null).times.rewritten === 0)
  ok('归一：字符串 → 空统计', normalizeAiAssist('nope').chars.polished === 0)
  const dirty = normalizeAiAssist({ chars: { generated: -5, rewritten: 'x', continued: 12.9 }, updatedAt: 'bad' } as never)
  ok('归一：负数归 0', dirty.chars.generated === 0)
  ok('归一：非数字归 0', dirty.chars.rewritten === 0)
  ok('归一：小数取整', dirty.chars.continued === 12)
  ok('归一：缺失的类补 0', dirty.chars.polished === 0)
  ok('归一：坏 updatedAt 归 0', dirty.updatedAt === 0)
}

// ---------- 2) withAiAssist：纯函数 ----------
{
  const c = mk('正文', undefined)
  const n1 = withAiAssist(c, 'generated', 100)
  ok('🔴 不改原对象（纯函数）', c.aiAssist === undefined)
  ok('返回新对象并带上统计', n1.aiAssist?.chars.generated === 100)
  ok('次数 +1', n1.aiAssist?.times.generated === 1)
  ok('updatedAt 被写入', (n1.aiAssist?.updatedAt ?? 0) > 0)

  const n2 = withAiAssist(n1, 'generated', 50)
  ok('同类累加', n2.aiAssist?.chars.generated === 150)
  ok('同类次数累加', n2.aiAssist?.times.generated === 2)

  const n3 = withAiAssist(n2, 'polished', 30)
  ok('异类分开记', n3.aiAssist?.chars.polished === 30 && n3.aiAssist?.chars.generated === 150)

  ok('非正数不记账（返回原对象）', withAiAssist(n3, 'generated', 0) === n3)
  ok('负数不记账', withAiAssist(n3, 'generated', -10) === n3)
  ok('NaN 不记账', withAiAssist(n3, 'generated', Number.NaN) === n3)
}

// ---------- 3) aiRatio：口径诚实 ----------
{
  const body = '一'.repeat(1000)   // 1000 个汉字
  const none = aiRatio(mk(body))
  ok('无 AI 记录 → 占比 0', none.ratioPct === 0 && none.aiChars === 0)

  const half = aiRatio(mk(body, normalizeAiAssist({ chars: { generated: 500 }, times: { generated: 1 } })))
  ok('AI 500 / 正文 1000 → 50%', half.ratioPct === 50, `${half.ratioPct}%`)
  ok('未触发封顶标记', half.cappedByEdits === false)
  ok('按类拆分的占比', half.byKind.generated === 50)

  // AI 写了 2000 字、作者删到 1000 字 → 占比必须封顶且标记
  const over = aiRatio(mk(body, normalizeAiAssist({ chars: { generated: 2000 }, times: { generated: 1 } })))
  ok('🔴 AI 产出多于现存正文 → 封顶 100%', over.ratioPct === 100, `${over.ratioPct}%`)
  ok('🔴 并置 cappedByEdits（说明经过删改）', over.cappedByEdits === true)

  const emptyBody = aiRatio(mk('', normalizeAiAssist({ chars: { generated: 100 } })))
  ok('正文为空时不除零', emptyBody.ratioPct === 0 && emptyBody.totalChars === 0)
}

// ---------- 4) summarizeAiAssist：全书汇总 ----------
{
  const chs = [
    mk('一'.repeat(1000), normalizeAiAssist({ chars: { generated: 600 }, times: { generated: 2 } })),
    mk('二'.repeat(1000), normalizeAiAssist({ chars: { rewritten: 200 }, times: { rewritten: 1 } })),
    mk('三'.repeat(1000)),   // 纯人工
  ]
  chs[1].content = '二'.repeat(1000)
  const s = summarizeAiAssist(chs)
  ok('章节数只算有内容的', s.chapters === 3, `${s.chapters}`)
  ok('用过 AI 的章数', s.aiChapters === 2, `${s.aiChapters}`)
  ok('AI 总字数 = 600 + 200', s.aiChars === 800, `${s.aiChars}`)
  ok('正文总字数', s.totalChars === 3000, `${s.totalChars}`)
  ok('全书占比 ≈ 26.7%', s.ratioPct === 26.7, `${s.ratioPct}%`)
  ok('按类汇总：generated', s.chars.generated === 600)
  ok('按类汇总：rewritten', s.chars.rewritten === 200)
  ok('按类汇总：次数', s.times.generated === 2 && s.times.rewritten === 1)
  ok('无封顶章节', s.cappedChapters === 0)
  ok('空列表不崩', summarizeAiAssist([]).ratioPct === 0)
}

// ---------- 5) 申报草稿 ----------
{
  const chs = [
    mk('一'.repeat(1000), normalizeAiAssist({ chars: { generated: 600, polished: 100 }, times: { generated: 2, polished: 3 } })),
    mk('二'.repeat(1000)),
  ]
  const s = summarizeAiAssist(chs)
  const d = buildAiDisclosureDraft(s, { bookName: '测试书', generatedAt: Date.UTC(2026, 8, 22) })
  ok('草稿含书名', d.includes('《测试书》'))
  ok('草稿含总字数与章数', d.includes('2,000') && d.includes('2 章'))
  ok('草稿含"用过 AI 的章数"', d.includes('1 章'))
  ok('草稿列出用到的环节（生成）', d.includes('生成（'))
  ok('草稿列出用到的环节（润色）', d.includes('润色（'))
  ok('🔴 草稿不含未使用的环节', !d.includes('改写（'))
  ok('🔴 说明"累计产出量 ≠ 成稿比例"（诚实口径）', d.includes('累计产出量') && d.includes('并不等同'))
  ok('🔴 不含反检测类措辞', !/命中率|规避|降低.*检测|反检测/.test(d))
  ok('注明数据来自自动记录', d.includes('自动记录') && d.includes('非手工填写'))

  const emptyDraft = buildAiDisclosureDraft(summarizeAiAssist([mk('一'.repeat(100))]), {})
  ok('无 AI 记录时也有草稿（且写明未记录到）', emptyDraft.includes('未记录到 AI 辅助产出'))
}

// ---------- 5.5) foldPendingAi：编辑器挂账的合并与消费（B3 补做 · 2.4.1）----------
{
  const chA = { id: 'A' } as Chapter

  const r0 = foldPendingAi([], chA)
  ok('无记账时原样返回（同一对象）', r0.chapter === chA && r0.rest.length === 0)

  const r1 = foldPendingAi([{ chapterId: 'B', kind: 'continued', chars: 100 }], chA)
  ok('别的章的记账不被消费，原样留着', r1.chapter === chA && r1.rest.length === 1)

  const r2 = foldPendingAi([{ chapterId: 'A', kind: 'continued', chars: 120 }], chA)
  ok('同章记账被合并进 aiAssist', r2.chapter.aiAssist?.chars.continued === 120)
  ok('合并后该条不再留在 rest', r2.rest.length === 0)
  ok('合并记 1 次', r2.chapter.aiAssist?.times.continued === 1)

  const r3 = foldPendingAi([
    { chapterId: 'A', kind: 'continued', chars: 100 },
    { chapterId: 'A', kind: 'polished', chars: 50 },
    { chapterId: 'A', kind: 'continued', chars: 30 },
  ], chA)
  ok('多笔同章累加（continued 100+30=130）', r3.chapter.aiAssist?.chars.continued === 130)
  ok('不同类分别计入（polished=50）', r3.chapter.aiAssist?.chars.polished === 50)
  ok('次数按笔数累加（continued 2 次）', r3.chapter.aiAssist?.times.continued === 2)
  ok('三笔全部消费掉', r3.rest.length === 0)

  const r4 = foldPendingAi([
    { chapterId: 'A', kind: 'generated', chars: 200 },
    { chapterId: 'B', kind: 'continued', chars: 9 },
  ], chA)
  ok('混合场景：只消费 A 的账', r4.chapter.aiAssist?.chars.generated === 200 && r4.rest.length === 1)
  ok('混合场景：留下的是 B 的账', r4.rest[0].chapterId === 'B')

  const r5 = foldPendingAi([{ chapterId: 'A', kind: 'continued', chars: 0 }], chA)
  ok('字数为 0 不产生 aiAssist（该条仍被消费掉）', r5.chapter.aiAssist === undefined && r5.rest.length === 0)

  const withPrev = withAiAssist(chA, 'rewritten', 500)
  const r6 = foldPendingAi([{ chapterId: 'A', kind: 'continued', chars: 40 }], withPrev)
  ok('已有记账时是叠加而不是覆盖（rewritten 保留）', r6.chapter.aiAssist?.chars.rewritten === 500)
  ok('叠加后新类也在（continued=40）', r6.chapter.aiAssist?.chars.continued === 40)
  // ⚠️ 注意：withAiAssist 会先 normalize（把未涉及的类填 0），所以这里判 0 而不是 undefined
  ok('原章节对象不被改动（纯函数）', chA.aiAssist === undefined && (withPrev.aiAssist?.chars.continued ?? 0) === 0)
}

// ---------- 6) 🔴 守门：AI 主路径必须记账 ----------
{
  const paths: Array<[string, string]> = [
    ['整章改写', 'src/lib/chapterRewrite.ts'],
    ['自动续写', 'src/lib/autoContinue.ts'],
    ['创意写作', 'src/lib/creativeSession.ts'],
    ['编辑器（伴写采纳 / 选区改稿）', 'src/components/useNovelEditorModel.ts'],
  ]
  for (const [label, f] of paths) {
    let src = ''
    try { src = readFileSync(f, 'utf8') } catch { /* 文件改名就让断言红，正是目的 */ }
    ok(`🔴 守门：${label} 路径有 AI 记账痕迹`, /withAiAssist|applyChapterRewrite|foldPendingAi/.test(src))
  }

  // 🔴 编辑器两条路径（B3 补做 · 2.4.1）：采纳那一刻挂账，落库时合并进该章。
  {
    const model = readFileSync('src/components/useNovelEditorModel.ts', 'utf8')
    const ghost = readFileSync('src/components/useNovelEditorGhost.ts', 'utf8')
    ok('🔴 编辑器：有挂账函数 noteAiAssist', /noteAiAssist\s*=/.test(model))
    ok('🔴 编辑器：落库统一走 saveChapterWithAi', /const saveChapterWithAi\s*=/.test(model))
    // ⚠️ 防"绕过"：saveChapterWithAi 内部那两处 db.saveChapter 是**允许的**（它就是唯一落库出口）；
    //    禁区是 helper **之外**又冒出直接落库 —— 那会让挂起的 AI 账静默漏掉。
    {
      const start = model.indexOf('const saveChapterWithAi')
      const endRaw = start < 0 ? -1 : model.indexOf('\n  }\n', start)
      const outside = start < 0 || endRaw < 0 ? model : model.slice(0, start) + model.slice(endRaw)
      const leaks = (outside.match(/db\.saveChapter\(/g) ?? []).length
      ok('🔴 编辑器：saveChapterWithAi 之外没有直连落库（漏账口子）', leaks === 0, `实得 ${leaks}`)
    }
    ok('🔴 伴写采纳回报了产出字数（onAiAssist 链路完整）',
      /onAiAssist\?\.\(/.test(ghost) && /onAiAssist/.test(model))
  }

  // 🔴 创意写作走的是共用的 `applyChapterRewrite`（那条默认记 rewritten）——
  //    必须显式传 'generated'，否则"从无到有"的产量会被算成"改写"，分类就错了。
  {
    const cs = readFileSync('src/lib/creativeSession.ts', 'utf8')
    ok('🔴 守门：创意写作显式传 generated（不是默认的 rewritten）', /applyChapterRewrite\([^)]*'generated'/.test(cs))
    const cr = readFileSync('src/lib/chapterRewrite.ts', 'utf8')
    ok('守门：applyChapterRewrite 的来源可由调用方声明', /kind:\s*AiSourceKind\s*=\s*'rewritten'/.test(cr))
  }
}

console.log(`\n  aiAssist: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
