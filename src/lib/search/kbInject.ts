// ============ 知识库 · 上下文注入（2.8.0 · 台账 #017）============
//
// 与 `semantic/inject.ts` 同构：把「召回」包成「一段可直接 push 进上下文的文本」，
// 好让 `aiContext` 只加几行调用（它已经贴着结构闸门的软限了）。
//
// 🔴 依赖方向：`kbInject → {db, semantic/inject, semantic/settings, knowledgeBase}`，
//    **不 import `aiContext`** —— 否则与 `aiContext → kbInject` 成环。

import * as db from '@/lib/db'
import { focusQueryOf } from '@/lib/semantic/inject'
import { resolveEmbedConfig } from '@/lib/semantic/settings'
import { KB_TOP_K, recallKnowledge, renderKbHits } from '@/lib/search/knowledgeBase'

export interface KbInjectOptions {
  /** 焦点章节 id。**可选** —— 没有它时退用 `fallbackQuery`（见下），不再整段放弃 */
  focusChapterId?: string
  /**
   * 🆕 3.0.3 · 无焦点章时的降级查询文本（调用方传"书名 + 简介"这类**项目级**文本）。
   *
   * 🔴 为什么要有：参考资料是作者**全项目共用**的素材，而此前它只在"有焦点章"时才召回 ——
   *    于是 AI 助手 / 灵感创作 / AI 伴写这些**没有"当前写到哪"**的功能，即便作者挂载了资料
   *    也一段都读不到（实测 29 个上下文装配点里 16 处如此）。那不是设计意图，是漏接。
   */
  fallbackQuery?: string
  /** 最多注入几条，默认 `KB_TOP_K`（4） */
  limit?: number
  /** 🆕 3.0.3 · 本段总长上限（默认 2400）。伴写这类"最轻的一档"传更小的值，免得挤掉设定 */
  maxChars?: number
  signal?: AbortSignal
  /** 单测注入点（生产不传） */
  deps?: {
    loadChapters?: () => Promise<{ id: string; title?: string; summary?: string; content?: string }[]>
    resolveConfig?: typeof resolveEmbedConfig
    recall?: typeof recallKnowledge
  }
}

/**
 * 构造〖参考资料〗段。**永不抛**、拿不到东西返回空串 —— 调用方只管"空就不 push"。
 *
 * 静默跳过的三种情况（都是常态，不是错误）：
 *   ① 连降级查询文本都没有 —— 拿不出查询就别发请求；
 *   ② 没有「已启用」的参考资料 —— 作者没挂载，或挂了但没勾选；
 *   ③ 召回失败（`recallKnowledge` 自己也不抛）。
 *
 * 🔴 查询文本优先用 `focusQueryOf`（与〖语义召回〗**同一取法**：若两段召回"看的不是同一段文字"，
 *    作者会觉得同一次生成里两边捞出来的东西风马牛不相及，很难判断到底是哪一边出了问题）；
 *    没有焦点章时才退到 `fallbackQuery` —— 那一档本来就没有"当前段落"可比，不存在口径冲突。
 */
export async function buildKbBlock(opts: KbInjectOptions): Promise<string> {
  try {
    const projectId = db.getCurrentProjectId()
    if (!projectId) return ''

    let query = ''
    if (opts.focusChapterId) {
      const loadChapters = opts.deps?.loadChapters ?? db.getAllChapters
      const chapters = await loadChapters().catch(() => [])
      query = focusQueryOf(chapters.find(c => c.id === opts.focusChapterId))
    }
    // 🔴 没有焦点章 ⇒ 用项目级文本（书名/简介）。**别在这里 return ''** ——
    //    那正是"挂了资料却读不到"的老毛病（见 KbInjectOptions.fallbackQuery 的说明）。
    if (!query) query = (opts.fallbackQuery ?? '').trim()
    if (!query) return ''

    const cfg = await (opts.deps?.resolveConfig ?? resolveEmbedConfig)()
    const hits = await (opts.deps?.recall ?? recallKnowledge)(query, {
      projectId,
      cfg,
      topK: opts.limit ?? KB_TOP_K,
      signal: opts.signal,
    })
    // maxChars 传 undefined 时用 renderKbHits 自己的默认值（2400）
    return renderKbHits(hits, opts.maxChars)
  } catch {
    return ''
  }
}
