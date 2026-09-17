// ============ 沉浸档防剧透：未来向字段一个都不能漏 ============
//
// 审计 2026-09-18（P1-1）：`AUTHOR_SIDE_FIELDS` 漏登记了 4 个**明确指向尚未发生之事**的字段 ——
//   力量体系的「金手指的成长路线」（示例值直接写着「卷一吞灵气→卷三吞血脉→卷五吞法则→卷七吞规则」）
//   与「顶端模糊地带」（最高境界之上的悬念）、物品的「流转轨迹」（谁给谁/怎么给/何时给 = 分配计划）、
//   种族的「与主线关系」。沉浸档下它们会**原文照进 system** —— 演员开局就拿到自己的成长路线与终局悬念。
//
// 本用例用**端到端渲染**来锁：把标记值写进表 → 角色视角下输出文本里绝不能出现那个标记。
// 为什么不直接断言「字段名在不在集合里」：那需要把内部常量导出来（为测试而开洞），
// 而端到端验的是**真实失效模式**（漏登记 → 泄漏），顺带覆盖渲染层的兜底路径。
// 反例对照（默认档位必须**能**看见）是必须的：否则「没泄漏」可能只是因为数据压根没进去。
import * as db from '../src/lib/db'
import { createDemoProject } from '../src/lib/seedData'
import { buildProjectContext } from '../src/lib/aiContext'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/**
 * 逐条核对：表单型走 formData（键可直接用字段名，渲染层对裸键有兜底），
 * 表格型走 tableRows。
 */
const CASES: { tabId: string; field: string; mark: string; kind: 'form' | 'table'; why: string }[] = [
  { tabId: 'power', field: '金手指的成长路线', mark: 'ZZMARK成长路线', kind: 'form', why: '分卷解锁计划 = 四卷剧透' },
  { tabId: 'power', field: '顶端模糊地带', mark: 'ZZMARK顶端悬念', kind: 'form', why: '最高境界之上的悬念 = 终局' },
  { tabId: 'items', field: '流转轨迹', mark: 'ZZMARK流转计划', kind: 'table', why: '谁给谁/何时给 = 分配计划' },
  { tabId: 'races', field: '与主线关系', mark: 'ZZMARK主线关联', kind: 'table', why: '指向未来的主线关联' },
  // 对照组：这几个**早就登记过**。它们能过滤，才说明「过滤机制本身在工作」，
  // 而不是碰巧整张表都没被带入。
  { tabId: 'power', field: '体系的隐藏层级', mark: 'ZZMARK隐藏层级', kind: 'form', why: '既有登记项（对照）' },
  { tabId: 'items', field: '剧情作用', mark: 'ZZMARK剧情作用', kind: 'table', why: '既有登记项（对照）' },
]

async function main() {
  __resetMockStores()
  const pid = await createDemoProject()
  db.setCurrentProject(pid)

  // ---------- 0) 把标记值写进去 ----------
  for (const c of CASES) {
    if (c.kind === 'form') {
      const cur = await db.getFormData(c.tabId)
      await db.saveFormData(c.tabId, { ...cur, [c.field]: c.mark })
    } else {
      await db.saveTableRow({
        // ⚠️ id 必须带上 field：同一张表的多条用例若共用 id 会**互相覆盖**，
        //    表现是「有的字段泄漏、有的没有」这种最难查的假象（2026-09-18 踩过）。
        id: `anti-spoiler-${c.tabId}-${c.field}`, tabId: c.tabId, projectId: pid,
        data: { 编号: 'ZZTEST', 名称: `反剧透用例-${c.tabId}`, 保密等级: 'A', [c.field]: c.mark },
        order: 9999,
      } as any)
    }
  }

  const BIG = 200000 // 预算给足：带没带只取决于档位，而不是被预算裁掉

  // ---------- 1) 反例对照：默认档位必须看得见这些标记 ----------
  const base = await buildProjectContext({ budget: BIG })
  const notRendered = CASES.filter(c => !base.text.includes(c.mark))
  ok('【反例对照】默认档位下这些标记**全部**出现在上下文里（证明数据确实写进去了、渲染层认得它们）',
    notRendered.length === 0,
    '没出现=' + notRendered.map(c => `${c.tabId}.${c.field}`).join('、'))

  // ---------- 2) 角色视角：一个标记都不许漏 ----------
  const cv = await buildProjectContext({ budget: BIG, viewMode: 'character-view' })
  const leaked = CASES.filter(c => cv.text.includes(c.mark))
  ok('🔴 角色视角下「未来向字段」一个都没泄漏（沉浸档防剧透）',
    leaked.length === 0,
    '泄漏=' + leaked.map(c => `${c.tabId}.${c.field}(${c.why})`).join('、'))
  // 逐条列出，失败时能一眼看出是哪条
  for (const c of CASES) {
    ok(`  · ${c.tabId}.${c.field} 未泄漏（${c.why}）`, !cv.text.includes(c.mark))
  }

  // ---------- 3) 导演视角：这些字段**照带**（作者自己要看得见） ----------
  const dv = await buildProjectContext({ budget: BIG, viewMode: 'director-view' })
  const dvMissing = CASES.filter(c => !dv.text.includes(c.mark))
  ok('导演视角下这些字段照常带入（只对扮演视角隐藏，不影响作者侧功能）',
    dvMissing.length === 0,
    '缺=' + dvMissing.map(c => c.field).join('、'))

  console.log(`\nantiSpoiler: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
