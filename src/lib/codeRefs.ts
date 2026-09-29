// ============ 编号引用检查（2026-09-29）============
//
// 背景：编号改为「补最小空号」（删除后的编号可以再被用上）后，同一个编号有可能
// 先被别处引用、再被删、再被新条目占用 —— 那时旧引用会静默指向一个不相干的条目。
// 所以在**删除时**做一次只读扫描，把「这个编号在别处出现了几处」如实告诉作者，
// 由他自己判断：确认没引用就是无风险删除，有引用则自行权衡（不改删除行为）。
//
// 🔴 口径：只看「文本里出现了这个编号」，不做语义判定 —— 宁可多报不漏报，
//    因为漏报会让作者以为没引用。纯只读、不改任何数据。

import * as db from './db'
import { TABS } from './schema'

export interface CodeRefResult {
  /** 出现处数（不含被删行自身的编号格） */
  total: number
  /** 最多 3 条出处提示，形如「《国家势力》·地理位置」「第 3 章（正文）」 */
  hints: string[]
  /** 🔴 扫描期间有数据源读取失败 ⇒ 结果偏少（不能当成「无引用」的事实） */
  incomplete?: boolean
}

const MAX_HINTS = 3

/**
 * 扫描本项目中某编号的引用情况。
 * @param code 完整编号（如 G0003）；空串直接返回 0
 * @param exclude 排除项：被删行自身（避免把自己的编号格算成引用）
 */
export async function countCodeRefs(
  code: string,
  exclude: { tabId?: string; rowId?: string } = {},
): Promise<CodeRefResult> {
  const target = (code ?? '').trim()
  if (!target) return { total: 0, hints: [] }
  let total = 0
  const hints: string[] = []
  let incomplete = false

  // ① 各表的行：逐格文本匹配（跨表引用列与自由文本里都可能写编号）
  for (const tab of TABS) {
    if (tab.type !== 'table') continue
    let rows
    try {
      rows = await db.getTableRows(tab.id)
    } catch { incomplete = true; continue }
    for (const r of rows) {
      if (exclude.rowId && r.id === exclude.rowId) continue
      for (const [col, v] of Object.entries(r.data ?? {})) {
        const s = typeof v === 'string' ? v : ''
        if (!s.includes(target)) continue
        // 同表同列的「编号」格不算引用（那是编号本身）
        if (exclude.tabId === tab.id && col === '编号') continue
        total++
        if (hints.length < MAX_HINTS) hints.push(`《${tab.name}》·${col}`)
      }
    }
  }

  // ② 卡片型设定（分卷大纲 / 章节细纲 / 角色卡等，type='card'）
  for (const tab of TABS) {
    if (tab.type !== 'card') continue
    let recs
    try {
      recs = await db.getCardRecords(tab.id)
    } catch { incomplete = true; continue }
    for (const rec of recs) {
      for (const v of Object.values(rec.data ?? {})) {
        if (typeof v === 'string' && v.includes(target)) {
          total++
          if (hints.length < MAX_HINTS) hints.push(`《${tab.name}》·${rec.name}`)
          break
        }
      }
    }
  }

  // ③ 表单型设定（作品定位 / 世界设定 / 力量体系 / 全书总纲 / 写作规范）
  for (const tab of TABS) {
    if (tab.type !== 'form') continue
    let data
    try {
      data = await db.getFormData(tab.id)
    } catch { incomplete = true; continue }
    for (const [k, v] of Object.entries(data ?? {})) {
      if (typeof v === 'string' && v.includes(target)) {
        total++
        if (hints.length < MAX_HINTS) hints.push(`《${tab.name}》·${k}`)
      }
    }
  }

  // ④ 章节正文（编号常被写进正文或细纲里）
  try {
    const chapters = await db.getAllChapters()
    for (const ch of chapters) {
      if ((ch.content ?? '').includes(target)) {
        total++
        if (hints.length < MAX_HINTS) hints.push(`第 ${ch.order + 1} 章 ${ch.title}（正文）`)
      }
    }
  } catch { incomplete = true /* 读不到正文：结果偏少，必须标注 */ }

  return { total, hints, incomplete }
}

/** 把引用结果拼成删除确认弹窗里的提示文案（无引用且扫描完整则返回空串） */
export function codeRefWarning(code: string, r: CodeRefResult): string {
  if (r.incomplete) {
    return `\n\n⚠️ 引用检查未完整执行（部分数据读取失败），无法确认「${code}」是否被引用 —— 请自行在相关表格与正文中核对后再删除。`
  }
  if (!r.total) return ''
  const where = r.hints.length ? `（如 ${r.hints.join('、')}）` : ''
  return `\n\n检测到「${code}」在 ${r.total} 处出现过${where}：如果该编号确实被别处引用，删除后这些引用会指向空号（之后新增条目还可能补上这个号）。请确认无引用后再删除；确认过的可直接删除。`
}
