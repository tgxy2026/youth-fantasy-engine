import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Sparkles, Settings2, Send, Copy, Check, Trash2, Pencil, Plus,
  Cpu, Globe, Loader2, AlertCircle, CheckCircle2, FlaskConical,
  MessageSquarePlus, FolderOpen,
} from 'lucide-react'
import { Modal } from './Modal'
import AutoTextarea from './AutoTextarea'
import HelpPopover from './HelpPopover'
import PromptModal from './PromptModal'
import { confirmDialog } from './dialogs'
import {
  type AIProvider, type ChatMessage, type AITestResult, type PlatformPreset,
  LOCAL_PRESETS, ONLINE_PRESETS, LOCAL_OPENAI_PRESETS, providerFromPreset,
  listOllamaModels, chat, testProvider,
  loadProviders, saveProviders, loadActiveId, saveActiveId, typeLabel,
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
5. 用简体中文回复。`

const TEMPLATES: { label: string; prompt: string }[] = [
  { label: '剧情灵感', prompt: '我想写一个关于【在此填写主题 / 核心梗】的故事，请给我 5 个差异化的剧情发展方向，每个用 2-3 句话说明卖点与潜在冲突。' },
  { label: '人物小传', prompt: '请为我的【类型，如：腹黑男二 / 废柴少女】角色设计一份小传：建议姓名风格、外貌气质、性格缺陷、核心动机、隐藏秘密，以及一条成长弧线。' },
  { label: '世界观脑暴', prompt: '围绕核心概念【在此填写概念】，帮我脑暴一套世界观设定草案：力量 / 修炼体系、主要势力及其矛盾、关键地点，以及 1 个能驱动全书的核心冲突。' },
  { label: '爽点节奏', prompt: '为【题材】故事设计一份「爽点节奏」：列出 8-10 个关键转折点，标注每处的情绪钩子与前期铺垫方式。' },
  { label: '一致性自查', prompt: '请帮我做设定一致性自查。以下是当前设定要点（人名 / 地点 / 时间线 / 能力 / 关系），请指出任何前后矛盾或逻辑漏洞，并给出修正建议：\n（在此粘贴你的设定）' },
]

const truncateTitle = (s: string, n = 16) => (s.length > n ? s.slice(0, n) + '…' : s)

export default function AIAssist() {
  const { ready: aiReady } = useAIReady()
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)

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

  useEffect(() => { reload() }, [reload])
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
    if (!cfg) { setError('尚未配置可用模型，点右上角「模型设置」添加。'); return }
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

  const copyMsg = (id: string, content: string) => {
    navigator.clipboard?.writeText(content)
    setCopied(id)
    setTimeout(() => setCopied(prev => (prev === id ? null : prev)), 1200)
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
          {'多轮对话式辅助：左侧可新建 / 切换 / 重命名 / 删除多个规划会话；右侧与模型连续对话。\n\n· 勾选「带入项目资料」可让模型参考你的世界观与角色设定，给出的建议更贴设定；\n· 灵感激发 / 剧情人物世界观规划 / 一致性自查（不生成正文）；\n· 首次使用点右上角「模型设置」添加并选择模型，未接入时对话按钮禁用。'}
        </HelpPopover>
        <button
          onClick={() => setShowSettings(true)}
          className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] bg-ink-800 text-ink-300 border border-ink-600 hover:text-ink-100 hover:border-amber/30 transition-colors"
        >
          <Settings2 size={12} /> 模型设置
        </button>
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
          <AlertCircle size={13} /> 尚未配置模型，点右上角「模型设置」添加本地模型或联网模型。
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
                  <button onClick={e => { e.stopPropagation(); renameSession(s.id) }} className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-500 hover:text-ink-200" title="重命名"><Pencil size={11} /></button>
                  <button onClick={e => { e.stopPropagation(); deleteSession(s.id) }} className="opacity-0 group-hover:opacity-100 p-0.5 text-ink-500 hover:text-red-400" title="删除"><Trash2 size={11} /></button>
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
                      <button onClick={() => copyMsg(m.id, m.content)} className="ml-2 align-middle text-ink-500 hover:text-ink-200" title="复制">
                        {copied === m.id ? <Check size={11} className="text-emerald-400 inline" /> : <Copy size={11} className="inline" />}
                      </button>
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
                  <button
                    key={t.label}
                    onClick={() => setPrompt(t.prompt)}
                    className="px-2 py-0.5 rounded-full text-[10.5px] bg-ink-800 text-ink-300 border border-ink-700 hover:text-amber hover:border-amber/30 transition-colors"
                    title={t.prompt}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-end gap-2">
              <AutoTextarea
                value={prompt}
                onChange={setPrompt}
                placeholder={aiReady ? '描述你的主题、要求或要自查的设定……' : '未接入模型，请先点右上角「模型设置」'}
                minHeight={40}
                maxHeight={160}
                className="!px-3 !py-2 bg-ink-800 border border-ink-700 rounded-lg text-ink-100 focus:border-amber/40 outline-none placeholder:text-ink-600 flex-1"
              />
              {loading ? (
                <Button onClick={stop} variant="danger" size="md" className="shrink-0 flex items-center text-[12px]">
                  <AlertCircle size={13} /> 停止
                </Button>
              ) : (
                <button
                  onClick={() => void send()}
                  disabled={!aiReady || !prompt.trim()}
                  className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-amber/15 text-amber border border-amber/30 rounded-lg text-[12px] hover:bg-amber/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={!aiReady ? AI_DISABLED_HINT : '发送'}
                >
                  <Send size={13} /> 发送
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {showSettings && (
        <SettingsModal onClose={() => { setShowSettings(false); reload() }} />
      )}

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

// ============ 模型设置弹窗 ============

function fmtMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** 测试结果条：成功显示耗时与模型回文，失败显示中文原因 */
function TestResultBar({ r }: { r: AITestResult }) {
  const cost = fmtMs(r.latencyMs)
  // 本地模型首次调用大头在「搬进显存」，标出来避免误判为响应慢
  const loadHint = r.loadMs > 500 ? `（其中模型加载 ${fmtMs(r.loadMs)}）` : ''
  return (
    <div
      className={`flex items-start gap-2 px-2.5 py-1.5 rounded-lg text-[11px] ${
        r.ok
          ? 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-300'
          : 'bg-red-500/10 border border-red-500/25 text-red-300'
      }`}
    >
      {r.ok ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" /> : <AlertCircle size={12} className="mt-0.5 shrink-0" />}
      {r.ok ? (
        <span>
          配置可用 · 耗时 {cost}
          {loadHint && <span className="text-emerald-400/70">{loadHint}</span>}
          {' · 模型回复「'}
          <span className="text-emerald-200">{r.reply.slice(0, 40)}</span>
          {r.reply.length > 40 ? '…' : ''}」
        </span>
      ) : (
        <span className="whitespace-pre-wrap">{r.error}</span>
      )}
    </div>
  )
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState<AIProvider | null>(null)
  const [ollamaModels, setOllamaModels] = useState<string[]>([])
  const [testing, setTesting] = useState(false)
  const [editResult, setEditResult] = useState<AITestResult | null>(null)
  const [saving, setSaving] = useState(false)
  /** 列表页：正在测试的模型 id（全局单测，避免多个大模型同时抢显存） */
  const [testingId, setTestingId] = useState<string | null>(null)
  /** 列表页：添加模型的平台选择态——none 显示两个大按钮；local/online 显示对应平台预设 */
  const [pickMode, setPickMode] = useState<'none' | 'local' | 'online'>('none')
  /** 列表页：各模型最近一次测试结果 */
  const [rowResults, setRowResults] = useState<Record<string, AITestResult>>({})

  const fail = (msg: string): AITestResult => ({ ok: false, latencyMs: 0, loadMs: 0, reply: '', error: msg })

  const refresh = useCallback(async () => {
    const list = await loadProviders()
    const aid = await loadActiveId()
    setProviders(list)
    setActiveId(list.some(p => p.id === aid) ? aid : (list[0]?.id ?? null))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const persist = async (list: AIProvider[], aid: string | null) => {
    await saveProviders(list)
    if (aid !== null) await saveActiveId(aid)
    setProviders(list)
    setActiveId(aid)
  }

  const setActive = async (id: string) => {
    await saveActiveId(id)
    setActiveId(id)
  }

  /** 配置变动后旧测试结论即失效，清掉避免误导 */
  const dropResult = (id: string) => {
    setRowResults(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const removeProvider = async (id: string) => {
    if (!await confirmDialog({ title: '删除模型配置', message: '确定删除该模型配置？', danger: true })) return
    const next = providers.filter(p => p.id !== id)
    const nextActive = activeId === id ? (next[0]?.id ?? null) : activeId
    await persist(next, nextActive)
    dropResult(id)
  }

  /** 由平台预设开始新增一条模型配置（未保存） */
  const startAddPreset = (p: PlatformPreset) => {
    setEditResult(null)
    setEditing(providerFromPreset(p))
    setPickMode('none')
  }

  const fetchModels = async (baseUrl: string) => {
    try {
      const models = await listOllamaModels(baseUrl)
      setOllamaModels(models)
      if (models.length === 0) {
        setEditResult(fail('Ollama 已连接，但本机还没有任何模型：请先执行 ollama pull <模型名> 拉取。'))
        return
      }
      setEditResult(null)
      if (editing && !editing.model) setEditing({ ...editing, model: models[0] })
    } catch (e) {
      setEditResult(fail(e instanceof Error ? e.message : String(e)))
    }
  }

  /** 编辑态：测试当前草稿配置（未保存也能测） */
  const runTest = async () => {
    if (!editing) return
    setTesting(true)
    setEditResult(null)
    setEditResult(await testProvider(editing))
    setTesting(false)
  }

  /** 列表态：测试某个已保存的模型配置 */
  const runRowTest = async (p: AIProvider) => {
    setTestingId(p.id)
    dropResult(p.id)
    const r = await testProvider(p)
    setRowResults(prev => ({ ...prev, [p.id]: r }))
    setTestingId(null)
  }

  const saveEdit = async () => {
    if (!editing) return
    if (!editing.name.trim()) { setEditResult(fail('请填写显示名称。')); return }
    if (!editing.model.trim()) { setEditResult(fail('请选择 / 填写模型名称。')); return }
    setSaving(true)
    const exists = providers.some(p => p.id === editing.id)
    const next = exists ? providers.map(p => p.id === editing.id ? editing : p) : [...providers, editing]
    const nextActive = activeId ?? (!exists ? editing.id : activeId)
    await persist(next, nextActive)
    dropResult(editing.id)
    setSaving(false)
    setEditing(null)
    setEditResult(null)
  }

  /** 编辑态（openai 类型）平台预设下拉：本地 / 联网各自只列本组 */
  const presetList =
    editing && editing.type === 'openai'
      ? editing.local
        ? [...LOCAL_OPENAI_PRESETS, { label: '自定义', baseUrl: '' }]
        : ONLINE_PRESETS
      : ONLINE_PRESETS

  return (
    <Modal open onClose={onClose} icon={<Settings2 size={15} />} title="模型设置" width="lg" maxHeight="85vh">

        {editing === null ? (
          <>
            {providers.length === 0 ? (
              <div className="text-[12px] text-ink-500 mb-3">还没有任何模型，先添加一个：</div>
            ) : (
              <p className="text-[11px] text-ink-500 mb-2.5 leading-relaxed">
                配置好模型后点该行「测试」，会真实发起一次最小对话来验证是否能正常调用。
                <span className="text-ink-600">本地大参数模型首次调用需加载进显存，可能等待数十秒，属正常现象。</span>
              </p>
            )}
            <div className="space-y-2 mb-4">
              {providers.map(p => (
                <div key={p.id} className="rounded-lg bg-ink-800 border border-ink-700">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${p.type === 'ollama' || p.local ? 'bg-emerald-500/15 text-emerald-400' : 'bg-sky-500/15 text-sky-400'}`}>
                      {typeLabel(p)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-ink-100 truncate">{p.name}</div>
                      <div className="text-[11px] text-ink-500 font-mono truncate">{p.model || '（未设置模型）'}</div>
                    </div>
                    {activeId === p.id ? (
                      <span className="shrink-0 flex items-center gap-1 text-[11px] text-emerald-400"><CheckCircle2 size={12} /> 当前</span>
                    ) : (
                      <button onClick={() => setActive(p.id)} className="shrink-0 text-[11px] px-2 py-1 rounded bg-ink-700 text-ink-200 hover:bg-ink-600">设为当前</button>
                    )}
                    <button
                      onClick={() => runRowTest(p)}
                      disabled={testingId !== null}
                      title={testingId !== null ? '有测试正在进行中，请稍候' : '发起一次最小对话，验证该模型能否正常调用'}
                      className="shrink-0 flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-ink-700 text-ink-200 hover:bg-ink-600 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {testingId === p.id ? <Loader2 size={11} className="animate-spin" /> : <FlaskConical size={11} />}
                      {testingId === p.id ? '测试中…' : '测试'}
                    </button>
                    <button onClick={() => { setEditResult(null); setEditing(p) }} title="编辑" className="shrink-0 p-1 text-ink-500 hover:text-amber"><Pencil size={12} /></button>
                    <button onClick={() => removeProvider(p.id)} title="删除" className="shrink-0 p-1 text-ink-500 hover:text-red-400"><Trash2 size={12} /></button>
                  </div>
                  {testingId === p.id && (
                    <div className="px-3 pb-2 text-[11px] text-ink-400 flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin text-amber" /> 正在调用「{p.model}」，本地大模型可能需要数十秒…
                    </div>
                  )}
                  {testingId !== p.id && rowResults[p.id] && (
                    <div className="px-3 pb-2"><TestResultBar r={rowResults[p.id]} /></div>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={() => setPickMode('local')} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 rounded-lg text-[12px] hover:bg-emerald-500/20 transition-colors" title="Ollama 与本地 OpenAI 兼容服务（LM Studio / LocalAI 等），运行在本机，一般免密钥、无需联网">
                <Cpu size={13} /> 添加本地模型
              </button>
              <button onClick={() => setPickMode('online')} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-sky-500/10 text-sky-300 border border-sky-500/25 rounded-lg text-[12px] hover:bg-sky-500/20 transition-colors" title="联网平台（硅基流动 / DeepSeek / 通义 / 智谱 等），需填 API 密钥">
                <Globe size={13} /> 添加联网模型
              </button>
            </div>
            {pickMode !== 'none' && (
              <div className="rounded-lg border border-ink-700 bg-ink-800/40 p-3">
                <div className="flex items-center gap-2 mb-2.5">
                  <span className="text-[12px] font-medium text-ink-200">
                    {pickMode === 'local' ? '选择本地平台' : '选择联网平台'}
                  </span>
                  <button onClick={() => setPickMode('none')} className="ml-auto text-[11px] text-ink-400 hover:text-ink-100">返回</button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(pickMode === 'local' ? LOCAL_PRESETS : ONLINE_PRESETS).map(p => (
                    <button
                      key={p.label}
                      onClick={() => startAddPreset(p)}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-800 border border-ink-700 text-[12px] text-ink-200 hover:text-emerald-300 hover:border-emerald-400/40 transition-colors text-left"
                    >
                      {pickMode === 'local'
                        ? <Cpu size={12} className="text-emerald-400 shrink-0" />
                        : <Globe size={12} className="text-sky-400 shrink-0" />}
                      <span className="truncate">{p.label}</span>
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-ink-500 mt-2 leading-relaxed">
                  {pickMode === 'local'
                    ? '本地平台运行在本机 / 局域网，一般免密钥、无需联网；Ollama 需先「ollama pull」拉取模型。'
                    : '联网平台需要 API 密钥，按预设填好接口地址后填入密钥与模型名即可。'}
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[12px]">
              {editing.type === 'ollama' ? (
                <span className="flex items-center gap-1 text-emerald-400"><Cpu size={13} /> 本地 Ollama</span>
              ) : editing.local ? (
                <span className="flex items-center gap-1 text-emerald-400"><Cpu size={13} /> 本地 OpenAI 兼容</span>
              ) : (
                <span className="flex items-center gap-1 text-sky-400"><Globe size={13} /> 联网 OpenAI 兼容</span>
              )}
            </div>

            <div>
              <label className="block text-[11px] text-ink-500 mb-1">显示名称</label>
              <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="如：本地 llama3 / DeepSeek" />
            </div>

            <div>
              <label className="block text-[11px] text-ink-500 mb-1">自定义系统提示词（可选）</label>
              <textarea
                className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600 resize-none"
                rows={3}
                value={editing.systemPrompt ?? ''}
                onChange={e => setEditing({ ...editing, systemPrompt: e.target.value })}
                placeholder="对所有调用此模型的功能追加一段总体指令（如写作风格、人称、禁忌）。留空则按系统预设。"
              />
              <p className="text-[10px] text-ink-500 mt-1 leading-relaxed">只附加在各功能自带的系统提示词之后，不会影响校对 / 补全 / 整理 / 对话的原有指令与格式约束。</p>
            </div>

            {editing.type === 'ollama' ? (
              <>
                <div>
                  <label className="block text-[11px] text-ink-500 mb-1">Ollama 地址</label>
                  <div className="flex gap-2">
                    <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="http://localhost:11434" />
                    <button onClick={() => fetchModels(editing.baseUrl)} className="shrink-0 flex items-center gap-1 px-3 py-1.5 bg-ink-700 text-ink-200 border border-ink-600 rounded-lg text-[12px] hover:bg-ink-600">获取本地模型</button>
                  </div>
                </div>
                {ollamaModels.length > 0 && (
                  <div>
                    <label className="block text-[11px] text-ink-500 mb-1">选择模型</label>
                    <select className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40" value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })}>
                      <option value="">— 请选择 —</option>
                      {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-[11px] text-ink-500 mb-1">或手动填写模型名</label>
                  <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })} placeholder="需本机已 ollama pull" />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="block text-[11px] text-ink-500 mb-1">平台预设</label>
                  <select
                    className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40"
                    value={presetList.find(p => p.baseUrl === editing.baseUrl)?.label ?? '自定义'}
                    onChange={e => {
                      const pre = presetList.find(p => p.label === e.target.value)
                      if (pre && pre.baseUrl !== '') setEditing({ ...editing, baseUrl: pre.baseUrl, local: !!pre.local, name: editing.name || pre.label })
                      else if (pre && pre.baseUrl === '') setEditing({ ...editing, baseUrl: '', local: editing.local, name: editing.name })
                    }}
                  >
                    {presetList.map(p => <option key={p.label} value={p.label}>{p.label}</option>)}
                  </select>
                  <p className="text-[10px] text-ink-500 mt-1">本地平台（LM Studio / LocalAI 等）一般免密钥、无需联网；联网平台需填写 API 密钥。选「自定义」可手填接口地址。</p>
                </div>
                <div>
                  <label className="block text-[11px] text-ink-500 mb-1">API 接口地址（baseUrl）</label>
                  <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.baseUrl} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
                </div>
                <div>
                  <label className="block text-[11px] text-ink-500 mb-1">API 密钥</label>
                  <input type="password" className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40 font-mono placeholder:text-ink-600" value={editing.apiKey} onChange={e => setEditing({ ...editing, apiKey: e.target.value })} placeholder="仅本地保存，不上传" />
                </div>
                <div>
                  <label className="block text-[11px] text-ink-500 mb-1">模型名称</label>
                  <input className="w-full bg-ink-800 border border-ink-700 rounded-lg text-ink-100 text-[12px] px-3 py-1.5 outline-none focus:border-amber/40 placeholder:text-ink-600" value={editing.model} onChange={e => setEditing({ ...editing, model: e.target.value })} placeholder="如 deepseek-chat / qwen-plus / glm-4-flash" />
                </div>
              </>
            )}

            {testing && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] bg-ink-800 border border-ink-700 text-ink-300">
                <Loader2 size={13} className="animate-spin text-amber shrink-0" />
                正在测试「{editing.model || '未设置模型'}」…本地大模型首次调用需加载进显存，请稍候。
              </div>
            )}
            {!testing && editResult && <TestResultBar r={editResult} />}

            <div className="flex items-center gap-2 pt-1">
              <Button onClick={saveEdit} disabled={saving || testing} variant="primary" size="md" className="flex items-center text-[12px]">
                <Check size={12} /> 保存
              </Button>
              <Button onClick={runTest}
                disabled={testing}
                title="不必先保存，直接用当前填写的配置发起一次最小对话" variant="secondary" size="md" className="flex items-center text-[12px]">
                {testing ? <Loader2 size={12} className="animate-spin" /> : <FlaskConical size={12} />}
                {testing ? '测试中…' : '测试此配置'}
              </Button>
              <button onClick={() => { setEditing(null); setEditResult(null); setPickMode('none') }} className="ml-auto px-3 py-2 bg-ink-700 text-ink-300 border border-ink-600 rounded-lg text-[12px] hover:text-ink-100">取消</button>
            </div>
          </div>
        )}
    </Modal>
  )
}
