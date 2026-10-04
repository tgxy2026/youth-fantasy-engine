// ============ AI 任务层 · AI 整理（抽取成表）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #3 段）。
// 提示词 ORGANIZE_SYS 就地声明在本文件（promptSettings 要求「提示词 ↔ 用法」同处）。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { parseObjectArray, asText } from '../aiParse'
import { authorBlock, newAuthorFence } from '../promptGuard'
import type { PromptDef } from '../promptSettings'

// ---------- AI 整理（从已有资料 / 正文中抽取结构化条目） ----------

export interface OrganizeColumn {
  name: string
  /** 列语义提示（来自 schema 的 tip） */
  desc?: string
  /** 该列的合法取值：select 选项、角色名清单等。给了模型就必须从中挑 */
  allowed?: string[]
}

export interface OrganizeRequest {
  /** 表名，如「人物关系」 */
  tableName: string
  /** 表用途说明，给模型交代清楚要抽什么 */
  purpose: string
  columns: OrganizeColumn[]
  /** 已登记条目（只需关键列的值，用于让模型避开重复） */
  existingKeys: string[]
  /** 本地判重用的关键列 */
  keyColumns: string[]
  /**
   * 判重时是否忽略 A/B 顺序（通用参数，见 `rowFingerprint`）。
   *
   * 🔴 2.7.2 起人物关系 / 势力关系是**有向对 + 关系类型** ⇒ 调用方恒传 false。
   *    保留该参数是给「真正无序对」的表将来复用（口径见 `aiScope.isDirectedPairTab`）。
   */
  unorderedPair: boolean
  /** 待整理的正文（可为空，此时仅依据项目资料整理） */
  sourceText: string
  /** 全项目资料上下文 */
  projectContext: string
  /** 单次最多返回条数 */
  maxRows?: number
  signal?: AbortSignal
  /**
   * **额外要求模型输出的字段名**（不会写进表 —— 表里没这一列，写回时会被过滤掉）。
   *
   * 目前只用于「拆书末尾的关系整理」：要求模型给出「依据」原文片段，调用方本地核对
   * 那段话**确实出现在材料里**，编不出来的条目就丢掉。
   *
   * 🔴 为什么必须有这一道：2026-09-19 实机（本地 4B）实测，即便 prompt 里写明
   *    「只登记材料中明确写出的关系、项目资料不得用于推断」，模型仍会拿项目资料里
   *    已有但本书没提到的势力互相配对（编出「中州皇朝 · 血魔教」这种正文里不存在的关系）。
   *    逼它给出逐字引文 + 本地核对，是唯一确定性的兜底。
   */
  evidenceField?: string
  /** 流式回调：提供时整理过程逐块可见 */
  onToken?: (delta: string) => void
}

export interface OrganizeResult {
  /** 去重后可直接入表的新条目 */
  rows: Record<string, string>[]
  /** 模型原始返回条数 */
  rawCount: number
  /** 因与已有条目重复而被丢弃的条数 */
  dupSkipped: number
  /** 因缺关键列而被丢弃的条数 */
  invalidSkipped: number
}

/** 判重指纹：去掉标点空格、统一大小写；无序对则排序后拼接 */
export function rowFingerprint(row: Record<string, string>, keyCols: string[], unordered: boolean): string {
  const norm = (s: string) =>
    (s ?? '')
      .replace(/[\s,.;:!?，。、；：！？·"'"''()（）[\]【】《》<>—\-_/\\|]/g, '')
      .toLowerCase()
  const vals = keyCols.map(c => norm(row[c] ?? ''))
  if (unordered) vals.sort()
  return vals.join('||')
}

let ORGANIZE_SYS = `你是「青春幻想引擎」的小说资料整理助手。作者已经写好了正文与设定，你的工作是把其中「已经明确写出来」的信息，整理登记进指定表格。

铁律：
1. 只登记原文/设定中确有依据的内容。严禁虚构、严禁推测、严禁"合理补全"——这是资料整理，不是创作。
2. 绝不重复【已登记条目】里已有的条目。判断重复以【判重列】为准：这几列的值组合相同才算同一条（措辞不同也算同一条）。
   ⚠️ 配对类表格（人物关系 / 势力关系）的判重列是「A + B + 关系类型」⇒ **同一对实体可以有多种关系**：只要「关系类型」不同就不是重复，必须照常输出；绝不能因为「A 与 B 已经出现过」就跳过。
3. 返回一个 JSON 数组，每个元素是一个对象，key 必须严格使用【列清单】中给出的列名原文。
4. 某列标注了"可选值"时，必须从可选值中挑选；涉及人物的列必须使用与角色卡完全一致的正式姓名，不要用代称、绰号、"他/她"；涉及跨表引用的列（如势力A / 势力B）必须从可选值里逐字挑选，不要自己造名字、也不要改写简称。
5. 拿不准或原文未写明的列，给空字符串 ""，不要编造。
6. 没有任何可新增的条目时，返回空数组 []。
7. 只输出 JSON 数组本身：不要解释、不要前言后语、不要 markdown 代码块标记。`

/**
 * AI 整理：把正文/设定里已经写明的事实抽成表格行。
 * 双重保险防重复：prompt 里明确告知已有条目 + 返回后本地按关键列再去一遍重。
 */
export async function aiOrganizeRows(req: OrganizeRequest): Promise<OrganizeResult> {
  // #014 用途路由：批量补条目属「整理」—— 建议指向便宜 / 快的模型
  const cfg = await requireProviderFor('utility')
  const max = req.maxRows ?? 12

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

  const existing = req.existingKeys.length > 0
    ? req.existingKeys.slice(0, 300).map((k, i) => `${i + 1}. ${k}`).join('\n')
    : '（暂无，本表还是空的）'

  // 🔴 2.7.2：把「判重列」显式写进 user 消息。此前只有【已登记条目】+【列清单】，
  //    模型得自己猜哪几列是判重维度 —— 关系表改成「有向对 + 关系类型」后，
  //    不说清楚很容易把「同对不同类型」当成重复跳过（本地判重不会误杀，但模型先不输出就白搭）。
  const keyBlock = req.keyColumns.length > 0
    ? `\n【判重列（这几列的值组合相同即视为同一条，不要重复返回）】\n${req.keyColumns.join(' + ')}\n`
    : ''

  const user = `【目标表格】${req.tableName}
【整理目标】${req.purpose}

【列清单】
${colList}${keyBlock}

【已登记条目（这些绝对不要再返回）】
${existing}

【项目资料（世界观 / 角色 / 设定，用于对齐名称与背景）】
${req.projectContext.trim() || '（无）'}

【待整理文本】
${req.sourceText.trim() ? authorBlock(newAuthorFence(), req.sourceText.trim()) : '（作者未指定正文，请仅依据上方项目资料整理其中已明确写出、但尚未登记进本表的条目）'}

请返回最多 ${max} 条新条目的 JSON 数组，优先返回最重要、最确定的。${req.evidenceField ? `
每条还必须带一个「${req.evidenceField}」字段：从【待整理文本】里「逐字」摘一句能证明这条的原文（40 字以内，不要改写、不要拼接）。摘不出原文的条目「一律不要输出」 —— 宁可少给，也不要编。` : ''}`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(ORGANIZE_SYS, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: req.signal, onToken: req.onToken, json: true },
  )

  const arr = parseObjectArray(text)
  const colNames = req.columns.map(c => c.name)
  // 表列 + 额外校验字段（依据）：一起从返回对象里取值，后者不进表、只用于本地核对
  const fieldNames = req.evidenceField ? [...colNames, req.evidenceField] : colNames
  const seen = new Set(req.existingKeys.map(k => rowFingerprint(keyLineToRow(k, req.keyColumns), req.keyColumns, req.unorderedPair)))

  const rows: Record<string, string>[] = []
  let dupSkipped = 0
  let invalidSkipped = 0

  for (const item of arr) {
    const row: Record<string, string> = {}
    for (const name of fieldNames) {
      // 容错：模型可能用了去空格/大小写不同的 key
      const hit = Object.keys(item).find(k => k.trim() === name || k.trim().replace(/\s/g, '') === name.replace(/\s/g, ''))
      row[name] = hit ? asText(item[hit]) : ''
    }
    // 关键列必须齐全，否则这条没法判重也没法用
    if (req.keyColumns.some(c => !row[c]?.trim())) { invalidSkipped++; continue }
    const fp = rowFingerprint(row, req.keyColumns, req.unorderedPair)
    if (seen.has(fp)) { dupSkipped++; continue }
    seen.add(fp)
    rows.push(row)
    if (rows.length >= max) break
  }

  return { rows, rawCount: arr.length, dupSkipped, invalidSkipped }
}

/** 把「张三 ｜ 李四」形态的已登记摘要还原成关键列对象，供统一指纹计算 */
function keyLineToRow(line: string, keyCols: string[]): Record<string, string> {
  const parts = line.split('｜').map(s => s.trim())
  const row: Record<string, string> = {}
  keyCols.forEach((c, i) => { row[c] = parts[i] ?? '' })
  return row
}

/** 生成「已登记条目」摘要行，与 keyLineToRow 成对使用 */
export function keyRowToLine(row: Record<string, string>, keyCols: string[]): string {
  return keyCols.map(c => (row[c] ?? '').trim()).join(' ｜ ')
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const ORGANIZE_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'organize-rows', group: '设定与资料', name: 'AI 整理（抽取成表）', note: '从正文/设定里抽成表格行，增量补充、不重复已有条目。' },
    read: () => ORGANIZE_SYS,
    write: t => { ORGANIZE_SYS = t },
  },
]
