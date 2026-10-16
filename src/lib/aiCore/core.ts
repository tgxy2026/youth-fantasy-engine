/**
 * AI 接入层 · 共享内核（2.8.0 从 `lib/ai.ts` 拆出，见 `lib/ai.ts` 顶部说明）。
 *
 * 这里放的是被 aiCore 各模块**共同引用**的叶子内容：Provider 数据模型、超时与温度常量、
 * 平台预设、系统提示词拼接、调用前的配置校验。
 * 🔴 本文件**不 import 任何兄弟模块** —— 它是依赖图的叶子，循环依赖的风险在这里归零。
 */

export type AIProviderType = 'ollama' | 'openai'

import type { SamplingValues } from '@/lib/ai/modelSampling'

export interface AIProvider {
  id: string
  /** 用户自定义显示名 */
  name: string
  type: AIProviderType
  /** Ollama 默认 http://localhost:11434；OpenAI 兼容填到 …/v1 之类前缀 */
  baseUrl: string
  apiKey: string
  /** Ollama 用 /api/tags 拉到的本地模型名；OpenAI 兼容自由填写（如 deepseek-chat） */
  model: string
  /**
   * 是否为本机 / 局域网 OpenAI 兼容服务（LM Studio / LocalAI / GPT4All / Jan 等）。
   * true 时 precheck 不强制要求 apiKey（本地服务大多免密钥）；并与 ollama 一并标记为「本地」。
   */
  local?: boolean
  /** 用户自定义系统提示词：追加到各功能自带系统提示词之后，不覆盖、不影响原指令与格式约束 */
  systemPrompt?: string
  /**
   * 该模型的上下文窗口（tokens）。🔴 **模型配置里为必填**（2026-10-04）：酒馆上下文预算与记忆档、
   * 正文写作额度都按它推算，留空保存不了（校验统一走 `modelCapacity.checkContextWindow()`）。
   * 不按模型名猜的理由：各家版本窗口能差一倍，本地/自建/冷门模型永远认不出 —— 让作者填一次最准。
   * ⚠️ 类型仍可选（老库里的配置没这个字段）：`adviseCapacity` 兜底，界面标「未填窗口」引导补填。
   */
  contextWindow?: number
  /**
   * 该模型的**生成温度**（选填）。
   *
   * 为什么按 provider 存（2.4.0 · A1 遗留补全）：本地小模型与云端大模型合适的温度差别很大
   * （小模型偏高温才不呆板、大模型偏低温才不跑偏），做成一个全局常量必然"两头都不合适"。
   * 留空时回落到 {@link DEFAULT_TEMPERATURE}。
   *
   * ⚠️ **结构化 JSON 任务不受它影响** —— 那类固定走 {@link JSON_TASK_TEMPERATURE}（0.3），
   *    那是「解析稳定性」的红线，不能让显示偏好把它顶掉。
   */
  temperature?: number
  /**
   * 文本生成微调（2.9.2 · 六个采样参数，见 `lib/modelSampling.ts`）。
   *
   * 🔴 **留空或全都不填 ⇒ 不下发**（`samplingOptionsOf()` 返回 undefined），
   *    请求体与「没有这个功能」时逐字节一致 —— 保证升级不改变任何存量模型的行为。
   * 🔴 键名是**语义名**（`topP` / `repeatPenalty` …），下发时按 local/cloud 转成原生键；
   *    其中 `topK` / `repeatPenalty` / `repeatLastN` 是 Ollama 专有，云端会被白名单丢弃。
   */
  sampling?: SamplingValues
  /**
   * **自定义请求头**（3.1.1 第 4 项 · 选填）。
   *
   * 给「要求额外请求头才认」的订阅 / 网关用 —— 典型是 OpenCode Go 的
   * `x-opencode-session`（缺了直接 400）。发请求时由 `headers.mergeHeaders()` 合并进请求头，
   * 合法名放行、浏览器禁止设置的头（`User-Agent` / `Cookie` …）**明确拒绝并提示**。
   *
   * 🔴 留空或不填 ⇒ 请求头与改动前**逐字节一致**（升级不改变任何既有模型的行为）。
   * 🔴 仅对 OpenAI 兼容端点有意义（Ollama 原生路径不接受自定义头）。
   */
  headers?: Record<string, string>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434'

/**
 * 正文生成默认超时（毫秒）—— 既是**出厂值**，也是**兜底默认**。
 *
 * 🔴 2.9.0：由 `const` 改为 `let` —— 用户在「模型设置 → 模型配置」里可调
 *    （存储键 `aiRequestTimeoutSec`，单位秒；默认 {@link AI_TIMEOUT_DEFAULT_SEC}），
 *    设置变更时由 `aiCore/session.ts` 的 `ensureTimeoutApplied()` / `saveAiTimeoutSec()`
 *    调 {@link setChatTimeoutMs} 写进来。
 *    ⚠️ **ES module 的 import 是活绑定** ⇒ `aiTasks/**` 约 50 处
 *    `timeoutMs: CHAT_TIMEOUT_MS` 与 `timeoutMs: opts.timeoutMs ?? CHAT_TIMEOUT_MS`
 *    **一行都不用改**即自动跟随（同本文件提示词默认值的「模块级 let + setter」范式）。
 */
export let CHAT_TIMEOUT_MS = 180_000

/** 「请求超时」（秒）的取值范围：下限防「设太小误杀慢模型」，上限防填出天文数字 */
export const AI_TIMEOUT_MIN_SEC = 30
export const AI_TIMEOUT_MAX_SEC = 3600
/** 「请求超时」出厂默认（秒）—— 与酒馆 `common.timeoutSec` 对齐（本地模型首字慢，给足时间） */
export const AI_TIMEOUT_DEFAULT_SEC = 300

/**
 * 把「请求超时」写进 {@link CHAT_TIMEOUT_MS}。
 * 入参是**毫秒**（调用方拿秒 ×1000 传来）；内部按秒四舍五入并钳到
 * [{@link AI_TIMEOUT_MIN_SEC}, {@link AI_TIMEOUT_MAX_SEC}]；非有限数忽略（保留原值）。
 */
export function setChatTimeoutMs(ms: number): void {
  if (!Number.isFinite(ms)) return
  const sec = Math.min(AI_TIMEOUT_MAX_SEC, Math.max(AI_TIMEOUT_MIN_SEC, Math.round(ms / 1000)))
  CHAT_TIMEOUT_MS = sec * 1000
}
/** 连通性测试超时：只让模型回两个字，但本地模型可能要先加载进显存 */
export const TEST_TIMEOUT_MS = 90_000

/** 创意类生成（续写 / 取名 / 灵感）默认温度 */
export const DEFAULT_TEMPERATURE = 0.85
/**
 * 采样温度的**三档**（2.4.0 · A1 遗留补全）。
 *
 * 为什么给档位而不是让作者填数字：对写小说的人来说「稳 / 标准 / 活」比 0.85 直观得多；
 * 且本项目 `NumberField` 会 `Math.round` 掉小数，温度这种 0.85 的值根本填不进去。
 * 存进 provider 的仍是**具体数值**（见 AIProvider.temperature），换档即换值。
 */
export const TEMPERATURE_TIERS = [
  { label: '稳', value: 0.7, hint: '更贴前文、少出意外 —— 适合正剧，或需要严丝合缝的段落' },
  { label: '标准', value: 0.85, hint: '默认档：创意与稳定的平衡点' },
  { label: '活', value: 1.0, hint: '更跳脱多变 —— 适合脑洞段落，但更容易跑偏' },
] as const

/** 本地小模型的建议档位值：参数小、容易写得呆板，给「活」一档 */
export const LOCAL_DEFAULT_TEMPERATURE = 1.0
/** 云端大模型的建议档位值：创作力强但容易跑偏，用「标准」档 */
export const CLOUD_DEFAULT_TEMPERATURE = 0.85
/** 结构化 JSON 任务（校对 / 审读 / 改稿 / 抽取）专用：低温换取格式稳定 */
export const JSON_TASK_TEMPERATURE = 0.3

/** 国内 / 国际 OpenAI 兼容平台预设（baseUrl 为 chat/completions 的前缀） */
export interface PlatformPreset {
  label: string
  baseUrl: string
  /** 是否为本机 / 局域网服务（免密钥） */
  local?: boolean
  /** 该预设对应的 provider 类型：'ollama' 走原生 /api/chat；'openai'（默认）走 OpenAI 兼容 */
  type?: AIProviderType
}

/** Ollama 本地预设：原生 API，单独用 type:'ollama' 走 /api/chat 路径 */
export const OLLAMA_PRESET: PlatformPreset = { label: 'Ollama（本地）', baseUrl: OLLAMA_DEFAULT_URL, local: true, type: 'ollama' }

/** 本地 OpenAI 兼容服务预设（baseUrl 为本机端口，一般无需密钥，type 默认 openai）。
 *  这些服务都暴露 OpenAI 兼容的 /v1 接口，走与「联网模型」完全相同的调用路径，
 *  仅用 local 标记免除密钥要求并归类为「本地」。 */
export const LOCAL_OPENAI_PRESETS: PlatformPreset[] = [
  { label: 'LM Studio（本地）', baseUrl: 'http://localhost:1234/v1', local: true },
  { label: 'LocalAI（本地）', baseUrl: 'http://localhost:8080/v1', local: true },
  { label: 'GPT4All（本地）', baseUrl: 'http://localhost:4891/v1', local: true },
  { label: 'Jan（本地）', baseUrl: 'http://localhost:1337/v1', local: true },
  { label: 'TextGen WebUI（本地）', baseUrl: 'http://localhost:5000/v1', local: true },
]

/** 全部本地平台预设（Ollama + 本地 OpenAI 兼容），用于绿色「添加本地模型」按钮 */
export const LOCAL_PRESETS: PlatformPreset[] = [OLLAMA_PRESET, ...LOCAL_OPENAI_PRESETS]

/**
 * OpenCode Go 的 OpenAI 兼容端点（订阅制）。
 * 🔴 它**强制要求 `x-opencode-session` 请求头**（2026-09-06 起；缺失即 400
 * `Request is missing x-opencode-session and cannot be routed efficiently.`）——
 * 这正是「自定义请求头」这项能力的由来。官方文档里的另一写法是
 * `https://opencode.ai/inference/go/openai/v1`，两者都指向同一服务。
 */
export const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1'

/** 生成一个随机会话 id（Go 要求「每个会话一个稳定 UUID」，选一次预设生成一个即可） */
function newSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 联网 OpenAI 兼容平台预设（需 API 密钥，baseUrl 为 chat/completions 前缀） */
export const ONLINE_PRESETS: PlatformPreset[] = [
  { label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1' },
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { label: '通义千问 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: '豆包 Doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { label: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1' },
  { label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1' },
  { label: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { label: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1' },
  { label: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1' },
  { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  // OpenCode Go（订阅制）：OpenAI 兼容端点，**强制要求 `x-opencode-session` 请求头**
  // （2026-09-06 起；缺失即 400）。选中后由 `providerFromPreset` 预置一个随机会话 id。
  { label: 'OpenCode Go', baseUrl: OPENCODE_GO_BASE },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { label: '自定义', baseUrl: '' },
]

/** 由平台预设生成一条未保存的 provider 草稿（类型 / 本地标记自动带好） */
export function providerFromPreset(p: PlatformPreset): AIProvider {
  const id = 'p_' + Math.random().toString(36).slice(2, 9)
  const isOllama = p.type === 'ollama'
  const local = p.local ?? isOllama
  const name = (p.label.replace(/（本地）|（联网）|\(local\)/gi, '').trim()) || (isOllama ? '本地 Ollama' : '联网模型')
  return {
    id,
    name,
    type: isOllama ? 'ollama' : 'openai',
    baseUrl: p.baseUrl,
    apiKey: '',
    model: '',
    local,
    // 「一键套用采样」的落点（2.4.0 · A1 遗留补全）：按模型体量给一个合适的初始温度 ——
    // 本地小模型给高一点（不然呆板）、云端大模型给稳一点（不然跑偏）。
    // 只是初值，作者可在「模型设置 → 模型配置」里按自己的手感改。
    temperature: local ? LOCAL_DEFAULT_TEMPERATURE : CLOUD_DEFAULT_TEMPERATURE,
    // OpenCode Go：预置一个可直接用的会话 id（作者不必自己造 UUID）。
    // 🔴 只是「预填」——作者可在模型配置里改 / 删；不填的平台保持 undefined（请求头逐字节不变）。
    headers: p.baseUrl === OPENCODE_GO_BASE ? { 'x-opencode-session': newSessionId() } : undefined,
  }
}

/**
 * 「作者自定义系统提示词」块的固定开头 —— 既是界面可见的分隔标题，也是**注入标记**。
 *
 * 🔴 标记用途（2026-10-06）：`chat()` 兜底注入时靠它判断「这条 system 是不是已经拼过了」，
 *    避免已显式调用 `composeSystemPrompt` 的链路被**重复注入**一遍。
 *    ⇒ 想改这块文字，只改这里一处；别在任何地方硬写同一句话。
 */
export const USER_SYSTEM_MARK = '【作者自定义系统提示词'

/**
 * 组合系统提示词：把「用户自定义系统提示词」追加到「功能自带的系统提示词」之后。
 * 设计要点（用户要求）：
 * - 用户没填 → 仅用功能预设，行为与原先完全一致；
 * - 用户填了 → 附加在原本指令之后，作为「总体补充」，不覆盖、不破坏各功能的格式约束与铁律；
 * - 因此无论用户写什么，校对 / 补全 / 整理 / 对话等原有功能都不会受影响。
 */
export function composeSystemPrompt(featureSys: string, provider?: AIProvider | null): string {
  const base = featureSys || ''
  const custom = provider?.systemPrompt?.trim()
  if (!custom) return base
  const block = `${USER_SYSTEM_MARK}（请在遵循以上全部规则的前提下一并考虑）】\n${custom}`
  return base ? `${base}\n\n${block}` : block
}

/**
 * 兜底注入：保证「作者自定义系统提示词」一定进了这次请求。
 *
 * 🔴 为什么需要它（2026-10-06 覆盖面盘点）：注入原先只靠各调用点自觉调 `composeSystemPrompt`，
 *    结果**酒馆全目录 + 正文续写字数校准 + 全局对话引导共 18 处根本没接** ——
 *    而模型配置界面对作者的承诺是「对所有调用此模型的功能生效」。
 *    把这件事收进 `chat()` 之后，**新增 AI 功能只要走 chat() 就自动接入**，
 *    不再依赖谁记得手写那一行。
 *
 * 规则：
 *   · provider 没填 → 原样返回（零开销、行为不变）；
 *   · 已有 system 且含标记 → 原样返回（显式 `composeSystemPrompt` 过的，不重复拼）；
 *   · 有 system 但没标记 → 追加到**第一条** system 尾部（与 `composeSystemPrompt` 同形）；
 *   · 一条 system 都没有 → 在最前面补一条 —— 作者提示词仍要待在**最高指令层**，
 *     绝不能因为它来得晚就被降级成 user 消息。
 */
export function injectUserSystemPrompt(messages: ChatMessage[], provider?: AIProvider | null): ChatMessage[] {
  const custom = provider?.systemPrompt?.trim()
  if (!custom) return messages
  const idx = messages.findIndex(m => m.role === 'system')
  if (idx < 0) {
    return [{ role: 'system', content: composeSystemPrompt('', provider) }, ...messages]
  }
  if (messages[idx].content.includes(USER_SYSTEM_MARK)) return messages
  const out = messages.slice()
  out[idx] = { ...out[idx], content: composeSystemPrompt(out[idx].content, provider) }
  return out
}

/** 测试前的本地校验：缺字段就别浪费一次网络往返（`aiCore/chat.ts` 与 `aiCore/session.ts` 共用） */
export function precheck(config: AIProvider): string {
  if (config.type === 'ollama') {
    if (!config.model.trim()) return '未选择模型：请先「获取本地模型」并选择一个，或手动填写模型名。'
    return ''
  }
  if (!config.baseUrl.trim()) return '未填写 API 接口地址（baseUrl）。'
  if (!config.model.trim()) return '未填写模型名称。'
  // 本地 OpenAI 兼容服务（LM Studio / LocalAI 等）大多免密钥，故仅联网模型强制要求密钥
  if (!config.local && !config.apiKey.trim()) return '未填写 API 密钥（本地兼容服务可留空）。'
  return ''
}
