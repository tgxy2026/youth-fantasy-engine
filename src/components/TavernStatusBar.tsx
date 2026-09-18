/**
 * 酒馆模式 · 角色状态块（右栏「角色状态」标签页的内容）
 *
 * 一句话定位：**把「现在是什么状态」摊在右栏，不用切页去翻记忆**。
 *
 * 【2026-09-16 第二次搬家：从「对话上方一条横栏」挪进右栏】
 *   老大原话：上方那条角色状态与右栏的「本场状态」应该**并到一起、能切换**。
 *   于是这里不再自己占一条横向空间（那会白吃掉对话区的高度），
 *   改为右栏面板里的**一个标签页**，与「本场状态」（5 项数值）切换着看。
 *   ⚠️ 因此**不再有 `collapsed`**：折叠语义已由「切标签」承担 —— 一个布尔一个控制点，
 *      再留一个「收起」只会多出一个彼此打架的开关。
 *
 * 【它现在只放「角色状态 + 场景」】
 *   · 角色状态（只读）—— 关系状态与计数都来自六栏记忆，**这里不给编辑入口**。
 *     记忆的阅读与手改入口在「角色卡片」页。
 *   · 🚫 **本场数值不在这里**（同日去重）：那五项是另一块数据（会话级变量），
 *     在右栏「本场状态」标签页里即看即改，见 `TavernVarsPanel.tsx`。
 *
 * ⚠️ 当前**只有自由对话在用**它（剧情推演另有自己的一块）。
 * 所以下面那句记忆整理时机的说明写的是自由模式的规矩（点「结束本轮对话」才整理）——
 * 哪天剧情推演也接进来，得按模式分文案，别把「聊几轮就会自动整理」写死在这儿。
 *
 * 【为什么不做「关系温度」的数值】
 * 自造一个 0–100 的分数，作者第一句一定问「这 73 分怎么算的」。这一步的温度
 * 就是**关系状态那一栏本身**（模型每轮重写的一句话），它比分数准，且能直接与记忆对照。
 * 「好感 / 信任」是另一回事：那是作者点名要的变量，且有明确语义（模型按剧情给增量）。
 *
 * 🔴 只渲染，不读库不写库（数据由 TavernFree 传进来、改完由它写回）。
 */
import Avatar from './Avatar'
import { agoText, type StatusModel } from '../lib/tavern/status'

export default function TavernStatusBar({ model, sceneText }: {
  model: StatusModel
  /** 场景一行（地点 · 时间，或剧本的名字与情境）；空则显示占位文案 */
  sceneText: string
}) {
  const noMemory = model.rows.every(r => r.empty)

  return (
    <div className="space-y-2.5">
      {/* 场景：这一场此刻发生在哪 —— 与下面「关系状态」不是一回事，单独一行 */}
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-10 text-ink-500 mt-0.5">场景</span>
        <span className="min-w-0 flex-1 text-11 leading-relaxed text-ink-300" title={sceneText}>
          {sceneText || <span className="text-ink-600">未设定场景（新建对话时可选一份剧本）</span>}
        </span>
      </div>

      {/* 一句话总览：几位在场、记了多少事实与雷，以及记忆什么时候更新的 */}
      <div className="flex flex-wrap items-center gap-x-2 text-10 text-ink-500">
        <span>{model.rows.length} 人在场</span>
        {model.facts > 0 && <span>· 关键事实 {model.facts}</span>}
        {model.mines > 0 && <span>· 未爆的雷 {model.mines}</span>}
        <span className="flex-1" />
        <span>记忆 {agoText(model.memoryUpdatedAt)}</span>
      </div>

      {/* ---------- 角色状态（只读） ---------- */}
      {model.rows.length === 0 ? (
        <p className="text-11 leading-relaxed text-ink-600">这一场还没有在场角色。</p>
      ) : (
        <ul className="space-y-2">
          {model.rows.map(r => (
            <li key={r.charId} className="flex items-start gap-2">
              <Avatar src={r.avatar} name={r.name} size={22} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-12 text-ink-100">{r.name}</span>
                  {r.isUser && <span className="text-10 text-amber">你演</span>}
                  {r.muted
                    ? <span className="text-10 text-ink-500">已静音 · 仍算在场</span>
                    : r.talkBand && <span className="text-10 text-ink-500">{r.talkBand}</span>}
                </div>
                <div
                  className="mt-0.5 text-11 leading-relaxed text-ink-400"
                  title={r.relationFull || undefined}
                >
                  {r.empty
                    ? <span className="text-ink-600">记忆还是空的 —— 点「结束本轮对话」时会整理出这一场</span>
                    : r.relation
                      ? <>关系：{r.relation}</>
                      : <span className="text-ink-600">关系状态这一栏还没写</span>}
                </div>
                {!r.empty && (
                  <div className="mt-0.5 text-10 text-ink-500">
                    关键事实 {r.facts} · 未爆的雷 {r.mines} · 纪念日与待办 {r.anniversaries}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="text-10 leading-relaxed text-ink-600">
        {noMemory
          ? '角色状态来自六栏记忆，现在还是空的 —— 自由对话只在点「结束本轮对话」时整理记忆，所以这一场聊完才会长出来。'
          : '角色状态只读（关系状态与计数来自六栏记忆，整理入口是「结束本轮对话」，要直接改就去「角色卡片」页的记忆区）。'}
      </p>
    </div>
  )
}
