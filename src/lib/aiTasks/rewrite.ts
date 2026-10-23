// ============ AI 任务层 · 整章改写（润色 / 扩写 / 精简 / 续写 / 改写）============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #17 段）。
// 🔴 「动作 × 章位置」纪律矩阵（详规 docs/2.2.1-续排细纲*）：历史章冻结、最新章仅改写档放开。
//    三条纪律提示词（BASE / HISTORY_RULE / LATEST_RULE）都是可编辑项，就地声明在本文件。
import type { CallRequestContext } from '@/lib/ai/callTracking'
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { authorBlock, newAuthorFence } from '@/lib/ai/promptGuard'
import type { PromptDef } from '@/lib/ai/promptSettings'
// 🔴 字数硬校准与容差：从 `lib/wordRange.ts` 取（与逐章连写共用同一常量与同一条校准逻辑）
import { enforceWordRange, WORD_TOLERANCE } from '@/lib/editor/wordRange'
import { countWords } from '@/lib/editor/textStats'
import { deAiGenerateRule } from '@/lib/ai/deAiStyle'
import { activeFingerprintNote } from '@/lib/ai/styleFingerprint'
// 3.2.0 · WQ6：改写步骤也要有预算 —— 主改写 / 补写 / 压缩逐次记账，到上限暂停
import {
  AIRequestBudgetExhaustedError, type AttemptBudget,
} from '@/lib/ai/requestLedger'

// ---------- 整章改写（润色 / 扩写 / 精简 / 续写 / 改写） ----------
//
// 与「选区改稿」（aiRewritePassage）的分工 —— 两者不是替代关系，是按篇幅分工：
//   · 选区改稿：作者在编辑器里选中**一段**，走 JSON 输出（{rewritten, notes}），结果写成"建议段"；
//   · 整章改写：对**一整章**做重写，走纯文本流式输出，结果在面板里预览、作者确认后才替换正文。
// 为什么整章不能复用选区改稿：① 建议段会和原文并排堆成两倍篇幅，作者没法读；
//   ② 把 4000 字塞进 JSON 字符串，引号 / 换行转义极易解析失败（会退化成"只输出几个标点"）；
//   ③ 它的定位是"局部修改"，不是"重写一章"。

export type ChapterRewriteAction = 'polish' | 'expand' | 'condense' | 'continue' | 'rewrite'

/**
 * 五种动作的界面文案；`needWords` = 这一档要不要问目标字数。
 *
 * 🔴 「扩写」与「续写」的区别（老大 2026-09-20 指出它们不是一回事）：
 *    · **扩写**＝通篇加料：原文会被**重写一遍**（句子更长、细节更多），文字层面与原稿不同；
 *    · **续写**＝末尾接续：**原文一字不动**，只在其后追加新内容，把全章补到目标字数。
 *    写成"这一章还没写完"就用续写；觉得"写得干、想加细节"才用扩写。
 */
export const CHAPTER_REWRITE_META: Record<ChapterRewriteAction, { label: string; hint: string; needWords: boolean }> = {
  polish: { label: '润色', hint: '提升文字表现力、去掉 AI 腔；不增删情节，字数与原文相当', needWords: false },
  expand: { label: '扩写', hint: '在不改情节的前提下补细节与感官描写，把这一章写到目标字数（会重写整章文字）', needWords: true },
  condense: { label: '精简', hint: '去掉冗余与注水，保留全部有效信息，压到目标字数', needWords: true },
  continue: { label: '续写', hint: '原文一字不动，只接着末尾往下写，把全章补到目标字数（适合「这一章还没写完」）', needWords: true },
  rewrite: { label: '改写', hint: '按你的要求重写这一章（换视角 / 调节奏 / 重排场景…）', needWords: true },
}

let CHAPTER_REWRITE_BASE = `你是资深中文网络小说编辑，负责对作者给出的「整章正文」做改写。

铁律：
1. 只输出改写后的正文本身 —— 不要任何解释、小标题、开场白、结束语，也不要 markdown 代码围栏。
2. 保持原有叙事视角与人称；除非作者明确要求，不改人物、不改情节走向、不改章末钩子。
3. 段落之间用空行分隔，与原文格式保持一致。
4. 不要写「以下是修改后的内容」这类前言。`

const CHAPTER_REWRITE_ACTION_RULES: Record<ChapterRewriteAction, string> = {
  polish: '本次动作：「润色」。提升文字表现与节奏，改掉 AI 腔（「仿佛 / 似乎 / 不禁 / 然而 / 不知为何」这类高频套话、堆砌的四字成语与对称排比、滥用破折号）；「不增删情节」，字数与原文相当（±10%）。',
  expand: '本次动作：「扩写」。在不改情节走向的前提下补细节：环境与感官、人物动作与微表情、对话的潜台词、情绪递进。「不要注水」（不重复同一信息、不空泛抒情），把章节扩到目标字数。',
  condense: '本次动作：「精简」。去掉冗余重复、注水抒情与无信息量的过渡，保留全部有效情节与关键对白，压到目标字数。',
  continue: '本次动作：「续写」。🔴 「原封不动保留作者已有的正文」 —— 一个字都不改写、不删减、不调整顺序、不润色；只在它末尾接着往下写新内容，使全章总量达到目标字数。续写部分必须严格承接原文最后一段的时间、地点、人物状态与情绪；不要重复或重述已写内容、不要重新开头、不要写前情提要。',
  rewrite: '本次动作：「按作者要求改写」。保持人物与情节主线，按【改写要求】调整叙述方式 / 场景顺序 / 冲突强度 / 节奏。',
}
//
// 「最新章」与「历史章」必须分开对待（老大 2026-09-19 要求）：
//   · 改**历史章**的风险是**污染设定** —— 旧章里的境界 / 身份 / 关系一改，后面已经写好的正文
//     与设定表就全对不上了。所以历史章只允许**文字层面**的加工，设定类内容一律冻结。
//   · 改**最新章**可以放开手脚（它后面还没有正文）；但正因如此，落库后必须补跑一轮
//     设定抽取 / 补登 / 更新，把这一章的新信息同步进设定表（否则「接着写」时会读到旧设定）。
let CHAPTER_REWRITE_HISTORY_RULE = `【本次改写的是「已定稿的旧章」】这一章后面已经有写好的正文与对应设定 —— 所以「设定类内容一律冻结」：
旧章里的身份 / 关系 / 境界 / 器物来历一旦被改动，后面已写好的正文与设定表就全对不上了。

「通用红线」（四种动作都适用）：
- 不改人物的身份 / 关系 / 境界 / 实力 / 品级；不改势力与地点的归属；不改物品的来龙去脉与术语用法；
- 不改已发生事件的因果与结果，不新增剧情事件，不埋伏笔、不给后文留下新的接口；
- 不借台词透露新信息；新增的台词必须「对情节没有实质影响」（寒暄、调侃、惊讶、沉默）；
- 须是「字面变了、信息没变」：原文若跟前文有矛盾，「不要顺手改对」 —— 那不是本次任务，改了反而让设定记录对不上。

「按动作各自的边界」：
- 「润色」：只换字不换事 —— 字词、句式、节奏可改；情节、信息、专名一律不动。润色天然不产生新设定，但同样不许顺手把泛指写成专指（「一位老者」不能改成「青云宗长老」）。
- 「扩写」：🔴 「描写层可以加，信息层不可以加」。「一柄剑」可以写成「一柄样式古朴的剑」，「不能」写成「师父所赠的断岳剑」—— 后者凭空造出专名与来历，设定表里没有、后文也不知道。
  可以加的：环境与感官、动作与微表情、情绪递进、无实质信息的过场衔接台词。
  不可以加的：任何新的人物 / 地点 / 势力 / 功法 / 器物 / 术语名称，以及任何新的来历、身份、境界、归属交代。
- 「精简」：🔴 「承载设定交代的句子一律保留」。只删冗余重复、注水抒情与无信息量的过渡。
  「他取出那枚得自青云宗的储物戒」不能压成「他取出储物戒」—— 来历交代删掉后，后文就断了。凡带专名、来历、境界、关系、归属、器物来源的句子，整句留着。
- 「改写」：只改叙述方式与文字（句式、节奏、场景切分），设定类内容一字不动，不新增事件、不埋伏笔。`

let CHAPTER_REWRITE_LATEST_RULE = `【本次改写的是「当前最新章」】它后面还没有正文，因此不必像改旧章那样收紧 —— 但🔴 『尺度由「动作」决定，不因「最新章」而放宽』：

- 只有「改写」这一档可以放开手脚：按作者要求调整叙述角度、强化冲突、重排场景、补写细节与对白，甚至改写局部走向。
- 「润色 / 扩写 / 精简仍严格按各自的动作纪律执行」（润色不增删情节与信息、扩写不注水、精简不丢信息）—— 「这是最新章」不是放宽它们的理由。

不论哪种动作都要守住两条：① 与前文设定不冲突；② 原文若有章末钩子，改写后必须留着 —— 它是下一章的接口。

🔴 落库后系统会自动补跑一轮「设定抽取 / 补登 / 更新」，把本章新增或变化的信息同步进设定表，供下一次「接着写」读取。`


export interface ChapterRewriteOpts {
  /** 章节标题（进 prompt 只为让模型知道在写什么，不改它） */
  title: string
  /** 本章原文（由调用方从库里读出） */
  body: string
  action: ChapterRewriteAction
  /** 作者的补充要求（可空） */
  requirement: string
  /** 目标字数：扩写 / 精简 / 改写档要 */
  targetWords?: number
  /** 上一章结尾样本（可选）—— 改写后仍要接得上，给模型当参照 */
  contextTail?: string
  /** 补足 / 压缩**没生效**时如实说明（透传给 `enforceWordRange`，见那里的 `onLog` 说明） */
  onLog?: (msg: string) => void
  signal?: AbortSignal
  /**
   * 请求归属（3.2.0 · WQ7）。
   * 🔴 整章改写是**一次逻辑调用里最贵的**（正文可能上千字，还会触发补写循环），
   *    不带归属就只能靠「唯一任务」兼容路径 —— 工单批量改写时最容易串账。
   */
  request?: CallRequestContext
  /**
   * 这一章是不是**项目最新章**（决定改写纪律，见上面两条 RULE）：
   *   `true`  = 最新章，允许创造性改写，落库后由调用方补跑设定抽取；
   *   `false` = 历史章，只做文字加工、设定类内容一律冻结。
   */
  isLatest: boolean
  /** 🔴 收字回调：**同时就是流式开关**。整章可能上千字，不传 onToken 会走非流式并撞总超时墙 */
  onToken?: (d: string) => void
  /**
   * 本次改写步骤的预算（3.2.0 · WQ6）。主改写、补写、压缩都计入；
   * 已耗尽时**一个请求都不发**，直接抛 `AIRequestBudgetExhaustedError`（暂停，不硬打）。
   * 不传 ⇒ 与改造前逐字一致（老调用零影响）。
   */
  budget?: AttemptBudget
}

/**
 * 整章改写。纯文本输出（不是 JSON）—— 长文塞进 JSON 会因转义而解析失败。
 * @returns 清洗后的正文；**返回空串表示模型没吐出可用正文**（调用方提示重试）
 */
export async function aiRewriteChapter(o: ChapterRewriteOpts): Promise<string> {
  // 3.2.0 · WQ6：预算已耗尽 ⇒ **一个请求都不发**（继续只会烧额度，由作者决定是否再试）
  if (o.budget?.exhausted) throw new AIRequestBudgetExhaustedError(o.budget.snapshot())
  const cfg = await requireProviderFor('create')
  const fenceId = newAuthorFence()
  // 历史章 / 最新章纪律不同（见上面两条 RULE 的说明）
  const scopeRule = o.isLatest ? CHAPTER_REWRITE_LATEST_RULE : CHAPTER_REWRITE_HISTORY_RULE
  // 🔴 去 AI 味纪律**必须钉在最末**（埋中段效果约等于 0，见 lib/deAiStyle.ts 文件头）——
  //    整章改写产出的同样是正文，与续写、伴写共用同一份真源。
  // 🔴 文风档（#015）插在去 AI 味纪律**之前**（deAi 必须钉在最末，见上一条注释）。
  //    空档时 `fpNote` 为空串 ⇒ 数组里连这一段都没有，行为与改造前逐字一致。
  const fpNote = await activeFingerprintNote()
  const sys = [CHAPTER_REWRITE_BASE, CHAPTER_REWRITE_ACTION_RULES[o.action], scopeRule, ...(fpNote ? [fpNote] : []), deAiGenerateRule('full')].join('\n\n')

  /**
   * 🔴 3.2.2 · 审计 A1（P1）：**跨阶段不变量**。
   *
   * 首轮 system 里有历史章冻结纪律与作者要求，但字数偏短/偏长进入 `enforceWordRange()`
   * 时它们**一个字都没带下去** ⇒ 同一个历史章任务前半程"一律冻结"、后半程"情节要实质推进"，
   * 字数合格掩盖了设定越界（审计实测：补写里新造"城主"，810 字落在区间内被接受）。
   * 这里把两者拼成一份原文，随每次补写/压缩重申；篇幅目标明确排在它之后。
   */
  const invariants = [
    scopeRule,
    o.requirement.trim() ? `作者本次要求：${o.requirement.trim()}` : '',
  ].filter(Boolean).join('\n')

  // ── 🔴 续写：原文由**我们自己保留**，模型只吐"新增片段" ──
  //    「原文一字不动」靠提示词是**做不到**的（模型总会顺手把原段润色一遍）；
  //    所以走结构上保证的路径 —— 直接复用 `enforceWordRange` 的增量补写循环
  //    （它本来就是"紧接着上文往下写"，与续写语义完全一致）。
  if (o.action === 'continue') {
    const target = o.targetWords && o.targetWords > 0 ? o.targetWords : countWords(o.body)
    const inWords = countWords(o.body)
    const out = await enforceWordRange({
      // ⚠️ **刻意不传 `sys`**：这一步要的是"只吐新增片段"，
      //    与"整章改写"的 system 天然打架（传下去模型会什么都不输出 —— 见 wordRange 的 DEFAULT_FILL_SYS）。
      cfg, body: o.body, target,
      // 🔴 补写到**区间下界**为止，别按正中补：续写不能压缩（原文一字不动），
      //    按正中补一旦补多就永远超上限（实测目标 3500 补到了 3968）。
      fillTarget: Math.max(inWords, target - WORD_TOLERANCE),
      // 🔴 审计 A1：续写补字同样重申冻结纪律（原文由我们保留，但新写的部分必须守同一套事实）
      invariants,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onToken ? { onToken: o.onToken } : {}),
      ...(o.onLog ? { onLog: o.onLog } : {}),
      ...(o.request ? { request: o.request } : {}),
      ...(o.budget ? { budget: o.budget } : {}),
      maxExpand: 8, // 续写可能要从 1000 补到 4000，轮数给足
      maxShrink: 0, // 🔴 绝不压缩：原文是作者写的，续写只有"往长里补"一个方向
    })
    return cleanChapterOutput(out)
  }

  // 字数一律写成「区间 + 口径」：只给"A 字左右"时，模型按 token / 字符估，实测能写到目标 +25%。
  const lo = o.targetWords ? Math.max(1, o.targetWords - WORD_TOLERANCE) : 0
  const hi = o.targetWords ? o.targetWords + WORD_TOLERANCE : 0
  const lines = [
    `【本章标题】${o.title}`,
    // 🔴 取**尾部** 1200 字：这一段叫「上一章结尾」，衔接靠的就是末尾那几句。
    //    2026-09-19 修：原先写的是 slice(0, 1200) 取到开头，等于拿「上一章开头」当衔接参照。
    // 🔴 上一章结尾同样是**作者正文**：与下方「本章原文」共用同一个 fenceId，包成边界块
    o.contextTail?.trim() ? `【上一章结尾】（只作衔接参考，不要改写这一段）\n${authorBlock(fenceId, o.contextTail.trim().slice(-1200))}` : '',
    o.requirement.trim() ? `【改写要求】\n${o.requirement.trim()}` : '',
    o.targetWords ? `【目标字数】必须落在 ${lo}~${hi} 个汉字之间（目标 ${o.targetWords}；「按汉字个数计，标点与空白不计」）` : '',
    '【本章原文】',
    authorBlock(fenceId, o.body),
  ].filter(Boolean)
  lines.push(
    '',
    o.targetWords
      ? `请按上面的动作改写这一章，只输出正文，篇幅必须落在 ${lo}~${hi} 个汉字之间（按汉字个数计，不含标点）。`
      : '请按上面的动作改写这一章，只输出正文。',
  )
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: lines.join('\n\n') }],
    {
      timeoutMs: CHAT_TIMEOUT_MS,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onToken ? { onToken: o.onToken } : {}),
      ...(o.request ? { request: o.request } : {}),
    },
  )
  // 一次主改写 = 一次逻辑调用（内部最多再打 3 次实际请求，由 `MAX_REQUESTS_PER_CALL` 兜）
  o.budget?.consume(1)
  let out = cleanChapterOutput(text)

  // ── 🔴 字数**硬校准**（±WORD_TOLERANCE）──
  //    提示词写死区间也拦不住超字（实测：原文 3000、目标 4000，实际写出 5000，超 25%），
  //    所以事后必须用同一套校准逻辑兜住 —— 与逐章连写用的是**同一个函数、同一个容差**。
  if (o.targetWords && o.targetWords > 0 && out) {
    out = await enforceWordRange({
      // ⚠️ 同上：不传 `sys`（补写要用"只吐新增片段"的提示词，不用整章改写那套）
      cfg, body: out, target: o.targetWords,
      // 🔴 审计 A1：**校准阶段继续沿用同一份不变量** —— 这正是原实现丢掉的那一段
      invariants,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onLog ? { onLog: o.onLog } : {}),
      ...(o.request ? { request: o.request } : {}),
      ...(o.budget ? { budget: o.budget } : {}),
      // 精简不该回头补（压到一半又补回去很荒谬）；其余动作补 2 轮
      maxExpand: o.action === 'condense' ? 0 : 2,
      maxShrink: 2,
    })
    out = cleanChapterOutput(out)
  }
  return out
}

/**
 * 剥掉正文里的 markdown 标记 —— 纯函数，可单测。
 *
 * 🔴 为什么必须有（2026-09-20 实机抓到）：逐章连写产出的正文里混进了
 *    `**"第九脉，已至。"**` 这种强调标记 —— 直接落库就是**正文带着星号**，
 *    作者在「正文编辑」里看到的是「**」而不是加粗（编辑器不渲染 markdown）。
 *
 * 只处理**确定是标记**的形态，不做通用 markdown 解析（正文不是文档）：
 *   ① 行首 `#` 标题符：`## 第三章` → `第三章`（层级符号进正文是纯噪声）
 *   ② 整行分隔线：`---` / `***` / `___` 独行 → 整行删除（正文里它是噪声，
 *      段落分隔用空行就够了）
 *   ③ `**粗体**` / `__粗体__` / `*斜体*` → 保留文字
 *
 * ⚠️ 单星号斜体必须**要求内容首字符非空白**（`\*\S…\*`）：否则 `a * b * c`
 *    这种把星号当运算符写的句子会被当成斜体吃掉一半（误伤正文比留标记更糟）。
 */
export function stripInlineMarkdown(text: string): string {
  let s = text
  // ① 行首标题符
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  // ② 整行分隔线（删除整行；留下的连续空行最后统一压缩）
  s = s.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
  // ③ 强调标记：先双符号（粗体），再单星号（斜体）
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')
  s = s.replace(/(?<![\w*])\*(\S[^*\n]*?)\*(?![\w*])/g, '$1')
  // 三行以上连续换行压成两行（删掉的整行会留下空档）
  s = s.replace(/\n{3,}/g, '\n\n')
  return s
}

/**
 * 剥掉围栏 / 前言 / 开场客套 / markdown 标记 —— 纯函数，可单测。
 * 模型偶尔会先来一句「好的，以下是修改后的内容：」或把正文裹进 ``` 围栏，
 * 直接落库就把这句写进正文了。
 *
 * 🔴 2026-09-20 起它同时负责**剥正文内部的 markdown 标记**（见 `stripInlineMarkdown`），
 *    并且**接进了逐章连写链路**（`autoContinue.ts`）—— 原先只有整章改写这一条路在调它，
 *    逐章连写产出的正文一个字都没清过。
 */
export function cleanChapterOutput(raw: string): string {
  let s = (raw ?? '').replace(/\r/g, '').trim()
  // 🔴 前言与围栏要**交替剥两轮**：模型偶尔先客套再贴围栏（「好的，以下是修改后的内容：」+ 三引号），
  //    只按"先围栏、后前言"剥一遍，会把围栏留在开头 —— 这个组合在实测里很常见。
  for (let i = 0; i < 2; i++) {
    s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
    s = s.replace(/^(?:好的|明白|收到)[，,：:]?\s*/, '')
    s = s.replace(/^(?:以下是|这是)[^：:\n]{0,20}[：:]\s*/, '').trim()
  }
  return stripInlineMarkdown(s).trim()
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const REWRITE_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'chapter-rewrite', group: '正文写作', name: '整章改写', note: '对整章正文做润色 / 扩写 / 精简 / 改写（纯文本输出，结果由作者确认后才替换正文）。' },
    read: () => CHAPTER_REWRITE_BASE,
    write: t => { CHAPTER_REWRITE_BASE = t },
  },
  {
    meta: { id: 'chapter-rewrite-history', group: '正文写作', name: '整章改写 · 历史章纪律', note: '改已定稿旧章时的设定冻结条款，按动作分节（润色不动设定 / 扩写不得新增设定 / 精简不得删设定交代 / 改写只改叙述方式）。' },
    read: () => CHAPTER_REWRITE_HISTORY_RULE,
    write: t => { CHAPTER_REWRITE_HISTORY_RULE = t },
  },
  {
    meta: { id: 'chapter-rewrite-latest', group: '正文写作', name: '整章改写 · 最新章纪律', note: '改当前最新章时的尺度：只有「改写」档可放开，润色 / 扩写 / 精简仍守各自纪律；落库后补跑设定同步。' },
    read: () => CHAPTER_REWRITE_LATEST_RULE,
    write: t => { CHAPTER_REWRITE_LATEST_RULE = t },
  },
]
