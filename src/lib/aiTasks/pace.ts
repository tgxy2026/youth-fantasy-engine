// ============ 爽点节奏与章末钩子 · AI 任务（B5 · 2.4.1）============
//
// 与「颉文姬⑥爽点/毒点检查」（自由文本报告）的**分工**：
//   那个回答"本章爽不爽、有没有毒点"（编辑视角，markdown 报告）；
//   本任务回答"**节奏落在哪一段、章末留没留钩子**"（结构视角，结构化 + 位置由本地算）。
//   两者互补，故不合并、也不删除已有的爽点检查。
//
// 立场（🔴 同 paceAnalysis.ts 与证据包）：只给**观察与建议**，不打分不排名。
// 提示词里也不谈"这段文字出自人手还是模型"这类话题 —— 这条由 tests/paceAnalysis.test.ts
// 的立场断言守着（它直接读本文件源码，所以**连注释里都不能出现那些词**）。

import { chat, requireProviderFor, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { newAuthorFence, authorBlock } from '../promptGuard'
import { PACE_BEAT_KINDS } from '../paceAnalysis'
import type { PromptDef } from '../promptSettings'
// 解析与位置换算都在本地纯函数层（tests 只 import 那边，不会把传输层拉进 Node 测试）
import { parsePaceReport, type PaceReport } from '../paceAnalysis'

/** 「节奏与章末钩子」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_pace_analysis = `你是网文节奏编辑。网文按章连载，读者是"一章一章被留下来"的：章内需要有情绪起伏（爆点），章末需要留一个让人想点下一章的理由（钩子）。

请审读本章，只做「结构观察」，输出 JSON（不要输出任何解释文字）。

严格按此结构，字段一个不多一个不少：
{
  "hook": {
    "present": true,
    "kind": "悬念|未完成事件|信息缺口|情绪悬置|无",
    "evidence": "章末最后一段里的一句原文（逐字照抄，不要改写）",
    "note": "这句话为什么算/不算钩子（一句话）"
  },
  "beats": [
    { "kind": "${PACE_BEAT_KINDS.join('|')}", "quote": "该处原文片段，逐字照抄，20~40 字", "note": "这里给了读者什么情绪" }
  ],
  "increments": ["本章推进/揭示了什么新信息（每条一句，最多 5 条）"],
  "observations": ["节奏观察（每条一句，最多 4 条）"],
  "summary": "一句话总评"
}

硬要求：
1. 「quote 必须逐字照抄正文原文」，一个字都不要改（程序要靠它在正文里定位位置，改写了就定位不到）。
2. beats 给 2~6 处「真正的情绪爆点」；没有就返回空数组，不要为了凑数把平铺叙述也算进去。
3. observations 只描述「节奏形态」（如"爆点集中在前半段"、"后段约三分之一没有起伏"、"章末收在叙述而非悬念上"），「不评分、不给等级、不排名」。
4. 只谈节奏与结构：本章有没有起伏、钩子留在哪里。不要讨论"这段文字像不像某个模型写的"这类话题 —— 那不在本报告的职责内。
5. 不给改写建议正文，只给结构层面的观察与建议。`

// 类型与解析都住在本地层（见上方 import）；这里再导出一次，方便门面统一从本文件取。
export type { PaceReport } from '../paceAnalysis'

export async function aiPaceAnalysis(
  projectContext: string,
  chapterText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<PaceReport> {
  const cfg = await requireProviderFor('review')
  const text = chapterText.trim()
  // 🔴 设定与正文都是**不可信作者文本**：包裹成边界块（内容一字不改，见 promptGuard 文件头）
  const fence = newAuthorFence()
  const user = `【设定资料（摘要）】
${projectContext.trim() ? authorBlock(fence, projectContext.trim()) : '（无）'}

【本章正文】
${text ? authorBlock(fence, text) : '（空）'}

请按结构观察本章节奏与章末钩子，输出 JSON。`

  const raw = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(P_pace_analysis, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )
  return parsePaceReport(raw, text)
}

export const PACE_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'pace-analysis',
      group: '编辑与审校',
      name: '节奏与章末钩子',
      note: '看章内爆点的位置分布与章末是否留了钩子；只给结构观察，不评分。',
    },
    read: () => P_pace_analysis,
    write: t => { P_pace_analysis = t },
  },
]
