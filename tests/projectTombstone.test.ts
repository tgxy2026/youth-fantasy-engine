// 3.3.2 · P4-2 项目级墓碑 · 单测
//
// 盯五件事：
//   ① 同一条记录只留一条墓碑（否则清单会被重复 id 撑大，服务端还可能判成脏数据）；
//   ② 时间取**最早**那次（第一次删的时刻才是真的，后来的只是重复点击）；
//   ③ 提交后只清"已上报"的那部分（提交期间又删的必须留下，否则那条删除永远传不出去）；
//   ④ 过期墓碑不带（协议 30 天），但 at=0 的老数据要当新鲜（宁可多带也不让删除失效）；
//   ⑤ 输出顺序确定（快照要求可复现，否则同一份内容每次哈希都不同）。
import {
  mergeTombstones, liveTombstones, noteDeletes, clearSubmittedTombstones,
  tombstonesToSubmit, createMemoryTombstoneStore, tombstoneKey, TOMBSTONE_TTL_MS, TOMBSTONE_MAX,
  type Tombstone,
} from '@/lib/sync/projectTombstone'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const T0 = 1_700_000_000_000
const T = (kind: string, id: string, deletedAt = T0): Tombstone => ({ kind, id, deletedAt })

async function main() {
  // ---------- 1. 去重与最早时间 ----------
  {
    const merged = mergeTombstones([T('chapters', 'c1', T0 + 100)], [T('chapters', 'c1', T0)])
    ok('同一条只留一条墓碑', merged.length === 1, String(merged.length))
    ok('时间取最早那次删除', merged[0].deletedAt === T0, String(merged[0].deletedAt))
  }

  // ---------- 2. 不同 kind 的同一个 id 不冲突 ----------
  {
    const merged = mergeTombstones([T('chapters', 'x1')], [T('cardRecords', 'x1')])
    ok('不同 kind 同 id 各留一条', merged.length === 2, JSON.stringify(merged))
  }

  // ---------- 3. 非法输入被丢掉 ----------
  {
    const merged = mergeTombstones([], [
      { kind: '', id: 'a', deletedAt: T0 },
      { kind: 'chapters', id: '', deletedAt: T0 },
      null as unknown as Tombstone,
    ])
    ok('空 kind / 空 id / null 都被丢掉', merged.length === 0, JSON.stringify(merged))
  }

  // ---------- 4. 输出顺序确定 ----------
  {
    const a = mergeTombstones([], [T('chapters', 'b', T0), T('chapters', 'a', T0)])
    const b = mergeTombstones([], [T('chapters', 'a', T0), T('chapters', 'b', T0)])
    ok('输入顺序不同、输出相同（哈希可复现）', JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a))
  }

  // ---------- 5. TTL ----------
  {
    const list = [T('chapters', 'old', T0 - TOMBSTONE_TTL_MS - 1), T('chapters', 'new', T0)]
    const live = liveTombstones(list, T0)
    ok('过期墓碑被过滤', live.length === 1 && live[0].id === 'new', JSON.stringify(live))
    ok('at=0 的老数据当新鲜（不让删除失效）',
      liveTombstones([T('chapters', 'zero', 0)], T0).length === 1)
  }

  // ---------- 6. 上限截断（保留最新的） ----------
  {
    const many: Tombstone[] = Array.from({ length: 5 }, (_, i) => T('chapters', `c${i}`, T0 + i))
    const capped = mergeTombstones([], many, 3)
    ok('超上限时保留最新的几条', capped.length === 3 && capped[2].id === 'c4', JSON.stringify(capped.map((x) => x.id)))
  }

  // ---------- 7. 累积删除 ----------
  {
    const store = createMemoryTombstoneStore()
    await noteDeletes(store, 'p1', [{ kind: 'chapters', id: 'c1' }], T0)
    await noteDeletes(store, 'p1', [{ kind: 'chapters', id: 'c2' }], T0 + 10)
    const list = await store.list('p1')
    ok('多次删除累积成多条', list.length === 2, JSON.stringify(list))
    ok('项目之间互不影响', (await store.list('p2')).length === 0)
  }

  // ---------- 8. 重复删除同一条不重复记 ----------
  {
    const store = createMemoryTombstoneStore()
    await noteDeletes(store, 'p1', [{ kind: 'chapters', id: 'c1' }], T0)
    const n = await noteDeletes(store, 'p1', [{ kind: 'chapters', id: 'c1' }], T0 + 100)
    ok('重复删同一条只保留一条且时间不变', n === 1 && (await store.list('p1'))[0].deletedAt === T0, String(n))
  }

  // ---------- 9. 提交后只清已上报的 ----------
  {
    const store = createMemoryTombstoneStore()
    await noteDeletes(store, 'p1', [{ kind: 'chapters', id: 'c1' }], T0)
    await noteDeletes(store, 'p1', [{ kind: 'chapters', id: 'c2' }], T0 + 500)   // 提交期间删的
    const cleared = await clearSubmittedTombstones(store, 'p1', T0 + 100, T0 + 600)
    const rest = await store.list('p1')
    // 🔴 关键：c2 是提交开始之后才删的，这次提交没带上它，必须留下
    ok('只清掉本次提交带走的', cleared === 1 && rest.length === 1 && rest[0].id === 'c2', JSON.stringify(rest))
  }

  // ---------- 10. 提交前取墓碑 ----------
  {
    const store = createMemoryTombstoneStore({
      p1: [T('chapters', 'live', T0), T('chapters', 'dead', T0 - TOMBSTONE_TTL_MS - 1)],
    })
    const out = await tombstonesToSubmit(store, 'p1', T0)
    ok('只提交未过期的', out.length === 1 && out[0].id === 'live', JSON.stringify(out))
  }

  // ---------- 11. 身份键 ----------
  ok('身份键区分 kind', tombstoneKey({ kind: 'a', id: 'x' }) !== tombstoneKey({ kind: 'b', id: 'x' }))
  ok('上限常量是正数', TOMBSTONE_MAX > 1000)

  // ---------- 12. 空删除不写盘 ----------
  {
    const store = createMemoryTombstoneStore()
    const n = await noteDeletes(store, 'p1', [], T0)
    ok('没有删除项时不产生记录', n === 0 && (await store.list('p1')).length === 0, String(n))
    const n2 = await noteDeletes(store, 'p1', [{ kind: 'chapters', id: '' }], T0)
    ok('id 为空的项不产生记录（避免造出无效墓碑）', n2 === 0)
  }

  console.log(`\n▶ projectTombstone: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
