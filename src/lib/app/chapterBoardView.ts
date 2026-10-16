/**
 * 章节规划板 · **展示判据**（3.1.1 第 2 项）
 *
 * 【只做一件事：把「状态」与「正文」明显对不上的情况说出来】
 * 规划板是只读视图，作者扫一眼要能发现两类矛盾：
 *   ① 状态已经是「完稿 / 已发布」，正文却是空的 —— 多半是改完忘了回填，或是误点了状态；
 *   ② 状态还停在「构思」，正文却已经写了成千字 —— 多半是闷头写、忘了推状态。
 *
 * 🔴 铁律：**只提示，绝不自动改状态**（沿用本项目「不擅自替作者决定」的口径）。
 *    文案也必须是**事实陈述**，不是质量判断 —— 写「状态标为『完稿』，但正文为空」，
 *    而不是「这章没写完」（后者是替作者下结论）。
 *
 * 【为什么单独一个叶子模块】纯函数、零运行时依赖 ⇒ 单测直接跑、不会把 db / React 拖进依赖图。
 */
import type { Chapter } from '@/lib/types'

/**
 * 「状态停在构思、正文却已写了不少」的判据阈值（字）。
 *
 * 🔴 取 2000：规划书原文是「标着『构思』却已经写了几千字」。
 *    这不是质量线，只是「明显超出构思阶段」的**提示线** —— 低于它的章不打扰作者。
 */
export const OUTLINE_STATUS_WORDS = 2000

/** 视为「已完成」的状态（与 `WritingWorkflow` 的 `finished` 集合同口径） */
const FINISHED_STATUS: ReadonlySet<string> = new Set(['完稿', '已发布'])

/** 判据需要的字段（`Chapter` 结构上兼容；便于单测少造字段） */
type MismatchInput = Pick<Chapter, 'status' | 'content' | 'wordCount'>

/**
 * 状态与正文明显不一致 ⇒ 返回**事实陈述**的提示文案；一致则返回 null。
 *
 * ⚠️ 全部判据都要求出现在规划板「正文章节」视图里（那里能同时看到状态、字数与「已有 / 尚无正文」），
 *    单看其中任一项都可能被误读。
 */
export function chapterStatusMismatch(c: MismatchInput): string | null {
  const hasContent = (c.content ?? '').trim().length > 0
  if (FINISHED_STATUS.has(c.status) && !hasContent) {
    return `状态标为「${c.status}」，但正文为空`
  }
  // 🔴 必须先确认「确有正文」再比字数：wordCount 有可能滞后于正文（历史数据 / 手工改过），
  //    只用字数判定会在空章上误报 —— 宁可漏报，不可误报（误报会让作者不再信任提示）。
  if (c.status === '构思' && hasContent && (c.wordCount ?? 0) >= OUTLINE_STATUS_WORDS) {
    return `状态仍标为「构思」，但正文已有 ${c.wordCount} 字`
  }
  return null
}
