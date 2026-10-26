/**
 * 对话引导（访谈式补全）—— 共用界面
 *
 * 【交互形状】
 * 打开即由 AI 先开口（问 1–3 个相关问题）→ 作者回答 → AI 接着追问，一轮一轮把模板的字段填起来。
 * 界面上同时显示**提纲进度**（已有着落几栏 / 共几栏），让作者看得见「还差什么」，
 * 也让他知道什么时候可以收手。
 *
 * 【为什么把「已收集的栏」摊在界面右侧】
 * 这是访谈式创建最容易让人不安的地方：聊了半天不知道聊出什么了。摊开来，作者随时能核对
 * 「Ta 把我说的『怕黑』记成『怕水』了」—— 能在生成之前就发现，而不是等填进表单里才发现。
 *
 * 【为什么和酒馆解耦】
 * 同一套界面要给角色卡 / 剧本 / 背景设定，以及角色管理 / 表单 / 表格用。
 * 它只认 `InterviewSpec`（提纲 + 字段清单 + 中文名）与一个 `callChat`（发给哪个模型由调用方定），
 * 不认识任何业务。**别在业务侧再写一份** —— 一处改了措辞另一处没改，两边就会长得不一样。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ChatMessage } from '@/lib/ai'
import {
  emptyInterview, interviewProgress, filledToText, runInterviewTurn,
  type InterviewSpec, type InterviewState,
} from '@/lib/creative/interview'
import { showToast, confirmDialog } from '@/components/dialogs/dialogs'
import {
  archiveAgeLabel, clearInterviewArchive, loadInterviewArchive, saveInterviewArchive,
  type InterviewArchive,
} from '@/lib/creative/interviewStore'
import { Button } from '@/components/common/Button'
import { Modal } from '@/components/dialogs/Modal'
import { candidateApplyContext, useCandidateApply } from '@/components/common/useCandidateApply'
import type { CandidateSubmit } from '@/lib/ai/candidateApply'
import { getCurrentProjectId } from '@/lib/db'
import TempAttachmentPicker from '@/components/ai/TempAttachmentPicker'

export default function InterviewChat({
  subject, spec, existing, context, callChat, onClose, onApply, applyLabel = '采用候选并填入', headerSlot,
  persistScope, persistLabel,
}: {
  /** 「角色卡」/「剧本」/「这份设定」—— 只用于文案 */
  subject: string
  spec: InterviewSpec
  /** 补完模式：把已有内容作为起点交进去（可空 = 从零创建） */
  existing?: string
  /** 额外背景（如本项目世界观）：让追问与既有设定保持一致 */
  context?: string
  /** 实际发请求：酒馆用会话指定的模型、全局补全用活动模型 —— 由调用方决定 */
  callChat: (msgs: ChatMessage[], opts: { signal?: AbortSignal }) => Promise<string>
  onClose: () => void
  onApply: CandidateSubmit
  applyLabel?: string
  /**
   * 标题栏下方的附加区（2026-10-03）—— 各调用方在这里放自己的「带哪些既有设定一起聊」选择面板。
   * 🔴 本组件**不自己读库**：读什么、读多少一律由调用方决定后通过 `context` 递进来。
   */
  headerSlot?: ReactNode
  /**
   * 会话存档作用域（3.1.3）。由调用方给**稳定值**（通常直接复用弹窗的 `draftScope`）；
   * 不传 = 不存档（一次性试聊 / 单测）。
   */
  persistScope?: string
  /** 恢复提示里的主语（默认用 `subject`，如「主要角色」） */
  persistLabel?: string
}) {
  const [state, setState] = useState<InterviewState>(() => emptyInterview())
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /** 读到但**尚未恢复**的存档：有值 ⇒ 顶部显示「继续 / 重新开始」，且不自动开场 */
  const [archive, setArchive] = useState<InterviewArchive | null>(null)
  /** 存档还在读 —— 读完之前别自动开场，否则会和恢复提示抢着开场 */
  const [archiveLoading, setArchiveLoading] = useState(!!persistScope)
  const startedRef = useRef(false)
  /** 是否已把结果填回表单（填过就不必在关闭时再问一句） */
  const appliedRef = useRef(false)
  /** 卸载守卫：异步回来后不再 setState（切页签会卸载本组件） */
  const aliveRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const archiveOwner = useRef({ pid: getCurrentProjectId(), context: candidateApplyContext() })
  const adoption = useCandidateApply(async values => {
    const pid = getCurrentProjectId()
    const context = candidateApplyContext()
    const result = await onApply(values)
    if (result === false) return false
    if (context !== candidateApplyContext()) return false
    // Cleanup belongs to the accepted source project, even if the caller closes this modal.
    appliedRef.current = true
    if (persistScope) await clearInterviewArchive(persistScope, pid)
    if (aliveRef.current) showToast('采用操作已完成，请在目标页核对结果和保存状态')
    return true
  }, onClose)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  /**
   * 打开时读存档，**不自动恢复**。
   * 🔴 自动恢复的坑：作者以为这次是从零开始，结果 AI 接着上次那半句话问下去，
   *    他会以为"AI 记住了不该记的东西"。所以一律先问一句「继续 / 重新开始」。
   */
  useEffect(() => {
    if (!persistScope) { setArchiveLoading(false); return }
    let alive = true
    void loadInterviewArchive(persistScope, Date.now(), archiveOwner.current.pid).then(a => {
      if (!alive || archiveOwner.current.context !== candidateApplyContext()) return
      setArchive(a)
      setArchiveLoading(false)
    })
    return () => { alive = false }
  }, [persistScope])

  /** 落盘：存档不是关键数据，失败不阻断对话（串行由 interviewStore 内部保证） */
  const persist = (next: InterviewState) => {
    if (!persistScope || archiveOwner.current.context !== candidateApplyContext()) return
    void saveInterviewArchive(persistScope, {
      state: next,
      updatedAt: Date.now(),
      applied: false,
      subject: persistLabel ?? subject,
    }, archiveOwner.current.pid)
  }

  /**
   * 发一轮。
   * @param base 指定起点（「重新开始」时上一句刚 setState，闭包里还是旧 state）
   */
  const send = async (text: string | null, base?: InterviewState) => {
    const from = base ?? state
    setBusy(true)
    setErr('')
    try {
      const res = await runInterviewTurn(spec, from, text, { callChat, existing, context })
      if (!aliveRef.current) return
      setState(res.state)
      // 先 setState 再落盘：界面不等库（落盘失败也不该让对话卡住）
      persist(res.state)
    } catch (e) {
      if (!aliveRef.current) return
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  // 打开后自动开场（只跑一次 —— startedRef 防 React 双跑与依赖变化引起的重入）
  useEffect(() => {
    if (startedRef.current || busy) return
    // 有存档待选择时不开场：先让作者决定「继续」还是「重新开始」
    if (archiveLoading || archive) return
    if (state.turns.length > 0) return
    startedRef.current = true
    void send(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.turns.length, busy, archive, archiveLoading])

  /** 恢复上次的对话（提示条消失，不再重复出现） */
  const restoreArchive = () => {
    if (archiveOwner.current.context !== candidateApplyContext()) return
    if (!archive) return
    setState(archive.state)
    setArchive(null)
    startedRef.current = true // 已有对话，别再自动开场
  }

  /** 丢掉存档、从第一句重新开始 */
  const restartFromScratch = () => {
    if (archiveOwner.current.context !== candidateApplyContext()) return
    setArchive(null)
    startedRef.current = true
    const fresh = emptyInterview()
    setState(fresh)
    setInput('')
    if (persistScope) void clearInterviewArchive(persistScope, archiveOwner.current.pid)
    void send(null, fresh)
  }

  /**
   * 关闭前确认（B 方案）。
   * 🔴 禁原生 `window.confirm`（项目红线），一律走 `confirmDialog`。
   * 🔴 文案要讲清「会保留存档」—— 否则作者以为一关就全丢，反而不敢关。
   */
  const requestClose = () => {
    if (adoption.isPending()) return
    if (adoption.blocked) { onClose(); return }
    if (state.turns.length > 0 && !appliedRef.current) {
      void confirmDialog({
        title: '对话还没填回表单',
        message: '关掉后这段对话会保留存档，下次打开可以接着聊；现在要关闭吗？',
        confirmText: '关闭',
        cancelText: '继续聊',
      }).then(ok => {
        if (!ok) return
        // 保险：把这轮再落一次（正常情况下每轮已经落过）
        persist(state)
        onClose()
      })
      return
    }
    onClose()
  }

  /** Only an accepted callback may clear the archive; failed/declined attempts retain it. */
  const applyAndClose = () => {
    void adoption.apply(state.filled)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.turns.length, busy])

  // 渲染期派生（2026-10-04 六维审计 A5）：输入框每敲一键都会重渲染，包 useMemo 免跟着重算。
  const progress = useMemo(() => interviewProgress(state, spec.allowedKeys), [state, spec.allowedKeys])
  /** 「第 N 轮」按作者的**回答数**算（AI 开场白不算一轮） */
  const userTurnCount = useMemo(
    () => (archive ? archive.state.turns.filter(t => t.role === 'user').length : 0),
    [archive],
  )
  const filledRows = useMemo(
    () => Object.entries(state.filled).filter(([, v]) => String(v ?? '').trim()),
    [state.filled],
  )

  return (
    <Modal
      open onClose={requestClose} dismissible={!adoption.pending} showCloseButton={!adoption.pending} title={`对话引导 · 创建${subject}`} width="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-11 text-ink-500">
            {progress.got === 0
              ? '还没聊出内容 —— 先回答 AI 的问题'
              : `已收集 ${progress.got} / ${progress.total} 栏${state.done ? ' · AI 认为可以收尾了' : ''}`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" disabled={adoption.pending} onClick={requestClose}>关闭</Button>
            <Button
              variant="primary" size="md"
              disabled={progress.got === 0 || busy || adoption.pending || adoption.blocked}
              onClick={() => {
                if (progress.got === 0) return
                applyAndClose()
              }}
            >
              {adoption.pending ? '正在采用…' : applyLabel}
            </Button>
          </div>
        </div>
      }
    >
      {headerSlot && <div className="mb-3">{headerSlot}</div>}

      {/* 恢复提示条：只在「有存档且还没选」时出现 —— 进入对话后立刻消失，不反复打扰。
          窄窗口下靠 flex-wrap 换行，两个按钮不会被挤成一条缝。 */}
      {archive && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber/30 bg-amber/5 px-2.5 py-1.5">
          <span className="min-w-0 text-11 leading-relaxed text-ink-300">
            上次在聊「{archive.subject || subject}」，聊到第 {userTurnCount} 轮回答（{archiveAgeLabel(archive.updatedAt)}）—— 要接着聊吗？
          </span>
          <div className="ml-auto flex shrink-0 gap-2">
            <Button variant="secondary" size="sm" disabled={busy || adoption.pending || adoption.blocked} onClick={restoreArchive}>继续上次</Button>
            <Button variant="secondary" size="sm" disabled={busy || adoption.pending || adoption.blocked} onClick={restartFromScratch}>重新开始</Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_15rem]">
        {/* 左：对话 */}
        <div className="flex h-[26rem] min-h-0 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-md border border-ink-700 bg-ink-900/40 p-3">
            {state.turns.length === 0 && (
              <p className="text-12 text-ink-500">
                {busy ? 'AI 正在想第一个问题…' : '准备开始。'}
                {existing?.trim() && <span className="block mt-1">（会把已有内容当起点，只追问缺口）</span>}
              </p>
            )}
            {state.turns.map((t, i) => (
              <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : ''}`}>
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-2.5 py-1.5 text-12 leading-relaxed ${t.role === 'user'
                  ? 'bg-amber/12 border border-amber/25 text-ink-100'
                  : 'bg-ink-850 border border-ink-700 text-ink-200'}`}>
                  {t.text}
                </div>
              </div>
            ))}
            {busy && <p className="text-11 text-ink-500">正在想下一个问题…</p>}
          </div>

          {err && (
            <p className="mt-1.5 text-11 leading-relaxed text-amber">⚠️ {err}</p>
          )}
          {adoption.error && <p role="alert" className="rounded-lg border border-danger/40 bg-surface-panel p-2 text-12 text-danger">{adoption.error}</p>}

          {/* 🆕 3.0.3：临时附加文件 —— 对话式规划最需要"让 AI 先看看我这份资料" */}
          <div className="mt-2">
            <TempAttachmentPicker />
          </div>

          <div className="mt-2 flex items-end gap-2">
            <textarea
              disabled={adoption.pending || adoption.blocked}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && input.trim() && !busy && !adoption.isPending() && !adoption.blocked) {
                  e.preventDefault()
                  const t = input
                  setInput('')
                  void send(t)
                }
              }}
              rows={2}
              placeholder="回答上面的问题（Enter 发送，Shift+Enter 换行）—— 答得越具体，结果越贴近你想的样子。"
              className="min-h-0 flex-1 resize-none rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-12 text-ink-100 outline-none focus:border-amber/50"
            />
            <Button
              variant="primary" size="md" className="shrink-0"
              disabled={busy || adoption.pending || adoption.blocked || !input.trim()}
              onClick={() => { const t = input; setInput(''); void send(t) }}
            >
              发送
            </Button>
          </div>
        </div>

        {/* 右：已收集的栏（随时核对，别等生成完才发现记错了） */}
        <aside className="space-y-2">
          <div className="rounded-md border border-ink-700 px-2 py-1.5 text-11 text-ink-300">
            已收集 {progress.got} / {progress.total} 栏
          </div>
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-700 bg-ink-900/60 p-2 text-10 leading-relaxed text-ink-400">
            {filledRows.length ? filledToText(state.filled, spec.labels) : '（还没有内容）'}
          </pre>
          <p className="text-10 leading-relaxed text-ink-600">
            这些是 AI 从对话里顺手提炼的，可能记错 —— 生成后到表单里逐栏核对。
            聊不完也可以随时「{applyLabel}」，剩下的栏之后自己补（或再开一次引导继续）。
          </p>
        </aside>
      </div>
    </Modal>
  )
}
