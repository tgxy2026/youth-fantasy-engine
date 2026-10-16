// ============ chapterSeq 硬断言（#013）============
// 章节顺序是全书叙事时序的「唯一权威」：导出、AI 取正文、连续性校验、搜索结果、
// 时光机全都依赖它。派生逻辑一旦出错，症状是"顺序莫名乱了"，作者极难察觉根因。
// 故此处用精确断言（而非只要求不炸的软断言）锁死语义。
import { flattenChapters, chapterSeqMap, chapterSeqOf, sortChapters, flattenAll, orphanChapters } from '../src/lib/outline/chapterSeq'
import { FREE_VOLUME_ORDER } from '../src/lib/outline/freeVolume'
import type { Chapter, Volume } from '../src/lib/types'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const PID = 'p1'
const vol = (id: string, order: number): Volume => ({
  id, projectId: PID, order, title: `卷${id}`, description: '', createdAt: 0,
})
const ch = (id: string, volumeId: string, order: number, extra: Partial<Chapter> = {}): Chapter => ({
  id, projectId: PID, volumeId, order,
  title: id, content: `${id}正文`, summary: '', status: '构思',
  wordCount: 0, createdAt: 0, updatedAt: 0, ...extra,
})

// ---------- 1. 跨卷排序：order 是「卷内」序号，绝不能全局裸排 ----------
{
  const vols = [vol('v1', 0), vol('v2', 1)]
  // 卷二第 1 章的 order 同样是 0，与卷一第 1 章撞号 —— 这正是历史 bug 的成因
  const chs = [ch('v2c1', 'v2', 0), ch('v1c2', 'v1', 1), ch('v1c1', 'v1', 0)]
  const got = flattenChapters(vols, chs).map(c => c.id)
  ok('跨卷排序：卷序优先于章序', got.join(',') === 'v1c1,v1c2,v2c1', got.join(','))
  // 反例守卫：裸 sort(a.order-b.order) 会得出串号结果，若此断言失败说明测试已失效
  const naive = [...chs].sort((a, b) => a.order - b.order).map(c => c.id)
  ok('反例：裸按 order 排序确实会串号（证明本用例有效）', naive.join(',') !== got.join(','), naive.join(','))
}

// ---------- 2. 卷数组乱序传入也要正确 ----------
{
  const vols = [vol('v3', 2), vol('v1', 0), vol('v2', 1)]
  const chs = [ch('a', 'v3', 0), ch('b', 'v1', 0), ch('c', 'v2', 0)]
  const got = flattenChapters(vols, chs).map(c => c.id).join(',')
  ok('卷数组乱序时仍按 Volume.order 排列', got === 'b,c,a', got)
}

// ---------- 3. 同卷内按 Chapter.order ----------
{
  const vols = [vol('v1', 0)]
  const chs = [ch('c3', 'v1', 2), ch('c1', 'v1', 0), ch('c2', 'v1', 1)]
  const got = flattenChapters(vols, chs).map(c => c.id).join(',')
  ok('同卷内按 Chapter.order 排列', got === 'c1,c2,c3', got)
}

// ---------- 4. 全局连续序号 1..n ----------
{
  const vols = [vol('v1', 0), vol('v2', 1)]
  const chs = [ch('v2c1', 'v2', 0), ch('v1c2', 'v1', 1), ch('v1c1', 'v1', 0)]
  const m = chapterSeqMap(vols, chs)
  const seq = [m.get('v1c1'), m.get('v1c2'), m.get('v2c1')]
  ok('全局连续序号 1..3 且跨卷递增', seq.join(',') === '1,2,3', String(seq))
}

// ---------- 5. 不计入序号：返回 0 且不占号，但仍参与排序 ----------
{
  const vols = [vol('v1', 0)]
  // 序章 order=0 排在正文第 1 章（order=1）之前
  const chs = [ch('c1', 'v1', 1), ch('pro', 'v1', 0, { excludeFromNumbering: true })]
  const m = chapterSeqMap(vols, chs)
  ok('不计入序号的章节返回 0', m.get('pro') === 0, String(m.get('pro')))
  ok('不计入序号的章节不占号（后续仍从 1 起）', m.get('c1') === 1, String(m.get('c1')))
  const got = flattenChapters(vols, chs).map(c => c.id).join(',')
  ok('不计入序号的章节仍参与叙事排序', got === 'pro,c1', got)
}

// ---------- 6. chapterSeqOf 边界 ----------
{
  const vols = [vol('v1', 0)]
  const chs = [ch('c1', 'v1', 0)]
  ok('chapterSeqOf 命中返回序号', chapterSeqOf(vols, chs, 'c1') === 1)
  ok('chapterSeqOf 未命中返回 0', chapterSeqOf(vols, chs, '不存在') === 0)
}

// ---------- 7. sortChapters 与 flattenChapters 一致且不丢章 ----------
{
  const vols = [vol('v1', 0), vol('v2', 1)]
  const chs = [ch('v2c2', 'v2', 1), ch('v1c1', 'v1', 0), ch('v2c1', 'v2', 0), ch('v1c2', 'v1', 1)]
  const a = sortChapters(vols, chs).map(c => c.id).join(',')
  const b = flattenChapters(vols, chs).map(c => c.id).join(',')
  ok('sortChapters 与 flattenChapters 顺序一致', a === b, `${a} ⟷ ${b}`)
  ok('sortChapters 不丢章（长度一致）', sortChapters(vols, chs).length === chs.length)
}

// ---------- 8. 空输入与孤儿章节 ----------
{
  ok('空输入返回空数组', flattenChapters([], []).length === 0)
  const chs = [ch('orphan', '不存在的卷', 0)]
  ok('章节所属卷不存在时被丢弃（不进入叙事序）', flattenChapters([vol('v1', 0)], chs).length === 0)

  // 🔴 2026-10-14 六维审计修：sortChapters 对孤儿章原先是「rank 缺失回落 0」，
  //    会静默插到第 1 章**前面**（与章节树把它们收进末尾兜底组的观感冲突）。
  const withOrphan = [ch('orphan', '不存在的卷', 0), ch('v1c1', 'v1', 0), ch('v1c2', 'v1', 1)]
  const ordered = sortChapters([vol('v1', 0)], withOrphan).map(c => c.id)
  ok('sortChapters 不丢孤儿章', ordered.length === 3, ordered.join(','))
  ok('孤儿章排在有效章之后（不再伪装成第 1 章）',
    ordered[ordered.length - 1] === 'orphan', ordered.join(','))
}

// ---------- 9. 自由卷：排最前但不占正文序号（2.6.4）----------
{
  const vols: Volume[] = [vol('v1', 0), { ...vol('vf', FREE_VOLUME_ORDER), isFree: true }]
  const chs = [ch('free1', 'vf', 0), ch('free2', 'vf', 1), ch('c1', 'v1', 0), ch('c2', 'v1', 1)]
  // ① 自由卷排最前（哨兵 order 为负）
  const order = flattenChapters(vols, chs).map(c => c.id).join(',')
  ok('自由卷章节排在正文之前', order === 'free1,free2,c1,c2', order)
  // ② 但自由章不占号：正片仍从 1 起
  const m = chapterSeqMap(vols, chs)
  ok('自由章返回 0（不占号）', m.get('free1') === 0 && m.get('free2') === 0, `${m.get('free1')},${m.get('free2')}`)
  ok('正片仍从第1章起（自由卷不挤占序号）', m.get('c1') === 1 && m.get('c2') === 2, `${m.get('c1')},${m.get('c2')}`)
  ok('哨兵值恒小于真卷 order（0）', FREE_VOLUME_ORDER < 0, String(FREE_VOLUME_ORDER))
  // 反面守卫：不排除自由卷时正片序号会被顶成 3/4 —— 证明本用例有效
  const naive = flattenChapters(vols, chs).map((c, i) => [c.id, i + 1] as const)
  ok('反面：不排除自由卷会顶号（本用例有效性证明）', naive[2][1] === 3, String(naive[2][1]))
}

// ---------- 10. flattenAll / orphanChapters：全书平铺唯一真源（2026-10-17 收敛漂移）----------
// 收敛前全仓有 4 份手写平铺、孤儿章口径分歧成三种（丢弃 / 保留不排序 / 保留且排序）。
// 这里把「真源该有的口径」逐条钉死，配上 structureGates ⑫ 的静态禁令一起用。
{
  // ① 卷乱序传入 + 章乱序传入：结果必须是 卷序 → 章序
  const vols = [vol('v3', 2), vol('v1', 0), vol('v2', 1)]
  const chs = [ch('c3b', 'v3', 1), ch('c1a', 'v1', 0), ch('c2a', 'v2', 0), ch('c3a', 'v3', 0), ch('c1b', 'v1', 1)]
  const got = flattenAll(vols, chs).map(c => c.id).join(',')
  ok('flattenAll：卷序 → 章序（两边乱序传入也成立）', got === 'c1a,c1b,c2a,c3a,c3b', got)

  // ② 孤儿章垫底且**按 order 排**（旧手写版有的直接丢掉、有的不排序）
  const withOrphan = [
    ch('orphan2', '已删的卷', 1), ch('v1c1', 'v1', 0), ch('orphan1', '已删的卷', 0), ch('v1c2', 'v1', 1),
  ]
  const mixed = flattenAll([vol('v1', 0)], withOrphan).map(c => c.id).join(',')
  ok('flattenAll：孤儿章垫底且不丢', mixed === 'v1c1,v1c2,orphan1,orphan2', mixed)

  // ③ 与 sortChapters 严格同序（两者曾是两条平行实现，正是漂移的来源）
  const sorted = sortChapters([vol('v1', 0)], withOrphan).map(c => c.id).join(',')
  ok('flattenAll 与 sortChapters 严格同序', sorted === mixed, `${sorted} ⟷ ${mixed}`)

  // ④ orphanChapters：只挑孤儿、按 order 排；没有孤儿时为空
  const orph = orphanChapters([vol('v1', 0)], withOrphan).map(c => c.id).join(',')
  ok('orphanChapters：只返回孤儿章并按 order 排', orph === 'orphan1,orphan2', orph)
  ok('orphanChapters：无孤儿时返回空数组', orphanChapters([vol('v1', 0)], [ch('v1c1', 'v1', 0)]).length === 0)

  // ⑤ 与 flattenChapters 的关系：后者不含孤儿（供编号用），前者含全部章节
  ok('flattenChapters 不含孤儿（编号口径不受影响）',
    flattenChapters([vol('v1', 0)], withOrphan).length === 2)
  ok('flattenAll 含全部章节（平铺口径不丢章）',
    flattenAll([vol('v1', 0)], withOrphan).length === 4)

  // ⑥ 自由卷照旧排最前（真源不得绕过 freeVolume 的哨兵 order）
  const freeVols: Volume[] = [vol('v1', 0), { ...vol('vf', FREE_VOLUME_ORDER), isFree: true }]
  const freeChs = [ch('c1', 'v1', 0), ch('free1', 'vf', 0)]
  ok('flattenAll：自由卷章节仍排最前',
    flattenAll(freeVols, freeChs).map(c => c.id).join(',') === 'free1,c1',
    flattenAll(freeVols, freeChs).map(c => c.id).join(','))
}

console.log(`\nchapterSeq: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
