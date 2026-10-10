// ============ 平台粘贴版可配置格式 + Markdown 标题层级（C6 · 2.4.2）单测 ============
//
// 最要紧的一条回归：**不带选项的老调用行为必须与 2.4.1 完全一致**（默认值兜底）。
// 另外钉住：numbered 按叙事序派生（含「不计入序号」章保留原题）、compact 间距、
// 不含卷标题、headingOffset 整体下移且越界钳制。
import type { Chapter, Volume } from '../src/lib/types'
import { bookToPlatformText, bookToMarkdown } from '../src/lib/storage/exporter'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ exportPlatform')

const mkCh = (id: string, title: string, content: string, extra: Partial<Chapter> = {}): Chapter =>
  ({ id, projectId: 'p1', volumeId: 'v1', order: 0, title, content, summary: '', status: '草稿', wordCount: 0, createdAt: 0, updatedAt: 0, ...extra } as unknown as Chapter)
const vol = { id: 'v1', projectId: 'p1', title: '第一卷', order: 1 } as unknown as Volume

const c1 = mkCh('c1', '风起', '　　第一段。\n　　第二段。', { order: 1 })
const c2 = mkCh('c2', '云涌', '　　第三段。\n\n\n　　第四段。', { order: 2 })
const c3 = mkCh('c3', '序章·楔子', '　　楔子正文。', { order: -1, excludeFromNumbering: true })
const chs = [c2, c1, c3] // 故意乱序传入，靠 order 排

// ---------- ① 默认行为不变（回归） ----------
{
  const pt = bookToPlatformText([vol], chs)
  ok('默认：带卷标题', pt.includes('第一卷'))
  ok('默认：标题原样', pt.includes('风起') && pt.includes('云涌'))
  ok('默认：段间空一行', pt.includes('　　第一段。\n\n　　第二段。'))
  ok('默认：折叠多余空行', !pt.includes('\n\n\n'), JSON.stringify(pt.split('\n').slice(0, 8)))
  ok('默认：保留行首缩进（A5 回归）', pt.includes('　　第一段。'))
  // 排序按 order：c3(-1) → c1(0) → c2(0)；同 order 按 sort 稳定性，c1 在 c2 前
  ok('默认：按叙事序输出', pt.indexOf('序章·楔子') < pt.indexOf('风起') && pt.indexOf('风起') < pt.indexOf('云涌'))
}

// ---------- ② 章节标题样式 ----------
{
  const numbered = bookToPlatformText([vol], chs, { chapterTitle: 'numbered' })
  ok('numbered：普通章补全局序号', numbered.includes('第1章 风起') && numbered.includes('第2章 云涌'), numbered.split('\n').slice(0, 4).join(' | '))
  ok('numbered：不计入序号的章保留原题', numbered.includes('序章·楔子') && !numbered.includes('第0章'))

  const none = bookToPlatformText([vol], chs, { chapterTitle: 'none' })
  ok('none：不带标题行', !none.includes('风起') && !none.includes('云涌') && none.includes('　　第一段。'))
}

// ---------- ③ 段落间距 / 卷标题 ----------
{
  const compact = bookToPlatformText([vol], chs, { paragraphGap: 'compact' })
  ok('compact：段间单换行', compact.includes('　　第一段。\n　　第二段。'))

  const noVol = bookToPlatformText([vol], chs, { includeVolumeTitle: false })
  ok('不含卷标题行', !noVol.includes('第一卷'))
  ok('不含卷标题时正文仍在', noVol.includes('　　第一段。'))
}

// ---------- ④ Markdown 标题层级 ----------
{
  const md0 = bookToMarkdown('测试书', [vol], chs)
  ok('offset 0（默认）：# 书 / ## 卷 / ### 章', md0.includes('# 测试书') && md0.includes('## 第一卷') && md0.includes('### 风起'))

  const md1 = bookToMarkdown('测试书', [vol], chs, { headingOffset: 1 })
  ok('offset 1：整体下移一级', md1.includes('## 测试书') && md1.includes('### 第一卷') && md1.includes('#### 风起'))
  ok('offset 1：不再有一级标题', !md1.includes('\n# ') && !md1.startsWith('# '))

  // 越界钳制：传超大值不炸、钳到最深 ######（书名 1+3=4 级，章名 3+3=6 级）
  const mdBig = bookToMarkdown('测试书', [vol], chs, { headingOffset: 9 as unknown as 0 })
  ok('越界 offset 被钳制：书名 #### / 章 ######', mdBig.includes('#### 测试书') && mdBig.includes('###### 风起') && !mdBig.includes('#######'))
  ok('正文缩进约定不受 offset 影响', md1.includes('　　第一段。'))
}

console.log(`\n  ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
