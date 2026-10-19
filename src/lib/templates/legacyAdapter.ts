/**
 * 3.2.0 · WT0：旧结构 → 有效模板的**适配器**
 *
 * 纪律（方案 §3.4）：「先证明当前输入输出一致再启用新编辑器」。
 * 所以这里**不重新解释**任何字段语义 —— 图鉴页签直接复用 `resolveAtlasFields`
 * （3.1.3 已验收的实现），只做一对一映射；非图鉴页签读 `tab.columns` / `tab.modules`。
 *
 * 🔴 这不是第二套解析器：字段筛选、别名、类别适用范围、权限口径全部来自既有实现。
 *    新编译器上线前，本适配器的输出必须与旧输出逐字段一致（见 tests/templatesAdapter.test.ts）。
 */
import type { TabDef } from '@/lib/types'
import { atlasSections, resolveAtlasFields, isAtlasTab } from '@/lib/atlas/schema'
import type { AtlasPurpose, AtlasSchemaConfig, ResolvedAtlasField } from '@/lib/atlas/types'
import type {
  EffectiveField, EffectiveGroup, EffectiveTemplate, TemplateDiagnostic,
  TemplateFieldType, TemplatePurpose,
} from './types'

/** 模板存储格式版本（与数据格式版本、发布版本分别管理） */
export const TEMPLATE_FORMAT_VERSION = 1

/** 图鉴 purpose 与模板 purpose 的映射：`index` 按 AI 可读口径取字段 */
export function atlasPurposeOf(p: TemplatePurpose): AtlasPurpose {
  return p === 'index' ? 'aiRead' : p
}

/** 图鉴六类型 + 业务控件类型 → 模板类型（未知类型归 other，只读） */
const BUILTIN_TYPE_MAP: Record<string, TemplateFieldType> = {
  text: 'text',
  textarea: 'textarea',
  number: 'number',
  select: 'select',
  multiSelect: 'multiSelect',
  boolean: 'boolean',
  date: 'date',
  calendar: 'calendar',
  tableRef: 'tableRef',
  character: 'character',
  characters: 'characters',
}

/**
 * 图鉴**自定义字段**的类型词表（`CustomFieldType` 六种）。
 *
 * 🔴 这张表与 `BUILTIN_TYPE_MAP` 不能合并：
 *    自定义字段的类型叫 `longText`，内置列叫 `textarea` —— 用内置表去查 `longText`
 *    会查不到、归成 `other`（只读 + 一条「类型未识别」诊断），
 *    于是**作者的长文本自定义字段全部被静默降级**（WT0-4 首轮实测抓到，2026-10-19）。
 */
const CUSTOM_TYPE_MAP: Record<string, TemplateFieldType> = {
  text: 'text',
  longText: 'textarea',
  number: 'number',
  select: 'select',
  multiSelect: 'multiSelect',
  boolean: 'boolean',
}

function typeOf(f: ResolvedAtlasField): TemplateFieldType {
  if (f.source === 'custom') {
    return f.customType ? (CUSTOM_TYPE_MAP[f.customType] ?? 'other') : 'other'
  }
  return BUILTIN_TYPE_MAP[f.builtinType ?? 'text'] ?? 'other'
}

/** ResolvedAtlasField（3.1.3 已验收）→ EffectiveField（一对一，无信息损失） */
export function effectiveFieldOfAtlas(f: ResolvedAtlasField): EffectiveField {
  return {
    id: f.key,
    sourceKey: f.key,
    source: f.source,
    label: f.label,
    ...(f.description ? { description: f.description } : {}),
    type: typeOf(f),
    ...(f.options ? { options: f.options } : {}),
    groupId: f.groupId,
    order: f.order,
    appliesTo: f.appliesTo,
    archived: f.source === 'custom' ? isArchived(f) : false,
    ...(f.fixedOptions ? { fixedOptions: true } : {}),
    ...(f.unit ? { unit: f.unit } : {}),
    permissions: {
      table: f.tableVisible,
      detail: f.detailVisible,
      search: f.searchable,
      aiRead: f.aiReadable,
      aiWrite: f.aiWritable,
    },
  }
}

/**
 * 归档判定：直接取解析结果带出来的 `archived`。
 *
 * 🔴 常规解析会 `continue` 掉归档字段 ⇒ 这个值恒为 false；
 *    只有显式传 `includeArchived: true`（派生模板快照时）才为 true。
 *    归档是「不显示」而不是「删除」，快照把它丢掉就再也恢复不了。
 */
function isArchived(f: ResolvedAtlasField): boolean {
  return f.archived === true
}

export interface AdaptAtlasOptions {
  aliases?: Record<string, string>
  config?: AtlasSchemaConfig | null
  purpose?: TemplatePurpose
  category?: string
  ignoreAppliesTo?: boolean
  /**
   * 返回**未过滤的完整结构**（3.2.0 · WT1-2，仅派生快照时用）。
   * 默认 false ⇒ 既有调用逐字不变。含义见 `ResolveAtlasOptions.unfiltered`。
   */
  unfiltered?: boolean
  /** 项目修订号（纯展示变化 +1；不参与 semanticDigest） */
  revision?: number
}

/**
 * 适配一个**图鉴页签**（种族生物 / 物品资源 / 国家势力 / 地理风物）。
 * 字段与分组全部来自 `resolveAtlasFields` / `atlasSections`，本函数只做形状转换。
 */
export function adaptAtlasTab(tab: TabDef, opts: AdaptAtlasOptions = {}): EffectiveTemplate {
  const purpose = opts.purpose ?? 'detail'
  const atlasPurpose = atlasPurposeOf(purpose)
  const fields = resolveAtlasFields(tab, {
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
    config: opts.config ?? null,
    purpose: atlasPurpose,
    ...(opts.category ? { category: opts.category } : {}),
    ...(opts.ignoreAppliesTo ? { ignoreAppliesTo: true } : {}),
    ...(opts.unfiltered ? { unfiltered: true } : {}),
  })
  const diagnostics: TemplateDiagnostic[] = []
  const effFields = fields.map(f => {
    const eff = effectiveFieldOfAtlas(f)
    if (eff.type === 'other') {
      diagnostics.push({ code: 'unknown-field-type', detail: `字段「${f.label}」类型未识别，按只读处理`, fieldId: f.key })
    }
    return eff
  })
  const groups: EffectiveGroup[] = atlasSections(tab, fields, opts.config ?? null)
    .map(sec => ({ id: sec.id, label: sec.label, order: fields.find(f => f.groupId === sec.id)?.order ?? 0 }))

  return {
    templateId: `builtin:${tab.id}`,
    version: TEMPLATE_FORMAT_VERSION,
    revision: opts.revision ?? 0,
    semanticDigest: semanticDigestOf(effFields),
    tabId: tab.id,
    purpose,
    groups,
    fields: effFields,
    diagnostics,
  }
}

/**
 * 非图鉴页签的适配（表单 / 卡片 / 普通表格）。
 *
 * 🔴 方案要求：「尚未开放模板编辑的页签也返回内置模板适配结果，
 *    业务消费者不自行兜回 tab.columns / tab.modules」。本函数就是那个兜底入口 ——
 *    当前阶段它逐字读 schema 原始结构，不改变任何既有行为。
 */
export function adaptBuiltinTab(tab: TabDef, opts: { revision?: number } = {}): EffectiveTemplate {
  const fields: EffectiveField[] = []
  const diagnostics: TemplateDiagnostic[] = []

  if (tab.columns?.length) {
    tab.columns.filter(c => !c.hidden).forEach((col, i) => {
      const type = BUILTIN_TYPE_MAP[col.type ?? 'text'] ?? 'other'
      if (type === 'other') {
        diagnostics.push({ code: 'unknown-field-type', detail: `列「${col.name}」类型未识别，按只读处理`, fieldId: col.name })
      }
      fields.push({
        id: col.name,
        sourceKey: col.name,
        source: 'builtin',
        label: col.name,
        type,
        ...(col.options ? { options: col.options } : {}),
        groupId: 'default',
        order: i,
        appliesTo: '*',
        archived: false,
        ...(col.fixedOptions ? { fixedOptions: true } : {}),
        // 表格型页签：列可见即可写（写入权限由各 AI 链路按业务规则另判）
        permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
      })
    })
  }

  let order = 0
  for (const mod of tab.modules ?? []) {
    mod.fields.forEach((fld, i) => {
      const key = `${mod.name}::${fld.name}`
      // 表单字段只有两种形态：普通文本域 / 数值字段（`kind: 'numeric'`，AI 补全时锁死不编数字）
      const type: TemplateFieldType = fld.kind === 'numeric' ? 'number' : 'textarea'
      fields.push({
        id: key,
        sourceKey: key,
        source: 'builtin',
        label: fld.name,
        ...(fld.desc ? { description: fld.desc } : {}),
        type,
        groupId: mod.name,
        order: order + i,
        appliesTo: '*',
        archived: false,
        permissions: { table: true, detail: true, search: true, aiRead: true, aiWrite: false },
      })
    })
    order += mod.fields.length
  }

  const groups: EffectiveGroup[] = (tab.modules ?? []).map((m, i) => ({ id: m.name, label: m.name, order: i }))
  if (fields.some(f => f.groupId === 'default')) groups.unshift({ id: 'default', label: tab.name, order: -1 })

  return {
    templateId: `builtin:${tab.id}`,
    version: TEMPLATE_FORMAT_VERSION,
    revision: opts.revision ?? 0,
    semanticDigest: semanticDigestOf(fields),
    tabId: tab.id,
    purpose: 'detail',
    groups,
    fields,
    diagnostics,
  }
}

/** 该页签能否用图鉴适配器（四个图鉴页签） */
export function canAdaptAsAtlas(tab: TabDef): boolean {
  return isAtlasTab(tab.id)
}

// ── 语义摘要 ────────────────────────────────────────────────

/**
 * FNV-1a 32 位哈希（纯 JS，浏览器与 Node 同码；不引 crypto，避免环境差异）。
 * 只用于「变了没有」的比对，不用于安全目的。
 *
 * 🔴 导出给 `mappingPlan.ts` 复用：映射摘要与模板摘要必须用**同一套**哈希，
 *    否则同一次变更在两个摘要里得出不同结论，排查时会被误导。
 */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 语义摘要：只包含影响 **AI 理解 / 权限 / 用途** 的部分。
 *
 * 🔴 刻意**不含** `order`、分组顺序、主题等纯展示因素 —— 方案 §3.2：
 *    「纯界面布局、分组顺序和主题不参与；变更时按实际字段依赖判定失效」。
 *    把它并进摘要会让「挪一下字段位置」误杀全部候选。
 */
export function semanticDigestOf(fields: readonly EffectiveField[]): string {
  const canon = [...fields]
    .filter(f => !f.archived)
    .map(f => ({
      id: f.id,
      sourceKey: f.sourceKey,
      label: f.label,
      description: f.description ?? '',
      type: f.type,
      options: f.options ?? [],
      groupId: f.groupId,
      appliesTo: f.appliesTo,
      permissions: f.permissions,
      ...(f.fixedOptions ? { fixedOptions: true } : {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return 'f1:' + fnv1a(JSON.stringify(canon))
}
