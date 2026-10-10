// ============ 一键拆书 · AI 章节边界识别（2.6.1 · R2）============
//
// 背景（社区反馈）：原著正则（split.ts 的 CHAPTER_TITLE_RE）只认「第X章 / 卷X / 【…】」这类标准格式，
// 标题写法一变体（如「01|风起」「风起（一）」）整本就掉进字数兜底。本任务让作者填几条
// 「章节标题示例」，AI 按示例从原文里挑出章节起始行。
//
// 🔴 防幻觉两条（2.6.1 规划 R2 的中止判据）：
//   ① AI 只能**从给出的原文里挑行**，提示词明令不得改写、不得编造；
//   ② 程序侧（bookbreak/aiSplit.applyAiSplit）把 AI 报的行在原文里逐字回定位，
//      命中 <2 全部弃用 —— 这里（parse 层）只做宽松抽取，严格采信在 applyAiSplit。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { parseLooseObject, asText } from '@/lib/aiParse'
import { newAuthorFence, authorBlock } from '@/lib/promptGuard'
import type { PromptDef } from '@/lib/promptSettings'

/** 「拆书 · AI 章节识别」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_bookbreak_split = `你是小说文本的结构分析器。作者导入了一段没有标准章节标题的小说原文，并给出了几条「章节标题示例」。请你从【原文节选】里找出所有「章节起始行」。

要求：
1. 严格按示例的格式规律识别（比如示例是「01|风起」，就去原文里找「数字|标题」形状的行；示例是「风起（一）」，就找「标题（序号）」形状的行）。
2. 只能从【原文节选】里「原样抄出」符合条件的整行 —— 一个字都不许改、不许补、不许编造原文里不存在的行。
3. lines 按原文出现顺序排列；一个都不确定的就不要硬凑 —— 空数组也是合法回答。
4. 只输出 JSON，不要解释、不要 markdown 代码块标记：
{ "lines": ["原文中的章节起始行 1", "原文中的章节起始行 2"] }`

export interface BookBreakSplitRequest {
  /** 原文采样（调用方用 sampleTextForSplit 组装，控 token 预算） */
  sampleText: string
  /** 作者填的章节标题示例（一行一条，≥1 条） */
  samples: string[]
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

/** 解析模型回复（**纯函数**，单测直喂字符串）——宽松抽取，严格采信在 applyAiSplit */
export function parseChapterLines(raw: string): string[] {
  const obj = parseLooseObject(raw) ?? {}
  const list = Array.isArray(obj.lines) ? obj.lines : Array.isArray(obj['章节行']) ? obj['章节行'] as unknown[] : []
  const out: string[] = []
  for (const it of list) {
    const t = asText(it).trim()
    if (t) out.push(t)
  }
  return out
}

export async function aiBookBreakSplitChapters(req: BookBreakSplitRequest): Promise<string[]> {
  // #014 用途路由：拆书章节边界识别属「整理」
  const cfg = await requireProviderFor('utility')
  const numbered = req.samples.map((t, i) => `${i + 1}. ${t}`).join('\n')
  const user = `【章节标题示例（按这些行的格式规律识别）】
${numbered}

【原文节选（可能是整篇的一部分，节选处用「……」标出）】
${authorBlock(newAuthorFence(), req.sampleText)}

请找出原文里的章节起始行。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(P_bookbreak_split, cfg) }, { role: 'user', content: user }],
    { json: true, timeoutMs: CHAT_TIMEOUT_MS, signal: req.signal, onToken: req.onToken },
  )
  return parseChapterLines(text)
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序。
 */
export const BOOKBREAK_SPLIT_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'bookbreak-split', group: '拆书工具', name: 'AI 章节边界识别', note: '一键拆书：本地规则认不出章节标题时，按作者填的「章节标题示例」从原文里挑出章节起始行；识别出的行会逐字回原文核对。' },
    read: () => P_bookbreak_split,
    write: t => { P_bookbreak_split = t },
  },
]
