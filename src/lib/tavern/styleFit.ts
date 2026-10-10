/**
 * 酒馆模式 · 「风格提示」与角色卡「尺度」的冲突自检（W4-2 / 方案 §13 F6）
 *
 * 【为什么需要】§13「关系有距离感」诊断的 A3 根因：
 *   自由对话的**风格提示**（`settings.free.styleHint`）是**每场注入**、且离生成点很近的一层；
 *   而角色卡 `conduct.rating`（第 3 章「尺度」）写的是**这段关系允许的表达密度**
 *   （例：可拥抱、可哭、可靠得很近）。
 *   当风格提示把自己钉成「即时聊天体 · 短句为主 · 最多连发 2 条」时，它就与
 *   「可以攥袖口、掰手指」这类卡文**直接打架** —— 模型会优先服从离生成点更近的那条，
 *   于是十香/折纸对士道**演得像陌生人**（只发短消息、不写肢体动作）。
 *
 * 【定位】这是一条**提醒**，不是校验 —— 作者完全可能有意让本场走聊天体。
 *   所以**绝不阻断**新建流程，界面只把它显示成一条可忽略的提示（与 F4 `profileFit` 同口径）。
 *
 * 【口径】判定全在这里，界面不许自己拼 —— 与「档案读取一律走 `activeProfileOf`」同一纪律：
 *   判断只许有一处，否则界面与引擎各判一次必然漂移。
 *
 * 🔒 **不扩范围**（§13.4 F6 边界）：本项只做「提示」，**不改亲密内容的解锁逻辑** ——
 *   亲密与否仍由角色卡 `conduct.rating` / `bottomLine` / `paceLock` 把关，
 *   **不因本提示而自动改卡、也不因数值升高而放开尺度**。
 *
 * 建立：2026-10-10（3.0 · 第 4 批 W4-2）
 */

import { TONE_HINT } from '@/lib/tavern/prompt'
import type { TavernTone } from '@/lib/tavern/types'

/**
 * 命中「聊天体 / 短句 / 限制篇幅」类风格提示的短语。
 * 覆盖两种常见写法：明说聊天体，或给出「短句为主 / 最多连发 N 条 / 不要长篇」这类硬约束。
 */
const CHAT_STYLE_RE =
  /(聊天体|聊天方式|即时聊天|消息体|短句为主|短句|最多连发|连发\s*\d+\s*条|不要长篇|别长篇|不要长段|短消息|像聊天)/

/**
 * 命中「表达密度高」类角色卡尺度描述的短语。
 * 这些措辞意味着卡文允许（甚至要求）丰富的肢体 / 情绪表达 —— 与聊天体的「短句」相冲。
 * 覆盖两类：① 明写可做的动作（拥抱 / 牵手 / 靠近 / 哭 …）；② 点明表达密度（细腻 / 丰富 / 第 4 章示例）。
 */
const RICH_EXPRESSION_RE =
  /(拥抱|抱住|牵手|拉手|攥|掰|蹭|贴近|靠得很近|靠近|依偎|贴|吻|哭|泪|抚摸|触碰|肢体|动作|细腻|丰富|情感外露|表情|第\s*4\s*章|示例对话)/

/** 冲突类型：目前只有一种（聊天体风格 ↔ 高表达密度卡文），留成联合方便将来扩展（如只挑剔长度）。 */
export type StyleFitKind = 'chat-vs-rich'

export type StyleFitWarning = {
  kind: StyleFitKind
  /** 给作者看的一句话（界面直接显示，不要再改写） */
  text: string
}

export type StyleFitInput = {
  /**
   * 本场**实际生效**的风格提示（已按「控制面板覆盖 → 内置档位默认」解析过）。
   * 🔴 传生效值而非原始值：档位是 chat 时即使作者没手填，内置默认也带聊天体约束。
   */
  styleHint: string
  /**
   * 本场全部参演角色卡的「尺度」文本（`conduct.rating`），含用户扮演的那个。
   * 空串 / 未填的卡不计。
   */
  castRatings: string[]
}

/**
 * 把「已生效的风格提示」解析出来。
 *
 * 🔴 **为什么必须由本模块提供**：风格提示有**两层** ——
 *   · 控制面板 `settings.free.styleHint`（作者手填 / 出厂默认 `TONE_HINT.chat`）；
 *   · 内置档位默认 `TONE_HINT[tone]`（自由对话恒为 `chat`）。
 * 引擎侧 `buildSystemPrompt` 用的是 `layers.styleHint ?? TONE_HINT[layers.tone]`。
 * 界面若自己写一遍这个解析，早晚跟引擎漂移（"界面说没冲突、引擎其实注入了聊天体"）。
 * 所以**解析只许有一处**，界面调用本函数拿生效值。
 *
 * ⚠️ 与引擎的差别：引擎那里 `styleHint: ''`（作者清空）会**回退**到档位默认；
 *    但界面无法区分"作者清空"与"没填过"，而 `settings.ts` 的出厂默认**本来就是 chat 档位的值**，
 *    所以界面口径为「手填值非空 → 用手填；否则用档位默认」。
 *    作者把控制面板那个框清空后**不会**被误报成叙事向 —— 宁可少提醒，不可误伤（这条提醒本来就允许忽略）。
 */
export function effectiveStyleHint(handWritten: string | undefined, tone: TavernTone): string {
  const s = (handWritten ?? '').trim()
  return s || TONE_HINT[tone] || ''
}

/** 摘要用于提示文案（原样嵌进去会把提示撑成一大段） */
function brief(s: string, n = 24): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 检查「本场风格提示」是否与参演角色的「尺度」冲突。
 * @returns 命中则返回一条提示；一切正常返回 `null`。
 */
export function checkStyleFit(input: StyleFitInput): StyleFitWarning | null {
  const hint = (input?.styleHint ?? '').trim()
  // 风格提示没写（或没命中聊天体约束）⇒ 谈不上冲突，直接放过
  if (!hint || !CHAT_STYLE_RE.test(hint)) return null

  const ratings = (input?.castRatings ?? []).map(s => (s ?? '').trim()).filter(Boolean)
  // 至少有一张卡明确写了「表达密度高」的尺度措辞，才算冲突（全空 / 全说"保持距离"则不报）
  const rich = ratings.find(r => RICH_EXPRESSION_RE.test(r))
  if (!rich) return null

  return {
    kind: 'chat-vs-rich',
    text: `本场风格提示写的是「${brief(hint)}」这类聊天体（短句为主），但本场有角色的「尺度」写着「${brief(rich)}」这类高表达密度 —— 两条都在每场注入、且风格提示离生成点更近，AI 很可能只顾发短消息、不演肢体与情绪，这场容易演得\"有距离感\"。想演得贴一些，建议把风格提示的「短句 / 连发条数」限制去掉，或改成叙事向。`,
  }
}
