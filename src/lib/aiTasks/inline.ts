// ============ AI 任务层 · AI 伴写（inline ghost 逐句续写）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #24 段）。
// 🔴 去 AI 味纪律（DEAI_INLINE_RULE）必须钉在 system **末尾**才有效。
import { chat, requireActiveProvider, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { deAiGenerateRule } from '../deAiStyle'
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
//   2. 🔴 采样治重复三旋钮（2026-09-28 第二轮，主人反馈伴写仍复读前文）：
//      repeat_last_n=1024（射程翻倍 ≈800 汉字，跨段复读进射程；窗口不施罚、只决定罚谁，纯扩覆盖）
//      + presence_penalty=0.2（出现过即一次性降温，不随词频累积——专治整句复述/换皮前文，不伤「的/了」高频字）
//      + frequency_penalty=0.1（**保持不动**：它按出现次数累积扣分，再拉高会把高频字罚到漏字；
//        下一档锚点 0.2 —— tests/live-repeat.ts C 组实测过的值）。
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
/**
 * 取 `deAiGenerateRule('brief')`：伴写一次只续一两句话，规则必须短 ——
 * 给完整版会把「只输出正文本身」这类硬要求挤没，反而更容易跑偏。
 * 真源在 `lib/deAiStyle.ts`（2.6.4 起所有去味儿规则只在那一份里改）。
 */
let DEAI_INLINE_RULE = deAiGenerateRule('brief')

/** 句中标点：断处已经是这些，就不必再补 */
const GHOST_MID_PUNCT = '，,、；;：:—…'
/** 句末标点 */
const GHOST_END_PUNCT = '。！？!?…」』”’）)'

/**
 * 折掉换行（ghost 只占一行），并在**断处补回句中标点**。
 *
 * 🔴 为什么必须补：模型给的「一句话」里偶尔自带换行（它按小句分段在吐），
 *    而下面直接把 \n 抹成空会把两个小句**粘成一串** ——
 *    社区反馈「伴写输出的一句话中间漏了逗号」（2026-10-02）的一条根因就在这儿。
 *
 * 判据：断处**前一个字符**若不是任何标点（句中标点与句末标点都算），就补一个「，」；
 * 已经是「，」「。」这类则原样折掉 —— 绝不重复加标点（重复标点比漏标点更难看）。
 * 行首就是换行时没有「上一句」，不补。
 *
 * 纯函数、可单测。
 */
export function foldGhostNewlines(s: string): string {
  return s.replace(/\n+/g, (_m, idx: number) => {
    const before = s[idx - 1] ?? ''
    if (!before) return ''
    if (GHOST_MID_PUNCT.includes(before) || GHOST_END_PUNCT.includes(before)) return ''
    return '，'
  })
}

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
  // ghost 是「一句话」，不落换行 —— 但**断处要补回标点**，否则两个小句会粘成一串（见上方函数注释）
  s = foldGhostNewlines(s)
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
  /**
   * 「换一句」：上一次已经给过的建议。传了就要求模型换一个写法。
   *
   * 为什么必须显式传：同前文 + 同参数在缓存里就是同一句，而"换一句"的语义是
   * **作者已经看过这句、不满意**。光绕开缓存还不够 —— 模型在同样的前文上多半会
   * 给出同样的续写，所以要把上一句当"避免重复"喂回去（见下方 layers 里的注入）。
   */
  avoid?: string
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
4. 不写总结、不写升华、不预告后文、不替作者收尾。
5. 标点必须完整：一句话中间的逗号、停顿一个都不要省，绝不能输出一长串连在一起、中间没有标点的字；末尾要有句号 / 问号 / 感叹号。`,
  ]
  if (opts.projectContext?.trim()) layers.push(`【设定资料（仅用于核对专名、身份、称谓，不要照抄内容）】\n${opts.projectContext.trim()}`)
  if (opts.styleSpec?.trim()) layers.push(`【作者的《写作规范》· 必须遵守】\n${opts.styleSpec.trim()}`)
  if (opts.styleNote?.trim()) layers.push(`【作者本次追加的文风要求】\n${opts.styleNote.trim()}`)
  // 「换一句」：上一句必须**整段**给出来，模型才认得出要避开什么。
  // ⚠️ 位置在去 AI 味规则**之前** —— 那条纪律必须钉在 system 末尾才有效（见文件头第 1 条依据）。
  if (opts.avoid?.trim()) {
    layers.push(`【上一次已经给过、这次不要用的建议】\n${opts.avoid.trim()}\n\n作者看过上面这句、不采用，请换一个「明显不同」的写法：\n· 可以换主语、换动作、换场景焦点，也可以干脆跳过它、直接写它后面本该发生的事；\n· 不要只把词换掉，不要同义改写，不要在原句上加减几个字。`)
  }
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
        // 「治复读」三旋钮必须显式下发才生效（依据见文件头第 2 条，2026-09-28 第二轮）：
        // repeat_last_n 默认仅 64 词元≈50 汉字，是三种惩罚共用的回看窗口——1024 射程 ≈800 汉字，跨段复读罚得到；
        // frequency_penalty 不传则默认 0，按词频扣分这件事根本没发生（保持 0.1，勿拉高——累积扣分会罚到高频字）；
        // presence_penalty 一次性扣分不随词频累积，专治整句复述/换皮前文，OpenAI 白名单本就放行该字段。
        repeat_last_n: 1024,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
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
