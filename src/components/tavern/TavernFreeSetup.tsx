/**
 * 酒馆模式 · 新建对话（自由模式）
 *
 * 版式对齐「新建推演」（`TavernPlotSetup`）：**位置槽位选角 + 对话内容设置**。
 * 差异有三：
 *   · **没有叙事锚点** —— 自由模式不绑小说项目，谈不上「截到第几章」，所以整段去掉；
 *   · **没有「在场不出声」** —— 自由对话是两个人的话，没开口的角色等于不在场；
 *   · **每个位置可以选「我演」**（最多一个）—— 默认你演你自己，
 *     但也可以反过来：你演阿禾、AI 演阿岩。选了之后 AI 才知道自己**在跟谁**对话，
 *     并且不会代写那个人的言行（见 `engine.buildFreeSystem` 的身份层）。
 *   · 「你演你自己」也不再是「没有身份」：控制面板的**「我的档案」**（全局、跨项目）
 *     会在这种时候作为用户本人的身份注入（名字 / 称呼 / 一句话自我设定）。
 *
 * 上限沿用引擎侧的多角色同场上限（3）：一轮里让模型分饰 N 个人，N 越大越容易串味，
 * 单轮输出也越长、等待越久 —— 与剧情模式同一条理由，写在界面上而不是埋在代码里。
 *
 * 【2026-09-14 第四轮改动：「对话内容」抽成「剧本」】
 * 原先这里有五格手填（地点/时间/在场/场景描述/第一句话），**填完就丢** ——
 * 想复用一场戏只能凭记忆重填一遍。现在这几格搬进「故事剧本」（六栏、可命名、可复用），
 * 这里只留一个**选择器**：留空（直接开口聊）或引用一份已有剧本。
 * 这样做还顺带解决一个隐患：手填的内容原本只进开场第一条消息、不进 system，
 * 剧本则把「情境/你的位置/目标/禁区」放进 system（每轮都在），开场白仍走消息通道 —— 分工更清楚。
 */
import { useEffect, useMemo, useState } from 'react'
import * as store from '@/lib/tavern/store'
import { MAX_AI_CAST, MAX_CAST_SLOTS } from '@/lib/tavern/types'
import { getTavernSettings, activeProfileOf, DEFAULT_TAVERN_SETTINGS } from '@/lib/tavern/settings'
import { checkProfileFit } from '@/lib/tavern/profileFit'
import { checkStyleFit, effectiveStyleHint } from '@/lib/tavern/styleFit'
import { Button } from '@/components/common/Button'
import SelectRow from '@/components/common/SelectRow'
import { Modal } from '@/components/dialogs/Modal'
import Avatar from '@/components/common/Avatar'
import TavernScriptDialog from '@/components/tavern/TavernScriptDialog'
import {
  getScript, scriptToText, snapshotOf, scriptDisplayName, listScriptsByStory,
} from '@/lib/tavern/script'
import { listStories, storyDisplayName } from '@/lib/tavern/story'
import { cardStoryId } from '@/lib/tavern/types'
import type { TavernScript, TavernScriptIndexItem, TavernStoryIndexItem } from '@/lib/tavern/types'

export type FreeDraft = {
  /** 全部参演角色（含用户扮演的那个） */
  charIds: string[]
  /** 用户扮演的角色 id（'' = 用户演他自己） */
  userCharId: string
  title: string
  /**
   * 引用哪份剧本（'' = 留空）。
   * 调用方据此取**快照**存进会话 —— 之后这份剧本被改被删，这一场都不会变样。
   */
  scriptId: string
  /**
   * 归属故事（**必选**，老大 2026-09-16 定）。
   * 这一场的世界观由它提供；会话存一份 id，左栏据此把对话挂在故事下面。
   */
  storyId: string
}

interface Props {
  open: boolean
  onCreate: (draft: FreeDraft) => void
  onCancel: () => void
}

// 🔴 位置上限 / AI 名额上限**不在这里定义** —— 单一真源是 `lib/tavern/types.ts` 的
//    `MAX_CAST_SLOTS` / `MAX_AI_CAST`（store.planFreeSessionCast 的截断也用同一个数）。
//    原先这里写死 3、store 那边又写死 3，两处独立 ⇒ 改了界面不改 store 会静默丢角色。

const inputCls = 'w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50'
const selCls = 'shrink-0 bg-ink-900 border border-ink-700 rounded-md px-2 py-1 text-12 text-ink-100 outline-none focus:border-amber/50'
const labelCls = 'text-11 text-ink-400 mb-1'

/**
 * 选角用的条目：名字 + 内核一句话（用来分辨相似的角色）。
 * `rating` = 角色卡第 3 章的「尺度」原文，**只给 W4-2 的冲突自检用**，不出现在界面上
 * （尺度是长文本，塞进下拉列表会撑爆版式）。
 */
type CharOption = { id: string; name: string; core: string; rating: string; avatar?: string; storyId: string }

/** 一个位置：选中的角色 + 由谁演 */
type Slot = { charId: string; role: 'ai' | 'user' }

/**
 * 打开弹窗时重建默认位置：**一个待选的 AI 空位**。
 *
 * （2.1.0 曾按控制面板的「默认『我演』的角色」预填成一个「我演」位置 —— 那个字段已废弃。
 * 「你本人是谁」改由全局的「我的档案」承担，不再需要在这里预填一个角色卡。）
 */
function freshSlots(): Slot[] {
  return [{ charId: '', role: 'ai' }]
}

/** 选角弹窗：搜索 + 已被别的位置占用的置灰 */
function CharPicker({ open, options, usedBy, currentId, onConfirm, onClose }: {
  open: boolean
  options: CharOption[]
  /** charId → 占用它的位置序号（1 起） */
  usedBy: Record<string, number>
  /** 本位置当前已选的角色（允许重复选中，等于「不改」） */
  currentId: string
  onConfirm: (charId: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [cardId, setCardId] = useState('')

  useEffect(() => {
    if (!open) return
    setQ('')
    setCardId(currentId)
  }, [open, currentId])

  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return options
    return options.filter(o => `${o.name} ${o.core}`.toLowerCase().includes(kw))
  }, [options, q])

  const picked = options.find(o => o.id === cardId)

  return (
    <Modal
      open={open} onClose={onClose} title="选择角色" width="lg"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-11 text-ink-500">{picked ? `已选：${picked.name || '（未命名）'}` : '还没选角色'}</span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
            <Button variant="primary" size="md" disabled={!cardId} onClick={() => onConfirm(cardId)}>确定</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        <input
          className={inputCls}
          placeholder="搜索角色（名字 / 内核）"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <div className="max-h-64 overflow-y-auto rounded-md border border-ink-700 divide-y divide-ink-700">
          {rows.map(o => {
            const used = usedBy[o.id]
            const disabled = used !== undefined && o.id !== currentId
            return (
              <SelectRow
                key={o.id} type="button" disabled={disabled} selected={cardId === o.id}
                onClick={() => setCardId(o.id)}
                className={`items-center gap-2 px-3 py-2 ${disabled ? 'cursor-not-allowed' : ''}`}
              >
                <Avatar src={o.avatar} name={o.name} size={20} />
                <span className={`min-w-0 shrink-0 text-12 ${cardId === o.id ? 'text-amber' : 'text-ink-200'}`}>
                  {o.name || '（未命名）'}
                </span>
                <span className="min-w-0 flex-1 truncate text-right text-10 text-ink-500">
                  {disabled ? `已在位置 ${used}` : o.core}
                </span>
              </SelectRow>
            )
          })}
          {rows.length === 0 && (
            <div className="px-3 py-3 text-12 text-ink-500">
              {options.length === 0 ? '还没有角色卡 —— 先去「角色卡片」建一张。' : '没有匹配的角色。'}
            </div>
          )}
        </div>
        <p className="text-10 text-ink-500">共 {options.length} 个角色 · 命中 {rows.length} 个</p>
      </div>
    </Modal>
  )
}

export default function TavernFreeSetup({ open, onCreate, onCancel }: Props) {
  const [options, setOptions] = useState<CharOption[]>([])
  const [loading, setLoading] = useState(true)
  /**
   * 「我的档案」（名字 / 称呼 / 自我设定）—— 打开时读一次。
   * 既用来把「AI 已经知道你是谁」讲清楚，也做档案 ↔ 阵容的匹配自检（W3-4 F4）。
   */
  const [profile, setProfile] = useState<{ name: string; address: string; persona: string }>(
    { name: '', address: '', persona: '' },
  )

  /**
   * 控制面板里**手填**的「聊天向风格提示」（空串 = 没手填 ⇒ 用出厂默认）。
   * 只用来做 W4-2 的风格自检；真正注入的那一份由引擎从 settings 现取，两边读同一条键。
   */
  const [styleHint, setStyleHint] = useState('')

  const [slots, setSlots] = useState<Slot[]>(() => freshSlots())
  const [pickerIdx, setPickerIdx] = useState<number | null>(null)

  const [title, setTitle] = useState('')
  /** 故事列表（左栏树状的同一批）+ 本次选中的故事 —— 不选故事就不能开始（老大 2026-09-16 定） */
  const [stories, setStories] = useState<TavernStoryIndexItem[]>([])
  const [storyId, setStoryId] = useState('')
  /** 剧本列表（索引项）与当前选中的那份全文（用于预览）。按选中的故事过滤 */
  const [scripts, setScripts] = useState<TavernScriptIndexItem[]>([])
  const [scriptId, setScriptId] = useState('')
  const [scriptView, setScriptView] = useState<TavernScript | null>(null)
  const [scriptOpen, setScriptOpen] = useState(false)

  // 打开时读角色卡（并重置成白纸）
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setSlots(freshSlots()); setPickerIdx(null); setProfile({ name: '', address: '', persona: '' })
    setStyleHint('')
    setTitle(''); setStoryId(''); setScriptId(''); setScriptView(null); setScriptOpen(false)
    ;(async () => {
      try {
        const [idx, st, ss] = await Promise.all([
          store.listFreeChars(),
          getTavernSettings().catch(() => DEFAULT_TAVERN_SETTINGS),
          listStories().catch(() => [] as TavernStoryIndexItem[]),
        ])
        // 逐个读完整卡拿「内核」那一句：选角色时能一眼分清（读失败就留空，不影响选）
        // storyId 从索引项拿（索引里有），不读整卡
        const full = await Promise.all(idx.map(async it => {
          const card = await store.getFreeChar(it.id).catch(() => null)
          return {
            id: it.id, name: it.name, avatar: card?.avatar,
            core: (card?.profile.core ?? '').trim().replace(/\s+/g, ' ').slice(0, 28),
            // W4-2：顺带把「尺度」原文带上（**不截断** —— 正则要能看到"拥抱/哭/靠近"这类词）
            rating: (card?.conduct?.rating ?? '').trim(),
            storyId: cardStoryId(it),
          }
        }))
        if (!alive) return
        setOptions(full)
        setStories(ss)
        setScripts([])  // 故事定了再按它拉剧本
        // W4-2：把控制面板手填的风格提示取回来（只用于冲突自检，不改任何注入行为）
        setStyleHint(st.free.styleHint ?? '')
        // 「我的档案」有名字 → 界面可以明确讲「AI 已经知道你是谁」。
        // 这正是「默认『我演』的角色」被去掉之后的补偿：**不用选角色也有身份**。
        const p = activeProfileOf(st)
        setProfile({ name: p.name, address: p.address, persona: p.persona })
      } catch {
        if (alive) setOptions([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [open])

  /** 选一份剧本（'' = 留空）—— 顺手把全文取回来做预览 */
  const pickScript = async (id: string) => {
    setScriptId(id)
    setScriptView(id ? await getScript(id).catch(() => null) : null)
  }

  /**
   * 选故事 —— 换故事必须**同时清掉选角与剧本**：
   * 角色与剧本都是挂在故事下的，留着上一个故事的人就会开出一场「人不对世界」的戏。
   */
  const pickStory = async (id: string) => {
    setStoryId(id)
    setSlots(freshSlots())
    setPickerIdx(null)
    setScriptId('')
    setScriptView(null)
    setScripts(id ? await listScriptsByStory(id).catch(() => []) : [])
  }

  /** 只让选本故事下的角色 —— 这是「先选故事」的全部意义 */
  const scoped = useMemo(() => options.filter(o => o.storyId === storyId), [options, storyId])

  /** 「我的档案」里的称呼/名字（空 = 没填档案）—— 只用来把「AI 已经知道你是谁」讲清楚 */
  const callName = profile.address.trim() || profile.name.trim()

  const nameOf = (id: string) => scoped.find(o => o.id === id)?.name ?? ''
  const coreOf = (id: string) => scoped.find(o => o.id === id)?.core ?? ''

  /** charId → 占用它的位置序号（1 起） */
  const usedBy = useMemo(() => {
    const m: Record<string, number> = {}
    slots.forEach((s, i) => { if (s.charId) m[s.charId] = i + 1 })
    return m
  }, [slots])

  const charIds = slots.map(s => s.charId).filter(Boolean)
  const userCharId = slots.find(s => s.role === 'user' && s.charId)?.charId ?? ''

  /**
   * 档案 ↔ 阵容匹配自检（W3-4 / §13 F4）：一条**可忽略**的提醒，绝不阻断新建。
   * 依赖写成 `profile` / `slots` / `scoped`（都是稳定引用）——不把每次渲染都重建的
   * `nameOf` / `charIds` 写进依赖，否则 memo 形同虚设（同 2026-10-04 审计 A5 的收敛）。
   */
  const fitWarning = useMemo(() => checkProfileFit({
    ...profile,
    castNames: slots
      .filter(s => !!s.charId)
      .map(s => scoped.find(o => o.id === s.charId)?.name ?? '')
      .filter(Boolean),
    userActsRole: slots.some(s => s.role === 'user' && !!s.charId),
  }), [profile, slots, scoped])

  /**
   * 「风格提示 ↔ 角色卡尺度」冲突自检（W4-2 / §13 F6）：同样是**可忽略**的提醒，不阻断新建。
   *
   * 🔴 生效的 styleHint 走 `effectiveStyleHint()` 解析，**界面不自己拼** ——
   *    手填值优先、否则回落到内置档位默认（自由对话恒为 chat 档）。
   *    自由对话的档位是常量 `chat`（引擎侧 `FREE_TONE`），所以这里直接写 'chat'；
   *    将来若给自由对话加档位开关，改这一处即可（判定的真源仍在 lib/tavern/styleFit）。
   */
  const styleFitWarning = useMemo(() => checkStyleFit({
    styleHint: effectiveStyleHint(styleHint, 'chat'),
    castRatings: slots
      .filter(s => !!s.charId)
      .map(s => scoped.find(o => o.id === s.charId)?.rating ?? '')
      .filter(Boolean),
  }), [styleHint, slots, scoped])
  const aiIds = slots.filter(s => s.role === 'ai' && s.charId).map(s => s.charId)
  /**
   * AI 名额按「**标了 AI 演的位置数**」算 —— 不是按"已选角色的"算。
   * 🔴 为什么必须这样：新增位置默认就是「AI 演」，若只数已选的，就会出现
   *   「6 个已选 + 2 个空位（都是 AI 演）」→ 再填满 → 8 个 AI → `planFreeSessionCast`
   *   按 `MAX_AI_CAST` 截断 ⇒ **静默丢掉两个角色**（界面还显示 8 个）。
   *   按位置数封顶则根本到不了那个状态。
   */
  const aiSlotCount = slots.filter(s => s.role === 'ai').length
  const aiSlotsFull = aiSlotCount >= MAX_AI_CAST
  const canStart = !!storyId && aiIds.length >= 1
  const hint = !storyId
    ? '先选一个故事（世界观由它提供）'
    : (canStart ? '' : (charIds.length === 0 ? '给位置 1 选一个角色' : '至少要有一个位置是「AI 演」'))

  const addSlot = () => setSlots(prev => (
    prev.length >= MAX_CAST_SLOTS || aiSlotsFull ? prev : [...prev, { charId: '', role: 'ai' }]))
  const removeSlot = (i: number) => setSlots(prev => (prev.length <= 1 ? prev : prev.filter((_, k) => k !== i)))
  const clearSlot = (i: number) => setSlots(prev => prev.map((s, k) => (k === i ? { ...s, charId: '' } : s)))
  const applyPick = (i: number, id: string) => {
    setSlots(prev => prev.map((s, k) => (k === i ? { ...s, charId: id } : s)))
    setPickerIdx(null)
  }
  /** 改由谁演：**「我演」只能有一个** —— 设第二个时把前一个改回 AI 演（角色不丢，只是换了谁演） */
  const setSlotRole = (i: number, role: Slot['role']) => setSlots(prev => prev.map((s, k) => {
    if (k === i) return { ...s, role }
    if (role === 'user' && s.role === 'user') return { ...s, role: 'ai' }
    return s
  }))

  const submit = () => {
    if (!canStart) return
    onCreate({ charIds, userCharId, title: title.trim(), scriptId, storyId })
  }

  const pickerCurrent = pickerIdx === null ? '' : slots[pickerIdx]?.charId ?? ''
  // 渲染期派生（2026-10-04 六维审计 A5）：依赖写成 `slots` / `scoped`，**不写**每渲染都重建的 `aiIds` / `nameOf`
  // —— 否则依赖恒变、memo 形同虚设。收敛后：标题输入等无关 state 变化时不再重算 `scoped.find`。
  const aiNames = useMemo(
    () => slots.filter(s => s.role === 'ai' && s.charId).map(s => scoped.find(o => o.id === s.charId)?.name ?? '').filter(Boolean),
    [slots, scoped],
  )
  const userNames = useMemo(
    () => slots.filter(s => s.role === 'user' && s.charId).map(s => scoped.find(o => o.id === s.charId)?.name ?? '').filter(Boolean),
    [slots, scoped],
  )

  return (
    <>
      <Modal
        open={open} onClose={onCancel} title="新建对话" width="xl"
        footer={
          <div className="flex items-center justify-between gap-3 w-full">
            <span className="text-11 text-ink-500">{hint || '准备就绪'}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="md" onClick={onCancel}>取消</Button>
              <Button variant="primary" size="md" disabled={!canStart} onClick={submit}>开始对话</Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {loading ? (
            <div className="py-8 text-center text-12 text-ink-500">正在读取角色卡…</div>
          ) : (
            <>
              {/* ⓪ 故事（必选）—— 老大 2026-09-16 定：建故事是使用自由对话的第一步 */}
              <section>
                <div className={labelCls}>⓪ 选择故事（必选）</div>
                {stories.length === 0 ? (
                  <div className="rounded-md border border-amber/30 bg-amber/8 px-3 py-3 text-12 leading-relaxed text-ink-300">
                    还没有故事 —— 先去「<b className="text-ink-100">故事剧本</b>」建一个：
                    故事决定这个世界什么样（时代、地点、规则），角色卡与剧本都挂在它下面。
                    没有故事，角色就不知道自己活在哪个世界。
                  </div>
                ) : (
                  <>
                    <select
                      className={`${selCls} w-full`}
                      value={storyId}
                      onChange={e => void pickStory(e.target.value)}
                    >
                      <option value="">请选择一个故事…</option>
                      {stories.map(s => (
                        <option key={s.id} value={s.id}>{storyDisplayName(s)}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-11 leading-relaxed text-ink-500">
                      这一场的世界观由选中的故事提供（每轮都注入）。选定后，下面只能挑这个故事下的角色 ——
                      换故事会清空已选的角与剧本，免得开出「人不对世界」的戏。
                    </p>
                  </>
                )}
              </section>

              {/* ① 角色分配（位置槽位 + 由谁演） */}
              <section>
                <div className={labelCls}>① 角色分配</div>
                {!storyId ? (
                  <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-12 text-ink-500">
                    先在上面选一个故事，这里才会列出它旗下的角色。
                  </div>
                ) : scoped.length === 0 ? (
                  <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-12 text-ink-400">
                    这个故事下还没有角色卡。先去「角色卡片」建一张（建卡时会让你选归属故事）——
                    填好第 4 章「示例对话」Ta会立刻像那个人。
                  </div>
                ) : (
                  <>
                    <p className="mb-2 text-11 leading-relaxed text-ink-500">
                      每个位置先选角色，再定由谁演。默认你演你自己；把某个位置改成「我演」，
                      AI 就会知道自己在跟谁对话（不会再把对面当成一个模糊的「用户」），
                      而且不会代写那个人的言行。「我演」最多一个。
                      多个 AI 角色则同场（最多 {MAX_AI_CAST} 个 AI）：一次只让一个说话，
                      轮到谁由语境决定，也能在会话顶部点头像指定下一位。
                      分饰的人越多越考较模型、等待也相应变长 —— 三四个通常是平衡点。
                      记忆按角色共享：换个会话不会重来。
                    </p>
                    <div className="space-y-2">
                      {slots.map((s, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-3 py-2">
                          <span className="w-12 shrink-0 text-11 text-ink-500">位置 {i + 1}</span>
                          {s.charId ? (
                            <>
                              <span className="min-w-0 flex-1 truncate text-12 text-ink-100">
                                {nameOf(s.charId) || '（角色已删除）'}
                                {coreOf(s.charId) && <span className="ml-2 text-10 text-ink-500">{coreOf(s.charId)}</span>}
                              </span>
                              <select
                                className={selCls} value={s.role}
                                onChange={e => setSlotRole(i, e.target.value as Slot['role'])}
                              >
                                <option value="ai" disabled={aiSlotsFull && s.role !== 'ai'}>AI 演</option>
                                <option value="user">我演</option>
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
                              <span className="shrink-0 text-10 text-ink-500">拟：{s.role === 'user' ? '我演' : 'AI 演'}</span>
                              {slots.length > 1 && (
                                <Button variant="secondary" size="md" className="shrink-0" onClick={() => removeSlot(i)}>移除位置</Button>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <Button variant="secondary" size="md"
                        disabled={slots.length >= MAX_CAST_SLOTS || aiSlotsFull}
                        title={aiSlotsFull ? `AI 演的名额已满（最多 ${MAX_AI_CAST} 个）` : ''}
                        onClick={addSlot}>
                        ＋ 增加位置（最多 {MAX_CAST_SLOTS} 个）
                      </Button>
                      <span className="text-11 text-ink-500">
                        {aiSlotsFull
                          ? `AI 演名额已满（${MAX_AI_CAST} 个）—— 想再加人，先把某个位置改成「我演」或删掉一个`
                          : (userNames.length
                            ? `你演 ${userNames.join('、')} · AI 演 ${aiNames.join('、') || '（还没定）'}`
                            : `${callName ? `你以「${callName}」的身份说话` : '你演你自己'} · AI 演 ${aiNames.join('、') || '（还没定）'}`)}
                      </span>
                    </div>
                    {/* 没设「我演」时说清后果 —— 老大明确问过「AI 到底在跟谁说话」 */}
                    {userNames.length === 0 && (
                      <p className="mt-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2 text-11 leading-relaxed text-ink-400">
                        {callName
                          ? <>当前没有你演的角色：AI 会按「我的档案」把你当作 <b className="text-ink-200">{callName}</b> 来对话 —— 称呼、亲疏、距离都照档案来。想改用某个角色出场，就把某个位置设成「我演」。</>
                          : <>当前没有你演的角色：AI 会把你当作<b className="text-ink-300">没有具体身份的「本人」</b> —— 它不会替你编一个角色，也就不知道在跟谁说话（称呼、亲疏、距离都无从针对）。到「控制面板 → <b className="text-ink-200">我的档案</b>」填一份档案（名字 + 称呼 + 一句话自我设定），AI 就知道对面是谁了；也可以把某个位置设成「我演」。</>}
                      </p>
                    )}
                  </>
                )}
              </section>

              {/* ② 剧本（可留空）—— 原先的五格手填已搬进「剧本编辑」 */}
              <section>
                <div className={labelCls}>② 剧本（可留空）</div>
                {!storyId ? (
                  <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-12 text-ink-500">
                    先在上面选一个故事，这里才会列出它旗下的剧本。
                  </div>
                ) : (
                <>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className={`${selCls} min-w-0 flex-1`}
                    value={scriptId}
                    onChange={e => void pickScript(e.target.value)}
                  >
                    <option value="">不设剧本（留空）—— 直接开口聊</option>
                    {scripts.map(it => (
                      <option key={it.id} value={it.id}>
                        {it.name}{it.goalBrief ? ` —— ${it.goalBrief}` : ''}
                      </option>
                    ))}
                  </select>
                  <Button variant="secondary" size="md" className="shrink-0" onClick={() => setScriptOpen(true)}>
                    ＋ 新建剧本
                  </Button>
                </div>

                {scriptView ? (
                  <div className="mt-2 rounded-md border border-ink-700 bg-ink-900/40 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-12 text-amber">{scriptDisplayName(scriptView)}</span>
                      <Button variant="secondary" size="xs"
                        onClick={() => void pickScript('')} className="shrink-0"
                      >
                        取消引用
                      </Button>
                    </div>
                    <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-10 leading-relaxed text-ink-400">
                      {scriptToText(snapshotOf(scriptView)) || '（这份剧本六栏是空的，等于没设）'}
                    </pre>
                    {scriptView.opening.trim() && (
                      <div className="mt-2 border-t border-ink-700 pt-1.5">
                        <div className="text-10 text-ink-500">开场白（会作为「开场」单独显示在对话最上方）：</div>
                        <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-10 leading-relaxed text-ink-400">
                          {scriptView.opening.trim()}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-1 text-11 leading-relaxed text-ink-500">
                    {scriptId
                      ? '这份剧本读不到了（可能刚被删）—— 换成「留空」或另选一份。'
                      : '留空 = 没有开场白，你直接说第一句（旧行为）。选一份剧本则自动带出情境、你的位置、目标与禁区；开场白会作为「开场」单独显示在对话最上方 —— 它不是你说的、也不是 AI 说的。剧本的「情境」只描述此刻；背景归角色卡的「角色与设定的关系」与它所属故事的「世界设定」—— 别互相抄。'}
                  </p>
                )}

                {scripts.length === 0 && !scriptId && (
                  <p className="mt-1 text-10 leading-relaxed text-ink-600">
                    还没有剧本。点「＋ 新建剧本」就地写一份，或到「故事剧本」页签慢慢打磨。
                  </p>
                )}
                {!scriptId && (
                  <p className="mt-1.5 text-10 leading-relaxed text-ink-600">
                    会话保存的是「引用那一刻的快照」：以后你改这份剧本，这场对话的设定不会跟着变。
                  </p>
                )}
                </>
                )}
              </section>

              {/* ③ 标题 */}
              <section>
                <div className={labelCls}>会话标题（可留空）</div>
                <input
                  className={inputCls} value={title} onChange={e => setTitle(e.target.value)}
                  placeholder={aiNames.length > 1 ? `默认：与${aiNames.join('、')}的对话` : `默认：和${aiNames[0] ?? '……'}的对话`}
                />
              </section>

              {/* 档案 ↔ 阵容自检（W3-4 / §13 F4）：**非阻断**，作者可无视照常开始 */}
              {fitWarning && (
                <section className="rounded-md border border-amber/30 bg-amber/8 px-3 py-2 text-11 leading-relaxed text-ink-300">
                  <b className="text-amber">⚠️ 档案提醒（可忽略）</b>
                  <div className="mt-0.5">{fitWarning.text}</div>
                </section>
              )}

              {/* 风格提示 ↔ 角色卡尺度冲突（W4-2 / §13 F6）：同样**非阻断** */}
              {styleFitWarning && (
                <section className="rounded-md border border-amber/30 bg-amber/8 px-3 py-2 text-11 leading-relaxed text-ink-300">
                  <b className="text-amber">⚠️ 风格提醒（可忽略）</b>
                  <div className="mt-0.5">{styleFitWarning.text}</div>
                </section>
              )}
            </>
          )}
        </div>
      </Modal>

      {open && scriptOpen && (
        <TavernScriptDialog
          open
          storyId={storyId}
          onClose={() => setScriptOpen(false)}
          onSaved={async saved => {
            setScripts(await listScriptsByStory(storyId))
            await pickScript(saved.id)
          }}
        />
      )}

      {open && pickerIdx !== null && (
        <CharPicker
          open
          options={scoped}
          usedBy={usedBy}
          currentId={pickerCurrent}
          onConfirm={id => applyPick(pickerIdx, id)}
          onClose={() => setPickerIdx(null)}
        />
      )}
    </>
  )
}
