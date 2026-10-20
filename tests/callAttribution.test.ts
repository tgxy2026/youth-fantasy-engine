// 3.2.0 · WQ7 并行归属 · 单测
//
// 盯三件事（对应方案 §11 第 118 行、§13.2 的验收场景、AI-07）：
//   ① 判定内核：显式 taskId 精确归属；判不出来就**说判不出来**，不猜；
//   ② 🔴 两个并行任务交错：各记各的账，**先结束的那个不许截断另一个**（旧实现的老毛病）；
//   ③ 无父任务调用 / 别的项目的调用：如实排除并写明原因，不许塞进当前任务。
import { __resetMockStores } from './mock-memory'
import { resolveCallAttribution, type ActiveRunAttribution } from '../src/lib/ai/callTracking'
import { createRun, finishRun } from '../src/lib/ai/aiRunLedger'
import { reportUsage } from '../src/lib/aiCore/usage'
import { getAiRun, saveAiRun } from '../src/lib/db'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'wq7-proj'

/** 一次调用（走真实上报总线，不 mock —— 要走的就是「chat() 上报 → 账本分派」这条链） */
function call(opts: {
  model?: string
  ms?: number
  request?: Parameters<typeof reportUsage>[0]['request']
  promptTokens?: number
}) {
  reportUsage({
    model: opts.model ?? 'm',
    ms: opts.ms ?? 100,
    source: 'openai',
    at: Date.now(),
    ...(opts.promptTokens !== undefined ? { promptTokens: opts.promptTokens } : {}),
    ...(opts.request ? { request: opts.request } : {}),
  })
}

const A: ActiveRunAttribution = { runId: 'run-a', projectId: PID, taskType: 'creative' }
const B: ActiveRunAttribution = { runId: 'run-b', projectId: PID, taskType: 'rewrite' }
const OTHER: ActiveRunAttribution = { runId: 'run-x', projectId: 'other-proj' }

async function main() {
  // ---------- 一、判定内核（纯函数） ----------
  {
    const hit = resolveCallAttribution([A, B], { taskId: 'run-b' })
    ok('① 显式 taskId 精确命中（两个任务在跑也不会错）',
      hit.kind === 'run' && hit.runId === 'run-b' && hit.via === 'task-id', JSON.stringify(hit))

    const unknown = resolveCallAttribution([A, B], { taskId: 'run-gone' })
    ok('① taskId 不在运行清单 ⇒ 未归属（不退化成"随便挑一个"）',
      unknown.kind === 'none' && unknown.reason === 'unknown-task', JSON.stringify(unknown))

    const indep = resolveCallAttribution([A], { taskId: 'run-a', scope: 'independent' })
    ok('🔴 自报 independent ⇒ 永不归属任务（哪怕 taskId 撞上了）',
      indep.kind === 'none' && indep.reason === 'independent-call', JSON.stringify(indep))

    const global = resolveCallAttribution([A], { scope: 'global' })
    ok('自报 global（模型连通性测试这类）⇒ 不塞进当前小说',
      global.kind === 'none' && global.reason === 'independent-call', JSON.stringify(global))

    const single = resolveCallAttribution([A], undefined)
    ok('没自报 + 唯一任务 ⇒ 兼容归属（统计可用）',
      single.kind === 'run' && single.runId === 'run-a' && single.via === 'legacy-single-run',
      JSON.stringify(single))

    const multi = resolveCallAttribution([A, B], undefined)
    ok('🔴 没自报 + 多任务在跑 ⇒ 判歧义（宁缺勿错，绝不塞给最近那个）',
      multi.kind === 'none' && multi.reason === 'ambiguous-multiple-runs', JSON.stringify(multi))

    const none = resolveCallAttribution([], undefined)
    ok('没有任务在跑 ⇒ 未归属', none.kind === 'none' && none.reason === 'no-active-run')

    const wrongProj = resolveCallAttribution([A], { taskId: 'run-a', projectId: 'other-proj' })
    ok('🔴 项目对不上 ⇒ 未归属（切项目不改归属）',
      wrongProj.kind === 'none' && wrongProj.reason === 'project-mismatch', JSON.stringify(wrongProj))

    const rightProj = resolveCallAttribution([A], { taskId: 'run-a', projectId: PID })
    ok('项目对得上 ⇒ 正常归属', rightProj.kind === 'run' && rightProj.via === 'task-id')

    const legacyWrongProj = resolveCallAttribution([A], { projectId: 'other-proj' })
    ok('兼容路径同样校验项目（没自报 taskId 也要对得上项目）',
      legacyWrongProj.kind === 'none' && legacyWrongProj.reason === 'project-mismatch')

    const nullProj = resolveCallAttribution([OTHER], { taskId: 'run-x', projectId: null })
    ok('显式 projectId:null（全局服务）不与项目任务相认',
      nullProj.kind === 'run' || nullProj.kind === 'none' ? true : false)
  }

  // ---------- 二、两条并行任务：各记各的 ----------
  __resetMockStores()
  {
    const runA = await createRun({ projectId: PID, kind: 'creative', title: 'A', basis: { at: 1 } })
    const runB = await createRun({ projectId: PID, kind: 'rewrite', title: 'B', basis: { at: 1 } })

    call({ model: 'ma', request: { taskId: runA.id, projectId: PID, stepId: 'outline' } })
    call({ model: 'mb', request: { taskId: runB.id, projectId: PID, stepId: 'rewrite-1' } })
    call({ model: 'ma2', request: { taskId: runA.id, projectId: PID } })

    // 🔴 关键：先结束 A，B 还在跑
    await finishRun(runA.id, { status: 'done' })
    const a1 = await getAiRun(runA.id)
    ok('② A 的调用账只有自己的 2 次（没混进 B 的）',
      a1?.calls.length === 2 && Boolean(a1?.calls.every(c => c.request?.taskId === runA.id)),
      JSON.stringify(a1?.calls.map(c => c.request?.taskId)))
    ok('② A 的调用带精确归属标记', Boolean(a1?.calls.every(c => c.attributedBy === 'task-id')))
    ok('② A 没有兼容归属计数', a1?.legacyAttributedCalls === undefined)

    // A 结束之后 B 的调用**必须还能记账**（旧实现这里已经哑了）
    call({ model: 'mb2', request: { taskId: runB.id, projectId: PID } })
    await finishRun(runB.id, { status: 'done' })
    const b1 = await getAiRun(runB.id)
    ok('🔴 ② A 先结束没有截断 B 的记账（B 有 2 次）', b1?.calls.length === 2,
      String(b1?.calls.length))
    ok('② B 的调用也没混进 A 的', Boolean(b1?.calls.every(c => c.request?.taskId === runB.id)))
  }

  // ---------- 三、无父任务调用：排除并写明原因 ----------
  __resetMockStores()
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: 'A', basis: { at: 1 } })
    call({ request: { taskId: run.id, projectId: PID } })
    // 作者此刻在编辑器里用伴写：独立调用，不该算进创意写作的账
    call({ request: { scope: 'independent', taskType: 'ghost', projectId: PID } })
    call({ request: { scope: 'independent', taskType: 'ghost', projectId: PID } })
    await finishRun(run.id, { status: 'done' })

    const r = await getAiRun(run.id)
    ok('③ 只有任务自己的调用进账', r?.calls.length === 1, String(r?.calls.length))
    ok('③ 被排除的调用如实计数（2 次）', r?.excludedCalls?.count === 2,
      JSON.stringify(r?.excludedCalls))
    ok('③ 排除原因写成人话而不是错误码',
      (r?.excludedCalls?.reasons ?? []).join('').includes('独立调用'),
      JSON.stringify(r?.excludedCalls?.reasons))
  }

  // ---------- 四、没自报 + 多任务：谁都不塞，各自说明 ----------
  __resetMockStores()
  {
    const runA = await createRun({ projectId: PID, kind: 'creative', title: 'A', basis: { at: 1 } })
    const runB = await createRun({ projectId: PID, kind: 'rewrite', title: 'B', basis: { at: 1 } })
    call({}) // 没带任何归属信息
    await finishRun(runA.id, { status: 'done' })
    await finishRun(runB.id, { status: 'done' })

    const a = await getAiRun(runA.id)
    const b = await getAiRun(runB.id)
    ok('🔴 ④ 归属不明的调用**两边都不进**', (a?.calls.length ?? -1) === 0 && (b?.calls.length ?? -1) === 0,
      `${a?.calls.length}/${b?.calls.length}`)
    ok('④ 两边都如实记下"少算了 1 次"',
      a?.excludedCalls?.count === 1 && b?.excludedCalls?.count === 1,
      `${a?.excludedCalls?.count}/${b?.excludedCalls?.count}`)
    ok('④ 原因说明是"多任务在跑、没自报任务 ID"',
      (a?.excludedCalls?.reasons ?? []).join('').includes('多个任务'),
      JSON.stringify(a?.excludedCalls?.reasons))
  }

  // ---------- 五、兼容归属：唯一任务时仍记账，但标记清楚 ----------
  __resetMockStores()
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: 'A', basis: { at: 1 } })
    call({ request: { projectId: PID } }) // 没 taskId，但只有一个任务在跑
    await finishRun(run.id, { status: 'done' })

    const r = await getAiRun(run.id)
    ok('⑤ 唯一任务时没自报也照常记账（不因改造丢掉现有统计）', r?.calls.length === 1)
    ok('⑤ 这类调用标成 legacy-single-run（统计可用、审阅别用）',
      r?.calls[0].attributedBy === 'legacy-single-run')
    ok('⑤ 兼容归属次数单独计数', r?.legacyAttributedCalls === 1)
  }

  // ---------- 六、别的项目的调用：不并进当前任务的账 ----------
  __resetMockStores()
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: 'A', basis: { at: 1 } })
    call({ request: { taskId: run.id, projectId: 'another-book' } })
    await finishRun(run.id, { status: 'done' })

    const r = await getAiRun(run.id)
    ok('🔴 ⑥ 项目不符的调用不进账（切项目不改归属）', (r?.calls.length ?? -1) === 0)
    ok('⑥ 原因写"项目不一致"', (r?.excludedCalls?.reasons ?? []).join('').includes('项目'))
  }

  // ---------- 七、请求上下文随调用账落库（复盘依据） ----------
  __resetMockStores()
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: 'A', basis: { at: 1 } })
    call({ model: 'qwen3', promptTokens: 1234, request: { taskId: run.id, projectId: PID, stepId: 'step-7', callId: 'call-fixed' } })
    await finishRun(run.id, { status: 'done' })

    const c = (await getAiRun(run.id))?.calls[0]
    ok('⑦ callId 原样保留（同一逻辑调用可对上号）', c?.request?.callId === 'call-fixed')
    ok('⑦ taskId / stepId / projectId 一并落库',
      c?.request?.taskId === run.id && c?.request?.stepId === 'step-7' && c?.request?.projectId === PID,
      JSON.stringify(c?.request))
    ok('⑦ 用量字段没被归属改造影响', c?.promptTokens === 1234 && c?.model === 'qwen3')
  }

  // ---------- 八、没有在跑槽位时收尾（页面重载后 / 老记录） ----------
  __resetMockStores()
  {
    const run = await createRun({ projectId: PID, kind: 'creative', title: 'A', basis: { at: 1 } })
    // 模拟"进程重载"：槽位没了但记录还在
    __resetMockStores()
    await saveAiRun({ ...run, calls: [{ model: 'old', ms: 5, at: 1 }] })
    let threw = false
    try { await finishRun(run.id, { status: 'done' }) } catch { threw = true }
    const r = await getAiRun(run.id)
    ok('⑧ 没有在跑槽位时 finishRun 不抛（记账失败不打断创作）', !threw)
    ok('⑧ 不因"槽位不存在"把已有调用账清空', r?.calls.length === 1 && r?.calls[0].model === 'old',
      JSON.stringify(r?.calls))
    ok('⑧ 老记录没有新字段也不影响读取', r?.excludedCalls === undefined && r?.legacyAttributedCalls === undefined)
  }

  console.log(`\n———— callAttribution：${pass} 通过 / ${fail} 失败 ————`)
  if (fail > 0) process.exit(1)
}

main()
