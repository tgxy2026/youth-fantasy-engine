/**
 * 3.4.2 · 线协议 driver 注册表
 *
 * 新增协议 = 新增一个 driver 文件 + 在这里登记；`chat()` 与所有 AI 功能侧不动。
 * 未登记的协议明确报错，绝不静默退回 OpenAI 兼容（那会把「不支持」伪装成「能用」）。
 */

import type { WireProtocol } from '@/lib/aiCore/protocol'
import { protocolOf } from '@/lib/aiCore/protocol'
import type { AIProvider } from '@/lib/aiCore/core'
import type { ChatDriver, DriverCapabilities } from '@/lib/aiCore/protocols/contract'
import { ollamaDriver } from '@/lib/aiCore/protocols/ollama'
import { openaiChatDriver } from '@/lib/aiCore/protocols/openaiChat'
import { anthropicDriver } from '@/lib/aiCore/protocols/anthropic'
import { geminiDriver } from '@/lib/aiCore/protocols/gemini'
import { responsesDriver } from '@/lib/aiCore/protocols/openaiResponses'

const REGISTRY: Partial<Record<WireProtocol, ChatDriver>> = {
  'ollama': ollamaDriver,
  'openai-chat': openaiChatDriver,
  'anthropic': anthropicDriver,
  'gemini': geminiDriver,
  'openai-responses': responsesDriver,
}

/** 按协议取 driver；未接入返回 undefined，由调用方如实报错 */
export function driverFor(protocol: WireProtocol): ChatDriver | undefined {
  return REGISTRY[protocol]
}

/** 运行时登记（新协议模块加载时调用；也便于测试注入受控假 driver） */
export function registerDriver(driver: ChatDriver): void {
  REGISTRY[driver.protocol] = driver
}

/** 已登记的 driver（配置界面 / 诊断用） */
export function registeredDrivers(): ChatDriver[] {
  return Object.values(REGISTRY).filter((d): d is ChatDriver => !!d)
}

/** 能力声明（规划 §4.A）：未登记协议返回 undefined，由调用方如实处理 */
export function capabilitiesOfProtocol(protocol: WireProtocol): DriverCapabilities | undefined {
  return REGISTRY[protocol]?.capabilities
}

/**
 * 统一模型清单入口（3.4.2）：按 provider 的线协议找对应 driver。
 * 未接入的协议明确报错，不静默退回 OpenAI 的 /models。
 */
export async function listModelsFor(config: AIProvider): Promise<string[]> {
  const protocol = protocolOf(config)
  const driver = driverFor(protocol)
  if (!driver?.listModels) {
    throw new Error(`暂不支持拉取该线协议（${protocol}）的模型清单。`)
  }
  return driver.listModels(config)
}