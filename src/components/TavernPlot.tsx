/**
 * 酒馆模式 · 剧情推演（tavern-plot）
 *
 * 定位：**诊断台**。你扮演书中一个角色，AI 扮演另一个，试演一场戏 ——
 * 看角色在具体情境下的反应是否合理。
 *
 * 布局（方案 §8.1）：顶部工具条 / 左栏本场信息（可折叠）/ 中栏对话区 / 底部上下文占用。
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），提示用 showToast。
 *
 * 【D4-3 拆分（2026-09-19）】原 1,011 行单文件按「一块职责一个文件」切开，手法是**只搬不改**：
 *   · `TavernPlotScenes.tsx`    — 左栏情景一览 + 本场信息栏（纯展示）；
 *   · `TavernPlotChat.tsx`      — 中栏对话区 + 输入区（纯展示）；
 *   · `usePlotSummary.ts`       — 本场记忆整理（🔴 只有手动入口，无自动整理）；
 *   · `usePlotCheckpoints.ts`   — 检查点 / 回滚 / 撤销；
 *   · 本文件保留会话生命周期、AI 回合（send / reroll）、消息级操作与装配。
 * 展示件的 props 名与原局部变量**同名**、hook 侧同名解构 ⇒ 被搬走的 JSX 与语句逐字未改。
 *
 * 🔴 留在本文件、别顺手挪走的三件事：
 *   · **贴底跟随**（`scrollRef`/`atBottom`）与切会话同拍，挪进子组件会改变 effect 时序；
 *   · **切会话中止在途生成**（`abortRef` 兼作代次令牌，send 据此判定自己是否已过期）；
 *   · **分支 `branchAt`**（要新建会话、改左栏选中，不只是检查点操作）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import * as db from '../lib/db'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import TavernPlotSetup, { type TavernDraft } from './TavernPlotSetup'
import TavernCastSetting from './TavernCastSetting'
import TavernCastDirector from './TavernCastDirector'
import PromptModal from './PromptModal'
import TavernEchoHints from './TavernEchoHints'
import TavernExportDialog from './TavernExportDialog'
import TavernUsageDialog from './TavernUsageDialog'
import * as store from '../lib/tavern/store'
import { runPlotTurn, splitCast } from '../lib/tavern/engine'
import { generateReport } from '../lib/tavern/report'
import { buildOpeningMessage } from '../lib/tavern/prompt'
import { plotDocModel } from '../lib/tavern/exportDoc'
import { messagesLen } from '../lib/tavern/budget'
import { uid } from '../lib/id'
import { hasCastSetting } from '../lib/tavern/types'
import type { TavernSession, TavernSessionIndexItem, TavernMessage, TavernDirectorNote } from '../lib/tavern/types'
import type { PostApplied } from '../lib/tavern/postRules'
import { usePlotSummary } from './usePlotSummary'
import { usePlotCheckpoints } from './usePlotCheckpoints'
import { PlotSessionList, PlotInfoPanel } from './TavernPlotScenes'
import { PlotChat } from './TavernPlotChat'

export default function TavernPlot() {
  const [list, setList] = useState<TavernSessionIndexItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [session, setSession] = useState<TavernSession | null>(null)
  // ---- 本场记忆整理（D4-3 拆出，同名解构接回；下游一个字没改）----
  // 🔴 只有手动入口，没有自动整理；失败/中止一律保留旧档案
  const { summarizing, runPlotSummary, stopSummary } = usePlotSummary({ setSession })
  const [setupOpen, setSetupOpen] = useState(false)
  const [showInfo, setShowInfo] = useState(true)
  const [input, setInput] = useState('')
  /** B3：上一轮后处理实际改了什么（空 = 一个字没改） */
  const [postNotice, setPostNotice] = useState<{ applied: PostApplied[]; errors: string[] }>({ applied: [], errors: [] })
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [phase, setPhase] = useState('')
  const [busyReport, setBusyReport] = useState(false)

  /** 「在场调度」弹窗（静音 / 健谈度，A6） */
  const [directorOpen, setDirectorOpen] = useState(false)
  /** 导出文档弹窗（B5） */
  const [exportOpen, setExportOpen] = useState(false)
  /** 用量明细弹窗（额度怎么分的） */
  const [usageOpen, setUsageOpen] = useState(false)
  // 扮演设定编辑：正在编辑的角色（null = 未打开）
  const [castEdit, setCastEdit] = useState<{ cardId: string; name: string; kind: 'ai' | 'user' } | null>(null)
  // 哪些角色已填过扮演设定（左栏显示「已设定 / 设定」）
  const [castFilled, setCastFilled] = useState<Record<string, boolean>>({})

  // 读一遍各角色的扮演设定是否填过（切会话/改角色分配时刷新）
  const castCardIds = useMemo(
    () => (session?.cast ?? []).filter(c => c.role !== 'silent').map(c => c.cardId),
    [session],
  )
  useEffect(() => {
    if (castCardIds.length === 0) { setCastFilled({}); return }
    let alive = true
    void Promise.all(castCardIds.map(async cardId =>
      [cardId, hasCastSetting(await store.getCastSetting(cardId))] as const,
    ))
      .then(rows => { if (alive) setCastFilled(Object.fromEntries(rows)) })
      .catch(() => { if (alive) setCastFilled({}) })
    return () => { alive = false }
  }, [castCardIds])

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const refreshList = useCallback(async () => {
    try {
      setList(await store.listSessions())
    } catch {
      showToast('读取推演列表失败', 'error')
    }
  }, [])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  // 切换会话：载入内容
  useEffect(() => {
    let alive = true
    // 🔴 审计 2026-09-18（P1-2）：切会话要**中止在途生成**并复位流式状态 ——
    //    否则旧请求返回后 setSession(res.session) 会把界面拽回旧会话，
    //    左栏高亮按 session?.id 判定 → 高亮与正文不一致。
    //    置空 abortRef 兼作「代次令牌」，供 send 判定自己是否已过期。
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setStreamText('')
    setPhase('')
    if (!activeId) { setSession(null); return }
    void store.getSession(activeId).then(s => { if (alive) setSession(s) })
    return () => { alive = false }
  }, [activeId])

  // 流式输出时贴底 + 「回到底部」按钮状态
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

  const casts = useMemo(() => (session ? splitCast(session.cast) : { user: [], ai: [], silent: [] }), [session])
  /** 取某条消息的发言角色名（多角色同场时挂头像与名字标签用） */
  const castNameOf = (id?: string) => (id ? casts.ai.find(c => c.cardId === id)?.name ?? '' : '')

  /** 在场调度（A6）：改的是**这一场**的安排，落库即生效 —— 下一轮组装就用新值 */
  const applyDirection = async (next: TavernSession) => {
    await store.saveSession(next)
    setSession(next)
  }

  /** 临时导演指令（B2）：会话级、落库即生效。传 null 即清除 */
  const applyDirectorNote = async (note: TavernDirectorNote | null) => {
    if (!session) return
    const next = store.setDirectorNote(session, note)
    setSession(next)
    await store.saveSession(next).then(refreshList).catch(() => undefined)
  }
  const directorRows = useMemo(
    () => casts.ai.map(c => ({ id: c.cardId, name: c.name, tag: 'AI 演', speakable: true })),
    [casts],
  )

  const createFromDraft = async (d: TavernDraft) => {
    try {
      const opening = buildOpeningMessage(d.scene, d.firstLine)
      const messages: TavernMessage[] = opening
        ? [{ id: uid(), role: 'user', content: opening, at: Date.now() }]
        : []
      const created = await store.createSession({
        title: d.title,
        mode: d.mode,
        anchorChapterId: d.anchorChapterId,
        anchorChapterLabel: d.anchorChapterLabel,
        cast: d.cast,
        scene: d.scene,
        messages,
        // 模型统一在「控制面板 → 通用设置 → 默认模型」里选；会话不留副本，
        // 留空即跟随那份设置（resolveTavernProvider 的兜底链：会话 → 面板默认 → 全局活动模型）
        model: { providerId: '' },
        params: {},
      })
      setSetupOpen(false)
      await refreshList()
      setActiveId(created.id)
      showToast('推演已创建，可以开演了')
    } catch {
      showToast('创建推演失败', 'error')
    }
  }

  /** preset = 快捷指令条递过来的一句现成话（走导演指令通道）；不传就用输入框里的 */
  const send = async (preset?: string) => {
    const text = (preset ?? input).trim()
    if (!session || !text || streaming) return
    if (!preset) setInput('')
    setStreaming(true)
    setStreamText('')
    setPhase('')
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const res = await runPlotTurn(session, text, {
        signal: ac.signal,
        onToken: d => setStreamText(t => t + d),
        onPhase: setPhase,
      })
      /**
       * 🔴 审计 2026-09-18（P1-2）：生成期间切了会话 / 按了停止 → 这一轮**照常落库**
       *    （它确实发生在那个会话上，数据不该丢），但**不回灌界面**：否则
       *    setSession(res.session) 会把界面拽回旧会话，左栏高亮与正文不一致。
       */
      // 落库（含索引同步）
      await store.saveSession(res.session)
      await refreshList()
      // 🔴 必须等**全部 await 之后**再判「有没有切走」：提前判的话，
      //    saveSession / refreshList 这两个 await 期间切走仍会 setSession 覆盖新会话。
      if (abortRef.current !== ac) return
      setSession(res.session)
      setStreamText('')
      setPostNotice({ applied: res.postApplied, errors: res.postErrors })
      if (res.fellBack) {
        showToast('「控制面板 → 通用设置 → 默认模型」还没选，这一轮用了全局活动模型', 'info')
      }
      // 🚫 2026-09-16 起**不再自动整理本场记忆**（老大拍板：全项目没有自动整理了）。
      //    理由：本地模型一次总结几十秒，压在一轮对话之后就是「说完一句卡半天」，聊越久越密。
      //    改由作者点「整理本场记忆」触发 —— 那条路径与这里同一套逻辑，只是 rel 由人决定。
    } catch (e) {
      if (abortRef.current !== ac) return   // 已切走：这不是「失败」，别弹错误提示
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setStreaming(false)
      setPhase('')
      setStreamText('')
      abortRef.current = null
    }
  }

  // ---------- 消息级操作（重说 / 编辑 / 隐藏 / 删除，2026-09-14 老大全接受的 A1） ----------
  /** 只有**末尾那条 AI 回复**能重说 —— 中间那条改了，后面是按旧版接的，必然打架 */
  const lastAiId = useMemo(() => store.lastAssistantId(session?.messages ?? []), [session])

  /** 消息改动统一走这里：立刻落库（含索引同步）+ 刷新左栏 */
  const commit = async (next: TavernSession) => {
    setSession(next)
    // 🔴 2026-09-22 六维审计 P2：原来是 `.catch(() => undefined)` —— 落库失败被彻底吞掉，
    //    编辑 / 隐藏 / 回滚 / 删消息看起来全都成功了，其实一个字节都没写进库（刷新后原样回来）。
    //    这条路径是推演本的唯一写入口，失败必须让作者知道。
    await store.saveSession(next).then(refreshList).catch(e => {
      showToast('保存失败：' + (e instanceof Error ? e.message : String(e)), 'error')
    })
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
      message: '删除后不再参与上下文，也不再显示。\n这一步不可撤销（整场推演仍可「结束推演」生成报告留档）。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    void commit(store.dropMessage(session, id))
  }

  // ---------- 分支 / 检查点 / 回滚（2026-09-14，路线图第 3 批） ----------
  /**
   * 从某一条分支：**另开一场**推演、只保留到这一条，原推演原封不动。
   * 记忆与水位线的重算规则见 `store.branchSession` —— 水位线落在分叉点之后时，
   * 会连本场记忆一起清空（否则分支会"记得还没发生的事"）。
   */
  const branchAt = async (messageId: string) => {
    if (!session || streaming) return
    const idx = session.messages.findIndex(m => m.id === messageId)
    if (idx < 0) { showToast('这一条已经不在记录里了', 'info'); return }
    const okGo = await confirmDialog({
      title: `从第 ${idx + 1} 条分叉？`,
      message: [
        `会另开一场新推演，只保留前 ${idx + 1} 条，从那里重新往下走。`,
        '原推演原封不动 —— 两场都在左栏，可以随时来回对比。',
        '',
        '记忆按分叉点重算：若原记忆里含「分叉之后才发生」的事，分支会把它清掉，',
        '否则 Ta 会记得还没发生的事。',
      ].join('\n'),
      confirmText: '创建分支',
    })
    if (!okGo) return
    const next = store.branchSession(session, messageId, list.map(x => x.title))
    if (!next) { showToast('这一条已经不在记录里了', 'info'); return }
    await store.saveSession(next)
    await refreshList()
    setActiveId(next.id)
    setSession(next)
    showToast(`已分支：${next.title}`)
  }

  // ---- 检查点 / 回滚（D4-3 拆出，同名解构接回）----
  const { cpNaming, setCpNaming, saveCheckpoint, commitCheckpoint, rollbackTo, undoRollback, dropCp } =
    usePlotCheckpoints({ session, streaming, commit })

  /**
   * 重说：`runPlotTurn(session, null)` = 不追加用户消息、先丢掉末尾那条 assistant，
   * 于是新生成的结果**天然替换**掉那一条。只出一个结果，不做多候选（老大 2026-09-14 定）。
   */
  const reroll = async () => {
    if (!session || streaming) return
    if (!lastAiId) { showToast('还没有可以重说的回复', 'info'); return }
    setStreaming(true)
    setStreamText('')
    setPhase('')
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const res = await runPlotTurn(session, null, {
        signal: ac.signal,
        onToken: d => setStreamText(t => t + d),
        onPhase: setPhase,
      })
      setSession(res.session)
      setStreamText('')
      await store.saveSession(res.session)
      await refreshList()
      if (!res.reply) showToast('这次没生成出内容，原来那条已保留', 'info')
    } catch (e) {
      showToast(`重说失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setStreaming(false)
      setPhase('')
      setStreamText('')
      abortRef.current = null
    }
  }

  const stop = () => {
    abortRef.current?.abort()
    setStreaming(false)
  }

  const finish = async () => {
    if (!session) return
    const okGo = await confirmDialog({
      title: '结束这场推演？',
      message: '结束后会生成一份合理性报告（矛盾 / 漏洞 / 存疑），存进「推演报告」页。\n推演记录会保留，可以继续演。',
      confirmText: '结束并生成报告',
    })
    if (!okGo) return
    setBusyReport(true)
    try {
      const report = await generateReport(session)
      await db.saveReport(report)
      await store.saveSession(session)
      await refreshList()
      showToast(`报告已生成：${report.findings.length} 条问题`)
    } catch (e) {
      showToast(`生成报告失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setBusyReport(false)
    }
  }

  const removeSession = async () => {
    if (!session) return
    const okDel = await confirmDialog({ title: '删除这场推演？', message: `「${session.title}」及其全部对话记录将被删除，且不可恢复。`, confirmText: '删除' })
    if (!okDel) return
    await store.deleteSession(session.id)
    setActiveId('')
    setSession(null)
    await refreshList()
    showToast('已删除')
  }

  /**
   * 对话消息字数。**不含 system** —— 原先这里写 `JSON.stringify(messages).length`（把 JSON 结构也算进去，
   * 明显虚高），又拿它去比一个不含 system 的「预算」，两个数都不对，作者据此判断不了还剩多少余量。
   * 真实占用（含协议 / 设定层 / 背景设定 / 记忆）在「用量明细」里按真实组装量。
   */
  const dialogChars = session ? messagesLen(session.messages) : 0

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      {/* ---------- 顶部工具条：只放「本场」的操作，导航（选/新建）都在左栏 ---------- */}
      <header className="shrink-0 flex flex-wrap items-center gap-2 border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">剧情推演</h1>

        <HelpPopover title="剧情推演怎么用" width="24rem" size={14}>
  左栏是全部场次（点一下就切），右边是这一场的对话。

  · 「＋ 新建推演」时选叙事锚点（从哪一章开始）与在场角色 —— 谁演谁由你定，你也能自己演一个。
  · 顶部几件：存检查点（记住此刻进度，之后能一键回到这里，回滚还可撤销）、本场信息、导出、结束推演。
  · 消息上悬停有「重说 / 编辑 / 隐藏 / 分支 / 删除」：隐藏 = 这条先不让 AI 看见（界面仍留着）；
    分支 = 从这条另开一场试另一个走向，原场不动。
  · 模型在「控制面板 → 通用设置 → 默认模型」里统一选，本页不再单独指定。
  · 它是「试戏」不是「写稿」：结束推演出的报告只诊断，不会写回你的小说。
  <AIDataSourceNote feature="tavern-plot" />
</HelpPopover>
        {session && (
          <span className="max-w-[28rem] truncate text-12 text-ink-400" title={session.title}>{session.title}</span>
        )}
        <div className="flex-1" />

        {session && (
          <>
            <Button
              variant="secondary" size="md" disabled={streaming} onClick={() => saveCheckpoint()}
              title="记住此刻的消息进度与本场记忆；之后无论聊成什么样都能一键回到这里（回滚还可撤销）"
            >
              存检查点
            </Button>
            <Button variant="secondary" size="md" onClick={() => setShowInfo(v => !v)}>
              {showInfo ? '收起本场信息' : '本场信息'}
            </Button>
            <Button
              variant="secondary" size="md" disabled={streaming || session.messages.length === 0}
              onClick={() => setExportOpen(true)}
              title="把这场推演导出成 Markdown 或带样式的单文件 HTML"
            >
              导出
            </Button>
            <Button variant="danger" size="md" disabled={busyReport || streaming} onClick={finish}>
              {busyReport ? '生成报告中…' : '结束推演'}
            </Button>
          </>
        )}
      </header>

      {/* 元指令速查：**必须留在 header 外面** —— 放进输入区的话，没有会话 / 没选中推演时
          那整块不渲染，新用户就永远看不到「可以用「」指挥 AI」这条。这里常驻可见。 */}
      <TavernEchoHints className="mt-3 shrink-0" />

      {/* ---------- 主体：左＝推演情景一览；右＝本场信息 + 对话区 ---------- */}
      <div className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* 左栏：推演情景（全部场次一览，点一下就切 —— 不再用下拉菜单挑） */}
        <PlotSessionList
          list={list}
          activeId={activeId}
          setActiveId={setActiveId}
          setSetupOpen={setSetupOpen}
        />

        {!session ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-ink-800">
            <div className="text-center">
              <p className="text-13 text-ink-300">还没有选择推演</p>
              <p className="mt-2 text-12 text-ink-500 leading-relaxed">
                {list.length === 0
                  ? '先「新建推演」：选一个叙事锚点、分配角色（你演谁 / AI 演谁），就能开演。'
                  : '从左栏点一场继续，或新建一场。'}
              </p>
            </div>
          </div>
        ) : (
          <>
          {/* 本场信息（可收起） */}
          {showInfo && (
            <PlotInfoPanel
              session={session}
              casts={casts}
              castFilled={castFilled}
              setCastEdit={setCastEdit}
              setDirectorOpen={setDirectorOpen}
              summarizing={summarizing}
              runPlotSummary={runPlotSummary}
              stopSummary={stopSummary}
              saveCheckpoint={saveCheckpoint}
              rollbackTo={rollbackTo}
              dropCp={dropCp}
              undoRollback={undoRollback}
              removeSession={removeSession}
            />
          )}

          {/* 中栏：对话区 */}
          <PlotChat
            session={session}
            casts={casts}
            castNameOf={castNameOf}
            lastAiId={lastAiId}
            streaming={streaming}
            streamText={streamText}
            phase={phase}
            postNotice={postNotice}
            input={input}
            setInput={setInput}
            dialogChars={dialogChars}
            scrollRef={scrollRef}
            atBottom={atBottom}
            updateAtBottom={updateAtBottom}
            scrollToBottom={scrollToBottom}
            reroll={reroll}
            saveEdited={saveEdited}
            toggleHidden={toggleHidden}
            removeMsg={removeMsg}
            branchAt={branchAt}
            applyDirectorNote={applyDirectorNote}
            send={send}
            stop={stop}
            setUsageOpen={setUsageOpen}
          />
          </>
        )}
      </div>

      {session && (
        <TavernUsageDialog
          open={usageOpen}
          onClose={() => setUsageOpen(false)}
          mode="plot"
          session={session}
        />
      )}

      {session && (
        <TavernExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          docTitle={session.title}
          kindLabel="推演记录"
          messageCount={session.messages.filter(m => m.role !== 'system').length}
          hiddenCount={session.messages.filter(m => m.hidden).length}
          build={o => plotDocModel(session, o)}
        />
      )}

      <TavernPlotSetup open={setupOpen} onCreate={createFromDraft} onCancel={() => setSetupOpen(false)} />

      <TavernCastDirector
        open={directorOpen}
        rows={directorRows}
        muted={session?.muted ?? []}
        talkativity={session?.talkativity ?? {}}
        onToggleMute={(id, next) => { if (session) void applyDirection(store.setMuted(session, id, next)) }}
        onSetTalkativity={(id, v) => { if (session) void applyDirection(store.setTalkativity(session, id, v)) }}
        onClose={() => setDirectorOpen(false)}
        note="只影响这一场：不改角色卡、不删记忆 —— 静音的人依然在场，只是这轮不发言。「下一位」点名在自由对话里。"
      />

      {/* 检查点命名：留空就用「第 N 条」（allowEmpty 让它能直接回车） */}
      <PromptModal
        open={cpNaming}
        title="给这个检查点起个名字"
        label="名字（可以留空）"
        placeholder="例：分手前 / 进医院之前"
        allowEmpty
        onSubmit={commitCheckpoint}
        onCancel={() => setCpNaming(false)}
      />

      {castEdit && (
        <TavernCastSetting
          open
          cardId={castEdit.cardId}
          name={castEdit.name}
          kind={castEdit.kind}
          onClose={() => setCastEdit(null)}
          onSaved={() => {
            // 保存后立刻刷新「已设定」标记（不必等切会话）
            void store.getCastSetting(castEdit.cardId)
              .then(v => setCastFilled(prev => ({ ...prev, [castEdit.cardId]: hasCastSetting(v) })))
              .catch(() => { /* 读取失败不影响保存本身，标记留旧值即可 */ })
          }}
        />
      )}
    </div>
  )
}
