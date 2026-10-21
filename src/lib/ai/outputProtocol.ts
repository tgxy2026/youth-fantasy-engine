/**
 * 3.2.0 · WQ5 输出协议解析（纯函数，零 UI 依赖）
 *
 * 方案 §16.6：
 *   「任务分别声明 `output: text | json-object | json-schema`、`reasoning: default | off | required`、
 *    schema 版本和输出预算。旧 `json:true` 在兼容包装中保留原默认，逐条迁移后由任务明确决定；
 *    **不能全局改变旧调用的温度和思考行为**。」
 *   「端点不支持单次『推理＋结构』时沿用可用路径并说明限制；不默认增加『先构思再整理』的第二次调用。」
 *
 * 🔴 为什么单独成文件：`chat()` 里那行 `think = opts.think ?? (opts.json ? false : undefined)`
 *    把「要 JSON」和「不许思考」焊死在一起 —— 大纲/设定这类任务因此固定失去构思能力
 *    （方案 §8 第 753 行点名的缺陷）。要拆开这对概念，就必须有个地方**只**回答
 *    「这次请求该带什么参数」，而不是散在通道里各写一遍。
 *
 * 🔴 兼容口径（逐字保留，别改）：
 *    只传 `json: true`（老调用点）⇒ `reasoning = 'off'` + `JSON_TASK_TEMPERATURE`，
 *    与 3.1.x 完全一致。行为变化**只**发生在调用方显式声明 `output` / `reasoning` 之后。
 */
import { DEFAULT_TEMPERATURE, JSON_TASK_TEMPERATURE } from '@/lib/aiCore/core'
import type { ModelCapabilities } from './modelCapabilities'

/** 输出结构需求 */
export type OutputKind = 'text' | 'json-object' | 'json-schema'
/** 推理需求 */
export type ReasoningNeed = 'default' | 'off' | 'required'

export interface OutputDeclaration {
  output?: OutputKind
  reasoning?: ReasoningNeed
  /** `output: 'json-schema'` 时下发的实际 schema（缺省则降级为 JSON 对象下发并说明） */
  schema?: Record<string, unknown>
  /** 旧口径（兼容包装）：等价于「输出 JSON + 关推理」，但走的是旧的固定默认 */
  json?: boolean
  think?: boolean
  temperature?: number
  /** provider 自带的默认温度（云端/本地合适值差别大，见 `AIProvider.temperature`） */
  providerTemperature?: number
  caps: ModelCapabilities
}

export interface ResolvedProtocol {
  output: OutputKind
  /** **实际生效**的推理需求（可能被能力降级） */
  reasoning: ReasoningNeed
  /** 下发给通道的 think（undefined = 不传，保持模型默认） */
  think: boolean | undefined
  temperature: number
  /**
   * 能否向请求下发结构格式（`format` / `response_format`）。
   * 🔴 `none` ＝ 只靠提示词约束（现网所有端点都是这条路径，行为与 3.1.x 一致）。
   */
  wireFormat: 'none' | 'json-object' | 'json-schema'
  /** 与声明不一致的地方（人话，逐条给作者/日志看；空数组＝声明被完整满足） */
  limitations: string[]
  /** 是否走旧 `json: true` 兼容口径（行为与 3.1.x 逐字一致） */
  legacyJson: boolean
}

/**
 * 解析本次请求的输出协议。
 *
 * 判定顺序：
 *  ① 输出种类：显式 `output` > 旧 `json` > `text`；
 *  ② 推理需求：显式 `reasoning` > （旧 `json` ⇒ `off`）> `default`；
 *     旧口径保留「JSON 关思考」的原默认 —— 不能借迁移悄悄改老调用点的行为；
 *  ③ 能力闸：`required` + 结构化输出，但端点**未确认**支持「推理＋结构」同时使用 ⇒
 *     退回 `off` 并记一条限制（沿用可用路径，且说明限制）；
 *  ④ 结构格式下发：只有能力来源不是 `unknown` 且端点确认支持时才下发，否则只走提示词约束；
 *  ⑤ 温度：显式 > （结构化 ⇒ 低温 0.3）> provider 默认 > 全局默认。
 */
export function resolveOutputProtocol(d: OutputDeclaration): ResolvedProtocol {
  const legacyJson = d.json === true && d.output === undefined
  const output: OutputKind = d.output ?? (d.json ? 'json-object' : 'text')
  const wantReasoning: ReasoningNeed = d.reasoning ?? (legacyJson ? 'off' : 'default')

  const limitations: string[] = []
  const capsConfirmed = d.caps.source !== undefined && d.caps.source !== 'unknown'

  // ③ 推理与结构能否共存 —— 未确认一律按原路径关闭推理，并说明
  let reasoning = wantReasoning
  if (wantReasoning === 'required' && output !== 'text' && !(capsConfirmed && d.caps.reasoningWithStructure)) {
    reasoning = 'off'
    limitations.push(
      '该端点未确认支持「推理＋结构输出」同时使用：本次按原路径关闭推理（保住 JSON 可解析）。'
      + '需要构思能力时，请把该任务改为 text 输出后再整理。',
    )
  }

  // ④ 结构格式是否真的下发
  let wireFormat: ResolvedProtocol['wireFormat'] = 'none'
  if (output !== 'text') {
    const mode = d.caps.structuredOutput ?? 'none'
    if (capsConfirmed && mode !== 'none') {
      wireFormat = output === 'json-schema' && mode !== 'json-schema' ? 'json-object' : output
      if (output === 'json-schema' && wireFormat !== 'json-schema') {
        limitations.push('该端点只确认支持 JSON 对象格式，schema 细约束已退回提示词描述。')
      }
    } else if (output === 'json-schema') {
      limitations.push('该端点未确认支持结构格式：schema 只能靠提示词约束，返回后仍会做本地解析与校验。')
    }
    // 端点确认支持 schema，但这次任务没给 schema —— 别假装下发了细约束
    if (wireFormat === 'json-schema' && !d.schema) {
      wireFormat = 'json-object'
      limitations.push('本次没有提供 JSON schema：按 JSON 对象下发，字段结构仍由提示词约定。')
    }
  }

  // ⑤ 温度（旧 JSON 口径固定低温 = 3.1.x 行为）
  const temperature = d.temperature
    ?? (output !== 'text'
      ? JSON_TASK_TEMPERATURE
      : (d.providerTemperature ?? DEFAULT_TEMPERATURE))

  // think：显式优先；`default` 保持 undefined（不传字段 ⇒ 思考型模型保持思考）
  const think = d.think !== undefined
    ? d.think
    : reasoning === 'off'
      ? false
      : reasoning === 'required'
        ? true
        : undefined

  return { output, reasoning, think, temperature, wireFormat, limitations, legacyJson }
}

/** 把解析结果压成一句人话（日志/账本用，别在界面长篇展示） */
export function describeProtocol(p: ResolvedProtocol): string {
  const out = p.output === 'text' ? '文本' : (p.output === 'json-schema' ? 'JSON(schema)' : 'JSON 对象')
  const rea = p.reasoning === 'off' ? '不推理' : (p.reasoning === 'required' ? '要求推理' : '推理按模型默认')
  const wire = p.wireFormat === 'none' ? '提示词约束' : `下发 ${p.wireFormat}`
  return `${out} · ${rea} · ${wire}${p.limitations.length ? ` · ${p.limitations.length} 处降级` : ''}`
}
