// ============ 跨页签任务中心 · 单测（2.6.3）============
//
// 钉住任务状态机里最容易翻车、且**直接对应社区反馈**的几件事：
//   ① 任务跑在 store 里 —— 组件卸载（切页签）不影响它，结果也不丢；
//   ② 中止**只能**由用户显式触发，且中止后不该被记成「完成」；
//   ③ 真并行（拍板项）：不同页签的任务**同时**在跑，互不排队；
//   ④ 「切页签仍在跑」的提示**同一任务只提示一次**；
//   ⑤ 完成 / 失败的提示由 store 发（作者可能已在别的页签，面板根本没挂载）。
import {
  abortAllTasks, abortTask, clearFinishedTasks, consumeTaskNotice, dismissTask,
  markTaskSeen, noticeSnapshot, resetTaskCenter, runningTaskCount, startTask,
  subscribeTasks, takeUnnotifiedRunning, tasksSnapshot, unreadTaskCount,
} from '../src/lib/aiTaskCenter'

/** 本测试用的进度形状（真实场景 = 拆书的 `FlowProgress`） */
interface TestProgress { message?: string; ratio?: number }

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 让微任务 / 定时器跑一轮（startTask 是 fire-and-forget 的异步执行） */
const tick = () => new Promise<void>(r => setTimeout(r, 0))

/** 可手动控制何时结束的任务（测「运行中」的各种中间态） */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** 取走一次性提示（读快照 → 消费） */
function takeNotice() {
  const n = noticeSnapshot()
  if (n) consumeTaskNotice()
  return n
}

async function main() {
  // ---------- 起任务：状态流转 ----------
  {
    resetTaskCenter()
    const d = deferred<string>()
    const id = startTask({
      ownerTab: 'bookbreak', kind: 'bookbreak', title: '一键拆书',
      run: async () => d.promise,
    })
    ok('startTask 返回任务 id', typeof id === 'string' && id !== null && id.length > 0)
    ok('任务立即进入 running', tasksSnapshot()[0]?.status === 'running')
    ok('runningTaskCount = 1', runningTaskCount() === 1)
    ok('未完成时 unreadTaskCount = 0', unreadTaskCount() === 0)
    ok('运行中 ⇒ 需要「切页签」提示', takeUnnotifiedRunning().length === 1)

    d.resolve('产物')
    await tick()
    const t = tasksSnapshot()[0]
    ok('完成后 status = done', t.status === 'done', t.status)
    ok('结果原样保存', t.result === '产物', String(t.result))
    ok('完成后标「未查看」', t.unread === true)
    ok('unreadTaskCount = 1', unreadTaskCount() === 1)
    ok('runningTaskCount 归零', runningTaskCount() === 0)
    const n = takeNotice()
    ok('完成时 store 自己弹了提示', !!n && n.text.includes('一键拆书'), n?.text)
    ok('已结束的任务不再需要提示', takeUnnotifiedRunning().length === 0)
  }

  // ---------- 取消「未查看」标记 ----------
  {
    resetTaskCenter()
    const id = startTask({ ownerTab: 't1', kind: 'k', title: '任务', run: async () => 1 })!
    await tick()
    takeNotice()
    markTaskSeen(id)
    ok('markTaskSeen 清掉 unread', tasksSnapshot()[0].unread === false)
    ok('unreadTaskCount 归零', unreadTaskCount() === 0)
  }

  // ---------- 进度上报 ----------
  {
    resetTaskCenter()
    const d = deferred<void>()
    let ctxProgress!: (p: TestProgress | null) => void
    startTask<void, TestProgress>({
      ownerTab: 't1', kind: 'k', title: '任务',
      run: async ctx => { ctxProgress = ctx.progress; await d.promise },
    })
    ctxProgress({ message: '第 3/12 章', ratio: 0.25 })
    ok('进度写进任务记录', (tasksSnapshot()[0].progress as TestProgress | null)?.message === '第 3/12 章')
    d.resolve()
    await tick()
    // 🔴 跑完**不清空**进度：拆书页的 WorkflowTimeline 靠它显示"跑完每一步做了什么、
    //    花了多久"（清掉就只剩空白，作者事后没法复盘）。
    ok('结束后进度仍保留（供时间线事后复盘）',
      (tasksSnapshot()[0].progress as TestProgress | null)?.message === '第 3/12 章')
  }

  // ---------- 断点回传 ----------
  {
    resetTaskCenter()
    const d = deferred<void>()
    let setResume!: (r: unknown) => void
    startTask<void, TestProgress>({
      ownerTab: 't1', kind: 'k', title: '任务',
      run: async ctx => { setResume = ctx.setResume; await d.promise },
    })
    setResume({ from: 'extract', doneUnits: 7, label: '已抽 7 块' })
    ok('断点写进任务记录', (tasksSnapshot()[0].resume as { doneUnits?: number } | null)?.doneUnits === 7)
    d.resolve()
    await tick()
    ok('断点在中止/完成后仍留在记录里（面板据此显示「继续」）',
      (tasksSnapshot()[0].resume as { doneUnits?: number } | null)?.doneUnits === 7)
  }

  // ---------- 失败 ----------
  {
    resetTaskCenter()
    startTask({ ownerTab: 't1', kind: 'k', title: '任务', run: async () => { throw new Error('模型超时') } })
    await tick()
    const t = tasksSnapshot()[0]
    ok('抛错 → status = failed', t.status === 'failed', t.status)
    ok('错误原因如实记录', t.error === '模型超时', t.error)
    ok('失败不算「待查看」', t.unread === false)
    const n = takeNotice()
    ok('失败提示带原因', !!n && n.kind === 'error' && n.text.includes('模型超时'), n?.text)
  }

  // ---------- 中止：只有显式中止才停 ----------
  {
    resetTaskCenter()
    const d = deferred<string>()
    const id = startTask({
      ownerTab: 'bookbreak', kind: 'bookbreak', title: '一键拆书',
      // 编排器通常会在 signal 上抛 AbortError；这里刻意**忽略信号正常 resolve**，
      // 验证「信号已中止 ⇒ 一律记 aborted、结果作废」这条兜底。
      run: async () => d.promise,
    })!
    abortTask(id)
    d.resolve('不该保留的产物')
    await tick()
    const t = tasksSnapshot()[0]
    ok('🔴 信号中止后即使正常返回也记 aborted', t.status === 'aborted', t.status)
    ok('🔴 中止的结果被丢弃（不给出可疑产物）', t.result === null, String(t.result))
    ok('中止不算「待查看」', t.unread === false)
    ok('🔴 中止不弹提示（是作者自己按的）', takeNotice() === null)
  }

  // ---------- 编排器抛 AbortError ----------
  {
    resetTaskCenter()
    startTask({
      ownerTab: 't1', kind: 'k', title: '任务',
      run: async () => { const e = new Error('已中止'); e.name = 'AbortError'; throw e },
    })
    await tick()
    ok('AbortError → aborted（不是 failed）', tasksSnapshot()[0].status === 'aborted', tasksSnapshot()[0].status)
    ok('AbortError 不弹错误提示', takeNotice() === null)
  }

  // ---------- 真并行（拍板项）：不同页签同时跑 ----------
  {
    resetTaskCenter()
    const a = deferred<void>(); const b = deferred<void>()
    startTask({ ownerTab: 'bookbreak', kind: 'bookbreak', title: '拆书', run: async () => a.promise })
    startTask({ ownerTab: 'organize', kind: 'organize', title: 'AI 整理', run: async () => b.promise })
    ok('🔴 两个任务同时在跑（不排队）', runningTaskCount() === 2, String(runningTaskCount()))
    ok('列表里各有各的记录', tasksSnapshot().length === 2)
    a.resolve(); b.resolve()
    await tick()
    ok('各自独立收尾', tasksSnapshot().every(t => t.status === 'done'))
    ok('两个「待查看」都在', unreadTaskCount() === 2, String(unreadTaskCount()))
  }

  // ---------- 同页签同类拒绝重复发起 ----------
  {
    resetTaskCenter()
    const d = deferred<void>()
    const first = startTask({ ownerTab: 'bookbreak', kind: 'bookbreak', title: '拆书', run: async () => d.promise })
    const dup = startTask({ ownerTab: 'bookbreak', kind: 'bookbreak', title: '拆书', run: async () => d.promise })
    ok('🔴 同页签同类运行中 → 拒绝第二次发起', dup === null)
    ok('只留一条记录', tasksSnapshot().length === 1)
    d.resolve()
    await tick()
    ok('第一次的任务仍正常完成', tasksSnapshot()[0].status === 'done' && tasksSnapshot()[0].id === first)
  }

  // ---------- 重跑会折叠上一条同页签同类记录 ----------
  {
    resetTaskCenter()
    startTask({ ownerTab: 'bookbreak', kind: 'bookbreak', title: '拆书', run: async () => 1 })
    await tick()
    ok('第一次完成 → 1 条记录', tasksSnapshot().length === 1)
    takeNotice()
    startTask({ ownerTab: 'bookbreak', kind: 'bookbreak', title: '拆书', run: async () => 2 })
    await tick()
    ok('🔴 重跑后仍只 1 条（旧记录被折叠，不刷屏）', tasksSnapshot().length === 1, String(tasksSnapshot().length))
    ok('留下的是新任务的结果', tasksSnapshot()[0].result === 2)

    // 换页签的任务不受影响
    startTask({ ownerTab: 'organize', kind: 'organize', title: '整理', run: async () => 3 })
    await tick()
    ok('别的页签的记录不被折叠', tasksSnapshot().length === 2)
  }

  // ---------- 切页签提示：同一任务只提示一次 ----------
  {
    resetTaskCenter()
    const d = deferred<void>()
    startTask({ ownerTab: 'bookbreak', kind: 'bookbreak', title: '一键拆书', run: async () => d.promise })
    const first = takeUnnotifiedRunning()
    ok('第一次取到 1 条待提示', first.length === 1 && first[0].title === '一键拆书')
    ok('🔴 第二次取不到（同一任务只提示一次）', takeUnnotifiedRunning().length === 0)
    d.resolve()
    await tick()
    takeNotice()
    ok('已结束的任务不再需要提示', takeUnnotifiedRunning().length === 0)
  }

  // ---------- 移除 / 清空 ----------
  {
    resetTaskCenter()
    const d = deferred<void>()
    const running = startTask({ ownerTab: 't1', kind: 'k', title: '跑着的', run: async () => d.promise })!
    ok('🔴 运行中的任务不允许移除', dismissTask(running) === false)
    startTask({ ownerTab: 't2', kind: 'k', title: '完成的', run: async () => 1 })
    await tick()
    const done = tasksSnapshot().find(t => t.ownerTab === 't2')!
    ok('已结束的可以移除', dismissTask(done.id) === true)
    ok('移除后只剩运行中的那条', tasksSnapshot().length === 1 && tasksSnapshot()[0].id === running)
    clearFinishedTasks()
    ok('clearFinishedTasks 不动运行中的', tasksSnapshot().length === 1)
    d.resolve()
    await tick()
    clearFinishedTasks()
    ok('结束后可被清空', tasksSnapshot().length === 0)
  }

  // ---------- 退出项目：全部中止 ----------
  {
    resetTaskCenter()
    const d = deferred<void>()
    startTask({ ownerTab: 't1', kind: 'k', title: '跑着的', run: async () => d.promise })
    abortAllTasks()
    d.resolve()
    await tick()
    ok('abortAllTasks 把运行中的记成 aborted', tasksSnapshot()[0].status === 'aborted', tasksSnapshot()[0].status)

    startTask({ ownerTab: 't1', kind: 'k2', title: 'x', run: async () => d.promise })
    resetTaskCenter()
    ok('resetTaskCenter 清空列表', tasksSnapshot().length === 0)
    await tick()
    ok('清空后晚到的回调不会复活任务', tasksSnapshot().length === 0)
  }

  // ---------- 自定义提示文案 ----------
  {
    resetTaskCenter()
    startTask({
      ownerTab: 'bookbreak', kind: 'bookbreak', title: '一键拆书',
      run: async () => 42,
      notify: ({ status, result }) => (status === 'done' ? { text: `拆书完成 —— 设定草稿 ${result} 条`, kind: 'success' } : null),
    })
    await tick()
    const n = takeNotice()
    ok('🔴 用任务自定义文案（而非通用文案）', n?.text === '拆书完成 —— 设定草稿 42 条', n?.text)
    ok('消费后清空', takeNotice() === null)
  }

  // ---------- 订阅：变更会通知 ----------
  {
    resetTaskCenter()
    let hits = 0
    const un = subscribeTasks(() => { hits++ })
    startTask({ ownerTab: 't1', kind: 'k', title: 'x', run: async () => 1 })
    await tick()
    ok('订阅者在任务变更时被通知', hits > 0, String(hits))
    un()
    const before = hits
    startTask({ ownerTab: 't2', kind: 'k', title: 'y', run: async () => 1 })
    await tick()
    ok('退订后不再收到通知', hits === before, `${before} → ${hits}`)
  }

  console.log(`\naiTaskCenter: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
