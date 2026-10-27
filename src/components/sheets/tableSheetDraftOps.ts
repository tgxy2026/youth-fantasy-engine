/**
 * 表格草稿（`drafts`）的纯函数（3.1.3 · 详情就地编辑）。
 *
 * 🔴 为什么单独成文件：`useTableSheetModel.ts` 已贴着 1200 行结构闸，
 *    草稿回滚逻辑塞进去就会超线；这里只放不依赖 React 的纯函数，顺带好写单测。
 *
 * 类型声明与 model 里的 `drafts` 同构：行 id → { 存储键: 值 }。
 */
import { saveTableRow } from '@/lib/db'
import type { TableRow } from '@/lib/types'
import { guardTabWrite, type TabWriteSource } from '@/lib/templates/migrationGuard'
import { captureStorageWriteOwner } from '@/lib/storage/writeOwner'

export type DraftMap = Record<string, Record<string, string>>

/**
 * 冲刷一批待保存草稿（切页签 / 卸载时的静默落库）。
 *
 * 🔴 迁移窗口内**整批跳过**（方案 §3.6）：旧结构的草稿灌进新结构会串字段，
 *    宁可这次不自动存，也不能写出一份没有任何界面能看出错了的数据。
 */
export async function flushDrafts(
  pid: string,
  tabId: string,
  rows: readonly TableRow[],
  drafts: DraftMap,
  source: TabWriteSource = 'autosave',
): Promise<boolean> {
  const owner = captureStorageWriteOwner(pid)
  if (await guardTabWrite(pid, tabId, source)) return false
  for (const rowId of Object.keys(drafts)) {
    if (!owner.current()) return false
    const orig = rows.find(r => r.id === rowId)
    if (orig) await saveTableRow({ ...orig, data: { ...orig.data, ...drafts[rowId] } })
  }
  return owner.current()
}

/**
 * 把某一行若干字段的草稿**回滚到给定的值**（详情面板「撤销本次改动」）。
 *
 * 语义只有两条：
 *   ① 给的值与该字段的**库值**一致 ⇒ 这个字段不再需要草稿，直接删掉；
 *   ② 不一致 ⇒ 写成给的值。
 *
 * 其它字段、其它行的草稿一律不动 —— 详情只能撤自己动过的那几栏，
 * 不能顺手把表格里其它未保存改动一起抹掉。
 *
 * @param baseData 该行的库值（`TableRow.data`），用于判断"是否已回到原样"
 * @returns 新的 drafts；没有任何字段真正被撤销时**原样返回**（避免无谓重渲染）
 */
export function revertDraftCells(
  drafts: DraftMap,
  baseData: Record<string, string>,
  rowId: string,
  values: Record<string, string>,
): DraftMap {
  const cur = drafts[rowId]
  if (!cur) return drafts

  const next: Record<string, string> = { ...cur }
  let changed = false
  for (const [k, v] of Object.entries(values)) {
    // 这一栏本来就没有草稿 ⇒ 撤销无事可做（别凭空造一条等值草稿出来）
    if (!(k in next)) continue
    changed = true
    if ((baseData[k] ?? '') === v) delete next[k]
    else next[k] = v
  }
  if (!changed) return drafts

  const out: DraftMap = { ...drafts }
  if (Object.keys(next).length === 0) delete out[rowId]
  else out[rowId] = next
  return out
}
