/**
 * 酒馆模式 · 自由对话（tavern-free）
 *
 * 定位：**陪伴**。自建角色卡的长期对话 —— 记得住事、有时间流逝感、换场景可开新会话
 * （记忆按角色共享，不随会话走）。
 *
 * 【2026-09-14 第三轮改版：页面版式对齐「剧情推演」】
 *   · 页面上的**角色列表撤掉了** —— 选角色改由「＋ 新建对话」弹窗承担（位置槽位 + 搜索选角），
 *     左栏腾给**会话列表**，一屏能看到所有对话、点一下就切，不再挂在某个角色下面；
 *   · 因此会话列表是**全局的**（跨角色）：每条副行标出在场角色，否则分不清这是和谁聊的；
 *   · 「记忆 / 日常」依然是**角色级**的，所以打开会话时取**该会话第一个角色**作为主角色
 *     （`primary`）来读记忆、跑总结、推进日常 —— 多角色会话下这是唯一自洽的口径。
 *
 * 【无服务端带来的三个 UI 义务（方案 §11 明确要求，不能吞掉）】
 *   1. 总结「不即时」—— 只能回复后判阈值、或下次打开补算。界面必须显示
 *      「记忆更新于 X」，让作者知道记忆的时效边界。
 *   2. 会话超长后早期原文会从上下文消失 —— 原文仍在记录里可翻回，
 *      但预算条要显示占用，别让作者以为模型还记得。
 *   3. 记忆是**角色级**的：换会话不会重来，所以新建对话时要写清这一点。
 *
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），
 * 提示用 showToast。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import TavernFreeSetup, { type FreeDraft } from './TavernFreeSetup'
import TavernCastDirector from './TavernCastDirector'
import TavernRevisionDialog from './TavernRevisionDialog'
import TavernMessageBody from './TavernMessageBody'
import TavernQuickBar, { type QuickAction } from './TavernQuickBar'
import { renderTavernMessage } from './TavernMessage'
import AutoTextarea from './AutoTextarea'
import * as store from '../lib/tavern/store'
import { runFreeTurn } from '../lib/tavern/engine'
import { advanceDaily, shouldAdvanceDaily } from '../lib/tavern/daily'
import { summarizeMemory } from '../lib/tavern/summarize'
import { proposeCardRevisions, type CardRevision } from '../lib/tavern/revise'
import { buildOpeningMessage } from '../lib/tavern/prompt'
import { uid } from '../lib/id'
import {
  memoryChars, messagesAfterWatermark, nextWatermark, acquireSummaryLock, releaseSummaryLock,
  shouldRunAutoSummary, MEMORY_SECTIONS, isMemoryEmpty,
} from '../lib/tavern/memory'
import {
  type FreeCharacter, type FreeMemory, type FreeSession, type TavernMessage,
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
  /** 角色卡索引：只用来显示名字（页面不再用它做选择） */
  const [chars, setChars] = useState<TavernCharIndexItem[]>([])
  /** 当前会话的**主角色**（会话 charIds[0]）：记忆 / 日常 / 总结都挂在它身上 */
  const [charCard, setCharCard] = useState<FreeCharacter | null>(null)
  const [sessions, setSessions] = useState<FreeSessionIndexItem[]>([])
  const [session, setSession] = useState<FreeSession | null>(null)
  /**
   * 记忆是**角色级**的：一场对话里有几个角色就有几份档案。
   * 所以这里存成 map，右侧面板用页签切换 —— 不再只显示「主角色」那一份。
   */
  const [mems, setMems] = useState<Record<string, FreeMemory | null>>({})
  /** 右栏当前看的是谁的记忆（默认 = 会话第一个角色） */
  const [memTabId, setMemTabId] = useState('')
  const [summaryProviderId, setSummaryProviderId] = useState('')

  // ---------- UI ----------
  const [loading, setLoading] = useState(true)
  const [setupOpen, setSetupOpen] = useState(false)
  /** 左栏会话筛选词 */
  const [q, setQ] = useState('')
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [phase, setPhase] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  /** 整理进度（多角色时要逐个整理，显示「2/3」免得以为卡住了） */
  const [sumProgress, setSumProgress] = useState('')
  const [showMemory, setShowMemory] = useState(true)
  /** Ta这几天的生活与心情（方案 §4.7：靠时间差推进，没有常驻进程） */
  const [daily, setDaily] = useState<DailyState | null>(null)
  const [showDaily, setShowDaily] = useState(false)
  /** 很久没来时Ta留着的一句话（§7.5），展示后清除 */
  const [greeting, setGreeting] = useState('')
  /** 本会话在场角色的完整卡（多角色渲染需要） */
  const [castCards, setCastCards] = useState<FreeCharacter[]>([])
  /** 手动指定下一位接话的角色（空 = 按轮转） */
  const [speakNext, setSpeakNext] = useState('')
  /** 「在场调度」弹窗（静音 / 健谈度，A6） */
  const [directorOpen, setDirectorOpen] = useState(false)
  /** 设定更新：AI 读对话 → 列出「设定可能该改了」，由作者逐条裁决 */
  const [reviseOpen, setReviseOpen] = useState(false)
  const [revising, setRevising] = useState(false)
  const [applyingRev, setApplyingRev] = useState(false)
  const [proposals, setProposals] = useState<CardRevision[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  /** 设查失败的原因（与「没有需要改设定」必须分开显示） */
  const [reviseError, setReviseError] = useState('')
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

  const nameOf = useCallback((id: string) => chars.find(c => c.id === id)?.name ?? '', [chars])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await store.listFreeSessions())
    } catch {
      showToast('读取会话列表失败', 'error')
    }
  }, [])

  // ---------- 加载 ----------
  useEffect(() => {
    void (async () => {
      try {
        // 模型与总结模型统一由控制面板管（原先那个「模型设置」面板已下线）
        const [cs, st] = await Promise.all([
          store.listFreeChars(),
          getTavernSettings().catch(() => DEFAULT_TAVERN_SETTINGS),
        ])
        setChars(cs)
        setTavernSettings(st)
        setSummaryProviderId(st.free.summaryProviderId)
        setSessions(await store.listFreeSessions())
      } catch (e) {
        showToast(`读取失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // ---------- 日常推进与主动留言（§4.7 / §7.5） ----------
  /**
   * 距上次活跃够久就补写「这几天的生活」，并拿到Ta留的一句话。
   * 静默执行：失败不打扰（下次打开还会再试），也不阻塞对话。
   */
  const advanceIfNeeded = useCallback(async (card: FreeCharacter, cur?: DailyState | null) => {
    const d = cur ?? (await store.getDaily(card.id).catch(() => null))
    if (!shouldAdvanceDaily(d, Date.now(), lim.dailyAdvanceMs)) return
    if (!acquireSummaryLock(Date.now(), lim.lockTtlMs)) return // 与总结共用一把锁，避免两个窗口同时写
    try {
      const mem = await store.getMemory(card.id).catch(() => null)
      const res = await advanceDaily({
        char: card,
        prev: d,
        memory: mem,
        providerId: summaryProviderId || undefined,
        logKeep: lim.dailyLogKeep,
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

  /**
   * 载入当前会话的上下文：在场角色卡 + **每位角色各自的记忆** + Ta留的话。
   * 记忆是角色级的，所以一次读全部参演角色；页签默认停在第一个角色。
   */
  const loadSessionContext = useCallback(async (s: FreeSession) => {
    try {
      const cards = (await Promise.all(s.charIds.map(cid => store.getFreeChar(cid)))).filter((c): c is FreeCharacter => !!c)
      setCastCards(cards)
      const primary = cards[0] ?? null
      setCharCard(primary)
      if (cards.length) {
        const rows = await Promise.all(cards.map(async c =>
          [c.id, await store.getMemory(c.id).catch(() => null)] as const))
        setMems(Object.fromEntries(rows))
        setMemTabId(prev => (cards.some(c => c.id === prev) ? prev : (primary?.id ?? '')))
        // 打开就补算「这几天的生活」（方案 §4.6 ② 的同一思路：无服务端只能靠打开时补）
        if (primary) void advanceIfNeeded(primary, await store.getDaily(primary.id).catch(() => null))
      } else {
        setMems({})
        setMemTabId('')
        setDaily(null)
      }
      // Ta留着的话：展示后即清除，不留着反复弹
      for (const c of cards) {
        const g = await store.takeGreeting(c.id)
        if (g) { setGreeting(g); break }
      }
    } catch {
      setCastCards([])
    }
  }, [advanceIfNeeded])

  const openSession = useCallback(async (id: string) => {
    const s = await store.getFreeSession(id)
    setSession(s)
    setStreamText('')
    setSpeakNext('')
    if (!s) return
    await loadSessionContext(s)
  }, [loadSessionContext])

  // ---------- 新建对话（版式对齐新建推演） ----------
  const createFromDraft = useCallback(async (d: FreeDraft) => {
    if (d.charIds.length === 0) return
    try {
      // 默认标题沿用 store 里的规则（「和X的对话」/「与X、Y的对话」），作者填了就以作者为准
      const { title } = store.planFreeSessionCast(d.charIds, d.charIds[0], nameOf)
      const opening = buildOpeningMessage(d.scene, d.firstLine)
      const created = await store.createFreeSession(
        d.charIds, d.title || title, { providerId: '' }, {}, d.userCharId || undefined)
      // 开场设定与第一条消息一起落库（scene 是可选的，旧会话没有这个字段也读得动）
      const withOpening: FreeSession = opening
        ? { ...created, scene: d.scene, messages: [{ id: uid(), role: 'user', content: opening, at: Date.now() }] }
        : { ...created, scene: d.scene }
      await store.saveFreeSession(withOpening)
      setSetupOpen(false)
      await refreshSessions()
      setSession(withOpening)
      await loadSessionContext(withOpening)
      const aiNames = d.charIds.filter(id => id !== d.userCharId).map(nameOf).filter(Boolean).join('、')
      showToast(d.userCharId
        ? `已新建对话：你演 ${nameOf(d.userCharId)}，AI 演 ${aiNames}`
        : d.charIds.length > 1
          ? '已新建多角色会话（发言顺序由语境决定，也可点顶部头像指定下一位）'
          : '已新建对话（记忆按角色共享，换会话不会重来）')
    } catch (e) {
      showToast(`新建失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [nameOf, refreshSessions, loadSessionContext])

  // ---------- 记忆总结 ----------
  /**
   * 跑一次总结：**按角色逐个整理**（记忆是角色级的）。
   * manual = 手动点「立即整理记忆」（不受时间节流限制 —— 作者点了就该跑）。
   * 自动路径要过三道闸：新消息够不够 → 时间节流 → 跨实例锁；过了才逐个角色整理。
   *
   * ⚠️ 水位线**只在全部角色都成功后才推进**：宁可下次重算，也不能让某个角色漏记一段。
   */
  const runSummary = useCallback(async (s: FreeSession, manual = false) => {
    const cards = (await Promise.all(s.charIds.map(async id => store.getFreeChar(id))))
      .filter((c): c is FreeCharacter => !!c)
    if (cards.length === 0) return

    if (!manual) {
      const first = await store.getMemory(cards[0].id).catch(() => null)
      const verdict = shouldRunAutoSummary(s, first, Date.now(), {
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
    if (!acquireSummaryLock(Date.now(), lim.lockTtlMs)) {
      if (manual) showToast('另一个窗口正在整理记忆', 'info')
      return
    }
    setSummarizing(true)
    try {
      const done: FreeMemory[] = []
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i]
        if (cards.length > 1) setSumProgress(`${i + 1}/${cards.length}`)
        const prev = await store.getMemory(c.id).catch(() => null)
        const next = await summarizeMemory({
          charId: c.id,
          charName: c.name,
          prev,
          messages: pending,
          // 带上角色背景：不给的话模型会凭对话臆断「Ta在哪、是谁」，记忆从第一次就开始漂移
          charContext: [
            c.world.trim() && `世界：${c.world.trim()}`,
            c.profile.core.trim() && `内核：${c.profile.core.trim()}`,
            c.profile.cannot.trim() && `做不到的事：${c.profile.cannot.trim()}`,
            c.profile.knowledge.trim() && `知识边界：${c.profile.knowledge.trim()}`,
            // 用户扮演的角色：他的台词是用户写的，整理时按「已经发生的事」记，别写成别人转述
            c.id === s.userCharId && '（这位角色由**用户自己**扮演：他说的话与做的事是既成事实，直接记进他的视角；不要写成「某某告诉我」。）',
          ].filter(Boolean).join('\n'),
          providerId: summaryProviderId || undefined,
          limits: { longTermLimit: lim.longTermLimit, diaryDays: lim.diaryDays },
        })
        await store.saveMemory(next)
        done.push(next)
      }
      // 水位线推进到最后一条（全部成功才走到这儿）
      const wm = nextWatermark(s)
      const updated: FreeSession = { ...s, watermark: wm ?? s.watermark, updatedAt: Date.now() }
      await store.saveFreeSession(updated)
      setSession(cur => (cur && cur.id === updated.id ? updated : cur))
      setMems(prev => ({ ...prev, ...Object.fromEntries(done.map(m => [m.charId, m])) }))
      if (manual) {
        const total = done.reduce((n, m) => n + memoryChars(m), 0)
        showToast(done.length > 1
          ? `已分别更新 ${done.length} 位角色的记忆（合计 ${total} 字）`
          : `记忆已更新（${total} 字）`)
      }
    } catch (e) {
      // 失败保留旧档案（已写成功的保留、未写的保持旧值），也**不推进水位线**，下次补算
      if (manual) showToast(`总结失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      releaseSummaryLock()
      setSummarizing(false)
      setSumProgress('')
    }
  }, [summaryProviderId, lim])

  /**
   * 设定更新：对**在场每个角色**分别审查一遍。
   *
   * 为什么每个都要跑：关系是**双向**的（用户演的楚楠提分手，楚楠与洛汐两张卡的「2.4 关系」都该改），
   * 只查 AI 演的那一方会漏掉一半。
   * 这里只产出建议、**不落库**；采纳由 applyPicked 交给 store。
   */
  const openRevise = useCallback(async (s: FreeSession) => {
    const cards = (await Promise.all(s.charIds.map(async id => store.getFreeChar(id))))
      .filter((c): c is FreeCharacter => !!c)
    setReviseOpen(true)
    if (cards.length === 0) { setProposals([]); return }
    setRevising(true)
    setProposals([])
    setPicked(new Set())
    setReviseError('')
    try {
      // 说话人名字：多角色同场时，「谁对谁说了什么」是判断的关键一半
      const speakerName = (m: TavernMessage) => cards.find(c => c.id === m.speakerId)?.name ?? '角色'
      const out: CardRevision[] = []
      for (const c of cards) {
        const rows = await proposeCardRevisions({
          char: c,
          messages: s.messages,
          providerId: summaryProviderId || undefined,
          speakerName,
        })
        out.push(...rows)
      }
      setProposals(out)
      setPicked(new Set(out.map(r => r.id)))
      showToast(out.length
        ? `读出 ${out.length} 处可能的设定变更，请逐条裁决`
        : `这段对话没有需要改的设定（共查了 ${cards.length} 张卡）`,
        'info')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setReviseError(msg)
      showToast(`检查失败：${msg}`, 'error')
    } finally {
      setRevising(false)
    }
  }, [summaryProviderId])

  /** 采纳选中的设定变更。写卡后**重读在场角色** —— 下一轮组装就用新设定 */
  const applyPicked = useCallback(async () => {
    const items = proposals
      .filter(p => picked.has(p.id))
      .map(p => ({ charId: p.charId, field: p.field, after: p.after }))
    if (items.length === 0) return
    setApplyingRev(true)
    try {
      const n = await store.applyCardRevisions(items)
      if (session) await loadSessionContext(session)
      showToast(`已更新 ${n} 处设定 —— 下一轮对话即按新设定演`)
      setReviseOpen(false)
      setProposals([])
      setPicked(new Set())
      setReviseError('')
    } catch (e) {
      showToast(`写入失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setApplyingRev(false)
    }
  }, [proposals, picked, session, loadSessionContext])

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
  /** preset = 快捷指令条递过来的一句现成话（走导演指令通道）；不传就用输入框里的 */
  const send = useCallback(async (preset?: string) => {
    const text = (preset ?? input).trim()
    if (!text || !session || !charCard || streaming) return
    if (!preset) setInput('')
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
      await refreshSessions()
      if (!res.cancelled) void autoSummarize(saved)
      if (res.fellBack) showToast('该会话指定的模型不可用，已回退到全局活动模型', 'info')
      // 说完这句就把Ta说的话撤掉：那句话是「很久没来」时才该有的
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
  }, [input, session, charCard, streaming, refreshSessions, autoSummarize, castCards, speakNext])

  // ---------- 消息级操作（与剧情推演同一套；自由模式多一条：重说时**保持原来的说话人**） ----------
  const lastAiId = useMemo(() => store.lastAssistantId(session?.messages ?? []), [session])

  const commit = async (next: FreeSession) => {
    setSession(next)
    await store.saveFreeSession(next).then(refreshSessions).catch(() => undefined)
  }

  const saveEdited = (id: string, text: string) => {
    if (!session) return
    void commit(store.patchMessage(session, id, { content: text, edited: true }))
  }

  const toggleHidden = (id: string) => {
    if (!session) return
    const next = store.toggleMessageHidden(session, id)
    void commit(next)
    const m = next.messages.find(x => x.id === id)
    showToast(m?.hidden ? '已隐藏：这条不再进上下文，界面仍留着' : '已恢复：这条重新参与上下文', 'info')
  }

  const removeMsg = async (id: string) => {
    if (!session) return
    const okGo = await confirmDialog({
      title: '删掉这一条？',
      message: '删除后不再参与上下文，也不再显示。\n这一步不可撤销（记忆是角色级的，已经整理进去的内容不受影响）。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    void commit(store.dropMessage(session, id))
  }

  /**
   * 重说：多角色同场时**保持原来的说话人** —— 同一轮换个人接话，观感很怪。
   * speakerId 传给引擎即走「手动指定下一位」那条路（它优先于轮转）。
   */
  const reroll = async () => {
    if (!session || streaming) return
    const target = session.messages.find(m => m.id === lastAiId)
    if (!target) { showToast('还没有可以重说的回复', 'info'); return }
    setStreaming(true)
    setStreamText('')
    setPhase('')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const cast = (castCards.length ? castCards : (charCard ? [charCard] : [])) as FreeCharacter[]
      const res = await runFreeTurn(session, cast, null, {
        onToken: d => setStreamText(prev => prev + d),
        onPhase: p => setPhase(p),
        signal: ctrl.signal,
        speakerId: target.speakerId,
      })
      const saved = await store.saveFreeSession(res.session)
      setSession(saved)
      setStreamText('')
      await refreshSessions()
      if (!res.reply) showToast('这次没生成出内容，原来那条已保留', 'info')
    } catch (e) {
      showToast(`重说失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setStreaming(false)
      setPhase('')
      abortRef.current = null
    }
  }

  /** 快捷指令条：走协议 R4 的**导演指令**通道（「」= 照做然后继续演） */
  const quickActions: QuickAction[] = [
    { key: 'cont', label: '继续', hint: '让 Ta 接着说', run: () => void send('「继续。」') },
    { key: 'env', label: '补环境', hint: '先补一句【】里的环境（光、声、气味），再接着说', run: () => void send('「先说一句【】里的环境（光、声、气味），再继续。」') },
    { key: 'time', label: '推进时间', hint: '把时间往前推一点（半小时 / 第二天）', run: () => void send('「把时间往前推一点（半小时或第二天），再继续。」') },
    { key: 'mind', label: 'Ta 在想什么', hint: '用一个动作或细节透出心里的想法，不直接写心理', run: () => void send('「用一个动作或细节写出 Ta 此刻心里在想什么，不要直接写心理。」') },
    { key: 'reroll', label: '重说', hint: '用同一段历史让 Ta 重说这一条（只出一个结果，说话人不变）', run: () => void reroll() },
  ]

  const stop = () => { abortRef.current?.abort() }

  const removeSession = async () => {
    if (!session) return
    const okGo = await confirmDialog({
      title: '删除这个会话？',
      message: '对话记录会一并删除。\n注意：**Ta的记忆是按角色存的**，所以记忆不会跟着消失。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    await store.deleteFreeSession(session.id)
    setSession(null)
    setCastCards([])
    setCharCard(null)
    setMems({})
    setMemTabId('')
    setDaily(null)
    await refreshSessions()
    showToast('已删除会话')
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

  /** 左栏列表：按标题 / 在场角色名过滤 */
  const rows = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return sessions
    return sessions.filter(s =>
      `${s.title} ${s.charIds.map(nameOf).join(' ')}`.toLowerCase().includes(kw))
  }, [sessions, q, nameOf])

  /** AI 演的角色（用户扮演的那个不算 AI 的位子：头像行、气泡归属都要摘掉他） */
  const aiCards = useMemo(
    () => castCards.filter(c => c.id !== session?.userCharId),
    [castCards, session],
  )
  /** 在场调度（A6）：改的是这一场，落库即生效（下一轮组装就用新值） */
  const applyDirection = async (next: FreeSession) => {
    await store.saveFreeSession(next)
    setSession(cur => (cur && cur.id === next.id ? next : cur))
  }
  const directorRows = useMemo(
    () => aiCards.map(c => ({ id: c.id, name: c.name || '（未命名）', tag: 'AI 演', speakable: true })),
    [aiCards],
  )
  /** 右栏页签当前指向的那份记忆 */
  const activeMem = memTabId ? mems[memTabId] ?? null : null
  const memChars = activeMem ? memoryChars(activeMem) : 0
  /** 当前页签角色的日常（心情 / 这几天的生活也是角色级的） */
  useEffect(() => {
    if (!memTabId) { setDaily(null); return }
    let alive = true
    void store.getDaily(memTabId).then(d => { if (alive) setDaily(d) }).catch(() => { if (alive) setDaily(null) })
    return () => { alive = false }
  }, [memTabId, session?.id])

  // ---------- 渲染 ----------
  if (loading) return <div className="page-enter"><LoadingState /></div>

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      {/* 顶部：只放「本场」的操作，导航（选/新建）都在左栏 */}
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">自由对话</h1>
        {session && <span className="max-w-[28rem] truncate text-[12px] text-ink-400" title={session.title}>{session.title}</span>}
        <div className="flex-1" />
        {session && (
          <>
            {!!daily?.log?.length && (
              <Button variant="ghost" size="md" onClick={() => setShowDaily(v => !v)}>
                {showDaily ? '收起这几天' : 'Ta最近几天'}
              </Button>
            )}
            <Button variant="ghost" size="md" onClick={() => setShowMemory(v => !v)}>
              {showMemory ? '隐藏记忆' : '查看记忆'}
            </Button>
            <Button variant="danger" size="md" onClick={() => void removeSession()}>删除对话</Button>
          </>
        )}
      </header>

      <div className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* 左栏：会话列表（全局，跨角色 —— 页面不再有角色列表） */}
        <aside className="flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-ink-800 bg-ink-850/40 p-3">
          <Button
            variant="primary" size="md" className="w-full"
            onClick={() => {
              if (chars.length === 0) { showToast('还没有角色卡 —— 先去「角色卡片」建一张', 'info'); return }
              setSetupOpen(true)
            }}
          >
            ＋ 新建对话
          </Button>
          {sessions.length > 4 && (
            <input
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-[11.5px] text-ink-100 outline-none focus:border-amber/50"
              placeholder="筛选（标题 / 角色）"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
          )}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {rows.map(s => {
              const active = session?.id === s.id
              const names = s.charIds.map(nameOf).filter(Boolean).join('、') || '（角色已删除）'
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => void openSession(s.id)}
                  className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors ${
                    active ? 'border-amber/40 bg-amber/10' : 'border-transparent hover:bg-ink-800/60'
                  }`}
                >
                  <div className={`truncate text-[12px] ${active ? 'text-amber' : 'text-ink-100'}`}>{s.title}</div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-[10.5px] text-ink-500">{names}</span>
                    <span className="shrink-0 text-[10.5px] text-ink-600">{ago(s.lastActiveAt)}</span>
                  </div>
                </button>
              )
            })}
            {rows.length === 0 && (
              <p className="px-1 py-2 text-[11px] leading-relaxed text-ink-500">
                {sessions.length === 0 ? '还没有对话 —— 点上面「新建对话」开一场。' : '没有匹配的对话。'}
              </p>
            )}
          </div>
          <div className="shrink-0 border-t border-ink-800 pt-2 text-[10.5px] text-ink-500">共 {sessions.length} 场</div>
        </aside>

        {chars.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-ink-700 bg-ink-850/60">
            <div className="text-center">
              <p className="text-[13px] text-ink-300">还没有角色可聊</p>
              <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
                先去「角色卡片」建一张卡 —— 填好第 4 章「示例对话」，Ta会立刻像那个人。
                <br />
                建好后回到这里，点「＋ 新建对话」就能开口了。
              </p>
            </div>
          </div>
        ) : !session ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-ink-800">
            <div className="text-center">
              <p className="text-[13px] text-ink-300">还没有选择对话</p>
              <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
                从左栏点一场继续，或「＋ 新建对话」开一场 —— 可以单角色聊，也能让两三个角色同场。
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* 对话区 */}
            <div className="flex flex-1 min-w-0 flex-col rounded-lg border border-ink-800 overflow-hidden">
              <div className="px-3 py-2 border-b border-ink-800 bg-ink-850/40">
                <div className="flex items-center justify-between gap-2">
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
                    <div className="text-[10.5px] text-ink-500 flex flex-wrap items-center gap-2">
                      <span>记忆更新于 {ago(activeMem?.updatedAt ?? 0)}</span>
                      {daily?.mood && <span className="text-amber/80">· 心情：{daily.mood}</span>}
                      {summarizing && <span className="text-amber">· 正在整理记忆…</span>}
                      {session.scene && [session.scene.place, session.scene.time].filter(Boolean).length > 0 && (
                        <span className="truncate">
                          · 场景：{[session.scene.place, session.scene.time].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* 多角色：在场者一览，点头像 = 指定下一位接话（§7.3）。
                    只列 **AI 演的**角色 —— 用户扮演的那个不是 AI 的位子，指定他接话没有意义。 */}
                {aiCards.length > 1 && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[10.5px] text-ink-500 shrink-0">在场（点头像指定下一位）</span>
                    {aiCards.map(c => (
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
                    <button
                      type="button"
                      onClick={() => setDirectorOpen(true)}
                      className="ml-auto shrink-0 rounded border border-ink-700 px-1.5 py-0.5 text-[10.5px] text-ink-400 hover:text-amber"
                      title="静音（在场但不发言）与健谈度"
                    >
                      在场调度
                    </button>
                  </div>
                )}

                {/* Ta这几天的生活（时间差推进出来的） */}
                {showDaily && !!daily?.log?.length && (
                  <div className="mt-2 rounded-md border border-ink-800 bg-ink-900/50 px-3 py-2">
                    <p className="text-[10.5px] text-ink-500 mb-1">
                      这几天的生活（你没来时Ta自己过的 —— 界面不打开就不会推进）
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
                {/* 很久没来时Ta留着的一句话（§7.5）：不弹通知，就放在对话里等Ta看见 */}
                {greeting && (
                  <div className="rounded-lg border border-amber/30 bg-amber/8 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10.5px] text-amber/80 mb-1">你很久没来了，Ta留下句话：</p>
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
                    还没有对话。在下面说第一句话，Ta就会应你。
                  </div>
                )}
                {session.messages.map(m => {
                  const who = m.speakerId ? aiCards.find(c => c.id === m.speakerId) : undefined
                  return (
                    <div key={m.id} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
                      {/* 多角色同场时挂头像，才分得清谁在说 */}
                      {m.role !== 'user' && aiCards.length > 1 && (
                        <span className="w-6 h-6 shrink-0 rounded-full bg-ink-700 text-ink-200 text-[11px] flex items-center justify-center mt-0.5">
                          {who?.name.trim().slice(0, 1) ?? '?'}
                        </span>
                      )}
                      <div className={m.role === 'user'
                        ? 'max-w-[80%] rounded-lg bg-amber/12 border border-amber/25 px-3 py-2'
                        : 'max-w-[85%] space-y-1'}>
                        {m.role !== 'user' && aiCards.length > 1 && who && (
                          <div className="text-[10.5px] text-amber/80">{who.name}</div>
                        )}
                        <TavernMessageBody
                          content={m.content} hidden={m.hidden} edited={m.edited}
                          ops={{
                            canReroll: m.id === lastAiId && !streaming,
                            busy: streaming,
                            onReroll: () => void reroll(),
                            onSaveEdit: t => saveEdited(m.id, t),
                            onToggleHidden: () => toggleHidden(m.id),
                            onDelete: () => void removeMsg(m.id),
                          }}
                        />
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
                <TavernQuickBar actions={quickActions} disabled={streaming} className="mb-2" />
                {/* 自动延展：默认 3 行，写长了自己长高，超过 200px 才内部滚动 */}
                <AutoTextarea
                  className="bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-ink-100 outline-none focus:border-amber/50"
                  textClass="text-[13px]"
                  minRows={3}
                  maxHeight={200}
                  placeholder="说点什么…（Ctrl+Enter 发送）"
                  value={input}
                  disabled={streaming}
                  onChange={setInput}
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
                      : <Button variant="primary" size="md" disabled={!input.trim()} onClick={() => void send()}>发送</Button>}
                  </div>
                </div>
              </div>
            </div>

            {/* 右栏：记忆（角色级）—— 一场对话里有几个角色就有几份档案，用页签切换 */}
            {showMemory && castCards.length > 0 && (
              <aside className="w-72 shrink-0 flex flex-col rounded-lg border border-ink-800 bg-ink-850/40 min-h-0">
                <div className="flex flex-wrap gap-1 border-b border-ink-800 p-2">
                  {castCards.map(c => {
                    const on = c.id === memTabId
                    const isUser = c.id === session.userCharId
                    return (
                      <button
                        key={c.id} type="button" onClick={() => setMemTabId(c.id)}
                        title={isUser ? '这个角色由你扮演' : '这个角色由 AI 扮演'}
                        className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                          on ? 'border-amber/40 bg-amber/10 text-amber' : 'border-transparent text-ink-300 hover:bg-ink-800/60'
                        }`}
                      >
                        {c.name || '（未命名）'}
                        {isUser && <span className="ml-1 text-[9.5px] text-amber/80">我演</span>}
                      </button>
                    )
                  })}
                </div>
                <div className="px-3 py-2 border-b border-ink-800 text-[10.5px] text-ink-500">
                  更新于 {ago(activeMem?.updatedAt ?? 0)} · {memChars} 字
                  {castCards.length > 1 && ` · ${castCards.length} 位各自记账`}
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {isMemoryEmpty(activeMem) ? (
                    <p className="text-[11.5px] text-ink-500 leading-relaxed">
                      这个角色还没有记忆。
                      <br />
                      聊满 {lim.triggerMessages} 条消息后会自动整理一次 —— 但只会在
                      <span className="text-ink-400">下次打开时</span>才用上（没有常驻进程，总结不是即时的）。
                    </p>
                  ) : (
                    MEMORY_SECTIONS.map(sec => {
                      const body = String(activeMem?.[sec.key] ?? '').trim()
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
                  <div className="flex gap-1.5">
                    <Button
                      variant="secondary" size="sm" className="flex-1"
                      disabled={!session || summarizing}
                      onClick={() => { if (session) void runSummary(session, true) }}
                    >
                      {summarizing
                        ? (sumProgress ? `整理中… ${sumProgress}` : '整理中…')
                        : '整理记忆'}
                    </Button>
                    <Button
                      variant="secondary" size="sm" className="flex-1"
                      disabled={!session || revising}
                      title="让 AI 读这段对话，列出「角色设定可能该改了」的条目，由你逐条裁决（记忆与设定分开：这里改的是角色卡）"
                      onClick={() => { if (session) void openRevise(session) }}
                    >
                      {revising ? '检查中…' : '更新设定'}
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[10.5px] text-ink-600 leading-relaxed">
                    记忆**按角色分别整理**（Ta 记得什么）；设定更新只在你点它时才跑，
                    而且**只列出来让你裁决**，不自动改卡。
                  </p>
                </div>
              </aside>
            )}
          </>
        )}
      </div>

      <TavernFreeSetup open={setupOpen} onCreate={createFromDraft} onCancel={() => setSetupOpen(false)} />

      <TavernRevisionDialog
        open={reviseOpen}
        loading={revising}
        applying={applyingRev}
        proposals={proposals}
        picked={picked}
        error={reviseError}
        onToggle={id => setPicked(prev => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })}
        onToggleAll={next => setPicked(next ? new Set(proposals.map(p => p.id)) : new Set())}
        onApply={() => void applyPicked()}
        onRetry={() => { if (session) void openRevise(session) }}
        onClose={() => setReviseOpen(false)}
      />

      <TavernCastDirector
        open={directorOpen}
        rows={directorRows}
        muted={session?.muted ?? []}
        talkativity={session?.talkativity ?? {}}
        showNext={aiCards.length > 1}
        nextId={speakNext}
        onPickNext={id => {
          setSpeakNext(speakNext === id ? '' : id)
          const hit = aiCards.find(c => c.id === id)
          showToast(speakNext === id ? '已取消指定' : '下一位由 ' + (hit?.name ?? '该角色') + ' 接话', 'info')
        }}
        onToggleMute={(id, next) => { if (session) void applyDirection(store.setMuted(session, id, next)) }}
        onSetTalkativity={(id, v) => { if (session) void applyDirection(store.setTalkativity(session, id, v)) }}
        onClose={() => setDirectorOpen(false)}
        note="只影响这一场的发言安排：不改角色卡，也不删记忆 —— 静音的人依然算在场，只是这一轮不发言。"
      />
    </div>
  )
}
