// ============ 2.5.2 · A2 灵感夹 → 创意写作联动：注入段格式 ============
//
// inspirationBlock 是「作者灵感 → 提示词段」的唯一拼装源（纯函数）：
//  · 段头口径（供参考 / 不要求全部体现 / 细纲优先）是产品决定，测试锁死防漂移；
//  · 空数组 / 全空串 → 空串（整段不出现，不产生空标题）；
//  · 编号从 1 起 —— 与灵感页条目上的 #N 对应。
import {
  inspirationBlock,
} from '../src/lib/autoContinue'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

// ① 段头口径（产品决定，锁死）
{
  const b = inspirationBlock(['钟楼的钟声在午夜会自己响起', '女主角发现信件得到回信'])
  ok('段头含「作者灵感」标识', b.includes('【作者灵感'))
  ok('🔴 段头口径：供参考、不要求全部体现', b.includes('供参考，不要求全部体现'))
  ok('🔴 段头口径：与细纲冲突时以细纲为准', b.includes('以细纲为准'))
  ok('编号从 1 起、逐条一行',
    b.includes('1. 钟楼的钟声在午夜会自己响起') && b.includes('2. 女主角发现信件得到回信'))
}

// ② 空与容错
ok('空数组 → 空串（整段不出现）', inspirationBlock([]) === '')
ok('全空串 → 空串（不做空标题）', inspirationBlock(['', '   ']) === '')
ok('单条也带段头（不是裸文本）', inspirationBlock(['一条']).includes('【作者灵感'))
ok('条目两端空白被 trim', inspirationBlock(['  有空白  ']).includes('1. 有空白'))

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
