// ============ 3.3.2 · P2 遗留 · 对象回收与回收站清理 ============
//
// 【为什么必须有】内容寻址的对象库只增不减：每提交一版就多一批对象，
// 旧版本的 manifest 被清理后，它引用的对象仍然躺在盘上。一本 40 MB 的书改十次，
// 盘上可能躺着 200 MB。1.7 GB 的服务器撑不了多久。
//
// 🔴 **宽限期是这套回收的唯一安全阀**，不是"顺手加个参数"：
//    客户端上传对象的顺序是「先传对象 → 再提交清单」。在提交发生之前，
//    这些对象**不在任何 manifest 里** —— 看起来就是"没人引用"。
//    没有宽限期就会把用户正在上传的对象删掉，然后提交时报 OBJECT_MISSING，
//    重试也一样（对象永远传一半被删）。默认 24 小时。
//
// 🔴 回收**只删对象文件**，不碰 manifest、不碰 state、不碰索引。
//    删 manifest 是 `projectStore.pruneRevisions` 的事，两件事分开，
//    免得"清理空间"顺手把历史版本弄没。
//
// 🔴 回收必须**按账号**做：对象库是按账号隔离的（见 `projectApi` 顶部），
//    跨账号扫会把别人的对象算成"没人引用"。
import fs from 'node:fs'
import path from 'node:path'
import { readIndex, writeIndex } from './v2Index.mjs'
import { acquireProjectLock, getProjectState } from './projectStore.mjs'

/** 对象的宽限期：必须远大于"上传完但还没提交"的窗口 */
export const GC_GRACE_MS = 24 * 60 * 60 * 1000
/** 回收站保留期：与墓碑 30 天对齐 */
export const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000

const objectsDir = (accountRoot) => path.join(accountRoot, 'objects')
const projectsDir = (accountRoot) => path.join(accountRoot, 'projects')

/** 列出对象库里的所有哈希（文件名即哈希） */
function listObjectFiles(accountRoot) {
  const dir = objectsDir(accountRoot)
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.filter((n) => /^[0-9a-f]{64}$/.test(n))
}

/**
 * 收集所有**被引用**的对象哈希。
 *
 * 扫描范围：每个项目目录下的所有 manifest（含历史版本）。
 * 🔴 必须扫历史：历史版本还能被 `GET /revisions/:rev/manifest` 读到、
 *    用户也可能从历史里恢复，把它引用的对象删了等于历史版本变砖。
 */
export function collectReferenced(accountRoot) {
  const refs = new Set()
  const root = projectsDir(accountRoot)
  let pids = []
  try { pids = fs.readdirSync(root) } catch (error) {
    if (error?.code === 'ENOENT') return refs
    throw Object.assign(new Error('PROJECT_DATA_READ_FAILED'), { code: 'PROJECT_DATA_READ_FAILED' })
  }
  for (const pid of pids) {
    const mdir = path.join(root, pid, 'manifests')
    let files = []
    try { files = fs.readdirSync(mdir) } catch {
      throw Object.assign(new Error('PROJECT_DATA_READ_FAILED'), { code: 'PROJECT_DATA_READ_FAILED' })
    }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue
      try {
        const m = JSON.parse(fs.readFileSync(path.join(mdir, f), 'utf8'))
        if (!m || typeof m !== 'object' || Array.isArray(m) ||
          (m.objects != null && !Array.isArray(m.objects)) || (m.assets != null && !Array.isArray(m.assets))) throw new Error('invalid manifest')
        if ([...(m.objects || []), ...(m.assets || [])].some(o => !o || typeof o.hash !== 'string' || !/^[0-9a-f]{64}$/.test(o.hash))) throw new Error('invalid reference')
        for (const o of m.objects || []) if (o && typeof o.hash === 'string') refs.add(o.hash)
        for (const a of m.assets || []) if (a && typeof a.hash === 'string') refs.add(a.hash)
      } catch {
        // 不能证明引用完整时整轮停止；宽限期不能保护已存在很久的对象。
        throw Object.assign(new Error('PROJECT_DATA_INVALID'), { code: 'PROJECT_DATA_INVALID' })
      }
    }
  }
  return refs
}

/**
 * 回收无人引用的对象。
 *
 * @param opts.graceMs 宽限期（默认 24h）
 * @param opts.dryRun 只统计不删（先看会删多少，再决定）
 * @returns {{ scanned, referenced, removed, freedBytes, keptRecent, dryRun }}
 */
export function gcObjects(accountRoot, opts = {}) {
  const now = opts.now ?? Date.now()
  const graceMs = opts.graceMs ?? GC_GRACE_MS
  const dryRun = !!opts.dryRun

  // 索引或当前版本缺失时无法证明引用集合完整，不做任何删除。
  const index = readIndex(path.dirname(path.dirname(accountRoot)), path.basename(accountRoot))
  for (const [pid, entry] of Object.entries(index.projects)) {
    if (Number(entry?.revision) > 0) {
      const state = getProjectState(accountRoot, pid, path.basename(accountRoot))
      if (state.revision < 1) throw Object.assign(new Error('PROJECT_DATA_MISSING'), { code: 'PROJECT_DATA_MISSING' })
    }
  }
  const refs = collectReferenced(accountRoot)
  const files = listObjectFiles(accountRoot)
  const dir = objectsDir(accountRoot)
  let removed = 0, freedBytes = 0, keptRecent = 0

  for (const name of files) {
    if (refs.has(name)) continue
    const file = path.join(dir, name)
    let st
    try { st = fs.statSync(file) } catch { continue }
    // 🔴 宽限期：可能是"正在上传、还没提交"的对象
    if (now - st.mtimeMs < graceMs) { keptRecent++; continue }
    freedBytes += st.size
    removed++
    if (!dryRun) {
      try { fs.unlinkSync(file) } catch { removed--; freedBytes -= st.size }
    }
  }
  return { scanned: files.length, referenced: refs.size, removed, freedBytes, keptRecent, dryRun }
}

/**
 * 清理回收站里过期的项目。
 *
 * 🔴 只清"索引里标了 deletedAt 且超过 TTL"的：墓碑 30 天是协议承诺，
 *    提前清会让离线设备回来时"删了复活"（它还会推上来）。
 * 🔴 清项目目录时**不动对象**：对象可能被他项目引用，交给 `gcObjects`。
 * @returns {{ purged: string[], kept: number, dryRun }}
 */
export function purgeDeletedProjects(accountRoot, opts = {}) {
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlMs ?? TRASH_TTL_MS
  const dryRun = !!opts.dryRun
  const v2Root = path.dirname(path.dirname(accountRoot))
  const accountId = path.basename(accountRoot)
  const idx = readIndex(v2Root, accountId)
  const projects = idx.projects || {}
  const purged = []
  let kept = 0
  for (const [pid, p] of Object.entries(projects)) {
    const deletedAt = Number(p?.deletedAt) || 0
    if (!deletedAt) continue
    if (now - deletedAt < ttlMs) { kept++; continue }
    if (!/^[A-Za-z0-9_-]+$/.test(pid)) throw Object.assign(new Error('PROJECT_DATA_INVALID'), { code: 'PROJECT_DATA_INVALID' })
    const lock = acquireProjectLock(accountRoot, pid)
    try {
      // 重新读取索引和状态，恢复或更新后的作品不能被旧列表删除。
      const latest = readIndex(v2Root, accountId)
      const entry = latest.projects[pid]
      const state = getProjectState(accountRoot, pid, accountId)
      if (!entry || !state.deleted || !state.deletedAt || now - state.deletedAt < ttlMs ||
          Number(entry.revision) !== state.revision || !entry.deletedAt || now - Number(entry.deletedAt) < ttlMs ||
          (entry.snapshotId && entry.snapshotId !== state.snapshotId)) {
        throw Object.assign(new Error('PROJECT_DATA_INVALID'), { code: 'PROJECT_DATA_INVALID' })
      }
      if (!dryRun) {
        // 先移到同账号隔离区；索引写失败时恢复目录，避免先删数据再丢失索引。
        const source = path.join(projectsDir(accountRoot), pid)
        const pendingRoot = path.join(accountRoot, 'purge-pending')
        const pending = path.join(pendingRoot, pid)
        fs.mkdirSync(pendingRoot, { recursive: true })
        if (fs.existsSync(pending)) throw Object.assign(new Error('PROJECT_DATA_RECOVERY_REQUIRED'), { code: 'PROJECT_DATA_RECOVERY_REQUIRED' })
        fs.renameSync(source, pending)
        try {
          delete latest.projects[pid]
          writeIndex(v2Root, accountId, latest)
        } catch (error) {
          try { fs.renameSync(pending, source) } catch {
            throw Object.assign(new Error('PROJECT_DATA_RECOVERY_REQUIRED'), { code: 'PROJECT_DATA_RECOVERY_REQUIRED' })
          }
          throw error
        }
        // 清理失败保留隔离目录，供人工检查；索引已提交，不应误报回收未发生。
        try { fs.rmSync(pending, { recursive: true, force: true }) } catch { /* 保留证据 */ }
      }
      purged.push(pid)
    } finally { lock.release() }
  }
  return { purged, kept, dryRun }
}

/** 回收站里还有哪些（给运维看） */
export function listTrash(accountRoot, now = Date.now()) {
  const idxFile = path.join(accountRoot, 'index.json')
  let idx
  try { idx = JSON.parse(fs.readFileSync(idxFile, 'utf8')) } catch { return [] }
  return Object.entries(idx.projects || {})
    .filter(([, p]) => Number(p?.deletedAt) > 0)
    .map(([pid, p]) => ({
      pid,
      deletedAt: Number(p.deletedAt),
      name: p.name || '',
      bytes: Number(p.objectBytes) || 0,
      expiresInMs: Math.max(0, TRASH_TTL_MS - (now - Number(p.deletedAt))),
    }))
    .sort((a, b) => b.deletedAt - a.deletedAt)
}
