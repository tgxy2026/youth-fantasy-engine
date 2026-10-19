/**
 * 图鉴（3.1.3）· **字段解析的唯一入口**。
 *
 * 依据：`docs/3.1.3-图鉴与自定义字段-具体实施方案-2026-10-18.md` §4.1 / §4.3。
 *
 * 🔴 为什么要有这一层（方案 §12 第一条风险）：
 *    代码里同时存在「遍历 row.data」和「按 tab.columns 输出」两条链路，
 *    图鉴再来一套「自己读列」就是第三套 —— 三处一旦漂移，表现是「表格里改的值图鉴看不见」
 *    这种极难查的静默 bug。所以组件只许调 `resolveAtlasFields()`，不许自己筛 columns。
 *
 * 本文件是纯函数层：不读库、不碰 localStorage、不 import components。
 */
import type { TabDef } from '@/lib/types'
import { SABC_LABELS } from '@/lib/schemaShared'
import { formatCustomValue, isEmptyValue } from './values'
import type {
  AtlasPurpose,
  AtlasResolvedSection,
  AtlasSchemaConfig,
  AtlasTabId,
  ResolvedAtlasField,
} from './types'

/** 本版开放图鉴的两个页签（方案 §1.1）。顺序即切换顺序 */
export const ATLAS_TABS: readonly AtlasTabId[] = ['races', 'items', 'nations', 'geography']

export function isAtlasTab(tabId: string): tabId is AtlasTabId {
  return (ATLAS_TABS as readonly string[]).includes(tabId)
}

interface GroupSpec {
  id: string
  label: string
  order: number
  /** 内置字段归属：**按存储键（列名）匹配**，不按显示名 —— 别名改来改去都不影响分组 */
  keys: readonly string[]
}

/**
 * 内置字段的默认分组（方案 §3.2 那张表）。
 * 🔴 这里写的是**存储键**，与 `schemaTabs/part2.ts` 的列名逐字对应；列名改了这里要同步，
 *    否则字段会静默掉进「补充资料」组（不报错、只是位置不对 —— 靠 tests/atlasSchema 闸住）。
 */
const GROUP_SPEC: Record<AtlasTabId, readonly GroupSpec[]> = {
  races: [
    { id: 'basic', label: '基本资料', order: 10, keys: ['编号', '名称', '上级', '别称', '保密等级', '类别'] },
    { id: 'ability', label: '能力与弱点', order: 20, keys: ['威胁等级', '能力特性', '弱点'] },
    { id: 'eco', label: '生态与社会', order: 30, keys: ['分布区域', '社会结构'] },
    { id: 'pact', label: '契约关系', order: 40, keys: ['契约/驯化关系'] },
    { id: 'plot', label: '剧情关联', order: 50, keys: ['与主线关系'] },
    { id: 'extra', label: '补充资料', order: 90, keys: ['备注'] },
  ],
  items: [
    { id: 'basic', label: '基本资料', order: 10, keys: ['编号', '名称', '上级', '别称', '保密等级', '类别', '品级'] },
    { id: 'source', label: '来源与效果', order: 20, keys: ['来源/出处', '能力/效果'] },
    { id: 'cost', label: '限制与代价', order: 30, keys: ['限制与代价'] },
    { id: 'hold', label: '持有与流转', order: 40, keys: ['当前持有者', '流转轨迹'] },
    { id: 'plot', label: '剧情关联', order: 50, keys: ['剧情作用'] },
    { id: 'extra', label: '补充资料', order: 90, keys: ['备注'] },
  ],
  // 国家势力：一势力一卡 —— 「它是谁 / 有多强 / 靠什么活着 / 跟谁什么关系 / 在故事里干什么」
  nations: [
    { id: 'basic', label: '基本资料', order: 10, keys: ['编号', '名称', '上级', '别称', '保密等级', '类别'] },
    { id: 'power', label: '实力构成', order: 20, keys: ['实力等级', '镇派功法/核心武力', '掌权者', '内部派系与权力斗争'] },
    { id: 'base', label: '立国之基', order: 30, keys: ['地理位置', '历史沿革', '经济来源'] },
    { id: 'rel', label: '关系', order: 40, keys: ['对外关系', '与主角关系'] },
    { id: 'plot', label: '剧情关联', order: 50, keys: ['剧情作用'] },
    { id: 'extra', label: '补充资料', order: 90, keys: ['备注'] },
  ],
  // 地理风物：位置/范围是这张表的骨架（时间线对账锚点），单独成组
  geography: [
    { id: 'basic', label: '基本资料', order: 10, keys: ['编号', '名称', '别称', '保密等级', '类别'] },
    { id: 'locate', label: '位置与范围', order: 20, keys: ['层级归属', '地理位置', '相对地理位置', '距离与行程时间', '范围与面积'] },
    { id: 'land', label: '地貌与物产', order: 30, keys: ['地貌与气候', '特色资源/特产'] },
    { id: 'risk', label: '归属与危险', order: 40, keys: ['势力归属', '危险等级'] },
    { id: 'human', label: '人文与剧情', order: 50, keys: ['风土人情（一句话）', '剧情作用'] },
    // 「地图格子」是 cH 隐藏列（地图编辑内部数据），不进分组
    { id: 'extra', label: '补充资料', order: 90, keys: ['备注', '所属地图'] },
  ],
}

/** 卡片摘要的默认字段（方案 §3.2；作者后续可在字段配置里改，本框架先只读） */
/**
 * 卡片默认摘要三项。
 * 🔴 **不要再放徽标字段**（`BADGE_KEYS` 里那几个）：名称行下方那两枚小标签已经显示过一遍了，
 *    摘要再写一遍就是同一行字在卡片上出现两次（2026-10-18 主人 review 时发现的观感问题）。
 *    所以每个页签的默认三项都刻意避开了自己的徽标字段。
 */
const DEFAULT_SUMMARY_KEYS: Record<AtlasTabId, readonly string[]> = {
  races: ['分布区域', '能力特性', '社会结构'],        // 徽标已显示 类别 + 威胁等级
  items: ['能力/效果', '当前持有者', '来源/出处'],     // 徽标已显示 类别 + 品级
  nations: ['掌权者', '对外关系', '剧情作用'],         // 徽标已显示 类别 + 实力等级
  geography: ['风土人情（一句话）', '势力归属', '距离与行程时间'], // 徽标已显示 类别 + 危险等级
}

/**
 * 卡片名称行下方的徽标（最多两枚）。
 * 🔴 品牌色/语义：整张卡片靠这两枚小字快速定位「这是什么、有多强」，
 *    所以一律取「类别 + 该表最有区分度的那一列」，别塞三个（会把名称行挤到换行）。
 */
const BADGE_KEYS: Record<AtlasTabId, readonly string[]> = {
  races: ['类别', '威胁等级'],
  items: ['类别', '品级'],
  nations: ['类别', '实力等级'],
  geography: ['类别', '危险等级'],
}

/** 卡片摘要最多显示的条数（方案 §3.2：最多 3 项，每项两行） */
export const ATLAS_MAX_SUMMARY = 3

/**
 * 本页签可用的分组（内置组 + 作者自建组），按显示顺序。
 * 供字段配置面板的「所属分组」下拉用 —— 分组标签只在这里产出一份，避免界面与解析各写一套。
 */
export function atlasGroupsOf(tabId: string, config?: AtlasSchemaConfig | null): { id: string; label: string }[] {
  const spec = groupSpecOf(tabId).map(g => ({ id: g.id, label: g.label }))
  const extra = (config?.groups ?? []).map(g => ({ id: g.id, label: g.label }))
  return [...spec, ...extra]
}

/** 该页签「类别」列的候选值（自定义字段的适用范围勾选用） */
export function atlasCategoryOptions(tab: TabDef): string[] {
  const col = (tab.columns ?? []).find(c => c.name === '类别')
  return col?.options ?? []
}

/** 空配置：**合法默认**，读取失败时用它兜底但绝不回写覆盖原配置（方案 §4.3） */
export function emptyAtlasSchema(): AtlasSchemaConfig {
  return {
    formatVersion: 1,
    revision: 0,
    fields: [],
    groups: [],
    builtinPresentation: {},
    summaryKeys: [],
  }
}

export function defaultSummaryKeys(tabId: AtlasTabId): string[] {
  return [...DEFAULT_SUMMARY_KEYS[tabId]]
}

function groupSpecOf(tabId: string): readonly GroupSpec[] {
  return isAtlasTab(tabId) ? GROUP_SPEC[tabId] : []
}

function groupOrderOf(tabId: string, groupId: string, config?: AtlasSchemaConfig | null): number {
  const spec = groupSpecOf(tabId).find(g => g.id === groupId)
  if (spec) return spec.order
  const custom = config?.groups.find(g => g.id === groupId)
  if (custom) return 500 + custom.order // 自定义组排在所有内置组之后
  return 900
}

function groupLabelOf(tabId: string, groupId: string, config?: AtlasSchemaConfig | null): string {
  const spec = groupSpecOf(tabId).find(g => g.id === groupId)
  if (spec) return spec.label
  const custom = config?.groups.find(g => g.id === groupId)
  return custom ? custom.label : '补充资料'
}

/** 自定义字段的适用范围判定：没填类别时只保留「不限类别」的字段（保守，不猜） */
function appliesTo(def: { appliesTo: '*' | string[] }, category?: string): boolean {
  if (def.appliesTo === '*') return true
  const list = def.appliesTo
  if (list.length === 0) return false
  const c = (category ?? '').trim()
  if (!c) return false
  return list.includes(c)
}

export interface ResolveAtlasOptions {
  /** 字段别名单（内置字段的显示名覆写，来自 `lib/settings/fieldAlias`） */
  aliases?: Record<string, string>
  config?: AtlasSchemaConfig | null
  /** 用途：决定 tableVisible / detailVisible / aiReadable 等开关怎么生效 */
  purpose?: AtlasPurpose
  /** 条目当前类别值，用于自定义字段的适用范围过滤 */
  category?: string
  /**
   * 忽略 `appliesTo`（类别适用范围）过滤。
   * 给「全表视图」用：卡片摘要配置、导出列清单 —— 这些地方不该因为某字段只适用于「魔兽」
   * 就在界面上消失（否则作者根本选不到它）。
   */
  ignoreAppliesTo?: boolean
  /**
   * 返回**未过滤的完整结构**（3.2.0 · WT1-2，仅派生模板快照时用）。
   *
   * 🔴 为什么需要：常规解析会按本次用途过滤 —— 归档字段不显示、类别不适用不算、
   *    某个视图里隐藏了某列。而**快照存的是定义本身**：那些被过滤掉的东西
   *    都是作者还可能恢复的（方案 §3.6：迁移要「复制字段定义、归档项和权限」），
   *    存档时一律带走，不能因为"此刻看不见"就永久删掉。
   *    「此刻看不看得到」交给解析侧按用途再判一次 —— 两套口径的分工在这里。
   *
   * 默认 false ⇒ 除快照派生外的所有既有调用**逐字不变**。
   */
  unfiltered?: boolean
}

/**
 * 把「内置列 + 自定义字段定义」解析成一份统一的字段清单。
 *
 * 非 races／items 页签也会走这里（返回原始列），但组件只在两个页签调用 ——
 * 保留这个兜底是为了将来别的表格复用时不至于返回空。
 */
export function resolveAtlasFields(tab: TabDef, opts: ResolveAtlasOptions = {}): ResolvedAtlasField[] {
  const purpose = opts.purpose ?? 'detail'
  const config = opts.config ?? null
  const spec = groupSpecOf(tab.id)
  const out: ResolvedAtlasField[] = []
  // 🔴 未过滤视图（派生快照用）：跳过归档 / 类别 / 用途三道过滤，只要完整定义
  const raw = opts.unfiltered === true

  const groupOfBuiltin = (key: string): string => {
    const override = config?.builtinPresentation[key]?.groupId
    if (override) return override
    return spec.find(g => g.keys.includes(key))?.id ?? 'extra'
  }

  ;(tab.columns ?? []).filter(c => !c.hidden).forEach((col, index) => {
    const pres = config?.builtinPresentation[col.name]
    if (!raw && purpose === 'table' && pres?.tableVisible === false) return
    if (!raw && purpose === 'detail' && pres?.detailVisible === false) return
    out.push({
      key: col.name,
      label: opts.aliases?.[col.name] ?? col.name,
      source: 'builtin',
      builtinType: col.type ?? 'text',
      ...(col.fixedOptions ? { fixedOptions: true } : {}),
      groupId: groupOfBuiltin(col.name),
      order: pres?.order ?? index,
      options: col.options,
      // 内置字段一律可读可搜；「可写」由各自 AI 链路按业务规则决定，不经这里
      tableVisible: pres?.tableVisible ?? true,
      detailVisible: pres?.detailVisible ?? true,
      searchable: true,
      aiReadable: true,
      aiWritable: false,
      appliesTo: '*',
    })
  })

  for (const def of config?.fields ?? []) {
    if (!raw && def.archived) continue
    if (!raw && !opts.ignoreAppliesTo && !appliesTo(def, opts.category)) continue
    if (!raw && purpose === 'table' && !def.tableVisible) continue
    if (!raw && purpose === 'detail' && !def.detailVisible) continue
    if (!raw && purpose === 'search' && !def.searchable) continue
    if (!raw && purpose === 'aiRead' && !def.aiReadable) continue
    if (!raw && purpose === 'aiWrite' && !def.aiWritable) continue
    out.push({
      key: def.id,
      label: def.label,
      source: 'custom',
      customType: def.type,
      groupId: def.groupId,
      order: def.order,
      unit: def.unit,
      description: def.description,
      options: def.options,
      tableVisible: def.tableVisible,
      detailVisible: def.detailVisible,
      searchable: def.searchable,
      aiReadable: def.aiReadable,
      aiWritable: def.aiWritable,
      appliesTo: def.appliesTo,
      ...(def.archived ? { archived: true } : {}),
    })
  }

  return out.sort((a, b) => {
    const ga = groupOrderOf(tab.id, a.groupId, config)
    const gb = groupOrderOf(tab.id, b.groupId, config)
    if (ga !== gb) return ga - gb
    return a.order - b.order
  })
}

/**
 * 两份字段定义之间，**「能不能给 AI 看」这件事变没变**（3.1.3 · R04）。
 *
 * 🔴 为什么必须专门判：语义索引是**已经算好的向量**，改了 `aiReadable` / `archived`
 *    并不会回头改旧向量 —— 作者刚把某字段设成"不给 AI 参考"，旧索引里那段文本照样能被召回、
 *    照样注回提示词。所以调用方据此**作废旧索引**（宁可让作者重建一次，也不能继续泄漏）。
 *
 * 只认 AI 可见性的变化：改名 / 调顺序 / 改下拉选项不影响"能不能看"，不该逼作者重建。
 * @returns true ⇒ 需要作废索引
 */
export function atlasAiVisibilityChanged(
  before: readonly { id: string; aiReadable?: boolean; archived?: boolean }[],
  after: readonly { id: string; aiReadable?: boolean; archived?: boolean }[],
): boolean {
  const visOf = (f: { id: string; aiReadable?: boolean; archived?: boolean }) =>
    `${f.archived ? 'A' : '-'}${f.aiReadable === false ? 'N' : 'Y'}`
  const map = new Map<string, string>()
  for (const f of before ?? []) map.set(f.id, visOf(f))
  for (const f of after ?? []) {
    const was = map.get(f.id)
    // 新加的字段：旧索引里根本没有它 ⇒ 不用为此逼作者重建
    if (was === undefined) continue
    if (was !== visOf(f)) return true
  }
  // 字段被整个删掉也算：删掉的字段此前可能已进索引
  const afterIds = new Set((after ?? []).map(f => f.id))
  return (before ?? []).some(f => !afterIds.has(f.id))
}

/**
 * 从一份**全表字段清单**里，按**某一条目的类别**挑出真正适用的那些（3.1.3 · R02）。
 *
 * 🔴 为什么要有这么一步：修 R02 之前，表格 / 详情 / 检索调 `resolveAtlasFields` 时
 *    都没传 `category`，于是 `appliesTo` 判定里 `category` 恒为空 ⇒
 *    **只要字段不是"不限类别"，就被整类排除**（验收实测：魔兽条目存了"食性=冰晶"，
 *    表格没这一列、详情没这一项、搜索也搜不到，值其实还在库里）。
 *
 *    正确做法是**两分**：表结构解析（列清单 / 摘要候选）取**全量**，
 *    再按每行自己的 `类别` 逐行决定"这一行用得上哪些"。
 *    这样既不会让列凭空消失，也不会把「只适用魔兽」的字段塞给一条灵兽。
 *
 * @param category 该条目的类别值（空 ⇒ 只保留不限类别的字段，保守、不猜）
 */
export function atlasFieldsForCategory<T extends { appliesTo: '*' | string[] }>(
  fields: readonly T[],
  category?: string,
): T[] {
  const c = (category ?? '').trim()
  if (!c) return fields.filter(f => f.appliesTo === '*')
  return fields.filter(f => f.appliesTo === '*' || f.appliesTo.includes(c))
}

/** 按分组聚合（详情页用）。空组分不出现在结果里 —— 字段数为零就不该有标题 */
export function atlasSections(
  tab: TabDef,
  fields: readonly ResolvedAtlasField[],
  config?: AtlasSchemaConfig | null,
): AtlasResolvedSection[] {
  const byGroup = new Map<string, ResolvedAtlasField[]>()
  for (const f of fields) {
    const arr = byGroup.get(f.groupId)
    if (arr) arr.push(f)
    else byGroup.set(f.groupId, [f])
  }
  return [...byGroup.entries()]
    .map(([id, list]) => ({ id, label: groupLabelOf(tab.id, id, config), fields: list }))
    .sort((a, b) => groupOrderOf(tab.id, a.id, config) - groupOrderOf(tab.id, b.id, config))
}

/**
 * 卡片摘要字段：按 summaryKeys（作者配置）→ 默认表 的顺序取，最多 3 个。
 * 🔴 摘要只看「这一行填了什么」，字段有没有值由调用方逐行过滤 —— 不同条目显示不同条数才是对的。
 */
export function atlasSummaryFields(
  tabId: string,
  fields: readonly ResolvedAtlasField[],
  config?: AtlasSchemaConfig | null,
): ResolvedAtlasField[] {
  const byKey = new Map(fields.map(f => [f.key, f]))
  const keys = config?.summaryKeys.length
    ? config.summaryKeys
    : isAtlasTab(tabId)
      ? DEFAULT_SUMMARY_KEYS[tabId]
      : []
  const picked: ResolvedAtlasField[] = []
  for (const k of keys) {
    const f = byKey.get(k)
    if (f) picked.push(f)
    if (picked.length >= ATLAS_MAX_SUMMARY) break
  }
  return picked
}

/** 卡片上的小徽标（类别 / 品级 / 威胁等级）：空值一律不显示，不占位 */
/** 该页签卡片徽标用到的字段键（字段设置面板据此提示：这几项在卡片上已经显示过了） */
export function atlasBadgeKeys(tabId: string): readonly string[] {
  return isAtlasTab(tabId) ? BADGE_KEYS[tabId] : []
}

export function atlasCardBadges(tabId: string, data: Record<string, string>): string[] {
  if (!isAtlasTab(tabId)) return []
  return BADGE_KEYS[tabId].map(k => (data[k] ?? '').trim()).filter(Boolean)
}

/**
 * 字段值的显示文本（表格 / 图鉴 / 搜索共用）。
 * 保密等级要把单字母翻成含义 —— 但**存储值仍是单字母**，这里只做展示。
 */
export function atlasDisplayValue(field: ResolvedAtlasField, raw: string | undefined | null): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  if (field.key === '保密等级') return SABC_LABELS[s] ?? s
  if (field.customType) {
    return formatCustomValue(field.customType, s, field.unit)
  }
  return s
}

/** 该行在某字段上是否有内容（卡片摘要 / 详情「未填」判定共用） */
export function atlasHasValue(data: Record<string, string>, field: ResolvedAtlasField): boolean {
  return !isEmptyValue(data[field.key])
}

/**
 * 检索正文（方案 §8.1）：把一行按「可读字段名：格式化后的值」拼成文本。
 *
 * 🔴 三条口径：
 *   1. **字段名也进正文** —— 否则作者搜「食性」永远搜不到（值里只有「肉食」）；
 *   2. 多选 / 布尔按显示形态展开（`["怕水","怕火"]` → `怕水、怕火`），不让引号括号污染分词；
 *   3. `cf_` 内部键**从不出现**在正文里（只拼 `field.label`）。
 */
export function atlasSearchText(fields: readonly ResolvedAtlasField[], data: Record<string, string>): string {
  const parts: string[] = []
  for (const f of fields) {
    const raw = data[f.key]
    if (!raw || !raw.trim()) continue
    const shown = f.customType ? formatCustomValue(f.customType, raw, f.unit) : raw.trim()
    if (!shown) continue
    parts.push(`${f.label}：${shown}`)
  }
  return parts.join('\n')
}
