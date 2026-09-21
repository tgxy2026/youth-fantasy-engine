// ============ 导出侧缩进一致性（2.4.0 · A5）============
//
// A5 的验收第 6 条：「导出 TXT / MD / 平台粘贴版的缩进与编辑器一致」。
// 这条最危险的地方在于**它在看不见的地方退化** —— 导出链路里三处都曾用 `s.trim()`，
// 会把手写缩进整段抹掉，而作者往往要等到投稿、贴到平台后台时才发现版面全乱了。
// 所以这里把三条链路都钉住：逐行缩进必须与编辑器里的正文一模一样。
import type { Chapter, Volume } from '../src/lib/types'
import { chaptersToTxt, bookToMarkdown, bookToPlatformText } from '../src/lib/exporter'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const F = '\u3000'
const U = F.repeat(2) // 一个缩进单位

/** 三级缩进样本：段首 / 一级 / 二级 */
const CONTENT = [
  '段首正常的一段。',
  U + '缩进一级的对白。',
  U.repeat(2) + '缩进两级的补充说明。',
  '',
  '结尾段。',
].join('\n')

const vol = { id: 'v1', projectId: 'p1', title: '第一卷', order: 1 } as unknown as Volume
const ch = {
  id: 'c1', projectId: 'p1', volumeId: 'v1', order: 1, title: '第一章',
  content: CONTENT, summary: '', status: '草稿', wordCount: 100,
  createdAt: 0, updatedAt: 0,
} as unknown as Chapter

// ---------- ① TXT ----------
{
  const txt = chaptersToTxt([ch], [vol])
  ok('TXT：保留缩进一级', txt.includes(U + '缩进一级的对白。'))
  ok('TXT：保留缩进二级', txt.includes(U.repeat(2) + '缩进两级的补充说明。'))
  ok('TXT：段首行仍是无缩进的原样',
    txt.includes('段首正常的一段。') && !txt.includes(U + '段首正常的一段。'))
  ok('🔴 TXT：没有"被 trim 压到行首"的痕迹',
    !txt.includes('\n缩进一级的对白。') && !txt.includes('\n缩进两级的补充说明。'),
    JSON.stringify(txt.split('\n').filter(l => l.includes('缩进')).map(l => l.slice(0, 12))))
}

// ---------- ② Markdown ----------
{
  const md = bookToMarkdown('测试书', [vol], [ch])
  ok('MD：保留缩进一级', md.includes(U + '缩进一级的对白。'))
  ok('MD：保留缩进二级', md.includes(U.repeat(2) + '缩进两级的补充说明。'))
  ok('MD：标题层级仍在', md.includes('# 测试书') && md.includes('### 第一章'))
  // 默认缩进单位是**全角**空格 —— Markdown 只把「行首 4 个半角空格」当代码块，故默认单位安全
  ok('🔴 MD：默认单位（全角）不会把正文变成代码块', !/\n {4}/.test(md))
}

// ---------- ③ 平台粘贴版 ----------
{
  const pt = bookToPlatformText([vol], [ch])
  ok('粘贴版：保留缩进一级', pt.includes(U + '缩进一级的对白。'))
  ok('粘贴版：保留缩进二级', pt.includes(U.repeat(2) + '缩进两级的补充说明。'))
  ok('粘贴版：段间仍规范成一个空行',
    pt.includes('段首正常的一段。\n\n' + U + '缩进一级的对白。'))
  ok('🔴 粘贴版：行尾空白仍被清掉（清理职责没丢）', !/[ \t]+$/m.test(pt))
  ok('粘贴版：连续空行仍被折叠', !pt.includes('\n\n\n'))
}

// ---------- ④ 三条链路口径一致 ----------
{
  const cnt = (s: string) => s.split('\n').filter(l => l.startsWith(U)).length
  const txt = cnt(chaptersToTxt([ch], [vol]))
  const md = cnt(bookToMarkdown('测试书', [vol], [ch]))
  const pt = cnt(bookToPlatformText([vol], [ch]))
  ok('🔴 三条导出链路对缩进的处理一致（各 2 行带缩进）',
    txt === 2 && md === 2 && pt === 2, `txt=${txt} md=${md} pt=${pt}`)
}

console.log(`\n—— exportIndent：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exitCode = 1
