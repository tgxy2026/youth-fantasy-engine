// ============ 折叠状态持久化（uiPrefs）============
//
// 本轮把 5 处树状 / 分组折叠统一交给 `lib/uiPrefs.ts`。这个用例盯三件事：
//   ① 纯读写函数的行为与降级（脏数据 / 无 Web Storage 环境不许崩）；
//   ② 🔴 **语义约定**：一律存「偏离默认的那一侧」（侧栏存"已折叠的分组"），
//      否则以后新增分组时，老用户的存量记录里没有它 → 新功能一上来就是收起的；
//   ③ 五处接入点都真的用了它 —— 只写模块不接线，等于白做。
import fs from 'node:fs'
import path from 'node:path'
// uiPrefs 的模块顶层不碰 localStorage（只在函数体内读），所以普通 import 也能让上面的桩先生效
import { readSetPref, writeSetPref, readBoolPref, writeBoolPref } from '../src/lib/uiPrefs'

// 最小 localStorage 桩：uiPrefs 只做字符串读写，不需要完整 Web Storage 实现。
// ⚠️ 必须在**调用函数之前**装好：uiPrefs 的函数体内才访问 localStorage（模块顶层不访问）。
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

// ---------- ① 读写往返 ----------
{
  ok('无记录 → null（由调用方决定默认值，模块不替它猜）', readSetPref('nope') === null)
  ok('默认布尔由调用方给（无记录时原样返回）',
    readBoolPref('nope', true) === true && readBoolPref('nope', false) === false)

  writeSetPref('t1', ['a', 'b'])
  ok('集合写完能读回来', JSON.stringify(readSetPref('t1')) === JSON.stringify(['a', 'b']))
  // 空集合是**合法状态**（"我把所有分组都折叠了"），不能被当成"没记录"退回默认值
  writeSetPref('t1', [])
  ok('🔴 空集合读回来是空数组、不是 null（否则"全折叠"会被默认值覆盖回去）',
    Array.isArray(readSetPref('t1')) && readSetPref('t1')!.length === 0)

  writeBoolPref('b1', true)
  ok('布尔 true 往返', readBoolPref('b1', false) === true)
  writeBoolPref('b1', false)
  ok('🔴 布尔 false 也是"有记录"（不能被默认值 true 顶掉）', readBoolPref('b1', true) === false)
}

// ---------- ② 脏数据 / 异常一律降级，不许崩 ----------
{
  store.set('yfe-ui:broken', '{不是 JSON')
  ok('坏 JSON → null（界面回到默认展开，而不是白屏）', readSetPref('broken') === null)

  store.set('yfe-ui:notarray', JSON.stringify({ a: 1 }))
  ok('存的不是数组 → null', readSetPref('notarray') === null)

  store.set('yfe-ui:mixed', JSON.stringify(['ok', 123, null, 'fine']))
  ok('数组里混进非字符串 → 只保留字符串，不整条丢弃',
    JSON.stringify(readSetPref('mixed')) === JSON.stringify(['ok', 'fine']))

  ok('布尔读到脏值 → 用默认值', readBoolPref('broken', true) === true)
}

// ---------- ③ 命名空间 ----------
{
  const src = read('src/lib/uiPrefs.ts')
  ok('🔴 所有键都带 yfe-ui: 前缀（不与项目数据 / 别的偏好混在裸键上）',
    /const PREFIX = 'yfe-ui:'/.test(src)
    && /localStorage\.setItem\(PREFIX \+ key/.test(src)
    && /localStorage\.getItem\(PREFIX \+ key/.test(src))
  const callers = [
    'src/components/Sidebar.tsx',
    'src/components/useTableSheetModel.ts',
    'src/components/AIPromptSettings.tsx',
    'src/components/DraftReviewPanel.tsx',
  ]
  ok('🔴 五处折叠的接入点都 import 了 uiPrefs（只写模块不接线＝白做）',
    callers.every(f => /from '\.\.\/lib\/uiPrefs'/.test(read(f))),
    callers.filter(f => !/from '\.\.\/lib\/uiPrefs'/.test(read(f))).join('、'))
}

// ---------- ④ 🔴 语义约定：存"偏离默认的那一侧" ----------
{
  const sidebar = read('src/components/Sidebar.tsx')
  // 侧栏的默认态是「全部分组展开」，所以必须存"已折叠"的集合。
  // 反过来存"已展开"的话，以后新增分组时老用户的记录里没有它 → 新分组默认是收起的。
  ok('🔴 侧栏存的是「已折叠的分组」（collapsedGroups），不是「已展开的」',
    /usePersistedSet\('sidebar-collapsed-groups'\)/.test(sidebar) && /collapsedGroups\.has\(group\)/.test(sidebar))
  ok('🔴 侧栏首次安装（无记录）＝空集合＝全部分组展开',
    !/usePersistedSet\('sidebar-collapsed-groups',\s*\[/.test(sidebar))
  ok('侧栏「章节总表」下的卷列表也记忆（首次默认展开）',
    /usePersistedBool\('sidebar-volume-open', true\)/.test(sidebar))

  // 表树折叠存的是"已折叠的行 id"，默认空＝全展开
  const sheet = read('src/components/useTableSheetModel.ts')
  ok('🔴 表树折叠**按页签分键**（国家势力的折叠不该影响历史事件）',
    /usePersistedSet\(`table-collapsed:\$\{tab\.id\}`\)/.test(sheet))

  // 提示词条目的默认态是「全部收起」，所以要存"已展开的条目"
  const prompt = read('src/components/AIPromptSettings.tsx')
  ok('🔴 提示词条目存的是「已展开的」（默认全收起，与旧行为一致）',
    /usePersistedSet\('prompt-expanded'\)/.test(prompt) && /!expandedPrompts\.has\(e\.id\)/.test(prompt))

  const draft = read('src/components/DraftReviewPanel.tsx')
  ok('草稿审阅的分组折叠也记忆', /usePersistedSet\('draft-review-collapsed'\)/.test(draft))
}

console.log(`\n—— uiPrefs 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
