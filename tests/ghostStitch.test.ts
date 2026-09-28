// ============ 伴写前文拼上一章（stitchGhostBefore + orderedChapters，2026-09-28）============
//
// 需求：当前章内容不足 2000 字时，读上一章末尾凑够 2000 字作上文（章首语境）。
// 钉住的行为：
// ① 当前章前文够长 → 原样返回（旧行为零变化，上一章再长也不拼）；
// ② 不足 → 用上一章**末尾**补齐差额（不是开头），总长恰为 GHOST_CONTEXT_CHARS；
// ③ 上一章无正文（第一卷第一章 / 上一章还没写）→ 原样返回，宁缺毋滥；
// ④ 「上一章」按全书卷章顺序（orderedChapters）——跨卷时是上一卷的最后一章，不是同卷上一章。
import type { Chapter, Volume } from '../src/lib/types'
import { GHOST_CONTEXT_CHARS, orderedChapters, stitchGhostBefore } from '../src/components/novelEditorHelpers'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const mkVol = (id: string, order: number): Volume =>
  ({ id, projectId: 'p', order, title: `卷${order + 1}`, description: '', createdAt: 0 })
const mkCh = (id: string, volumeId: string, order: number, content = ''): Chapter =>
  ({ id, projectId: 'p', volumeId, order, title: id, content, summary: '', createdAt: 0, updatedAt: 0 }) as Chapter

// ---------- orderedChapters：全书顺序 ----------
{
  const vols = [mkVol('v2', 1), mkVol('v1', 0)]
  const chs = [
    mkCh('c22', 'v2', 1, '卷二第二章'),
    mkCh('c11', 'v1', 0, '卷一第一章'),
    mkCh('c21', 'v2', 0, '卷二第一章'),
    mkCh('c12', 'v1', 1, '卷一第二章'),
  ]
  const flat = orderedChapters(vols, chs)
  ok('全书顺序：卷按 order、卷内章按 order（与传入顺序无关）',
    flat.map(c => c.id).join(',') === 'c11,c12,c21,c22', flat.map(c => c.id).join(','))
  ok('跨卷「上一章」＝上一卷最后一章（c21 的上一章是 c12）', flat[flat.findIndex(c => c.id === 'c21') - 1].id === 'c12')
  ok('第一卷第一章没有上一章（idx=0）', flat.findIndex(c => c.id === 'c11') === 0)
}

// ---------- stitchGhostBefore：拼接规则 ----------
{
  const prevTail = '前'.repeat(3000)          // 上一章末尾截出的 ≤2000 字
  const long = '正'.repeat(GHOST_CONTEXT_CHARS)
  ok('当前章前文够长 → 原样返回（旧行为零变化）', stitchGhostBefore(long, prevTail) === long)

  const cur = '本'.repeat(600)
  const stitched = stitchGhostBefore(cur, prevTail)
  ok('不足 2000 → 补齐后总长恰为 GHOST_CONTEXT_CHARS', stitched.length === GHOST_CONTEXT_CHARS, String(stitched.length))
  ok('补的是上一章的末尾（不是开头）', stitched === prevTail.slice(-(GHOST_CONTEXT_CHARS - 600)) + cur)
  ok('当前章内容原样排在末段且不被截断', stitched.endsWith(cur))

  ok('上一章比差额短 → 全部拼入', stitchGhostBefore('a'.repeat(1990), '上一章很短') === '上一章很短' + 'a'.repeat(1990))
  ok('上一章为空串 → 原样返回（第一卷第一章/上一章没写）', stitchGhostBefore('当前章', '') === '当前章')
  ok('章首为空 → 全部来自上一章末尾', stitchGhostBefore('', prevTail) === prevTail.slice(-GHOST_CONTEXT_CHARS))
  ok('自定义 limit 生效', stitchGhostBefore('x'.repeat(8), 'y'.repeat(100), 10) === 'yy' + 'x'.repeat(8))
}

console.log(`\nghostStitch: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
