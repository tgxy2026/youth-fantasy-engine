// ============ 便携版存储后端（fileBackend）核心逻辑 ============
//
// 🔴 为什么补这份（2026-10-11 审计）：
//    `src/lib/db/core.ts:81` 的注释写着「实测口径见 tests/portableBackend.test.ts」，
//    但这份文件**根本不存在** —— 注释指向一个不存在的护栏，是最危险的一类自述失实：
//    后来者以为有测试守着，实际 `fileBackend.ts` 的核心纯逻辑（`upsertRows` / `deleteRowsOf` /
//    `keyOfRecord` / `PORTABLE_KEY_FIELDS`）零覆盖。
//
// 这里钉四件事：
//   ① `PORTABLE_KEY_FIELDS` 与桌面版 `KEY_PATHS` / 同步层 `KEY_FIELD` **逐项一致**
//      （便携版多出的三项是它的专属表，桌面侧不该有）；
//   ② `keyOfRecord` 对「主键非 id」的表（`formData.tabId` / `meta.key`）取对键；
//   ③ `upsertRows` 的 upsert 语义（同主键替换、否则追加、主键缺失跳过、不改入参）；
//   ④ `deleteRowsOf` 按主键删除（数字键与字符串键互通）。
//
// 与 `tests/portableVecKb.test.ts` 分工：那份验「两库并入整库」的编解码与后端方法，
// 这份验**整库本身的行操作** —— 是所有 store 共用的地基。
//
// ⚠️ 只读 import：`fileBackend` 的 `PORTABLE` 在 Node 下恒为 false（无 window 注入），
//    这里的四个导出都是**纯函数**，不碰网络、不碰 window，可直接测。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  PORTABLE_KEY_FIELDS, keyOfRecord, upsertRows, deleteRowsOf, filterByIndex,
} from '../src/lib/storage/fileBackend'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
function read(rel: string): string {
  try { return readFileSync(path.join(process.cwd(), rel), 'utf8') } catch { return '' }
}

console.log('\n—— portableBackend 用例开始 ——')

// 便携版专属的三张表（桌面版不存在，因为那两库在桌面端是独立 IDB、刻意不入整库）
const PORTABLE_ONLY = ['vecRows', 'kbDocs', 'kbBodies']

/** 从源码文本里抠出一份 `Record<string,string>` 字面量（够用的朴素解析：只认 `name: 'value'` 对） */
function parseKeyMap(src: string, decl: string): Record<string, string> {
  const at = src.indexOf(decl)
  if (at < 0) return {}
  const start = src.indexOf('{', at)
  if (start < 0) return {}
  let depth = 0, end = start
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  const body = src.slice(start + 1, end)
  const out: Record<string, string> = {}
  // 只匹配 name: 'v'（本仓四份主键表都是这个形状，值一律是带引号的字段名）
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g)) out[m[1]] = m[2]
  return out
}

// ---------- ① 三份主键表一致性（防漂移的守卫） ----------
//
// 仓库里现有**四份**主键表：
//   · src/lib/app/desktop.ts        KEY_PATHS          （桌面版落盘）
//   · src/lib/sync/syncCore.ts      KEY_FIELD          （云同步）
//   · src/lib/storage/fileBackend.ts PORTABLE_KEY_FIELDS（便携版落盘）
//   · tests/mock-memory.ts          KEY_PATHS          （测试桩）
// 前两份的注释都明写「增删 store 键时两处都要改」，但**一直没有任何测试钉住**（desktop.ts:309
// 自己承认）。`?? 'id'` 兜底让漂移**静默** —— 直到某个主键不是 id 的新表出现才炸（历史上
// `formData: 'tabId'` 就在测试桩里漏过，导致表单测试全在空跑）。这里把四份一次性钉住。
{
  const desktopSrc = read('src/lib/app/desktop.ts')
  const syncSrc = read('src/lib/sync/syncCore.ts')
  const mockSrc = read('tests/mock-memory.ts')

  const desk = parseKeyMap(desktopSrc, 'export const KEY_PATHS')
  const sync = parseKeyMap(syncSrc, 'export const KEY_FIELD')
  const mock = parseKeyMap(mockSrc, 'export const KEY_PATHS')

  ok('① 解析到 desktop.KEY_PATHS（≥10 项）', Object.keys(desk).length >= 10, String(Object.keys(desk).length))
  ok('① 解析到 syncCore.KEY_FIELD（≥10 项）', Object.keys(sync).length >= 10, String(Object.keys(sync).length))
  ok('① 解析到 mock-memory.KEY_PATHS（≥10 项）', Object.keys(mock).length >= 10, String(Object.keys(mock).length))

  // 便携表 = 桌面表 ∪ 三项专属
  const portableBase = { ...PORTABLE_KEY_FIELDS }
  for (const k of PORTABLE_ONLY) delete portableBase[k]

  const missingInPortable = Object.keys(desk).filter(k => !(k in portableBase))
  ok('① 便携表覆盖桌面表全部项', missingInPortable.length === 0, missingInPortable.join(','))

  const diffValue = Object.keys(desk).filter(k => desk[k] !== portableBase[k])
  ok('① 与 desktop.KEY_PATHS 取值逐项一致', diffValue.length === 0,
    diffValue.map(k => `${k}: ${desk[k]} vs ${portableBase[k]}`).join(' | '))

  const missingInSync = Object.keys(sync).filter(k => !(k in portableBase))
  ok('① 便携表覆盖 syncCore.KEY_FIELD 全部项', missingInSync.length === 0, missingInSync.join(','))

  const diffSync = Object.keys(sync).filter(k => sync[k] !== portableBase[k])
  ok('① 与 syncCore.KEY_FIELD 取值逐项一致', diffSync.length === 0,
    diffSync.map(k => `${k}: ${sync[k]} vs ${portableBase[k]}`).join(' | '))

  // 反向：便携专属三项不该出现在桌面 / 同步层（它们不是主库的表）
  const leak = PORTABLE_ONLY.filter(k => k in desk || k in sync)
  ok('① 便携专属三表未泄漏进桌面/同步层', leak.length === 0, leak.join(','))

  // 测试桩也不许漏（它模拟的是桌面 store）
  const mockMissing = Object.keys(desk).filter(k => !(k in mock))
  ok('① 测试桩 KEY_PATHS 覆盖 desktop 全部项', mockMissing.length === 0, mockMissing.join(','))
}

// ---------- ② keyOfRecord：主键非 id 的表必须取对 ----------
{
  ok('② formData 取 tabId', keyOfRecord('formData', { id: 'x', tabId: 'tab-9' }) === 'tab-9',
    keyOfRecord('formData', { id: 'x', tabId: 'tab-9' }))
  ok('② meta 取 key', keyOfRecord('meta', { id: 'x', key: 'k-1' }) === 'k-1')
  ok('② settingsKV 取 key', keyOfRecord('settingsKV', { key: 'sk-2' }) === 'sk-2')
  ok('② chapters 取 id', keyOfRecord('chapters', { id: 'c-3' }) === 'c-3')
  ok('② 未知 store 兜底取 id', keyOfRecord('someNewStore', { id: 'n-1' }) === 'n-1')
  ok('② 主键缺失 ⇒ 空串（调用方据此前跳过）', keyOfRecord('chapters', { name: '无主键' }) === '')
  ok('② null / undefined ⇒ 空串', keyOfRecord('chapters', null) === '' && keyOfRecord('chapters', undefined) === '')
  ok('② 数字主键字符串化', keyOfRecord('chapters', { id: 42 }) === '42')
}

// ---------- ③ upsertRows：upsert 语义 ----------
//
// `upsertRows` / `deleteRowsOf` 的签名是 `unknown[]`（它们要服务所有 store，不能绑定具体行类型），
// 故用例里统一走这个收窄助手 —— 别在各处散写 `as`（散写会让「到底断言了什么」看不清）。
type TestRow = { id?: string; tabId?: string; v?: number }
const asRows = (x: unknown[]): TestRow[] => x as TestRow[]

{
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]
  const out = asRows(upsertRows('chapters', base, [{ id: 'b', v: 99 }, { id: 'c', v: 3 }]))
  ok('③ 同主键替换', out.length === 3 && out[1].v === 99, JSON.stringify(out))
  ok('③ 新主键追加', out[2].id === 'c' && out[2].v === 3)
  ok('③ 不改入参数组', base.length === 2 && base[1].v === 2, JSON.stringify(base))

  // 主键缺失一律跳过：写进去无法定位，只会污染数据
  const out2 = asRows(upsertRows('chapters', base, [{ v: 777 }]))
  ok('③ 主键缺失的记录被跳过', out2.length === 2, JSON.stringify(out2))

  // 主键非 id 的表
  const forms = [{ tabId: 't1', v: 1 }]
  const out3 = asRows(upsertRows('formData', forms, [{ tabId: 't1', v: 5 }, { tabId: 't2', v: 6 }]))
  ok('③ formData 按 tabId upsert', out3.length === 2 && out3[0].v === 5, JSON.stringify(out3))

  const out4 = asRows(upsertRows('chapters', [], [{ id: 'x', v: 1 }]))
  ok('③ 空基础表可追加', out4.length === 1)
}

// ---------- ④ deleteRowsOf：按主键删 ----------
{
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const out = deleteRowsOf('chapters', rows, ['b'])
  ok('④ 删掉指定主键', out.length === 2 && !out.some(r => (r as { id: string }).id === 'b'), JSON.stringify(out))
  ok('④ 不改入参', rows.length === 3)

  // 数字键与字符串键互通（调用方可能传 number 或 string）
  const rows2 = [{ id: 1 }, { id: 2 }]
  const out2 = deleteRowsOf('chapters', rows2, [1])
  ok('④ 数字主键可删（键统一字符串化）', out2.length === 1 && (out2[0] as { id: number }).id === 2, JSON.stringify(out2))

  const out3 = deleteRowsOf('chapters', rows, [])
  ok('④ 空键列表 ⇒ 原样返回', out3.length === 3)

  // 主键非 id 的表
  const forms = [{ tabId: 't1' }, { tabId: 't2' }]
  const out4 = deleteRowsOf('formData', forms, ['t1'])
  ok('④ formData 按 tabId 删', out4.length === 1 && (out4[0] as { tabId: string }).tabId === 't2')
}

// ---------- ⑤ filterByIndex（文件型后端退化为全量过滤） ----------
{
  const rows = [{ projectId: 'p1', n: 1 }, { projectId: 'p2', n: 2 }, { projectId: 'p1', n: 3 }]
  const hit = filterByIndex(rows, 'projectId', 'p1')
  ok('⑤ 按索引字段过滤', hit.length === 2 && hit[0].n === 1 && hit[1].n === 3, JSON.stringify(hit))
  ok('⑤ 无匹配 ⇒ 空数组', filterByIndex(rows, 'projectId', 'p9').length === 0)
  ok('⑤ 缺该字段的记录不匹配', filterByIndex([{ n: 1 }] as { projectId?: string; n: number }[], 'projectId', 'p1').length === 0)
}

// ---------- ⑥ 源码自述一致性：注释提到的测试文件必须真实存在 ----------
{
  // `core.ts:81` 曾指向一个不存在的 tests/portableBackend.test.ts —— 由本文件补上后应存在
  const self = read('tests/portableBackend.test.ts')
  ok('⑥ 本文件存在（core.ts:81 注释的指向成立）', self.length > 0)

  const core = read('src/lib/db/core.ts')
  const refs = [...core.matchAll(/tests\/([A-Za-z0-9_.-]+\.test\.ts)/g)].map(m => m[1])
  const broken = refs.filter(f => read(`tests/${f}`).length === 0)
  ok('⑥ core.ts 引用的测试文件均真实存在', broken.length === 0, broken.join(','))
}

console.log(`\n—— portableBackend 用例结束：${pass} 通过 / ${fail} 失败 ——`)
if (fail > 0) process.exit(1)
