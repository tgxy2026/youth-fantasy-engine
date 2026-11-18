// ============ Agent 写世界设定后的合并判定（3.6.1 · B2 从 hook 抽出）============
//
// 原先判定与 React 状态更新混在 `useAgentWorldSetSync` 的 effect 里。抽出来钉三件事：
//   ① 事件是不是给本页签 / 本项目的（切页签后别把别的书的数据冒出来）；
//   ② 记录归属对不对（projectId / 子项 store 双重校验）；
//   ③ **只追加、不覆盖**：本机已有同 id 记录时保持原样（作者可能正在改它）。
import { decideWorldSetEvent, shouldMergeWorldSetRecord } from '../src/lib/world/agentWorldSetDecision'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ask = (detail: Parameters<typeof decideWorldSetEvent>[0]['detail'], over: Partial<{ projectId: string | null; tabId: string }> = {}) =>
  decideWorldSetEvent({ detail, projectId: 'p-1', tabId: 'tab-char', ...over })

const record = { id: 'r-1', projectId: 'p-1', tabId: 'tab-char:sub' }
const merge = (over: Partial<Parameters<typeof shouldMergeWorldSetRecord>[0]> = {}) => shouldMergeWorldSetRecord({
  record, projectId: 'p-1', expectedTabId: 'tab-char:sub', existingIds: [], ...over,
})

function main() {
  // ① 事件筛选
  ok('非 world-set 事件忽略', ask({ kind: 'chapter', projectId: 'p-1', tabId: 'tab-char', cardId: 'r-1' }).accept === false)
  ok('别的项目忽略', ask({ kind: 'world-set', projectId: 'p-2', tabId: 'tab-char', cardId: 'r-1' }).accept === false)
  ok('别的页签忽略', ask({ kind: 'world-set', projectId: 'p-1', tabId: 'tab-other', cardId: 'r-1' }).accept === false)
  ok('缺 cardId 时忽略', ask({ kind: 'world-set', projectId: 'p-1', tabId: 'tab-char' }).accept === false)
  ok('空 detail 不崩', ask(null).accept === false)
  const good = ask({ kind: 'world-set', projectId: 'p-1', tabId: 'tab-char', cardId: 'r-1' })
  ok('本页签本项目的写入被接受', good.accept === true && good.cardId === 'r-1', JSON.stringify(good))
  ok('拒绝时给出原因', JSON.stringify(ask({ kind: 'world-set', projectId: 'p-2', tabId: 'tab-char', cardId: 'r' }))
    === JSON.stringify({ accept: false, reason: 'other-project' }))
  ok('当前没有打开项目时（projectId 为 null）一律忽略', ask({ kind: 'world-set', projectId: 'p-1', tabId: 'tab-char', cardId: 'r-1' }, { projectId: null }).accept === false)

  // ② 记录归属
  ok('记录不存在时不合并', merge({ record: null }) === false)
  ok('记录属于别的项目时不合并', merge({ record: { ...record, projectId: 'p-2' } }) === false)
  ok('记录落在别的子项 store 时不合并', merge({ record: { ...record, tabId: 'tab-char:other' } }) === false)

  // ③ 只追加不覆盖
  ok('记录已在列表里时不覆盖（保留本机草稿）', merge({ existingIds: ['r-1'] }) === false)
  ok('记录不在列表里时追加', merge({ existingIds: ['r-2'] }) === true)

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} agentWorldSetDecision ${pass}/${pass + fail}`)
  if (fail) process.exitCode = 1
}

main()
