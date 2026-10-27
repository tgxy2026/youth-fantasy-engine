/**
 * 编辑器「离页屏障」的跨模块通道（3.3.0 · UX06）。
 *
 * 【为什么需要】
 *   编辑器在深层组件里，`App` 拿不到它的实例；换页签 / 退出项目都是 `App` 直接
 *   `setActiveTab` / 清 `projectId`，编辑器只能靠**卸载时的异步冲刷**兜底。
 *   那条卸载链有两个致命性质：
 *     ① `flushEditorDraftNow()` 故意 `.catch(() => undefined)`（关窗兜底可以吞，离页不行）；
 *     ② 卸载已经发生 —— 就算这时知道写盘失败，页面和 DOM 都已经没了，作者无从重试。
 *   于是「正文存失败 → 仍然离页 → 界面看起来一切正常 → 重启发现少了一章」。
 *
 * 【做法】
 *   编辑器挂载时登记一个 **guard**（`isDirty` + `flush`），`App` 在真正切走之前先问它：
 *     · `isDirty()` 同步判定 —— 干净时**完全走原同步路径**，不给每次切页签加一次 await；
 *     · `flush()` 返回**成功/失败**，失败时 `App` 放弃跳转、留在当前页，草稿与 DOM 原样保留。
 *   不登记（没进编辑器）时一切照旧。
 *
 * 【与 draftFlush 的分工】
 *   `draftFlush` 服务**关窗**：只求「尽力发出去」，不能 await，失败也无处可报 —— 保持原样。
 *   本模块服务**离页**：必须知道成败，失败就**不走**。两者不要互相替代。
 */

/** 离页冲刷失败时，失败发生在哪一块（只用于给作者一句准确的话） */
export type LeaveScope = 'content' | 'meta' | 'record'

export type LeaveFlushResult =
  | { ok: true }
  | { ok: false; scope: LeaveScope; error: unknown }

export interface LeaveGuard {
  /** 是否还有没落库的东西（正文草稿 / 待冲刷的标题·摘要）。必须是同步判定。 */
  isDirty(): boolean
  /** 立刻把它们落库，并如实返回成败（不许吞异常冒充成功）。 */
  flush(): Promise<LeaveFlushResult>
}

let guard: LeaveGuard | null = null
const auxiliary = new Set<LeaveGuard>()
let auxiliaryRevision = 0

/** Side panes participate without replacing the editor's content/meta guard. */
export function registerAuxiliaryLeaveGuard(next: LeaveGuard): () => void {
  auxiliary.add(next); auxiliaryRevision++
  return () => { if (auxiliary.delete(next)) auxiliaryRevision++ }
}
function dirty(g: LeaveGuard): boolean {
  try { return g.isDirty() } catch { return true }
}
export function auxiliaryLeaveGuardDirty(): boolean {
  return [...auxiliary].some(dirty)
}
export async function runAuxiliaryLeaveGuards(): Promise<LeaveFlushResult> {
  const revision = auxiliaryRevision, snapshot = [...auxiliary]
  for (const g of snapshot) {
    if (dirty(g)) {
      try {
        const result = await g.flush()
        if (!result.ok) return result
      } catch (error) { return { ok: false, scope: 'record', error } }
    }
    if (revision !== auxiliaryRevision || dirty(g)) return { ok: false, scope: 'record', error: '设定编辑上下文或输入已改变，请重试。' }
  }
  // A later pane can yield long enough for input in an earlier pane to change.
  if (revision !== auxiliaryRevision || auxiliaryLeaveGuardDirty()) return { ok: false, scope: 'record', error: '设定仍有新输入，请重试。' }
  return { ok: true }
}

/** 登记 / 注销编辑器离页 guard（编辑器挂载时登记，卸载时注销） */
export function registerLeaveGuard(next: LeaveGuard | null): void {
  guard = next
}

export function hasLeaveGuard(): boolean {
  return guard !== null || auxiliary.size > 0
}

/**
 * 现在离页会不会丢东西。没有 guard（不在编辑器）⇒ false。
 * `isDirty()` 自己抛错时按「脏」处理：宁可在离页前多问一次，也不静默放过可能的丢稿。
 */
export function leaveGuardDirty(): boolean {
  const g = guard
  return (!!g && dirty(g)) || auxiliaryLeaveGuardDirty()
}

/**
 * 执行离页冲刷。
 * - 没有 guard、或已经干净 ⇒ 直接 `{ ok: true }`（调用方可以据此保持同步路径）；
 * - `flush` 抛错 ⇒ 转成 `{ ok: false }`，绝不向上抛（否则会打断调用方的导航逻辑）。
 */
export async function runLeaveGuard(): Promise<LeaveFlushResult> {
  const g = guard
  const auxiliaryResult = await runAuxiliaryLeaveGuards()
  if (!auxiliaryResult.ok) return auxiliaryResult
  if (g !== guard) return { ok: false, scope: 'record', error: '编辑页面已改变，请重试。' }
  if (!g) return { ok: true }
  if (!dirty(g)) return { ok: true }
  try {
    const result = await g.flush()
    if (result.ok && auxiliaryLeaveGuardDirty()) return { ok: false, scope: 'record', error: '设定仍有新输入，请重试。' }
    return result
  } catch (error) {
    return { ok: false, scope: 'content', error }
  }
}
