import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as RPointerEvent } from 'react'
import { Loader2, Eraser, Sparkles, GitBranch, Check, X, Move } from 'lucide-react'
import * as db from '../lib/db'
import type { TableRow, TabDef } from '../lib/types'
import { aiBriefing } from '../lib/aiTasks'
import { buildProjectContext } from '../lib/aiContext'
import { useAIReady } from '../lib/useAIReady'
import { showToast } from './dialogs'
import HelpPopover from './HelpPopover'
import { Button } from './Button'


type CardType = 'foreshadow' | 'hook' | 'character' | 'next'
interface CardItem { id: string; chapter: string; type: CardType; text: string; x: number; y: number }
type Conn = [string, string]
interface PlotPersist { selected: string[]; cards: CardItem[]; conns: Conn[] }

const TYPE_META: Record<CardType, { label: string; color: string }> = {
  foreshadow: { label: '待办伏笔', color: '#f0a4a4' },
  hook: { label: '钩子爽点', color: '#e8b36a' },
  character: { label: '角色状态', color: '#8fd0c4' },
  next: { label: '下一章衔接', color: '#8fb4e8' },
}
const HEADER_TO_TYPE: Record<string, CardType> = {
  '待办伏笔': 'foreshadow', '钩子与爽点': 'hook', '角色状态提醒': 'character', '下一章衔接': 'next',
}

const CARD_W = 260
/** 卡片外接框留白：右/下侧预留一屏内的余量，卡片超出可视区时画布才扩展并出现滚动条 */
const PAD_X = CARD_W / 2 + 60
const PAD_Y = 160
/** 画布可扩展上限（防止误拖出天文数字尺寸） */
const MAX_W = 8000
const MAX_H = 6000

function parseBriefing(report: string, chapter: string): Omit<CardItem, 'id' | 'x' | 'y'>[] {
  const cards: Omit<CardItem, 'id' | 'x' | 'y'>[] = []
  const blocks = report.split(/^##\s+/m).slice(1)
  for (const block of blocks) {
    const nl = block.indexOf('\n')
    const header = (nl >= 0 ? block.slice(0, nl) : block).trim()
    const type = HEADER_TO_TYPE[header]
    if (!type) continue
    const body = nl >= 0 ? block.slice(nl + 1) : ''
    const lines = body.split('\n').map(l => l.replace(/^[-·*]\s*/, '').trim()).filter(Boolean)
    for (const line of lines) {
      if (line.length < 2) continue
      cards.push({ chapter, type, text: line })
    }
  }
  return cards
}

export default function PlotCanvas({ tab }: { tab: TabDef }) {
  const ai = useAIReady()
  const [chapters, setChapters] = useState<TableRow[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [cards, setCards] = useState<CardItem[]>([])
  const [conns, setConns] = useState<Conn[]>([])
  const [connectMode, setConnectMode] = useState(false)
  const [pendingConn, setPendingConn] = useState<string | null>(null)
  const [generating, setGenerating] = useState<{ i: number; total: number } | null>(null)
  /** 推演信息密度：完整=章节全要素（准/慢/费 token）；简略=只喂「章节压缩摘要」（约原文 1/10，快/省 token） */
  const [briefMode, setBriefMode] = useState(false)
  /** 滚动容器可视尺寸（画布默认就这么大，不再固定硬撑滚动条） */
  const [vp, setVp] = useState({ w: 1200, h: 800 })
  const [panning, setPanning] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<
    | { kind: 'card'; id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean }
    | { kind: 'pan'; startX: number; startY: number; origLeft: number; origTop: number }
    | null
  >(null)
  const loadedRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  // 载入章节 + 从项目库恢复推演快照（切页 / 重启后内容不丢）
  useEffect(() => {
    let alive = true
    void db.getAllChapterLedgerRows().then(setChapters)
    db.getSetting<PlotPersist>('plotCanvas', { selected: [], cards: [], conns: [] }).then(p => {
      if (!alive) return
      if (p.selected) setSelected(new Set(p.selected))
      if (p.cards) setCards(p.cards)
      if (p.conns) setConns(p.conns)
      loadedRef.current = true
    })
    return () => { alive = false }
  }, [])

  // 任何改动后（载入完成后）自动落库，形成持久化的推演快照
  useEffect(() => {
    if (!loadedRef.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void db.setSetting('plotCanvas', { selected: [...selected], cards, conns })
    }, 300)
    return () => clearTimeout(saveTimer.current)
  }, [selected, cards, conns])

  // 可视尺寸实测（容器变化时跟随）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth; const h = el.clientHeight
      if (w > 0 && h > 0) {
        setVp(prev => (Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h }))
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 画布尺寸 = 可视尺寸，卡片超出时按外接框扩展（此时才出现滚动条） */
  const canvas = useMemo(() => {
    let needW = 0; let needH = 0
    for (const c of cards) {
      needW = Math.max(needW, c.x + PAD_X)
      needH = Math.max(needH, c.y + PAD_Y)
    }
    return {
      w: Math.min(MAX_W, Math.max(vp.w, Math.ceil(needW))),
      h: Math.min(MAX_H, Math.max(vp.h, Math.ceil(needH))),
    }
  }, [cards, vp])

  const toggleChapter = (id: string) =>
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const generate = async () => {
    if (!ai.ready || generating) return
    const chosen = chapters.filter(c => selected.has(c.id))
    if (chosen.length === 0) { showToast('请先在左侧选择至少一个章节', 'info'); return }
    showToast('AI 推演本生成需要 30–90 秒，请耐心等待（并非卡死）', 'info')
    setGenerating({ i: 0, total: chosen.length })
    const projCtx = (await buildProjectContext({ budget: 6000 })).text
    const newCards: CardItem[] = []
    // 续接在已有卡片右侧，避免与旧推演重叠；首列从可见区内起排，避免最左一列被裁切
    const baseX = cards.length ? Math.max(...cards.map(c => c.x)) + 360 : CARD_W / 2 + 40
    for (let i = 0; i < chosen.length; i++) {
      const ch = chosen[i]
      setGenerating({ i: i + 1, total: chosen.length })
      const title = `章节：${ch.data['章节号'] || ''} ${ch.data['章节标题'] || ''}`
      // 简略模式：只喂「章节压缩摘要」（约原文 1/10；无摘要则回退完整要素并提示）；完整模式：章节全要素
      let ctx: string
      if (briefMode) {
        const s = (ch.data['一句话事件'] || '').trim()
        if (!s) {
          showToast(`第 ${i + 1} 章「${ch.data['章节标题'] || ''}」未填章节压缩摘要，已用完整要素推演`, 'info')
          ctx = [
            title,
            `出场人物：${ch.data['出场人物'] || ''}`,
            `埋设伏笔：${ch.data['埋设伏笔编号'] || ''}`,
            `回收伏笔：${ch.data['回收伏笔编号'] || ''}`,
          ].filter(Boolean).join('\n')
        } else {
          ctx = [title, `事件：${s}`].join('\n')
        }
      } else {
        ctx = [
          title,
          ch.data['一句话事件'] ? `事件：${ch.data['一句话事件']}` : '',
          ch.data['出场人物'] ? `出场人物：${ch.data['出场人物']}` : '',
          ch.data['埋设伏笔编号'] ? `埋设伏笔：${ch.data['埋设伏笔编号']}` : '',
          ch.data['回收伏笔编号'] ? `回收伏笔：${ch.data['回收伏笔编号']}` : '',
        ].filter(Boolean).join('\n')
      }
      try {
        const res = await aiBriefing(projCtx, ctx)
        const parsed = parseBriefing(res.report, ch.data['章节标题'] || ch.data['章节号'] || `第${i + 1}章`)
        // 自动布局：每章一列，卡片纵向堆叠
        const colX = baseX + i * 360
        parsed.forEach((c, j) => {
          newCards.push({ ...c, id: `c${Date.now()}_${i}_${j}`, x: colX, y: 110 + j * 130 })
        })
      } catch (e) {
        showToast(`第 ${i + 1} 章推演失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      }
    }
    setCards(prev => [...prev, ...newCards])
    setGenerating(null)
    showToast(`已为 ${chosen.length} 章生成推演卡片`, 'success')
  }

  const clearCanvas = () => {
    setCards([]); setConns([]); setPendingConn(null); setConnectMode(false)
    const el = scrollRef.current
    if (el) { el.scrollLeft = 0; el.scrollTop = 0 }
  }

  const removeCard = (id: string) => {
    setCards(prev => prev.filter(c => c.id !== id))
    setConns(prev => prev.filter(([a, b]) => a !== id && b !== id))
    setPendingConn(p => (p === id ? null : p))
  }

  const removeConn = (idx: number) => setConns(prev => prev.filter((_, i) => i !== idx))

  // ---------- 卡片拖拽 ----------
  const onCardDown = (e: RPointerEvent<HTMLDivElement>, id: string) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    if (connectMode) {
      e.stopPropagation()
      if (!pendingConn) { setPendingConn(id); return }
      if (pendingConn !== id) {
        setConns(prev => prev.some(([a, b]) => (a === pendingConn && b === id) || (a === id && b === pendingConn)) ? prev : [...prev, [pendingConn, id]])
      }
      setPendingConn(null)
      return
    }
    const card = cards.find(c => c.id === id)
    if (!card) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = { kind: 'card', id, startX: e.clientX, startY: e.clientY, origX: card.x, origY: card.y, moved: false }
  }

  // ---------- 空白处左键拖动 = 平移画布 ----------
  const onBgDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const el = scrollRef.current
    if (!el) return
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    dragRef.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, origLeft: el.scrollLeft, origTop: el.scrollTop }
    setPanning(true)
  }

  const onCanvasMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.startX; const dy = e.clientY - d.startY
    if (d.kind === 'pan') {
      const el = scrollRef.current
      if (!el) return
      el.scrollLeft = d.origLeft - dx
      el.scrollTop = d.origTop - dy
      return
    }
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true
    if (!d.moved) return
    setCards(prev => prev.map(c => c.id === d.id
      ? { ...c, x: Math.max(CARD_W / 2 + 8, Math.min(MAX_W - 40, d.origX + dx)), y: Math.max(40, Math.min(MAX_H - 40, d.origY + dy)) }
      : c))
  }
  const onCanvasUp = useCallback(() => { dragRef.current = null; setPanning(false) }, [])

  const cardCenter = (id: string) => {
    const c = cards.find(x => x.id === id)
    return c ? { x: c.x, y: c.y } : { x: 0, y: 0 }
  }

  const scrollable = canvas.w > vp.w + 1 || canvas.h > vp.h + 1

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 顶部通栏标题条（与左侧「选择章节」窗口左缘对齐） */}
      <div className="px-4 py-2.5 border-b border-ink-700 flex items-center gap-3 flex-wrap shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch size={15} className="text-amber shrink-0" />
          <span className="font-semibold text-ink-100">{tab.name}</span>
          <span className="text-[11px] text-ink-500">{cards.length} 张卡片 · {conns.length} 条推演链</span>
          <HelpPopover
            title="情节推演"
            width="20rem"
            className="ml-1"
          >
            {'把灵感简报升级成可拖拽、可连线的结构化推演画布\n\n'
              + '· 左侧勾选章节 → 点「生成推演」，复用颉文姬灵感简报同一 AI 管线，每章生成一列卡片（待办伏笔 / 钩子爽点 / 角色状态 / 下一章衔接）。\n'
              + '· 拖动卡片自由排布；按住空白处左键拖动可平移画布，卡片多到超出一屏时画布自动扩展并出现滚动条。\n'
              + '· 连接模式：依次点两张卡即可连成一条推演链；鼠标移到连线上点「×」可取消该连线。\n'
              + '· 推演内容会自动保存为项目快照（切换页面 / 重启都不丢失）。「清空推演本」可一键复位。'}
          </HelpPopover>
        </div>
        <div className="flex items-center gap-1.5 ml-auto flex-wrap">
          {Object.entries(TYPE_META).map(([k, m]) => (
            <span key={k} className="flex items-center gap-1 text-[10px] text-ink-400"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: m.color }} />{m.label}</span>
          ))}
          <span className="flex items-center gap-1 text-[10px] text-ink-500 border border-ink-700 rounded-md px-1.5 py-1" title="按住鼠标左键拖动空白处即可平移画布">
            <Move size={10} /> 左键拖动平移
          </span>
          <Button variant="bare"
            onClick={() => { setConnectMode(v => !v); setPendingConn(null) }}
            className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] transition-colors ${connectMode ? 'border-amber/40 text-amber bg-amber/10' : 'border-ink-700 text-ink-400 hover:text-ink-200'}`}
            title="连接模式：依次点两张卡连成推演链；鼠标移到连线上点 × 取消"
          >
            <GitBranch size={11} /> {connectMode ? '连接中…' : '连接模式'}
          </Button>
        </div>
      </div>

      {/* 主体：左章节选择 + 右推演画布（两列等高） */}
      <div className="flex-1 flex min-h-0">
        {/* 左侧：章节选择 */}
        <div className="w-64 shrink-0 border-r border-ink-700 bg-ink-850/60 flex flex-col h-full min-h-0">
          <div className="px-3 py-2.5 border-b border-ink-700">
            <div className="flex items-center gap-2 text-ink-100 font-medium"><GitBranch size={14} className="text-amber" /> 选择章节</div>
            <div className="text-[10px] text-ink-500 mt-0.5">多选后点「生成推演」，复用颉文姬灵感简报同一 AI 管线</div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {chapters.length === 0 && <div className="text-[11px] text-ink-500 px-1 py-2">暂无《章节总表》数据。</div>}
            {chapters.map(ch => {
              const id = ch.id; const on = selected.has(id)
              return (
                <Button variant="bare"
                  key={id}
                  onClick={() => toggleChapter(id)}
                  className={`w-full text-left px-2 py-1.5 rounded-md border text-[12px] flex items-center gap-2 transition-colors ${on ? 'bg-amber/10 border-amber/30 text-amber' : 'border-ink-700 text-ink-300 hover:text-ink-100 hover:bg-ink-800'}`}
                >
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${on ? 'bg-amber border-amber text-ink-900' : 'border-ink-600'}`}>{on && <Check size={10} />}</span>
                  <span className="truncate"><span className="text-ink-500">{ch.data['章节号'] || ''} </span>{ch.data['章节标题'] || '（未命名）'}</span>
                </Button>
              )
            })}
          </div>
          <div className="p-2 border-t border-ink-700 space-y-1.5">
            {/* 信息密度：完整（章节全要素）/ 简略（压缩摘要） */}
            <div className="flex items-center justify-between gap-1.5 text-[10px] text-ink-500 px-0.5">
              <span>推演信息</span>
              <div className="flex rounded-md overflow-hidden border border-ink-700">
                <Button variant="bare" onClick={() => setBriefMode(false)} className={`px-2 py-0.5 transition-colors ${!briefMode ? 'bg-amber/20 text-amber' : 'text-ink-400 hover:text-ink-200'}`} title="喂入章节全要素：推演更准，但耗时长、费 token">完整</Button>
                <Button variant="bare" onClick={() => setBriefMode(true)} className={`px-2 py-0.5 transition-colors ${briefMode ? 'bg-amber/20 text-amber' : 'text-ink-400 hover:text-ink-200'}`} title="只喂「章节压缩摘要」（约原文 1/10）：速度快、省 token，适合快速过方向">简略</Button>
              </div>
            </div>
            <Button variant="bare"
              disabled={!ai.ready || generating != null}
              onClick={() => void generate()}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] border bg-amber/15 border-amber/30 text-amber hover:bg-amber/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {generating ? <><Loader2 size={12} className="animate-spin" /> 生成中 {generating.i}/{generating.total}</> : <><Sparkles size={12} /> 生成推演</>}
            </Button>
            <Button onClick={clearCanvas} variant="secondary" size="md" className="w-full flex items-center justify-center text-[11px]"><Eraser size={11} /> 清空推演本</Button>
            {!ai.ready && <div className="text-[10px] text-ink-500 text-center">未配置 AI 模型，生成按钮已禁用</div>}
          </div>
        </div>

        {/* 右侧：推演本画布 */}
        <div className="flex-1 min-w-0 h-full min-h-0">
          <div
            ref={scrollRef}
            className={`h-full bg-ink-900 relative ${scrollable ? 'overflow-auto' : 'overflow-hidden'}`}
          >
            <div
              className="relative"
              style={{
                width: canvas.w, height: canvas.h,
                backgroundImage: 'radial-gradient(circle, rgba(120,113,108,0.18) 1px, transparent 1px)',
                backgroundSize: '26px 26px',
                cursor: panning ? 'grabbing' : 'grab',
              }}
              onPointerDown={onBgDown}
              onPointerMove={onCanvasMove}
              onPointerUp={onCanvasUp}
              onPointerCancel={onCanvasUp}
            >
              {/* 连线层 */}
              <svg className="absolute inset-0 pointer-events-none" width={canvas.w} height={canvas.h}>
                <defs>
                  <marker id="pc-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
                    <path d="M0,0 L8,3 L0,6 Z" fill="#a89b8c" />
                  </marker>
                </defs>
                {conns.map(([a, b], i) => {
                  const pa = cardCenter(a); const pb = cardCenter(b)
                  const mx = (pa.x + pb.x) / 2
                  return <path key={i} d={`M ${pa.x} ${pa.y} C ${mx} ${pa.y}, ${mx} ${pb.y}, ${pb.x} ${pb.y}`} stroke="#a89b8c" strokeWidth={2} fill="none" markerEnd="url(#pc-arrow)" strokeOpacity={0.7} />
                })}
              </svg>

              {cards.map(c => {
                const meta = TYPE_META[c.type]
                const isPending = pendingConn === c.id
                return (
                  <div
                    key={c.id}
                    onPointerDown={e => onCardDown(e, c.id)}
                    className={`group absolute w-[260px] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-ink-850 shadow-lg select-none ${connectMode ? 'cursor-pointer' : 'cursor-grab'}`}
                    style={{ left: c.x, top: c.y, borderColor: isPending ? meta.color : 'rgb(63 63 58)', boxShadow: isPending ? `0 0 0 2px ${meta.color}` : undefined }}
                  >
                    <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-ink-700" style={{ borderTopColor: meta.color }}>
                      <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: meta.color }} />
                      <span className="text-[10px] font-medium" style={{ color: meta.color }}>{meta.label}</span>
                      <span className="text-[9px] text-ink-500 ml-auto truncate">{c.chapter}</span>
                    </div>
                    <div className="px-2.5 py-2 text-[12px] text-ink-200 leading-snug">{c.text}</div>
                    <Button variant="bare"
                      onPointerDown={e => { e.stopPropagation(); removeCard(c.id) }}
                      className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-ink-800 border border-ink-600 text-ink-400 hover:text-red-300 hover:border-red-400 items-center justify-center hidden group-hover:flex"
                      title="删除该卡"
                    ><X size={11} /></Button>
                  </div>
                )
              })}

              {/* 连线删除按钮（悬停显示；连接模式下常显） */}
              {conns.map(([a, b], i) => {
                const pa = cardCenter(a); const pb = cardCenter(b)
                const mx = (pa.x + pb.x) / 2; const my = (pa.y + pb.y) / 2
                return (
                  <Button variant="bare"
                    key={`del-${i}`}
                    onPointerDown={e => { e.stopPropagation(); removeConn(i) }}
                    title="取消这条推演链"
                    className={`absolute w-5 h-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-800 border border-ink-600 text-ink-300 hover:text-red-300 hover:border-red-400 flex items-center justify-center ${connectMode ? 'opacity-100' : 'opacity-0 hover:opacity-100'}`}
                    style={{ left: mx, top: my, pointerEvents: 'auto' }}
                  ><X size={11} /></Button>
                )
              })}

              {cards.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="text-center text-ink-500 text-sm max-w-sm">
                    <GitBranch size={28} className="mx-auto mb-2 opacity-50" />
                    左侧选择章节 → 点「生成推演」<br />AI 会把灵感简报升级成可拖拽、可连线的结构化卡片
                    <div className="text-[11px] text-ink-600 mt-2">卡片多到超出一屏时，画布会自动扩展并出现滚动条；按住左键拖动空白处即可平移。</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
