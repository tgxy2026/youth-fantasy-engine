// ============ 跑团互动 · 引用世界版本读入（3.0 · W4-3e）============
//
// D4=A：跑团局引用**冻结的某一版**世界。锁两条：
//   ① 渲染：只读冻结版、键值成行、超长**显式标注**截断（不静默）；
//   ② 失效不报错：世界被删 / 版本不存在 → 空串（引用失效不该让整局跑不动）。
import * as db from '../src/lib/db'
import { __resetMockStores } from './mock-memory'
import { renderWorldTables, resolveRunWorldText, DEFAULT_WORLD_TEXT_CAP } from '../src/lib/run/worldContext'
import type { WorldStoredRecord } from '../src/lib/worldTypes'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function world(tables: WorldStoredRecord['tables'], versions: WorldStoredRecord['versions'] = []): WorldStoredRecord {
  return {
    id: 'w1', name: '雾港', origin: { projectId: 'p1', projectName: '书', at: 1 },
    tables, activeSubs: {}, fingerprint: 'fp', versions, createdAt: 1, updatedAt: 1,
  }
}

async function main() {
  __resetMockStores()

  // ---------- 1) 渲染（纯函数） ----------
  {
    const text = renderWorldTables([
      { tabId: 'worldbase', kind: 'form', rows: [{ id: 'worldbase', data: { '世界设定::时代': '架空晚清', '世界设定::潮汐': '每月一次' }, order: 0 }] },
      { tabId: 'nations', kind: 'table', rows: [{ id: 'n1', data: { '国家势力::名称': '雾港议会' }, order: 0 }] },
      { tabId: 'empty', kind: 'table', rows: [] },
    ])
    ok('含表头', text.includes('【worldbase】') && text.includes('【nations】'))
    ok('键值成行', /世界设定::时代=架空晚清/.test(text))
    ok('多字段以；相连', /架空晚清；世界设定::潮汐=每月一次/.test(text))
    ok('空表被跳过', !text.includes('【empty】'))

    const huge = renderWorldTables(
      [{ tabId: 'big', kind: 'table', rows: [{ id: 'r', data: { x: 'y'.repeat(50) }, order: 0 }] }],
      20,
    )
    ok('超长截断', huge.length <= 20 + 40, String(huge.length))
    ok('🔴 截断显式标注（不静默）', /已截断/.test(huge))
    ok('默认上限常量为 4000', DEFAULT_WORLD_TEXT_CAP === 4000)
  }

  // ---------- 2) 读冻结版 ----------
  {
    __resetMockStores()
    await db.saveWorld(world(
      [{ tabId: 'worldbase', kind: 'form', rows: [{ id: 'worldbase', data: { '世界设定::时代': '草稿版' }, order: 0 }] }],
      [
        { v: 1, at: 1, fingerprint: 'f1', note: '', activeSubs: {}, tables: [{ tabId: 'worldbase', kind: 'form', rows: [{ id: 'worldbase', data: { '世界设定::时代': '初版' }, order: 0 }] }] },
        { v: 2, at: 2, fingerprint: 'f2', note: '', activeSubs: {}, tables: [{ tabId: 'worldbase', kind: 'form', rows: [{ id: 'worldbase', data: { '世界设定::时代': '二版' }, order: 0 }] }] },
      ],
    ))

    const v1 = await resolveRunWorldText({ worldId: 'w1', version: 1 })
    ok('🔴 取到 v1 的内容（不是草稿、不是 v2）', /初版/.test(v1) && !/草稿版|二版/.test(v1), v1)
    const v2 = await resolveRunWorldText({ worldId: 'w1', version: 2 })
    ok('取到 v2', /二版/.test(v2))
    const draft = await resolveRunWorldText({ worldId: 'w1', version: 0 })
    ok('version=0 取草稿', /草稿版/.test(draft))

    ok('世界不存在 → 空串（不抛）', (await resolveRunWorldText({ worldId: 'nope', version: 1 })) === '')
    ok('版本不存在 → 空串', (await resolveRunWorldText({ worldId: 'w1', version: 99 })) === '')
    ok('无引用 → 空串', (await resolveRunWorldText(undefined)) === '')
  }

  console.log(`\nrunWorldContext: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
