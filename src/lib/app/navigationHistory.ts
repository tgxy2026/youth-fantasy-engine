/**
 * 「来源上下文」：从 A 页跳到 B 页时，记住 A 在哪，好给作者一个明确的返回入口（UX05）。
 *
 * 【为什么要单独一层】
 *   返回不是浏览器历史 —— 侧栏随便点两下不应该堆出一串栈。只有**关联跳转**才算来源：
 *   正文里点「提及的章节」、角色页点「在哪章出现」、表格引用点某条记录。
 *   这类跳转的共同点是「作者是为了看某个具体东西才离开当前页」，看完想回原位。
 *
 * 【红线】
 *   · **有界**：最多 `HISTORY_LIMIT` 条，超了丢最旧的；只存路由 ID 与短标签，绝不存正文/草稿。
 *   · **不重复**：与栈顶同一目标不重复入栈；从 A 跳 A 不记。
 *   · **标签安全**：标签只用于按钮上那行字，去掉控制字符、截断上限，不参与任何键值。
 *   · **一次性**：`pop()` 取走即出栈；跳转失败时由调用方决定是否 `restore()` 放回。
 */
import type { WorkspaceTarget } from './navigation'

/** 返回栈深度上限：够覆盖「正文→角色→设定」这类连续查找，又不至于堆成一串 */
export const HISTORY_LIMIT = 8
const MAX_LABEL = 60

const cleanId = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : null

/** 只留可读的一行字：去控制字符、压空白、截断；空串回落到「上一页」 */
export function sanitizeLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat
}

export interface HistoryEntry { target: WorkspaceTarget; label: string }

/** 同一目标的比较键（章 / 行目标参与比较，缺省与空串等价） */
export function targetKey(target: WorkspaceTarget): string {
  return [target.tabId, target.chapterId ?? '', target.rowId ?? ''].join('\u0001')
}

export function normalizeEntry(target: WorkspaceTarget, label: unknown): HistoryEntry | null {
  const tabId = cleanId(target?.tabId)
  if (!tabId) return null
  const chapterId = target.chapterId == null ? undefined : cleanId(target.chapterId)
  const rowId = target.rowId == null ? undefined : cleanId(target.rowId)
  if (target.chapterId != null && !chapterId) return null
  if (target.rowId != null && !rowId) return null
  // 与 parseWorkspaceTarget 同一条路由约束：章目标只属于正文页，行目标只属于表格/卡片页
  if (chapterId && tabId !== 'editor') return null
  if (rowId && tabId === 'editor') return null
  return { target: { tabId, ...(chapterId ? { chapterId } : {}), ...(rowId ? { rowId } : {}) }, label: sanitizeLabel(label) }
}

export function createNavigationHistory(limit = HISTORY_LIMIT) {
  let entries: HistoryEntry[] = []
  const listeners = new Set<() => void>()
  const notify = () => { for (const fn of [...listeners]) { try { fn() } catch { /* 监听器异常不能影响导航 */ } } }

  const trim = () => { if (entries.length > limit) entries = entries.slice(entries.length - limit) }

  return {
    /** 深拷贝，调用方改不坏内部状态 */
    list: (): HistoryEntry[] => entries.map(entry => ({ ...entry, target: { ...entry.target } })),
    size: () => entries.length,
    top: (): HistoryEntry | null => {
      const last = entries[entries.length - 1]
      return last ? { ...last, target: { ...last.target } } : null
    },
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    /**
     * 记下「我要离开的原位」。
     * `from` 是跳转发生时作者所在的页面：与目标相同就不记（从 A 跳 A 没有返回意义）。
     */
    push(from: WorkspaceTarget, label: unknown): boolean {
      const fromEntry = normalizeEntry(from, label)
      if (!fromEntry) return false
      const top = entries[entries.length - 1]
      if (top && targetKey(top.target) === targetKey(fromEntry.target)) return false
      entries.push(fromEntry)
      trim()
      notify()
      return true
    },
    /** 取走栈顶（点击返回时调用）；失败可用 `restore` 放回去 */
    pop(): HistoryEntry | null {
      const entry = entries.pop() ?? null
      if (entry) notify()
      return entry
    },
    restore(entry: HistoryEntry) {
      const normalized = normalizeEntry(entry.target, entry.label)
      if (!normalized) return
      entries.push(normalized)
      trim()
      notify()
    },
    clear() {
      if (!entries.length) return
      entries = []
      notify()
    },
  }
}

export type NavigationHistory = ReturnType<typeof createNavigationHistory>
