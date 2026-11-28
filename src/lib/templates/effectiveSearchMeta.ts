/**
 * 设定检索 · 当前有效字段键（3.7.3 修「历史老字段与新字段并存」）
 *
 * 【问题】检索页此前用「schema 列 ∪ 记录里所有键」枚举字段（3.6.1 为让图鉴自定义字段可见）。
 *   但作者删掉 / 归档自定义字段、隐藏内置列、或改用新模板后，旧键仍留在 `row.data` / `rec.data` 里。
 *   表格与图鉴只渲染**当前有效字段**，旧键看不到；检索页却把旧键一并列出 ——
 *   于是同一个条目在检索里出现「旧字段 + 新字段」两份。
 *
 * 【口径】本函数返回与 `TableSheet` / `CharacterSheet` 完全相同的有效字段集合：
 *   · 采用模板 → `tableColumnsOfTemplate` / `cardGroupsOfTemplate`；
 *   · 未采用模板 → 表格走 `atlasColumnsOf`（已过滤隐藏列、归档字段），卡片走模板适配器。
 *   · 读取失败返回 `null`，调用方回退旧行为（宁可多显示，也不要整页空白）。
 *
 * 🔴 纯读取：不写库、不改 `row.data`；只用于「哪些键还该出现」的过滤。
 */
import type { TabDef } from '@/lib/types'
import type { AtlasTabId } from '@/lib/atlas/types'
import { getCurrentProjectId } from '@/lib/db'
import { loadTemplateDef } from '@/lib/templates/store'
import { loadFieldDefinitions } from '@/lib/templates/fieldDefinition'
import { loadAliases, defaultLabelOf } from '@/lib/settings/fieldAlias'
import { isAtlasTab } from '@/lib/atlas/schema'
import { loadAtlasSchema } from '@/lib/atlas/persistence'
import { atlasColumnsOf } from '@/lib/atlas/columns'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import { cardGroupsOfTemplate, tableColumnsOfTemplate } from '@/lib/templates/render'

export interface EffectiveSearchMeta {
  /** 当前有效的存储键 */
  keys: Set<string>
  /** 存储键 → 当前显示名（与页面同口径） */
  labels: Record<string, string>
}

export async function loadEffectiveSearchMeta(tab: TabDef): Promise<EffectiveSearchMeta | null> {
  if (tab.type !== 'card' && tab.type !== 'table') return null
  const pid = getCurrentProjectId()
  if (!pid) return null
  try {
    const [def, defDoc, aliases] = await Promise.all([
      loadTemplateDef(pid, tab.id).catch(() => null),
      loadFieldDefinitions(pid, tab.id).catch(() => null),
      loadAliases(tab.id).catch(() => ({} as Record<string, string>)),
    ])
    const loaded = isAtlasTab(tab.id)
      ? await loadAtlasSchema(pid, tab.id as AtlasTabId)
      : null
    // 配置读取失败时 config 是空默认；这时返回 null，让检索页回退旧行为，避免自定义字段整片消失
    if (loaded?.error) return null
    const config = loaded?.config ?? null
    const tpl = resolveTemplateForTab(tab, {
      ...(def ? { def } : {}),
      config,
      aliases,
      ...(defDoc ? { fieldDefinitions: defDoc } : {}),
      purpose: tab.type === 'card' ? 'detail' : 'table',
    })
    if (tab.type === 'card') {
      const fields = cardGroupsOfTemplate(tab, tpl).flatMap(g => g.fields)
      return {
        keys: new Set(fields.map(f => f.key)),
        labels: Object.fromEntries(fields.map(f => [f.key, f.label])),
      }
    }
    // 与 `useSheetTemplate` 的 effectiveColumns 同口径：
    // 采用快照走模板列；未采用走图鉴列（已过滤隐藏列 / 归档字段）。
    const cols = def ? tableColumnsOfTemplate(tab, tpl) : atlasColumnsOf(tab, config, aliases)
    return {
      keys: new Set(cols.map(c => c.name)),
      /**
       * 🔴 3.7.6：自定义字段的显示名在 `atlasField.label` 里（作者起的「种族名」），
       *    `templateLabel` 只有采用模板后才有。漏了它，设定检索会把 `cf_xxx` 原始键
       *    直接摆给作者看（表格 / 图鉴读的是 atlasField.label，所以那边正常）。
       */
      labels: Object.fromEntries(cols.map(c => [
        c.name,
        c.templateLabel ?? c.atlasField?.label ?? defaultLabelOf(c.name),
      ])),
    }
  } catch {
    return null
  }
}