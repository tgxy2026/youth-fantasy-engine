/**
 * 酒馆模式 · 剧情推演（tavern-plot）
 *
 * 定位：**诊断台**。你扮演书中一个角色，AI 扮演另一个，试演一场戏 ——
 * 看角色在具体情境下的反应是否合理。
 *
 * 布局（方案 §8.1）：顶部工具条 / 左栏本场信息（可折叠）/ 中栏对话区 / 底部上下文占用。
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），提示用 showToast。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import HelpPopover from './HelpPopover'
import * as db from '../lib/db'
import { loadProviders, type AIProvider } from '../lib/ai'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import TavernPlotSetup, { type TavernDraft } from './TavernPlotSetup'
import TavernCastSetting from './TavernCastSetting'
import TavernCastDirector from './TavernCastDirector'
import TavernMessageBody from './TavernMessageBody'
import PromptModal from './PromptModal'
import TavernQuickBar, { type QuickAction } from './TavernQuickBar'
import TavernDirectorNoteBar from './TavernDirectorNoteBar'
import TavernExportDialog from './TavernExportDialog'
import TavernUsageDialog from './TavernUsageDialog'
import { renderTavernMessage } from './TavernMessage'
import AutoTextarea from './AutoTextarea'
import * as store from '../lib/tavern/store'
import { runPlotTurn, splitCast } from '../lib/tavern/engine'
import { generateReport } from '../lib/tavern/report'
import { buildOpeningMessage } from '../lib/tavern/prompt'
import { plotDocModel } from '../lib/tavern/exportDoc'
import { messagesLen } from '../lib/tavern/budget'
import { uid } from '../lib/id'
import { MEMORY_SOFT_LIMIT, hasCastSetting, talkBandOf, talkativityOf } from '../lib/tavern/types'
import type { TavernSession, TavernSessionIndexItem, TavernMessage, TavernDirectorNote } from '../lib/tavern/types'
import type { PostApplied } from '../lib/tavern/postRules'


export default function TavernPlot() {
  const [list, setList] = useState<TavernSessionIndexItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [session, setSession] = useState<TavernSession | null>(null)
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [setupOpen, setSetupOpen] = useState(false)
  const [showInfo, setShowInfo] = useState(true)
  /** 左栏情景列表的筛选词（场次多了靠它找，不必滚动） */
  const [pickQuery, setPickQuery] = useState('')

  const [input, setInput] = useState('')
  /** B3：上一轮后处理实际改了什么（空 = 一个字没改） */
  const [postNotice, setPostNotice] = useState<{ applied: PostApplied[]; errors: string[] }>({ applied: [], errors: [] })
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [phase, setPhase] = useState('')
  const [busyReport, setBusyReport] = useState(false)
  /** 「存检查点」的命名弹窗（null = 关着） */
  const [cpNaming, setCpNaming] = useState(false)
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
    void loadProviders().then(setProviders).catch(() => setProviders([]))
  }, [refreshList])

  // 切换会话：载入内容
  useEffect(() => {
    let alive = true
    if (!activeId) { setSession(null); return }
    void store.getSession(activeId).then(s => { if (alive) setSession(s) })
    return () => { alive = false }
  }, [activeId])

  // 流式输出时贴底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session?.messages.length, streamText])

  const casts = useMemo(() => (session ? splitCast(session.cast) : { user: [], ai: [], silent: [] }), [session])

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
        model: { providerId: providers[0]?.id ?? '' },
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

  const switchProvider = async (providerId: string) => {
    if (!session) return
    const next = { ...session, model: { providerId } }
    setSession(next)
    await store.saveSession(next).then(refreshList).catch(() => undefined)
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
      setSession(res.session)
      setStreamText('')
      setPostNotice({ applied: res.postApplied, errors: res.postErrors })
      if (res.fellBack) {
        showToast('酒馆模式未单独指定模型，已回退到全局活动模型', 'error')
      }
      // 落库（含索引同步）
      await store.saveSession(res.session)
      await refreshList()
    } catch (e) {
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
    await store.saveSession(next).then(refreshList).catch(() => undefined)
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

  const saveCheckpoint = () => {
    if (!session) return
    setCpNaming(true)
  }

  const commitCheckpoint = (label: string) => {
    setCpNaming(false)
    if (!session) return
    void commit(store.addCheckpoint(session, label))
    showToast(`已存检查点（第 ${session.messages.length} 条），之后随时可以回到这里`, 'info')
  }

  const rollbackTo = async (cpId: string) => {
    if (!session || streaming) return
    const cp = (session.checkpoints ?? []).find(c => c.id === cpId)
    if (!cp) return
    const name = cp.label || `第 ${cp.messageCount} 条`
    const okGo = await confirmDialog({
      title: `回到「${name}」？`,
      message: [
        `消息会截回 ${cp.messageCount} 条，本场记忆与记忆水位线也一并还原到那一刻。`,
        '回滚前会自动留一份当前进度 —— 不满意可以点「撤销上次回滚」退回来。',
      ].join('\n'),
      confirmText: '回到这里',
    })
    if (!okGo) return
    const next = store.rollbackToCheckpoint(session, cpId)
    if (!next) return
    void commit(next)
    showToast(`已回到「${name}」（可撤销）`)
  }

  const undoRollback = () => {
    if (!session?.undoSnapshot) return
    void commit(store.undoRollback(session))
    showToast('已撤销这次回滚')
  }

  const dropCp = (cpId: string) => {
    if (!session) return
    void commit(store.dropCheckpoint(session, cpId))
  }

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

  /**
   * 快捷指令条：走协议 R4 的**导演指令**通道（「」= 照做然后继续演），所以不必改引擎。
   * 好处是它不污染「角色说过的话」这层语义 —— 不会被当成台词记进记忆。
   */
  const quickActions: QuickAction[] = [
    { key: 'cont', label: '继续', hint: '让 AI 顺着往下演一轮', run: () => void send('「继续，不必解释。」') },
    { key: 'turn', label: '换个方向', hint: '这一轮换一种走向，不要重复刚才的写法', run: () => void send('「换一个方向演这一轮，不要重复刚才的走向。」') },
    { key: 'env', label: '补环境', hint: '先补一句【】里的环境（光、声、气味），再接着说', run: () => void send('「先说一句【】里的环境（光、声、气味），再继续。」') },
    { key: 'time', label: '推进时间', hint: '把时间往前推一点（半小时 / 第二天）', run: () => void send('「把时间往前推一点（半小时或第二天），再继续。」') },
    { key: 'wind', label: '收束本场', hint: '给这一幕一个可以停下的落点', run: () => void send('「把这一幕收一收，落到一个可以停下的地方。」') },
    { key: 'mind', label: 'Ta 在想什么', hint: '用一个动作或细节透出心里的想法，不直接写心理', run: () => void send('「用一个动作或细节写出 Ta 此刻心里在想什么，不要直接写心理。」') },
    { key: 'reroll', label: '重说', hint: '用同一段历史让 AI 重说这一条（只出一个结果）', run: () => void reroll() },
  ]

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

  /** 左栏情景列表：按筛选词过滤（标题 / 参演角色 / 锚点章名都算命中） */
  const sessionRows = useMemo(() => {
    const q = pickQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter(s =>
      `${s.title} ${s.castBrief} ${s.anchorTitle}`.toLowerCase().includes(q))
  }, [list, pickQuery])

  /** 列表里的日期小字（只到「几月几日」，同年不写年） */
  const fmtDay = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      {/* ---------- 顶部工具条：只放「本场」的操作，导航（选/新建）都在左栏 ---------- */}
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">剧情推演</h1>

        <HelpPopover title="剧情推演怎么用" width="24rem" size={14}>
  左栏是全部场次（点一下就切），右边是这一场的对话。

  • 「＋ 新建推演」时选叙事锚点（从哪一章开始）与在场角色 —— 谁演谁由你定，你也能自己演一个。
  • 顶部几件：存检查点（记住此刻进度，之后能一键回到这里，回滚还可撤销）、本场信息、导出、结束推演。
  • 消息上悬停有「重说 / 编辑 / 隐藏 / 分支 / 删除」：隐藏 = 这条先不让 AI 看见（界面仍留着）；
    分支 = 从这条另开一场试另一个走向，原场不动。
  • 模型可以单独指定（不跟随全局活动模型），换模型不影响已有记录。
  • 它是「试戏」不是「写稿」：结束推演出的报告只诊断，不会写回你的小说。
</HelpPopover>
        {session && (
          <span className="max-w-[28rem] truncate text-[12px] text-ink-400" title={session.title}>{session.title}</span>
        )}
        <div className="flex-1" />

        {session && (
          <>
            <select
              className="bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-[12px] text-ink-100 outline-none focus:border-amber/50"
              value={session.model.providerId}
              onChange={e => void switchProvider(e.target.value)}
              title="酒馆模式单独指定模型（不跟随全局活动模型）"
            >
              <option value="">（用全局活动模型）</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
            </select>
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

      {/* ---------- 主体：左＝推演情景一览；右＝本场信息 + 对话区 ---------- */}
      <div className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* 左栏：推演情景（全部场次一览，点一下就切 —— 不再用下拉菜单挑） */}
        <aside className="flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-ink-800 bg-ink-850/40 p-3">
          <Button variant="primary" size="md" className="w-full" onClick={() => setSetupOpen(true)}>＋ 新建推演</Button>
          {list.length > 4 && (
            <input
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-[11.5px] text-ink-100 outline-none focus:border-amber/50"
              placeholder="筛选（标题 / 角色 / 锚点）"
              value={pickQuery}
              onChange={e => setPickQuery(e.target.value)}
            />
          )}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {sessionRows.map(s => {
              const active = s.id === activeId
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveId(s.id)}
                  className={`w-full rounded-md border px-2 py-1.5 text-left transition-colors ${
                    active ? 'border-amber/40 bg-amber/10' : 'border-transparent hover:bg-ink-800/60'
                  }`}
                >
                  <div className={`truncate text-[12px] ${active ? 'text-amber' : 'text-ink-200'}`}>{s.title}</div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-[10.5px] text-ink-500">
                      {s.mode === 'immersive' ? '沉浸' : '导演'} · {s.castBrief || '未分配角色'}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-ink-600">{fmtDay(s.updatedAt)}</span>
                  </div>
                </button>
              )
            })}
            {sessionRows.length === 0 && (
              <p className="px-1 py-2 text-[11px] leading-relaxed text-ink-500">
                {list.length === 0 ? '还没有推演 —— 点上面「新建推演」开一场。' : '没有匹配的推演。'}
              </p>
            )}
          </div>
          <div className="shrink-0 border-t border-ink-800 pt-2 text-[10.5px] text-ink-500">共 {list.length} 场</div>
        </aside>

        {!session ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-ink-800">
            <div className="text-center">
              <p className="text-[13px] text-ink-300">还没有选择推演</p>
              <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
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
            <aside className="w-64 shrink-0 overflow-y-auto rounded-lg border border-ink-800 bg-ink-850/40 p-3 space-y-3">
              <div>
                <div className="text-[11px] text-ink-500">叙事锚点</div>
                <div className="text-[12px] text-ink-200 mt-0.5">{session.anchorChapterLabel || '（未标注）'}</div>
              </div>
              <div>
                <div className="text-[11px] text-ink-500">信息边界</div>
                <div className="text-[12px] text-ink-200 mt-0.5">
                  {session.mode === 'immersive' ? '沉浸推演（只带角色常识）' : '导演推演（可参照大纲，仍截到锚点）'}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-ink-500">角色分配</div>
                <ul className="mt-1 space-y-1">
                  {casts.user.map(c => (
                    <li key={c.cardId} className="flex items-center gap-1.5">
                      <span className="flex-1 min-w-0 truncate text-[12px] text-amber">你演 · {c.name}</span>
                      <button
                        type="button"
                        onClick={() => setCastEdit({ cardId: c.cardId, name: c.name, kind: 'user' })}
                        className={`shrink-0 text-[11px] hover:text-amber ${castFilled[c.cardId] ? 'text-amber/80' : 'text-ink-500'}`}
                        title="扮演设定：口吻 / 称呼 / 知识边界 / 底线…">
                        {castFilled[c.cardId] ? '已设定' : '设定'}
                      </button>
                    </li>
                  ))}
                  {casts.ai.map(c => {
                    const mutedNow = (session.muted ?? []).includes(c.cardId)
                    const band = talkBandOf(talkativityOf(session, c.cardId))
                    return (
                    <li key={c.cardId} className="flex items-center gap-1.5">
                      <span className={"flex-1 min-w-0 truncate text-[12px] " + (mutedNow ? "text-ink-500" : "text-ink-200")}>
                        AI 演 · {c.name}
                        {mutedNow
                          ? <span className="ml-1 text-[10.5px] text-ink-600">已静音</span>
                          : band.name !== '均衡' && <span className="ml-1 text-[10.5px] text-ink-500">{band.name}</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCastEdit({ cardId: c.cardId, name: c.name, kind: 'ai' })}
                        className={`shrink-0 text-[11px] hover:text-amber ${castFilled[c.cardId] ? 'text-amber/80' : 'text-ink-500'}`}
                        title="扮演设定：口吻 / 称呼 / 知识边界 / 底线…">
                        {castFilled[c.cardId] ? '已设定' : '设定'}
                      </button>
                    </li>
                    )
                  })}
                  {casts.silent.map(c => <li key={c.cardId} className="text-[12px] text-ink-500">在场 · {c.name}</li>)}
                </ul>
                {casts.ai.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setDirectorOpen(true)}
                    className="mt-1.5 w-full rounded-md border border-ink-700 py-1 text-[11px] text-ink-400 hover:text-amber"
                    title="静音（在场但不发言）与健谈度：只影响提示词怎么写，不改角色卡"
                  >
                    在场调度（静音 / 健谈度）
                  </button>
                )}
                <p className="mt-1.5 text-[10.5px] text-ink-500 leading-relaxed">
                  AI 演的角色建议填一填「扮演设定」—— 它管的是口吻与底线，比堆设定更能演得像。
                </p>
              </div>
              {(session.scene.place || session.scene.time || session.scene.description) && (
                <div>
                  <div className="text-[11px] text-ink-500">场景</div>
                  <div className="text-[12px] text-ink-300 mt-0.5 leading-relaxed">
                    {[session.scene.place, session.scene.time].filter(Boolean).join(' · ')}
                    {session.scene.description && <div className="mt-0.5">{session.scene.description}</div>}
                  </div>
                </div>
              )}
              {session.memory && (
                <div>
                  <div className="text-[11px] text-ink-500">本场记忆（{session.memory.length} 字）</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-400 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">{session.memory}</div>
                </div>
              )}
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-ink-500">检查点（{(session.checkpoints ?? []).length}）</span>
                  <Button variant="secondary" size="xs"
                    onClick={() => saveCheckpoint()}
                  >
                    ＋ 存一个
                  </Button>
                </div>
                {(session.checkpoints ?? []).length === 0 ? (
                  <p className="mt-1 text-[10.5px] text-ink-600 leading-relaxed">
                    还没有检查点。存一个之后，后面无论聊成什么样都能回到那一刻 ——
                    消息与本场记忆一起还原，而且可以撤销。
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {[...(session.checkpoints ?? [])].sort((a, b) => b.at - a.at).map(cp => (
                      <li key={cp.id} className="flex items-center gap-1.5">
                        <span
                          className="min-w-0 flex-1 truncate text-[11.5px] text-ink-300"
                          title={`第 ${cp.messageCount} 条 · ${new Date(cp.at).toLocaleString()}`}
                        >
                          {cp.label || `第 ${cp.messageCount} 条`}
                        </span>
                        <Button variant="secondary" size="xs"
                          onClick={() => void rollbackTo(cp.id)} className="shrink-0"
                        >
                          回到这里
                        </Button>
                        <Button variant="danger" size="xs"
                          title="删掉这个检查点（不影响对话）"
                          onClick={() => dropCp(cp.id)} className="shrink-0"
                        >
                          ×
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {session.undoSnapshot && (
                  <Button variant="secondary" size="sm" className="mt-1.5 w-full !text-[11px]" onClick={undoRollback}>
                    ↩ 撤销上次回滚（{new Date(session.undoSnapshot.at).toLocaleTimeString()}）
                  </Button>
                )}
              </div>
              <Button variant="secondary" size="md" className="w-full text-[12px]" onClick={removeSession}>删除这场推演</Button>
            </aside>
          )}

          {/* 中栏：对话区 */}
          <div className="flex flex-1 min-w-0 flex-col rounded-lg border border-ink-800 overflow-hidden">
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {session.messages.length === 0 && (
                <div className="text-center text-[12px] text-ink-500 py-10">
                  还没有对话。在下面输入你的第一句话开演。
                </div>
              )}
              {session.messages.map(m => (
                <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
                  <div className={m.role === 'user'
                    ? 'max-w-[80%] rounded-lg bg-amber/12 border border-amber/25 px-3 py-2'
                    : 'max-w-[85%] space-y-1'}>
                    {m.role !== 'user' && casts.ai.length > 1 && m.speakerId && (
                      <div className="text-[11px] text-amber">{casts.ai.find(c => c.cardId === m.speakerId)?.name ?? ''}</div>
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
                        onBranch: () => void branchAt(m.id),
                      }}
                    />
                  </div>
                </div>
              ))}
              {streaming && (
                <div className="max-w-[85%] space-y-1">
                  {streamText
                    ? renderTavernMessage(streamText)
                    : <div className="text-[12px] text-ink-500">{phase || '正在生成…'}</div>}
                </div>
              )}
            </div>

            {/* 输入区 */}
            <div className="border-t border-ink-800 p-3">
              <TavernDirectorNoteBar
                note={session.directorNote}
                postApplied={postNotice.applied}
                postErrors={postNotice.errors}
                disabled={streaming}
                onSave={n => void applyDirectorNote(n)}
                onClear={() => void applyDirectorNote(null)}
              />
              <TavernQuickBar actions={quickActions} disabled={streaming} className="mb-2" />
              <AutoTextarea
                className="bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-[13px]"
                minRows={3}
                maxHeight={200}
                placeholder={casts.user.length
                  ? '以你的角色身份说一句话、做一个动作…（Ctrl+Enter 发送）'
                  : '这一场没有你演的角色 —— 可以以旁白或任意角色的身份推进…（Ctrl+Enter 发送）'}
                value={input}
                disabled={streaming}
                onChange={setInput}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-ink-500">
                  对话消息 {dialogChars} 字
                  {session.memory ? ` · 记忆 ${session.memory.length}/${MEMORY_SOFT_LIMIT} 字` : ''}
                  <button
                    type="button"
                    onClick={() => setUsageOpen(true)}
                    className="ml-2 text-amber/80 hover:text-amber underline decoration-dotted"
                    title="按真实组装量一遍：协议 / 设定层 / 背景设定 / 记忆各占多少，留给对话历史多少"
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
            </div>
          </div>
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
        note="只影响这一场的发言安排：不改角色卡，也不删记忆 —— 静音的人依然算在场，只是这一轮不发言。「下一位」点名在自由对话里。"
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
