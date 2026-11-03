// 3.3.2 · P3-1 同步状态机 · 单测
//
// 盯四件事：
//   ① 同步中不能被"又一次入队"刷回排队中（界面会显示成没在跑）；
//   ② 冲突没解决不能自动重跑（会反复撞 409）；
//   ③ 不可重试的失败必须进 blocked，不能沉到 failed 里被无限重试；
//   ④ 非法事件返回原状态，不抛（重复回调不该把同步跑挂）。
import {
  nextState, isTrouble, canAutoRetry, isDurable, eventFromOutcome,
  type SyncState, type SyncEvent,
} from '@/lib/sync/syncMachine'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const ALL_STATES: SyncState[] = ['idle', 'queued', 'syncing', 'synced', 'conflict', 'failed', 'blocked', 'offline']
const ALL_EVENTS: SyncEvent['type'][] = ['enqueue', 'start', 'finish', 'conflict', 'fail', 'offline', 'online', 'clear', 'reset']

function main() {
  // ---------- 1. 正常路径 ----------
  {
    let s: SyncState = 'idle'
    s = nextState(s, { type: 'enqueue' }); ok('未绑定→入队=排队中', s === 'queued', s)
    s = nextState(s, { type: 'start' }); ok('排队中→开始=同步中', s === 'syncing', s)
    s = nextState(s, { type: 'finish' }); ok('同步中→完成=已同步', s === 'synced', s)
    s = nextState(s, { type: 'enqueue' }); ok('已同步→再入队=排队中', s === 'queued', s)
  }

  // ---------- 2. 同步中不能被刷回排队中 ----------
  ok('同步中收到入队仍保持同步中', nextState('syncing', { type: 'enqueue' }) === 'syncing')
  ok('同步中收到完成不会被打断', nextState('syncing', { type: 'finish' }) === 'synced')

  // ---------- 3. 冲突不自动重跑 ----------
  ok('冲突态不接受 start（不自动重跑）', nextState('conflict', { type: 'start' }) === 'conflict')
  ok('冲突态收到 finish 也不变', nextState('conflict', { type: 'finish' }) === 'conflict')
  ok('冲突解除后回到排队中', nextState('conflict', { type: 'clear' }) === 'queued')

  // ---------- 4. 失败按 retryable 分叉 ----------
  ok('可重试失败→failed', nextState('syncing', { type: 'fail', retryable: true }) === 'failed')
  ok('不可重试失败→blocked', nextState('syncing', { type: 'fail', retryable: false }) === 'blocked')
  ok('blocked 不接受 start（需人工清除）', nextState('blocked', { type: 'start' }) === 'blocked')
  ok('blocked 清除后回 idle', nextState('blocked', { type: 'clear' }) === 'idle')
  ok('failed 可以自动再开始', nextState('failed', { type: 'start' }) === 'syncing')

  // ---------- 5. 离线不降级成失败 ----------
  ok('同步中断网→离线', nextState('syncing', { type: 'offline' }) === 'offline')
  ok('离线时失败仍留在离线', nextState('offline', { type: 'fail', retryable: true }) === 'offline')
  ok('离线恢复后可直接开始', nextState('offline', { type: 'start' }) === 'syncing')

  // ---------- 6. 非法组合返回原状态（不抛） ----------
  {
    let threw = ''
    for (const s of ALL_STATES) {
      for (const t of ALL_EVENTS) {
        try {
          const r = nextState(s, { type: t, retryable: true } as unknown as SyncEvent)
          if (!ALL_STATES.includes(r)) { threw = `非法返回 ${s}+${t}→${r}`; break }
        } catch (e) { threw = `${s}+${t} 抛了：${String(e)}`; break }
      }
      if (threw) break
    }
    ok('全部 8×9 组合都不抛且返回合法状态', threw === '', threw)
  }

  // ---------- 7. 辅助判据 ----------
  ok('冲突/失败/阻塞/离线算"需要提醒"', isTrouble('conflict') && isTrouble('failed') && isTrouble('blocked') && isTrouble('offline'))
  ok('已同步不算提醒', !isTrouble('synced') && !isTrouble('queued'))
  ok('只有 failed / offline 允许自动重试', canAutoRetry('failed') && canAutoRetry('offline')
    && !canAutoRetry('blocked') && !canAutoRetry('conflict'))
  // 🔴 blocked（配额满）绝不能被当成"已落云端"——那正是"写了一整晚白工"的成因
  ok('只有 synced / idle 算已落云端', isDurable('synced') && isDurable('idle')
    && !isDurable('blocked') && !isDurable('failed') && !isDurable('syncing'))

  // ---------- 8. 结局→事件 ----------
  ok('成功→finish', eventFromOutcome({ ok: true, status: 'published', revision: 1, snapshotId: 's' }).type === 'finish')
  ok('重放也算成功', eventFromOutcome({ ok: true, status: 'replayed', revision: 1, snapshotId: 's' }).type === 'finish')
  ok('冲突→conflict', eventFromOutcome({ ok: false, status: 'conflict', revision: 2 }).type === 'conflict')
  ok('配额→不可重试失败', (() => {
    const e = eventFromOutcome({ ok: false, status: 'quota' })
    return e.type === 'fail' ? e.retryable === false : false
  })())
  ok('网络错误→离线（不是失败）', eventFromOutcome({
    ok: false, status: 'error', code: 'NETWORK', message: 'x', retryable: true,
  }).type === 'offline')
  ok('哈希不符→不可重试失败', (() => {
    const e = eventFromOutcome({ ok: false, status: 'error', code: 'HASH_MISMATCH', message: 'x', retryable: false })
    return e.type === 'fail' && e.retryable === false
  })())

  // ---------- 9. 解绑/换账号 ----------
  ok('任何状态 reset 都回 idle', ALL_STATES.every((s) => nextState(s, { type: 'reset' }) === 'idle'))

  console.log(`\n▶ syncMachine: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
