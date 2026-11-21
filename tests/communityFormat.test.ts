// ============ 投稿广场 · 展示格式（3.6.2）============
//
// 这个文件很小，但值一条闸：浏览量在**列表 / 详情 / 合集页**三处出现，
// 三处各写一份格式化，早晚会出现「列表说 1.2 万、合集页说 12345」。
import { formatViews } from '../src/lib/community/format'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

ok('0 → "0"', formatViews(0) === '0')
ok('undefined → "0"（老帖没有这个字段）', formatViews(undefined) === '0')
ok('null → "0"', formatViews(null) === '0')
ok('负数 → "0"（脏数据不显示成 -1）', formatViews(-5) === '0')
ok('万以下原样显示', formatViews(8423) === '8423', formatViews(8423))
ok('小数向下取整（不显示 8423.7）', formatViews(8423.7) === '8423')
ok('9999 不折万', formatViews(9999) === '9999')
ok('10000 → "1.0 万"', formatViews(10000) === '1.0 万', formatViews(10000))
ok('12345 → "1.2 万"', formatViews(12345) === '1.2 万', formatViews(12345))
ok('🔴 10400 与 19400 显示不同（不能都折成「1 万」）', formatViews(10400) !== formatViews(19400),
  `${formatViews(10400)} vs ${formatViews(19400)}`)
ok('十万以上不留小数', formatViews(123456) === '12 万', formatViews(123456))

console.log(`\ncommunityFormat: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
