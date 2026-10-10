/**
 * 「字数区间校准」—— 把正文**补写 / 压缩到目标字数 ± 容差**之内（既补也压）。
 *
 * 【为什么单独成层】
 * 这条能力有两个使用方，而它们**互相不能 import**：
 *   · 逐章连写（`autoContinue.ts`）—— 每章生成后校准；
 *   · 整章改写（`aiTasks/rewrite.ts`）—— 改写后校准。
 * `autoContinue.ts` 依赖 `aiTasks` 门面，若把校准留在那里，改写侧去 import 就成了**循环依赖**
 * （会被 importCycles 闸拦）。抽到这一层后两边都只依赖 `ai` + `textStats`，方向干净。
 *
 * 🔴 **字数口径（全项目统一）**：一律按 `countWords` 计 —— **汉字逐字 + 拉丁词**，
 *    标点与空白**不计**。凡是给模型看的字数要求都必须写明「按汉字个数计，不含标点」：
 *    模型默认按 token 或字符估，写出来必然偏长（实测：目标 4000 写成 5000，超 25%）。
 */
import { chat, requireActiveProvider, stripThink, isCancelled } from '@/lib/ai'
import { countWords } from '@/lib/textStats'
import { newAuthorFence, authorBlock } from '@/lib/promptGuard'

/** 字数容差（±）：成品必须落在 `目标 ± 它` 之内 —— 界面、连写、改写三处共用同一常量 */
export const WORD_TOLERANCE = 300

/** 当前启用模型配置的类型（原在 `autoContinue`，随校准逻辑一并迁来；那边仍需它标注签名） */
export type Cfg = Awaited<ReturnType<typeof requireActiveProvider>>

// ============ 单次问答（剥思维链只作用于本次返回，绝不重复剥累加体） ============

export async function ask(
  cfg: Cfg, sys: string, user: string,
  opts: { signal?: AbortSignal; onToken?: (d: string) => void; json?: boolean } = {},
): Promise<string> {
  const raw = await chat(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], opts)
  return stripThink(raw).trim()
}

/** 非致命问答：取消向上抛，其它异常吞成空串由调用方按字数判定 */
export async function askSoft(
  cfg: Cfg, sys: string, user: string,
  opts: { signal?: AbortSignal; onToken?: (d: string) => void; json?: boolean } = {},
): Promise<string> {
  try {
    return await ask(cfg, sys, user, opts)
  } catch (e) {
    if (isCancelled(e)) throw e
    return ''
  }
}

// ============ 字数区间校准（既补也压） ============

/**
 * 补写用的**默认 system**。
 *
 * 🔴 必须与补写的 user 指令**同向**：user 说「只输出新增的正文片段」，
 *    而调用方若把「整章改写」那套 system（"请改写这一章，只输出正文…"）传进来，
 *    模型就被两套指令夹住了 —— 实测表现是**什么都不输出**：
 *    · 续写目标 3500，结果原样 2202（补写零生效，两次一致）；
 *    · 改写目标 3500，结果 2679 后不再往上补。
 *    两者都不是"模型波动"，而是喂了互相打架的提示词。
 */
const DEFAULT_FILL_SYS = [
  '你是资深网文作者，负责把已有的章节正文「接着往下补写」到目标字数。',
  '只输出新增的正文片段：不要重复或重述已有内容、不要重新开头、不要输出整章、不要任何说明文字。',
].join('\n')

export async function enforceWordRange(o: {
  cfg: Cfg
  body: string
  target: number
  /**
   * 补写用的 system；**不传就用 `DEFAULT_FILL_SYS`**。
   * ⚠️ 别把「整章改写」的提示词传进来（原因见 `DEFAULT_FILL_SYS` 的说明）。
   */
  sys?: string
  /**
   * 补写的目标字数（默认 = `target`）。
   *
   * 🔴 续写场景应传**区间下界**（`target - WORD_TOLERANCE`）：续写不能压缩（原文一字不动），
   *    按正中补一旦补多就永远超上限（实测：目标 3500 按正中补，结果超到 3968）。
   *    少补一点，反而更容易落进目标区间。
   */
  fillTarget?: number
  signal?: AbortSignal
  onToken?: (d: string) => void
  onPhase?: (p: string) => void
  onBodyReplace?: (s: string) => void
  /**
   * 补足 / 压缩**没生效**时如实说明（2026-09-20 加）。
   *
   * 🔴 为什么必须报：`askSoft` 会把模型调用失败吞成空串，随后**静默 break** ——
   *    调用方只看到"字数一点没变"，分不清是"模型失败"还是"本来就不需要补"
   *    （实测：续写目标 4000，结果 2202 原样返回，界面上只有 `2202 → 2202 字` 这一个线索）。
   */
  onLog?: (msg: string) => void
  maxExpand?: number
  maxShrink?: number
  /**
   * 本次在写第几章（2026-10-03）。**只影响补写指令的措辞**：补写是章节越界的高发段
   * （初稿差一截时，模型最容易靠「顺手把下一章也写了」凑字数），带上章号才能明确说
   * 「补的仍然是第 N 章」。不传就只说「本章」。
   */
  chapterNo?: number
}): Promise<string> {
  // 🔴 作者正文是**不可信文本**：补写与压缩两条路径都走边界块包裹（内容一字不改，
  //    见 promptGuard 文件头；同一章的多次补写/压缩共用一套边界语言）
  const fence = newAuthorFence()
  const fillSys = o.sys ?? DEFAULT_FILL_SYS
  const lo = o.target - WORD_TOLERANCE
  const hi = o.target + WORD_TOLERANCE
  let body = o.body
  let words = countWords(body)

  // ① 偏短：紧接上文分幕补写（增量单独剥思维链后再拼，避免砍掉已写正文）
  const maxExpand = o.maxExpand ?? 4
  for (let r = 0; r < maxExpand && words < lo; r++) {
    o.onPhase?.(`补足篇幅（${words} → ${lo}~${hi} 汉字）`)
    const gap = Math.max(0, (o.fillTarget ?? o.target) - words)
    const add = await askSoft(o.cfg, fillSys, [
      '【本章已写部分】',
      authorBlock(fence, body),
      '',
      `当前已写 ${words} 个汉字，距目标还差约 ${gap} 个汉字。请紧接着上文继续往下写，使全章总量落在 ${lo}~${hi} 汉字之间。`,
      '要求：不要重复或重述已写内容、不要重新开头、不要用形容词与心理独白注水；情节要实质推进；若剧情已近章末，则收束到章末钩子。只输出新增的正文片段。',
      // 🔴 2026-10-03 社区反馈的预防性加固：补写是**越界高发段** ——
      //    初稿差一截时，模型最容易靠「顺手把下一章也写了」来凑够字数。
      (o.chapterNo
        ? `🔴 补写仍属第 ${o.chapterNo} 章：只能在「本章范围内」展开（场景、对话、细节、心理描写），不得写出下一章的开头或提前展开下一章的事件。`
        : '🔴 补写只能在「本章范围内」展开，不得写出下一章的开头或提前展开下一章的事件。'),
    ].join('\n'), { signal: o.signal, onToken: o.onToken })
    if (countWords(add) < 30) {
      // 无效增量：停止空转，接受偏短。🔴 但必须**说出来**（否则调用方只看到"字数没变"）
      o.onLog?.(`补写未生效（模型只返回 ${countWords(add)} 汉字，可能失败或被截断）：停在 ${words} 汉字，目标 ${o.target}`)
      break
    }
    body = body.trimEnd() + '\n\n' + add
    words = countWords(body)
    o.onBodyReplace?.(body)
  }

  // ② 偏长：精简压缩到区间。安全阀：压出来过短视为模型偷懒/截断，保留原文（宁可超字也不丢情节）
  const maxShrink = o.maxShrink ?? 2
  for (let r = 0; r < maxShrink && words > hi; r++) {
    o.onPhase?.(`压缩篇幅（${words} → ${lo}~${hi} 汉字）`)
    const out = await askSoft(o.cfg,
      '你是资深网文编辑，擅长在不损失任何情节的前提下做「轻度」精简。只输出精简后的正文本身。',
      [
        // 🔴 给**具体删减量**而不是"压到 X 字"：只说目标时模型常按"精简"的字面理解大删
        //    （实测：3982 → 要求落到 3200~3800，模型一口气压到 2488，被安全阀判异常丢弃）。
        `下面这一章有 ${words} 个汉字，请「只删掉约 ${Math.max(1, words - o.target)} 个汉字」，`,
        `使全章落在 ${lo}~${hi} 个汉字之间（按汉字个数计，不含标点）。`,
        '🔴 这是「轻度压缩」，不是重写：',
        '1. 只删冗余的环境描写、重复铺陈、可有可无的形容词与心理独白 —— 删完仍要读得通顺。',
        '2. 保留全部关键情节、转折、对话要点与章末钩子，不得删除任何情节线，不得删掉结尾。',
        '3. 「不要合并场景、不要改写句子结构、不要缩写成摘要或提纲」。',
        '4. 保持原有叙事视角、人称与文风。',
        '5. 只输出精简后的完整正文，不要任何说明文字。',
        '',
        `【原文（${words} 汉字）】`,
        authorBlock(fence, body),
      ].join('\n'),
      // 🔴 `onToken` 是**流式开关**（不是"要不要显示"）：压缩要输出整章（几千字），
      //    非流式请求的响应头要等**整段生成完**才回来，必然撞 `CHAT_TIMEOUT_MS`(180s) ——
      //    后果是「压缩永远失败、超字永远压不下去」（实测：目标 3500、结果停在 3975）。
      { signal: o.signal, ...(o.onToken ? { onToken: o.onToken } : {}) })
    const ow = countWords(out)
    if (!out || ow < lo * 0.85) {
      o.onLog?.(`压缩结果异常（${ow} 汉字，低于下限 ${Math.round(lo * 0.85)}），保留原文 ${words} 汉字`)
      break
    }
    body = out
    words = ow
    o.onBodyReplace?.(body)
  }
  return body
}
