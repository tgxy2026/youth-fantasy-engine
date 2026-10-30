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

/** 该项目的对象字节（配额口径：按 manifest 声明累加，跨项目去重不折抵） */
export function projectBytes(idx, pid) {
  const p = idx.projects?.[pid]
  return p ? (p.objectBytes || 0) : 0
}

export function accountUsedBytes(idx) {
  return Object.values(idx.projects || {}).reduce((n, p) => n + (p.objectBytes || 0), 0)
}

/** 更新一个项目的索引项（迁移与提交共用；字段合并而不是整体替换） */
export function setProjectMeta(v2Root, accountId, pid, patch) {
  const idx = readIndex(v2Root, accountId)
  idx.projects = idx.projects || {}
  idx.projects[pid] = { ...(idx.projects[pid] || {}), ...patch, updatedAt: patch.updatedAt ?? Date.now() }
  writeIndex(v2Root, accountId, idx)
  return idx.projects[pid]
}
