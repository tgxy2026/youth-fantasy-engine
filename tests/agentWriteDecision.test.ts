// ============ Agent 写入正文后的界面同步判定（3.6.1 · B2 从 hook 抽出）============
//
// 这段判定原先埋在 `useAgentWriteSync` 的事件回调里，靠两个可变 ref 参与判断，
// 只能靠真机验证。抽成纯函数后逐条钉住 —— 每条分支都对应一次**已经在发生的丢字风险**：
//   ① 不是本章/本卷的写入 → 不理；
//   ② 别的项目的事件晚到 → 不理（切项目后事件还在路上）；
//   ③ 当前章有**未保存草稿** → 保留草稿，绝不覆盖（否则 Agent 刚写的正文会被旧草稿盖回去）；
//   ④ 当前章干净 → 读库后应用；
//   ⑤ 读库期间作者开始输入 / 切了章 → 放弃这次应用（宁可停在旧正文，也不吞新敲的字）；
//   ⑥ 刷新列表时要保留本机正在编辑的那一条。
//
// 🔴 行为与 3.4.3 起一致：草稿冲突是**静默保留**，本版没加提示（加提示属产品决定）。
import {
  canApplyAgentChapter, decideAgentWrite, mergeKeepingLocal,
} from '../src/lib/editor/agentWriteDecision'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const chapter = { id: 'ch-1', content: '库里的正文' }
const ask = (over: Partial<Parameters<typeof decideAgentWrite>[0]> = {}) => decideAgentWrite({
  detail: { kind: 'chapter', projectId: 'p-1', chapterId: 'ch-1' },
  currentProjectId: 'p-1',
  activeChapter: chapter,
  draft: '库里的正文',
  ...over,
})

function main() {
  // ① 不是本模块管的写入
  ok('别的 kind 一律忽略', ask({ detail: { kind: 'card' } }).action === 'ignore')
  ok('空 detail 不崩', ask({ detail: null }).action === 'ignore')
  ok('忽略时给出原因（other-kind）', JSON.stringify(ask({ detail: undefined })) === JSON.stringify({ action: 'ignore', reason: 'other-kind' }))

  // ② 别的项目的事件
  const otherProject = ask({ detail: { kind: 'chapter', projectId: 'p-2', chapterId: 'ch-1' } })
  ok('其它项目的事件忽略', otherProject.action === 'ignore' && otherProject.reason === 'other-project', JSON.stringify(otherProject))
  ok('事件不带 projectId 时按本项目处理', ask({ detail: { kind: 'chapter', chapterId: 'ch-1' } }).action === 'apply-chapter')

  // ③ 当前章有未保存草稿 → 保留草稿
  const dirty = ask({ draft: '作者刚敲的字' })
  ok('当前章有未保存草稿时保留草稿', dirty.action === 'keep-draft' && dirty.reason === 'unsaved-draft', JSON.stringify(dirty))
  ok('草稿与库里一致（无改动）时不算脏', ask({ draft: '库里的正文' }).action === 'apply-chapter')

  // ④ 当前章干净 → 应用
  const apply = ask()
  ok('当前章干净时直接应用', apply.action === 'apply-chapter' && apply.chapterId === 'ch-1', JSON.stringify(apply))

  // ⑤ 整卷 / 非当前章 → 刷新列表
  const volume = ask({ detail: { kind: 'volume', projectId: 'p-1' } })
  ok('整卷变更走刷新列表', volume.action === 'refresh-list' && volume.reason === 'volume', JSON.stringify(volume))
  const otherChapter = ask({ detail: { kind: 'chapter', projectId: 'p-1', chapterId: 'ch-9' } })
  ok('其它章变更走刷新列表', otherChapter.action === 'refresh-list' && otherChapter.reason === 'not-active-chapter', JSON.stringify(otherChapter))
  const noActive = ask({ activeChapter: null })
  ok('没有打开章节时走刷新列表（不试着应用）', noActive.action === 'refresh-list' && noActive.reason === 'not-active-chapter', JSON.stringify(noActive))
  ok('整卷变更即使当前章脏也只刷新列表（不动草稿）', ask({ detail: { kind: 'volume', projectId: 'p-1' }, draft: '改过' }).action === 'refresh-list')

  // ⑥ 读库后的二次判定
  ok('读库前后都没变时应用', canApplyAgentChapter({ stillActive: true, stillSameDraft: true, found: true }))
  ok('读库期间切了章则放弃', canApplyAgentChapter({ stillActive: false, stillSameDraft: true, found: true }) === false)
  ok('读库期间开始输入则放弃', canApplyAgentChapter({ stillActive: true, stillSameDraft: false, found: true }) === false)
  ok('库里找不到该章则放弃', canApplyAgentChapter({ stillActive: true, stillSameDraft: true, found: false }) === false)

  // ⑦ 刷新列表时保留本机正在编辑的那一条
  const incoming = [{ id: 'ch-1', content: 'Agent 写的' }, { id: 'ch-2', content: '另一章' }]
  const merged = mergeKeepingLocal(incoming, { id: 'ch-1', content: '作者正在改的' })
  ok('本机正在编辑的那条不被覆盖', merged[0].content === '作者正在改的', JSON.stringify(merged))
  ok('其它章按库里的内容更新', merged[1].content === '另一章')
  ok('没有正在编辑的章时原样采用库里的列表', JSON.stringify(mergeKeepingLocal(incoming, null)) === JSON.stringify(incoming))
  ok('本机那条不在列表里时也不崩', mergeKeepingLocal(incoming, { id: 'ch-x', content: 'x' }).length === 2)

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} agentWriteDecision ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
