/**
 * 酒馆模式 · 新建对话（自由模式）
 *
 * 版式对齐「新建推演」（`TavernPlotSetup`）：**位置槽位选角 + 对话内容设置**。
 * 差异有三：
 *   · **没有叙事锚点** —— 自由模式不绑小说项目，谈不上「截到第几章」，所以整段去掉；
 *   · **没有「在场不出声」** —— 自由对话是两个人的话，没开口的角色等于不在场；
 *   · **每个位置可以选「我演」**（最多一个）—— 默认你演你自己，
 *     但也可以反过来：你演苏念、AI 演楚楠。选了之后 AI 才知道自己**在跟谁**对话，
 *     并且不会代写那个人的言行（见 `engine.buildFreeSystem` 的身份层）。
 *   · 「你演你自己」也不再是「没有身份」：控制面板的**「我的档案」**（全局、跨项目）
 *     会在这种时候作为用户本人的身份注入（名字 / 称呼 / 一句话自我设定）。
 *
 * 上限沿用引擎侧的多角色同场上限（3）：一轮里让模型分饰 N 个人，N 越大越容易串味，
 * 单轮输出也越长、等待越久 —— 与剧情模式同一条理由，写在界面上而不是埋在代码里。
 *
 * 【2026-09-14 第四轮改动：「对话内容」抽成「剧本」】
 * 原先这里有五格手填（地点/时间/在场/场景描述/第一句话），**填完就丢** ——
 * 想复用一场戏只能凭记忆重填一遍。现在这几格搬进「剧本编辑」（六栏、可命名、可复用），
 * 这里只留一个**选择器**：留空（直接开口聊）或引用一份已有剧本。
 * 这样做还顺带解决一个隐患：手填的内容原本只进开场第一条消息、不进 system，
 * 剧本则把「情境/你的位置/目标/禁区」放进 system（每轮都在），开场白仍走消息通道 —— 分工更清楚。
 */
import { useEffect, useMemo, useState } from 'react'
import * as store from '../lib/tavern/store'
import { getTavernSettings, DEFAULT_TAVERN_SETTINGS } from '../lib/tavern/settings'
import { Button } from './Button'
import { Modal } from './Modal'
import Avatar from './Avatar'
import TavernScriptDialog from './TavernScriptDialog'
import {
  listScripts, getScript, scriptToText, snapshotOf, scriptDisplayName,
} from '../lib/tavern/script'
import type { TavernScript, TavernScriptIndexItem } from '../lib/tavern/types'

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
}

interface Props {
  open: boolean
  onCreate: (draft: FreeDraft) => void
  onCancel: () => void
}

/** 位置上限 = 多角色同场上限（引擎侧同样按 3 处理） */
const MAX_SLOTS = 3

const inputCls = 'w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-sm text-ink-100 outline-none focus:border-amber/50'
const selCls = 'shrink-0 bg-ink-900 border border-ink-700 rounded-md px-2 py-1 text-[12px] text-ink-100 outline-none focus:border-amber/50'
const labelCls = 'text-[11px] text-ink-400 mb-1'

/** 选角用的条目：名字 + 内核一句话（用来分辨相似的角色） */
type CharOption = { id: string; name: string; core: string; avatar?: string }

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
                <Avatar src={o.avatar} name={o.name} size={20} />
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
  /** 「我的档案」里的称呼/名字（空 = 没填档案）—— 只用来把「AI 已经知道你是谁」讲清楚 */
  const [callName, setCallName] = useState('')

  const [slots, setSlots] = useState<Slot[]>(() => freshSlots())
  const [pickerIdx, setPickerIdx] = useState<number | null>(null)

  const [title, setTitle] = useState('')
  /** 剧本列表（索引项）与当前选中的那份全文（用于预览） */
  const [scripts, setScripts] = useState<TavernScriptIndexItem[]>([])
  const [scriptId, setScriptId] = useState('')
  const [scriptView, setScriptView] = useState<TavernScript | null>(null)
  const [scriptOpen, setScriptOpen] = useState(false)

  // 打开时读角色卡（并重置成白纸）
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setSlots(freshSlots()); setPickerIdx(null); setCallName('')
    setTitle(''); setScriptId(''); setScriptView(null); setScriptOpen(false)
    ;(async () => {
      try {
        const [idx, st, sc] = await Promise.all([
          store.listFreeChars(),
          getTavernSettings().catch(() => DEFAULT_TAVERN_SETTINGS),
          listScripts().catch(() => [] as TavernScriptIndexItem[]),
        ])
        // 逐个读完整卡拿「内核」那一句：选角色时能一眼分清（读失败就留空，不影响选）
        const full = await Promise.all(idx.map(async it => {
          const card = await store.getFreeChar(it.id).catch(() => null)
          return { id: it.id, name: it.name, avatar: card?.avatar, core: (card?.profile.core ?? '').trim().replace(/\s+/g, ' ').slice(0, 28) }
        }))
        if (!alive) return
        setOptions(full)
        setScripts(sc)
        // 「我的档案」有名字 → 界面可以明确讲「AI 已经知道你是谁」。
        // 这正是「默认『我演』的角色」被去掉之后的补偿：**不用选角色也有身份**。
        setCallName(st.profile.address.trim() || st.profile.name.trim())
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

  const nameOf = (id: string) => options.find(o => o.id === id)?.name ?? ''
  const coreOf = (id: string) => options.find(o => o.id === id)?.core ?? ''

  /** charId → 占用它的位置序号（1 起） */
  const usedBy = useMemo(() => {
    const m: Record<string, number> = {}
    slots.forEach((s, i) => { if (s.charId) m[s.charId] = i + 1 })
    return m
  }, [slots])

  const charIds = slots.map(s => s.charId).filter(Boolean)
  const userCharId = slots.find(s => s.role === 'user' && s.charId)?.charId ?? ''
  const aiIds = slots.filter(s => s.role === 'ai' && s.charId).map(s => s.charId)
  const canStart = aiIds.length >= 1
  const hint = canStart ? '' : (charIds.length === 0 ? '先给位置 1 选一个角色' : '至少要有一个位置是「AI 演」')

  const addSlot = () => setSlots(prev => (prev.length >= MAX_SLOTS ? prev : [...prev, { charId: '', role: 'ai' }]))
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
    onCreate({ charIds, userCharId, title: title.trim(), scriptId })
  }

  const pickerCurrent = pickerIdx === null ? '' : slots[pickerIdx]?.charId ?? ''
  const aiNames = aiIds.map(nameOf).filter(Boolean)
  const userNames = slots.filter(s => s.role === 'user' && s.charId).map(s => nameOf(s.charId)).filter(Boolean)

  return (
    <>
      <Modal
        open={open} onClose={onCancel} title="新建对话" width="xl"
        footer={
          <div className="flex items-center justify-between gap-3 w-full">
            <span className="text-[11px] text-ink-500">{hint || '准备就绪'}</span>
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
              {/* ① 角色分配（位置槽位 + 由谁演） */}
              <section>
                <div className={labelCls}>① 角色分配</div>
                {options.length === 0 ? (
                  <div className="rounded-md border border-ink-700 bg-ink-850/60 px-3 py-3 text-[12px] text-ink-400">
                    还没有角色卡。先去「角色卡片」建一张 —— 填好第 4 章「示例对话」Ta会立刻像那个人。
                  </div>
                ) : (
                  <>
                    <p className="mb-2 text-[11px] leading-relaxed text-ink-500">
                      每个位置先选角色，再定由谁演。默认你演你自己；把某个位置改成「我演」，
                      AI 就会知道自己在跟谁对话（不会再把对面当成一个模糊的「用户」），
                      而且不会代写那个人的言行。「我演」最多一个。
                      多个 AI 角色则同场：一次只让一个说话，轮到谁由语境决定，
                      也能在会话顶部点头像指定下一位（最多 {MAX_SLOTS} 个 —— 再多，一轮里要分饰太多人，
                      角色容易串味、等待也明显变长）。记忆按角色共享：换个会话不会重来。
                    </p>
                    <div className="space-y-2">
                      {slots.map((s, i) => (
                        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-ink-700 bg-ink-900/40 px-3 py-2">
                          <span className="w-12 shrink-0 text-[11px] text-ink-500">位置 {i + 1}</span>
                          {s.charId ? (
                            <>
                              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">
                                {nameOf(s.charId) || '（角色已删除）'}
                                {coreOf(s.charId) && <span className="ml-2 text-[10.5px] text-ink-500">{coreOf(s.charId)}</span>}
                              </span>
                              <select
                                className={selCls} value={s.role}
                                onChange={e => setSlotRole(i, e.target.value as Slot['role'])}
                              >
                                <option value="ai">AI 演</option>
                                <option value="user">我演</option>
                              </select>
                              <Button variant="secondary" size="md" className="shrink-0 text-[12px]" onClick={() => setPickerIdx(i)}>更换</Button>
                              <Button variant="secondary" size="md" className="shrink-0 text-[12px]" onClick={() => clearSlot(i)}>清空</Button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button" onClick={() => setPickerIdx(i)}
                                className="min-w-0 flex-1 truncate rounded-md border border-dashed border-ink-700 px-2 py-1 text-left text-[12px] text-ink-500 transition-colors hover:border-amber/40 hover:text-amber"
                              >
                                ＋ 选择角色
                              </button>
                              <span className="shrink-0 text-[10.5px] text-ink-500">拟：{s.role === 'user' ? '我演' : 'AI 演'}</span>
                              {slots.length > 1 && (
                                <Button variant="secondary" size="md" className="shrink-0 text-[12px]" onClick={() => removeSlot(i)}>移除位置</Button>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                      <Button variant="secondary" size="md" className="text-[12px]" disabled={slots.length >= MAX_SLOTS} onClick={addSlot}>
                        ＋ 增加位置（最多 {MAX_SLOTS} 个）
                      </Button>
                      <span className="text-[11px] text-ink-500">
                        {userNames.length
                          ? `你演 ${userNames.join('、')} · AI 演 ${aiNames.join('、') || '（还没定）'}`
                          : `${callName ? `你以「${callName}」的身份说话` : '你演你自己'} · AI 演 ${aiNames.join('、') || '（还没定）'}`}
                      </span>
                    </div>
                    {/* 没设「我演」时说清后果 —— 老大明确问过「AI 到底在跟谁说话」 */}
                    {userNames.length === 0 && (
                      <p className="mt-2 rounded-md border border-ink-700 bg-ink-900/40 px-2.5 py-2 text-[11px] leading-relaxed text-ink-400">
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
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-amber">{scriptDisplayName(scriptView)}</span>
                      <Button variant="secondary" size="xs"
                        onClick={() => void pickScript('')} className="shrink-0"
                      >
                        取消引用
                      </Button>
                    </div>
                    <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink-400">
                      {scriptToText(snapshotOf(scriptView)) || '（这份剧本六栏是空的，等于没设）'}
                    </pre>
                    {scriptView.opening.trim() && (
                      <div className="mt-2 border-t border-ink-800 pt-1.5">
                        <div className="text-[10.5px] text-ink-500">开场白（会变成对话的第一条消息）：</div>
                        <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap text-[10.5px] leading-relaxed text-ink-400">
                          {scriptView.opening.trim()}
                        </pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
                    {scriptId
                      ? '这份剧本读不到了（可能刚被删）—— 换成「留空」或另选一份。'
                      : '留空 = 没有开场白，你直接说第一句（旧行为）。选一份剧本则自动带出情境、你的位置、目标与禁区；开场白会渲染成对话的第一条消息。剧本的「情境」只描述此刻，背景仍归角色卡与「背景设定」—— 三处别互相抄。'}
                  </p>
                )}

                {scripts.length === 0 && !scriptId && (
                  <p className="mt-1 text-[10.5px] leading-relaxed text-ink-600">
                    还没有剧本。点「＋ 新建剧本」就地写一份，或到「剧本编辑」页签慢慢打磨。
                  </p>
                )}
                {!scriptId && (
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-600">
                    会话保存的是「引用那一刻的快照」：以后你改这份剧本，这场对话的设定不会跟着变。
                  </p>
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
            </>
          )}
        </div>
      </Modal>

      {open && scriptOpen && (
        <TavernScriptDialog
          open
          onClose={() => setScriptOpen(false)}
          onSaved={async saved => {
            setScripts(await listScripts())
            await pickScript(saved.id)
          }}
        />
      )}

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
