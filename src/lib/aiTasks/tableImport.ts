// ============ AI 任务层 · 表格批量导入的「AI 智能拆分」============
// 2.7.0：社区反馈「已有一份成体系的设定，想整批搬进项目」。
//
// 【本地解析 vs AI 智能拆分】
//   · 本地解析（lib/tableIO 的 parseImportText / textToRows）能稳稳接住**规整**的输入：
//     Markdown 表格、Excel 复制出来的制表符、CSV、以及「列名：值」键值块。确定、不烧额度。
//   · 但**散文式设定**（一段人写的描述里夹着好几个人物/地点）本地规则会拆得七零八落，
//     或者整段合成一条。这时用模型做「智能拆分」：按语义切成多条记录、并对齐到目标表的列。
//
// 🔴 与「AI 整理」（organize.ts）的分工 —— 两者都产表格行，但**输入与判重口径不同**：
//   · AI 整理 = 从**已写正文 / 项目资料**里抽出「尚未登记」的事实；自带判重、增量补充、上限 12。
//   · 本任务 = 把**作者粘进来的一段内容**解析成表行；**不判重、不做增量判断** ——
//     重复与否交给导入预览的本地校验去标（`validateImport`），作者看得见、可勾选、可放弃。
//   若在这里也做判重，预览里就再也不会出现「与已有重复」这一状态，作者会以为导入行被吞了。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { parseObjectArray, asText } from '../aiParse'
import { authorBlock, newAuthorFence } from '../promptGuard'
import type { PromptDef } from '../promptSettings'
import { RULE_TABLE_COLUMN_KEYS, RULE_JSON_ARRAY_BARE } from './shared'

export interface ImportSplitColumn {
  name: string
  /** 列语义提示（来自 schema 的 tip） */
  desc?: string
  /** 该列的合法取值：select 选项、跨表引用名清单、角色名等。给了模型就必须从中挑 */
  allowed?: string[]
}

export interface ImportSplitRequest {
  /** 表名，如「人物关系」 */
  tableName: string
  /** 表用途说明，给模型交代清楚要解析成什么 */
  purpose: string
  columns: ImportSplitColumn[]
  /** 作者粘贴的原始内容（表格或散文） */
  sourceText: string
  /** 全项目资料上下文（用于对齐人名 / 势力名），可为空 */
  projectContext?: string
  /** 这一次调用最多返回多少条 */
  maxRows?: number
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

export interface ImportSplitResult {
  /** 解析出的行（key = schema 列名原文）；未做判重 */
  rows: Record<string, string>[]
  /** 模型原始返回条数 */
  rawCount: number
}

let TABLE_IMPORT_SPLIT_SYS = `你是「青春幻想引擎」的资料录入助手。作者粘贴了一段「已有内容」（可能是表格、也可能是散文式设定），你的工作是把这段内容「解析并拆分成多条记录」，逐条填进指定表格。

铁律：
1. 一条记录 = 一个独立对象（一个人物 / 一个地点 / 一种物品 / 一条关系 / 一个势力……）。
   「绝不把多个对象合并成一条」，也不要硬把一个对象拆成多条。作者最怕的就是"十几条设定被合成一条"。
2. 只依据作者粘贴的内容。内容里没写到的列，给空字符串 ""，严禁虚构、严禁推测、严禁"合理补全"。
3. ${RULE_TABLE_COLUMN_KEYS}
4. 某列标注了"可选值"时，必须从可选值中「逐字」挑选；涉及人物、势力、地点等跨表引用的列，
   也必须从可选值里逐字挑选，不要自己造名字、不要改写简称或别名。
5. 若粘贴内容本身就是一张表（带表头），按表头把单元格对齐到对应列（列名可能不在同一位置、也可能带空格）。
   若没有表头，就按每段语义判断该填哪些列。
6. 内容很短、确实只有一条时，也返回只含一条的数组；确实没有任何可解析内容时，返回空数组 []。
7. ${RULE_JSON_ARRAY_BARE}`

/**
 * 「AI 智能拆分」：把作者粘贴的内容解析成多条表格行。
 *
 * 不判重、不裁剪字段 —— 产出的行直接交给导入预览的本地校验（validateImport）标注
 * 「与已有重复 / 缺必填 / 悬空引用」，怎么处理由作者勾选决定。
 */
export async function aiSplitTableRows(req: ImportSplitRequest): Promise<ImportSplitResult> {
  // #014 用途路由：表格批量拆分属「整理」
  const cfg = await requireProviderFor('utility')
  const max = req.maxRows ?? 60

  const colList = req.columns
    .map(c => {
      const bits = [`- ${c.name}`]
      if (c.desc) bits.push(`（${c.desc}）`)
      if (c.allowed && c.allowed.length > 0) {
        const show = c.allowed.slice(0, 40).join(' / ')
        bits.push(`【可选值：${show}${c.allowed.length > 40 ? ' …' : ''}】`)
      }
      return bits.join('')
    })
    .join('\n')

  const user = `【目标表格】${req.tableName}
【解析目标】${req.purpose}

【列清单】
${colList}

【项目资料（世界观 / 角色 / 设定，用于对齐名称与背景；不要照抄它来编条目）】
${(req.projectContext ?? '').trim() || '（无）'}

【作者粘贴的内容】
${authorBlock(newAuthorFence(), req.sourceText.trim())}

请把上面这段内容解析成最多 ${max} 条记录，按出现顺序返回 JSON 数组。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(TABLE_IMPORT_SPLIT_SYS, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: req.signal, onToken: req.onToken, json: true },
  )

  const arr = parseObjectArray(text)
  const colNames = req.columns.map(c => c.name)
  const rows: Record<string, string>[] = []

  for (const item of arr) {
    const row: Record<string, string> = {}
    for (const name of colNames) {
      // 容错：模型可能用了去空格 / 大小写不同的 key
      const hit = Object.keys(item).find(
        k => k.trim() === name || k.trim().replace(/\s/g, '') === name.replace(/\s/g, ''),
      )
      row[name] = hit ? asText(item[hit]) : ''
    }
    // 整行全空的丢弃（模型偶尔会吐一个空对象占位）
    if (!colNames.some(n => (row[n] ?? '').trim())) continue
    rows.push(row)
    if (rows.length >= max) break
  }

  return { rows, rawCount: arr.length }
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const TABLE_IMPORT_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'table-import-split',
      group: '设定与资料',
      name: '表格导入 · AI 智能拆分',
      note: '把粘贴的设定（表格或散文）解析成多条表格记录，供导入预览逐条勾选。',
    },
    read: () => TABLE_IMPORT_SPLIT_SYS,
    write: t => { TABLE_IMPORT_SPLIT_SYS = t },
  },
]
