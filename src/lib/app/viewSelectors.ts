/**
 * 窗口选择器 —— 把**曾经内联在组件里**的判定 / 整形逻辑集中到一处（3.0 · 建议级③ · 2026-10-10）
 *
 * 【为什么有这个文件】`audit-coverage` 的 A 类零覆盖清单里有一批**弹窗组件**。项目没有 React
 * 测试工具，也不打算为此引一套（W3-3 已定判：为两个组件引 jsdom + testing-library 不划算）。
 * 于是沿用同一条做法 —— **把组件里那段「能判错的逻辑」抽成纯函数**，组件只负责渲染，
 * 纯函数进单测。`BackupReminder.shouldRemind` / `desktop.decideDataFileLoad` 就是这条路的先例。
 *
 * 🔴 收录判据：只有**会判错**的逻辑才进这里（筛选 / 回落 / 拼装 / 解析）。
 *    纯展示（`map` 出一堆 JSX、拼 `className`）不抽 —— 抽了只是给覆盖率凑数，不是工程收益。
 */
import type { FeedbackEntry } from '@/lib/ai/aiTasks'

// ==================== 读者反馈（FeedbackAIPanel）====================

/**
 * 反馈表行 → 交给 AI 分析的条目。
 * 🔴 全空的行必须滤掉：它们会被模型当成「这个周期什么数据都没有」而过度解读，
 *    白白占上下文（这张表允许边填边存，空行很常见）。
 */
export function toFeedbackEntries(rows: Record<string, string | undefined>[]): FeedbackEntry[] {
  return rows
    .map(r => ({
      period: r['数据周期'] || r['日期'] || '',
      metrics: [r['追读'], r['均订'], r['留存']].filter(Boolean).join(' / '),
      complaints: r['高频吐槽'] || '',
      churnChapter: r['流失点章节'] || '',
      churnReason: r['流失原因分析'] || '',
    }))
    .filter(e => e.metrics || e.complaints || e.churnChapter || e.churnReason)
}

// ==================== 剧本导入（TavernScriptImportDialog）====================

/**
 * 选「导入到哪个故事」—— 回落顺序：**保持已选** → 优先故事 → 列表第一个 → 空串。
 * 🔴 第一步必须先查「已选还在不在」：故事可能刚被删掉，不查就会把一个不存在的 id 设回去，
 *    于是界面上显示着某个故事、实际导入目标却是空（静默失败）。
 */
export function pickImportTargetId(current: string, ids: readonly string[], preferred?: string): string {
  if (current && ids.includes(current)) return current
  if (preferred && ids.includes(preferred)) return preferred
  return ids[0] ?? ''
}

// ==================== 导出摘要（TavernExportDialog）====================

/** 导出弹窗的摘要行文案（各段为空则自动省略；用 ` · ` 连接） */
export function tavernExportSummaryText(o: {
  exportedCount?: number
  includeHidden: boolean
  hiddenCount: number
  withMeta: boolean
  metaLabel?: string
}): string {
  const countPart = o.exportedCount === undefined
    ? ''
    : `将导出 ${o.exportedCount} 条对话${!o.includeHidden && o.hiddenCount > 0 ? `（已排除 ${o.hiddenCount} 条隐藏的）` : ''}`
  const metaPart = o.withMeta ? (o.metaLabel ?? '附角色与场景信息') : ''
  return [countPart, metaPart].filter(Boolean).join(' · ')
}

// ==================== 本场数值输入（TavernCardBasics）====================

/**
 * 数值项输入解析：空串 / 非有限数 → 回落到出厂值 `init`；否则取数值。
 * 🔴 数值项**必须存成 number** —— 它要喂给 AI 与界面档位计算；存成字符串会在
 *    「按档位取当前阶段」那一步静默失效（字符串比较永远不落档）。
 *    文本项（心情 / 地点）原样保留（含空格，只有数值项才 trim 后判空）。
 */
export function parseVarInputValue(kind: 'num' | 'text' | string, raw: string, init: number): number | string {
  if (kind !== 'num') return raw
  const t = raw.trim()
  if (t === '') return init
  const n = Number(t)
  return Number.isFinite(n) ? n : init
}

// ==================== 小说角色筛选（TavernCardNovelImportDialog）====================

/** 分组 + 关键字筛选（关键字按名字比，忽略大小写与首尾空格） */
export function filterNovelChars<T extends { name: string; tabId: string }>(
  chars: readonly T[], keyword: string, tab: string,
): T[] {
  const kw = keyword.trim().toLowerCase()
  return chars.filter(c => (tab === 'all' || c.tabId === tab) && (!kw || c.name.toLowerCase().includes(kw)))
}

/** 各分组的计数（`all` = 全部分组的合计） */
export function countNovelChars<T extends { tabId: string }>(chars: readonly T[], tab: string): number {
  return tab === 'all' ? chars.length : chars.filter(c => c.tabId === tab).length
}
