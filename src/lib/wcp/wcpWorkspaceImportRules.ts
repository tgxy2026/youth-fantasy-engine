// ============ WCP 回流导入 · 纯判定规则（3.7.4 · 复核修复）============
//
// 把回流弹窗里两件**容易写错、必须可单测**的判定抽成纯函数：
//   ① `.wcp.json` 已解析结果的权威性：不能因为全局摘要格式是 Markdown 就被重新解析；
//   ② 正文写入后的归档时机：还有未写入的可勾选候选时先不归档，避免「正文用了、候选还没入库、
//      原件却被移走」的半程状态。
//
// 🔴 零 IO、零依赖；弹窗只做状态编排，判定口径在这里被逐字钉住。
import { parseWcpReply, type WcpParseResult } from '@/lib/wcp/wcpParser'
import type { WcpSummaryFormat } from '@/lib/wcp/wcpTypes'

/** 由 `.wcp.json` 解析得到、可直接复用的结果（连同它的规范化双段文本一起记住） */
export interface WcpLoadedJsonParse {
  text: string
  result: WcpParseResult
}

/**
 * 决定弹窗当前应当显示哪份解析结果。
 *
 * 🔴 `loaded` 命中时**原样返回**：`.wcp.json` 的结构与候选已由 `parseWcpWorkspaceJsonFile`
 *    校验并归一化过，此时全局设置是 JSON 还是 Markdown 都不该再影响它。
 * 🔴 文本框被编辑（`text !== loaded.text`）后，`loaded` 自动失效，回落到按当前格式解析。
 */
export function resolveWcpImportParse(
  text: string,
  format: WcpSummaryFormat,
  loaded: WcpLoadedJsonParse | null,
): WcpParseResult | null {
  if (!text.trim()) return null
  if (loaded && text === loaded.text) return loaded.result
  return parseWcpReply(text, format)
}

/** 正文动作成功后的归档决策 */
export type WcpOutboxArchiveDecision = 'archive' | 'defer' | 'none'

/**
 * @param archiveEnabled   设置里的「导入后自动归档收件箱」（D3）
 * @param hasLoadedSource  正文是否来自本机收件箱产物（浏览本地文件 / 粘贴回来没有可归档来源）
 * @param pendingCandidates 当前是否还有**未写入**的可勾选候选
 */
export function decideOutboxArchiveAfterBody(input: {
  archiveEnabled: boolean
  hasLoadedSource: boolean
  pendingCandidates: boolean
}): WcpOutboxArchiveDecision {
  if (!input.archiveEnabled || !input.hasLoadedSource) return 'none'
  // 候选还没入库就归档，会让作者回头找不到原件；等 applySelected 成功后再归档
  if (input.pendingCandidates) return 'defer'
  return 'archive'
}