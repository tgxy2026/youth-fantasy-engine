/**
 * 灵感夹（2.5.1 · A3）
 *
 * 灵感启发页的第三个模块：随手记灵感 → 攒着 → 勾选几条 → AI 融合成情节卡 → 落推演画布。
 *
 * 设计要点：
 * · 条目就是一句话（不结构化）—— 灵感夹是草稿区，结构化是「AI 整理到设定」那些功能的事；
 * · 融合至少勾 2 条：一条灵感没有「融合」可言（那是扩写，留给画布上直接编辑）；
 * · 产出直接写 plotCanvas 快照（idea 卡），画布挂载时会重读 —— 两个页签不会同时挂载，无写冲突；
 * · 生成结果同时在下方列出并标「基于灵感 #N」，与画布里的卡一一对应（溯源红线）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Lightbulb, Loader2, Sparkles, X } from 'lucide-react'
import * as db from '../lib/db'
import { addItem, loadBox, removeItem, INSPIRATION_MAX, type InspirationItem } from '../lib/inspirationBox'
import { aiFuseInspiration, type FusedIdea } from '../lib/aiTasks'
import { buildProjectContext } from '../lib/aiContext'
import { writerBudgetFor } from '../lib/aiWriterBudget'
import { isCancelled } from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { showToast } from './dialogs'
import AIDataSourceNote from './AIDataSourceNote'
import HelpPopover from './HelpPopover'
import { Button } from './Button'

/** 融合产出的 idea 卡在画布上的排布：沿对角线错开，避免与已有卡片叠死 */
function ideaCardPos(existing: number): { x: number; y: number } {
  const k = existing % 6
  return { x: 80 + k * 48, y: 80 + k * 48 }
}

export default function InspirationBox() {
  const { ready: aiReady } = useAIReady()
  const [items, setItems] = useState<InspirationItem[]>([])
  const [newText, setNewText] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [fusing, setFusing] = useState(false)
  const [fused, setFused] = useState<FusedIdea[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setItems(await loadBox())
  }, [])
  useEffect(() => { void load() }, [load])

  const add = async () => {
    const r = await addItem(newText, items)
    if (!r.added) {
      if (r.reason === 'dup') showToast('这条灵感已经在夹子里了', 'info')
      else if (r.reason === 'full') showToast(`灵感夹最多存 ${INSPIRATION_MAX} 条，先转化或清掉一些吧`, 'info')
      else return
    }
    setItems(r.items)
    setNewText('')
  }

  const toggleChecked = (id: string) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const del = async (id: string) => {
    setItems(await removeItem(id, items))
    setChecked(prev => { const n = new Set(prev); n.delete(id); return n })
    setFused(null) // 删掉的条目可能被上一轮产出引用，溯源标注不再可信
  }

  const fuse = async () => {
    if (!aiReady) { showToast('还没接入模型，无法融合', 'info'); return }
    if (checked.size < 2) { showToast('至少勾选 2 条灵感才能融合', 'info'); return }
    if (fusing) return
    setFusing(true); setError(''); setFused(null)
    try {
      const chosen = items.filter(i => checked.has(i.id))
      const ctx = await buildProjectContext({ budget: await writerBudgetFor('inspiration-fuse') }).catch(() => ({ text: '' }))
      const ideas = await aiFuseInspiration({ items: chosen.map(i => i.text), context: ctx.text })
      if (ideas.length === 0) { setError('这次没融合出可用的创意，再试一次或换几条灵感组合。'); return }
      // 落画布：读最新快照 → 追加 idea 卡 → 写回（与画布的防抖写互不干扰：两页签不同时挂载）
      const persist = await db.getSetting<{ selected: string[]; cards: Array<Record<string, unknown>>; conns: unknown[] }>('plotCanvas', { selected: [], cards: [], conns: [] })
      const base = persist.cards?.length ?? 0
      const newCards = ideas.map((idea, i) => {
        const pos = ideaCardPos(base + i)
        // C-1 · 2.6.0：basedOn 随卡落快照 —— 兑现帮助里「每张卡标注用了哪几条灵感」的承诺（画布卡头部渲染）
        return { id: `idea-${Date.now()}-${i}`, chapter: '', type: 'idea', text: idea.text, basedOn: idea.basedOn, x: pos.x, y: pos.y }
      })
      await db.setSetting('plotCanvas', { ...persist, cards: [...(persist.cards ?? []), ...newCards] })
      setFused(ideas)
      setChecked(new Set())
      showToast(`已把 ${ideas.length} 张情节卡放到推演画布`, 'success')
    } catch (e) {
      if (isCancelled(e)) return
      setError(e instanceof Error ? e.message : String(e))
    } finally { setFusing(false) }
  }

  return (
    <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
      <h2 className="text-13 font-semibold text-ink-100 mb-4 flex items-center gap-2">
        <Lightbulb size={14} className="text-amber" /> 灵感夹
        <HelpPopover title="灵感夹怎么用" width="24rem">
          {'随手把一闪而过的点子记在这里 —— 一条一句话就够，攒着不用急着用。\n\n勾选 2 条以上，点「融合为情节卡」：AI 会让这几条灵感互相服务，形成新的情节创意，直接放到「情节推演」的画布上（每张卡会标注用了哪几条灵感）。注意是创作管理组的「情节推演」画布，不是酒馆模式里的「剧情推演」——那边是酒馆会话的推演，两回事。\n\n· 灵感夹跟着项目走，换项目看到的是那一本书的夹子；\n· 融合结果在画布上随便拖、随便删，这里不锁任何东西。'}
          <AIDataSourceNote feature="inspiration-fuse" />
        </HelpPopover>
        <span className="ml-auto text-10 text-ink-500 font-normal">{items.length} 条</span>
      </h2>

      {/* 记一条 */}
      <div className="flex items-center gap-2 mb-3">
        <input
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && newText.trim()) void add() }}
          placeholder="记一条灵感：一个点子、一句台词、一个画面……（回车记下）"
          className="flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-12 text-ink-100 outline-none focus:border-amber placeholder:text-ink-600"
        />
        <Button variant="secondary" size="sm" disabled={!newText.trim()} onClick={() => void add()}>
          记下来
        </Button>
      </div>

      {/* 条目列表 */}
      {items.length === 0 ? (
        <div className="text-11 text-ink-500 py-2">夹子还是空的 —— 想到什么先记下来，攒几条再融合。</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((it, idx) => (
            <div key={it.id} className={`flex items-start gap-2 rounded-lg border px-3 py-2 transition-colors ${
              checked.has(it.id) ? 'border-amber/40 bg-amber/5' : 'border-ink-700 bg-ink-800/60'
            }`}>
              <Button variant="bare" className="p-0.5 mt-0.5 shrink-0"
                onClick={() => toggleChecked(it.id)}
                title={checked.has(it.id) ? '取消勾选' : '勾选（融合时用它）'}
                aria-label={checked.has(it.id) ? '取消勾选' : '勾选'}>
                {checked.has(it.id)
                  ? <span className="flex items-center justify-center w-3.5 h-3.5 rounded bg-amber text-ink-950"><Check size={10} /></span>
                  : <span className="block w-3.5 h-3.5 rounded border border-ink-600" />}
              </Button>
              <span className="flex-1 text-12 text-ink-200 leading-relaxed break-all">{it.text}</span>
              <span className="text-10 text-ink-600 shrink-0 mt-0.5 tabular-nums">#{idx + 1}</span>
              <Button variant="icon-danger" className="p-0.5 shrink-0 mt-0.5" onClick={() => void del(it.id)} title="删除这条灵感" aria-label="删除">
                <X size={11} />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* 融合操作条 */}
      {items.length > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-11 text-ink-400">已勾选 <b className="text-ink-200 tabular-nums">{checked.size}</b> 条</span>
          {checked.size > 0 && (
            <Button variant="secondary" size="xs" onClick={() => setChecked(new Set())}>清空勾选</Button>
          )}
          {aiReady ? (
            <Button variant="primary" size="sm" className="ml-auto" disabled={fusing || checked.size < 2}
              onClick={() => void fuse()}
              title={checked.size < 2 ? '至少勾选 2 条灵感' : '把勾选的灵感融合成情节卡，放到推演画布'}>
              {fusing ? <><Loader2 size={12} className="animate-spin" /> 融合中…</> : <><Sparkles size={12} /> 融合为情节卡</>}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" className="ml-auto" disabled title={AI_DISABLED_HINT}>
              <Sparkles size={12} /> 融合为情节卡
            </Button>
          )}
        </div>
      )}

      {/* 融合失败 */}
      {error && (
        <div className="mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-danger/10 border border-danger/25 text-12 text-danger">
          <Sparkles size={13} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{error}</span>
        </div>
      )}

      {/* 本轮产出（溯源） */}
      {fused && fused.length > 0 && (
        <div className="mt-3 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2.5">
          <div className="text-10 text-ink-500 mb-1.5">本轮产出 {fused.length} 张卡，已在推演画布上（可拖动、可删除）：</div>
          <div className="space-y-1.5">
            {fused.map((f, i) => (
              <div key={i} className="text-11 text-ink-300 leading-relaxed">
                <span className="text-10 text-success/80 mr-1.5 shrink-0">灵感融合 #{i + 1}{f.basedOn.length ? ` · 基于灵感 ${f.basedOn.map(n => '#' + n).join(' ')}` : ''}</span>
                {f.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
