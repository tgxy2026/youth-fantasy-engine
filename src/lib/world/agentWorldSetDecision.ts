/**
 * 「Agent 写了世界设定子项之后，这张表要不要把它并进来」的判定（3.6.1 · B2 从 hook 抽出）。
 *
 * 【原来的问题】判定与 React 状态更新混在 `useAgentWorldSetSync` 的 effect 里：
 * 事件是不是给我的、记录归属对不对、是不是已经有了 —— 三条都在回调里现算，
 * 想测就得把 React 拖进单测（本版不引 DOM 测试栈）。
 *
 * 【三条判定，都有真实后果】
 *   ① 事件与本页签/本项目无关 → 不理（否则切页签后会看到别人项目的数据冒出来）；
 *   ② 记录不属于本项目 / 不落在本表的子项 store → 不理（归属错位等于把别的书的设定写进来）；
 *   ③ 记录已经在本机列表里 → **不替换**（作者可能正在改它；覆盖等于吞掉刚敲的字）。
 *      所以这里只做"追加"判断，永远不返回"覆盖"。
 */

export interface WorldSetEventDetail {
  kind?: string
  projectId?: string
  tabId?: string
  cardId?: string
}

export type WorldSetEventDecision =
  | { accept: true; cardId: string }
  | { accept: false; reason: 'other-kind' | 'other-project' | 'other-tab' | 'no-card' }

export function decideWorldSetEvent(input: {
  detail: WorldSetEventDetail | null | undefined
  /** 当前打开的项目 */
  projectId: string | null
  /** 本 hook 所属的页签 */
  tabId: string
}): WorldSetEventDecision {
  const { detail } = input
  if (!detail || detail.kind !== 'world-set') return { accept: false, reason: 'other-kind' }
  if (detail.projectId !== input.projectId) return { accept: false, reason: 'other-project' }
  if (detail.tabId !== input.tabId) return { accept: false, reason: 'other-tab' }
  if (!detail.cardId) return { accept: false, reason: 'no-card' }
  return { accept: true, cardId: detail.cardId }
}

/**
 * 读回记录后：要不要并进当前列表。
 *
 * 🔴 只追加、不覆盖：本机已存在同 id 记录时保持原样（作者可能正在编辑它）。
 * @param expectedTabId 子项记录应归属的 store（调用方传 `subTabIdOf(tabId)`）
 */
export function shouldMergeWorldSetRecord(input: {
  record: { id: string; projectId?: string; tabId?: string } | null | undefined
  projectId: string | null
  expectedTabId: string
  existingIds: readonly string[]
}): boolean {
  const { record } = input
  if (!record) return false
  if (record.projectId !== input.projectId) return false
  if (record.tabId !== input.expectedTabId) return false
  return !input.existingIds.includes(record.id)
}
