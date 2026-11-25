/**
 * 人物小传页签（3.7.1 · W2/W3）
 *
 * 角色管理组独立页签：聚焦主要角色与次要角色，提供「人物生平小传正文 + 重要节点事件轴」双层结构。
 * 支持手动编辑、从 3.7.0 状态演变零消耗引入、角色卡双向跳转、Markdown 导出，以及 API / MCP / ACP 三模式 AI 整理。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowUp, BookOpen, Download, ExternalLink, History,
  Loader2, Pencil, Plus, Save, ScrollText, Sparkles, Trash2, Undo2, UserRound,
} from 'lucide-react'
import * as db from '@/lib/db'
import { TABS } from '@/lib/schema'
import type { CardRecord, Chapter, Volume } from '@/lib/types'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import { captureOwnedOperation } from '@/lib/storage/ownedOperation'
import { downloadText } from '@/lib/storage/zip'
import { readAliases } from '@/lib/settings/aliases'
import { evolutionOf, readStateRecords, type StateRecord } from '@/lib/settings/stateTrack'
import {
  appendBioNodes, BIO_NODE_TAGS, deleteBioNode, emptyBiography,
  formatBiographyMarkdown, isDuplicateBioNode, readAllBiographies,
  reorderCharacterPrequelNode, saveBiographyProse, sortBioNodes, upsertBioNode,
  type BioEventNode, type BioNodeSource, type CharacterBiography,
} from '@/lib/settings/charBiography'
import { aiComposeBiography, aiExtractBioNodes } from '@/lib/aiTasks/charBiographyAI'
import { useWritingReady } from '@/lib/agentHost/useWritingReady'
import { acpStructuredText } from '@/lib/agentHost/acpStructured'
import { useSaveHotkey } from '@/lib/app/useSaveHotkey'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import PageHeader, { pageSummary } from '@/components/common/PageHeader'
import { MasterDetail, MasterList } from '@/components/common/MasterDetail'
import { LoadingState } from '@/components/common/LoadingState'
import AutoTextarea from '@/components/common/AutoTextarea'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import {
  BatchScanPanel, BioNodeForm, ComposePreviewPanel, StatePromotePanel, type ScanCandidate,
} from '@/components/world/CharacterBioPanels'

interface Props {
  focusRowId?: string | null
  onFocusConsumed?: () => void
  onNavigate?: (id: string, chapterId?: string, rowId?: string) => void
}

const SOURCE_LABEL: Record<BioNodeSource, string> = {
  manual: '手写',
  'post-process': '章后整理',
  'batch-scan': '正文整理',
  'state-promote': '状态演变引入',
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

export default function CharacterBioPage({ focusRowId, onFocusConsumed, onNavigate }: Props) {
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
    const [mainList, secList, bioMap, stList, vols, chs] = await Promise.all([
      db.getCardRecords('char-main').catch(() => [] as CardRecord[]),
      db.getCardRecords('char-secondary').catch(() => [] as CardRecord[]),
      readAllBiographies(),
      readStateRecords(),
      db.getAllVolumes().catch(() => [] as Volume[]),
      db.getAllChapters().catch(() => [] as Chapter[]),
    ])
    const allCards = [...mainList, ...secList]
    const seq = chapterSeqMap(vols, chs)
    const orderedChs = chs
      .map(ch => ({ chapter: ch, chapterNo: seq.get(ch.id) ?? 0 }))
      .filter(x => x.chapterNo > 0)
      .sort((a, b) => a.chapterNo - b.chapterNo)
    setCards(allCards)
    setBios(bioMap)
    setStateRecords(stList)
    setChapters(orderedChs)
    setLoaded(true)
    setActiveId(prev => {
      if (focusRowId && allCards.some(c => c.id === focusRowId)) return focusRowId
      if (prev && allCards.some(c => c.id === prev)) return prev
      return allCards[0]?.id ?? null
    })
  }, [focusRowId])

  useEffect(() => { void loadAll() }, [loadAll])

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
      showToast('已保存人物小传正文', 'success')
    } finally {
      setSavingProse(false)
    }
  }, [selectedCard, savingProse, proseDirty, proseDraft])

  useSaveHotkey(handleSaveProse)

  const filteredCards = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return cards
    return cards.filter(c => {
      if (c.name.toLowerCase().includes(q)) return true
      const aliases = readAliases(c.tabId, c.data)
      return aliases.some(a => a.toLowerCase().includes(q))
    })
  }, [cards, query])

  const mainCards = useMemo(() => filteredCards.filter(c => c.tabId === 'char-main'), [filteredCards])
  const secCards = useMemo(() => filteredCards.filter(c => c.tabId === 'char-secondary'), [filteredCards])

  const charStates = useMemo(() => {
    if (!selectedCard) return []
    const pid = selectedCard.projectId || db.getCurrentProjectId() || ''
    return evolutionOf(stateRecords, { kind: 'card', tabId: selectedCard.tabId, id: selectedCard.id, projectId: pid })
  }, [selectedCard, stateRecords])

  const sortedNodes = useMemo(() => sortBioNodes(selectedBio?.nodes ?? []), [selectedBio])
  const visibleNodes = useMemo(
    () => (tagFilter === '全部' ? sortedNodes : sortedNodes.filter(n => n.tag === tagFilter)),
    [sortedNodes, tagFilter],
  )
  const prequelNodes = useMemo(() => visibleNodes.filter(n => n.phase === 'prequel'), [visibleNodes])
  const storyNodes = useMemo(() => visibleNodes.filter(n => n.phase === 'story'), [visibleNodes])
  const allPrequelCount = useMemo(() => sortedNodes.filter(n => n.phase === 'prequel').length, [sortedNodes])

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
          tierLabel: selectedCard.tabId === 'char-main' ? '主要角色' : '次要角色',
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
    const tier = selectedCard.tabId === 'char-main' ? '主要角色' : '次要角色'
    const md = formatBiographyMarkdown(selectedCard.name, tier, { ...selectedBio, prose: proseDraft })
    downloadText(`${selectedCard.name}-人物小传.md`, md, 'text/markdown;charset=utf-8')
    showToast('已导出 Markdown 人物小传', 'success')
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
            <button
              key={c.id}
              type="button"
              onClick={() => void switchCharacter(c.id)}
              className={`w-full text-left rounded-lg border px-3 py-2 transition-all duration-150 ${
                isActive
                  ? 'bg-amber/15 border-amber/30 text-amber'
                  : 'bg-ink-850 border-ink-700 text-ink-300 hover:border-ink-500'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <UserRound size={12} className="shrink-0" />
                <span className="text-13 font-medium truncate flex-1">{c.name}</span>
                {isActive && proseDirty && <span className="w-1.5 h-1.5 rounded-full bg-amber shrink-0" />}
              </div>
              <div className="text-10 text-ink-500 mt-0.5 truncate">
                {nodeCount} 个节点 · {hasProse ? '已有正文' : '待写正文'}
              </div>
            </button>
          )
        })}
      </div>
    )
  }

  const renderNodeCard = (node: BioEventNode, idx: number, totalInGroup: number) => (
    <div key={node.id} className="rounded-lg border border-ink-700 bg-ink-900/50 p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <span className="px-1.5 py-px rounded text-10 font-medium bg-amber/15 text-amber border border-amber/25">
            {node.phase === 'prequel' ? '开篇前' : `第 ${node.chapterNo} 章`}
          </span>
          <span className="px-1.5 py-px rounded text-10 bg-ink-800 border border-ink-700 text-ink-300">{node.tag}</span>
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

  if (!loaded) return <div className="p-6 max-w-6xl mx-auto"><LoadingState /></div>

  return (
    <div className="p-6 max-w-6xl mx-auto h-full flex flex-col min-h-0">
      <PageHeader
        title="人物小传"
        description={pageSummary(tabMeta?.description, '主要与次要角色的生平小传与重要节点事件轴')}
        help={(
          <HelpPopover title="人物小传怎么用">
            <div className="space-y-1.5">
              <p>· 分上下两层：上层写人物生平小传长文，下层按「开篇前 → 正文章号」记重要里程碑节点。</p>
              <p>· 前传节点可手动上下调序；正文节点按章号升序，并可直接点「原文」回正文。</p>
              <p>· 可从 3.7.0「状态演变」零消耗引入节点，也可在「颉文姬 · 整理」里自动抽出里程碑候选。</p>
              <AIDataSourceNote feature="char-bio" />
            </div>
          </HelpPopover>
        )}
        actions={selectedCard && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="toggle"
              selected={proseDirty}
              disabled={!proseDirty || savingProse}
              onClick={() => void handleSaveProse()}
              title={proseDirty ? '保存小传正文（Ctrl+S）' : '小传正文已保存'}
            >
              <Save size={12} /> {savingProse ? '保存中…' : proseDirty ? '保存正文' : '已保存'}
            </Button>
            <Button variant="secondary" size="md" onClick={handleExportMd}>
              <Download size={12} /> 导出 Markdown
            </Button>
          </div>
        )}
      />

      {cards.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-ink-700 rounded-xl text-ink-500 gap-2 p-8">
          <ScrollText size={26} className="text-ink-600" />
          <p className="text-13 text-ink-300">还没有主要或次要角色卡</p>
          <p className="text-11 text-ink-500">先在「主要角色」或「次要角色」里建立角色，这里会自动列出。</p>
          <Button variant="secondary" size="sm" onClick={() => onNavigate?.('char-main')}>前往主要角色</Button>
        </div>
      ) : (
        <MasterDetail>
          <MasterList
            widthClass="w-48 lg:w-56"
            query={query}
            onQueryChange={setQuery}
            placeholder="搜角色名或别称…"
            isEmpty={filteredCards.length === 0}
            emptyHint="没有匹配的角色"
          >
            <div className="space-y-3">
              {renderGroupList('主要角色', mainCards)}
              {renderGroupList('次要角色', secCards)}
            </div>
          </MasterList>

          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
            {selectedCard && selectedBio && (
              <>
                {/* 角色头条 */}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-ink-700 bg-ink-850 px-4 py-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <h2 className="text-15 font-semibold text-ink-50 truncate">{selectedCard.name}</h2>
                    <span className="px-2 py-0.5 rounded-full text-10 bg-amber/15 text-amber border border-amber/30">
                      {selectedCard.tabId === 'char-main' ? '主要角色' : '次要角色'}
                    </span>
                    <span className="text-11 text-ink-500">{sortedNodes.length} 个重要节点</span>
                  </div>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => onNavigate?.(selectedCard.tabId, undefined, selectedCard.id)}
                  >
                    <ExternalLink size={11} /> 回到角色卡
                  </Button>
                </div>

                {/* 上层：人物生平小传正文 */}
                <section className="rounded-xl border border-ink-700 bg-ink-850 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-13 font-semibold text-ink-100">一、人物生平小传正文</h3>
                      <p className="text-11 text-ink-500 mt-0.5">自由分段记录完整生平；AI 起草或续写仅提供预览，不会覆盖已有手写内容。</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {proseDirty && (
                        <Button variant="secondary" size="xs" onClick={() => setProseDraft(selectedBio.prose)}>
                          <Undo2 size={11} /> 撤销
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={!writingReady || composing}
                        title={!writingReady ? blockedHint : '根据角色卡、重要节点与状态演变生成小传'}
                        onClick={() => void handleCompose(proseDraft.trim() ? 'continue' : 'draft')}
                      >
                        {composing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
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
                <section className="rounded-xl border border-ink-700 bg-ink-850 p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-13 font-semibold text-ink-100">二、重要节点事件轴</h3>
                      <p className="text-11 text-ink-500 mt-0.5">开篇前按手动顺序排列，正文阶段按章号升序自动对齐。</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button variant="secondary" size="xs" onClick={() => setPromoteOpen(v => !v)}>
                        <History size={11} /> 从状态演变引入（{charStates.length}）
                      </Button>
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => setScanOpen(v => !v)}
                        title="按章节范围抽取该角色的里程碑节点候选"
                      >
                        <Sparkles size={11} /> AI 从正文整理节点
                      </Button>
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={() => { setEditingNode(null); setFormOpen(true) }}
                      >
                        <Plus size={11} /> 新增节点
                      </Button>
                    </div>
                  </div>

                  {/* 标签筛选 */}
                  <div className="flex flex-wrap items-center gap-1">
                    {['全部', ...BIO_NODE_TAGS].map(tag => (
                      <Button
                        key={tag}
                        variant="toggle"
                        size="xs"
                        selected={tagFilter === tag}
                        onClick={() => setTagFilter(tag)}
                      >
                        {tag}
                      </Button>
                    ))}
                  </div>

                  {formOpen && (
                    <BioNodeForm
                      initial={editingNode}
                      nextPrequelOrder={allPrequelCount}
                      saving={nodeSaving}
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
    </div>
  )
}
