// ============ 3.3.2 · P2 遗留 · 维护定时任务（回收站到期清理 + 对象回收）============
//
// 【为什么必须有】两件事以前只能人工 `node admin.mjs gc <用户> --apply`：
//   ① 回收站里超过 30 天的项目：协议承诺"30 天内可恢复"，到期不清理的话
//      这些项目会永久占着配额 —— 用户看不见它们，却一直在为它们付配额；
//   ② 无人引用的对象：内容寻址只增不减，一本 40 MB 的书改十次，盘上可能躺 200 MB。
//   1.7 G 的机器 + 200 MB 默认配额，不回收撑不了几个月。
//
// 【为什么不放在请求路径里】清理是重 IO（扫所有 manifest、遍历对象目录），
// 挂在请求上会让某个用户的提交偶发变慢；而且清理失败不该影响任何一次提交。
//
// 🔴 三条安全底线（都不是"顺手可改"的参数）：
//   1. **顺序**：先清回收站（删项目目录）再回收对象。反过来的话，刚被清掉的项目
//      引用的对象还没变成"无人引用"，这一轮就白扫了。
//   2. **宽限期归 `objectGc` 管**（默认 24h）：客户端"先传对象、后提交清单"，
//      提交之前那些对象看起来就是没人引用。这里**不许**传更小的 graceMs。
//   3. **按账号隔离**：对象库是按账号分目录的，跨账号扫会把别人的对象算成孤儿。
//
// 🔴 定时器一律 `unref()`：维护任务绝不能成为"进程退不掉"的原因
//    （便携版 / 测试脚本会 import 到本模块）。
import fs from 'node:fs'
import path from 'node:path'
import { accountRoot } from './v2Index.mjs'
import { gcObjects, purgeDeletedProjects } from './objectGc.mjs'

/** 默认 6 小时一轮：清理不是时效性任务，跑太勤只是白扫盘 */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
/**
 * 首轮延迟 5 分钟。
 * 🔴 不在启动瞬间跑：部署/重启往往连着来好几次，每次启动都全盘扫一遍纯属浪费，
 *    而且启动那一刻正好是"最不该抢 IO"的时候（服务刚起来，用户正在登录）。
 */
export const DEFAULT_FIRST_DELAY_MS = 5 * 60 * 1000

/** 列出所有账号目录（没有 v2 数据时返回空数组，不抛） */
export function listAccounts(v2Root) {
  try {
    return fs.readdirSync(path.join(v2Root, 'accounts'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^u_[A-Za-z0-9]+$/.test(n))
  } catch {
    return []
  }
}

/**
 * 跑一轮维护（同步、可重复调用）。
 *
 * @param {object} o
 * @param {string} o.v2Root  `<DATA_DIR>/v2`
 * @param {(s:string)=>void} [o.log]
 * @param {number} [o.now]   注入时间（自检用）
 * @param {boolean} [o.dryRun] 只统计不删（自检/排障用）
 * @returns {{accounts:number, purged:string[], objectsRemoved:number, freedBytes:number, errors:{account:string,error:string}[]}}
 */
export function runMaintenanceOnce(o) {
  const v2Root = o.v2Root
  const now = o.now ?? Date.now()
  const dryRun = !!o.dryRun
  const accounts = listAccounts(v2Root)
  const purged = []
  let objectsRemoved = 0
  let freedBytes = 0
  const errors = []

  for (const accountId of accounts) {
    const root = accountRoot(v2Root, accountId)
    // ① 回收站到期清理（只清"标了 deletedAt 且超过 30 天"的，见 objectGc 注释）
    try {
      const p = purgeDeletedProjects(root, { now, dryRun })
      for (const pid of p.purged) purged.push(`${accountId}/${pid}`)
    } catch (e) {
      // 单个账号失败不能拖垮整轮：记下来，其他账号继续
      errors.push({ account: accountId, error: e && e.message ? String(e.message) : String(e) })
      continue
    }
    // ② 对象回收（宽限期由 objectGc 的默认值兜底，这里不传更小的值）
    try {
      const g = gcObjects(root, { now, dryRun })
      objectsRemoved += g.removed
      freedBytes += g.freedBytes
    } catch (e) {
      errors.push({ account: accountId, error: e && e.message ? String(e.message) : String(e) })
    }
  }

  return { accounts: accounts.length, purged, objectsRemoved, freedBytes, errors }
}

/**
 * 造一个调度器。**默认不自动开**（`index.mjs` 决定开不开），方便自检与将来做成可配置。
 *
 * @param {object} o
 * @param {string} o.v2Root
 * @param {number} [o.intervalMs]
 * @param {number} [o.firstDelayMs]
 * @param {(s:string)=>void} [o.log]
 * @param {()=>number} [o.now]
 */
export function createScheduler(o) {
  const intervalMs = Math.max(60_000, o.intervalMs ?? DEFAULT_INTERVAL_MS)
  const firstDelayMs = Math.max(0, o.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS)
  const log = o.log || (() => {})
  const now = o.now || Date.now
  let timer = null
  let kickoff = null
  let running = false
  let last = null

  const runOnce = () => {
    // 🔴 不重入：上一轮还在扫盘时又起一轮，只会让 IO 翻倍，结果还可能互相踩
    if (running) {
      log('[maint] 上一轮还没跑完，跳过这一轮')
      return null
    }
    running = true
    const t0 = now()
    try {
      const r = runMaintenanceOnce({ v2Root: o.v2Root, now: now(), dryRun: !!o.dryRun })
      const mb = (r.freedBytes / 1048576).toFixed(2)
      const err = r.errors.length ? `，失败 ${r.errors.length} 个账号` : ''
      log(`[maint] ${r.accounts} 个账号：清回收站 ${r.purged.length} 项、`
        + `回收对象 ${r.objectsRemoved} 个 / ${mb} MiB，用时 ${now() - t0}ms${err}`)
      for (const e of r.errors) log(`[maint]   ${e.account} 失败：${e.error}`)
      last = { at: now(), ...r }
      return last
    } catch (e) {
      // 整轮崩了也不能让定时器停：下一轮还会来
      log(`[maint] 整轮失败：${e && e.message ? e.message : e}`)
      return null
    } finally {
      running = false
    }
  }

  return {
    /** 开始定时（幂等） */
    start() {
      if (timer || kickoff) return
      kickoff = setTimeout(() => { kickoff = null; runOnce() }, firstDelayMs)
      if (kickoff.unref) kickoff.unref()
      timer = setInterval(runOnce, intervalMs)
      if (timer.unref) timer.unref()
      log(`[maint] 维护任务已启动：首轮 ${Math.round(firstDelayMs / 1000)}s 后，之后每 ${Math.round(intervalMs / 3600000)} 小时`)
    },
    stop() {
      if (kickoff) { clearTimeout(kickoff); kickoff = null }
      if (timer) { clearInterval(timer); timer = null }
    },
    /** 立刻跑一轮（自检 / 运维手动触发） */
    runNow: runOnce,
    isRunning: () => running,
    lastRun: () => last,
  }
}
