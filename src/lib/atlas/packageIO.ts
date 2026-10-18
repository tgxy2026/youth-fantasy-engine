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
import { ATLAS_TABS } from './schema'
import { ATLAS_TOTAL_LIMIT, formatBytes } from './quota'
import { dataUrlBytes } from '@/lib/media/imagePortrait'
import type { AtlasFieldDefinition, AtlasImage, AtlasSchemaConfig, AtlasTabId, CustomFieldType } from './types'

export const ATLAS_PACKAGE_KIND = 'yfe-atlas'
export const ATLAS_PACKAGE_VERSION = 1
/** 单份资料包的条目上限（防恶意/误操作的大包把内存打爆） */
export const ATLAS_PACKAGE_MAX_ROWS = 5000
/** 单份资料包的字段上限（与配置上限同量级） */
export const ATLAS_PACKAGE_MAX_FIELDS = 200
/** 外来包接受的图片格式（与 `atlas/image` 的接受清单同口径；SVG 可执行内容，一律拒） */
export const ATLAS_PACKAGE_IMAGE_MIMES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']
/** 单张主图的字符数上限（外来包按同一规格卡；自报的 bytes 一律不信，见 normalizeImage） */
export const ATLAS_PACKAGE_MAX_IMAGE_CHARS = 512 * 1024
/** 六类字段类型（与 `atlas/types` 的 `CustomFieldType` 同步；写死是为了校验外来包） */
export const ATLAS_FIELD_TYPES: readonly string[] = ['text', 'longText', 'number', 'select', 'multiSelect', 'boolean']

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

// ============ 深校验（3.1.3 · R05）============
//
// 🔴 为什么必须逐字段校验：修复前 `parseAtlasPackage` 只做"是不是数组 / 超不超限"这种浅断言，
//    然后直接 `as AtlasFieldDefinition[]` / `as Record<string,string>` 强转 ——
//    实测 `{名称: 42}` 这样的包会被判为合法并写库，而界面与检索到处对值调 `.trim()`
//    ⇒ 运行时崩溃，且崩溃点在**写库之后**，作者的项目已经脏了。
//    外来文件是**不可信输入**，规矩是：任何目标写入之前先完整验证，不合格就整包拒绝。

/** 单条字段定义的问题；没问题返回 null */
function fieldProblem(f: unknown, i: number): string | null {
  const at = `第 ${i + 1} 个字段`
  if (!f || typeof f !== 'object') return `${at}不是合法对象`
  const o = f as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return `${at}缺少稳定 id`
  const name = typeof o.label === 'string' && o.label.trim() ? o.label : o.id
  if (typeof o.label !== 'string' || !o.label.trim()) return `字段「${name}」缺少名称`
  if (typeof o.type !== 'string' || !ATLAS_FIELD_TYPES.includes(o.type)) {
    return `字段「${name}」的类型不合法（${String(o.type)}）`
  }
  if (o.appliesTo !== '*' && !Array.isArray(o.appliesTo)) return `字段「${name}」的类别适用范围不合法`
  if (Array.isArray(o.appliesTo) && !o.appliesTo.every(x => typeof x === 'string')) {
    return `字段「${name}」的类别适用范围里有非文本值`
  }
  if (o.options !== undefined && !Array.isArray(o.options)) return `字段「${name}」的下拉候选不是数组`
  if (Array.isArray(o.options) && !o.options.every(x => typeof x === 'string')) {
    return `字段「${name}」的下拉候选里有非文本值`
  }
  for (const b of ['tableVisible', 'detailVisible', 'searchable', 'aiReadable', 'aiWritable', 'archived'] as const) {
    if (o[b] !== undefined && typeof o[b] !== 'boolean') return `字段「${name}」的开关「${b}」不是布尔值`
  }
  if (o.order !== undefined && typeof o.order !== 'number') return `字段「${name}」的排序不是数字`
  for (const s of ['unit', 'description', 'groupId'] as const) {
    if (o[s] !== undefined && typeof o[s] !== 'string') return `字段「${name}」的「${s}」不是文本`
  }
  return null
}

/** 单张主图的问题；没问题返回 null */
function imageProblem(img: unknown, i: number): string | null {
  const at = `第 ${i + 1} 条条目的主图`
  if (!img || typeof img !== 'object') return `${at}不合法`
  const m = img as Record<string, unknown>
  if (typeof m.dataUrl !== 'string' || !m.dataUrl.startsWith('data:')) return `${at}不是图片数据`
  if (!m.dataUrl.includes(';base64,')) return `${at}不是 base64 数据`
  const mime = /^data:([^;,]+)/.exec(m.dataUrl)?.[1] ?? ''
  if (!ATLAS_PACKAGE_IMAGE_MIMES.includes(mime)) {
    return `${at}格式不支持（${mime || '未知'}；只接受 PNG / JPEG / WebP，SVG 一律拒）`
  }
  if (m.dataUrl.length > ATLAS_PACKAGE_MAX_IMAGE_CHARS) {
    return `${at}太大（${Math.round(m.dataUrl.length / 1024)}KB，单张上限 ${Math.round(ATLAS_PACKAGE_MAX_IMAGE_CHARS / 1024)}KB）`
  }
  return null
}

/** 单条条目的问题；没问题返回 null */
function rowProblem(r: unknown, i: number): string | null {
  const at = `第 ${i + 1} 条条目`
  if (!r || typeof r !== 'object') return `${at}不是合法对象`
  const o = r as Record<string, unknown>
  if (o.data === undefined || o.data === null) return null
  if (typeof o.data !== 'object' || Array.isArray(o.data)) return `${at}的内容不合法`
  for (const [k, v] of Object.entries(o.data as Record<string, unknown>)) {
    // 🔴 非字符串值必须挡在写库之前：全项目对单元格值调 .trim()，数字/对象会直接崩
    if (typeof v !== 'string') return `${at}的「${k}」不是文本（收到 ${typeof v}）`
  }
  if (o.atlasImage !== undefined && o.atlasImage !== null) return imageProblem(o.atlasImage, i)
  return null
}

/**
 * 外来包的**完整结构校验**（纯函数，可单测）。
 * @returns 没问题返回 `null`；有问题返回给作者看的原因（含定位，方便他改包）
 */
export function atlasPackageProblem(o: Record<string, unknown>): string | null {
  // 🔴 页签白名单**必须**取自 ATLAS_TABS（3.1.3 · R07）：
  //    这里原先写死 'races' / 'items'，于是 nations 与 geography 导出的包**导不回自己家**。
  if (!ATLAS_TABS.includes(o.tabId as AtlasTabId)) {
    return `资料包的目标页签不合法（${String(o.tabId)}；支持 ${ATLAS_TABS.join(' / ')}）`
  }
  const rows = o.rows
  if (!Array.isArray(rows)) return '资料包里没有条目（rows）'
  if (rows.length > ATLAS_PACKAGE_MAX_ROWS) {
    return `条目太多（${rows.length} 条，单份最多 ${ATLAS_PACKAGE_MAX_ROWS} 条）`
  }
  const schema = (o.schema && typeof o.schema === 'object' ? o.schema : {}) as Record<string, unknown>
  const fields = Array.isArray(schema.fields) ? schema.fields : []
  if (fields.length > ATLAS_PACKAGE_MAX_FIELDS) {
    return `字段太多（${fields.length} 个，单份最多 ${ATLAS_PACKAGE_MAX_FIELDS} 个）`
  }
  const seen = new Set<string>()
  for (let i = 0; i < fields.length; i++) {
    const msg = fieldProblem(fields[i], i)
    if (msg) return msg
    const id = String((fields[i] as Record<string, unknown>).id)
    if (seen.has(id)) return `字段 id 重复（${id}）—— 两个字段共用一个键会让数据串味`
    seen.add(id)
  }
  let imageChars = 0
  for (let i = 0; i < rows.length; i++) {
    const msg = rowProblem(rows[i], i)
    if (msg) return msg
    const img = (rows[i] as Record<string, unknown> | null)?.atlasImage as Record<string, unknown> | undefined
    if (img && typeof img.dataUrl === 'string') imageChars += img.dataUrl.length
  }
  // 包自身就超过总量上限 ⇒ 没必要开始（调用方还会再按"项目剩余额度"判一次是否剥图）
  if (imageChars > ATLAS_TOTAL_LIMIT) {
    return `资料包里的图片合计 ${formatBytes(imageChars)}，超过单项目图片上限 ${formatBytes(ATLAS_TOTAL_LIMIT)}`
  }
  return null
}

/**
 * 外来图片的**规范化**：尺寸与体积一律**重算**，不信包里自报的（3.1.3 · R05）。
 * 自报 bytes 是"伪造体积"的入口：写 1 就能绕过所有容量闸，实际却塞进一张几 MB 的图。
 */
function normalizeImage(img: Record<string, unknown>): AtlasImage {
  const dataUrl = String(img.dataUrl ?? '')
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    dataUrl,
    mime: (/^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png') as AtlasImage['mime'],
    width: num(img.width),
    height: num(img.height),
    bytes: dataUrlBytes(dataUrl),
  }
}

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
  // 🔴 深校验（R05 + R07）：字段定义、每条单元格值、图片格式与体积逐项过一遍再谈导入
  const problem = atlasPackageProblem(o)
  if (problem) return { ok: false, reason: problem }
  const rows = o.rows as unknown[]
  const schema = (o.schema ?? {}) as Record<string, unknown>
  const fields = Array.isArray(schema.fields) ? schema.fields : []
  return {
    ok: true,
    pkg: {
      kind: ATLAS_PACKAGE_KIND,
      formatVersion: ver,
      exportedAt: typeof o.exportedAt === 'number' ? o.exportedAt : 0,
      tabId: o.tabId as AtlasTabId,
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
          // 🔴 图片重算体积（不信包里自报的 bytes）
          ...(r.atlasImage && typeof r.atlasImage === 'object'
            ? { atlasImage: normalizeImage(r.atlasImage as Record<string, unknown>) }
            : {}),
        })),
    },
  }
}

/**
 * 资料包条目的**稳定 id**（3.1.3 · R11）。
 *
 * 🔴 为什么要稳定而不用 `uid()`：分批导入中途失败时，前 N-1 行其实已经入库了。
 *    修复前只在"全部成功"时才并入界面 ⇒ 作者看到的是"一条都没进来"，于是再导一次 ——
 *    而重试用的是新 uid，成功的那批被**再写一遍**，变成两条一模一样的条目。
 *    id 由「包指纹 + 行序号」算出 ⇒ 同一份包重导落在同一批 id 上 ⇒ **重试天然幂等**，
 *    重导只会补上上次没成功的那几条。
 */
export function packageRowId(pkg: AtlasPackage, index: number): string {
  return `atk-${pkg.exportedAt || 0}-${pkg.rows.length}-${pkg.tabId}-${index}`
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
