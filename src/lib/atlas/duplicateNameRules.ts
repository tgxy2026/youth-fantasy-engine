// ============ 名字字段重复判据（3.7.6 · P3） ============
//
// 数据体检用它判断：同一条记录里，内置名称列与某个自定义「名字类」字段是否都填了值。
// 判据单独成纯函数，是因为它决定「报不报」与「合并哪个键」，两处（体检 / 修复）必须同一口径。
//
// 🔴 「别称 / 别名 / 曾用名 / 称号 / 尊称…」是**正常并存**的字段，不算重复。

/** 名字类自定义字段名：以「名 / 名称 / 名字」结尾 */
const NAME_FIELD_RE = /名(称|字)?$/
/** 与名称天然并存的近义字段，排除 */
const NAME_OK_RE = /别称|别名|曾用名|原名|旧名|乳名|绰号|外号|称号|尊称|法名|道号|封号|学名/

export function isNameLikeCustomFieldLabel(label: string): boolean {
  const trimmed = label.trim()
  if (!trimmed) return false
  if (NAME_OK_RE.test(trimmed)) return false
  return NAME_FIELD_RE.test(trimmed)
}

export interface DuplicateNamePlan {
  /** 保留键（内置名称列优先） */
  keepKey: string
  /** 需要归档的自定义字段键 */
  dropKeys: string[]
}

/**
 * 给一行算「保留谁、归档谁」；没有重复返回 null。
 *
 * @param nameKeys 参与比较的键（内置名称列 + 名字类自定义字段）
 * @param data 该行的数据
 * @param displayCol 内置名称列（有值且已填时优先保留）
 */
export function duplicateNamePlan(
  nameKeys: readonly string[],
  data: Record<string, string> | undefined,
  displayCol?: string,
): DuplicateNamePlan | null {
  if (!data || nameKeys.length < 2) return null
  const present = nameKeys.filter(key => (data[key] ?? '').trim())
  if (present.length < 2) return null
  const keepKey = displayCol && present.includes(displayCol) ? displayCol : present[0]
  const dropKeys = present.filter(key => key !== keepKey)
  return dropKeys.length > 0 ? { keepKey, dropKeys } : null
}
