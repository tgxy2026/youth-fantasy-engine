/**
 * 酒馆模式 · 采样参数（继承式覆盖）
 *
 * 设计依据：方案 §4.9。
 *
 * 【继承链】会话参数 → 角色参数 → 模式默认 → 全局默认，**逐层覆盖**（越靠后越优先）。
 * 调用方按需传层即可，未传的层自动跳过。
 *
 * ★ 抄参数时最容易抄错的一处（方案 §4.9 专门标注）：
 *   界面叫「重复惩罚」，底层字段是 `repetition_penalty`，而到 Ollama 那边叫 `repeat_penalty`
 *   ——少了 "ition"。同一个参数、两个名字，别弄混。
 *
 * 本文件是纯逻辑，不含 React。
 */
import { TAVERN_DEFAULTS, type TavernParams } from '@/lib/tavern/types'

export type ResolvedParams = Required<TavernParams>

/**
 * 逐层覆盖出最终参数。
 * @param mode 'plot'（剧情，温度 0.9）/ 'free'（自由，温度 0.95 —— 更松）
 * @param layers 从低优先级到高优先级依次传入（如 角色参数, 会话参数）
 */
export function resolveParams(mode: 'plot' | 'free', ...layers: (TavernParams | undefined)[]): ResolvedParams {
  const out: ResolvedParams = { ...TAVERN_DEFAULTS[mode] }
  for (const layer of layers) {
    if (!layer) continue
    for (const [k, v] of Object.entries(layer) as [keyof TavernParams, number | undefined][]) {
      if (v !== undefined && v !== null && Number.isFinite(v)) out[k] = v
    }
  }
  return out
}

/**
 * 把解析后的参数翻译成 Ollama 原生 /api/chat 的 options 字段名。
 * ⚠️ 这里就是「重复惩罚」改名的地方：内部 repeatPenalty → Ollama 的 repeat_penalty。
 *
 * ⚠️ 两把「治复读」的旋钮（2026-09-16 新增）必须**显式下发**才有意义：
 *   · `repeat_last_n` —— 不传时 Ollama 用自带默认 **64 词元 ≈ 50 个汉字**，
 *     而它同时是 repeat_penalty / frequency_penalty / presence_penalty 三者的回看窗口，
 *     射程只有半句话 → 跨轮复读罚不到（见 GUIDE_REPEAT_LAST_N）。
 *   · `frequency_penalty` —— 不传时默认 **0（完全关闭）**，按词频扣分这件事根本没发生。
 */
export function toOllamaOptions(p: ResolvedParams): Record<string, number> {
  return {
    temperature: p.temperature,
    top_p: p.topP,
    top_k: p.topK,
    repeat_penalty: p.repeatPenalty,
    frequency_penalty: p.frequencyPenalty,
    repeat_last_n: p.repeatLastN,
    presence_penalty: p.presencePenalty,
    // 显式传 num_ctx：不传时 Ollama 会按全局 OLLAMA_CONTEXT_LENGTH（可能 128K）加载，
    // 显存占用远超预期（方案 §9.3）
    num_ctx: p.numCtx,
  }
}
