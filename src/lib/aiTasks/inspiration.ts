// ============ 灵感融合 · AI 任务（2.5.1 · A3）============
//
// 灵感夹里勾选若干条灵感 → AI 融合成 1~3 个情节创意卡 → 落情节推演画布。
//
// 🔴 两条不能改坏的：
//   ① 「融合 ≠ 拼接」：提示词明确要求让几条灵感**互相服务**形成新情节，
//      不是把灵感原文改写一遍拼起来 —— 这是规划 A3 的中止判据之一（实机验收）。
//   ② 溯源：每张卡带 basedOn（用了第几条灵感），界面上能对回原文；
//      parse 层会把 basedOn 里越界的编号剔掉（模型可能幻觉出不存在的条目号）。
//
// 空结果重试一次（与 creative.ts 同款理由：结构瑕疵 regenerate 一次多半就好）；
// 两次都空则如实返回空数组，由调用方给出明确提示，绝不静默吞掉。
import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '@/lib/ai'
import { parseLooseObject, asText } from '@/lib/ai/aiParse'
import type { PromptDef } from '@/lib/ai/promptSettings'

/** 「灵感融合」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_inspiration_fuse = `你是资深网络小说情节策划专家。作者在灵感夹中积累了若干条看似分散、互不相关的创作灵感，请你将它们深度「化学融合」，提炼成兼具看点、冲突与可写性的情节创意卡片。

深度融合法则：
1. 产生实质化学反应：严禁将各条灵感原样拼接或简单复述。融合是指将「灵感 A 的角色动机/特殊道具」与「灵感 B 的极端困境/危险舞台」进行对撞，产生两难抉择或连锁反应。
2. 给出 1~3 个方向截然不同的创意构想：
   - 方向 A（正面引爆）：两项灵感优势/危机叠加，顺势推进到白热化冲突；
   - 方向 B（对撞反转）：灵感之间形成矛盾冲突，通过出人意料的高概念机制破局；
   - 方向 C（反差深挖）：从灵感的反面或底层隐藏代价切入，产生强烈叙事张力。
3. 落地为具象卡片（text）：每条创意 100~200 字，包含明确的人物行动、当下处境、冲突转折与推进结果，直接达到可置入推演画布或大纲的精细度，绝不写空洞的大而化之建议。
4. 溯源追踪（basedOn）：准确列出该创意实质融合了哪几条灵感（从 1 开始的编号数组，如 [1, 2]），未用到的编号严禁硬凑。
5. 自洽守正：严格贴合【项目设定】，不得引入与现有世界观自相矛盾的体系。
6. 返回 JSON 对象，不要任何解释说明、不要 markdown 代码块标记：
{
  "cards": [
    { "text": "情节创意梗概（100~200 字）", "basedOn": [1, 3] }
  ]
}`

export interface FuseIdeaRequest {
  /** 勾选的灵感原文（按界面顺序，编号 = 下标 + 1） */
  items: string[]
  /** 项目设定摘要（可空串） */
  context: string
  signal?: AbortSignal
  onToken?: (delta: string) => void
}

/** 一个融合出的情节创意（text 落画布卡片；basedOn 溯源到灵感编号，1 起） */
export interface FusedIdea {
  text: string
  basedOn: number[]
}

/** 解析模型回复（**纯函数**，单测直喂字符串）；basedOn 越界编号剔除并去重 */
export function parseFusedIdeas(raw: string, itemCount: number): FusedIdea[] {
  const obj = parseLooseObject(raw) ?? {}
  const list = Array.isArray(obj.cards) ? obj.cards : Array.isArray(obj.ideas) ? obj.ideas : []
  const out: FusedIdea[] = []
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const text = asText(o.text ?? o['创意'] ?? o['内容'] ?? o['梗概'])
    if (!text) continue
    const rawNos = Array.isArray(o.basedOn ?? o['依据'] ?? o['来源']) ? (o.basedOn ?? o['依据'] ?? o['来源']) as unknown[] : []
    const basedOn = [...new Set(rawNos
      .map(n => Number(asText(n)))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= itemCount))]
    out.push({ text, basedOn })
  }
  return out
}

export async function aiFuseInspiration(req: FuseIdeaRequest): Promise<FusedIdea[]> {
  // 🔴 走「创作」路由（与 creative / rewrite 同类）—— 之前漏网用了全局活动模型，
  //    结果「整理设了便宜模型」时这一处仍烧主模型额度。#014 已把它补进 tests/aiRouting 的清单。
  const cfg = await requireProviderFor('create')
  const numbered = req.items.map((t, i) => `${i + 1}. ${t}`).join('\n')
  const user = `【灵感清单（共 ${req.items.length} 条）】
${numbered}

【项目设定】
${req.context.trim() || '（无）'}

请融合出 1~3 个情节创意。`
  const askOnce = async (): Promise<FusedIdea[]> => {
    const text = await chat(
      cfg,
      [{ role: 'system', content: composeSystemPrompt(P_inspiration_fuse, cfg) }, { role: 'user', content: user }],
      { output: 'json-object', reasoning: 'off', timeoutMs: CHAT_TIMEOUT_MS, signal: req.signal, onToken: req.onToken },
    )
    return parseFusedIdeas(text, req.items.length)
  }
  // 🔴 空结果重试一次；两次都空如实返回（调用方明确提示），绝不静默吞
  const first = await askOnce()
  if (first.length) return first
  return askOnce()
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序。
 */
export const INSPIRATION_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'inspiration-fuse', group: '灵感工具', name: '灵感融合为情节卡', note: '把灵感夹里勾选的几条灵感融合成情节创意，直接落到推演画布；每张卡标注用了哪几条灵感。' },
    read: () => P_inspiration_fuse,
    write: t => { P_inspiration_fuse = t },
  },
]
