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
import { createDemoProject } from '../src/lib/app/seedData'
import { buildProjectContext } from '../src/lib/ai/aiContext'
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

  // ---------- 4) S 级（绝密 / 剧透）：角色视角**整行剔除**，作者侧照带 ----------
  //
  // 审计 2026-10-02（P0）：`SABC_DESC` 一直承诺「S=绝密（角色视角看不到）」，而实现只按
  //   页签 / 字段名排除作者侧资料 —— **从没按 S 级剔行**（文档也记着「按 S 级过滤」属未做）。
  //   本组把承诺钉住，三条通路各测一份：表格行（renderTable）/ 卡片（renderCards）/
  //   表单整条（sectionOf 的 form 分支）。
  // 🔴 负面对照：把 `aiContext.ts` 里三处 `!(o.hideSecretRows && isSecretRow(...))` 的 S 判断
  //   临时删掉，本组前 3 条必须变红（第 4 条「非 S 照常可见」不受影响）。
  const S_TABLE = 'ZZMARK_S_表格行'
  const S_CARD = 'ZZMARK_S_卡片'
  const S_FORM = 'ZZMARK_S_表单段'
  const OK_TABLE = 'ZZMARK_非S_表格行'   // 对照：等级不是 S ⇒ 角色视角照常看得见

  await db.saveTableRow({
    id: 's-level-table', tabId: 'items', projectId: pid,
    data: { 编号: 'ZZS001', 名称: S_TABLE, 保密等级: 'S' }, order: 9998,
  } as any)
  await db.saveTableRow({
    id: 'ok-level-table', tabId: 'items', projectId: pid,
    data: { 编号: 'ZZB001', 名称: OK_TABLE, 保密等级: 'B' }, order: 9997,
  } as any)
  await db.saveCardRecord({
    id: 's-level-card', tabId: 'char-secondary', projectId: pid,
    name: S_CARD, data: { 保密等级: 'S' }, order: 9998,
  })
  {
    // 表单整段：把「作品定位」标成 S。标记值要落在**同一个字段名**的所有键形态上，
    // 否则会被 demo 里已有的「模块::字段」复合键顶掉（renderForm 优先读复合键）。
    const cur = await db.getFormData('positioning')
    const next: Record<string, string> = { ...cur }
    let wrote = false
    for (const k of Object.keys(next)) {
      if (k === '核心卖点' || k.endsWith('::核心卖点')) { next[k] = S_FORM; wrote = true }
    }
    if (!wrote) next['核心卖点'] = S_FORM
    next['保密等级'] = 'S'
    await db.saveFormData('positioning', next)
  }

  const cv2 = await buildProjectContext({ budget: BIG, viewMode: 'character-view' })
  ok('🔴 S 级表格行在角色视角下被整行剔除', !cv2.text.includes(S_TABLE))
  ok('🔴 S 级卡片在角色视角下被整行剔除', !cv2.text.includes(S_CARD))
  ok('🔴 标了 S 的表单（作品定位）整段不带', !cv2.text.includes(S_FORM))
  ok('对照：非 S（B 级）的表格行在角色视角下**照常可见**（证明过滤没误伤）',
    cv2.text.includes(OK_TABLE))

  const dv2 = await buildProjectContext({ budget: BIG, viewMode: 'director-view' })
  ok('导演视角下 S 级内容照常带上（作者自己的底牌自己要看得见）',
    dv2.text.includes(S_TABLE) && dv2.text.includes(S_CARD) && dv2.text.includes(S_FORM),
    `表=${dv2.text.includes(S_TABLE)} 卡=${dv2.text.includes(S_CARD)} 表单=${dv2.text.includes(S_FORM)}`)

  console.log(`\nantiSpoiler: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
