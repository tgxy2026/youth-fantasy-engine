/**
 * 3.3.3 · A3：作者主动发起的「模型能力实测」。
 *
 * 只做一件事：向**当前端点**发一次很小的 JSON 请求，确认这次能不能拿到可解析的对象。
 *
 * 🔴 它**不能**证明的事（诊断文案必须说清）：
 *    · 能解析 JSON 对象 ≠ 支持 `json-schema`（schema 未测）；
 *    · 一次失败 ≠ 模型不支持（401/429/网络/超时都只说明这一次没测成）；
 *    · 同一模型接在不同中转上能力可以不同 —— 结论按端点隔离。
 *
 * 🔴 计费与取消：会真实调用模型（可能计费）；作者点确认才发；可取消、默认 15 秒超时；
 *    取消/超时/错误都**不写缓存**，不污染能力结论。
 */
import { chat } from '@/lib/ai'
import { parseLooseObject } from '@/lib/ai/aiParse'
import { protocolOf, type AIProvider } from '@/lib/aiCore/core'
import {
  CAPABILITY_TTL_MS, capabilityConfigFingerprint, capabilityKeyOf, classifyCapabilityError, normalizeEndpoint,
  type CapabilityFailureReason, type CapabilityTestRecord,
} from '@/lib/ai/capabilityProfile'

export const CAPABILITY_TEST_TIMEOUT_MS = 15_000

export interface CapabilityTestOutcome {
  /** `supported` = 这次请求走通了（不代表 schema）；`unknown` = 没测成；`aborted` = 作者取消/超时 */
  state: 'supported' | 'unknown' | 'aborted'
  /** 只有 supported 才有记录（可持久化） */
  record: CapabilityTestRecord | null
  jsonObject: boolean
  message: string
  reason?: CapabilityFailureReason
  retriable?: boolean
}

export async function testModelCapability(input: {
  provider: AIProvider
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<CapabilityTestOutcome> {
  const provider = input.provider
  const timeoutMs = input.timeoutMs ?? CAPABILITY_TEST_TIMEOUT_MS
  const configFingerprint = capabilityConfigFingerprint(provider)
  const key = capabilityKeyOf({
    endpoint: provider.baseUrl, modelId: provider.model, protocol: protocolOf(provider), configFingerprint,
  })

  const ctrl = new AbortController()
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  const onAbort = () => { cancelled = true; ctrl.abort() }
  if (input.signal) {
    if (input.signal.aborted) { cancelled = true; ctrl.abort() }
    else input.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const text = await chat(
      provider,
      [
        { role: 'system', content: '你只需要输出一个 JSON 对象，不要解释、不要 markdown。' },
        { role: 'user', content: '请原样输出 {"ok": true} 这个 JSON 对象。' },
      ],
      { output: 'json-object', reasoning: 'off', timeoutMs, signal: ctrl.signal },
    )
    let jsonObject = false
    try {
      const v = parseLooseObject(String(text ?? '')) as unknown
      jsonObject = !!v && typeof v === 'object'
    } catch { /* 解析不了就如实记 false，不据此判"不支持" */ }
    const now = Date.now()
    const record: CapabilityTestRecord = {
      key,
      endpointKey: normalizeEndpoint(provider.baseUrl),
      modelId: provider.model,
      protocol: protocolOf(provider),
      configFingerprint,
      state: 'supported',
      jsonObject,
      jsonSchema: 'unknown',
      reasoningWithStructure: provider.reasoningWithStructure ?? 'unknown',
      at: now,
      expiresAt: now + CAPABILITY_TTL_MS,
    }
    return {
      state: 'supported',
      record,
      jsonObject,
      message: jsonObject
        ? '端点可用，并且这次返回能解析成 JSON 对象（schema 未测）。'
        : '端点可用，但这次回答不是可解析的 JSON 对象 —— 只说明这次没按格式回答，不能判定“不支持”。',
    }
  } catch (e) {
    if (timedOut) {
      return {
        state: 'aborted', record: null, jsonObject: false,
        reason: 'timeout', retriable: true,
        message: `超过 ${Math.round(timeoutMs / 1000)} 秒没有结果，已放弃；本次不改变能力结论。`,
      }
    }
    if (cancelled) {
      return {
        state: 'aborted', record: null, jsonObject: false,
        reason: 'cancelled', retriable: true,
        message: '已取消：本次不改变能力结论。',
      }
    }
    const c = classifyCapabilityError(e)
    return { state: 'unknown', record: null, jsonObject: false, reason: c.reason, retriable: c.retriable, message: c.message }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}