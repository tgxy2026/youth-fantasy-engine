// ============ 敏感 meta / 设置键判据（叶子模块，不 import 任何项目内模块）============
// 2026-10-13 建立（社区反馈：把「导出数据文件」当备份，AI 密钥被一起带了出去）。
//
// 🔴 为什么必须单独一个文件、而不能挂在任何一处现成模块里：
//    有三条**出口**要用同一份判据，而它们分属三层，谁也不该反向依赖谁 ——
//      ① 云同步排除：`lib/sync/syncCore.ts`（sync 层）
//      ② 数据文件导出剥离：`lib/app/desktop.ts` / `lib/storage/fileBackend.ts`（app / storage 层）
//      ③ 项目包导出黑名单：`lib/db/projects.ts`（db 层）
//    判据放其中任何一处，另外两处去 import 都会凑出环（tests/importCycles 会报红，
//    而这类环在浏览器里可能以 TDZ 形式炸在模块求值期 —— tsc 与单测都看不出来）。
//    范式同 `lib/storage/webcrypto.ts`（同样是为了断环而抽出的叶子）。
//
// 判据分两级：
//    · 一级 = 键名清单：已知的敏感键（AI 模型配置 / 检索服务密钥）。
//    · 二级 = 字段探测：值里**任何一层**出现 apiKey / secret / token / password 这类字段名。
//    第二级是给「将来某个版本又在别处存了密钥」留的兜底 —— 那种漏网只能靠值探测发现，
//    因为新键名当时还没进清单。宁可多剥一项设置，也不能漏一枚密钥。

/**
 * 已知的敏感 **meta 键**（全局 meta，与当前打开哪个项目无关）。
 *
 * ⚠️ 这是**清单**不是模式：加新键就往这里加。删键要格外小心 ——
 *    删掉一个仍在用的键，等于让它重新开始随云同步 / 导出外流。
 */
export const SENSITIVE_META_KEYS: readonly string[] = [
  'aiProviders', // AI 模型配置（apiKey 明文住在里面）
  'aiActiveProviderId', // 当前活动模型 id（本身无密钥，但同属「本地专属、换机重填」这一族）
  'aiConfigMigratedToGlobal', // 旧项目级 AI 配置的迁移标记（本地专属，无密钥）
  'app.search', // 检索服务密钥
]

/**
 * 旧版**项目级** AI 配置键名（1.5.0 之前模型配置按项目存，键名与全局的相同）。
 *
 * 🔴 与 {@link SENSITIVE_META_KEYS} 刻意分开：那边是「云同步 / 导出时整体排除」的清单，
 *    里面还有 `aiConfigMigratedToGlobal` —— 那是**在用的**迁移标记键（`aiCore/session.ts`
 *    每次读配置都要读它），**绝不能删**。而这里这两个键在迁移标记写下之后就是**死数据**，
 *    且 `aiProviders` 里带着 apiKey 明文 ⇒ 必须从 settingsKV 里真正删掉。
 */
export const LEGACY_PROJECT_AI_KEYS: readonly string[] = ['aiProviders', 'aiActiveProviderId']

/**
 * 敏感**字段名**：出现在对象的键上即视为敏感。
 *
 * 🔴 只看**键名**、不看内容 —— 小说正文里出现 "token" 这个词不会被误判（那是值不是键）。
 *    故本判据对「项目级设置里塞了一段正文」的键是安全的。
 */
const SENSITIVE_FIELD_RE =
  /^(api[-_]?key|apikey|secret([-_]?key)?|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|password|passwd|credential)s?$/i

/**
 * 字段探测的深度上限 —— 防「深层大对象」把导出拖慢。
 * 本项目设置最深不过 3 层；给到 8 是留余量，同时保证有界。
 */
const MAX_DEPTH = 8

/** 键名是否命中已知敏感清单 */
export function isSensitiveMetaKey(key: unknown): boolean {
  return typeof key === 'string' && SENSITIVE_META_KEYS.includes(key)
}

/**
 * 递归探测：值里是否出现敏感字段名。
 *
 * 判据是**对象/数组的键名**，不是字符串内容；深度超过 {@link MAX_DEPTH} 即停止下探。
 * 任何异常（循环引用等）都按「不敏感」处理 —— 本函数服务于导出路径，**绝不能抛**：
 * 抛出去等于整个导出失败，那比少剥一项更糟。
 */
export function valueHasSecretField(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return false
  try {
    if (Array.isArray(value)) {
      for (const it of value) if (valueHasSecretField(it, depth + 1)) return true
      return false
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_FIELD_RE.test(k)) return true
      if (valueHasSecretField(v, depth + 1)) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * **项目级** settingsKV 的键（**已剥掉 `<项目id>::` 前缀**）是否敏感。
 *
 * 用途：`exportProject()` 收集 `bundle.settings` 时做双保险。
 * 存在意义（2026-10-13）：1.5.0 之前 AI 配置是**按项目**存的，键名就叫 `aiProviders`；
 * 迁移到全局后老库里的项目级残留仍在 `settingsKV` 里，而 exportProject 按前缀**全收** ⇒
 * 那些老项目的备份文件 / 迁移包会带着明文密钥出门。键名清单 + 值探测两道一起挡。
 */
export function isSensitiveSettingKey(key: unknown, value?: unknown): boolean {
  if (typeof key !== 'string') return false
  if (isSensitiveMetaKey(key)) return true
  if (SENSITIVE_FIELD_RE.test(key)) return true
  return valueHasSecretField(value)
}

/**
 * 从「整库 stores」里剥掉敏感 meta 记录（数据文件导出专用）。
 *
 * 🔴🔴 **必须换新对象、绝不就地删**：`stores.meta` 与内存里的 `data.stores.meta`
 *    是**同一个引用**（调用点都是 `{ ...data.stores, ...inline }` 浅拷贝）。
 *    若在这里 `delete meta[k]`，删掉的是**运行中的内存库** —— 紧接着一次防抖写盘
 *    就把作者的 AI 配置真删了。这是本函数唯一必须守住的纪律。
 *
 * @returns `stores` 为剥完的**新对象**（未命中任何敏感键时原样返回，避免无谓复制）；
 *          `removed` 为被剥掉的键名（供 UI 如实告知作者）。
 */
export function stripSensitiveMeta<T extends Record<string, unknown>>(stores: T): {
  stores: T
  removed: string[]
} {
  // 形状放宽到 `Record<string, unknown>` 再自行收窄 `meta`：
  // 两个调用点的 `stores` 都是 `{ ...data.stores, ...inline }`，而 `inline`（外置载荷）
  // 的值是**数组**、不是 `Record<string, unknown>` —— 卡死类型只会逼调用点写 `as`。
  const meta = (stores as { meta?: Record<string, unknown> } | null | undefined)?.meta
  if (!meta || typeof meta !== 'object') return { stores, removed: [] }
  const kept: Record<string, unknown> = {}
  const removed: string[] = []
  for (const [mapKey, rec] of Object.entries(meta)) {
    // 记录的 `key` 字段才是真键名；map 键理论上与它一致，但两个都查更稳（外部写坏过就不一致）
    const rowKey = (rec as { key?: unknown } | null | undefined)?.key ?? mapKey
    if (isSensitiveMetaKey(rowKey) || isSensitiveMetaKey(mapKey)) {
      removed.push(String(rowKey))
      continue
    }
    kept[mapKey] = rec
  }
  if (!removed.length) return { stores, removed: [] }
  return { stores: { ...stores, meta: kept } as T, removed }
}
