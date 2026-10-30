// 3.3.2 · P3-2 待同步队列 · 单测
//
// 盯六件事：
//   ① 同一项目反复保存**只留一个任务、只用一个 opId**（幂等地基）；
//   ② 已成功的任务**绝不复用**（否则新内容会被判成重放，永远上不去）；
//   ③ 崩溃停在 running 的任务必须能被打回重跑，且 attempts 要累加；
//   ④ 同项目串行：跑着的时候不会再领到第二条；
//   ⑤ 退避到期的任务不提前跑；
//   ⑥ 不可重试的失败进 blocked，且会被新的改动唤醒。
import {
  createMemoryQueueStore, enqueuePush, recoverRunning, claimNext,
  markDone, markFailed, pruneQueue, pendingJobsOf, clearProjectJobs,
  backoffFor, MAX_BACKOFF_MS, DONE_TTL_MS, deriveStateFromJobs,
  type SyncJob,
} from '@/lib/sync/syncQueue'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const T0 = 1_700_000_000_000
const base = { projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0 }

void (async () => {
    // ---------- 1. 首次入队 ----------
    {
      const store = createMemoryQueueStore()
      const job = await enqueuePush(store, { ...base, now: T0 })
      ok('首次入队生成 pending 任务', job.state === 'pending' && job.attempts === 0, JSON.stringify(job))
      ok('opId 以 op_ 开头（提交时直接当幂等键）', job.id.startsWith('op_'), job.id)
    }

    // ---------- 2. 反复入队复用同一个任务与 opId ----------
    {
      const store = createMemoryQueueStore()
      const a = await enqueuePush(store, { ...base, now: T0 })
      const b = await enqueuePush(store, { ...base, baseRevision: 5, now: T0 + 1000 })
      const all = await store.all()
      ok('第二次入队不新增任务', all.length === 1, String(all.length))
      ok('复用同一个 opId（幂等地基）', a.id === b.id, `${a.id} vs ${b.id}`)
      ok('基线随最新入队更新', b.baseRevision === 5, String(b.baseRevision))
    }

    // ---------- 3. 已成功的任务必须新建 ----------
    {
      const store = createMemoryQueueStore()
      const a = await enqueuePush(store, { ...base, now: T0 })
      await claimNext(store, T0)
      await markDone(store, a.id, 3, T0 + 10)
      const b = await enqueuePush(store, { ...base, baseRevision: 3, now: T0 + 20 })
      ok('已成功后再入队生成新 opId（否则会被判成重放）', b.id !== a.id, `${a.id} vs ${b.id}`)
      ok('新任务从 pending 起跑、尝试次数归零', b.state === 'pending' && b.attempts === 0)
    }

    // ---------- 4. 崩溃恢复 ----------
    {
      const store = createMemoryQueueStore()
      const a = await enqueuePush(store, { ...base, now: T0 })
      await claimNext(store, T0) // → running
      const n = await recoverRunning(store, T0 + 5000)
      const after = (await store.get(a.id))!
      ok('崩溃后 running 被打回 pending', n === 1 && after.state === 'pending', JSON.stringify(after))
      // claimNext 已经把 attempts 记成 1；恢复不该再加一次（否则一次崩溃算两次，退避翻倍）
      ok('恢复不重复计尝试（claimNext 已计）', after.attempts === 1, String(after.attempts))
      ok('恢复留下可读的原因，不是静默', /中断/.test(after.lastError || ''), after.lastError || '')
      // 🔴 恢复后仍用同一个 opId：上次可能已经提交成功、只是回执丢了
      const claimed = await claimNext(store, T0 + 6000)
      ok('恢复后重跑仍是同一个 opId', claimed?.id === a.id, claimed?.id)
    }

    // ---------- 5. 同项目串行 ----------
    {
      const store = createMemoryQueueStore()
      const a = await enqueuePush(store, { ...base, now: T0 })
      await claimNext(store, T0)
      // 人为塞一条同项目的 pending（模拟历史脏数据）
      await store.put({ ...a, id: 'op_dup', state: 'pending', createdAt: T0 + 1, updatedAt: T0 + 1 } as SyncJob)
      const next = await claimNext(store, T0 + 2)
      ok('项目在跑时不再领第二条（同项目串行）', next === null, JSON.stringify(next))
      // 另一个项目可以并行领
      await store.put({
        ...a, id: 'op_other', projectId: 'p2', state: 'pending', createdAt: T0 + 3, updatedAt: T0 + 3,
      } as SyncJob)
      const other = await claimNext(store, T0 + 4)
      ok('不同项目可以各自领到', other?.projectId === 'p2', JSON.stringify(other))
    }

    // ---------- 6. 退避 ----------
    {
      const store = createMemoryQueueStore()
      const a = await enqueuePush(store, { ...base, now: T0 })
      const running = (await claimNext(store, T0))!
      await markFailed(store, running.id, { code: 'NETWORK', message: '网络抖动', retryable: true }, T0 + 10)
      const afterFail = (await store.get(a.id))!
      ok('可重试失败进 failed 并算退避', afterFail.state === 'failed' && (afterFail.nextAttemptAt ?? 0) > T0 + 10, JSON.stringify(afterFail))
      ok('退避未到期不跑', (await claimNext(store, T0 + 11)) === null)
      ok('退避到期后能跑', (await claimNext(store, afterFail.nextAttemptAt! + 1)) !== null)
    }

    // ---------- 7. 不可重试失败 → blocked，可被新改动唤醒 ----------
    {
      const store = createMemoryQueueStore()
      const a = await enqueuePush(store, { ...base, now: T0 })
      await claimNext(store, T0)
      await markFailed(store, a.id, { code: 'QUOTA_EXCEEDED', message: '空间不足', retryable: false }, T0 + 10)
      const blocked = (await store.get(a.id))!
      ok('不可重试失败进 blocked', blocked.state === 'blocked', JSON.stringify(blocked))
      ok('blocked 不会被自动领走', (await claimNext(store, T0 + 999_999)) === null)
      const woken = await enqueuePush(store, { ...base, now: T0 + 20 })
      ok('新改动把 blocked 唤醒成 pending', woken.state === 'pending' && woken.id === a.id, JSON.stringify(woken))
    }

    // ---------- 8. 已完成的清理 ----------
    {
      const store = createMemoryQueueStore()
      const a = await enqueuePush(store, { ...base, now: T0 })
      await markDone(store, a.id, 1, T0)
      ok('新鲜的成功任务先留着（回执丢失时可再确认）', (await pruneQueue(store, T0 + 1000)) === 0
        && (await store.all()).length === 1)
      const n = await pruneQueue(store, T0 + DONE_TTL_MS + 1)
      ok('超期后清掉', n === 1 && (await store.all()).length === 0, String(n))
    }

    // ---------- 9. 项目维度查询与解绑 ----------
    {
      const store = createMemoryQueueStore()
      await enqueuePush(store, { ...base, now: T0 })
      await enqueuePush(store, { ...base, projectId: 'p2', cloudProjectId: 'c2', now: T0 + 1 })
      ok('按项目查到自己的任务', (await pendingJobsOf(store, 'p1')).length === 1)
      const cleared = await clearProjectJobs(store, 'p1')
      ok('解绑清掉该项目的任务（避免带旧云端 id 反复失败）',
        cleared === 1 && (await pendingJobsOf(store, 'p1')).length === 0)
      ok('其他项目不受影响', (await pendingJobsOf(store, 'p2')).length === 1)
    }

    // ---------- 10. 退避封顶 ----------
    ok('退避指数增长', backoffFor(1, 1000) === 1000 && backoffFor(3, 1000) === 4000, `${backoffFor(1, 1000)},${backoffFor(3, 1000)}`)
    ok('退避有上限（不会算出"等几小时"）', backoffFor(30, 1000) === MAX_BACKOFF_MS, String(backoffFor(30, 1000)))

    // ---------- 11. 领任务顺序 ----------
    {
      const store = createMemoryQueueStore()
      await enqueuePush(store, { ...base, projectId: 'pB', cloudProjectId: 'cB', now: T0 + 2 })
      await enqueuePush(store, { ...base, projectId: 'pA', cloudProjectId: 'cA', now: T0 + 1 })
      const first = await claimNext(store, T0 + 10)
      ok('按入队时间先来先跑', first?.projectId === 'pA', first?.projectId)
    }

  // ---------- 12. 界面状态推导 ----------
  {
    const mk = (state: SyncJob['state'], lastCode?: string): SyncJob => ({
      id: 'x', projectId: 'p1', cloudProjectId: 'c1', baseRevision: 0,
      createdAt: 0, updatedAt: 0, state, attempts: 1, lastCode,
    })
    ok('跑着 → 同步中（优先于其他）', deriveStateFromJobs([mk('running'), mk('blocked')]) === 'syncing')
    ok('只有排队 → 排队中', deriveStateFromJobs([mk('pending')]) === 'queued')
    ok('有可重试失败 → 失败', deriveStateFromJobs([mk('failed')]) === 'failed')
    ok('基线不符的阻塞 → 冲突（文案不同）',
      deriveStateFromJobs([mk('blocked', 'BASELINE_MISMATCH')]) === 'conflict')
    ok('配额类阻塞 → 硬阻塞', deriveStateFromJobs([mk('blocked', 'QUOTA_EXCEEDED')]) === 'blocked')
    // 🔴 队列空不等于"已同步"：完成的记录会被清理，本层无从得知上次是否成功
    ok('队列空 → idle（不冒充已同步）', deriveStateFromJobs([]) === 'idle')
    ok('只剩已完成 → idle', deriveStateFromJobs([mk('done')]) === 'idle')
  }

  console.log(`\n▶ syncQueue: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
