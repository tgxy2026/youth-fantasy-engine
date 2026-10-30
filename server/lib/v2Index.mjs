// ============ 3.3.2 · v2 账号索引（HTTP 层与迁移脚本共用）============
//
// 【为什么单独抽出来】`index.json` 有两件事必须只有一份实现：
//   ① 「这个账号有哪些云端作品、各在哪个 revision」——列表、迁移、运维都读它；
//   ② 「这个账号用了多少字节」——配额靠它，两套算法必然对不上。
// 原先这套逻辑长在 `projectApi.mjs` 里（请求耦合），迁移脚本要用就只得复制一份 ——
// 而复制出来的第二份迟早与第一份漂移。故抽成叶子模块：只做文件读写，不认识 req/res。
//
// 🔴 目录布局：`<v2Root>/accounts/<accId>/`
//      index.json      列表与配额
//      objects/        内容库（按账号隔离，见 projectApi 顶部说明）
//      projects/       manifest 与 state
//      locks/          项目锁
//      legacy-gate.json 旧路径门禁
import fs from 'node:fs'
import path from 'node:path'

export const V2_INDEX_FILE = 'index.json'

export const accountRoot = (v2Root, accountId) => path.join(v2Root, 'accounts', accountId)
export const indexFile = (v2Root, accountId) => path.join(accountRoot(v2Root, accountId), V2_INDEX_FILE)

/** 读索引；不存在/损坏都返回空索引（损坏不该让列表页 500，调用方会重新写） */
export function readIndex(v2Root, accountId) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(v2Root, accountId), 'utf8'))
    if (!raw || typeof raw !== 'object' || typeof raw.projects !== 'object') return { projects: {} }
    return raw
  } catch {
    return { projects: {} }
  }
}

/** 原子写索引（tmp + rename） */
export function writeIndex(v2Root, accountId, idx) {
  const file = indexFile(v2Root, accountId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(idx))
  fs.renameSync(tmp, file)
}

/** 该项目的对象字节（该项目自己看到的总量，不折抵与他人共享的对象） */
export function projectBytes(idx, pid) {
  const p = idx.projects?.[pid]
  return p ? (p.objectBytes || 0) : 0
}

/**
 * 账号已用字节 —— **按对象哈希去重**。
 *
 * 🔴 老实现是把每个项目的 `objectBytes` 直接相加，而对象库是账号级的：
 *    两本书共用一张同样的封面时，盘上只存一份，配额却算了两份。
 *    用户什么都没多做，空间就"凭空少了"。
 * 🔴 已删除（在回收站）的项目**不计入**：物理空间还在盘上，但让用户为
 *    "看不见的东西"付配额是更糟的体验；那部分由 `objectGc.purgeDeletedProjects`
 *    在 30 天后真正清掉。
 * 🔴 老记录没有 `objects`（3.3.2 之前写的索引）时退回 `objectBytes` 并单列一个键，
 *    避免与真实哈希撞在一起。
 */
export function accountUsedBytes(idx) {
  const seen = new Map()
  for (const [pid, p] of Object.entries(idx.projects || {})) {
    if (!p || p.deletedAt) continue
    const list = Array.isArray(p.objects) ? p.objects : []
    if (!list.length) {
      // 老记录：没有对象清单，只能按声明值算（不能静默当 0，否则配额突然放宽）
      seen.set(`__legacy__${pid}`, Number(p.objectBytes) || 0)
      continue
    }
    for (const o of list) {
      if (!o || typeof o.hash !== 'string' || seen.has(o.hash)) continue
      seen.set(o.hash, Number(o.bytes) || 0)
    }
  }
  let total = 0
  for (const v of seen.values()) total += v
  return total
}

/**
 * 假设把 `pid` 换成 `objects` 之后，账号总共会用多少字节。
 *
 * 用于提交前的配额判断。不能写成 `已用 - 本项目 + 新增`：
 * 本项目与他人共享的对象会被减掉两次（减的时候按项目算，加的时候按去重算）。
 */
export function projectedUsedBytes(idx, pid, objects = []) {
  const seen = new Map()
  for (const [key, p] of Object.entries(idx.projects || {})) {
    if (!p || p.deletedAt || key === pid) continue
    const list = Array.isArray(p.objects) ? p.objects : []
    if (!list.length) { seen.set(`__legacy__${key}`, Number(p.objectBytes) || 0); continue }
    for (const o of list) {
      if (!o || typeof o.hash !== 'string' || seen.has(o.hash)) continue
      seen.set(o.hash, Number(o.bytes) || 0)
    }
  }
  for (const o of objects) {
    if (!o || typeof o.hash !== 'string' || seen.has(o.hash)) continue
    seen.set(o.hash, Number(o.bytes) || 0)
  }
  let total = 0
  for (const v of seen.values()) total += v
  return total
}

/** 更新一个项目的索引项（迁移与提交共用；字段合并而不是整体替换） */
export function setProjectMeta(v2Root, accountId, pid, patch) {
  const idx = readIndex(v2Root, accountId)
  idx.projects = idx.projects || {}
  idx.projects[pid] = { ...(idx.projects[pid] || {}), ...patch, updatedAt: patch.updatedAt ?? Date.now() }
  writeIndex(v2Root, accountId, idx)
  return idx.projects[pid]
}
