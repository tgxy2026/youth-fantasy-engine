// ============ 整书证据包（A4 遗留补全）============
// 覆盖点：总览统计 / 逐章版本数与"名额已满"标记 / 细纲有无 / JSON 全量 /
//         文档模型结构 / 文件名 / 声明不含绝对化承诺 / 空项目不崩。
import {
  buildBookEvidencePack, bookPackToDocModel, bookPackToJson,
  bookEvidenceHtmlFileName, bookEvidenceJsonFileName, bookEvidenceSummary, bookDailyRange,
  DEFAULT_BOOK_EVIDENCE_OPTIONS, BOOK_EVIDENCE_KIND, BOOK_EVIDENCE_SPEC_VERSION,
} from '../src/lib/bookEvidence'
import { toHtml } from '../src/lib/tavern/exportDoc'
import { MAX_SNAPSHOTS_PER_CHAPTER } from '../src/lib/db/chapters'
import type { CardRecord, Chapter, Volume } from '../src/lib/types'
import type { Snapshot } from '../src/lib/db'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const D = (s: string) => new Date(s).getTime()
const T0 = D('2026-09-01T10:00:00')
const T1 = D('2026-09-20T11:00:00')

const vol: Volume = { id: 'v1', projectId: 'p', title: '卷一', order: 0, description: '', createdAt: T0 }
const ch = (id: string, order: number, wordCount: number, title: string): Chapter => ({
  id, projectId: 'p', volumeId: 'v1', order, title,
  content: '正文'.repeat(wordCount), summary: '', status: '草稿',
  wordCount, createdAt: T0 + order * 86400000, updatedAt: T0 + order * 86400000 + 3600000,
})
const chapters = [ch('c1', 0, 3000, '第一章'), ch('c2', 1, 0, '第二章'), ch('c3', 2, 2500, '第三章')]
const outline: CardRecord = {
  id: 'k1', projectId: 'p', tabId: 'chapter-outline', name: '第1章 第一章', order: 0, data: { '定位::事件': '开端' },
}
const snaps: Snapshot[] = [
  { id: 's1', projectId: 'p', chapterId: 'c1', chapterTitle: '第一章', content: 'a', wordCount: 10, createdAt: T1, source: 'ai-rewrite' },
  { id: 's2', projectId: 'p', chapterId: 'c1', chapterTitle: '第一章', content: 'b', wordCount: 12, createdAt: T1 + 1, source: 'auto' },
  { id: 's3', projectId: 'p', chapterId: 'c3', chapterTitle: '第三章', content: 'c', wordCount: 20, createdAt: T1 + 2, source: 'auto' },
]
const dailyStats = [
  { date: '2026-09-01', words: 1000 },
  { date: '2026-09-02', words: 0 },
  { date: '2026-09-03', words: 500 },
]

const pack = buildBookEvidencePack({
  projectName: '吞天神脉', chapters, volumes: [vol], snapshots: snaps,
  outlineCards: [outline], dailyStats, exportedAt: T1,
})

// ---------- ① 结构标识与来源 ----------
{
  ok('① kind / specVersion 正确', pack.kind === BOOK_EVIDENCE_KIND && pack.specVersion === BOOK_EVIDENCE_SPEC_VERSION)
  ok('① 生成器署名', pack.generator.app.includes('青春幻想引擎'))
  ok('① 作品名带过来', pack.project.name === '吞天神脉')
  ok('① 导出时间可读', pack.exportedAtLabel.length > 10, pack.exportedAtLabel)
}

// ---------- ② 总览统计 ----------
{
  const o = pack.overview
  ok('② 章节数 = 3', o.chapters === 3, String(o.chapters))
  ok('② 有正文的章节 = 2（第二章是空的）', o.writtenChapters === 2, String(o.writtenChapters))
  ok('② 总字数 = 5500', o.totalWords === 5500, String(o.totalWords))
  ok('② 累计版本数 = 3', o.totalVersions === 3, String(o.totalVersions))
  ok('② 活跃写作天数 = 2（09-02 是 0）', o.activeDays === 2, String(o.activeDays))
  ok('② firstAt / lastAt 取自章节时间戳', o.firstAt === T0 && o.lastAt === T0 + 2 * 86400000 + 3600000)
}

// ---------- ③ 逐章行：章号 / 版本数 / 细纲 ----------
{
  const c1 = pack.chapters.find(r => r.id === 'c1')!
  const c2 = pack.chapters.find(r => r.id === 'c2')!
  ok('③ 章号按全书顺序算出（c1 = 第 1 章）', c1.no === 1, String(c1.no))
  ok('③ c1 版本数 = 2', c1.versions === 2, String(c1.versions))
  ok('③ c1 有细纲', c1.hasOutline)
  ok('③ c2 无细纲 / 无版本', !c2.hasOutline && c2.versions === 0, JSON.stringify({ o: c2.hasOutline, v: c2.versions }))
  ok('③ 顺序按章号升序', pack.chapters.map(r => r.no).join(',') === '1,2,3', pack.chapters.map(r => r.no).join(','))
  ok('③ 未满名额时不误报截断', pack.chapters.every(r => !r.likelyTruncated))
}

// ---------- ④ 名额满 → 标记"更早的已被清理" ----------
{
  const full: Snapshot[] = Array.from({ length: MAX_SNAPSHOTS_PER_CHAPTER }, (_, i) => ({
    id: `f${i}`, projectId: 'p', chapterId: 'c1', chapterTitle: '第一章',
    content: 'x', wordCount: 5, createdAt: T1 + i, source: 'auto' as const,
  }))
  const p2 = buildBookEvidencePack({
    projectName: 'X', chapters, volumes: [vol], snapshots: full,
    outlineCards: [], dailyStats: [], exportedAt: T1,
  })
  ok('④ 版本名额满的章节被标记 likelyTruncated',
    p2.chapters.find(r => r.id === 'c1')!.likelyTruncated)
  ok('④ 声明里写明了版本上限', p2.statement.some(s => s.includes(String(MAX_SNAPSHOTS_PER_CHAPTER))))
}

// ---------- ⑤ JSON 全量 + 文档模型 ----------
{
  const json = JSON.parse(bookPackToJson(pack))
  ok('⑤ JSON 可解析且含逐章行', !!json && json.chapters.length === 3)
  ok('⑤ JSON 含原始时间戳（数字而非字符串）', typeof json.chapters[0].createdAt === 'number')

  const html = toHtml(bookPackToDocModel(pack, DEFAULT_BOOK_EVIDENCE_OPTIONS))
  ok('⑤ HTML 含成书总览', html.includes('成书总览'))
  ok('⑤ HTML 含逐章一览', html.includes('逐章一览'))
  ok('⑤ HTML 含写作分布', html.includes('写作分布'))
  ok('🔴 ⑤ HTML 写明每日字数口径（不按章节拆分）', html.includes('不按章节拆分'))
  ok('⑤ HTML 列出各章标题', html.includes('第一章') && html.includes('第三章'))
  ok('⑤ HTML 打印样式仍在', html.includes('@media print'))
  ok('⑤ HTML 自包含', !/<(script|link|img)[^>]*(src|href)=/i.test(html) && !/https?:\/\//.test(html))
}

// ---------- ⑥ 关掉选项后对应区块消失 ----------
{
  const html = toHtml(bookPackToDocModel(pack, { includeChapterList: false, includeDaily: false }))
  ok('⑥ 关掉逐章一览后不再出现该节', !html.includes('逐章一览'))
  ok('⑥ 关掉写作分布后不再出现该节', !html.includes('写作分布'))
  ok('⑥ JSON 不受选项影响（仍含逐章行）', JSON.parse(bookPackToJson(pack)).chapters.length === 3)
}

// ---------- ⑦ 声明与产品立场 ----------
{
  const ABSOLUTE_PROMISE = /全程本地|不外发|不上传|绝不外发|纯本地/
  const all = pack.statement.join('\n')
  ok('🔴 ⑦ 声明无绝对化"不外发"承诺', !ABSOLUTE_PROMISE.test(all), all.slice(0, 80))
  ok('🔴 ⑦ 声明点明不做规避检测', all.includes('绕过 AI 检测'))
  ok('⑦ 声明交代数据来源', all.includes('创作记录'))
}

// ---------- ⑧ 文件名 / 摘要 / 区间 / 空项目 ----------
{
  ok('⑧ HTML 文件名规范', bookEvidenceHtmlFileName(pack) === '吞天神脉-成书过程证据包.html', bookEvidenceHtmlFileName(pack))
  ok('⑧ JSON 文件名规范', bookEvidenceJsonFileName(pack) === '吞天神脉-成书过程证据包.json', bookEvidenceJsonFileName(pack))
  ok('⑧ 摘要给出规模感', bookEvidenceSummary(pack).includes('章'), bookEvidenceSummary(pack))
  ok('⑧ 写作日期区间取首尾',
    JSON.stringify(bookDailyRange(pack)) === JSON.stringify({ from: '2026-09-01', to: '2026-09-03' }),
    JSON.stringify(bookDailyRange(pack)))

  const empty = buildBookEvidencePack({
    projectName: '', chapters: [], volumes: [], snapshots: [], outlineCards: [], dailyStats: [],
  })
  ok('⑧ 空项目不崩：计数全 0、时间为 null', empty.overview.chapters === 0 && empty.overview.firstAt === null)
  ok('⑧ 空项目作品名有兜底', empty.project.name === '未命名作品', empty.project.name)
  const emptyHtml = toHtml(bookPackToDocModel(empty, DEFAULT_BOOK_EVIDENCE_OPTIONS))
  ok('⑧ 空项目也能渲染出文档', emptyHtml.includes('成书总览') && emptyHtml.includes('还没有章节'))
}

console.log(`\n整书证据包（A4）：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
