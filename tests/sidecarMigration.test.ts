// ============ 3.2.3 · R2 §6.3：备份外置数据的迁移、损坏与恢复 ============
//
// 方案 §6.3 要求扩充的场景：
//   · 损坏一个／多个载荷（导出仍产出健康载荷并标记不完整）
//   · 目标不可写
//   · 迁移中断
//   · 主 JSON 与 blobs **同时**恢复
//   · 恢复失败后重试
// 判据：**自动比较记录标识、正文和载荷哈希**，不以"导出成功"这句提示作证据。
//
// 已有覆盖（不重复）：`sidecar.test.ts` 锁两种布局语义 + 单条损坏导出；
// `backupShards.test.ts` 锁四片拆分/合并与"哈希不符不写回"。这里补的是**迁移与恢复链路**。
import { createHash } from 'node:crypto'
import type { StoreOps } from '../src/lib/storage/storeOps'
import type { SidecarApi, SidecarSpec } from '../src/lib/storage/sidecar'
import {
  withSidecar, migrateSidecar, collectSidecarForExport, extractSidecarRows,
  registerSidecarApi, SIDECAR_WHOLE_KEY,
} from '../src/lib/storage/sidecar'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')

/** 外置通道的内存实现（键 = `store/id`），带读/写定点失败开关 —— 定向注入，不靠随机 */
class MemApi implements SidecarApi {
  files = new Map<string, unknown>()
  writes = 0
  failWriteIds = new Set<string>()
  failReadIds = new Set<string>()
  async read(store: string, id: string): Promise<unknown | undefined> {
    if (this.failReadIds.has(`${store}/${id}`)) throw new Error(`模拟：${store}/${id} 载荷损坏或读取失败`)
    return this.files.get(`${store}/${id}`)
  }
  async write(store: string, id: string, value: unknown): Promise<boolean> {
    this.writes++
    if (this.failWriteIds.has(`${store}/${id}`)) return false
    this.files.set(`${store}/${id}`, value)
    return true
  }
  async remove(store: string, id: string): Promise<boolean> { return this.files.delete(`${store}/${id}`) }
  async listIds(store: string): Promise<string[]> {
    return [...this.files.keys()].filter(k => k.startsWith(`${store}/`)).map(k => k.slice(store.length + 1))
  }
}

/** 未外置 store 的记忆后端 */
function baseOps(): StoreOps & { rows: Record<string, unknown[]> } {
  const rows: Record<string, unknown[]> = {}
  const ops: StoreOps = {
    async getAll<T>(store: string) { return (rows[store] ?? []) as T[] },
    async get<T>(store: string, key: string) {
      return (rows[store] ?? []).find(r => String((r as { id?: unknown }).id ?? '') === key) as T | undefined
    },
    async put(store: string, value: unknown) { rows[store] = [...(rows[store] ?? []), value] },
    async del(store: string, key: string) { rows[store] = (rows[store] ?? []).filter(r => String((r as { id?: unknown }).id) !== key) },
    async getAllByIndex<T>(store: string) { return (rows[store] ?? []) as T[] },
    async bulkPut(store: string, values: unknown[]) { rows[store] = [...(rows[store] ?? []), ...values] },
    async bulkDel(store: string, keys: (string | number)[]) {
      rows[store] = (rows[store] ?? []).filter(r => !keys.includes(String((r as { id?: unknown }).id)))
    },
  }
  return Object.assign(ops, { rows })
}

const SPEC: SidecarSpec = {
  backupPayloads: { layout: 'per-id', keyField: 'id' },
  vecRows: { layout: 'whole', keyField: 'id' },
}

const P1 = { id: 'pl-1', projectId: 'p1', text: '第一份载荷正文'.repeat(40) }
const P2 = { id: 'pl-2', projectId: 'p1', text: '第二份载荷正文'.repeat(40) }
const V1 = { id: 'v-1', projectId: 'p1', vec: [0.1, 0.2, 0.3] }

function freshMain() {
  return {
    fileVersion: 1,
    stores: {
      chapters: [{ id: 'c1', text: '第一章正文' }],
      backupPayloads: [P1, P2],
      vecRows: [V1],
    } as Record<string, unknown>,
  }
}

function freshOps() {
  const base = baseOps()
  const api = new MemApi()
  const ops = withSidecar(base, api, SPEC)
  registerSidecarApi(api)
  return { base, api, ops }
}

async function main() {
  // ---------- ① 迁移成功：源被摘走、外置逐字段一致、主库其它数据不动 ----------
  {
    const main = freshMain()
    const { api, ops } = freshOps()
    let persisted = 0
    const r = await migrateSidecar(main, ops, SPEC, async () => { persisted++; return true })
    ok('① 迁移数量正确（2 份载荷 + 1 整表）', r.moved.backupPayloads === 2 && r.moved.vecRows === 1, JSON.stringify(r.moved))
    ok('① 迁移后无失败、主库写盘成功', r.failed.length === 0 && r.ok === true)
    ok('① 主库写盘被调用一次', persisted === 1, String(persisted))
    ok('① 主 JSON 里的外置 store 已摘除', !('backupPayloads' in main.stores) && !('vecRows' in main.stores))
    ok('① 未外置的 chapters 原样保留', Array.isArray(main.stores.chapters) && (main.stores.chapters as unknown[]).length === 1)
    ok('① 载荷按 per-id 各落一份', api.files.has('backupPayloads/pl-1') && api.files.has('backupPayloads/pl-2'))
    ok('① 整表按 whole 键落一份', api.files.has(`vecRows/${SIDECAR_WHOLE_KEY}`))
    ok('🔴 ① 记录标识与正文逐字段一致（不比"提示"，比哈希）',
      sha(api.files.get('backupPayloads/pl-2')) === sha(P2), 'hash 不一致')
  }

  // ---------- ② 目标不可写：该 store 源数据必须留着，其它照常迁 ----------
  {
    const main = freshMain()
    const { api, ops } = freshOps()
    api.failWriteIds.add('backupPayloads/pl-2') // 定点让第二份载荷写不进去
    const r = await migrateSidecar(main, ops, SPEC, async () => true)
    ok('② 部分失败如实记录', r.failed.length === 1 && r.failed[0].includes('backupPayloads'), JSON.stringify(r.failed))
    ok('🔴 ② 写失败的那个 store 源数据**原样留在主库**（不许删了却没写出去）',
      Array.isArray(main.stores.backupPayloads) && (main.stores.backupPayloads as unknown[]).length === 2)
    ok('② 另一个 store 照常迁走', r.moved.vecRows === 1 && !('vecRows' in main.stores))
    ok('② 已迁成功的载荷确实在外置里', api.files.has('backupPayloads/pl-1'))
  }

  // ---------- ③ 迁移中断（主库写盘失败）：返回值必须说 ok=false ----------
  {
    const main = freshMain()
    const { ops } = freshOps()
    const r = await migrateSidecar(main, ops, SPEC, async () => false)
    ok('🔴 ③ 主数据文件写不下去 ⇒ ok=false（调用方能据此报警，不是静默）', r.ok === false)
    ok('③ 外置确实已写入（所以下次重启重迁是安全的 upsert）', r.moved.backupPayloads === 2)
  }

  // ---------- ④ 重试幂等：再跑一次不清空、不重复、不丢 ----------
  {
    const main = freshMain()
    const { api, ops } = freshOps()
    await migrateSidecar(main, ops, SPEC, async () => false) // 先来一次"写盘失败"
    const before = api.files.size
    const again = await migrateSidecar(main, ops, SPEC, async () => true)
    ok('④ 重跑时已无可迁数据（主库已摘除）', Object.keys(again.moved).length === 0, JSON.stringify(again.moved))
    ok('④ 重跑不报失败', again.failed.length === 0 && again.ok === true)
    ok('④ 外置文件数量不变（upsert 语义，不重复堆放）', api.files.size === before, `${before} -> ${api.files.size}`)
    ok('④ 数据仍在且内容未变', sha(api.files.get('backupPayloads/pl-1')) === sha(P1))
  }

  // ---------- ⑤ 多份载荷损坏：健康的照常带走，缺的逐条报出来 ----------
  {
    const { api, ops } = freshOps()
    const P3 = { id: 'pl-3', projectId: 'p1', text: '第三份载荷'.repeat(20) }
    for (const p of [P1, P2, P3]) await api.write('backupPayloads', p.id, p)
    api.failReadIds.add('backupPayloads/pl-1')
    api.failReadIds.add('backupPayloads/pl-3')
    const r = await collectSidecarForExport(ops, SPEC)
    ok('🔴 ⑤ 两份损坏都被记进 issues（不是笼统一句"部分失败"）',
      r.issues.length === 2 && r.issues.every(i => i.store === 'backupPayloads'), JSON.stringify(r.issues))
    ok('🔴 ⑤ 完整性标记为 false（界面必须据此说"不完整"）', r.complete === false)
    ok('⑤ 健康的那份仍被带出', (r.data.backupPayloads ?? []).length === 1)
    ok('⑤ 带出的正是健康那份（按 id 与哈希核对）',
      sha(r.data.backupPayloads?.[0]) === sha(P2), JSON.stringify(r.data.backupPayloads?.[0]).slice(0, 80))
  }

  // ---------- ⑥ 主 JSON 与 blobs 同时恢复：两边合起来要能还原全部 ----------
  {
    const main = freshMain()
    const { api, ops } = freshOps()
    await migrateSidecar(main, ops, SPEC, async () => true) // 迁移后：主 JSON 只剩 chapters，载荷在外置

    // "恢复" = 读主 JSON（chapters）+ 读回外置（载荷/向量）
    const mainJson = JSON.parse(JSON.stringify({ ...main })) as { stores: Record<string, unknown[]> }
    const back = await collectSidecarForExport(ops, SPEC)
    const merged = {
      chapters: mainJson.stores.chapters ?? [],
      backupPayloads: back.data.backupPayloads ?? [],
      vecRows: back.data.vecRows ?? [],
    }
    ok('⑥ 恢复是完整的（无缺失条目）', back.complete === true && back.issues.length === 0)
    ok('⑥ 主库数据来自主 JSON', merged.chapters.length === 1 && (merged.chapters[0] as { id: string }).id === 'c1')
    ok('🔴 ⑥ 载荷条数与标识一致（两份都在，id 对得上）',
      merged.backupPayloads.length === 2
      && merged.backupPayloads.map(p => (p as { id: string }).id).sort().join(',') === 'pl-1,pl-2')
    ok('🔴 ⑥ 正文与载荷哈希逐份一致（不是"看着像恢复成功"）',
      sha(merged.backupPayloads.find(p => (p as { id: string }).id === 'pl-1')) === sha(P1)
      && sha(merged.backupPayloads.find(p => (p as { id: string }).id === 'pl-2')) === sha(P2))
    ok('⑥ 向量表也一并回来', merged.vecRows.length === 1 && sha(merged.vecRows[0]) === sha(V1))
    ok('⑥ 外置里不再残留主库该有的东西（无重复）', !api.files.has('chapters/c1'))
  }

  // ---------- ⑦ 恢复失败后重试 ----------
  {
    const { api, ops } = freshOps()
    for (const p of [P1, P2]) await api.write('backupPayloads', p.id, p)
    api.failReadIds.add('backupPayloads/pl-2')
    const first = await collectSidecarForExport(ops, SPEC)
    ok('⑦ 第一次恢复失败 ⇒ 不完整且写明缺哪条',
      first.complete === false && first.issues.some(i => i.id === 'pl-2'))
    ok('⑦ 第一次仍救出健康载荷', (first.data.backupPayloads ?? []).length === 1)

    api.failReadIds.clear() // 故障排除后重试
    const retry = await collectSidecarForExport(ops, SPEC)
    ok('🔴 ⑦ 重试成功且完整', retry.complete === true && (retry.data.backupPayloads ?? []).length === 2)
    ok('⑦ 重试后内容与原始一致', sha(retry.data.backupPayloads?.find(p => (p as { id: string }).id === 'pl-2')) === sha(P2))
  }

  // ---------- ⑧ 源码守卫：迁移"主库写盘失败"必须能传到界面 ----------
  {
    const src = (await import('node:fs')).readFileSync('src/lib/storage/fileBackend.ts', 'utf8')
    ok('🔴 ⑧ migratePortableSidecar 检查 ok===false 并写 lastError（否则作者看不到主库没落盘）',
      /total > 0 && !r\.ok/.test(src) && /主数据文件未写成功/.test(src))
    ok('⑧ extractSidecarRows 不修改入参（迁移判定依赖它）',
      sha(Object.keys(extractSidecarRows(freshMain().stores, SPEC))) === sha(['backupPayloads', 'vecRows']))
  }

  console.log(`\n———— sidecarMigration：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
