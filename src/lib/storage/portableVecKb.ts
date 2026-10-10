// ============ 便携版 · 语义检索 / 知识库并入整库 JSON（方案 A）============
//
// 【要解决的问题】
//   桌面版把语义向量与参考资料放在**两个独立 IndexedDB 库**里（`-vec` / `-kb`），
//   并**刻意**让它们不进整库 JSON、不进云同步、不进备份（见 `semantic/store.ts` 与
//   `search/knowledgeBase.ts` 的文件头）。那是桌面版的正确选择：独立库随浏览器 profile
//   持久化，不参与整库搬运，省得把十几 MB 的二进制向量塞进每次写盘的 JSON。
//
//   但便携版（U 盘自包含）不吃这一套：**IDB 落在浏览器 profile 里，不跟 U 盘走**。
//   照搬的话，换一台机器打开便携版，向量索引与参考资料全部丢失 —— 数据不全。
//
// 【方案 A 的做法：注入后端，不改两库源码】
//   两库都留了后端注入点（`setVecBackend` / `setKbBackend`），注释原文写着
//   「供单测与将来的『内存模式』复用」—— 这里正是那个用途。
//   便携模式下把后端换成「读写 `portableStore` 的三个专属 store」：
//     · `vecRows`   ← 向量行（VecRow，`vec` 字段 base64 化）
//     · `kbDocs`    ← 知识库文档元数据（KbDoc）
//     · `kbBodies`  ← 知识库正文（{ id, text }）
//   于是这两库的数据自动跟着整库 JSON 走 `./data` 落盘、随 U 盘携带。
//
// 🔴 为什么不改 `storeOps.ts` / `PORTABLE_KEY_FIELDS` 之外的既有机制：
//    · 桌面端两库的「独立、不入整库」是**红线**，不能因为便携版而改动桌面行为；
//    · 故三个新 store 只加在便携版的 `PORTABLE_KEY_FIELDS`，桌面端 key 表一律不动。
//
// 🔴 `vec` 是 `ArrayBuffer`：整库 JSON 是文本 ⇒ 写时 base64 编码、读时解码回 ArrayBuffer。
//    `Float32Array` 本身的小端字节序在同一台机器上往返无碍；跨机（大小端不同）虽理论有差异，
//    但现实中的浏览器/WASM 环境均是 Little-Endian，且换模型本就要整库重建（见 VecRow.model）。
import type { VecBackend, VecRow, VecKind } from '@/lib/semantic/store'
import { setVecBackend, summarize, refKeyOf, splitRefKey } from '@/lib/semantic/store'
import { chunkKey } from '@/lib/semantic/chunk'
import type { KbBackend, KbDoc } from '@/lib/search/knowledgeBase'
import { setKbBackend } from '@/lib/search/knowledgeBase'
import { PORTABLE, portableStore } from '@/lib/storage/fileBackend'

/** 便携整库 JSON 里承载两库数据的三个 store 名（桌面端不存在这三个） */
export const PORTABLE_VEC_STORE = 'vecRows'
export const PORTABLE_KB_DOCS_STORE = 'kbDocs'
export const PORTABLE_KB_BODIES_STORE = 'kbBodies'

// ---------- ArrayBuffer <-> base64 ----------

/** 把 `ArrayBuffer` 编成 base64（写盘用） */
export function bufferToBase64(buf: ArrayBuffer): string {
  // 🔴 防御（2026-10-10 便携版单测踩到）：若调用方误传 `Float32Array` / `Uint8Array` 等**视图**，
  //    `new Uint8Array(view)` 不会取底层字节，而是逐元素转字节 ⇒ **静默编出错误长度的结果**
  //    （实测 `Float32Array([1,0,0])` → 3 字节而非 12 字节），且不报任何错。
  //    这会让 U 盘里的向量全是垃圾而**无人察觉**（召回只是结果错，不抛）。
  //    故此处主动归一：视图取其底层字节的拷贝；真 ArrayBuffer 原样使用。
  const ab: ArrayBufferLike = ArrayBuffer.isView(buf)
    ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice().buffer
    : buf
  const bytes = new Uint8Array(ab)
  let bin = ''
  // 分块拼接，避免超长数组一次性 spread 触发调用栈上限
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  // btoa 在浏览器与 Node 18+ 全局均可用；不存在时退到 Buffer（Node 单测环境）
  if (typeof btoa === 'function') return btoa(bin)
  return Buffer.from(bytes).toString('base64')
}

/**
 * base64 还原回 `ArrayBuffer`（读盘用）。畸形输入返回**空 buffer**（调用方按无效块跳过）。
 *
 * 🔴 为什么必须 try/catch（2026-10-11 审计实测）：`atob` 对**非 base64 字符**直接抛
 *    `DOMException: Invalid character`（实测 `'!!!not-base64!!!'` 即抛），`Buffer.from(x,'base64')`
 *    虽宽容但也不保证。而上面这行注释原本就承诺「畸形返回空 buffer」—— **注释说的是设计，
 *    代码做的是抛异常**，二者不一致。
 *
 *    后果不是"这一条坏"，而是**整块功能瘫痪**：`load()` 里 `rows.map(fromStored)`，
 *    任一条抛错就让整个 Promise reject ⇒ 语义检索 / 知识库**全部无结果且不报错**
 *    （上层把检索失败降级成"没召回"，作者只看到"搜不出来"，永远查不到真因）。
 *    数据文件里出现一条坏向量的现实路径很常见：网盘同步截断、手工编辑过 JSON、磁盘坏块。
 *    ⇒ 一条坏数据只该丢这一条，不该掀翻整个库。
 */
export function base64ToBuffer(b64: string): ArrayBuffer {
  let bytes: Uint8Array
  try {
    if (typeof atob === 'function') {
      const bin = atob(b64)
      bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    } else {
      bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    }
  } catch {
    // 畸形：返回空 buffer，让调用方按"无效块"跳过（与函数契约一致）
    return new ArrayBuffer(0)
  }
  // 🔴 `Uint8Array.buffer` 的静态类型是 `ArrayBufferLike`（含 SharedArrayBuffer），
  //    而 `VecRow.vec` 声明为 `ArrayBuffer` ⇒ 用 `slice()` 复制出**独立且非共享**的 buffer，
  //    顺带避免解码结果与内部缓冲共享内存（改一处会串另一处）。
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

// ---------- 落盘形态 ----------

/** 整库 JSON 里存的向量行：`vec` 由 ArrayBuffer 换成 base64 字符串 */
type StoredVecRow = Omit<VecRow, 'vec'> & { vecB64: string }

function toStored(r: VecRow): StoredVecRow {
  const { vec, ...rest } = r
  return { ...rest, vecB64: bufferToBase64(vec) }
}

function fromStored(s: StoredVecRow): VecRow {
  const { vecB64, ...rest } = s
  return { ...rest, vec: base64ToBuffer(vecB64 ?? '') }
}

// ---------- 便携向量后端 ----------
//
// 🔴 `export` 是为了让单测能在**不伪造 `PORTABLE`**（它是 const 绑定，Node 下改不了）的前提下，
//    直接把本后端注入 `setVecBackend(portableVecBackend)` 跑全链路 —— 见 tests/portableVecKb.test.ts。
//    这也让「内存模式」等将来的复用点有据可依（与两库后端接口的设计初衷一致）。
export const portableVecBackend: VecBackend = {
  async load(projectId: string): Promise<VecRow[]> {
    const rows = await portableStore.getAllByIndex<StoredVecRow>(PORTABLE_VEC_STORE, 'projectId', projectId)
    return rows.map(fromStored)
  },
  async bulkPut(rows: VecRow[]): Promise<void> {
    if (rows.length === 0) return
    await portableStore.bulkPut(PORTABLE_VEC_STORE, rows.map(toStored))
  },
  async delByRef(projectId: string, refId: string): Promise<void> {
    const key = `${projectId}::${refId}`
    const hit = await portableStore.getAllByIndex<StoredVecRow>(PORTABLE_VEC_STORE, 'refKey', key)
    await portableStore.bulkDel(PORTABLE_VEC_STORE, hit.map(r => r.id))
  },
  async clearProject(projectId: string): Promise<void> {
    const hit = await portableStore.getAllByIndex<StoredVecRow>(PORTABLE_VEC_STORE, 'projectId', projectId)
    await portableStore.bulkDel(PORTABLE_VEC_STORE, hit.map(r => r.id))
  },
  async stats(projectId: string) {
    return summarize(await portableVecBackend.load(projectId))
  },
  async index(projectId: string) {
    const rows = await portableStore.getAllByIndex<StoredVecRow>(PORTABLE_VEC_STORE, 'projectId', projectId)
    const hashes = new Map<string, string>()
    const refs = new Set<string>()
    for (const r of rows) {
      // 🔴 复用 `chunkKey()` 而非手拼 —— 键格式必须与 IDB 后端逐字一致（`kind::refId::idx`），
      //    否则增量重建会把「已有块」认成「没有」，导致全书重复嵌入。
      hashes.set(chunkKey(r.kind, r.refId, r.chunkIdx), r.hash)
      refs.add(refKeyOf(r.kind, r.refId))
    }
    return { hashes, refs }
  },
}

// ---------- 便携知识库后端 ----------

type StoredBody = { id: string; text: string }

/** 便携知识库后端（`export` 理由同上：供单测直接注入） */
export const portableKbBackend: KbBackend = {
  async list(projectId: string): Promise<KbDoc[]> {
    return portableStore.getAllByIndex<KbDoc>(PORTABLE_KB_DOCS_STORE, 'projectId', projectId)
  },
  async put(doc: KbDoc): Promise<void> {
    await portableStore.put(PORTABLE_KB_DOCS_STORE, doc)
  },
  async del(id: string): Promise<void> {
    await portableStore.del(PORTABLE_KB_DOCS_STORE, id)
  },
  async getBody(id: string): Promise<string> {
    const row = await portableStore.get<StoredBody>(PORTABLE_KB_BODIES_STORE, id)
    return row?.text ?? ''
  },
  async putBody(id: string, text: string): Promise<void> {
    await portableStore.put(PORTABLE_KB_BODIES_STORE, { id, text })
  },
  async delBody(id: string): Promise<void> {
    await portableStore.del(PORTABLE_KB_BODIES_STORE, id)
  },
  async clearProject(projectId: string): Promise<void> {
    const docs = await portableKbBackend.list(projectId)
    for (const d of docs) {
      await portableStore.del(PORTABLE_KB_DOCS_STORE, d.id)
      await portableStore.del(PORTABLE_KB_BODIES_STORE, d.id)
    }
  },
}

// ---------- 安装 / 卸载 ----------

let installed = false

/**
 * 便携模式下把语义检索 / 知识库的后端切到整库 JSON。
 *
 * 🔴 幂等：重复调用无副作用（App 启动装载路径可能多次经过）。
 * 🔴 只在 `PORTABLE` 为真时生效 —— 桌面版与纯浏览器 dev 保持两库的默认独立 IDB 行为，
 *    这是**红线**（桌面版两库刻意不入整库 JSON）。
 * 🔴 必须在 `initPortableStore()` **之后**调用：后端读写都落在 `portableStore` 的内存 cache 上，
 *    早于装载会读到空库。
 */
export function installPortableVecKb(): void {
  if (!PORTABLE || installed) return
  setVecBackend(portableVecBackend)
  setKbBackend(portableKbBackend)
  installed = true
}

/** 卸载（复位回默认 IDB 后端）—— 供测试与「切回桌面模式」的假想路径使用 */
export function uninstallPortableVecKb(): void {
  if (!installed) return
  setVecBackend(null)
  setKbBackend(null)
  installed = false
}

/** 是否已装（供测试断言） */
export function isPortableVecKbInstalled(): boolean {
  return installed
}

// 供上层按需重导出类型，避免各处再 import 两库（可选）
export type { VecKind }
export { splitRefKey }
