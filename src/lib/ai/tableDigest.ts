/**
 * 设定表「摘要化」（3.1.3 · R3 的第二半）。
 *
 * 【为什么需要】
 *   装配层（`contextAssembler`）只能决定「这一段放不放得下」，改不了段内部有多胖。
 *   而设定表天生很胖：实测《地理风物》22 行 × 20 列 = **6804 字符**、
 *   《物品资源》6283、《种族生物》5636 —— 一张表就赶上整个预算的一半。
 *   结果是：这些表要么整段被丢（AI 完全不知道有这些设定），要么把后面的段落全挤死。
 *
 * 【怎么压】
 *   优先级**先减列、再减行**，理由很实际：
 *   「22 个条目 × 8 个字段」比「11 个条目 × 20 个字段」有用得多 ——
 *   模型要知道"世界里有这些东西、各是什么来路"，而不是把某三个条目的每个细节读完。
 *
 * 【保列顺序】名称列（`preferKeys`）先保，其余按**填充率**降序（有值的行多 ⇒ 信息密度高），
 *   填充率相同则按原列序 —— 排序必须完全确定，本地模型的 prompt prefix cache 靠前缀逐字一致。
 *
 * 🔴 只在超限时才动手：小表（放得下的）输出与改造前**逐字一致**。
 */
export interface DigestColumn {
  /** 存储键（内部用，不进输出） */
  key: string
  /** 给模型看的列名（自定义字段已换成字段名） */
  label: string
}

export interface DigestInput {
  columns: readonly DigestColumn[]
  /** 与 columns 一一对应、**已格式化并单格截断**的行 */
  rows: readonly (readonly string[])[]
  /** 输出字符上限（含表头与两条申报） */
  maxChars: number
  /** 优先保留的列 key（名称列 / 作者指定的摘要字段），按顺序；不存在的自动跳过 */
  preferKeys?: readonly string[]
  /** 全量有效行数（大于 `rows.length` 说明上游按行数上限截断过，要如实申报） */
  totalRows?: number
}

export interface DigestResult {
  text: string
  /** 是否真的压缩过（false ⇒ 输出与原来逐字一致） */
  compressed: boolean
  keptColumns: number
  keptRows: number
  /** 因预算没列出的列名（给界面/账本如实申报用） */
  droppedColumnLabels: string[]
  droppedRows: number
}

/** 申报文本预留（两条申报加起来通常 60~120 字符） */
const NOTE_RESERVE = 140

/**
 * 实际预留：大预算按 140，小预算按 15% 收敛。
 * 🔴 固定 140 会让 130~200 字符的极小预算直接算出负数 ⇒ 一行都带不了（"有预算却全空"）。
 */
function noteReserveFor(maxChars: number): number {
  return Math.min(NOTE_RESERVE, Math.max(40, Math.floor(maxChars * 0.15)))
}
/** 至少留几列（再多压就只剩名字，没有信息量） */
const MIN_COLS = 2

/** 拼接一行（列间用全角竖线，与既有表格段一致） */
function joinCells(values: readonly string[]): string {
  return values.join(' ｜ ')
}

/**
 * 把一张表压进 `maxChars`。
 *
 * 返回的 `text` 首行是表头，其后是数据行，末尾可能带两条申报：
 *   `（另有 N 行未列出）` / `（另有 K 列未列出：甲、乙…）`
 */
export function digestTable(input: DigestInput): DigestResult {
  const { columns, rows, maxChars } = input
  const totalRows = Math.max(rows.length, input.totalRows ?? rows.length)

  if (columns.length === 0 || rows.length === 0) {
    return { text: '', compressed: false, keptColumns: 0, keptRows: 0, droppedColumnLabels: [], droppedRows: 0 }
  }

  const render = (idx: readonly number[], rowCount: number): string => {
    const head = joinCells(idx.map(i => columns[i].label))
    const body: string[] = [head]
    for (let r = 0; r < rowCount; r++) body.push(joinCells(idx.map(i => rows[r][i] ?? '')))
    return body.join('\n')
  }

  const noteOf = (droppedRows: number, droppedCols: readonly string[]): string => {
    const parts: string[] = []
    if (droppedRows > 0) parts.push(`（另有 ${droppedRows} 行未列出）`)
    if (droppedCols.length > 0) {
      const shown = droppedCols.slice(0, 6).join('、')
      parts.push(`（另有 ${droppedCols.length} 列未列出：${shown}${droppedCols.length > 6 ? '…' : ''}）`)
    }
    return parts.length ? '\n' + parts.join('\n') : ''
  }

  const allIdx = columns.map((_, i) => i)

  // 一、放得下就原样输出（小表零变化：调用方可以据此断言"没压过"）
  const fullNote = noteOf(totalRows - rows.length, [])
  const full = render(allIdx, rows.length) + fullNote
  if (full.length <= maxChars) {
    return {
      text: full,
      compressed: false,
      keptColumns: columns.length,
      keptRows: rows.length,
      droppedColumnLabels: [],
      droppedRows: totalRows - rows.length,
    }
  }

  /**
   * 列优先级：preferKeys 在前（保作者意图），其余按填充率降序、原列序 tiebreak。
   * 🔴 填充率只统计**这批行**（不是全库）：我们要的是"在这批被带进来的条目里，
   *    哪一列信息最密"，全库统计会把早已删掉的旧数据也算进来。
   */
  const filledCount = columns.map((_, i) => rows.reduce((n, r) => n + ((r[i] ?? '').trim() ? 1 : 0), 0))
  const prefer = (input.preferKeys ?? [])
    .map(k => columns.findIndex(c => c.key === k))
    .filter(i => i >= 0)
  const preferSet = new Set(prefer)
  const rest = allIdx
    .filter(i => !preferSet.has(i))
    .sort((a, b) => filledCount[b] - filledCount[a] || a - b)
  const ordered = [...prefer, ...rest]

  /**
   * 二、**先保全部条目**：从多列往少列试，找能装下「全部行」的最大列数。
   *
   * 🔴 顺序不能反。最初的实现是"从多列开始、只要还能带 3 行就接受"，
   *    结果它永远选最多列、只带 3 行 —— 与"22 条 × 8 字段 优于 3 条 × 20 字段"完全相反
   *    （被单测当场抓出来：maxChars 600 时 keptRows 只有 3）。
   *    正确目标：**条目覆盖优先**，字段可以让位。
   */
  for (let k = ordered.length; k >= MIN_COLS; k--) {
    const picked = ordered.slice(0, k)
    // 输出仍按原列序，读起来跟界面上的表一致
    const idx = picked.slice().sort((a, b) => a - b)
    const droppedCols = columns.filter((_, i) => !picked.includes(i)).map(c => c.label)
    const text = render(idx, rows.length) + noteOf(totalRows - rows.length, droppedCols)
    if (text.length <= maxChars) {
      return {
        text,
        compressed: true,
        keptColumns: idx.length,
        keptRows: rows.length,
        droppedColumnLabels: droppedCols,
        droppedRows: totalRows - rows.length,
      }
    }
  }

  /**
   * 三、连 2 列都装不下全部条目 ⇒ 才减行（此时已无列可减）。
   * 这么窄的预算一般是"某张表特别胖 + 总预算特别紧"，能给几条是几条，并如实申报。
   */
  const idx = ordered.slice(0, MIN_COLS).sort((a, b) => a - b)
  const droppedCols = columns.filter((_, i) => !idx.includes(i)).map(c => c.label)
  const headLen = joinCells(idx.map(i => columns[i].label)).length
  const budgetForRows = maxChars - headLen - noteReserveFor(maxChars)
  const lineLens = rows.map(r => joinCells(idx.map(i => r[i] ?? '')).length + 1)
  let acc = 0
  let n = 0
  for (const len of lineLens) {
    if (acc + len > budgetForRows) break
    acc += len
    n++
  }
  if (n === 0) {
    return { text: '', compressed: false, keptColumns: 0, keptRows: 0, droppedColumnLabels: [], droppedRows: totalRows }
  }
  return {
    text: render(idx, n) + noteOf(totalRows - n, droppedCols),
    compressed: true,
    keptColumns: idx.length,
    keptRows: n,
    droppedColumnLabels: droppedCols,
    droppedRows: totalRows - n,
  }
}
