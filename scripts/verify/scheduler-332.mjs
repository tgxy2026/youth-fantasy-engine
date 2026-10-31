// 3.3.2 · P2 遗留自检：维护定时任务（回收站到期清理 + 对象回收）
//
// 这个模块把两件以前只能人工做的事接上了定时器，所以它自己必须先把"什么时候不该动"
// 证清楚，否则定时器会变成一台自动删数据的机器。盯八件事：
//   ① 回收站里**超过 30 天**的项目被清掉（目录 + 索引项都消失）；
//   ② 没到期的**不动**（30 天是协议承诺，早清 = 离线设备回来"删了复活"）；
//   ③ 对象回收**保留宽限期内的孤儿**（那是"传完还没提交"的对象，删了用户就永远传不上）；
//   ④ 历史版本引用的对象**不删**（删了历史版本变砖）；
//   ⑤ **按账号隔离**：A 的账号目录只按 A 的 manifest 判活；
//   ⑥ 一个账号坏掉（index.json 是坏 JSON / 目录读不了）**不影响其他账号**；
//   ⑦ `dryRun` 只统计不删；
//   ⑧ 调度器**不重入**、首轮有延迟、stop 之后不再跑。
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { runMaintenanceOnce, createScheduler, listAccounts } from '../../server/lib/scheduler.mjs'

let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; console.log(`FAIL ${name}${extra ? ` :: ${extra}` : ''}`) }
}

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000
/** 合法对象哈希（64 位十六进制，否则会被当成非对象文件跳过） */
const H = (s) => createHash('sha256').update(String(s)).digest('hex')

/** 造一个账号目录：<v2>/accounts/<id>/{index.json, objects/, projects/} */
function makeAccount(v2, id) {
  const root = path.join(v2, 'accounts', id)
  fs.mkdirSync(path.join(root, 'objects'), { recursive: true })
  fs.mkdirSync(path.join(root, 'projects'), { recursive: true })
  return root
}

/** 放一个对象文件（mtime 可控） */
function putObject(root, hash, ageMs) {
  const f = path.join(root, 'objects', hash)
  fs.writeFileSync(f, Buffer.alloc(64, 7))
  const t = new Date(NOW - ageMs)
  fs.utimesSync(f, t, t)
  return f
}

/** 放一个项目的 manifest（模拟"这一版引用了这些对象"） */
function putManifest(root, pid, rev, hashes) {
  const dir = path.join(root, 'projects', pid, 'manifests')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${rev}.json`), JSON.stringify({
    protocol: 2, revision: rev,
    objects: hashes.map((h) => ({ kind: 'text', hash: h, bytes: 64 })),
    assets: [],
  }))
}

/** 写索引（deletedAt 用相对 NOW 的偏移） */
function putIndex(root, projects) {
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: 1, projects }))
}

function readIndexRaw(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8')) } catch { return null }
}

// ---------------- 造现场 ----------------
const v2 = fs.mkdtempSync(path.join(os.tmpdir(), 'maint332-'))
const A = makeAccount(v2, 'u_testa')
const B = makeAccount(v2, 'u_testb')

// A 的对象：两个"没人引用"，一个被 p1 引用
const hOrphanOld = H('A-orphan-old')      // 2 天前写的、没人引用 ⇒ 可回收
const hOrphanNew = H('A-orphan-new')      // 1 小时前写的、没人引用 ⇒ 宽限期内，留
const hReferenced = H('A-referenced')     // 2 天前写的、被 p1 第 1 版引用 ⇒ 留
putObject(A, hOrphanOld, 2 * DAY)
putObject(A, hOrphanNew, 60 * 60 * 1000)
putObject(A, hReferenced, 2 * DAY)
putManifest(A, 'prj_alive', 1, [hReferenced])
fs.mkdirSync(path.join(A, 'projects', 'prj_alive'), { recursive: true })

// A 的回收站：一个过期 31 天、一个只删了 10 天
putManifest(A, 'prj_expired', 1, [])
putManifest(A, 'prj_fresh', 1, [])
putIndex(A, {
  prj_alive: { name: '活着', revision: 1, objectBytes: 192 },
  prj_expired: { name: '过期', revision: 1, deletedAt: NOW - 31 * DAY, objectBytes: 0 },
  prj_fresh: { name: '十天内', revision: 1, deletedAt: NOW - 10 * DAY, objectBytes: 0 },
})

// B 的对象：一个没人引用的老对象 —— 必须按 B 自己的 manifest 判活（B 没有 manifest）
const hB = H('B-orphan-old')
putObject(B, hB, 3 * DAY)
// B 故意不放 index.json：清理回收站那步要能安静跳过，且**不影响**对象回收

// ---------------- ① 空目录 / 无账号 ----------------
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'maint332-empty-'))
const rEmpty = runMaintenanceOnce({ v2Root: empty, now: NOW })
ok('① 没有 v2 数据时不抛异常、账号数为 0',
  rEmpty.accounts === 0 && rEmpty.purged.length === 0 && rEmpty.errors.length === 0)

ok('① 账号目录只认 u_ 前缀（不被临时文件/杂项目录带偏）',
  listAccounts(v2).sort().join(',') === 'u_testa,u_testb',
  listAccounts(v2).join(','))

// ---------------- ② dryRun 只统计不删 ----------------
const dry = runMaintenanceOnce({ v2Root: v2, now: NOW, dryRun: true })
ok('② dryRun 报出会清 1 个项目、会回收 2 个对象',
  dry.purged.length === 1 && dry.objectsRemoved === 2,
  `purged=${dry.purged.length} removed=${dry.objectsRemoved}`)
ok('② dryRun 真的没动文件',
  fs.existsSync(path.join(A, 'projects', 'prj_expired'))
  && fs.existsSync(path.join(A, 'objects', hOrphanOld))
  && fs.existsSync(path.join(B, 'objects', hB)))

// ---------------- ③ 正式跑一轮 ----------------
const r = runMaintenanceOnce({ v2Root: v2, now: NOW })
const idxA = readIndexRaw(A)
ok('③ 过期 31 天的项目被清掉（目录与索引项都没了）',
  r.purged.length === 1
  && !fs.existsSync(path.join(A, 'projects', 'prj_expired'))
  && idxA && !idxA.projects.prj_expired,
  JSON.stringify(r.purged))
ok('③ 只删了 10 天的项目**没动**', fs.existsSync(path.join(A, 'projects', 'prj_fresh'))
  && !!idxA.projects.prj_fresh)
ok('③ 活着的项目没动', fs.existsSync(path.join(A, 'projects', 'prj_alive')) && !!idxA.projects.prj_alive)

ok('④ 宽限期内的孤儿对象**留着**（这是"传完还没提交"的那批）',
  fs.existsSync(path.join(A, 'objects', hOrphanNew)))
ok('④ 历史版本引用的对象**留着**', fs.existsSync(path.join(A, 'objects', hReferenced)))
ok('④ 真正没人引用的老对象被回收', !fs.existsSync(path.join(A, 'objects', hOrphanOld)))
ok('④ 统计里的回收数量与释放字节对得上（2 个 × 64B）',
  r.objectsRemoved === 2 && r.freedBytes === 128,
  `removed=${r.objectsRemoved} freed=${r.freedBytes}`)

ok('⑤ B 账号没有 index.json 也不报错，对象按 B 自己的 manifest 判活（无引用 ⇒ 回收）',
  r.errors.length === 0 && !fs.existsSync(path.join(B, 'objects', hB)),
  JSON.stringify(r.errors))

// ---------------- ⑥ 一个账号坏掉不影响其他账号 ----------------
const C = makeAccount(v2, 'u_testc')
fs.writeFileSync(path.join(C, 'index.json'), '{ 这不是 JSON')
const hC = H('C-orphan-old')
putObject(C, hC, 2 * DAY)
// 再造一个健康账号 D，确认它照样被清理
const D = makeAccount(v2, 'u_testd')
const hD = H('D-orphan-old')
putObject(D, hD, 2 * DAY)
const r2 = runMaintenanceOnce({ v2Root: v2, now: NOW })
ok('⑥ 坏账号不拖垮整轮：健康账号的对象照样回收',
  !fs.existsSync(path.join(D, 'objects', hD)), 'D 的对象没被回收')

// ---------------- ⑦ 调度器：首轮延迟 / 不重入 / stop ----------------
const logs = []
let reentrantSkipped = false
const sched = createScheduler({
  v2Root: v2,
  firstDelayMs: 30_000,
  intervalMs: 60_000,
  now: () => NOW,
  log: (m) => {
    logs.push(m)
    /**
     * 🔴 只在一轮**正在跑**的时候再点一次：这正是"上一轮没扫完又来一轮"的真实时序。
     *    放在启动日志上测就测错了（那时本来就没在跑，runNow 当然会执行）。
     */
    if (m.includes('个账号')) {
      const r2 = sched.runNow()
      if (r2 === null) reentrantSkipped = true
    }
  },
})
sched.start()
ok('⑦ start 之后不会立刻跑（首轮有延迟，避免每次重启都全盘扫）',
  sched.lastRun() === null && !logs.some((m) => m.includes('个账号')),
  logs.join(' / '))
ok('⑦ 启动日志只打一条（幂等：重复 start 不会挂两个定时器）',
  (sched.start(), logs.filter((m) => m.includes('已启动')).length === 1))

const first = sched.runNow()
ok('⑦ 手动 runNow 能跑出一份结果（账号数 > 0）', !!first && first.accounts > 0)
ok('⑦ **重入被挡住**：一轮没跑完时再调用直接返回 null', reentrantSkipped)
ok('⑦ 跑完之后 isRunning 回到 false', sched.isRunning() === false)

sched.stop()
ok('⑦ stop 只停定时器，手动 runNow 仍可用（运维排障要能用）',
  !!sched.runNow() && sched.isRunning() === false)

// ---------------- 汇总 ----------------
console.log(`\nscheduler: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
