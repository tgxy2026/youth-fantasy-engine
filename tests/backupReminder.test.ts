/**
 * 「导出备份」提醒节流 · 单测（2026-10-06 补）
 *
 * 为什么补：这段逻辑的**核心是一条语义约束**，TS 与其它测试都管不了 ——
 *   🔴 「稍后再说」**不等于**「已备份」。
 * 若把它俩记成同一个时间戳，用户点几次「稍后」就再也不会被提醒，
 * 而这条提醒要防的恰恰是「写了几个月没导出过一份备份」。
 * 另外两个边界也容易错：恰好满 7 天算不算（不算）、存储不可用时怎么办（按未导出处理，不能静默吞）。
 */
import {
  isExportOverdue, isDismissExpired, markExported, markDismissed, REMIND_AFTER_DAYS,
} from '../src/lib/backupReminder'

let pass = 0, fail = 0
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`) }
}

/** 与 backupReminder.ts 内部一致的两个键（刻意硬编码：改名 = 老用户提醒状态丢失，测试要能发现） */
const LAST_KEY = 'yfe-last-export-at'
const DISMISS_KEY = 'yfe-backup-remind-dismiss-at'

const DAY = 24 * 60 * 60 * 1000
const store = new Map<string, string>()
const g = globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }

function installMockStorage(): void {
  g.localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  } as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

function main() {
  installMockStorage()

  // ---------- 1) 从未导出过 → 提醒 ----------
  {
    store.clear()
    ok('1a 从未导出过 ⇒ isExportOverdue() 为 true', isExportOverdue())
    ok('1b 从未导出过 ⇒ isDismissExpired() 为 true', isDismissExpired())
    ok('1c 提醒间隔是 7 天', REMIND_AFTER_DAYS === 7, String(REMIND_AFTER_DAYS))
  }

  // ---------- 2) 刚导出过 → 不提醒 ----------
  {
    store.clear()
    markExported()
    ok('2a markExported 后不再提醒', !isExportOverdue())
    ok('2b 写的是 LAST_KEY（键名改了会让老用户状态丢失）', store.has(LAST_KEY), [...store.keys()].join(','))
    ok('2c 记的是 currentTimeMillis（可跨会话比对）',
      Number(store.get(LAST_KEY)) > Date.now() - 60_000)
  }

  // ---------- 3) 🔴 核心语义：「稍后再说」≠「已备份」 ----------
  {
    store.clear()
    markDismissed()
    ok('3a 「稍后再说」不会把导出时间刷成现在（否则用户点几次就再也不提醒）',
      !store.has(LAST_KEY), JSON.stringify([...store.entries()]))
    ok('3b 但会写下 DISMISS_KEY', store.has(DISMISS_KEY))
    ok('3c 点过「稍后」后：静默期内不弹', !isDismissExpired())
    ok('3d 🔴 但「导出过期」仍为 true —— 提醒条件本身没有被它短路', isExportOverdue())
  }

  // ---------- 4) 时间边界 ----------
  {
    store.clear()
    store.set(LAST_KEY, String(Date.now() - (REMIND_AFTER_DAYS * DAY + 60_000)))  // 超 7 天一分钟
    ok('4a 超期一分钟 ⇒ 提醒', isExportOverdue())

    store.set(LAST_KEY, String(Date.now() - (REMIND_AFTER_DAYS * DAY - 60_000)))  // 差一分钟满 7 天
    ok('4b 还差一分钟 ⇒ 不提醒', !isExportOverdue())

    store.set(LAST_KEY, String(Date.now() - REMIND_AFTER_DAYS * DAY))             // 恰好 7 天
    ok('4c 恰好满 7 天 ⇒ 不提醒（判据是「超过」而非「达到」）', !isExportOverdue())

    store.set(DISMISS_KEY, String(Date.now() - (REMIND_AFTER_DAYS * DAY + 60_000)))
    ok('4d 「稍后」静默期同样以 7 天为界（超期即恢复提醒）', isDismissExpired())
  }

  // ---------- 5) 脏数据与存储不可用 ----------
  {
    store.clear()
    store.set(LAST_KEY, 'NaN')
    ok('5a 非数字脏值 ⇒ 按「从未导出」处理（宁可多提醒一次，也不静默放过）', isExportOverdue())
    store.set(LAST_KEY, '0')
    ok('5b 0 ⇒ 同样按从未导出处理', isExportOverdue())
    store.set(LAST_KEY, '-5')
    ok('5c 负数 ⇒ 同样按从未导出处理', isExportOverdue())
    store.set(LAST_KEY, String(Date.now()))
    ok('5d 合法值仍然正常工作（证明 5a~5c 不是「一律返回 true」）', !isExportOverdue())
  }
  {
    // 隐私模式 / 存储被禁用：getItem 抛 ⇒ 必须按「从未导出」处理（照常提醒，不静默吞掉）
    store.clear()
    g.localStorage = {
      getItem: () => { throw new Error('存储不可用') },
      setItem: () => { throw new Error('存储不可用') },
      removeItem: () => {},
    } as unknown as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
    ok('5e 存储读取抛异常 ⇒ 不崩、按未导出处理', isExportOverdue())
    let threw = false
    try { markExported(); markDismissed() } catch { threw = true }
    ok('5f 存储写入抛异常 ⇒ 不崩（下次启动仍会提醒）', !threw)
    installMockStorage()   // 还原，别污染后续
  }

  console.log(`\nbackupReminder: ${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
}

main()
