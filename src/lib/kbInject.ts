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
import { KB_TOP_K, recallKnowledge, renderKbHits } from '@/lib/knowledgeBase'

export interface KbInjectOptions {
  focusChapterId: string
  /** 最多注入几条，默认 `KB_TOP_K`（4） */
  limit?: number
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
 *   ① 焦点章不存在 / 空章 —— 拿不出查询文本就别发请求；
 *   ② 没有「已启用」的参考资料 —— 作者没挂载，或挂了但没勾选；
 *   ③ 召回失败（`recallKnowledge` 自己也不抛）。
 *
 * 🔴 查询文本用 `focusQueryOf` —— 与〖语义召回〗**同一取法**。若两段召回"看的不是同一段文字"，
 *    作者会觉得同一次生成里两边捞出来的东西风马牛不相及，很难判断到底是哪一边出了问题。
 */
export async function buildKbBlock(opts: KbInjectOptions): Promise<string> {
  try {
    const projectId = db.getCurrentProjectId()
    if (!projectId) return ''
    const loadChapters = opts.deps?.loadChapters ?? db.getAllChapters
    const chapters = await loadChapters().catch(() => [])
    const query = focusQueryOf(chapters.find(c => c.id === opts.focusChapterId))
    if (!query) return ''

    const cfg = await (opts.deps?.resolveConfig ?? resolveEmbedConfig)()
    const hits = await (opts.deps?.recall ?? recallKnowledge)(query, {
      projectId,
      cfg,
      topK: opts.limit ?? KB_TOP_K,
      signal: opts.signal,
    })
    return renderKbHits(hits)
  } catch {
    return ''
  }
}
