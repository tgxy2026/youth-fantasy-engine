/**
 * 酒馆模式 · 新建对话（自由模式）
 *
 * 版式对齐「新建推演」（`TavernPlotSetup`）：**位置槽位选角 + 对话内容设置**。
 * 两处差异是有意的：
 *   · **没有叙事锚点** —— 自由模式不绑小说项目，谈不上「截到第几章」，所以整段去掉；
 *   · **没有「我演 / 在场不出声」** —— 自由对话里用户永远是自己，位置只表示「由 AI 演的角色」。
 *
 * 上限沿用引擎侧的多角色同场上限（3）：一轮里让模型分饰 N 个人，N 越大越容易串味，
 * 单轮输出也越长、等待越久 —— 与剧情模式同一条理由，写在界面上而不是埋在代码里。
 */
import { useEffect, useMemo, useState } from 'react'
import * as store from '../lib/tavern/store'
import { Button } from './Button'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import type { TavernScene } from '../lib/tavern/types'

export type FreeDraft = {
  charIds: string[]
  title: string
  scene: TavernScene
  /** 开场的第一句话（可留空，之后在对话里说也行） */
  firstLine: string
}

interface Props {
  open: boolean
  onCreate: (draft: FreeDraft) => void
  onCancel: () => void
}

/** 位置上限 = 多角色同场上限（引擎侧同样按 3 处理） */
const MAX_SLOTS = 3

const inputCls = 'w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50'
const labelCls = 'text-[11px] text-ink-400 mb-1'

/** 选角用的条目：名字 + 内核一句话（用来分辨同名/相似的角色） */
type CharOption = { id: string; name: string; core: string }

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
          <span className="text-[11px] text-ink-500">{picked ? `已选：${picked.name || '（未命名）'}` : '还没选角色'}</span>
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
        <div className="max-h-64 overflow-y-auto rounded-md border border-ink-700 divide-y divide-ink-800">
          {rows.map(o => {
            const used = usedBy[o.id]
            const disabled = used !== undefined && o.id !== currentId
            return (
              <button
                key={o.id} type="button" disabled={disabled} onClick={() => setCardId(o.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  disabled ? 'cursor-not-allowed opacity-40'
                    : cardId === o.id ? 'bg-amber/10' : 'hover:bg-ink-800/60'
                }`}
              >
                <span className={`min-w-0 shrink-0 text-[12.5px] ${cardId === o.id ? 'text-amber' : 'text-ink-200'}`}>
                  {o.name || '（未命名）'}
                </span>
                <span className="min-w-0 flex-1 truncate text-right text-[10.5px] text-ink-500">
                  {disabled ? `已在位置 ${used}` : o.core}
                </span>
              </button>
            )
          })}
          {rows.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-ink-500">
              {options.length === 0 ? '还没有角色卡 —— 先去「角色卡片」建一张。' : '没有匹配的角色。'}
            </div>
          )}
        </div>
        <p className="text-[10.5px] text-ink-500">共 {options.length} 个角色 · 命中 {rows.length} 个</p>
      </div>
    </Modal>
  )
}

export default function TavernFreeSetup({ open, onCreate, onCancel }: Props) {
  const [options, setOptions] = useState<CharOption[]>([])
  const [loading, setLoading] = useState(true)

  /** 位置：每个槽位存一个 charId，'' = 空位 */
  const [slots, setSlots] = useState<string[]>([''])
  const [pickerIdx, setPickerIdx] = useState<number | null>(null)

  const [title, setTitle] = useState('')
  const [place, setPlace] = useState('')
  const [time, setTime] = useState('')
  const [present, setPresent] = useState('')
  const [description, setDescription] = useState('')
  const [firstLine, setFirstLine] = useState('')

  // 打开时读角色卡（并重置成白纸）
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setSlots(['']); setPickerIdx(null)
    setTitle(''); setPlace(''); setTime(''); setPresent(''); setDescription(''); setFirstLine('')
    ;(async () => {
      try {
        const idx = await store.listFreeChars()
        // 逐个读完整卡拿「内核」那一句：选角色时能一眼分清（读失败就留空，不影响选）
        const full = await Promise.all(idx.map(async it => {
          const card = await store.getFreeChar(it.id).catch(() => null)
          return { id: it.id, name: it.name, core: (card?.profile.core ?? '').trim().replace(/\s+/g, ' ').slice(0, 28) }
        }))
        if (!alive) return
        setOptions(full)
      } catch {
        if (alive) setOptions([])
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [open])

  const nameOf = (id: string) => options.find(o => o.id === id)?.name ?? ''
  const coreOf = (id: string) => options.find(o => o.id === id)?.core ?? ''

  /** charId → 占用它的位置序号（1 起） */
  const usedBy = useMemo(() => {
    const m: Record<string, number> = {}
    slots.forEach((id, i) => { if (id) m[id] = i + 1 })
    return m
  }, [slots])

  const charIds = slots.filter(Boolean)
  const canStart = charIds.length >= 1
  const hint = canStart ? '' : '先给位置 1 选一个角色'

  const addSlot = () => setSlots(prev => (prev.length >= MAX_SLOTS ? prev : [...prev, '']))
  const removeSlot = (i: number) => setSlots(prev => (prev.length <= 1 ? prev : prev.filter((_, k) => k !== i)))
  const clearSlot = (i: number) => setSlots(prev => prev.map((id, k) => (k === i ? '' : id)))
  const applyPick = (i: number, id: string) => {
    setSlots(prev => prev.map((x, k) => (k === i ? id : x)))
    setPickerIdx(null)
  }

  const submit = () => {
    if (!canStart) return
    onCreate({
      charIds,
      title: title.trim(),
      scene: {
        place: place.trim(),
        time: time.trim(),
        present: present.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean),
        description: description.trim(),
      },
      firstLine: firstLine.trim(),
    })
  }

  const pickerCurrent = pickerIdx === null ? '' : slots[pickerIdx]

  return (
    <>
      <Modal
        open={open} onClose={onCancel} title="新建对话" width="xl"
        footer={
          <div className="flex items-center justify-between gap-3 w-full">
            <span className="text-[11px] text-ink-500">{hint || `准备就绪 · ${charIds.length} 个角色`}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="md" onClick={onCancel}>取消</Button>
              <Button variant="primary" size="md" disabled={!canStart} onClick={submit}>开始对话</Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {loading ? (
            <div className="py-8 text-center text-[12px] text-ink-500">正在读取角色卡…</div>
          ) : (
            <>
              {/* ① 角色分配（位置槽位） */}
              <section>
                <div className={labelCls}>① 角色分配</div>
                {options.length === 0 ? (
                  <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-[12px] text-ink-400">
                    还没有角色卡。先去「角色卡片」建一张 —— 填好第 4 章「示例对话」她会立刻像那个人。
                  </div>
                ) : (
                  <>
                    <p className="mb-2 text-[11px] leading-relaxed text-ink-500">
                      一个位置就是单角色聊天；多选几个则**多角色同场**：一次只让一个角色说话，
                      轮到谁由语境决定，也能在会话顶部点头像指定下一位。最多 {MAX_SLOTS} 个
                      —— 再多，一轮里要分饰太多人，角色容易串味、等待也明显变长。
                      （记忆按角色共享：换个会话不会让她重来。）
                    </p>
                    <div className="space-y-2">
                      {slots.map((id, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-3 py-2">
                          <span className="w-12 shrink-0 text-[11px] text-ink-500">位置 {i + 1}</span>
                          {id ? (
                            <>
                              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">
                                {nameOf(id) || '（角色已删除）'}
                                {coreOf(id) && <span className="ml-2 text-[10.5px] text-ink-500">{coreOf(id)}</span>}
                              </span>
                              <Button variant="ghost" size="md" className="shrink-0 text-[12px]" onClick={() => setPickerIdx(i)}>更换</Button>
                              <Button variant="ghost" size="md" className="shrink-0 text-[12px]" onClick={() => clearSlot(i)}>清空</Button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button" onClick={() => setPickerIdx(i)}
                                className="min-w-0 flex-1 truncate rounded-md border border-dashed border-ink-700 px-2 py-1 text-left text-[12px] text-ink-500 transition-colors hover:border-amber/40 hover:text-amber"
                              >
                                ＋ 选择角色
                              </button>
                              {slots.length > 1 && (
                                <Button variant="ghost" size="md" className="shrink-0 text-[12px]" onClick={() => removeSlot(i)}>移除位置</Button>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <Button variant="ghost" size="md" className="text-[12px]" disabled={slots.length >= MAX_SLOTS} onClick={addSlot}>
                        ＋ 增加角色（最多 {MAX_SLOTS} 个）
                      </Button>
                      <span className="text-[11px] text-ink-500">当前：{charIds.length} 个角色</span>
                    </div>
                  </>
                )}
              </section>

              {/* ② 对话内容 */}
              <section>
                <div className={labelCls}>② 对话内容（可全留空）</div>
                <div className="grid grid-cols-2 gap-2">
                  <input className={inputCls} placeholder="地点（如便利店 · 深夜的公寓）" value={place} onChange={e => setPlace(e.target.value)} />
                  <input className={inputCls} placeholder="时间（如凌晨两点 · 周六午后）" value={time} onChange={e => setTime(e.target.value)} />
                </div>
                <input className={`${inputCls} mt-2`} placeholder="在场人物（顿号分隔，可留空）" value={present} onChange={e => setPresent(e.target.value)} />
                <AutoTextarea className="mt-2 bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                  textClass="text-sm" minRows={3} maxHeight={320}
                  placeholder="场景描述（你们此刻在做什么、气氛如何）"
                  value={description} onChange={setDescription} />
                <AutoTextarea className="mt-2 bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50"
                  textClass="text-sm" minRows={2} maxHeight={240}
                  placeholder="你的第一句话（可留空，之后再开口也行）"
                  value={firstLine} onChange={setFirstLine} />
                <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                  上面这些会渲染成开场的第一条消息，让第一轮就有场景感；全留空也能直接开口聊。
                  它**不是**小说项目的锚点 —— 自由模式不绑项目，这里只影响第一轮的语境。
                </p>
              </section>

              {/* ③ 标题 */}
              <section>
                <div className={labelCls}>会话标题（可留空）</div>
                <input
                  className={inputCls} value={title} onChange={e => setTitle(e.target.value)}
                  placeholder={charIds.length > 1
                    ? `默认：与${charIds.map(nameOf).filter(Boolean).join('、') || '……'}的对话`
                    : `默认：和${nameOf(charIds[0]) || '……'}的对话`}
                />
              </section>
            </>
          )}
        </div>
      </Modal>

      {open && pickerIdx !== null && (
        <CharPicker
          open
          options={options}
          usedBy={usedBy}
          currentId={pickerCurrent}
          onConfirm={id => applyPick(pickerIdx, id)}
          onClose={() => setPickerIdx(null)}
        />
      )}
    </>
  )
}
