/**
 * 3.5.5 · ACP 结构化任务（宿主侧严格解析与校验）。
 *
 * 规划口径：ACP 组件当前只保证「回合完整结束 + 返回文本」，不保证 JSON schema。
 * 所以宿主负责：**按任务解析 → 严格核验完整性/字段/枚举/长度/引用 → 不合格就拒绝**。
 *
 * 🔴 三条硬约束（改动前先读）：
 *   1. **拒绝截断与损坏**：自带严格扫描器 —— 括号没闭合就判 `truncated`，散文/围栏外杂字判
 *      `invalid-json`，一律拒收。**不复用** `parseObjectArrayDetailed`：那条路会做截断修复，
 *      少半条 OOC 记录会被当成「没有这处问题」，用在结构化落地上是危险的。
 *   2. **不静默转用 API**：本模块只走 `acpText`，失败就把失败原因交给任务中心，
 *      绝不回落到 API 模型（否则「ACP 模式下没配 API 也能用」的承诺会被悄悄违反）。
 *   3. **引用要能对得上**：调用方通过 `assertReference` 校验引文/实体是否真存在于原文或作品，
 *      对不上按 `bad-reference` 拒收，不把定位失败的结果写进作品。
 */
import type { AcpTask } from './acpBridge'
import { acpGateMessage, acpGatedText, type AcpGateConfirmOptions } from './acpGate'

/** 3.5.5 结构化任务。校对因涉及原文位置校验，单独在 proofread.ts 里接。 */
export type AcpStructuredTask = Extract<AcpTask, 'review' | 'ooc' | 'advice' | 'proofread' | 'extract' | 'changes' | 'organize' | 'fill'>

export type AcpStructuredFailure = 'empty' | 'invalid-json' | 'truncated' | 'missing-field' | 'bad-field' | 'bad-reference'

/** 结构化结果不合格。`failure` 供任务中心区分「Agent 没按格式回」与「内容本身不可用」。 */
export class AcpStructuredError extends Error {
  readonly failure: AcpStructuredFailure
  constructor(failure: AcpStructuredFailure, detail: string) {
    super(`ACP 结构化结果不合格（${failure}）：${detail}`)
    this.name = 'AcpStructuredError'
    this.failure = failure
  }
}

const STRUCTURED_SCOPE: Record<AcpStructuredTask, { title: string; full: string; purpose: string }> = {
  review: { title: '发送章节资料至 ACP Agent', full: '本章正文与设定资料', purpose: '生成章节编辑意见（结构化评分与问题清单）' },
  ooc: { title: '发送章节资料至 ACP Agent', full: '本章正文与设定资料', purpose: '检查角色言行是否偏离人设（结构化清单）' },
  advice: { title: '发送章节资料至 ACP Agent', full: '本章正文与设定资料', purpose: '生成续写方向建议（结构化清单）' },
  proofread: { title: '发送本章正文至 ACP Agent', full: '本章正文', purpose: '校对错别字、语病与标点（结构化问题清单）' },
  extract: { title: '发送本章正文至 ACP Agent', full: '本章正文', purpose: '抽取可补登的设定实体（只出候选，不会自动写入设定表）' },
  changes: { title: '发送本章正文至 ACP Agent', full: '本章正文', purpose: '抽取章后整理的变化候选（伏笔 / 关系 / 状态，写入前仍要你核对）' },
  organize: { title: '发送整理材料至 ACP Agent', full: '所选章节正文与项目资料', purpose: '整理成表格候选条目（勾选后才会写入表格）' },
  fill: { title: '发送设定资料至 ACP Agent', full: '字段清单、项目资料与你填的草图', purpose: '补全设定模板（填好后仍要点应用才写入）' },
}

export interface AcpStructuredSendInput {
  task: AcpStructuredTask
  generation: string
  agentName: string
  signal?: AbortSignal
  assertCurrent?: () => void
  ask: (options: AcpGateConfirmOptions) => Promise<boolean>
  /**
   * 覆盖默认外发范围。校对分文字层（只发正文）与逻辑层（正文 + 设定），
   * 同一条任务标识下范围不同，必须让调用方如实指定 —— 不能让逻辑层顶着「只发正文」的文案发设定。
   */
  scopeText?: string
  /** 校对按块发送时只确认一次（其余任务单次调用，无需设置） */
  askOnce?: boolean
}

/** 生成传给 `ai*` 任务的 `acpText`：与报告类共用同一道闸门，只是范围文案不同。 */
export function acpStructuredText(input: AcpStructuredSendInput): (prompt: string) => Promise<string> {
  const scope = STRUCTURED_SCOPE[input.task]
  return acpGatedText({
    task: input.task,
    generation: input.generation,
    title: scope.title,
    message: acpGateMessage(input.agentName, input.scopeText ?? scope.full, scope.purpose),
    agentName: input.agentName,
    signal: input.signal,
    assertCurrent: input.assertCurrent,
    ask: input.ask,
    askOnce: input.askOnce,
  })
}

/** 外发范围文案（界面确认弹窗前可先展示）。 */
export function acpStructuredMessage(task: AcpStructuredTask, agentName: string, scopeText?: string): string {
  const scope = STRUCTURED_SCOPE[task]
  return acpGateMessage(agentName, scopeText ?? scope.full, scope.purpose)
}

/**
 * 追加到提示词末尾的「只输出 JSON」约束。
 *
 * 为什么必须写死 schema 示例：ACP 侧没有 `response_format` 之类的开关，
 * 只能靠提示词；把字段名、取值范围、条数上限逐条写出来，宿主校验才不会总是拒收。
 */
export function acpJsonInstruction(taskLabel: string, schema: string): string {
  return [
    `【输出格式】只输出一个 JSON 对象（或对象数组），不要任何解释文字、不要 Markdown 代码块标记。`,
    `任务：${taskLabel}。字段名与取值范围按下面示例，缺失或越界会被直接丢弃重来：`,
    schema,
  ].join('\n')
}

export interface AcpRowsLimits {
  /**
   * 结果形状：`object` = 单个 JSON 对象（编辑意见、续写方向）；
   * `array` = 对象数组（OOC 清单，允许合法空数组）。
   *
   * 🔴 必须显式声明：旧宽松解析器会「找第一个 `[` 切片」，于是
   *    `{"score":78,"dimensions":[…]}` 会被切成 **dimensions 数组**，
   *    结果行数变成 2、还被判成「条目过多」。这条踩过一次，别再用统一入口猜形状。
   */
  shape: 'object' | 'array'
  /** 至少几条；OOC 这类「合法为空」的任务传 0 */
  min: number
  /** 最多几条，超出即判不合格（防止 Agent 刷出几十条无用条目） */
  max: number
}

/** 去掉 ```json 围栏与前后空行；围栏本身不改变内容语义。 */
function stripFence(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('```')) {
    s = s.slice(3)
    if (s.startsWith('json')) s = s.slice(4)
    s = s.replace(/\s*```\s*$/, '')
  }
  return s.trim()
}

/**
 * 严格扫描出**第一个完整**的 JSON 值。
 * 与 aiParse 的容错路径不同：这里不做截断修复、不做元素过滤 ——
 * 截断就是截断，报给调用方，绝不拿半条结果当完整结果。
 */
function scanJson(raw: string): unknown {
  const s = stripFence(raw)
  if (!s) throw new AcpStructuredError('empty', 'Agent 没有返回任何内容')
  const start = [...s].findIndex(ch => ch === '{' || ch === '[')
  if (start < 0) throw new AcpStructuredError('invalid-json', '返回里没有 JSON 的起始括号')
  let depth = 0
  let inString = false
  let escaped = false
  let end = -1
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  // 括号没闭合 = 输出被截断（生成超时/输出上限最常见），必须区分于「格式不对」
  if (end < 0) throw new AcpStructuredError('truncated', 'JSON 没有闭合，输出被截断')
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    throw new AcpStructuredError('invalid-json', '括号完整但不是合法 JSON')
  }
}

/**
 * 按声明形状解析 Agent 返回，并做**严格**过滤。
 * 对象形状返回 1 行；数组形状逐元素要求是对象（有一个不是就整体拒收）。
 */
export function decodeAcpRows(raw: string, limits: AcpRowsLimits): Record<string, unknown>[] {
  const value = scanJson(raw)
  let rows: Record<string, unknown>[]
  if (limits.shape === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AcpStructuredError('invalid-json', '要求返回单个 JSON 对象，实际不是对象')
    }
    rows = [value as Record<string, unknown>]
  } else {
    if (!Array.isArray(value)) throw new AcpStructuredError('invalid-json', '要求返回 JSON 数组，实际不是数组')
    rows = value.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new AcpStructuredError('bad-field', `第 ${index + 1} 个条目不是对象`)
      }
      return item as Record<string, unknown>
    })
  }
  if (rows.length < limits.min) throw new AcpStructuredError('empty', `条目不足（${rows.length} < ${limits.min}）`)
  if (rows.length > limits.max) throw new AcpStructuredError('bad-field', `条目过多（${rows.length} > ${limits.max}）`)
  return rows
}

/**
 * 校对回复的两种**合法外壳**：顶层数组，或 `{issues:[…]}` 对象（API 侧新协议）。
 *
 * 为什么这里允许两种而不是只认一种：两种外壳在 API 侧都真实存在、历史数据也在用；
 * 但「每条必须是对象」不放宽 —— 放宽成过滤非对象，就等于把 Agent 的胡话当成「没问题」。
 */
export function decodeAcpIssues(raw: string, max: number): Record<string, unknown>[] {
  try {
    return decodeAcpRows(raw, { shape: 'array', min: 0, max })
  } catch (error) {
    // 只有「形状不对」才继续试对象外壳；截断是截断，直接抛
    if (!(error instanceof AcpStructuredError) || error.failure !== 'invalid-json') throw error
  }
  const envelope = decodeAcpRows(raw, { shape: 'object', min: 1, max: 1 })[0]
  const issues = envelope.issues ?? envelope['问题']
  if (!Array.isArray(issues)) throw new AcpStructuredError('invalid-json', '既不是数组，也没有 issues 数组')
  if (issues.length > max) throw new AcpStructuredError('bad-field', `条目过多（${issues.length} > ${max}）`)
  return issues.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AcpStructuredError('bad-field', `第 ${index + 1} 条不是对象`)
    }
    return item as Record<string, unknown>
  })
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
/** 取必填/可选文本字段，支持中英别名（模型不一定按示例的键名回）。 */
export function acpField(
  row: Record<string, unknown>,
  keys: string[],
  label: string,
  opts?: { required?: boolean; max?: number },
): string {
  const value = keys.map(k => text(row[k])).find(Boolean) ?? ''
  if (!value) {
    if (opts?.required === false) return ''
    throw new AcpStructuredError('missing-field', `缺少「${label}」`)
  }
  const max = opts?.max ?? 2000
  if (value.length > max) throw new AcpStructuredError('bad-field', `「${label}」过长（${value.length} > ${max}）`)
  return value
}

/** 取必填数值字段并校验区间；越界直接拒绝，不做 clamp（clamp 会把 85 分问题悄悄变成 100 分）。 */
export function acpNumber(
  row: Record<string, unknown>,
  keys: string[],
  label: string,
  opts: { min: number; max: number; integer?: boolean },
): number {
  const raw = keys.map(k => row[k]).find(v => v !== undefined && v !== null && v !== '')
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new AcpStructuredError('missing-field', `缺少或非法的「${label}」`)
  if (n < opts.min || n > opts.max) {
    throw new AcpStructuredError('bad-field', `「${label}」超出范围（${n}，应在 ${opts.min}~${opts.max}）`)
  }
  return opts.integer === false ? n : Math.round(n)
}

/** 取字符串数组字段：非数组→缺字段；元素过滤空串；超上限直接拒绝（不静默截断）。 */
export function acpList(
  row: Record<string, unknown>,
  keys: string[],
  label: string,
  opts: { max: number; required?: boolean },
): string[] {
  const raw = keys.map(k => row[k]).find(v => v !== undefined && v !== null)
  if (raw === undefined) {
    if (opts.required === false) return []
    throw new AcpStructuredError('missing-field', `缺少「${label}」`)
  }
  if (!Array.isArray(raw)) throw new AcpStructuredError('bad-field', `「${label}」不是数组`)
  const items = raw.map(text).filter(Boolean)
  if (items.length > opts.max) {
    throw new AcpStructuredError('bad-field', `「${label}」条目过多（${items.length} > ${opts.max}）`)
  }
  return items
}
