// ============ 云同步防呆：空载荷守卫 / 云端载荷解不开就别覆盖 / 推不上去要报错 ============
//
// 这三条锁的是 2026-09-15 那轮审计里**最危险的一类静默路径**（都能让云端数据无声消失）：
//   ① 空推守卫原先用 `Object.keys(...).length` 判空 —— `liveStores` 会把每个 store 都放成键
//      （哪怕是空数组），12 个空数组就能骗过它，一份空快照照样被推上云端。
//   ② 409（远端更新）时若 `decryptObj(resp.enc)` 抛错，旧实现把 serverCache 置 null 继续
//      以本地 cache 重试 → 用 serverRev 覆盖那份**只有云端才有**的加密载荷，连 .corrupt 都不留。
//   ③ `flushNow` 只对「抛错」设 error，而 pushNow 重试耗尽时是**返回** {conflict:true}（不抛）
//      → 状态永远停在 'syncing'（界面一直转圈，实际一条都没上传）。
//
// 这三条都靠端到端点不出来（需要一个真出错的云盘目录），所以必须先锁死。
import { createCloudStore } from '../src/lib/syncCore'
import type { SyncTransport } from '../src/lib/syncTransport'
import { __resetMockStores } from './mock-memory'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type PushRec = { baseRev: number; enc: string }

/** 可编排的传输层替身：pull / push 的行为由用例给定，并记录每次 push。 */
function scriptedTransport(opts: {
  pull?: () => Promise<{ status: number; rev?: number; enc?: string | null }> | { status: number; rev?: number; enc?: string | null }
  push?: (baseRev: number, enc: string) => Promise<{ status: number; rev?: number; enc?: string | null }> | { status: number; rev?: number; enc?: string | null }
}) {
  const pushes: PushRec[] = []
  const t: SyncTransport = {
    mode: 'file',
    setCode() { /* 测试不关心槽位 */ },
    async pull() { return opts.pull ? await opts.pull() : { status: 200, rev: 0, enc: null } },
    async push(baseRev, enc) {
      pushes.push({ baseRev, enc })
      return opts.push ? await opts.push(baseRev, enc) : { status: 200, rev: baseRev + 1 }
    },
    startWatch() { /* 测试不轮询 */ },
    stopWatch() { /* 同上 */ },
  }
  return { t, pushes }
}

async function main() {
  __resetMockStores()

  // ---------- ① 全空载荷必须被拒（键数判法会被「12 个空数组」骗过去） ----------
  {
    const { t, pushes } = scriptedTransport({})
    const cloud = createCloudStore(t)
    cloud.configure('test-key')

    // 先正常播种一份有内容的数据 → push 成功 → baseCache 变成非空
    await cloud.seedFromLocal(async () => [{ id: 'p1' }])
    const afterSeed = pushes.length
    ok('正常播种会推一次', afterSeed === 1, String(afterSeed))

    // 再把「全是空数组」的载荷喂进去（模拟 cache 被清空的瞬间）
    let threw = false
    let msg = ''
    try {
      await cloud.seedFromLocal(async () => [])
    } catch (e) {
      threw = true
      msg = e instanceof Error ? e.message : String(e)
    }
    ok('🔴 全空载荷被拒（不是「12 个空 store 也算有内容」）', threw && /empty push/.test(msg), msg)
    ok('被拒时没有真的推上去', pushes.length === afterSeed, `${pushes.length} vs ${afterSeed}`)
  }

  // ---------- ② 409 且云端载荷解不开 → 停止重试，绝不覆盖 ----------
  {
    let pushCount = 0
    const { t } = scriptedTransport({
      pull: () => ({ status: 200, rev: 1, enc: null }),
      // 远端永远「比本地新」，且交回来的是一段解不开的负载
      push: () => { pushCount++; return { status: 409, rev: 2, enc: 'not-a-valid-encrypted-payload' } },
    })
    const cloud = createCloudStore(t)
    cloud.configure('test-key')

    let threw = false
    let msg = ''
    try {
      await cloud.seedFromLocal(async () => [{ id: 'p1' }])
    } catch (e) {
      threw = true
      msg = e instanceof Error ? e.message : String(e)
    }
    ok('🔴 云端载荷解不开时抛错（不再拿本地 cache 去覆盖它）', threw && /undecryptable/.test(msg), msg)
    ok('🔴 只尝试了一次，不进入重试循环', pushCount === 1, String(pushCount))
    ok('状态置为 error（界面不会假装同步中）', cloud.getStatus() === 'error', cloud.getStatus())
  }

  // ---------- ③ 重试耗尽（conflict 是「返回」不是「抛」）→ 状态必须落到 error ----------
  {
    const { t } = scriptedTransport({
      pull: () => ({ status: 200, rev: 1, enc: null }),
      // 每次都是「远端更新但没有负载可合并」→ 上层合并后重试，直到 MAX_CONFLICT_RETRY 用尽
      push: (baseRev) => ({ status: 409, rev: baseRev + 1, enc: null }),
    })
    const cloud = createCloudStore(t)
    cloud.configure('test-key')

    // 走防抖那条路（flushNow），这才是真实写入路径
    await cloud.store.put('projects', { id: 'p1' })
    await sleep(1400) // 等防抖窗口过完
    ok('🔴 推不上去时状态是 error，而不是永远 syncing', cloud.getStatus() === 'error', cloud.getStatus())
  }

  console.log(`\nsyncGuards: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

main().catch(e => {
  console.log(`FAIL 未捕获异常: ${e && e.message ? e.message : e}`)
  process.exitCode = 1
})
