// ============ 3.4.0 · B 本章资料绑定的写入安全 ============
//
// 这组判据的共同点：**写反了界面上看不出来**。
//   ① 读失败仍允许写 ⇒ 一次「固定」就把库里的原绑定覆盖成空绑定（静默丢数据）；
//   ② 目录读失败却说「记录已删除」⇒ 作者以为资料没了，去做多余的重建。
// 所以这里既测纯函数，也核对调用点真的用了它（只写模块不接线 = 白做）。
import fs from 'node:fs'
import path from 'node:path'
import { bindingWriteGate, pinnedUnavailableLabel } from '../src/lib/revision/chapterContextSafety'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 只有读成功才允许写 ----------
{
  ok('ready → 允许写', bindingWriteGate('ready').allowed)
  ok('🔴 loading → 不允许写（写下去是占位空绑定）', !bindingWriteGate('loading').allowed)
  ok('🔴 failed → 不允许写（写下去会覆盖库里真实记录）', !bindingWriteGate('failed').allowed)
  ok('被拦下时必须给出原因（不能静默失效）',
    bindingWriteGate('failed').reason.length > 0 && bindingWriteGate('loading').reason.length > 0)
  ok('failed 的原因点明「以免覆盖」', bindingWriteGate('failed').reason.includes('覆盖'))
  ok('ready 不返回多余提示', bindingWriteGate('ready').reason === '')
}

// ---------- ② 固定项失效文案：三种原因不许混 ----------
{
  ok('模块被策略禁用 → 说「未启用」，不说删除',
    pinnedUnavailableLabel({ tabVisible: false, found: false, catalogError: '' }).includes('未启用'))
  ok('找到了 → 没有失效说明', pinnedUnavailableLabel({ tabVisible: true, found: true, catalogError: '' }) === '')
  ok('🔴 目录读失败 → 只说「暂时无法确认」，不说「已删除」', (() => {
    const text = pinnedUnavailableLabel({ tabVisible: true, found: false, catalogError: '关联资料目录读取失败' })
    return text.includes('暂时无法确认') && !text.includes('记录已删除')
  })())
  ok('目录读成功但找不到 → 才能说「记录已删除」',
    pinnedUnavailableLabel({ tabVisible: true, found: false, catalogError: '' }).includes('记录已删除'))
  ok('模块禁用优先于目录失败（禁用时目录根本没读）',
    pinnedUnavailableLabel({ tabVisible: false, found: false, catalogError: '目录失败' }).includes('未启用'))
}

// ---------- ③ 接线核对 ----------
{
  const hook = read('src/components/editor/useChapterContextData.ts')
  ok('🔴 useChapterContextData 的写入口走 bindingWriteGate',
    hook.includes('bindingWriteGate(statusRef.current)'))
  ok('固定项失效文案走 pinnedUnavailableLabel（不再手写三元）',
    hook.includes('pinnedUnavailableLabel({') && hook.includes('catalogError,'))
  ok('读失败时状态置 failed，而不是 loaded（不再允许写）',
    hook.includes("setBindingStatus('failed')"))
  ok('读请求带序号，迟到响应不许落到新上下文',
    hook.includes('loadAttempt') && hook.includes('attempt !== loadAttempt.current'))
  ok('保存失败回滚到上次成功写入的版本（界面不停在假已保存）',
    hook.includes('persistedRef.current') && hook.includes('setBinding(persistedRef.current)'))

  const panel = read('src/components/editor/ChapterContextPanel.tsx')
  ok('面板在读失败时给出重试入口', panel.includes('retryBinding') && panel.includes('重试'))
  ok('面板说明「跟随当前章」与「固定不改发送范围」',
    panel.includes('当前这一章') && panel.includes('续写是否带入固定资料'))
  ok('面板页签偏好持久化（换章不用重点）', panel.includes("usePersistedEnum<ContextTab>('chapter-context-tab'"))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
