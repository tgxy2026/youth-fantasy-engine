// ============ 备份保留策略 · 纯函数单测（3.6.2 · W3）============
//
// 钉住四件容易翻车的事：
//   ① 淘汰的一定是**最旧**的（不是"最早创建的"以外的任何东西）；
//   ② 手动 / 定稿（limit=0）一份都不许删 —— 作者主动留的档被系统删掉是最伤人的 bug；
//   ③ **同一毫秒**的多份备份，淘汰结果必须确定（不依赖 sort 实现）；
//   ④ 源码闸：`backups.ts` 不许再退回"就地 slice 截断"的老写法。
import fs from 'node:fs'
import path from 'node:path'
import { planBackupRetention } from '../src/lib/db/backups'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

function mk(id: string, createdAt: number) { return { id, createdAt } }

// ---------- 1. 基本淘汰 ----------
{
  const items = [mk('a', 1000), mk('b', 2000), mk('c', 3000)]
  const drop = planBackupRetention(items, 2)
  ok('1a 上限 2 / 共 3 份 → 淘汰 1 份', drop.length === 1, String(drop.length))
  ok('1b 淘汰的是最旧的那份（a）', drop[0] === 'a', drop.join(','))
  ok('1c 输入顺序打乱也认得出最旧',
    planBackupRetention([mk('c', 3000), mk('a', 1000), mk('b', 2000)], 2)[0] === 'a')
}

// ---------- 2. 边界 ----------
{
  ok('2a 上限 0（手动/定稿）→ 一份都不删', planBackupRetention([mk('a', 1), mk('b', 2)], 0).length === 0)
  ok('2b 上限负数 → 一份都不删（不把 0 当"全删"）', planBackupRetention([mk('a', 1)], -5).length === 0)
  ok('2c 上限 NaN → 一份都不删', planBackupRetention([mk('a', 1)], Number.NaN).length === 0)
  ok('2d 空输入 → 空结果', planBackupRetention([], 5).length === 0)
  ok('2e 未超限 → 不删', planBackupRetention([mk('a', 1), mk('b', 2)], 5).length === 0)
  ok('2f 上限 1 → 只留最新一份', planBackupRetention([mk('a', 1), mk('b', 2), mk('c', 3)], 1).join(',') === 'a,b',
    planBackupRetention([mk('a', 1), mk('b', 2), mk('c', 3)], 1).join(','))
}

// ---------- 3. 超量 3 倍 ----------
{
  const items = Array.from({ length: 9 }, (_, i) => mk(`id${i}`, (i + 1) * 1000))
  const drop = planBackupRetention(items, 3)
  ok('3a 9 份 / 上限 3 → 删 6 份', drop.length === 6, String(drop.length))
  ok('3b 留下的正是最新的 3 份（id6/id7/id8）',
    !drop.includes('id6') && !drop.includes('id7') && !drop.includes('id8'), drop.join(','))
  ok('3c 删除顺序是最旧 → 较新（调用方可逐个删）',
    drop.join(',') === 'id0,id1,id2,id3,id4,id5', drop.join(','))
}

// ---------- 4. 同时间戳的确定性 ----------
{
  const same = [mk('zzz', 5000), mk('aaa', 5000), mk('mmm', 5000)]
  const r1 = planBackupRetention(same, 1)
  const r2 = planBackupRetention([...same].reverse(), 1)
  ok('4a 同一毫秒：两次调用结果一致（不依赖 sort 实现）', r1.join(',') === r2.join(','), `${r1} vs ${r2}`)
  ok('4b 同一毫秒按 id 升序保留（保留 aaa，删 mmm/zzz）',
    !r1.includes('aaa') && r1.includes('mmm') && r1.includes('zzz'), r1.join(','))
}

// ---------- 5. 不修改入参 ----------
{
  const items = [mk('a', 1000), mk('b', 3000), mk('c', 2000)]
  const snapshot = JSON.stringify(items)
  planBackupRetention(items, 1)
  ok('5a 纯函数：不改动传入数组', JSON.stringify(items) === snapshot)
}

// ---------- 6. 源码闸：不许退回就地截断 ----------
{
  const root = [process.cwd(), path.join(process.cwd(), '..')]
    .find(c => fs.existsSync(path.join(c, 'package.json'))) ?? ''
  const src = fs.readFileSync(path.join(root, 'src/lib/db/backups.ts'), 'utf8')
  ok('🔴 6a 淘汰走 planBackupRetention（而不是就地 slice）', src.includes('planBackupRetention('))
  // 只拦「老写法」那种就地截断：变量名是 all、直接切尾巴。纯函数内部的 sorted.slice 是合法的。
  ok('🔴 6b `backups.ts` 里不再出现「all 数组就地切尾巴」的老写法', !/\ball\.slice\(/.test(src),
    (src.match(/\w+\.slice\([^)]*\)/g) ?? []).join(' '))
  ok('6c 删除顺序是最旧优先（语义与注释一致）',
    /\.slice\(limit\)\.map\([^)]*\)\.reverse\(\)/.test(src), '缺少 reverse() —— 顺序会变成"次新→最旧"')
}

console.log(`\nbackupRetention: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
