/**
 * 文本指纹与字节数（3.6.1 · 死代码/重复实现专项收口）
 *
 * 【为什么合到一起】原来 `stableHash` 在 `audit/repetition` 与 `tasks/unitLedger` **各写了一份、
 * 逐字节相同**；`utf8Bytes` 也是两份（一份带 TextEncoder 兜底、一份没有）。
 * 两份同样的算法意味着"修一处漏一处"：将来改散列口径（比如换 FNV 参数或加盐），
 * 只有一边变、另一边仍然旧口径，去重与台账就会互相不认。故收敛成唯一实现。
 *
 * 🔴 `stableHash` 的输出格式（8 位十六进制 + 长度）已被既有数据依赖：
 *    task 台账里存过这个值，改格式等于让历史记录失配 —— 要改必须带迁移。
 *    `audit/repetition` 与 `tasks/unitLedger` 都从这里 re-export，公开 API 不变。
 */

/** FNV-1a 32 位散列 + 原文长度；格式固定为 `<8 位 hex>-<长度 hex>` */
export function stableHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}-${text.length.toString(16)}`
}

/**
 * UTF-8 字节数（存占用统计用）。
 * TextEncoder 在浏览器 / Node 都有；兜底按码点估算，保证在极老环境里也不会抛。
 */
export function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return bytes
}
