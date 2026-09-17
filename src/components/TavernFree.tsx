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
import { ChevronDown, Pencil } from 'lucide-react'
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
import { runFreeTurn, varsEnabledKeys, resolveTavernProvider, runFreeAssist } from '../lib/tavern/engine'
import { unloadOllamaModel, isCancelled } from '../lib/ai'
import { refreshSessionVars } from '../lib/tavern/varsRefresh'
import type { PostApplied } from '../lib/tavern/postRules'
import { advanceDaily, shouldAdvanceDaily } from '../lib/tavern/daily'
import { proposeCardRevisions, type CardRevision } from '../lib/tavern/revise'
import { uid } from '../lib/id'
import { nextWatermark, acquireSummaryLock, releaseSummaryLock } from '../lib/tavern/memory'
import {
  type FreeCharacter, type FreeMemory, type FreeSession, type TavernMessage, type TavernDirectorNote,
  type FreeSessionIndexItem, type TavernCharIndexItem, type DailyState,
  type VarKey, type TavernStoryIndexItem, sessionStoryId, type CharVars, type TavernVars,
} from '../lib/tavern/types'
import { varsOf, setVarManually, resetVarValues, recordVarChanges, turnSeqOf, migrateVarScale, VAR_SCALE, setCharNote, emptyVars } from '../lib/tavern/vars'
import { scriptSceneLine, snapshotOf, openingToMessage } from '../lib/tavern/script'
import { getScript } from '../lib/tavern/script'
import { getTavernSettings, memoryLimitsOf, DEFAULT_TAVERN_SETTINGS, DEFAULT_TAVERN_PROFILE, type TavernSettings } from '../lib/tavern/settings'
import { listStories, storyDisplayName, getStory, snapshotStorySetting } from '../lib/tavern/story'
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

/**
 * 本场状态的「主角色」= **AI 扮演的第一个角色**（排除用户扮演的那个）。
 * 用户把「我演」放在位置 1 时 charIds[0] 就是用户卡 —— 此前 #4 把主角色死写成 charIds[0]，
 * 导致本场状态（好感/信任/精神…）被算进并回写**用户卡**而非 AI 角色卡（反馈 #16）。
 * 无 userCharId（纯 AI 多角色、用户不扮演）时回退 charIds[0]，保持旧行为。
 */
function primaryAiCharId(s: { charIds: string[]; userCharId?: string | null }): string {
  const user = s.userCharId
  if (user) {
    const ai = s.charIds.filter(id => id !== user)
    if (ai.length > 0) return ai[0]
  }
  return s.charIds[0] ?? ''
}

/** 把角色卡上的持久状态（CharVars）转成面板要的 TavernVars 形状（面板只用 values，log/turnSeq 是会话级流水，这里给空壳） */
function charVarsToTavern(cv?: CharVars): TavernVars | undefined {
  if (!cv) return undefined
  return { values: cv.values, turnSeq: 0, log: [], scale: VAR_SCALE }
}

/**
 * 反馈 #4 配套：会话自身还没数值（新会话 / 老会话未初始化）但主角色卡上已有持久数值时，
 * 把那一份拉进会话当起点 —— 上一次处出来的好感下一场接着算，而不是从 0 起；
 * 也顺手修好了反馈 #1「数值不显示」（之前 createFreeSession 从不初始化 vars，面板只能永远停在 0）。
 */
async function seedSessionVarsFromCard(s: FreeSession): Promise<FreeSession> {
  if (s.vars) return s
  const id = primaryAiCharId(s)
  if (!id) return s
  const card = await store.getFreeChar(id).catch(() => null)
  if (!card?.vars) return s
  return { ...s, vars: { values: card.vars.values, turnSeq: 0, log: [], scale: VAR_SCALE } }
}

export default function TavernFree() {
  // ---------- 数据 ----------
  /** 角色卡索引：只用来显示名字（页面不再用它做选择） */
  const [chars, setChars] = useState<TavernCharIndexItem[]>([])
  /** 当前会话的**主角色**（AI 扮演的第一个角色，见 primaryAiCharId）：本场状态挂它身上 */
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
  /** 右栏「本场状态」当前看哪位角色的数值（默认 AI 扮演的主角色）；多角色时才需切换（反馈 #4） */
  const [varsCharId, setVarsCharId] = useState('')
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
  /** 润色/自动回复生成中（与 streaming 互斥但同属「正在生成」，期间禁用快捷条与发送） */
  const [assistBusy, setAssistBusy] = useState(false)
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
  /** Ta这几天的生活与心情（方案 §4.7：靠时间差推进，没有常驻进程） */
  const [daily, setDaily] = useState<DailyState | null>(null)
  const [showDaily, setShowDaily] = useState(false)
  /**
   * 右栏当前看哪一页（2026-09-16 老大定：原先「对话上方那条角色状态」并进右栏，两页切换）。
   *
   * 默认停在「本场状态」：好感 / 信任 / 精神这些**每轮都在变**，是聊的时候盯得最多的一块。
   * 「角色状态」是整理完才长出来的（关系与计数），看一眼就切回去，没必要抢默认位。
   * 用了会话级 state（不落库）：它跟「作者此刻想看什么」有关，不是项目的持久设置。
   */
  const [statusTab, setStatusTab] = useState<'status' | 'vars'>('vars')
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
  /**
   * 「生成中又按了一次发送」的提示节流（反馈 #13）。
   * 输入框在生成期间**保持可用**（作者可以先把下一句打好），所以 Enter 会真的按下去 ——
   * 若只是静默拦截，作者会以为键盘坏了。一次生成只提示一次，别每按一下弹一个 toast。
   */
  const streamingHintRef = useRef(false)

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
      const primary = cards.find(c => c.id === primaryAiCharId(s)) ?? cards[0] ?? null
      setCharCard(primary)
      if (cards.length) {
        const rows = await Promise.all(cards.map(async c =>
          [c.id, await store.getMemory(c.id).catch(() => null)] as const))
        setMems(Object.fromEntries(rows))
        const aiFirst = cards.find(c => c.id !== s.userCharId)
        setStatusCharId(prev => (cards.some(c => c.id === prev) ? prev : (aiFirst?.id ?? primary?.id ?? '')))
        // 「这几天的生活」的补算移到**右栏那个 effect** 里（审计 P1-6）：
        // 旧实现只在这里对 cards[0] 推一次 —— 多角色同场时切到别的角色只是只读，
        // 那几位永远停在旧状态；而且 setDaily 设的是 cards[0]，与右栏默认看的 aiFirst 还可能不是同一个人。
        // 现在改成「谁被打开看，就补算谁」，一个入口、一处状态。
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
    // 不再依赖 advanceIfNeeded —— 日常推进已移到右栏那个 effect（审计 P1-6）
  }, [])

  const openSession = useCallback(async (id: string) => {
    const raw = await store.getFreeSession(id)
    /**
     * 🔴 旧刻度的会话在这里**一次性迁移**并落库（2026-09-16 老大定 D2）：
     * 三项数值从 0–100 制（好感/信任默认 50）改为 −100~+100 制（默认 0），旧值一律归零。
     *
     * 为什么不放在读取侧「顺手改」：只在内存里归零的话库里还是旧值，
     * 下次打开又会再归零一遍 —— 作者手改的数值会被**反复抹掉**。
     * `migrateVarScale` 对已经在新刻度上的会话原样返回，所以这次判断没有额外代价。
     */
    const s: FreeSession | null = raw ? migrateVarScale(raw) : null
    if (s && s !== raw) {
      await store.saveFreeSession(s).catch(() => undefined)
      // 给了提示才不会被当成「我的好感怎么突然清零了」
      showToast('本场数值的刻度已改为 −100~+100，这一场按新刻度从 0 重新计', 'info')
    }
    setSession(s)
    setStreamText('')
    setSpeakNext('')
    if (!s) return
    await loadSessionContext(s)
    // 反馈 #4：主角色卡上若有持久数值，拉进会话当起点（跨会话累积，也修好 #1 不显示）
    const seeded = await seedSessionVarsFromCard(s)
    if (seeded !== s) {
      setSession(seeded)
      await store.saveFreeSession(seeded).catch(() => undefined)
    }
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
      /**
       * 故事世界设定 → **快照**（#5 / D1，2026-09-16）。
       * 同剧本的道理：设定可编辑，只存 storyId 的话作者改一次故事，
       * 所有引用它的历史会话都会被悄悄改写。**读不到就当没有**，不让新会话失败。
       */
      const story = d.storyId ? await getStory(d.storyId).catch(() => null) : null
      const storySnap = story ? snapshotStorySetting(story) : null
      const created = await store.createFreeSession(
        d.charIds, d.title || title, { providerId: '' }, {}, d.userCharId || undefined, d.storyId || undefined)
      const withOpening: FreeSession = {
        ...created,
        ...(snap ? { scriptId: snap.scriptId, script: snap } : {}),
        ...(storySnap && storySnap.setting ? { storySetting: storySnap } : {}),
        ...(opening ? { messages: [{ id: uid(), role: 'user' as const, content: opening, at: Date.now() }] } : {}),
      }
      await store.saveFreeSession(withOpening)
      setSetupOpen(false)
      await refreshSessions()
      await refreshStories()
      setSession(withOpening)
      await loadSessionContext(withOpening)
      // 反馈 #4：若主角色卡已有持久数值，新会话接着算（跨会话累积）
      const seeded = await seedSessionVarsFromCard(withOpening)
      if (seeded !== withOpening) {
        setSession(seeded)
        await store.saveFreeSession(seeded).catch(() => undefined)
      }
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
   * 让本地 Ollama 把这一场用过的模型吐出去（#11，收尾跑完后才调）。
   *
   * 【为什么聊天模型也要卸】老大遇到的正是「清空了记忆与日记，模型扮演的角色还是有记忆」——
   *   真正带着上一场上下文的是**生成回复那个模型**，它按 keep_alive 挂在显存里。
   *   总结模型如果与它不是同一个，也一并卸掉（两个都占显存）。
   *   同一个模型只卸一次（按 类型|地址|模型名 去重），免得白跑一次 HTTP。
   *
   * 非本机 Ollama（云端 / 局域网另一台机器）会被 `unloadOllamaModel` 静默跳过，
   * 这里如实提示一句「没有可卸载的本地模型」，免得作者以为开关坏了。
   */
  const unloadLocalModels = useCallback(async () => {
    const refs: { providerId?: string }[] = []
    if (session?.model?.providerId) refs.push({ providerId: session.model.providerId })
    if (summaryProviderId) refs.push({ providerId: summaryProviderId })
    const seen = new Set<string>()
    let done = 0
    for (const ref of refs) {
      try {
        const { provider } = await resolveTavernProvider(ref)
        const key = `${provider.type}|${provider.baseUrl}|${provider.model}`
        if (seen.has(key)) continue
        seen.add(key)
        if (await unloadOllamaModel(provider)) done++
      } catch {
        // 单个解析或卸载失败不影响另一个；下面统一提示
      }
    }
    if (done > 0) showToast('已让本地模型退出显存（下一场开场会慢一点：要重新加载）', 'info')
    else showToast('没有可卸载的本地模型（云端模型不需要卸载，或本机 Ollama 未响应）', 'info')
  }, [session, summaryProviderId])

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
    // 🔴 取锁必须在 try **之外**（审计 P1-3）：旧写法把取锁放在 try 里，
    //    而 `finally` 无条件 releaseSummaryLock() —— 取锁失败（说明锁在**别人**手里）时
    //    也会执行 finally，把别人的锁删掉，防并发形同虚设。
    //    （TavernPlot 的 runPlotSummary 本来就是正确写法，这里对齐。）
    if (!acquireSummaryLock(Date.now(), lim.lockTtlMs)) {
      showToast('另一个窗口正在收尾', 'info')
      setEnding(false)
      return
    }
    try {
      const res = await runRoundEnd({
        session: s,
        cards: castCards,
        providerId: summaryProviderId || undefined,
        // 反馈 #4：本场数值算完回写主角色卡（持久、跨会话累积）
        primaryCharId: primaryAiCharId(s),
        // hardLimit 必须传：不传就永远走内置 3000，面板调的「记忆硬上限」是死的（审计 P1-1）
        limits: { longTermLimit: lim.longTermLimit, diaryDays: lim.diaryDays, hardLimit: lim.hardLimit },
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
        // 🔴 默认**一条都不勾**（审计 P2）：设定改动会动角色卡的根本，老大 2026-09-16 的原话是
        //    「由于会涉及到角色卡的根本性变化，所以需要用户确认修改内容」。
        //    默认全勾等于给了一句「一键全采纳」，与「逐条裁决」的初衷相反。
        setPicked(new Set())
        setReviseError('')
        setReviseOpen(true)
      }
      await refreshSessions()

      // 🔴 #11：卸载排在这一步**之后**（D4 硬约束）。
      //    到这里的含义是：记忆/日记/数值/设定建议全部产出、会话也已落库、列表也刷过了 ——
      //    后面不再有任何模型调用，此时卸载才是安全的。
      //    中途卸会让后面的收尾步骤先等一次模型重新加载（本地 27B 上几十秒），得不偿失。
      //    失败只提示，**绝不**把这一轮收尾判成失败：卸载是锦上添花的事。
      if ((tavernSettings ?? DEFAULT_TAVERN_SETTINGS).free.unloadAfterRoundEnd) {
        void unloadLocalModels()
      }
    } catch (e) {
      showToast(`结束失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      releaseSummaryLock()
      setEnding(false)
      setEndStage(null)
    }
  }, [session, ending, castCards, summaryProviderId, lim, varKeys, tavernSettings, nameOf, refreshSessions, unloadLocalModels])

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

  // ---------- 本场数值：把状态落回角色卡（定义在 send 之前，避免 useCallback 依赖数组触发 TDZ） ----------
  /** 把一份角色卡状态落库并刷新内存（反馈 #4：状态存卡、跨会话累积）。通用：任何角色 id 都能用。 */
  const persistCharVars = useCallback(async (charId: string, cv: CharVars) => {
    const card = await store.getFreeChar(charId).catch(() => null)
    if (!card) return
    const updated = { ...card, vars: cv }
    await store.saveFreeChar(updated).catch(() => undefined)
    setCharCard(prev => (prev && prev.id === charId ? updated : prev))
    setCastCards(prev => prev.map(c => (c.id === charId ? updated : c)))
  }, [])

  // ---------- 对话 ----------
  /** preset = 快捷指令条递过来的一句现成话（走导演指令通道）；不传就用输入框里的 */
  const send = useCallback(async (preset?: string) => {
    const text = (preset ?? input).trim()
    if (!text || !session || !charCard) return
    /**
     * 生成中又按了一次发送（反馈 #13）。
     * 输入框现在**不被 disable**，作者能先把下一句打好 —— 所以 Enter 是真按下去的，
     * 🔴 不能只是静默 return：那会让作者以为键盘失灵。提示一次即可（ref 节流）。
     */
    if (streaming) {
      if (!streamingHintRef.current) {
        streamingHintRef.current = true
        showToast('Ta 还在说 —— 这句说完再接你的下一句', 'info')
      }
      return
    }
    // 🔴 归档后只读：这一场已经整理归档再去改它，记忆与日记就会和正文对不上
    if (session.endedAt) {
      showToast('本轮对话已结束 —— 想接着聊请新开一场', 'info')
      return
    }
    if (!preset) {
      setInput('')
      // 发送后把光标留在（已清空的）输入框里：沉浸聊天时下一句直接打，
      // 不用每轮再抬手点一次框（老大 2026-09-16 反馈 #13）。
      // ⚠️ 必须等 React 把空值渲染进去再聚焦 —— 同步 setState 后立刻 focus 会跟重渲染打架。
      requestAnimationFrame(() => inputRef.current?.focus())
    }
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
      setStreamText('')
      // 反馈 #5：先把这一轮完整回复作为消息立刻显示，文字常驻不闪退；后面的数值结算在后台跑（只更新右栏），不再清空正文导致「文字消失再重现」。
      setSession(res.session)
      /**
       * 每轮刷新本场数值（2026-09-16 老大反馈 #4）。
       * 这一步还要再等一次小调用 —— 先把阶段提示换上，否则正文都出来了界面还卡着，像死机。
       * 刷新结果与正文**同一笔落库**：数值跟它所依据的那条回复不能分家。
       */
      setPhase('正在结算本场数值…')
      const withVars = await refreshSessionVars({
        session: res.session,
        keys: varKeys,
        maxStep: (tavernSettings ?? DEFAULT_TAVERN_SETTINGS).vars.maxStep,
        nameOf: id => nameOf(id ?? ''),
        providerId: summaryProviderId || undefined,
        signal: ctrl.signal,
        // 反馈 #4：抽取时把主角色卡当前备注当上下文；算完把新值＋新备注回写卡（持久、跨会话累积）
        primaryCharId: primaryAiCharId(res.session),
        charVars: charCard?.vars,
        persistCharVars,
      })
      const saved = await store.saveFreeSession(withVars)
      setSession(saved)
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
      streamingHintRef.current = false
    }
  }, [input, session, charCard, streaming, refreshSessions, castCards, speakNext, varKeys, tavernSettings, summaryProviderId, nameOf, persistCharVars])

  // ---------- 消息级操作（与剧情推演同一套；自由模式多一条：重说时**保持原来的说话人**） ----------
  const lastAiId = useMemo(() => store.lastAssistantId(session?.messages ?? []), [session])

  const commit = async (next: FreeSession) => {
    setSession(next)
    await store.saveFreeSession(next).then(refreshSessions).catch(() => undefined)
  }

  // ---------- 本场数值（C2 第二步）：作者手改 + 回写角色卡 ----------

  /**
   * 手改一个数值（主角色）。
   * 🔴 走 `setVarManually`（与模型增量同一个写入关口）→ 夹取、去重、变更记录只有一套规则；
   *    并标记来源 manual —— 重说时**不会**把作者刚改的数翻回去（那是作者的手，比模型准）。
   * 同时把新值回写主角色卡（反馈 #4：跨会话累积）。
   */
  const setVar = (key: VarKey, raw: string) => {
    if (!session) return
    const cur = varsOf(session, varKeys)
    const applied = setVarManually(cur.values, key, raw)
    if (applied.changes.length === 0) return
    const next = recordVarChanges({ ...cur, values: applied.values }, applied.changes, turnSeqOf(session.messages), 'manual')
    void commit({ ...session, vars: next })
    // 回写主角色卡：备注沿用卡上已有的（手改数值不动备注）
    const id = primaryAiCharId(session)
    if (id) void persistCharVars(id, { values: next.values ?? applied.values, notes: charCard?.vars?.notes ?? {} })
    showToast(`已改为 ${applied.changes.map(c => `${c.label} ${String(c.to || '空')}`).join('、')}`)
  }

  /** 改主角色某项的备注（作者手改入口）；空串＝清掉这条备注 */
  const setPrimaryNote = (key: VarKey, text: string) => {
    if (!charCard) return
    const cv = setCharNote(charCard.vars, key, text)
    void persistCharVars(charCard.id, cv)
  }

  /** 手改非主角色的数值（多角色同场，右栏切到某位时） */
  const setOtherVar = (charId: string, key: VarKey, raw: string) => {
    const card = castCards.find(c => c.id === charId)
    if (!card) return
    const cur = card.vars?.values ?? {}
    const applied = setVarManually(cur, key, raw)
    if (applied.changes.length === 0) return
    void persistCharVars(charId, { values: applied.values, notes: { ...(card.vars?.notes ?? {}) } })
    showToast(`已改为 ${applied.changes.map(c => `${c.label} ${String(c.to || '空')}`).join('、')}`)
  }

  /** 改非主角色某项的备注 */
  const setOtherNote = (charId: string, key: VarKey, text: string) => {
    const card = castCards.find(c => c.id === charId)
    if (!card) return
    void persistCharVars(charId, setCharNote(card.vars, key, text))
  }

  /** 把某位非主角色的本卡数值归零（多角色同场，右栏切到该角色时可用） */
  const resetOtherVars = (charId: string) => {
    void persistCharVars(charId, { values: emptyVars(varKeys).values, notes: {} })
    showToast('已将该角色本卡数值归零')
  }

  const resetVars = async () => {
    if (!session || varKeys.length === 0) return
    const cur = varsOf(session, varKeys)
    const applied = resetVarValues(cur.values, varKeys)
    if (applied.changes.length === 0) { showToast('数值已经在初始值上了', 'info'); return }
    const okGo = await confirmDialog({
      title: '重置本场数值？',
      message: `${applied.changes.map(c => c.label).join('、')} 会回到初始值（数值归 0，心情与地点清空）。\n这一场的变动记录会保留，但数值本身回不去 —— 要恢复得再手改一遍。\n（重置只清这一场的数值，角色卡上累积的状态也会一并归零。）`,
      confirmText: '重置',
      danger: true,
    })
    if (!okGo) return
    const next = recordVarChanges({ ...cur, values: applied.values }, applied.changes, turnSeqOf(session.messages), 'manual')
    void commit({ ...session, vars: next })
    // 角色卡上的持久状态一并归零
    const id = primaryAiCharId(session)
    if (id) void persistCharVars(id, { values: next.values ?? applied.values, notes: {} })
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
    // 🔴 归档守卫：结束本轮对话之后这一场是**只读**的 —— 重说会真调模型并 store.saveFreeSession()
    //    落库，把归档那一刻的记忆/日记与正文彻底对不上（这正是 send() 那条注释想防的事）。
    if (session.endedAt) {
      showToast('这一场已经结束了（只读归档）—— 想接着聊请新开一场', 'info')
      return
    }
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
      setStreamText('')
      // 反馈 #5：重说也先把新回复作为消息立刻显示，文字常驻；数值结算在后台跑（只更新右栏）。
      setSession(res.session)
      // 重说同样要刷新数值（反馈 #4）：回复换了，这一轮的关系走向也就跟着换
      setPhase('正在结算本场数值…')
      const withVars = await refreshSessionVars({
        session: res.session,
        keys: varKeys,
        maxStep: (tavernSettings ?? DEFAULT_TAVERN_SETTINGS).vars.maxStep,
        nameOf: id => nameOf(id ?? ''),
        providerId: summaryProviderId || undefined,
        signal: ctrl.signal,
        // 反馈 #4：抽取时把主角色卡当前备注当上下文；算完把新值＋新备注回写卡（持久、跨会话累积）
        primaryCharId: primaryAiCharId(res.session),
        charVars: charCard?.vars,
        persistCharVars,
      })
      const saved = await store.saveFreeSession(withVars)
      setSession(saved)
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
  // ---------- 润色 / 自动回复（AI 实时生成文本回写输入框，绝不自动发送） ----------
  const assistWrite = useCallback(async (mode: 'polish' | 'auto') => {
    if (streaming || assistBusy || !session || !session.userCharId) return
    if (session.messages.length === 0) return           // 首轮（无历史）禁用
    if (session.endedAt) return
    if (mode === 'polish' && !input.trim()) {
      showToast('输入框是空的，没有可润色的内容', 'info')
      return
    }
    const original = input
    setAssistBusy(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let buf = ''
    let lastFlush = 0
    try {
      const cast = castCards.length ? castCards : (charCard ? [charCard] : [])
      const res = await runFreeAssist(
        session,
        cast,
        mode,
        mode === 'polish' ? original.trim() : '',
        {
          signal: ctrl.signal,
          onToken: (t) => {
            buf += t
            const now = Date.now()
            if (now - lastFlush >= 120) { lastFlush = now; setInput(buf) } // 节流 ~120ms，避免高频重渲染
          },
        },
      )
      setInput(res.text.trim())                          // 最终以完整结果为准（节流可能漏掉尾部）
    } catch (e) {
      if (isCancelled(e)) setInput(buf.trim())          // 取消：保留已生成的部分
      else {
        showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
        if (mode === 'polish') setInput(original)        // 润色失败：还原原文
        else setInput('')                               // 自动回复失败：留空
      }
    } finally {
      setAssistBusy(false)
      abortRef.current = null
    }
  }, [streaming, assistBusy, session, input, castCards, charCard])

  /** 仅当用户扮演了已建角色卡、且已有历史消息（非首轮）时，润色/自动回复才可用 */
  const canAssist = !!session?.userCharId && session.messages.length > 0

  const quickActions: QuickAction[] = [
    { key: 'cont', label: '继续', hint: '让 Ta 接着说', text: '「继续。」' },
    { key: 'env', label: '补环境', hint: '先补一句（ ）里的环境（光、声、气味），再接着说', text: '「先说一句（ ）里的环境（光、声、气味），再继续。」' },
    { key: 'time', label: '推进时间', hint: '把时间往前推 —— 填进输入框后自己改成需要的时长', text: '「把时间往前推进 半小时，然后继续。」', slot: '半小时' },
    { key: 'mind', label: 'Ta 在想什么', hint: '用一个动作或细节透出心里的想法，不直接写心理', text: '「用一个动作或细节写出 Ta 此刻心里在想什么，不要直接写心理。」' },
    { key: 'reroll', label: '重说', hint: '用同一段历史让 Ta 重说这一条（只出一个结果，说话人不变）', run: () => void reroll() },
    {
      key: 'polish',
      label: '润色',
      hint: 'AI 读取你已写的文本，结合角色卡/剧本/上下文扩写润色，结果覆盖输入框（不自动发送）',
      run: () => void assistWrite('polish'),
      disabled: !canAssist,
    },
    {
      key: 'auto',
      label: '自动回复',
      hint: 'AI 结合剧本/上下文/角色卡，替你扮演的角色写一句发言填进输入框（不自动发送）',
      run: () => void assistWrite('auto'),
      disabled: !canAssist,
    },
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

  // ---------- 自动滚到底 + 「回到底部」按钮状态 ----------
  const [atBottom, setAtBottom] = useState(true)
  const updateAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setAtBottom(dist < 48)
  }, [])
  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setAtBottom(true)
  }, [])
  // 已在底部时才自动跟随（反馈 #13）：用户往回滚看历史时不再被新内容硬拽回底部
  useEffect(() => {
    const el = scrollRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [session?.messages.length, streamText, atBottom])

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
  /**
   * 右栏「Ta这几天的生活 / 心情」跟着 statusCharId 走（角色级数据，换人换一份）。
   *
   * 补算也在这里做（审计 P1-6）：**谁被打开看，就补算谁**。
   * 旧实现只在载入会话时对第一位角色推一次，其余角色切过去只读不推进 —— 永远停在旧状态。
   * `advanceIfNeeded` 内部有 `shouldAdvanceDaily` 节流，重复进入不会反复调模型。
   */
  useEffect(() => {
    if (!statusCharId) { setDaily(null); return }
    let alive = true
    void (async () => {
      const cur = await store.getDaily(statusCharId).catch(() => null)
      if (!alive) return
      setDaily(cur)
      const card = castCards.find(c => c.id === statusCharId)
      if (card) void advanceIfNeeded(card, cur)
    })()
    return () => { alive = false }
  }, [statusCharId, session?.id, castCards, advanceIfNeeded])

  // ---------- 渲染 ----------
  if (loading) return <div className="page-enter"><LoadingState /></div>

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      {/* 顶部：只放「本场」的操作，导航（选/新建）都在左栏 */}
      <header className="shrink-0 flex flex-wrap items-center gap-2 border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">自由对话</h1>

        <HelpPopover title="自由对话怎么用" width="24rem" size={14}>
  这里的对话不绑小说项目：换一本书，角色卡与记忆照样在。

  • 顶部几件：Ta最近几天（每日小结）、结束本轮对话（整理记忆、写日记、结算本场数值、检查要不要改设定，
    然后这一场归档为只读）、导出。
  • 右侧常驻「本场状态」：好感 / 信任 / 精神 / 心情 / 地点 这些即时数值（可直接改，改完回车生效），以及在场由 AI 扮演的角色。
  • 多角色同场时点头像可指定下一位接话；「在场调度」里能静音某个人、调健谈度。
  • 记忆按角色存、跨会话共享 —— 换一场对话不会失忆。但它只在点「结束本轮对话」时才整理，
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
              title="把这场对话导出成 Markdown 或带样式的单文件 HTML。只含对话正文与场景信息，不含角色记忆与日记"
            >
              导出
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
                      // 这里的心情来自**日常推进**（Ta 这几天过得怎么样），与右栏「本场数值」里的 mood 是两回事
                      {daily?.mood && <span className="text-amber/80">这几天的心情：{daily.mood}</span>}
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
                    只列 **AI 演的**角色 —— 用户扮演的那个不是 AI 的位子，指定他接话没有意义。
                    归档只读时整块收掉：指定下一位 / 改静音与健谈度都是"为了接着聊"的准备动作。 */}
                {aiCards.length > 1 && !session.endedAt && (
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

              {/* 🚫 2026-09-16：原「对话上方那条角色状态一览」已挪进右栏 ——
                  它横在对话上方会白吃掉一截高度，而右栏本来就有地方摆（与「本场状态」两页切换）。
                  老大原话：「放到一起，能够进行页面切换」。见右栏 `<aside>` 的 statusTab。 */}

              <div className="relative flex-1 min-h-0">
              <div ref={scrollRef} onScroll={updateAtBottom} className="absolute inset-0 overflow-y-auto p-4 space-y-4">
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
                            // 归档只读：工具条整条不渲染（reroll / 编辑 / 隐藏 / 删除都不该有）
                            locked: !!session.endedAt,
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
              {!atBottom && (
                <button
                  type="button"
                  onClick={() => scrollToBottom()}
                  title="回到底部（看历史时一键回到最新消息）"
                  className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-full border border-ink-600 bg-ink-800/90 px-3 py-1.5 text-[11px] text-ink-100 shadow-lg backdrop-blur hover:bg-ink-700"
                >
                  <ChevronDown className="h-3.5 w-3.5" /> 回到底部
                </button>
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
                <TavernQuickBar actions={quickActions} disabled={streaming || assistBusy} onFill={fillInput} className="mb-2" />
                {/* 自动延展：默认 3 行，写长了自己长高，超过 200px 才内部滚动 */}
                {/* 按键：Enter 发送、Shift+Enter 换行（与「对话引导」一致）。
                    🔴 必须挡 isComposing —— 中文输入法里 Enter 是**选字确认键**，
                    不挡的话字打到一半就被当成发送，换成 Enter 发送后这是必踩的坑。 */}
                {/* 🔴 **不再 `disabled={streaming}`**（反馈 #13 的根因）：
                    旧写法在生成期间把整个 textarea 禁掉，浏览器会**主动把焦点移走**，
                    生成结束后也没人还回来 —— 表现就是「每轮都要再点一次输入框」。
                    现在生成期照常可打字（先把下一句备好），发送按钮那侧仍会变成「停止」。 */}
                <AutoTextarea
                  className="bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-ink-100 outline-none focus:border-amber/50"
                  textClass="text-[13px]"
                  minRows={3}
                  maxHeight={200}
                  placeholder={streaming || assistBusy
                    ? (streaming ? 'Ta 还在说 —— 你可以先把下一句打在这儿' : '正在为你生成 —— 结果会填到这儿')
                    : '说点什么…（Enter 发送，Shift+Enter 换行）'}
                  value={input}
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
                    {streaming || assistBusy
                      ? <Button variant="secondary" size="md" onClick={stop}>停止</Button>
                      : <Button variant="primary" size="md" disabled={!input.trim()} onClick={() => void send()}>发送</Button>}
                  </div>
                </div>
                </>
                )}
              </div>
            </div>

            {/* 右栏：角色状态 / 本场状态 两页切换（老大 2026-09-16 定 ——
                原先「对话上方那条一览」并到这里，不再单独占一条横向空间）。
                · 角色状态 = 场景 + 在场角色的关系状态与记忆计数（只读）
                · 本场状态 = 这一场的好感 / 信任 / 精神 / 心情 / 地点（改完回车生效）
                🚫 记忆不摆在这儿：它是给 AI 用的六栏档案，摆出来既不直观、又容易被改成半成品，
                   阅读与手改入口在「角色卡片」页。
                ⚠️ 整块**不再用 `castCards.length > 0` 门控** —— 卡被删或还没加载完时，
                   右栏会连「本场数值」一起消失（这正是反馈里「勾了启用却不显示」的一部分）。 */}
            <aside className="w-72 shrink-0 flex flex-col rounded-lg border border-ink-800 bg-ink-850/40 min-h-0">
              {/* 分段切换。红线：分段用 toggle + selected，不要静止无框的 ghost */}
              <div className="flex gap-1 border-b border-ink-800 p-2">
                <Button
                  variant="toggle" size="sm" className="flex-1 justify-center"
                  selected={statusTab === 'status'} onClick={() => setStatusTab('status')}
                  title="这一场的场景、在场角色的关系状态与记忆计数（只读）"
                >
                  角色状态
                </Button>
                <Button
                  variant="toggle" size="sm" className="flex-1 justify-center"
                  selected={statusTab === 'vars'} onClick={() => setStatusTab('vars')}
                  title="这一场的好感 / 信任 / 精神 / 心情 / 地点（改完回车生效）"
                >
                  本场状态
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {statusTab === 'status' ? (
                  <>
                    <TavernStatusBar
                      model={statusModel}
                      sceneText={
                        [session.scene?.place, session.scene?.time].filter(Boolean).join(' · ')
                        // 没手填场景时用剧本的名字与情境顶上（这一场本来就有处境，不该显示"未设定"）
                        || scriptSceneLine(session.script)
                      }
                    />

                    {/* 在场的人：只列 AI 扮演的（用户演的那位不是观察对象）。
                        点一个 = 把「Ta这几天的生活 / 心情」切到这位名下。
                        只在多角色时出现 —— 单角色只有一个人可看，列出来纯属占地方。 */}
                    {aiCards.length > 1 && (
                      <div className="border-t border-ink-800 pt-2">
                        <div className="text-[10.5px] text-ink-500 mb-1">
                          AI 扮演<span className="text-ink-600">（点名字看他这几天的生活）</span>
                        </div>
                        <ul className="space-y-1">
                          {aiCards.map(c => {
                            const on = c.id === statusCharId
                            return (
                              <li key={c.id}>
                                <button
                                  type="button"
                                  onClick={() => setStatusCharId(c.id)}
                                  title={`看 ${c.name || 'Ta'} 这几天的生活`}
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
                    )}
                  </>
                ) : (
                  /* 本场数值：**全项目唯一的显示与修改入口**（2026-09-16 去重 ——
                     原先中间那条状态栏里还有一份只读/可改的副本，已删）。
                     反馈 #4：多角色同场时，这里看的是「当前选中的那位」角色卡上的持久数值；
                     主角色（AI 扮演的第一个角色，见 primaryAiCharId）走会话工作副本并每轮回写卡，其余角色直接读写各自的卡。 */
                  <div className="space-y-2">
                    {aiCards.length > 1 && (
                      <div>
                        <div className="text-[10.5px] text-ink-500 mb-1">看哪位角色的数值</div>
                        <ul className="space-y-1">
                          {aiCards.map(c => {
                            const on = (varsCharId || primaryAiCharId(session)) === c.id
                            return (
                              <li key={c.id}>
                                <button
                                  type="button"
                                  onClick={() => setVarsCharId(c.id)}
                                  title={`看 ${c.name || 'Ta'} 的本卡数值`}
                                  className={`w-full flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors ${
                                    on ? 'border-amber/40 bg-amber/10' : 'border-transparent hover:bg-ink-800/60'
                                  }`}
                                >
                                  <Avatar src={c.avatar} name={c.name} size={18} />
                                  <span className={`truncate text-[11.5px] ${on ? 'text-amber' : 'text-ink-200'}`}>
                                    {c.name || '（未命名）'}
                                  </span>
                                  {c.id === primaryAiCharId(session) && <span className="ml-auto text-[10px] text-ink-500">主</span>}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )}
                    {(() => {
                      const activeId = varsCharId || primaryAiCharId(session) || ''
                      const primary = activeId === primaryAiCharId(session)
                      const card = castCards.find(c => c.id === activeId) ?? null
                      const vars = primary ? session?.vars : charVarsToTavern(card?.vars)
                      const notes = (primary ? charCard?.vars?.notes : card?.vars?.notes) ?? {}
                      const setV = (k: VarKey, raw: string) => (primary ? setVar(k, raw) : setOtherVar(activeId, k, raw))
                      const setN = (k: VarKey, text: string) => (primary ? setPrimaryNote(k, text) : setOtherNote(activeId, k, text))
                      const reset = primary ? () => void resetVars() : () => resetOtherVars(activeId)
                      return (
                        <TavernVarsPanel
                          vars={vars}
                          varKeys={varKeys}
                          onSetVar={setV}
                          onSetNote={setN}
                          noteOf={k => notes[k] ?? ''}
                          onResetVars={reset}
                          readOnly={!!session?.endedAt}
                        />
                      )
                    })()}
                  </div>
                )}
              </div>

              <div className="p-2 border-t border-ink-800">
                <p className="text-[10.5px] text-ink-600 leading-relaxed">
                  {statusTab === 'status'
                    ? '角色状态只读 —— 来自六栏记忆，整理入口是「结束本轮对话」；要直接改就去「角色卡片」页的记忆区。'
                    : '数值每轮回复后自动结算，也可随时手改；聊天过程中不跑整理，所以不会卡住对话。'}
                </p>
              </div>
            </aside>
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
