/**
 * 酒馆模式 · 状态栏（批次 8 只读一览 + C2 第二步「本场数值」）
 *
 * 一句话定位：**把「现在是什么状态」摊在对话上方，不用去右栏翻记忆**。
 *
 * 【两层内容，性质不同】
 *   · 角色状态（只读）—— 关系状态与计数都来自右栏「记忆」那六栏，**这里不给编辑入口**。
 *     要改去右栏改（那才是数据所在），或者让 AI 整理一次。
 *   · 本场数值（可改）—— 好感 / 信任 / 剧情进度 / 心情 / 当前地点。它是**会话级**的独立数据
 *     （不在记忆里），所以这里必须有编辑入口，否则模型算错时作者只能干看着。
 *
 * 【为什么不做「关系温度」的数值】
 * 自造一个 0–100 的分数，作者第一句一定问「这 73 分怎么算的」。这一步的温度
 * 就是**关系状态那一栏本身**（模型每轮重写的一句话），它比分数准，且能直接与记忆对照。
 * 「好感 / 信任」是另一回事：那是作者点名要的变量，且有明确语义（模型每轮按剧情给增量）。
 *
 * 🔴 只渲染，不读库不写库（数据由 TavernFree 传进来、改完由它写回）。
 */
import { useEffect, useState } from 'react'
import Avatar from './Avatar'
import { agoText, type StatusModel } from '../lib/tavern/status'
import { varDefOf, type TavernVars, type VarKey } from '../lib/tavern/types'
import { lastChangeText } from '../lib/tavern/vars'

/** 一个数值行：标签 + 进度条（仅数值变量）+ 可编辑的值 + 最近一次差量 */
function VarRow({ k, vars, onSet }: {
  k: VarKey
  vars: TavernVars | undefined
  onSet: (key: VarKey, raw: string) => void
}) {
  const def = varDefOf(k)!
  const raw = vars?.values?.[k]
  const shown = raw === undefined ? String(def.init ?? '') : String(raw)
  const [draft, setDraft] = useState(shown)
  // 外部值变了（AI 更新 / 重置 / 换会话）就刷新草稿 —— 否则输入框会定格在旧值上
  useEffect(() => { setDraft(shown) }, [shown])

  const num = def.kind === 'num' ? Number(shown) : NaN
  const pct = def.kind === 'num' && Number.isFinite(num)
    ? Math.max(0, Math.min(100, ((num - def.min) / Math.max(1, def.max - def.min)) * 100))
    : 0
  const delta = lastChangeText(vars, k)

  const commit = () => {
    if (draft === shown) return
    onSet(k, draft)
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[11px] text-ink-400" title={def.kind === 'num' ? `${def.min}–${def.max}` : `≤${def.maxLen} 字`}>
        {def.label}
      </span>
      {def.kind === 'num' && (
        <span className="relative h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-ink-700" title={`${shown} / ${def.max}`}>
          <span className="absolute inset-y-0 left-0 rounded-full bg-amber/70" style={{ width: `${pct}%` }} />
        </span>
      )}
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
        inputMode={def.kind === 'num' ? 'numeric' : undefined}
        placeholder={def.kind === 'text' ? '（未填）' : String(def.init ?? '')}
        className={`w-24 shrink-0 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11.5px] text-ink-100 outline-none focus:border-amber/50 ${def.kind === 'text' ? 'min-w-0 flex-1' : ''}`}
        title="改完按回车或点一下别处生效（也可以让它自己走）"
      />
      {delta && (
        <span className={`shrink-0 text-[10.5px] ${delta.startsWith('-') ? 'text-ink-400' : 'text-amber/80'}`}>
          上次 {delta}
        </span>
      )}
    </div>
  )
}

export default function TavernStatusBar({ model, sceneText, collapsed, vars, varKeys, onSetVar, onResetVars }: {
  model: StatusModel
  /** 场景一行（地点 · 时间，或剧本的名字与情境）；空则显示占位文案 */
  sceneText: string
  /**
   * 折叠状态。**开关放在页面工具条上**（「角色状态」按钮），这里不再放第二个开关 ——
   * 原先条内自带「收起」，而页头没入口，结果作者根本不知道有这块东西
   * （老大 2026-09-14 原话：「我没找到如何查看对话角色状态一览的地方」）。
   * 一个布尔值一个控制点，位置还得是"找按钮会去的地方"。
   */
  collapsed: boolean
  /** 本场数值（C2 第二步）。没有 / 全关闭时不渲染数值块 */
  vars?: TavernVars
  varKeys: VarKey[]
  onSetVar: (key: VarKey, raw: string) => void
  onResetVars: () => void
}) {
  const noMemory = model.rows.every(r => r.empty)
  const [showLog, setShowLog] = useState(false)
  const log = [...(vars?.log ?? [])].reverse().slice(0, 12)

  return (
    <div className="shrink-0 border-b border-ink-800 bg-ink-850/40 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-[10.5px] text-ink-400">角色状态</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-300" title={sceneText}>
          {sceneText || <span className="text-ink-600">未设定场景（新建对话时可选一份剧本）</span>}
        </span>
        {/* 折叠时也给一条最小信息：在场几位 + 记忆新鲜度 */}
        {collapsed && (
          <span className="shrink-0 text-[10.5px] text-ink-500">
            {model.rows.length} 人在场
            {model.facts > 0 && <> · 事实 {model.facts}</>}
            {model.mines > 0 && <> · 雷 {model.mines}</>}
          </span>
        )}
        <span className="shrink-0 text-[10.5px] text-ink-500">记忆 {agoText(model.memoryUpdatedAt)}</span>
      </div>

      {!collapsed && (
        <>
          {/* ---------- 本场数值（可改） ---------- */}
          {varKeys.length > 0 && (
            <div className="mt-2 rounded-md border border-ink-800 bg-ink-900/40 px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] text-ink-400">本场数值</span>
                <span className="text-[10px] text-ink-600">改完回车生效 · 数值属于这一场，换一场重来</span>
                <span className="flex-1" />
                {log.length > 0 && (
                  <button
                    type="button" onClick={() => setShowLog(v => !v)}
                    className="shrink-0 text-[10.5px] text-ink-500 hover:text-amber"
                    title="看这一场数值的变化过程"
                  >
                    {showLog ? '收起变动' : `变动 ${log.length}`}
                  </button>
                )}
                <button
                  type="button" onClick={onResetVars}
                  className="shrink-0 text-[10.5px] text-ink-500 hover:text-amber"
                  title="把启用中的数值全部恢复成初始值（好感/信任 50、剧情进度 0，文本清空）"
                >
                  重置
                </button>
              </div>
              <div className="mt-1.5 space-y-1">
                {varKeys.map(k => <VarRow key={k} k={k} vars={vars} onSet={onSetVar} />)}
              </div>
              {showLog && (
                <ul className="mt-1.5 max-h-40 space-y-0.5 overflow-y-auto border-t border-ink-800 pt-1.5">
                  {log.map((e, i) => (
                    <li key={`${e.at}-${i}`} className="text-[10.5px] leading-relaxed text-ink-500">
                      <span className="text-ink-600">{new Date(e.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                      {e.source === 'manual' && <span className="ml-1 text-amber/70">手改</span>}
                      {e.source !== 'manual' && e.turnSeq ? <span className="ml-1">第 {e.turnSeq} 轮</span> : null}
                      <span className="ml-1">
                        {e.changes.map(c => `${c.label} ${String(c.from || '空')} → ${String(c.to || '空')}`).join('；')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* ---------- 角色状态（只读） ---------- */}
          <ul className="mt-2 space-y-1.5">
            {model.rows.map(r => (
              <li key={r.charId} className="flex items-start gap-2">
                <Avatar src={r.avatar} name={r.name} size={22} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-[12px] text-ink-100">{r.name}</span>
                    {r.isUser && <span className="text-[10px] text-amber">你演</span>}
                    {r.muted
                      ? <span className="text-[10px] text-ink-500">已静音 · 仍算在场</span>
                      : r.talkBand && <span className="text-[10px] text-ink-500">{r.talkBand}</span>}
                  </div>
                  <div
                    className="mt-0.5 text-[11px] leading-relaxed text-ink-400"
                    title={r.relationFull || undefined}
                  >
                    {r.empty
                      ? <span className="text-ink-600">记忆还是空的 —— 聊几句之后 Ta 会自己整理</span>
                      : r.relation
                        ? <>关系：{r.relation}</>
                        : <span className="text-ink-600">关系状态这一栏还没写</span>}
                  </div>
                  {!r.empty && (
                    <div className="mt-0.5 text-[10.5px] text-ink-500">
                      关键事实 {r.facts} · 未爆的雷 {r.mines} · 纪念日与待办 {r.anniversaries}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-[10.5px] text-ink-600 leading-relaxed">
            {noMemory
              ? '角色状态只是把记忆摊开看 —— 记忆为空说明还没聊到需要整理的量，聊几轮就会自动整理。'
              : '角色状态只读：关系状态与计数都来自右栏「记忆」那六栏，要改请去那边（或让 AI 整理一次）。下面的本场数值可以直接改。'}
          </p>
        </>
      )}
    </div>
  )
}
