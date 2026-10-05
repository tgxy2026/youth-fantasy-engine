/**
 * 剧情推演 · **左栏情景一览 + 本场信息栏**（从 `TavernPlot.tsx` 拆出来的，2026-09-19 D4-3）。
 *
 * 两个纯展示件，props 名与原局部变量**同名** ⇒ 内部 JSX 一个字未改（缩进也保留原样）。
 *
 * 【为什么左栏的筛选词搬进来】`pickQuery` / `sessionRows` / `fmtDay` 只服务这一块，
 *   原先挂在主组件上，等于让主文件替子区域保管私有状态。搬进来后主文件只交出 4 个 props。
 *
 * ⚠️ 本场信息栏里的「本场记忆 / 检查点」两块是**只读展示 + 触发**：
 *   真正的整理与回滚逻辑分别在 `usePlotSummary` / `usePlotCheckpoints` 里。
 */
import { useMemo, useState } from 'react'
import { Button } from './Button'
import SelectRow from './SelectRow'
import { talkBandOf, talkativityOf, type TavernSession, type TavernSessionIndexItem } from '../lib/tavern/types'
import type { splitCast } from '../lib/tavern/engine'
// S1a 分支树视图（2026-10-05）：父子推断是**纯函数**、住在 store（与 branchTitle 相邻），组件只渲染结果
import { groupSessionsByBranch, isBranchTitle } from '../lib/tavern/store'

// ⚠️ 下面两个展示件内部是从原文件**逐行搬**过来的 JSX，缩进保留原样（8 / 12 空格），
//    这样才能用「逐行区间核对」证明一个字没改 —— 别为了好看去重排缩进。

/** 左栏：全部场次一览（点一下就切）+ 标题/角色/锚点 三合一筛选 */
export function PlotSessionList({ list, activeId, setActiveId, setSetupOpen }: {
  list: TavernSessionIndexItem[]
  activeId: string
  setActiveId: (id: string) => void
  setSetupOpen: (open: boolean) => void
}) {
  /** 左栏情景列表的筛选词（场次多了靠它找，不必滚动） */
  const [pickQuery, setPickQuery] = useState('')

  /** 左栏情景列表：按筛选词过滤（标题 / 参演角色 / 锚点章名都算命中） */
  const sessionRows = useMemo(() => {
    const q = pickQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter(s =>
      `${s.title} ${s.castBrief} ${s.anchorTitle}`.toLowerCase().includes(q))
  }, [list, pickQuery])

  /** 分支树视图开关（S1a，2026-10-05）：**纯显示开关、零数据改动** ——
   *  不新增字段、不存 `parentId`，父子关系由 `branchTitle` 写进去的「 ·分支N」后缀反推。
   *  推断逻辑在 `store.groupSessionsByBranch()`（纯函数、有单测），组件这边只拿结果渲染。 */
  const [treeMode, setTreeMode] = useState(false)

  /** 有多少场是分支 —— 一场分支都没有时不必显示这个开关（少一个控点） */
  const branchCount = useMemo(() => list.filter(s => isBranchTitle(s.title)).length, [list])

  /** 展示行：平铺 = 保持原顺序；树形 = 每个根场次**紧跟**它自己的分支（缩进一级）。 */
  const rows = useMemo(() => groupSessionsByBranch(sessionRows, treeMode), [sessionRows, treeMode])

  /** 列表里的日期小字（只到「几月几日」，同年不写年） */
  const fmtDay = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  return (
        <aside className="flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-ink-800 bg-ink-850/40 p-3">
          <Button variant="primary" size="md" className="w-full" onClick={() => setSetupOpen(true)}>＋ 新建推演</Button>
          {list.length > 4 && (
            <input
              className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1 text-11 text-ink-100 outline-none focus:border-amber/50"
              placeholder="筛选（标题 / 角色 / 锚点）"
              value={pickQuery}
              onChange={e => setPickQuery(e.target.value)}
            />
          )}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
            {rows.map(({ s, depth, missingParent }) => {
              const active = s.id === activeId
              return (
                  <SelectRow
                    key={s.id}
                    type="button"
                    selected={active}
                    variant="outline"
                    onClick={() => setActiveId(s.id)}
                    className={`rounded-md px-2 py-1.5 ${depth ? 'ml-3' : ''}`}
                  >
                    <div className={`flex items-center gap-1 text-12 ${active ? 'text-amber' : 'text-ink-200'}`}>
                      {depth ? (
                        <span className="shrink-0 text-ink-600"
                          title={missingParent ? '它的父场次不在当前列表里' : '分支'}>{'└'}</span>
                      ) : null}
                      <span className="truncate">{s.title}</span>
                    </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-10 text-ink-500">
                      {s.mode === 'immersive' ? '沉浸' : '导演'} · {s.castBrief || '未分配角色'}
                    </span>
                    <span className="shrink-0 text-10 text-ink-600">{fmtDay(s.updatedAt)}</span>
                  </div>
                </SelectRow>
              )
            })}
            {rows.length === 0 && (
              <p className="px-1 py-2 text-11 leading-relaxed text-ink-500">
                {list.length === 0 ? '还没有推演 —— 点上面「新建推演」开一场。' : '没有匹配的推演。'}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-ink-800 pt-2 text-10 text-ink-500">
            <span>共 {list.length} 场{branchCount > 0 ? ` · ${branchCount} 个分支` : ''}</span>
            {branchCount > 0 && (
              <Button variant="toggle" size="xs" selected={treeMode}
                onClick={() => setTreeMode(v => !v)}
                title="按「·分支N」后缀推断父子关系并缩进显示（纯显示开关，不改动任何数据）">
                分支树
              </Button>
            )}
          </div>
        </aside>
  )
}

/** 本场信息栏（可收起）：叙事锚点 / 角色分配 / 场景 / 本场记忆 / 检查点 / 删除本场 */
export function PlotInfoPanel({
  session, casts, castFilled, setCastEdit, setDirectorOpen, summarizing, runPlotSummary, stopSummary,
  saveCheckpoint, rollbackTo, dropCp, undoRollback, removeSession,
}: {
  session: TavernSession
  casts: ReturnType<typeof splitCast>
  castFilled: Record<string, boolean>
  setCastEdit: (v: { cardId: string; name: string; kind: 'ai' | 'user' }) => void
  setDirectorOpen: (open: boolean) => void
  summarizing: boolean
  runPlotSummary: (s: TavernSession) => void | Promise<void>
  stopSummary: () => void
  saveCheckpoint: () => void
  rollbackTo: (cpId: string) => void | Promise<void>
  dropCp: (cpId: string) => void
  undoRollback: () => void
  removeSession: () => void | Promise<void>
}) {
  return (
            <aside className="w-64 shrink-0 overflow-y-auto rounded-lg border border-ink-800 bg-ink-850/40 p-3 space-y-3">
              <div>
                <div className="text-11 text-ink-500">叙事锚点</div>
                <div className="text-12 text-ink-200 mt-0.5">{session.anchorChapterLabel || '（未标注）'}</div>
              </div>
              <div>
                <div className="text-11 text-ink-500">信息边界</div>
                <div className="text-12 text-ink-200 mt-0.5">
                  {session.mode === 'immersive' ? '沉浸推演（只带角色常识）' : '导演推演（可参照大纲，仍截到锚点）'}
                </div>
              </div>
              <div>
                <div className="text-11 text-ink-500">角色分配</div>
                <ul className="mt-1 space-y-1">
                  {casts.user.map(c => (
                    <li key={c.cardId} className="flex items-center gap-1.5">
                      <span className="flex-1 min-w-0 truncate text-12 text-amber">你演 · {c.name}</span>
                      <button
                        type="button"
                        onClick={() => setCastEdit({ cardId: c.cardId, name: c.name, kind: 'user' })}
                        className={`shrink-0 text-11 hover:text-amber ${castFilled[c.cardId] ? 'text-amber/80' : 'text-ink-500'}`}
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
                      <span className={"flex-1 min-w-0 truncate text-12 " + (mutedNow ? "text-ink-500" : "text-ink-200")}>
                        AI 演 · {c.name}
                        {mutedNow
                          ? <span className="ml-1 text-10 text-ink-600">已静音</span>
                          : band.name !== '均衡' && <span className="ml-1 text-10 text-ink-500">{band.name}</span>}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCastEdit({ cardId: c.cardId, name: c.name, kind: 'ai' })}
                        className={`shrink-0 text-11 hover:text-amber ${castFilled[c.cardId] ? 'text-amber/80' : 'text-ink-500'}`}
                        title="扮演设定：口吻 / 称呼 / 知识边界 / 底线…">
                        {castFilled[c.cardId] ? '已设定' : '设定'}
                      </button>
                    </li>
                    )
                  })}
                  {casts.silent.map(c => <li key={c.cardId} className="text-12 text-ink-500">在场 · {c.name}</li>)}
                </ul>
                {casts.ai.length > 1 && (
                  <Button
                    variant="secondary" size="sm" className="mt-1.5 w-full"
                    onClick={() => setDirectorOpen(true)}
                    title="静音（在场但不发言）与健谈度：只影响提示词怎么写，不改角色卡"
                  >
                    在场调度（静音 / 健谈度）
                  </Button>
                )}
                <p className="mt-1.5 text-10 text-ink-500 leading-relaxed">
                  AI 演的角色建议填一填「扮演设定」—— 它管的是口吻与底线，比堆设定更能演得像。
                </p>
              </div>
              {(session.scene.place || session.scene.time || session.scene.description) && (
                <div>
                  <div className="text-11 text-ink-500">场景</div>
                  <div className="text-12 text-ink-300 mt-0.5 leading-relaxed">
                    {[session.scene.place, session.scene.time].filter(Boolean).join(' · ')}
                    {session.scene.description && <div className="mt-0.5">{session.scene.description}</div>}
                  </div>
                </div>
              )}
              {/* 本场记忆：会话级（这一场推演发生了什么），随检查点 / 回滚 / 分支一起还原 */}
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-11 text-ink-500">
                    本场记忆{session.memory ? `（${session.memory.length} 字）` : ''}
                  </span>
                  <Button variant="secondary" size="xs" disabled={summarizing}
                    onClick={() => void runPlotSummary(session)}
                    title="把水位线之后的新对话整理进本场记忆。没有自动整理 —— 想更新就点这里"
                  >
                    {summarizing ? '整理中…' : session.memory ? '重新整理' : '整理本场记忆'}
                  </Button>
                  {/* 27B 上整理一次要几十秒到几分钟，给一条退路（中止后旧档案原样保留） */}
                  {summarizing && (
                    <Button variant="secondary" size="xs" onClick={stopSummary} title="停止整理：本场记忆保持原样">
                      中止
                    </Button>
                  )}
                </div>
                {session.memory ? (
                  <div className="mt-0.5 text-11 text-ink-400 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">{session.memory}</div>
                ) : (
                  <p className="mt-1 text-10 text-ink-600 leading-relaxed">
                    还没有本场记忆。点上面的「整理本场记忆」才会生成 —— 不会自动整理。
                    它会随检查点与回滚一起还原；分支时会清掉分叉点之后的记忆，要重新点上面的按钮整理 —— 所以分支不会「记得还没发生的事」。
                  </p>
                )}
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-11 text-ink-500">检查点（{(session.checkpoints ?? []).length}）</span>
                  <Button variant="secondary" size="xs"
                    onClick={() => saveCheckpoint()}
                  >
                    ＋ 存一个
                  </Button>
                </div>
                {(session.checkpoints ?? []).length === 0 ? (
                  <p className="mt-1 text-10 text-ink-600 leading-relaxed">
                    还没有检查点。存一个之后，后面无论聊成什么样都能回到那一刻 ——
                    消息与本场记忆一起还原，而且可以撤销。
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {[...(session.checkpoints ?? [])].sort((a, b) => b.at - a.at).map(cp => (
                      <li key={cp.id} className="flex items-center gap-1.5">
                        <span
                          className="min-w-0 flex-1 truncate text-11 text-ink-300"
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
                  <Button variant="secondary" size="xs" className="mt-1.5 w-full" onClick={undoRollback}>
                    ↩ 撤销上次回滚（{new Date(session.undoSnapshot.at).toLocaleTimeString()}）
                  </Button>
                )}
              </div>
              <Button variant="danger" size="md" className="w-full" onClick={removeSession}>删除这场推演</Button>
            </aside>
  )
}
