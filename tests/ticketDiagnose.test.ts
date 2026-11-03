// 3.2.0 · W4 工单诊断：本地体检留档 + 检查项状态（WQ1）· 单测
//
// 盯四件事：
//   ① 两套词表**只在一处**对齐：本地引擎的 error/warn/info → 留存的 严重/中等/提示；
//      漏一处就会让「冲突级」问题被当成提示 → 按 A 策略不落库 → 作者隔天查不到。
//   ② 留档按**章**归属：一章一份，多章互不挤（每章 5 份配额是作者口径）。
//   ③ 同一章重跑不重复占额度（指纹去重）；发现变了才多占一份。
//   ④ 某章没检成 ⇒ 记 `failed`，**不许**被吞成「诊断完成、没有问题」（WQ1 登记病灶）。
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import './mock-memory'
import {
  chapterReportToFindings, chapterReportToRun, evidenceOfFindings, levelOfSeverity, LOCAL_TICKET_JOB_ID,
  summarizeEvidence,
} from '@/lib/revision/checkAdapters'
import {
  persistCheckReports, listCheckReportViews, summarizeReportViews, reportSourceLabel,
  type CheckFindingLike,
} from '@/lib/revision/checkReports'
import { listProjectRevisionPayloads } from '@/lib/db/revisionJobs'
import { recheckDelta } from '@/lib/app/optimizeTicket'
import type { ChapterCheckReport } from '@/lib/outline/chapterCheck'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const F_SERIOUS: CheckFindingLike = { level: '严重', title: '时间线冲突', detail: '第 3 章说三天后，第 5 章说次日' }
const F_MID: CheckFindingLike = { level: '中等', title: '人设漂移', detail: '角色忽然改用书面语' }
const runOf = (findings: CheckFindingLike[], state = 'completed') => ({ state, result: { data: findings } })

const PID = 'w4-ticket-diagnose'

/** 造一份章节体检报告（五个引擎都给一点，含"没问题"这类噪声） */
const rep: ChapterCheckReport = {
  chapterId: 'c1',
  chapterTitle: '第一章',
  continuity: [{
    id: 'ct1', severity: 'error', category: '连续性', title: '死者复活', detail: '甲第 2 章已死',
    location: { kind: 'chapter', chapterId: 'c1', hint: '他抬起头' },
  }],
  foreshadow: {
    codes: ['F01'],
    issues: [{ id: 'fs1', severity: 'warn', category: '伏笔', title: 'F01 未回收', detail: '埋了 8 章' }],
  },
  sensitive: [{ word: '毒', count: 2, context: '这是一种毒药' }],
  typos: [{ word: '按装', suggest: '安装', count: 1, context: '他按装好了' }],
  style: [
    { id: 's-ok', severity: 'info', category: '文风', title: '文风稳定', detail: '' },
    { id: 's-empty', severity: 'info', category: '文风', title: '未填写作规范', detail: '' },
    { id: 's-rep', severity: 'warn', category: '文风', title: '三段连用同一句式', detail: '第 2–4 段' },
  ],
}

async function main() {
  // ---------- 一、词表对齐（唯一去处） ----------
  {
    ok('① error → 严重', levelOfSeverity('error') === '严重', levelOfSeverity('error'))
    ok('① warn → 中等', levelOfSeverity('warn') === '中等', levelOfSeverity('warn'))
    ok('① info → 提示', levelOfSeverity('info') === '提示', levelOfSeverity('info'))
  }

  // ---------- 二、报告 → 统一发现 ----------
  {
    const fs = chapterReportToFindings(rep)
    ok('② 噪声不入：文风"没问题 / 未填规范"不算发现',
      !fs.some(f => f.title === '文风稳定' || f.title === '未填写作规范'), String(fs.length))
    ok('② 五类都在（连续性/伏笔/敏感词/错别字/文风）', fs.length === 5, fs.map(f => f.title).join(' | '))
    ok('② 顺序与工单一致（连续性 → 伏笔 → 敏感词 → 错别字 → 文风）',
      fs[0].title === '死者复活' && fs[1].title === 'F01 未回收'
      && fs[2].title === '敏感词：毒' && fs[3].title === '错别字：按装 → 安装'
      && fs[4].title === '三段连用同一句式')
    ok('🔴 ② 敏感词恒"严重"（本地扫描到就是冲突，不按引擎给的级别降档）',
      fs[2].level === '严重', String(fs[2].level))
    ok('🔴 ② 错别字恒"中等"', fs[3].level === '中等', String(fs[3].level))
    // where 是工单定位段号的依据：必须是正文中逐字存在的片段
    ok('🔴 ② 敏感词/错别字的 where 是命中词本体（工单才能定位到段号）',
      fs[2].where === '毒' && fs[3].where === '按装', `${fs[2].where} / ${fs[3].where}`)
    ok('② 审计问题的 where 取 location.hint（取不到就空，绝不编）', fs[0].where === '他抬起头', String(fs[0].where))
    ok('② 伏笔问题没有 hint ⇒ where 为空', fs[1].where === '', String(fs[1].where))

    // 与工单口径对齐：真正会变成条目的数量（提示级不算）。
    // 本例五类各一条，全是严重/中等 ⇒ 5 条（噪声两条已被剔除，若没剔除会是 7 条）
    const actionable = fs.filter(f => f.level !== '提示').length
    ok('② 需要动手的发现 5 条（提示级不算问题，噪声已剔除）', actionable === 5, String(actionable))

    ok('② 跑完的报告 state 恒 completed（拿不到报告的情况由 CheckItemResult.failed 承担）',
      chapterReportToRun(rep).state === 'completed')
  }

  // ---------- 三、留档：按章归属，多章互不挤 ----------
  {
    const r = await persistCheckReports({
      projectId: PID,
      jobId: LOCAL_TICKET_JOB_ID,
      reports: [
        { checkId: 'chapter-check', source: 'local', run: runOf([F_SERIOUS]), chapterId: 'c1', chapterNo: 1 },
        { checkId: 'chapter-check', source: 'local', run: runOf([F_MID]), chapterId: 'c2', chapterNo: 2 },
      ],
    })
    ok('③ 一次调用落两章', r.saved === 2, `saved=${r.saved}`)
    const rows = (await listProjectRevisionPayloads(PID)).filter(p => p.kind === 'report')
    const byCh = new Map(rows.map(p => [String((p.report as Record<string, unknown>).chapterId), p]))
    ok('🔴 ③ 各带各的章（工单才能按章挂回去）',
      byCh.get('c1') !== undefined && byCh.get('c2') !== undefined, [...byCh.keys()].join(','))
    ok('③ 章号也存了（新章落库前只有章号可用）',
      (byCh.get('c1')?.report as Record<string, unknown>).chapterNo === 1)
    ok('③ 检查项 id 与来源跟着载荷走（读回来不是 unknown）',
      (byCh.get('c1')?.report as Record<string, unknown>).checkId === 'chapter-check'
      && (byCh.get('c1')?.report as Record<string, unknown>).source === 'local')
  }

  // ---------- 四、同一章重跑：指纹去重；发现变了才多占一份 ----------
  {
    const before = (await listProjectRevisionPayloads(PID)).filter(p => p.kind === 'report').length
    const again = await persistCheckReports({
      projectId: PID,
      jobId: LOCAL_TICKET_JOB_ID,
      reports: [
        { checkId: 'chapter-check', source: 'local', run: runOf([F_SERIOUS]), chapterId: 'c1', chapterNo: 1 },
        { checkId: 'chapter-check', source: 'local', run: runOf([F_MID]), chapterId: 'c2', chapterNo: 2 },
      ],
    })
    const after = (await listProjectRevisionPayloads(PID)).filter(p => p.kind === 'report').length
    ok('🔴 ③ 重跑同一章、发现没变 ⇒ 不重复占额度',
      again.saved === 0 && after === before, `saved=${again.saved} ${before}→${after}`)

    // 让 c1 连出 6 份**不同**的发现，验证「每章 5 份」只淘汰本章的旧报告
    for (let i = 0; i < 6; i++) {
      await persistCheckReports({
        projectId: PID,
        jobId: LOCAL_TICKET_JOB_ID,
        reports: [{
          checkId: 'chapter-check', source: 'local',
          run: runOf([{ level: '严重', title: `新问题 ${i}`, detail: `第 ${i} 次` }]),
          chapterId: 'c1', chapterNo: 1,
        }],
      })
    }
    const rows = (await listProjectRevisionPayloads(PID)).filter(p => p.kind === 'report')
    const c1 = rows.filter(p => (p.report as Record<string, unknown>).chapterId === 'c1')
    const c2 = rows.filter(p => (p.report as Record<string, unknown>).chapterId === 'c2')
    ok('🔴 ③ 每章最多 5 份（超了淘汰本章最旧的）', c1.length === 5, String(c1.length))
    ok('🔴 ③ 淘汰只落在本章：另一章一份没少', c2.length === 1, String(c2.length))
    ok('③ 留的是最新的那几份（含最后一次的"新问题 5"）',
      c1.some(p => String(p.summary ?? '').length >= 0
        && JSON.stringify(p.report ?? {}).includes('新问题 5')),
      String(c1.length))
  }

  // ---------- 四之二、回看：存下来就是为了能翻回去看 ----------
  {
    const rows = await listCheckReportViews(PID)
    ok('④ 回看能列出留档报告', rows.length > 0, String(rows.length))
    ok('🔴 ④ 新的在前（作者先看最近一次）',
      rows.every((r, i) => i === 0 || rows[i - 1].createdAt >= r.createdAt))
    ok('④ 每份都带章与来源（不然回看时不知道是哪一章、哪次检查）',
      rows.every(r => !!r.chapterId && !!r.source && !!r.checkId))
    ok('④ 条目与级别计数都在', rows.every(r => r.findings.length > 0 && (r.serious + r.minor) > 0))

    const sum = summarizeReportViews(rows)
    ok('④ 汇总：份数 / 涉及章数 / 冲突数', sum.total === rows.length && sum.chapters >= 2 && sum.serious >= 1,
      `${sum.total}/${sum.chapters}/${sum.serious}`)
    ok('④ 汇总：最近时间取最大（不是最后一条）',
      sum.latestAt === Math.max(...rows.map(r => r.createdAt)))
    ok('④ 空列表 ⇒ 汇总为零、latestAt 为 null（界面写"没有"而不是编一个时间）',
      summarizeReportViews([]).total === 0 && summarizeReportViews([]).latestAt === null)
    ok('④ 没记章的条目不计入涉及章数',
      summarizeReportViews([{ id: 'x', jobId: 'j', checkId: 'c', source: 'local', createdAt: 1, bytes: 1, summary: '', findings: [], serious: 0, minor: 0, info: 0 }]).chapters === 0)

    ok('④ 来源说人话（不把 local-recheck 直接给作者看）',
      reportSourceLabel('local') === '本地诊断'
      && reportSourceLabel('local-recheck') === '改后复检'
      && reportSourceLabel('self-refine') === '连写自检')
  }

  // ---------- 四之三、证据快照：落库那一刻的定位，不是"现在的" ----------
  {
    const body = '甲推开门。\n他看着墙上的按装图纸。\n这是一种毒药。'
    const ev = evidenceOfFindings(chapterReportToFindings(rep), body)
    const sum = summarizeEvidence(ev)
    ok('④ 每条发现都有一个引文（含定位不到的）', ev.length === 5, String(ev.length))
    ok('🔴 ④ 错别字引文逐字命中 ⇒ located 且带段号',
      ev[3].located === true && ev[3].paragraphIndex === 1, JSON.stringify(ev[3]))
    ok('🔴 ④ 敏感词引文逐字命中 ⇒ located 且带段号',
      ev[2].located === true && ev[2].paragraphIndex === 2, JSON.stringify(ev[2]))
    ok('🔴 ④ 伏笔问题没有引文 ⇒ 不编引文也不编段号',
      ev[1].located === false && ev[1].quote === '', JSON.stringify(ev[1]))
    ok('🔴 ④ 审计问题的 hint 不在正文 ⇒ located:false 但保留引文本身（作者自己核对）',
      ev[0].located === false && ev[0].quote === '他抬起头', JSON.stringify(ev[0]))
    ok('④ 统计：可定位数 ≤ 总数', sum.total === 5 && sum.located === 2, JSON.stringify(sum))
    ok('④ 空正文 ⇒ 全部定位不到（不是崩，也不是"都没问题"）',
      evidenceOfFindings(chapterReportToFindings(rep), '').every(e => !e.located))
    ok('④ 空发现列表 ⇒ 0/0（界面不说"0/0 可定位"）',
      summarizeEvidence([]).total === 0 && evidenceOfFindings([], 'x').length === 0)

    // 落库后的回看里要能看到"当时的证据"（老报告没有该字段 ⇒ 不假装有）
    const withEv = await persistCheckReports({
      projectId: PID,
      jobId: LOCAL_TICKET_JOB_ID,
      reports: [{
        checkId: 'chapter-check', source: 'local',
        run: runOf([{ level: '严重', title: '新问题 9', detail: '第 9 次', where: '按装' }]),
        evidence: evidenceOfFindings([{ level: '严重', title: '新问题 9', where: '按装' }], body),
        chapterId: 'c9', chapterNo: 9,
      }],
    })
    ok('④ 带证据快照的报告照样落库', withEv.saved === 1, `saved=${withEv.saved}`)
    const row = (await listCheckReportViews(PID)).find(r => r.chapterId === 'c9')
    ok('🔴 ④ 回看能读到落库时的证据统计', row?.evidence?.total === 1 && row?.evidence?.located === 1,
      JSON.stringify(row?.evidence))
    const old = (await listCheckReportViews(PID)).find(r => r.chapterId === 'c1')
    ok('④ 老报告（无证据字段）⇒ evidence 为 undefined，不假装有', old?.evidence === undefined)
  }

  // ---------- 五、改完复检：标"已改写" ≠ "问题解决了" ----------
  {
    const before = ['错别字：按装 → 安装', '敏感词：毒', '三段连用同一句式']

    const all = recheckDelta(before, [
      { level: '中等', title: '错别字：按装 → 安装' },
      { level: '严重', title: '敏感词：毒' },
      { level: '中等', title: '三段连用同一句式' },
    ])
    ok('⑤ 一条没解决 ⇒ stillOpen 全在，resolved 为 0',
      all.stillOpen.length === 3 && all.resolved === 0, `${all.stillOpen.length}/${all.resolved}`)

    const partial = recheckDelta(before, [{ level: '严重', title: '敏感词：毒' }])
    ok('⑤ 只解决两条 ⇒ stillOpen 1 / resolved 2',
      partial.stillOpen.length === 1 && partial.stillOpen[0] === '敏感词：毒' && partial.resolved === 2,
      `${partial.stillOpen.join(',')}/${partial.resolved}`)

    const cleared = recheckDelta(before, [{ level: '中等', title: '别的问题' }])
    ok('⑤ 原问题全清 ⇒ resolved = 改前条数', cleared.stillOpen.length === 0 && cleared.resolved === 3)

    ok('🔴 ⑤ 降级成"提示"的不再算未解决（提示级不是待办）',
      recheckDelta(before, [{ level: '提示', title: '敏感词：毒' }]).stillOpen.length === 0)

    ok('🔴 ⑤ 复检冒出来的新问题不进 stillOpen（它没在改前工单里，作者没要求改它）',
      recheckDelta(before, [{ level: '严重', title: '死者复活' }]).stillOpen.length === 0)

    ok('⑤ 改前没有条目 ⇒ 0/0（不该出现负数）',
      recheckDelta([], []).resolved === 0 && recheckDelta([], []).stillOpen.length === 0)

    // 标题可对上是这套比对成立的前提：工单条目与复检发现必须同形
    const fs = chapterReportToFindings(rep)
    ok('🔴 ⑤ 工单条目与复检发现同形（错别字/敏感词措辞一致，比对才有意义）',
      fs.some(f => f.title === '错别字：按装 → 安装') && fs.some(f => f.title === '敏感词：毒'))
  }

  // ---------- 六、接线断言（这些破了不会报错，只会悄悄失效） ----------
  {
    const lib = readFileSync(path.join(process.cwd(), 'src/lib/app/optimizeTicket.ts'), 'utf8')
    const ui = readFileSync(path.join(process.cwd(), 'src/components/tools/OptimizeTicketPanel.tsx'), 'utf8')

    ok('④ buildTicket 委托 buildTicketDetailed（新增状态不改变老调用的行为）',
      /buildTicketDetailed\(opts\)\)\.items/.test(lib))
    ok('④ 诊断会留档，且用固定 jobId（每次新 id 会让去重形同虚设）',
      lib.includes('persistCheckReports') && lib.includes('LOCAL_TICKET_JOB_ID'))
    ok('🔴 ④ 改写落库后跑复检（本地引擎、零额度）',
      /runChapterCheck\(\{ \.\.\.hit\.chapter, content: text \}\)/.test(lib))
    ok('🔴 ④ 两处落库都带证据快照（诊断按被检查正文、复检按改后正文）',
      (lib.match(/evidenceOfFindings\(/g) ?? []).length === 2
      && lib.includes("evidence: evidenceOfFindings(findings, c.chapter.content ?? '')")
      && lib.includes("evidence: evidenceOfFindings(findings, text)"))
    ok('🔴 ④ 复检报告也留档，来源标 local-recheck（与诊断侧的报告区分开）',
      lib.includes("source: 'local-recheck'") && lib.includes('chapterReportToRun(after)'))
    ok('🔴 ④ 复检是旁路：跑失败不把已落库的正文报成失败（有 catch + warn）',
      /改完复检没跑成/.test(lib))
    ok('🔴 ④ 某章检查抛错记 failed，不静默跳过',
      /status: 'failed'/.test(lib) && /没检成/.test(lib))
    ok('🔴 ④ 中止后剩下的章记 pending（否则覆盖率会显示 100%）',
      /status: 'pending'/.test(lib))
    ok('④ 空章记 skipped（不装作"检过且没问题"）', /status: 'skipped'/.test(lib))
    ok('④ 检查项状态走 reviewFindings（WQ1 模块不再是零调用方）',
      lib.includes("@/lib/aiTasks/reviewFindings") && lib.includes('calculateCoverage'))
    ok('🔴 ④ 界面用带状态的入口，且如实显示"没检成"',
      ui.includes('buildTicketDetailed') && ui.includes('没检成'))
    const iMissed = ui.indexOf('if (missed)')
    const iAllGood = ui.indexOf('诊断完成，没有发现需要处理的问题')
    ok('🔴 ④ 漏检提示排在最前：不再把"没检成"报成"诊断完成、没有问题"',
      iMissed > 0 && iAllGood > iMissed, `${iMissed} / ${iAllGood}`)
    ok('④ 界面显示覆盖率与留档份数（作者看得见这次到底查了几章）',
      ui.includes('已检') && ui.includes('留档'))
    ok('🔴 ④ 界面区分「已改写」与「已解决」：复检结论按章显示',
      ui.includes('recheckOf') && ui.includes('条没解决') && ui.includes('复检没跑成'))
    ok('④ 复检结论两个来源都读（中止后看 resume，不然已改的章会显示成没复检）',
      /exe\.result \?\? \(exe\.task\?\.resume/.test(ui))

    const traj = readFileSync(path.join(process.cwd(), 'src/components/audit/TrajectoryPanel.tsx'), 'utf8')
    ok('④ 检查报告有回看入口（挂在「创作轨迹」头部）',
      traj.includes('CheckReportPanel') && traj.includes('检查报告'))
    const panel = readFileSync(path.join(process.cwd(), 'src/components/revision/CheckReportPanel.tsx'), 'utf8')
    ok('🔴 ④ 空态说明"全绿的检查不落库"（不然作者会以为功能坏了）',
      panel.includes('全绿的检查不占空间') || panel.includes('只有查到'))
    ok('④ 回看页说明配额与淘汰（更早的报告可能已不在）', panel.includes('会删最旧的'))
    ok('④ 来源分三类的标签（本地诊断 / 改后复检 / AI 自检）', panel.includes('reportSourceLabel'))
  }

  console.log(`\n———— ticketDiagnose：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
