/**
 * 人物小传子面板集合（3.7.1 · W2/W3）
 *
 * 从 CharacterBioPage 拆出：
 *   1. BioNodeForm         —— 新增 / 编辑单条重要节点
 *   2. StatePromotePanel   —— 从 3.7.0 状态演变零 AI 消耗提拔为小传节点
 *   3. BatchScanPanel      —— 从正文批量抽取重要节点候选并勾选追加
 *   4. ComposePreviewPanel —— AI 起草 / 续写小传正文预览条（不自动覆盖）
 */
import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Loader2, Sparkles, History, Search, UserRound, X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import CustomSelect from '@/components/common/CustomSelect'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'
import { Modal } from '@/components/dialogs/Modal'
import type { CardRecord } from '@/lib/types'
import { readAliases } from '@/lib/settings/aliases'
import type { CustomOptionPayload } from '@/lib/db'
import {
  BIO_NODE_TAGS, BIO_TAG_COL_NAME, bioNodeFromStateRecord, buildBioNode, isDuplicateBioNode,
  type BioEventNode, type BioNodePhase, type BioNodeTag,
} from '@/lib/settings/charBiography'
import type { StateRecord } from '@/lib/settings/stateTrack'
import type { ExtractedBioNode } from '@/lib/aiTasks/charBiographyAI'

export function BioNodeForm({
  initial,
  nextPrequelOrder,
  saving,
  defaultTag,
  tagOptionsPayload,
  onRenameTag,
  onCancel,
  onSubmit,
}: {
  initial?: BioEventNode | null
  nextPrequelOrder: number
  saving: boolean
  defaultTag?: string
  tagOptionsPayload?: CustomOptionPayload
  onRenameTag?: (oldName: string, newName: string) => void
  onCancel: () => void
  onSubmit: (node: BioEventNode) => Promise<void>
}) {
  const [phase, setPhase] = useState<BioNodePhase>(initial?.phase ?? 'story')
  const [chapterNo, setChapterNo] = useState(initial?.chapterNo ? String(initial.chapterNo) : '1')
  const [storyTime, setStoryTime] = useState(initial?.storyTime ?? '')
  const fallbackTag = defaultTag || (initial?.phase === 'prequel' ? '前传背景' : '成长突破')
  const [tag, setTag] = useState<BioNodeTag>(initial?.tag ?? fallbackTag)
  const [title, setTitle] = useState(initial?.title ?? '')
  const [summary, setSummary] = useState(initial?.summary ?? '')
  const [evidence, setEvidence] = useState(initial?.evidence ?? '')

  const handleSave = () => {
    if (!title.trim() || saving) return
    const no = phase === 'story' ? Math.max(1, Math.floor(Number(chapterNo) || 1)) : 0
    const node = buildBioNode({
      id: initial?.id,
      phase,
      chapterId: phase === 'story' ? initial?.chapterId : undefined,
      chapterNo: no,
      order: initial ? initial.order : nextPrequelOrder,
      storyTime,
      title,
      summary,
      tag,
      source: initial?.source ?? 'manual',
      evidence,
    })
    void onSubmit(node)
  }

  return (
    <div className="rounded-xl border border-amber/35 bg-ink-900/70 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-13 font-semibold text-amber">{initial ? '编辑重要节点' : '新增重要节点'}</span>
        <Button variant="bare" iconOnly size="xs" onClick={onCancel} aria-label="关闭节点表单">
          <X size={13} />
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <label className="text-11 text-ink-400 space-y-1">
          <span className="block">阶段</span>
          <select
            value={phase}
            onChange={e => setPhase(e.target.value as BioNodePhase)}
            className="w-full h-8 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-12 text-ink-100 outline-none focus:border-amber/50"
          >
            <option value="prequel">开篇前（前传）</option>
            <option value="story">正文阶段（按章）</option>
          </select>
        </label>
        {phase === 'story' ? (
          <label className="text-11 text-ink-400 space-y-1">
            <span className="block">章号</span>
            <input
              type="number"
              min={1}
              value={chapterNo}
              onChange={e => setChapterNo(e.target.value)}
              className="w-full h-8 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-12 text-ink-100 outline-none focus:border-amber/50"
            />
          </label>
        ) : (
          <label className="text-11 text-ink-400 space-y-1">
            <span className="block">前传时间（可选）</span>
            <input
              value={storyTime}
              onChange={e => setStoryTime(e.target.value)}
              placeholder="如：灵历3014年冬"
              className="w-full h-8 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-12 text-ink-100 outline-none focus:border-amber/50"
            />
          </label>
        )}
        <div className="text-11 text-ink-400 space-y-1">
          <span className="block">节点类型（可自定义增删改）</span>
          <div className="w-full h-8 rounded-lg border border-ink-700 bg-ink-950 px-1 flex items-center focus-within:border-amber/50">
            <CustomSelect
              tabId="char-bio"
              colName={BIO_TAG_COL_NAME}
              options={[...BIO_NODE_TAGS]}
              value={tag}
              onChange={v => setTag(v || defaultTag || (phase === 'prequel' ? '前传背景' : '其他'))}
              payload={tagOptionsPayload}
              onRenameBuiltin={onRenameTag}
            />
          </div>
        </div>
      </div>
      {phase === 'story' && (
        <label className="block text-11 text-ink-400 space-y-1">
          <span className="block">故事内时间（可选）</span>
          <input
            value={storyTime}
            onChange={e => setStoryTime(e.target.value)}
            placeholder="如：灵历3024年八月"
            className="w-full h-8 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-12 text-ink-100 outline-none focus:border-amber/50"
          />
        </label>
      )}
      <label className="block text-11 text-ink-400 space-y-1">
        <span className="block">节点标题</span>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="一句话概括关键事件（如：外门大比夺魁）"
          className="w-full h-8 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-12 text-ink-100 outline-none focus:border-amber/50"
        />
      </label>
      <label className="block text-11 text-ink-400 space-y-1">
        <span className="block">经过与影响</span>
        <textarea
          rows={3}
          value={summary}
          onChange={e => setSummary(e.target.value)}
          placeholder="记录前因后果、性格或立场转折…"
          className="w-full rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-2 text-12 text-ink-100 outline-none focus:border-amber/50 resize-y"
        />
      </label>
      <label className="block text-11 text-ink-400 space-y-1">
        <span className="block">正文依据（可选）</span>
        <input
          value={evidence}
          onChange={e => setEvidence(e.target.value)}
          placeholder="可附原文原句摘录"
          className="w-full h-8 rounded-lg border border-ink-700 bg-ink-950 px-2.5 text-12 text-ink-100 outline-none focus:border-amber/50"
        />
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>取消</Button>
        <Button variant="primary" solid size="sm" onClick={handleSave} disabled={!title.trim() || saving}>
          {saving ? '保存中…' : '保存节点'}
        </Button>
      </div>
    </div>
  )
}

export function StatePromotePanel({
  records,
  existingNodes,
  busy,
  onPromote,
  onClose,
}: {
  records: StateRecord[]
  existingNodes: readonly BioEventNode[]
  busy: boolean
  onPromote: (nodes: BioEventNode[]) => Promise<void>
  onClose: () => void
}) {
  const candidates = records.map((r, i) => {
    const node = bioNodeFromStateRecord(r, i)
    const dup = isDuplicateBioNode(existingNodes, node)
    return { record: r, node, dup }
  })
  const fresh = candidates.filter(c => !c.dup)

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/70 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-13 font-semibold text-ink-100">
          <History size={14} className="text-amber" />
          从「状态演变」引入（不消耗 AI）
        </div>
        <div className="flex items-center gap-2">
          {fresh.length > 0 && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void onPromote(fresh.map(x => x.node))}>
              全部引入（{fresh.length} 条）
            </Button>
          )}
          <Button variant="bare" iconOnly size="xs" onClick={onClose} aria-label="关闭状态演变抽屉">
            <X size={13} />
          </Button>
        </div>
      </div>
      {candidates.length === 0 ? (
        <div className="text-11 text-ink-500 py-2">该角色暂无状态演变记录。可在角色卡底部的「状态演变」或章后整理中产生。</div>
      ) : (
        <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
          {candidates.map(({ record, node, dup }) => (
            <div key={record.id} className="flex items-start justify-between gap-2 rounded-lg border border-ink-700/70 yfe-surface-1 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-11 text-ink-200">
                  <span className="text-amber">{record.chapterNo > 0 ? `第${record.chapterNo}章` : '未标章'}</span>
                  <span className="mx-1.5">·</span>
                  <span>{record.state}</span>
                </div>
                {record.previous && <div className="text-10 text-ink-500 mt-0.5">改前：{record.previous}</div>}
                {record.evidence && <div className="text-10 text-ink-500 mt-0.5">「{record.evidence}」</div>}
              </div>
              <Button
                variant="secondary"
                size="xs"
                disabled={busy || dup}
                onClick={() => void onPromote([node])}
              >
                {dup ? '已存在' : '引入'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export interface ScanCandidate {
  key: string
  node: ExtractedBioNode
  duplicate: boolean
}

export function BatchScanPanel({
  chapterCount,
  lastScannedNo,
  writingReady,
  blockedHint,
  scanning,
  candidates,
  picked,
  onTogglePick,
  onScan,
  onApply,
  onClose,
}: {
  chapterCount: number
  lastScannedNo: number
  writingReady: boolean
  blockedHint: string
  scanning: boolean
  candidates: ScanCandidate[] | null
  picked: Set<string>
  onTogglePick: (key: string) => void
  onScan: (fromNo: number, toNo: number) => void
  onApply: () => void
  onClose: () => void
}) {
  const defaultFrom = lastScannedNo > 0 && lastScannedNo < chapterCount ? lastScannedNo + 1 : 1
  const [fromNo, setFromNo] = useState(String(defaultFrom))
  const [toNo, setToNo] = useState(String(Math.max(defaultFrom, chapterCount)))

  const startScan = () => {
    const f = Math.max(1, Math.floor(Number(fromNo) || 1))
    const t = Math.max(f, Math.min(chapterCount, Math.floor(Number(toNo) || chapterCount)))
    onScan(f, t)
  }

  return (
    <div className="rounded-xl border border-amber/35 bg-ink-900/70 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-13 font-semibold text-amber">
          <Sparkles size={14} />
          AI 从正文整理重要节点
        </div>
        <Button variant="bare" iconOnly size="xs" onClick={onClose} aria-label="关闭批量整理面板">
          <X size={13} />
        </Button>
      </div>
      <AIDataSourceNote feature="char-bio" compact className="text-11" />
      <div className="flex flex-wrap items-center gap-2 text-12">
        <span className="text-ink-400">扫描章号范围：</span>
        <input
          type="number"
          min={1}
          max={Math.max(1, chapterCount)}
          value={fromNo}
          onChange={e => setFromNo(e.target.value)}
          className="w-16 h-8 rounded-lg border border-ink-700 bg-ink-950 px-2 text-12 text-ink-100"
        />
        <span className="text-ink-500">至</span>
        <input
          type="number"
          min={1}
          max={Math.max(1, chapterCount)}
          value={toNo}
          onChange={e => setToNo(e.target.value)}
          className="w-16 h-8 rounded-lg border border-ink-700 bg-ink-950 px-2 text-12 text-ink-100"
        />
        <span className="text-11 text-ink-500">（全书共 {chapterCount} 章{lastScannedNo > 0 ? ` · 上次扫至第 ${lastScannedNo} 章` : ''}）</span>
        <Button
          variant="primary"
          size="sm"
          disabled={!writingReady || scanning || chapterCount === 0}
          title={!writingReady ? blockedHint : chapterCount === 0 ? '项目暂无章节正文' : '抽取里程碑事件候选（只追加，不覆盖）'}
          onClick={startScan}
          className="ml-auto"
        >
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {scanning ? '抽取中…' : '开始抽取候选'}
        </Button>
      </div>

      {candidates && (
        candidates.length === 0 ? (
          <div className="text-11 text-ink-500 py-2">所选章节内未发现该角色的里程碑级转折事件。</div>
        ) : (
          <div className="space-y-2">
            <div className="max-h-60 overflow-y-auto space-y-1.5 pr-1">
              {candidates.map(c => (
                <label
                  key={c.key}
                  className={`flex items-start gap-2 rounded-lg border px-2.5 py-2 ${
                    c.duplicate ? 'border-ink-700/60 bg-ink-950/30 opacity-60' : 'border-ink-700 bg-ink-950/70 cursor-pointer'
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={c.duplicate}
                    checked={!c.duplicate && picked.has(c.key)}
                    onChange={() => onTogglePick(c.key)}
                    className="mt-1 accent-amber"
                  />
                  <div className="min-w-0 flex-1 text-11">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-amber font-medium">{c.node.chapterNo > 0 ? `第${c.node.chapterNo}章` : '未标章'}</span>
                      <span className="px-1.5 py-px rounded text-9 bg-ink-800 border border-ink-700 text-ink-300">{c.node.tag}</span>
                      <span className="text-ink-100 font-medium">{c.node.title}</span>
                      {c.duplicate && <span className="text-10 text-ink-500">（事件轴已有相似节点）</span>}
                    </div>
                    {c.node.summary && <div className="text-ink-300 mt-0.5 leading-relaxed">{c.node.summary}</div>}
                    <div className="text-10 text-ink-500 mt-0.5 border-l-2 border-ink-700 pl-1.5">「{c.node.evidence}」</div>
                  </div>
                </label>
              ))}
            </div>
            <div className="flex justify-end">
              <Button variant="primary" solid size="sm" disabled={picked.size === 0} onClick={onApply}>
                <Check size={13} /> 追加选中的 {picked.size} 条到事件轴
              </Button>
            </div>
          </div>
        )
      )}
    </div>
  )
}

export function ComposePreviewPanel({
  mode,
  text,
  hasExisting,
  onAppend,
  onReplace,
  onDiscard,
}: {
  mode: 'draft' | 'continue'
  text: string
  hasExisting: boolean
  onAppend: () => void
  onReplace: () => void
  onDiscard: () => void
}) {
  return (
    <div className="rounded-xl border border-amber/40 bg-amber/5 p-4 space-y-2.5">
      <div className="flex items-center justify-between">
        <span className="text-13 font-semibold text-amber">
          AI {mode === 'continue' ? '续写建议' : '小传初稿'}预览（未写入，由你决定采纳方式）
        </span>
        <Button variant="bare" iconOnly size="xs" onClick={onDiscard} aria-label="放弃预览">
          <X size={13} />
        </Button>
      </div>
      <div className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-lg border border-ink-700 yfe-surface-1 p-3 text-12 text-ink-200 leading-relaxed">
        {text}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onDiscard}>放弃</Button>
        {hasExisting && (
          <Button variant="secondary" size="sm" onClick={onAppend}>追加到现有正文末尾</Button>
        )}
        <Button variant="primary" solid size="sm" onClick={onReplace}>
          {hasExisting ? '替换当前正文' : '采用为正文'}
        </Button>
      </div>
    </div>
  )
}

const PICKER_GROUPS: { tabId: 'char-main' | 'char-secondary' | 'char-npc'; label: string }[] = [
  { tabId: 'char-main', label: '主要角色' },
  { tabId: 'char-secondary', label: '次要角色' },
  { tabId: 'char-npc', label: 'NPC 角色' },
]

export function AddBioCharacterModal({
  open,
  cards,
  existingBioIds,
  adding,
  onClose,
  onPick,
  onNavigateTab,
}: {
  open: boolean
  cards: CardRecord[]
  existingBioIds: Set<string>
  adding: boolean
  onClose: () => void
  onPick: (card: CardRecord) => Promise<void>
  onNavigateTab?: (tabId: 'char-main' | 'char-secondary' | 'char-npc') => void
}) {
  const [query, setQuery] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  // 只展示尚未建立小传的角色卡（已有小传的角色直接在左侧列表切换）
  const availableCards = useMemo(
    () => cards.filter(c => !existingBioIds.has(c.id)),
    [cards, existingBioIds],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return availableCards
    return availableCards.filter(c => {
      if (c.name.toLowerCase().includes(q)) return true
      return readAliases(c.tabId, c.data).some(a => a.toLowerCase().includes(q))
    })
  }, [availableCards, query])

  const toggleGroup = (tabId: string) => {
    setCollapsedGroups(prev => ({ ...prev, [tabId]: !prev[tabId] }))
  }

  return (
    <Modal open={open} onClose={onClose} title="选择角色并建立小传" width="lg">
      <div className="space-y-3.5">
        <p className="text-12 text-ink-400">
          从「主要角色」「次要角色」「NPC 角色」中挑选尚未建立小传的已有角色；可按分组折叠/展开或输入关键词快速检索。
        </p>

        {availableCards.length > 0 && (
          <div className="relative">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="按姓名或别称搜索未建小传的角色…"
              className="w-full h-9 rounded-lg border border-ink-700 bg-ink-950 !pl-8 pr-3 text-12 text-ink-100 outline-none focus:border-amber/50"
            />
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500 pointer-events-none" />
          </div>
        )}

        {cards.length === 0 ? (
          <div className="rounded-xl border border-dashed border-ink-700 py-8 px-4 text-center space-y-2.5">
            <p className="text-13 text-ink-300">项目内还没有任何角色卡片</p>
            <p className="text-11 text-ink-500">请先前往「主要角色」「次要角色」或「NPC 角色」建好角色，再来编写角色小传。</p>
            {onNavigateTab && (
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                {PICKER_GROUPS.map(g => (
                  <Button key={g.tabId} variant="secondary" size="sm" onClick={() => onNavigateTab(g.tabId)}>
                    前往{g.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
        ) : availableCards.length === 0 ? (
          <div className="rounded-xl border border-dashed border-ink-700 py-8 px-4 text-center space-y-2">
            <p className="text-13 text-ink-300">全部已有角色都已建立角色小传</p>
            <p className="text-11 text-ink-500">如需为新角色编写小传，请先到「主要角色 / 次要角色 / NPC 角色」页签建档。</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-dashed border-ink-700 py-8 text-center text-12 text-ink-500">
            未匹配到「{query.trim()}」的未建小传角色，可先在角色管理页签新建或确认其是否已建过小传。
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto pr-1 space-y-2.5">
            {PICKER_GROUPS.map(group => {
              const list = filtered.filter(c => c.tabId === group.tabId)
              if (list.length === 0) return null
              const isCollapsed = !query.trim() && !!collapsedGroups[group.tabId]
              return (
                <div key={group.tabId} className="space-y-1.5">
                  <Button
                    variant="bare"
                    size="sm"
                    onClick={() => toggleGroup(group.tabId)}
                    aria-expanded={!isCollapsed}
                    className="w-full !justify-between px-2.5 py-1.5 text-12 font-medium text-ink-300 bg-ink-900/70 hover:bg-ink-800 border border-ink-700/60"
                  >
                    <span>{group.label}（{list.length}）</span>
                    <span className="inline-flex items-center gap-1 text-11 text-ink-500">
                      {isCollapsed ? '展开' : '收起'}
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </span>
                  </Button>
                  {!isCollapsed && (
                    <div className="space-y-1.5">
                      {list.map(c => {
                        const aliases = readAliases(c.tabId, c.data)
                        return (
                          <div
                            key={c.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-ink-700 yfe-surface-3 px-3 py-2 hover:border-ink-500 transition-colors"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <UserRound size={13} className="text-ink-400 shrink-0" />
                                <span className="text-13 font-medium text-ink-100 truncate">{c.name}</span>
                                {aliases.length > 0 && (
                                  <span className="text-11 text-ink-500 truncate">（{aliases.join('、')}）</span>
                                )}
                              </div>
                            </div>
                            <Button variant="primary" size="sm" disabled={adding} onClick={() => void onPick(c)}>
                              选择添加
                            </Button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1 border-t border-ink-700/60">
          <div className="flex flex-wrap items-center gap-1.5">
            {onNavigateTab && PICKER_GROUPS.map(g => (
              <Button key={g.tabId} variant="secondary" size="sm" onClick={() => onNavigateTab(g.tabId)}>
                去{g.label}建卡
              </Button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={adding}>关闭</Button>
        </div>
      </div>
    </Modal>
  )
}
