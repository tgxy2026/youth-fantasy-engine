// ============ 3.4.0 · C 时光机恢复的前置校验 ============
//
// 恢复 = 覆盖作者正在写的东西。危险的不是「恢复」，而是**认错目标**：
// 弹窗开着切了章、12 版池把目标淘汰了、快照内容被改过 —— 这些都在 await 之后才发生，
// 所以必须在执行前再校验一次，不能相信打开弹窗时的界面状态。
import fs from 'node:fs'
import path from 'node:path'
import { checkRestoreTarget, restoreFailureMessage } from '../src/lib/editor/snapshotRestore'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

const base = {
  chapterId: 'c1',
  activeChapterId: 'c1',
  chapterExists: true,
  snapshot: { content: '旧稿' },
  expectedContent: '旧稿',
}

// ---------- ① 正常路径 ----------
ok('章在、当前就是这章、版本在、内容一致 → 放行', checkRestoreTarget(base).ok)

// ---------- ② 逐个条件失配 ----------
{
  const gone = checkRestoreTarget({ ...base, chapterExists: false })
  ok('🔴 章已被删 → 拒绝，且不改任何东西', !gone.ok && (!gone.ok && gone.message.includes('已不在项目')))

  const switched = checkRestoreTarget({ ...base, activeChapterId: 'c2' })
  ok('🔴 弹窗期间切了章 → 拒绝（不能把 A 章版本写进 B 章）',
    !switched.ok && (!switched.ok && switched.message.includes('切换到其他章节')))
  ok('没有打开任何章 → 同样拒绝', !checkRestoreTarget({ ...base, activeChapterId: null }).ok)

  const pruned = checkRestoreTarget({ ...base, snapshot: null })
  ok('🔴 版本被 12 版上限淘汰 → 拒绝并说明原因',
    !pruned.ok && (!pruned.ok && pruned.message.includes('12 版')))

  const drifted = checkRestoreTarget({ ...base, snapshot: { content: '被改过的稿' } })
  ok('🔴 快照内容与预览不一致 → 拒绝（作者看到的和要写的不是一份）',
    !drifted.ok && (!drifted.ok && drifted.message.includes('已变化')))
}

// ---------- ③ 判定顺序：别先报「内容变了」而章其实已经没了 ----------
{
  const both = checkRestoreTarget({ ...base, chapterExists: false, snapshot: null })
  ok('章没了 + 版本也没了 → 先报章（更接近作者的真实处境）',
    !both.ok && (!both.ok && both.message.includes('已不在项目')))
  const switchedAndPruned = checkRestoreTarget({ ...base, activeChapterId: 'c9', snapshot: null })
  ok('切了章 + 版本没了 → 先报切章（版本可能只是"另一章"的）',
    !switchedAndPruned.ok && (!switchedAndPruned.ok && switchedAndPruned.message.includes('切换到其他章节')))
}

// ---------- ④ 失败措辞必须安抚「我的稿还在吗」 ----------
{
  ok('失败文案说明草稿仍保留', restoreFailureMessage(new Error('磁盘忙')).includes('草稿仍保留'))
  ok('失败文案带原始错误（排查用）', restoreFailureMessage(new Error('磁盘忙')).includes('磁盘忙'))
  ok('非 Error 抛出也能读（不许变成 [object Object]）',
    restoreFailureMessage('quota').includes('quota') && !restoreFailureMessage('quota').includes('[object'))
}

// ---------- ⑤ 接线核对：模型里真的这么做了 ----------
{
  const model = read('src/components/editor/useNovelEditorModel.ts')
  // 3.4.0 · 事务体从 model 抽出（单文件 1200 行闸）⇒ 断言落在 restoreChapter.ts
  const run = read('src/components/editor/restoreChapter.ts')
  ok('🔴 恢复前调用 checkRestoreTarget（执行前再校验，而非依赖界面状态）',
    run.includes('checkRestoreTarget({') && run.includes('activeChapterId: hooks.active.current?.id'))
  ok('🔴 留档存的是当前草稿（draft），不是可能滞后的 chapter.content',
    run.includes('const currentText = hooks.draft.current') && run.includes('content: currentText'))
  ok('留档后读回核实，再继续', run.includes('verified.content !== currentText'))
  ok('落库成功后才改界面（先 await enqueueSave，后 applySaved）', (() => {
    const save = run.indexOf('await hooks.enqueueSave(chapterId')
    const apply = run.indexOf('hooks.applySaved(written, content)')
    return save >= 0 && apply > save
  })())
  ok('恢复失败文案统一走 restoreFailureMessage', run.includes('restoreFailureMessage(e)'))
  ok('模型只做装配：把 ref 与回写动作交给 restoreChapter', (() => {
    const call = model.indexOf('restoreChapter({')
    const apply = model.indexOf('applySaved: (written, text)')
    return call >= 0 && apply > call
  })())
  ok('取消挂起的自动保存（否则恢复后旧稿会被写回）', run.includes('clearTimeout(hooks.autosaveTimer.current)'))

  const modals = read('src/components/editor/EditorModals.tsx')
  ok('🔴 恢复按钮 await 真实结果，成功才关弹窗',
    modals.includes('const r = await onRestore(preview.id, preview.content)') && modals.includes('if (r.ok)'))
  ok('恢复中禁止重复提交', modals.includes('if (!preview || restoring) return') && modals.includes('disabled={restoring || creatingSnapshot}'))
  ok('失败时不关弹窗，并把原因显示出来', modals.includes('setRestoreError(r.message)') && modals.includes('{restoreError &&'))
  ok('界面写明「只恢复本章正文，不等于整部作品回退」', modals.includes('不等于把整部作品回退到那个时间点'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
