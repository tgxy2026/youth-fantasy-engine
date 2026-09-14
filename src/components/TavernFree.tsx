/**
 * 酒馆模式 · 自由对话（tavern-free）
 *
 * 定位：**陪伴**。自建角色卡的长期对话 —— 记得住事、有时间流逝感、换场景可开新会话
 * （记忆按角色共享，不随会话走）。
 *
 * 【无服务端带来的三个 UI 义务（方案 §11 明确要求，不能吞掉）】
 *   1. 总结「不即时」—— 只能回复后判阈值、或下次打开补算。界面必须显示
 *      「记忆更新于 X」，让作者知道记忆的时效边界。
 *   2. 会话超长后早期原文会从上下文消失 —— 原文仍在记录里可翻回，
 *      但预算条要显示占用，别让作者以为模型还记得。
 *   3. 记忆是**角色级**的：换会话不会重来，所以新建会话时要说清这一点。
 *
 * 阶段：P2 范围（单角色对话 + 六栏记忆 + 总结触发）。
 * 多角色同场与发言调度（§7.3）、日常状态时间差推进（§7.4）、角色主动留言（§7.5）
 * 属 P3 —— 引擎层已就绪，界面留待 P3 接。
 *
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），
 * 提示用 showToast。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { loadProviders, type AIProvider } from '../lib/ai'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import { Modal } from './Modal'
import { LoadingState } from './LoadingState'
import { renderTavernMessage } from './TavernMessage'
import * as store from '../lib/tavern/store'
import { runFreeTurn } from '../lib/tavern/engine'
import { advanceDaily, shouldAdvanceDaily } from '../lib/tavern/daily'
import { summarizeMemory } from '../lib/tavern/summarize'
import {
  memoryChars, messagesAfterWatermark, nextWatermark, acquireSummaryLock, releaseSummaryLock,
  shouldRunAutoSummary, MEMORY_SECTIONS, isMemoryEmpty,
} from '../lib/tavern/memory'
import {
  type FreeCharacter, type FreeMemory, type FreeSession,
  type FreeSessionIndexItem, type TavernCharIndexItem, type DailyState,
} from '../lib/tavern/types'
import { getTavernSettings, memoryLimitsOf, DEFAULT_TAVERN_SETTINGS, type TavernSettings } from '../lib/tavern/settings'

/** 把时间戳显示成「刚刚 / X 分钟前 / X 小时前 / 日期」 */
function ago(ts: number): string {
  if (!ts) return '还没有记忆'
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export default function TavernFree() {
  // ---------- 数据 ----------
  const [chars, setChars] = useState<TavernCharIndexItem[]>([])
  const [charId, setCharId] = useState('')
  const [charCard, setCharCard] = useState<FreeCharacter | null>(null)
  const [sessions, setSessions] = useState<FreeSessionIndexItem[]>([])
  const [session, setSession] = useState<FreeSession | null>(null)
  const [memory, setMemory] = useState<FreeMemory | null>(null)
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [summaryProviderId, setSummaryProviderId] = useState('')

  // ---------- UI ----------
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [phase, setPhase] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  const [showMemory, setShowMemory] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  /** 她这几天的生活与心情（方案 §4.7：靠时间差推进，没有常驻进程） */
  const [daily, setDaily] = useState<DailyState | null>(null)
  const [showDaily, setShowDaily] = useState(false)
  /** 很久没来时她留着的一句话（§7.5），展示后清除 */
  const [greeting, setGreeting] = useState('')
  /** 新建会话：多角色同场（§7.3），v1 上限 3 人 */
  const [pickOpen, setPickOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  /** 本会话在场角色的完整卡（多角色渲染需要） */
  const [castCards, setCastCards] = useState<FreeCharacter[]>([])
  /** 手动指定下一位接话的角色（空 = 按轮转） */
  const [speakNext, setSpeakNext] = useState('')
  /** 控制面板设置（记忆与日常阈值都从这儿来）—— 读不到时用出厂默认，不含糊 */
  const [tavernSettings, setTavernSettings] = useState<TavernSettings | null>(null)
  /** 会话名内联编辑：列表里只显示标题，改不了就只能删了重开，所以给个直接改的入口 */
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  /** 记忆与日常阈值（控制面板）。读到设置前先用出厂默认，免得界面闪一个错的数字。 */
  const lim = useMemo(
    () => memoryLimitsOf(tavernSettings ?? DEFAULT_TAVERN_SETTINGS),
    [tavernSettings],
  )

  // ---------- 加载 ----------
  useEffect(() => {
    void (async () => {
      try {
        const [cs, ps, sid, st] = await Promise.all([
          store.listFreeChars(),
          loadProviders().catch(() => [] as AIProvider[]),
          store.getSummaryProviderId().catch(() => ''),
          getTavernSettings().catch(() => DEFAULT_TAVERN_SETTINGS),
        ])
        setChars(cs)
        setProviders(ps)
        setSummaryProviderId(sid)
        setTavernSettings(st)
        if (cs.length > 0) setCharId(prev => prev || cs[0].id)
      } catch (e) {
        showToast(`读取失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // ---------- 日常推进与主动留言（§4.7 / §7.5） ----------
  /**
   * 距上次活跃够久就补写「这几天的生活」，并拿到她留的一句话。
   * 静默执行：失败不打扰（下次打开还会再试），也不阻塞对话。
   */
  const advanceIfNeeded = useCallback(async (card: FreeCharacter, cur?: DailyState | null) => {
    const d = cur ?? (await store.getDaily(card.id).catch(() => null))
    if (!shouldAdvanceDaily(d, Date.now(), lim.dailyAdvanceMs)) return
    if (!acquireSummaryLock()) return // 与总结共用一把锁，避免两个窗口同时写
    try {
      const mem = await store.getMemory(card.id).catch(() => null)
      const res = await advanceDaily({
        char: card,
        prev: d,
        memory: mem,
        providerId: summaryProviderId || undefined,
      })
      await store.saveDaily(res.state)
      setDaily(res.state)
      if (res.greeting) {
        await store.setGreeting(card.id, res.greeting)
        const g = await store.takeGreeting(card.id)
        if (g) setGreeting(g)
      }
    } catch {
      /* 静默：下次打开再试，不弹错打断作者 */
    } finally {
      releaseSummaryLock()
    }
  }, [summaryProviderId, lim])

  // 选中的角色 → 读完整卡 + 该角色的会话 + 它的记忆
  const loadForChar = useCallback(async (id: string) => {
    if (!id) return
    try {
      const [card, all, mem, day] = await Promise.all([
        store.getFreeChar(id),
        store.listFreeSessions(),
        store.getMemory(id).catch(() => null),
        store.getDaily(id).catch(() => null),
      ])
      setCharCard(card)
      setSessions(all.filter(s => s.charIds.includes(id)))
      setMemory(mem)
      setDaily(day)
      // 打开就补算「这几天的生活」（方案 §4.6 ② 的同一思路：无服务端只能靠打开时补）
      if (card) void advanceIfNeeded(card, day)
    } catch (e) {
      showToast(`读取角色失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [advanceIfNeeded])

  useEffect(() => {
    void loadForChar(charId)
    setSession(null)
    setStreamText('')
  }, [charId, loadForChar, advanceIfNeeded])

  const openSession = useCallback(async (id: string) => {
    const s = await store.getFreeSession(id)
    setSession(s)
    setStreamText('')
    if (!s) return
    // 在场角色的完整卡（多角色渲染与发言调度要用）
    try {
      const cards = (await Promise.all(s.charIds.map(cid => store.getFreeChar(cid)))).filter((c): c is FreeCharacter => !!c)
      setCastCards(cards)
      // 她留着的话：展示后即清除，不留着反复弹
      for (const c of cards) {
        const g = await store.takeGreeting(c.id)
        if (g) { setGreeting(g); break }
      }
    } catch { setCastCards([]) }
    // 打开即补算（方案 §4.6 ②：下次打开应用时扫描水位线补算 —— 这里在打开会话时做）
    void autoSummarize(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charCard])

  const createSession = useCallback(async (charIds?: string[]) => {
    if (!charCard) return
    // 参演角色与默认标题都由「本次最终选中的角色」推出（规则锁在 planFreeSessionCast 里）
    const { charIds: ids, title } = store.planFreeSessionCast(
      charIds ?? [],
      charCard.id,
      id => chars.find(c => c.id === id)?.name,
    )
    // 模型：跟随全局活动模型（会话级可再改）
    const active = providers.find(p => p.id === (session?.model.providerId ?? '')) ?? providers[0]
    try {
      const s = await store.createFreeSession(
        ids,
        title,
        { providerId: active?.id ?? '' },
        {},
      )
      setSession(s)
      setCastCards((await Promise.all(ids.map(id => store.getFreeChar(id)))).filter((c): c is FreeCharacter => !!c))
      await loadForChar(charCard.id)
      showToast(ids.length > 1
        ? '已新建多角色会话（发言顺序由语境决定，也可点顶部头像指定下一位）'
        : '已新建会话（记忆按角色共享，换会话不会重来）')
    } catch (e) {
      showToast(`新建失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [charCard, providers, session, loadForChar, chars])

  // ---------- 记忆总结 ----------
  /**
   * 跑一次总结。manual = 手动点「立即总结」（不受时间节流限制 —— 作者点了就该跑）。
   * 自动路径要过三道闸：新消息够不够 → 时间节流 → 跨实例锁。
   */
  const runSummary = useCallback(async (s: FreeSession, manual = false) => {
    if (!charCard) return
    const prev = await store.getMemory(charCard.id).catch(() => null)
    if (!manual) {
      const verdict = shouldRunAutoSummary(s, prev, Date.now(), {
        triggerMessages: lim.triggerMessages,
        minIntervalMs: lim.minIntervalMs,
      })
      if (!verdict.run) return
    }
    const pending = messagesAfterWatermark(s.messages, s.watermark)
    if (pending.length === 0) {
      if (manual) showToast('还没有新内容可整理', 'info')
      return
    }
    if (!acquireSummaryLock()) {
      if (manual) showToast('另一个窗口正在整理记忆', 'info')
      return
    }
    setSummarizing(true)
    try {
      const next = await summarizeMemory({
        charId: charCard.id,
        charName: charCard.name,
        prev,
        messages: pending,
        // 带上角色背景：不给的话模型会凭对话臆断「她在哪、是谁」，记忆从第一次就开始漂移
        charContext: [
          charCard.world.trim() && `世界：${charCard.world.trim()}`,
          charCard.profile.core.trim() && `内核：${charCard.profile.core.trim()}`,
          charCard.profile.cannot.trim() && `做不到的事：${charCard.profile.cannot.trim()}`,
          charCard.profile.knowledge.trim() && `知识边界：${charCard.profile.knowledge.trim()}`,
        ].filter(Boolean).join('\n'),
        providerId: summaryProviderId || undefined,
        limits: { longTermLimit: lim.longTermLimit, diaryDays: lim.diaryDays },
      })
      await store.saveMemory(next)
      // 水位线推进到最后一条 —— 关机/失败都不丢不重
      const wm = nextWatermark(s)
      const updated: FreeSession = { ...s, watermark: wm ?? s.watermark, updatedAt: Date.now() }
      await store.saveFreeSession(updated)
      setSession(cur => (cur && cur.id === updated.id ? updated : cur))
      setMemory(next)
      if (manual) showToast(`记忆已更新（${memoryChars(next)} 字）`)
    } catch (e) {
      // 失败保留旧档案，绝不写半截结果
      if (manual) showToast(`总结失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      releaseSummaryLock()
      setSummarizing(false)
    }
  }, [charCard, summaryProviderId, lim])

  /** 自动总结：静默，失败也不打扰（下次打开会补算） */
  const autoSummarize = useCallback(async (s: FreeSession) => {
    try { await runSummary(s, false) } catch { /* 静默 */ }
  }, [runSummary])

  /** 提交会话改名（Enter / 失焦保存，Esc 取消）。与原名相同则不写库、不提示。 */
  const saveTitle = useCallback(async () => {
    const cur = session
    setEditingTitle(false)
    if (!cur) return
    const nextTitle = titleDraft.trim()
    if (!nextTitle || nextTitle === cur.title) return
    const updated: FreeSession = { ...cur, title: nextTitle, updatedAt: Date.now() }
    try {
      await store.saveFreeSession(updated) // store 会一并更新索引里的标题
      setSession(s => (s && s.id === updated.id ? updated : s))
      setSessions(prev => prev.map(x => (x.id === updated.id ? { ...x, title: nextTitle, updatedAt: updated.updatedAt } : x)))
      showToast('已改名')
    } catch (e) {
      showToast(`改名失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [session, titleDraft])

  // ---------- 对话 ----------
  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || !session || !charCard || streaming) return
    setInput('')
    setStreaming(true)
    setStreamText('')
    setPhase('')
    // 立刻把这句话显示出来 —— 等整轮生成完才现身的话，中间那几十秒界面像没收到你说话。
    // 这里只是**预演**：runFreeTurn 内部会用 withUser 自己重建 messages，
    // 成功后用返回的 session 覆盖，失败则回滚并把文字还回输入框。
    const optimistic: FreeSession = {
      ...session,
      messages: [...session.messages, { id: `pending-${Date.now()}`, role: 'user', content: text, at: Date.now() }],
    }
    setSession(optimistic)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const cast = castCards.length ? castCards : [charCard]
      const res = await runFreeTurn(session, cast, text, {
        onToken: d => setStreamText(prev => prev + d),
        onPhase: p => setPhase(p),
        signal: ctrl.signal,
        speakerId: speakNext || undefined,
      })
      const saved = await store.saveFreeSession(res.session)
      setSession(saved)
      setStreamText('')
      await loadForChar(charCard.id)
      if (!res.cancelled) void autoSummarize(saved)
      if (res.fellBack) showToast('该会话指定的模型不可用，已回退到全局活动模型', 'info')
      // 说完这句就把她说的话撤掉：那句话是「很久没来」时才该有的
      setGreeting('')
      setSpeakNext('')
    } catch (e) {
      // 回滚：这句话没送出去，把它还回输入框，别让作者白打一遍
      setSession(session)
      setInput(text)
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setStreaming(false)
      setPhase('')
      abortRef.current = null
    }
  }, [input, session, charCard, streaming, loadForChar, autoSummarize, castCards, speakNext])

  const stop = () => { abortRef.current?.abort() }

  const removeSession = async () => {
    if (!session) return
    const okGo = await confirmDialog({
      title: '删除这个会话？',
      message: '对话记录会一并删除。\n注意：**她的记忆是按角色存的**，所以记忆不会跟着消失。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    await store.deleteFreeSession(session.id)
    setSession(null)
    if (charCard) await loadForChar(charCard.id)
    showToast('已删除会话')
  }

  const changeModel = async (providerId: string) => {
    if (!session) return
    const next = { ...session, model: { providerId }, updatedAt: Date.now() }
    await store.saveFreeSession(next)
    setSession(next)
    showToast('已切换本会话的模型')
  }

  const changeSummaryModel = async (id: string) => {
    setSummaryProviderId(id)
    await store.setSummaryProviderId(id)
    showToast(id ? '已指定总结模型' : '总结将跟随全局活动模型')
  }

  // ---------- 自动滚到底 ----------
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session?.messages.length, streamText])

  const usedChars = useMemo(() => {
    if (!session) return 0
    return session.messages.reduce((n, m) => n + m.content.length, 0)
  }, [session])

  const memChars = memory ? memoryChars(memory) : 0

  // ---------- 渲染 ----------
  if (loading) return <div className="page-enter"><LoadingState /></div>

  return (
    <div className="page-enter flex flex-col h-full">
      <header className="mb-3 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink-50">自由对话</h1>
            <p className="text-[12px] text-ink-400 mt-1">
              与自建角色的长期对话：记得住事、有时间流逝感、换场景可开新会话（记忆按角色共享）。
            </p>
          </div>
          {chars.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setShowSettings(v => !v)}>
              {showSettings ? '收起设置' : '模型设置'}
            </Button>
          )}
        </div>

        {showSettings && (
          <div className="mt-2 rounded-lg border border-ink-700 bg-ink-850/50 p-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-500">本会话模型</span>
              <select
                className="mt-1 w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-[12px] text-ink-100 outline-none"
                value={session?.model.providerId ?? ''}
                onChange={e => void changeModel(e.target.value)}
                disabled={!session}
              >
                <option value="">（未选择）</option>
                {providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">总结模型（整理记忆用，越快越省越好）</span>
              <select
                className="mt-1 w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-[12px] text-ink-100 outline-none"
                value={summaryProviderId}
                onChange={e => void changeSummaryModel(e.target.value)}
              >
                <option value="">跟随全局活动模型</option>
                {providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
              </select>
            </label>
          </div>
        )}
      </header>

      {chars.length === 0 ? (
        <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-6 py-12 text-center">
          <p className="text-[13px] text-ink-300">还没有角色可聊</p>
          <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
            先去「角色卡片」建一张卡 —— 填好第 4 章「示例对话」，她会立刻像那个人。
            <br />
            （从小说角色一键导入属 P3，还没开放）
          </p>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 gap-3">
          {/* 左栏 */}
          <aside className="w-52 shrink-0 flex flex-col gap-3 min-h-0">
            <div>
              <div className="text-[11px] text-ink-500 mb-1">角色</div>
              <ul className="space-y-1">
                {chars.map(c => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setCharId(c.id)}
                      className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                        charId === c.id ? 'bg-amber/15 border border-amber/30' : 'border border-transparent hover:bg-ink-800/60'
                      }`}
                    >
                      <span className="w-6 h-6 shrink-0 rounded-full bg-ink-700 text-ink-200 text-[11px] flex items-center justify-center">
                        {c.name.trim().slice(0, 1) || '?'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-ink-500">会话</span>
                <button
                  type="button"
                  className="text-[11px] text-amber hover:underline"
                  onClick={() => { setPicked([charId]); setPickOpen(true) }}
                >
                  新建
                </button>
              </div>
              {sessions.length === 0 ? (
                <p className="text-[11px] text-ink-600 leading-relaxed px-1">还没有会话，点「新建」开一场。</p>
              ) : (
                <ul className="space-y-1">
                  {sessions.map(s => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => void openSession(s.id)}
                        className={`w-full text-left rounded-md px-2 py-1.5 ${
                          session?.id === s.id ? 'bg-amber/15 border border-amber/30' : 'border border-transparent hover:bg-ink-800/60'
                        }`}
                      >
                        <div className="truncate text-[12px] text-ink-100">{s.title}</div>
                        <div className="text-[10.5px] text-ink-600">{ago(s.lastActiveAt)}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* 中栏：对话 */}
          {!session ? (
            <div className="flex-1 flex items-center justify-center rounded-lg border border-ink-800">
              <div className="text-center">
                <p className="text-[13px] text-ink-300">选一个会话，或新建一场</p>
                <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
                  {charCard?.examples?.trim()
                    ? `「${charCard.name}」已经填了示例对话，开口就会像那个人。`
                    : `「${charCard?.name ?? ''}」还没填第 4 章「示例对话」—— 补上会明显更像。`}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 min-w-0 flex-col rounded-lg border border-ink-800 overflow-hidden">
              <div className="px-3 py-2 border-b border-ink-800 bg-ink-850/40">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    {editingTitle ? (
                      <input
                        autoFocus
                        value={titleDraft}
                        placeholder="给这场对话起个名字"
                        onChange={e => setTitleDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); void saveTitle() }
                          if (e.key === 'Escape') { e.preventDefault(); setEditingTitle(false) }
                        }}
                        onBlur={() => void saveTitle()}
                        className="w-56 bg-ink-900 border border-amber/50 rounded px-2 py-0.5 text-[12.5px] text-ink-100 outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        title="点击改名"
                        onClick={() => { setTitleDraft(session.title); setEditingTitle(true) }}
                        className="group flex items-center gap-1.5 max-w-full text-left"
                      >
                        <span className="truncate text-[12.5px] text-ink-100">{session.title}</span>
                        <Pencil className="w-3 h-3 shrink-0 text-ink-600 group-hover:text-amber" />
                      </button>
                    )}
                    <div className="text-[10.5px] text-ink-500 flex items-center gap-2">
                      <span>记忆更新于 {ago(memory?.updatedAt ?? 0)}</span>
                      {daily?.mood && <span className="text-amber/80">· 心情：{daily.mood}</span>}
                      {summarizing && <span className="text-amber">· 正在整理记忆…</span>}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    {!!daily?.log?.length && (
                      <Button variant="ghost" size="sm" onClick={() => setShowDaily(v => !v)}>
                        {showDaily ? '收起这几天' : '她最近几天'}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setShowMemory(v => !v)}>
                      {showMemory ? '隐藏记忆' : '查看记忆'}
                    </Button>
                    <Button variant="danger" size="sm" onClick={removeSession}>删除</Button>
                  </div>
                </div>

                {/* 多角色：在场者一览，点头像 = 指定下一位接话（§7.3） */}
                {castCards.length > 1 && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[10.5px] text-ink-500 shrink-0">在场（点头像指定下一位）</span>
                    {castCards.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setSpeakNext(speakNext === c.id ? '' : c.id)
                          showToast(speakNext === c.id ? '已取消指定' : `下一位由 ${c.name} 接话`, 'info')
                        }}
                        className={`flex items-center gap-1 rounded-full pl-0.5 pr-2 py-0.5 border ${speakNext === c.id ? 'border-amber/50 bg-amber/15' : 'border-ink-700 hover:bg-ink-800/60'}`}
                      >
                        <span className="w-5 h-5 rounded-full bg-ink-700 text-ink-200 text-[10px] flex items-center justify-center">
                          {c.name.trim().slice(0, 1)}
                        </span>
                        <span className="text-[11px] text-ink-200">{c.name}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* 她这几天的生活（时间差推进出来的） */}
                {showDaily && !!daily?.log?.length && (
                  <div className="mt-2 rounded-md border border-ink-800 bg-ink-900/50 px-3 py-2">
                    <p className="text-[10.5px] text-ink-500 mb-1">
                      这几天的生活（你没来时她自己过的 —— 界面不打开就不会推进）
                    </p>
                    <ul className="space-y-0.5">
                      {daily.log.map((l, i) => (
                        <li key={i} className="text-[11.5px] text-ink-300 leading-relaxed">
                          <span className="text-ink-500">{l.date}</span> {l.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* 很久没来时她留着的一句话（§7.5）：不弹通知，就放在对话里等她看见 */}
                {greeting && (
                  <div className="rounded-lg border border-amber/30 bg-amber/8 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10.5px] text-amber/80 mb-1">你很久没来了，她留下句话：</p>
                        {renderTavernMessage(greeting)}
                      </div>
                      <button type="button" className="shrink-0 text-[11px] text-ink-500 hover:text-ink-200" onClick={() => setGreeting('')}>
                        收起
                      </button>
                    </div>
                  </div>
                )}
                {session.messages.length === 0 && (
                  <div className="text-center text-[12px] text-ink-500 py-10">
                    还没有对话。在下面说第一句话，她就会应你。
                  </div>
                )}
                {session.messages.map(m => {
                  const who = m.speakerId ? castCards.find(c => c.id === m.speakerId) : undefined
                  return (
                    <div key={m.id} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
                      {/* 多角色同场时挂头像，才分得清谁在说 */}
                      {m.role !== 'user' && castCards.length > 1 && (
                        <span className="w-6 h-6 shrink-0 rounded-full bg-ink-700 text-ink-200 text-[11px] flex items-center justify-center mt-0.5">
                          {who?.name.trim().slice(0, 1) ?? '?'}
                        </span>
                      )}
                      <div className={m.role === 'user'
                        ? 'max-w-[80%] rounded-lg bg-amber/12 border border-amber/25 px-3 py-2'
                        : 'max-w-[85%] space-y-1'}>
                        {m.role !== 'user' && castCards.length > 1 && who && (
                          <div className="text-[10.5px] text-amber/80">{who.name}</div>
                        )}
                        {renderTavernMessage(m.content)}
                      </div>
                    </div>
                  )
                })}
                {streaming && (
                  <div className="max-w-[85%] space-y-1">
                    {streamText ? renderTavernMessage(streamText) : (
                      <div className="text-[12px] text-ink-500">{phase || '正在想…'}</div>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t border-ink-800 p-3">
                <textarea
                  className="w-full h-20 resize-none bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-[13px] text-ink-100 outline-none focus:border-amber/50"
                  placeholder="说点什么…（Ctrl+Enter 发送）"
                  value={input}
                  disabled={streaming}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-ink-500">
                    本会话 {usedChars} 字
                    {memChars > 0 && ` · 记忆 ${memChars}/${lim.softLimit} 字`}
                  </span>
                  <div className="flex gap-2">
                    {streaming
                      ? <Button variant="secondary" size="md" onClick={stop}>停止</Button>
                      : <Button variant="primary" size="md" disabled={!input.trim()} onClick={send}>发送</Button>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 右栏：记忆 */}
          {session && showMemory && (
            <aside className="w-64 shrink-0 flex flex-col rounded-lg border border-ink-800 bg-ink-850/40 min-h-0">
              <div className="px-3 py-2 border-b border-ink-800">
                <div className="text-[12px] text-ink-100">她的记忆</div>
                <div className="text-[10.5px] text-ink-500">
                  更新于 {ago(memory?.updatedAt ?? 0)} · {memChars} 字
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {isMemoryEmpty(memory) ? (
                  <p className="text-[11.5px] text-ink-500 leading-relaxed">
                    还没有记忆。
                    <br />
                    聊满 {lim.triggerMessages} 条消息后会自动整理一次 —— 但她只会在
                    <span className="text-ink-400">下次打开时</span>才用上（没有常驻进程，总结不是即时的）。
                  </p>
                ) : (
                  MEMORY_SECTIONS.map(sec => {
                    const body = String(memory?.[sec.key] ?? '').trim()
                    if (!body) return null
                    return (
                      <div key={sec.key}>
                        <div className="text-[11px] text-amber/80">{sec.title}</div>
                        <div className="mt-0.5 text-[11.5px] text-ink-300 whitespace-pre-wrap leading-relaxed">{body}</div>
                      </div>
                    )
                  })
                )}
              </div>
              <div className="p-2 border-t border-ink-800">
                <Button
                  variant="secondary" size="sm" className="w-full"
                  disabled={!session || summarizing}
                  onClick={() => void runSummary(session, true)}
                >
                  {summarizing ? '整理中…' : '立即整理记忆'}
                </Button>
                <p className="mt-1.5 text-[10.5px] text-ink-600 leading-relaxed">
                  没开应用时她「过了几天」也不会自动发生 —— 这是三端共用一套前端代码的代价，不藏着。
                </p>
              </div>
            </aside>
          )}
        </div>
      )}

      {/* 新建会话：选 1–3 个角色（多角色同场 §7.3） */}
      <Modal open={pickOpen} onClose={() => setPickOpen(false)} title="新建会话" width="md"
        footer={
          <div className="flex items-center justify-between gap-3 w-full">
            <span className="text-[11px] text-ink-500">
              {picked.length === 0 ? '至少选一个角色' : `已选 ${picked.length} 个（上限 3）`}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="md" onClick={() => setPickOpen(false)}>取消</Button>
              <Button
                variant="primary" size="md"
                disabled={picked.length === 0}
                onClick={() => { setPickOpen(false); void createSession(picked) }}
              >
                开始对话
              </Button>
            </div>
          </div>
        }>
        <div className="space-y-3">
          <p className="text-[11.5px] text-ink-500 leading-relaxed">
            选一个就是单角色聊天。选多个则**多角色同场**：一次只让一个角色说话，
            轮到谁由语境决定，也可以点会话顶部的头像手动指定下一位。
          </p>
          <ul className="space-y-1">
            {chars.map(c => {
              const on = picked.includes(c.id)
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(prev => {
                      if (prev.includes(c.id)) return prev.filter(x => x !== c.id)
                      if (prev.length >= 3) { showToast('最多 3 个角色同场', 'info'); return prev }
                      return [...prev, c.id]
                    })}
                    className={`w-full flex items-center gap-2 rounded-md px-2 py-2 text-left border ${on ? 'border-amber/40 bg-amber/12' : 'border-transparent hover:bg-ink-800/60'}`}
                  >
                    <span className="w-6 h-6 shrink-0 rounded-full bg-ink-700 text-ink-200 text-[11px] flex items-center justify-center">
                      {c.name.trim().slice(0, 1) || '?'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{c.name}</span>
                    {on && <span className="shrink-0 text-[11px] text-amber">已选</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </Modal>
    </div>
  )
}
