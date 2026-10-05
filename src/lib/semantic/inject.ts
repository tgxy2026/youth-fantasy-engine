// ============ 语义检索 · 上下文注入 ============
//
// 把「召回」包装成「一段可直接 push 进上下文的文本」。
//
// 为什么单独一层（而不是塞进 `aiContext`）：
//   `aiContext.ts` 已是近 900 行的文件（贴着结构闸门的软限），而这一段要读库、要调嵌入、
//   要渲染格式 —— 塞进去只会让它更难读。放这里之后 `aiContext` 只需加三行调用。
//
// 🔴 依赖方向：`inject → {db, recall, settings}`，**不 import `aiContext`** ——
//    因为 `indexer → aiContext`（要用 S/D 判据），若这里再反向 import 就成环了。
//    （`aiContext` 能安全 import 本文件，正是因为它只出不进。）

import * as db from '../db'
import { clipText } from '../textClip'
import { recallRelevant, type RecallHit } from './recall'
import type { VecKind } from './store'
import { resolveEmbedConfig } from './settings'

/** 命中类别的显示名（渲染召回段时标「这条来自哪儿」） */
const RECALL_KIND_LABEL: Record<VecKind, string> = {
  chapter: '章节', setting: '设定', summary: '摘要', kb: '资料', tavern: '对话',
}

/** 查询文本取焦点章正文的前多少字（摘要已给出主题，正文前段补"当下的语感与场景"） */
const SEMANTIC_QUERY_CHARS = 900

export interface SemanticInjectOptions {
  projectId: string
  focusChapterId: string
  /** 角色视角：剔除 S 级来源（D 级在索引阶段就不存在了） */
  hideSecretRows?: boolean
  /** 叙事锚点白名单（只对章节类命中生效） */
  allowChapterIds?: Set<string> | null
  /** 最多注入几条，默认 6 */
  limit?: number
  signal?: AbortSignal
  /** 单测注入点（生产不传） */
  deps?: {
    loadChapters?: () => Promise<{ id: string; title?: string; summary?: string; content?: string }[]>
    resolveConfig?: typeof resolveEmbedConfig
    recall?: typeof recallRelevant
  }
}

/**
 * 焦点章的查询文本：标题 + 摘要 + 正文前段。
 * 空章（没标题也没正文）返回空串 ⇒ 调用方直接跳过（拿不出查询就别发请求）。
 */
export function focusQueryOf(
  c: { title?: string; summary?: string; content?: string } | null | undefined,
  chars: number = SEMANTIC_QUERY_CHARS,
): string {
  if (!c) return ''
  const head = `${c.title ?? ''}\n${c.summary ?? ''}`.trim()
  const body = (c.content ?? '').trim().slice(0, Math.max(0, chars))
  return [head, body].filter(Boolean).join('\n').trim()
}

/** 命中 → 可注入文本（**纯函数**，渲染格式改动只在这里）。`header` 可换（自由对话用的是另一句话） */
export function renderRecallHits(
  hits: RecallHit[],
  header = '（按语义相似度从全书捞出的片段，供判断前文与设定是否一致）',
): string {
  if (hits.length === 0) return ''
  const lines = [header]
  for (const h of hits) {
    const label = RECALL_KIND_LABEL[h.kind] ?? '资料'
    const name = (h.title || '未命名').trim()
    lines.push(`◆ ${label}｜${name}（相似度 ${h.score.toFixed(2)}）`)
    lines.push(clipText(h.text, 400, true))
  }
  return lines.join('\n')
}

/**
 * 构造〖语义召回〗段。**永不抛**、拿不到东西返回空串 —— 调用方只管"空就不 push"。
 *
 * 静默跳过的四种情况（都是常态，不是错误）：
 *   ① 没配嵌入模型；② 焦点章不存在 / 空章；③ 索引为空；④ 嵌入或索引调用失败。
 */
export async function buildSemanticRecallBlock(opts: SemanticInjectOptions): Promise<string> {
  try {
    const cfg = await (opts.deps?.resolveConfig ?? resolveEmbedConfig)()
    if (!cfg) return ''

    const loadChapters = opts.deps?.loadChapters ?? db.getAllChapters
    const chapters = await loadChapters().catch(() => [])
    const focus = chapters.find(c => c.id === opts.focusChapterId)
    const query = focusQueryOf(focus)
    if (!query) return ''

    const hits = await (opts.deps?.recall ?? recallRelevant)(query, {
      projectId: opts.projectId,
      cfg,
      topK: opts.limit,
      hideSecretRows: opts.hideSecretRows === true,
      allowChapterIds: opts.allowChapterIds ?? null,
      // 🔴 焦点章自己不进召回：它的正文（或摘要）此刻正在提示里，再塞一遍既占预算又会让
      //    模型以为那是"别的章节"的描述。
      excludeRefIds: new Set([opts.focusChapterId]),
      signal: opts.signal,
    })
    return renderRecallHits(hits)
  } catch {
    return ''
  }
}
