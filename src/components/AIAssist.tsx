import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Sparkles, Send, Copy, Check, Trash2, Pencil, Plus,
  AlertCircle, MessageSquarePlus, FolderOpen,
} from 'lucide-react'
import AutoTextarea from './AutoTextarea'
import HelpPopover from './HelpPopover'
import PromptModal from './PromptModal'
import { confirmDialog } from './dialogs'
import {
  type AIProvider, type ChatMessage,
  chat, loadProviders, loadActiveId, saveActiveId, typeLabel,
  requireActiveProvider, isCancelled, composeSystemPrompt,
} from '../lib/ai'
import { useAIReady } from '../lib/useAIReady'
import { AI_DISABLED_HINT } from '../lib/aiScope'
import { buildProjectContext } from '../lib/aiContext'
import { getSetting, setSetting } from '../lib/db'
import { uid } from '../lib/id'
import { Button } from './Button'


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

const SYSTEM_PROMPT = `你是一位网络小说创作的辅助助手，专门帮助作者做创作前期的「灵感激发、剧情 / 人物 / 世界观规划、设定脑暴、一致性自查」工作。

规则：
1. 只输出规划性、启发性的内容（创意、大纲草案、设定建议、可选项），不要替作者直接写出小说正文章节；
2. 结构清晰，善用标题、列表、分点，便于作者直接取用；
3. 贴合作者给定的题材与风格；
4. 若信息不足，主动给出多个可选项而非空泛回答；
5. 用简体中文回复；
6. 若对话中提供了【项目资料】（世界观 / 角色 / 时间线 / 势力等），请优先参考其中已填写的设定，使建议贴合已有世界观与人设、不与已登记设定冲突，并可主动呼应其中的伏笔与线索。`

const TEMPLATES: { label: string; prompt: string }[] = [
  { label: '剧情灵感', prompt: '我想写一个关于【在此填写主题 / 核心梗】的故事，请给我 5 个差异化的剧情发展方向，每个用 2-3 句话说明卖点与潜在冲突。' },
  { label: '人物小传', prompt: '请为我的【类型，如：腹黑男二 / 废柴少女】角色设计一份小传：建议姓名风格、外貌气质、性格缺陷、核心动机、隐藏秘密，以及一条成长弧线。' },
  { label: '世界观脑暴', prompt: '围绕核心概念【在此填写概念】，帮我脑暴一套世界观设定草案：力量 / 修炼体系、主要势力及其矛盾、关键地点，以及 1 个能驱动全书的核心冲突。' },
  { label: '爽点节奏', prompt: '为【题材】故事设计一份「爽点节奏」：列出 8-10 个关键转折点，标注每处的情绪钩子与前期铺垫方式。' },
  { label: '一致性自查', prompt: '请帮我做设定一致性自查。以下是当前设定要点（人名 / 地点 / 时间线 / 能力 / 关系），请指出任何前后矛盾或逻辑漏洞，并给出修正建议：\n（在此粘贴你的设定）' },
]

const truncateTitle = (s: string, n = 16) => (s.length > n ? s.slice(0, n) + '…' : s)

export default function AIAssist({ reloadKey = 0 }: { reloadKey?: number }) {
  const { ready: aiReady } = useAIReady()
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [bringContext, setBringContext] = useState(false)
  /** 流式输出时累计的临时回文（未落库，仅用于边出边显） */
  const [streamingText, setStreamingText] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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
    setError('')
  }

  const switchSession = (id: string) => { setActiveSessionId(id); setError(''); setPrompt('') }

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
    if (!cfg) { setError('尚未配置可用模型，请先在上方「模型配置」里添加。'); return }
    const text0 = prompt.trim()
    const userMsg: ChatMsg = { id: uid(), role: 'user', content: text0, ts: Date.now() }
    const base: ChatSession = activeSession ?? { id: uid(), title: truncateTitle(text0), messages: [], updatedAt: Date.now() }
    const session0: ChatSession = {
      ...base,
      title: base.messages.length === 0 ? truncateTitle(text0) : base.title,
      messages: [...base.messages, userMsg],
      updatedAt: Date.now(),
    }
    persist(upsert(sessions, session0))
    setActiveSessionId(session0.id)
    setPrompt('')
    setLoading(true)
    setError('')
    setStreamingText('')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      let sys = composeSystemPrompt(SYSTEM_PROMPT, cfg)
      if (bringContext) {
        try {
          const ctx = await buildProjectContext({ budget: 4000 })
          if (ctx.text) sys += `\n\n【项目资料（供参考：人名 / 设定 / 时间线 / 势力，可据此约束你的建议）】\n${ctx.text}`
        } catch { /* 拿不到设定资料就少带一段，不阻断 */ }
      }
      const msgs: ChatMessage[] = [
        { role: 'system', content: sys },
        ...session0.messages.map(m => ({ role: m.role, content: m.content })),
      ]
      const reply = await chat(cfg, msgs, {
        signal: ctrl.signal,
        onToken: (d) => setStreamingText(prev => prev + d),
      })
      const assistantMsg: ChatMsg = { id: uid(), role: 'assistant', content: reply, ts: Date.now() }
      persist(upsert(sessions, { ...session0, messages: [...session0.messages, assistantMsg], updatedAt: Date.now() }))
    } catch (e) {
      if (!isCancelled(e)) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  const stop = () => abortRef.current?.abort()

  const copiedTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const copyMsg = (id: string, content: string) => {
    navigator.clipboard?.writeText(content)
    setCopied(id)
    copiedTimer.current = setTimeout(() => setCopied(prev => (prev === id ? null : prev)), 1200)
  }

  // 新消息 / 思考中 / 流式输出时滚动到底部
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [activeSession?.messages.length, loading, streamingText])

  return (
    <section className="bg-ink-850 border border-ink-700 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={14} className="text-amber" />
        <h2 className="text-[13px] font-semibold text-ink-100">AI 辅助规划</h2>
        <HelpPopover title="AI 辅助规划怎么用" width="23rem" className="ml-0.5">
          {'多轮对话式辅助：左侧可新建 / 切换 / 重命名 / 删除多个规划会话；右侧与模型连续对话。\n\n· 勾选「带入项目资料」可让模型参考你的世界观与角色设定，给出的建议更贴设定；\n· 灵感激发 / 剧情人物世界观规划 / 一致性自查（不生成正文）；\n· 首次使用先到上方「模型配置」添加并选择模型，未接入时对话按钮禁用。'}
        </HelpPopover>
      </div>

      {/* 当前模型状态条 */}
      {active ? (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-ink-800/70 border border-ink-700/70 text-[12px]">
          <span className={`px-1.5 py-0.5 rounded text-[10px] ${active.type === 'ollama' || active.local ? 'bg-emerald-500/15 text-emerald-400' : 'bg-sky-500/15 text-sky-400'}`}>
            {typeLabel(active)}
          </span>
          <span className="text-ink-200">{active.name}</span>
          <span className="text-ink-500">·</span>
          <span className="text-ink-300 font-mono">{active.model || '（未选模型）'}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-lg bg-amber/10 border border-amber/25 text-[12px] text-amber">
          <AlertCircle size={13} /> 尚未配置模型：请先在上方「模型配置」里添加本地或联网模型。
        </div>
      )}

      {/* 双栏：左历史会话 / 右多轮对话 */}
      <div className="flex gap-3 h-[60vh] min-h-[420px]">
        {/* 左：历史会话 */}
        <div className="w-44 shrink-0 flex flex-col bg-ink-900/40 border border-ink-700 rounded-lg overflow-hidden">
          <div className="p-2 border-b border-ink-700">
            <Button onClick={newSession} variant="primary" size="md" className="w-full flex items-center justify-center text-[12px]">
              <Plus size={12} /> 新建对话
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
            {sessions.length === 0 ? (
              <div className="text-[11px] text-ink-500 text-center py-6 px-2">还没有对话，点上方新建</div>
            ) : (
              [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(s => (
                <div
                  key={s.id}
                  onClick={() => switchSession(s.id)}
                  className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 cursor-pointer transition-colors ${s.id === activeSessionId ? 'bg-amber/10 border border-amber/30' : 'border border-transparent hover:bg-ink-800'}`}
                >
                  <MessageSquarePlus size={12} className={`shrink-0 ${s.id === activeSessionId ? 'text-amber' : 'text-ink-500'}`} />
                  <span className={`flex-1 text-[11.5px] truncate ${s.id === activeSessionId ? 'text-amber' : 'text-ink-300'}`}>{s.title}</span>
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
                <span className="text-[12px]">开始和 AI 聊你的创作构想吧<br />点上方模板可快速提问</span>
              </div>
            ) : (
              [...activeSession.messages, ...(loading ? [{ id: '__stream__', role: 'assistant' as const, content: streamingText || '思考中…', ts: Date.now() }] : [])].map(m => (
                <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-xl px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'bg-amber/15 text-amber border border-amber/25' : 'bg-ink-800 text-ink-200 border border-ink-700'}`}>
                    {m.content}
                    {m.role === 'assistant' && (
                      <Button variant="icon-muted" onClick={() => copyMsg(m.id, m.content)} className="ml-2 align-middle" title="复制">
                        {copied === m.id ? <Check size={11} className="text-emerald-400 inline" /> : <Copy size={11} className="inline" />}
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
              <div className="flex items-start gap-2 px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-[11px] text-red-300">
                <AlertCircle size={12} className="mt-0.5 shrink-0" /> <span className="whitespace-pre-wrap">{error}</span>
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-1.5 text-[11px] text-ink-400 cursor-pointer select-none">
                <input type="checkbox" checked={bringContext} onChange={e => setBringContext(e.target.checked)} className="accent-amber" />
                带入项目资料
              </label>
              <div className="flex flex-wrap gap-1 ml-1">
                {TEMPLATES.map(t => (
                  <Button variant="bare"
                    key={t.label}
                    onClick={() => setPrompt(t.prompt)}
                    className="px-2 py-0.5 rounded-full text-[10.5px] bg-ink-800 text-ink-300 border border-ink-700 hover:text-amber hover:border-amber/30 transition-colors"
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
                placeholder={aiReady ? '描述你的主题、要求或要自查的设定……' : '未接入模型，请先在上方「模型配置」里添加'}
                minHeight={40}
                maxHeight={160}
                className="!px-3 !py-2 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 focus:border-amber/40 outline-none placeholder:text-ink-600 flex-1"
              />
              {loading ? (
                <Button onClick={stop} variant="danger" size="md" className="shrink-0 flex items-center text-[12px]">
                  <AlertCircle size={13} /> 停止
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void send()} disabled={!aiReady || !prompt.trim()} className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title={!aiReady ? AI_DISABLED_HINT : '发送'}>
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
    </section>
  )
}
