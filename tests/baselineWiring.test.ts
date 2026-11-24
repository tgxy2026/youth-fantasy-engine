// ============ 3.7.0 · W2 过期体系统一接线 ============
//
// 盯六件事（规划 §3 W2.3）：
//   ① 三条变更路径（正文 / 细纲 / 设定）各一条：pending 候选变 stale 且原因正确；applied 不受影响；
//   ② R2 重算一致：同一库状态两次算摘要 ⇒ 逐字相同；库状态变了 ⇒ 必变；
//   ③ 剧情候选：正文/细纲变更后**落库** stale（读存储断言）；
//   ④ 画布卡来源角标：来源变了角标数据成立、没变不出现（纯函数口径）；
//   ⑤ 对照报告：落档记正文摘要；老报告无字段不提示；
//   ⑥ 休眠件接线闸：`isBaselineStale` / `expireCandidate` 在 src 内真有消费者。
import fs from 'node:fs'
import * as db from '../src/lib/db'
import { memoryOps, __resetMockStores } from './mock-memory'
import { clearDbChangeListeners } from '../src/lib/db/changeBus'
import { registerChangeWatch, resetWatchStats, setWatchClock, watchStats, whenIdle } from '../src/lib/revision/changeWatch'
import { recordRewriteCandidate } from '../src/lib/revision/candidateIntake'
import { loadCandidate, saveCandidate } from '../src/lib/revision/candidateStore'
import { applyPlotCandidate } from '../src/lib/creative/plotCandidateStore'
import { rewriteJobIdOf } from '../src/lib/revision/candidateIntake'
import { expireRevisionCandidatesForChapter } from '../src/lib/revision/candidateExpiry'
import {
  outlineDigestOf, settingsDigestOf, outlineDigestForChapter, settingsDigestForChapter,
} from '../src/lib/revision/baselineDigest'
import { setSettingFor } from '@/lib/db'
import { dataDigestOf, applicabilityOf, type PlotCandidate } from '../src/lib/creative/plotCandidates'
import { refreshPlotCandidateStaleness, loadPlotCandidates, PLOT_CANDIDATE_KEY, outlineFingerprintNow } from '../src/lib/creative/plotCandidateStore'
import { listCheckReportViews, persistCheckReports } from '../src/lib/revision/checkReports'
import { hashOf } from '../src/lib/semantic/chunk'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

type Timer = { fn: () => void; at: number }
let timers: Timer[] = []
let now = 0
setWatchClock({
  setTimeout(fn, ms) { const t = { fn, at: now + ms }; timers.push(t); return t },
  clearTimeout(h) { timers = timers.filter(t => t !== h) },
})
async function advance(ms: number) {
  now += ms
  for (const t of [...timers].sort((a, b) => a.at - b.at)) {
    if (t.at > now) continue
    timers = timers.filter(x => x !== t)
    t.fn()
  }
  await whenIdle()
}

const PID = 'p-w2'
const OUTLINE = 'chapter-outline'

const ch = (over: Record<string, unknown> = {}) => ({
  id: 'c1', projectId: PID, volumeId: 'v1', order: 0, title: '第1章',
  content: '旧正文', wordCount: 3, updatedAt: 1, ...over,
})
const outline = (data: Record<string, string> = {}) => ({
  id: 'o1', projectId: PID, tabId: OUTLINE, name: '第1章 测试', order: 0,
  data: { '一、本章定位::本章一句话事件': '旧事件', ...data },
})

async function seed() {
  __resetMockStores()
  db.setStoreOps(memoryOps)
  db.setCurrentProject(PID)
  timers = []
  now = 0
  await memoryOps.put('volumes', { id: 'v1', projectId: PID, order: 0, title: '卷一', createdAt: 1 })
  await memoryOps.put('chapters', ch())
  await memoryOps.put('cardRecords', outline())
  // 本章固定资料：一张角色卡（设定变更路径的对象）
  await memoryOps.put('cardRecords', { id: 'char1', projectId: PID, tabId: 'char-main', name: '甲', order: 0, data: { 姓名: '甲', 状态: '健在' } })
  await setSettingFor(PID, 'chapterContext32:c1', {
    schema: 1, pinnedRefs: [{ kind: 'card', tabId: 'char-main', id: 'char1', projectId: PID }], updatedAt: 1,
  })
}

async function makeCandidate() {
  const r = await recordRewriteCandidate({
    projectId: PID, chapterId: 'c1', text: '新稿', beforeText: '旧正文', summary: '整章改写',
  })
  if (!r.ok || !r.candidateId) throw new Error('候选没建出来：' + r.detail)
  return r.candidateId
}

async function main() {
  registerChangeWatch()

  // ---------- ① R2：摘要可确定性重算 ----------
  {
    const card = outline()
    ok('同一细纲卡两次摘要逐字相同（崩溃恢复口径）', outlineDigestOf(card) === outlineDigestOf(card))
    ok('细纲改一个字段 ⇒ 摘要必变', outlineDigestOf(card) !== outlineDigestOf(outline({ '一、本章定位::本章一句话事件': '新事件' })))
    ok('细纲摘要与插入顺序无关（键排序）', outlineDigestOf({ name: 'n', data: { a: '1', b: '2' } })
      === outlineDigestOf({ name: 'n', data: { b: '2', a: '1' } }) as never)
    const entries = [{ key: 'k1', value: 'v1' }, { key: 'k2', value: 'v2' }]
    ok('设定摘要与传入顺序无关', settingsDigestOf(entries) === settingsDigestOf([...entries].reverse()))
    ok('设定值变了 ⇒ 摘要必变', settingsDigestOf(entries) !== settingsDigestOf([{ key: 'k1', value: 'v9' }, entries[1]]))

    await seed()
    const a = await outlineDigestForChapter('c1')
    const b = await outlineDigestForChapter('c1')
    ok('同库状态两次取数 ⇒ 逐字相同', a === b && !!a)
    const s1 = await settingsDigestForChapter('c1')
    await memoryOps.put('cardRecords', { id: 'char1', projectId: PID, tabId: 'char-main', name: '甲', order: 0, data: { 姓名: '甲', 状态: '重伤' } })
    const s2 = await settingsDigestForChapter('c1')
    ok('固定资料变了 ⇒ 设定摘要必变', s1 !== s2)
  }

  // ---------- ② 正文变更路径（经 changeWatch，不是直接调函数） ----------
  {
    await seed()
    const id = await makeCandidate()
    const before = await loadCandidate(id)
    ok('生成时候选带细纲 / 设定 / 章序摘要', !!before?.outlineDigest && !!before?.settingsDigest && before?.chapterOrder === 1)

    await db.saveChapter(ch({ content: '新正文，作者改过' }) as never)
    await advance(300)
    const after = await loadCandidate(id)
    ok('正文变更 → 候选变 stale（读存储）', after?.status === 'stale', String(after?.status))
    ok('过期原因 = 正文已变化', (after?.staleReasons ?? []).includes('正文已变化'), JSON.stringify(after?.staleReasons))
    // 复核补：重复判定不重复追加原因（否则面板里同一句会越堆越多）
    await expireRevisionCandidatesForChapter('c1')
    await expireRevisionCandidatesForChapter('c1')
    const again = await loadCandidate(id)
    ok('重复过期不重复追加原因', (again?.staleReasons ?? []).filter(r => r === '正文已变化').length === 1, JSON.stringify(again?.staleReasons))
  }

  // ---------- ③ 已应用候选不受影响 ----------
  {
    await seed()
    const id = await makeCandidate()
    const cur = await loadCandidate(id)
    const applied = await saveCandidate({ ...cur!, status: 'applied', appliedAt: 1 }, undefined, cur ?? undefined)
    ok('已应用候选写入成功', applied.ok, JSON.stringify(applied))
    await db.saveChapter(ch({ content: '又改了' }) as never)
    await advance(300)
    const after = await loadCandidate(id)
    ok('applied 不被过期（终态不动）', after?.status === 'applied')
  }

  // ---------- ④ 细纲变更路径 ----------
  {
    await seed()
    const id = await makeCandidate()
    await db.saveCardRecord({ ...outline({ '一、本章定位::本章一句话事件': '新事件' }), createdAt: 1 } as never)
    await advance(300)
    const after = await loadCandidate(id)
    ok('细纲变更 → 候选 stale', after?.status === 'stale', String(after?.status))
    ok('过期原因含「细纲已变化」', (after?.staleReasons ?? []).includes('细纲已变化'), JSON.stringify(after?.staleReasons))
  }

  // ---------- ⑤ 设定变更路径 ----------
  {
    await seed()
    const id = await makeCandidate()
    await memoryOps.put('cardRecords', { id: 'char1', projectId: PID, tabId: 'char-main', name: '甲', order: 0, data: { 姓名: '甲', 状态: '重伤' } })
    // 用 db 收口点写（模拟设定页保存）——changeWatch 才能收到事实
    await db.saveCardRecord({ id: 'char1', projectId: PID, tabId: 'char-main', name: '甲', order: 0, data: { 姓名: '甲', 状态: '闭关' } } as never)
    await advance(300)
    const after = await loadCandidate(id)
    ok('依赖设定变更 → 候选 stale', after?.status === 'stale', String(after?.status))
    ok('过期原因含「依赖设定已变化」', (after?.staleReasons ?? []).includes('依赖设定已变化'), JSON.stringify(after?.staleReasons))
  }

  // ---------- ⑥ 老候选兼容：没有摘要字段 → 只按正文判 ----------
  {
    await seed()
    const legacy = {
      id: 'legacy-1', jobId: rewriteJobIdOf('c1'), projectId: PID, chapterId: 'c1', status: 'pending' as const,
      text: '旧稿', beforeText: '旧正文', summary: '整章改写', bytes: 1, createdAt: 1, updatedAt: 1, generation: 1,
    }
    await saveCandidate(legacy)
    await db.saveChapter(ch({ content: '改了正文' }) as never)
    await advance(300)
    const after = await loadCandidate('legacy-1')
    ok('无摘要字段的老候选不误报「细纲/设定已变化」',
      !(after?.staleReasons ?? []).includes('细纲已变化') && !(after?.staleReasons ?? []).includes('依赖设定已变化'))
    ok('正文确实变了 ⇒ 仍然按正文判过期', after?.status === 'stale' && (after?.staleReasons ?? []).includes('正文已变化'))
  }

  // ---------- ⑦ 剧情候选：主动落库 stale + 正文基准 ----------
  {
    await seed()
    const fp = await outlineFingerprintNow(PID, 'o1')
    ok('能取到细纲卡当前指纹', !!fp)
    const plotCand: PlotCandidate = {
      id: 'pc-1', projectId: PID, outlineCardId: 'o1', chapterNo: 1, chapterTitle: '第1章 测试',
      outlineFingerprint: fp!, bodyDigest: hashOf('旧正文'), branchPoint: 'x', title: '候选', rationale: 'r',
      fields: [{ slot: '本章一句话事件', key: '一、本章定位::本章一句话事件', label: '一句话事件', before: '旧事件', after: '新事件', source: '模型提议' }],
      status: 'pending', createdAt: 1, updatedAt: 1,
    }
    await setSettingFor(PID, PLOT_CANDIDATE_KEY, [plotCand])
    const changed = await refreshPlotCandidateStaleness(PID, { chapterNo: 1 })
    ok('正文基准失配 → 失配候选落库 stale', changed === 0) // 正文还没改，指纹也没变 ⇒ 0
    await db.saveChapter(ch({ content: '新正文' }) as never)
    await refreshPlotCandidateStaleness(PID, { chapterNo: 1 })
    const stored = (await loadPlotCandidates(PID)).list.find(c => c.id === 'pc-1')
    ok('正文改了 ⇒ 剧情候选状态落库为 stale', stored?.status === 'stale', String(stored?.status))
    ok('失配时 applicability 也拒绝应用', applicabilityOf(stored!, fp!, hashOf('新正文')).canApply === false)
    ok('两边都一致时可应用（负向）', applicabilityOf({ ...plotCand }, fp!, hashOf('旧正文')).canApply === true)
    ok('老候选没有 bodyDigest 时不做正文判定（兼容）', applicabilityOf({ ...plotCand, bodyDigest: undefined }, fp!).canApply === true)
    const blocked = await applyPlotCandidate(PID, 'pc-1')
    ok('应用前防线也拒绝：正文已变则不写细纲', !blocked.ok && !!blocked.error && blocked.error.includes('正文'), JSON.stringify(blocked.error))
  }

  // ---------- ⑧ 画布卡来源摘要口径 ----------
  {
    const row = { 章节标题: '第1章', 一句话事件: '旧' }
    ok('同一字段表两次摘要相同', dataDigestOf(row) === dataDigestOf({ ...row }) as never)
    ok('字段改了摘要必变', dataDigestOf(row) !== dataDigestOf({ ...row, 一句话事件: '新' }) as never)
  }

  // ---------- ⑨ 对照报告：落档记摘要；老报告不冒充 ----------
  {
    await seed()
    const findings = [{ level: '中等', title: '计划未体现', detail: 'x' }]
    await persistCheckReports({
      projectId: PID, jobId: 'local-plan-compare', chapterId: 'c1', bodyDigest: hashOf('旧正文'),
      reports: [{ checkId: 'plan-compare', source: 'plan-compare', run: { state: 'completed', result: { data: findings } }, chapterId: 'c1' }],
    })
    const views = await listCheckReportViews(PID)
    ok('报告视图带落档正文摘要', views[0]?.bodyDigest === hashOf('旧正文'), JSON.stringify(views[0]?.bodyDigest))
    const legacyFindings = [{ level: '中等', title: '旧报告', detail: 'y' }]
    await persistCheckReports({
      projectId: PID, jobId: 'local-plan-compare', chapterId: 'c1',
      reports: [{ checkId: 'plan-compare', source: 'plan-compare', run: { state: 'completed', result: { data: legacyFindings } }, chapterId: 'c1' }],
    })
    const older = (await listCheckReportViews(PID)).find(v => v.findings[0]?.title === '旧报告')
    ok('老报告没有摘要字段 → 界面据此不提示（不假装知道基准）', older?.bodyDigest === undefined)
  }

  // ---------- ⑩ 休眠件接线闸 ----------
  {
    const src = fs.readFileSync('src/lib/revision/candidateExpiry.ts', 'utf8')
    ok('isBaselineStale / expireCandidate 有真实消费者', src.includes('isBaselineStale(') && src.includes('expireCandidate('))
    const watch = fs.readFileSync('src/lib/revision/changeWatch.ts', 'utf8')
    ok('changeWatch 接了候选过期（正文 / 细纲 / 设定三路）',
      watch.includes('expireRevisionCandidatesForChapter') && watch.includes('expireRevisionCandidatesForProject'))
    const runner = fs.readFileSync('src/lib/revision/candidateRunner.ts', 'utf8')
    ok('jobForCandidate 的 baseline 带上细纲 / 设定摘要（R2）',
      runner.includes('candidate.outlineDigest') && runner.includes('candidate.settingsDigest'))
  }

  // ---------- ⑪ 防抖合并：正文变过的事实不被后发的「仅标题 patch」冲掉 ----------
  {
    await seed()
    const id = await makeCandidate()
    await db.patchChapter('c1', { content: '正文真的改了', wordCount: 7 } as never)
    await db.patchChapter('c1', { title: '第1章 新标题' } as never) // 正文未变 ⇒ contentChanged:false
    await advance(300)
    const after = await loadCandidate(id)
    ok('正文 patch＋标题 patch 合并后仍按正文过期（OR 合并）',
      after?.status === 'stale' && (after?.staleReasons ?? []).includes('正文已变化'), JSON.stringify(after?.staleReasons))
  }

  // ---------- ⑫ 设定空变更（保存未改值）不触发全书过期扫描 ----------
  {
    await seed()
    const id = await makeCandidate()
    resetWatchStats()
    await db.saveCardRecord({ id: 'char1', projectId: PID, tabId: 'char-main', name: '甲', order: 0, data: { 姓名: '甲', 状态: '健在' } } as never)
    await advance(300)
    const after = await loadCandidate(id)
    ok('设定保存未改值 → 候选不被过期', after?.status === 'pending', String(after?.status))
    ok('空变更不算一次分析', watchStats.analyses === 0, JSON.stringify(watchStats))
  }

  clearDbChangeListeners()
  console.log(`\n———— 结果：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(error => { console.error(error); process.exit(1) })