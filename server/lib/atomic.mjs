// ============ 原子写 JSON（本地文件存储的唯一写入入口） ============
//
// 【为什么必须原子】先把内容写进 xxx.tmp、再 rename 覆盖目标：rename 在同一分区上是原子的，
// 于是「读到一半断电」永远不会读到半个文件 —— 要么是旧的完整内容，要么是新的完整内容。
//
// 🔴 tmp 文件名必须**每次唯一**（pid + 递增序号）：这项目在桌面版 main.cjs 上踩过一次 ——
//    共用固定 tmp 名时两次并发写会互相踩，写出内容混杂的文件。服务端同样要守。
import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

let seq = 0
function tmpNameFor(abs) {
  return `${abs}.${process.pid}.${++seq}.${randomBytes(3).toString('hex')}.tmp`
}

function ensureDir(abs) {
  const d = dirname(abs)
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

/** 同步原子写（用于很小的文件，如 users.json；阻塞时间在毫秒级） */
export function writeTextAtomicSync(abs, text) {
  ensureDir(abs)
  const tmp = tmpNameFor(abs)
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, abs)
  } catch (e) {
    try { unlinkSync(tmp) } catch { /* 唯一名，残留不污染 */ }
    throw e
  }
}

/** 异步原子写（用于用户整库 JSON；几十 MB 时不能阻塞事件循环） */
export async function writeTextAtomic(abs, text) {
  ensureDir(abs)
  const tmp = tmpNameFor(abs)
  try {
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, abs)
  } catch (e) {
    try { await unlink(tmp) } catch { /* 同上 */ }
    throw e
  }
}

/**
 * 读 JSON。
 * @returns {{ok:true,value:any}|{ok:false,missing:true}|{ok:false,error:string}}
 *
 * 🔴 必须区分「文件不存在」与「文件损坏」：前者是首次使用的正常状态（可以建默认值），
 *    后者绝不能当成空的然后写回去 —— 那就是拿空表覆盖用户全部数据。
 */
export function readJSONOr(abs, reader) {
  try {
    if (!existsSync(abs)) return { ok: false, missing: true }
    const text = reader(abs)
    if (!text.trim()) return { ok: false, error: '文件内容为空' }
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 目录递归字节数（配额统计用）。忽略 .tmp 残留 */
export function dirBytesSync(dir) {
  let total = 0
  if (!existsSync(dir)) return 0
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const p = `${d}/${ent.name}`
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) {
        if (ent.name.endsWith('.tmp')) continue
        try { total += statSync(p).size } catch { /* 并发删除，跳过 */ }
      }
    }
  }
  walk(dir)
  return total
}
