// 3.2.1 · 迁移锁与「迁移中」横幅的数据源 · 单测
//
// 盯四件事：
//   ① 加锁后能**点名**（横幅要说清"哪个页签在换模板"，只说"有页签在迁移"作者没法判断该等谁）；
//   ② 同一页签加两次锁仍是 1 项（Set 语义），释放一次**不解开别人的锁**；
//   ③ 按项目过滤 —— 别的项目的锁不该出现在本项目的横幅上；
//   ④ 订阅通知：加锁 / 释放都要 `emit`，否则横幅不会自动消失。
//
// 🔴 为什么要单测锁：`isAnyTabMigrationActive` / `subscribeMigrationLock` 在 3.2.0 就写好了，
//    但直到 2026-10-22 才有消费方 —— 零测试的模块「看起来对」和「真的对」没区别。
import {
  beginTabMigrationLock,
  activeMigrationTabIds,
  isTabMigrationActive,
  isAnyTabMigrationActive,
  subscribeMigrationLock,
} from '@/lib/templates/migrationGuard'

let pass = 0, fail = 0

function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

const PID = 'proj-A'
const PID2 = 'proj-B'

console.log('\n── ① 点名与计数 ──')
{
  ok('无锁时为空表', activeMigrationTabIds().length === 0)
  ok('无锁时 isAny 为 false', isAnyTabMigrationActive() === false)

  const r1 = beginTabMigrationLock(PID, 'characters')
  ok('加锁后点名到 characters', JSON.stringify(activeMigrationTabIds(PID)) === '["characters"]',
    JSON.stringify(activeMigrationTabIds(PID)))
  ok('isAny 变 true', isAnyTabMigrationActive() === true)
  ok('isTabMigrationActive 对该页签为 true', isTabMigrationActive(PID, 'characters') === true)
  ok('未加锁的页签仍为 false', isTabMigrationActive(PID, 'outline') === false)

  const r2 = beginTabMigrationLock(PID, 'worldview')
  const two = activeMigrationTabIds(PID).sort()
  ok('两个页签 → 2 项', two.length === 2, JSON.stringify(two))

  r1()
  ok('释放一个 → 剩 worldView', JSON.stringify(activeMigrationTabIds(PID)) === '["worldview"]',
    JSON.stringify(activeMigrationTabIds(PID)))
  r2()
  ok('全部释放 → 空表', activeMigrationTabIds().length === 0)
  ok('全部释放 → isAny 为 false', isAnyTabMigrationActive() === false)
}

console.log('\n── ② 重复加锁 / 重复释放 ──')
{
  const a = beginTabMigrationLock(PID, 'characters')
  const b = beginTabMigrationLock(PID, 'characters')
  ok('同一页签加两次锁仍只点名 1 项', activeMigrationTabIds(PID).length === 1,
    JSON.stringify(activeMigrationTabIds(PID)))

  a()
  // 🔴 Set 语义：a 释放后集合已无该键 —— 但 b 仍持有"释放权"，
  //    此时 isTabMigrationActive 应为 false（集合里确实没有了）。
  //    这条断言钉的是「不做引用计数」这个既定取舍，不是 bug。
  ok('首个释放即解锁（不做引用计数）', isTabMigrationActive(PID, 'characters') === false)

  b() // 幂等：重复释放不抛、不影响其它锁
  ok('重复释放不抛错且集合为空', activeMigrationTabIds().length === 0)
}

console.log('\n── ③ 按项目过滤 ──')
{
  const ra = beginTabMigrationLock(PID, 'characters')
  const rb = beginTabMigrationLock(PID2, 'worldview')
  ok('本项目只看到自己的页签', JSON.stringify(activeMigrationTabIds(PID)) === '["characters"]',
    JSON.stringify(activeMigrationTabIds(PID)))
  ok('另一项目只看到自己的', JSON.stringify(activeMigrationTabIds(PID2)) === '["worldview"]',
    JSON.stringify(activeMigrationTabIds(PID2)))
  ok('不传 pid 时返回全部', activeMigrationTabIds().length === 2)
  ra(); rb()
}

console.log('\n── ④ 订阅通知（横幅靠它自动出现 / 消失）──')
{
  let fired = 0
  const un = subscribeMigrationLock(() => { fired++ })
  const r = beginTabMigrationLock(PID, 'characters')
  ok('加锁触发一次通知', fired === 1, `fired=${fired}`)
  r()
  ok('释放触发一次通知', fired === 2, `fired=${fired}`)

  un()
  beginTabMigrationLock(PID, 'characters')()
  ok('退订后不再通知', fired === 2, `fired=${fired}`)
}

console.log(`\n${fail === 0 ? '✅' : '❌'} migrationLock: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
