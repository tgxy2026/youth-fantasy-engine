// ============ 表格页签 · 批量导入 / 导出（2.6.4）============
//
// 社区诉求：作者已有一份成体系的设定（Excel 表格 / 交给外部 AI 整理好的清单 / 自己写的文档），
// 想整批搬进项目。而项目原有「AI 整理」只吃一段文本、一次最多 12 条，且模型常把多条合成一条。
// 本模块提供**确定性的批量导入导出** —— 不依赖模型、不烧额度、结果可预期。
//
// 🔴 四条设计约束（动这里之前先读）：
//   1. **列名即契约**：模板列头 = schema 列名（`TabDef.columns[].name`），导入按「列名」映射、不靠列位置。
//      这样作者在 Excel 里调换列序也不影响导入。
//   2. **勾稽靠名称**：跨表引用（tableRef）存的是**名称字符串**（不是 id 外键）。导入只做
//      「名称存在性校验」，把悬空的列出来让作者决定（仍导入 / 跳过）—— 绝不悄悄改写成 id。
//      ⇒ 只要名称与目标表逐字一致，导入后勾稽关系**天然成立**、不会失效。
//   3. **编号不让外部传**：带「编号」列的表，导入行若编号为空则走 `nextAutoCode` 补号。
//   4. **解析是纯函数、落库是副作用**：本文件只做「文本 → 行对象 → 校验结果」，
//      真正的写库由弹窗组件调 `db.saveTableRow`（与「AI 整理」同一落库口径，见 useTableSheetModel）。
//
// 📌 两种输入都能解析（社区反馈明确要求）：
//   · 表格：Markdown 表格 / 制表符（从 Excel 直接复制）/ 逗号 CSV —— 走 `parseImportText`；
//   · 文本：一段散文式设定 —— 走 `textToRows`，先按「列名：值」块或按行拆分。

import type { TabDef, TableColumn, TableRow } from './types'
import { organizeKeyColumns, isUnorderedPairTab } from './aiScope'
import { nextAutoCode, AUTONUM_GROUPS } from './autoCode'

// ============ A. 文本 → 表格矩阵 ============

export type ImportFormat = 'md' | 'tsv' | 'csv' | 'text'

export interface ParsedTable { headers: string[]; rows: string[][] }

export interface ParsedInput {
  format: ImportFormat
  /** 表格模式有值；文本模式为 undefined */
  table?: ParsedTable
  /** 文本模式的原文 */
  text?: string
  /** 给用户看的一句话说明（检测到了什么） */
  note: string
}

/** CSV 单元格拆分：支持 `"a,b"` 与 `""` 转义。不支持字段内换行（设定表用不到，且会让行号对不上） */
export function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else inQ = false
      } else cur += ch
    } else if (ch === '"') {
      inQ = true
    } else if (ch === ',') {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map(s => s.trim())
}

/** Markdown 表格行拆分：去掉首尾竖线后按 `|` 切 */
export function splitMdRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map(x => x.trim())
}

/** Markdown 表格分隔行：`| --- | :--: |` */
export function isMdSeparator(line: string): boolean {
  return /-/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(line)
}

/**
 * 自动识别并解析导入文本。识别顺序（越结构化的越优先）：
 *   ① Markdown 表格（首行含 `|` 且第二行是分隔行）
 *   ② TSV（出现制表符 —— Excel 复制粘贴的默认格式）
 *   ③ CSV（出现逗号且「列数大致一致」—— 避免把含逗号的散文误判成表格）
 *   ④ 纯文本（交给 `textToRows`）
 */
export function parseImportText(raw: string): ParsedInput {
  const text = (raw ?? '').replace(/\r\n?/g, '\n').trim()
  if (!text) return { format: 'text', text: '', note: '内容为空' }
  const lines = text.split('\n').filter(l => l.trim() !== '')

  // ① Markdown 表格
  if (lines.length >= 2 && lines[0].includes('|') && isMdSeparator(lines[1])) {
    const headers = splitMdRow(lines[0])
    const rows = lines.slice(2).map(splitMdRow)
    return { format: 'md', table: { headers, rows }, note: `Markdown 表格 · ${headers.length} 列 × ${rows.length} 行` }
  }

  // ② TSV
  if (lines.some(l => l.includes('\t'))) {
    const grid = lines.map(l => l.split('\t').map(s => s.trim()))
    const w = grid[0].length
    return { format: 'tsv', table: { headers: grid[0], rows: grid.slice(1) }, note: `制表符分隔（Excel 粘贴）· ${w} 列 × ${grid.length - 1} 行` }
  }

  // ③ CSV
  if (lines.length >= 2 && lines[0].includes(',')) {
    const grid = lines.map(splitCsvLine)
    const w = grid[0].length
    const sameWidth = grid.filter(r => r.length === w).length
    if (w >= 2 && sameWidth >= Math.max(2, grid.length - 1)) {
      return { format: 'csv', table: { headers: grid[0], rows: grid.slice(1) }, note: `逗号分隔（CSV）· ${w} 列 × ${grid.length - 1} 行` }
    }
  }

  // ④ 纯文本
  return { format: 'text', text, note: `纯文本 · ${lines.length} 行（按「列名：值」块或逐行拆分）` }
}

// ============ B. 映射与行对象 ============

/** 表头 → schema 列名（null = 该列忽略）。按列名精确匹配，不按位置 */
export function mapHeaders(headers: string[], tab: TabDef): (string | null)[] {
  const cols = tab.columns ?? []
  return headers.map(h => {
    const key = (h ?? '').trim()
    const hit = cols.find(c => c.name === key)
    return hit ? hit.name : null
  })
}

/** 矩阵 + 映射 → 行对象（键 = schema 列名；未映射的列丢弃） */
export function matrixToRows(table: ParsedTable, mapping: (string | null)[], tab: TabDef): Record<string, string>[] {
  const cols = tab.columns ?? []
  return table.rows.map(r => {
    const data: Record<string, string> = {}
    cols.forEach(c => { data[c.name] = '' })
    r.forEach((v, i) => {
      const col = mapping[i]
      if (col) data[col] = (v ?? '').trim()
    })
    return data
  })
}

/** 该表的「主列」：优先 displayCol，否则第一个非编号/非章节号列 */
export function mainColumn(tab: TabDef): string {
  const cols = tab.columns ?? []
  if (tab.displayCol && cols.some(c => c.name === tab.displayCol)) return tab.displayCol
  const first = cols.find(c => c.name !== '编号' && c.name !== '章节号' && !c.hidden)
  return first?.name ?? ''
}

/**
 * 纯文本 → 行对象（本地规则，不依赖模型）。
 * 规则：先按空行分块 ——
 *   · 块内多数行是「列名：值」形式 → 合成一条记录（列名命中 schema 才算）；
 *   · 否则逐行一条，内容填到主列（供作者在预览里手动调整）。
 */
export function textToRows(text: string, tab: TabDef): { rows: Record<string, string>[]; note: string } {
  const cols = tab.columns ?? []
  const colNames = new Set(cols.map(c => c.name))
  const main = mainColumn(tab)
  const blocks = (text ?? '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  const rows: Record<string, string>[] = []
  let kvMode = false
  const blank = () => { const d: Record<string, string> = {}; cols.forEach(c => { d[c.name] = '' }); return d }

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    const kvLines = lines.filter(l => {
      const m = l.match(/^([^：:]{1,14})[：:]/)
      return !!m && colNames.has(m[1].trim())
    })
    if (kvLines.length >= Math.max(2, lines.length - 1) && kvLines.length > 0) {
      // 键值块 → 一条记录
      kvMode = true
      const data = blank()
      for (const l of lines) {
        const m = l.match(/^([^：:]{1,14})[：:]\s*([\s\S]*)$/)
        if (!m) continue
        const col = m[1].trim()
        if (colNames.has(col)) data[col] = m[2].trim()
      }
      rows.push(data)
    } else {
      // 逐行一条 → 主列
      for (const l of lines) {
        const data = blank()
        if (main) data[main] = l
        rows.push(data)
      }
    }
  }
  const note = kvMode
    ? '按「列名：值」块拆分（列名需与本表列名一致）'
    : `按行拆分，内容填入「${main || '首列'}」`
  return { rows, note }
}

// ============ C. 校验 ============

export interface DanglingRef { col: string; value: string; refTab: string; refLabel: string }

export interface ImportRowResult {
  data: Record<string, string>
  /** 批内序号（1 起），供界面显示行号 */
  index: number
  /** 与「库里已有行」判重命中 */
  dupExisting: boolean
  /** 与本批次内更早的一行重复 */
  dupInBatch: boolean
  /** 缺必填（主列 / displayCol） */
  missing: string[]
  /** 悬空引用（名称在目标表里找不到） */
  dangling: DanglingRef[]
  /** 「编号」列与库内已有编号重复 */
  codeConflict: boolean
}

export interface ImportContext {
  /** 库里已有的行（判重与编号冲突用） */
  existing: TableRow[]
  /** tabId → 该表 refCol 的取值集合（校验 tableRef 悬空） */
  refValues: Map<string, Set<string>>
  /** 引用表 tabId → 显示名（悬空提示用） */
  refLabels?: Map<string, string>
}

/** 判重指纹：无序对表（人物关系 / 势力关系）A-B 与 B-A 视为同一条 */
function dupKey(data: Record<string, string>, keys: string[], unordered: boolean): string {
  const vals = keys.map(k => (data[k] ?? '').trim())
  if (unordered) vals.sort()
  return vals.join('\u0001')
}

/** 逐行校验：判重 / 缺必填 / 悬空引用 / 编号冲突 */
export function validateImport(
  rows: Record<string, string>[],
  tab: TabDef,
  ctx: ImportContext,
): ImportRowResult[] {
  const cols = tab.columns ?? []
  const keys = organizeKeyColumns(tab)
  const unordered = isUnorderedPairTab(tab.id)
  const existingKeys = new Set(ctx.existing.map(r => dupKey(r.data, keys, unordered)))
  const codeCol = cols.some(c => c.name === '编号') ? '编号' : ''
  const existingCodes = new Set(
    codeCol ? ctx.existing.map(r => (r.data[codeCol] ?? '').trim()).filter(Boolean) : [],
  )
  const main = mainColumn(tab)
  const refCols = cols.filter(c => c.type === 'tableRef' && c.refTab)
  const batchKeys = new Set<string>()

  return rows.map((data, i) => {
    // 判重键全空的行不参与判重（否则整批空行会互相判成重复）
    const hasKey = keys.length > 0 && keys.some(k => (data[k] ?? '').trim() !== '')
    const key = hasKey ? dupKey(data, keys, unordered) : ''
    const dupExisting = hasKey && existingKeys.has(key)
    const dupInBatch = hasKey && batchKeys.has(key)
    if (hasKey) batchKeys.add(key)

    const missing: string[] = []
    if (main && !(data[main] ?? '').trim()) missing.push(main)

    const dangling: DanglingRef[] = []
    for (const rc of refCols) {
      const v = (data[rc.name] ?? '').trim()
      if (!v) continue
      const allowed = ctx.refValues.get(rc.refTab!)
      if (allowed && allowed.size > 0 && !allowed.has(v)) {
        dangling.push({
          col: rc.name, value: v, refTab: rc.refTab!,
          refLabel: ctx.refLabels?.get(rc.refTab!) ?? rc.refTab!,
        })
      }
    }

    return {
      data,
      index: i + 1,
      dupExisting,
      dupInBatch,
      missing,
      dangling,
      codeConflict: !!codeCol && existingCodes.has((data[codeCol] ?? '').trim()),
    }
  })
}

// ============ D. 落库行 ============

/**
 * 把「勾选保留」的导入行构造成 TableRow（不写库，由调用方落盘 —— 与「AI 整理」口径一致）。
 * 编号列：外部留空则由 `nextAutoCode` 补号（多行在循环里累加，避免拿到同一个号）。
 */
export function buildImportRows(
  picked: ImportRowResult[],
  tab: TabDef,
  existing: TableRow[],
  projectId: string,
  uid: () => string,
  drafts: Record<string, Record<string, string>> = {},
): TableRow[] {
  const cols = tab.columns ?? []
  const codeCol = cols.some(c => c.name === '编号') ? '编号' : ''
  const needAuto = !!codeCol && AUTONUM_GROUPS.has(tab.group)
  const created: TableRow[] = []
  for (const r of picked) {
    const data: Record<string, string> = {}
    cols.forEach(c => { data[c.name] = r.data[c.name] ?? '' })
    if (needAuto && !(data[codeCol] ?? '').trim()) {
      data[codeCol] = nextAutoCode(tab.id, [...existing, ...created], drafts, codeCol)
    }
    created.push({
      id: uid(), projectId, tabId: tab.id, data,
      order: existing.length + created.length, createdAt: Date.now(),
    })
  }
  return created
}

// ============ E. 导出 ============

/** CSV 单元格转义（含逗号 / 引号 / 换行的字段用双引号包裹） */
export function csvCell(v: string): string {
  const s = String(v ?? '').replace(/\r?\n/g, ' ')
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 导出当前表数据为 CSV（列序 = schema 列序，跳过隐藏列） */
export function exportRowsCsv(tab: TabDef, rows: TableRow[]): string {
  const cols = (tab.columns ?? []).filter(c => !c.hidden)
  const head = cols.map(c => csvCell(c.name)).join(',')
  const body = rows.map(r => cols.map(c => csvCell(String(r.data[c.name] ?? ''))).join(','))
  return [head, ...body].join('\n')
}

/** 导出空白模板 CSV：只有列头行（不含示例数据，避免误当成一条记录导进去） */
export function exportTemplateCsv(tab: TabDef): string {
  const cols = (tab.columns ?? []).filter(c => !c.hidden)
  return cols.map(c => csvCell(c.name)).join(',')
}

function colTypeLabel(c: TableColumn): string {
  switch (c.type) {
    case 'select': return '单选'
    case 'tableRef': return '引用其它表'
    case 'character': return '角色（单个）'
    case 'characters': return '角色（多个）'
    case 'date': return '日期'
    case 'calendar': return '历法日期'
    case 'number': return '数字'
    case 'textarea': return '长文本'
    default: return '文本'
  }
}

function colTip(c: TableColumn, tab: TabDef): string {
  const bits: string[] = []
  if (c.name === mainColumn(tab)) bits.push('**必填**')
  if (c.type === 'select' && c.options?.length) bits.push(`可选：${c.options.join(' / ')}`)
  if (c.type === 'tableRef' && c.refTab) bits.push('须与目标表中已有的名称逐字一致（否则勾稽会悬空）')
  if (c.name === '编号') bits.push('留空则导入时自动编号')
  return bits.join('；') || '—'
}

/**
 * 生成《导入说明.md》—— 列头含义 + 可复制的表头行 + 一段**可直接粘给外部 AI** 的提示词。
 * 场景：作者已有一份设定，想让别的 AI 整理成表格再导回本项目。
 */
export function buildImportGuide(tab: TabDef): string {
  const cols = (tab.columns ?? []).filter(c => !c.hidden)
  const headers = cols.map(c => c.name)
  const L: string[] = []
  L.push(`# 《${tab.name}》导入说明`)
  L.push('')
  L.push('把本节「表头行」复制到 Excel / 在线表格的第一行，逐行填写，另存为 CSV（UTF-8）后，')
  L.push('回到本页点「导入」粘贴或选择该文件即可。也可以用 Markdown 表格、或直接从 Excel 复制粘贴。')
  L.push('')
  L.push('## 列说明')
  L.push('')
  L.push('| 列名 | 类型 | 说明 |')
  L.push('| --- | --- | --- |')
  for (const c of cols) L.push(`| ${c.name} | ${colTypeLabel(c)} | ${colTip(c, tab)} |`)
  L.push('')
  L.push('## 表头行（可直接复制）')
  L.push('')
  L.push('```')
  L.push(headers.join(','))
  L.push('```')
  L.push('')
  L.push('## 交给其他 AI 整理用的提示词（可选）')
  L.push('')
  L.push('```')
  L.push(`请把下面的设定整理成一张 CSV 表格。第一行表头必须逐字为：${headers.join(',')}。`)
  L.push('每一行是一条记录；不要增删列；无法确定的单元格留空；不要输出解释文字，只输出 CSV。')
  L.push('（在此粘贴你的设定原文）')
  L.push('```')
  return L.join('\n')
}
