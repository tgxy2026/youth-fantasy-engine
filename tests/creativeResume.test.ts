// ============ 3.3.3 · B3 创意写作断点产物回读校验 ============
//
// 钉住（规划 §6.2 / 验收 B-04）：
//   ① 旧记录没有证据 ⇒ 一律要求人工核对，不假装可续跑；
//   ② 断点里的章被删除 ⇒ 拒绝续跑（否则 baseDone 会多算，后面的章号错位）；
//   ③ 断点里的章正文被改 ⇒ 拒绝续跑（按旧进度跳过错误的章）；
//   ④ 标题改了不影响（作者常改标题），只看正文指纹；
//   ⑤ 已完成章数与证据条数对不上 ⇒ 记录本身损坏，拒绝；
//   ⑥ 书库里多出来的章不计问题（作者自己新写的）。
import { describeResumeEvidence, verifyResumeEvidence } from '../src/lib/creative/resumeEvidence'
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
  ok('重复章 id 不能冒充两章', verifyResumeEvidence([ev('a', '正文A'), ev('a', '正文A')], [ch('a', '正文A')], 2).reason === 'invalid')
  ok('证据类型损坏时拒绝', verifyResumeEvidence({} as never, [ch('a', '正文A')], 1).reason === 'invalid')
  ok('缺失指纹时拒绝', verifyResumeEvidence([{ ...ev('a', '正文A'), fingerprint: '' }], [ch('a', '正文A')], 1).reason === 'invalid')
  ok('无效完成章数时拒绝', verifyResumeEvidence([ev('a', '正文A')], [ch('a', '正文A')], Number.NaN).reason === 'count')

  console.log(`\ncreativeResume: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
