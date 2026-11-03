// 「新建最新章节」判据 · 单测
//
// 盯四件事：
//   ① 自由卷不会被当成「最新的一卷」（哨兵 order 是负数，取最大值会误选）；
//   ② 卷内追加序号取 max+1，不是章节数（删过章之后两者会分叉）；
//   ③ 空卷从 0 开始；别的卷的 order 不影响本卷；
//   ④ 没有真卷时返回 null（由界面决定提示还是改用自由章节）。
import type { Chapter, Volume } from '@/lib/types'
import { latestRealVolume, nextOrderInVolume, latestChapterTarget } from '@/lib/outline/chapterAppend'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

const vol = (id: string, order: number, isFree?: boolean): Volume =>
  ({ id, projectId: 'p', order, title: id, description: '', isFree }) as Volume
const ch = (id: string, volumeId: string, order: number): Chapter =>
  ({ id, projectId: 'p', volumeId, order, title: id, content: '' }) as Chapter

function main() {
  // ① 自由卷负 order，不能被选中
  {
    const vols = [vol('v1', 0), vol('v2', 1), vol('free', -999999, true)]
    const latest = latestRealVolume(vols)
    ok('自由卷不会被当成最新的一卷', latest?.id === 'v2', latest?.id)
  }

  // ② 卷内序号取 max+1（有空洞时不能撞号）
  {
    const chs = [ch('a', 'v1', 0), ch('c', 'v1', 2)]
    ok('删过章后仍取 max+1（不是章节数）', nextOrderInVolume(chs, 'v1') === 3, String(nextOrderInVolume(chs, 'v1')))
    // 反例钉住：若有人改回 length，这里会变成 2 并与其他章撞号
    ok('不等于章节数（回归判据）', nextOrderInVolume(chs, 'v1') !== chs.length)
  }

  // ③ 空卷 / 其他卷互不影响
  {
    const chs = [ch('a', 'v2', 7)]
    ok('空卷从 0 开始', nextOrderInVolume(chs, 'v1') === 0, String(nextOrderInVolume(chs, 'v1')))
    ok('别的卷的 order 不影响本卷', nextOrderInVolume(chs, 'v1') === 0 && nextOrderInVolume(chs, 'v2') === 8)
  }

  // ④ 没有真卷
  {
    ok('只有自由卷时返回 null', latestRealVolume([vol('free', -999999, true)]) === null)
    ok('完全没有卷时返回 null', latestRealVolume([]) === null)
    ok('没有真卷时不给出落点', latestChapterTarget([vol('free', -1, true)], []) === null)
  }

  // ⑤ 组合判据
  {
    const vols = [vol('v1', 0), vol('v2', 1), vol('free', -5, true)]
    const chs = [ch('a', 'v1', 0), ch('b', 'v1', 1), ch('c', 'v2', 0), ch('d', 'v2', 1)]
    const t = latestChapterTarget(vols, chs)
    ok('落点＝最新真卷 + 卷内 max+1', t?.volumeId === 'v2' && t?.order === 2 && t?.volumeTitle === 'v2', JSON.stringify(t))
  }

  // ⑥ 不修改入参（组件每次渲染都传同一份数组）
  {
    const vols = [vol('v1', 0), vol('v2', 1)]
    const snapshot = JSON.stringify(vols)
    latestRealVolume(vols)
    ok('不修改入参数组', JSON.stringify(vols) === snapshot)
  }

  console.log(`\n▶ chapterAppend: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
