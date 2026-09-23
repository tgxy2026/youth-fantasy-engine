// ============ 读者视角审问 · AI 任务（C5 · 2.4.2）============
//
// 与「AI 审稿」类任务（颉文姬校对 / 本章体检 C3）的分工：
//   那些回答「这里写错了没有」；本任务回答「**一个人读到这里会怎样**」——走神、看不懂、想知道后续。
//   所以提示词走「扮演」而不是「评估」（复用酒馆模式以人设驱动对话的写法）。
//
// 🔴 三条不能改坏的地方：
//   ① 三问的措辞只有一处源（`lib/readerProbe.ts` 的 `READER_QUESTIONS`），运行时拼进 user 消息 ——
//      别把问题再抄一份到 system 里，两份必然漂移（一边改了另一边没改，表现是「界面问的和模型答的不是一回事」）。
//   ② quote 必须逐字照抄：段号要靠它在正文里本地定位（`locateQuote`）。
//   ③ 立场：不评分、不给等级、不谈"像不像模型写的"——由 tests/readerProbe.test.ts 的
//      立场断言守着（它直接读本文件源码，所以**连注释里都不能出现那些词**）。

import { chat, requireActiveProvider, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import type { PromptDef } from '../promptSettings'
import {
  parseReaderProbe, readerLensOf, READER_QUESTIONS,
  type ReaderProbeResult,
} from '../readerProbe'

/** 「读者视角审问」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_reader_probe = `你现在要**扮演**一位具体的读者，把下面这一章当小说读一遍，然后回答三个问题。

【你读的时候要遵守】
- 你是读者，不是编辑：不要谈语法、标点、结构、文笔，也不要谈设定是否自相矛盾。那些不归你管。
- 说的是**你读到某一处的真实反应**：哪一句让你走神、哪一句让你停下来、哪一句勾住了你。
- 每条意见都要指着正文的具体某一句：quote 必须**逐字照抄**原文片段（一个字都不要改——程序要靠它在正文里找到位置），长度 20~40 字。
- 确实没有对应感觉的，就直说没有，quote 留空串，不要为了凑满而硬编一处。
- 不评分、不给等级、不排名，也不写"建议改成……"。你只是读者，改不改是作者的事。

【你会得到的三个问题】放在下面的用户消息里，逐条回答。

只输出 JSON，不要任何解释文字：
{
  "notes": [
    { "q": "bored | lost | want", "quote": "逐字照抄的原文片段（没有具体位置就留空串）", "comment": "你作为这个读者的反应，一到两句，用口语" }
  ],
  "summary": "读完这一章你会不会点下一章，为什么（一到两句）"
}

notes 给 3~8 条；覆盖三个问题比数量重要。`

/**
 * 读者视角审问：以「某个具体读者」的身份读一章，回三问。
 *
 * @param projectContext 设定资料摘要（可选；让"没看懂"的判断有依据——有些信息在设定里交代过）
 * @param chapterText    本章正文
 * @param lensKey        读者视角 key（见 `READER_LENSES`）
 */
export async function aiReaderProbe(
  projectContext: string,
  chapterText: string,
  lensKey: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ReaderProbeResult> {
  const cfg = await requireActiveProvider()
  const lens = readerLensOf(lensKey)
  const text = chapterText.trim()
  // 三问的措辞只有这一处源（见文件头 ①）
  const questions = READER_QUESTIONS.map((q, i) => `${i + 1}. ${q.label}：${q.ask}`).join('\n')
  const user = `【你是谁】
${lens.brief}

【设定资料（摘要，供你判断"哪些信息其实交代过"）】
${projectContext.trim() || '（无）'}

【要回答的三个问题】
${questions}

【本章正文】
${text || '（空）'}

请以这个读者的身份读完，按 JSON 结构回答。`

  const raw = await chat(
    cfg,
    [{ role: 'system', content: composeSystemPrompt(P_reader_probe, cfg) }, { role: 'user', content: user }],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )
  return parseReaderProbe(raw, text)
}

export const READER_PROBE_PROMPTS: PromptDef[] = [
  {
    meta: {
      id: 'reader-probe',
      group: '编辑与审校',
      name: '读者视角审问',
      note: '让 AI 扮演一个具体读者读这一章，回答「哪里看不下去 / 哪里没看懂 / 最想知道什么」；只给读者反应，不评分。',
    },
    read: () => P_reader_probe,
    write: t => { P_reader_probe = t },
  },
]
