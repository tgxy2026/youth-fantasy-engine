// ============ 同名字段修复（3.7.6 · P3） ============
//
// 背景：作者给图鉴页签新增了一个「名称类」自定义字段，把新条目的名字写进它，
//       内置「名称」列留空 —— 于是同一条记录有两套名字（老数据在内置、新数据在自定义）。
//       设定检索在 P1 之后能正确取到名字，但两套值仍并存，作者自己也会分不清哪个是准的。
//
// 🔴 两条硬约束：
//   1. **只追加不覆盖**：内置列已经有值时绝不用自定义值去覆盖（那是作者的手稿，不是脏数据）；
//   2. **不删数据**：合并的唯一手段是「归档该自定义字段」（定义与值都留着，只是不再显示 / 不再参与索引）。
//      真要删值走字段面板的「永久删除」（它自带备份与引用检查）。
//
// 写库顺序：先写行（值已进内置列）→ 再归档字段。反过来一旦归档成功、写行失败，
// 值就只剩在一个不再显示的字段里，作者会以为丢了。
import * as db from '@/lib/db'
import { getCurrentProjectId } from '@/lib/db/core'
import { loadAtlasSchema, saveAtlasSchema } from '@/lib/atlas/persistence'
import { backupBeforeAtlasFieldChange } from '@/lib/atlas/fieldOps'
import type { AtlasTabId } from '@/lib/atlas/types'

export interface DuplicateNameFixArgs {
  tabId: string
  rowId: string
  /** 保留键（内置名称列） */
  keepKey: string
  /** 要归档的自定义字段键（`cf_*`） */
  dropKey: string
  /**
   * `fill-and-archive`：内置为空 → 把自定义值写进内置，再归档自定义字段；
   * `archive-only`：两边都有值 → 只归档自定义字段（保留值，不覆盖内置）。
   */
  mode: 'fill-and-archive' | 'archive-only'
}

export interface DuplicateNameFixResult {
  /** 是否把值写进了内置列 */
  filled: boolean
  /** 是否归档了自定义字段 */
  archived: boolean
}

/** 归档一个自定义字段（定义与已填值都保留，只是不再显示 / 不参与检索与 AI） */
async function archiveCustomField(projectId: string, tabId: string, fieldId: string): Promise<boolean> {
  const loaded = await loadAtlasSchema(projectId, tabId as AtlasTabId)
  if (loaded.error) throw new Error(`字段配置读取失败，已拒绝修改：${loaded.error}`)
  const config = loaded.config
  if (!config) throw new Error('没有找到该页签的字段配置')
  const field = config.fields.find(f => f.id === fieldId)
  if (!field) return false
  if (field.archived) return true
  await saveAtlasSchema(projectId, tabId as AtlasTabId, {
    ...config,
    fields: config.fields.map(f => (f.id === fieldId ? { ...f, archived: true } : f)),
  })
  return true
}

export async function fixDuplicateNameField(args: DuplicateNameFixArgs): Promise<DuplicateNameFixResult> {
  const projectId = getCurrentProjectId()
  if (!projectId) throw new Error('当前没有打开项目')

  const rows = await db.getTableRows(args.tabId)
  const row = rows.find(r => r.id === args.rowId)
  if (!row) throw new Error('这一行已经不存在（可能被删除或同步覆盖），未做任何改动')

  const keepNow = (row.data[args.keepKey] ?? '').trim()
  const dropNow = (row.data[args.dropKey] ?? '').trim()
  if (!dropNow) {
    // 自定义值已被别处清空：只剩归档这件事可做
    await backupBeforeAtlasFieldChange(projectId, `合并同名字段 · ${args.tabId}`)
    const archived = await archiveCustomField(projectId, args.tabId, args.dropKey)
    return { filled: false, archived }
  }
  if (args.mode === 'fill-and-archive' && keepNow) {
    throw new Error(`「${args.keepKey}」已经有值了，不会覆盖；如确认以它为准，请改用「归档该字段」`)
  }

  await backupBeforeAtlasFieldChange(projectId, `合并同名字段 · ${args.tabId}`)

  let filled = false
  if (args.mode === 'fill-and-archive') {
    const next = { ...row, data: { ...row.data, [args.keepKey]: dropNow } }
    await db.saveTableRow(next)
    filled = true
  }

  const archived = await archiveCustomField(projectId, args.tabId, args.dropKey)
  return { filled, archived }
}
