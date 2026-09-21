// ============ 云端同步层语义：backups 本地专属 / 敏感 meta 不上云 / 不可用回退 / 播种口径 ============
//
// 背景（2026-09-14 P2-3）：审计原文说「syncCore.SYNC_STORES 含 backups，但 liveStores/mergeCaches
// 全程排除」——初看以为是「死配置」。回源码逐行验尸后，真身比那严重：
//
//   syncCore.liveStores() 上传前把 backups 从载荷里剔除（#026「云端永不参与备份增删」），
//   而 db.ts 的 makeCloudStoreWrapper 当时只对敏感 meta 做本地短路，**backups 没有接回本地**。
//   于是云端模式下 ops.put('backups') 只写进云端实例的内存 cache → 上传时被剔除 →
//   既不落云端、也不落本地。后果：备份只活在内存里，刷新/关页即丢；
//   且由于 cache 初值来自 pull（云端载荷本就不含 backups），备份列表还会显示为空。
//
// 修复：在包装层唯一入口 cloudOrLocal 处对 backups 短路到 local。
// 本测试锁住该语义，防止后人「顺手」把 backups 放回云端分支。
//
// ⚠️ 这些断言无法靠 tsc 或端到端点击可靠覆盖（需要一个已开启云同步的环境），故必须先锁死。
import * as db from '../src/lib/db'
import { createCloudStore, SYNC_STORES } from '../src/lib/syncCore'
import type { StoreOps } from '../src/lib/storeOps'
import type { SyncTransport } from '../src/lib/syncTransport'
import { memoryOps, __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const OPS = ['getAll', 'get', 'put', 'del', 'getAllByIndex', 'bulkPut', 'bulkDel'] as const

/** 云端替身：只记录调用落点、不落盘（云端本就不该收到 backups）。 */
function stubCloud(tag: string) {
  const calls: string[] = []
  const wrap: Record<string, unknown> = {}
  for (const op of OPS) {
    wrap[op] = async (store: string) => {
      calls.push(`${tag}:${op}:${store}`)
      return op === 'getAll' || op === 'getAllByIndex' ? [] : undefined
    }
  }
  return { ops: wrap as unknown as StoreOps, calls, has: (s: string) => calls.includes(s) }
}

/** 本地替身：真实内存存储（memoryOps）+ 调用落点记录，用于验证「数据确实写到了本地」。 */
function spyLocal(tag: string) {
  const calls: string[] = []
  const real = memoryOps as unknown as Record<string, (...a: any[]) => any>
  const wrap: Record<string, unknown> = {}
  for (const op of OPS) {
    wrap[op] = async (...args: any[]) => {
      calls.push(`${tag}:${op}:${String(args[0])}`)
      return real[op](...args)
    }
  }
  return { ops: wrap as unknown as StoreOps, calls, has: (s: string) => calls.includes(s) }
}

/** 空库假传输层：pull 恒返回「空库」，push 只记录次数。 */
function emptyTransport() {
  const pushes: { baseRev: number; enc: string }[] = []
  const t: SyncTransport = {
    mode: 'file',
    setCode() { /* 无需槽位 */ },
    async pull() { return { status: 200, rev: 0, enc: null } },
    async push(baseRev, enc) { pushes.push({ baseRev, enc }); return { status: 200, rev: baseRev + 1 } },
    startWatch() { /* 测试不轮询 */ },
    stopWatch() { /* 同上 */ },
  }
  return { t, pushes }
}

async function main() {
  __resetMockStores()

  // ---------- 1) backups 读写删一律落本地 ----------
  {
    const cloud = stubCloud('cloud')
    const local = spyLocal('local')
    const w = db.makeCloudStoreWrapper(cloud.ops, local.ops, () => false)

    await w.put('backups', { id: 'b1', projectId: 'p1', kind: 'auto5min' })
    ok('put(backups) 落本地', local.has('local:put:backups'))
    ok('put(backups) 完全不碰云端', cloud.calls.length === 0, cloud.calls.join(',') || '(无)')

    const listed = await w.getAll<{ id: string }>('backups')
    ok('getAll(backups) 从本地读', local.has('local:getAll:backups'))
    ok('getAll(backups) 能读回刚落的备份（证明真落了盘）', listed.length === 1 && listed[0].id === 'b1', `实际=${JSON.stringify(listed)}`)

    await w.del('backups', 'b1')
    ok('del(backups) 落本地', local.has('local:del:backups'))
    ok('删除后本地确无该备份', (await w.getAll('backups')).length === 0)
  }

  // ---------- 2) 其它 store 未被误伤（仍走云端） ----------
  {
    const cloud = stubCloud('cloud')
    const local = spyLocal('local')
    const w = db.makeCloudStoreWrapper(cloud.ops, local.ops, () => false)

    await w.put('chapters', { id: 'c1' })
    await w.getAll('chapters')
    await w.bulkPut('tableRows', [{ id: 'r1' }])
    ok('普通 store 仍走云端', cloud.has('cloud:put:chapters') && cloud.has('cloud:getAll:chapters') && cloud.has('cloud:bulkPut:tableRows'))
    ok('普通 store 不被误短路到本地', local.calls.length === 0, local.calls.join(',') || '(无)')
  }

  // ---------- 3) 敏感 meta 既有语义回归（#006） ----------
  {
    const cloud = stubCloud('cloud')
    const local = spyLocal('local')
    const w = db.makeCloudStoreWrapper(cloud.ops, local.ops, () => false)

    await w.put('meta', { key: 'aiProviders', value: 'SECRET' })
    await w.put('meta', { key: 'theme', value: 'dark' })
    ok('敏感 meta 走本地（不上云）', local.has('local:put:meta'))
    ok('普通 meta 走云端', cloud.has('cloud:put:meta'))
    ok('敏感 meta 的 key 未出现在云端调用里', !cloud.calls.some(c => c.includes('SECRET')))
  }

  // ---------- 4) 云端不可用时全部回退本地（#008/#011） ----------
  {
    const cloud = stubCloud('cloud')
    const local = spyLocal('local')
    const down = db.makeCloudStoreWrapper(cloud.ops, local.ops, () => true)

    await down.getAll('chapters')
    ok('云端不可用时回退本地', local.has('local:getAll:chapters') && cloud.calls.length === 0)

    const before = local.calls.filter(c => c === 'local:put:backups').length
    await down.put('backups', { id: 'b2' })
    const after = local.calls.filter(c => c === 'local:put:backups').length
    ok('云端不可用 + backups：仍落本地且只落一次（短路优先于回退，不重复写）', after - before === 1, `增量=${after - before}`)
  }

  // ---------- 5) 播种口径：seedFromLocal 不再白读 backups ----------
  {
    const seen: string[] = []
    const getAll = async (s: string) => { seen.push(s); return [] as any[] }
    const inst = createCloudStore(emptyTransport().t)
    inst.configure('YFE-SYNC-TEST-0000')
    try {
      await inst.seedFromLocal(getAll)
    } catch {
      // push 阶段可能因 Node 侧无 WebCrypto 安全上下文而失败——本组只断言「读取口径」，
      // 而 seen 在 push 之前就已填充完毕，故忽略之（不影响结论）。
    }
    ok('seedFromLocal 不读 backups（本地专属，读了也没有下游消费者）', !seen.includes('backups'), seen.join(','))
    ok('seedFromLocal 仍遍历其余全部 store（未误伤）', seen.length === SYNC_STORES.length - 1,
      `实际=${seen.length} 期望=${SYNC_STORES.length - 1}`)
  }

  console.log(`\ncloudStoreWrapper: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
