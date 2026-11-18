// ============ 三路合并规则契约闸（3.6.0 · 零覆盖长期债）============
//
// syncMerge.ts 是同步链路里唯一的纯逻辑（不碰传输 / 加密 / 调度），此前**零测试覆盖**，
// 而它承担四条「删了会复活」的防护 —— 任何一条被改坏，表现都是"删掉的东西自己回来"，
// 且只在本机与云端时间窗对不齐时复现，人工验收极难触发。这里逐条钉住：
//   ① 空本地 + 云端有 ⇒ 采用云端（localHasContent 闸，防新设备首同步整片丢数据）
//   ② 本地有内容 + 本地删过（墓碑）+ 云端未改 ⇒ 不复活
//   ③ 本地删过但云端改过 ⇒ 不复活，但记冲突（作者还能从冲突面板捞回来）
//   ④ 云端删过、本地文件陈旧留着旧记录 ⇒ 不复活（云模式冻结快照那条路径）
//   ⑤ 两端逐字一致但墓碑在 ⇒ 尊重删除（最容易被当成"不需要判"的一支）
//   ⑥ 只有云端改 / 只有本地改 ⇒ 各自采用，不产生冲突
//   ⑦ 两端都改 ⇒ 本地优先 + 云端那版交冲突回调
//   ⑧ 本地专属 store ⇒ 一律以本机为准
//   ⑨ sameStores 必须走主键表（formData 主键是 tabId，手写 id ?? key 会恒判不一致）
//   ⑩ 冲突回调抛错不得影响合并
import type { SyncRow, SyncStores } from '../src/lib/sync/syncCore'

// 最小 localStorage 桩：墓碑落在这里，必须在调用前装好
const store = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
}

const { mergeCaches, sameStores, snapshotOf, eqRecord } = await import('../src/lib/sync/syncMerge')
const { markDeleted, resetTombs } = await import('../src/lib/sync/syncTombstone')

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

type Conflict = { store: string; key: unknown; local: unknown; server: unknown }
const mkCtx = (over: Partial<{ keyField: Record<string, string>; isLocalOnly: (s: string) => boolean; onConflict: (c: Conflict) => void }> = {}) => {
  const conflicts: Conflict[] = []
  const ctx = {
    keyField: over.keyField ?? {},
    isLocalOnly: over.isLocalOnly ?? (() => false),
    onConflict: over.onConflict ?? ((c: Conflict) => { conflicts.push(c) }),
  }
  return { ctx, conflicts }
}
const row = (id: string, v = 1): SyncRow => ({ id, v })
const projects = (...rows: SyncRow[]): SyncStores => ({ projects: rows })

function fresh() { resetTombs(); store.clear() }

// ---------- ① 空本地 + 云端有 ----------
{
  fresh()
  markDeleted('projects', ['p1'])
  const { ctx } = mkCtx()
  const out = mergeCaches({}, projects(row('p1')), {}, ctx)
  ok('🔴 ① 本地空库（新设备/刚启动）即使有墓碑也采用云端 —— 否则整片丢数据',
    out.projects?.length === 1 && out.projects[0].id === 'p1', JSON.stringify(out))
}

// ---------- ② 本地有内容 + 删过 + 云端未改 ----------
{
  fresh()
  markDeleted('projects', ['p1'])
  const { ctx } = mkCtx()
  const base = projects(row('p1'), row('p2'))
  const server = projects(row('p1'), row('p2'))
  const local = projects(row('p2'))
  const out = mergeCaches(base, server, local, ctx)
  ok('🔴 ② 本机删过、云端未改 ⇒ 尊重删除（幽灵项目那条路径）',
    !out.projects?.some(r => r.id === 'p1'), JSON.stringify(out))
}

// ---------- ③ 删过但云端改过 ----------
{
  fresh()
  markDeleted('projects', ['p1'])
  const { ctx, conflicts } = mkCtx()
  const base = projects(row('p1', 1), row('p2'))
  const server = projects(row('p1', 2), row('p2'))
  const local = projects(row('p2'))
  const out = mergeCaches(base, server, local, ctx)
  ok('🔴 ③ 本机删过但云端改过 ⇒ 仍不采用云端', !out.projects?.some(r => r.id === 'p1'))
  ok('③ 但把云端那版记进冲突（作者能从冲突面板捞回来）',
    conflicts.length === 1 && conflicts[0].store === 'projects' && (conflicts[0].local === null || conflicts[0].local === undefined),
    JSON.stringify(conflicts))
}

// ---------- ④ 云端删过、本地陈旧文件还留着 ----------
{
  fresh()
  markDeleted('projects', ['p1'])
  const { ctx } = mkCtx()
  const local = projects(row('p1'))       // 冻结快照里还有它
  const out = mergeCaches({}, {}, local, ctx)
  ok('🔴 ④ 云端已删、本地文件陈旧 + 墓碑 ⇒ 不复活（删除不被撤销回推）',
    !out.projects?.some(r => r.id === 'p1'), JSON.stringify(out))
}

// ---------- ⑤ 两端一致 + 墓碑 ----------
{
  fresh()
  markDeleted('projects', ['p1'])
  const { ctx } = mkCtx()
  const same = projects(row('p1'))
  const out = mergeCaches(same, same, same, ctx)
  ok('🔴 ⑤ 两端逐字一致但墓碑在 ⇒ 尊重删除（第四条复活路径）',
    !out.projects?.some(r => r.id === 'p1'), JSON.stringify(out))
}

// ---------- ⑥ 单边改动 ----------
{
  fresh()
  const { ctx, conflicts } = mkCtx()
  const base = projects(row('p1', 1), row('p2', 1))
  const server = projects(row('p1', 2), row('p2', 1))   // 云端改了 p1
  const local = projects(row('p1', 1), row('p2', 9))    // 本地改了 p2
  const out = mergeCaches(base, server, local, ctx)
  const byId = new Map(out.projects?.map(r => [r.id, r.v]))
  ok('⑥ 只有云端改 ⇒ 采用云端', byId.get('p1') === 2)
  ok('⑥ 只有本地改 ⇒ 保留本地', byId.get('p2') === 9)
  ok('⑥ 单边改动不产生冲突', conflicts.length === 0, JSON.stringify(conflicts))
}

// ---------- ⑦ 两端都改 ----------
{
  fresh()
  const { ctx, conflicts } = mkCtx()
  const base = projects(row('p1', 1))
  const server = projects(row('p1', 2))
  const local = projects(row('p1', 3))
  const out = mergeCaches(base, server, local, ctx)
  ok('⑦ 两端都改 ⇒ 本地优先', out.projects?.[0]?.v === 3)
  ok('⑦ 云端那版进冲突回调（供另存副本）',
    conflicts.length === 1
    && (conflicts[0].local as SyncRow)?.v === 3 && (conflicts[0].server as SyncRow)?.v === 2,
    JSON.stringify(conflicts))
}

// ---------- ⑧ 本地专属 store ----------
{
  fresh()
  const { ctx } = mkCtx({ isLocalOnly: s => s === 'backups' })
  const base = { backups: [{ id: 'b1' }] }
  const server = { backups: [{ id: 'b1' }, { id: 'b2' }] }
  const local = { backups: [{ id: 'b1' }] }
  const out = mergeCaches(base, server, local, ctx)
  ok('⑧ 本地专属 store（备份）一律以本机为准，不采用云端新增',
    out.backups?.length === 1 && out.backups[0].id === 'b1', JSON.stringify(out))
}

// ---------- ⑨ sameStores 必须走主键表 ----------
{
  // formData 的主键是 tabId：既没有 id 也没有 key。手写 id ?? key 时两条都会变成 undefined，
  // Map 里互相覆盖 ⇒ 恒判「不一致」⇒ 同步乒乓。这条断言防的就是那个 P1 回归。
  const a = { formData: [{ tabId: 't1', x: 1 }, { tabId: 't2', x: 2 }] }
  const b = { formData: [{ tabId: 't1', x: 1 }, { tabId: 't2', x: 2 }] }
  ok('🔴 ⑨ formData 走 tabId 主键 ⇒ 内容相同判一致（旧写法恒 false 会导致同步乒乓）',
    sameStores(a, b, { formData: 'tabId' }) === true)
  const c = { formData: [{ tabId: 't1', x: 1 }, { tabId: 't2', x: 3 }] }
  ok('⑨ 内容真不同才判不一致', sameStores(a, c, { formData: 'tabId' }) === false)
  ok('🔴 ⑨ 键序不同但内容相同 ⇒ 判相等（原先 JSON.stringify 会判"变了"，导致假冲突与反复推送）',
    sameStores({ s: [{ id: 'a', x: 1, y: 2 }, { id: 'b' }] }, { s: [{ id: 'b' }, { id: 'a', y: 2, x: 1 }] }, { s: 'id' }) === true)
}

// ---------- ⑩ 冲突回调抛错不影响合并 ----------
{
  fresh()
  const { ctx } = mkCtx({ onConflict: () => { throw new Error('面板炸了') } })
  const base = projects(row('p1', 1))
  const out = mergeCaches(base, projects(row('p1', 2)), projects(row('p1', 3)), ctx)
  ok('⑩ 冲突回调抛错时合并照常完成（本地优先）', out.projects?.[0]?.v === 3)
}

// ---------- ⑪ 快照与相等判定 ----------
{
  const src = { s: [{ id: 'a' }] }
  const snap = snapshotOf(src)
  snap.s.push({ id: 'b' })
  ok('⑪ snapshotOf 是数组浅拷贝：改快照不污染原快照', src.s.length === 1)
  ok('⑪ eqRecord：同值 / 异值 / null', eqRecord({ a: 1 }, { a: 1 }) && !eqRecord({ a: 1 }, { a: 2 }) && !eqRecord(null, { a: 1 }))
}

console.log(`\n———— syncMerge：${pass} 通过 / ${fail} 失败 ————`)
if (fail) process.exit(1)
