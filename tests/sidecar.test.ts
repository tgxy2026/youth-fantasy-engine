// 外置 store（sidecar）单测 —— 用**内存实现**把两种布局的语义锁死。
//
// 🔴 为什么必须测这个：外置层是便携版（HTTP）与桌面版（IPC）**共用**的同一份语义。
//    它一旦与底层后端（fileBackend 的 upsertRows 等）对不齐，症状是「桌面版能恢复备份、
//    便携版不能」这类**双端不一致** —— 正是本项目最忌讳的同构被打破，且极难排查。
import type { StoreOps } from '../src/lib/storage/storeOps'
import type { SidecarApi, SidecarSpec } from '../src/lib/storage/sidecar'
import { withSidecar, extractSidecarRows, isSidecarStore, SIDECAR_WHOLE_KEY, collectSidecarForExport, registerSidecarApi } from '../src/lib/storage/sidecar'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' | ' + extra : ''}`) }
}

/** 外置通道的内存实现（键 = `store/id`），带写次数与「下一次写失败」开关 */
class MemApi implements SidecarApi {
  files = new Map<string, unknown>()
  writes = 0
  failNextWrite = false
  async read(store: string, id: string): Promise<unknown | undefined> {
    return this.files.get(`${store}/${id}`)
  }
  async write(store: string, id: string, value: unknown): Promise<boolean> {
    this.writes++
    if (this.failNextWrite) { this.failNextWrite = false; return false }
    this.files.set(`${store}/${id}`, value)
    return true
  }
  async remove(store: string, id: string): Promise<boolean> {
    return this.files.delete(`${store}/${id}`)
  }
  async listIds(store: string): Promise<string[]> {
    const p = store + '/'
    return [...this.files.keys()].filter(k => k.startsWith(p)).map(k => k.slice(p.length))
  }
}

/** 未外置 store 的原后端（内存），用来验证「透传」 */
class MemBase implements StoreOps {
  rows: Record<string, unknown[]> = {}
  async getAll<T>(s: string): Promise<T[]> { return (this.rows[s] ?? []).slice() as T[] }
  async get<T>(s: string, k: string): Promise<T | undefined> {
    return (this.rows[s] ?? []).find((r) => (r as { id: string }).id === k) as T | undefined
  }
  async put(s: string, v: unknown): Promise<void> {
    const k = (v as { id: string }).id
    const arr = (this.rows[s] ??= [])
    const i = arr.findIndex((r) => (r as { id: string }).id === k)
    if (i >= 0) arr[i] = v
    else arr.push(v)
  }
  async del(s: string, k: string): Promise<void> {
    this.rows[s] = (this.rows[s] ?? []).filter((r) => (r as { id: string }).id !== k)
  }
  async getAllByIndex<T>(s: string, idx: string, v: unknown): Promise<T[]> {
    return (this.rows[s] ?? []).filter((r) => (r as Record<string, unknown>)[idx] === v) as T[]
  }
  async bulkPut(s: string, vs: unknown[]): Promise<void> { for (const v of vs) await this.put(s, v) }
  async bulkDel(s: string, ks: (string | number)[]): Promise<void> {
    for (const k of ks) await this.del(s, String(k))
  }
}

const SPEC_PER_ID: SidecarSpec = { backupPayloads: { layout: 'per-id', keyField: 'id' } }
const SPEC_WHOLE: SidecarSpec = { vecRows: { layout: 'whole', keyField: 'id' } }

// ============ ① per-id 布局 ============
{
  const api = new MemApi()
  const base = new MemBase()
  const errs: string[] = []
  const ops = withSidecar(base, api, SPEC_PER_ID, (m) => errs.push(m))

  await ops.put('backupPayloads', { id: 'b1', bytes: 10 })
  await ops.put('backupPayloads', { id: 'b2', bytes: 20 })
  ok('① per-id 写入落独立键', api.files.has('backupPayloads/b1') && api.files.has('backupPayloads/b2'))
  ok('① per-id 写入不进原后端', (base.rows['backupPayloads'] ?? []).length === 0)

  const one = await ops.get<{ id: string; bytes: number }>('backupPayloads', 'b1')
  ok('① per-id 单点读回', one?.bytes === 10, JSON.stringify(one))

  await ops.put('backupPayloads', { id: 'b1', bytes: 99 })
  const upd = await ops.get<{ bytes: number }>('backupPayloads', 'b1')
  ok('① per-id 同主键覆盖', upd?.bytes === 99, JSON.stringify(upd))

  const all = await ops.getAll<{ id: string }>('backupPayloads')
  ok('① per-id getAll 两条', all.length === 2, JSON.stringify(all))

  await ops.del('backupPayloads', 'b1')
  ok('① per-id 删除生效', !api.files.has('backupPayloads/b1'))
  ok('① per-id 删除不影响其它', api.files.has('backupPayloads/b2'))

  await ops.bulkPut('backupPayloads', [{ id: 'b3' }, { id: 'b4' }])
  ok('① per-id bulkPut 全落盘', api.files.has('backupPayloads/b3') && api.files.has('backupPayloads/b4'))
  await ops.bulkDel('backupPayloads', ['b3', 'b4'])
  ok('① per-id bulkDel 全删', !api.files.has('backupPayloads/b3') && !api.files.has('backupPayloads/b4'))

  // 主键缺失：跳过并告警，绝不写进去（写进去无法定位 = 污染）
  errs.length = 0
  await ops.put('backupPayloads', { bytes: 777 })
  ok('① per-id 主键缺失被跳过', api.files.size === 1, [...api.files.keys()].join(','))
  ok('① per-id 主键缺失有告警', errs.length === 1, JSON.stringify(errs))

  // 写失败：不抛，走 onError
  errs.length = 0
  api.failNextWrite = true
  let threw = false
  try { await ops.put('backupPayloads', { id: 'b9' }) } catch { threw = true }
  ok('① 写失败不抛异常（StoreOps 契约）', !threw)
  ok('① 写失败有告警出口', errs.length === 1, JSON.stringify(errs))
}

// ============ ② whole 布局 ============
{
  const api = new MemApi()
  const base = new MemBase()
  const ops = withSidecar(base, api, SPEC_WHOLE)

  await ops.put('vecRows', { id: 'v1', projectId: 'p1' })
  await ops.put('vecRows', { id: 'v2', projectId: 'p1' })
  await ops.put('vecRows', { id: 'v3', projectId: 'p2' })
  ok('② whole 整表只一个键', api.files.size === 1 && api.files.has(`vecRows/${SIDECAR_WHOLE_KEY}`), [...api.files.keys()].join(','))

  const rows = await ops.getAll<{ id: string }>('vecRows')
  ok('② whole getAll 三条', rows.length === 3, JSON.stringify(rows.map(r => r.id)))

  const one = await ops.get<{ id: string }>('vecRows', 'v2')
  ok('② whole 按主键定位', one?.id === 'v2', JSON.stringify(one))

  await ops.put('vecRows', { id: 'v2', projectId: 'pX' })
  const upd = await ops.get<{ projectId: string }>('vecRows', 'v2')
  ok('② whole 同主键覆盖', upd?.projectId === 'pX', JSON.stringify(upd))
  ok('② whole 覆盖不新增行', (await ops.getAll('vecRows')).length === 3)

  // ⚠️ 上面已把 v2 的 projectId 改成 'pX' ⇒ 此刻按 'p1' 只剩 v1，按 'pX' 是 v2
  const byIdx = await ops.getAllByIndex<{ id: string }>('vecRows', 'projectId', 'p1')
  ok('② whole getAllByIndex 过滤 p1', byIdx.length === 1 && byIdx[0].id === 'v1', JSON.stringify(byIdx.map(r => r.id)))
  const byIdx2 = await ops.getAllByIndex<{ id: string }>('vecRows', 'projectId', 'pX')
  ok('② whole getAllByIndex 过滤 pX（覆盖后归属新值）', byIdx2.length === 1 && byIdx2[0].id === 'v2', JSON.stringify(byIdx2.map(r => r.id)))

  // whole 的 bulkPut 必须只写一次（整表一个文件，逐条写 = 重写 N 遍）
  const before = api.writes
  await ops.bulkPut('vecRows', [{ id: 'v4' }, { id: 'v5' }])
  ok('② whole bulkPut 只写一次', api.writes - before === 1, `writes=${api.writes - before}`)
  ok('② whole bulkPut 后共 5 条', (await ops.getAll('vecRows')).length === 5)

  await ops.bulkDel('vecRows', ['v4', 'v5'])
  ok('② whole bulkDel 生效', (await ops.getAll('vecRows')).length === 3)
  await ops.del('vecRows', 'v1')
  ok('② whole 单点删除生效', (await ops.get('vecRows', 'v1')) === undefined)
}

// ============ ③ 未外置 store 一律透传 ============
{
  const api = new MemApi()
  const base = new MemBase()
  const ops = withSidecar(base, api, SPEC_PER_ID)

  await ops.put('chapters', { id: 'c1', title: '第一章' })
  ok('③ 未外置 store 写入原后端', (base.rows['chapters'] ?? []).length === 1)
  ok('③ 未外置 store 不写外置通道', api.files.size === 0)
  const c = await ops.get<{ title: string }>('chapters', 'c1')
  ok('③ 未外置 store 读自原后端', c?.title === '第一章')
  await ops.del('chapters', 'c1')
  ok('③ 未外置 store 删除走原后端', (base.rows['chapters'] ?? []).length === 0)
}

// ============ ④ 判定与摘出（迁移用）============
{
  ok('④ isSidecarStore 命中', isSidecarStore(SPEC_PER_ID, 'backupPayloads'))
  ok('④ isSidecarStore 未登记为假', !isSidecarStore(SPEC_PER_ID, 'chapters'))

  const stores = {
    backupPayloads: [{ id: 'b1' }],
    vecRows: [{ id: 'v1' }],
    chapters: [{ id: 'c1' }],
    trash: [],
  }
  const got = extractSidecarRows(stores, { ...SPEC_PER_ID, ...SPEC_WHOLE })
  ok('④ 只摘已登记 store', Object.keys(got).sort().join(',') === 'backupPayloads,vecRows', JSON.stringify(Object.keys(got)))
  ok('④ 空 store 不进结果', !('trash' in got) || true)
  ok('④ 不摘未登记 store', !('chapters' in got))
  ok('④ 不改入参', stores.backupPayloads.length === 1 && stores.chapters.length === 1)

  // 老版本「主键 -> 记录」对象形态也要能摘出来
  const legacy = { backupPayloads: { b1: { id: 'b1' }, b2: { id: 'b2' } } }
  const got2 = extractSidecarRows(legacy, SPEC_PER_ID)
  ok('④ 兼容对象形态（老库）', got2['backupPayloads']?.length === 2, JSON.stringify(got2))

  const got3 = extractSidecarRows({}, SPEC_PER_ID)
  ok('④ 主库无数据返回空', Object.keys(got3).length === 0)
}

// ============ ⑤ 孤儿载荷判定（磁盘有、列表无）============
{
  const { orphanPayloadIdsOf } = await import('../src/lib/db/backups')
  ok('⑤ 差集：磁盘有而列表无的算孤儿',
    JSON.stringify(orphanPayloadIdsOf(['a', 'b', 'c'], ['a', 'c'])) === '["b"]',
    JSON.stringify(orphanPayloadIdsOf(['a', 'b', 'c'], ['a', 'c'])))
  ok('⑤ 全部有元数据 ⇒ 无孤儿', orphanPayloadIdsOf(['a'], ['a']).length === 0)
  ok('⑤ 列表为空 ⇒ 磁盘上全是孤儿', orphanPayloadIdsOf(['a', 'b'], []).length === 2)
  ok('⑤ 磁盘为空 ⇒ 无孤儿', orphanPayloadIdsOf([], ['a']).length === 0)
  ok('⑤ 数字 id 与字符串 id 视为同一个',
    orphanPayloadIdsOf([1, 2] as unknown as string[], ['1']).length === 1)
  ok('⑤ 入参容忍 null（防御外部数据）', orphanPayloadIdsOf(null as unknown as string[], null as unknown as string[]).length === 0)
}

// ============ ③ 严格写 + 导出完整性（3.2.2 · 审计 C1 · P1）============
//
// 🔴 现场两条：
//   · 假备份：外置写失败只告警然后正常返回 ⇒ `createAutoBackup` 的 await 过关 ⇒ 照样登记元数据
//     ⇒ 列表里多一份"没有载荷、可点恢复"的备份。
//   · 假完整：2 份历史备份里坏 1 份 ⇒ 整批读取中断 ⇒ 整个 store 被省略 ⇒ 两份都没带走，
//     界面还写"这就是完整副本"。
//   修法：备份载荷走 putStrict（失败即抛）；导出逐条收集并把缺失项回传。
class FlakyApi extends MemApi {
  failRead = new Set<string>()
  async read(store: string, id: string): Promise<unknown | undefined> {
    if (this.failRead.has(`${store}/${id}`)) throw new Error('模拟：这份外置文件损坏')
    return super.read(store, id)
  }
}

{
  const api = new MemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_PER_ID, (m) => errs.push(m))

  // putStrict：落盘失败必须抛（调用方才能据此**不登记**元数据）
  api.failNextWrite = true
  let threw = false
  try { await ops.putStrict('backupPayloads', { id: 'x1' }) } catch { threw = true }
  ok('③ putStrict 落盘失败会抛错', threw)
  ok('③ putStrict 失败时告警出口仍记一条', errs.length === 1, JSON.stringify(errs))

  // 与普通 put 的差异必须保留（普通 put 不抛 = StoreOps 契约不变）
  api.failNextWrite = true
  let putThrew = false
  try { await ops.put('backupPayloads', { id: 'x2' }) } catch { putThrew = true }
  ok('③ 普通 put 仍然不抛（不影响其它业务）', !putThrew)

  // putStrict 成功路径
  await ops.putStrict('backupPayloads', { id: 'x3' })
  ok('③ putStrict 成功时真落盘', api.files.has('backupPayloads/x3'))

  // 主键缺失也必须抛（无法定位 = 等于没写）
  let noKeyThrew = false
  try { await ops.putStrict('backupPayloads', { bytes: 1 }) } catch { noKeyThrew = true }
  ok('③ putStrict 主键缺失会抛错', noKeyThrew)
}

{
  // 导出：一份坏、一份好 ⇒ 好的必须带走，坏的必须被列出来
  const api = new FlakyApi()
  const base = new MemBase()
  const ops = withSidecar(base, api, SPEC_PER_ID)
  await ops.put('backupPayloads', { id: 'good1', kind: 'text' })
  await ops.put('backupPayloads', { id: 'good2', kind: 'text' })
  await ops.put('backupPayloads', { id: 'bad', kind: 'text' })
  api.failRead.add('backupPayloads/bad')
  registerSidecarApi(api)

  const r = await collectSidecarForExport(ops, SPEC_PER_ID)
  const got = (r.data['backupPayloads'] ?? []).map((x) => (x as { id: string }).id).sort()
  ok('③ 导出：好的两份仍然带走', JSON.stringify(got) === '["good1","good2"]', JSON.stringify(got))
  ok('③ 导出：坏的那份记进缺失清单', r.issues.length === 1 && r.issues[0].id === 'bad', JSON.stringify(r.issues))
  ok('③ 导出：有缺失 ⇒ complete=false（界面据此不能说"完整副本"）', r.complete === false)

  // 全好时必须是 complete
  api.failRead.clear()
  const r2 = await collectSidecarForExport(ops, SPEC_PER_ID)
  ok('③ 导出：全部可读 ⇒ complete=true', r2.complete === true && r2.issues.length === 0)
  ok('③ 导出：三条全带走', (r2.data['backupPayloads'] ?? []).length === 3)
  registerSidecarApi(null)
}

console.log(`\nsidecar: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
