/**
 * 3.4.2 · 线协议 driver 契约（`aiCore` 叶子层）
 *
 * 一个后端 = 一个协议 driver + 一组能力声明。`chat()` 只负责输出协议解析、
 * 上下文预算与用量上报，真正的「怎么发请求、怎么读流」由 driver 完成。
 *
 * 🔴 依赖方向：本文件只 `import type`（不引入运行时值），各 driver 可以放心引用，
 *    不会与 `chat.ts` 形成环（driver 不反向 import chat）。
 */

import type { AIProvider, ChatMessage, WireProtocol } from '@/lib/aiCore/core'
import type { SseLineParser } from '@/lib/aiCore/transport'
import type { RealUsage } from '@/lib/aiCore/usageParse'
import type { ChatUsage } from '@/lib/aiCore/usage'

/** driver 的内部调用参数（与 `chat.ts` 的 CallOpts 同形；由 chat 统一解析后传入） */
export interface DriverCallOpts {
  disableCompatibilityRetry?: boolean
  timeoutMs: number
  think?: boolean
  signal?: AbortSignal
  /** 流式回调：提供时开启 SSE 流式 */
  onToken?: (delta: string) => void
  /** 采样温度。**必填**：由 chat() 统一解析后传入，是唯一真源 */
  temperature: number
  /** 额外采样参数（原生键名） */
  extraOptions?: Record<string, number>
  /** 任务声明的输出上限（token）；Anthropic 这类必须显式 max_tokens 的协议用它 */
  outputTokens?: number
  /** 流式空闲超时 */
  idleTimeoutMs?: number
  /** 本次要下发的结构格式；只有端点能力被确认才会非 `none` */
  wireFormat?: 'none' | 'json-object' | 'json-schema'
  /** `wireFormat === 'json-schema'` 时随请求下发的 schema */
  jsonSchema?: Record<string, unknown>
}

/** driver 的返回（与 chat.ts 的 ChatRaw 同形） */
export interface DriverResult {
  content: string
  /** 本地模型加载耗时（毫秒）；联网协议恒为 0 */
  loadMs: number
  /** 真实 token 用量（拿不到就是 undefined，由 chat 决定是否退回估算） */
  usage?: RealUsage
}

/** 鉴权方式（配置界面与请求头构造共用） */
export type ProtocolAuth = 'none' | 'bearer' | 'x-api-key' | 'x-goog-api-key'

/** 系统提示放置位置 */
export type SystemSlot = 'messages' | 'top-level' | 'systemInstruction' | 'instructions'

/** 助手角色名 */
export type AssistantRole = 'assistant' | 'model'

/** 流式端点形态 */
export type StreamEndpoint = 'same' | 'separate'

/**
 * 线协议 driver。
 *
 * 🔴 只做协议适配：不碰提示词、不做内容改写、不缓存作品正文。
 *    提示词内容由上层逐字传入，driver 只负责「放在协议的哪个槽位」。
 */
export interface ChatDriver {
  protocol: WireProtocol
  /** 配置界面 / 错误文案用的显示名 */
  label: string
  /** 鉴权方式 */
  auth: ProtocolAuth
  /** 系统提示位置 */
  systemSlot: SystemSlot
  /** 助手角色名 */
  assistantRole: AssistantRole
  /** 流式是否走独立端点 */
  streamEndpoint: StreamEndpoint
  /** 用量账本的来源标签（旧两值保持不变） */
  usageSource: ChatUsage['source']
  /**
   * 本驱动能落成厂商结构化输出字段的范围。
   *
   * · `true`：`json-object` 与 `json-schema` 都能下发；
   * · `'json-schema'`：只能下发带 schema 的格式（如 Anthropic `output_config.format` 只支持 json_schema，
   *   不提供无 schema 的 JSON 对象模式）；`json-object` 时会降为 `none` 并如实记录；
   * · `false`：本版不向该厂商下发结构字段。
   */
  structuredWire: boolean | 'json-schema'
  /** 流式单行解析器；非流式协议可省略 */
  parseStreamLine?: SseLineParser
  /** 拉取该协议的可用模型清单（配置界面用）；未实现由调用方如实报错 */
  listModels?: (config: Pick<AIProvider, 'baseUrl' | 'apiKey' | 'headers'>) => Promise<string[]>
  /** 发一次逻辑调用（含协议自身的兼容降级） */
  chat(config: AIProvider, messages: ChatMessage[], o: DriverCallOpts): Promise<DriverResult>
}

/** 便捷构造：强制 `protocol` 与 `usageSource` 对齐，避免手写时漂移 */
export function defineDriver<D extends ChatDriver>(d: D): D {
  return d
}