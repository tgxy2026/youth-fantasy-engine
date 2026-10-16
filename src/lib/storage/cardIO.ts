/**
 * 角色卡（card 型页签）· 批量导入 / 导出适配层（3.1.x）。
 *
 * 【它解决什么】
 * 世界构建组的表格页签早有「导入 / 导出」（`TableSheet` + `TableImportDialog` + `tableIO`），
 * 但三个角色页签是 **card 型** —— 数据是 `CardRecord`（`data` 的键形如 `一、基础信息::姓名`），
 * 字段定义在 `tab.modules` 而不是 `tab.columns`。于是 `tableIO` 那一整套
 * （解析 / 映射 / 校验 / 落库 / 模板 / 说明）一个都用不上。
 *
 * 【做法：拍平成虚拟表格，把 tableIO 整套复用】
 * `cardTabToTableTab()` 把 `modules` 拍平成 `columns`（列名 = 纯字段名），得到一个
 * `type: 'table'` 的虚拟 `TabDef` —— 之后 `tableIO` 的每个函数、乃至「AI 智能拆分」
 * （`tableImportSplit`）都能**原样跑**，因为它们只认 `columns`。
 * 只有两件事需要本文件补：
 *   ① 列名（纯字段名）→ 存储键（`模块名::字段名`）的映射，落库时把键转回去；
 *   ② 多值引用字段（「所属势力」）的悬空校验要**逐个拆开**验 —— 见 `TableColumn.multiValue`。
 *
 * 🔴 三条与 tableIO 完全一致的纪律（动这里之前先读）：
 *   1. **列名即契约**：模板列头 = schema 原字段名（既不是 FieldAlias 的界面显示名、
 *      也不是 `模块::字段` 全路径）—— 同页签内字段名不重复，故短名无歧义；
 *      真有重名时自动退化为全路径，绝不静默串位。
 *   2. **勾稽靠名称**：跨表引用（所属势力 / 种族 / 地理位置）存的是名称字符串，
 *      导入只做「名称存在性校验」并提示，**绝不改写成 id**。
 *   3. **解析是纯函数、落库是副作用**：本文件不写库，落库由组件调 `db.saveCardRecord`。
 *
 * ⚠️ 本文件住在 lib，**不得 import components**（分层红线，见 `tests/importCycles.test.ts`）。
 */
import type { CardRecord, TableColumn, TableRow, TabDef } from '@/lib/types'
import { CARD_TABLE_REF_FIELDS } from '@/lib/schema'
import { CARD_SELECT_FIELDS } from '@/lib/world/cardFields'
import { buildImportGuide, exportRowsCsv, exportTemplateCsv, type ImportRowResult } from '@/lib/storage/tableIO'

/** 卡片的主字段名 —— 它既是「必填列」，也是卡片在左栏列表里的名字（与 `CharacterSheet.handleFill` 同口径） */
export const CARD_NAME_FIELD = '姓名'

/** 拍平后的一个卡片字段 */
export interface CardField {
  /** CSV 列头 / 列名映射键 —— schema 原字段名（同页签内唯一；重名时退化为 `模块::字段`） */
  name: string
  /** 存储键 —— `CardRecord.data` 的键，形如 `一、基础信息::姓名` */
  path: string
  /** 所属模块名（含 schema 里的序号，如「一、基础信息」） */
  module: string
  desc: string
  example: string
}

/**
 * 拍平 `tab.modules` → 字段列表（保持 schema 的模块顺序与模块内顺序）。
 *
 * 🔴 列名默认取**纯字段名**：三个角色页签内字段名互不重复，短名对作者友好得多
 *    （模板里写「核心性格」而不是「二、性格与内心::核心性格」）。
 *    但**重名时必须退化**成全路径 —— 否则两列同名，`mapHeaders` 会把它们映射到同一列，
 *    数据静默串位（这类错在预览里也看不出来）。故先数一遍重名，再决定列名。
 */
export function cardFieldsOf(tab: TabDef): CardField[] {
  const flat: CardField[] = (tab.modules ?? []).flatMap(m => m.fields.map(f => ({
    name: f.name,
    path: `${m.name}::${f.name}`,
    module: m.name,
    desc: f.desc,
    example: f.example,
  })))
  const seen = new Map<string, number>()
  for (const f of flat) seen.set(f.name, (seen.get(f.name) ?? 0) + 1)
  return flat.map(f => ((seen.get(f.name) ?? 0) > 1 ? { ...f, name: f.path } : f))
}

/** 列名 → 存储键（落库时把导入行的键转回 `CardRecord.data` 的键） */
export function cardFieldPathMap(tab: TabDef): Map<string, string> {
  return new Map(cardFieldsOf(tab).map(f => [f.name, f.path]))
}

/**
 * 「姓名」字段的存储键 —— **单一源**（列名因重名退化成 `模块::字段` 时也认得出来）。
 *
 * 🔴 必须只有一份：下面三处若各写各的「找姓名」逻辑，标题与姓名字段就会漂移 ——
 *    `cardRecordsToTableRows`（导出 / 判重的姓名兜底）、`buildCardRecords`（导入落库时取卡名）、
 *    `CharacterSheet` 的重命名补值。
 */
export function cardNamePath(tab: TabDef): string | undefined {
  const fields = cardFieldsOf(tab)
  return (fields.find(f => f.name === CARD_NAME_FIELD)
    ?? fields.find(f => f.path.endsWith(`::${CARD_NAME_FIELD}`)))?.path
}

/**
 * 把卡片页签拍平成 `tableIO` 能消费的**虚拟表格页签**（`type: 'table'` + `columns`）。
 *
 * 这是整个适配层的核心：世界构建组那一整套导入导出（解析 / 映射 / 校验 / 模板 / 说明 /
 * AI 智能拆分）只认 `tab.columns`，拍平之后**一个字节都不用改**就能跑。
 *
 * 字段类型按取值来源推断（与表格页签同口径）：
 *   · 跨表引用（所属势力 / 种族 / 地理位置）→ `tableRef`，勾稽靠名称；多选的标 `multiValue`；
 *   · 下拉枚举（人物状态 / 保密等级）→ `select`，候选值供 AI 拆分注入；
 *   · 其余 → `text`（`desc` 进 `tip`，说明文档里会带出来）。
 *
 * ⚠️ 人物立绘（`CardRecord.portrait`）**不在 columns 里** —— 它是图片、不是 `data` 字段，
 *    天然不会进 CSV，无需额外排除。
 */
export function cardTabToTableTab(tab: TabDef): TabDef {
  const fields = cardFieldsOf(tab)
  const columns: TableColumn[] = fields.map(f => {
    const ref = CARD_TABLE_REF_FIELDS[f.name]
    if (ref) {
      return {
        name: f.name,
        type: 'tableRef' as const,
        refTab: ref.tabId,
        refCol: ref.col,
        ...(ref.multi ? { multiValue: true } : {}),
        tip: ref.multi ? `${f.desc}（可多选，多个之间用中文逗号「，」分隔）` : f.desc,
      }
    }
    const sel = CARD_SELECT_FIELDS[f.name]
    if (sel) return { name: f.name, type: 'select' as const, options: sel.map(o => o.value), tip: f.desc }
    return { name: f.name, type: 'text' as const, tip: f.desc }
  })
  const hasName = columns.some(c => c.name === CARD_NAME_FIELD)
  return {
    ...tab,
    type: 'table',
    columns,
    // 主列 =「姓名」：它同时是必填判据与卡片名来源。万一某页签没有它，退回第一列（不硬失败）
    displayCol: hasName ? CARD_NAME_FIELD : columns[0]?.name,
  }
}

/**
 * 已有角色卡 → 判重用的表格行（`data` 的键 = 列名）。
 *
 * 🔴 R9（2026-10-16 独立复核）：**卡片标题与「姓名」字段并非始终同步** ——
 *    手工新建（`submitNamePrompt`）只设 `rec.name`、`data` 是空的；历史数据里也有
 *    重命名后标题与字段不一致的。若只读 `data`，这类卡导出的 CSV「姓名」列为空 ⇒
 *    ① 导出无法完整往返（再导回来名字没了）；② 判重键是空的、`hasKey` 为 false，
 *    同名角色**不会判重**、可以重复建卡；③ 姓名是必填列，重导时还会被默认不勾选。
 *    故姓名缺失时用**卡片标题兜底**，让导出 / 判重 / 落库三处口径一致。
 *    姓名字段**有值时不覆盖** —— 作者可能故意让标题与姓名不同（标题「陈渊（主角）」、
 *    姓名「陈渊」），那种情况以字段为准。
 */
export function cardRecordsToTableRows(tab: TabDef, records: CardRecord[]): TableRow[] {
  const fields = cardFieldsOf(tab)
  const nameCol = fields.find(f => f.name === CARD_NAME_FIELD)?.name
    ?? fields.find(f => f.path.endsWith(`::${CARD_NAME_FIELD}`))?.name
  return records.map(r => {
    const data: Record<string, string> = {}
    for (const f of fields) data[f.name] = r.data[f.path] ?? ''
    if (nameCol && !(data[nameCol] ?? '').trim()) data[nameCol] = r.name ?? ''
    return {
      id: r.id,
      projectId: r.projectId,
      tabId: r.tabId,
      data,
      order: r.order,
      ...(r.createdAt !== undefined ? { createdAt: r.createdAt } : {}),
    }
  })
}

/**
 * 把勾选保留的导入行构造成 `CardRecord`（**不写库**，由调用方调 `db.saveCardRecord`）。
 *
 * 卡名取「姓名」字段 —— 与 `CharacterSheet.handleFill`（AI 新增）同口径：
 * 卡片名与「姓名」字段本来就是同一个东西，导入时不该让作者填两遍。
 * 姓名为空的行正常不会走到这里（`validateImport` 已把它标成缺必填、默认不勾）。
 */
export function buildCardRecords(
  picked: ImportRowResult[],
  tab: TabDef,
  existing: CardRecord[],
  projectId: string,
  uid: () => string,
): CardRecord[] {
  const fields = cardFieldsOf(tab)
  const namePath = cardNamePath(tab)
  const fallbackName = `未命名${tab.group === '角色管理' ? '角色' : '设定'}`
  const out: CardRecord[] = []
  for (const r of picked) {
    const data: Record<string, string> = {}
    for (const f of fields) {
      const v = (r.data[f.name] ?? '').trim()
      if (v) data[f.path] = v
    }
    const name = (namePath ? (data[namePath] ?? '') : '').trim() || fallbackName
    out.push({ id: uid(), projectId, tabId: tab.id, name, data, order: existing.length + out.length })
  }
  return out
}

/** 导出空白模板 CSV：只有字段名表头行（不含示例数据，避免误当成一条记录导进去） */
export function exportCardTemplateCsv(tab: TabDef): string {
  return exportTemplateCsv(cardTabToTableTab(tab))
}

/** 导出已有角色卡为 CSV（列序 = 字段在 schema 里的顺序） */
export function exportCardsCsv(tab: TabDef, records: CardRecord[]): string {
  return exportRowsCsv(cardTabToTableTab(tab), cardRecordsToTableRows(tab, records))
}

/**
 * 生成《导入说明.md》—— 在表格版说明之上，补一段角色卡特有的事项。
 *
 * 🔴 为什么不能直接复用表格版：角色卡有三个表格没有的坑 ——
 *    ① 卡片名就是「姓名」字段（表格的主列名与卡名是两回事）；
 *    ② 立绘是图片，CSV 传不了，得单独说明，否则作者会以为漏了；
 *    ③ 「所属势力」可多选、用**中文**逗号分隔（表格里没有多值引用列；
 *       写成英文逗号会被 CSV 当成两列）。
 */
export function buildCardImportGuide(tab: TabDef): string {
  const lines = buildImportGuide(cardTabToTableTab(tab)).split('\n')
  const extra = [
    `> **本页是「${tab.name}」角色卡**：CSV 的一行 = 一张角色卡。`,
    '> · 「姓名」是必填列，也是这张卡在左侧列表里显示的名字。',
    '> · 「所属势力」「种族」「地理位置」请填**已有设定里的名称**（逐字一致）；',
    '>   对不上的名称导入后勾稽会悬空，预览会把它标出来（仍然可以导，只是那项关联不上）。',
    '> · 「所属势力」可多选，多个之间用**中文逗号「，」**分隔（如：青岚宗，天机阁）。',
    '>   写成英文逗号会被 CSV 当成两列，请勿使用。',
    '> · 「人物状态」「保密等级」请填下拉里的取值（保密等级填单字母 S / A / B / C / D）。',
    '> · 列名用的是软件的**原始字段名**，与你在界面里改过的「字段显示名」可能不同 —— 导入按原始名匹配。',
    '> · **人物立绘不在 CSV 里** —— 图片无法用表格传递，导入后在卡片右侧单独上传。',
    '',
  ].join('\n')
  // 插在标题行之后、正文之前
  lines.splice(1, 0, '', extra)
  return lines.join('\n')
}
