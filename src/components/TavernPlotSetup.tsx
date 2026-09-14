/**
 * 酒馆模式 · 新建推演（建会话四步：锚点 → 角色分配 → 信息边界档位 → 开场）
 *
 * 方案 §6.1 / §6.2 / §6.3。
 * 校验：锚点必选；角色分配里 `user`（你演）必须且只能有一个；至少要有一个 `ai`。
 */
import { useEffect, useMemo, useState } from 'react'
import * as db from '../lib/db'
import { flattenChapters } from '../lib/chapterSeq'
import { TABS } from '../lib/schema'
import { Button } from './Button'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import type { Chapter, Volume, CardRecord } from '../lib/types'
import type { TavernCast, TavernMode } from '../lib/tavern/types'

export type TavernDraft = {
  title: string
  mode: TavernMode
  anchorChapterId: string
  anchorChapterLabel: string
  cast: TavernCast[]
  scene: { place: string; time: string; present: string[]; description: string }
  /** 开场的第一句话（可留空，之后在对话里说也行） */
  firstLine: string
}

interface Props {
  open: boolean
  onCreate: (draft: TavernDraft) => void
  onCancel: () => void
}

/** 角色来源：角色管理下的三张卡 */
const CHAR_TABS = ['char-main', 'char-secondary', 'char-npc'] as const

const inputCls = 'w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50'
const labelCls = 'text-[11px] text-ink-400 mb-1'

export default function TavernPlotSetup({ open, onCreate, onCancel }: Props) {
  const [vols, setVols] = useState<Volume[]>([])
  const [chs, setChs] = useState<Chapter[]>([])
  const [cards, setCards] = useState<{ tabId: string; name: string; recs: CardRecord[] }[]>([])
  const [loading, setLoading] = useState(true)

  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<TavernMode>('immersive')
  const [anchorId, setAnchorId] = useState('')
  const [assign, setAssign] = useState<Record<string, TavernCast['role'] | ''>>({})
  const [place, setPlace] = useState('')
  const [time, setTime] = useState('')
  const [present, setPresent] = useState('')
  const [description, setDescription] = useState('')
  const [firstLine, setFirstLine] = useState('')

  // 打开时载入章节与角色卡
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const [v, c] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
        if (!alive) return
        setVols(v)
        setChs(c)
        const loaded: { tabId: string; name: string; recs: CardRecord[] }[] = []
        for (const tabId of CHAR_TABS) {
          const recs = await db.getCardRecords(tabId)
          const tab = TABS.find(t => t.id === tabId)
          loaded.push({ tabId, name: tab?.name ?? tabId, recs })
        }
        if (!alive) return
        setCards(loaded)
      } catch {
        /* 读取失败按空处理，页面会显示空态 */
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [open])

  // 叙事序（卷序 → 章序），锚点选择用同一套顺序
  const ordered = useMemo(() => {
    const orphans = chs.filter(c => !vols.some(v => v.id === c.volumeId))
    return [...flattenChapters(vols, chs), ...orphans]
  }, [vols, chs])

  const allCards = useMemo(() => cards.flatMap(g => g.recs.map(r => ({ ...r, tabId: g.tabId, tabName: g.name }))), [cards])

  const userCount = Object.values(assign).filter(v => v === 'user').length
  const aiCount = Object.values(assign).filter(v => v === 'ai').length
  const canStart = !!anchorId && userCount === 1 && aiCount >= 1

  const hint = !anchorId
    ? '请先选择一个叙事锚点（之后的内容不会被带进上下文）'
    : userCount === 0 ? '请指定一个「你演」的角色'
    : userCount > 1 ? '「你演」只能有一个角色'
    : aiCount === 0 ? '请至少指定一个「AI 演」的角色'
    : ''

  const submit = () => {
    if (!canStart) return
    const anchor = ordered.find(c => c.id === anchorId)
    const cast: TavernCast[] = allCards
      .filter(c => assign[c.id])
      .map(c => ({ cardId: c.id, role: assign[c.id] as TavernCast['role'], tabId: c.tabId, name: c.name }))
    onCreate({
      title: title.trim() || `推演 · ${anchor?.title ?? '未命名章节'}`,
      mode,
      anchorChapterId: anchorId,
      anchorChapterLabel: anchor ? `第 ${ordered.findIndex(c => c.id === anchorId) + 1} 章 · ${anchor.title || '未命名'}` : '',
      cast,
      scene: {
        place: place.trim(),
        time: time.trim(),
        present: present.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean),
        description: description.trim(),
      },
      firstLine: firstLine.trim(),
    })
  }

  return (
    <Modal open={open} onClose={onCancel} title="新建推演" width="xl"
      footer={
        <div className="flex items-center justify-between gap-3 w-full">
          <span className="text-[11px] text-ink-500">{hint || '准备就绪'}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onCancel}>取消</Button>
            <Button variant="primary" size="md" disabled={!canStart} onClick={submit}>开始推演</Button>
          </div>
        </div>
      }>
      <div className="space-y-4">
        {loading ? (
          <div className="py-8 text-center text-[12px] text-ink-500">正在读取章节与角色…</div>
        ) : (
          <>
            {/* ① 叙事锚点 */}
            <section>
              <div className={labelCls}>① 叙事锚点（必选）</div>
              {ordered.length === 0 ? (
                <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-[12px] text-ink-400">
                  这个项目还没有章节。推演需要一个锚点 —— 请先在「正文编辑」里写几章，再回来。
                </div>
              ) : (
                <>
                  <select className={inputCls} value={anchorId} onChange={e => setAnchorId(e.target.value)}>
                    <option value="">— 请选择 —</option>
                    {ordered.map((c, i) => (
                      <option key={c.id} value={c.id}>第 {i + 1} 章 · {c.title || '未命名章节'}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-ink-500">
                    锚点之后发生的事不会被带进上下文 —— 这样角色才是「此刻的她」，而不是知道结局的演员。
                  </p>
                </>
              )}
            </section>

            {/* ② 角色分配 */}
            <section>
              <div className={labelCls}>② 角色分配（你演 1 个，AI 至少演 1 个）</div>
              {allCards.length === 0 ? (
                <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-[12px] text-ink-400">
                  角色管理里还没有角色卡。请先建几张角色卡（主要角色 / 次要角色 / NPC 均可）。
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto rounded-md border border-ink-700 divide-y divide-ink-800">
                  {cards.map(g => g.recs.length > 0 && (
                    <div key={g.tabId}>
                      <div className="bg-ink-850 px-3 py-1 text-[11px] text-ink-500">{g.name}</div>
                      {g.recs.map(r => (
                        <div key={r.id} className="flex items-center gap-3 px-3 py-1.5">
                          <span className="flex-1 truncate text-[12px] text-ink-200">{r.name || '（未命名）'}</span>
                          <select
                            className="bg-ink-900 border border-ink-700 rounded-md px-2 py-1 text-[12px] text-ink-100 outline-none focus:border-amber/50"
                            value={assign[r.id] ?? ''}
                            onChange={e => setAssign(a => ({ ...a, [r.id]: e.target.value as TavernCast['role'] | '' }))}
                          >
                            <option value="">不参与</option>
                            <option value="user">你演</option>
                            <option value="ai">AI 演</option>
                            <option value="silent">在场不出声</option>
                          </select>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ③ 信息边界档位 */}
            <section>
              <div className={labelCls}>③ 信息边界</div>
              <div className="flex gap-2">
                <Button variant="toggle" selected={mode === 'immersive'} size="md" onClick={() => setMode('immersive')}>
                  沉浸推演（默认）
                </Button>
                <Button variant="toggle" selected={mode === 'director'} size="md" onClick={() => setMode('director')}>
                  导演推演
                </Button>
              </div>
              <p className="mt-1 text-[11px] text-ink-500">
                {mode === 'immersive'
                  ? '沉浸：只带入角色的「常识」（世界观 / 角色 / 关系），排除大纲与伏笔 —— 用它测角色反应最准。'
                  : '导演：可参照大纲与伏笔，但同样只到锚点为止 —— 适合检查「按设定这里该怎么演」。'}
              </p>
            </section>

            {/* ④ 开场 */}
            <section>
              <div className={labelCls}>④ 开场</div>
              <div className="grid grid-cols-2 gap-2">
                <input className={inputCls} placeholder="地点（如山门 · 药铺）" value={place} onChange={e => setPlace(e.target.value)} />
                <input className={inputCls} placeholder="时间（如清晨 · 灯会后第三日）" value={time} onChange={e => setTime(e.target.value)} />
              </div>
              <input className={`${inputCls} mt-2`} placeholder="在场人物（顿号分隔，可留空）" value={present} onChange={e => setPresent(e.target.value)} />
              <AutoTextarea className="mt-2 bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-sm" minRows={3} maxHeight={320}
                placeholder="场景描述（这一场从什么地方开始）"
                value={description} onChange={setDescription} />
              <AutoTextarea className="mt-2 bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-sm" minRows={2} maxHeight={240}
                placeholder="你的第一句话（可留空，之后再开口也行）"
                value={firstLine} onChange={setFirstLine} />
            </section>

            {/* 标题 */}
            <section>
              <div className={labelCls}>推演标题（可留空，默认取锚点章名）</div>
              <input className={inputCls} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：她得知师父死讯那一夜" />
            </section>

            <div className="text-[11px] text-ink-500 border-t border-ink-800 pt-2">
              ⚠️ 角色卡与人物关系表都是「全书当前快照」、没有时间版本。
              推演早期剧情时，若卡上写着他「已继任宗主」，带进去就会错位 —— 请留意这种状态错位。
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
