// ============ 关窗前写盘：返回值的三态判定（2026-09-23 六维审计 P2）============
//
// 病根：主进程写失败时**返回 `{ok:false}` 而不抛异常**；而 `saveSync` 还可能返回 `undefined`
// （IPC 根本没返回值 = 压根没写）。旧写法 `if (r && r.ok === false)` 让 `undefined`
// 落进成功分支、顺手清掉 `dirty` ⇒ **关窗前的最后一次编辑被静默丢弃**。
//
// 这里钉两件事：
//   ① 三态判定本身（含「失败但没给原因时不能让 error 变成 undefined」）；
//   ② 接线 —— `flushDesktopSync` 真的走它，且失败分支是 `return`（保留 dirty）
//      而不是继续往下把 dirty 清掉。
import fs from 'node:fs'
import { interpretSaveSyncResult } from '../src/lib/app/desktop'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('\n▶ desktopSaveVerdict')

// ---------- 1. 三态 ----------
{
  const undef = interpretSaveSyncResult(undefined)
  ok('🔴 undefined（IPC 没返回值）算**失败**，且原因可读',
    undef.ok === false && undef.error === 'IPC 未返回值', JSON.stringify(undef))

  const failed = interpretSaveSyncResult({ ok: false, error: '磁盘已满' })
  ok('{ok:false} 算失败，并带上主进程给的原因',
    failed.ok === false && failed.error === '磁盘已满', JSON.stringify(failed))

  const noReason = interpretSaveSyncResult({ ok: false, error: null })
  ok('{ok:false} 但没给原因 ⇒ 兜底文案（不能是 undefined/空）',
    noReason.ok === false && typeof noReason.error === 'string' && noReason.error.length > 0,
    JSON.stringify(noReason))

  const good = interpretSaveSyncResult({ ok: true, error: null })
  ok('{ok:true} 才算成功', good.ok === true, JSON.stringify(good))
}

// ---------- 2. 接线（抽了不用 = 白抽，单测看不出来）----------
{
  const src = fs.readFileSync('src/lib/app/desktop.ts', 'utf8')
  const at = src.indexOf('export function flushDesktopSync()')
  ok('前置：能找到 flushDesktopSync', at > 0)
  const body = src.slice(at, at + 900)
  ok('🔴 接线：判定走 interpretSaveSyncResult（不是原地重写一遍三态）',
    body.includes('interpretSaveSyncResult('))
  ok('🔴 接线：失败分支里是 return（保留 dirty），不是继续往下清 dirty',
    /if \(!verdict\.ok\)[\s\S]{0,200}?return/.test(body),
    body.slice(0, 220).replace(/\n/g, '⏎'))
  ok('🔴 接线：旧的三态误判写法已不存在（`r && r.ok === false`）',
    !/if \(r && r\.ok === false\)/.test(body))
  // 🔴 2026-10-17 全量审计 P2：dirty 从布尔清理改为**序号判定** —— 写盘 await 期间的
  //    新改动（writeSeq 递增）不能被成功分支吞掉；正常路径仍然会清（writeSeq 未变 ⇒ false 之外的分支）。
  ok('反例：成功路径仍会清 dirty（改用写入序号判定，不能矫枉过正改成"永远不清"）',
    /savedSeq = writeSeq/.test(body) && /dirty = writeSeq !== savedSeq/.test(body))
  ok('🔴 反向守卫：成功分支不许再无条件 `dirty = false`（会吞掉写盘期间的新改动）',
    !/dirty = false/.test(body))
}

console.log(`\ndesktopSaveVerdict: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
