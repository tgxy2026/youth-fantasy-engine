// ============ 通用流程状态机的回归用例 ============
//
// lib/flow/pipeline.ts 是「一键拆书」与「创意写作」共用的调度层。它的价值全在**边界行为**上：
// 顺序、加权进度、中止后已完成产物的保留（能续跑的前提）、外部 signal 联动。
// 这些错一个都不会让 tsc 或界面报错，只会在真跑长途任务时表现为「进度乱跳 / 中止了还在跑 / 续跑丢结果」。
import { createFlow } from '../src/lib/flow/pipeline'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ---------- ① 顺序执行、产物按阶段 id 进 bag ----------
{
  const order: string[] = []
  const flow = createFlow([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])
  flow.on('a', async () => { order.push('a'); return 1 })
  flow.on('b', async ctx => { order.push('b'); return (ctx.bag.a as number) + 1 })
  const res = await flow.run()
  ok('阶段按声明顺序执行', order.join(',') === 'a,b', order.join(','))
  ok('全部完成 → status=done', res.status === 'done', res.status)
  ok('产物按阶段 id 存进 bag（后序阶段能读到前序产物）', res.bag.a === 1 && res.bag.b === 2, `${res.bag.a},${res.bag.b}`)
  ok('完成时总进度=1', res.progress.ratio === 1, String(res.progress.ratio))
  ok('message 为完成态', res.progress.message === '已完成', res.progress.message)
}

// ---------- ② 进度按阶段权重加权（避免进度条「卡 5% 然后跳 90%」） ----------
{
  const snaps: number[] = []
  const flow = createFlow(
    [{ id: 'x', label: 'X', weight: 1 }, { id: 'y', label: 'Y', weight: 3 }],
    { onProgress: p => snaps.push(p.ratio) },
  )
  flow.on('x', async ctx => { ctx.report(0.5); return null })
  flow.on('y', async ctx => { ctx.report(1); return null })
  await flow.run()
  // x 权重 1 / 总权重 4，x 报 0.5 → 0.5/4 = 0.125
  ok('加权：轻阶段半程只贡献 1/8', snaps.some(v => Math.abs(v - 0.125) < 1e-9), snaps.map(v => v.toFixed(3)).join(','))
  ok('加权：总进度最终到 1', snaps[snaps.length - 1] === 1)
  ok('进度回调至少被调用 4 次（阶段起止各一次）', snaps.length >= 4, String(snaps.length))
}

// ---------- ③ 未登记执行体的阶段记为 skipped（不是卡住不动） ----------
{
  const flow = createFlow([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])
  flow.on('a', async () => null)
  const res = await flow.run()
  ok('未登记阶段 → skipped', res.progress.stages.find(s => s.id === 'b')?.status === 'skipped',
    res.progress.stages.find(s => s.id === 'b')?.status)
}

// ---------- ④ 中止：状态归 cancelled、已完成阶段产物保留、后续阶段不执行 ----------
{
  const flow = createFlow([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])
  flow.on('a', async () => { flow.abort(); return 'A-产物' })
  flow.on('b', async () => '不应执行')
  const res = await flow.run()
  ok('中止 → status=cancelled', res.status === 'cancelled', res.status)
  ok('🔴 中止后已完成阶段的产物仍保留（这是「续跑」的前提）', res.bag.a === 'A-产物', String(res.bag.a))
  ok('中止后不再执行后续阶段', res.bag.b === undefined, String(res.bag.b))
  ok('未执行的阶段被标为 cancelled（界面不会停在「待执行」）',
    res.progress.stages.every(s => s.status !== 'pending'), res.progress.stages.map(s => s.status).join(','))
}

// ---------- ⑤ 阶段抛错 → status=error，错误消息带出，后续不执行 ----------
{
  const flow = createFlow([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])
  flow.on('a', async () => { throw new Error('模型连接失败') })
  flow.on('b', async () => 'B')
  const res = await flow.run()
  ok('阶段抛错 → status=error', res.status === 'error', res.status)
  ok('错误消息透传给调用方', res.error === '模型连接失败', String(res.error))
  ok('出错阶段本身标 failed', res.progress.stages[0].status === 'failed', res.progress.stages[0].status)
  ok('出错后不执行后续阶段', res.bag.b === undefined)
}

// ---------- ⑤b AbortError 归入 cancelled（而非 error）—— 界面不该为「用户主动中止」弹红字 ----------
{
  const flow = createFlow([{ id: 'a', label: 'A' }])
  flow.on('a', async () => {
    const e = new Error('aborted')
    e.name = 'AbortError'
    throw e
  })
  const res = await flow.run()
  ok('AbortError → cancelled（不是 error）', res.status === 'cancelled', res.status)
}

// ---------- ⑥ run(from)：跳过前序阶段、保留预置产物（续跑） ----------
{
  const ran: string[] = []
  const flow = createFlow(
    [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    { bag: { a: '上次跑出的产物' } },
  )
  flow.on('a', async () => { ran.push('a'); return '重跑产物' })
  flow.on('b', async ctx => { ran.push('b'); return ctx.bag.a })
  const res = await flow.run('b')
  ok('续跑不重跑前序阶段', !ran.includes('a'), ran.join(','))
  ok('续跑保留预置产物（前序结果没丢）', res.bag.a === '上次跑出的产物', String(res.bag.a))
  ok('续跑起点之前的阶段标 skipped', res.progress.stages.find(s => s.id === 'a')?.status === 'skipped')
  ok('续跑从 from 开始执行（读到上一轮产物）', res.bag.b === '上次跑出的产物', String(res.bag.b))
}

// ---------- ⑦ 外部 signal（界面「中止」按钮）与内部 controller 联动 ----------
{
  const ctl = new AbortController()
  const flow = createFlow([{ id: 'a', label: 'A' }], { signal: ctl.signal })
  flow.on('a', async () => { ctl.abort(); return 1 })
  const res = await flow.run()
  ok('外部 signal 中止生效', res.status === 'cancelled', res.status)
}
{
  const ctl = new AbortController()
  ctl.abort() // 进来之前就已中止
  const ran: string[] = []
  const flow = createFlow([{ id: 'a', label: 'A' }], { signal: ctl.signal })
  flow.on('a', async () => { ran.push('a'); return 1 })
  const res = await flow.run()
  ok('传入已中止的 signal → 阶段根本不执行', ran.length === 0 && res.status === 'cancelled', ran.join(','))
}

// ---------- ⑧ snapshot() 是快照，不随后续状态变化（否则界面拿到的是"活引用"） ----------
{
  const flow = createFlow([{ id: 'a', label: 'A' }])
  flow.on('a', async () => null)
  const before = flow.snapshot()
  await flow.run()
  ok('snapshot() 返回的是快照而非活引用', before.stages[0].status === 'pending' && before.status === 'idle',
    `${before.status}/${before.stages[0].status}`)
}

// ---------- ⑨ skipRest：条件提前结束剩余阶段（创意写作「只保存大纲」靠它） ----------
{
  const ran: string[] = []
  const flow = createFlow([
    { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' },
  ])
  flow.on('a', async () => { ran.push('a'); return 1 })
  flow.on('b', async ctx => { ran.push('b'); ctx.skipRest('（已选择：只生成大纲）'); return 2 })
  flow.on('c', async () => { ran.push('c'); return 3 })
  const res = await flow.run()
  const [stA, stB, stC] = res.progress.stages
  ok('skipRest：被跳过的阶段不执行', ran.join(',') === 'a,b', ran.join(','))
  ok('🔴 skipRest：剩余阶段记 skipped 而非 done（界面不能谎称正文写了）', stC.status === 'skipped', stC.status)
  ok('skipRest：触发它的那个阶段照常算完成', stB.status === 'done', stB.status)
  ok('skipRest：跳过原因写进 detail（说明"为什么没跑"）', stC.detail === '（已选择：只生成大纲）', stC.detail)
  ok('skipRest：流程整体仍是 done（正常收尾，不是中止/失败）', res.status === 'done', res.status)
  ok('skipRest：跳过的阶段不产出 bag 条目', res.bag.a === 1 && res.bag.b === 2 && !('c' in res.bag),
    JSON.stringify(res.bag))
  ok('🔴 skipRest：进度不因跳过而卡住（skipped 计入已完成）', res.progress.ratio === 1, String(res.progress.ratio))
  ok('skipRest：先前阶段状态未被改写', stA.status === 'done', stA.status)
}
{
  // 边界：最后一个阶段喊 skipRest —— 后面没阶段可跳，不能因此把流程判成异常
  const flow = createFlow([{ id: 'a', label: 'A' }])
  flow.on('a', async ctx => { ctx.skipRest('后面没阶段了'); return 1 })
  const res = await flow.run()
  ok('skipRest：在最后一个阶段调用 → 无副作用',
    res.status === 'done' && res.progress.stages[0].status === 'done',
    `${res.status}/${res.progress.stages[0].status}`)
}
{
  // 边界：skipRest 与「未登记执行体」的 skipped 走的是同一条通路 —— 别互相踩
  const flow = createFlow([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])
  flow.on('a', async ctx => { ctx.skipRest(); return 1 })
  const res = await flow.run()
  ok('skipRest：不给原因时用兜底文案（detail 不为空，界面不显示空白）',
    res.progress.stages[1].status === 'skipped' && res.progress.stages[1].detail === '（已跳过）',
    res.progress.stages[1].detail)
}

console.log(`\n—— flowPipeline 用例结束：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
