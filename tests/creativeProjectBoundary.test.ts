// 3.2.2 · 创意写作跨项目守卫 · 单测
//
// 背景（用户 2026-10-23 反馈）：「我一个项目在创意写作，切换到另一个项目，创意写作也在进行」
// 核实结论：真 bug，且比反馈严重 —— 任务的**读与写全走 `db.*`（隐式取当前项目）**，
// 切项目后 A 的产出会带着 B 的 projectId 落库（新章 / 大纲 / 设定草稿 / 运行账本 / 改写候选）。
//
// 本测试钉的是**判定表**（`runBelongsTo`）——最容易写反、也最容易被后人"顺手简化"的那部分：
//   · 没在跑 ⇒ 永不打断；
//   · 同项目重开 ⇒ 不打断（App 允许：被中止的任务可「继续」）；
//   · 跑到别的项目 ⇒ 必须打断；
//   · 没有绑定项目（老状态）⇒ 保守不打断。
//
// ⚠️ 副作用部分（真的把 `running` 置 false、弹 notice、resolve 三个挂起弹窗）没有在这里起真任务验证 ——
//    `startCreativeRun` 需要模型端点。那部分靠代码审查 + `abortRunIfProjectChanged` 复用
//    `stopCreativeRun()`（后者已有既有测试覆盖）来保证；真机复现清单见
//    `docs/归档/3.2/3.2.2-创意写作跨项目修复-2026-10-23.md`。
import { runBelongsTo, abortRunIfProjectChanged } from '@/lib/creative/creativeSession'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

console.log('\n── ① 判定表 ──')
{
  // 没在跑：任何情况都不冲突
  ok('没在跑 + 无绑定 ⇒ 不冲突', runBelongsTo(null, false, 'pB') === true)
  ok('没在跑 + 有绑定 ⇒ 不冲突', runBelongsTo('pA', false, 'pB') === true)

  // 在跑：绑定项目决定
  ok('跑到 A、切到 A ⇒ 不冲突（同项目重开，任务可继续）', runBelongsTo('pA', true, 'pA') === true)
  ok('🔴 跑到 A、切到 B ⇒ 冲突（必须打断）', runBelongsTo('pA', true, 'pB') === false)
  ok('🔴 跑到 A、退出项目（空串）⇒ 冲突', runBelongsTo('pA', true, '') === false)

  // 老状态没有绑定：保守不打断（宁可少停一次，不误杀）
  ok('在跑但没有绑定项目 ⇒ 不冲突（保守）', runBelongsTo(null, true, 'pB') === true)
}

console.log('\n── ② 没有任务时调用：不该有副作用 ──')
{
  // 初始 snap.running 为 false（模块级默认值），此时调用应当直接返回 false
  const aborted = abortRunIfProjectChanged('some-other-project')
  ok('无任务时返回 false（没有可中止的东西）', aborted === false, String(aborted))
  // 幂等：连调两次也不该抛
  ok('连调两次不抛且仍返回 false', abortRunIfProjectChanged('') === false)
}

/**
 * ③ 切项目前的「未落盘想法」必须写回**原项目**（3.2.2 遗留修复 · 2026-10-23）
 *
 * 病灶：想法走 1 秒防抖落盘，而 `persistNow()` 原先无条件读全局「当前项目」。
 * 作者填完想法 1 秒内切项目 ⇒ 防抖在切换**之后**才触发 ⇒ 想法被写进新项目的键，
 * 原项目里反而没有（实机遗留第 2 条）。
 *
 * 这里用真（内存）存储走一遍：写想法 → **不等 1 秒**立刻切项目 → 等过防抖窗口 → 查两边的键。
 */
console.log('\n── ③ 切项目时未落盘的想法归属 ──')
{
  const db = await import('@/lib/db')
  const { hydrateCreativeSession, updateInputs } = await import('@/lib/creative/creativeSession')

  db.setCurrentProject('pA')
  await hydrateCreativeSession()          // 会话归属 = pA（面板挂载时就是这么做的）
  updateInputs({ seed: '一秒内切走也要保住的想法' })   // 排下 1 秒防抖

  // 立刻切项目（模拟 App：先判再切）
  const aborted = abortRunIfProjectChanged('pB')
  ok('③ 没在跑时仍返回 false（不误报"已中止任务"）', aborted === false, String(aborted))

  // 真的切过去
  db.setCurrentProject('pB')
  // 等过 1 秒防抖窗口：如果旧实现还留了定时器，这里就会把内容写进 pB
  await new Promise(r => setTimeout(r, 1300))

  type SessionRec = { inputs?: { seed?: string } } | null
  const aRec = await db.getMeta<SessionRec>('creativeSession:pA', null)
  const bRec = await db.getMeta<SessionRec>('creativeSession:pB', null)
  ok('🔴 ③ 想法写回了**原项目** pA', aRec?.inputs?.seed === '一秒内切走也要保住的想法',
    JSON.stringify(aRec?.inputs ?? null))
  ok('🔴 ③ 新项目 pB 里**没有**串味的会话', !bRec, JSON.stringify(bRec ?? null))

  // 收尾：回到干净状态，免得影响后续用例
  db.setCurrentProject('')
}

/**
 * ④ 源码闸：中止路径上的两件"必须做否则会反噬"的事
 *
 * 这两条**没法用行为测**（要走 `startCreativeRun`，需要模型端点），但它们一旦被后人删掉，
 * 症状都是**静默的数据事故**，所以逐条钉住：
 *   · 取消 set() 排下的落盘 —— 否则 1 秒后全局 pid 已换成新项目，
 *     那个定时器会把"清空后的会话"写进新项目，等于用空壳覆盖 B 自己的会话；
 *   · 清 `SESSION_BLANK` —— 否则切到 B 的当下会显示 A 的「已中止 · 继续写作」（实机遗留第 1 条）。
 */
console.log('\n── ④ 源码闸：中止路径的两个关键动作 ──')
{
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/lib/creative/creativeSession.ts', 'utf8')
  const body = /export function abortRunIfProjectChanged[\s\S]*?\n\}/.exec(src)?.[0] ?? ''

  ok('④ 能找到 abortRunIfProjectChanged', body.length > 100, String(body.length))
  ok('🔴 ④ 切项目前先把未落盘草稿写回**所属项目**（显式 pid）',
    /flushPersist\(owner\)/.test(body))
  ok('④ 归属取 runProjectId 或 hydratedFor（不是全局当前项目）',
    /const owner = runProjectId \?\? hydratedFor/.test(body))
  ok('🔴 ④ 中止后取消排队的落盘（否则 1 秒后写进新项目）',
    /cancelScheduledPersist\(\)/.test(body))
  ok('🔴 ④ 中止后清 SESSION_BLANK（B 面板不再显示 A 的残留）',
    /\.\.\.SESSION_BLANK/.test(body))
  ok('④ 落盘函数支持指定项目（persistNow 接受 pid）',
    /async function persistNow\(pid\?: string\)/.test(src)
    && /const target = pid \?\? db\.getCurrentProjectId\(\)/.test(src))
  ok('④ flushPersist 同口径支持 pid', /export async function flushPersist\(pid\?: string\)/.test(src))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} creativeProjectBoundary: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
