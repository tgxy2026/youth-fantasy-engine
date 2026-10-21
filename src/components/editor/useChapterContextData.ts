import { useEffect, useMemo, useRef, useState } from 'react'
import type { CardRecord, TableRow, TabDef } from '@/lib/types'
import type { RecordRef } from '@/lib/revision/revisionTypes'
import type { VisCtx } from '@/lib/schema'
import { TABS, getTab, tabVisible } from '@/lib/schema'
import * as db from '@/lib/db'
import { loadTemplateDef } from '@/lib/templates/store'
import { loadFieldDefinitions } from '@/lib/templates/fieldDefinition'
import { resolveTemplateForTab } from '@/lib/templates/resolve'
import type { EffectiveTemplate } from '@/lib/templates/types'
import { readAliases } from '@/lib/settings/aliases'
import {
  chapterContextRefKey, emptyChapterContextBinding, findOutlineReferenceSuggestions,
  normalizeChapterContextBinding, outlinePurposeForField,
  type OutlinePurpose,
  type ChapterContextBinding,
} from '@/lib/revision/chapterContext'

export interface ChapterContextCatalogItem {
  ref: RecordRef
  name: string
  source: string
  value: string
  searchText: string
  matchTerms: string[]
}

const SETTING_PREFIX = 'chapterContext32:'

function valueSummary(data: Record<string, string>): string {
  return Object.values(data).map(v => v.trim()).filter(Boolean).slice(0, 3).join(' · ').slice(0, 160)
}

function rowName(tab: TabDef, row: TableRow): string {
  const label = tab.displayCol ? row.data[tab.displayCol] : ''
  return label?.trim() || row.data['名称']?.trim() || row.data['编号']?.trim() || row.id
}

function matchTerms(name: string, tabId: string, data: Record<string, string>): string[] {
  const identifiers = Object.entries(data)
    .filter(([key]) => /(?:编号|代码)$/.test(key))
    .map(([, value]) => value.trim())
  return [...new Set([name, ...readAliases(tabId, data), ...identifiers].filter(value => value.length >= 2))]
}

interface Args { projectId: string; chapterId: string; ctx: VisCtx }

export function useChapterContextData({ projectId, chapterId, ctx }: Args) {
  const [binding, setBinding] = useState<ChapterContextBinding>(() => emptyChapterContextBinding())
  const bindingRef = useRef(binding)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const [bindingLoaded, setBindingLoaded] = useState(false)
  const [outlineCards, setOutlineCards] = useState<CardRecord[]>([])
  const [outlineTemplate, setOutlineTemplate] = useState<EffectiveTemplate | null>(null)
  const [catalog, setCatalog] = useState<ChapterContextCatalogItem[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [loadingError, setLoadingError] = useState('')
  const outlineTab = getTab('chapter-outline')

  useEffect(() => {
    let alive = true
    setBindingLoaded(false)
    setLoadingError('')
    void db.getSettingFor<unknown>(projectId, `${SETTING_PREFIX}${chapterId}`, null).then(raw => {
      if (!alive) return
      const next = normalizeChapterContextBinding(raw, projectId)
      bindingRef.current = next
      setBinding(next)
      setBindingLoaded(true)
    }).catch(() => {
      if (!alive) return
      const next = emptyChapterContextBinding()
      bindingRef.current = next
      setBinding(next)
      setLoadingError('读取章节绑定失败；本次改动可能无法保存')
      setBindingLoaded(true)
    })
    return () => { alive = false }
  }, [projectId, chapterId])

  useEffect(() => {
    if (!outlineTab) return
    let alive = true
    void Promise.all([
      db.getCardRecordsFor(projectId, outlineTab.id),
      loadTemplateDef(projectId, outlineTab.id),
      loadFieldDefinitions(projectId, outlineTab.id),
    ]).then(([cards, def, fieldDefinitions]) => {
      if (!alive) return
      setOutlineCards(cards)
      setOutlineTemplate(resolveTemplateForTab(outlineTab, {
        ...(def ? { def } : {}),
        ...(fieldDefinitions ? { fieldDefinitions } : {}),
      }))
    }).catch(() => { if (alive) setLoadingError('细纲资料加载失败') })
    return () => { alive = false }
  }, [projectId, outlineTab])

  useEffect(() => {
    let alive = true
    setCatalogLoaded(false)
    const sourceTabs = TABS.filter(tab =>
      (tab.type === 'card' || tab.type === 'table')
      && tab.id !== 'chapter-outline'
      && tabVisible(tab.id, ctx),
    )
    void Promise.all(sourceTabs.map(async tab => {
      if (tab.type === 'card') {
        const records = await db.getCardRecordsFor(projectId, tab.id)
        return records.map(record => {
          const value = valueSummary(record.data)
          const terms = matchTerms(record.name, tab.id, record.data)
          return {
            ref: { kind: 'card' as const, projectId, tabId: tab.id, id: record.id },
            name: record.name, source: tab.name, value,
            searchText: `${terms.join(' ')} ${value} ${tab.name}`.toLocaleLowerCase(),
            matchTerms: terms,
          }
        })
      }
      const rows = await db.getTableRowsFor(projectId, tab.id)
      return rows.map(row => {
        const name = rowName(tab, row)
        const value = valueSummary(row.data)
        const terms = matchTerms(name, tab.id, row.data)
        return {
          ref: { kind: 'row' as const, projectId, tabId: tab.id, id: row.id },
          name, source: tab.name, value,
          searchText: `${terms.join(' ')} ${value} ${tab.name}`.toLocaleLowerCase(),
          matchTerms: terms,
        }
      })
    })).then(groups => {
      if (alive) {
        setCatalog(groups.flat())
        setCatalogLoaded(true)
      }
    }).catch(() => {
      if (alive) {
        setCatalog([])
        setCatalogLoaded(true)
        setLoadingError('关联资料加载失败')
      }
    })
    return () => { alive = false }
  }, [projectId, ctx])

  const saveBinding = (update: (previous: ChapterContextBinding) => ChapterContextBinding) => {
    const next = { ...update(bindingRef.current), schema: 1 as const, updatedAt: Date.now() }
    bindingRef.current = next
    setBinding(next)
    setLoadingError('')
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(() => db.setSettingFor(projectId, `${SETTING_PREFIX}${chapterId}`, next))
      .catch(() => setLoadingError('保存章节资料失败，请重试'))
  }

  const outline = outlineCards.find(card => card.id === binding.outlineId)
  const groups = useMemo(() => {
    const template = outlineTemplate
    if (!outline || !template) return []
    const labels = new Map(template.groups.map(group => [group.id, group.label]))
    const byGroup = new Map<string, { label: string; values: { label: string; value: string; purpose?: OutlinePurpose }[] }>()
    for (const field of template.fields) {
      const value = outline.data[field.sourceKey]?.trim()
      if (!value) continue
      const key = field.groupId || 'other'
      const group = byGroup.get(key) ?? { label: labels.get(key) ?? '其他', values: [] }
      group.values.push({ label: field.label, value, purpose: outlinePurposeForField(field) })
      byGroup.set(key, group)
    }
    return [...byGroup.values()]
  }, [outline, outlineTemplate])

  const pinned = useMemo(() => binding.pinnedRefs.map(ref => {
    const item = catalog.find(candidate => chapterContextRefKey(candidate.ref) === chapterContextRefKey(ref))
    const visible = tabVisible(ref.tabId, ctx)
    return { ref, item, unavailable: !visible ? '当前项目未启用此资料模块' : item ? '' : '记录已删除或暂时不可用' }
  }), [binding.pinnedRefs, catalog, ctx])

  const outlineSuggestions = useMemo(() => {
    if (!outline || !outlineTemplate) return []
    const fields = outlineTemplate.fields.flatMap(field => {
      const value = outline.data[field.sourceKey]?.trim()
      return value ? [{
        id: field.id, sourceKey: field.sourceKey, label: field.label, defaultLabel: field.defaultLabel,
        description: field.description, value,
      }] : []
    })
    const pinnedRefs = new Set(binding.pinnedRefs.map(chapterContextRefKey))
    return findOutlineReferenceSuggestions(fields, catalog).map(suggestion => ({
      ...suggestion,
      ambiguous: suggestion.candidates.length > 1,
      candidates: suggestion.candidates.map(candidate => ({
        ...candidate,
        pinned: pinnedRefs.has(chapterContextRefKey(candidate.ref)),
      })),
    }))
  }, [binding.pinnedRefs, catalog, outline, outlineTemplate])

  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return []
    const selected = new Set(binding.pinnedRefs.map(chapterContextRefKey))
    return catalog.filter(item => !selected.has(chapterContextRefKey(item.ref)) && item.searchText.includes(needle)).slice(0, 30)
  }, [binding.pinnedRefs, catalog, query])

  const pin = (ref: RecordRef) => saveBinding(previous => ({
    ...previous, pinnedRefs: [...previous.pinnedRefs, ref],
  }))
  const unpin = (ref: RecordRef) => saveBinding(previous => ({
    ...previous,
    pinnedRefs: previous.pinnedRefs.filter(item => chapterContextRefKey(item) !== chapterContextRefKey(ref)),
  }))
  const selectOutline = (id: string) => saveBinding(previous => ({
    ...previous,
    ...(id ? { outlineId: id } : { outlineId: undefined }),
  }))

  return {
    binding, bindingLoaded, outlineCards, outlineTemplate, catalogLoaded, query, setQuery,
    loadingError, outline, groups, pinned, outlineSuggestions, results, pin, unpin, selectOutline,
  }
}
