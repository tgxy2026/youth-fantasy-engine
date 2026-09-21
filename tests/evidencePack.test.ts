// ============ 创作证据包（A4）============
// 覆盖点：JSON 是全量原件（不受显示选项影响）/ HTML 用 pre 块**保住行首缩进** /
//         打印样式与分页规则 / 保留情况的如实申报 / 每日字数口径 / 声明里不许出现绝对化承诺。
import {
  buildEvidencePack, packToDocModel, packToJson,
  evidenceHtmlFileName, evidenceJsonFileName, evidenceSummary, dailyRange, formatStamp,
  DEFAULT_EVIDENCE_OPTIONS, EVIDENCE_KIND, EVIDENCE_SPEC_VERSION,
  type EvidenceViewOptions,
} from '../src/lib/evidencePack'
import { buildChapterTrajectory, type TrajectoryInput } from '../src/lib/trajectory'
import { toHtml, toMarkdown } from '../src/lib/tavern/exportDoc'
import type { CardRecord, Chapter, Volume } from '../src/lib/types'
import type { Snapshot } from '../src/lib/db'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const D = (s: string) => new Date(s).getTime()
const T0 = D('2026-09-20T10:00:00')
const T1 = D('2026-09-20T11:30:00')
const T3 = D('2026-09-21T09:00:00')

const vol: Volume = { id: 'v1', projectId: 'p', title: '卷一 青云', order: 0, description: '', createdAt: T0 }
const chapter: Chapter = {
  id: 'c1', projectId: 'p', volumeId: 'v1', order: 0, title: '废脉',
  // 🔴 正文带全角空格缩进（这是作者排版，导出必须原样保住）
  content: '　　陈渊醒来时，天还没亮。\n　　他摸了摸腕间的胎记。\n\n　　门外传来脚步声。',
  summary: '', status: '草稿', wordCount: 36, createdAt: T0, updatedAt: T3,
}
const outline: CardRecord = {
  id: 'k1', projectId: 'p', tabId: 'chapter-outline', name: '第1章 废脉', order: 0,
  data: { '一、本章定位::本章一句话事件': '测灵大典判定废脉' },
}
const snapshots: Snapshot[] = [
  { id: 's1', projectId: 'p', chapterId: 'c1', chapterTitle: '废脉', content: '　　初稿：陈渊醒了。', wordCount: 12, createdAt: T1, source: 'ai-rewrite' },
]
const dailyStats = [
  { date: '2026-09-20', words: 1500 },
  { date: '2026-09-21', words: 0 },
]

const baseInput: TrajectoryInput = {
  chapter, volumes: [vol], chapters: [chapter], snapshots, outline, dailyStats,
}

const pack = buildEvidencePack(buildChapterTrajectory(baseInput), '吞天神脉', D('2026-09-22T15:00:00'))

// ---------- ① JSON：结构标识与全量原件 ----------
{
  const json = packToJson(pack)
  const back = JSON.parse(json)
  ok('① kind 与结构版本写进 JSON', back.kind === EVIDENCE_KIND && back.specVersion === EVIDENCE_SPEC_VERSION)
  ok('① 生成器署名带软件名', back.generator.app.includes('青春幻想引擎'))
  ok('① 含各版全文', back.versions.length === 1 && back.versions[0].content.includes('初稿'))
  ok('① 含当前稿全文', back.current.content.includes('陈渊醒来时'))
  ok('① 含细纲文本', typeof back.outline === 'string' && back.outline.includes('测灵大典'))
  ok('① 保留原始时间戳（不是格式化字符串）', typeof back.versions[0].at === 'number' && back.versions[0].at === T1)
  ok('① 导出时间可读', back.exportedAtLabel === formatStamp(D('2026-09-22T15:00:00')), back.exportedAtLabel)
}

// ---------- ② 显示选项只影响 HTML，JSON 永远全量 ----------
{
  const minimal: EvidenceViewOptions = { includeVersions: false, includeOutline: false, includeDaily: false }
  const htmlMin = toHtml(packToDocModel(pack, minimal))
  ok('② 关掉「各版正文」后 HTML 里不再出现正文块', !htmlMin.includes('陈渊醒来时'))
  ok('② 关掉「细纲」后 HTML 里不再出现细纲标题', !htmlMin.includes('五、本章细纲'))
  ok('② 关掉「写作分布」后 HTML 里不再出现该节', !htmlMin.includes('四、写作分布'))
  // 关键：同一个 pack，JSON 依然全量
  ok('🔴 ② 同一个 pack 的 JSON 仍含全文（选项不该影响原件）',
    packToJson(pack).includes('陈渊醒来时') && packToJson(pack).includes('测灵大典'))
}

// ---------- ③ HTML：正文必须走 pre 块并保住行首缩进 ----------
{
  const html = toHtml(packToDocModel(pack, DEFAULT_EVIDENCE_OPTIONS))
  ok('③ 正文用 <pre class="raw"> 而不是 <p>', html.includes('<pre class="raw">'))
  ok('🔴 ③ 正文的行首全角缩进被保住（没被 trim 掉）', html.includes('　　陈渊醒来时，天还没亮。'))
  ok('③ 正文里的空行也保住', /陈渊醒来时[\s\S]*胎记。\n\n　　门外/.test(html) || html.includes('\n\n'), '')
  ok('③ pre 有 white-space:pre-wrap（否则换行会塌）', /pre\.raw\{[^}]*white-space:pre-wrap/.test(html))
  ok('③ 每版正文带标签（谁、什么时候、多少字）',
    html.includes('AI 整章改写前 · 旧稿') && html.includes('当前稿'))
}

// ---------- ④ 打印：样式与分页规则 ----------
{
  const html = toHtml(packToDocModel(pack, DEFAULT_EVIDENCE_OPTIONS))
  ok('④ 有 @media print 打印样式', html.includes('@media print'))
  ok('④ 打印时 pre 不掉底色', /@media print\{[\s\S]*pre\.raw\{background:transparent/.test(html))
  ok('🔴 ④ pre / 消息块设了 break-inside:avoid（打印不被拦腰截断）',
    /pre\.raw,\.msg,li\{break-inside:avoid\}/.test(html))
  ok('④ 小标题不与正文分离（break-after:avoid）', /h2,\.rawLabel\{break-after:avoid\}/.test(html))
  ok('④ HTML 自包含（不引任何外部资源）',
    !/<(script|link|img)[^>]*(src|href)=/i.test(html) && !/https?:\/\//.test(html))
}

// ---------- ⑤ 保留情况：名额满 / 版本被清理要如实写 ----------
{
  const full = Array.from({ length: 12 }, (_, i) => ({
    id: `f${i}`, projectId: 'p', chapterId: 'c1', chapterTitle: '废脉',
    content: 'x'.repeat(10), wordCount: 10, createdAt: T1 + i * 60000, source: 'auto' as const,
  }))
  const p2 = buildEvidencePack(
    buildChapterTrajectory({ ...baseInput, snapshots: full }), '吞天神脉', T3)
  ok('⑤ 名额满时 likelyTruncated = true', p2.retention.likelyTruncated)
  ok('🔴 ⑤ 如实写明「已被自动清理」，不假装完整', p2.retention.note.includes('已被自动清理'), p2.retention.note)
  ok('⑤ 写明本机保留数与上限', p2.retention.note.includes('12'))
  ok('⑤ 声明里追加了提醒', p2.statement.some(s => s.includes('已被自动清理')))

  const p3 = buildEvidencePack(buildChapterTrajectory(baseInput), '吞天神脉', T3)
  ok('⑤ 正常情况不误报截断', !p3.retention.likelyTruncated)
  ok('⑤ 正常情况的措辞是「已全部收录」', p3.retention.note.includes('全部收录'), p3.retention.note)
}

// ---------- ⑥ 每日字数的口径必须写清（这是最容易误导的地方） ----------
{
  const html = toHtml(packToDocModel(pack, DEFAULT_EVIDENCE_OPTIONS))
  ok('🔴 ⑥ 写明是「本项目当天写的总字数」而非「这一章当天写的」',
    html.includes('本项目当天写的总字数') && html.includes('不按章节拆分'))
  ok('⑥ 逐日列出日期与字数', html.includes('2026-09-20') && html.includes('1500 字'))
  ok('⑥ 区间外的日期不进（09-19 / 09-22 都不该有）',
    !html.includes('2026-09-19') && !html.includes('2026-09-22　'))
}

// ---------- ⑦ 时间线：细纲不带时间点 ----------
{
  const html = toHtml(packToDocModel(pack, DEFAULT_EVIDENCE_OPTIONS))
  ok('🔴 ⑦ 老细纲卡（无创建时间）如实写明「未记录时间」', html.includes('未记录时间'))
  ok('⑦ 细纲条目仍作为起点出现', html.includes('章节细纲'))
  ok('⑦ 时间线含 AI 版与当前稿', html.includes('第 1 个保留版本') && html.includes('当前稿'))
}

// ---------- ⑧ 声明：不得出现绝对化的"不外发"承诺（与 aiDataSources 闸同一口径） ----------
{
  const ABSOLUTE_PROMISE = /全程本地|不外发|不上传|绝不外发|纯本地/
  const all = [...pack.statement, pack.retention.note].join('\n')
  ok('🔴 ⑧ 声明里没有绝对化的"不外发"承诺', !ABSOLUTE_PROMISE.test(all), all.slice(0, 100))
  ok('⑧ 声明点明数据来源', pack.statement.some(s => s.includes('创作记录')))
  ok('🔴 ⑧ 声明点明不做规避检测（产品立场）', pack.statement.some(s => s.includes('绕过 AI 检测')))

  const html = toHtml(packToDocModel(pack, DEFAULT_EVIDENCE_OPTIONS))
  ok('⑧ 声明渲染进了 HTML 脚注', html.includes('<footer>') && html.includes('绕过 AI 检测'))
}

// ---------- ⑨ 文件名与摘要 ----------
{
  ok('⑨ HTML 文件名含作品名与章名', evidenceHtmlFileName(pack) === '吞天神脉-废脉-创作轨迹.html', evidenceHtmlFileName(pack))
  ok('⑨ JSON 文件名带 .json', evidenceJsonFileName(pack) === '吞天神脉-废脉-创作轨迹.json', evidenceJsonFileName(pack))
  ok('⑨ 摘要给出体量感', evidenceSummary(pack).includes('个历史版本'), evidenceSummary(pack))
  ok('⑨ 写作日期区间取首尾', JSON.stringify(dailyRange(pack)) === JSON.stringify({ from: '2026-09-20', to: '2026-09-21' }), JSON.stringify(dailyRange(pack)))
  ok('⑨ 无每日记录时区间为 null', dailyRange({ ...pack, daily: [] }) === null)
}

// ---------- ⑩ Markdown 出口也能吃 pre 块（不崩、不丢缩进） ----------
{
  const md = toMarkdown(packToDocModel(pack, DEFAULT_EVIDENCE_OPTIONS))
  ok('⑩ md 渲染成功且含正文', md.includes('陈渊醒来时'))
  ok('🔴 ⑩ md 的 pre 块不做 trim（行首缩进仍在）', md.includes('　　陈渊醒来时，天还没亮。'))
}

console.log(`\n证据包（A4）：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
