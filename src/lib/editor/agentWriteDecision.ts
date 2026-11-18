/**
 * 「外部 Agent 写入正文后，当前编辑器要不要跟着改」的判定（3.6.1 · B2 从 hook 抽出）。
 *
 * 【为什么要单独一个纯函数模块】这段判定原先长在 `useAgentWriteSync` 的事件回调里，
 * 靠 `draftRef` / `activeRef` 两个可变的 ref 参与判断 —— 想测它就得把 React 与编辑器模型
 * 一起拖进单测（本版不引 DOM 测试栈）。判定本身与 React 无关，抽出来就能穷举。
 *
 * 【判定的四条分支，每一条都是「已经在发生的用户损失」】
 *   ① 事件不是本章/本卷 → 不理（避免无关写入引起全量刷新）；
 *   ② 事件来自别的项目 → 不理（同一窗口切过项目时事件会晚到）；
 *   ③ 命中的是**正在编辑的章但草稿有未保存输入** → **不覆盖**（否则 Agent 刚写入的正文
 *      会被下一次自动保存用旧草稿盖回去，作者的字和 Agent 的字一起没）；
 *   ④ 命中的是其它章 / 整卷变更 → 刷新列表，但**保留本机正在编辑的那一条**（同上，不覆盖草稿）。
 *
 * 🔴 行为与 3.4.3 起一致，本版**没有**新增提示或延后重试：
 *    草稿冲突时是**静默保留草稿**（不打断写作）。要改成弹提示属产品决定，不在这里悄悄加。
 */

/** `yfe:agent-write` 事件里与本判定相关的字段 */
export interface AgentWriteEventDetail {
  projectId?: string
  kind?: string
  chapterId?: string
}

export type AgentWriteDecision =
  /** 不是本模块管的写入，忽略 */
  | { action: 'ignore'; reason: 'other-kind' | 'other-project' }
  /** 整卷变更 / 不是当前章：重读列表（保留本机正在编辑的那条） */
  | { action: 'refresh-list'; reason: 'volume' | 'not-active-chapter' }
  /** 命中的是当前章，但草稿有未保存输入：保留草稿，不覆盖 */
  | { action: 'keep-draft'; reason: 'unsaved-draft' }
  /** 命中的是当前章且草稿干净：读库后应用 */
  | { action: 'apply-chapter'; chapterId: string }

export interface AgentWriteInput {
  detail: AgentWriteEventDetail | null | undefined
  /** 当前打开的项目（`db.getCurrentProjectId()`） */
  currentProjectId: string | null
  /** 当前正在看/编辑的章 */
  activeChapter: { id: string; content?: string } | null
  /** 编辑器里此刻的草稿文本 */
  draft: string
}

export function decideAgentWrite(input: AgentWriteInput): AgentWriteDecision {
  const { detail } = input
  if (!detail || (detail.kind !== 'chapter' && detail.kind !== 'volume')) {
    return { action: 'ignore', reason: 'other-kind' }
  }
  if (detail.projectId && detail.projectId !== input.currentProjectId) {
    return { action: 'ignore', reason: 'other-project' }
  }
  const current = input.activeChapter
  if (detail.kind === 'volume' || !current || current.id !== detail.chapterId) {
    return { action: 'refresh-list', reason: detail.kind === 'volume' ? 'volume' : 'not-active-chapter' }
  }
  if (input.draft !== (current.content ?? '')) return { action: 'keep-draft', reason: 'unsaved-draft' }
  return { action: 'apply-chapter', chapterId: current.id }
}

/**
 * 第二次判定：读库是异步的，读完时作者可能已经开始输入或切了章。
 * 任一条件不成立就**放弃这次应用**（宁可停在旧正文等下次事件，也不能吞掉刚敲的字）。
 */
export function canApplyAgentChapter(input: {
  /** 读库前后是否还是同一章（引用相等，调用方传 `activeRef.current === current`） */
  stillActive: boolean
  /** 读库前后草稿是否没变 */
  stillSameDraft: boolean
  /** 库里是否还能找到这一章 */
  found: boolean
}): boolean {
  return input.stillActive && input.stillSameDraft && input.found
}

/**
 * 刷新列表时保留本机正在编辑的那一条：
 * 库里读回来的列表是权威的，但**唯一例外**是作者此刻正在编辑的那条 —— 用本机副本替换，
 * 否则界面会显示 Agent 写的内容，而作者的下一次保存又把 Agent 的内容盖掉。
 */
export function mergeKeepingLocal<T extends { id: string }>(incoming: readonly T[], local: T | null | undefined): T[] {
  if (!local) return [...incoming]
  return incoming.map(item => (item.id === local.id ? local : item))
}
