/**
 * 人物小传页签（3.7.1 · W2/W3）
 *
 * 角色管理组独立页签：聚焦主要角色与次要角色，提供「人物生平小传正文 + 重要节点事件轴」双层结构。
 * 支持手动编辑、从 3.7.0 状态演变零消耗引入、角色卡双向跳转、Markdown 导出，以及 API / MCP / ACP 三模式 AI 整理。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowUp, BookOpen, ExternalLink, FileUp, History,
  Loader2, Pencil, Plus, Save, ScrollText, Search, Sparkles, Tags, Trash2, Undo2, UserRound,
} from 'lucide-react'
import * as db from '@/lib/db'
import type { CustomOptionPayload } from '@/lib/db'
import type { NavigateToReference } from '@/lib/app/navigation'
import { TABS } from '@/lib/schema'
import type { CardRecord, Chapter, Volume } from '@/lib/types'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { downloadText } from '@/lib/storage/zip'
import { readAliases } from '@/lib/settings/aliases'
import { resolveOptions } from '@/lib/settings/customOptions'
import { evolutionOf, readStateRecords, type StateRecord } from '@/lib/settings/stateTrack'
import {
  appendBioNodes, BIO_NODE_TAGS, BIO_TAG_COL_NAME, deleteBiography, deleteBioNode, emptyBiography,
  formatBiographyMarkdown, isDuplicateBioNode, readAllBiographies, renameBioNodeTag,
  reorderCharacterPrequelNode, saveBiographyProse, sortBioNodes, upsertBioNode,
  type BioEventNode, type BioNodeSource, type CharacterBiography,
} from '@/lib/settings/charBiography'
import { aiComposeBiography, aiExtractBioNodes } from '@/lib/aiTasks/charBiographyAI'
import { useWritingReady } from '@/lib/agentHost/useWritingReady'
import { acpStructuredText } from '@/lib/agentHost/acpStructured'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import { Button } from '@/components/common/Button'
import CustomSelect, { CUSTOM_OPTIONS_EVENT } from '@/components/common/CustomSelect'
import HelpPopover from '@/components/common/HelpPopover'
import PageHeader, { pageSummary } from '@/components/common/PageHeader'
import { MasterDetail, MasterList } from '@/components/common/MasterDetail'
import { LoadingState } from '@/components/common/LoadingState'
import AutoTextarea from '@/components/common/AutoTextarea'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import MentionPanel from '@/components/app/MentionPanel'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import {
  AddBioCharacterModal, BatchScanPanel, BioNodeForm, ComposePreviewPanel, StatePromotePanel, type ScanCandidate,
} from '@/components/world/CharacterBioPanels'

interface Props {
  focusRowId?: string | null
  onFocusConsumed?: () => void
  onNavigate?: (id: string, chapterId?: string, rowId?: string) => void
  onNavigateReference?: NavigateToReference
}

const SOURCE_LABEL: Record<BioNodeSource, string> = {
  manual: '手写',
  'post-process': '章后整理',
  'batch-scan': '正文整理',
  'state-promote': '状态演变引入',
}

function tierLabelOf(tabId: string): string {
  if (tabId === 'char-main') return '主要角色'
  if (tabId === 'char-secondary') return '次要角色'
  return 'NPC 角色'
}

function summarizeCardData(rec: CardRecord): string {
  const skip = new Set(['姓名', '别称', '保密等级'])
  const lines: string[] = []
  for (const [k, v] of Object.entries(rec.data)) {
    const val = String(v ?? '').trim()
    if (!val) continue
    const label = k.includes('::') ? k.split('::').pop()! : k
    if (skip.has(label)) continue
    lines.push(`${label}：${val}`)
    if (lines.length >= 16) break
  }
  return lines.join('\n')
}

export default function CharacterBioPage({ focusRowId, onFocusConsumed, onNavigate, onNavigateReference }: Props) {
  const tabMeta = useMemo(() => TABS.find(t => t.id === 'char-bio'), [])
  const { ready: writingReady, viaAcp, agentName, generation, blockedHint } = useWritingReady()

  const [loaded, setLoaded] = useState(false)
  const [cards, setCards] = useState<CardRecord[]>([])
  const [bios, setBios] = useState<Record<string, CharacterBiography>>({})
  const [stateRecords, setStateRecords] = useState<StateRecord[]>([])
  const [chapters, setChapters] = useState<{ chapter: Chapter; chapterNo: number }[]>([])

  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [proseDraft, setProseDraft] = useState('')
  const [savingProse, setSavingProse] = useState(false)

  const [tagFilter, setTagFilter] = useState<string>('全部')
  const [tagOptionsPayload, setTagOptionsPayload] = useState<CustomOptionPayload>({ items: [], hidden: [] })
  const [manageTagsOpen, setManageTagsOpen] = useState(false)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [addingBio, setAddingBio] = useState(false)
  const [mention, setMention] = useState<{ id: string; name: string; aliases: string[] } | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editingNode, setEditingNode] = useState<BioEventNode | null>(null)
  const [nodeSaving, setNodeSaving] = useState(false)

  const [promoteOpen, setPromoteOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanCandidates, setScanCandidates] = useState<ScanCandidate[] | null>(null)
  const [scanPicked, setScanPicked] = useState<Set<string>>(new Set())
  const [scanMaxChapterNo, setScanMaxChapterNo] = useState(0)

  const [composing, setComposing] = useState(false)
  const [composePreview, setComposePreview] = useState<{ mode: 'draft' | 'continue'; text: string } | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => () => { abortRef.current?.abort() }, [])

  const loadAll = useCallback(async () => {
    const [mainList, secList, npcList, bioMap, stList, vols, chs, tagOpts] = await Promise.all([
      db.getCardRecords('char-main').catch(() => [] as CardRecord[]),
      db.getCardRecords('char-secondary').catch(() => [] as CardRecord[]),
      db.getCardRecords('char-npc').catch(() => [] as CardRecord[]),
      readAllBiographies(),
      readStateRecords(),
      db.getAllVolumes().catch(() => [] as Volume[]),
      db.getAllChapters().catch(() => [] as Chapter[]),
      db.getCustomOptions('char-bio', BIO_TAG_COL_NAME).catch((): CustomOptionPayload => ({ items: [], hidden: [] })),
    ])
    const allCards = [...mainList, ...secList, ...npcList]
    const seq = chapterSeqMap(vols, chs)
    const orderedChs = chs
      .map(ch => ({ chapter: ch, chapterNo: seq.get(ch.id) ?? 0 }))
      .filter(x => x.chapterNo > 0)
      .sort((a, b) => a.chapterNo - b.chapterNo)
    setCards(allCards)
    setBios(bioMap)
    setStateRecords(stList)
    setChapters(orderedChs)
    setTagOptionsPayload(tagOpts)
    setLoaded(true)
    setActiveId(prev => {
      if (focusRowId && allCards.some(c => c.id === focusRowId)) return focusRowId
      if (prev && allCards.some(c => c.id === prev) && (prev in bioMap)) return prev
      return allCards.find(c => c.id in bioMap)?.id ?? null
    })
  }, [focusRowId])

  useEffect(() => { void loadAll() }, [loadAll])

  useEffect(() => {
    let alive = true
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ tabId?: string; colName?: string }>).detail
      if (!d || d.tabId !== 'char-bio' || d.colName !== BIO_TAG_COL_NAME) return
      void db.getCustomOptions('char-bio', BIO_TAG_COL_NAME).then(p => {
        if (alive) setTagOptionsPayload(p)
      }).catch(() => {})
    }
    window.addEventListener(CUSTOM_OPTIONS_EVENT, onChanged)
    return () => { alive = false; window.removeEventListener(CUSTOM_OPTIONS_EVENT, onChanged) }
  }, [])

  useEffect(() => {
    if (focusRowId && cards.some(c => c.id === focusRowId)) {
      setActiveId(focusRowId)
      onFocusConsumed?.()
    }
  }, [focusRowId, cards, onFocusConsumed])

  const selectedCard = useMemo(
    () => cards.find(c => c.id === activeId) ?? null,
    [cards, activeId],
  )
  const selectedBio = useMemo(
    () => (selectedCard ? (bios[selectedCard.id] ?? emptyBiography(selectedCard.id)) : null),
    [selectedCard, bios],
  )
  const proseDirty = !!selectedBio && proseDraft !== selectedBio.prose

  useEffect(() => {
    setProseDraft(selectedBio?.prose ?? '')
    setFormOpen(false)
    setEditingNode(null)
    setPromoteOpen(false)
    setScanOpen(false)
    setScanCandidates(null)
    setScanPicked(new Set())
    setComposePreview(null)
  }, [selectedCard?.id, selectedBio?.prose])

  const switchCharacter = async (nextId: string) => {
    if (nextId === activeId) return
    if (proseDirty && selectedCard) {
      const leave = await confirmDialog({
        title: '小传正文尚未保存',
        message: `「${selectedCard.name}」的小传正文有未保存改动，切换角色会丢弃这些改动。是否继续切换？`,
        confirmText: '放弃改动并切换',
        cancelText: '留在本角色',
      })
      if (!leave) return
    }
    setActiveId(nextId)
  }

  const handleSaveProse = useCallback(async () => {
    if (!selectedCard || savingProse || !proseDirty) return
    setSavingProse(true)
    try {
      const r = await saveBiographyProse(selectedCard.id, proseDraft)
      if (!r.ok || !r.bio) {
        showToast('保存小传失败，原内容未变动，请重试', 'error')
        return
      }
      setBios(prev => ({ ...prev, [selectedCard.id]: r.bio! }))
      showToast('已保存角色小传正文', 'success')
    } finally {
      setSavingProse(false)
    }
  }, [selectedCard, savingProse, proseDirty, proseDraft])

  useSaveHotkey(handleSaveProse)

  const bioCardIdsSet = useMemo(() => new Set(Object.keys(bios)), [bios])
  const bioCards = useMemo(
    () => cards.filter(c => bioCardIdsSet.has(c.id) || c.id === activeId),
    [cards, bioCardIdsSet, activeId],
  )

  const filteredCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return bioCards
    return bioCards.filter(c => {
      if (c.name.toLowerCase().includes(q)) return true
      const aliases = readAliases(c.tabId, c.data)
      return aliases.some(a => a.toLowerCase().includes(q))
    })
  }, [bioCards, query])

  const mainCards = useMemo(() => filteredCards.filter(c => c.tabId === 'char-main'), [filteredCards])
  const secCards = useMemo(() => filteredCards.filter(c => c.tabId === 'char-secondary'), [filteredCards])
  const npcCards = useMemo(() => filteredCards.filter(c => c.tabId === 'char-npc'), [filteredCards])

  const charStates = useMemo(() => {
    if (!selectedCard) return []
    const pid = selectedCard.projectId || db.getCurrentProjectId() || ''
    return evolutionOf(stateRecords, { kind: 'card', tabId: selectedCard.tabId, id: selectedCard.id, projectId: pid })
  }, [selectedCard, stateRecords])

  const resolvedTagNames = useMemo(
    () => resolveOptions([...BIO_NODE_TAGS], tagOptionsPayload).map(o => o.name),
    [tagOptionsPayload],
  )
  const displayTagOf = useCallback(
    (raw: string) => tagOptionsPayload.renamed?.[raw] ?? raw,
    [tagOptionsPayload.renamed],
  )

  const sortedNodes = useMemo(() => sortBioNodes(selectedBio?.nodes ?? []), [selectedBio])
  const allFilterTags = useMemo(() => {
    const base = ['全部', ...resolvedTagNames]
    const seen = new Set(base)
    for (const n of sortedNodes) {
      const label = displayTagOf(n.tag)
      if (label && !seen.has(label)) {
        seen.add(label)
        base.push(label)
      }
    }
    return base
  }, [resolvedTagNames, sortedNodes, displayTagOf])

  useEffect(() => {
    if (tagFilter !== '全部' && !allFilterTags.includes(tagFilter)) {
      setTagFilter('全部')
    }
  }, [tagFilter, allFilterTags])

  const visibleNodes = useMemo(
    () => (tagFilter === '全部'
      ? sortedNodes
      : sortedNodes.filter(n => displayTagOf(n.tag) === tagFilter || n.tag === tagFilter)),
    [sortedNodes, tagFilter, displayTagOf],
  )
  const prequelNodes = useMemo(() => visibleNodes.filter(n => n.phase === 'prequel'), [visibleNodes])
  const storyNodes = useMemo(() => visibleNodes.filter(n => n.phase === 'story'), [visibleNodes])
  const allPrequelCount = useMemo(() => sortedNodes.filter(n => n.phase === 'prequel').length, [sortedNodes])

  const handleRenameTag = async (oldName: string, newName: string) => {
    const next = newName.trim()
    if (!oldName.trim() || !next || oldName === next) return
    const prevDisplay = tagOptionsPayload.renamed?.[oldName]
    let totalUpdated = 0
    const r1 = await renameBioNodeTag(oldName, next)
    if (r1.ok) totalUpdated += r1.updated
    if (prevDisplay && prevDisplay !== oldName) {
      const r2 = await renameBioNodeTag(prevDisplay, next)
      if (r2.ok) totalUpdated += r2.updated
    }
    if (totalUpdated > 0) {
      const fresh = await readAllBiographies()
      setBios(fresh)
    }
    setTagFilter(prev => (prev === oldName || prev === prevDisplay ? next : prev))
  }

  const refreshSelectedBio = async (characterId: string) => {
    const fresh = await readAllBiographies()
    setBios(fresh)
    if (!fresh[characterId]) {
      setBios(prev => ({ ...prev, [characterId]: emptyBiography(characterId) }))
    }
  }

  const handleSaveNode = async (node: BioEventNode) => {
    if (!selectedCard || nodeSaving) return
    setNodeSaving(true)
    try {
      const r = await upsertBioNode(selectedCard.id, node)
      if (!r.ok) { showToast('保存节点失败，请重试', 'error'); return }
      await refreshSelectedBio(selectedCard.id)
      setFormOpen(false)
      setEditingNode(null)
      showToast(editingNode ? '已更新重要节点' : '已添加重要节点', 'success')
    } finally {
      setNodeSaving(false)
    }
  }

  const handleDeleteNode = async (node: BioEventNode) => {
    if (!selectedCard) return
    const okDel = await confirmDialog({
      title: '删除重要节点',
      message: `确定删除节点「${node.title}」吗？删除后不会影响小传正文或章节正文。`,
      confirmText: '确认删除',
    })
    if (!okDel) return
    const r = await deleteBioNode(selectedCard.id, node.id)
    if (!r.ok) { showToast('删除节点失败，请重试', 'error'); return }
    await refreshSelectedBio(selectedCard.id)
    showToast('已删除该节点', 'success')
  }

  const handleReorderPrequel = async (nodeId: string, dir: -1 | 1) => {
    if (!selectedCard) return
    const r = await reorderCharacterPrequelNode(selectedCard.id, nodeId, dir)
    if (!r.ok) { showToast('调整顺序失败', 'error'); return }
    await refreshSelectedBio(selectedCard.id)
  }

  const handlePromoteStates = async (nodes: BioEventNode[]) => {
    if (!selectedCard || nodes.length === 0) return
    setNodeSaving(true)
    try {
      const r = await appendBioNodes(selectedCard.id, nodes)
      if (!r.ok) { showToast('引入状态记录失败', 'error'); return }
      await refreshSelectedBio(selectedCard.id)
      showToast(`已引入 ${r.appended} 条节点${r.skippedDup ? `（跳过 ${r.skippedDup} 条重复）` : ''}`, 'success')
    } finally {
      setNodeSaving(false)
    }
  }

  const buildAcpText = (owner: ReturnType<typeof captureOwnedOperation>, signal: AbortSignal) => {
    if (!viaAcp || !generation) return undefined
    return acpStructuredText({
      task: 'char-bio',
      generation,
      agentName: agentName ?? 'ACP Agent',
      signal,
      assertCurrent: () => owner.assertCurrent(),
      ask: confirmDialog,
      askOnce: true,
    })
  }

  const handleScanChapters = async (fromNo: number, toNo: number) => {
    if (!selectedCard || scanning || !writingReady) return
    const slice = chapters.filter(x => x.chapterNo >= fromNo && x.chapterNo <= toNo && x.chapter.content.trim())
    if (slice.length === 0) {
      showToast('所选章号范围内没有可扫描的正文', 'info')
      return
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const owner = captureOwnedOperation(db.getCurrentProjectId())
    setScanning(true)
    setScanCandidates(null)
    setScanPicked(new Set())
    try {
      const acpText = buildAcpText(owner, ctrl.signal)
      const res = await aiExtractBioNodes(
        {
          characterName: selectedCard.name,
          aliases: readAliases(selectedCard.tabId, selectedCard.data),
          chapters: slice.map(x => ({ chapterNo: x.chapterNo, title: x.chapter.title, content: x.chapter.content })),
          existingTitles: sortedNodes.map(n => n.title),
          allowedTags: resolvedTagNames,
        },
        { signal: ctrl.signal, ...(acpText ? { acpText } : {}) },
      )
      owner.assertCurrent()
      if (res.outcome === 'cancelled') { showToast('已取消抽取', 'info'); return }
      if (res.outcome !== 'completed') { showToast(res.error || '抽取失败，请重试', 'error'); return }

      const existing = selectedBio?.nodes ?? []
      const candidates: ScanCandidate[] = res.nodes.map((node, i) => {
        const dup = isDuplicateBioNode(existing, {
          phase: node.chapterNo > 0 ? 'story' : 'prequel',
          chapterNo: node.chapterNo,
          title: node.title,
          summary: node.summary,
        })
        return { key: `scan-${i}-${node.chapterNo}-${node.title}`, node, duplicate: dup }
      })
      setScanCandidates(candidates)
      setScanMaxChapterNo(toNo)
      setScanPicked(new Set(candidates.filter(c => !c.duplicate).map(c => c.key)))
    } catch (e) {
      showToast(e instanceof Error ? e.message : '抽取失败', 'error')
    } finally {
      setScanning(false)
    }
  }

  const handleApplyScan = async () => {
    if (!selectedCard || !scanCandidates) return
    const chosen = scanCandidates.filter(c => !c.duplicate && scanPicked.has(c.key))
    if (chosen.length === 0) return
    const chByNo = new Map(chapters.map(x => [x.chapterNo, x.chapter.id]))
    const toAppend = chosen.map(c => ({
      phase: (c.node.chapterNo > 0 ? 'story' : 'prequel') as 'story' | 'prequel',
      chapterId: chByNo.get(c.node.chapterNo),
      chapterNo: c.node.chapterNo,
      title: c.node.title,
      summary: c.node.summary,
      tag: c.node.tag,
      source: 'batch-scan' as const,
      evidence: c.node.evidence,
    }))
    const built = toAppend.map((x, idx) => ({
      id: `bio-scan-${Date.now().toString(36)}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      phase: x.phase,
      ...(x.chapterId ? { chapterId: x.chapterId } : {}),
      chapterNo: x.phase === 'story' ? x.chapterNo : 0,
      order: allPrequelCount + idx,
      title: x.title,
      summary: x.summary,
      tag: x.tag,
      source: x.source,
      evidence: x.evidence,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }))
    const r = await appendBioNodes(selectedCard.id, built, { lastScannedChapterNo: scanMaxChapterNo })
    if (!r.ok) { showToast('追加节点失败，请重试', 'error'); return }
    await refreshSelectedBio(selectedCard.id)
    setScanCandidates(null)
    setScanPicked(new Set())
    setScanOpen(false)
    showToast(`已追加 ${r.appended} 条重要节点${r.overflow ? `（超出上限未保留 ${r.overflow} 条）` : ''}`, 'success')
  }

  const handleCompose = async (mode: 'draft' | 'continue') => {
    if (!selectedCard || composing || !writingReady) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const owner = captureOwnedOperation(db.getCurrentProjectId())
    setComposing(true)
    try {
      const acpText = buildAcpText(owner, ctrl.signal)
      const res = await aiComposeBiography(
        {
          characterName: selectedCard.name,
          tierLabel: tierLabelOf(selectedCard.tabId),
          mode,
          cardSummary: summarizeCardData(selectedCard),
          existingProse: proseDraft,
          nodes: sortedNodes.map(n => ({
            phase: n.phase, chapterNo: n.chapterNo, storyTime: n.storyTime,
            title: n.title, summary: n.summary, tag: n.tag,
          })),
          stateLines: charStates.map(s => `第${s.chapterNo || '?'}章：${s.state}${s.previous ? `（原：${s.previous}）` : ''}`),
        },
        { signal: ctrl.signal, ...(acpText ? { acpText } : {}) },
      )
      owner.assertCurrent()
      if (res.outcome === 'cancelled') { showToast('已取消生成', 'info'); return }
      if (res.outcome !== 'completed' || !res.text) {
        showToast(res.error || '未能生成有效小传内容，请重试', 'error')
        return
      }
      setComposePreview({ mode, text: res.text })
    } catch (e) {
      showToast(e instanceof Error ? e.message : '生成小传失败', 'error')
    } finally {
      setComposing(false)
    }
  }

  const handleExportMd = () => {
    if (!selectedCard || !selectedBio) return
    const tier = tierLabelOf(selectedCard.tabId)
    const md = formatBiographyMarkdown(selectedCard.name, tier, { ...selectedBio, prose: proseDraft })
    downloadText(`${selectedCard.name}-角色小传.md`, md, 'text/markdown;charset=utf-8')
    showToast('已导出 Markdown 角色小传', 'success')
  }

  const handlePickCharacterForBio = async (card: CardRecord) => {
    if (addingBio) return
    if (bioCardIdsSet.has(card.id)) {
      setAddModalOpen(false)
      setQuery('')
      await switchCharacter(card.id)
      return
    }
    if (proseDirty && selectedCard) {
      const leave = await confirmDialog({
        title: '小传正文尚未保存',
        message: `「${selectedCard.name}」的小传正文有未保存改动，切换角色会丢弃这些改动。是否继续？`,
        confirmText: '放弃改动并切换',
        cancelText: '留在本角色',
      })
      if (!leave) return
    }
    setAddingBio(true)
    try {
      const r = await saveBiographyProse(card.id, '')
      if (!r.ok || !r.bio) {
        showToast('创建角色小传失败，请重试', 'error')
        return
      }
      setBios(prev => ({ ...prev, [card.id]: r.bio! }))
      setQuery('')
      setActiveId(card.id)
      setAddModalOpen(false)
      showToast(`已为「${card.name}」建立角色小传，可开始编写`, 'success')
    } finally {
      setAddingBio(false)
    }
  }

  const handleDeleteBiography = async (card: CardRecord) => {
    const hasSavedBio = bioCardIdsSet.has(card.id)
    if (!hasSavedBio) {
      if (activeId === card.id) setActiveId(cards.find(c => c.id !== card.id && bioCardIdsSet.has(c.id))?.id ?? null)
      return
    }
    const okDel = await confirmDialog({
      title: '删除角色小传',
      message: `确定删除「${card.name}」的角色小传正文与全部重要节点吗？\n此操作不会删除原角色卡档案。`,
      confirmText: '确认删除小传',
      danger: true,
    })
    if (!okDel) return
    const r = await deleteBiography(card.id)
    if (!r.ok) { showToast('删除角色小传失败，请重试', 'error'); return }
    const nextMap = { ...bios }
    delete nextMap[card.id]
    setBios(nextMap)
    if (activeId === card.id) {
      setActiveId(cards.find(c => c.id !== card.id && (c.id in nextMap))?.id ?? null)
    }
    showToast(`已删除「${card.name}」的角色小传`, 'success')
  }

  const renderGroupList = (title: string, list: CardRecord[]) => {
    if (list.length === 0) return null
    return (
      <div className="space-y-1.5">
        <div className="px-1 text-10 font-medium text-ink-500">{title}（{list.length}）</div>
        {list.map(c => {
          const isActive = c.id === activeId
          const bio = bios[c.id]
          const nodeCount = bio?.nodes.length ?? 0
          const hasProse = !!bio?.prose.trim()
          return (
            <div
              key={c.id}
              onClick={() => void switchCharacter(c.id)}
              title={c.name}
              className={`group cursor-pointer rounded-lg border px-3 py-2.5 transition-all duration-150 ${
                isActive
                  ? 'bg-amber/12 border-amber/30 text-amber ws-control'
                  : 'bg-ink-850/90 border-ink-700/75 text-ink-300 hover:border-ink-600 hover:bg-ink-800/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <Button
                  variant="bare"
                  className="min-w-0 flex-1 !justify-start"
                  onClick={e => { e.stopPropagation(); void switchCharacter(c.id) }}
                  aria-pressed={isActive}
                  aria-label={`选择角色：${c.name}`}
                >
                  <UserRound size={13} className="shrink-0" />
                  <span className="text-13 font-medium truncate">{c.name}</span>
                </Button>
                {isActive && proseDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" />}
                <Button
                  variant="bare"
                  iconOnly
                  size="xs"
                  title={`查看「${c.name}」在正文中的提及`}
                  onClick={e => {
                    e.stopPropagation()
                    setMention({ id: c.id, name: c.name, aliases: readAliases(c.tabId, c.data) })
                  }}
                  className="opacity-40 group-hover:opacity-100 text-ink-500 hover:text-amber transition-all"
                >
                  <Search size={12} />
                </Button>
                <Button
                  variant="icon-danger"
                  iconOnly
                  size="xs"
                  title={`删除「${c.name}」的角色小传`}
                  onClick={e => { e.stopPropagation(); void handleDeleteBiography(c) }}
                  className="opacity-40 group-hover:opacity-100 transition-all"
                >
                  <Trash2 size={12} />
                </Button>
              </div>
              <div className="text-10 text-ink-500 mt-0.5 truncate ws-num">
                {nodeCount} 个节点 · {hasProse ? '已有正文' : '待写正文'}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const renderNodeCard = (node: BioEventNode, idx: number, totalInGroup: number) => (
    <div key={node.id} className="rounded-lg border border-ink-700/75 border-l-2 border-l-amber/50 bg-ink-900/55 p-3 space-y-1.5 ws-control">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <span className="px-1.5 py-px rounded-md text-10 font-medium bg-amber/15 text-amber border border-amber/25 ws-num">
            {node.phase === 'prequel' ? '开篇前' : `第 ${node.chapterNo} 章`}
          </span>
          <span className="px-1.5 py-px rounded text-10 bg-ink-800 border border-ink-700 text-ink-300">{displayTagOf(node.tag)}</span>
          {node.storyTime && <span className="text-10 text-ink-500">{node.storyTime}</span>}
          <span className="text-13 font-medium text-ink-100">{node.title}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {node.phase === 'prequel' && (
            <>
              <Button variant="bare" iconOnly size="xs" disabled={idx === 0} onClick={() => void handleReorderPrequel(node.id, -1)} title="上移">
                <ArrowUp size={12} />
              </Button>
              <Button variant="bare" iconOnly size="xs" disabled={idx === totalInGroup - 1} onClick={() => void handleReorderPrequel(node.id, 1)} title="下移">
                <ArrowDown size={12} />
              </Button>
            </>
          )}
          {node.chapterId && (
            <Button variant="bare" size="xs" onClick={() => onNavigate?.('editor', node.chapterId)} title="跳转到对应章节正文">
              <BookOpen size={11} /> 原文
            </Button>
          )}
          <Button variant="bare" iconOnly size="xs" onClick={() => { setEditingNode(node); setFormOpen(true) }} title="编辑节点">
            <Pencil size={12} />
          </Button>
          <Button variant="icon-danger" iconOnly size="xs" onClick={() => void handleDeleteNode(node)} title="删除节点">
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
      {node.summary && <p className="text-12 text-ink-300 leading-relaxed whitespace-pre-wrap">{node.summary}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-10 text-ink-500">
        {node.evidence ? <span className="border-l-2 border-ink-700 pl-1.5">「{node.evidence}」</span> : <span />}
        <span>来源：{SOURCE_LABEL[node.source]}</span>
      </div>
    </div>
  )

  if (!loaded) return <div className="page-enter h-full min-h-0 flex flex-col"><LoadingState /></div>

  return (
    <div className="page-enter h-full min-h-0 flex flex-col">
      <PageHeader
        title="角色小传"
        description={pageSummary(tabMeta?.description, '主要与次要角色的生平小传与重要节点事件轴')}
        help={(
          <HelpPopover title="角色小传怎么用" width="22rem" size={14}>
            <div className="space-y-1.5">
              <p>· 分上下两层：上层写角色生平小传长文，下层按「开篇前 → 正文章号」记重要里程碑节点。</p>
              <p>· 前传节点可手动上下调序；正文节点按章号升序，并可直接点「原文」回正文。</p>
              <p>· 节点类型支持自定义增、改、删（含预填类型）；可从 3.7.0「状态演变」零消耗引入，或在「颉文姬 · 整理」自动抽取。</p>
              <AIDataSourceNote feature="char-bio" />
            </div>
          </HelpPopover>
        )}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {selectedCard && (
              <>
                <Button
                  variant="toggle"
                  size="md"
                  selected={proseDirty}
                  disabled={!proseDirty || savingProse}
                  onClick={() => void handleSaveProse()}
                  title={proseDirty ? '保存小传正文（Ctrl+S）' : '小传正文已保存'}
                >
                  <Save size={14} /> {savingProse ? '保存中…' : proseDirty ? '保存正文' : '已保存'}
                </Button>
                {/* 🔴 2026-11-25 主人指正：导出是「把内容送出去」，箭头该朝上；
                    此前用 Download（向下）表达的是「拿进来」，与导入同义，语义反了。
                    与 BookVersionPanel 的「导出」（FileUp）保持一致。 */}
                <Button variant="secondary" size="md" onClick={handleExportMd}>
                  <FileUp size={14} /> 导出 Markdown
                </Button>
              </>
            )}
            <Button variant="primary" size="md" onClick={() => setAddModalOpen(true)}>
              <Plus size={14} /> 新增角色小传
            </Button>
          </div>
        )}
      />

      {bioCards.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-ink-700 rounded-xl text-ink-500 gap-2.5 p-8">
          <ScrollText size={26} className="text-ink-600" />
          <p className="text-13 text-ink-300">{cards.length > 0 ? '还没有建立任何角色小传' : '项目内还没有角色卡片'}</p>
          <p className="text-11 text-ink-500">
            {cards.length > 0
              ? '请从已有「主要角色 / 次要角色 / NPC 角色」中挑选人物，即可开始编写小传正文与节点轴。'
              : '请先在「主要角色」「次要角色」或「NPC 角色」页签建好角色卡片，再来这里编写小传。'}
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {cards.length > 0 ? (
              <Button variant="primary" size="sm" onClick={() => setAddModalOpen(true)}>
                <Plus size={13} /> 新增角色小传
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => onNavigate?.('char-main')}>前往主要角色</Button>
            )}
          </div>
        </div>
      ) : (
        <MasterDetail>
          <MasterList
            widthClass="w-44 lg:w-52"
            query={query}
            onQueryChange={setQuery}
            placeholder="搜角色名或别称…"
            isEmpty={filteredCards.length === 0}
            emptyHint="没有匹配的角色"
          >
            <div className="space-y-3">
              {renderGroupList('主要角色', mainCards)}
              {renderGroupList('次要角色', secCards)}
              {renderGroupList('NPC 角色', npcCards)}
            </div>
          </MasterList>

          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
            {selectedCard && selectedBio && (
              <>
                {/* 角色头条 */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-700/75 bg-ink-850/95 px-4 py-3 ws-surface">
                  <div className="flex items-center gap-2 min-w-0">
                    <h2 className="text-15 font-semibold text-ink-50 truncate">{selectedCard.name}</h2>
                    <span className="px-2 py-0.5 rounded-full text-10 bg-amber/15 text-amber border border-amber/30">
                      {tierLabelOf(selectedCard.tabId)}
                    </span>
                    <span className="text-11 text-ink-500 ws-num">{sortedNodes.length} 个重要节点</span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      if (onNavigateReference) {
                        onNavigateReference({ tabId: selectedCard.tabId, label: selectedCard.name, rowId: selectedCard.id, sourceId: selectedCard.id })
                      } else {
                        onNavigate?.(selectedCard.tabId, undefined, selectedCard.id)
                      }
                    }}
                  >
                    <ExternalLink size={13} /> 回到角色卡
                  </Button>
                </div>

                {/* 上层：人物生平小传正文 */}
                <section className="rounded-xl border border-ink-700/75 bg-ink-850/95 p-4 space-y-3 ws-surface">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-13 font-semibold text-ink-100">一、人物生平小传正文</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {proseDirty && (
                        <Button variant="secondary" size="sm" onClick={() => setProseDraft(selectedBio.prose)}>
                          <Undo2 size={13} /> 撤销
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={!writingReady || composing}
                        title={!writingReady ? blockedHint : '根据角色卡、重要节点与状态演变生成小传'}
                        onClick={() => void handleCompose(proseDraft.trim() ? 'continue' : 'draft')}
                      >
                        {composing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                        {composing ? '生成中…' : proseDraft.trim() ? 'AI 续写小传' : 'AI 起草小传'}
                      </Button>
                    </div>
                  </div>
                  <AutoTextarea
                    value={proseDraft}
                    onChange={setProseDraft}
                    minRows={5}
                    maxHeight={380}
                    placeholder={`为「${selectedCard.name}」撰写人物生平小传（支持自由分段）…`}
                    className="w-full rounded-lg border border-ink-700 bg-ink-950/70 px-3 py-2.5 text-13 text-ink-100 leading-relaxed outline-none focus:border-amber/50"
                  />
                  {composePreview && (
                    <ComposePreviewPanel
                      mode={composePreview.mode}
                      text={composePreview.text}
                      hasExisting={!!proseDraft.trim()}
                      onAppend={() => {
                        setProseDraft(prev => (prev.trim() ? `${prev.trimEnd()}\n\n${composePreview.text}` : composePreview.text))
                        setComposePreview(null)
                      }}
                      onReplace={() => {
                        setProseDraft(composePreview.text)
                        setComposePreview(null)
                      }}
                      onDiscard={() => setComposePreview(null)}
                    />
                  )}
                </section>

                {/* 下层：重要节点事件轴 */}
                <section className="rounded-xl border border-ink-700/75 bg-ink-850/95 p-4 space-y-3 ws-surface">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-13 font-semibold text-ink-100">二、重要节点事件轴</h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setPromoteOpen(v => !v)}>
                        <History size={13} /> 从状态演变引入（{charStates.length}）
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setScanOpen(v => !v)}
                        title="按章节范围抽取该角色的里程碑节点候选"
                      >
                        <Sparkles size={13} /> AI 从正文整理节点
                      </Button>
                      <Button
                        variant="primary"
                        solid
                        size="sm"
                        onClick={() => { setEditingNode(null); setFormOpen(true) }}
                      >
                        <Plus size={13} /> 新增节点
                      </Button>
                    </div>
                  </div>

                  {/* 动态节点类型筛选 + 自定义管理入口 */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {allFilterTags.map(tag => (
                      <Button
                        key={tag}
                        variant="toggle"
                        size="sm"
                        selected={tagFilter === tag}
                        onClick={() => setTagFilter(tag)}
                      >
                        {tag}
                      </Button>
                    ))}
                    <Button
                      variant="toggle"
                      size="sm"
                      selected={manageTagsOpen}
                      onClick={() => setManageTagsOpen(v => !v)}
                      title="新增自定义节点类型，或重命名、移除默认类型"
                      className="ml-auto"
                    >
                      <Tags size={13} /> 管理类型
                    </Button>
                  </div>

                  {manageTagsOpen && (
                    <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2">
                      <span className="text-12 text-ink-300 shrink-0">自定义节点类型：</span>
                      <div className="w-56 h-8 rounded-lg border border-ink-700 bg-ink-950 px-1 flex items-center focus-within:border-amber/50">
                        <CustomSelect
                          tabId="char-bio"
                          colName={BIO_TAG_COL_NAME}
                          options={[...BIO_NODE_TAGS]}
                          value={tagFilter === '全部' ? '' : tagFilter}
                          onChange={v => setTagFilter(v || '全部')}
                          payload={tagOptionsPayload}
                          onRenameBuiltin={(oldName, newName) => void handleRenameTag(oldName, newName)}
                        />
                      </div>
                    </div>
                  )}

                  {formOpen && (
                    <BioNodeForm
                      key={editingNode?.id ?? 'new'}
                      initial={editingNode}
                      nextPrequelOrder={allPrequelCount}
                      saving={nodeSaving}
                      defaultTag={resolvedTagNames[0]}
                      tagOptionsPayload={tagOptionsPayload}
                      onRenameTag={(oldName, newName) => void handleRenameTag(oldName, newName)}
                      onCancel={() => { setFormOpen(false); setEditingNode(null) }}
                      onSubmit={handleSaveNode}
                    />
                  )}

                  {promoteOpen && (
                    <StatePromotePanel
                      records={charStates}
                      existingNodes={selectedBio.nodes}
                      busy={nodeSaving}
                      onPromote={handlePromoteStates}
                      onClose={() => setPromoteOpen(false)}
                    />
                  )}

                  {scanOpen && (
                    <BatchScanPanel
                      chapterCount={chapters.length}
                      lastScannedNo={selectedBio.lastScannedChapterNo ?? 0}
                      writingReady={writingReady}
                      blockedHint={blockedHint}
                      scanning={scanning}
                      candidates={scanCandidates}
                      picked={scanPicked}
                      onTogglePick={key => setScanPicked(prev => {
                        const next = new Set(prev)
                        if (next.has(key)) next.delete(key)
                        else next.add(key)
                        return next
                      })}
                      onScan={(f, t) => void handleScanChapters(f, t)}
                      onApply={() => void handleApplyScan()}
                      onClose={() => setScanOpen(false)}
                    />
                  )}

                  {visibleNodes.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-ink-700 py-8 text-center text-12 text-ink-500">
                      {sortedNodes.length === 0
                        ? '还没有重要节点，可点上方「新增节点」、「从状态演变引入」或「AI 从正文整理节点」。'
                        : `「${tagFilter}」分类下暂无节点。`}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {prequelNodes.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-11 font-medium text-ink-400">开篇前（前传 · {prequelNodes.length}）</div>
                          <div className="space-y-2">
                            {prequelNodes.map((n, idx) => renderNodeCard(n, idx, prequelNodes.length))}
                          </div>
                        </div>
                      )}
                      {storyNodes.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-11 font-medium text-ink-400">正文阶段（按章升序 · {storyNodes.length}）</div>
                          <div className="space-y-2">
                            {storyNodes.map((n, idx) => renderNodeCard(n, idx, storyNodes.length))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </>
            )}
          </div>
        </MasterDetail>
      )}
      <AddBioCharacterModal
        open={addModalOpen}
        cards={cards}
        existingBioIds={bioCardIdsSet}
        adding={addingBio}
        onClose={() => setAddModalOpen(false)}
        onPick={handlePickCharacterForBio}
        onNavigateTab={tabId => { setAddModalOpen(false); onNavigate?.(tabId) }}
      />
      {mention && (
        <MentionPanel
          name={mention.name}
          aliases={mention.aliases}
          onClose={() => setMention(null)}
          onNavigate={onNavigate ?? (() => {})}
          onNavigateReference={onNavigateReference}
        />
      )}
    </div>
  )
}
