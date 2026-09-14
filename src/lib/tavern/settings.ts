/**
 * 酒馆模式 · 控制面板设置（全局 meta）
 *
 * 【为什么要有这一层】
 * 之前这些「接进 AI 的参数与提示词」全散在代码里：温度写在 `types.ts` 的 TAVERN_DEFAULTS、
 * 聊天向风格写在 `prompt.ts` 的 TONE_HINT、记忆阈值写在 `memory.ts`、超时写在 `ai.ts`……
 * 想调一个数就得改代码 + 重新构建。这里把它们**收到一处**，并落成**全局设置**，
 * 由控制面板这个页签直接改。
 *
 * 【三条原则】
 *  ① **默认值就是原来的硬编码值**（逐个照抄，不趁机"顺手优化"）—— 所以打开面板前与打开后
 *     的行为完全一致，不存在"升个版本悄悄变了风格"。
 *  ② 存储走**全局 meta**（`tavern.settings`），与自由模式其余数据同域：不绑项目、删项目不跟着没。
 *  ③ 读取一律走 `getTavernSettings()`（与默认值深合并），**不要直接读 meta** ——
 *     否则将来新增字段时，老数据里没有该键会读出 undefined 并一路传下去。
 *
 * 【参数的优先级链没变】
 * 会话参数 → 角色参数 → **控制面板（本文件）** → `TAVERN_DEFAULTS` 内置兜底。
 * 本文件提供的那一层由 `commonParamsLayer` / `modeParamsLayer` 拼出来，交给 `resolveParams` 逐层覆盖。
 *
 * 本文件是纯逻辑，不含 React。
 */
import * as db from '../db'
import {
  TAVERN_DEFAULTS, MEMORY_SOFT_LIMIT, MEMORY_HARD_LIMIT, MEMORY_LONGTERM_LIMIT,
  MEMORY_DIARY_DAYS, SUMMARY_TRIGGER_MESSAGES, SUMMARY_MIN_INTERVAL_MS, SUMMARY_LOCK_TTL_MS,
  DAILY_ADVANCE_MS, DAILY_LOG_KEEP,
  type TavernParams,
} from './types'
import { TONE_HINT } from './prompt'
import { PROTOCOL_CORE } from './protocol'
import { FIXED_OVERHEAD_CHARS } from './budget' // budget 只依赖 types，不会成环

/** 设置存储键（全局 meta） */
export const K_TAVERN_SETTINGS = 'tavern.settings'

/** 通用控制（两种模式都生效） */
export type TavernCommonSettings = {
  /** 默认模型：留空 = 跟随「模型设置」里的全局活动模型（会话里还能单独改） */
  defaultProviderId: string
  /** 上下文预算（字）：一轮请求里「设定 + 记忆 + 历史」的总字数上限 */
  contextBudget: number
  /** 固定开销预留（字）：给 system 骨架与协议留的位置，不计入可分配给历史的额度 */
  fixedOverheadChars: number
  /** 请求超时（秒）—— 本地模型慢时可调大 */
  timeoutSec: number
  /** 上下文窗口：显式传给模型，避免它按全局值（可能 128K）加载而爆显存 */
  numCtx: number
  /** 关闭思考链：角色扮演要「像人说话」，不要分析腔，所以默认关 */
  disableThink: boolean
  /** 通用补充要求：拼进两种模式的 system（放在协议之前）。默认含「标点适用范围」那条 */
  extraPrompt: string
}

/** 剧情推演控制 */
export type TavernPlotSettings = {
  temperature: number
  topP: number
  topK: number
  repeatPenalty: number
  presencePenalty: number
  /** 设定层占上下文预算的比例：剩下的留给对话历史与长期记忆 */
  settingRatio: number
  /** 叙事向风格追加（默认空 = 不追加，就走协议默认 —— 方案 §5.2 的原意） */
  styleHint: string
  /** 剧情推演专属补充要求 */
  extraPrompt: string
}

/** 自由对话控制 */
export type TavernFreeSettings = {
  temperature: number
  topP: number
  topK: number
  repeatPenalty: number
  presencePenalty: number
  /** 总结模型：整理记忆用，越快越省越好。留空 = 跟随上面的默认模型 */
  summaryProviderId: string
  /**
   * 默认「我演」的角色（自由模式）。
   *
   * 自由模式默认是「用户演他自己」—— AI 会把你当作**没有具体身份的本人**，
   * 不替你编一个角色；但代价是它不知道在跟谁对话，称呼与距离无从针对。
   * 这里指定一个角色卡之后，新建对话会自动把它预填成一个「我演」位置。
   * 留空 = 保持「你演你自己」。
   */
  defaultUserCharId: string
  /** 聊天向风格提示（默认沿用原 TONE_HINT.chat） */
  styleHint: string
  /** 自由对话专属补充要求 */
  extraPrompt: string
  /** 未总结消息达到多少条就自动整理一次记忆 */
  triggerMessages: number
  /** 记忆软上限（字）：超过就在界面上提醒 */
  softLimit: number
  /** 记忆硬上限（字）：超过就按序压缩 */
  hardLimit: number
  /** 「长期摘要」单栏字数上限 */
  longTermLimit: number
  /** 「最近日记」保留天数 */
  diaryDays: number
  /** 两次自动整理之间的最小间隔（分钟） */
  summaryMinIntervalMin: number
  /** 整理锁的有效期（分钟）：上次跑到一半崩了，超过它可被接管 */
  summaryLockTtlMin: number
  /** 日常状态推进间隔（小时）—— 距上次活跃超过它才补写「这几天的生活」 */
  dailyAdvanceHours: number
  /** 日常「这几天的生活」保留条数 */
  dailyLogKeep: number
}

export type TavernSettings = {
  common: TavernCommonSettings
  plot: TavernPlotSettings
  free: TavernFreeSettings
  /** 扮演协议全文（两种模式共用，钉在 system 末尾）。默认 = 内置常量 */
  protocol: string
}

/**
 * 「标点适用范围」——放在**通用补充要求**的默认值里。
 *
 * 起因：角色卡的示例常是「手机消息体」风格（短句、无标点连发），模型会把这套风格
 * 泛化到整篇，连动作描写（全角括号内）都不加标点。这是两个模式共有的问题，故放通用层。
 * ★ 用户可以改、也可以清空 —— 它只是默认值。
 *
 * ⚠️ **排版纪律：一段话就是一整行，不许为了「好看」把一句话硬折成多行。**
 * 这段文本会直接显示在控制面板的多行输入框里，硬换行 + 行首缩进会让用户看到
 * 「上一行是逗号、下一行却换行，还带着莫名的空格」的乱排版（首版就踩过这个坑）。
 * 段与段之间用空行分隔即可（`\n\n`）。
 */
export const DEFAULT_COMMON_EXTRA = [
  '标点照常用：动作与神态、环境叙述、对白，一律使用正常的中文标点（，。？！、……）。',
  '唯一的例外：角色卡的示例若采用「无标点的消息体」风格（真人发微信那种），那也只是该角色发出去的消息文本可以少标点；动作描写（全角括号内）与叙述照旧要用标点，不要把整段写成没有标点的空格流。',
].join('\n\n')

/**
 * 首版（2.1.0）的默认文本 —— 句子被硬折成 4 行、行首还带两个空格缩进。
 * 存过设置的机器会把这串旧文本原样留在库里，光改默认值救不回来，故留作升级比对的锚点。
 * **只在存储里正好等于这串旧默认时才升级**；用户自己改过的文本一律不动。
 */
const LEGACY_DEFAULT_COMMON_EXTRA = [
  '标点照常用：动作与神态、环境叙述、对白一律使用正常的中文标点（，。？！、……）。',
  '★ 唯一的例外：角色卡的示例若采用「无标点的消息体」风格（真人发微信那种），',
  '  那也只是该角色**发出去的消息文本**可以少标点；动作描写（全角括号内）与叙述照旧要用标点，',
  '  不要把整段写成没有标点的空格流。',
].join('\n')

/**
 * 老数据升级：把「存的就是旧版默认文本」的那一份换成新版默认文本。
 * 只比 `extraPrompt` 这一处（本文件目前唯一被改过排版的默认值）；
 * 将来若再有默认文本变更，按同样方式在这里追加一条比对，而不是去动用户已保存的值。
 */
function upgradeLegacyDefaults(raw: Partial<TavernSettings> | null): Partial<TavernSettings> | null {
  if (!raw || typeof raw !== 'object' || !raw.common) return raw
  if (raw.common.extraPrompt !== LEGACY_DEFAULT_COMMON_EXTRA) return raw
  return { ...raw, common: { ...raw.common, extraPrompt: DEFAULT_COMMON_EXTRA } }
}

/** 出厂协议（= 内置常量）。面板上的「恢复出厂协议」还原到这里 */
export const DEFAULT_PROTOCOL = PROTOCOL_CORE

/** 出厂默认：**与原硬编码值逐一对应**（不存在"顺手改过"的数） */
export const DEFAULT_TAVERN_SETTINGS: TavernSettings = {
  common: {
    defaultProviderId: '',
    contextBudget: TAVERN_DEFAULTS.free.contextBudget,
    fixedOverheadChars: FIXED_OVERHEAD_CHARS,
    timeoutSec: 180, // = ai.ts 的 CHAT_TIMEOUT_MS / 1000
    numCtx: TAVERN_DEFAULTS.free.numCtx,
    disableThink: true, // engine 原本恒传 think:false
    extraPrompt: DEFAULT_COMMON_EXTRA,
  },
  plot: {
    temperature: TAVERN_DEFAULTS.plot.temperature,
    topP: TAVERN_DEFAULTS.plot.topP,
    topK: TAVERN_DEFAULTS.plot.topK,
    repeatPenalty: TAVERN_DEFAULTS.plot.repeatPenalty,
    presencePenalty: TAVERN_DEFAULTS.plot.presencePenalty,
    settingRatio: 0.6, // engine 原本写死 Math.round(total * 0.6)
    styleHint: TONE_HINT.narrative,
    extraPrompt: '',
  },
  free: {
    temperature: TAVERN_DEFAULTS.free.temperature,
    topP: TAVERN_DEFAULTS.free.topP,
    topK: TAVERN_DEFAULTS.free.topK,
    repeatPenalty: TAVERN_DEFAULTS.free.repeatPenalty,
    presencePenalty: TAVERN_DEFAULTS.free.presencePenalty,
    summaryProviderId: '',
    defaultUserCharId: '',
    styleHint: TONE_HINT.chat,
    extraPrompt: '',
    triggerMessages: SUMMARY_TRIGGER_MESSAGES,
    softLimit: MEMORY_SOFT_LIMIT,
    hardLimit: MEMORY_HARD_LIMIT,
    longTermLimit: MEMORY_LONGTERM_LIMIT,
    diaryDays: MEMORY_DIARY_DAYS,
    summaryMinIntervalMin: Math.round(SUMMARY_MIN_INTERVAL_MS / 60000),
    summaryLockTtlMin: Math.round(SUMMARY_LOCK_TTL_MS / 60000),
    dailyAdvanceHours: Math.round(DAILY_ADVANCE_MS / 3600000),
    dailyLogKeep: DAILY_LOG_KEEP,
  },
  protocol: DEFAULT_PROTOCOL,
}

/** 深合并（只对普通对象递归，数组与标量直接覆盖） */
function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = k in out ? mergeDeep(out[k], v) : v
  }
  return out as T
}

/**
 * 读设置（与默认值深合并）。**所有消费方都走这里**。
 * 读取失败（存储不可用）时回退出厂默认，绝不抛 —— 设置读不出来不该让对话功能整个挂掉。
 */
export async function getTavernSettings(): Promise<TavernSettings> {
  try {
    const raw = await db.getMeta<Partial<TavernSettings> | null>(K_TAVERN_SETTINGS, null)
    // 先过一遍老数据升级（只动「还等于旧默认」的字段），再与默认值深合并
    return mergeDeep(DEFAULT_TAVERN_SETTINGS, upgradeLegacyDefaults(raw))
  } catch {
    return DEFAULT_TAVERN_SETTINGS
  }
}

export async function saveTavernSettings(next: TavernSettings): Promise<TavernSettings> {
  const merged = mergeDeep(DEFAULT_TAVERN_SETTINGS, next)
  await db.setMeta(K_TAVERN_SETTINGS, merged)
  return merged
}

/** 恢复出厂默认（写回默认值，而不是删键 —— 删键在部分后端会留下 undefined 分支） */
export async function resetTavernSettings(): Promise<TavernSettings> {
  await db.setMeta(K_TAVERN_SETTINGS, DEFAULT_TAVERN_SETTINGS)
  return DEFAULT_TAVERN_SETTINGS
}

// ==================== 给引擎用的派生量 ====================

/** 通用层参数（上下文预算 / num_ctx 属于"不管哪种模式都一样"的量） */
export function commonParamsLayer(s: TavernCommonSettings): TavernParams {
  return { contextBudget: s.contextBudget, numCtx: s.numCtx }
}

/** 模式层参数（温度等两种模式各有一套，所以不能塞进通用层） */
export function modeParamsLayer(mode: 'plot' | 'free', s: TavernSettings): TavernParams {
  const m = mode === 'plot' ? s.plot : s.free
  return {
    temperature: m.temperature,
    topP: m.topP,
    topK: m.topK,
    repeatPenalty: m.repeatPenalty,
    presencePenalty: m.presencePenalty,
  }
}

/** 记忆与日常的阈值（自由对话用） */
export type TavernMemoryLimits = {
  triggerMessages: number
  softLimit: number
  hardLimit: number
  longTermLimit: number
  diaryDays: number
  minIntervalMs: number
  dailyAdvanceMs: number
  /** 整理锁有效期（毫秒） */
  lockTtlMs: number
  /** 日常「这几天的生活」保留条数 */
  dailyLogKeep: number
}

export function memoryLimitsOf(s: TavernSettings): TavernMemoryLimits {
  const f = s.free
  return {
    triggerMessages: f.triggerMessages,
    softLimit: f.softLimit,
    hardLimit: f.hardLimit,
    longTermLimit: f.longTermLimit,
    diaryDays: f.diaryDays,
    minIntervalMs: Math.max(0, f.summaryMinIntervalMin) * 60000,
    dailyAdvanceMs: Math.max(0, f.dailyAdvanceHours) * 3600000,
    lockTtlMs: Math.max(1, f.summaryLockTtlMin) * 60000,
    dailyLogKeep: Math.max(1, f.dailyLogKeep),
  }
}

/** 请求超时（毫秒） */
export function timeoutMsOf(s: TavernSettings): number {
  return Math.max(5, s.common.timeoutSec) * 1000
}

/** 整理锁有效期（毫秒） */
export function summaryLockTtlOf(s: TavernSettings): number {
  return Math.max(1, s.free.summaryLockTtlMin) * 60000
}

/** think 字段：关闭思考链时传 false，否则传 undefined（= 不下发该字段，让模型保持思考） */
export function thinkOptOf(s: TavernSettings): boolean | undefined {
  return s.common.disableThink ? false : undefined
}
