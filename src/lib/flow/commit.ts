/**
 * 落库 —— 把用户勾选的草稿行写进项目设定表。
 *
 * 🔴 三条红线（照做，别改）：
 *   1. **只写被勾选的行**。本函数不做任何"自动补全"或"顺手带上"。落库的唯一入口是用户的勾选。
 *   2. **绝不静默覆盖**。目标表已有同名条目时，按 `conflict` 策略处理，默认 `keep-existing`（分毫不动）。
 *   3. **只写目标表真实存在的键**。落点由 `fieldMap.resolveSlot` 产出；本层再兜一道（写前过滤掉
 *      不在列/模块里的键），避免 schema 改动后写出一列幽灵数据。
 *
 * 🔴 「同一条」怎么认，有**两条路径**（别只想着第一条）：
 *   1. 有「名称」列的表 → 按名称 / 别称匹配（绝大多数表走这条）；
 *   2. **没有「名称」列的表**（人物关系 / 势力关系）→ 按草稿行声明的 `dedupKeys` 列值组合匹配。
 *      2.7.2 起配对表是**有向对**且判重键含「关系类型」（A→B 与 B→A、以及同对不同类型都算不同关系）。
 *   第 2 条是 2026-09-19 补的：关系不是"条目"，它没有名字，`名称` 这个键在表里压根不存在 ——
 *   缺了它，判重恒判"不存在"，作者在草稿页点两次「写入项目」就登记两条同样的关系。
 *
 * 写入顺序：**表格型先、卡片型后**。卡片有指向其它表的引用列（「地理位置」→ 地理风物、
 * 「所属势力」→ 国家势力），先建被引用者，引用才不会落空。B2 若新增更深的引用链，在此扩展拓扑。
 */
import { readAliases } from '../aliases'
import { isDirectedPairTab } from '../aiScope'
import { nextAutoCode } from '../autoCode'
import * as db from '../db'
import { uid } from '../id'
import { TABS } from '../schema'
import { isParallelSetTab } from '../worldSets'
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

/**
 * 「按列组合判重」用的键值：把指定列的值归一化后拼成一串。
 * `unordered` 为真时把值**排序后**再拼 —— A-B 与 B-A 视为同一条。
 * 🔴 2.7.2 起人物关系 / 势力关系是**有向对**（`!isDirectedPairTab` 为假）⇒ 不再排序，
 *    反向即视为两条不同关系（视角不同）。
 */
function dedupKeyOf(data: Record<string, string>, keys: string[], unordered: boolean): string {
  const vals = keys.map(k => normName(data[k] ?? ''))
  if (unordered) vals.sort()
  return vals.join('||')
}

/** 草稿字段 → 同名字典（与已有行的 `data` 同形，便于用同一套判重键比对） */
function fieldRecordOf(fields: DraftField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) out[f.key] = f.value
  return out
}

/**
 * 表格型草稿在已有行里找「同一条」。两条路径：
 *
 * - **有「名称」列**（绝大多数表）→ 按名称 / 别称匹配（原有行为，未改）
 * - **没有「名称」列**（人物关系 / 势力关系这类）→ 按 `row.dedupKeys` 的列值组合匹配，
 *   配对表为**有向对**（2.7.2 起，A→B 与 B→A 是两条），且判重键含「关系类型」。
 *
 * 🔴 第二条路径为什么必要：关系不是"条目"，它没有名字，`名称` 这个键在表里压根不存在。
 *    旧代码于是恒判"不存在"→ 作者在草稿页点两次「写入项目」就登记两条同样的关系
 *    （图谱里随即多一条重复边）。没声明 `dedupKeys` 的行仍返回 undefined（不判重，
 *    与旧行为一致 —— 不会因为这次改动反而变得更激进）。
 */
function findTableHit(list: TableRow[], row: DraftRow, cols: Set<string>, nameCol: string): TableRow | undefined {
  if (cols.has(nameCol)) {
    return list.find(r => nameMatches(r.data[nameCol] ?? '', readAliases(row.tabId, r.data), row.name))
  }
  const keys = (row.dedupKeys ?? []).filter(k => cols.has(k))
  if (keys.length === 0) return undefined
  const unordered = !isDirectedPairTab(row.tabId)
  const want = dedupKeyOf(fieldRecordOf(row.fields), keys, unordered)
  // 键值全空时**不判重** —— 否则所有"关键列没填"的行会互相当成同一条，第一条之后全被跳过
  if (!want.replace(/\|/g, '').trim()) return undefined
  return list.find(r => dedupKeyOf(r.data, keys, unordered) === want)
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
  //
  // 🔴 2026-10-03 六维审计 P1：这里**不许把读失败吞成 `{}`**。落库写的是 `{...cur, 本次草稿}`，
  //    而 `saveFormData` 是**整份覆盖** —— 读失败时给 `{}` 等于拿一份只剩草稿字段的新对象
  //    盖掉作者手填的整张表（作品信息 / 全书总纲 / 写作规范…），界面还报「已更新 N 条」。
  //    读不出来就让它抛，由下面的 catch 如实记进 `out.failed`，这一行一个字都不写。
  const formCache = new Map<string, Record<string, string>>()
  const formOf = async (tabId: string): Promise<Record<string, string>> => {
    let v = formCache.get(tabId)
    if (!v) { v = await db.getFormData(tabId); formCache.set(tabId, v) }
    return v
  }

  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]
    if (opts.signal?.aborted) break
    try {
      const tab = TABS.find(t => t.id === row.tabId)
      if (!tab) { out.failed.push(row.name); continue }

      if (tab.type === 'form') {
        // 🔴 2026-10-02（2.7.2 并列结构）：制度四页签（政治 / 经济基础 / 宗教信仰 / 司法制度）
        //    在 schema 里也是 `type:'form'`，但它们**没有母级 formData** —— 读取侧
        //    （aiContext / exporter / ParallelSetSheet）走的全是「条目」（`cardRecords` 的 `<tabId>-sub`）。
        //    所以这里**不能**走下面的 saveFormData（那会写进一个永不被读的黑洞）。
        //    ⇒ 改成写条目：`formDraftRows` 已把模型的多套拆成「一行一套」（行名＝主体名 魏/蜀/吴）。
        if (isParallelSetTab(row.tabId)) {
          const data: Record<string, string> = {}
          const allowedP = formFieldNames(row.tabId)
          let anyP = false
          for (const f of row.fields) {
            if (!f.value || !allowedP.has(f.label)) continue
            data[f.key] = f.value
            anyP = true
          }
          if (!anyP) { out.failed.push(`${row.name}（没有可落库的字段）`); continue }
          const setName = row.name.trim() || `${tab.name}汇总`
          // 🔴 读失败不再降级成 `[]`（2026-10-03 六维审计 P2）：那会把「读不出来」当成
          //    「一条都没有」⇒ 判重落空 ⇒ 同名条目被**再建一条**。读不出来就抛，由外层记入 failed。
          const existing = await db.getSubSets(row.tabId)
          const hit = existing.find(s => s.name === setName)
          if (hit) {
            // 同名条目：按冲突策略合并（fill-empty / keep-existing 只填空，use-incoming 覆盖）
            const nextData = { ...(hit.data ?? {}) }
            let changed = false
            for (const [k, v] of Object.entries(data)) {
              if (policy === 'use-incoming') {
                if ((nextData[k] ?? '') !== v) { nextData[k] = v; changed = true }
              } else if (!(nextData[k] ?? '').trim()) {
                nextData[k] = v
                changed = true
              }
            }
            if (changed) {
              await db.saveSubSet(row.tabId, { ...hit, data: nextData })
              out.updated++
            }
          } else {
            // 新条目：落库 + 设为活跃（作者能看到它、也会随 AI 上下文发出去）
            const rec = { id: uid(), projectId: '', tabId: `${row.tabId}-sub`, name: setName, data, order: existing.length }
            await db.saveSubSet(row.tabId, rec)
            await db.setSubActive(row.tabId, rec.id, true)
            out.created++
          }
          continue
        }
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
        const hit = findTableHit(list, row, cols, nameCol)
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
        // 🔴 与 commitDraftRows 同规则（2026-10-02）：并列结构页签落点是「条目」而不是 formData，
        //    预览必须按同一套判据算「新建 / 更新 / 跳过」，否则界面数字与实际落库不符。
        if (isParallelSetTab(row.tabId)) {
          const allowedP = formFieldNames(row.tabId)
          const fieldsP = row.fields.filter(f => f.value && allowedP.has(f.label))
          if (fieldsP.length === 0) {
            out.skip++
            out.items.push({ name: row.name, tabId: row.tabId, tabName: row.tabName, action: 'skip' })
            continue
          }
          const setName = row.name.trim() || `${tab.name}汇总`
          const listP = await db.getSubSets(row.tabId).catch(() => [])
          const hitP = listP.find(s => s.name === setName)
          let actionP: 'create' | 'update' | 'skip' = 'create'
          if (hitP) {
            const curD = hitP.data ?? {}
            const willFill = fieldsP.some(f =>
              conflict === 'use-incoming'
                ? (curD[f.key] ?? '') !== f.value
                : !(curD[f.key] ?? '').trim())
            actionP = willFill ? 'update' : 'skip'
          }
          out[actionP]++
          out.items.push({ name: row.name, tabId: row.tabId, tabName: row.tabName, action: actionP })
          continue
        }
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
        // 与落库走**同一个** findTableHit，保证「预览说的」与「实际发生的」一致
        exists = !!findTableHit(list, row, cols, nameCol)
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
