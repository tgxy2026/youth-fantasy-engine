/**
 * 落库 —— 把用户勾选的草稿行写进项目设定表。
 *
 * 🔴 三条红线（照做，别改）：
 *   1. **只写被勾选的行**。本函数不做任何"自动补全"或"顺手带上"。落库的唯一入口是用户的勾选。
 *   2. **绝不静默覆盖**。目标表已有同名条目时，按 `conflict` 策略处理，默认 `keep-existing`（分毫不动）。
 *   3. **只写目标表真实存在的键**。落点由 `fieldMap.resolveSlot` 产出；本层再兜一道（写前过滤掉
 *      不在列/模块里的键），避免 schema 改动后写出一列幽灵数据。
 *
 * 写入顺序：**表格型先、卡片型后**。卡片有指向其它表的引用列（「地理位置」→ 地理风物、
 * 「所属势力」→ 国家势力），先建被引用者，引用才不会落空。B2 若新增更深的引用链，在此扩展拓扑。
 */
import { readAliases } from '../aliases'
import { nextAutoCode } from '../autoCode'
import * as db from '../db'
import { uid } from '../id'
import { TABS } from '../schema'
import { normName } from '../settingLedger'
import { formFieldNames } from './formMap'
import type { CardRecord, TableRow } from '../types'
import type { CommitOutcome, DraftField, DraftRow } from './types'

/**
 * 已有同名条目时的处理方式：
 * - `keep-existing`（默认）已有条目一律不动 —— 最保守，符合「绝不静默覆盖」
 * - `fill-empty`    只补已有条目里的**空字段**，非空字段不碰
 * - `use-incoming`  用新值覆盖已有字段（危险操作，界面须二次确认）
 */
export type ConflictPolicy = 'keep-existing' | 'fill-empty' | 'use-incoming'

export interface CommitOptions {
  conflict?: ConflictPolicy
  /** 逐条进度回调（done 从 1 起） */
  onProgress?: (done: number, total: number, name: string) => void
  signal?: AbortSignal
}

/** 目标页签的真实列名集合（表格型）；卡片型走模块字段，另行处理 */
function columnNamesOf(tabId: string): Set<string> {
  const cols = TABS.find(t => t.id === tabId)?.columns ?? []
  return new Set(cols.map(c => c.name))
}

function isCardTab(tabId: string): boolean {
  return TABS.find(t => t.id === tabId)?.type === 'card'
}

/** 主名或别称命中目标名 */
function nameMatches(display: string, aliases: string[], target: string): boolean {
  const t = normName(target)
  if (!t) return false
  if (normName(display) === t) return true
  return aliases.some(a => normName(a) === t)
}

/** 卡片页签里该 `模块::字段` 键是否真实存在（防止 schema 改过之后写出一列幽灵数据） */
function cardFieldExists(tabId: string, key: string): boolean {
  const tab = TABS.find(t => t.id === tabId)
  if (!tab?.modules) return false
  const idx = key.indexOf('::')
  if (idx < 0) return false
  const modName = key.slice(0, idx)
  const fieldName = key.slice(idx + 2)
  return tab.modules.some(m => m.name === modName && m.fields.some(f => f.name === fieldName))
}

/** 草稿字段数组 → 存储用 Record（键已由 fieldMap 保证合法，这里只做取值） */
function fieldsToRecord(fields: DraftField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) if (f.value) out[f.key] = f.value
  return out
}

/** 把草稿字段过滤成「目标表真实存在的键」，并剔除「编号」（编号一律由 autoCode 生成，不接受外部值） */
function sanitizeFields(fields: DraftField[], allowed: (k: string) => boolean, skip: Set<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    if (!f.value) continue
    if (skip.has(f.key)) continue
    if (!allowed(f.key)) continue
    out[f.key] = f.value
  }
  return out
}

export async function commitDraftRows(rows: DraftRow[], opts: CommitOptions = {}): Promise<CommitOutcome> {
  const policy = opts.conflict ?? 'keep-existing'
  const out: CommitOutcome = { created: 0, updated: 0, failed: [] }
  const total = rows.length
  if (total === 0) return out

  // 表格型（rank 0）先写，卡片型（rank 1）后写
  const ordered = [...rows].sort((a, b) => Number(isCardTab(a.tabId)) - Number(isCardTab(b.tabId)))

  // per-tab 缓存：同一次批量里不复读全表；新建的行即时推入，保证后续判重能看到它
  const tableCache = new Map<string, TableRow[]>()
  const cardCache = new Map<string, CardRecord[]>()
  const tableRowsOf = async (tabId: string): Promise<TableRow[]> => {
    let v = tableCache.get(tabId)
    if (!v) { v = await db.getTableRows(tabId); tableCache.set(tabId, v) }
    return v
  }
  const cardRowsOf = async (tabId: string): Promise<CardRecord[]> => {
    let v = cardCache.get(tabId)
    if (!v) { v = await db.getCardRecords(tabId); cardCache.set(tabId, v) }
    return v
  }
  // 表单型：一份表一条记录（`projectId::tabId`），同批量内也不复读
  const formCache = new Map<string, Record<string, string>>()
  const formOf = async (tabId: string): Promise<Record<string, string>> => {
    let v = formCache.get(tabId)
    if (!v) { v = await db.getFormData(tabId).catch(() => ({} as Record<string, string>)); formCache.set(tabId, v) }
    return v
  }

  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]
    if (opts.signal?.aborted) break
    try {
      const tab = TABS.find(t => t.id === row.tabId)
      if (!tab) { out.failed.push(row.name); continue }

      if (tab.type === 'form') {
        // 表单型是**整项目单份**，没有"同名条目"这回事 —— 冲突策略直接作用在**字段**上：
        // · keep-existing / fill-empty：**只填空字段**（作者手改过的内容一律不动）
        // · use-incoming：覆盖（危险，界面须二次确认）
        // ⚠️ 这里刻意让 keep-existing 也填空：表单字段天生"存在但可能为空"，
        //    若按条目型那样"已存在就整条不动"，末尾汇总将永远写不进任何东西（功能静默失效）。
        const cur = await formOf(row.tabId)
        const allowed = formFieldNames(row.tabId)
        const next = { ...cur }
        let changed = false
        for (const f of row.fields) {
          if (!f.value) continue
          if (!allowed.has(f.label)) continue // 防幽灵字段（schema 改过名时）
          if (policy === 'use-incoming') {
            if ((next[f.key] ?? '') !== f.value) { next[f.key] = f.value; changed = true }
          } else if (!(next[f.key] ?? '').trim()) {
            next[f.key] = f.value
            changed = true
          }
        }
        if (changed) {
          await db.saveFormData(row.tabId, next)
          formCache.set(row.tabId, next)
          // 整份表原本一个字都没有 → 算"新建"；只是补了几个空字段 → 算"更新"
          if (Object.values(cur).some(v => (v ?? '').trim())) out.updated++
          else out.created++
        }
      } else if (tab.type === 'card') {
        const list = await cardRowsOf(row.tabId)
        const hit = list.find(r => nameMatches(r.name, readAliases(row.tabId, r.data), row.name))
        if (hit) {
          // 卡片字段键形如 `模块::字段`，合法性由 fieldMap 保证；此处只做跳过判定
          const next = { ...hit.data }
          let changed = false
          for (const f of row.fields) {
            if (!f.value) continue
            if (policy === 'use-incoming') { if (next[f.key] !== f.value) { next[f.key] = f.value; changed = true } }
            else if (policy === 'fill-empty' && !(next[f.key] ?? '').trim()) { next[f.key] = f.value; changed = true }
          }
          if (changed) { await db.saveCardRecord({ ...hit, data: next }); out.updated++ }
        } else {
          const existing = await db.getCardRecords(row.tabId)
          const rec: CardRecord = {
            id: uid(),
            projectId: db.getCurrentProjectId(),
            tabId: row.tabId,
            name: row.name,
            data: fieldsToRecord(row.fields.filter(f => cardFieldExists(row.tabId, f.key))),
            order: existing.length,
          }
          await db.saveCardRecord(rec)
          list.push(rec)
          out.created++
        }
      } else {
        const list = await tableRowsOf(row.tabId)
        const cols = columnNamesOf(row.tabId)
        const nameCol = cols.has('名称') ? '名称' : '事件名称'
        const hit = list.find(r => nameMatches(r.data[nameCol] ?? '', readAliases(row.tabId, r.data), row.name))
        if (hit) {
          const next = { ...hit.data }
          let changed = false
          for (const f of row.fields) {
            if (!f.value || f.key === '编号') continue
            if (!cols.has(f.key)) continue
            if (policy === 'use-incoming') { if (next[f.key] !== f.value) { next[f.key] = f.value; changed = true } }
            else if (policy === 'fill-empty' && !(next[f.key] ?? '').trim()) { next[f.key] = f.value; changed = true }
          }
          if (changed) { await db.saveTableRow({ ...hit, data: next, updatedAt: Date.now() }); out.updated++ }
        } else {
          const data: Record<string, string> = {}
          for (const col of tab.columns ?? []) data[col.name] = ''
          Object.assign(data, sanitizeFields(row.fields, k => cols.has(k), new Set(['编号'])))
          if (cols.has('编号')) data['编号'] = nextAutoCode(row.tabId, list)
          const newRow: TableRow = {
            id: uid(),
            projectId: db.getCurrentProjectId(),
            tabId: row.tabId,
            data,
            order: list.length,
            createdAt: Date.now(),
          }
          await db.saveTableRow(newRow)
          list.push(newRow)
          out.created++
        }
      }
    } catch {
      out.failed.push(row.name)
    }
    opts.onProgress?.(i + 1, total, row.name)
  }

  return out
}

/** 落库前预览：告诉用户「将新建 N 条 / 将更新 M 条 / 将跳过 K 条（已存在）」，确认后才落库 */
export interface CommitPreview {
  create: number
  update: number
  skip: number
  /**
   * 逐条明细（界面按目标表分组展示）。`action` 是**按当前冲突策略推算**的结果，
   * 与实际落库一致 —— 用户看到的与将要发生的对得上。
   */
  items: { name: string; tabId: string; tabName: string; action: 'create' | 'update' | 'skip' }[]
}

export async function previewCommit(rows: DraftRow[], conflict: ConflictPolicy = 'keep-existing'): Promise<CommitPreview> {
  const out: CommitPreview = { create: 0, update: 0, skip: 0, items: [] }
  for (const row of rows) {
    const tab = TABS.find(t => t.id === row.tabId)
    if (!tab) { out.skip++; out.items.push({ name: row.name, tabId: row.tabId, tabName: row.tabName, action: 'skip' }); continue }
    let exists = false
    try {
      if (tab.type === 'form') {
        // 表单型要预览的是"**有没有字段真会被写**"，而不是"有没有同名条目"——
        // 表单永远"存在"（它有默认值），按条目型那套判断会把每一张都算成"跳过"。
        const cur = await db.getFormData(row.tabId).catch(() => ({} as Record<string, string>))
        const allowed = formFieldNames(row.tabId)
        const fillable = row.fields.filter(f =>
          f.value && allowed.has(f.label) &&
          (conflict === 'use-incoming' ? (cur[f.key] ?? '') !== f.value : !(cur[f.key] ?? '').trim()))
        const anyFilled = Object.values(cur).some(v => (v ?? '').trim())
        const action: 'create' | 'update' | 'skip' =
          fillable.length === 0 ? 'skip' : anyFilled ? 'update' : 'create'
        out[action]++
        out.items.push({ name: row.name, tabId: row.tabId, tabName: row.tabName, action })
        continue
      }
      if (tab.type === 'card') {
        const list = await db.getCardRecords(row.tabId)
        exists = list.some(r => nameMatches(r.name, readAliases(row.tabId, r.data), row.name))
      } else {
        const cols = columnNamesOf(row.tabId)
        const nameCol = cols.has('名称') ? '名称' : '事件名称'
        const list = await db.getTableRows(row.tabId)
        exists = list.some(r => nameMatches(r.data[nameCol] ?? '', readAliases(row.tabId, r.data), row.name))
      }
    } catch { /* 读失败按不存在处理，落库时还会再判一次 */ }

    const action: 'create' | 'update' | 'skip' = !exists
      ? 'create'
      : conflict === 'keep-existing' ? 'skip' : 'update'
    out[action]++
    out.items.push({ name: row.name, tabId: row.tabId, tabName: row.tabName, action })
  }
  return out
}
