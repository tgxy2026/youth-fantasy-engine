/**
 * 模块化表单 / 卡片 / 大纲页签的轻量自定义字段支持（3.7.6 · P1）。
 *
 * 复用 `atlasSchema::<tabId>` 存储键与 `cf_<uid>` 不可变字段键：
 *   · 不破坏既有 `模块名::字段名` 内置数据；
 *   · 母子世界（WorldSetSheet / ParallelSetSheet）共享母页签 `tab.id` 的定义；
 *   · 内置字段显示名仍走 `fieldAlias::<tabId>`，自定义字段显示名即 `def.label`。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TabDef } from '@/lib/types'
import type { AtlasSchemaConfig, ResolvedAtlasField } from '@/lib/atlas/types'
import type { CardGroupView, CardFieldView } from '@/lib/templates/render'
import type { TemplateFieldType } from '@/lib/templates/types'
import { emptyAtlasSchema } from '@/lib/atlas/schema'
import { loadAtlasSchema, saveAtlasSchema, subscribeAtlasSchema } from '@/lib/atlas/persistence'
import { getCurrentProjectId } from '@/lib/db/core'

export const MODULE_CUSTOM_FIELD_TABS = new Set<string>([
  'positioning',
  'worldbase',
  'power',
  'master',
  'style',
  'misc-settings',
  'volume-outline',
  'chapter-outline',
])

export function supportsModuleCustomFields(tab: Pick<TabDef, 'id' | 'modules'>): boolean {
  return MODULE_CUSTOM_FIELD_TABS.has(tab.id) && (tab.modules?.length ?? 0) > 0
}

/** 该页签可用的模块分组（各内置模块名 + 兜底「自定义字段」组） */
export function moduleGroupsOf(tab: TabDef): { id: string; label: string }[] {
  const mods = (tab.modules ?? []).map(m => ({ id: m.name, label: m.name }))
  return [...mods, { id: 'extra', label: '自定义字段' }]
}

/** 把 `AtlasSchemaConfig` 里的未归档自定义字段转成渲染用 `ResolvedAtlasField` */
export function resolveModuleCustomFields(
  config: AtlasSchemaConfig | null | undefined,
  opts: { purpose?: 'detail' | 'search' | 'aiRead' | 'aiWrite' } = {},
): ResolvedAtlasField[] {
  if (!config?.fields?.length) return []
  const purpose = opts.purpose ?? 'detail'
  return config.fields
    .filter(f => {
      if (f.archived) return false
      if (purpose === 'detail' && !f.detailVisible) return false
      if (purpose === 'search' && !f.searchable) return false
      if (purpose === 'aiRead' && !f.aiReadable) return false
      if (purpose === 'aiWrite' && !f.aiWritable) return false
      return true
    })
    .sort((a, b) => a.order - b.order)
    .map(f => ({
      key: f.id,
      label: f.label,
      source: 'custom',
      customType: f.type,
      groupId: f.groupId || 'extra',
      order: f.order,
      unit: f.unit,
      description: f.description,
      options: f.options,
      tableVisible: f.tableVisible,
      detailVisible: f.detailVisible,
      searchable: f.searchable,
      aiReadable: f.aiReadable,
      aiWritable: f.aiWritable,
      appliesTo: '*',
    }))
}

export interface ModuleCustomFieldsState {
  config: AtlasSchemaConfig
  activeFields: ResolvedAtlasField[]
  newerFormat: boolean
  saveConfig: (next: AtlasSchemaConfig) => Promise<AtlasSchemaConfig>
}

export function useModuleCustomFields(tab: TabDef, enabled = true): ModuleCustomFieldsState {
  const pid = getCurrentProjectId()
  const [config, setConfig] = useState<AtlasSchemaConfig>(() => emptyAtlasSchema())
  const [newerFormat, setNewerFormat] = useState(false)

  useEffect(() => {
    if (!enabled || !pid) {
      setConfig(emptyAtlasSchema())
      setNewerFormat(false)
      return
    }
    let alive = true
    const reload = () => {
      void loadAtlasSchema(pid, tab.id).then(r => {
        if (!alive) return
        setConfig(r.config)
        setNewerFormat(r.newerFormat)
      })
    }
    reload()
    const off = subscribeAtlasSchema(changedTabId => {
      if (changedTabId === tab.id) reload()
    })
    return () => { alive = false; off() }
  }, [enabled, pid, tab.id])

  const activeFields = useMemo(
    () => (enabled ? resolveModuleCustomFields(config, { purpose: 'detail' }) : []),
    [enabled, config],
  )

  const saveConfig = useCallback(async (next: AtlasSchemaConfig) => {
    const saved = await saveAtlasSchema(pid, tab.id, next)
    setConfig(saved)
    return saved
  }, [pid, tab.id])

  return { config, activeFields, newerFormat, saveConfig }
}

/** 未采用模板的卡片页签：把内置模块与自定义字段合并成统一 `CardGroupView[]` */
export function buildFallbackCardGroups(
  tab: TabDef,
  aliasLabels: Record<string, string>,
  customFields: readonly ResolvedAtlasField[],
): CardGroupView[] {
  const baseGroups: CardGroupView[] = (tab.modules ?? []).map((m, index) => ({
    id: m.name,
    label: m.name,
    order: index,
    isBasic: m.name.includes('基础信息') || index === 0,
    fields: m.fields.map(f => {
      const key = `${m.name}::${f.name}`
      return {
        key,
        name: f.name,
        label: aliasLabels[key] ?? f.name,
        ...(f.desc ? { desc: f.desc } : {}),
        ...(f.example ? { example: f.example } : {}),
        type: (f.kind === 'numeric' ? 'number' : 'textarea') as TemplateFieldType,
        source: 'builtin' as const,
      }
    }),
  }))
  if (customFields.length === 0) return baseGroups
  const modNames = new Set(baseGroups.map(g => g.id))
  const extra: CardFieldView[] = []
  for (const cf of customFields) {
    const view: CardFieldView = {
      key: cf.key,
      name: cf.label,
      label: cf.label,
      ...(cf.description ? { desc: cf.description } : {}),
      type: (cf.customType === 'longText' ? 'textarea' : cf.customType ?? 'text') as TemplateFieldType,
      ...(cf.options ? { options: [...cf.options] } : {}),
      ...(cf.customType ? { customType: cf.customType } : {}),
      atlasField: cf,
      source: 'custom',
    }
    const target = modNames.has(cf.groupId) ? baseGroups.find(g => g.id === cf.groupId) : undefined
    if (target) target.fields.push(view)
    else extra.push(view)
  }
  if (extra.length > 0) baseGroups.push({ id: 'extra', label: '自定义字段', order: baseGroups.length, isBasic: false, fields: extra })
  return baseGroups
}
