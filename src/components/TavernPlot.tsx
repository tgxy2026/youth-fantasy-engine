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
import * as db from '../lib/db'
import { loadProviders, type AIProvider } from '../lib/ai'
import { showToast, confirmDialog } from './dialogs'
import { Button } from './Button'
import TavernPlotSetup, { type TavernDraft } from './TavernPlotSetup'
import TavernCastSetting from './TavernCastSetting'
import { renderTavernMessage } from './TavernMessage'
import AutoTextarea from './AutoTextarea'
import * as store from '../lib/tavern/store'
import { runPlotTurn, splitCast } from '../lib/tavern/engine'
import { generateReport } from '../lib/tavern/report'
import { buildOpeningMessage } from '../lib/tavern/prompt'
import { uid } from '../lib/id'
import { MEMORY_SOFT_LIMIT, hasCastSetting } from '../lib/tavern/types'
import type { TavernSession, TavernSessionIndexItem, TavernMessage } from '../lib/tavern/types'


export default function TavernPlot() {
  const [list, setList] = useState<TavernSessionIndexItem[]>([])
  const [activeId, setActiveId] = useState('')
  const [session, setSession] = useState<TavernSession | null>(null)
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [setupOpen, setSetupOpen] = useState(false)
  const [showInfo, setShowInfo] = useState(true)

  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [phase, setPhase] = useState('')
  const [busyReport, setBusyReport] = useState(false)
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

  const send = async () => {
    if (!session || !input.trim() || streaming) return
    const text = input.trim()
    setInput('')
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

  const usedChars = session ? JSON.stringify(session.messages).length + (session.memory?.length ?? 0) : 0
  const budget = session?.params.contextBudget ?? 8000

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      {/* ---------- 顶部工具条 ---------- */}
      <header className="flex flex-wrap items-center gap-2 border-b border-ink-800 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">剧情推演</h1>
        <select
          className="bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-[12px] text-ink-100 outline-none focus:border-amber/50 min-w-[14rem]"
          value={activeId}
          onChange={e => setActiveId(e.target.value)}
        >
          <option value="">— 选择一场推演 —</option>
          {list.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <Button variant="primary" size="md" onClick={() => setSetupOpen(true)}>新建推演</Button>

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
            <Button variant="secondary" size="md" onClick={() => setShowInfo(v => !v)}>
              {showInfo ? '收起本场信息' : '本场信息'}
            </Button>
            <Button variant="danger" size="md" disabled={busyReport || streaming} onClick={finish}>
              {busyReport ? '生成报告中…' : '结束推演'}
            </Button>
          </>
        )}
      </header>

      {/* ---------- 主体三栏 ---------- */}
      {!session ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-[13px] text-ink-300">还没有选择推演</p>
            <p className="mt-2 text-[12px] text-ink-500 leading-relaxed">
              {list.length === 0
                ? '先「新建推演」：选一个叙事锚点、分配角色（你演谁 / AI 演谁），就能开演。'
                : '从上方下拉里选一场继续，或新建一场。'}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 gap-3 pt-3">
          {/* 左栏：本场信息 */}
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
                  {casts.ai.map(c => (
                    <li key={c.cardId} className="flex items-center gap-1.5">
                      <span className="flex-1 min-w-0 truncate text-[12px] text-ink-200">AI 演 · {c.name}</span>
                      <button
                        type="button"
                        onClick={() => setCastEdit({ cardId: c.cardId, name: c.name, kind: 'ai' })}
                        className={`shrink-0 text-[11px] hover:text-amber ${castFilled[c.cardId] ? 'text-amber/80' : 'text-ink-500'}`}
                        title="扮演设定：口吻 / 称呼 / 知识边界 / 底线…">
                        {castFilled[c.cardId] ? '已设定' : '设定'}
                      </button>
                    </li>
                  ))}
                  {casts.silent.map(c => <li key={c.cardId} className="text-[12px] text-ink-500">在场 · {c.name}</li>)}
                </ul>
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
              <Button variant="ghost" size="md" className="w-full text-[12px]" onClick={removeSession}>删除这场推演</Button>
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
                    {renderTavernMessage(m.content)}
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
              <AutoTextarea
                className="bg-ink-900 border border-ink-700 rounded-md px-3 py-2 text-ink-100 outline-none focus:border-amber/50"
                textClass="text-[13px]"
                minRows={3}
                maxHeight={200}
                placeholder="以你的角色身份说一句话、做一个动作…（Ctrl+Enter 发送）"
                value={input}
                disabled={streaming}
                onChange={setInput}
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send() } }}
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-ink-500">
                  上下文占用约 {usedChars} / {budget} 字
                  {session.memory ? ` · 记忆 ${session.memory.length}/${MEMORY_SOFT_LIMIT} 字` : ''}
                </span>
                <div className="flex gap-2">
                  {streaming
                    ? <Button variant="secondary" size="md" onClick={stop}>停止</Button>
                    : <Button variant="primary" size="md" disabled={!input.trim()} onClick={send}>发送</Button>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <TavernPlotSetup open={setupOpen} onCreate={createFromDraft} onCancel={() => setSetupOpen(false)} />

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
