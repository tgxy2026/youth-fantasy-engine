// 3.2.0 · W4「加入工单」联动 · 单测
//
// 链条：自检发现问题 → 报告落库（带章号）→ 加入工单（挂回章）→ 作者手动处置。
// 盯四件事：
//   ① AI 结论进工单后 `action` 恒为 manual（可疑 ≠ 确定要改，不许自动执行）；
//   ② 章号 / 章 id 两级匹配；都对不上要**如实计数**，不许硬塞到某一章；
//   ③ 合并时已有条目状态优先（作者标过的 skipped/done 不被打回 pending）；
//   ④ 坏数据（result 不是数组、条目没标题）被安全丢弃，不制造空工单。
import { readFileSync } from 'node:fs'
import { __resetMockStores } from './mock-memory'
import {
  ticketSourceOfCheck, findingsOfReport, intakeReport, intakeFromReports,
  mergeIntake, loadCheckReports, joinCheckReportsToTicket,
  type ChapterRef, type PersistedCheckReport,
} from '@/lib/revision/ticketIntake'
import { saveRevisionPayload } from '@/lib/db/revisionJobs'
import type { RevisionPayload } from '@/lib/revision/jobTypes'
import type { ContinuityFinding } from '@/lib/aiTasks/audit'
import type { TicketItem } from '@/lib/app/optimizeTicket'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const F = (title: string, where = '', level = '严重'): ContinuityFinding => ({
  level, title, detail: `关于${title}的说明`, where,
})

const CH: ChapterRef = { id: 'ch-1', title: '第一章', no: 1, body: '他推开门，屋里没有人。\n桌上放着一封没有署名的信。' }
const CH2: ChapterRef = { id: 'ch-2', title: '第二章', no: 2, body: '第二天的清晨，雨停了。' }

const rep = (over: Partial<PersistedCheckReport> = {}): PersistedCheckReport => ({
  id: 'r1', jobId: 'job-1', checkId: 'continuity', source: '章节自检 · 连续性',
  findings: [F('时间线冲突', '他推开门')], ...over,
})

async function main() {
  // ---------- 一、词表映射 ----------
  {
    ok('① 连续性 → continuity', ticketSourceOfCheck('continuity') === 'continuity')
    ok('① 人设 → ai-ooc', ticketSourceOfCheck('ooc') === 'ai-ooc')
    ok('① 伏笔 → foreshadow', ticketSourceOfCheck('foreshadow') === 'foreshadow')
    ok('① 未知检查项不瞎猜（落 ai-review）', ticketSourceOfCheck('whatever') === 'ai-review')
    ok('① 大小写/空格容错', ticketSourceOfCheck('  OOC ') === 'ai-ooc')
  }

  // ---------- 二、读报告：坏数据安全丢弃 ----------
  {
    ok('② 非数组 result ⇒ 空（老/坏数据不炸）', findingsOfReport({ result: 'oops' }).length === 0)
    ok('② 空 input 不抛', findingsOfReport(null).length === 0 && findingsOfReport(undefined).length === 0)
    const got = findingsOfReport({
      result: [
        { level: '严重', title: ' A ', detail: 'd', where: 'w' },
        { level: '中等' },                    // 没标题 ⇒ 丢弃（作者看不出要改什么）
        { title: 'B' },                       // 缺级别 ⇒ 默认中等
        null, 'x', 3,
      ],
    })
    ok('② 没标题的条目被丢弃（不做空工单）', got.length === 2, JSON.stringify(got))
    ok('② 标题去空格、缺级别默认中等', got[0].title === 'A' && got[1].level === '中等')
    ok('② 缺 detail/where 时给空串（不留 undefined）', got[1].detail === '' && got[1].where === '')
  }

  // ---------- 三、单份报告 → 条目 ----------
  {
    const items = intakeReport(rep(), CH)
    ok('③ 一条发现一条工单', items.length === 1)
    const it = items[0]
    ok('🔴 ③ action 恒为 manual（可疑 ≠ 确定要改，界面禁执行）', it.action === 'manual')
    ok('③ 章信息原样带上（id/标题/序号）',
      it.chapterId === CH.id && it.chapterTitle === CH.title && it.chapterNo === CH.no)
    ok('③ 证据能在正文里定位（含段号）',
      it.evidence?.[0].located === true && it.evidence?.[0].paragraphIndex === 0, JSON.stringify(it.evidence))
    ok('③ 保留报告来源（可回看是哪次检查报的）', it.originReportId === 'r1')
    ok('③ 严重度按审计词表（严重 → error）', it.severity === 'error')

    const miss = intakeReport(rep({ findings: [F('对不上的问题', '正文里没有这句')] }), CH)
    ok('③ 定位不到时如实标 located=false（不假装有证据）', miss[0].evidence?.[0].located === false)
    ok('③ 第二段命中 ⇒ 段号 1',
      intakeReport(rep({ findings: [F('线索问题', '桌上放着一封')] }), CH)[0].evidence?.[0].paragraphIndex === 1)
  }

  // ---------- 四、多份报告 → 挂章（两级匹配） ----------
  {
    const r1 = intakeFromReports([rep({ id: 'a', chapterId: 'ch-1' })], [CH, CH2])
    ok('④ 按 chapterId 精确匹配', r1.items.length === 1 && r1.items[0].chapterId === 'ch-1' && r1.unmapped === 0)

    const r2 = intakeFromReports([rep({ id: 'b', chapterNo: 2 })], [CH, CH2])
    ok('④ 只有章号时按章号匹配（连写新章的场景）',
      r2.items.length === 1 && r2.items[0].chapterId === 'ch-2', JSON.stringify(r2.items.map(i => i.chapterId)))

    const r3 = intakeFromReports([rep({ id: 'c', chapterNo: 99 })], [CH, CH2])
    ok('🔴 ④ 章号对不上 ⇒ 计 unmapped，绝不硬塞到某一章',
      r3.items.length === 0 && r3.unmapped === 1, JSON.stringify(r3))

    const r4 = intakeFromReports([rep({ id: 'd' })], [CH, CH2])
    ok('④ 既无 id 也无章号 ⇒ unmapped', r4.unmapped === 1 && r4.items.length === 0)

    const r5 = intakeFromReports([rep({ id: 'e', chapterId: 'ch-1' }), rep({ id: 'f', chapterNo: 2 })], [CH, CH2])
    ok('④ 一批报告各挂各章', r5.reportsUsed === 2 && r5.items.length === 2
      && r5.items.map(i => i.chapterId).sort().join(',') === 'ch-1,ch-2')
  }

  // ---------- 五、合并：已有状态优先 ----------
  {
    const existing: TicketItem[] = [{
      id: 'local-1', chapterId: CH.id, chapterTitle: CH.title, chapterNo: 1,
      source: 'typo', severity: 'warn', title: '错别字：在 → 再', detail: '2 处', action: 'polish', status: 'done',
    }]
    const incoming = intakeReport(rep(), CH)
    const m1 = mergeIntake(existing, incoming)
    ok('⑤ 新条目被并入', m1.added === 1 && m1.items.length === 2, JSON.stringify({ a: m1.added }))

    const dup = intakeReport(rep({ id: 'r2' }), CH) // 同一发现（同章/同来源/同标题/同证据）
    const m2 = mergeIntake(m1.items, dup)
    ok('⑤ 同一发现重复加入 ⇒ 跳过（不重复占工单）', m2.added === 0 && m2.skipped === 1, JSON.stringify(m2))

    const skipped: TicketItem[] = m1.items.map(i => (i.source === 'continuity' ? { ...i, status: 'skipped' as const } : i))
    const m3 = mergeIntake(skipped, intakeReport(rep({ id: 'r3' }), CH))
    ok('🔴 ⑤ 作者标过 skipped 的条目不会被打回 pending（状态不被覆盖）',
      m3.added === 0 && m3.items.find(i => i.source === 'continuity')?.status === 'skipped')
  }

  // ---------- 六、读库 + 总入口 ----------
  __resetMockStores()
  {
    const put = async (id: string, report: Record<string, unknown>) => {
      await saveRevisionPayload({
        id, projectId: 'w4-intake', kind: 'report', jobId: 'job-1',
        report, summary: '检查', bytes: 10, createdAt: Date.now(),
      } as RevisionPayload)
    }
    await put('p1', { checkId: 'continuity', source: '自检', chapterNo: 1, result: [F('时间线冲突', '他推开门')] })
    await put('p2', { checkId: 'ooc', source: '自检', chapterId: 'ch-2', result: [F('人设漂移', '雨停了', '中等')] })
    await put('p3', { checkId: 'continuity', source: '自检', result: '坏数据' })   // 应被忽略
    await put('p4', { checkId: 'foreshadow', source: '自检', chapterNo: 99, result: [F('伏笔未收')] }) // unmapped

    const rows = await loadCheckReports('w4-intake')
    ok('⑥ 读库时跳过坏数据（不留空报告）', rows.length === 3, String(rows.length))

    const joined = await joinCheckReportsToTicket('w4-intake', [CH, CH2], [])
    // 3 份可读报告里：p1/p2 挂上（2 条），p4 章号对不上（unmapped），p3 是坏数据（被忽略）
    ok('⑥ 总入口把能挂的挂上、对不上的不硬塞', joined.items.length === 2, JSON.stringify({ n: joined.items.length }))
    ok('⑥ 报告数与未匹配数如实回报', joined.reportsUsed === 2 && joined.unmapped === 1, JSON.stringify(joined))
    ok('⑥ 挂上的条目都带 originReportId', joined.items.every(i => Boolean((i as { originReportId?: string }).originReportId)))
    ok('⑥ 已有工单不受影响（新条目追加）', (await joinCheckReportsToTicket('w4-intake', [CH], [])).items.length >= 1)
  }

  {
    // 读库抛错也不崩（工单页不该因一份坏报告整页空掉）
    const r = await joinCheckReportsToTicket('', [CH], [{
      id: 'x', chapterId: 'ch-1', chapterTitle: '第一章', chapterNo: 1,
      source: 'typo', severity: 'warn', title: 't', detail: 'd', action: 'polish', status: 'pending',
    }])
    ok('🔴 ⑥ 读库异常时保留已有条目（不整页空掉）', r.items.length === 1 && r.added === 0)
  }

  // ---------- 七、接线：工单生成真的会并入 ----------
  {
    const src = readFileSync('src/lib/app/optimizeTicket.ts', 'utf8')
    ok('⑦ buildTicket 调用了 joinCheckReportsToTicket', /joinCheckReportsToTicket\(/.test(src))
    ok('⑦ 用当前项目 + 按章的章节引用（id/标题/序号/正文都要）',
      /db\.getCurrentProjectId\(\) \?\? ''/.test(src) && /body: c\.chapter\.content \?\? ''/.test(src))
    ok('⑦ 合并后仍走去重排序（口径不分裂）', /sortAndDedup\(joined\.items\)/.test(src))
  }

  console.log(`\n———— ticketIntake：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
