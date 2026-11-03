// ============ 3.3.3 · A4/B3 任务台账并发串行（源码级，非真实 IDB）============
//
// 钉住：
//   ① 有 Web Locks 时，同一任务两次接管**串行**执行：代次 1 → 2（不是两边都读到 0 并写 1）；
//   ② 没有 Web Locks 时不假装安全：接管直接拒绝（TaskExecutionLost），而不是"尽量跑"；
//   ③ 接管与丢弃并发也走同一把锁：丢弃后任务头不存在，且不抛未处理错误。
//
// 🔴 这是用**内存队列模拟** navigator.locks 的源码级证据，不等于真实 IndexedDB 多窗口验证；
//    真实 Edge 两标签页证据见验收复核记录 §续修，桌面/便携仍待单独检验。
import * as db from '../src/lib/db'
import { __resetMockStores, memoryOps } from './mock-memory'
import {
  TaskExecutionLost, claimTask, deleteTaskArtifacts, getTaskHead, saveTaskHead,
} from '../src/lib/db/taskLedger'
import type { TaskHead } from '../src/lib/tasks/unitLedger'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-task-concurrency'
const TASK = 't-concurrency'

function head(): TaskHead {
  return {
    id: TASK, kind: 'bookbreak-extract', projectId: PID, storageKey: 'k',
    inputFingerprint: 't1:x', configFingerprint: 'c1:y', protocolVersion: 1,
    modelTag: 'test/model', totalUnits: 3, status: 'pending', ownerId: '',
    generation: 0, createdAt: 1, updatedAt: 1, label: '',
  }
}

/** 极简 FIFO 互斥队列：语义与 navigator.locks 的 exclusive 请求一致（够本测试用） */
function installLock() {
  let tail: Promise<void> = Promise.resolve()
  const locks = {
    request: async <T>(_name: string, _opts: unknown, cb: () => Promise<T>): Promise<T> => {
      let release!: () => void
      const mine = new Promise<void>(r => { release = r })
      const prev = tail
      tail = mine
      await prev
      try { return await cb() } finally { release() }
    },
  }
  ;(globalThis as unknown as { window?: unknown }).window = globalThis
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true })
}

function removeLock() {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
}

async function main() {
  __resetMockStores()
  await memoryOps.put('projects', { id: PID, name: '并发', createdAt: 0, updatedAt: 0 })
  db.setCurrentProject(PID)
  await saveTaskHead(head())

  installLock()
  // 两次接管同时发起：没有锁时两边都会读到 generation 0 并写 1
  const [a, b] = await Promise.all([claimTask(TASK, 'w1'), claimTask(TASK, 'w2')])
  const gens = [a.head.generation, b.head.generation].sort((x, y) => x - y)
  ok('两次接管串行（代次 1、2）', gens[0] === 1 && gens[1] === 2, JSON.stringify(gens))
  const live = await getTaskHead(TASK)
  ok('最终头是第二个执行者', live?.ownerId === 'w2' && live?.generation === 2, `${live?.ownerId}/${live?.generation}`)
  ok('先到者拿到的是自己的代次', a.head.ownerId === 'w1' && b.head.ownerId === 'w2')

  // 没有 Web Locks：拒绝，而不是退化成"内存里各写各的"
  removeLock()
  let rejected: unknown = null
  try { await claimTask(TASK, 'w3') } catch (e) { rejected = e }
  ok('无 Web Locks 时拒绝接管', rejected instanceof TaskExecutionLost || (rejected as { name?: string })?.name === 'TaskExecutionLost',
    String(rejected))
  ok('拒绝后任务头没有被改', (await getTaskHead(TASK))?.generation === 2)

  // 接管 + 丢弃并发：同一把锁，丢弃后头不存在；不允许半删除残留
  installLock()
  await Promise.allSettled([claimTask(TASK, 'w4'), deleteTaskArtifacts(TASK)])
  ok('丢弃后任务头已清理', (await getTaskHead(TASK)) === undefined)

  // 还原全局，避免影响同进程后续加载（本文件独立进程，双保险）
  removeLock()
  delete (globalThis as unknown as { window?: unknown }).window

  console.log(`\ntaskLedgerConcurrency: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()