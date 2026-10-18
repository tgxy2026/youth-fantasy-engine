/**
 * 图鉴资料包（3.1.3 · 方案 §8.2 / §8.3）—— 跨项目共享整份图鉴（含自定义字段与图片）。
 *
 * 【与另外两种导出的分工（方案那张表）】
 *   项目备份  = 能还原真实项目，什么都带（含归档字段、本机布局之外的一切）
 *   CSV       = 只带文字、按列，明确**不是**完整备份（图片与字段类型说明都不在里面）
 *   图鉴资料包 = 带**字段定义 + 条目 + 图片**，用于"把这一套图鉴搬到另一个项目"
 *
 * 🔴 本文件是**纯函数层**（不碰 db / localStorage）：
 *   · `buildAtlasPackage` 造包；`parseAtlasPackage` 校验外来包；
 *   · `planAtlasImport` 只**算计划**（哪些字段复用、哪些新建、每行的键怎么映射），
 *     真正写库由调用方做 —— 这样"同名不同类型"这类冲突可以在预览里先说清楚再落盘。
 */
import type { TabDef, TableRow } from '@/lib/types'
import type { AtlasFieldDefinition, AtlasImage, AtlasSchemaConfig, AtlasTabId, CustomFieldType } from './types'

export const ATLAS_PACKAGE_KIND = 'yfe-atlas'
export const ATLAS_PACKAGE_VERSION = 1
/** 单份资料包的条目上限（防恶意/误操作的大包把内存打爆） */
export const ATLAS_PACKAGE_MAX_ROWS = 5000
/** 单份资料包的字段上限（与配置上限同量级） */
export const ATLAS_PACKAGE_MAX_FIELDS = 200

export interface AtlasPackageRow {
  data: Record<string, string>
  atlasImage?: AtlasImage
}

export interface AtlasPackage {
  kind: typeof ATLAS_PACKAGE_KIND
  formatVersion: number
  exportedAt: number
  tabId: AtlasTabId
  tabName: string
  /** 字段定义（只带**未归档**的：资料包用于共享正在用的那套） */
  schema: {
    fields: AtlasFieldDefinition[]
    groups: { id: string; label: string; order: number }[]
    builtinPresentation: AtlasSchemaConfig['builtinPresentation']
    summaryKeys: string[]
  }
  rows: AtlasPackageRow[]
}

/** 造包（纯函数：输入当前表的行与配置） */
export function buildAtlasPackage(
  tab: TabDef,
  config: AtlasSchemaConfig | null | undefined,
  rows: readonly TableRow[],
  opts: { now?: number } = {},
): AtlasPackage {
  const fields = (config?.fields ?? []).filter(f => !f.archived)
  return {
    kind: ATLAS_PACKAGE_KIND,
    formatVersion: ATLAS_PACKAGE_VERSION,
    exportedAt: opts.now ?? Date.now(),
    tabId: tab.id as AtlasTabId,
    tabName: tab.name,
    schema: {
      fields,
      groups: config?.groups ?? [],
      builtinPresentation: config?.builtinPresentation ?? {},
      summaryKeys: config?.summaryKeys ?? [],
    },
    rows: rows.map(r => ({
      data: { ...r.data },
      ...(r.atlasImage ? { atlasImage: { ...r.atlasImage } } : {}),
    })),
  }
}

export type ParseResult =
  | { ok: true; pkg: AtlasPackage }
  | { ok: false; reason: string }

/**
 * 校验外来包。
 * 🔴 先校验后写库（方案 §8.3）：不完整 / 超限的包在**动目标项目之前**就拒绝。
 */
export function parseAtlasPackage(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: '这不是有效的 JSON 文件' }
  }
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '文件内容不是图鉴资料包' }
  const o = raw as Record<string, unknown>
  if (o.kind !== ATLAS_PACKAGE_KIND) {
    return { ok: false, reason: '这不是图鉴资料包（可能是项目备份或普通 JSON）' }
  }
  const ver = typeof o.formatVersion === 'number' ? o.formatVersion : 0
  if (ver > ATLAS_PACKAGE_VERSION) {
    return { ok: false, reason: `这份资料包来自更新的版本（formatVersion ${ver}），当前版本读不了` }
  }
  if (o.tabId !== 'races' && o.tabId !== 'items') {
    return { ok: false, reason: '资料包的目标页签不合法（只支持种族生物 / 物品资源）' }
  }
  const rows = Array.isArray(o.rows) ? o.rows : null
  if (!rows) return { ok: false, reason: '资料包里没有条目（rows）' }
  if (rows.length > ATLAS_PACKAGE_MAX_ROWS) {
    return { ok: false, reason: `条目太多（${rows.length} 条，单份最多 ${ATLAS_PACKAGE_MAX_ROWS} 条）` }
  }
  const schema = (o.schema ?? {}) as Record<string, unknown>
  const fields = Array.isArray(schema.fields) ? schema.fields : []
  if (fields.length > ATLAS_PACKAGE_MAX_FIELDS) {
    return { ok: false, reason: `字段太多（${fields.length} 个，单份最多 ${ATLAS_PACKAGE_MAX_FIELDS} 个）` }
  }
  return {
    ok: true,
    pkg: {
      kind: ATLAS_PACKAGE_KIND,
      formatVersion: ver,
      exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : 0,
      tabId: o.tabId,
      tabName: typeof o.tabName === 'string' ? o.tabName : String(o.tabId),
      schema: {
        fields: fields as AtlasFieldDefinition[],
        groups: Array.isArray(schema.groups) ? (schema.groups as AtlasPackage['schema']['groups']) : [],
        builtinPresentation: (schema.builtinPresentation ?? {}) as AtlasPackage['schema']['builtinPresentation'],
        summaryKeys: Array.isArray(schema.summaryKeys) ? (schema.summaryKeys as string[]) : [],
      },
      rows: rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map(r => ({
          data: (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, string>,
          ...(r.atlasImage && typeof r.atlasImage === 'object' ? { atlasImage: r.atlasImage as AtlasImage } : {}),
        })),
    },
  }
}

export interface ImportPlan {
  /** 导入后应有的完整字段清单（原有 + 新建） */
  fields: AtlasFieldDefinition[]
  /** 包内 field id → 目标 field id（内置键不在 map 里，本来就是同一个） */
  fieldMap: Record<string, string>
  reused: { label: string; id: string }[]
  created: { label: string; id: string }[]
  /** 每行的 data 已按 fieldMap 重映射 */
  rows: AtlasPackageRow[]
  /** 资料包里带了图但目标容量不够时，这些行的图会被跳过（由调用方填） */
  imageRows: number
}

/**
 * 算导入计划（**只算不写**）。
 *
 * 字段去重规则（方案 §8.3 的简化落地）：
 *   · 同 `label` 且同 `type` 且未归档 ⇒ **复用现有字段**（不重复造）；
 *   · 其余一律新建（新 `cf_` id），并把包内旧键重映射到新键 —— 不同义/不同类型的同名字段
 *     不硬合并，避免把两种含义的数据搅在一起。
 * @param makeId 生成新字段 id（注入进来，本文件不依赖 db/uid）
 */
export function planAtlasImport(
  pkg: AtlasPackage,
  targetConfig: AtlasSchemaConfig | null | undefined,
  makeId: () => string,
): ImportPlan {
  const existing = (targetConfig?.fields ?? []).filter(f => !f.archived)
  const fieldMap: Record<string, string> = {}
  const reused: ImportPlan['reused'] = []
  const created: ImportPlan['created'] = []
  const newFields: AtlasFieldDefinition[] = []

  for (const f of pkg.schema.fields) {
    const hit = existing.find(e => e.label === f.label && e.type === f.type)
    if (hit) {
      fieldMap[f.id] = hit.id
      reused.push({ label: f.label, id: hit.id })
      continue
    }
    const id = makeId()
    fieldMap[f.id] = id
    created.push({ label: f.label, id })
    newFields.push({ ...f, id, archived: false })
  }

  const rows: AtlasPackageRow[] = pkg.rows.map(r => {
    const data: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.data)) {
      // 内置字段键（列名）原样保留；自定义键按 map 换到目标 id
      const mapped = fieldMap[k] ?? k
      data[mapped] = v
    }
    return { data, ...(r.atlasImage ? { atlasImage: r.atlasImage } : {}) }
  })

  return {
    fields: [...existing.map(e => e), ...newFields].concat(
      // 归档字段保持归档（不进 fields 的"有效"清单，但仍要写回配置，否则会丢）
      (targetConfig?.fields ?? []).filter(f => f.archived),
    ),
    fieldMap,
    reused,
    created,
    rows,
    imageRows: pkg.rows.filter(r => !!r.atlasImage).length,
  }
}

/** 资料包里出现的字段类型（预览里显示"新增 3 个字段（单选 / 多选 / 数字）"用） */
export function typeLabelsOf(fields: readonly AtlasFieldDefinition[]): CustomFieldType[] {
  return [...new Set(fields.map(f => f.type))]
}

/** 导入前的**只读预览**（不造 id、不改任何东西）—— 给确认弹窗用的数字 */
export function previewAtlasImport(
  pkg: AtlasPackage,
  targetConfig: AtlasSchemaConfig | null | undefined,
  categoryOptions: readonly string[] = [],
): { rows: number; images: number; reusedFields: number; createdFields: number; unknownCategories: string[] } {
  const existing = (targetConfig?.fields ?? []).filter(f => !f.archived)
  const reusedFields = pkg.schema.fields.filter(f => existing.some(e => e.label === f.label && e.type === f.type)).length
  /**
   * 3.1.3：包里的「类别」值目标表没有 ⇒ 导入后这一格在下拉里会显示空白（值其实在），
   * 所以预览要**先说清楚**，导入时再把这些值登记成该列的自定义选项（不丢值、可筛选）。
   */
  const known = new Set(categoryOptions)
  const unknownCategories = [...new Set(
    pkg.rows
      .map(r => (r.data['类别'] ?? '').trim())
      .filter(v => v.length > 0 && !known.has(v)),
  )]
  return {
    rows: pkg.rows.length,
    images: pkg.rows.filter(r => !!r.atlasImage).length,
    reusedFields,
    createdFields: pkg.schema.fields.length - reusedFields,
    unknownCategories,
  }
}
