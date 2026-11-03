// ============ 3.3.0 · UX12：键盘重排的落点判据 ============
//
// 章节树此前只能拖拽 —— 键盘/读屏用户排不了序。补的替代入口是 Alt+↑/↓，
// 而它是否"该动"全在 `keyboardNeighbor` 这一条判据上，边界错了会出两种坏结果：
//   ① 到头了还提示"排序已保存"（假反馈）；② 跨组换位（章跑到别的卷里）。
import { canMove, keyboardNeighbor } from '../src/lib/editor/chapterReorder'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}
const list = [
  { id: 'c', order: 2 },
  { id: 'a', order: 0 },
  { id: 'b', order: 1 },
]

// ---------- ① 相邻落点 ----------
{
  ok('🔴 ① 向下 = 与下一个相邻项换位（before 语义）',
    JSON.stringify(keyboardNeighbor(list, 'a', 1)) === JSON.stringify({ id: 'b', pos: 'after' }),
    JSON.stringify(keyboardNeighbor(list, 'a', 1)))
  ok('🔴 ① 向上 = 与上一个相邻项换位', JSON.stringify(keyboardNeighbor(list, 'c', -1)) === JSON.stringify({ id: 'b', pos: 'before' }),
    JSON.stringify(keyboardNeighbor(list, 'c', -1)))
  ok('🔴 ① 输入乱序也按 order 排后再取相邻（不按数组下标猜）',
    JSON.stringify(keyboardNeighbor(list, 'b', 1)) === JSON.stringify({ id: 'c', pos: 'after' }))
}

// ---------- ② 边界：不产生空操作 ----------
{
  ok('🔴 ② 第一项向上 ⇒ 没有落点（不假报"已保存"）', keyboardNeighbor(list, 'a', -1) === null)
  ok('🔴 ② 最后一项向下 ⇒ 没有落点', keyboardNeighbor(list, 'c', 1) === null)
  ok('🔴 ② 只有一项时上下都无落点',
    keyboardNeighbor([{ id: 'only', order: 0 }], 'only', -1) === null
      && keyboardNeighbor([{ id: 'only', order: 0 }], 'only', 1) === null)
}

// ---------- ③ 越权与不存在的项 ----------
{
  ok('🔴 ③ 不在这一组里的 id ⇒ 没有落点（章不会跑到别的卷）', keyboardNeighbor(list, 'zzz', 1) === null)
  ok('🔴 ③ canMove 与落点判断一致（界面据此决定是否提示）',
    canMove(list, 'a', 1) === true && canMove(list, 'a', -1) === false)
}

console.log(`\n———— chapterReorder：${pass} 通过 / ${fail} 失败 ————`)
if (fail > 0) process.exitCode = 1
