import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { bindingWriteGate, pinnedUnavailableLabel } from '@/lib/revision/chapterContextSafety'

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
  /**
   * 绑定读取的三种状态（3.4.0 · B）。
   *
   * 🔴 「读失败」与「没绑定」必须分开：
   *    原实现读失败后也把 `bindingLoaded` 置 true，界面照样允许固定/取消固定 ——
   *    于是作者在"其实没读出来"的空绑定上点一下，就会把 `{outlineId: undefined, pinnedRefs: [...]}`
   *    **整条覆盖**掉库里原本的绑定。规划 §四 明写「读取失败不当作空数据覆盖」。
   *    现在 failed 状态下所有写入口一律关闭，并给出重试。
   */
  const [bindingStatus, setBindingStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [binding, setBinding] = useState<ChapterContextBinding>(() => emptyChapterContextBinding())
  const bindingRef = useRef(binding)
  const persistedRef = useRef<ChapterContextBinding>(binding)
  const statusRef = useRef(bindingStatus)
  statusRef.current = bindingStatus
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  /** 读请求序号：切章/重试后，迟到的旧响应不许落到新上下文 */
  const loadAttempt = useRef(0)
  const [bindingError, setBindingError] = useState('')

  const [outlineCards, setOutlineCards] = useState<CardRecord[]>([])
  const [outlineTemplate, setOutlineTemplate] = useState<EffectiveTemplate | null>(null)
  const [outlineError, setOutlineError] = useState('')
  const [catalog, setCatalog] = useState<ChapterContextCatalogItem[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [catalogError, setCatalogError] = useState('')
  const [query, setQuery] = useState('')
  const [loadingError, setLoadingError] = useState('')
  const outlineTab = getTab('chapter-outline')

  const loadBinding = useCallback(() => {
    const attempt = ++loadAttempt.current
    setBindingStatus('loading')
    setBindingError('')
    setLoadingError('')
    void db.getSettingFor<unknown>(projectId, `${SETTING_PREFIX}${chapterId}`, null).then(raw => {
      if (attempt !== loadAttempt.current) return
      const next = normalizeChapterContextBinding(raw, projectId)
      bindingRef.current = next
      persistedRef.current = next
      setBinding(next)
      setBindingStatus('ready')
    }).catch(() => {
      if (attempt !== loadAttempt.current) return
      // 只清显示，不把空绑定当成"可写基线"：status=failed ⇒ 写入口全部关闭
      const empty = emptyChapterContextBinding()
      bindingRef.current = empty
      persistedRef.current = empty
      setBinding(empty)
      setBindingStatus('failed')
      setBindingError('读取本章资料绑定失败；为避免覆盖原记录，固定与解绑已暂时停用')
    })
  }, [projectId, chapterId])

  useEffect(() => { loadBinding() }, [loadBinding])

  useEffect(() => {
    if (!outlineTab) return
    let alive = true
    setOutlineError('')
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
    }).catch(() => {
      if (!alive) return
      setOutlineError('细纲资料加载失败')
      setLoadingError('细纲资料加载失败')
    })
    return () => { alive = false }
  }, [projectId, outlineTab])

  useEffect(() => {
    let alive = true
    setCatalogLoaded(false)
    setCatalogError('')
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
        // 🔴 目录整体读失败 ≠「这些记录被删了」：分开记，固定项的失效说明据此区分
        setCatalogError('关联资料目录读取失败')
        setLoadingError('关联资料加载失败')
      }
    })
    return () => { alive = false }
  }, [projectId, ctx])

  const saveBinding = (update: (previous: ChapterContextBinding) => ChapterContextBinding) => {
    const gate = bindingWriteGate(statusRef.current)
    if (!gate.allowed) {
      setBindingError(gate.reason)
      return
    }
    const previous = bindingRef.current
    const next = { ...update(previous), schema: 1 as const, updatedAt: Date.now() }
    bindingRef.current = next
    setBinding(next)
    setLoadingError('')
    saveQueue.current = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        await db.setSettingFor(projectId, `${SETTING_PREFIX}${chapterId}`, next)
        persistedRef.current = next
      })
      .catch(() => {
        // 回滚到「上次确认写成功」的版本：界面不能停在"看起来已保存"的状态
        if (bindingRef.current === next) {
          bindingRef.current = persistedRef.current
          setBinding(persistedRef.current)
        }
        setBindingError('保存本章资料失败，已恢复为上次保存的内容，请重试')
      })
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
    const unavailable = pinnedUnavailableLabel({
      tabVisible: tabVisible(ref.tabId, ctx),
      found: !!item,
      catalogError,
    })
    return { ref, item, unavailable }
  }), [binding.pinnedRefs, catalog, ctx, catalogError])

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
    binding,
    /** 只有「确实读成功」才算 loaded；读失败必须让界面关掉写入口 */
    bindingLoaded: bindingStatus === 'ready',
    bindingStatus, bindingError, retryBinding: loadBinding,
    outlineCards, outlineTemplate, outlineError,
    catalogLoaded, catalogError, query, setQuery,
    loadingError, outline, groups, pinned, outlineSuggestions, results, pin, unpin, selectOutline,
  }
}
