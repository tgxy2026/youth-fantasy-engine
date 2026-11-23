// ============ 语音转写（3.7.0 · W7）============
//
// 协议：OpenAI 兼容 `POST {baseUrl}/audio/transcriptions`（multipart，model 默认 whisper-1）。
// BYOK（D3 拍板）：作者自填 baseUrl / apiKey / model，**不内置任何服务商预设**；
// 配置独立于聊天模型，不参与聊天模型列表（`transport` 的 NON_CHAT 过滤口径不动）。
//
// 🔴 隐私（规划 §3 W7.2 ③）：
//   · 音频只发往作者配置的服务；本应用**不落盘、不进备份、不进云同步、不进诊断包**；
//   · 失败即弃（内存里的 Blob 随调用结束被回收），提示重试、不静默重发；
//   · 本模块不打印 apiKey / 请求头，错误文案只说「检查 apiKey」，不回显值。
import * as db from '@/lib/db'

export const TRANSCRIBE_CONFIG_KEY = 'transcribeConfig'
export const TRANSCRIBE_DEFAULT_MODEL = 'whisper-1'
/** 单次录音上限（先到先停；规划 §3 W7.2 ②） */
export const VOICE_MAX_SECONDS = 120
export const VOICE_MAX_BYTES = 10 * 1024 * 1024

export interface TranscribeConfig {
  baseUrl: string
  apiKey: string
  model: string
}

const EMPTY: TranscribeConfig = { baseUrl: '', apiKey: '', model: TRANSCRIBE_DEFAULT_MODEL }

export function normalizeConfig(raw: unknown): TranscribeConfig {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<TranscribeConfig>
  return {
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl.trim() : '',
    apiKey: typeof v.apiKey === 'string' ? v.apiKey.trim() : '',
    model: typeof v.model === 'string' && v.model.trim() ? v.model.trim() : TRANSCRIBE_DEFAULT_MODEL,
  }
}

export async function loadTranscribeConfig(): Promise<TranscribeConfig> {
  try {
    return normalizeConfig(await db.getMeta<unknown>(TRANSCRIBE_CONFIG_KEY, EMPTY))
  } catch {
    return { ...EMPTY }
  }
}

export async function saveTranscribeConfig(config: TranscribeConfig): Promise<void> {
  const next = normalizeConfig(config)
  await db.setMeta(TRANSCRIBE_CONFIG_KEY, next)
}

/** 「能用」判据：地址合法且 Key/model 不为空（不做连通性探测 —— 那会在作者没录音时就发请求） */
export function transcribeReady(config: TranscribeConfig): boolean {
  return /^https?:\/\//i.test(config.baseUrl.trim()) && !!config.apiKey.trim() && !!config.model.trim()
}

export function transcribeEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  // 作者把完整端点贴进来时不再重复拼（/audio/transcriptions 只出现一次）
  if (/\/audio\/transcriptions$/i.test(base)) return base
  return `${base}/audio/transcriptions`
}

export type TranscribeFailure = 'unconfigured' | 'auth' | 'too-large' | 'network' | 'http' | 'empty'

export interface TranscribeOutcome {
  ok: boolean
  text?: string
  failure?: TranscribeFailure
  /** 作者可见的如实说明（不含密钥） */
  detail?: string
}

/**
 * 把一段录音发给作者配置的转写服务。
 * 🔴 不落盘：`blob` 只在本函数的内存里活一次；成功返回文本，失败返回明确原因。
 */
export async function transcribeAudio(
  blob: Blob, config: TranscribeConfig, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<TranscribeOutcome> {
  const cfg = normalizeConfig(config)
  if (!transcribeReady(cfg)) {
    return { ok: false, failure: 'unconfigured', detail: '未配置转写服务：先在「模型设置 → 语音转写」填 baseUrl / apiKey / model。' }
  }
  if (!blob || blob.size === 0) return { ok: false, failure: 'empty', detail: '这段录音是空的，请重新录。' }
  if (blob.size > VOICE_MAX_BYTES) return { ok: false, failure: 'too-large', detail: '录音超过 10MB 上限，请缩短后重录。' }

  const form = new FormData()
  form.append('file', blob, `voice.${blob.type.includes('ogg') ? 'ogg' : 'webm'}`)
  form.append('model', cfg.model)
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(transcribeEndpoint(cfg.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: form,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: false, failure: 'auth', detail: '转写服务拒绝了请求（鉴权失败）：请检查 apiKey 是否有效。' }
    }
    if (res.status === 413) return { ok: false, failure: 'too-large', detail: '转写服务说音频太大（413），请缩短后重录。' }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, failure: 'http', detail: `转写服务返回 ${res.status}${body ? `：${body.slice(0, 120)}` : ''}` }
    }
    const data = await res.json().catch(() => null) as { text?: unknown } | null
    const text = typeof data?.text === 'string' ? data.text.trim() : ''
    if (!text) return { ok: false, failure: 'empty', detail: '转写服务返回了空结果，请重录或换模型。' }
    return { ok: true, text }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return { ok: false, failure: 'network', detail: '转写已取消。' }
    return { ok: false, failure: 'network', detail: '连不上转写服务（网络错误）。音频已丢弃，请检查网络后重试。' }
  }
}