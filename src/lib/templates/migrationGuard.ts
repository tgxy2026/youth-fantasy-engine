/**
 * 3.2.0 · WT1-4：模板迁移期间的**写入隔离**（草稿 / 自动保存 / 在途 AI 回填）
 *
 * 方案 §3.6 原文：
 *   > 迁移期间阻止旧编辑草稿、自动保存和已在途 AI 结果回填该页签；
 *   > 它们返回明确冲突，不把旧草稿悄悄冲刷进新结构。
 *
 * 🔴 为什么"明确冲突"不是"静默丢弃"：
 *   静默丢弃会让作者以为改动丢了（其实是他自己没保存），而静默写入更糟 ——
 *   旧字段 id 的值会灌进新结构，字段一改义就变成"张冠李戴"的脏数据，
 *   且没有任何界面能看出它错了。冲突是唯一能让人**做决定**的形态。
 *
 * 🔴 两级判据（缺一不可）：
 *   ① 内存锁：迁移正在本进程跑 ⇒ 同步就能拦住（自动保存是异步连发的，等一次 IO 太晚）；
 *   ② 持久日志：进程重启后内存锁没了，但 `prepared` / `writing` / `rollback-failed`
 *      的日志还在 ⇒ 作者一开机就编辑，同样必须拦住。
 */
import { loadMigrationLog, isBlockingState, type MigrationState } from './migrationLog'

/** 会被旧结构污染的写入来源 */
export type TabWriteSource = 'draft' | 'autosave' | 'ai-writeback' | 'import'

export interface MigrationTabConflict {
  blocked: true
  code: 'tab-in-migration'
  tabId: string
  source: TabWriteSource
  state: MigrationState | 'locked'
  /** 给作者看的一句话（说清"发生了什么"，不 blame 用户） */
  message: string
  /** 现在能做什么 —— 不许写"稍后重试"这种空话 */
  hint: string
}

// ────────────────────────── 内存锁 ──────────────────────────

const active = new Set<string>()
const subs = new Set<() => void>()

function keyOf(pid: string, tabId: string): string {
  return `${pid}::${tabId}`
}

function emit(): void {
  subs.forEach(fn => {
    try { fn() } catch { /* 订阅方异常不该影响迁移本身 */ }
  })
}

/**
 * 占住一个页签（迁移执行期间调用）。返回值是**释放函数**（务必 finally）。
 *
 * 🔴 释放函数做成一次性：嵌套/重复调用不会把别人的锁解开 ——
 *    迁移失败路径很多，逐个分支写 `end()` 必漏一处，锁漏解就是"这个页签永远不能编辑"。
 */
export function beginTabMigrationLock(pid: string, tabId: string): () => void {
  const k = keyOf(pid, tabId)
  active.add(k)
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    active.delete(k)
    emit()
  }
}

export function isTabMigrationActive(pid: string, tabId: string): boolean {
  return active.has(keyOf(pid, tabId))
}

/** 是否有任何页签正在迁移（全局维护态：界面可据此显示"迁移中"横幅） */
export function isAnyTabMigrationActive(): boolean {
  return active.size > 0
}

/**
 * 当前正在迁移的页签 id（可按项目过滤）。
 *
 * 为什么要"点名"：只说「有页签正在迁移」作者无从判断该等哪个页签 ——
 * 他可能正在另一个页签里反复试保存，以为是自己写坏了。横幅必须点出页签名。
 */
export function activeMigrationTabIds(pid?: string): string[] {
  const out: string[] = []
  for (const k of active) {
    const sep = k.indexOf('::')
    if (sep < 0) continue
    const kPid = k.slice(0, sep)
    if (!pid || kPid === pid) out.push(k.slice(sep + 2))
  }
  return out
}

export function subscribeMigrationLock(fn: () => void): () => void {
  subs.add(fn)
  return () => { subs.delete(fn) }
}

// ────────────────────────── 冲突 ──────────────────────────

const MESSAGE: Record<TabWriteSource, string> = {
  draft: '该页签正在更换模板，旧结构下的草稿没有恢复进来 —— 直接灌进新结构会串字段。',
  autosave: '该页签正在更换模板，本次自动保存已取消（改动仍在编辑器里，没有丢）。',
  'ai-writeback': '该页签正在更换模板，这批 AI 填写结果没有写回 —— 它们出自旧模板的字段清单。',
  import: '该页签正在更换模板，本次导入已取消。',
}

const HINT: Record<TabWriteSource, string> = {
  draft: '等迁移结束后重新打开该页签；若迁移中断，先按提示完成恢复，再恢复草稿。',
  autosave: '等迁移完成后手动保存一次（Ctrl/Cmd+S），确认改动落在新结构上。',
  'ai-writeback': '等迁移完成后重新发起这批填写 —— 新模板的字段清单才是这次该用的。',
  import: '等迁移完成后再导入；导入的是整行数据，中途写入会让新旧结构混在一行里。',
}

function conflictOf(
  tabId: string,
  source: TabWriteSource,
  state: MigrationState | 'locked',
): MigrationTabConflict {
  return {
    blocked: true,
    code: 'tab-in-migration',
    tabId,
    source,
    state,
    message: MESSAGE[source],
    hint: HINT[source],
  }
}

/** 只看内存锁（同步；自动保存这种高频路径先查它，避免每 2 秒一次 IO） */
export function localMigrationConflict(
  pid: string,
  tabId: string,
  source: TabWriteSource,
): MigrationTabConflict | null {
  return isTabMigrationActive(pid, tabId) ? conflictOf(tabId, source, 'locked') : null
}

/**
 * 完整判据：内存锁 → 持久日志（阻断态）。
 *
 * @returns `null` = 可以写；否则是必须原样交给界面的冲突对象。
 */
export async function guardTabWrite(
  pid: string,
  tabId: string,
  source: TabWriteSource,
): Promise<MigrationTabConflict | null> {
  const local = localMigrationConflict(pid, tabId, source)
  if (local) return local
  if (!pid || !tabId) return null
  const log = await loadMigrationLog(pid, tabId)
  if (log && isBlockingState(log.state)) return conflictOf(tabId, source, log.state)
  return null
}

/** 状态的可读说法（界面 / 报告复用一处，避免各写一套词） */
export function migrationStateLabel(state: MigrationState): string {
  switch (state) {
    case 'prepared': return '已备份，尚未写入'
    case 'writing': return '正在写入'
    case 'done': return '已完成'
    case 'done-partial': return '结构已切换，但有条目需人工处理'
    case 'rolled-back': return '已恢复到迁移前'
    case 'rollback-failed': return '恢复未完成，需要人工处理'
    default: return '未知状态'
  }
}
