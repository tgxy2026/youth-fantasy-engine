/**
 * 图鉴（3.1.3）· **自定义字段 → 表格列** 的映射（纯函数）。
 *
 * 依据：方案 §4.3「非 races／items 调用继续返回原始 schema 行为」+ §10 F3。
 *
 * 🔴 三条不许破的口径：
 *   1. 内置列**原样返回**（含 `hidden`），一个字节都不改 —— 它们是存储键与 AI 语义的来源；
 *   2. 自定义列的 `name` 必须是 `cf_<uid>`（存储键），**不是**显示名。表格单元格用它写草稿，
 *      写错就等于把值存到另一个键上（改名即丢数据）；
 *   3. 只有自定义列带 `atlasField` 标记，渲染层据此分流 → 内置列绝不会走新控件，
 *      这样"改一处、别的表全跟着变"的风险被限制在两个页签内。
 */
import type { TabDef, TableColumn } from '@/lib/types'
import { resolveAtlasFields } from './schema'
import type { AtlasSchemaConfig, CustomFieldType, ResolvedAtlasField } from './types'

/** 表格列 + 自定义字段标记（内置列没有这个属性） */
export interface AtlasColumn extends TableColumn {
  atlasField?: ResolvedAtlasField
}

/** 六类型 → 表格列类型：布尔/多选都借用文本或下拉，真正控件由 `AtlasCellInput` 决定 */
const COL_TYPE_OF: Record<CustomFieldType, TableColumn['type']> = {
  text: 'text',
  longText: 'textarea',
  number: 'number',
  select: 'select',
  multiSelect: 'text',
  boolean: 'select',
}

function widthOfCustom(type: CustomFieldType): number {
  if (type === 'number') return 110
  if (type === 'select' || type === 'boolean') return 130
  if (type === 'longText') return 200
  return 160
}

/** 自定义字段列的默认宽度（表格 `widthOf` 用；列宽仍可拖拽并记忆） */
export function customColumnWidth(type: CustomFieldType): number {
  return widthOfCustom(type)
}

/**
 * 组装本页签实际要渲染的列：内置列（原顺序）+ 自定义字段（按 order）。
 *
 * 为什么自定义列一律追加在末尾：本轮不接管内置列的重排（方案 §4.1 只要求「可改显示名、
 * 调整展示位置」，重排内置列涉及宽表格与 3.1.2 的正文保底逻辑，留到后续单独一轮）。
 */
export function atlasColumnsOf(
  tab: TabDef,
  config?: AtlasSchemaConfig | null,
  aliases?: Record<string, string>,
): AtlasColumn[] {
  const builtins: AtlasColumn[] = (tab.columns ?? [])
    .filter(c => !c.hidden)
    .map(c => ({ ...c }))

  /**
   * 🔴 列结构必须取**全量**（`ignoreAppliesTo: true`，3.1.3 · R02）：
   *    表格是「一整张表的列」，不该因为某个字段只适用魔兽就让这一列**在所有行上消失**
   *    —— 那样作者既看不到、也改不到（验收实测：魔兽条目存了"食性=冰晶"，表格没这一列）。
   *    类别是否适用由**每一行**自己决定，见 `atlasFieldsForCategory`。
   *    另：这样"改类别前的历史值"也仍有一个能看见、能改回来的地方。
   */
  const customs = resolveAtlasFields(tab, { config, aliases, purpose: 'table', ignoreAppliesTo: true })
    .filter(f => f.source === 'custom')
    .sort((a, b) => a.order - b.order)

  const customCols: AtlasColumn[] = customs.map(f => {
    const type = f.customType ?? 'text'
    return {
      name: f.key,                       // 🔴 存储键，不是 label
      type: COL_TYPE_OF[type],
      options: type === 'boolean' ? ['true', 'false'] : f.options,
      fixedOptions: type === 'boolean',  // 布尔只有两个值，不给「自定义选项」入口
      tip: f.description || undefined,
      atlasField: f,
    }
  })

  return [...builtins, ...customCols]
}
