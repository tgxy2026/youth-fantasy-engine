/**
 * 酒馆模式 · 新建推演（锚点 → 位置与角色 → 信息边界档位 → 开场）
 *
 * 方案 §6.1 / §6.2 / §6.3。
 *
 * 【2026-09-14 第二轮改造，两个「列表太长」的解法】
 *
 * ① 叙事锚点：从下拉 `select` 换成**搜索框 + 可滚动列表**。章节上百之后，
 *    下拉里逐条滚着找比翻书还慢 —— 现在按「标题 / 卷名 / 章号」过滤，命中数实时显示。
 *
 * ② 角色分配：不再把所有角色平铺给用户逐个选档位（角色一多就是一张长表，还容易漏看）。
 *    改成**位置（槽位）**模型：默认给 3 个位置，点空位 → 弹窗选角色（同样支持搜索与按分组筛选）
 *    → 在弹窗里定「由谁演出」。约束两条：
 *      · 「我演」至多 1 个，**可以为 0**（整场交给 AI）；
 *      · 「AI 演」至多 `MAX_AI_CAST` 个 —— 再多，一轮里要分饰太多人，角色容易串味、
 *        等待也明显变长；两个通常是推演效果与输出效率的平衡点。
 *
 * 校验：锚点必选；至少一个位置是「AI 演」。
 */
import { useEffect, useMemo, useState } from 'react'
import * as db from '@/lib/db'
import { flattenChapters } from '@/lib/chapterSeq'
import { TABS } from '@/lib/schema'
import { Button } from '@/components/Button'
import SelectRow from '@/components/SelectRow'
import { Modal } from '@/components/Modal'
import AutoTextarea from '@/components/AutoTextarea'
import type { Chapter, Volume, CardRecord } from '@/lib/types'
import { MAX_AI_CAST, MAX_CAST_SLOTS, type CastRole, type TavernCast, type TavernMode } from '@/lib/tavern/types'

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

/** 默认位置数 = `DEFAULT_SLOT_ROLES` 的长度（1 个你演 + 2 个 AI 演） */
// 🔴 位置总数上限与 AI 名额上限**不在本文件定义** —— 单一真源在 `lib/tavern/types.ts`
//    （`MAX_CAST_SLOTS` / `MAX_AI_CAST`）。原先这里写死 4 与 3，而自由侧与
//    `store.planFreeSessionCast` 各自又写了一份，三处数字互不相干 ⇒ 改一处漏一处会静默丢角色。
/** 默认位置的演出方式：位置 1 = 你演，其余 = AI 演 */
const DEFAULT_SLOT_ROLES: CastRole[] = ['user', 'ai', 'ai']

const ROLE_LABEL: Record<CastRole, string> = { user: '我演', ai: 'AI 演', silent: '在场不出声' }
const ROLE_DESC: Record<CastRole, string> = {
  user: '这个角色由你自己掌控言行，AI 不会代写。整场至多一个 —— 也可以一个都不要（全部由 AI 演）。',
  ai: `由 AI 扮演。同时最多 ${MAX_AI_CAST} 个：再多，一轮里要分饰太多人，角色容易串味、等待也明显变长。`,
  silent: '在场但这一场不开口：AI 知道他在场，但不会替他说话。',
}

const inputCls = 'w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50'
const selCls = 'shrink-0 bg-ink-900 border border-ink-700 rounded-md px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50'
const labelCls = 'text-11 text-ink-400 mb-1'

/** 读卡片里的某个字段（模块名不固定，按「::字段名」后缀找 —— 与 CharacterSheet 同法） */
function fieldOf(rec: CardRecord, field: string): string {
  const k = Object.keys(rec.data).find(kk => kk.endsWith(`::${field}`))
  return k ? (rec.data[k] || '').trim() : ''
}

/** 列表/弹窗共用的角色条目（带所属页签与两条用于辨认的次要信息） */
type CardOption = CardRecord & { tabId: string; tabName: string; identity: string; retired: boolean }

/** 一个「位置」：选中的角色 + 谁来演 */
type Slot = { key: string; cardId: string; role: CastRole }

/** 打开弹窗时重建默认位置（每次「新建推演」都是一张白纸） */
function freshSlots(): Slot[] {
  return DEFAULT_SLOT_ROLES.map((role, i) => ({ key: `slot-${i}-${Date.now()}`, cardId: '', role }))
}

/**
 * 选角弹窗：先定「由谁演出」，再搜索/筛选角色，点一行即选中。
 * 已被别的位置占用的角色在这里置灰 —— 同一个角色不能既「我演」又「AI 演」。
 */
function CharacterPicker({ open, title, options, usedBy, initialCardId, initialRole, aiFull, onConfirm, onClose }: {
  open: boolean
  title: string
  options: CardOption[]
  /** cardId → 占用它的位置序号（1 起） */
  usedBy: Record<string, number>
  initialCardId: string
  initialRole: CastRole
  /** 其余位置已经把 AI 名额占满（此时不允许再选「AI 演」） */
  aiFull: boolean
  onConfirm: (cardId: string, role: CastRole) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState('all')
  const [cardId, setCardId] = useState('')
  const [role, setRole] = useState<CastRole>('ai')

  // 每次打开都把草稿重置成该位置的当前状态（关掉即丢弃，不会留下上次的筛选词）
  useEffect(() => {
    if (!open) return
    setQ('')
    setTab('all')
    setCardId(initialCardId)
    setRole(initialRole)
  }, [open, initialCardId, initialRole])

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return options.filter(o =>
      (tab === 'all' || o.tabId === tab)
      && (!kw || `${o.name} ${o.identity} ${o.tabName}`.toLowerCase().includes(kw)))
  }, [options, q, tab])

  const groups = useMemo(() => {
    const seen = new Map<string, string>()
    for (const o of options) if (!seen.has(o.tabId)) seen.set(o.tabId, o.tabName)
    return [{ id: 'all', name: '全部' }, ...[...seen].map(([id, name]) => ({ id, name }))]
  }, [options])

  const picked = options.find(o => o.id === cardId)

  return (
    <Modal
      open={open} onClose={onClose} title={title} width="lg"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-11 text-ink-500">
            {picked ? `已选：${picked.name || '（未命名）'} · ${ROLE_LABEL[role]}` : '还没选角色'}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
            <Button variant="primary" size="md" disabled={!cardId} onClick={() => onConfirm(cardId, role)}>确定</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {/* ① 由谁演出 */}
        <div>
          <div className={labelCls}>由谁演出</div>
          <div className="flex flex-wrap gap-2">
            {(['ai', 'user', 'silent'] as CastRole[]).map(r => (
              <Button
                key={r} variant="toggle" size="md" selected={role === r}
                disabled={r === 'ai' && aiFull} title={ROLE_DESC[r]}
                onClick={() => setRole(r)}
              >
                {ROLE_LABEL[r]}
              </Button>
            ))}
          </div>
          <p className="mt-1 text-11 leading-relaxed text-ink-500">
            {ROLE_DESC[role]}
            {aiFull && <span className="text-amber"> （{MAX_AI_CAST} 个 AI 名额已被其它位置占满）</span>}
          </p>
        </div>

        {/* ② 搜索 + 分组筛选 */}
        <div>
          <input
            className={inputCls}
            placeholder="搜索角色（姓名 / 身份 / 分组）"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {groups.map(g => (
              <Button key={g.id} variant="toggle" size="sm" selected={tab === g.id} onClick={() => setTab(g.id)}>
                {g.name}
              </Button>
            ))}
          </div>
        </div>

        {/* ③ 角色列表 */}
        <div className="max-h-64 overflow-y-auto rounded-md border border-ink-700 divide-y divide-ink-700">
          {rows.map(o => {
            const used = usedBy[o.id]
            const disabled = used !== undefined && o.id !== initialCardId
            return (
              <SelectRow
                  key={o.id} type="button" disabled={disabled} selected={cardId === o.id}
                  onClick={() => setCardId(o.id)}
                  className={`items-center gap-2 px-3 py-2 ${disabled ? 'cursor-not-allowed' : ''}`}
                >
                  <span className={`min-w-0 flex-1 truncate text-12 ${cardId === o.id ? 'text-amber' : 'text-ink-200'}`}>
                  {o.name || '（未命名）'}
                  {o.retired && <span className="ml-1.5 text-10 text-ink-500">已退场</span>}
                </span>
                <span className="shrink-0 truncate text-10 text-ink-500">
                  {disabled ? `已在位置 ${used}` : (o.identity || o.tabName)}
                </span>
              </SelectRow>
            )
          })}
          {rows.length === 0 && (
            <div className="px-3 py-3 text-12 text-ink-500">没有匹配的角色。</div>
          )}
        </div>
        <p className="text-10 text-ink-500">共 {options.length} 个角色 · 命中 {rows.length} 个</p>
      </div>
    </Modal>
  )
}

export default function TavernPlotSetup({ open, onCreate, onCancel }: Props) {
  const [vols, setVols] = useState<Volume[]>([])
  const [chs, setChs] = useState<Chapter[]>([])
  const [cards, setCards] = useState<{ tabId: string; name: string; recs: CardRecord[] }[]>([])
  const [loading, setLoading] = useState(true)

  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<TavernMode>('immersive')
  const [anchorId, setAnchorId] = useState('')
  const [anchorQ, setAnchorQ] = useState('')
  const [slots, setSlots] = useState<Slot[]>(() => freshSlots())
  const [pickerIdx, setPickerIdx] = useState<number | null>(null)
  const [place, setPlace] = useState('')
  const [time, setTime] = useState('')
  const [present, setPresent] = useState('')
  const [description, setDescription] = useState('')
  const [firstLine, setFirstLine] = useState('')

  // 打开时载入章节与角色卡，并把表单重置成白纸（「新建」不该带着上一次的残留）
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setTitle(''); setMode('immersive'); setAnchorId(''); setAnchorQ('')
    setSlots(freshSlots()); setPickerIdx(null)
    setPlace(''); setTime(''); setPresent(''); setDescription(''); setFirstLine('')
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

  /** 章节行：章号取「叙事序里的下标 + 1」，附卷名（搜索时卷名也参与命中） */
  const chapterRows = useMemo(() => {
    const volName = new Map(vols.map(v => [v.id, v.title]))
    return ordered.map((c, i) => ({ c, no: i + 1, vol: volName.get(c.volumeId) ?? '' }))
  }, [ordered, vols])

  const anchorRows = useMemo(() => {
    const kw = anchorQ.trim().toLowerCase()
    if (!kw) return chapterRows
    return chapterRows.filter(r =>
      `第${r.no}章 ${r.no} ${r.c.title} ${r.vol}`.toLowerCase().includes(kw))
  }, [chapterRows, anchorQ])

  const anchorRow = chapterRows.find(r => r.c.id === anchorId)

  const options = useMemo<CardOption[]>(() => cards.flatMap(g => g.recs.map(r => ({
    ...r,
    tabId: g.tabId,
    tabName: g.name,
    identity: fieldOf(r, '身份定位'),
    retired: fieldOf(r, '人物状态') === '已退场',
  }))), [cards])

  const cardById = useMemo(() => new Map(options.map(o => [o.id, o])), [options])

  /** cardId → 占用它的位置序号（1 起），选角弹窗据此置灰 */
  const usedBy = useMemo(() => {
    const m: Record<string, number> = {}
    slots.forEach((s, i) => { if (s.cardId) m[s.cardId] = i + 1 })
    return m
  }, [slots])

  const aiCount = slots.filter(s => s.cardId && s.role === 'ai').length
  const userCount = slots.filter(s => s.cardId && s.role === 'user').length
  const canStart = !!anchorId && aiCount >= 1

  const hint = !anchorId
    ? '请先选择一个叙事锚点（锚点之后的内容不会被带进上下文）'
    : aiCount === 0 ? '请至少让一个位置「AI 演」'
    : ''

  // ---------- 位置操作 ----------
  /**
   * AI 名额按「**标了 AI 演的位置数**」封顶（与自由侧同一条纪律），不是按"已选角色的"。
   * 🔴 新增位置默认是「AI 演」，只数已选的会出现：6 个已选 + 2 个空位（都标着 AI 演）
   *   → 填满就成了 8 个 AI —— 越过上限，而界面上一点提示都没有。
   *
   * AI 名额满了**不禁止加位置**（按钮上写着「最多 N 个」，点不动会让人以为坏了）——
   * 改成让新位置**默认落在「在场不出声」**：这类角色本来就有用（在场、可被提到、不占发言），
   * 作者想用就留着，想改成 AI 演时那个选项自然是被禁用的灰色。
   */
  const addSlot = () => setSlots(prev => (
    prev.length >= MAX_CAST_SLOTS
      ? prev
      : [...prev, {
        key: `slot-${prev.length}-${Date.now()}`,
        cardId: '',
        role: (prev.filter(x => x.role === 'ai').length >= MAX_AI_CAST ? 'silent' : 'ai') as CastRole,
      }]))

  const removeSlot = (i: number) => setSlots(prev => (prev.length <= 1 ? prev : prev.filter((_, k) => k !== i)))

  const clearSlot = (i: number) => setSlots(prev => prev.map((s, k) => (k === i ? { ...s, cardId: '' } : s)))

  /** 改演出方式：「我演」唯一 —— 把别的位置改回 AI 演（角色不丢，只是换了谁演） */
  const setSlotRole = (i: number, role: CastRole) => setSlots(prev => prev.map((s, k) => {
    if (k === i) return { ...s, role }
    if (role === 'user' && s.role === 'user') return { ...s, role: 'ai' }
    return s
  }))

  const applyPick = (i: number, cardId: string, role: CastRole) => {
    setSlots(prev => prev.map((s, k) => {
      if (k === i) return { ...s, cardId, role }
      if (role === 'user' && s.role === 'user') return { ...s, role: 'ai' }
      return s
    }))
    setPickerIdx(null)
  }

  const submit = () => {
    if (!canStart) return
    const cast: TavernCast[] = slots
      .filter(s => s.cardId && cardById.has(s.cardId))
      .map(s => {
        const c = cardById.get(s.cardId)!
        return { cardId: c.id, role: s.role, tabId: c.tabId, name: c.name }
      })
    onCreate({
      title: title.trim() || `推演 · ${anchorRow?.c.title ?? '未命名章节'}`,
      mode,
      anchorChapterId: anchorId,
      anchorChapterLabel: anchorRow ? `第 ${anchorRow.no} 章 · ${anchorRow.c.title || '未命名'}` : '',
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

  const pickerSlot = pickerIdx === null ? null : slots[pickerIdx]
  const pickerAiFull = pickerIdx !== null
    && slots.filter((s, k) => k !== pickerIdx && s.cardId && s.role === 'ai').length >= MAX_AI_CAST

  return (
    <>
    <Modal open={open} onClose={onCancel} title="新建推演" width="xl"
      footer={
        <div className="flex items-center justify-between gap-3 w-full">
          <span className="text-11 text-ink-500">{hint || '准备就绪'}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onCancel}>取消</Button>
            <Button variant="primary" size="md" disabled={!canStart} onClick={submit}>开始推演</Button>
          </div>
        </div>
      }>
      <div className="space-y-4">
        {loading ? (
          <div className="py-8 text-center text-12 text-ink-500">正在读取章节与角色…</div>
        ) : (
          <>
            {/* ① 叙事锚点 */}
            <section>
              <div className={labelCls}>① 叙事锚点（必选）</div>
              {ordered.length === 0 ? (
                <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-12 text-ink-400">
                  这个项目还没有章节。推演需要一个锚点 —— 请先在「正文编辑」里写几章，再回来。
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      className={inputCls}
                      placeholder="搜索章节（标题 / 卷名 / 章号）"
                      value={anchorQ}
                      onChange={e => setAnchorQ(e.target.value)}
                    />
                    {anchorId && (
                      <Button variant="secondary" size="md" className="shrink-0" onClick={() => setAnchorId('')}>
                        清除已选
                      </Button>
                    )}
                  </div>
                  <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-ink-700 divide-y divide-ink-700">
                    {anchorRows.map(r => {
                      const active = r.c.id === anchorId
                      return (
                        <SelectRow
                          key={r.c.id} type="button" selected={active}
                          onClick={() => setAnchorId(r.c.id)}
                          className="items-center gap-2 px-3 py-1.5"
                        >
                          <span className={`min-w-0 flex-1 truncate text-12 ${active ? 'text-amber' : 'text-ink-200'}`}>
                            第 {r.no} 章 · {r.c.title || '未命名章节'}
                          </span>
                          {r.vol && <span className="shrink-0 text-10 text-ink-500">{r.vol}</span>}
                        </SelectRow>
                      )
                    })}
                    {anchorRows.length === 0 && (
                      <div className="px-3 py-3 text-12 text-ink-500">没有匹配的章节。</div>
                    )}
                  </div>
                  <p className="mt-1 text-11 leading-relaxed text-ink-500">
                    共 {ordered.length} 章 · 命中 {anchorRows.length} 条
                    {anchorRow ? ` · 已选：第 ${anchorRow.no} 章 · ${anchorRow.c.title || '未命名章节'}` : ''}
                    <br />
                    锚点之后发生的事不会被带进上下文 —— 这样角色才是「此刻的Ta」，而不是知道结局的演员。
                  </p>
                </>
              )}
            </section>

            {/* ② 角色分配（位置槽位） */}
            <section>
              <div className={labelCls}>② 角色分配</div>
              {options.length === 0 ? (
                <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-12 text-ink-400">
                  角色管理里还没有角色卡。请先建几张角色卡（主要角色 / 次要角色 / NPC 均可）。
                </div>
              ) : (
                <>
                  <p className="mb-2 text-11 leading-relaxed text-ink-500">
                    空位置点一下就能选角色，选完在弹窗里定「由谁演出」。
                    AI 同时最多演 {MAX_AI_CAST} 个 —— 一轮里只让其中一个开口，所以人多也不会「抢话」，
                    但分饰的人越多越考较模型，等待也相应变长；三四个通常是效果与效率的平衡点。
                    用不上的角色挂到「在场不出声」就行（Ta 依然在场、可被提到，只是不占发言）。
                    「我演」可以留空（整场交给 AI），也至多一个。
                  </p>
                  <div className="space-y-2">
                    {slots.map((s, i) => {
                      const card = s.cardId ? cardById.get(s.cardId) : undefined
                      const aiOther = slots.filter((x, k) => k !== i && x.cardId && x.role === 'ai').length
                      const aiLocked = aiOther >= MAX_AI_CAST
                      return (
                        <div key={s.key} className="flex flex-wrap items-center gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-3 py-2">
                          <span className="w-12 shrink-0 text-11 text-ink-500">位置 {i + 1}</span>
                          {card ? (
                            <>
                              <span className="min-w-0 flex-1 truncate text-12 text-ink-100">
                                {card.name || '（未命名）'}
                                <span className="ml-2 text-10 text-ink-500">
                                  {card.tabName}{card.identity ? ` · ${card.identity}` : ''}
                                </span>
                              </span>
                              <select
                                className={selCls} value={s.role}
                                onChange={e => setSlotRole(i, e.target.value as CastRole)}
                              >
                                <option value="ai" disabled={aiLocked}>AI 演</option>
                                <option value="user">我演</option>
                                <option value="silent">在场不出声</option>
                              </select>
                              <Button variant="secondary" size="md" className="shrink-0" onClick={() => setPickerIdx(i)}>更换</Button>
                              <Button variant="secondary" size="md" className="shrink-0" onClick={() => clearSlot(i)}>清空</Button>
                            </>
                          ) : (
                            <>
                              {/* 空位占位符：保留虚线边框的「这里还空着」语义，但走 Button 组件
                                  （同屏的「更换 / 清空」都是 Button，混着写两套样式迟早走样） */}
                              <Button
                                variant="secondary" size="sm"
                                className="min-w-0 flex-1 justify-start border-dashed"
                                onClick={() => setPickerIdx(i)}
                              >
                                ＋ 选择角色
                              </Button>
                              <span className="shrink-0 text-10 text-ink-500">拟：{ROLE_LABEL[s.role]}</span>
                              {slots.length > 1 && (
                                <Button variant="secondary" size="md" className="shrink-0" onClick={() => removeSlot(i)}>移除位置</Button>
                              )}
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <Button variant="secondary" size="md"
                      disabled={slots.length >= MAX_CAST_SLOTS} onClick={addSlot}>
                      ＋ 增加位置（最多 {MAX_CAST_SLOTS} 个）
                    </Button>
                    <span className="text-11 text-ink-500">
                      当前：AI 演 {aiCount} 个 · 我演 {userCount} 个{userCount === 0 ? '（整场由 AI 扮演）' : ''}
                    </span>
                  </div>
                </>
              )}
            </section>

            {/* ③ 信息边界档位 */}
            <section>
              <div className={labelCls}>③ 信息边界</div>
              <div className="flex gap-2">
                <Button variant="toggle" selected={mode === 'immersive'} size="md" onClick={() => setMode('immersive')}>
                  沉浸推演
                </Button>
                <Button variant="toggle" selected={mode === 'director'} size="md" onClick={() => setMode('director')}>
                  导演推演
                </Button>
              </div>
              <p className="mt-1 text-11 text-ink-500">
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
                placeholder="你的第一句话（可留空，之后再开口也行；没有你演的角色时这里可写旁白或场景推进）"
                value={firstLine} onChange={setFirstLine} />
            </section>

            {/* 标题 */}
            <section>
              <div className={labelCls}>推演标题（可留空，默认取锚点章名）</div>
              <input className={inputCls} value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：Ta得知师父死讯那一夜" />
            </section>

            <div className="text-11 text-ink-500 border-t border-ink-700 pt-2">
              ⚠️ 角色卡与人物关系表都是「全书当前快照」、没有时间版本。
              推演早期剧情时，若卡上写着他「已继任宗主」，带进去就会错位 —— 请留意这种状态错位。
            </div>
          </>
        )}
      </div>
    </Modal>

    {/* 选角弹窗是**外层弹窗的兄弟节点**（各自 Portal 到 body，层级由 zLayer 保证）——
        嵌在 Modal children 里虽然也能显示，但语义上是「弹窗里的按钮又开了一层」，容易读错。 */}
    {open && pickerIdx !== null && pickerSlot && (
      <CharacterPicker
        open
        title={`位置 ${pickerIdx + 1} · 选择角色`}
        options={options}
        usedBy={usedBy}
        initialCardId={pickerSlot.cardId}
        initialRole={pickerSlot.role}
        aiFull={pickerAiFull}
        onConfirm={(cardId, role) => applyPick(pickerIdx, cardId, role)}
        onClose={() => setPickerIdx(null)}
      />
    )}
    </>
  )
}
