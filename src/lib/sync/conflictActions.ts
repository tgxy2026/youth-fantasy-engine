/**
 * 同步冲突面板的判定与文案（3.6.1 · B2 从 `SyncConflictCenter` 抽出）。
 *
 * 【为什么抽】冲突面板里真正会伤到作者的是三件事：
 *   ① 「恢复云端那一版」按钮**什么时候能点**（本地/云端已删、跨项目时点了必然失败）；
 *   ② 点不了的时候**必须说清为什么**（否则作者只会去点「删除副本」，把唯一的云端留档丢掉）；
 *   ③ 删除副本**必须先确认**，且说清"永久删除"与"建议先导出"。
 * 这些原先散在组件里，测不了。抽成纯函数后逐条钉住，组件只负责渲染与调用。
 *
 * 🔴 判定顺序与 3.1.1 起的实现**逐条一致**（先类型、再云端、再本机、最后项目归属）：
 *    顺序换了会改变提示文案，等于改用户可见行为。
 */
import { conflictStoreLabel } from '@/lib/sync/conflictView'

/** JSON 预览最多显示多少字符（超出提示"导出文件含完整内容"） */
export const CONFLICT_PREVIEW_LIMIT = 20000

export interface ConflictLike {
  store: string
  /** 主键：存储层里是 unknown（历史数据可能是数字），显示时统一 String() */
  key: unknown
  server?: unknown
  local?: unknown
}

/** 列表里的一行标题：优先用云端那版的 title/name，其次本机，最后退回主键 */
export function conflictLabel(c: ConflictLike): string {
  const row = (c.server && typeof c.server === 'object' ? c.server : c.local) as { title?: unknown; name?: unknown } | null
  const name = row?.title ?? row?.name ?? c.key
  return `${conflictStoreLabel(c.store)} · ${String(name ?? '未知记录')}`
}

/** 单侧内容预览（null 说人话；超长截断并告知导出文件里有完整内容） */
export function conflictPreview(value: unknown, limit = CONFLICT_PREVIEW_LIMIT): string {
  if (value == null) return '此侧已删除或没有该记录'
  const text = JSON.stringify(value, null, 2)
  return text.length > limit ? `${text.slice(0, limit)}\n…预览已截断，导出文件包含完整内容` : text
}

export type ConflictRestoreDecision =
  | { allowed: true }
  /** 不能原位恢复时必须给出原因（不能只是把按钮藏掉） */
  | { allowed: false; reason: string }

/**
 * 能不能「恢复云端那一版」。
 * 条件与 `db/syncConflicts.ts` 的前置校验逐条对齐：
 * 章节冲突 + 云端版还在 + 本机章还在 + 属当前项目。
 */
export function decideConflictRestore(c: ConflictLike, currentProjectId: string | null): ConflictRestoreDecision {
  if (c.store !== 'chapters') {
    return { allowed: false, reason: '此类型暂不支持安全的原位恢复。导出双方完整数据后，可在对应项目中手工核对。' }
  }
  if (c.server == null) {
    return { allowed: false, reason: '云端已删除这一章，没有可恢复的云端版本；如需保留本机内容，请先导出双方完整数据。' }
  }
  if (c.local == null) {
    return { allowed: false, reason: '本机已删除这一章，无法原位恢复；如需云端版本，请先导出双方完整数据后手工核对。' }
  }
  const owner = (c.server as { projectId?: string }).projectId
  if (currentProjectId !== owner) {
    return { allowed: false, reason: '该冲突属于其它项目，请打开对应项目后再恢复（当前只能导出或删除副本）。' }
  }
  return { allowed: true }
}

/** 选中项回退：当前选中的记录被筛掉后，落到筛选结果的第一条（没有就清空） */
export function pickConflictSelection(list: readonly { metaKey: string }[], selected: string | null): string | null {
  if (selected && list.some(item => item.metaKey === selected)) return selected
  return list[0]?.metaKey ?? null
}

export interface ConflictPrompt {
  title: string
  message: string
  confirmText: string
  danger: boolean
}

/** 恢复前的二次确认文案（说清会建备份、备份失败就不覆盖） */
export function conflictRestorePrompt(c: ConflictLike): ConflictPrompt {
  return {
    title: '恢复云端那一版章节',
    message: `将用冲突副本覆盖当前章节「${conflictLabel(c)}」。操作前会自动建立一份完整项目备份；备份失败时不会覆盖。请确认已查看双方内容。`,
    confirmText: '建立备份并恢复',
    danger: true,
  }
}

/** 删除副本前的二次确认文案（🔴 不可逆，必须说清"永久删除"与"建议先导出"） */
export function conflictDeletePrompt(c: ConflictLike): ConflictPrompt {
  return {
    title: '删除冲突副本',
    message: `将永久删除「${conflictLabel(c)}」的双方冲突记录。建议先导出副本，再删除。`,
    confirmText: '删除副本',
    danger: true,
  }
}
