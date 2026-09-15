// ============ 数据体检：确定性结构扫描（不依赖 AI） ============
//
// 与「AI 一致性深度自查」互补：AI 查"故事通不通"（语义矛盾），本引擎查"链接断没断"
// （数据结构层面的引用完整性）。纯程序遍历所有表格型页签的引用列，毫秒级、100% 确定、
// 精确到行、可跳转修复。覆盖四类问题：
//   1. 悬空引用：cr（跨表引用）列的值在源表对应列中找不到 → 多半是改名/删除后残留
//   2. 孤儿项：自引用父级（上级/层级归属）指向本表不存在的名称 → 父条目被删
//   3. 编号冲突：同一表出现重复「编号」
//   4. 必填空：主名称列（displayCol）未填写，行缺少主标识
// 另外独立校验"编号型引用"（如 章节总表的 埋设/回收伏笔编号、历史的 对应伏笔编号）：
//   值为字母+数字编码时，按前缀映射到目标表，确认该编码真实存在。

import { TABS, getTab, GEO_MAPS_TAB } from './schema'
import { getTableRows } from './db'
import type { AuditIssue, AuditLocation } from './audit'

/** 编码前缀 → 目标表（用于编号型引用校验） */
const PREFIX_TAB: Record<string, string> = {
  N: 'nations', G: 'geography', R: 'races', I: 'items', H: 'history',
  T: 'terms', F: 'foreshadow', LINE: 'subplots', S: 'secrets',
  C: 'changelog', IDEA: 'ideas', MAP: 'geomaps',
}
const CODE_RE = /^(N|G|R|I|H|T|F|LINE|S|C|IDEA|MAP)\d/i

export interface HealthResult {
  issues: AuditIssue[]
  scannedTables: number
}

export async function runDataHealthCheck(): Promise<HealthResult> {
  const issues: AuditIssue[] = []
  // 《地图》是独立数据表（不在 TABS 里），但它是《地理风物》「所属地图」列的**引用目标** ——
  // 不并进来的话，refValues 取不到它，所有已指派的地图归属都会被误报成「悬空引用」。
  const tableTabs = [...TABS, GEO_MAPS_TAB].filter(t => t.type === 'table')
  const counter = { n: 0 }
  const push = (
    severity: AuditIssue['severity'],
    category: string,
    title: string,
    detail: string,
    loc?: AuditLocation,
  ) => {
    counter.n += 1
    issues.push({ id: `H${counter.n}`, severity, category, title, detail, location: loc })
  }

  // 预取所有表格数据
  const cache = new Map<string, { id: string; data: Record<string, string> }[]>()
  for (const t of tableTabs) {
    const rows = await getTableRows(t.id)
    cache.set(t.id, rows.map(r => ({ id: r.id, data: r.data })))
  }

  // 建索引：refTab→refCol 取值集合（用于 cr 悬空校验）
  const refValues = (tabId: string, col: string) => {
    const set = new Set<string>()
    for (const r of cache.get(tabId) ?? []) {
      const v = (r.data[col] || '').trim()
      if (v) set.add(v)
    }
    return set
  }
  // 建索引：表→编号集合（用于编号型引用校验）
  const codeIndex = new Map<string, Set<string>>()
  for (const t of tableTabs) {
    const has = (t.columns ?? []).some(c => c.name === '编号')
    if (!has) continue
    const set = new Set<string>()
    for (const r of cache.get(t.id) ?? []) {
      const v = (r.data['编号'] || '').trim().toUpperCase()
      if (v) set.add(v)
    }
    codeIndex.set(t.id, set)
  }

  for (const t of tableTabs) {
    const rows = cache.get(t.id) ?? []
    const cols = t.columns ?? []
    const displayCol = t.displayCol

    // —— 1) 跨表引用悬空（cr 列，含自引用父级=孤儿项）——
    for (const col of cols) {
      if (col.type !== 'tableRef' || !col.refTab || !col.refCol) continue
      const refTab = col.refTab
      const refCol = col.refCol
      const allowed = refValues(refTab, refCol)
      const selfRef = refTab === t.id
      const refName = selfRef ? t.name : (getTab(refTab)?.name ?? refTab)
      for (const row of rows) {
        const v = (row.data[col.name] || '').trim()
        if (!v || allowed.has(v)) continue
        push(
          'error',
          selfRef ? '孤儿项' : '悬空引用',
          selfRef ? `「${col.name}」指向不存在的父级` : `「${col.name}」引用悬空`,
          `《${t.name}》·「${row.data[displayCol ?? ''] || '(无名称)'}」的「${col.name}」=「${v}」，但在${selfRef ? '本表' : `《${refName}》`}的「${refCol}」中找不到对应值。多半是源条目被改名或删除后残留，建议改为正确值或清理该行。`,
          { kind: 'row', tabId: t.id, rowId: row.id, hint: col.name },
        )
      }
    }

    // —— 2) 编号冲突 ——
    if (cols.some(c => c.name === '编号')) {
      const byCode = new Map<string, { name: string; rowId: string }[]>()
      for (const row of rows) {
        const v = (row.data['编号'] || '').trim()
        if (!v) continue
        if (!byCode.has(v)) byCode.set(v, [])
        byCode.get(v)!.push({ name: row.data[displayCol ?? ''] || row.id, rowId: row.id })
      }
      for (const [code, list] of byCode) {
        if (list.length <= 1) continue
        const first = list[0]
        push(
          'error',
          '编号冲突',
          `编号「${code}」重复`,
          `《${t.name}》中有 ${list.length} 行使用了相同编号「${code}」：${list.map(l => l.name).join('、')}。编号应唯一，重复会导致跳转与引用错位。`,
          { kind: 'row', tabId: t.id, rowId: first.rowId, hint: '编号' },
        )
      }
    }

    // —— 3) 必填空（主名称列）——
    if (displayCol) {
      for (const row of rows) {
        const v = (row.data[displayCol ?? ''] || '').trim()
        if (v) continue
        push(
          'warn',
          '必填空',
          `「${displayCol}」为空`,
          `《${t.name}》有一行的主标识「${displayCol}」未填写，该行缺少名称，会影响检索、联动与跳转定位。`,
          { kind: 'row', tabId: t.id, rowId: row.id, hint: displayCol },
        )
      }
    }

    // —— 4) 编号型引用悬空（埋设/回收伏笔编号 等纯文本编码列）——
    for (const col of cols) {
      if (col.name === '编号' || col.type === 'tableRef') continue
      if (!col.name.includes('编号')) continue
      for (const row of rows) {
        const raw = (row.data[col.name] || '').trim()
        if (!raw) continue
        for (const token of raw.split(/[,，、;\s]+/).map(s => s.trim()).filter(Boolean)) {
          const m = token.match(CODE_RE)
          if (!m) continue
          const prefix = (m[1] ?? '').toUpperCase()
          const target = PREFIX_TAB[prefix]
          if (!target) continue
          const set = codeIndex.get(target)
          if (set && !set.has(token.toUpperCase())) {
            push(
              'error',
              '悬空引用(编号)',
              `「${col.name}」指向不存在的编号`,
              `《${t.name}》·「${row.data[displayCol ?? ''] || '(无名称)'}」的「${col.name}」含编码「${token}」，但《${getTab(target)?.name ?? target}》中没有该编号。多半是对应条目被删或编号改过。`,
              { kind: 'row', tabId: t.id, rowId: row.id, hint: col.name },
            )
          }
        }
      }
    }
  }

  // 严重度排序：error → warn → info
  const order = { error: 0, warn: 1, info: 2 } as const
  issues.sort((a, b) => order[a.severity] - order[b.severity])

  return { issues, scannedTables: tableTabs.length }
}
