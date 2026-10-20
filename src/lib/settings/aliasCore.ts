/**
 * 字段显示名的**纯函数核心**（不引 React、不读库）。
 *
 * 为什么单独一层（3.2.0 · T3）：`templates/legacyAdapter` 也要用同一套清洗口径
 * 把别名叠到有效模板的 `label` 上。若直接从 `fieldAlias.ts` 导入，模板层就会
 * 被 React hooks 的模块依赖拖进来 —— 解析层必须保持纯函数、可在 Node 里直接测。
 *
 * 🔴 口径只有这一份：`fieldAlias.ts` 与模板层都从这里取，谁也不许自己再判一遍。
 */
/** 存储键 → 显示名 */
export type AliasMap = Record<string, string>

/** 显示名最长字数（表头是单行，超长会被 truncate 吃掉） */
export const MAX_ALIAS_LEN = 20

/**
 * 存储键 → **默认显示名**。
 *
 * 🔴🔴 表单 / 卡片页签的存储键是 `模块名::字段名`，界面上只该显示「字段名」那半截。
 *    以前这里直接回退成整个存储键 —— 于是「作品信息 › 基本信息」里每一行都印成
 *    「基本信息::书名」，等于把所属模块的表头在每条前面又重复了一遍
 *    （2026-10-03 社区反馈）。表格页签的键本身就是列名（不含 `::`），原样返回。
 */
export function defaultLabelOf(key: string): string {
  const i = key.lastIndexOf('::')
  return i >= 0 ? key.slice(i + 2) : key
}

/**
 * 清洗别名表：剔掉「本表已不存在的列」（换题材包会改列结构）、空串、
 * 超长、以及与任何**默认显示名** / 已被占用的别名**重名**的条目。
 *
 * 🔴 与 `labelOf` 共用这一份口径 —— 谁也不许自己再判一遍，否则界面各处会不一致。
 */
export function sanitizeAliases(cols: string[], map: AliasMap | null | undefined): AliasMap {
  const out: AliasMap = {}
  if (!map || typeof map !== 'object') return out
  // 默认显示名先全部占位：别名不得与任何一列的显示名相同（否则用户分不清是哪一个）
  const taken = new Set(cols.map(defaultLabelOf))
  for (const key of cols) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) continue
    const raw = (map[key] ?? '').trim()
    if (!raw) continue // 空 = 用原名
    if (raw === defaultLabelOf(key)) continue // 与默认显示名相同 = 视为未改
    if (raw.length > MAX_ALIAS_LEN) continue
    if (taken.has(raw)) continue // 撞名 → 丢弃（回退原名），绝不显示成两个一样的列
    out[key] = raw
    taken.add(raw)
  }
  return out
}

/** 逐列取显示名：有合法别名用别名，否则回退**默认显示名**（表单键只取 `::` 后的字段名） */
export function labelOf(cols: string[], map: AliasMap | null | undefined, key: string): string {
  return sanitizeAliases(cols, map)[key] ?? defaultLabelOf(key)
}

/** 全表「存储键 → 显示名」映射（表头一次算好，避免逐列重复清洗） */
export function labelMapOf(cols: string[], map: AliasMap | null | undefined): AliasMap {
  const clean = sanitizeAliases(cols, map)
  const out: AliasMap = {}
  for (const k of cols) out[k] = clean[k] ?? defaultLabelOf(k)
  return out
}

/** 有几个字段正被改名（页头按钮上的角标用） */
export function aliasCount(cols: string[], map: AliasMap | null | undefined): number {
  return Object.keys(sanitizeAliases(cols, map)).length
}

/**
 * 校验「正在输入」的别名。返回 `null` 表示合法，否则返回给用户看的原因。
 * 落盘前也走一遍 `sanitizeAliases` 兜底 —— 前端校验只是提示层，不是唯一防线。
 */
export function validateAliasInput(
  cols: string[],
  map: AliasMap | null | undefined,
  key: string,
  input: string,
): string | null {
  const raw = input.trim()
  if (!raw) return null // 空 = 恢复默认，合法
  if (raw.length > MAX_ALIAS_LEN) return `最多 ${MAX_ALIAS_LEN} 个字`
  if (raw === defaultLabelOf(key)) return null
  const clean = sanitizeAliases(cols, map)
  for (const other of cols) {
    if (other === key) continue
    const shown = clean[other] ?? defaultLabelOf(other)
    if (shown === raw) return `与「${shown}」重名了`
  }
  return null
}
