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
import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../lib/ai'
import {
  emptyInterview, interviewProgress, filledToText, runInterviewTurn,
  type InterviewSpec, type InterviewState,
} from '../lib/interview'
import { showToast } from './dialogs'
import { Button } from './Button'
import { Modal } from './Modal'

export default function InterviewChat({
  subject, spec, existing, context, callChat, onClose, onApply, applyLabel = '生成草稿并填入',
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
  onApply: (filled: Record<string, string>) => void
  applyLabel?: string
}) {
  const [state, setState] = useState<InterviewState>(() => emptyInterview())
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const startedRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const send = async (text: string | null) => {
    setBusy(true)
    setErr('')
    try {
      const res = await runInterviewTurn(spec, state, text, { callChat, existing, context })
      setState(res.state)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // 打开后自动开场（只跑一次 —— startedRef 防 React 双跑与依赖变化引起的重入）
  useEffect(() => {
    if (startedRef.current || busy) return
    if (state.turns.length > 0) return
    startedRef.current = true
    void send(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.turns.length, busy])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.turns.length, busy])

  const progress = interviewProgress(state, spec.allowedKeys)
  const filledRows = Object.entries(state.filled).filter(([, v]) => String(v ?? '').trim())

  return (
    <Modal
      open onClose={onClose} title={`对话引导 · 创建${subject}`} width="xl"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-11 text-ink-500">
            {progress.got === 0
              ? '还没聊出内容 —— 先回答 AI 的问题'
              : `已收集 ${progress.got} / ${progress.total} 栏${state.done ? ' · AI 认为可以收尾了' : ''}`}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={onClose}>关闭</Button>
            <Button
              variant="primary" size="md"
              disabled={progress.got === 0 || busy}
              onClick={() => {
                if (progress.got === 0) return
                onApply(state.filled)
                showToast(`已填入 ${progress.got} 栏 —— 生成的是草稿，逐栏改完再保存`)
              }}
            >
              {applyLabel}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_15rem]">
        {/* 左：对话 */}
        <div className="flex h-[26rem] min-h-0 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-md border border-ink-800 bg-ink-900/40 p-3">
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
                  : 'bg-ink-850 border border-ink-800 text-ink-200'}`}>
                  {t.text}
                </div>
              </div>
            ))}
            {busy && <p className="text-11 text-ink-500">正在想下一个问题…</p>}
          </div>

          {err && (
            <p className="mt-1.5 text-11 leading-relaxed text-amber">⚠️ {err}</p>
          )}

          <div className="mt-2 flex items-end gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && input.trim() && !busy) {
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
              disabled={busy || !input.trim()}
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
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap rounded-md border border-ink-800 bg-ink-900/60 p-2 text-10 leading-relaxed text-ink-400">
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
