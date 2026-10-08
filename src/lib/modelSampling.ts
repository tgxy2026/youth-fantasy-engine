/**
 * 模型生成参数微调（2.9.2）—— 「模型设置 → 模型配置」里那一组采样参数。
 *
 * 参照酒馆控制面板（`lib/tavern/paramGuide.ts` / `TavernControlModes`）搬迁，但**面向写作**：
 * 酒馆那套说明是写给角色扮演的（「人设漂移」「像在念设定稿」），写作场景想要的因果不同，故另写一份。
 *
 * 🔴 键名约定：界面与存储一律用**语义名**（`topP` / `repeatPenalty` …），
 *    只在**下发**时才按 local / cloud 转成目标接口的原生键（`top_p` / `repeat_penalty` …）。
 *    ⚠️ **命名陷阱**（酒馆 `params.ts` 专门标注过）：内部 `repeatPenalty` →
 *    Ollama 是 `repeat_penalty` —— **少了 "ition"**。同一个参数两个名字。
 *
 * 🔴 **留空 ＝ 不下发**：一个参数都不填时 `samplingOptionsOf()` 返回 `undefined`，
 *    请求体与「完全没有这个功能」时**逐字节一致** ⇒ 升级不改变任何存量模型的行为。
 *
 * 纯数据 + 纯函数，不含 React。
 */

/** 六个可调参数的语义名（`temperature` 不在此列 —— 它早就有独立字段 `AIProvider.temperature`） */
type SamplingKey =
  | 'topP' | 'topK' | 'repeatPenalty' | 'repeatLastN' | 'frequencyPenalty' | 'presencePenalty'

export type SamplingValues = Partial<Record<SamplingKey, number>>

interface SamplingField {
  key: SamplingKey
  /** 界面显示名（中文） */
  label: string
  min: number
  max: number
  step: number
  /** 推荐区间（写作向经验值，纯展示文案） */
  recommend: string
  /** 因果说明：调大 / 调小分别会怎样（说影响，不说好坏） */
  effect: string
  /** OpenAI 兼容端点是否认这个参数；false ⇒ 云端模型下界面灰显（Ollama 专有） */
  cloud: boolean
}

/**
 * 参数清单（界面按此顺序渲染）。
 * 🔴 `cloud: false` 的三项是 Ollama 专有：云端下发会被 `openaiSampling()` 白名单丢弃，
 *    所以界面在云端模型下**灰显**，免得作者以为调了会生效（这正是 2.9.2 一起修的那类问题）。
 */
export const SAMPLING_FIELDS: readonly SamplingField[] = [
  {
    key: 'topP', label: '核采样阈值', min: 0, max: 1, step: 0.01, cloud: true,
    recommend: '0.85 ~ 0.95',
    effect: '每一步只从「累积概率达到这个值」的词里挑。调低 ⇒ 候选面收窄、用词更保守也更重复；调高 ⇒ 表达更花哨，但更易出现别扭搭配与突兀书面语。',
  },
  {
    key: 'topK', label: '候选词上限', min: 0, max: 200, step: 1, cloud: false,
    recommend: '20 ~ 60（0 ＝ 不限制）',
    effect: '每一步只在概率最高的这么多个词里挑。调低 ⇒ 高度稳定但词汇贫乏，写长段落很快开始复读；调高 ⇒ 文风更活，本地小模型容易蹦出生造词与病句。',
  },
  {
    key: 'repeatPenalty', label: '重复惩罚', min: 0.5, max: 2, step: 0.01, cloud: false,
    recommend: '1.02 ~ 1.10',
    effect: '高于 1 压制重复用词。调高 ⇒ 复读与口头禅减少，但过高（> 1.35）连「的 / 了 / 他」这类虚词都会被回避、句子发硬；低于 1 等于反过来鼓励重复。',
  },
  {
    key: 'repeatLastN', label: '惩罚回看窗口', min: 0, max: 4096, step: 64, cloud: false,
    recommend: '512 ~ 1024',
    effect: '上面两种惩罚「回看多远」的词元数（≈ 汉字数）。调小 ⇒ 只罚近处、跨段的复读管不住；调大 ⇒ 覆盖更远，代价是更吃算力。⚠️ 不填时 Ollama 自带默认只有 64 词元（约半句话）。',
  },
  {
    key: 'frequencyPenalty', label: '词频惩罚', min: -2, max: 2, step: 0.05, cloud: true,
    recommend: '0 ~ 0.3',
    effect: '同一个词出现得越多扣得越狠。调高 ⇒ 反复出现的词（「翻」「冷笑」「缓缓」）会被压下去；调负 ⇒ 反过来鼓励重复。',
  },
  {
    key: 'presencePenalty', label: '新话题倾向', min: -2, max: 2, step: 0.05, cloud: true,
    recommend: '0 ~ 0.5',
    effect: '正数鼓励引入新内容，负数更愿意围着当前话题说。调高 ⇒ 更发散、也更容易跑题；调低 ⇒ 更聚焦，但可能绕圈反复讲同一件事。',
  },
] as const

/**
 * 把 provider 上的采样参数翻成**目标接口的原生键名**。
 *
 * - **Ollama 原生端点** ⇒ 六个全下发（`/api/chat` 的 `options` 认这些）
 * - 其它（云端 **＋ 本地 OpenAI 兼容**）⇒ 只下发白名单里的三个
 *   （`top_p` / `frequency_penalty` / `presence_penalty`）
 *
 * 🔴 一个都没填 ⇒ 返回 `undefined`（调用方据此**保持原样**，不下发空对象）。
 */
export function samplingOptionsOf(
  // ⚠️ `local` 保留在**入参类型**里（AIProvider 本就有这个字段，测试也要能构造「本地 OpenAI 兼容」
  //    的真实形态），但**判据不看它** —— 见 `isOllamaSamplingChannel`。
  p: { type?: string; local?: boolean; sampling?: SamplingValues } | null | undefined,
): Record<string, number> | undefined {
  const s = p?.sampling
  if (!s) return undefined
  const out: Record<string, number> = {}
  const put = (k: string, v: number | undefined) => {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
  }
  put('top_p', s.topP)
  put('frequency_penalty', s.frequencyPenalty)
  put('presence_penalty', s.presencePenalty)
  if (isOllamaSamplingChannel(p)) {
    put('top_k', s.topK)
    put('repeat_penalty', s.repeatPenalty)
    put('repeat_last_n', s.repeatLastN)
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * 这些参数会走 **Ollama 原生通道**吗（＝ `top_k` / `repeat_penalty` / `repeat_last_n` 是否真生效）。
 *
 * 🔴🔴 判据必须是 `type === 'ollama'`，**不是 `local`**。
 *   `local` 在本项目里的语义是「本机 / 局域网服务」（免密钥、窗口由显存决定那一类判断），
 *   而**本地 OpenAI 兼容服务**（LM Studio / LocalAI / GPT4All / Jan…）虽然 `local: true`，
 *   走的却是 `openaiChat` —— 它只认 `OPENAI_SAFE_SAMPLING` 白名单，上面三个键会被**静默丢弃**。
 *   用 `local` 判会让界面显示「可编辑」而下发被丢 —— 正是本轮（2.9.2）要修的那类「调了不生效」。
 *
 * 🔴 **界面三处灰显判据必须与本函数同源**：
 *   `AIConfigPanel` 的「文本生成微调」、`TavernControlModes` 的采样参数、
 *   `TavernControlBasics` 的「上下文窗口长度」，统一走 `components/SamplingUnavailable.tsx`。
 */
export function isOllamaSamplingChannel(p: { type?: string } | null | undefined): boolean {
  return p?.type === 'ollama'
}
