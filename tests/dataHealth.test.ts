// ============ 数据体检 · 第 5 类「酒馆列表残留」与 issue id 稳定性 ============
//
// 2026-09-20 数据体检新增第 5 类检查：酒馆的「索引项」指向的正文/分条已不存在
// （列表里看得见、点开是空的）—— 即幽灵条目。检测能力早在 `tavern/store.ts` 就写好了
// （`auditSessions` / `auditFreeChars` / `auditFreeSessions`），此前**两种模式都没有产品入口**。
//
// 本测试锁三件事：
//   ① 干净库不误报；
//   ② 三类幽灵（剧情会话 / 自由角色卡 / 自由会话）各能被检出，且点名到具体条目；
//   ③ 🔴 新检查必须排在表格类问题**之后** —— issue id 是 `H1`、`H2`… 递增的，而本页的
//      「忽略」把 id **持久化**在 `healthIgnoredIds` 里。若把新检查插在中间，同一个 id 会
//      指向另一条问题，表现是「我忽略了 A，结果 B 被藏起来」，而且**不报任何错**（静默失效）。
//      第 ③ 组断言就是钉这个：加检查前后，既有问题的 id 必须一字不变。
import * as db from '../src/lib/db'
import { runDataHealthCheck } from '../src/lib/dataHealth'
import { TABS } from '../src/lib/schema'
import { __resetMockStores } from './mock-memory'
import type { TavernSessionIndexItem, TavernCharIndexItem, FreeSessionIndexItem } from '../src/lib/tavern/types'
import type { TableRow } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 本类检查的 category（唯一标识，测试靠它筛） */
const CAT = '酒馆列表残留'

/** 三个索引键：会话索引走 settings（项目级），角色卡 / 自由会话走 meta（跨项目） */
const K_SESSION = 'tavern.sessionIndex'
const K_CHAR = 'tavern.charIndex'
const K_FREE_SESSION = 'tavern.free.sessionIndex'

/**
 * 写三类幽灵索引项（**只写索引、不写分条** = 幽灵）。
 * 传 false 的那类写空数组（当作"没有幽灵"）。
 */
async function setGhosts(o: { sessions?: boolean; chars?: boolean; freeSessions?: boolean }) {
  // ⚠️ setter 不是泛型（只有 getter 是），类型靠变量标注来保：
  //    `db.setSetting<T>(...)` 会 TS2558（Expected 0 type arguments）。
  const sessions: TavernSessionIndexItem[] = o.sessions
    ? [{ id: 'g-sess', title: '幽灵推演', mode: 'immersive', castBrief: '', anchorTitle: '', updatedAt: Date.now() }]
    : []
  await db.setSetting(K_SESSION, sessions)
  const chars: TavernCharIndexItem[] = o.chars
    ? [{ id: 'g-char', name: '幽灵角色', storyId: '', updatedAt: Date.now() }]
    : []
  await db.setMeta(K_CHAR, chars)
  const freeSessions: FreeSessionIndexItem[] = o.freeSessions
    ? [{ id: 'g-free', title: '幽灵对话', charIds: [], lastActiveAt: Date.now(), updatedAt: Date.now() }]
    : []
  await db.setMeta(K_FREE_SESSION, freeSessions)
}

async function main() {
  __resetMockStores()
  // 造一个真项目再切过去：`saveTableRow` 会顺带 `touchProject`，项目不存在时会走空转分支
  const proj = await db.createProject('体检测试项目')
  db.setCurrentProject(proj.id)

  // ---------- 1) 干净库不误报 ----------
  {
    await setGhosts({})
    const res = await runDataHealthCheck()
    ok('索引与分条都空时不报「酒馆列表残留」',
      res.issues.every(i => i.category !== CAT),
      `实际=${res.issues.filter(i => i.category === CAT).length} 条`)
  }

  // ---------- 2) 三类幽灵各能被检出 ----------
  {
    await setGhosts({ sessions: true, chars: true, freeSessions: true })
    const res = await runDataHealthCheck()
    const hit = res.issues.filter(i => i.category === CAT)
    ok('三类幽灵各报一条', hit.length === 3, `实际=${hit.length}：${hit.map(i => i.title).join(' ｜ ')}`)
    ok('剧情会话幽灵：标题与条目名都点到',
      hit.some(i => i.title.includes('剧情推演会话') && i.detail.includes('幽灵推演')))
    ok('自由角色卡幽灵：标题与条目名都点到',
      hit.some(i => i.title.includes('自由对话角色卡') && i.detail.includes('幽灵角色')))
    ok('自由会话幽灵：标题与条目名都点到',
      hit.some(i => i.title.includes('自由对话会话') && i.detail.includes('幽灵对话')))
    ok('严重度是 warn（只提醒，不是数据冲突）', hit.length > 0 && hit.every(i => i.severity === 'warn'))
    ok('不带跳转位置（幽灵没有可跳的表格行，「跳转 ↗」会自然置灰）',
      hit.every(i => i.location === undefined))
    ok('文案如实说明「清理」入口，并讲清只动索引、不碰正文',
      hit.every(i => i.detail.includes('清理') && i.detail.includes('不碰正文')))

    // ---- 可清理分组：与 issue 靠 id 关联（刻意**不**往 AuditIssue 这个公共类型上加业务字段）----
    const gs = res.tavernGhosts ?? []
    ok('体检结果带出可清理分组', gs.length === 3, `实际=${gs.length}`)
    ok('分组的 issueId 都能在 issues 里找到（关联有效，界面不必解析文案）',
      gs.every(g => res.issues.some(i => i.id === g.issueId)))
    ok('三组 group 齐全（决定清理时调哪个 prune）',
      ['sessions', 'freeChars', 'freeSessions'].every(x => gs.some(g => g.group === x)))
    ok('每组 count 与对应 issue 的实际条数一致', gs.every(g => g.count === 1), JSON.stringify(gs.map(g => g.count)))
  }

  // ---------- 3) 🔴 id 稳定性：新检查不得改变既有问题的 id ----------
  {
    const tab = TABS.find(t => t.type === 'table' && t.displayCol)
    ok('前置：schema 里存在带主名称列的表格页签', !!tab)
    if (!tab) throw new Error('找不到可用的表格页签，后续断言无法进行')

    // 造一个表格类问题：主名称列为空（必填空 / warn）
    const row: TableRow = { id: 'row-blank', projectId: proj.id, tabId: tab.id, data: {}, order: 0 }
    await db.saveTableRow(row)

    // ③-1 先在没有幽灵的状态下跑一次 —— 相当于"作者当初忽略这条时"的编号
    await setGhosts({})
    const before = await runDataHealthCheck()
    const blankBefore = before.issues.find(i => i.category === '必填空')
    ok('前置：主名称为空的那行被检出', !!blankBefore, `共 ${before.issues.length} 条问题`)

    // ③-2 加回幽灵再跑 —— 同一个问题必须**占着同一个 id**
    await setGhosts({ sessions: true, chars: true, freeSessions: true })
    const after = await runDataHealthCheck()
    const blankAfter = after.issues.find(i => i.category === '必填空')
    ok('🔴 新增检查后既有问题的 id 未变（否则作者已忽略的 id 会错位到别的条目）',
      !!blankBefore && blankAfter?.id === blankBefore.id,
      `${blankBefore?.id} → ${blankAfter?.id}`)

    const ghosts = after.issues.filter(i => i.category === CAT)
    const maxGhost = ghosts.length ? Math.max(...ghosts.map(g => Number(g.id.slice(1)))) : -1
    ok('🔴 幽灵检查排在表格类问题之后（追加在末尾，故既有编号不受影响）',
      ghosts.length === 3 && maxGhost > Number(blankAfter?.id.slice(1) ?? '0'),
      `必填空=${blankAfter?.id} 幽灵=${ghosts.map(g => g.id).join(',')}`)
  }

  console.log(`\ndataHealth: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
