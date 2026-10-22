// 3.2.1 · T-10 封存版本差异入口 · 单测
//
// 盯四件事：
//   ① 摊平口径（`entriesOfVersion`）必须与 `compareWorldVersions` 内部一致 ——
//      否则两版用了不同的摊平方式，diff 结果就是假的；
//   ② `active` 来自 `activeSubs[tabId]`，无该键时一律 false（抽包时每张表都会写这个键）；
//   ③ 非语义字段（updatedAt / createdAt / projectSource…）**不进指纹**：
//      同一内容重抽一次不该显示成"改过"；
//   ④ 三种差异都要能认出来：改字段 / 删行 / 加行。
import { entriesOfVersion, diffWorldVersions } from '@/lib/world/worldDiff'
import type { WorldPackKind, WorldPackTable, WorldVersion } from '@/lib/world/worldTypes'

let pass = 0, fail = 0
function ok(name: string, cond: unknown, extra = '') {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, '::', extra) }
}

const table = (
  tabId: string,
  kind: WorldPackKind,
  rows: { id: string; name?: string; data: Record<string, string> }[],
): WorldPackTable => ({
  tabId,
  kind,
  rows: rows.map((r, i) => ({ id: r.id, order: i, data: r.data, ...(r.name ? { name: r.name } : {}) })),
})

const ver = (v: number, tables: WorldPackTable[], activeSubs: Record<string, string[]> = {}): WorldVersion => ({
  v, at: 1000 * v, fingerprint: 'fp' + v, tables, activeSubs,
})

const nations = (rows: { id: string; name?: string; data: Record<string, string> }[]) => table('nations', 'card', rows)

function main() {
  // ---------- ① 摊平 ----------
  {
    const v1 = ver(1, [
      nations([{ id: 'r1', name: '云州', data: { '基础::名称': '云州', '基础::类型': '王朝' } }]),
      table('worldbase', 'form', [{ id: 'wb', data: { '总览::时代': '上古' } }]),
    ])
    const entries = entriesOfVersion(v1)
    ok('① 两张表的行都摊平出来了', entries.length === 2, `len=${entries.length}`)
    const cloud = entries.find(e => e.rowId === 'r1')
    ok('① tabId / kind / rowId / name 都对', !!cloud && cloud.tabId === 'nations' && cloud.kind === 'card' && cloud.name === '云州')
    ok('① fields 直接用 row.data', !!cloud && cloud.fields['基础::类型'] === '王朝')
    ok('① contentFingerprint 非空（同一套指纹算法）', !!cloud && cloud.contentFingerprint.length > 0)
  }

  // ---------- ② active ----------
  {
    const withSubs = entriesOfVersion(ver(1,
      [nations([{ id: 'r1', name: 'A', data: { k: '1' } }, { id: 'r2', name: 'B', data: { k: '2' } }])],
      { nations: ['r1'] }))
    ok('② activeSubs 里的行 active=true', withSubs.find(e => e.rowId === 'r1')?.active === true)
    ok('② 没列进 activeSubs 的行 active=false', withSubs.find(e => e.rowId === 'r2')?.active === false)
    const noSubs = entriesOfVersion(ver(1, [nations([{ id: 'r1', name: 'A', data: { k: '1' } }])]))
    ok('② 无 activeSubs 键时默认 false（不假装活跃）', noSubs[0].active === false)
  }

  // ---------- ③ 非语义字段不进指纹 ----------
  {
    const a = entriesOfVersion(ver(1, [nations([{ id: 'r1', name: 'A', data: { '基础::名称': 'A', updatedAt: '1' } }])]))
    const b = entriesOfVersion(ver(2, [nations([{ id: 'r1', name: 'A', data: { '基础::名称': 'A', updatedAt: '999' } }])]))
    ok('③ 只有 updatedAt 不同 ⇒ 指纹相同', a[0].contentFingerprint === b[0].contentFingerprint)
    const d = diffWorldVersions(ver(1, [nations([{ id: 'r1', name: 'A', data: { '基础::名称': 'A', updatedAt: '1' } }])]),
      ver(2, [nations([{ id: 'r1', name: 'A', data: { '基础::名称': 'A', updatedAt: '999' } }])]))
    ok('③ 只有 updatedAt 不同 ⇒ 显示为未变化', d.modifiedCount === 0 && d.unchangedCount === 1, JSON.stringify(d))
  }

  // ---------- ④ 同内容 ----------
  {
    const rows = [{ id: 'r1', name: 'A', data: { k: '1' } }, { id: 'r2', name: 'B', data: { k: '2' } }]
    const d = diffWorldVersions(ver(1, [nations(rows)]), ver(2, [nations(rows)]))
    ok('④ 两版一样 ⇒ 0 变化、全部未变', d.addedCount === 0 && d.removedCount === 0 && d.modifiedCount === 0 && d.unchangedCount === 2)
    ok('④ 版本号以 vN 呈现', d.oldVersionId === 'v1' && d.newVersionId === 'v2', `${d.oldVersionId}→${d.newVersionId}`)
  }

  // ---------- ⑤ 改字段 ----------
  {
    const d = diffWorldVersions(
      ver(1, [nations([{ id: 'r1', name: 'A', data: { '基础::类型': '王朝' } }])]),
      ver(2, [nations([{ id: 'r1', name: 'A', data: { '基础::类型': '联邦' } }])]),
    )
    const e = d.entryDiffs.find(x => x.rowId === 'r1')
    ok('⑤ 改字段 ⇒ modified=1', d.modifiedCount === 1)
    ok('⑤ 字段前后值都带出来', !!e && e.fieldDiffs.some(f => f.fieldName === '基础::类型' && f.oldValue === '王朝' && f.newValue === '联邦'),
      JSON.stringify(e?.fieldDiffs))
  }

  // ---------- ⑥ 删行 / 加行 ----------
  {
    const d = diffWorldVersions(
      ver(1, [nations([{ id: 'r1', name: 'A', data: { k: '1' } }, { id: 'r2', name: 'B', data: { k: '2' } }])]),
      ver(2, [nations([{ id: 'r1', name: 'A', data: { k: '1' } }, { id: 'r3', name: 'C', data: { k: '3' } }])]),
    )
    ok('⑥ 删了一行 ⇒ removed=1', d.removedCount === 1)
    ok('⑥ 加了一行 ⇒ added=1', d.addedCount === 1)
    ok('⑥ 留下的那行算未变', d.unchangedCount === 1)
  }

  // ---------- ⑦ 活跃状态变化 ----------
  {
    const d = diffWorldVersions(
      ver(1, [nations([{ id: 'r1', name: 'A', data: { k: '1' } }])], { nations: ['r1'] }),
      ver(2, [nations([{ id: 'r1', name: 'A', data: { k: '1' } }])], { nations: [] }),
    )
    const e = d.entryDiffs.find(x => x.rowId === 'r1')
    ok('⑦ 活跃状态变了也算法变化', d.modifiedCount === 1 && !!e?.activeChanged, JSON.stringify(e))
    ok('⑦ 前后活跃状态都记下来', e?.oldActive === true && e?.newActive === false)
  }

  // ---------- ⑧ 指纹相同但改名：现行口径如实记录 ----------
  {
    const d = diffWorldVersions(
      ver(1, [nations([{ id: 'r1', name: '旧名', data: { k: '1' } }])]),
      ver(2, [nations([{ id: 'r1', name: '新名', data: { k: '1' } }])]),
    )
    ok('⑧ 只改卡片名 ⇒ 指纹不含 name，判为未变化（已知口径，不是 bug）',
      d.modifiedCount === 0 && d.unchangedCount === 1, JSON.stringify(d))
  }

  console.log(`\n———— worldVersionDiff：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

void main()
