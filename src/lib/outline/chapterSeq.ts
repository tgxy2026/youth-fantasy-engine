// ============ 章节叙事顺序（唯一权威来源）============
//
// 设计原则（1.9.2）：**章节叫什么 与 章节排第几 彻底解耦**。
// 顺序只由隐藏字段 (Volume.order, Chapter.order) 派生，永不解析章节标题——
// 作者把章名叫「第11章」「序章」「番外·铁柱传」都不影响故事时序。
//
// 为什么是「派生」而不是「存一个序号字段」：
//   存下来的值会 stale（作者一拖拽就失效），派生的值每次现算，永远等于当前真实顺序。
//   拖拽重排时 NovelEditor 会把 order 重新赋成 0..n-1 并落库，本模块读到的就已是最新序。
//
// 卷：完全依赖 Volume.order，不存在解析卷名的逻辑，也无「不计入序号」概念。

import type { Chapter, Volume } from '@/lib/types'

/** 按 (卷序, 章序) 展平成真实叙事顺序。这是全应用判定章节先后的唯一入口。 */
export function flattenChapters(vols: Volume[], chs: Chapter[]): Chapter[] {
  const sortedVols = [...vols].sort((a, b) => a.order - b.order)
  return sortedVols.flatMap(v =>
    chs.filter(c => c.volumeId === v.id).sort((a, b) => a.order - b.order),
  )
}

/**
 * 章节 id → 全局连续序号（从 1 起）。
 *
 * 返回 0 ＝ **不占号**（仍参与排序，只是不编号），两种来源：
 *   ① 作者标了「不计入序号」（`excludeFromNumbering`）；
 *   ② 章节所在卷是「自由章节」托管卷 —— 自由卷排在全书最前，但它的章节**不占正文序号**，
 *      正片仍从「第1章」起（口径见 lib/freeVolume.ts 的 FREE_VOLUME_ORDER）。
 *
 * ⚠️ 这里**内联判定** `isFree`、不 import `lib/freeVolume`：本章在 db 层之下（db/migrations 依赖它），
 *    反向引 freeVolume（它引 ./db）会成环、违反分层。判定口径与 freeVolume.isFreeVolume 一致（只认字段）。
 */
export function chapterSeqMap(vols: Volume[], chs: Chapter[]): Map<string, number> {
  const out = new Map<string, number>()
  const freeVolIds = new Set(vols.filter(v => v.isFree === true).map(v => v.id))
  let no = 0
  for (const c of flattenChapters(vols, chs)) {
    if (c.excludeFromNumbering || freeVolIds.has(c.volumeId)) { out.set(c.id, 0); continue }
    no++
    out.set(c.id, no)
  }
  return out
}

/** 单个章节的全局序号；未找到或「不计入序号」返回 0 */
export function chapterSeqOf(vols: Volume[], chs: Chapter[], chapterId: string): number {
  return chapterSeqMap(vols, chs).get(chapterId) ?? 0
}

/**
 * 给一组章节按真实叙事序排序（供 AI 取正文、导出等场景使用）。
 * 注意：不要直接 chs.sort((a,b)=>a.order-b.order) —— 那样会跨卷串号，
 * 因为 order 是卷内序号，卷二第 1 章的 order 也是 0。
 */
export function sortChapters(vols: Volume[], chs: Chapter[]): Chapter[] {
  const rank = new Map<string, number>()
  flattenChapters(vols, chs).forEach((c, i) => rank.set(c.id, i))
  // 🔴 不在 rank 里的 = **孤儿章**（volumeId 指向已不存在的卷，例如卷被删过）。
  //    原先回落到 0 会让它们静默排到「第 1 章」前面，与章节树把它们收进末尾
  //    「未归类章节」兜底组的观感冲突（2026-10-14 六维审计发现）。
  //    给一个大于全部有效序号的排名 ⇒ 不丢、位置稳定、且不会伪装成开头。
  const tail = rank.size
  return [...chs].sort((a, b) => (rank.get(a.id) ?? tail) - (rank.get(b.id) ?? tail))
}
