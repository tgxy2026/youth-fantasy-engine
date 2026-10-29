// ============ 使用答疑 · 提问编排（3.3.1 · P4 接线） ============
//
// 规划 §5.3 / §7：答疑链路 = 本地检索 → 依据足够才请求模型 → 校验来源引用 → 显示回答 + 原文。
//
// 🔴 这个文件是「答疑层」与「公共模型层」之间**唯一**的接缝，四条纪律都在这里落实：
//   ① **归属全局**：`scope:'global'` + `projectId:null` —— 打开哪本小说都不改变它的归属，
//      usage 不会混进正在跑的拆书 / 写作 / 审校任务（规划 §7「答疑属于应用级服务」）。
//   ② **提示词隔离**：`skipUserSystem: true` —— 作者给模型配的「附加创作系统提示词」是写作
//      指令（风格、人称、禁区），拿它当产品事实去回答「这个按钮在哪」会直接答错。这里必须
//      跳过注入，但**不改动**作者存储的模型配置（规划 §7 最后一条）。
//   ③ **一次逻辑调用**：不自动重问、不修复 JSON 再问一遍、失败不换模型重试。作者点重试才算新提交。
//   ④ **不落盘**：问题、回答、召回片段只在本函数内存里存在。运行统计沿用公共账本，
//      这里不额外写任何项目数据（规划 §7「不新建设定 / 快照 / 报告来存放答疑」）。
import { chat, isCancelled, resolveProviderFor, type ChatMessage } from '@/lib/ai'
import { searchHelp, type HelpHit } from '@/lib/help'
import {
  buildHelpAnswerPrompt, prepareHelpPromptFragments, readHelpAnswer, HELP_ANSWER_FAILURE_TEXT,
  type HelpAnswerFailure, type HelpPromptFragment, type HelpSourceRef,
} from '@/lib/aiTasks/helpAnswer'

/** 一次提问的结果。`hits` 恒为**本次**召回，界面靠它渲染「也可以直接看这几段」。 */
export type AskResult =
  /** 还没配模型：只返回本地检索结果，不假装答过 */
  | { kind: 'no-model'; hits: HelpHit[] }
  /** 本地没有召回到任何片段：不请求模型（模型只能靠常识编） */
  | { kind: 'no-recall'; hits: HelpHit[] }
  /** 有依据的 AI 回答 */
  | { kind: 'answer'; answer: string; sources: HelpSourceRef[]; sourceSnapshots: Record<string, string>; hits: HelpHit[] }
  /** 模型答了但校验不过（或调用失败）：退回检索结果 */
  | { kind: 'fallback'; message: string; hits: HelpHit[] }
  /** 作者主动停止：什么都不算，界面保留提问方便重试 */
  | { kind: 'cancelled'; hits: HelpHit[] }

/** 答疑的召回条数：比手册页的 5 段多一点，模型需要上下文拼接空间 */
export const ASK_RECALL_LIMIT = 6

/** 回答的输出预算：一段操作说明通常远小于此，留余量给「步骤 + 注意事项」 */
export const ASK_OUTPUT_TOKENS = 700

/** 可替换的调用边界，用于验证配置读取失败和取消时序；正式使用始终走公共模型层。 */
interface AskDependencies {
  resolveProviderFor: typeof resolveProviderFor
  chat: typeof chat
}
const defaultDependencies: AskDependencies = { resolveProviderFor, chat }

function fragmentsStillCurrent(hits: HelpHit[], fragments: HelpPromptFragment[]): boolean {
  const current = prepareHelpPromptFragments(hits)
  return current.length === fragments.length && fragments.every((fragment, index) => (
    current[index].hit.articleId === fragment.hit.articleId
    && current[index].hit.sectionId === fragment.hit.sectionId
    && current[index].text === fragment.text
    && current[index].sourceSnapshot === fragment.sourceSnapshot
  ))
}

const changedHelp = (hits: HelpHit[]): AskResult => ({
  kind: 'fallback', message: '手册内容在回答期间发生变化，请重新提问；已退回手册检索结果。', hits,
})

/** 召回：答疑与手册页复用同一套本地检索，口径一致才不会「搜得到、问不出」 */
export function recallForAsk(question: string, currentTabId?: string | null): HelpHit[] {
  if (!question.trim()) return []
  return searchHelp(question, { currentTabId: currentTabId ?? null, limit: ASK_RECALL_LIMIT })
}

/**
 * 问一次。
 *
 * @param question     作者原话
 * @param currentTabId 当前所在页签（只用于检索加权，**不进提示词** —— 页面标题不是产品事实）
 * @param signal       停止按钮
 */
export async function askHelpOnce(
  question: string,
  currentTabId?: string | null,
  signal?: AbortSignal,
  dependencies: AskDependencies = defaultDependencies,
): Promise<AskResult> {
  const hits = recallForAsk(question, currentTabId)
  if (signal?.aborted) return { kind: 'cancelled', hits }
  // ① 没召回就不问模型：没有片段时模型只能凭常识编，而「凭常识编出来的软件用法」正是本功能要避免的
  if (hits.length === 0) return { kind: 'no-recall', hits }
  const fragments = prepareHelpPromptFragments(hits)
  if (fragments.length === 0) return { kind: 'fallback', message: '手册内容暂时无法核对，已退回手册检索结果。', hits }

  // ② 模型归属走「整理」用途：答疑是低频、短输出、要快的活，不该占创作模型
  let raw = ''
  try {
    const provider = await dependencies.resolveProviderFor('utility')
    // 配置读取可能慢于用户按停止；不能在停止后仍发起模型请求。
    if (signal?.aborted) return { kind: 'cancelled', hits }
    if (!provider) return { kind: 'no-model', hits }
    if (!fragmentsStillCurrent(hits, fragments)) return changedHelp(hits)
    const prompt = buildHelpAnswerPrompt(question, hits, fragments)
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ]
    raw = await dependencies.chat(provider, messages, {
      // 结构化小任务：显式声明「要 JSON 对象」+「关推理」（3.2.0 · WQ5 的唯一口径）。
      // 🔴 不要退回旧的兼容写法 —— 新链路必须走协议声明（闸 outputProtocol ⑨ / thinkPolicy 棘轮）。
      output: 'json-object',
      reasoning: 'off',
      // 🔴 提示词隔离：不带作者的创作附加提示词（见文件头 ②）
      skipUserSystem: true,
      // 🔴 全局归属：不属于当前打开的小说，也不属于正在跑的任务（见文件头 ①）
      request: { scope: 'global', projectId: null, taskType: 'help-answer' },
      intent: 'help-answer',
      outputTokens: ASK_OUTPUT_TOKENS,
      signal,
    })
  } catch (error) {
    if (isCancelled(error) || signal?.aborted) return { kind: 'cancelled', hits }
    // 网络 / 端点错误也走回退：手册片段已经拿到了，不能让作者空手
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'fallback', message: `答疑模型这次没能回答（${detail.slice(0, 80)}），已退回手册检索结果。`, hits }
  }

  if (signal?.aborted) return { kind: 'cancelled', hits }

  // 请求期间手册若发生变化，旧答案不能静默指向新的正文。
  if (!fragmentsStillCurrent(hits, fragments)) return changedHelp(hits)

  // ③ 校验：来源必须在本次召回内、摘录必须逐字出现在原文
  const checked = readHelpAnswer(raw, hits, fragments)
  if (!checked.ok) {
    return { kind: 'fallback', message: HELP_ANSWER_FAILURE_TEXT[checked.reason], hits }
  }
  const sourceSnapshots = Object.fromEntries(fragments.map(fragment => [
    `${fragment.hit.articleId}/${fragment.hit.sectionId}`, fragment.sourceSnapshot,
  ]))
  return { kind: 'answer', answer: checked.answer, sources: checked.sources, sourceSnapshots, hits }
}

/** 失败原因 → 一句话（供单测与界面复用，避免两处各写一份措辞） */
export function askFailureText(reason: HelpAnswerFailure): string {
  return HELP_ANSWER_FAILURE_TEXT[reason]
}
