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

import type { TabDef, TableColumn, TableRow } from '@/lib/types'
import { organizeKeyColumns, isDirectedPairTab } from '@/lib/ai/aiScope'
import { nextAutoCode, AUTONUM_GROUPS } from '@/lib/ai/autoCode'

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

/**
 * 把长文本切成多段，供「AI 智能拆分」分批调用（每段独立喂模型 ⇒ 单次上下文小、拆分更准，
 * 也顺带突破「一次 12 条」的旧上限）。
 *
 * 切分规则（贪心装填，保证**每段长度 ≤ maxChars**）：
 *   · 逐行累加，装不下就在**这一行之前**收口；
 *   · 单行本身就超预算（如一大坨没有换行的散文）→ 按字数硬切；
 *   · 段首的空行丢弃，段与段之间**不重叠** —— 重叠会让同一条记录被解析两次、在预览里变成"重复"。
 */
export function splitIntoChunks(text: string, maxChars = 3000): string[] {
  const t = (text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!t) return []
  const per = Math.max(200, Math.floor(maxChars))
  if (t.length <= per) return [t]

  const chunks: string[] = []
  let buf: string[] = []
  let size = 0
  const flush = () => {
    const s = buf.join('\n').trim()
    if (s) chunks.push(s)
    buf = []
    size = 0
  }

  for (const line of t.split('\n')) {
    if (line.length > per) {
      flush()
      for (let i = 0; i < line.length; i += per) chunks.push(line.slice(i, i + per))
      continue
    }
    if (size > 0 && size + line.length + 1 > per) flush()
    if (buf.length === 0 && line.trim() === '') continue // 段首空行丢弃
    buf.push(line)
    size += line.length + 1
  }
  flush()
  return chunks
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
    // 🔴 2026-10-02 六维审计 P2：只有一行、且被分隔符切开的每一段都命中列名 —— 这是作者把「模板表头行」
    //    单独粘进来了，不是数据。跳过它，免得凭空生成一条名叫「名称」的幽灵记录（还会被默认勾选）。
    if (lines.length === 1) {
      const parts = lines[0].split(/[,\t]/).map(s => s.trim()).filter(Boolean)
      if (parts.length >= 2 && parts.every(p => colNames.has(p))) continue
    }
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

/** 判重指纹：`unordered` 为真时排序后比对。配对表（人物/势力关系）2.7.2 起为**有向对** ⇒ unordered=false。 */
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
  const unordered = !isDirectedPairTab(tab.id)
  const existingKeys = new Set(ctx.existing.map(r => dupKey(r.data, keys, unordered)))
  const codeCol = cols.some(c => c.name === '编号') ? '编号' : ''
  const existingCodes = new Set(
    codeCol ? ctx.existing.map(r => (r.data[codeCol] ?? '').trim()).filter(Boolean) : [],
  )
  const main = mainColumn(tab)
  const refCols = cols.filter(c => c.type === 'tableRef' && c.refTab)
  const batchKeys = new Set<string>()
  // 🔴 2026-10-02 六维审计 P2：编号冲突也要看**同批**。原先只比库内已有编号 ⇒ 一批里两行填了同一个
  //    显式编号时不报冲突；而空行的自动补号（buildImportRows 的 nextAutoCode）会补到一个已被同批
  //    占用的号上，落库后才在表格里爆「编号重复」红色告警 —— 问题被推迟到用户看不见的下一步。
  const batchCodes = new Set<string>()

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
      if (!allowed || allowed.size === 0) continue
      // 🔴 多值列（3.1.x · 角色卡「所属势力」）：按中文 / 英文逗号拆开**逐个**校验。
      //    按整串比对的话，「青岚宗，天机阁」永远匹配不到单个名称 ⇒ 每一行都误报悬空，
      //    而悬空提示会让人以为整列都填错了。单选列（未标 multiValue）行为与改动前逐字一致。
      const vals = rc.multiValue ? v.split(/[，,]/).map(s => s.trim()).filter(Boolean) : [v]
      for (const one of vals) {
        if (allowed.has(one)) continue
        dangling.push({
          col: rc.name, value: one, refTab: rc.refTab!,
          refLabel: ctx.refLabels?.get(rc.refTab!) ?? rc.refTab!,
        })
      }
    }

    const code = codeCol ? (data[codeCol] ?? '').trim() : ''
    const codeConflict = !!codeCol && !!code && (existingCodes.has(code) || batchCodes.has(code))
    if (code) batchCodes.add(code)

    return {
      data,
      index: i + 1,
      dupExisting,
      dupInBatch,
      missing,
      dangling,
      codeConflict,
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
  if (c.multiValue) bits.push('可多选，多个之间用中文逗号「，」分隔')
  if (c.name === '编号') bits.push('留空则导入时自动编号')
  return bits.join('；') || '—'
}

/**
 * 生成《导入说明.md》—— 三种导入方式各适用什么情况 + 列头含义 + 可复制的表头行 +
 * 一段**可直接粘给外部 AI** 的提示词。
 *
 * 🔴 这份文件的读者是「已经有一份现成设定、想搬进项目」的作者，和「把这个文件交给别的 AI」的外部模型
 *    —— 所以三种方式必须先讲清「什么时候用哪一种」，否则作者会拿最笨的方式做最简单的事。
 */
export function buildImportGuide(tab: TabDef): string {
  const cols = (tab.columns ?? []).filter(c => !c.hidden)
  const headers = cols.map(c => c.name)
  const main = mainColumn(tab)
  const L: string[] = []
  L.push(`# 《${tab.name}》导入说明`)
  L.push('')
  L.push('你手上已经有一份现成设定（Excel 表 / 文档里的文字 / 别的 AI 帮你整理好的清单），想整批搬进本项目。')
  L.push('本项目提供**三种**导入方式，按你的材料形态挑一种即可：')
  L.push('')
  L.push('## 方式一 · 照着模板填（最简单、最确定）')
  L.push('')
  L.push('**什么时候用**：你的设定本来就条理清晰，或者你愿意手动整理。')
  L.push('**怎么做**：把下面「表头行」复制到 Excel / 在线表格的第一行，逐行填写，')
  L.push('回到本页点「导入」——粘贴表格、或选择另存好的 CSV（UTF-8）文件都行。')
  L.push('Markdown 表格、以及从 Excel 直接「复制 → 粘贴」过来的制表符表格，同样能识别。')
  L.push('**特点**：完全本地解析，**不消耗任何 AI 额度**，结果可预期。')
  L.push('')
  L.push('## 方式二 · 交给别的 AI 整理成表（适合散文式设定）')
  L.push('')
  L.push('**什么时候用**：你的设定是文档/散文式的，人懒得逐条誊，但想让**别的 AI**（如网页版对话模型）帮你整理。')
  L.push('**怎么做**：把本文件「交给其他 AI 整理用的提示词」整段复制、连同你的设定原文一起发给那个 AI，')
  L.push('让它输出表格；拿到结果后回到本页「导入」，粘贴进来即可（走方式一的解析）。')
  L.push('**特点**：不消耗本项目的额度；由你挑选的**外部 AI**（网页版对话模型等）出力，与本项目已接入的模型无关。')
  L.push('')
  L.push('## 方式三 · 直接粘贴，用本项目已接入的 AI 智能拆分（最省事）')
  L.push('')
  L.push('**什么时候用**：你懒得手动整理、也不想另开一个 AI；希望**粘贴完点一下就自动拆成多条**。')
  L.push('**怎么做**：把表格内容或散文式设定直接粘到本页文本框，点「AI 智能拆分」，')
  L.push('本项目会用你**当前配置的模型**把内容解析成多条记录，拆完进预览、逐条勾选后导入。')
  L.push('**特点**：会用你配置的模型（本地 Ollama / 联网模型），**会消耗该模型的额度**（本地不花钱、联网按量计费）；')
  L.push('**长文会自动分批**，突破一次十几条的限制；效果取决于模型能力，拆完务必在预览里过一眼再导入。')
  L.push('')
  L.push('---')
  L.push('')
  L.push('> 无论哪种方式，导入**不会破坏表之间的勾稽关系**：跨表引用按「名称逐字一致」关联，')
  L.push('> 只要名称与目标表里已有的写法一致，导入后关系就成立。预览会把「对不上的名称」单独标出来提示你。')
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
  L.push('## 交给其他 AI 整理用的提示词（方式二用）')
  L.push('')
  L.push('```')
  L.push(`请把下面的设定整理成一张 CSV 表格。第一行表头必须逐字为：${headers.join(',')}。`)
  L.push('每一行是一条记录；**不要把一个对象拆成多行，也不要把多个对象合并成一行**；')
  L.push('不要增删列；无法确定的单元格留空；不要输出解释文字，只输出 CSV。')
  L.push(`其中「${main}」这一列是必填（每条记录的核心名称）。`)
  L.push('（在此粘贴你的设定原文）')
  L.push('```')
  return L.join('\n')
}

// ============ 导入预览的准备层（2026-10-06 自 `TableImportDialog` 抽出）============
//
// 🔴 为什么抽出来：下面这几段原先长在弹窗组件里 —— 400 行的组件、8 个 `useMemo`，
//    而**纯函数住在组件里就等于测不了**（要 DOM 环境才跑得起）。抽到这里之后，
//    「三种来源的行为一致」「默认勾选哪几行」这类**错了也不报错**的地方才钉得住。
//    搬家时行为一字未改，组件改为调用这里。

/**
 * 把「本地解析结果」或「AI 拆分结果」统一成**待校验的行 + 一句说明**。
 *
 * 三种来源（AI / 表格 / 纯文本）在预览里必须**长得一样**：都产出 `Record<列名, 值>[]`，
 * 再交给 `validateImport` 走同一套判重 / 缺必填 / 悬空 —— 这正是「不擅自替作者决定」的实现方式。
 *
 * @param ai 非空时**优先**用它（作者刚跑完 AI 拆分、原文还没改过）
 */
export function buildImportPrepared(
  parsed: ParsedInput | null,
  tab: TabDef,
  ai?: { rows: Record<string, string>[]; rawCount: number; chunks: number } | null,
): { rows: Record<string, string>[]; note: string } {
  if (ai) {
    const rawN = ai.rawCount ?? ai.rows.length
    const chunkN = ai.chunks ?? 1
    return {
      rows: ai.rows,
      note: `AI 智能拆分 · 解析出 ${ai.rows.length} 条（模型原始返回 ${rawN} 条）`
        + (chunkN > 1 ? ` · 分 ${chunkN} 段解析` : ''),
    }
  }
  if (!parsed) return { rows: [], note: '' }
  if (parsed.table) {
    const mapping = mapHeaders(parsed.table.headers, tab)
    const hit = mapping.filter(Boolean).length
    const lostCols = parsed.table.headers.filter((_, i) => !mapping[i])
    // 🔴 「未识别的列已忽略」必须**报出来**：不报的话，作者会以为整份表都导进来了，
    //    实际少了几列却毫无提示 —— 这类静默丢数据是导入功能最不该有的表现。
    const lost = lostCols.length ? `；未识别的列已忽略：${lostCols.join('、')}` : ''
    return {
      rows: matrixToRows(parsed.table, mapping, tab),
      note: `${parsed.note} · 匹配到 ${hit}/${mapping.length} 列${lost}`,
    }
  }
  const tx = textToRows(parsed.text ?? '', tab)
  return { rows: tx.rows, note: `${parsed.note} · ${tx.note}` }
}

/** 导入预览的统计（界面顶部那行「共 N 行 / 与已有重复 N / …」） */
export interface ImportSummary {
  total: number
  /** 与库内重复 **+** 批内重复（两者都叫「重复」，界面合成一个数显示） */
  dup: number
  /** 悬空引用：名称在目标表里找不到 */
  dangling: number
  /** 缺必填（主列 / displayCol） */
  missing: number
  /** 编号冲突（库内已有 **或** 同批占用） */
  code: number
}

/** 逐行累加预览统计。纯函数，输入与输出的对应关系一眼可测。 */
export function summarizeImportResults(results: ImportRowResult[]): ImportSummary {
  let dup = 0, dangling = 0, missing = 0, code = 0
  for (const r of results) {
    if (r.dupExisting || r.dupInBatch) dup++
    if (r.dangling.length) dangling++
    if (r.missing.length) missing++
    if (r.codeConflict) code++
  }
  return { total: results.length, dup, dangling, missing, code }
}

/**
 * 默认勾选哪些行（返回**下标**）；名单之外的靠作者自己勾。
 *
 * 🔴 四条全过才默认勾：不重复（库内 / 批内）、不缺必填、**编号不冲突**。
 *    最后那条是 2026-10-02 六维审计 P2 补的：原先默认勾上 ⇒ 一按「导入」就落库出一个
 *    「编号重复」的行，而表格保存时会被编号校验拦下 —— 等于**替作者造了个存不下去的状态**。
 */
export function defaultCheckedIndexes(results: ImportRowResult[]): number[] {
  const out: number[] = []
  results.forEach((r, i) => {
    if (!r.dupExisting && !r.dupInBatch && !r.codeConflict && r.missing.length === 0) out.push(i)
  })
  return out
}

/**
 * 本表需要做「悬空校验」的跨表引用目标：`{ 目标表, 取值列 }`，**按首次出现顺序去重**。
 *
 * 同一张目标表可能被多列引用（如「上级」与「宗主」都指向人物表），只取**第一个**列的 refCol
 * 当「名称列」—— 与校验口径一致（校验只问「这个名字在那张表里存不存在」）。
 * `refCol` 缺省为「名称」：多数表的主列就叫这个名。
 */
export function refColumnTargets(tab: TabDef): { tabId: string; refCol: string }[] {
  const seen = new Map<string, string>()
  for (const c of tab.columns ?? []) {
    if (c.type !== 'tableRef' || !c.refTab) continue
    if (!seen.has(c.refTab)) seen.set(c.refTab, c.refCol || '名称')
  }
  return [...seen.entries()].map(([tabId, refCol]) => ({ tabId, refCol }))
}
