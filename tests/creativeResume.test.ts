// ============ 3.3.3 · B3 创意写作断点产物回读校验 ============
//
// 钉住（规划 §6.2 / 验收 B-04）：
//   ① 旧记录没有证据 ⇒ 一律要求人工核对，不假装可续跑；
//   ② 断点里的章被删除 ⇒ 拒绝续跑（否则 baseDone 会多算，后面的章号错位）；
//   ③ 断点里的章正文被改 ⇒ 拒绝续跑（按旧进度跳过错误的章）；
//   ④ 标题改了不影响（作者常改标题），只看正文指纹；
//   ⑤ 已完成章数与证据条数对不上 ⇒ 记录本身损坏，拒绝；
//   ⑥ 书库里多出来的章不计问题（作者自己新写的）。
import { describeResumeEvidence, downgradeInterruptedProgress, isCreativeResumeShape, verifyResumeEvidence } from '../src/lib/creative/resumeEvidence'
import { textFingerprint } from '../src/lib/tasks/unitLedger'

let pass = 0, fail = 0
const ok = (n: string, c: boolean | undefined, e = '') => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, '::', e) }
}

const ch = (id: string, content: string) => ({ id, content })
const ev = (id: string, content: string, over: Partial<{ title: string; no: number }> = {}) => ({
  id, title: over.title ?? '章', no: over.no ?? 1, fingerprint: textFingerprint(content),
})

function main() {
  // ① 旧记录
  const legacy = verifyResumeEvidence(undefined, [ch('a', '正文')], 1)
  ok('旧记录要求人工核对', !legacy.ok && legacy.reason === 'legacy')
  ok('旧记录有可展示的原因', describeResumeEvidence(legacy).includes('旧版本'))
  ok('空证据也按旧记录处理', verifyResumeEvidence([], [ch('a', '正文')]).reason === 'legacy')

  // ② 缺章
  const missing = verifyResumeEvidence([ev('a', '正文A'), ev('b', '正文B')], [ch('a', '正文A')], 2)
  ok('章被删除 ⇒ 拒绝', !missing.ok && missing.reason === 'missing' && missing.missing.join() === 'b')
  ok('缺章原因写数量', describeResumeEvidence(missing).includes('1 章已被删除'))

  // ③ 正文被改
  const changed = verifyResumeEvidence([ev('a', '正文A')], [ch('a', '正文A（改）')], 1)
  ok('正文被改 ⇒ 拒绝', !changed.ok && changed.reason === 'changed' && changed.changed.join() === 'a')
  ok('改写原因不冒充"丢失"', describeResumeEvidence(changed).includes('正文已被改动'))

  // ④ 标题改动不影响
  const sameId = ev('a', '正文A', { title: '旧标题', no: 3 })
  ok('标题/章号不参与判定', verifyResumeEvidence([sameId], [ch('a', '正文A')], 1).ok)

  // ⑤ 已完成章数与证据对不上
  const count = verifyResumeEvidence([ev('a', '正文A')], [ch('a', '正文A')], 3)
  ok('条数不一致 ⇒ 记录损坏', !count.ok && count.reason === 'count')

  // ⑥ 全部一致 + 书库多章
  const good = verifyResumeEvidence(
    [ev('a', '正文A'), ev('b', '正文B')],
    [ch('x', '作者新写'), ch('a', '正文A'), ch('b', '正文B')],
    2,
  )
  ok('全部对得上才允许续跑', good.ok && good.reason === '')
  ok('多出来的章不算问题', good.missing.length === 0 && good.changed.length === 0)
  ok('能续跑时没有原因文案', describeResumeEvidence(good) === '')

  // ⑦ 边界：空正文也能校验（指纹对空串一致）
  ok('空正文可一致', verifyResumeEvidence([ev('e', '')], [ch('e', '')], 1).ok)

  // ⑧ 旧记录的形状识别：坏形状不能当"没有记录"静默丢掉
  const goodResume = { bag: {}, from: 'draft', doneChapters: 2, totalChapters: 5, label: '已写 2/5 章' }
  ok('正常断点形状通过', isCreativeResumeShape(goodResume))
  ok('旧记录没有 evidence 仍可识别形状', isCreativeResumeShape(goodResume))
  ok('字符串断点不算', !isCreativeResumeShape('已写 2/5 章'))
  ok('缺 doneChapters 不算', !isCreativeResumeShape({ ...goodResume, doneChapters: undefined }))
  ok('章数不是数字不算', !isCreativeResumeShape({ ...goodResume, totalChapters: '5' }))
  ok('0 总章数不算', !isCreativeResumeShape({ ...goodResume, totalChapters: 0 }))
  ok('空对象不算', !isCreativeResumeShape({}))
  ok('null 不算', !isCreativeResumeShape(null))
  ok('重复章 id 不能冒充两章', verifyResumeEvidence([ev('a', '正文A'), ev('a', '正文A')], [ch('a', '正文A')], 2).reason === 'invalid')
  ok('证据类型损坏时拒绝', verifyResumeEvidence({} as never, [ch('a', '正文A')], 1).reason === 'invalid')
  ok('缺失指纹时拒绝', verifyResumeEvidence([{ ...ev('a', '正文A'), fingerprint: '' }], [ch('a', '正文A')], 1).reason === 'invalid')
  ok('无效完成章数时拒绝', verifyResumeEvidence([ev('a', '正文A')], [ch('a', '正文A')], Number.NaN).reason === 'count')

  // ⑦ 重开时"上次没跑完"的进度降级为已中止（2026-11-01 实机发现）
  //
  //    缺陷现场：设定阶段跑到 18% 后关掉页面，重开后时间线仍显示「进行中」，
  //    但草稿只在内存里（bag 不落盘）⇒ 既没有任务在跑，也没有草稿可确认。
  const running = {
    status: 'running', ratio: 0.176, current: 'bible', message: '生成 6 条设定草稿，等待确认…',
    stages: [
      { id: 'bible', label: '设定奠基', status: 'running', ratio: 1, detail: '生成 6 条设定草稿，等待确认…' },
      { id: 'outline', label: '分卷大纲', status: 'pending', ratio: 0, detail: '待处理' },
    ],
  } as unknown as import('../src/lib/flow/types').FlowProgress
  const down = downgradeInterruptedProgress(running)
  ok('running 进度 ⇒ 降级为已中止', down?.status === 'cancelled')
  ok('降级后说明提到「中断」', !!down?.message && /中断/.test(down.message))
  ok('running 阶段 ⇒ 也降级为 cancelled', down?.stages[0].status === 'cancelled')
  ok('pending 阶段保持不动', down?.stages[1].status === 'pending')
  ok('纯函数：不改原对象', running.status === 'running' && running.stages[0].status === 'running')
  ok('done 不降级', downgradeInterruptedProgress({ ...running, status: 'done' } as never)?.status === 'done')
  ok('error 不降级', downgradeInterruptedProgress({ ...running, status: 'error' } as never)?.status === 'error')
  ok('null ⇒ null', downgradeInterruptedProgress(null) === null)
  ok('undefined ⇒ null', downgradeInterruptedProgress(undefined) === null)

  console.log(`\ncreativeResume: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
