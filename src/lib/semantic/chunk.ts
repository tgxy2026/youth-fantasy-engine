// ============ 语义检索 · 切块与内容哈希 ============
//
// 为什么单独一层：切块策略与「增量判据」（hash）是纯函数，与存储 / 网络完全无关，
// 单独放可以把最容易出错的地方（覆盖完整性、重叠边界）钉进单测，不必拉库、不必发请求。
//
// 🔴 本文件**只做字符串处理**：不读库、不发请求、不 import db / ai 链。
//    唯一的例外是它会被 indexer 调用 —— 反向依赖绝不允许。

/** 单块目标长度（字符数）。400 字对中文小说约等于 2~3 个自然段，语义已足够聚焦 */
export const CHUNK_TARGET = 400
/** 相邻块的重叠字符数。留 80 字是为了让跨段落的指代（"他" / "那件事"）不断线 */
export const CHUNK_OVERLAP = 80

export interface Chunk {
  /** 章内块序号，从 0 起，连续 */
  idx: number
  text: string
}

export interface ChunkOptions {
  target?: number
  overlap?: number
}

/** 段落级规范化：统一换行符、去行尾空白 */
function normalize(raw: string): string {
  return (raw ?? '').replace(/\r\n?/g, '\n')
}

/**
 * 把正文切成「不超过 target」的原始片段（还没合并、也还没加重叠）。
 *
 * 先切段、再对超长单段硬切 —— 顺序很重要：
 *   段落是语义自然边界，能整段放就整段放；只有单段本身超过 target 时才牺牲语义硬切，
 *   否则一个 1500 字的场景段会被后来的聚合逻辑当成"放不下"而整段跳过（内容直接丢失）。
 */
function toPieces(text: string, target: number): string[] {
  const out: string[] = []
  for (const para of text.split(/\n+/)) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= target) {
      out.push(p)
      continue
    }
    for (let i = 0; i < p.length; i += target) out.push(p.slice(i, i + target))
  }
  return out
}

/** 取尾部 n 个字符做重叠；尽量从换行处起，避免把一句话从中间劈开 */
function tailFor(text: string, n: number): string {
  if (n <= 0 || text.length <= n) return ''
  const tail = text.slice(-n)
  const nl = tail.indexOf('\n')
  // 换行离尾部太远（> 一半）时不值得再裁，直接用原尾部 —— 否则重叠会缩得几乎没有
  if (nl >= 0 && nl < Math.floor(n / 2)) return tail.slice(nl + 1)
  return tail
}

/**
 * 章节正文 → 块列表。
 *
 * 保证：
 *   · 原文每一个非空片段都出现在**至少一个**块里（不丢内容）；
 *   · 相邻块之间有 overlap 字的重叠（不切断跨段指代）；
 *   · 返回的 idx 从 0 起连续。
 * 空 / 全空白输入返回 `[]`（不返回一个空块 —— 空块嵌进向量库只会污染召回）。
 */
export function chunkChapter(raw: string, opts: ChunkOptions = {}): Chunk[] {
  const target = Math.max(80, Math.floor(opts.target ?? CHUNK_TARGET))
  // 重叠不得超过 target 的一半：否则块会越滚越大，直到每个块都等于 target 而永不推进
  const overlap = Math.max(0, Math.min(Math.floor(opts.overlap ?? CHUNK_OVERLAP), Math.floor(target / 2)))

  const text = normalize(raw).trim()
  if (!text) return []

  const pieces = toPieces(text, target)
  if (pieces.length === 0) return []

  const chunks: Chunk[] = []
  let buf = ''
  const flush = () => {
    const t = buf.trim()
    if (!t) return
    chunks.push({ idx: chunks.length, text: t })
    buf = tailFor(t, overlap)
  }

  for (const p of pieces) {
    // 放不下就先落一块（buf 尾部保留重叠字，作为下一块的开头）
    if (buf && buf.length + p.length + 1 > target) flush()
    buf = buf ? `${buf}\n${p}` : p
  }
  const last = buf.trim()
  if (last) chunks.push({ idx: chunks.length, text: last })
  return chunks
}

/**
 * 内容哈希（FNV-1a 32 位 + 长度后缀）。
 *
 * 用途：增量索引的判据 —— 块内容没变就不重复嵌入（嵌入是要花钱 / 花时间的）。
 * 为什么不用 `crypto.subtle.digest`：它是**异步**的，而增量比对要在同步循环里做
 * （逐块判断跳不跳），引入 await 会让整段逻辑变成 Promise 链、性能也差；
 * 这里只需要"变了能看出来"，不需要抗碰撞强度 —— 前缀 8 位 hex 加长度已经够用。
 */
export function hashOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16).padStart(8, '0')}-${text.length.toString(16)}`
}

/** 向量行主键：项目 + 类别 + 来源 id + 块序号（🔴 换任何一个字段都算另一行，别省） */
export function vectorRowId(projectId: string, kind: string, refId: string, chunkIdx: number): string {
  return `${projectId}::${kind}::${refId}::${chunkIdx}`
}

/** 增量比对的键（不含项目 —— 比对永远在同一项目内进行） */
export function chunkKey(kind: string, refId: string, chunkIdx: number): string {
  return `${kind}::${refId}::${chunkIdx}`
}

/** number[] / Float32Array → 独立 ArrayBuffer（🔴 必须拷贝：直接取 .buffer 会带上整个底层缓冲） */
export function toVectorBuffer(v: number[] | Float32Array): ArrayBuffer {
  const f = v instanceof Float32Array ? v : Float32Array.from(v)
  return f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer
}

/** ArrayBuffer → Float32Array（只读视图，不拷贝 —— 只用于算余弦，不会被改） */
export function fromVectorBuffer(buf: ArrayBuffer): Float32Array {
  return new Float32Array(buf)
}
