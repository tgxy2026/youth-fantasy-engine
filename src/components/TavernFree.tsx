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
import HelpPopover from './HelpPopover'
import TavernEchoHints from './TavernEchoHints'
import { Pencil } from 'lucide-react'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import { Modal } from './Modal'
import { LoadingState } from './LoadingState'
import TavernFreeSetup, { type FreeDraft } from './TavernFreeSetup'
import TavernCastDirector from './TavernCastDirector'
import TavernRevisionDialog from './TavernRevisionDialog'
import TavernExportDialog from './TavernExportDialog'
import TavernStatusBar from './TavernStatusBar'
import TavernVarsPanel from './TavernVarsPanel'
import TavernUsageDialog from './TavernUsageDialog'
import Avatar from './Avatar'
import TavernMessageBody from './TavernMessageBody'
import TavernQuickBar, { type QuickAction } from './TavernQuickBar'
import TavernDirectorNoteBar from './TavernDirectorNoteBar'
import { renderTavernMessage } from './TavernMessage'
import AutoTextarea from './AutoTextarea'
import * as store from '../lib/tavern/store'
import { runFreeTurn, varsEnabledKeys } from '../lib/tavern/engine'
import type { PostApplied } from '../lib/tavern/postRules'
import { advanceDaily, shouldAdvanceDaily } from '../lib/tavern/daily'
import { proposeCardRevisions, type CardRevision } from '../lib/tavern/revise'
import { uid } from '../lib/id'
import { nextWatermark, acquireSummaryLock, releaseSummaryLock } from '../lib/tavern/memory'
import {
  type FreeCharacter, type FreeMemory, type FreeSession, type TavernMessage, type TavernDirectorNote,
  type FreeSessionIndexItem, type TavernCharIndexItem, type DailyState,
  type VarKey, type TavernStoryIndexItem, sessionStoryId,
} from '../lib/tavern/types'
import { varsOf, setVarManually, resetVarValues, recordVarChanges, turnSeqOf } from '../lib/tavern/vars'
import { scriptSceneLine, snapshotOf, openingToMessage } from '../lib/tavern/script'
import { getScript } from '../lib/tavern/script'
import { getTavernSettings, memoryLimitsOf, DEFAULT_TAVERN_SETTINGS, DEFAULT_TAVERN_PROFILE, type TavernSettings } from '../lib/tavern/settings'
import { listStories, storyDisplayName } from '../lib/tavern/story'
import { freeDocModel, type SpeakerInfo } from '../lib/tavern/exportDoc'
import { buildStatusModel, agoText } from '../lib/tavern/status'
import { runRoundEnd, pendingMessages, type RoundEndProgress, type RoundEndResult, type RoundEndStage } from '../lib/tavern/roundEnd'

/** 收尾各阶段在界面上的措辞（多角色时还会附上「第几个/共几个」） */
const STAGE_TEXT: Record<RoundEndStage, string> = {
  memory: '整理记忆与日记…',
  vars: '结算本场数值…',
  revise: '审查设定…',
  done: '已收尾',
}

export default function TavernFree() {
  // ---------- 数据 ----------
  /** 角色卡索引：只用来显示名字（页面不再用它做选择） */
  const [chars, setChars] = useState<TavernCharIndexItem[]>([])
  /** 当前会话的**主角色**（会话 charIds[0]）：记忆 / 日常 / 总结都挂在它身上 */
  const [charCard, setCharCard] = useState<FreeCharacter | null>(null)
  const [sessions, setSessions] = useState<FreeSessionIndexItem[]>([])
  /** 故事列表（左栏把对话挂在故事下面；老大 2026-09-16 定） */
  const [stories, setStories] = useState<TavernStoryIndexItem[]>([])
  /** 左栏树里被**收起**的故事（默认全展开 —— 对话不多时先让作者看见全貌） */
  const [closedStoryIds, setClosedStoryIds] = useState<string[]>([])
  const [session, setSession] = useState<FreeSession | null>(null)
  /**
   * 记忆是**角色级**的：一场对话里有几个角色就有几份档案。
   * 所以存成 map。注意右侧面板已改为显示「本场状态」而非记忆（老大 2026-09-16 定），
   * 记忆只在点「结束本轮对话」时整理，阅读入口在角色卡片页。
   */
  const [mems, setMems] = useState<Record<string, FreeMemory | null>>({})
  /** 右栏「Ta这几天的生活 / 心情」看的是谁 —— 默认取第一个 **AI 扮演** 的角色（用户演的那位不是观察对象） */
  const [statusCharId, setStatusCharId] = useState('')
  const [summaryProviderId, setSummaryProviderId] = useState('')

  // ---------- UI ----------
  const [loading, setLoading] = useState(true)
  const [setupOpen, setSetupOpen] = useState(false)
  /** 左栏会话筛选词 */
  const [q, setQ] = useState('')
  const [input, setInput] = useState('')
  /** B3：上一轮后处理实际改了什么 */
  const [postNotice, setPostNotice] = useState<{ applied: PostApplied[]; errors: string[] }>({ applied: [], errors: [] })
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [phase, setPhase] = useState('')
  /**
   * 「结束本轮对话」进行中。
   * 注意与旧的 `summarizing` 不同：那玩意儿是**每轮都在后台跑**，作者看得见它卡；
   * 这个只在作者主动点「结束本轮对话」后才出现，且是一次性的。
   */
  const [ending, setEnding] = useState(false)
  const [endStage, setEndStage] = useState<RoundEndProgress | null>(null)
  /** 收尾结果摘要（日记 + 数值变化），弹窗展示后关掉即焚 */
  const [endResult, setEndResult] = useState<RoundEndResult | null>(null)
  /** 右栏状态面板默认展开；它的价值就在「不用点开就看到」，所以不再给收起按钮 */
  /** Ta这几天的生活与心情（方案 §4.7：靠时间差推进，没有常驻进程） */
  const [daily, setDaily] = useState<DailyState | null>(null)
  const [showDaily, setShowDaily] = useState(false)
  /** 状态一览（批次 8，只读）：默认展开 —— 它的价值就在「不用点开就看到」 */
  const [statusOpen, setStatusOpen] = useState(true)
  /** 用量明细弹窗（额度怎么分的） */
  const [usageOpen, setUsageOpen] = useState(false)
  /** 很久没来时Ta留着的一句话（§7.5），展示后清除 */
  const [greeting, setGreeting] = useState('')
  /** 本会话在场角色的完整卡（多角色渲染需要） */
  const [castCards, setCastCards] = useState<FreeCharacter[]>([])
  /** 手动指定下一位接话的角色（空 = 按轮转） */
  const [speakNext, setSpeakNext] = useState('')
  /** 「在场调度」弹窗（静音 / 健谈度，A6） */
  const [directorOpen, setDirectorOpen] = useState(false)
  /** 导出文档弹窗（B5） */
  const [exportOpen, setExportOpen] = useState(false)
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
  /**
   * 本场数值启用哪几项。空数组 = 整块不显示、提示词里也没有（与引擎同一判定函数，
   * 别在界面里再写一份 —— 两处只要有一处不同，就会出现「界面显示着、模型却不知道」）。
   */
  const varKeys = useMemo(
    () => varsEnabledKeys(tavernSettings ?? DEFAULT_TAVERN_SETTINGS),
    [tavernSettings],
  )

  const nameOf = useCallback((id: string) => chars.find(c => c.id === id)?.name ?? '', [chars])

  /**
   * 导出文档时「这句是谁说的」（B5）：按**角色名**署名。
   * 用「角色」这种占位名在导出稿里等于没署 —— 多角色同场时整篇就认不出谁在说。
   */
  const exportSpeakerOf = useCallback((m: TavernMessage): SpeakerInfo => {
    if (m.role === 'user') {
      return { label: (session?.userCharId && nameOf(session.userCharId)) || '你', side: 'user' }
    }
    return { label: nameOf(m.speakerId ?? '') || '角色', side: 'ai' }
  }, [session?.userCharId, nameOf])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await store.listFreeSessions())
    } catch {
      showToast('读取会话列表失败', 'error')
    }
  }, [])

  /** 故事列表（左栏把对话挂在故事下面；老大 2026-09-16 定） */
  const refreshStories = useCallback(async () => {
    try { setStories(await listStories()) } catch { setStories([]) }
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
        await refreshStories()
      } catch (e) {
        showToast(`读取失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, [refreshStories])

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
        const aiFirst = cards.find(c => c.id !== s.userCharId)
        setStatusCharId(prev => (cards.some(c => c.id === prev) ? prev : (aiFirst?.id ?? primary?.id ?? '')))
        // 打开就补算「这几天的生活」（方案 §4.6 ② 的同一思路：无服务端只能靠打开时补）
        if (primary) void advanceIfNeeded(primary, await store.getDaily(primary.id).catch(() => null))
      } else {
        setMems({})
        setStatusCharId('')
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
      /**
       * 剧本 → **快照**。
       * 🔴 存快照而不是只存 id：剧本是可编辑的，只存引用的话作者改一次剧本，
       *    所有引用过它的历史会话都会被悄悄改写 —— 那种问题几乎反推不到原因。
       * 开场白走**消息通道**（对话的第一条），不进 system：塞进 system 会让模型以为
       * 用户已经说过这句，也会白占每轮的常驻额度。
       */
      const script = d.scriptId ? await getScript(d.scriptId).catch(() => null) : null
      const snap = script ? snapshotOf(script) : null
      const opening = snap ? openingToMessage(snap) : ''
      const created = await store.createFreeSession(
        d.charIds, d.title || title, { providerId: '' }, {}, d.userCharId || undefined, d.storyId || undefined)
      const withOpening: FreeSession = {
        ...created,
        ...(snap ? { scriptId: snap.scriptId, script: snap } : {}),
        ...(opening ? { messages: [{ id: uid(), role: 'user' as const, content: opening, at: Date.now() }] } : {}),
      }
      await store.saveFreeSession(withOpening)
      setSetupOpen(false)
      await refreshSessions()
      await refreshStories()
      setSession(withOpening)
      await loadSessionContext(withOpening)
      const aiNames = d.charIds.filter(id => id !== d.userCharId).map(nameOf).filter(Boolean).join('、')
      const who = d.userCharId
        ? `你演 ${nameOf(d.userCharId)}，AI 演 ${aiNames}`
        : d.charIds.length > 1
          ? '多角色会话（发言顺序由语境决定，也可点顶部头像指定下一位）'
          : `与 ${aiNames} 的对话`
      showToast(snap
        ? `已新建对话（剧本「${snap.name}」）—— ${who}`
        : `已新建对话 —— ${who}（记忆按角色共享，换会话不会重来）`)
    } catch (e) {
      showToast(`新建失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [nameOf, refreshSessions, refreshStories, loadSessionContext])

  // ---------- 结束本轮对话（一次性收尾：记忆 + 日记 + 数值 + 设定） ----------
  /**
   * 以前这里是「每轮说完一句就静默整理一次记忆」。本地模型跑一次要几十秒，
   * 全都压在那句之后 —— 作者的表现就是「说完卡半天」，聊越久越卡（反馈 #3）。
   *
   * 现在改成：**聊天过程中一次都不整理**，作者点「结束本轮对话」才走完这一整套。
   * 代价是本轮的对话要结束时才进长期记忆 —— 换来的是对话过程再不会被打断。
   */
  const endRound = useCallback(async () => {
    const s = session
    if (!s || ending) return
    if (s.endedAt) { showToast('本轮已经结束了', 'info'); return }

    const pending = pendingMessages(s)
    if (pending.length === 0 && s.messages.length === 0) {
      showToast('这个对话还是空的', 'info')
      return
    }

    const ok = await confirmDialog({
      title: '结束本轮对话',
      message: [
        `现在就让 AI 整理这一场（${s.messages.length} 条），然后把它归档。`,
        '',
        '整理内容包括：各角色的记忆、Ta 的第一人称日记、本场数值，以及要不要改设定的建议。',
        '结束后这一场会变成只读，想继续就新开一场。',
      ].join('\n'),
      danger: false,
    })
    if (!ok) return

    setEnding(true)
    setEndStage(null)
    setEndResult(null)
    try {
      if (!acquireSummaryLock(Date.now(), lim.lockTtlMs)) {
        showToast('另一个窗口正在收尾', 'info')
        return
      }
      const res = await runRoundEnd({
        session: s,
        cards: castCards,
        providerId: summaryProviderId || undefined,
        limits: { longTermLimit: lim.longTermLimit, diaryDays: lim.diaryDays },
        varKeys,
        vars: s.vars,
        maxStep: (tavernSettings ?? DEFAULT_TAVERN_SETTINGS).vars.maxStep,
        nameOf: (id?: string) => nameOf(id ?? ''),
        onProgress: setEndStage,
      })

      // 水位线推进到最后一条 + 写回数值 + 打上归档戳
      const updated: FreeSession = {
        ...s,
        watermark: nextWatermark(s) ?? s.watermark,
        vars: res.vars,
        endedAt: res.endedAt,
        updatedAt: Date.now(),
      }
      await store.saveFreeSession(updated)
      setSession(cur => (cur && cur.id === updated.id ? updated : cur))
      setMems(prev => ({ ...prev, ...Object.fromEntries(res.memories.map(m => [m.charId, m])) }))

      const n = Object.keys(res.journals).length
      showToast(`本轮已结束 —— ${res.memories.length} 位角色的记忆已更新${n ? `，写了 ${n} 条日记` : ''}`)

      setEndResult(res)
      // 有设定建议就顺手摊开给作者裁决 —— 都到这一步了，让他再点一次按钮纯属多余
      if (res.proposals.length > 0) {
        setProposals(res.proposals)
        setPicked(new Set(res.proposals.map(p => p.id)))
        setReviseError('')
        setReviseOpen(true)
      }
      await refreshSessions()
    } catch (e) {
      showToast(`结束失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      releaseSummaryLock()
      setEnding(false)
      setEndStage(null)
    }
  }, [session, ending, castCards, summaryProviderId, lim, varKeys, tavernSettings, nameOf, refreshSessions])

  /**
   * 设定更新：对**在场每个角色**分别审查一遍。
   *
   * 为什么每个都要跑：关系是**双向**的（用户演的阿岩提分手，阿岩与小满两张卡的「2.4 关系」都该改），
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
    // 🔴 归档后只读：这一场已经整理归档再去改它，记忆与日记就会和正文对不上
    if (session.endedAt) {
      showToast('本轮对话已结束 —— 想接着聊请新开一场', 'info')
      return
    }
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
      setPostNotice({ applied: res.postApplied, errors: res.postErrors })
      await refreshSessions()
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
  }, [input, session, charCard, streaming, refreshSessions, castCards, speakNext])

  // ---------- 消息级操作（与剧情推演同一套；自由模式多一条：重说时**保持原来的说话人**） ----------
  const lastAiId = useMemo(() => store.lastAssistantId(session?.messages ?? []), [session])

  const commit = async (next: FreeSession) => {
    setSession(next)
    await store.saveFreeSession(next).then(refreshSessions).catch(() => undefined)
  }

  // ---------- 本场数值（C2 第二步）：作者手改 ----------
  /**
   * 手改一个数值。
   * 🔴 走 `setVarManually`（与模型增量同一个写入关口）→ 夹取、去重、变更记录只有一套规则；
   *    并标记来源 manual —— 重说时**不会**把作者刚改的数翻回去（那是作者的手，比模型准）。
   */
  const setVar = (key: VarKey, raw: string) => {
    if (!session) return
    const cur = varsOf(session, varKeys)
    const applied = setVarManually(cur.values, key, raw)
    if (applied.changes.length === 0) return
    const next = recordVarChanges({ ...cur, values: applied.values }, applied.changes, turnSeqOf(session.messages), 'manual')
    void commit({ ...session, vars: next })
    showToast(`已改为 ${applied.changes.map(c => `${c.label} ${String(c.to || '空')}`).join('、')}`)
  }

  const resetVars = async () => {
    if (!session || varKeys.length === 0) return
    const cur = varsOf(session, varKeys)
    const applied = resetVarValues(cur.values, varKeys)
    if (applied.changes.length === 0) { showToast('数值已经在初始值上了', 'info'); return }
    const okGo = await confirmDialog({
      title: '重置本场数值？',
      message: `${applied.changes.map(c => c.label).join('、')} 会回到初始值（好感/信任 50、剧情进度 0，文本清空）。\n这一场的变动记录会保留，但数值本身回不去 —— 要恢复得再手改一遍。`,
      confirmText: '重置',
      danger: true,
    })
    if (!okGo) return
    const next = recordVarChanges({ ...cur, values: applied.values }, applied.changes, turnSeqOf(session.messages), 'manual')
    void commit({ ...session, vars: next })
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
      setPostNotice({ applied: res.postApplied, errors: res.postErrors })
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

  /** 临时导演指令（B2）：与剧情推演同一套；落库即生效，传 null 即清除 */
  const applyDirectorNote = async (note: TavernDirectorNote | null) => {
    if (!session) return
    const next = store.setDirectorNote(session, note)
    setSession(next)
    await store.saveFreeSession(next).catch(() => undefined)
  }

  /**
   * 快捷指令条：走协议 R4 的**导演指令**通道（「」= 照做然后继续演）。
   * 🔴 点击**只填进输入框、不直接发送** —— 这些指令几乎都要作者改一处（推进多久），
   *    直接发出去等于替作者作了决定。带 slot 的（推进时间）会把那一段选中，直接改即可。
   */
  const quickActions: QuickAction[] = [
    { key: 'cont', label: '继续', hint: '让 Ta 接着说', text: '「继续。」' },
    { key: 'env', label: '补环境', hint: '先补一句（ ）里的环境（光、声、气味），再接着说', text: '「先说一句（ ）里的环境（光、声、气味），再继续。」' },
    { key: 'time', label: '推进时间', hint: '把时间往前推 —— 填进输入框后自己改成需要的时长', text: '「把时间往前推进 半小时，然后继续。」', slot: '半小时' },
    { key: 'mind', label: 'Ta 在想什么', hint: '用一个动作或细节透出心里的想法，不直接写心理', text: '「用一个动作或细节写出 Ta 此刻心里在想什么，不要直接写心理。」' },
    { key: 'reroll', label: '重说', hint: '用同一段历史让 Ta 重说这一条（只出一个结果，说话人不变）', run: () => void reroll() },
  ]

  /** 输入框 ref：预填后要聚焦并把「该改的那一段」选中 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  /**
   * 快捷指令预填：把预制文本填进输入框、聚焦，并把该改的那段选中（不发送）。
   * ⚠️ 选区要等 React 把新值渲染进 textarea 之后再设 —— 同步 setState 后立刻设会选到旧值。
   */
  const fillInput = (text: string, slot?: string) => {
    setInput(text)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      const i = slot ? text.indexOf(slot) : -1
      if (i >= 0) el.setSelectionRange(i, i + slot!.length)
      else el.setSelectionRange(text.length, text.length)
    })
  }

  const stop = () => { abortRef.current?.abort() }

  const removeSession = async () => {
    if (!session) return
    const okGo = await confirmDialog({
      title: '删除这个会话？',
      message: '对话记录会一并删除。\n注意：Ta的记忆是按角色存的，所以记忆不会跟着消失。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    await store.deleteFreeSession(session.id)
    setSession(null)
    setCastCards([])
    setCharCard(null)
    setMems({})
    setStatusCharId('')
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

  /**
   * 左栏树：故事（父）→ 对话（子）。过滤词同时作用于故事名与对话（标题 / 在场角色）。
   *
   * 「未归属」抽屉必留：会话的归属是**推**出来的（自己存的 storyId，或按在场角色反推），
   * 故事被删、卡被删之后就会推不出来 —— 那些对话必须有地方安身，
   * 否则它们会从列表里凭空消失，而作者只会以为「对话丢了」。
   */
  const tree = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const hit = (s: FreeSessionIndexItem) =>
      !kw || `${s.title} ${s.charIds.map(nameOf).join(' ')}`.toLowerCase().includes(kw)
    const kept = sessions.filter(hit)
    const groups = stories
      .map(st => ({ id: st.id, name: storyDisplayName(st), rows: kept.filter(s => sessionStoryId(s, chars) === st.id) }))
      // 过滤时把空组隐掉（否则搜一个词会剩一排空标题）；不过滤时保留，让作者看见结构
      .filter(g => !kw || g.rows.length > 0)
    const orphan = kept.filter(s => {
      const sid = sessionStoryId(s, chars)
      return !sid || !stories.some(st => st.id === sid)
    })
    return { groups, orphan, total: kept.length }
  }, [sessions, stories, chars, q, nameOf])

  const toggleStory = (id: string) =>
    setClosedStoryIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))

  /** 一场对话在左栏树里的样子（故事分组与「未归属」两处共用，抽出来免得走样） */
  const renderSessionRow = (s: FreeSessionIndexItem) => {
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
          <span className="shrink-0 text-[10.5px] text-ink-600">{agoText(s.lastActiveAt)}</span>
        </div>
      </button>
    )
  }

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
  /**
   * 状态一览（批次 8，C2 第一步：只读）。
   * 只吃**已经加载好**的两样东西（在场角色卡 + 每位角色的记忆），不额外读库 ——
   * 否则同一份数据就有两个来源，哪天两边不同步会很难查。
   */
  const statusModel = useMemo(() => buildStatusModel({
    chars: castCards.map(c => ({ id: c.id, name: c.name, avatar: c.avatar })),
    direction: session,
    userCharId: session?.userCharId,
    memories: mems,
  }), [castCards, session, mems])

  /** 我的档案（全局）：目前只用来给「你」这一侧挂头像 */
  const myProfile = tavernSettings?.profile ?? DEFAULT_TAVERN_PROFILE
  /** 右栏「Ta这几天的生活 / 心情」跟着 statusCharId 走（角色级数据，换人换一份） */
  useEffect(() => {
    if (!statusCharId) { setDaily(null); return }
    let alive = true
    void store.getDaily(statusCharId).then(d => { if (alive) setDaily(d) }).catch(() => { if (alive) setDaily(null) })
    return () => { alive = false }
  }, [statusCharId, session?.id])

  // ---------- 渲染 ----------
  if (loading) return <div className="page-enter"><LoadingState /></div>

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      {/* 顶部：只放「本场」的操作，导航（选/新建）都在左栏 */}
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">自由对话</h1>

        <HelpPopover title="自由对话怎么用" width="24rem" size={14}>
  这里的对话不绑小说项目：换一本书，角色卡与记忆照样在。

  • 顶部几件：Ta最近几天（每日小结）、结束本轮对话（整理记忆并归档）、导出。
  • 右侧常驻「本场状态」：好感 / 信任 / 剧情进度 / 心情 这些即时数值（可直接改，改完回车生效），以及在场由 AI 扮演的角色。
  • 多角色同场时点头像可指定下一位接话；「在场调度」里能静音某个人、调健谈度。
  • 记忆按角色存、跨会话共享 —— 换一场对话不会失忆。但它**只在点「结束本轮对话」时**才整理，
    所以聊天过程中不会被整理任务卡住；整理好的记忆与日记在「角色卡片」页里看。
  • 想给这一场一个具体处境，就在新建对话时选一份剧本（「故事剧本」里写，要先有故事）。
</HelpPopover>
        {session && <span className="max-w-[28rem] truncate text-[12px] text-ink-400" title={session.title}>{session.title}</span>}
        <div className="flex-1" />
        {session && (
          <>
            {!!daily?.log?.length && (
              <Button variant="secondary" size="md" onClick={() => setShowDaily(v => !v)}>
                {showDaily ? '收起这几天' : 'Ta最近几天'}
              </Button>
            )}
            {/* 已归档：先说明状态再给唯一的补救入口 —— 顺序不能反，
                否则作者第一眼看到的是「新开一场」，会以为自己的对话没了 */}
            {session.endedAt ? (
              <span className="text-[11.5px] text-amber/80">
                本轮已于 {agoText(session.endedAt)}结束（只读）
              </span>
            ) : null}
            <Button
              variant={session.endedAt ? 'secondary' : 'danger'} size="md"
              disabled={ending || !!session.endedAt}
              title={session.endedAt
                ? '这一场已经整理归档了'
                : '整理这一场：更新各角色记忆、写本场日记、结算数值，并把对话归档为只读'}
              onClick={() => void endRound()}
            >
              {ending ? '收尾中…' : (session.endedAt ? '已结束' : '结束本轮对话')}
            </Button>
            <Button
              variant="secondary" size="md" disabled={streaming || session.messages.length === 0}
              onClick={() => setExportOpen(true)}
              title="把这场对话导出成 Markdown 或带样式的单文件 HTML"
            >
              导出
            </Button>
            <Button
              variant="secondary" size="md" onClick={() => setStatusOpen(v => !v)}
              title="对话上方那条一览：场景、在场角色与记忆计数（只读）。本场数值在右侧「本场状态」里改"
            >
              {statusOpen ? '收起角色状态' : '角色状态'}
            </Button>
            <Button variant="danger" size="md" onClick={() => void removeSession()}>删除对话</Button>
          </>
        )}
      </header>

      {/* 元指令速查：**必须留在 header 外面** —— 放进输入区的话，没有会话时那块不渲染，
          新用户就永远看不到「可以用「」指挥 Ta」这条。这里常驻可见。 */}
      <TavernEchoHints className="mt-3 shrink-0" />

      <div className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* 左栏：会话列表（全局，跨角色 —— 页面不再有角色列表） */}
        <aside className="flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-ink-800 bg-ink-850/40 p-3">
          <Button
            variant="primary" size="md" className="w-full"
            onClick={async () => {
              if (stories.length === 0) {
                showToast('还没有故事 —— 先去「故事剧本」建一个（世界观由故事提供）', 'info')
                return
              }
              if (chars.length === 0) { showToast('还没有角色卡 —— 先去「角色卡片」建一张', 'info'); return }
              await refreshStories()
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
            {tree.groups.map(g => {
              const closed = closedStoryIds.includes(g.id)
              return (
                <div key={g.id} className="space-y-0.5">
                  {/* 故事（父）：只有这一组的对话才画出来；空组留个「还没有对话」的痕迹，
                      否则作者会以为「我在这故事下开的那场不见了」 */}
                  <button
                    type="button"
                    onClick={() => toggleStory(g.id)}
                    title={closed ? '展开这个故事的对话' : '收起这个故事的对话'}
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-ink-800/60"
                  >
                    <span className={`shrink-0 text-[10px] ${closed ? 'text-ink-600' : 'text-amber/80'}`}>
                      {closed ? '▸' : '▾'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-300">{g.name}</span>
                    <span className="shrink-0 text-[10px] text-ink-600">{g.rows.length}</span>
                  </button>
                  {!closed && (
                    <div className="ml-3 space-y-1 border-l border-ink-800 pl-1.5">
                      {g.rows.map(s => renderSessionRow(s))}
                      {g.rows.length === 0 && (
                        <p className="px-1 py-1 text-[10.5px] text-ink-600">还没有对话</p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* 未归属：故事被删 / 卡被删之后推不出归属的对话，放这儿等着作者处理 */}
            {tree.orphan.length > 0 && (
              <div className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => toggleStory('__orphan__')}
                  title={closedStoryIds.includes('__orphan__') ? '展开' : '收起'}
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-ink-800/60"
                >
                  <span className={`shrink-0 text-[10px] ${closedStoryIds.includes('__orphan__') ? 'text-ink-600' : 'text-amber/80'}`}>
                    {closedStoryIds.includes('__orphan__') ? '▸' : '▾'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-300">未归属</span>
                  <span className="shrink-0 text-[10px] text-ink-600">{tree.orphan.length}</span>
                </button>
                {!closedStoryIds.includes('__orphan__') && (
                  <div className="ml-3 space-y-1 border-l border-ink-800 pl-1.5">
                    {tree.orphan.map(s => renderSessionRow(s))}
                  </div>
                )}
              </div>
            )}

            {tree.total === 0 && (
              <p className="px-1 py-2 text-[11px] leading-relaxed text-ink-500">
                {sessions.length === 0
                  ? '还没有对话 —— 点上面「新建对话」开一场（要先有故事）。'
                  : '没有匹配的对话。'}
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
                先到「故事剧本」建一个<b className="text-ink-400">故事</b>（这个世界什么样），
                再到「角色卡片」建一张卡（它属于哪个故事）。
                <br />
                填好第 4 章「示例对话」，Ta 会立刻像那个人。建好后回到这里点「＋ 新建对话」。
              </p>
            </div>
          </div>
        ) : !session ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-ink-800">
            <div className="text-center">
              <p className="text-[13px] text-ink-300">还没有选择对话</p>
              <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
                从左栏点一场继续，或「＋ 新建对话」开一场 —— 新建时要先选一个故事，
                再从这个故事的角色里挑人（可以单角色聊，也能让两三个角色同场）。
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
                      {/* 场景与记忆新鲜度已收进下方「状态」一览（同一信息不写两处）；
                          这里只留它不显示的：心情（这是**当前页签角色**的心情）与整理进度 */}
                      {daily?.mood && <span className="text-amber/80">心情：{daily.mood}</span>}
                      {ending && (
                        <span className="text-amber">
                          {endStage ? STAGE_TEXT[endStage.stage] : '收尾中…'}
                          {endStage && endStage.total > 1 ? `（${endStage.cur}/${endStage.total}）` : ''}
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
                        <Avatar src={c.avatar} name={c.name} size={20} />
                        <span className="text-[11px] text-ink-200">{c.name}</span>
                      </button>
                    ))}
                    <Button variant="secondary" size="xs"
                      onClick={() => setDirectorOpen(true)}
                      title="静音（在场但不发言）与健谈度" className="shrink-0"
                    >
                      在场调度
                    </Button>
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

              <TavernStatusBar
                model={statusModel}
                sceneText={
                  [session.scene?.place, session.scene?.time].filter(Boolean).join(' · ')
                  // 没手填场景时用剧本的名字与情境顶上（这一场本来就有处境，不该显示"未设定"）
                  || scriptSceneLine(session.script)
                }
                collapsed={!statusOpen}
              />

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* 很久没来时Ta留着的一句话（§7.5）：不弹通知，就放在对话里等Ta看见 */}
                {greeting && (
                  <div className="rounded-lg border border-amber/30 bg-amber/8 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[10.5px] text-amber/80 mb-1">你很久没来了，Ta留下句话：</p>
                        {renderTavernMessage(greeting)}
                      </div>
                      <Button variant="secondary" size="xs" onClick={() => setGreeting('')} className="shrink-0">
                        收起
                      </Button>
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
                  // 头像规则：多角色同场必须挂（否则分不清谁在说）；单角色只有**设过头像**才挂
                  // （没设时挂一个名字首字的圆点，在单人对话里纯属视觉噪音）
                  const showWho = aiCards.length > 1 || !!who?.avatar
                  return (
                    <div key={m.id} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : ''}`}>
                      {m.role !== 'user' && showWho && (
                        <Avatar src={who?.avatar} name={who?.name ?? '?'} size={24} className="mt-0.5" />
                      )}
                      {/* 两侧都不带外框（老大 2026-09-15 定）：用户那侧靠右对齐 + 头像区分，
                          加气泡框反而把同一段对话切成了两种视觉语言。 */}
                      <div className={m.role === 'user'
                        ? 'max-w-[80%] space-y-1'
                        : 'max-w-[85%] space-y-1'}>
                        {m.role !== 'user' && showWho && who && (
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
                      {/* 你自己那侧：只有「我的档案」设过头像才挂 —— 没设就别占地方 */}
                      {m.role === 'user' && !!myProfile.avatar && (
                        <Avatar src={myProfile.avatar} name={myProfile.name || '我'} size={24} className="mt-0.5" />
                      )}
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
                {session.endedAt ? (
                  /* 归档后收掉整个输入区 —— 留着可打字的框，作者一定会去敲，
                     敲完发现发不出去（send 里有守卫），只会以为软件坏了。 */
                  <div className="rounded-lg border border-amber/30 bg-amber/8 px-3 py-3">
                    <p className="text-[12px] text-ink-200">
                      本轮已于 {agoText(session.endedAt)}结束 —— 这一场是只读归档了，记忆、日记与本场数值都已整理好。
                    </p>
                    <p className="mt-1 text-[11px] text-ink-500 leading-relaxed">
                      想接着往下演就新开一场：记忆与日记是跨会话共享的，Ta 不会失忆。
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button variant="primary" size="sm" onClick={() => setSetupOpen(true)}>新开一场</Button>
                    </div>
                  </div>
                ) : (
                <>
                <TavernDirectorNoteBar
                  note={session.directorNote}
                  postApplied={postNotice.applied}
                  postErrors={postNotice.errors}
                  disabled={streaming}
                  onSave={n => void applyDirectorNote(n)}
                  onClear={() => void applyDirectorNote(null)}
                />
                <TavernQuickBar actions={quickActions} disabled={streaming} onFill={fillInput} className="mb-2" />
                {/* 自动延展：默认 3 行，写长了自己长高，超过 200px 才内部滚动 */}
                {/* 按键：Enter 发送、Shift+Enter 换行（与「对话引导」一致）。
                    🔴 必须挡 isComposing —— 中文输入法里 Enter 是**选字确认键**，
                    不挡的话字打到一半就被当成发送，换成 Enter 发送后这是必踩的坑。 */}
                <AutoTextarea
                  className="bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-ink-100 outline-none focus:border-amber/50"
                  textClass="text-[13px]"
                  minRows={3}
                  maxHeight={200}
                  placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
                  value={input}
                  disabled={streaming}
                  inputRef={inputRef}
                  onChange={setInput}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                    e.preventDefault()
                    void send()
                  }}
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-ink-500">
                    本会话 {usedChars} 字
                    <button
                      type="button"
                      onClick={() => setUsageOpen(true)}
                      className="ml-2 text-amber/80 hover:text-amber underline decoration-dotted"
                      title="按真实组装量一遍：角色卡 / 背景设定 / 记忆各占多少，留给对话历史多少"
                    >
                      用量明细
                    </button>
                  </span>
                  <div className="flex gap-2">
                    {streaming
                      ? <Button variant="secondary" size="md" onClick={stop}>停止</Button>
                      : <Button variant="primary" size="md" disabled={!input.trim()} onClick={() => void send()}>发送</Button>}
                  </div>
                </div>
                </>
                )}
              </div>
            </div>

            {/* 右栏：本场状态（老大 2026-09-16 定 —— 这里不再摆记忆）
                记忆是给 AI 用的六栏档案，摆在这里既不直观、又容易让人去手改成半成品；
                作者真正想在聊的时候盯的是「好感 / 心情 / 进度」这些即时状态。 */}
            {castCards.length > 0 && (
              <aside className="w-72 shrink-0 flex flex-col rounded-lg border border-ink-800 bg-ink-850/40 min-h-0">
                <div className="px-3 py-2 border-b border-ink-800 text-[11px] text-ink-300">
                  本场状态
                  <span className="ml-1 text-[10px] text-ink-600">（属于这一场，换场重来）</span>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {/* 本场数值：**全项目唯一的显示与修改入口**（2026-09-16 去重 ——
                      原先中间那条状态栏里还有一份只读/可改的副本，已删）。 */}
                  <TavernVarsPanel
                    vars={session.vars}
                    varKeys={varKeys}
                    onSetVar={setVar}
                    onResetVars={() => void resetVars()}
                  />

                  {/* 在场的人：只列 AI 扮演的 —— 用户自己演的那位不是观察对象。
                      点一个 = 把上面「Ta这几天的生活 / 心情」切到这位名下（多角色时才有意义）。 */}
                  <div className="border-t border-ink-800 pt-2">
                    <div className="text-[10.5px] text-ink-500 mb-1">
                      AI 扮演{aiCards.length > 1 && <span className="text-ink-600">（点名字看他这几天的生活）</span>}
                    </div>
                    <ul className="space-y-1">
                      {aiCards.map(c => {
                        const on = aiCards.length > 1 && c.id === statusCharId
                        return (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => setStatusCharId(c.id)}
                              title={aiCards.length > 1 ? `看 ${c.name || 'Ta'} 这几天的生活` : undefined}
                              className={`w-full flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors ${
                                on ? 'border-amber/40 bg-amber/10' : 'border-transparent hover:bg-ink-800/60'
                              }`}
                            >
                              <Avatar src={c.avatar} name={c.name} size={18} />
                              <span className={`truncate text-[11.5px] ${on ? 'text-amber' : 'text-ink-200'}`}>
                                {c.name || '（未命名）'}
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                </div>

                <div className="p-2 border-t border-ink-800">
                  <p className="text-[10.5px] text-ink-600 leading-relaxed">
                    这些状态只在<span className="text-ink-500">点「结束本轮对话」时</span>结算 ——
                    聊天过程中不跑整理，所以不会卡住对话。
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

      {session && (
        <TavernUsageDialog
          open={usageOpen}
          onClose={() => setUsageOpen(false)}
          mode="free"
          session={session}
          chars={castCards}
        />
      )}

      {/* 收尾摘要：告诉作者这一场到底整理出了什么。
          没有它就等于「点了结束，什么也没看见」—— 人家会怀疑到底跑没跑。 */}
      <Modal
        open={!!endResult}
        onClose={() => setEndResult(null)}
        title="本轮已结束"
        width="lg"
        footer={
          <Button variant="primary" size="sm" onClick={() => setEndResult(null)}>知道了</Button>
        }
      >
        {endResult && (
          <div className="space-y-3">
            <p className="text-[11.5px] text-ink-400">
              这一场整理好了：{endResult.memories.length} 位角色的记忆已更新，对话已归档为只读。
              想接着往下演就新开一场 —— 记忆是跨会话共享的，Ta 不会失忆。
            </p>

            {endResult.varChanges.length > 0 && (
              <div>
                <div className="text-[11px] text-amber/80">本场数值</div>
                <ul className="mt-0.5 space-y-0.5">
                  {endResult.varChanges.map((c, i) => (
                    <li key={i} className="text-[11.5px] text-ink-300">
                      {c.label}：{String(c.from || '空')} → {String(c.to || '空')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <div className="text-[11px] text-amber/80">写进 Ta 的日记</div>
              {Object.keys(endResult.journals).length === 0 ? (
                <p className="mt-0.5 text-[11.5px] text-ink-500">这次没有产出小结。</p>
              ) : (
                <ul className="mt-0.5 space-y-2">
                  {castCards.filter(c => endResult.journals[c.id]).map(c => (
                    <li key={c.id}>
                      <div className="text-[11.5px] text-ink-200">{c.name || '（未命名）'}</div>
                      <div className="text-[11.5px] text-ink-300 whitespace-pre-wrap leading-relaxed">
                        {endResult.journals[c.id]}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[10.5px] text-ink-600">
                日记只给作者回顾用，不会注进以后的对话；完整内容在「角色卡片」页底部。
              </p>
            </div>
          </div>
        )}
      </Modal>

      {session && (
        <TavernExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          docTitle={session.title}
          kindLabel="对话记录"
          messageCount={session.messages.filter(m => m.role !== 'system').length}
          hiddenCount={session.messages.filter(m => m.hidden).length}
          build={o => freeDocModel(session, {
            ...o,
            nameOf,
            speakerOf: exportSpeakerOf,
            userLabel: (session.userCharId && nameOf(session.userCharId)) || '你',
          })}
        />
      )}

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
