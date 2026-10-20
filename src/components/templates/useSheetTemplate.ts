/**
 * 页签的**已采用模板**加载（组件层小钩子）。
 *
 * 数据层负责解析，这里只负责三件事：按「项目 + 页签」读一次快照、订阅变更、
 * 把解析结果交给页面。`useTableSheetModel` 与 `CharacterSheet` 共用它，
 * 避免两边各写一套「读库 → 解析 → 失效」。
 *
 * 🔴 `loadTemplateDef` 必须显式传 pid：异步读取期间作者可能已经切书。
 * 🔴 订阅 `subscribeTemplateStore`：采用 / 放弃自定义 / 迁移回滚都会 emit，
 *    否则页面会停在旧结构，作者以为"点了采用没反应"。
 */
import { useEffect, useMemo, useState } from 'react'
import type { TabDef } from '@/lib/types'
import type { AtlasSchemaConfig } from '@/lib/atlas/types'
import { getCurrentProjectId } from '@/lib/db'
import { loadTemplateDef, subscribeTemplateStore } from '@/lib/templates/store'
import { resolveTemplateCached } from '@/lib/templates/cache'
import { atlasColumnsOf, type AtlasColumn } from '@/lib/atlas/columns'
import { tableColumnsOfTemplate } from '@/lib/templates/render'
import type { TemplateDef } from '@/lib/templates/definition'
import type { EffectiveTemplate } from '@/lib/templates/types'

export interface SheetTemplateState {
  /** 项目采用的快照；null = 仍走内置 / 图鉴兼容适配器 */
  def: TemplateDef | null
  /** 表格视图的实际列（采用快照后由快照决定） */
  effectiveColumns: AtlasColumn[]
  /** `purpose:'aiWrite'` 的解析结果（AI 输出目标） */
  aiWriteTemplate: EffectiveTemplate
}

export function useSheetTemplate(
  tab: TabDef,
  atlasConfig: AtlasSchemaConfig | null,
): SheetTemplateState {
  const pid = getCurrentProjectId()
  const [def, setDef] = useState<TemplateDef | null>(null)

  useEffect(() => {
    let alive = true
    const reload = () => {
      void loadTemplateDef(pid, tab.id)
        .then(d => { if (alive) setDef(d) })
        .catch(() => { if (alive) setDef(null) })
    }
    reload()
    const off = subscribeTemplateStore(reload)
    return () => { alive = false; off() }
  }, [pid, tab.id])

  const tableTemplate = useMemo(
    () => resolveTemplateCached(tab, {
      ...(def ? { def } : {}),
      config: atlasConfig,
      purpose: 'table',
    }, pid),
    [tab, atlasConfig, def, pid],
  )

  const aiWriteTemplate = useMemo(
    () => resolveTemplateCached(tab, {
      ...(def ? { def } : {}),
      config: atlasConfig,
      purpose: 'aiWrite',
      ignoreAppliesTo: true,
    }, pid),
    [tab, atlasConfig, def, pid],
  )

  const effectiveColumns = useMemo<AtlasColumn[]>(
    () => (def ? tableColumnsOfTemplate(tab, tableTemplate) : atlasColumnsOf(tab, atlasConfig)),
    [tab, atlasConfig, def, tableTemplate],
  )

  return { def, effectiveColumns, aiWriteTemplate }
}
