import Panel from './Panel'
import { foldVh } from '../lib/theme'
import { writerBudgetFor } from '../lib/aiWriterBudget'
import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Sparkles, Send, Copy, Check, Trash2, Pencil, Plus,
  AlertCircle, MessageSquarePlus, FolderOpen,
} from 'lucide-react'
import AutoTextarea from './AutoTextarea'
import HelpPopover from './HelpPopover'
import AIDataSourceNote from './AIDataSourceNote'
import PromptModal from './PromptModal'
import { confirmDialog, copyText } from './dialogs'
import {
  type AIProvider, type ChatMessage,
  chat, loadProviders, loadActiveId, saveActiveId, typeLabel,
  requireActiveProvider, composeSystemPrompt,
} from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { useTaskRunner } from '../lib/aiTaskCenter'
import { buildProjectContext } from '../lib/aiContext'
import { getSetting, setSetting } from '../lib/db'
import { uid } from '../lib/id'
import { Button } from './Button'
import { clipText } from '../lib/textClip'
// 🔴 W2-3：提示词与登记已搬到 lib（静态可达）—— 组件里不再 registerPrompt
import { getAssistPrompt } from '../lib/aiAssistPrompt'

// ============ 多轮对话会话模型（按项目持久化在 settingsKV） ============
interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  ts: number
}
interface ChatSession {
  id: string
  title: string
  messages: ChatMsg[]
  updatedAt: number
}
const SESSIONS_KEY = 'aiChatSessions'

// 功能提示词已移至 lib/aiAssistPrompt.ts（🔴 那里加载即注册，不受本组件懒加载影响）

const TEMPLATES: { label: string; prompt: string }[] = [
  { label: '剧情灵感', prompt: '我想写一个关于【在此填写主题 / 核心梗】的故事，请给我 5 个差异化的剧情发展方向，每个用 2-3 句话说明卖点与潜在冲突。' },
  { label: '人物小传', prompt: '请为我的【类型，如：腹黑男二 / 废柴少女】角色设计一份小传：建议姓名风格、外貌气质、性格缺陷、核心动机、隐藏秘密，以及一条成长弧线。' },
  { label: '世界脑暴', prompt: '围绕核心概念【在此填写概念】，帮我脑暴一套世界观设定草案：力量 / 修炼体系、主要势力及其矛盾、关键地点，以及 1 个能驱动全书的核心冲突。' },
  { label: '爽点节奏', prompt: '为【题材】故事设计一份「爽点节奏」：列出 8-10 个关键转折点，标注每处的情绪钩子与前期铺垫方式。' },
  { label: '设定自查', prompt: '请帮我做设定一致性自查。以下是当前设定要点（人名 / 地点 / 时间线 / 能力 / 关系），请指出任何前后矛盾或逻辑漏洞，并给出修正建议：\n（在此粘贴你的设定）' },
]

const truncateTitle = (s: string, n = 16) => clipText(s, n)

export default function AIAssist({ reloadKey = 0 }: { reloadKey?: number }) {
  const { ready: aiReady } = useAIReady()
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  /** 本地错误（未配置模型等界面问题）；AI 请求失败由任务中心报 */
  const [localError, setLocalError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [bringContext, setBringContext] = useState(false)
  /** 流式输出时累计的临时回文（未落库，仅用于边出边显） */
  const [streamingText, setStreamingText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // 🔴 接到任务中心（清单 #009）：AI 回复耗时可达数十秒，切页签时 **loading 状态与完成提示**都不再丢，
  //    也避免切回来后误判「没在跑」而重复发送（同一会话并发两条回复会串序）。
  //    ⚠️ 流式回文**刻意不放进任务中心**：每个 token 都推一次全局快照会把指示器拖垮；
  //       它留在组件本地、丢失也无妨 —— 完整回复会落库，切回来照样能看到。
  const t = useTaskRunner<ChatSession>({
    ownerTab: 'inspire-tools', kind: 'ai-assist', title: 'AI 辅助规划',
    // 回复会写进本项目的会话清单 —— 与别的写同一份 meta 的任务撞上时会轻提示一次
    writes: ['meta:ai-assist-sessions'],
  })
  const loading = t.running
  const error = localError || t.error

  const active = providers.find(p => p.id === activeId) ?? null
  const activeSession = sessions.find(s => s.id === activeSessionId) ?? null

  const reload = useCallback(async () => {
    const list = await loadProviders()
    const aid = await loadActiveId()
    setProviders(list)
    const valid = aid && list.some(p => p.id === aid)
    if (valid) setActiveId(aid)
    else if (list.length > 0) { setActiveId(list[0].id); await saveActiveId(list[0].id) }
    else setActiveId(null)
  }, [])

  // 载入会话列表（按项目持久化）
  const reloadSessions = useCallback(async () => {
    const list = (await getSetting<ChatSession[]>(SESSIONS_KEY, [])) ?? []
    setSessions(list)
    setActiveSessionId(list.length > 0 ? [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0].id : null)
  }, [])

  useEffect(() => { reload() }, [reload, reloadKey])
  useEffect(() => { reloadSessions() }, [reloadSessions])

  /** 写入会话列表并持久化（按项目 settingsKV） */
  const persist = useCallback((next: ChatSession[], keepActive = true) => {
    setSessions(next)
    if (keepActive) setActiveSessionId(prev => prev ?? next[0]?.id ?? null)
    void setSetting(SESSIONS_KEY, next)
  }, [])

  const upsert = (list: ChatSession[], s: ChatSession) => {
    const i = list.findIndex(x => x.id === s.id)
    return i >= 0 ? list.map(x => x.id === s.id ? s : x) : [...list, s]
  }

  const newSession = () => {
    const s: ChatSession = { id: uid(), title: '新对话', messages: [], updatedAt: Date.now() }
    persist(upsert(sessions, s))
    setActiveSessionId(s.id)
    setPrompt('')
    setLocalError('')
  }

  const switchSession = (id: string) => { setActiveSessionId(id); setLocalError(''); setPrompt('') }

  // v1.6：对话改名走应用内 PromptModal（浏览器 prompt 在 Electron 桌面端无实现、点击无反应）
  const [renameTarget, setRenameTarget] = useState<ChatSession | null>(null)

  const renameSession = (id: string) => {
    const s = sessions.find(x => x.id === id)
    if (s) setRenameTarget(s)
  }

  const submitRename = (v: string) => {
    const s = renameTarget
    setRenameTarget(null)
    if (!s || !v.trim() || v.trim() === s.title) return
    persist(upsert(sessions, { ...s, title: v.trim(), updatedAt: Date.now() }))
  }

  const deleteSession = async (id: string) => {
    if (!await confirmDialog({ title: '删除对话', message: '确定删除该对话？此操作不可恢复。', danger: true })) return
    const next = sessions.filter(x => x.id !== id)
    persist(next, false)
    if (activeSessionId === id) setActiveSessionId(next[0]?.id ?? null)
  }

  const send = async () => {
    if (!aiReady || !prompt.trim() || loading) return
    const cfg = await requireActiveProvider().catch(() => null)
    if (!cfg) { setLocalError('尚未配置可用模型，请先到「工作面板 → 模型设置」里添加。'); return }
    const text0 = prompt.trim()
    const userMsg: ChatMsg = { id: uid(), role: 'user', content: text0, ts: Date.now() }
    const base: ChatSession = activeSession ?? { id: uid(), title: truncateTitle(text0), messages: [], updatedAt: Date.now() }
    const session0: ChatSession = {
      ...base,
      title: base.messages.length === 0 ? truncateTitle(text0) : base.title,
      messages: [...base.messages, userMsg],
      updatedAt: Date.now(),
    }
    // 作者的话立刻落库 —— 即便后面回复失败也不丢
    persist(upsert(sessions, session0))
    setActiveSessionId(session0.id)
    setPrompt('')
    setLocalError('')
    setStreamingText('')
    // 会话清单**不在这里快照**（见下方落库处）：任务跑在 store 里，完成时要读**最新**清单再合并
    const bringCtx = bringContext
    t.run(async job => {
      let sys = composeSystemPrompt(getAssistPrompt(), cfg)
      if (bringCtx) {
        try {
          const ctx = await buildProjectContext({ budget: await writerBudgetFor('ai-assist') })
          if (ctx.text) sys += `\n\n【项目资料（供参考：人名 / 设定 / 时间线 / 势力，可据此约束你的建议）】\n${ctx.text}`
        } catch { /* 拿不到设定资料就少带一段，不阻断 */ }
      }
      const msgs: ChatMessage[] = [
        { role: 'system', content: sys },
        ...session0.messages.map(m => ({ role: m.role, content: m.content })),
      ]
      const reply = await chat(cfg, msgs, {
        signal: job.signal,
        // 边出边显只在组件活着时有意义（卸载后 setState 是 no-op，无害）
        onToken: (d) => setStreamingText(prev => prev + d),
      })
      const assistantMsg: ChatMsg = { id: uid(), role: 'assistant', content: reply, ts: Date.now() }
      const nextSession: ChatSession = { ...session0, messages: [...session0.messages, assistantMsg], updatedAt: Date.now() }
      // 🔴 落库放在**任务内**（不依赖组件存活）：切页签跑完的回复，回来重新加载会话就能看到。
      // 🔴🔴 2026-10-01 六维审计 P2：这里必须**先读回最新清单再合并**，不能用发起时的快照。
      //    发起时会话快照给不了"期间发生了什么"：作者在等回复时点「新建对话」/「切换会话」
      //    都会**立刻落库**（见 newSession / persist），拿旧快照覆盖就会把那段时间新建的会话
      //    从磁盘上抹掉（内存里还在，一重载就没了）。`upsert` 按 id 合并 ⇒ 读最新是无损的。
      const latest = (await getSetting<ChatSession[]>(SESSIONS_KEY, [])) ?? []
      void setSetting(SESSIONS_KEY, upsert(latest, nextSession))
      return nextSession
    })
  }

  // 任务完成 → 把新会话同步进本地清单（含切回页签后从任务中心读回）
  useEffect(() => {
    const s = t.result
    if (!s) return
    setSessions(prev => {
      const i = prev.findIndex(x => x.id === s.id)
      return i >= 0 ? prev.map(x => (x.id === s.id ? s : x)) : [...prev, s]
    })
  }, [t.result])

  const stop = () => t.stop()

  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyMsg = (id: string, content: string) => {
    void copyText(content, '已复制到剪贴板') // 走统一入口：非安全上下文有 execCommand 兜底、失败不静默
    setCopied(id)
    copiedTimer.current = setTimeout(() => setCopied(prev => (prev === id ? null : prev)), 1200)
  }

  // 新消息 / 思考中 / 流式输出时滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [activeSession?.messages.length, loading, streamingText])

  return (
    <Panel>
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={14} className="text-amber" />
        <h2 className="text-13 font-semibold text-ink-100">AI 辅助规划</h2>
        <HelpPopover title="AI 辅助规划怎么用" width="23rem" className="ml-0.5">
          {'多轮对话式辅助：左侧可新建 / 切换 / 重命名 / 删除多个规划会话；右侧与模型连续对话。\n\n· 勾选「带入项目资料」可让模型参考你的世界观与角色设定，给出的建议更贴设定；\n· 灵感激发 / 剧情人物世界观规划 / 一致性自查（不生成正文）；\n· 首次使用先到「工作面板 → 模型设置」添加并选择模型，未接入时对话按钮禁用。'}
          <AIDataSourceNote feature="ai-assist" />
        </HelpPopover>
      </div>

      {/* 当前模型状态条 */}
      {active ? (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-ink-800/70 border border-ink-700/70 text-12">
          <span className={`px-1.5 py-0.5 rounded text-10 ${active.type === 'ollama' || active.local ? 'bg-success/15 text-success' : 'bg-info/15 text-info'}`}>
            {typeLabel(active)}
          </span>
          <span className="text-ink-200">{active.name}</span>
          <span className="text-ink-500">·</span>
          <span className="text-ink-300 font-mono">{active.model || '（未选模型）'}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-amber/10 border border-amber/25 text-12 text-amber">
          <AlertCircle size={13} /> 尚未配置模型：请先到「工作面板 → 模型设置」里添加本地或联网模型。
        </div>
      )}

      {/* 双栏：左历史会话 / 右多轮对话 */}
      <div className="flex gap-3 min-h-[420px]"
style={{ height: foldVh('60vh') }}>
        {/* 左：历史会话 */}
        <div className="w-44 shrink-0 flex flex-col bg-ink-900/40 border border-ink-700 rounded-lg overflow-hidden">
          <div className="p-2 border-b border-ink-700">
            <Button onClick={newSession} variant="primary" size="md" className="w-full flex items-center justify-center">
              <Plus size={12} /> 新建对话
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
            {sessions.length === 0 ? (
              <div className="text-11 text-ink-500 text-center py-6 px-2">还没有对话，点上方新建</div>
            ) : (
              [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(s => (
                <div
                  key={s.id}
                  onClick={() => switchSession(s.id)}
                  className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 cursor-pointer transition-colors ${s.id === activeSessionId ? 'bg-amber/15 border border-amber/30' : 'border border-transparent hover:bg-ink-800'}`}
                >
                  <MessageSquarePlus size={12} className={`shrink-0 ${s.id === activeSessionId ? 'text-amber' : 'text-ink-500'}`} />
                  <span className={`flex-1 text-11 truncate ${s.id === activeSessionId ? 'text-amber' : 'text-ink-300'}`}>{s.title}</span>
                  <Button variant="icon-muted" onClick={e => { e.stopPropagation(); renameSession(s.id) }} className="opacity-40 group-hover:opacity-100 p-0.5" title="重命名"><Pencil size={11} /></Button>
                  <Button variant="icon-danger" onClick={e => { e.stopPropagation(); deleteSession(s.id) }} className="opacity-40 group-hover:opacity-100 p-0.5" title="删除"><Trash2 size={11} /></Button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右：对话 */}
        <div className="flex-1 flex flex-col min-w-0 bg-ink-900/40 border border-ink-700 rounded-lg overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
            {!activeSession || activeSession.messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-ink-500 gap-2">
                <FolderOpen size={20} className="text-ink-600" />
                <span className="text-12">开始和 AI 聊你的创作构想吧<br />点上方模板可快速提问</span>
              </div>
            ) : (
              [...activeSession.messages, ...(loading ? [{ id: '__stream__', role: 'assistant' as const, content: streamingText || '思考中…', ts: Date.now() }] : [])].map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 text-12 leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'bg-amber/15 text-amber border border-amber/25' : 'bg-ink-800 text-ink-200 border border-ink-700'}`}>
                    {m.content}
                    {m.role === 'assistant' && (
                      <Button variant="icon-muted" onClick={() => copyMsg(m.id, m.content)} className="ml-2 align-middle" title="复制">
                        {copied === m.id ? <Check size={11} className="text-success inline" /> : <Copy size={11} className="inline" />}
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* 输入区 */}
          <div className="border-t border-ink-700 p-2.5 space-y-2">
            {error && (
              <div className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-danger/10 border border-danger/25 text-11 text-danger">
                <AlertCircle size={12} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{error}</span>
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-1.5 text-11 text-ink-400 cursor-pointer select-none">
                <input type="checkbox" checked={bringContext} onChange={e => setBringContext(e.target.checked)} className="accent-amber" />
                带入项目资料
              </label>
              <div className="flex flex-wrap gap-1 ml-1">
                {TEMPLATES.map(t => (
                  <Button variant="bare"
                    key={t.label}
                    onClick={() => setPrompt(t.prompt)}
                    className="px-2 py-0.5 rounded-full text-10 bg-ink-800 text-ink-300 border border-ink-700 hover:text-amber hover:border-amber/30 transition-colors"
                    title={t.prompt}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex items-end gap-2">
              <AutoTextarea
                value={prompt}
                onChange={setPrompt}
                placeholder={aiReady ? '描述你的主题、要求或要自查的设定……' : '未接入模型，请先到「工作面板 → 模型设置」添加'}
                minHeight={40}
                maxHeight={160}
                className="!px-3 !py-2 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 focus:border-amber/40 outline-none placeholder:text-ink-600 flex-1"
              />
              {loading ? (
                <Button onClick={stop} variant="danger" size="md" className="shrink-0 flex items-center">
                  <AlertCircle size={13} /> 停止
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void send()} disabled={!aiReady || !prompt.trim()} className="shrink-0 flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title={!aiReady ? AI_DISABLED_HINT : '发送'}>
                  <Send size={13} /> 发送
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

            {/* v1.6：应用内输入弹窗（替代浏览器 prompt，桌面端可用） */}
      <PromptModal
        open={!!renameTarget}
        title="重命名对话"
        defaultValue={renameTarget?.title ?? ''}
        placeholder="请输入对话名称"
        onSubmit={submitRename}
        onCancel={() => setRenameTarget(null)}
      />
    </Panel>
  )
}

// —— AI 提示词登记已移至 lib/aiAssistPrompt.ts（W2-3）——
// 原先写在这里会因本组件只在懒加载的「灵感工具」页里被 import 而**漏注册**：
// 没打开过那个页签的作者，在「AI 提示词」设置页看不到这条。
