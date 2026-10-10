// AI 模型接入抽象层 · **门面**（2.8.0 瘦身：实现已按职责拆到 `aiCore/*`）
//
// 设计目标（v1）：
// - 本地 Ollama：免密钥，调用 /api/chat，适合离线、隐私优先的辅助创作。
// - 联网 OpenAI 兼容接口：Bearer 密钥，调用 /chat/completions；
//   国内主流平台（DeepSeek / 通义千问 / 智谱 GLM / 豆包 / Kimi / MiniMax 等）
//   均提供 OpenAI 兼容端点，用「预设」一键填好 baseUrl 即可。
// - 配置走现有 db.settingsKV（web/便携/桌面三端通用），不另起存储。
//
// 注意：浏览器 / Electron 渲染进程直接 fetch 外部地址可能受 CORS 限制，
// 这是平台侧策略，本层只负责把错误翻译成可读中文提示。
//
// 🔴 **门面纪律（照 `schema.ts` 的先例）**：外部一律 `from './ai'` 导入，不许各去深层路径；
//    本文件**显式再导出**（禁用 `export *`），原有导出只准增不准减 —— 少一个就是一片编译红。
// 🔴 段文件之间**不得 import 本文件**（会成循环依赖，浏览器侧可能 TDZ 崩，见 tests/importCycles）。
//
// 拆分版图：
//   · aiCore/core.ts      —— 类型 / 常量 / 平台预设 / 系统提示词拼接 / 调用前校验（依赖图叶子）
//   · aiCore/prompts.ts   —— 四条补全提示词 + 语境映射 + 登记（文件末尾）
//   · aiCore/transport.ts —— HTTP / SSE / 错误翻译（唯一的裸 JSON.parse 在传输信封解析）
//   · aiCore/chat.ts      —— 统一对话入口 + Ollama / OpenAI 两条通道 + 连通性测试
//   · aiCore/template.ts  —— 世界观上下文 + 设定模板补全 + 交互式 JSON 轮次
//   · aiCore/session.ts   —— 模型配置持久化 + 当前模型解析 + AI 就绪状态订阅

// 副作用：注册「设定模板补全 / 大纲规划三页签」四条提示词（原先位于 ai.ts 末尾）。
// 🔴 必须是裸引入 —— 只再导出 `FillContext`（类型）的话会在编译期被擦除，登记就不执行了。
import '@/lib/aiCore/prompts'
// 副作用：注册「AI 辅助规划」提示词（W2-3 自 components/AIAssist.tsx 搬来）。
// 🔴 同样必须裸引入：AIAssist 只在懒加载的「灵感工具」页里被 import，
//    注册留在那儿的话，没打开过该页签的作者在「AI 提示词」里看不到这条。
import '@/lib/aiAssistPrompt'

// ---- 共享内核：Provider 类型 / 超时温度常量 / 平台预设 ----
export {
  OLLAMA_DEFAULT_URL, CHAT_TIMEOUT_MS, TEST_TIMEOUT_MS,
  AI_TIMEOUT_MIN_SEC, AI_TIMEOUT_MAX_SEC, AI_TIMEOUT_DEFAULT_SEC, setChatTimeoutMs,
  DEFAULT_TEMPERATURE, TEMPERATURE_TIERS, LOCAL_DEFAULT_TEMPERATURE, CLOUD_DEFAULT_TEMPERATURE, JSON_TASK_TEMPERATURE,
  OLLAMA_PRESET, LOCAL_OPENAI_PRESETS, LOCAL_PRESETS, ONLINE_PRESETS,
  providerFromPreset, composeSystemPrompt,
} from '@/lib/aiCore/core'
export type { AIProviderType, AIProvider, ChatMessage, PlatformPreset } from '@/lib/aiCore/core'

// ---- 补全提示词语境 ----
export type { FillContext } from '@/lib/aiCore/prompts'

// ---- 传输层：思考块剥离 / 取消哨兵 / 地址归一 / 模型清单 / 卸载 ----
export { stripThink, AICancelled, isCancelled, openaiBaseOf, listOpenAIModels, listOllamaModels, unloadOllamaModel } from '@/lib/aiCore/transport'

// ---- 对话层：统一入口与连通性测试 ----
export { chat, OPENAI_SAFE_SAMPLING, testProvider } from '@/lib/aiCore/chat'
export type { ChatOptions, AITestResult } from '@/lib/aiCore/chat'

// ---- 设定补全：世界观上下文与模板补全 ----
export { WORLD_CONTEXT_GROUPS, buildWorldContext, aiCompleteTemplate, aiChatJson } from '@/lib/aiCore/template'
export type { TemplateField, TemplateFillResult, WorldContextGroup } from '@/lib/aiCore/template'

// ---- 会话层：模型配置持久化与就绪状态 ----
export {
  loadProviders, saveProviders, loadActiveId, saveActiveId, typeLabel,
  isProviderUsable, getActiveProvider, requireActiveProvider, aiReadySnapshot, subscribeAIReady,
  loadAiTimeoutSec, saveAiTimeoutSec,
} from '@/lib/aiCore/session'
export type { AIReadyInfo } from '@/lib/aiCore/session'

// ---- AI 用途路由（2.8.0 · 台账 #014）：创作 / 审校 / 整理各自指定模型 ----
// 🔴 aiRouting 只依赖 `./aiCore/session`（**不 import 本门面**），故此处再导出不成环。
export {
  TASK_ROLES, ROLE_LABEL, ROLE_HINT, DEFAULT_ROUTING,
  loadRouting, saveRouting, resolveProviderFor, requireProviderFor, rolesOf,
} from '@/lib/aiRouting'
export type { TaskRole, RoutingMap } from '@/lib/aiRouting'
