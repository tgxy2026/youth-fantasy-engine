// ============ DOCX 排版选项与投稿稿件（E2 · 2.6.2）============
//
// 三条被钉死的东西：
// ① 🔴 零变化红线：layout 为 undefined 时，生成的 XML 必须与旧版逐字节一致
//    （旧版：标题只有 <w:b/>，正文无任何 rPr / pPr）。这是 E2 的硬验收 ——
//    「不选任何选项时导出与现状观感零变化」，靠空 opts 不生成节点的**结构性**保证，
//    不是「默认值恰好等于现状」，所以必须逐字节断言。
// ② 排版选项：rPr 子元素按 OOXML schema 序（rFonts → b → sz → szCs），
//    pPr 按 spacing → ind → jc；left 不写 jc、单倍行距不写 spacing（与现状同口径）。
// ③ 投稿稿件：书名（黑体 22pt 加粗居中）→ 简介（可空）→ 选定章节（按全书卷章
//    顺序重排 —— 传入顺序不影响输出；未分卷章节垫底，与 chaptersToTxt 口径一致）。
import type { Chapter, Volume } from '../src/lib/types'
import { buildDocxBody, buildSubmissionDocxBody } from '../src/lib/exporter'
import type { DocxLayoutOptions } from '../src/lib/exporter'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const vol1 = { id: 'v1', projectId: 'p1', title: '第一卷', order: 1 } as unknown as Volume
const vol2 = { id: 'v2', projectId: 'p1', title: '第二卷', order: 2 } as unknown as Volume
function mkCh(id: string, volumeId: string, order: number, title: string, content: string) {
  return { id, projectId: 'p1', volumeId, order, title, content, summary: '', status: '草稿', wordCount: 100, createdAt: 0, updatedAt: 0 } as unknown as Chapter
}
const ch1 = mkCh('c1', 'v1', 1, '第一章 初入', '段首正常的一段。\n\n第二段。')
const ch2 = mkCh('c2', 'v1', 2, '第二章 再战', '第二卷前的章节。')
const ch3 = mkCh('c3', 'v2', 1, '第三章 破境', '卷二的章节。')
const orphan = mkCh('c9', 'v-none', 1, '外传', '未分卷的章节。')
const chapters = [ch1, ch2, ch3, orphan]
const volumes = [vol1, vol2]

const SUBMISSION: DocxLayoutOptions = { fontSizePt: 12, align: 'left', firstLineChars: 2, lineSpacing: 1.5, bodyFont: '宋体' }

// ---------- ① 零变化红线：无 layout 与旧版逐字节一致 ----------
{
  const body = buildDocxBody('测试书', volumes, chapters)
  ok('🔴 无 layout：书名段与旧版逐字节一致',
    body[0] === '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">测试书</w:t></w:r></w:p>',
    body[0])
  ok('🔴 无 layout：卷标题段与旧版逐字节一致',
    body[1] === '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">第一卷</w:t></w:r></w:p>',
    body[1])
  ok('🔴 无 layout：章标题段与旧版逐字节一致',
    body[2] === '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">第一章 初入</w:t></w:r></w:p>',
    body[2])
  ok('🔴 无 layout：正文段无任何样式节点',
    body[3] === '<w:p><w:r><w:t xml:space="preserve">段首正常的一段。</w:t></w:r></w:p>',
    body[3])
  const all = body.join('')
  ok('🔴 无 layout：全文档不含 sz / ind / jc / spacing / rFonts',
    !all.includes('w:sz') && !all.includes('w:ind') && !all.includes('w:jc')
    && !all.includes('w:spacing') && !all.includes('w:rFonts'))
  ok('🔴 无 layout：未分卷章节不进全书 DOCX（旧版现状口径 —— 只有 volumes 循环，零变化红线钉住它；投稿稿才带 orphan，见④）',
    !body.some(s => s.includes('外传')))
}

// ---------- ② 排版选项：投稿标准预设 ----------
{
  const body = buildDocxBody('测试书', volumes, chapters, SUBMISSION)
  const para = body.find(s => s.includes('段首正常的一段。'))!
  ok('投稿标准：正文段 rPr = 宋体 + sz/szCs 24（12pt），无 b',
    para.includes('<w:rPr><w:rFonts w:ascii="宋体" w:eastAsia="宋体" w:hAnsi="宋体"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>'),
    para)
  ok('投稿标准：正文段 pPr = 1.5 倍行距（line 360 auto）+ 首行缩进（480 twips / firstLineChars 200）',
    para.includes('<w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:ind w:firstLine="480" w:firstLineChars="200"/></w:pPr>'),
    para)
  ok('投稿标准：左对齐不写 jc（与 Word 默认同口径）', !para.includes('w:jc'))
  ok('投稿标准：书名黑体 18pt（sz 36）加粗居中',
    body[0].includes('<w:jc w:val="center"/>')
    && body[0].includes('<w:rFonts w:ascii="黑体" w:eastAsia="黑体" w:hAnsi="黑体"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>'),
    body[0])
  ok('投稿标准：章标题黑体 14pt（sz 28）加粗左对齐（无 jc）',
    body[2].includes('<w:sz w:val="28"/>') && body[2].includes('黑体') && !body[2].includes('w:jc'),
    body[2])
}

// ---------- ③ 选项组合：justify / 单倍 / 四号缩进 / 黑体 ----------
{
  const body = buildDocxBody('测试书', volumes, chapters, { fontSizePt: 14, align: 'justify', firstLineChars: 2, lineSpacing: 1, bodyFont: '黑体' })
  const para = body.find(s => s.includes('段首正常的一段。'))!
  ok('两端对齐：jc=justify 且位于 ind 之后（schema 序 spacing→ind→jc）',
    para.includes('<w:ind w:firstLine="560" w:firstLineChars="200"/><w:jc w:val="justify"/>'),
    para)
  ok('单倍行距：不写 spacing（与现状同口径）', !para.includes('w:spacing'))
  ok('四号字：sz/szCs 28', para.includes('<w:sz w:val="28"/><w:szCs w:val="28"/>'))
}
{
  // 紧凑预设：10.5pt + 无缩进 + 单倍 → pPr 全空（无样式段落，仅 rPr 字号）
  const body = buildDocxBody('测试书', volumes, chapters, { fontSizePt: 10.5, align: 'left', firstLineChars: 0, lineSpacing: 1, bodyFont: '宋体' })
  const para = body.find(s => s.includes('段首正常的一段。'))!
  ok('紧凑预设：无缩进 + 单倍 + 左对齐 ⇒ 不生成 pPr',
    para.startsWith('<w:p><w:r><w:rPr>') && !para.includes('w:pPr'),
    para)
  ok('紧凑预设：五号 = sz 21', para.includes('<w:sz w:val="21"/><w:szCs w:val="21"/>'))
}

// ---------- ④ 投稿稿件：结构 ----------
{
  const body = buildSubmissionDocxBody(
    { bookTitle: '测试书', intro: '这是一段投稿简介。', chapterIds: ['c2', 'c1', 'c9'], layout: SUBMISSION },
    volumes, chapters,
  )
  ok('投稿稿：书名黑体 22pt（sz 44）加粗居中',
    body[0] === '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="黑体" w:eastAsia="黑体" w:hAnsi="黑体"/><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr><w:t xml:space="preserve">测试书</w:t></w:r></w:p>',
    body[0])
  ok('投稿稿：第二节是「简介」标题（黑体四号加粗左对齐）',
    body[1] === '<w:p><w:r><w:rPr><w:rFonts w:ascii="黑体" w:eastAsia="黑体" w:hAnsi="黑体"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">简介</w:t></w:r></w:p>',
    body[1])
  const idx = (t: string) => body.findIndex(s => s.includes(`>${t}</w:t>`))
  ok('投稿稿：章节按全书卷章顺序重排（传入乱序不影响输出）',
    idx('第一章 初入') < idx('第二章 再战') && idx('第二章 再战') < idx('外传'),
    `第一章@${idx('第一章 初入')} 第二章@${idx('第二章 再战')} 外传@${idx('外传')}`)
  ok('投稿稿：未选定的章节不出现', !body.some(s => s.includes('第三章 破境')))
  ok('投稿稿：正文段带排版（宋体小四 + 缩进 + 1.5 倍行距）',
    body.find(s => s.includes('段首正常的一段。'))!.includes('<w:ind w:firstLine="480" w:firstLineChars="200"/>'))
  ok('投稿稿：未分卷章节垫底（外传在最后一个卷内选定章之后）', idx('外传') > idx('第二章 再战'))
}
{
  // 空简介 → 跳过简介节，书名后直接进章
  const body = buildSubmissionDocxBody(
    { bookTitle: '测试书', intro: '   ', chapterIds: ['c1'], layout: SUBMISSION },
    volumes, chapters,
  )
  ok('投稿稿：纯空白简介 → 无简介节，第二节直接是第一章',
    !body.some(s => s.includes('>简介</w:t>')) && body[1].includes('第一章 初入'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
