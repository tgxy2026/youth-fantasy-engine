/**
 * 跑团（3.0 · W4-3e · 第 4 批）
 *
 * 「跑团」的界面：AI 当 **KP（守秘人）**主持一次有始有终的互动 ——
 * 玩家行动 → 系统掷检定 → KP 照结果演 → 落线索 / 揭秘密 / 判结局。
 *
 * 【与另外两种互动的位置关系】
 *   · 剧情推演 —— 试演一场戏，看角色反应是否**合理**；
 *   · 自由对话 —— 与自建角色的**长期陪伴**；
 *   · 跑团 —— 一次**可玩、可分叉、可复盘**的冒险。
 * 三者共用酒馆的会话底盘（消息 / 记忆 / 存档），跑团额外长着「检定 / 线索 / 同伴 / 秘密 / 结局」。
 *
 * 🔴 遵守项目约定：弹窗用共享 `Modal`、按钮用 `Button`、禁 `window.prompt/confirm`（用 `confirmDialog`）、
 *    提示用 `showToast`；重命名走**行内编辑**。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Plus, Trash2 } from 'lucide-react'
import * as db from '@/lib/db'
import {
  listRuns, getRun, saveRun, deleteRun, renameRun, newRun, addRunCheckpoint,
  dropRunCheckpoint, rollbackRunToCheckpoint, undoRunRollback,
  type RunSessionWithUndo,
} from '@/lib/run/store'
import { addCompanion, dropCompanion, clueStats, pendingClues } from '@/lib/run/clues'
import { evalEndings, lockedSecrets } from '@/lib/run/endings'
import { runKpTurn, type KpCheck } from '@/lib/run/turn'
import { uid } from '@/lib/app/id'
import type { RunIndexItem, RunSession } from '@/lib/run/runTypes'
import type { WorldStoredRecord } from '@/lib/world/worldTypes'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import HelpPopover from '@/components/common/HelpPopover'
import AIDataSourceNote from '@/components/ai/AIDataSourceNote'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function fmt(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const tierCls = (t: string) =>
  t === '达成' ? 'text-success' : t === '接近' ? 'text-amber' : 'text-ink-500'

export default function RunPanel() {
  const [list, setList] = useState<RunIndexItem[] | null>(null)
  const [selId, setSelId] = useState('')
  const [session, setSession] = useState<RunSessionWithUndo | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState('')
  const [worlds, setWorlds] = useState<WorldStoredRecord[]>([])
  /** 新建局选的世界引用（"worldId::version"，空 = 不引用） */
  const [worldPick, setWorldPick] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null)
  const [actionText, setActionText] = useState('')
  const [lastCheck, setLastCheck] = useState<KpCheck | null>(null)
  const [comp, setComp] = useState({ name: '', stance: '', knows: '', canHelp: true })

  const load = useCallback(async () => {
    try {
      setList(await listRuns())
      setWorlds(await db.listWorlds())
    } catch (e) { showToast('读取跑团互动列表失败：' + errText(e)) }
  }, [])

  useEffect(() => { void load() }, [load])

  // 选中局变化时载入详情
  useEffect(() => {
    let cancelled = false
    if (!selId) { setSession(null); return }
    void (async () => {
      try {
        const s = await getRun(selId)
        if (!cancelled) { setSession(s as RunSessionWithUndo | null); setLastCheck(null) }
      } catch (e) { if (!cancelled) showToast('载入这一局失败：' + errText(e)) }
    })()
    return () => { cancelled = true }
  }, [selId])

  const worldOptions = useMemo(() => {
    const out: { value: string; label: string }[] = []
    for (const w of worlds) {
      if (w.versions.length) for (const v of w.versions) out.push({ value: `${w.id}::${v.v}`, label: `${w.name} v${v.v}` })
      else out.push({ value: `${w.id}::0`, label: `${w.name}（草稿）` })
    }
    return out
  }, [worlds])

  const persist = useCallback(async (next: RunSessionWithUndo) => {
    const saved = await saveRun(next) as RunSessionWithUndo
    setSession({ ...next, updatedAt: saved.updatedAt })
    setList(await listRuns())
    return saved
  }, [])

  const doCreate = useCallback(async () => {
    setBusy(true)
    try {
      let ref: RunSession['worldRef']
      if (worldPick) {
        const [wid, v] = worldPick.split('::')
        const w = worlds.find(x => x.id === wid)
        ref = { worldId: wid, version: Number(v) || 0, worldName: w?.name }
      }
      const s = newRun(creating || '未命名跑团', { providerId: '' })
      if (ref) s.worldRef = ref
      const saved = await saveRun(s)
      setCreating(''); setWorldPick('')
      await load()
      setSelId(saved.id)
      showToast('已新建一局')
    } catch (e) { showToast('新建失败：' + errText(e)) } finally { setBusy(false) }
  }, [creating, worldPick, worlds, load])

  const doDelete = useCallback(async (id: string, title: string) => {
    const okd = await confirmDialog({ title: '删除这一局？', message: `「${title}」连同它的线索、同伴、存档都会被删除，不可恢复。`, danger: true, confirmText: '删除' })
    if (!okd) return
    try { await deleteRun(id); if (selId === id) setSelId(''); await load(); showToast('已删除') }
    catch (e) { showToast('删除失败：' + errText(e)) }
  }, [selId, load])

  const doAction = useCallback(async () => {
    if (!session || !actionText.trim() || busy) return
    setBusy(true)
    try {
      const r = await runKpTurn(session, actionText.trim())
      setLastCheck(r.check)
      setActionText('')
      await persist(r.session)
      if (r.cancelled) showToast('已取消')
    } catch (e) {
      showToast('这一轮没跑通：' + errText(e))
    } finally { setBusy(false) }
  }, [session, actionText, busy, persist])

  const doCheckpoint = useCallback(async () => {
    if (!session) return
    try { await persist(addRunCheckpoint(session, `第 ${(session.checkpoints ?? []).length + 1} 档`)); showToast('已存档') }
    catch (e) { showToast('存档失败：' + errText(e)) }
  }, [session, persist])

  const doRollback = useCallback(async (cpId: string) => {
    if (!session) return
    const okd = await confirmDialog({ title: '回到这个存档？', message: '当前进度会先留一份，之后可用「撤销回滚」找回。', confirmText: '回滚' })
    if (!okd) return
    const next = rollbackRunToCheckpoint(session, cpId)
    if (!next) { showToast('存档不存在'); return }
    try { await persist(next); showToast('已回到该存档') }
    catch (e) { showToast('回滚失败：' + errText(e)) }
  }, [session, persist])

  const doDropCheckpoint = useCallback(async (cpId: string) => {
    if (!session) return
    try { await persist(dropRunCheckpoint(session, cpId)) }
    catch (e) { showToast('删除存档失败：' + errText(e)) }
  }, [session, persist])

  const doUndo = useCallback(async () => {
    if (!session) return
    try { await persist(undoRunRollback(session)); showToast('已撤销上次回滚') }
    catch (e) { showToast('撤销失败：' + errText(e)) }
  }, [session, persist])

  const doAddCompanion = useCallback(async () => {
    if (!session || !comp.name.trim()) return
    const next = addCompanion(session, {
      charId: uid(), name: comp.name, stance: comp.stance,
      knows: comp.knows.split(/[、,，\s]+/).filter(Boolean), canHelp: comp.canHelp,
    })
    setComp({ name: '', stance: '', knows: '', canHelp: true })
    try { await persist(next) } catch (e) { showToast('添加同伴失败：' + errText(e)) }
  }, [session, comp, persist])

  const ends = session ? evalEndings(session) : []
  const stats = session ? clueStats(session) : { acquired: 0, total: 0 }

  return (
    <div className="page-enter flex h-full flex-col overflow-hidden">
      <header className="shrink-0 flex flex-wrap items-center gap-2 border-b border-ink-700 pb-3">
        <h1 className="text-lg font-bold text-ink-50 mr-1">跑团互动</h1>
        <HelpPopover title="跑团互动怎么用" width="26rem" size={14}>
          AI 在这里当 <b>KP（守秘人）</b>主持一次有始有终的冒险 —— 不是陪聊，而是**裁决与推进**。
          {'\n\n'}· 在下方「你的行动」里写你要做什么（观察 / 交谈 / 取证…），也可以只写「我想撬开抽屉」。
          {'\n\n'}· 🔴 **成败由系统掷定**：系统先按行动难度掷一次检定，把「大成功 / 成功 / 擦边 / 失败」写进提示词，
          KP 必须照这个结果演 —— 失败不会写成成功，擦边一定带代价。这样同一句话的结果才**可复现**。
          {'\n\n'}· 线索会进**线索板**；满足条件的**秘密**会自动揭晓；**结局**按条件达成，每一行都写着「还差什么」。
          {'\n\n'}· 每局可以**存档**：打一档、随时回滚（回滚本身也能撤销）。
          <AIDataSourceNote feature="tavern-run" />
        </HelpPopover>
        <span className="text-11 text-ink-500">AI 当 KP · 检定 · 线索 · 同伴 · 秘密与结局</span>

        <div className="ml-auto flex items-center gap-2">
          {worldOptions.length > 0 && (
            <select
              className="h-9 bg-ink-900 border border-ink-700 rounded-lg px-2 text-13 text-ink-100 outline-none focus:border-amber/50"
              value={worldPick}
              onChange={e => setWorldPick(e.target.value)}
              title="引用一份冻结的世界版本（可选）">
              <option value="">不引用世界</option>
              {worldOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          <input
            className="h-9 w-48 bg-ink-900 border border-ink-700 rounded-lg px-3 text-13 text-ink-100 outline-none focus:border-amber/50"
            placeholder="这一局的名字"
            value={creating}
            onChange={e => setCreating(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void doCreate() }}
          />
          <Button variant="primary" size="md" disabled={busy} onClick={() => void doCreate()}>＋ 新建一局</Button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 gap-3 pt-3">
        {/* 左：局列表 */}
        <aside className="w-72 shrink-0 space-y-1.5 overflow-y-auto">
          {list === null ? (
            <div className="flex items-center gap-2 py-6 text-ink-400"><Loader2 size={15} className="animate-spin text-amber" /><span className="text-13">读取中…</span></div>
          ) : list.length === 0 ? (
            <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3 text-12 leading-relaxed text-ink-400">
              还没有跑团互动。<b className="text-ink-200">「＋ 新建一局」</b>开始 —— 之后在右侧输入你的行动就能开跑。
            </div>
          ) : list.map(it => (
            <div key={it.id}
              className={`rounded-lg border px-3 py-2 cursor-pointer transition-colors ${selId === it.id ? 'border-amber/50 bg-ink-800/60' : 'border-ink-700 bg-ink-850/30 hover:bg-ink-800/40'}`}
              onClick={() => setSelId(it.id)}>
              {renaming?.id === it.id ? (
                <input autoFocus
                  className="w-full h-7 bg-ink-900 border border-amber/50 rounded px-2 text-13 text-ink-100 outline-none"
                  value={renaming.text}
                  onChange={e => setRenaming({ id: it.id, text: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { void renameRun(it.id, renaming.text).then(load); setRenaming(null) }
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={() => { void renameRun(it.id, renaming.text).then(load); setRenaming(null) }}
                  onClick={e => e.stopPropagation()} />
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="flex-1 truncate text-13 text-ink-100">{it.title}</span>
                  <Button variant="icon-muted" size="sm" title="重命名"
                    onClick={e => { e.stopPropagation(); setRenaming({ id: it.id, text: it.title }) }}>✎</Button>
                  <Button variant="icon-danger" size="sm" title="删除"
                    onClick={e => { e.stopPropagation(); void doDelete(it.id, it.title) }}><Trash2 size={13} /></Button>
                </div>
              )}
              <div className="mt-1 text-10 text-ink-500 truncate">
                {it.companionBrief ? `同伴：${it.companionBrief} · ` : ''}线索 {it.clueCount}
                {it.reachedEnding ? ` · 结局「${it.reachedEnding}」` : ''}
              </div>
              <div className="text-10 text-ink-600 truncate">{it.worldBrief ? `世界 ${it.worldBrief} · ` : ''}{fmt(it.updatedAt)}</div>
            </div>
          ))}
        </aside>

        {/* 右：局详情 */}
        <section className="flex-1 min-w-0 overflow-y-auto pr-1">
          {!session ? (
            <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-4 text-12 leading-relaxed text-ink-400">
              从左边选一局，或新建一局。跑团互动的每一步都记在**行动流水**里，可存档、可回滚。
            </div>
          ) : (
            <div className="space-y-3">
              {/* 概览 + 存档 */}
              <div className="rounded-lg border border-ink-700 bg-ink-850/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-13 font-semibold text-ink-100">{session.title}</span>
                  {session.worldRef && (
                    <span className="rounded border border-ink-700 px-1.5 py-0.5 text-10 text-ink-400">
                      引用世界「{session.worldRef.worldName ?? '世界'}」v{session.worldRef.version}
                    </span>
                  )}
                  <span className="text-10 text-ink-500">线索 {stats.acquired}/{stats.total} · 秘密已揭 {session.secrets.filter(x => x.unlocked).length}/{session.secrets.length}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button variant="secondary" size="sm" onClick={() => void doCheckpoint()}>存档</Button>
                    {(session.undoSnapshot) && <Button variant="ghost" size="sm" onClick={() => void doUndo()}>撤销回滚</Button>}
                  </div>
                </div>
                {(session.checkpoints ?? []).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {(session.checkpoints ?? []).map(cp => (
                      <span key={cp.id} className="inline-flex items-center gap-1 rounded border border-ink-700 px-1.5 py-0.5 text-10 text-ink-400">
                        {cp.label || '档'} · {fmt(cp.at)}
                        <Button variant="bare" type="button" className="text-10 text-amber hover:underline" onClick={() => void doRollback(cp.id)}>回滚</Button>
                        <Button variant="bare" type="button" className="text-10 text-ink-500 hover:text-danger" onClick={() => void doDropCheckpoint(cp.id)}>✕</Button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* 行动 */}
              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="text-12 font-semibold text-ink-200">你的行动</span>
                  <span className="text-10 text-ink-500">观察 / 交谈 / 取证…成败由系统掷定，KP 照结果演</span>
                  {lastCheck && (
                    <span className="ml-auto text-11 text-ink-400">
                      本轮：{lastCheck.kind} · 难度 {lastCheck.difficulty} · 掷 {lastCheck.roll} ⇒
                      <b className={lastCheck.outcome === '失败' ? 'text-danger' : lastCheck.outcome === '大成功' ? 'text-success' : 'text-amber'}> {lastCheck.outcome}</b>
                    </span>
                  )}
                </div>
                <div className="flex items-end gap-2">
                  <textarea
                    className="flex-1 min-h-[56px] bg-ink-900 border border-ink-700 rounded-lg px-3 py-2 text-13 text-ink-100 outline-none focus:border-amber/50 resize-y"
                    placeholder="我搜查抽屉 / 我问他昨晚在哪 / 我观察四周…"
                    value={actionText}
                    onChange={e => setActionText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void doAction() }} />
                  <Button variant="primary" size="md" disabled={busy || !actionText.trim()} onClick={() => void doAction()}>
                    {busy ? <Loader2 size={14} className="animate-spin" /> : '开始 KP 一轮'}
                  </Button>
                </div>
              </div>

              {/* 同伴 */}
              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="mb-1.5 text-12 font-semibold text-ink-200">同伴 <span className="text-10 text-ink-500">知晓边界：没写在「知晓」里的事，Ta 不会知道</span></div>
                {session.companions.length === 0 && <div className="text-11 text-ink-500">还没有同伴。</div>}
                <div className="space-y-1">
                  {session.companions.map(c => (
                    <div key={c.charId} className="flex items-center gap-2 text-11">
                      <span className="text-ink-100">{c.name}</span>
                      {c.stance && <span className="text-ink-500">｜{c.stance}</span>}
                      <span className="text-ink-500">｜知晓：{c.knows.length ? c.knows.join('、') : '（无）'}</span>
                      {c.canHelp && <span className="text-info">｜可搭手</span>}
                      <Button variant="bare" type="button" className="ml-auto text-10 text-ink-500 hover:text-danger"
                        onClick={() => void persist(dropCompanion(session, c.charId))}>移除</Button>
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <input className="h-8 w-28 bg-ink-900 border border-ink-700 rounded px-2 text-12 text-ink-100 outline-none focus:border-amber/50"
                    placeholder="名字" value={comp.name} onChange={e => setComp({ ...comp, name: e.target.value })} />
                  <input className="h-8 w-36 bg-ink-900 border border-ink-700 rounded px-2 text-12 text-ink-100 outline-none focus:border-amber/50"
                    placeholder="立场（如：欠你一条命）" value={comp.stance} onChange={e => setComp({ ...comp, stance: e.target.value })} />
                  <input className="h-8 w-44 bg-ink-900 border border-ink-700 rounded px-2 text-12 text-ink-100 outline-none focus:border-amber/50"
                    placeholder="知晓（逗号分隔）" value={comp.knows} onChange={e => setComp({ ...comp, knows: e.target.value })} />
                  <label className="flex items-center gap-1 text-11 text-ink-400">
                    <input type="checkbox" checked={comp.canHelp} onChange={e => setComp({ ...comp, canHelp: e.target.checked })} />可搭手
                  </label>
                  <Button variant="secondary" size="sm" disabled={!comp.name.trim()} onClick={() => void doAddCompanion()}>
                    <Plus size={13} /> 添加
                  </Button>
                </div>
              </div>

              {/* 线索板 */}
              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="mb-1.5 text-12 font-semibold text-ink-200">线索板 <span className="text-10 text-ink-500">已获 {stats.acquired} / {stats.total}</span></div>
                {session.clues.length === 0 && <div className="text-11 text-ink-500">还没有线索 —— 去「取证 / 观察 / 交谈」。</div>}
                <div className="space-y-0.5">
                  {session.clues.map(c => (
                    <div key={c.id} className={`text-11 ${c.acquired ? 'text-ink-200' : 'text-ink-600'}`}>
                      {c.acquired ? '●' : '○'} {c.text} <span className="text-ink-500">（{c.source}）</span>
                      {c.linksSecretId && <span className="text-ink-500"> · 关联秘密</span>}
                    </div>
                  ))}
                </div>
                {pendingClues(session).length > 0 && (
                  <div className="mt-1 text-10 text-ink-500">○ 表示开局先埋、还没发现的线索（{pendingClues(session).length} 条）。</div>
                )}
              </div>

              {/* 秘密 */}
              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="mb-1.5 text-12 font-semibold text-ink-200">秘密 <span className="text-10 text-ink-500">满足条件自动揭晓；也可由 KP 说破</span></div>
                {session.secrets.length === 0 && <div className="text-11 text-ink-500">这一局还没设秘密。</div>}
                <div className="space-y-0.5">
                  {session.secrets.map(s => (
                    <div key={s.id} className={`text-11 ${s.unlocked ? 'text-amber' : 'text-ink-500'}`}>
                      {s.unlocked ? '🔓 已揭' : '🔒 未揭'}：{s.text}
                    </div>
                  ))}
                </div>
                {lockedSecrets(session).length > 0 && <div className="mt-1 text-10 text-ink-500">未揭 {lockedSecrets(session).length} 条。</div>}
              </div>

              {/* 结局 */}
              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="mb-1.5 text-12 font-semibold text-ink-200">结局</div>
                {ends.length === 0 ? <div className="text-11 text-ink-500">还没设结局。</div> : (
                  <div className="space-y-1">
                    {ends.map(e => (
                      <div key={e.ending.id} className="text-11">
                        <span className={tierCls(e.tier)}>
                          {e.tier === '达成' ? <CheckCircle2 size={11} className="inline -mt-0.5" /> : e.tier === '接近' ? <AlertTriangle size={11} className="inline -mt-0.5" /> : null}
                          {' '}{e.ending.name} · {e.tier}
                        </span>
                        {e.missing.length > 0 && <span className="text-ink-600"> —— 还差：{e.missing.join('；')}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 行动流水 */}
              <div className="rounded-lg border border-ink-700 bg-ink-850/30 p-3">
                <div className="mb-1.5 text-12 font-semibold text-ink-200">行动流水 <span className="text-10 text-ink-500">可记录的后果</span></div>
                {session.actions.length === 0 ? <div className="text-11 text-ink-500">还没有行动。</div> : (
                  <div className="space-y-0.5">
                    {[...session.actions].reverse().map(a => (
                      <div key={a.id} className="text-11 text-ink-300">
                        <span className="text-ink-500">{a.kind}</span> {a.text}
                        {typeof a.roll === 'number' && <span className="text-ink-500"> · 掷 {a.roll}/{a.difficulty} ⇒ {a.outcome}</span>}
                        {a.consequence && <div className="pl-3 text-ink-500">↳ {a.consequence}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
