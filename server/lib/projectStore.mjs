// ============ 3.3.2 · P2 项目版本服务（存储与提交事务）============
//
// 【它是什么】把「一本作品」存成**不可变快照序列**：内容对象按哈希寻址 + manifest 指针 +
//   单调递增 revision。3.3.1 及之前的云端是**整库覆盖**（`/api/data` 一次写全部作品），
//   多设备一开就会互相踩；本模块是项目级协议的地基（协议草案见
//   `docs/3.3.2-P2同步协议草案-v1-2026-10-30.md`）。
//
// 【为什么不是「直接上数据库」】这台服务器是 2C/1.7GB + 2GB swap，且现状是「备份=拷一个目录」。
//   文件 + 锁 + 原子 rename 能给出与本地事务等价的**可见性保证**（读者永远看到某个完整
//   revision），而运维成本不变。真到需要 SQL 的规模，换实现只需替换本文件。
//
// 🔴 四条从原型实测里换来的硬约束（`.workbuddy/tmp/proto-p0-t6/`，V1/V2/V3/V5）：
//   1. **提交点唯一**＝`state.json` 的那次原子替换。manifest 先写、对象先落，都只是暂存；
//      状态没换过去，读者看到的就是旧 revision（不会半提交）。
//   2. **幂等记录必须与 revision 推进同一次写入**。分开写就会出现「状态已提交、opId 没记上」
//      ⇒ 客户端重试变成二次发布（原型里靠「回执丢失 + 同 opId 重试」验证过）。
//   3. **先删后验/先占后用**在 code、锁、幂等三处同理：宁可这次失败，也不给重试留下歧义。
//   4. **对象必须流式落盘**（V4）：40 MiB 载荷全量缓冲时 RSS 峰值 +220 MiB（5.5×），
//      1.7GB 机器 5 个并发就触顶。这里的 `stageObject` 只接受流，不接受整块 Buffer。
//
// 🔴 本文件不含 HTTP、不含账号鉴权：调用方（路由层）必须先用 `accountId` 校验归属，
//    本模块只保证「同一项目内的提交是串行且原子的」。授权缺失不能被这里的锁掩盖。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'

/** 协议版本：不兼容的改动必须升它，客户端据此拒写而不是「尽力而为」 */
export const PROTOCOL_VERSION = 1
/** 墓碑保留期（与规划 §7 的 30 天一致；过期后设备必须全量重建） */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 幂等记录保留期：要覆盖「离线很久后重试」的场景 */
export const OP_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 单对象上限：V4 结论——不做流式时的安全阈值；本模块已流式，仍保留上限防滥用 */
export const MAX_OBJECT_BYTES = 64 * 1024 * 1024
const LOCK_TIMEOUT_MS = 15_000
const LOCK_STALE_MS = 30_000

// ---------- 路径 ----------
const p = {
  objects: (root) => path.join(root, 'objects'),
  projects: (root) => path.join(root, 'projects'),
  project: (root, pid) => path.join(root, 'projects', pid),
  manifests: (root, pid) => path.join(root, 'projects', pid, 'manifests'),
  state: (root, pid) => path.join(root, 'projects', pid, 'state.json'),
  lock: (root, pid) => path.join(root, 'locks', `${pid}.lock`),
  epoch: (root) => path.join(root, 'epoch.json'),
}

function ensureDirs(root, pid) {
  fs.mkdirSync(p.objects(root), { recursive: true })
  fs.mkdirSync(p.manifests(root, pid), { recursive: true })
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true })
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const okHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)

/** 原子写小文件（state / manifest）：tmp + fsync + rename */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return def }
}

// ---------- 锁 ----------
export function acquireProjectLock(root, pid) {
  const file = p.lock(root, pid)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, `${process.pid}@${Date.now()}`)
      fs.closeSync(fd)
      return {
        release() { try { fs.unlinkSync(file) } catch { /* 已被清理 */ } },
      }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e
      try {
        const st = fs.statSync(file)
        // 持有者崩溃后锁文件会留下：超过陈旧阈值就回收，否则永远卡死
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(file); continue }
      } catch { /* 竞争中被删，直接重试 */ }
      if (Date.now() > deadline) throw new Error('LOCK_TIMEOUT')
      const until = Date.now() + 5 + Math.floor(Math.random() * 10)
      while (Date.now() < until) { /* 短自旋 */ }
    }
  }
}

// ---------- 世代 ----------
export function readEpoch(root) {
  return readJSON(p.epoch(root), { epoch: 1 }).epoch ?? 1
}

/** 提升数据世代（迁移/恢复用）：旧基线在新世代全部失效，客户端必须全量重建 */
export function bumpEpoch(root, reason = '') {
  const cur = readEpoch(root)
  const next = cur + 1
  writeAtomic(p.epoch(root), JSON.stringify({ epoch: next, at: Date.now(), reason }))
  return next
}

// ---------- 对象 ----------
/**
 * 流式暂存内容对象。
 *
 * @param {object} o
 * @param {string} o.root
 * @param {string} o.pid 项目 id（仅用于目录组织与上限统计，内容本身全局去重）
 * @param {string} o.hash 客户端声明的 sha256（hex）
 * @param {import('node:stream').Readable|AsyncIterable<Uint8Array>} o.stream
 * @returns {Promise<{ ok: true, hash: string, bytes: number, reused: boolean }
 *                  | { ok: false, code: 'HASH_MISMATCH'|'TOO_LARGE'|'NO_STREAM', bytes?: number }>}
 */
export async function stageObject({ root, pid, hash, stream }) {
  if (!okHash(hash)) return { ok: false, code: 'HASH_MISMATCH' }
  if (!stream) return { ok: false, code: 'NO_STREAM' }
  ensureDirs(root, pid)
  const target = path.join(p.objects(root), `${hash}.bin`)
  // 同内容已存在就不必重传（内容寻址的天然去重）——但**不校验调用方账号**，
  // 归属校验在路由层：否则 A 账号可以用「猜哈希」探测 B 的内容是否存在。
  if (fs.existsSync(target)) {
    const st = fs.statSync(target)
    return { ok: true, hash, bytes: st.size, reused: true }
  }
  const tmp = path.join(root, 'tmp', `${hash}.${process.pid}.${Date.now()}.part`)
  const h = crypto.createHash('sha256')
  let bytes = 0
  let tooLarge = false
  const counter = new (await import('node:stream')).Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length
      if (bytes > MAX_OBJECT_BYTES) { tooLarge = true; cb(new Error('TOO_LARGE')); return }
      h.update(chunk)
      cb(null, chunk)
    },
  })
  try {
    await pipeline(stream, counter, fs.createWriteStream(tmp))
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    if (tooLarge) return { ok: false, code: 'TOO_LARGE', bytes }
    throw e
  }
  const actual = h.digest('hex')
  if (actual !== hash) {
    // 哈希不符＝传输损坏或被篡改：删掉暂存，绝不让它进对象库
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    return { ok: false, code: 'HASH_MISMATCH', bytes }
  }
  fs.renameSync(tmp, target)
  return { ok: true, hash, bytes, reused: false }
}

export function objectPath(root, hash) {
  return path.join(p.objects(root), `${hash}.bin`)
}

export function hasObject(root, hash) {
  return okHash(hash) && fs.existsSync(objectPath(root, hash))
}

// ---------- 状态 ----------
function readState(root, pid, accountId) {
  const st = readJSON(p.state(root, pid), null)
  if (st) return st
  return { protocol: PROTOCOL_VERSION, accountId, revision: 0, snapshotId: '', epoch: readEpoch(root), tombs: [], ops: {} }
}

/** 读取项目对外状态（不含幂等表细节） */
export function getProjectState(root, pid, accountId) {
  const st = readState(root, pid, accountId)
  return {
    revision: st.revision,
    snapshotId: st.snapshotId,
    epoch: st.epoch,
    tombstoneCount: (st.tombs || []).length,
  }
}

export function readManifest(root, pid, rev) {
  const file = path.join(p.manifests(root, pid), `${rev}.json`)
  return readJSON(file, null)
}

/** 当前有效墓碑（已按 TTL 清理） */
export function effectiveTombstones(root, pid, now = Date.now()) {
  const st = readState(root, pid, '')
  return (st.tombs || []).filter((t) => now - (t.deletedAt || 0) <= TOMBSTONE_TTL_MS)
}

/**
 * 提交一次快照。
 *
 * 调用前提：manifest 里列出的所有 `objects[].hash` 都已 `stageObject` 成功。
 *
 * @returns {{ ok: true, revision: number, snapshotId: string, replayed?: boolean }
 *          | { ok: false, code: string, revision?: number, missing?: string[] }}
 */
export function commitProjectSnapshot({ root, pid, accountId, opId, baseRevision, manifest, now = Date.now() }) {
  if (!pid || !accountId || !opId) return { ok: false, code: 'BAD_REQUEST' }
  if (!manifest || manifest.protocol !== PROTOCOL_VERSION) return { ok: false, code: 'PROTOCOL_UNSUPPORTED' }
  ensureDirs(root, pid)
  const lock = acquireProjectLock(root, pid)
  try {
    const st = readState(root, pid, accountId)

    // 归属：同一云端作品只能被一个账号写（路由层也校验，这里是第二道）
    if (st.accountId && st.accountId !== accountId) return { ok: false, code: 'FORBIDDEN' }

    // 幂等：同一 opId 必须返回**当时**的结果，不能重新发布
    const seen = st.ops?.[opId]
    if (seen) return { ok: true, revision: seen.revision, snapshotId: seen.snapshotId, replayed: true }

    // 世代：服务器从备份恢复/迁移后，旧基线一律失效
    const epoch = readEpoch(root)
    if (st.epoch !== epoch) return { ok: false, code: 'EPOCH_STALE', revision: st.revision }

    if (Number(baseRevision) !== st.revision) {
      return { ok: false, code: 'BASELINE_MISMATCH', revision: st.revision }
    }

    // 对象齐备性：缺一个就不提交（避免发布出「manifest 指向不存在内容」的版本）
    const missing = []
    for (const o of manifest.objects || []) if (!hasObject(root, o.hash)) missing.push(o.hash)
    for (const a of manifest.assets || []) if (!hasObject(root, a.hash)) missing.push(a.hash)
    if (missing.length) return { ok: false, code: 'OBJECT_MISSING', missing }

    const nextRev = st.revision + 1
    const snapshotId = sha256(Buffer.from(JSON.stringify({
      protocol: PROTOCOL_VERSION, pid, revision: nextRev, objects: manifest.objects || [], assets: manifest.assets || [],
    }), 'utf8'))

    // 1) manifest 先落（此前任何失败都只留下无害的孤儿文件）
    writeAtomic(path.join(p.manifests(root, pid), `${nextRev}.json`), JSON.stringify({ ...manifest, revision: nextRev, snapshotId }))

    // 2) 墓碑并入（不是替换）：新提交只带「本次删了谁」，历史墓碑要继续有效
    const merged = mergeTombstones(st.tombs || [], manifest.tombstones || [], now)

    // 3) 幂等表：保留期内有效，超出按时间清理
    const ops = pruneOps(st.ops || {}, now)
    ops[opId] = { revision: nextRev, snapshotId, at: now }

    // 4) **提交点**：一次写入同时推进 revision 与幂等记录
    const next = {
      protocol: PROTOCOL_VERSION, accountId, revision: nextRev, snapshotId,
      epoch, tombs: merged, ops,
    }
    writeAtomic(p.state(root, pid), JSON.stringify(next))
    return { ok: true, revision: nextRev, snapshotId }
  } finally {
    lock.release()
  }
}

function pruneOps(ops, now) {
  const out = {}
  for (const [k, v] of Object.entries(ops)) {
    if (v && now - (v.at || 0) <= OP_TTL_MS) out[k] = v
  }
  return out
}

function mergeTombstones(oldList, newList, now) {
  const key = (t) => `${t.kind}:${t.id}`
  const map = new Map()
  for (const t of oldList) {
    if (now - (t.deletedAt || 0) > TOMBSTONE_TTL_MS) continue // 过期墓碑不再参与
    map.set(key(t), t)
  }
  for (const t of newList) {
    if (!t || !t.kind || !t.id) continue
    const prev = map.get(key(t))
    // 同一条被删两次取**更早**的删除时间：复活判定要保守，不能因为重复上传把时间往后推
    if (!prev || (t.deletedAt || 0) < (prev.deletedAt || 0)) map.set(key(t), { kind: t.kind, id: t.id, deletedAt: t.deletedAt || now })
  }
  return [...map.values()]
}

/**
 * 删除整个云端作品：写覆盖式墓碑（不是直接删目录）。
 *
 * 🔴 为什么保留目录：离线设备回来时会带着旧 revision，直接删目录会让它「看起来云端没这本」
 *    从而自动重建一份 —— 那正是「删了复活」。保留 state + 墓碑，设备才会被判成「基线过期」。
 */
export function deleteProject({ root, pid, accountId, opId, now = Date.now(), tombKinds = ['project'] }) {
  if (!pid || !accountId || !opId) return { ok: false, code: 'BAD_REQUEST' }
  ensureDirs(root, pid)
  const lock = acquireProjectLock(root, pid)
  try {
    const st = readState(root, pid, accountId)
    if (st.accountId && st.accountId !== accountId) return { ok: false, code: 'FORBIDDEN' }
    const seen = st.ops?.[opId]
    if (seen) return { ok: true, revision: seen.revision, snapshotId: seen.snapshotId, replayed: true }
    const nextRev = st.revision + 1
    const snapshotId = sha256(Buffer.from(`deleted:${pid}:${nextRev}`, 'utf8'))
    writeAtomic(path.join(p.manifests(root, pid), `${nextRev}.json`), JSON.stringify({
      protocol: PROTOCOL_VERSION, deleted: true, revision: nextRev, snapshotId,
    }))
    const ops = pruneOps(st.ops || {}, now)
    ops[opId] = { revision: nextRev, snapshotId, at: now }
    const tombs = mergeTombstones(st.tombs || [], tombKinds.map((kind) => ({ kind, id: pid, deletedAt: now })), now)
    writeAtomic(p.state(root, pid), JSON.stringify({
      protocol: PROTOCOL_VERSION, accountId, revision: nextRev, snapshotId,
      epoch: readEpoch(root), tombs, ops, deletedAt: now,
    }))
    return { ok: true, revision: nextRev, snapshotId }
  } finally {
    lock.release()
  }
}

/** 统计用：对象库总字节（配额校验用；不做全量扫描时由调用方缓存） */
export function objectsBytes(root) {
  let total = 0
  const dir = p.objects(root)
  let names = []
  try { names = fs.readdirSync(dir) } catch { return 0 }
  for (const n of names) {
    try { total += fs.statSync(path.join(dir, n)).size } catch { /* ignore */ }
  }
  return total
}
