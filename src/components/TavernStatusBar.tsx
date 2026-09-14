/**
 * 酒馆模式 · 状态栏（批次 8；调研稿 C2 第一步：**只读可视化**）
 *
 * 一句话定位：**把「现在是什么状态」摊在对话上方，不用去右栏翻记忆**。
 *
 * 【为什么是只读】
 * C2 的第二步才是「变量 + AI 输出增量」。第一步只读有两个实打实的好处：
 *   ① 不改数据模型 —— 六栏记忆仍是唯一真源，多出来的只是**视图**，坏了不影响任何数据；
 *   ② 不给 AI 多一个可写字段 —— 让模型每轮吐数值，就得处理它乱吐、漏吐、数值漂移，
 *      那是第二步要单独设计的事（也正因如此老大把它列为「慎做」）。
 * 所以这里连一处编辑入口都不给：要改去右栏「记忆」改，那才是数据所在。
 *
 * 【为什么不做「关系温度」的数值】
 * 自造一个 0–100 的分数，作者第一句一定问「这 73 分怎么算的」。这一步的温度
 * 就是**关系状态那一栏本身**（模型每轮重写的一句话），它比分数准，且能直接与记忆对照。
 *
 * 🔴 只渲染模型，不读库、不写库（模型由 TavernFree 用**已经加载好**的记忆组装）。
 */
import Avatar from './Avatar'
import { agoText, type StatusModel } from '../lib/tavern/status'

export default function TavernStatusBar({ model, sceneText, collapsed }: {
  model: StatusModel
  /** 场景一行（地点 · 时间）；空则显示占位文案 */
  sceneText: string
  /**
   * 折叠状态。**开关放在页面工具条上**（「角色状态」按钮），这里不再放第二个开关 ——
   * 原先条内自带「收起」，而页头没入口，结果作者根本不知道有这块东西
   * （老大 2026-09-14 原话：「我没找到如何查看对话角色状态一览的地方」）。
   * 一个布尔值一个控制点，位置还得是"找按钮会去的地方"。
   */
  collapsed: boolean
}) {
  const noMemory = model.rows.every(r => r.empty)

  return (
    <div className="shrink-0 border-b border-ink-800 bg-ink-850/40 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-[10.5px] text-ink-400">角色状态</span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-300" title={sceneText}>
          {sceneText || <span className="text-ink-600">未设定场景（新建对话时可以填）</span>}
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
              ? '这里只是把记忆摊开看 —— 记忆为空说明还没聊到需要整理的量，聊几轮就会自动整理。'
              : '只读一览：关系状态与计数都来自右栏「记忆」那六栏，要改请去那边（或让 AI 整理一次）。'}
          </p>
        </>
      )}
    </div>
  )
}
