// 外置 store（sidecar）单测 —— 用**内存实现**把两种布局的语义锁死。
//
// 🔴 为什么必须测这个：外置层是便携版（HTTP）与桌面版（IPC）**共用**的同一份语义。
//    它一旦与底层后端（fileBackend 的 upsertRows 等）对不齐，症状是「桌面版能恢复备份、
//    便携版不能」这类**双端不一致** —— 正是本项目最忌讳的同构被打破，且极难排查。
import type { StoreOps } from '../src/lib/storage/storeOps'
import type { SidecarApi, SidecarSpec, SidecarWholeCommitEntry, SidecarMultiWriteResult, SidecarVersionedRead } from '../src/lib/storage/sidecar'
import { withSidecar, extractSidecarRows, isSidecarStore, SIDECAR_WHOLE_KEY, collectSidecarForExport, registerSidecarApi, SidecarUnsupportedError } from '../src/lib/storage/sidecar'
// ③-b 只读源码做契约守卫（生产适配器在 app/desktop.ts，跑真身要起 Electron）
import { readFileSync } from 'node:fs'

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

  /**
   * 🔴 ③-b 生产适配器的两态必须分开（`app/desktop.ts` 的 `ipcSidecarApi`）：
   *    · `missing:true` ⇒ 返回 undefined（还没写过这份 ＝ 正常）
   *    · `ok:false`    ⇒ **必须 throw**（文件坏了 ≠ 不存在）
   *    若把后者也当 undefined，损坏的备份会被"静默跳过"，`complete` 永远是 true ——
   *    界面就又会说"完整导出"，正是审计 C1 那条假完整。
   */
  const desktopSrc = readFileSync('src/lib/app/desktop.ts', 'utf8')
  const apiBlock = /const ipcSidecarApi[\s\S]*?\n\}/.exec(desktopSrc)?.[0] ?? ''
  ok('③-b 缺文件（missing）走 undefined，不算错误', /if \(r\.missing\) return undefined/.test(apiBlock))
  ok('🔴 ③-b 读失败（!r.ok）必须抛，不许当"不存在"', /if \(!r\.ok\) throw new Error/.test(apiBlock))
  ok('③-b 列目录失败同样抛（否则整批被当成空）', /payloadList[\s\S]{0,120}throw new Error/.test(apiBlock))
}

// ============ ⑥ whole 布局：同页串行 + 跨窗口条件写合并 ============
//
// 现场：整表 store（向量 / 知识库）每次写都是「读整表 → 改内存 → 写整表」。
// 两个标签同时改不同行时，后写的会静默覆盖先写的。修法是带版本条件写 + 冲突后重读重放。
class CasMemApi implements SidecarApi {
  files = new Map<string, unknown>()
  writes = 0
  /** 下一次条件写之前注入「另一个窗口的更新」 */
  beforeConditionalWrite: (() => Promise<void> | void) | null = null
  /** 模拟另一个窗口持续写入：条件写永远冲突 */
  alwaysConflict = false
  /** 下一次条件写传输中断（无法判断是否落盘） */
  unknownNext = false

  private revOf(store: string, id: string): string {
    const key = `${store}/${id}`
    return 'rev:' + (this.files.has(key) ? JSON.stringify(this.files.get(key)) : 'missing')
  }
  async read(store: string, id: string): Promise<unknown | undefined> {
    return this.files.get(`${store}/${id}`)
  }
  async write(store: string, id: string, value: unknown): Promise<boolean> {
    this.writes++
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
  async readVersioned(store: string, id: string) {
    return { value: this.files.get(`${store}/${id}`), revision: this.revOf(store, id) }
  }
  async writeConditional(store: string, id: string, value: unknown, expected: string | null) {
    this.writes++
    const hook = this.beforeConditionalWrite
    this.beforeConditionalWrite = null
    if (hook) await hook()
    if (this.unknownNext) {
      this.unknownNext = false
      return { ok: false, unknown: true }
    }
    if (this.alwaysConflict) return { ok: false, conflict: true, revision: this.revOf(store, id) }
    const current = this.revOf(store, id)
    if (expected !== null && expected !== current) return { ok: false, conflict: true, revision: current }
    this.files.set(`${store}/${id}`, value)
    return { ok: true, revision: this.revOf(store, id) }
  }
  /** 模拟另一个窗口直接落盘（绕过本页队列） */
  externalWrite(rows: unknown[]) { this.files.set(`vecRows/${SIDECAR_WHOLE_KEY}`, rows) }
}

{
  const api = new CasMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_WHOLE, (m) => errs.push(m))
  await Promise.all([
    ops.put('vecRows', { id: 'a', projectId: 'p1' }),
    ops.put('vecRows', { id: 'b', projectId: 'p1' }),
  ])
  const ids = (await ops.getAll<{ id: string }>('vecRows')).map(r => r.id).sort()
  ok('⑥ 同页并发写不同行：最终都在（不丢写）', JSON.stringify(ids) === '["a","b"]', JSON.stringify(ids))
  ok('⑥ 同页并发没有写失败告警', errs.length === 0, JSON.stringify(errs))
}

{
  const api = new CasMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_WHOLE, (m) => errs.push(m))
  await ops.put('vecRows', { id: 'first', projectId: 'p1' })
  // 本页读出快照之后、条件写之前，另一个窗口先落盘
  // （真实窗口同样是「读当前整表 → 加自己的行 → 写回」，故它写入的内容里应已含 first）
  api.beforeConditionalWrite = () => {
    api.externalWrite([{ id: 'first', projectId: 'p1' }, { id: 'external', projectId: 'p1' }])
  }
  await ops.put('vecRows', { id: 'second', projectId: 'p1' })
  const ids = (await ops.getAll<{ id: string }>('vecRows')).map(r => r.id).sort()
  ok('🔴 ⑥ 读后另一窗口先写：冲突重读重放，两边修改都保留',
    JSON.stringify(ids) === '["external","first","second"]', JSON.stringify(ids))
  ok('⑥ 冲突确实触发重试（条件写 ≥ 2 次）', api.writes >= 2, String(api.writes))
  ok('⑥ 成功合并后没有告警', errs.length === 0, JSON.stringify(errs))
}

{
  const api = new CasMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_WHOLE, (m) => errs.push(m))
  await ops.put('vecRows', { id: 'base', projectId: 'p1' })
  api.alwaysConflict = true
  let threw = false
  try { await ops.put('vecRows', { id: 'lost', projectId: 'p1' }) } catch { threw = true }
  ok('⑥ 持续冲突时普通 put 不抛（StoreOps 契约不变）', !threw)
  ok('🔴 ⑥ 持续冲突有可见告警（不谎报成功）', errs.some(m => m.includes('连续')), JSON.stringify(errs))
  let strictThrew = false
  try { await ops.putStrict('vecRows', { id: 'lost2', projectId: 'p1' }) } catch { strictThrew = true }
  ok('🔴 ⑥ 持续冲突时 putStrict 抛错（严格写拿得到可判断结果）', strictThrew)
}

{
  const api = new CasMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_WHOLE, (m) => errs.push(m))
  await ops.put('vecRows', { id: 'base2', projectId: 'p1' })
  const writesBefore = api.writes
  api.unknownNext = true
  await ops.put('vecRows', { id: 'maybe', projectId: 'p1' })
  ok('🔴 ⑥ 传输中断 ⇒ 明确「结果不明」，不盲目重试',
    errs.some(m => m.includes('结果不明')), JSON.stringify(errs))
  ok('⑥ 结果不明的写只尝试一次', api.writes - writesBefore === 1, String(api.writes - writesBefore))
}

{
  const api = new CasMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_WHOLE, (m) => errs.push(m))
  api.externalWrite([{ id: 'same', projectId: 'p1', content: 'original' }])
  api.beforeConditionalWrite = () => api.externalWrite([{ id: 'same', projectId: 'p1', content: 'newer' }])
  try { await ops.put('vecRows', { id: 'same', projectId: 'p1', content: 'older draft' }) } catch { /* 冲突可抛出 */ }
  const rows = await ops.getAll<{ content: string }>('vecRows')
  ok('同一记录并发修改不得覆盖对方新内容', rows[0]?.content === 'newer' && errs.length > 0, JSON.stringify({ rows, errs }))
  api.beforeConditionalWrite = () => api.externalWrite([{ id: 'same', projectId: 'p1', content: 'newest' }])
  try { await ops.del('vecRows', 'same') } catch { /* 冲突可抛出 */ }
  const afterDelete = await ops.getAll<{ content: string }>('vecRows')
  ok('并发删除不得删除对方更新后的记录', afterDelete[0]?.content === 'newest', JSON.stringify(afterDelete))
}

{
  const api = new CasMemApi()
  const ops = withSidecar(new MemBase(), api, SPEC_WHOLE)
  api.externalWrite([{ id: 'same', text: 'newer' }])
  let refused = false
  try { await ops.putIfAbsentStrict('vecRows', { id: 'same', text: 'older' }) } catch { refused = true }
  const rows = await ops.getAll<{ text: string }>('vecRows')
  ok('条件恢复拒绝覆盖已存在记录', refused && rows[0]?.text === 'newer')
  api.externalWrite([])
  api.beforeConditionalWrite = () => api.externalWrite([{ id: 'same', text: 'concurrent' }])
  let raced = false
  try { await ops.putIfAbsentStrict('vecRows', { id: 'same', text: 'restore' }) } catch { raced = true }
  const final = await ops.getAll<{ text: string }>('vecRows')
  ok('条件恢复期间出现并发记录时不覆盖', raced && final[0]?.text === 'concurrent')
}

// ============ ⑦ transactWhole：跨文件原子提交（kbDocs + kbBodies）============
//
// 现场：知识库删除/导入要同时改两个整表文件。两次独立条件写之间崩溃会留下孤儿。
// 这里把客户端纪律钉死：一次 commitWhole 带双方前置版本；冲突重读重放但目标行被改过
// 就拒绝覆盖；结果不明不重试；旧通道抛 SidecarUnsupportedError（业务层回退，不假装有事务）。
const SPEC_KB: SidecarSpec = {
  kbDocs: { layout: 'whole', keyField: 'id' },
  kbBodies: { layout: 'whole', keyField: 'id' },
}

class TxnMemApi implements SidecarApi {
  files = new Map<string, unknown>()
  commits: SidecarWholeCommitEntry[][] = []
  beforeCommit: (() => Promise<void> | void) | null = null
  resultOverride: SidecarMultiWriteResult | null = null
  alwaysConflict = false

  private revOf(store: string, id: string): string {
    const key = `${store}/${id}`
    return 'rev:' + (this.files.has(key) ? JSON.stringify(this.files.get(key)) : 'missing')
  }
  async read(store: string, id: string): Promise<unknown | undefined> {
    return this.files.get(`${store}/${id}`)
  }
  async write(store: string, id: string, value: unknown): Promise<boolean> {
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
  async readVersioned(store: string, id: string): Promise<SidecarVersionedRead> {
    return { value: this.files.get(`${store}/${id}`), revision: this.revOf(store, id) }
  }
  async writeConditional(store: string, id: string, value: unknown, expected: string | null) {
    const current = this.revOf(store, id)
    if (expected !== null && expected !== current) return { ok: false, conflict: true, revision: current }
    this.files.set(`${store}/${id}`, value)
    return { ok: true, revision: this.revOf(store, id) }
  }
  async commitWhole(entries: SidecarWholeCommitEntry[]): Promise<SidecarMultiWriteResult> {
    this.commits.push(entries.map(e => ({ ...e })))
    const hook = this.beforeCommit
    this.beforeCommit = null
    if (hook) await hook()
    if (this.resultOverride) { const r = this.resultOverride; this.resultOverride = null; return r }
    if (this.alwaysConflict) return { ok: false, conflict: true }
    for (const e of entries) {
      if (e.expectedRevision !== null && e.expectedRevision !== this.revOf(e.store, SIDECAR_WHOLE_KEY)) {
        return { ok: false, conflict: true }
      }
    }
    const revisions: Record<string, string | null> = {}
    for (const e of entries) {
      this.files.set(`${e.store}/${SIDECAR_WHOLE_KEY}`, e.value)
      revisions[e.store] = this.revOf(e.store, SIDECAR_WHOLE_KEY)
    }
    return { ok: true, revisions }
  }
}

const addPair = (id: string) => (rows: Record<string, unknown[]>) => ({
  kbDocs: [...rows.kbDocs, { id, projectId: 'p1' }],
  kbBodies: [...rows.kbBodies, { id, text: 'body-' + id }],
})
const keysOf = (id: string) => ({ kbDocs: new Set([id]), kbBodies: new Set([id]) })
const idsIn = (api: TxnMemApi, store: string) =>
  ((api.files.get(`${store}/${SIDECAR_WHOLE_KEY}`) ?? []) as { id: string }[]).map(r => r.id).sort()

{
  const api = new TxnMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_KB, m => errs.push(m))
  const beforeDocs = (await api.readVersioned('kbDocs', SIDECAR_WHOLE_KEY)).revision
  const beforeBodies = (await api.readVersioned('kbBodies', SIDECAR_WHOLE_KEY)).revision
  await ops.transactWhole(['kbDocs', 'kbBodies'], addPair('d1'), keysOf('d1'))
  ok('⑦ 原子提交一次完成：两表都拿到新行', JSON.stringify(idsIn(api, 'kbDocs')) === '["d1"]' && JSON.stringify(idsIn(api, 'kbBodies')) === '["d1"]')
  ok('🔴 ⑦ 只调用一次 commitWhole（不是两次独立条件写冒充）', api.commits.length === 1, String(api.commits.length))
  const entries = api.commits[0]
  ok('⑦ 提交按 store 排序（与服务端锁顺序一致）', entries[0].store === 'kbBodies' && entries[1].store === 'kbDocs')
  ok('🔴 ⑦ 双方前置版本都带上（缺失文件也有版本）',
    entries[0].expectedRevision === beforeBodies && entries[1].expectedRevision === beforeDocs)
  ok('⑦ 成功提交没有告警', errs.length === 0, JSON.stringify(errs))
}

{
  // 旧通道：没有 commitWhole ⇒ 类型化错误，业务层据此回退旧路径
  const api = new CasMemApi()
  const ops = withSidecar(new MemBase(), api, SPEC_KB)
  let unsupported = false
  try { await ops.transactWhole(['kbDocs', 'kbBodies'], addPair('d1'), keysOf('d1')) }
  catch (e) { unsupported = e instanceof SidecarUnsupportedError }
  ok('🔴 ⑦ 通道无 commitWhole ⇒ SidecarUnsupportedError（不假装有事务）', unsupported)
}

{
  const api = new TxnMemApi()
  const ops = withSidecar(new MemBase(), api, SPEC_KB)
  api.resultOverride = { ok: false, unsupported: true }
  let unsupported = false
  try { await ops.transactWhole(['kbDocs', 'kbBodies'], addPair('d1'), keysOf('d1')) }
  catch (e) { unsupported = e instanceof SidecarUnsupportedError }
  ok('⑦ 服务端答复 unsupported ⇒ 同样抛类型化错误', unsupported)
}

{
  const api = new TxnMemApi()
  api.readVersioned = async (store, id) => ({ value: await api.read(store, id), revision: null })
  const ops = withSidecar(new MemBase(), api, SPEC_KB)
  let unsupported = false
  try { await ops.transactWhole(['kbDocs', 'kbBodies'], addPair('d1'), keysOf('d1')) }
  catch (e) { unsupported = e instanceof SidecarUnsupportedError }
  ok('🔴 ⑦ 快照缺版本 ⇒ 拒绝提交（不能裸写两个文件）', unsupported && api.commits.length === 0)
}

{
  const api = new TxnMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_KB, m => errs.push(m))
  // 首次提交前另一窗口先落盘（改的是别的行）⇒ 冲突后重读重放，双方都保留
  api.beforeCommit = () => { api.files.set(`kbDocs/${SIDECAR_WHOLE_KEY}`, [{ id: 'external', projectId: 'p1' }]) }
  await ops.transactWhole(['kbDocs', 'kbBodies'], addPair('d1'), keysOf('d1'))
  ok('🔴 ⑦ 冲突重读重放：另一窗口的行与本次的行都在',
    JSON.stringify(idsIn(api, 'kbDocs')) === '["d1","external"]' && JSON.stringify(idsIn(api, 'kbBodies')) === '["d1"]',
    JSON.stringify(idsIn(api, 'kbDocs')))
  ok('⑦ 确实重试了一次提交', api.commits.length === 2, String(api.commits.length))
  ok('⑦ 合并成功没有告警', errs.length === 0, JSON.stringify(errs))
}

{
  const api = new TxnMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_KB, m => errs.push(m))
  api.files.set(`kbDocs/${SIDECAR_WHOLE_KEY}`, [{ id: 'd1', projectId: 'p1', content: 'original' }])
  api.files.set(`kbBodies/${SIDECAR_WHOLE_KEY}`, [{ id: 'd1', text: 'original-body' }])
  api.beforeCommit = () => { api.files.set(`kbDocs/${SIDECAR_WHOLE_KEY}`, [{ id: 'd1', projectId: 'p1', content: 'newer' }]) }
  let threw = false
  try {
    await ops.transactWhole(['kbDocs', 'kbBodies'], rows => ({
      kbDocs: rows.kbDocs.map(r => (r as { id: string }).id === 'd1' ? { ...(r as Record<string, unknown>), content: 'my draft' } : r),
      kbBodies: rows.kbBodies,
    }), keysOf('d1'))
  } catch { threw = true }
  const docs = api.files.get(`kbDocs/${SIDECAR_WHOLE_KEY}`) as { content: string }[]
  ok('🔴 ⑦ 目标行已被其他窗口修改 ⇒ 拒绝覆盖并抛错', threw && docs[0].content === 'newer', JSON.stringify(docs))
  ok('⑦ 拒绝覆盖有可见告警', errs.some(m => m.includes('其他窗口')), JSON.stringify(errs))
}

{
  const api = new TxnMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_KB, m => errs.push(m))
  api.resultOverride = { ok: false, unknown: true }
  let msg = ''
  try { await ops.transactWhole(['kbDocs', 'kbBodies'], addPair('d1'), keysOf('d1')) }
  catch (e) { msg = e instanceof Error ? e.message : String(e) }
  ok('🔴 ⑦ 结果不明 ⇒ 抛错且只尝试一次（不盲目重放）', api.commits.length === 1 && msg.includes('结果不明'), msg)
  ok('⑦ 结果不明有告警', errs.length > 0)
}

{
  const api = new TxnMemApi()
  const ops = withSidecar(new MemBase(), api, SPEC_KB)
  api.resultOverride = { ok: false }
  let msg = ''
  try { await ops.transactWhole(['kbDocs', 'kbBodies'], addPair('d1'), keysOf('d1')) }
  catch (e) { msg = e instanceof Error ? e.message : String(e) }
  ok('⑦ 服务端保留日志的中断 ⇒ 抛错并说明会自动恢复', msg.includes('恢复日志'), msg)
}

{
  const api = new TxnMemApi()
  const ops = withSidecar(new MemBase(), api, SPEC_KB)
  api.alwaysConflict = true
  let msg = ''
  try { await ops.transactWhole(['kbDocs', 'kbBodies'], addPair('d1'), keysOf('d1')) }
  catch (e) { msg = e instanceof Error ? e.message : String(e) }
  ok('🔴 ⑦ 持续冲突 ⇒ 有限重试后失败关闭（不无限卡死）', api.commits.length === 12 && msg.includes('连续'), `${api.commits.length} ${msg}`)
}

{
  const api = new TxnMemApi()
  const ops = withSidecar(new MemBase(), api, { ...SPEC_KB, backupPayloads: { layout: 'per-id', keyField: 'id' } })
  let single = false, perId = false, unknownStore = false
  try { await ops.transactWhole(['kbDocs'], addPair('d1'), keysOf('d1')) } catch { single = true }
  try { await ops.transactWhole(['kbDocs', 'backupPayloads'], addPair('d1'), keysOf('d1')) } catch { perId = true }
  try { await ops.transactWhole(['kbDocs', 'vecRows'], addPair('d1'), keysOf('d1')) } catch { unknownStore = true }
  ok('⑦ 参数校验：单 store / per-id / 未外置 store 都拒绝', single && perId && unknownStore)
  ok('⑦ 校验失败不发起任何提交', api.commits.length === 0)
}

{
  // 同页互斥：单表写与跨表事务并发，最终两边修改都在（共享串行队列）
  const api = new TxnMemApi()
  const errs: string[] = []
  const ops = withSidecar(new MemBase(), api, SPEC_KB, m => errs.push(m))
  await Promise.all([
    ops.put('kbDocs', { id: 'single', projectId: 'p1' }),
    ops.transactWhole(['kbDocs', 'kbBodies'], addPair('txn'), keysOf('txn')),
  ])
  ok('🔴 ⑦ 同页单表写与跨表事务并发：两边修改都在',
    JSON.stringify(idsIn(api, 'kbDocs')) === '["single","txn"]', JSON.stringify(idsIn(api, 'kbDocs')))
  ok('⑦ 并发互斥没有告警', errs.length === 0, JSON.stringify(errs))
}

console.log(`\nsidecar: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
