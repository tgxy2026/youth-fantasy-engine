/**
 * 3.3.3 · A3：模型能力的**来源、缓存与诊断**（方案 §5 / §14.1）。
 *
 * 【优先级】显式用户覆盖 > 同端点同模型且未过期的主动实测 > 内置推断 > 保守默认。
 *    只有前两者能用来下发结构格式或开推理；内置推断只是"提示"，不能当凭据。
 *
 * 【缓存隔离】按「规范化端点 + 模型 + 协议 + 配置指纹」分开：
 *    · 同名模型接在不同中转上，能力可以完全不同（有的认 `response_format`、有的直接 400）；
 *    · 不存密钥本身，只存端点标识（去 userinfo / query / 尾斜杠）。
 *    · 端点、模型、协议、配置指纹任一变化 ⇒ 旧记录不再命中。
 *
 * 【失败语义】401 / 429 / 网络错误 / 超时一律**不写"不支持"**：
 *    它们说明不了模型能力，只说明这一次没测成。诊断文案必须带上"实际采用的能力及来源 + 下一步"。
 *
 * 🔴 能力测试是作者主动动作：会真实调用模型、可能计费；可跳过、超时、取消；
 *    不作为首次启动必经步骤（启动只做"读缓存"，不发请求）。
 */
import { ops } from '@/lib/db/core'
import type { StoreOps } from '@/lib/storage/storeOps'
import type { CapabilitySource, ModelCapabilities } from '@/lib/ai/modelCapabilities'

/** 实测结果有效期（30 天）。过期后当作"未测"，回落到内置推断。 */
export const CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const CAPABILITY_META_PREFIX = 'aiCapability::'

export type CapabilityTestState = 'supported' | 'unsupported'
export type CapabilityFailureReason =
  | 'auth' | 'rate-limit' | 'network' | 'timeout' | 'cancelled' | 'bad-response' | 'unknown'

export interface CapabilityTestRecord {
  /** `capabilityKeyOf()` 的结果（meta 键的后半段） */
  key: string
  /** 规范化端点（不含协议、userinfo、query；供诊断显示） */
  endpointKey: string
  modelId: string
  protocol: string
  configFingerprint: string
  state: CapabilityTestState
  /** 本次是否成功拿到可解析的 JSON 对象（**不等于**支持 json-schema） */
  jsonObject: boolean
  /** json-schema 本次未测 ⇒ unknown；不要因为"能解析 JSON"就说支持 schema */
  jsonSchema: 'unknown' | 'supported' | 'unsupported'
  reasoningWithStructure: boolean | 'unknown'
  at: number
  expiresAt: number
}

export interface CapabilityInput {
  endpoint: string
  modelId: string
  protocol?: string
  /** 只含影响能力判定的配置（如 structuredOutput）；**绝不能放密钥** */
  configFingerprint?: string
}

/** FNV-1a + 长度（只用于"变了没有"） */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16).padStart(8, '0')}-${text.length.toString(16)}`
}

/**
 * 规范化端点：保留协议和路径大小写，移除 userinfo、query 和片段。
 * 返回空串表示没填端点（此时不做实测缓存，避免把"没地址"当成一个端点）。
 */
export function normalizeEndpoint(raw: string): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  try {
    const url = new URL(s)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/**
 * 缓存键 = 规范化端点 + 模型 + 配置指纹。
 * 🔴 协议（openai / ollama）就在 `configFingerprint` 里（`capabilityConfigFingerprint` 会拼 type），
 *    这里不再单独拼一次 —— 否则两处口径容易一处传一处漏，表现为"刚测完却命中不了"。
 */
export function capabilityKeyOf(input: CapabilityInput): string {
  const endpointKey = normalizeEndpoint(input.endpoint)
  return hash([
    endpointKey,
    String(input.modelId ?? '').trim().toLowerCase(),
    String(input.configFingerprint ?? ''),
  ].join('\u0001'))
}

/**
 * 能力相关配置的指纹（**只放影响请求形态的字段**，绝不放密钥）。
 * 端点、模型、协议、这份指纹任一变化 ⇒ 旧实测不再命中。
 */
export function capabilityConfigFingerprint(p: {
  type?: string
  structuredOutput?: string
  reasoningWithStructure?: boolean
  capabilityVersion?: string
}): string {
  return JSON.stringify([
    String(p.type ?? ''), String(p.structuredOutput ?? ''), p.reasoningWithStructure === true ? '1' : '0',
    String(p.capabilityVersion ?? ''),
  ])
}

// ============ 内存缓存（进程内快速判断） ============
const memory = new Map<string, CapabilityTestRecord>()

function recordKeyOf(rec: CapabilityTestRecord): string {
  return rec.key
}

export function isCapabilityFresh(rec: CapabilityTestRecord | null | undefined, now = Date.now()): boolean {
  return !!rec && Number.isFinite(rec.expiresAt) && rec.expiresAt > now && !!rec.key
}

/** 读进程内缓存；过期/缺失返回 null（**不会**回落到别的端点） */
export function getCachedCapability(input: CapabilityInput, now = Date.now()): CapabilityTestRecord | null {
  // 参数和 URL 凭据可能改变服务端行为，又可能包含秘密；不持久化这些值作为缓存身份。
  try {
    const url = new URL(input.endpoint)
    if (url.search || url.username || url.password) return null
  } catch {
    return null
  }
  const rec = memory.get(capabilityKeyOf(input))
  return isCapabilityFresh(rec, now) ? rec ?? null : null
}

export function hydrateCapabilityTests(records: CapabilityTestRecord[]): void {
  for (const rec of records) {
    if (!rec || typeof rec.key !== 'string') continue
    if (!isCapabilityFresh(rec)) continue
    memory.set(rec.key, rec)
  }
}

/** 清空（测试 / 换账号时用） */
export function resetCapabilityMemory(): void {
  memory.clear()
}

// ============ 持久化（本机专属 meta） ============
export async function loadCapabilityTests(store: StoreOps = ops): Promise<CapabilityTestRecord[]> {
  try {
    const rows = await store.getAll<{ key: string; value?: CapabilityTestRecord }>('meta')
    return rows
      .filter(r => typeof r?.key === 'string' && r.key.startsWith(CAPABILITY_META_PREFIX) && !!r.value)
      .map(r => r.value as CapabilityTestRecord)
      .filter(rec => isCapabilityFresh(rec))
  } catch {
    return []
  }
}

/** 启动时读一次缓存（只读 meta，不发任何网络请求） */
export async function hydrateCapabilityCacheFromStore(store: StoreOps = ops): Promise<void> {
  hydrateCapabilityTests(await loadCapabilityTests(store))
}

export async function persistCapabilityTest(rec: CapabilityTestRecord, store: StoreOps = ops): Promise<void> {
  memory.set(recordKeyOf(rec), rec)
  await store.put('meta', { key: `${CAPABILITY_META_PREFIX}${rec.key}`, value: rec }).catch(() => {})
}

/** 诊断面板用：本次实际会采用的能力 + 来源 */
export interface CapabilityDiagnosis {
  source: CapabilitySource
  sourceLabel: string
  structuredOutput: 'none' | 'json-object' | 'json-schema'
  jsonOutput: boolean
  reasoningWithStructure: boolean
  maxContext: number
  maxOutput: number
  /** 实测记录（没有就是 null） */
  test: CapabilityTestRecord | null
  /** 给作者的一句话：采用的能力 + 下一步 */
  explain: string
}

export function sourceLabel(source: CapabilitySource): string {
  switch (source) {
    case 'user-config': return '作者在模型配置里明确确认'
    case 'isolated-test': return '作者主动实测（本机记录，30 天内有效）'
    default: return '内置推断 / 保守默认（只作提示，不据此下发结构格式）'
  }
}

export function describeCapability(caps: ModelCapabilities, test: CapabilityTestRecord | null = null): CapabilityDiagnosis {
  const source = caps.source ?? 'unknown'
  const structured = caps.structuredOutput ?? 'none'
  const parts: string[] = []
  if (structured === 'none') parts.push('本次只靠提示词约束 JSON（不下发 response_format / format）。')
  else parts.push(`本次会下发${structured === 'json-schema' ? ' JSON Schema' : ' JSON 对象格式'}。`)
  if (test) {
    parts.push(`实测记录：${test.state === 'supported' ? '端点可用' : '端点不可用'} · ${test.jsonObject ? '能解析 JSON 对象' : '未确认能解析 JSON 对象'}`
      + `${test.jsonSchema === 'unknown' ? ' · schema 未测' : ''}。`)
  }
  parts.push(source === 'unknown'
    ? '下一步：要下发结构格式，请在模型配置里明确选择；本次测试只验证响应。'
    : '下一步：如需重新确认，可再做一次实测（会调用模型）。')
  return {
    source,
    sourceLabel: sourceLabel(source),
    structuredOutput: structured,
    jsonOutput: caps.jsonOutput,
    reasoningWithStructure: caps.reasoningWithStructure === true,
    maxContext: caps.maxContext,
    maxOutput: caps.maxOutput,
    test,
    explain: parts.join(''),
  }
}

/** 失败归类：全都不写"不支持"，只说明这一次为什么没测成 */
export function classifyCapabilityError(e: unknown): {
  reason: CapabilityFailureReason
  retriable: boolean
  message: string
} {
  const status = (e as { status?: unknown } | null)?.status
  const name = (e as { name?: unknown } | null)?.name
  const msg = e instanceof Error ? e.message : String(e ?? '')
  if (name === 'AbortError' || /abort|cancel|取消/i.test(msg)) {
    return { reason: 'cancelled', retriable: true, message: '已取消：本次不改变能力结论。' }
  }
  if (status === 401 || status === 403 || /(^|\D)(401|403)(\D|$)|unauthorized|forbidden|invalid api key|鉴权|密钥无效/i.test(msg)) {
    return { reason: 'auth', retriable: false, message: '鉴权失败（401/403）：请检查密钥或账号权限；本次不改变能力结论（仍按未知处理）。' }
  }
  if (status === 429 || /(^|\D)429(\D|$)|rate limit|too many requests|限流/i.test(msg)) {
    return { reason: 'rate-limit', retriable: true, message: '被限流（429）：这次没测成，能力仍是未知；稍后再试。' }
  }
  if (/timeout|timed out|超时/i.test(msg)) {
    return { reason: 'timeout', retriable: true, message: '请求超时：本次不改变能力结论；可以重试或改用小模型试。' }
  }
  if (/fetch|network|econn|enotfound|econnrefused|failed to fetch|断网|网络/i.test(msg)) {
    return { reason: 'network', retriable: true, message: '网络错误：本次不改变能力结论（仍是未知）；检查端点地址与网络后再试。' }
  }
  if (/json|parse|解析/i.test(msg)) {
    return { reason: 'bad-response', retriable: true, message: '返回不是可解析的 JSON：只说明这次没按格式回答，不能据此判定模型"不支持"。' }
  }
  return { reason: 'unknown', retriable: true, message: '这次测试没有成功（原因不明）；本次不改变能力结论。' }
}
