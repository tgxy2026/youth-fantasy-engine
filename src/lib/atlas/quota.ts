/**
 * 图鉴图片**项目容量**（3.1.3 · 方案 §6.2）。
 *
 * 【为什么必须有个总量闸】
 *   单张 200KB 只管住了一张图，管不住"这个项目一共塞了多少"。200 张就是 40MB：
 *   整库 JSON 每次保存都要重写它，云同步每次都要传它，备份也按项目走。
 *   所以除了单张上限，还要一条**项目级硬上限**（初始 32MiB）+ 80% 预警。
 *
 * 🔴 口径（与方案逐条对应）：
 *   · 统计**两个图鉴页签（races + items）**的所有条目 —— 只算当前表会低估一半；
 *   · 替换同一行的图时按**净增量**算（新图 - 旧图），不是"再加一张"；
 *   · 超限时**只禁传图**，文字编辑照常（方案明写：容量超限时条目文字编辑仍正常）。
 *
 * 🔴🔴 **这个上限只对「网页版云端账号模式」生效**（2026-10-18 主人拍板）。
 *   桌面安装版 / 便携版 / 游客网页版的数据都在使用者自己的机器上（JSON 文件或浏览器 IDB），
 *   既不进服务器配额、也没有「一份备份一份钱」的成本，无理由替用户设 32MB 的墙。
 *   所以：**本文件只提供纯函数与常量（默认值 = 云端档位）**，由调用方按运行形态决定传什么 limit：
 *   `WEB_CLOUD ? ATLAS_TOTAL_LIMIT : Infinity`。判定在 `components/sheets/useTableSheetModel`，
 *   这里不 import `@/lib/app/platform`（纯函数层要保持可单测、不依赖 window）。
 */
import type { TableRow } from '@/lib/types'

/** 项目图鉴图片总上限：32MiB —— **仅网页版云端账号模式**（方案 §6.2 初始值） */
export const ATLAS_TOTAL_LIMIT = 32 * 1024 * 1024
/** 达到该比例开始提示（80%） */
export const ATLAS_WARN_RATIO = 0.8

export interface AtlasImageUsage {
  /** 已用字节（编码后、dataURL 解码前的真实字节） */
  used: number
  /** 带图条目数 */
  count: number
}

/** 累加一批表格行的图片占用 */
export function atlasImageUsageOf(rows: readonly TableRow[]): AtlasImageUsage {
  let used = 0
  let count = 0
  for (const r of rows) {
    const bytes = r.atlasImage?.bytes ?? 0
    if (bytes > 0) { used += bytes; count++ }
  }
  return { used, count }
}

export type BudgetLevel = 'ok' | 'warn' | 'over'

export interface BudgetCheck {
  level: BudgetLevel
  /** 当前已用 */
  used: number
  /** 加上这次之后的总量 */
  after: number
  limit: number
  /** 占用比例（0～1+） */
  ratio: number
  /** 超限时给作者看的原因；未超限为 undefined */
  reason?: string
}

/**
 * 检查"再加 `addBytes`"是否可接受。
 * @param addBytes 可以为负（替换成更小的图 / 删图）—— 负增量永远放行
 */
export function checkAtlasBudget(used: number, addBytes: number, limit = ATLAS_TOTAL_LIMIT): BudgetCheck {
  const after = used + addBytes
  const ratio = limit > 0 ? after / limit : 0
  if (after > limit) {
    return {
      level: 'over',
      used, after, limit, ratio,
      reason: `项目图片已达上限（${formatBytes(limit)}），这张放不下了。可以先删掉几张不用的主图，或换一张更小的图。`,
    }
  }
  return { level: ratio >= ATLAS_WARN_RATIO ? 'warn' : 'ok', used, after, limit, ratio }
}

/** 字节 → 人话（与备份列表同口径：一位小数 MB） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`
  const kb = n / 1024
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
}

/** 用量文案（详情里显示"项目图片 x / y（n%）"） */
export function atlasUsageLabel(used: number, limit = ATLAS_TOTAL_LIMIT): string {
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
  return `${formatBytes(used)} / ${formatBytes(limit)}（${pct}%）`
}

/**
 * 运行形态自适应的用量文案。
 * @param limit `Infinity` ⇒ 本机存储不限（桌面 / 便携 / 游客网页版都不受 32MiB 约束）
 */
export function atlasUsageText(used: number, limit: number): string {
  if (!Number.isFinite(limit)) return `${formatBytes(used)}（本机存储，不限）`
  return atlasUsageLabel(used, limit)
}

/** 占用比例（0～1+）；`Infinity` ⇒ 0（本机存储不显示进度成色） */
export function atlasUsageRatio(used: number, limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? used / limit : 0
}
