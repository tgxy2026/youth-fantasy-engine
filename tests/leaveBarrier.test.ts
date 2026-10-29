// ============ 3.3.0 · UX06：离页屏障（leaveBarrier）============
//
// 守的是这条已确认的缺口：
//   「正文写盘失败 → 仍然切页签 / 退出项目 → 界面看起来正常 → 重启发现少了一章」。
// 原先离页只有卸载时的异步冲刷兜底，而 `flushEditorDraftNow()` 故意吞失败（关窗场景可以吞，
// 离页不行：那时页面已经没了，作者没有任何重试机会）。
//
// 本用例分两层：
//   ① 运行期：guard 的登记 / 脏判定 / 成败传递 / 异常不外泄；
//   ② 静态闸：App 与编辑器确实**按要求接上了**，且没有退回旧的吞失败写法
//      （静态闸很必要 —— 这些行为在单测里没有 DOM 就测不到，靠源码契约钉住）。
import fs from 'node:fs'
import path from 'node:path'
import {
  registerLeaveGuard,
  hasLeaveGuard,
  leaveGuardDirty,
  runLeaveGuard,
  registerAuxiliaryLeaveGuard, auxiliaryLeaveGuardDirty, runAuxiliaryLeaveGuards,
} from '../src/lib/editor/leaveBarrier'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

async function main() {
  // ---------- ① 没有编辑器时：一切照旧，绝不放慢导航 ----------
  {
    registerLeaveGuard(null)
    ok('① 未登记 guard：hasLeaveGuard 为 false', hasLeaveGuard() === false)
    ok('① 未登记 guard：不认为有脏稿', leaveGuardDirty() === false)
    const r = await runLeaveGuard()
    ok('① 未登记 guard：屏障直接放行', r.ok === true)
  }

  // ---------- ② 干净时：不调用 flush，保持 App 的同步导航路径 ----------
  {
    let flushed = 0
    registerLeaveGuard({ isDirty: () => false, flush: async () => { flushed++; return { ok: true } } })
    ok('🔴 ② 干净时 leaveGuardDirty 为 false（App 据此走同步路径）', leaveGuardDirty() === false)
    const r = await runLeaveGuard()
    ok('② 干净时屏障放行', r.ok === true)
    ok('🔴 ② 干净时不触发写盘（不能给每次切页签加一次保存）', flushed === 0)
  }

  // ---------- ③ 脏时：必须真的冲刷，且成功才放行 ----------
  {
    let flushed = 0
    registerLeaveGuard({ isDirty: () => true, flush: async () => { flushed++; return { ok: true } } })
    ok('③ 脏时 leaveGuardDirty 为 true', leaveGuardDirty() === true)
    const r = await runLeaveGuard()
    ok('③ 写盘成功后才放行', r.ok === true)
    ok('③ flush 恰好调用一次', flushed === 1)
  }

  // ---------- ④ 写盘失败：必须如实传回去（正文 / 标题摘要分别带 scope） ----------
  {
    const err = new Error('磁盘写满')
    registerLeaveGuard({ isDirty: () => true, flush: async () => ({ ok: false, scope: 'content', error: err }) })
    const rc = await runLeaveGuard()
    ok('🔴 ④ 正文失败：ok 为 false（调用方必须据此不跳转）', rc.ok === false)
    ok('④ 正文失败：scope=content', rc.ok === false && rc.scope === 'content')
    ok('④ 正文失败：原始错误透传', rc.ok === false && rc.error === err)

    registerLeaveGuard({ isDirty: () => true, flush: async () => ({ ok: false, scope: 'meta', error: err }) })
    const rm = await runLeaveGuard()
    ok('④ 标题/摘要失败：scope=meta', rm.ok === false && rm.scope === 'meta')
  }

  // ---------- ⑤ flush 抛异常：转成失败，不许把导航逻辑一起带崩 ----------
  {
    const boom = new Error('boom')
    registerLeaveGuard({ isDirty: () => true, flush: async () => { throw boom } })
    let threw = false
    let r
    try { r = await runLeaveGuard() } catch { threw = true }
    ok('🔴 ⑤ flush 抛错不向调用方冒泡', threw === false)
    ok('⑤ 抛错按失败处理', r != null && r.ok === false)
  }

  // ---------- ⑥ isDirty 自己抛错：按「脏」处理（宁多问一次，不静默放过） ----------
  {
    let flushed = 0
    registerLeaveGuard({
      isDirty: () => { throw new Error('state broken') },
      flush: async () => { flushed++; return { ok: false, scope: 'content', error: 'x' } },
    })
    ok('🔴 ⑥ 脏判定异常时按脏处理', leaveGuardDirty() === true)
    const r = await runLeaveGuard()
    ok('⑥ 脏判定异常时仍走冲刷', flushed === 1 && r.ok === false)
  }

  // ---------- ⑦ 注销后彻底不再参与 ----------
  {
    registerLeaveGuard({ isDirty: () => true, flush: async () => ({ ok: false, scope: 'content', error: 1 }) })
    registerLeaveGuard(null)
    ok('⑦ 注销后 hasLeaveGuard 为 false', hasLeaveGuard() === false)
    ok('⑦ 注销后视为干净', leaveGuardDirty() === false)
    const r = await runLeaveGuard()
    ok('⑦ 注销后放行', r.ok === true)
  }

  // ---------- ⑧ 静态闸：App 必须真的接上屏障 ----------
  {
    const app = read('src/App.tsx')
    ok('🔴 ⑧ App 引入离页屏障', /from '@\/lib\/editor\/leaveBarrier'/.test(app))
    // 🔴 守的是「navigate 一定经 pageNavigationIntent → navGate.request」，不是那个对象的字面写法：
    //    3.3.1 · T1 给它加了可选的 position（全文检索命中定位），写法由单行变成展开对象。
    ok('🔴 ⑧ navigate 经共享事务屏障提交',
      app.includes('dirty: leaveGuardDirty, flush: runLeaveGuard')
      && /const navigate = useCallback\([\s\S]{0,260}pageNavigationIntent\(\{[\s\S]{0,200}tabId: id, chapterId, rowId/.test(app)
      && /const navigate = useCallback\([\s\S]{0,600}navGate\.request\(intent\)/.test(app))
    ok('🔴 ⑧ exitProject 经过同一事务屏障', app.includes("navGate.request({ kind: 'exit' })") && /intent.kind === 'exit'[\s\S]{0,60}doExitProject\(\)/.test(app))
    ok('🔴 ⑧ 真正跳页只在 applyNav 里（屏障失败不会走到它）', /const applyNav = useCallback[\s\S]{0,1200}setActiveTab\(id\)/.test(app))
    ok('🔴 ⑧ 退出项目里清 projectId 的动作与退出入口分离', /const doExitProject = useCallback[\s\S]{0,1500}setProjectId\(null\)/.test(app))
    ok('⑧ 有在途标记，避免一次离页走出两条导航', /navPending/.test(app))
    ok('🔴 ⑧ 失败提示说清「没退出 / 留在当前页」', /还没退出项目/.test(app) && /已留在当前页面/.test(app))
  }

  // ---------- ⑨ 静态闸：编辑器必须登记 guard，且失败要能被看见 ----------
  {
    const model = read('src/components/editor/useNovelEditorModel.ts')
    const hook = read('src/components/editor/useEditorLeaveBarrier.ts')
    ok('🔴 ⑨ 编辑器接上离页屏障 hook', /useEditorLeaveBarrier\(\{/.test(model))
    ok('🔴 ⑨ hook 里登记 guard', /registerLeaveGuard\(\{/.test(hook))
    ok('🔴 ⑨ hook 卸载时注销 guard', /registerLeaveGuard\(null\)/.test(hook))
    ok('🔴 ⑨ guard 的 flush 不复用吞失败的 flushEditorDraftNow',
      // 判「没引入/没调用」，不看注释里那句「绝不调用」的说明
      !/from '@\/lib\/editor\/draftFlush'/.test(hook) && !/flushEditorDraftNow\s*\(/.test(hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))
    ok('🔴 ⑨ 脏判定同时覆盖正文与标题摘要', /draftRef\.current !== cur\.content/.test(hook) && /metaPending\.current\.size > 0/.test(hook))
    ok('🔴 ⑨ commitContent 返回成败（catch 里 return ok:false）', /catch \(e\)[\s\S]{0,400}return \{ ok: false, error: e \}/.test(model))
    ok('🔴 ⑨ 切章前检查保存结果，失败不切', /const r = await commitContent\(draftRef\.current\)[\s\S]{0,300}if \(!r\.ok\)[\s\S]{0,200}return false/.test(model))
    ok('🔴 ⑨ metaFlush 不再吞掉单笔失败', !/j\(\)\.catch\(\(\) => \{ \/\* 忽略单笔失败 \*\/ \}\)/.test(model))
    ok('🔴 ⑨ metaFlush 失败的那笔记账放回队列（可重试）', /metaPending\.current\.set\(id, job\)/.test(model))
    ok('🔴 ⑨ metaFlush 把成败返回给调用方', /return \{ ok: errors\.length === 0, errors \}/.test(model))
    ok('🔴 ⑨ 标题摘要防抖到点也要报失败', /metaFlush\.current\(\)\.then\(r => \{\s*if \(!r\.ok\)/.test(model))
  }

  registerLeaveGuard({ isDirty: () => true, flush: async () => ({ ok: false, scope: 'record', error: 'isolated record failure' }) })
  const recordFailure = await runLeaveGuard()
  ok('资料页失败保持record作用域，不假报正文章节失败', !recordFailure.ok && recordFailure.scope === 'record')
  registerLeaveGuard(null)

  {
    const order: string[] = []; let pending = true
    registerLeaveGuard({ isDirty: () => true, flush: async () => { order.push('body'); return { ok: true } } })
    const dispose = registerAuxiliaryLeaveGuard({ isDirty: () => pending, flush: async () => { order.push('field'); return { ok: false, scope: 'record', error: 'retained' } } })
    ok('auxiliary: side pane contributes to the global dirty check', leaveGuardDirty() && auxiliaryLeaveGuardDirty())
    ok('auxiliary: failed side pane blocks navigation before primary flush', !(await runLeaveGuard()).ok && order.join() === 'field')
    pending = false
    ok('auxiliary: clean side pane does not replace the primary guard', (await runLeaveGuard()).ok && order.join() === 'field,body')
    dispose(); dispose(); registerLeaveGuard(null)
    ok('auxiliary: disposal removes only its own guard and is idempotent', !hasLeaveGuard())
  }
  {
    let release!: () => void, pending = true
    const wait = new Promise<void>(yes => { release = yes })
    const dispose = registerAuxiliaryLeaveGuard({ isDirty: () => pending, flush: async () => { await wait; pending = false; return { ok: true } } })
    const job = runAuxiliaryLeaveGuards(); dispose()
    const disposeNew = registerAuxiliaryLeaveGuard({ isDirty: () => false, flush: async () => ({ ok: true }) })
    release(); ok('auxiliary: replacement during a delayed flush rejects an old receipt', !(await job).ok); disposeNew()
  }
  {
    const dispose = registerAuxiliaryLeaveGuard({ isDirty: () => true, flush: async () => ({ ok: true }) })
    ok('auxiliary: new input still dirty after a successful flush blocks leaving', !(await runAuxiliaryLeaveGuards()).ok); dispose()
    const disposeError = registerAuxiliaryLeaveGuard({ isDirty: () => { throw Error('dirty') }, flush: async () => { throw Error('flush') } })
    const result = await runAuxiliaryLeaveGuards()
    ok('auxiliary: dirty/flush exceptions stay bounded with record scope', !result.ok && result.scope === 'record'); disposeError()
  }
  {
    let earlierDirty = false, laterDirty = true
    const first = registerAuxiliaryLeaveGuard({ isDirty: () => earlierDirty, flush: async () => ({ ok: true }) })
    const second = registerAuxiliaryLeaveGuard({ isDirty: () => laterDirty, flush: async () => { earlierDirty = true; laterDirty = false; return { ok: true } } })
    ok('auxiliary: a later flush cannot conceal new input in an earlier pane', !(await runAuxiliaryLeaveGuards()).ok)
    second(); first()
  }

  console.log(`\n———— leaveBarrier：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
