/**
 * 酒馆模式 · 状态栏（对话上方那条只读一览）
 *
 * 一句话定位：**把「现在是什么状态」摊在对话上方，不用切页去翻记忆**。
 *
 * 【它现在只放「角色状态 + 场景」】
 *   · 角色状态（只读）—— 关系状态与计数都来自六栏记忆，**这里不给编辑入口**。
 *     记忆的阅读与手改入口在「角色卡片」页（2026-09-16 起右栏改显「本场状态」，不再摆记忆）。
 *   · 🚫 **本场数值已从这里搬走**（同日去重）：同一组数原先在中间这条栏与右栏各显示一遍，
 *     现在只留右栏「本场状态」那一处（栏内即看即改），见 `TavernVarsPanel.tsx`。
 *
 * ⚠️ 当前**只有自由对话在用**它（剧情推演另有自己的一块）。
 * 所以下面那句记忆整理时机的说明写的是自由模式的规矩（点「结束本轮对话」才整理）——
 * 哪天剧情推演也接进来，得按模式分文案，别把「聊几轮就会自动整理」写死在这儿。
 *
 * 【为什么不做「关系温度」的数值】
 * 自造一个 0–100 的分数，作者第一句一定问「这 73 分怎么算的」。这一步的温度
 * 就是**关系状态那一栏本身**（模型每轮重写的一句话），它比分数准，且能直接与记忆对照。
 * 「好感 / 信任」是另一回事：那是作者点名要的变量，且有明确语义（模型每轮按剧情给增量）。
 *
 * 🔴 只渲染，不读库不写库（数据由 TavernFree 传进来、改完由它写回）。
 */
import Avatar from './Avatar'
import { agoText, type StatusModel } from '../lib/tavern/status'

export default function TavernStatusBar({ model, sceneText, collapsed }: {
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
}) {
  const noMemory = model.rows.every(r => r.empty)

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
                      ? <span className="text-ink-600">记忆还是空的 —— 点「结束本轮对话」时会整理出这一场</span>
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
              ? '角色状态来自六栏记忆，现在还是空的 —— 自由对话只在点「结束本轮对话」时整理记忆，所以这一场聊完才会长出来。'
              : '角色状态只读（关系状态与计数来自六栏记忆，整理入口是「结束本轮对话」，要直接改就去「角色卡片」页的记忆区）。'}
          </p>
        </>
      )}
    </div>
  )
}
