// ============ 按用户隔离的数据存储 + 配额 ============
//
// 【与便携版契约完全一致】前端 `fileBackend.ts` 的 `portableStore` 期望的就是这几个端点：
//   GET  /api/data        → { text, path, missing }
//   PUT  /api/data        → body 为整库 JSON 文本
//   GET  /api/blob?store=&id=
//   PUT  /api/blob?store=&id=
//   DELETE /api/blob?store=&id=
//   GET  /api/blob/list?store=
// 于是前端一个字节都不用改（它只认 `window.__YFE_PORTABLE__` 这个注入标记）。
//
// 磁盘布局
//   <DATA_DIR>/users/<uid>/data.json
//   <DATA_DIR>/users/<uid>/blobs/<store>/<base64url(id)>.json
//
// 🔴 文件名一律 base64url 编码：id 来自用户数据，可能含 `/`、`..`、NUL。
//    「先转义再拼接」永远比「过滤危险字符」可靠 —— 过滤法总漏变体。
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { USERS_DATA_DIR } from './config.mjs'
import { writeTextAtomic, dirBytesSync } from './atomic.mjs'

/** 允许的 store 名（白名单）：未知 store 一律拒绝，防止拿它当任意文件写入器 */
const ALLOWED_STORES = new Set(['backupPayloads', 'vecRows', 'kbDocs', 'kbBodies'])

export function userDir(uid) {
  return join(USERS_DATA_DIR, uid)
}
export function userDataFile(uid) {
  return join(userDir(uid), 'data.json')
}
function blobsDir(uid) {
  return join(userDir(uid), 'blobs')
}
function storeDir(uid, store) {
  return join(blobsDir(uid), store)
}
export function ensureUserDir(uid) {
  const d = userDir(uid)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

const encId = (id) => Buffer.from(String(id), 'utf8').toString('base64url')

/** 读取用户整库文本；不存在返回 missing */
export function readUserData(uid) {
  const file = userDataFile(uid)
  if (!existsSync(file)) return { missing: true, text: null }
  const text = readFileSync(file, 'utf8')
  return { missing: false, text }
}

/** 写入用户整库（调用方已做配额校验） */
export async function writeUserData(uid, text) {
  ensureUserDir(uid)
  await writeTextAtomic(userDataFile(uid), text)
}

/**
 * 当前已用字节 = data.json + blobs 目录。
 * 用于「写入前预估」与「界面上显示配额」。
 */
export function usageOf(uid) {
  const file = userDataFile(uid)
  let total = 0
  if (existsSync(file)) {
    try { total += readFileSync(file).length } catch { /* 并发写，忽略 */ }
  }
  total += dirBytesSync(blobsDir(uid))
  return total
}

// ---------- 外置大块数据（sidecar） ----------

export function isValidStore(store) {
  return ALLOWED_STORES.has(String(store || ''))
}

export function readBlob(uid, store, id) {
  if (!isValidStore(store)) return { ok: false, error: 'STORE_NOT_ALLOWED' }
  const file = join(storeDir(uid, store), `${encId(id)}.json`)
  if (!existsSync(file)) return { ok: true, missing: true }
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function writeBlob(uid, store, id, value) {
  if (!isValidStore(store)) return { ok: false, error: 'STORE_NOT_ALLOWED' }
  const dir = storeDir(uid, store)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  await writeTextAtomic(join(dir, `${encId(id)}.json`), JSON.stringify(value))
  return { ok: true }
}

export function deleteBlob(uid, store, id) {
  if (!isValidStore(store)) return { ok: false, error: 'STORE_NOT_ALLOWED' }
  const file = join(storeDir(uid, store), `${encId(id)}.json`)
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch { /* 幂等：删不掉也算成功，下次覆盖 */ }
  return { ok: true }
}

export function listBlobs(uid, store) {
  if (!isValidStore(store)) return { ok: false, error: 'STORE_NOT_ALLOWED' }
  const dir = storeDir(uid, store)
  if (!existsSync(dir)) return { ok: true, ids: [] }
  const ids = []
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tmp') || !name.endsWith('.json')) continue
    try {
      ids.push(Buffer.from(name.slice(0, -5), 'base64url').toString('utf8'))
    } catch { /* 非法名，跳过 */ }
  }
  return { ok: true, ids }
}

/** 删除整个用户的数据目录（账号注销用；当前未开放入口，先备着） */
export function wipeUserData(uid) {
  const dir = userDir(uid)
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'blobs') {
      for (const sub of readdirSync(p)) {
        const sd = join(p, sub)
        for (const f of readdirSync(sd)) { try { unlinkSync(join(sd, f)) } catch { /* 略 */ } }
      }
    }
    try { unlinkSync(p) } catch { /* 目录项由系统回收 */ }
  }
}
