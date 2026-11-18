/**
 * 检查报告 → 修订候选 的**一次性带入**（3.6.0 · 审计项 12 补写）
 *
 * 【为什么需要这一层】
 * 数据模型早就支持「候选关联检查报告」（`RevisionCandidate.checkPayloadIds` 从 3.2 起就在
 * 存储与比较里，`sameCandidateRevision` 还专门比它），但**产品里没有任何一条路径会写它**。
 * 检查报告面板只能回看，创意写作里的改写要求是作者手填的自由文本 —— 两边不通，
 * 于是「检查 → 证据 → 候选 → 审阅应用」这条链在第 3 步断开，作者拿不出"这稿是按哪份报告改的"。
 *
 * 【为什么用模块级状态，而不是 URL / 数据库】
 * 两个界面在不同页签，跨页传递一个**待用意图**最轻的做法就是模块级单值：
 *   · 不落库：它只活到"被用掉/被关掉"，没有历史价值，落库反而要清理；
 *   · 不塞路由：本项目没有 query 路由，硬塞会把页面状态机弄脏。
 * 这与 `aiTaskCenter` / 候选上下文同一套思路（跨页长任务放可存活的模块级状态）。
 *
 * 🔴 三条纪律：
 *   ① **取走即清空**（`take`）：一次带入只够用一次，避免下一次改写莫名带上旧报告；
 *   ② **项目不匹配就不给**：切了项目还沿用它，等于把甲书的检查结论当乙书的依据；
 *   ③ **时间不设过期，但记录 createdAt**：界面可以据此提示"这份带入来自 N 分钟前"。
 */

export interface PendingRevisionFromCheck {
  projectId: string
  chapterId: string
  /** 关联的检查载荷 id（写进候选，供日后追溯"这稿按哪份报告改的"） */
  checkPayloadIds: string[]
  /** 带入到改写要求输入框的文本（作者可再编辑） */
  requirement: string
  createdAt: number
}

let pending: PendingRevisionFromCheck | null = null

/** 登记一次带入（后一次覆盖前一次：作者刚点的那个才是他要的） */
export function setPendingRevisionFromCheck(
  input: Omit<PendingRevisionFromCheck, 'createdAt'> & { createdAt?: number },
): PendingRevisionFromCheck {
  pending = {
    ...input,
    checkPayloadIds: [...new Set(input.checkPayloadIds.filter(id => typeof id === 'string' && id))],
    createdAt: input.createdAt ?? Date.now(),
  }
  return pending
}

/** 只看不取（界面可据此显示"有带入的检查要求"） */
export function peekPendingRevisionForProject(projectId: string): PendingRevisionFromCheck | null {
  if (!pending) return null
  // 🔴 项目变了就不认：宁可让作者重选一次，也不要把甲书的结论当乙书的依据
  if (!projectId || pending.projectId !== projectId) return null
  return pending
}

/** 取走（用完即清）。项目不匹配时**不动**它——那可能是作者切错了项目又切回来。 */
export function takePendingRevisionForProject(projectId: string): PendingRevisionFromCheck | null {
  const hit = peekPendingRevisionForProject(projectId)
  if (!hit) return null
  pending = null
  return hit
}

export function clearPendingRevisionFromCheck(): void {
  pending = null
}

/**
 * 把一份检查报告整理成「改写要求」文本。
 *
 * 🔴 只搬运**报告里已有的**内容（标题 + 级别），不自己发挥：报告写"这里有问题"，
 *    要求就写"按报告修这里"；不替作者判断该怎么改（那是模型与该次改写的事）。
 * 🔴 上限 6 条：要求框是给人看的，塞 30 条只会让作者看不清要去改什么。
 */
export function requirementFromReport(input: {
  chapterTitle?: string
  summary?: string
  findings: { level?: string; title?: string }[]
  limit?: number
}): string {
  const limit = input.limit ?? 6
  const serious = input.findings.filter(f => f.level === '严重')
  const medium = input.findings.filter(f => f.level === '中等')
  const picked = [...serious, ...medium].slice(0, limit)
  const lines = picked.map((f, i) => `${i + 1}. ${(f.title ?? '').trim() || '（报告未给标题）'}`)
  const head = input.chapterTitle ? `按检查报告修订本章（${input.chapterTitle}）：` : '按检查报告修订本章：'
  const body = lines.length ? lines.join('\n') : (input.summary ?? '').trim() || '按检查报告指出的问题修订。'
  const tail = picked.length < serious.length + medium.length
    ? `\n（报告共 ${serious.length + medium.length} 条严重/中等发现，这里只列前 ${picked.length} 条，其余请一并修正）`
    : ''
  return `${head}\n${body}${tail}`
}
