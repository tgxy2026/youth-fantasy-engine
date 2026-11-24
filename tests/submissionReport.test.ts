// ============ 3.7.0 · W6 投稿体检一页汇总 ============
//
// 盯四件事（规划 §3 W6.3）：
//   ① 各来源缺失时如实显示「未跑」；有结果时原文引用、不改写；
//   ② 立场：模块与界面文案不含判定类用词（沿 platformCheck 禁词模式）；
//   ③ 导出 JSON 与界面同源、可往返；
//   ④ 待办条数来自已留档的检查报告（只读汇总），不补跑检查、不新造统计。
import fs from 'node:fs'
import { buildSubmissionReport, submissionReportJson } from '../src/lib/audit/submissionReport'
import type { TicketItem } from '../src/lib/app/optimizeTicket'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const banned = '评分|评级|排名|合格|不合格|签约潜力|合格率'

// ---------- ① 缺失 ⇒ 未跑（不补跑、不假装） ----------
{
  const r = buildSubmissionReport({}, 1000)
  ok('四个区都在（开篇 / 平台 / 正文 / 待办）', r.sections.map(s => s.key).join(',') === 'opening,platform,body,todo')
  ok('全部没有结果 ⇒ 全部未跑', r.sections.every(s => s.state === 'not-run'))
  ok('未跑项写明「不会替你补跑」', r.sections.every(s => s.lines.join('').includes('不会替你补跑')), JSON.stringify(r.sections.map(s => s.lines)))
  ok('未跑项时间为 0（不冒充生成时间）', r.sections.every(s => s.at === 0))
  ok('每区都带来源面板名', r.sections.every(s => !!s.source))
}

// ---------- ② 有结果 ⇒ 原文引用、带时间；待办条数来自工单 ----------
{
  const tickets = [
    { id: 't1', chapterId: 'c1', chapterTitle: '第1章', source: 'continuity', title: '人名未登记', detail: 'x', level: '严重' },
    { id: 't2', chapterId: 'c1', chapterTitle: '第1章', source: 'foreshadow', title: '伏笔孤儿', detail: 'y', level: '中等' },
  ] as unknown as TicketItem[]
  const r = buildSubmissionReport({
    opening: { conclusion: '需改', at: 111, source: '颉文姬 · 审读 · 黄金三章' },
    platform: { platform: '起点', observations: ['第1章 3200 字', '命中 2 处平台重点类别'], at: 222 },
    body: { lines: ['第 12–18 章连续 7 章没有登记爽点。'], at: 333 },
    todo: { tickets, at: 444 },
  }, 1000)
  const by = (k: string) => r.sections.find(s => s.key === k)!
  ok('开篇结论引用 AI 原话', by('opening').lines[0].includes('需改') && by('opening').lines.join('').includes('AI 原话'))
  ok('开篇注明仅供参考（不当作平台判定）', by('opening').lines.join('').includes('以平台实际为准'))
  ok('平台区保留观察句原文', by('platform').lines.includes('第1章 3200 字'))
  ok('正文事实区保留事实句', by('body').lines.includes('第 12–18 章连续 7 章没有登记爽点。'))
  ok('待办条数 = 留档报告挂章后的条数（不另算）', by('todo').lines[0].includes('已留档检查发现 2 条待处理问题'), by('todo').lines[0])
  ok('有结果的区各自带时间', by('opening').at === 111 && by('platform').at === 222 && by('body').at === 333 && by('todo').at === 444)
  ok('生成时间取调用时间', r.generatedAt === 1000)

  // ---------- ③ 导出往返 ----------
  const json = submissionReportJson(r)
  const back = JSON.parse(json)
  ok('导出 JSON 与界面同源（区数与顺序一致）', back.sections.map((s: { key: string }) => s.key).join(',') === r.sections.map(s => s.key).join(','))
  ok('导出内容逐字保留原话', json.includes('需改') && json.includes('第 12–18 章连续 7 章没有登记爽点。'))
  ok('导出文件注明未跑不等于通过', back.note.includes('不代表通过'))
}

// ---------- ④ 立场闸 ----------
{
  for (const p of ['src/lib/audit/submissionReport.ts', 'src/components/audit/SubmissionReportDialog.tsx']) {
    const src = fs.readFileSync(p, 'utf8')
    ok(`${p} 不含判定类用词`, !new RegExp(banned).test(src), (src.match(new RegExp(banned, 'g')) ?? []).join(','))
  }
  const r = buildSubmissionReport({})
  ok('界面文案不含判定类用词', !r.sections.some(s => new RegExp(banned).test(s.lines.join(''))))
}

console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  // ---------- 接线闸：开篇结论真的进了体检页 ----------
  {
    const dialog = fs.readFileSync('src/components/audit/SubmissionReportDialog.tsx', 'utf8')
    const model = fs.readFileSync('src/components/jiewenji/useJieWenJiModel.ts', 'utf8')
    ok('黄金三章跑完会存结论快照', model.includes('saveOpeningSnapshot(owner.projectId'))
    ok('体检页读取快照并作为「开篇」引用', dialog.includes('readOpeningSnapshot(') && dialog.includes('opening: { conclusion'))
    const platform = fs.readFileSync('src/components/audit/PlatformCheckPanel.tsx', 'utf8')
    const probe = fs.readFileSync('src/components/audit/ReaderProbePanel.tsx', 'utf8')
    ok('分平台预检跑完会存观察句快照', platform.includes('savePlatformSnapshot(db.getCurrentProjectId(), report)'))
    ok('读者探针跑完会存摘要快照', probe.includes('saveReaderProbeSnapshot(projectId, lensName, result)'))
    ok('体检页读取平台 / 探针快照', dialog.includes('readPlatformSnapshot(pid)') && dialog.includes('readReaderProbeSnapshot(pid)'))
    ok('体检页不补跑检查（不调 buildTicket / runChapterCheck）', !dialog.includes('buildTicket') && !dialog.includes('runChapterCheck'))
    ok('待办只读已留档报告（loadCheckReports）', dialog.includes('loadCheckReports(pid)'))
  }

if (fail > 0) process.exit(1)