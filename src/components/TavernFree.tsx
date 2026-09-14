/**
 * 酒馆模式 · 自由对话（tavern-free）
 *
 * 定位：**陪伴**。自建角色卡的长期对话 —— 记得住事、有时间流逝感、换场景可开新会话
 * （记忆按角色共享，不随会话走）。
 *
 * 【无服务端带来的三个 UI 义务（方案 §11 明确要求，不能吞掉）】
 *   1. 总结「不即时」—— 只能回复后判阈值、或下次打开补算。界面必须显示
 *      「记忆更新于 X」，让作者知道记忆的时效边界。
 *   2. 会话超长后早期原文会从上下文消失 —— 原文仍在记录里可翻回，
 *      但预算条要显示占用，别让作者以为模型还记得。
 *   3. 记忆是**角色级**的：换会话不会重来，所以新建会话时要说清这一点。
 *
 * 阶段：P2 范围（单角色对话 + 六栏记忆 + 总结触发）。
 * 多角色同场与发言调度（§7.3）、日常状态时间差推进（§7.4）、角色主动留言（§7.5）
 * 属 P3 —— 引擎层已就绪，界面留待 P3 接。
 *
 * 遵守项目约定：弹窗用共享 Modal，按钮用 Button，禁 window.confirm（用 confirmDialog），
 * 提示用 showToast。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadProviders, type AIProvider } from '../lib/ai'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import { LoadingState } from './LoadingState'
import { renderTavernMessage } from './TavernMessage'
import * as store from '../lib/tavern/store'
import { runFreeTurn } from '../lib/tavern/engine'
import { summarizeMemory } from '../lib/tavern/summarize'
import {
  memoryChars, messagesAfterWatermark, nextWatermark, acquireSummaryLock, releaseSummaryLock,
  shouldRunAutoSummary, MEMORY_SECTIONS, isMemoryEmpty,
} from '../lib/tavern/memory'
import {
  MEMORY_SOFT_LIMIT, type FreeCharacter, type FreeMemory, type FreeSession,
  type FreeSessionIndexItem, type TavernCharIndexItem,
} from '../lib/tavern/types'

/** 把时间戳显示成「刚刚 / X 分钟前 / X 小时前 / 日期」 */
function ago(ts: number): string {
  if (!ts) return '还没有记忆'
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

export default function TavernFree() {
  // ---------- 数据 ----------
  const [chars, setChars] = useState<TavernCharIndexItem[]>([])
  const [charId, setCharId] = useState('')
  const [charCard, setCharCard] = useState<FreeCharacter | null>(null)
  const [sessions, setSessions] = useState<FreeSessionIndexItem[]>([])
  const [session, setSession] = useState<FreeSession | null>(null)
  const [memory, setMemory] = useState<FreeMemory | null>(null)
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [summaryProviderId, setSummaryProviderId] = useState('')

  // ---------- UI ----------
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [phase, setPhase] = useState('')
  const [summarizing, setSummarizing] = useState(false)
  const [showMemory, setShowMemory] = useState(true)
  const [showSettings, setShowSettings] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // ---------- 加载 ----------
  useEffect(() => {
    void (async () => {
      try {
        const [cs, ps, sid] = await Promise.all([
          store.listFreeChars(),
          loadProviders().catch(() => [] as AIProvider[]),
          store.getSummaryProviderId().catch(() => ''),
        ])
        setChars(cs)
        setProviders(ps)
        setSummaryProviderId(sid)
        if (cs.length > 0) setCharId(prev => prev || cs[0].id)
      } catch (e) {
        showToast(`读取失败：${e instanceof Error ? e.message : String(e)}`, 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  // 选中的角色 → 读完整卡 + 该角色的会话 + 它的记忆
  const loadForChar = useCallback(async (id: string) => {
    if (!id) return
    try {
      const [card, all, mem] = await Promise.all([
        store.getFreeChar(id),
        store.listFreeSessions(),
        store.getMemory(id).catch(() => null),
      ])
      setCharCard(card)
      setSessions(all.filter(s => s.charIds.includes(id)))
      setMemory(mem)
    } catch (e) {
      showToast(`读取角色失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [])

  useEffect(() => {
    void loadForChar(charId)
    setSession(null)
    setStreamText('')
  }, [charId, loadForChar])

  const openSession = useCallback(async (id: string) => {
    const s = await store.getFreeSession(id)
    setSession(s)
    setStreamText('')
    if (!s) return
    // 打开即补算（方案 §4.6 ②：下次打开应用时扫描水位线补算 —— 这里在打开会话时做）
    void autoSummarize(s)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charCard])

  const createSession = useCallback(async () => {
    if (!charCard) return
    // 模型：跟随全局活动模型（会话级可再改）
    const active = providers.find(p => p.id === (session?.model.providerId ?? '')) ?? providers[0]
    try {
      const s = await store.createFreeSession(
        [charCard.id],
        `和${charCard.name}的对话`,
        { providerId: active?.id ?? '' },
        {},
      )
      setSession(s)
      await loadForChar(charCard.id)
      showToast('已新建会话（记忆按角色共享，换会话不会重来）')
    } catch (e) {
      showToast(`新建失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }, [charCard, providers, session, loadForChar])

  // ---------- 记忆总结 ----------
  /**
   * 跑一次总结。manual = 手动点「立即总结」（不受时间节流限制 —— 作者点了就该跑）。
   * 自动路径要过三道闸：新消息够不够 → 时间节流 → 跨实例锁。
   */
  const runSummary = useCallback(async (s: FreeSession, manual = false) => {
    if (!charCard) return
    const prev = await store.getMemory(charCard.id).catch(() => null)
    if (!manual) {
      const verdict = shouldRunAutoSummary(s, prev)
      if (!verdict.run) return
    }
    const pending = messagesAfterWatermark(s.messages, s.watermark)
    if (pending.length === 0) {
      if (manual) showToast('还没有新内容可整理', 'info')
      return
    }
    if (!acquireSummaryLock()) {
      if (manual) showToast('另一个窗口正在整理记忆', 'info')
      return
    }
    setSummarizing(true)
    try {
      const next = await summarizeMemory({
        charId: charCard.id,
        charName: charCard.name,
        prev,
        messages: pending,
        providerId: summaryProviderId || undefined,
      })
      await store.saveMemory(next)
      // 水位线推进到最后一条 —— 关机/失败都不丢不重
      const wm = nextWatermark(s)
      const updated: FreeSession = { ...s, watermark: wm ?? s.watermark, updatedAt: Date.now() }
      await store.saveFreeSession(updated)
      setSession(cur => (cur && cur.id === updated.id ? updated : cur))
      setMemory(next)
      if (manual) showToast(`记忆已更新（${memoryChars(next)} 字）`)
    } catch (e) {
      // 失败保留旧档案，绝不写半截结果
      if (manual) showToast(`总结失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      releaseSummaryLock()
      setSummarizing(false)
    }
  }, [charCard, summaryProviderId])

  /** 自动总结：静默，失败也不打扰（下次打开会补算） */
  const autoSummarize = useCallback(async (s: FreeSession) => {
    try { await runSummary(s, false) } catch { /* 静默 */ }
  }, [runSummary])

  // ---------- 对话 ----------
  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || !session || !charCard || streaming) return
    setInput('')
    setStreaming(true)
    setStreamText('')
    setPhase('')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await runFreeTurn(session, [charCard], text, {
        onToken: d => setStreamText(prev => prev + d),
        onPhase: p => setPhase(p),
        signal: ctrl.signal,
      })
      const saved = await store.saveFreeSession(res.session)
      setSession(saved)
      setStreamText('')
      await loadForChar(charCard.id)
      if (!res.cancelled) void autoSummarize(saved)
      if (res.fellBack) showToast('该会话指定的模型不可用，已回退到全局活动模型', 'info')
    } catch (e) {
      showToast(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setStreaming(false)
      setPhase('')
      abortRef.current = null
    }
  }, [input, session, charCard, streaming, loadForChar, autoSummarize])

  const stop = () => { abortRef.current?.abort() }

  const removeSession = async () => {
    if (!session) return
    const okGo = await confirmDialog({
      title: '删除这个会话？',
      message: '对话记录会一并删除。\n注意：**她的记忆是按角色存的**，所以记忆不会跟着消失。',
      confirmText: '删除',
      danger: true,
    })
    if (!okGo) return
    await store.deleteFreeSession(session.id)
    setSession(null)
    if (charCard) await loadForChar(charCard.id)
    showToast('已删除会话')
  }

  const changeModel = async (providerId: string) => {
    if (!session) return
    const next = { ...session, model: { providerId }, updatedAt: Date.now() }
    await store.saveFreeSession(next)
    setSession(next)
    showToast('已切换本会话的模型')
  }

  const changeSummaryModel = async (id: string) => {
    setSummaryProviderId(id)
    await store.setSummaryProviderId(id)
    showToast(id ? '已指定总结模型' : '总结将跟随全局活动模型')
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

  const memChars = memory ? memoryChars(memory) : 0

  // ---------- 渲染 ----------
  if (loading) return <div className="page-enter"><LoadingState /></div>

  return (
    <div className="page-enter flex flex-col h-full">
      <header className="mb-3 shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-ink-50">自由对话</h1>
            <p className="text-[12px] text-ink-400 mt-1">
              与自建角色的长期对话：记得住事、有时间流逝感、换场景可开新会话（记忆按角色共享）。
            </p>
          </div>
          {chars.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setShowSettings(v => !v)}>
              {showSettings ? '收起设置' : '模型设置'}
            </Button>
          )}
        </div>

        {showSettings && (
          <div className="mt-2 rounded-lg border border-ink-700 bg-ink-850/50 p-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-500">本会话模型</span>
              <select
                className="mt-1 w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-[12px] text-ink-100 outline-none"
                value={session?.model.providerId ?? ''}
                onChange={e => void changeModel(e.target.value)}
                disabled={!session}
              >
                <option value="">（未选择）</option>
                {providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[11px] text-ink-500">总结模型（整理记忆用，越快越省越好）</span>
              <select
                className="mt-1 w-full bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-[12px] text-ink-100 outline-none"
                value={summaryProviderId}
                onChange={e => void changeSummaryModel(e.target.value)}
              >
                <option value="">跟随全局活动模型</option>
                {providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
              </select>
            </label>
          </div>
        )}
      </header>

      {chars.length === 0 ? (
        <div className="rounded-lg border border-ink-700 bg-ink-850/60 px-6 py-12 text-center">
          <p className="text-[13px] text-ink-300">还没有角色可聊</p>
          <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
            先去「角色卡片」建一张卡 —— 填好第 4 章「示例对话」，她会立刻像那个人。
            <br />
            （从小说角色一键导入属 P3，还没开放）
          </p>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 gap-3">
          {/* 左栏 */}
          <aside className="w-52 shrink-0 flex flex-col gap-3 min-h-0">
            <div>
              <div className="text-[11px] text-ink-500 mb-1">角色</div>
              <ul className="space-y-1">
                {chars.map(c => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setCharId(c.id)}
                      className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                        charId === c.id ? 'bg-amber/15 border border-amber/30' : 'border border-transparent hover:bg-ink-800/60'
                      }`}
                    >
                      <span className="w-6 h-6 shrink-0 rounded-full bg-ink-700 text-ink-200 text-[11px] flex items-center justify-center">
                        {c.name.trim().slice(0, 1) || '?'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100">{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-ink-500">会话</span>
                <button type="button" className="text-[11px] text-amber hover:underline" onClick={createSession}>新建</button>
              </div>
              {sessions.length === 0 ? (
                <p className="text-[11px] text-ink-600 leading-relaxed px-1">还没有会话，点「新建」开一场。</p>
              ) : (
                <ul className="space-y-1">
                  {sessions.map(s => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => void openSession(s.id)}
                        className={`w-full text-left rounded-md px-2 py-1.5 ${
                          session?.id === s.id ? 'bg-amber/15 border border-amber/30' : 'border border-transparent hover:bg-ink-800/60'
                        }`}
                      >
                        <div className="truncate text-[12px] text-ink-100">{s.title}</div>
                        <div className="text-[10.5px] text-ink-600">{ago(s.lastActiveAt)}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>

          {/* 中栏：对话 */}
          {!session ? (
            <div className="flex-1 flex items-center justify-center rounded-lg border border-ink-800">
              <div className="text-center">
                <p className="text-[13px] text-ink-300">选一个会话，或新建一场</p>
                <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
                  {charCard?.examples?.trim()
                    ? `「${charCard.name}」已经填了示例对话，开口就会像那个人。`
                    : `「${charCard?.name ?? ''}」还没填第 4 章「示例对话」—— 补上会明显更像。`}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 min-w-0 flex-col rounded-lg border border-ink-800 overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-ink-800 bg-ink-850/40">
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] text-ink-100">{session.title}</div>
                  <div className="text-[10.5px] text-ink-500">
                    {charCard?.name} · 记忆更新于 {ago(memory?.updatedAt ?? 0)}
                    {summarizing && <span className="text-amber ml-2">正在整理记忆…</span>}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => setShowMemory(v => !v)}>
                    {showMemory ? '隐藏记忆' : '查看记忆'}
                  </Button>
                  <Button variant="danger" size="sm" onClick={removeSession}>删除</Button>
                </div>
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                {session.messages.length === 0 && (
                  <div className="text-center text-[12px] text-ink-500 py-10">
                    还没有对话。在下面说第一句话，她就会应你。
                  </div>
                )}
                {session.messages.map(m => (
                  <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
                    <div className={m.role === 'user'
                      ? 'max-w-[80%] rounded-lg bg-amber/12 border border-amber/25 px-3 py-2'
                      : 'max-w-[85%] space-y-1'}>
                      {renderTavernMessage(m.content)}
                    </div>
                  </div>
                ))}
                {streaming && (
                  <div className="max-w-[85%] space-y-1">
                    {streamText ? renderTavernMessage(streamText) : (
                      <div className="text-[12px] text-ink-500">{phase || '正在想…'}</div>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t border-ink-800 p-3">
                <textarea
                  className="w-full h-20 resize-none bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-[13px] text-ink-100 outline-none focus:border-amber/50"
                  placeholder="说点什么…（Ctrl+Enter 发送）"
                  value={input}
                  disabled={streaming}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-ink-500">
                    本会话 {usedChars} 字
                    {memChars > 0 && ` · 记忆 ${memChars}/${MEMORY_SOFT_LIMIT} 字`}
                  </span>
                  <div className="flex gap-2">
                    {streaming
                      ? <Button variant="secondary" size="md" onClick={stop}>停止</Button>
                      : <Button variant="primary" size="md" disabled={!input.trim()} onClick={send}>发送</Button>}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 右栏：记忆 */}
          {session && showMemory && (
            <aside className="w-64 shrink-0 flex flex-col rounded-lg border border-ink-800 bg-ink-850/40 min-h-0">
              <div className="px-3 py-2 border-b border-ink-800">
                <div className="text-[12px] text-ink-100">她的记忆</div>
                <div className="text-[10.5px] text-ink-500">
                  更新于 {ago(memory?.updatedAt ?? 0)} · {memChars} 字
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-3">
                {isMemoryEmpty(memory) ? (
                  <p className="text-[11.5px] text-ink-500 leading-relaxed">
                    还没有记忆。
                    <br />
                    聊满 6 条消息后会自动整理一次 —— 但她只会在
                    <span className="text-ink-400">下次打开时</span>才用上（没有常驻进程，总结不是即时的）。
                  </p>
                ) : (
                  MEMORY_SECTIONS.map(sec => {
                    const body = String(memory?.[sec.key] ?? '').trim()
                    if (!body) return null
                    return (
                      <div key={sec.key}>
                        <div className="text-[11px] text-amber/80">{sec.title}</div>
                        <div className="mt-0.5 text-[11.5px] text-ink-300 whitespace-pre-wrap leading-relaxed">{body}</div>
                      </div>
                    )
                  })
                )}
              </div>
              <div className="p-2 border-t border-ink-800">
                <Button
                  variant="secondary" size="sm" className="w-full"
                  disabled={!session || summarizing}
                  onClick={() => void runSummary(session, true)}
                >
                  {summarizing ? '整理中…' : '立即整理记忆'}
                </Button>
                <p className="mt-1.5 text-[10.5px] text-ink-600 leading-relaxed">
                  没开应用时她「过了几天」也不会自动发生 —— 这是三端共用一套前端代码的代价，不藏着。
                </p>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  )
}
