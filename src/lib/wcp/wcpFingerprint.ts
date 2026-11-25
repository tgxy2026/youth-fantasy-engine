// ============ WCP 网页资料包 · 底包指纹（3.7.3 · W1）============
//
// 用途：判定「上次导出的常驻底包是否已过期」（规划 §3.1）。
//
// 🔴 为什么不用时间戳判过期：作者导出底包后可能只是打开文件看了一眼、
//    或改了一个与底包无关的章节标题 —— 时间戳会天天报「已过期」，提示很快失效。
//    这里对**底包实际装入的源文本**做确定性指纹：内容没变 ⇒ 指纹不变 ⇒ 显示「最新」。
// 🔴 纯函数：同样的输入永远得到同样的指纹（不掺时间、不掺随机数）。
//    导出时与「记住的指纹」逐字比对，避免把「换了个顺序」误判成内容更新。
import type { WcpFingerprintPart } from '@/lib/wcp/wcpTypes'

/** FNV-1a 32 位（两路不同种子 + 总长度，降低碰撞；只用于「是否变化」而非安全摘要） */
function fnv1a(text: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, '0')
}

/**
 * 计算底包源数据指纹。
 *
 * 输入按**传入顺序**参与计算：底包模块顺序由 `WCP_BASE_MODULES` 固定，
 * 调用方不要先 sort —— 顺序本身也是「装进文件的内容」的一部分。
 */
export function wcpFingerprintOf(parts: readonly WcpFingerprintPart[]): string {
  const body = parts
    .map(p => `${p.id}\u0001${p.content.length}\u0001${p.content}`)
    .join('\u0002')
  return `${hex8(fnv1a(body, 2166136261))}${hex8(fnv1a(body, 5381))}${body.length.toString(16)}`
}

/** 指纹是否与记录一致（空指纹一律视为「未导出过」） */
export function wcpFingerprintMatches(recorded: string, current: string): boolean {
  return !!recorded && !!current && recorded === current
}