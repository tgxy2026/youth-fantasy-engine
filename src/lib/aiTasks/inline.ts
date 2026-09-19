// ============ AI 任务层 · AI 伴写（inline ghost 逐句续写）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #24 段）。
// 🔴 去 AI 味纪律（DEAI_INLINE_RULE）必须钉在 system **末尾**才有效。
import { chat, requireActiveProvider, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { authorBlock, newAuthorFence } from '../promptGuard'
import type { PromptDef } from '../promptSettings'

// ---------- 颉文姬⑦：AI 伴写（inline ghost 逐句续写 · 2.2.0） ----------
//
// 与「续写方向」（aiContinuationAdvice：只给方向、不落正文）的区别：本函数**直接产出正文续写片段**，
// 一次一句话，交给编辑器以浅灰 ghost 文本透在光标处；作者按 Tab 采纳才真正落进正文，继续打字即丢弃。
// 定位是"最轻的一档"——日常不断流、完全可逆、零打扰。
//
// 三条实现依据都来自本项目已实测结论，别随手改：
//   1. 🔴 反重复 / 去 AI 味的提示词**只有钉在 system 末尾才有效**，埋中段≈0（酒馆模式实测）。
//   2. 🔴 采样沿用 repeat_last_n=512 + frequency_penalty=0.1（手部率 28.9%→13.4%）；
//      **绝不调高 repeat_penalty** —— 1.4 实测动作行 2.08→0.43/轮且括号不闭合
//      （`（`/`）` 本身就在回看窗口里，惩罚会打在格式符上）。
//   3. 文风锚定不靠"文风枚举标签"，而走三层：①前文样本（必带、最准）②《写作规范》摘录（可关）
//      ③作者自定义补充。理由：枚举永不够用、选错标签反而更假，且伴写是低打扰场景，多一个选择就是多一次打断。

/** 伴写长度档位。给用户的是「档」不是数字——数字输入是伪自由度，用户不知该填多少，填大了 ghost 会糊住半屏 */
export type InlineSuggestLength = 'short' | 'sentence' | 'two'

export const INLINE_SUGGEST_LIMITS: Record<InlineSuggestLength, { label: string; chars: number; numPredict: number }> = {
  short: { label: '短句', chars: 20, numPredict: 40 },
  sentence: { label: '一句话', chars: 40, numPredict: 64 },
  two: { label: '两句', chars: 80, numPredict: 110 },
}

/**
 * 去 AI 味约束（**生成向**）。
 *
 * ⚠️ 不要复用 autoContinue.ts 的 DEAI_TEMPLATES：那 4 条写的是「把正文改得…」的**改写**指令，
 * 放进"生成"场景会让模型先去找正文再改写，甚至输出「以下是修改后的内容：」这类前言。
 * 这里只抽它们的共性，写成生成向的短约束——针对"一句话"这个粒度，不用长清单。
 */
let DEAI_INLINE_RULE = `【文风纪律 · 最重要】
不要用「仿佛 / 似乎 / 宛如 / 不禁 / 然而 / 值得一提的是 / 不知为何」这类 AI 高频套话开头；
不要堆四字成语与对称排比；不要写空泛的总结、升华或哲理感慨；
不要滥用破折号与省略号；多给具体的动作、对白、感官细节，句子长短错落，像活人顺手写下来的。`

/**
 * 伴写结果后处理（**纯函数，可单测**）。
 * 把模型返回的文本洗成"可直接落进正文的一段"：剥围栏 / 前言 / 包裹引号 → 折掉换行 → 按句末标点截断到字数上限。
 * @returns 可插入正文的片段；**返回空串表示本次不作建议**（少于 4 字视为噪声，宁缺毋滥——显示垃圾建议比不显示更烦人）。
 */
export function trimInlineSuggestion(raw: string, maxChars: number): string {
  let s = (raw ?? '').replace(/\r/g, '').trim()
  if (!s) return ''
  s = s.replace(/```[a-zA-Z]*\n?/g, '')                       // 去掉 markdown 代码围栏
  s = (s.split(/\n{2,}/)[0] ?? '').trim()                     // 只要第一段（模型偶尔会多续一段）
  s = s.replace(/\n+/g, '')                                   // ghost 是"一句话"，不落换行
  s = s.replace(/^["'“”]+/, '').replace(/["'“”]+$/, '')       // 整段被引号包裹
  s = s.replace(/^(?:好的|明白)[，,]\s*/, '')                  // 「好的，…」开场
  s = s.replace(/^(?:以下[是为][^：:]{0,14}[：:]|续写[：:]|接续[：:]|接下来[^：:]{0,8}[：:])\s*/u, '')
  s = s.trim()
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars)
    // 优先切在句末标点（保证 ghost 不会以半句悬空收尾）；退而求其次切在逗号；都没有才硬切
    let at = -1
    for (const p of ['。', '！', '？', '…', '；', '!', '?']) at = Math.max(at, cut.lastIndexOf(p))
    if (at >= Math.floor(maxChars * 0.4)) s = cut.slice(0, at + 1)
    else {
      const comma = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(','))
      s = comma >= Math.floor(maxChars * 0.5) ? cut.slice(0, comma + 1) : cut
    }
  }
  s = s.trim()
  return s.length >= 4 ? s : ''
}

export interface InlineSuggestOptions {
  /** 设定资料摘要（可空）。只用于核对专名 / 身份 / 称谓，不要求模型照抄内容 */
  projectContext?: string
  /** 《写作规范》摘录（已知坏习惯清单 / 标点规范 / 视角切换规则）；关闭该层时传空串 */
  styleSpec?: string
  /** ③ 作者自定义风格补充（可空） */
  styleNote?: string
  /** 长度档位，默认 'sentence'（一句话 ≤40 字） */
  length?: InlineSuggestLength
  /** 是否挂「去 AI 味」约束，默认 true（轻量档） */
  deAiFlavor?: boolean
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

/**
 * AI 伴写：根据光标之前的正文，续写紧接着的**一句话**（纯文本，非 JSON）。
 * @param contextBefore 光标之前的正文（调用方切片，建议末尾 2000 字内）
 * @returns 可直接插入正文的片段；空串 = 本次无合适建议，调用方应静默丢弃、不显示 ghost
 */
export async function aiInlineSuggest(contextBefore: string, opts: InlineSuggestOptions = {}): Promise<string> {
  const body = (contextBefore ?? '').trim()
  if (body.length < 8) return ''            // 前文太短（还没起句），无从"接着写"
  const cfg = await requireActiveProvider()
  const limit = INLINE_SUGGEST_LIMITS[opts.length ?? 'sentence']
  const goal = opts.length === 'short' ? '一个短句' : opts.length === 'two' ? '一到两句' : '一句话'

  // system 分层：基础约束 → 设定 → 写作规范 → 自定义补充 → 去 AI 味（🔴 必须最后）
  const layers: string[] = [
    `你是中文网络小说的「伴写」引擎，紧贴在作者的键盘后面，替他往下接${goal}。

【任务】只输出**紧接着前文往下写的正文本身**，${goal}，不超过 ${limit.chars} 字，写完立刻停。
【硬性要求】
1. 直接给正文。不要解释、不要说"好的"、不要引号、不要 markdown、不要标题、不要分点、不要换行。
2. 严格顺着前文的语气、人称、视角、时态、称呼与叙事节奏往下写，衔接自然到看不出接缝。
3. 不要复述或改写前文的最后一句，从它的下一步写起。
4. 不写总结、不写升华、不预告后文、不替作者收尾。`,
  ]
  if (opts.projectContext?.trim()) layers.push(`【设定资料（仅用于核对专名、身份、称谓，不要照抄内容）】\n${opts.projectContext.trim()}`)
  if (opts.styleSpec?.trim()) layers.push(`【作者的《写作规范》· 必须遵守】\n${opts.styleSpec.trim()}`)
  if (opts.styleNote?.trim()) layers.push(`【作者本次追加的文风要求】\n${opts.styleNote.trim()}`)
  if (opts.deAiFlavor !== false) layers.push(DEAI_INLINE_RULE)

  const user = `【光标之前的正文】\n${authorBlock(newAuthorFence(), body)}\n\n请接着往下写。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(layers.join('\n\n'), cfg) }, { role: 'user', content: user }],
    {
      // 这是创作任务，走全局创意档（默认 0.85），不手填温度——温度唯一真源在 ai.ts（项目铁律）
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: opts.signal,
      onToken: opts.onToken,
      // 🔴 必须关思考链（ai.ts 的 think 注释里已把伴写登记为第二个「有意关闭」的例外，与酒馆同类）：
      //    思考型模型（qwen3 系等）会先吐一大段推理，① 延迟从 1~3s 变成十几秒，ghost 手感直接崩；
      //    ② 万一只吐思考不给结论，ollamaChatRaw 有「content 为空则退用 thinking」的兜底，
      //    那段推理会被当成续写内容透到正文里。伴写要的是"顺手接一句"，不是推理。
      think: false,
      extraOptions: {
        top_p: 0.92,
        // Ollama 原生字段：显式限产出长度（不传时按模型默认，可能吐一长段）。
        // OpenAI 兼容端点的白名单只放行 top_p / presence_penalty / frequency_penalty，
        // 该字段会被 openaiSampling() 丢弃 —— 那边靠 prompt 约束 + 客户端句末截断兜底。
        num_predict: limit.numPredict,
        // 两把「治复读」的旋钮必须显式下发才生效（见 docs/酒馆模式-工程红线.md）：
        // repeat_last_n 默认仅 64 词元≈50 汉字，是三种惩罚共用的回看窗口，射程半句 → 跨句复读罚不到；
        // frequency_penalty 不传则默认 0，按词频扣分这件事根本没发生。
        repeat_last_n: 512,
        frequency_penalty: 0.1,
      },
    },
  )
  return trimInlineSuggestion(text, limit.chars)
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const INLINE_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'deai-rule', group: '正文写作', name: '去 AI 味纪律', note: '生成正文时附加的反 AI 腔规则（钉在 system 末尾）。' },
    read: () => DEAI_INLINE_RULE,
    write: t => { DEAI_INLINE_RULE = t },
  },
]
