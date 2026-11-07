/**
 * 3.4.2 · 线协议判据（叶子模块，零依赖）
 *
 * 🔴 为什么要单独成文件：`AIProviderType` 一个字段原先兼任两个正交语义 ——
 *    「用什么线协议说话」与「本地 / 联网」。直接扩联合类型会让本机判定、采样下发、
 *    用量解析跟着漂移，而且「碰巧对」不会报错（静默失明）。
 *    这里只回答「这条 provider 该走哪种线协议」，不碰本地 / 联网判断。
 *
 * 🔴 依赖方向：本文件**不 import 任何兄弟模块**。`core.ts`、`ai/modelSampling.ts`、
 *    `ai/modelCapacity.ts` 都可以安全引用它，不会与 `core.ts` 形成环。
 */

/** 线协议枚举。新增协议只加这里 + 一个 driver，不改既有存储键。 */
export type WireProtocol =
  | 'ollama'
  | 'openai-chat'
  | 'anthropic'
  | 'gemini'
  | 'openai-responses'

/** 旧 provider 只有 type（`'ollama' | 'openai'`），没有 protocol 字段 */
export interface ProtocolCarrier {
  type?: string
  protocol?: WireProtocol
}

/**
 * 取一条 provider（或平台预设）的线协议。
 *
 * 兼容口径：
 *   · 显式 `protocol` 优先；
 *   · 旧数据无 `protocol` ⇒ `type === 'ollama'` 映射为 `'ollama'`，其余映射为 `'openai-chat'`；
 *   · 缺省 / 空值 ⇒ `'openai-chat'`（与升级前「非 ollama 一律走 OpenAI 兼容」逐字一致）。
 */
export function protocolOf(p: ProtocolCarrier | null | undefined): WireProtocol {
  if (!p) return 'openai-chat'
  if (p.protocol) return p.protocol
  return p.type === 'ollama' ? 'ollama' : 'openai-chat'
}

/** 协议显示名（配置界面与错误文案共用，避免各处硬写中英混排） */
export const WIRE_PROTOCOL_LABELS: Record<WireProtocol, string> = {
  'ollama': 'Ollama 原生',
  'openai-chat': 'OpenAI 兼容（Chat Completions）',
  'anthropic': 'Anthropic Messages',
  'gemini': 'Google Gemini generateContent',
  'openai-responses': 'OpenAI Responses',
}

/** 是否 Ollama 原生协议（不是「是否本地」—— 远程 Ollama 也属于此协议） */
export function isOllamaProtocol(p: ProtocolCarrier | null | undefined): boolean {
  return protocolOf(p) === 'ollama'
}