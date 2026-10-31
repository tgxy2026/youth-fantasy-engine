// ============ 3.3.3 · P1 长任务单元台账（A4 / B3 共用基础）============
//
// 钉住这几条（规划 §6.1 / §14.3 / 验收 A-06、B-04 的代码侧部分）：
//   ① 单元身份：原文 / 配置 / 协议 / 下标 / 单元文本，任一项变了就不能复用旧结果。
//   ② 恢复计划：默认只补 pending/interrupted/cancelled；failed **不自动重试**。
//   ③ 状态与产物同一条记录：先落盘再算成功；running 重启后降 interrupted。
//   ④ 执行权：generation 递增，旧执行者的回包一律拒绝。
//   ⑤ 配额：本机项目 5 个任务 / 单任务 20 MiB / 合计 50 MiB（按 UTF-8 实字节）。
//   ⑥ 清理：丢弃只删任务私有产物；删项目级联清理台账。
import * as db from '../src/lib/db'
import { __resetMockStores, memoryOps } from './mock-memory'
import {
  TASK_LIMITS, canTransition, configFingerprint, countUnits, decideTaskQuota, planUnitRun,
  reconcileOnLoad, recordBytes, stableHash, taskIdOf, textFingerprint, unitKeyOf,
  type TaskHead, type TaskUnit,
} from '../src/lib/tasks/unitLedger'
import {
  TaskExecutionLost, claimTask, deleteProjectTaskArtifacts, getTaskHead, listProjectTaskHeads,
  listTaskUnits, loadTask, saveTaskHead, saveTaskUnit, taskUsage,
} from '../src/lib/db/taskLedger'
import {
  bookBreakIdentity, bookBreakUnitKey, discardBookBreakTask, openBookBreakTask, previewBookBreakTask,
} from '../src/lib/bookbreak/taskStore'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const PID = 'p-task-ledger'
const TEXT = '第1章 起\n他叫陈渊，青岚宗外门弟子。\n第2章 承\n陈渊在藏经阁找到一卷残简。\n第3章 转\n青岚宗大比开始。\n'

function idOf(text: string, cfg: { titleSamples?: string } = {}) {
  return bookBreakIdentity(text, cfg, PID)
}

function mkHead(over: Partial<TaskHead> = {}): TaskHead {
  return {
    id: over.id ?? `t-${stableHash(String(Math.random()))}`,
    kind: 'bookbreak-extract',
    projectId: PID,
    storageKey: 'k',
    inputFingerprint: 't1:x',
    configFingerprint: 'c1:y',
    protocolVersion: 1,
    modelTag: 'test/model',
    totalUnits: over.totalUnits ?? 3,
    status: over.status ?? 'pending',
    ownerId: '',
    generation: 0,
    createdAt: 1,
    updatedAt: 1,
    label: '',
    ...over,
  }
}

async function main() {
  __resetMockStores()
  await memoryOps.put('projects', { id: PID, name: '台账测试', createdAt: 0, updatedAt: 0 })
  db.setCurrentProject(PID)

  // ───────────────── ① 指纹与身份 ─────────────────
  {
    ok('同文本指纹稳定', textFingerprint(TEXT) === textFingerprint(TEXT))
    ok('改一个字指纹就变', textFingerprint(TEXT) !== textFingerprint(TEXT.replace('陈渊', '陈源')))
    ok('配置指纹与键序无关',
      configFingerprint({ a: 1, b: 2 }) === configFingerprint({ b: 2, a: 1 }))
    ok('配置值变了指纹就变', configFingerprint({ a: 1 }) !== configFingerprint({ a: 2 }))
    const a = idOf(TEXT), b = idOf(TEXT), c = idOf(TEXT + '加一段'), d = idOf(TEXT, { titleSamples: '第N章' })
    ok('同项目同文本 ⇒ 同任务 id', a.taskId === b.taskId)
    ok('原文变了 ⇒ 另一个任务', a.taskId !== c.taskId)
    ok('抽取配置变了 ⇒ 另一个任务', a.taskId !== d.taskId)
    ok('任务 id 含 kind（不与别的任务类型混用）', a.taskId.startsWith('bookbreak-extract:'))
    ok('taskIdOf 是确定性推导（非随机）',
      taskIdOf({ kind: 'k', projectId: 'p', inputFingerprint: 'i', configFingerprint: 'c', protocolVersion: 1 })
      === taskIdOf({ kind: 'k', projectId: 'p', inputFingerprint: 'i', configFingerprint: 'c', protocolVersion: 1 }))
    const k0 = bookBreakUnitKey(a, 0, '第一块')
    ok('单元键含下标', k0 !== bookBreakUnitKey(a, 1, '第一块'))
    ok('单元键含单元文本', k0 !== bookBreakUnitKey(a, 0, '第二块'))
    ok('单元键含配置', k0 !== bookBreakUnitKey(d, 0, '第一块'))
  }

  // ───────────────── ② 状态机与恢复计划 ─────────────────
  {
    ok('pending 可以进 running', canTransition('pending', 'running'))
    ok('running 可以落成 succeeded/failed/interrupted',
      canTransition('running', 'succeeded') && canTransition('running', 'failed') && canTransition('running', 'interrupted'))
    ok('failed 可以再试（作者显式发起）', canTransition('failed', 'running'))
    ok('succeeded 是终态（不允许改回 running）', !canTransition('succeeded', 'running'))

    const raw: TaskUnit[] = [
      mkUnit({ index: 0, status: 'succeeded' }),
      mkUnit({ index: 1, status: 'running' }),
      mkUnit({ index: 2, status: 'failed' }),
    ]
    const rec = reconcileOnLoad(raw)
    ok('重启对账：running → interrupted', rec[1].status === 'interrupted')
    ok('对账不改原数组（纯函数）', raw[1].status === 'running')

    const units = [0, 1, 2, 3].map(i => ({ index: i, textFingerprint: `tf${i}`, chapterTitle: `第${i + 1}章` }))
    const identity = idOf(TEXT)
    const statuses: TaskUnit['status'][] = ['succeeded', 'interrupted', 'cancelled', 'failed']
    const existing = units.map(u => mkUnit({
      taskId: identity.taskId,
      index: u.index,
      unitKey: unitKeyOf({ inputFingerprint: identity.inputFingerprint, configFingerprint: identity.configFingerprint,
        protocolVersion: identity.protocolVersion, index: u.index, textFingerprint: u.textFingerprint }),
      status: statuses[u.index] ?? 'pending',
    }))
    const resume = planUnitRun({ units, existing, identity, mode: 'resume' })
    ok('继续：已成功的复用、不重跑', resume.reuse.join(',') === '0' && !resume.run.includes(0))
    ok('继续：中断与取消这次补跑', resume.run.includes(1) && resume.run.includes(2))
    ok('继续：失败单元**不自动重试**', !resume.run.includes(3) && resume.failed.join(',') === '3')

    const retry = planUnitRun({ units, existing, identity, mode: 'retry-failed' })
    ok('只重试失败：只跑 failed', retry.run.join(',') === '3' && retry.reuse.join(',') === '0')

    const fresh = planUnitRun({ units, existing, identity, mode: 'fresh' })
    ok('从头重跑：全部重跑', fresh.run.length === 4 && fresh.reuse.length === 0)

    // 键对不上（原文改了/参数变了）⇒ 旧结果作废，不能只按"下标已完成"跳过
    const staleExisting = [mkUnit({ taskId: identity.taskId, index: 0, unitKey: 'old-key', status: 'succeeded' })]
    const stale = planUnitRun({ units, existing: staleExisting, identity, mode: 'resume' })
    ok('旧键对不上 ⇒ 判过期并重跑', stale.stale.includes(0) && stale.run.includes(0) && stale.reuse.length === 0)
    ok('台账里多出来的旧单元也判过期',
      planUnitRun({ units: units.slice(0, 2), existing: [mkUnit({ taskId: identity.taskId, index: 9, unitKey: 'x', status: 'failed' })], identity, mode: 'resume' })
        .stale.includes(9))
  }

  // ───────────────── ③ 配额（纯函数）─────────────────
  {
    const heads = Array.from({ length: 5 }, () => ({ id: 'x', status: 'pending' as const }))
    ok('5 个任务后再新建被拒', !decideTaskQuota({ heads, projectBytes: 0, taskBytes: 0, projectedBytes: 0, creating: true }).ok)
    ok('已有任务继续写不受任务条数限制',
      decideTaskQuota({ heads, projectBytes: 0, taskBytes: 0, projectedBytes: 1, creating: false }).ok)
    ok('单任务超 20 MiB 被拒', !decideTaskQuota({
      heads: [], projectBytes: 0, taskBytes: TASK_LIMITS.maxBytesPerTask - 2, projectedBytes: 4, creating: false,
    }).ok)
    ok('项目合计超 50 MiB 被拒', !decideTaskQuota({
      heads: [], projectBytes: TASK_LIMITS.maxBytesPerProject - 2, taskBytes: 0, projectedBytes: 4, creating: false,
    }).ok)
    ok('中文按 UTF-8 实字节（3 字节/字）', recordBytes('中文') >= 6 + 2, String(recordBytes('中文')))
    ok('countUnits 分清各状态',
      countUnits([mkUnit({ status: 'succeeded' }), mkUnit({ status: 'failed' }), mkUnit({ status: 'interrupted' })], 3)
      .succeeded === 1)
  }

  // ───────────────── ④ 持久化：写、重开、执行权 ─────────────────
  {
    const identity = idOf(TEXT)
    const h = await openBookBreakTask({ identity, totalUnits: 3, modelTag: 'test/model', label: '0/3' })
    ok('任务台账可用（不会被降级成 null）', !!h)
    if (!h) throw new Error('台账不可用，后续断言无法进行')

    const key0 = bookBreakUnitKey(identity, 0, '第一块')
    const meta0 = { index: 0, key: key0, chapterTitle: '第1章' }
    await h.beginUnit(meta0)
    let units = await listTaskUnits(identity.taskId)
    ok('running 已落盘（崩溃后能看出"跑过但没收尾"）', units[0]?.status === 'running')
    await h.settleUnit(meta0, [{ type: '人物', name: '陈渊', desc: '', evidence: '他叫陈渊' }])
    units = await listTaskUnits(identity.taskId)
    ok('succeeded 与产物同在一条记录', units[0]?.status === 'succeeded' && Array.isArray(units[0]?.result))
    ok('记录带真实字节数（配额口径）', (units[0]?.bytes ?? 0) > 0)

    const meta2 = { index: 2, key: bookBreakUnitKey(identity, 2, '第三块'), chapterTitle: '第3章' }
    await h.beginUnit(meta2)
    await h.failUnit(meta2, 'parse-invalid')
    await h.finish('pending', '1/3 · 失败 1')
    const snap = await loadTask(identity.taskId)
    ok('失败单元记原因码（不含原文）', snap?.units.find(u => u.index === 2)?.failure === 'parse-invalid')
    ok('任务头停在 pending（还有失败/待跑）', snap?.head.status === 'pending')

    // 执行权：第二个执行者接管后，第一个的回包必须被拒绝
    const h2 = await openBookBreakTask({ identity, totalUnits: 3, modelTag: 'test/model', label: '1/3' })
    ok('重新打开会递增执行代次', !!h2 && h2.head.generation === h.head.generation + 1)
    let lost = false
    try {
      await h.settleUnit({ index: 1, key: bookBreakUnitKey(identity, 1, '第二块'), chapterTitle: '第2章' }, [])
    } catch (e) {
      lost = e instanceof TaskExecutionLost
    }
    ok('旧执行者的晚回包被拒绝（TaskExecutionLost）', lost)

    // 只重试失败：用持久化结果算出的计划
    const preview = await previewBookBreakTask(identity)
    ok('预览能读到历史进度（不 claim）', !!preview && preview.counts.succeeded === 1 && preview.counts.failed === 1)
    const unitTexts = ['第一块', '第二块', '第三块']
    const plan = planUnitRun({
      units: unitTexts.map((t, i) => ({ index: i, textFingerprint: textFingerprint(t), chapterTitle: `第${i + 1}章` })),
      existing: await listTaskUnits(identity.taskId),
      identity,
      mode: 'retry-failed',
    })
    ok('重试计划只含失败单元', plan.run.join(',') === '2', plan.run.join(','))

    const usage = await taskUsage(PID)
    ok('项目用量按任务归集', (usage.byTask[identity.taskId] ?? 0) > 0)

    await discardBookBreakTask(identity.taskId)
    ok('丢弃后台账清空', !(await getTaskHead(identity.taskId)) && (await listTaskUnits(identity.taskId)).length === 0)
  }

  // ───────────────── ⑤ 配额落盘口径 + 删项目级联 ─────────────────
  {
    __resetMockStores()
    await memoryOps.put('projects', { id: PID, name: '台账测试', createdAt: 0, updatedAt: 0 })
    db.setCurrentProject(PID)

    for (let i = 0; i < TASK_LIMITS.maxTasksPerProject; i++) {
      await saveTaskHead(mkHead({ id: `head-${i}` }))
    }
    ok('5 个任务头已登记', (await listProjectTaskHeads(PID)).length === 5)
    let quota = ''
    try {
      await openBookBreakTask({ identity: idOf(TEXT + '另一份'), totalUnits: 1, modelTag: '', label: '' })
    } catch (e) {
      quota = e instanceof Error ? e.message : String(e)
    }
    ok('超 5 个任务时新建被拒，并给出可操作原因', quota.includes('清理'))

    // 删项目：台账随项目级联清理（否则成为作者找不到、却一直占配额的孤儿）
    await saveTaskUnit({
      id: `${'p-task'}-u0`, taskId: 'head-0', projectId: PID, index: 0, unitKey: 'k',
      chapterTitle: '第1章', status: 'succeeded', attempts: 1, bytes: 0, updatedAt: 1, result: [],
    })
    ok('单元已写入', (await listTaskUnits('head-0')).length === 1)
    await db.deleteProject(PID)
    ok('删项目后任务头清空', (await listProjectTaskHeads(PID)).length === 0)
    ok('删项目后单元清空', (await memoryOps.getAllByIndex('taskUnits', 'projectId', PID)).length === 0)

    // 显式清理函数同样只动本项目
    await saveTaskHead(mkHead({ id: 'other-head', projectId: 'p-other' }))
    await saveTaskHead(mkHead({ id: 'stay-head' }))
    await deleteProjectTaskArtifacts('p-other')
    ok('按项目清理不影响别的项目', !(await getTaskHead('other-head')) && !!(await getTaskHead('stay-head')))
  }

  // ───────────────── ⑥ 接管时的 running 重置 ─────────────────
  {
    __resetMockStores()
    await memoryOps.put('projects', { id: PID, name: '台账测试', createdAt: 0, updatedAt: 0 })
    db.setCurrentProject(PID)
    const identity = idOf(TEXT)
    const h = await openBookBreakTask({ identity, totalUnits: 1, modelTag: '', label: '' })
    if (!h) throw new Error('台账不可用')
    await h.beginUnit({ index: 0, key: bookBreakUnitKey(identity, 0, '块'), chapterTitle: '第1章' })
    // 模拟"进程在 running 时被强杀"：直接换一个执行者接管
    const claimed = await claimTask(identity.taskId, 'next-owner')
    ok('接管时把残留 running 写成 interrupted', claimed.units[0]?.status === 'interrupted')
    ok('接管后任务头为 running 且代次 +1', claimed.head.status === 'running' && claimed.head.generation === h.head.generation + 1)
  }

  console.log(`\nTASK_LEDGER ${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
}

function mkUnit(over: Partial<TaskUnit> = {}): TaskUnit {
  return {
    id: `u-${stableHash(String(Math.random()))}`,
    taskId: over.taskId ?? 'task-x',
    projectId: PID,
    index: over.index ?? 0,
    unitKey: over.unitKey ?? 'k',
    chapterTitle: over.chapterTitle ?? '章',
    status: over.status ?? 'pending',
    attempts: 1,
    bytes: 0,
    updatedAt: 1,
    ...over,
  }
}

main().catch(e => { console.error(e); process.exitCode = 1 })