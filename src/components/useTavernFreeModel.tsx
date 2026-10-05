/**
 * 自由对话（酒馆模式）的**状态与生命周期**（从 `TavernFree.tsx` 拆出来的，2026-09-19）。
 *
 * 【为什么这么拆】原文件 1935 行（全项目最大）：逻辑 1119 行 + 视图 700 行，
 *   JSX 直接用到 95 个组件作用域名字（全组件声明 143 个）。自由对话又是全项目交互最密的一页
 *   （流式输出、逐条改删、收尾多阶段、数值/记忆/日记），所以拆法仍是**只搬不改**：
 *   状态 / effect / 动作整体收进来，视图侧同名解构接回去 —— JSX 一个字不动。
 *
 * 🔴 搬动时逐条保住的红线：
 *   · **收尾不可取消 → 现在可取消**（本轮审计 P1-2）：`endRound` 全程下传 signal，
 *     中止 ≠ 失败（措辞按 /取消|abort/ 区分），中止时一条都不落库、水位线不推进；
 *   · 数值/设定审查失败不再被静默吞掉（`RoundEndResult.warnings[]` 由界面如实显示）；
 *   · 会话存**快照非引用**：`snapshotStorySetting` 落库后再读，别改成读活设定；
 *   · 水位线只认 `nextWatermark` 的口径（同一消息集两处过滤条件必须一致）。
 */
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

import { useFreeTurn } from './useFreeTurn'
import { useFreeRoundEnd } from './useFreeRoundEnd'
import { useFreeRevise } from './useFreeRevise'
import { primaryAiCharId } from '../lib/tavern/primaryChar'
import { useTavernReady } from './useTavernReady'

import { showToast, confirmDialog } from './dialogs'
import { type FreeDraft } from './TavernFreeSetup'
import * as store from '../lib/tavern/store'
import { varsEnabledKeys } from '../lib/tavern/engine'
import type { PostApplied } from '../lib/tavern/postRules'
import { advanceDaily, shouldAdvanceDaily } from '../lib/tavern/daily'
import { uid } from '../lib/id'
import { acquireSummaryLock, releaseSummaryLock } from '../lib/tavern/memory'
import {
  type FreeCharacter, type FreeMemory, type FreeSession, type TavernMessage, type TavernDirectorNote,
  type FreeSessionIndexItem, type TavernCharIndexItem, type DailyState,
  type VarKey, type TavernStoryIndexItem, sessionStoryId, 
} from '../lib/tavern/types'
import { varsOf, setVarManually, resetVarValues, recordVarChanges, turnSeqOf, migrateVarScale, VAR_SCALE, setCharNote, emptyVars } from '../lib/tavern/vars'
import { snapshotOf, openingToMessage } from '../lib/tavern/script'
import { getScript } from '../lib/tavern/script'
import { getTavernSettings, memoryLimitsOf, activeProfileOf, DEFAULT_TAVERN_SETTINGS, DEFAULT_TAVERN_PROFILE, type TavernSettings } from '../lib/tavern/settings'
import { listStories, storyDisplayName, getStory, snapshotStorySetting } from '../lib/tavern/story'
import { type SpeakerInfo } from '../lib/tavern/exportDoc'
import { buildStatusModel, agoText } from '../lib/tavern/status'


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

export function useTavernFreeModel() {
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
  const [statusTab, setStatusTab] = useState<'status' | 'vars' | 'cp'>('vars')
  /** 「存检查点」的命名弹窗（null = 关着）—— F1 自由模式分支 */
  const [cpNaming, setCpNaming] = useState(false)
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
  /** 控制面板设置（记忆与日常阈值都从这儿来）—— 读不到时用出厂默认，不含糊 */
  const [tavernSettings, setTavernSettings] = useState<TavernSettings | null>(null)
  // ---------- AI 就绪（2026-09-22 六维审计 F1）----------
  // 酒馆自由对话原先整条链路都没有就绪守卫，未配模型时点发送会一路走到 provider 抛错。
  // 🔴 判据必须走酒馆自己的 provider 链（会话 model → 面板 defaultProviderId → 全局活动模型）：
  //    直接套全局那个会禁掉「全局留空 + 面板指定模型」这一有效配置（tests/uiUxGuards 钉着）。
  //    依赖两项 id 而非整个对象：id 变了才需要重算，免得每次渲染都触发一次异步解析。
  //    ⚠️ 必须放在 `session` / `tavernSettings` 声明**之后**（JS 的 let/const 有 TDZ）。
  const tavernReady = useTavernReady(session?.model?.providerId, tavernSettings?.common.defaultProviderId)
  /** 会话名内联编辑：列表里只显示标题，改不了就只能删了重开，所以给个直接改的入口 */
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  /** 当前会话 id 的 ref：判断「是不是真的换了会话」用 —— 点左栏里当前这一场不该把在途生成杀掉 */
  const sessionIdRef = useRef<string | null>(null)
  useEffect(() => { sessionIdRef.current = session?.id ?? null }, [session])
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
  // 生成链路（流式状态机 + 发送 / 重说 / 润色 / 自动回复）—— 见 useFreeTurn.ts
  const turn = useFreeTurn({
    session, setSession, input, setInput, charCard, castCards, speakNext, setSpeakNext,
    setCharCard, setCastCards, setPostNotice, setGreeting,
    varKeys, tavernSettings, summaryProviderId, nameOf, refreshSessions,
  })
  const {
    streaming, streamText, setStreamText, phase, assistBusy,
    send, stop, reroll, quickActions, fillInput, inputRef, lastAiId, selectVariant,
    cancelInFlight, persistCharVars,
  } = turn

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
      // 审计 P2：读失败≠角色不存在 —— 必须把上一会话的 charCard/mems 一并清掉，
      // 否则 send() 的兜底 castCards.length ? castCards : [charCard] 会拿错卡当上下文
      setCastCards([]); setCharCard(null); setMems({})
    }
    // 不再依赖 advanceIfNeeded —— 日常推进已移到右栏那个 effect（审计 P1-6）
  }, [])
  // 设定更新（AI 读对话 → 列出「设定该改了」→ 作者逐条裁决）—— 见 useFreeRevise.ts
  const revise = useFreeRevise({ session, loadSessionContext, summaryProviderId })
  const {
    reviseOpen, setReviseOpen, revising, applyingRev, reviseError,
    proposals, setProposals, picked, setPicked, setReviseError,
    openRevise, applyPicked,
  } = revise

  const openSession = useCallback(async (id: string) => {
    /**
     * 🔴 审计 2026-09-18（P1-2）：切走会话要中止在途生成 + 复位流式（见 cancelInFlight）。
     *    只在**真的换了会话**时做 —— 点左栏里当前这一场不该把正在生成的一轮杀掉
     *    （那会把用户这句话连同回复一起丢掉：原实现只是清流式文字，那一轮仍会落库）。
     */
    if (sessionIdRef.current !== id) cancelInFlight()
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
  }, [loadSessionContext, cancelInFlight, setStreamText])

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
      // 🔴 审计 2026-09-18（P1-2）：新建会话也是「切走」—— 不中止的话，
      //    在途的旧回复返回后会 setSession(res.session) 把这个新会话顶掉。
      cancelInFlight()
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
  }, [nameOf, refreshSessions, refreshStories, loadSessionContext, cancelInFlight])
  // 收尾（记忆 + 日记 + 数值 + 设定审查，跑完归档为只读）—— 见 useFreeRoundEnd.ts
  const roundEnd = useFreeRoundEnd({
    session, setSession, setMems, castCards, summaryProviderId, lim, varKeys, tavernSettings, nameOf, refreshSessions,
    setReviseOpen, setProposals, setPicked, setReviseError,
  })
  const { ending, endStage, endResult, setEndResult, endRound, stopEndRound } = roundEnd



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



  // ---------- 消息级操作（与剧情推演同一套；自由模式多一条：重说时**保持原来的说话人**） ----------

  const commit = async (next: FreeSession) => {
    setSession(next)
    await store.saveFreeSession(next).then(refreshSessions).catch(() => undefined)
  }

  // ---------- 检查点 / 回滚（F1 自由模式分支，2026-10-05） ----------
  //
  // 🔴 与剧情模式的结构差异：剧情模式的记忆（`session.memory`）就在会话对象里，
  //    `store.rollbackToCheckpoint` 是个纯改对象的动作；自由模式的记忆**按角色分条存在独立存储**
  //    （`store.getMemory(charId)`）⇒ 存点要读齐 N 份、回滚要把 N 份**写回存储**。
  //    纯函数在 `store.*FreeCheckpoint/rollbackFreeToCheckpoint`，这里只做编排与落盘。

  /** 读齐这一场所有在场角色的记忆（含用户扮演那位 —— Ta 也有自己的记忆条目） */
  const readAllMemories = async (s: FreeSession) => {
    const list = await Promise.all(s.charIds.map(id => store.getMemory(id).catch(() => null)))
    return list.filter((m): m is NonNullable<typeof m> => !!m)
  }

  /** 把一组记忆写回存储 —— 🔴 回滚链路上**必须先于会话落库**，理由见 rollbackToCp 的注释 */
  const writeMemories = async (list: Awaited<ReturnType<typeof readAllMemories>>) => {
    await Promise.all(list.map(m => store.saveMemory(m).catch(() => undefined)))
  }

  const saveCheckpoint = () => {
    if (session) setCpNaming(true)
  }

  const commitCheckpoint = (label: string) => {
    setCpNaming(false)
    if (!session) return
    const s = session
    void (async () => {
      const memories = await readAllMemories(s)
      await commit(store.addFreeCheckpoint(s, memories, label))
      showToast(`已存检查点（第 ${s.messages.length} 条，含 ${memories.length} 位角色的记忆）`, 'info')
    })()
  }

  const rollbackToCp = async (cpId: string) => {
    if (!session || streaming) return
    const s = session
    const cp = (s.checkpoints ?? []).find(c => c.id === cpId)
    if (!cp) return
    const name = cp.label || `第 ${cp.messageCount} 条`
    const okGo = await confirmDialog({
      title: `回到「${name}」？`,
      message: [
        `消息会截回 ${cp.messageCount} 条；${cp.memories.length} 位角色的记忆与本场数值也一并还原到那一刻。`,
        // 🔴 必须明说：自由模式的记忆是**角色级、跨会话共享**的 —— 回滚会连带改动其他对话里同一角色记得的事
        '注意：角色记忆是跨会话共享的，这次回滚也会影响这位角色在别的对话里的记忆。',
        '回滚前会自动留一份当前进度 —— 不满意可以点「撤销上次回滚」退回来。',
      ].join('\n'),
      confirmText: '回到这里',
    })
    if (!okGo) return
    const cur = await readAllMemories(s)
    const r = store.rollbackFreeToCheckpoint(s, cpId, cur)
    if (!r) return
    // 🔴 顺序有讲究：**先写记忆、再落会话**。反过来的话，中途失败会留下
    //    「会话已退回去、记忆没退」——Ta 会记得那些已经不存在的事（比反过来更难发现）。
    await writeMemories(r.restore)
    await commit(r.session)
    showToast(`已回到「${name}」（可撤销）`)
  }

  const undoRollbackCp = async () => {
    if (!session?.undoSnapshot) return
    const r = store.undoFreeRollback(session)
    if (!r) return
    await writeMemories(r.restore)
    await commit(r.session)
    showToast('已撤销这次回滚')
  }

  const dropCp = (cpId: string) => {
    if (!session) return
    void commit(store.dropFreeCheckpoint(session, cpId))
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


  /** 临时导演指令（B2）：与剧情推演同一套；落库即生效，传 null 即清除 */
  const applyDirectorNote = async (note: TavernDirectorNote | null) => {
    if (!session) return
    const next = store.setDirectorNote(session, note)
    setSession(next)
    await store.saveFreeSession(next).catch(() => undefined)
  }



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
          active ? 'border-amber/40 bg-amber/15' : 'border-transparent hover:bg-ink-800/60'
        }`}
      >
        <div className={`truncate text-12 ${active ? 'text-amber' : 'text-ink-100'}`}>{s.title}</div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="truncate text-10 text-ink-500">{names}</span>
          <span className="shrink-0 text-10 text-ink-600">{agoText(s.lastActiveAt)}</span>
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

  /** 我的档案（全局）：目前只用来给「你」这一侧挂头像。🔴 走 activeProfileOf（多套档案时取选中的那份） */
  const myProfile = tavernSettings ? activeProfileOf(tavernSettings) : DEFAULT_TAVERN_PROFILE
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

  return {
    // 会话 / 故事 / 角色数据
    sessions, session, stories, closedStoryIds, chars, charCard, aiCards, myProfile, castCards, tree, toggleStory, renderSessionRow, refreshStories, nameOf, exportSpeakerOf,
    // 左栏检索与新建
    q, setQ, input, setSetupOpen, setupOpen,
    // 消息与输入
    inputRef, setInput, fillInput, send, stop, streaming, phase, streamText, assistBusy, quickActions, applyDirectorNote, directorRows,
    // 消息操作（编辑 / 重生成 / 隐藏 / 删除）
    saveEdited, toggleHidden, removeMsg, reroll, lastAiId, selectVariant, saveTitle, editingTitle, setEditingTitle, titleDraft, setTitleDraft, removeSession, updateAtBottom,
    // 检查点 / 回滚（F1）
    cpNaming, setCpNaming, saveCheckpoint, commitCheckpoint, rollbackToCp, undoRollbackCp, dropCp,
    // 滚动
    scrollRef, scrollToBottom, atBottom, usedChars,
    // 数值与状态
    varKeys, varsCharId, setVarsCharId, statusCharId, setStatusCharId, statusModel, statusTab, setStatusTab, setVar, setPrimaryNote, setOtherVar, setOtherNote, resetOtherVars, resetVars,
    // 收尾 / 待发留言 / 日常
    ending, endStage, endResult, setEndResult, endRound, stopEndRound, daily, showDaily, setShowDaily, greeting, setGreeting, postNotice, applyDirection,
    // AI 设定更新（建议 / 采纳）
    reviseOpen, setReviseOpen, openRevise, revising, applyingRev, reviseError, proposals, picked, setPicked, applyPicked,
    // 多角色接话
    speakNext, setSpeakNext,
    // 🔴 AI 就绪（2026-09-22 六维审计 F1）：未配模型时发送键要禁用并说明原因。
    //    判据走**酒馆自己的 provider 链**（会话 → 面板默认 → 全局），绝不能用全局那个（见 useTavernReady 文件头）。
    //    否则「全局留空、只在面板指定模型」这一有效配置会被误禁（见 useTavernReady 的文件头）。
    aiReady: tavernReady.ready, aiReadyLabel: tavernReady.label,
    // 弹窗与抽屉
    usageOpen, setUsageOpen, directorOpen, setDirectorOpen, exportOpen, setExportOpen,
    // 其他
    loading, createFromDraft,
  }
}

export { primaryAiCharId }

export type TavernFreeModel = ReturnType<typeof useTavernFreeModel>