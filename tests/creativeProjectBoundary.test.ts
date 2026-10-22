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

console.log(`\n${fail === 0 ? '✅' : '❌'} creativeProjectBoundary: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
