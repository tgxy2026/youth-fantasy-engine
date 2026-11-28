// ============ 设定表「一行叫什么名字」的统一取值（3.7.6） ============
//
// 🔴 为什么要有这个文件：标题取值散落在四处（设定检索 / 本章引用 / 正文引用高亮 / 数据体检），
//    每处都写着 `row.data[tab.displayCol]`。一旦作者把名字写进**自定义字段**（图鉴「新增字段」），
//    或把内置名称列留空，`displayCol` 就取不到值，各处回退方式还不一致：
//    检索退到「第一个非空」—— 而新增行最先写入的是自动编号，于是标题变成 `R0001`
//    （2026-11-28 用户反馈的「种族生物编号在上、名称在下」）。
//
// 取值优先级（逐级回落，任一为空才继续）：
//   ① schema 的 `displayCol`（名称列，最常见路径，保持原行为）
//   ② 有效字段里「显示名含 名称 / 标题 / 名字」的键（模板改过名也认得）
//   ③ 键名本身含 名称 / 标题 / 名字 的键（没拿到显示名时的兜底）
//   ④ 第一个非空值，但**跳过编号 / 代码列**（避免标题变编号）
//   ⑤ 只剩编号时才用它
//
// 🔴 纯函数、不读库：调用方有有效字段元数据就传 `labels` / `keys`，没有就只靠键名判断。
import type { TabDef } from '@/lib/types'

/** 名称类显示名 / 键名 */
const NAME_RE = /名称|标题|名字/
/** 编号类显示名 / 键名：④ 里要跳过，⑤ 才轮到 */
const CODE_RE = /编号|代码/
const ID_KEY_RE = /(^|[^a-z])id$/i

function isCodeKey(key: string, label: string): boolean {
  return CODE_RE.test(label) || CODE_RE.test(key) || ID_KEY_RE.test(key)
}

export interface RowTitleOptions {
  /** 存储键 → 当前显示名（模板 / 图鉴 / 别名后的口径） */
  labels?: Record<string, string>
  /** 当前有效的存储键（顺序即列顺序）；不给则用数据自身的键顺序 */
  keys?: readonly string[]
}

/**
 * 取一行的显示名；取不到返回空串（调用方自己决定是「（未命名）」还是跳过）。
 */
export function resolveRowTitle(
  tab: Pick<TabDef, 'displayCol'>,
  data: Record<string, string> | undefined,
  opts: RowTitleOptions = {},
): string {
  if (!data) return ''
  const keys = opts.keys && opts.keys.length > 0 ? opts.keys : Object.keys(data)
  const labels = opts.labels ?? {}
  const labelOf = (key: string) => (labels[key] ?? key).trim()

  const seen = new Set<string>()
  const ordered: string[] = []
  const add = (key?: string) => {
    if (!key || seen.has(key)) return
    seen.add(key)
    ordered.push(key)
  }

  add(tab.displayCol)
  for (const key of keys) if (NAME_RE.test(labelOf(key)) && !isCodeKey(key, labelOf(key))) add(key)
  for (const key of keys) if (NAME_RE.test(key) && !isCodeKey(key, labelOf(key))) add(key)
  for (const key of keys) if (!isCodeKey(key, labelOf(key))) add(key)
  for (const key of keys) add(key)

  for (const key of ordered) {
    const value = (data[key] ?? '').trim()
    if (value) return value
  }
  return ''
}
