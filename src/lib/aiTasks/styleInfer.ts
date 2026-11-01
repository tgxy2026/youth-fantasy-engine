/**
 * 3.3.3 · B4：按章反推「写作规范」的建议（**只产建议，不改库**）。
 *
 * 🔴 只输出作者本页**已有字段**的键；模型编出来的字段名一律丢弃。
 * 🔴 建议落到界面后由作者逐条勾选采用；"取消 / 只采用几条"都不写库（FormSheet 仍走手动保存）。
 * 🔴 材料按预算裁剪（6000 字）并明示；一次调用，不自动重试、不换模型。
 */
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { newAuthorFence, authorBlock } from '@/lib/ai/promptGuard'
import type { PromptDef } from '@/lib/ai/promptSettings'
import type { StyleFieldDef, StyleSuggestion } from '@/lib/forms/styleIO'
import { parseStyleSuggestions } from '@/lib/forms/styleIO'

export type { StyleSuggestion }
export { parseStyleSuggestions }

export const STYLE_INFER_MATERIAL_LIMIT = 6000

let P_style_infer = `你是小说写作规范的分析助手。作者会给出自己的「写作规范」字段清单，以及一章正文。请从这一章正文**反推**出这些字段目前体现出的写法。

要求：
1. 只允许使用给出的字段键（严格照抄 key），**不得新增字段**、不得改写 key。
2. 每个建议必须能从正文中找到依据（可以给一句不超过 40 字的原文引用）；凭感觉的不写。
3. value 用简洁的中文描述（不超过 120 字），写"这一章实际是怎么写的"，不是"应该怎么写"。
4. 不确定的字段不要给建议；空数组是合法回答。
5. 只输出 JSON，不要解释、不要 markdown 代码块：
{ "suggestions": [ { "key": "模块名::字段名", "value": "...", "reason": "...", "quote": "..." } ] }`

export interface StyleInferRequest {
  material: string
  fields: Pick<StyleFieldDef, 'key' | 'label'>[]
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

export async function aiInferStyle(req: StyleInferRequest): Promise<StyleSuggestion[]> {
  const cfg = await requireProviderFor('utility')
  const fence = newAuthorFence()
  const fieldList = req.fields.map(f => `- ${f.key}（${f.label}）`).join('\n')
  const user = `【可用的规范字段（只能用这些 key）】
${fieldList}

【正文材料（可能已按预算截断）】
${authorBlock(fence, req.material)}

请从正文反推这些字段目前体现出的写法。`
  const text = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(P_style_infer, cfg) }, { role: 'user', content: user }],
    { output: 'json-object', reasoning: 'off', timeoutMs: CHAT_TIMEOUT_MS, signal: req.signal, onToken: req.onToken },
  )
  return parseStyleSuggestions(text, req.fields.map(f => f.key))
}

/** 本域可编辑提示词 */
export const STYLE_INFER_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'style-infer',
      group: '编辑与审校',
      name: '按章反推写作规范',
      note: '写作规范页：作者选一章正文，让模型按本页已有字段反推写法建议；只产建议，逐条勾选后才并入草稿。',
    },
    read: () => P_style_infer,
    write: t => { P_style_infer = t },
  },
]