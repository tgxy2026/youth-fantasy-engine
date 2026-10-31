/**
 * 3.3.3 · A2：AI 侧的「本章变化清单」调用（只发**一次**请求）。
 *
 * 【边界】本文件只负责"问模型 + 拿回文本"；引文核验、条数上限、结论口径全在
 *    `lib/audit/changeList.ts`（纯函数）—— 模型说什么都不能直接当证据。
 *
 * 🔴 每次作者动作最多 3 次请求（规划 §4）；这里**不自动重试、不换模型兜底**，
 *    失败就如实返回错误，由作者决定要不要再发起（避免静默计费）。
 * 🔴 材料在调用方按 10,000 字裁剪并明示截断，本函数不再二次裁剪 —— 否则"到底送了多少"两处口径。
 */
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { newAuthorFence, authorBlock } from '@/lib/ai/promptGuard'
import type { PromptDef } from '@/lib/ai/promptSettings'

let P_change_list = `你是长篇小说的情节校对助手。请阅读这一章正文，找出**最多 3 条**「这一章内确实发生的变化线索」，供作者核对。

允许的变化类型（type 只能取这五个之一）：
- 目标：人物想做的事/追求发生了变化
- 关系：人物之间的关系发生了变化
- 信息：人物或读者获得了新的信息、认知
- 资源/地位：资源、身份、地位、处境发生了变化
- 处境或情绪认知：人物对自身处境或情绪的理解发生了变化

铁律：
1. 只写正文**明确写出**的变化；铺垫、休整、内心变化同样算（不要求"不可逆"，也不要求"事件"）。
2. 每条必须给 quote：从正文中**逐字照抄**一句能支持这条变化的原句（不超过 60 字），一个字都不许改。
3. 找不到可靠依据就少写甚至不写 —— 空数组是合法回答；**不要**为了凑数而推测。
4. before/after 各一句话；before 可以留空（正文只写了"现在怎样"）。
5. 只输出 JSON，不要解释、不要 markdown 代码块标记：
{ "changes": [ { "type": "信息", "before": "", "after": "陈渊得知残简来自镇界塔", "quote": "..." } ] }`

export interface ChapterChangeAiRequest {
  /** 已按 10,000 字裁剪的正文（调用方负责，`buildChangeMaterial`） */
  material: string
  chapterTitle: string
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

export interface ChapterChangeAiResult {
  text: string
  /** 真实模型名（用于"换模型不可比"的提示）；不含端点与密钥 */
  modelTag: string
}

export async function aiChapterChangeList(req: ChapterChangeAiRequest): Promise<ChapterChangeAiResult> {
  const cfg = await requireProviderFor('utility')
  const fence = newAuthorFence()
  const user = `【章节】${req.chapterTitle.trim() ? authorBlock(fence, req.chapterTitle.trim()) : '（未命名章节）'}

【本章正文（可能已按预算截断，截断处不代表正文结束）】
${authorBlock(fence, req.material)}

请按要求输出这一章的变化线索。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(P_change_list, cfg) }, { role: 'user', content: user }],
    {
      output: 'json-object', reasoning: 'off', timeoutMs: CHAT_TIMEOUT_MS,
      signal: req.signal, onToken: req.onToken,
    },
  )
  return { text, modelTag: String(cfg.model ?? '').slice(0, 60) }
}

/** 本域可编辑提示词（设置页「AI 提示词」里可改） */
export const CHANGE_LIST_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'chapter-change-list',
      group: '编辑与审校',
      name: '本章变化清单',
      note: '检查工具 → 投稿前自检：作者主动点「生成本章变化清单」时才调用一次；每条变化必须给逐字原文引文，程序会回正文核对，对不上的剔除。',
    },
    read: () => P_change_list,
    write: t => { P_change_list = t },
  },
]