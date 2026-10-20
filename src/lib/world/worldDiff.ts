// ============ C1 封存版本差异查看 · 世界差异 ============
// 2026-10-20 · 方案 §10.1 / C1 (3.2.x)
//
// 🔴 本文件是纯业务逻辑，不 import 任何 UI。
//    它负责：
//    ① 同世界、ID 连续的版本按 (tabId, kind, row.id) 对齐
//    ② 新增/删除/修改条目及字段前后值
//    ③ 忽略时间戳、项目来源等非语义字段
//    ④ 同指纹显示内容一致

// ============ 世界版本条目 ============
export interface WorldVersionEntry {
  /** 表 ID */
  tabId: string
  /** 条目类型 */
  kind: string
  /** 行 ID */
  rowId: string
  /** 名称 */
  name: string
  /** 字段值 */
  fields: Record<string, unknown>
  /** 内容指纹 */
  contentFingerprint: string
  /** 活跃状态 */
  active: boolean
}

// ============ 差异类型 ============
export type WorldDiffKind = 'added' | 'removed' | 'modified' | 'unchanged'

// ============ 字段差异 ============
export interface FieldDiff {
  /** 字段名 */
  fieldName: string
  /** 旧值 */
  oldValue?: unknown
  /** 新值 */
  newValue?: unknown
  /** 是否变化 */
  changed: boolean
}

// ============ 条目差异 ============
export interface EntryDiff {
  /** 表 ID */
  tabId: string
  /** 条目类型 */
  kind: string
  /** 行 ID */
  rowId: string
  /** 名称 */
  name: string
  /** 差异类型 */
  diffKind: WorldDiffKind
  /** 字段差异 */
  fieldDiffs: FieldDiff[]
  /** 活跃状态变化 */
  activeChanged: boolean
  /** 旧活跃状态 */
  oldActive?: boolean
  /** 新活跃状态 */
  newActive?: boolean
}

// ============ 版本差异结果 ============
export interface WorldVersionDiff {
  /** 旧版本 ID */
  oldVersionId: string
  /** 新版本 ID */
  newVersionId: string
  /** 条目差异 */
  entryDiffs: EntryDiff[]
  /** 新增条目数 */
  addedCount: number
  /** 删除条目数 */
  removedCount: number
  /** 修改条目数 */
  modifiedCount: number
  /** 未变化条目数 */
  unchangedCount: number
}

// ============ 非语义字段（忽略） ============
const NON_SEMANTIC_FIELDS = new Set([
  'updatedAt',
  'createdAt',
  'projectSource',
  'sourceProject',
  'importedAt',
  'version',
])

/** 是否应忽略该字段 */
function shouldIgnoreField(fieldName: string): boolean {
  return NON_SEMANTIC_FIELDS.has(fieldName)
}

/** 计算内容指纹（简化版） */
function computeFingerprint(entry: WorldVersionEntry): string {
  const fields = Object.entries(entry.fields)
    .filter(([k]) => !shouldIgnoreField(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join('|')
  return fields
}

/** 对齐两个版本的条目 */
function alignEntries(
  oldEntries: WorldVersionEntry[],
  newEntries: WorldVersionEntry[],
): Map<string, { old: WorldVersionEntry | undefined; new: WorldVersionEntry | undefined }> {
  const aligned = new Map<string, { old: WorldVersionEntry | undefined; new: WorldVersionEntry | undefined }>()

  // 按 (tabId, kind, row.id) 对齐
  const oldMap = new Map<string, WorldVersionEntry>()
  const newMap = new Map<string, WorldVersionEntry>()

  for (const e of oldEntries) {
    const key = `${e.tabId}|${e.kind}|${e.rowId}`
    oldMap.set(key, e)
  }
  for (const e of newEntries) {
    const key = `${e.tabId}|${e.kind}|${e.rowId}`
    newMap.set(key, e)
  }

  // 合并
  for (const [key, entry] of oldMap) {
    aligned.set(key, { old: entry, new: newMap.get(key) })
  }
  for (const [key, entry] of newMap) {
    if (!aligned.has(key)) {
      aligned.set(key, { old: undefined, new: entry })
    }
  }

  return aligned
}

/** 比较两个字段值 */
function compareFieldValues(oldVal: unknown, newVal: unknown): boolean {
  return JSON.stringify(oldVal) === JSON.stringify(newVal)
}

/** 比较两个条目的字段差异 */
function compareEntryFields(
  oldEntry: WorldVersionEntry,
  newEntry: WorldVersionEntry,
): FieldDiff[] {
  const allFields = new Set([
    ...Object.keys(oldEntry.fields),
    ...Object.keys(newEntry.fields),
  ])

  const diffs: FieldDiff[] = []
  for (const field of allFields) {
    if (shouldIgnoreField(field)) continue

    const oldVal = oldEntry.fields[field]
    const newVal = newEntry.fields[field]

    if (oldVal === undefined && newVal !== undefined) {
      diffs.push({ fieldName: field, oldValue: undefined, newValue: newVal, changed: true })
    } else if (oldVal !== undefined && newVal === undefined) {
      diffs.push({ fieldName: field, oldValue: oldVal, newValue: undefined, changed: true })
    } else if (oldVal !== undefined && newVal !== undefined && !compareFieldValues(oldVal, newVal)) {
      diffs.push({ fieldName: field, oldValue: oldVal, newValue: newVal, changed: true })
    }
  }

  return diffs
}

/** 执行版本差异比较 */
export function compareWorldVersions(
  oldVersionId: string,
  newVersionId: string,
  oldEntries: WorldVersionEntry[],
  newEntries: WorldVersionEntry[],
): WorldVersionDiff {
  const aligned = alignEntries(oldEntries, newEntries)
  const entryDiffs: EntryDiff[] = []
  let addedCount = 0
  let removedCount = 0
  let modifiedCount = 0
  let unchangedCount = 0

  for (const [, pair] of aligned) {
    if (pair.old && pair.new) {
      // 两个版本都存在
      const oldFingerprint = computeFingerprint(pair.old)
      const newFingerprint = computeFingerprint(pair.new)

      if (oldFingerprint === newFingerprint && pair.old.active === pair.new.active) {
        // 同指纹且活跃状态相同 → 未变化
        unchangedCount++
        entryDiffs.push({
          tabId: pair.old.tabId,
          kind: pair.old.kind,
          rowId: pair.old.rowId,
          name: pair.old.name,
          diffKind: 'unchanged',
          fieldDiffs: [],
          activeChanged: false,
        })
      } else {
        // 有变化
        modifiedCount++
        const fieldDiffs = compareEntryFields(pair.old, pair.new)
        entryDiffs.push({
          tabId: pair.old.tabId,
          kind: pair.old.kind,
          rowId: pair.old.rowId,
          name: pair.old.name,
          diffKind: 'modified',
          fieldDiffs,
          activeChanged: pair.old.active !== pair.new.active,
          oldActive: pair.old.active,
          newActive: pair.new.active,
        })
      }
    } else if (!pair.old && pair.new) {
      // 新增
      addedCount++
      entryDiffs.push({
        tabId: pair.new.tabId,
        kind: pair.new.kind,
        rowId: pair.new.rowId,
        name: pair.new.name,
        diffKind: 'added',
        fieldDiffs: Object.entries(pair.new.fields)
          .filter(([k]) => !shouldIgnoreField(k))
          .map(([k, v]) => ({ fieldName: k, oldValue: undefined, newValue: v, changed: true })),
        activeChanged: false,
      })
    } else if (pair.old && !pair.new) {
      // 删除
      removedCount++
      entryDiffs.push({
        tabId: pair.old.tabId,
        kind: pair.old.kind,
        rowId: pair.old.rowId,
        name: pair.old.name,
        diffKind: 'removed',
        fieldDiffs: Object.entries(pair.old.fields)
          .filter(([k]) => !shouldIgnoreField(k))
          .map(([k, v]) => ({ fieldName: k, oldValue: v, newValue: undefined, changed: true })),
        activeChanged: false,
      })
    }
  }

  return {
    oldVersionId,
    newVersionId,
    entryDiffs,
    addedCount,
    removedCount,
    modifiedCount,
    unchangedCount,
  }
}

/** 格式化差异为 Markdown */
export function formatDiffAsMarkdown(diff: WorldVersionDiff): string {
  const lines: string[] = [`# 世界版本差异: ${diff.oldVersionId} → ${diff.newVersionId}`, '']

  if (diff.addedCount > 0) lines.push(`## 新增条目 (${diff.addedCount})`)
  if (diff.removedCount > 0) lines.push(`## 删除条目 (${diff.removedCount})`)
  if (diff.modifiedCount > 0) lines.push(`## 修改条目 (${diff.modifiedCount})`)
  if (diff.unchangedCount > 0) lines.push(`## 未变化条目 (${diff.unchangedCount})`)

  for (const entry of diff.entryDiffs) {
    if (entry.diffKind === 'unchanged') continue
    lines.push(`\n### ${entry.diffKind === 'added' ? '+' : entry.diffKind === 'removed' ? '-' : '~'} ${entry.name} (${entry.tabId})`)
    if (entry.activeChanged) {
      lines.push(`- 活跃状态: ${entry.oldActive ?? '未知'} → ${entry.newActive ?? '未知'}`)
    }
    for (const f of entry.fieldDiffs) {
      lines.push(`- ${f.fieldName}: ${JSON.stringify(f.oldValue)} → ${JSON.stringify(f.newValue)}`)
    }
  }

  return lines.join('\n')
}
