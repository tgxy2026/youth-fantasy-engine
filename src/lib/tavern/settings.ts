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
  MEMORY_DIARY_DAYS, SUMMARY_LOCK_TTL_MS,
  DAILY_ADVANCE_MS, DAILY_LOG_KEEP,
  type TavernParams, type SceneDescLevel, type PlotContextSource, type VarKey,
} from './types'
import { TONE_HINT } from './prompt'
import { PROTOCOL_CORE, LEGACY_PROTOCOLS } from './protocol'
import { DEFAULT_POST_RULES, LEGACY_DEFAULT_POST_RULES, normalizePostRules, type PostRule } from './postRules'
import { FIXED_OVERHEAD_CHARS } from './budget' // budget 只依赖 types，不会成环
import { resolveParams } from './params'          // 同上：params 只依赖 types

/** 设置存储键（全局 meta） */
export const K_TAVERN_SETTINGS = 'tavern.settings'

/** 通用控制（两种模式都生效） */
export type TavernCommonSettings = {
  /** 默认模型：留空 = 跟随「灵感启发 → 模型配置」里的全局活动模型（会话里还能单独改） */
  defaultProviderId: string
  /** 上下文预算（字）：一轮请求里「设定 + 记忆 + 历史」的总字数上限 */
  contextBudget: number
  /**
   * 额外安全余量（字）。**语义已变（2026-09-14，老大选 C 档）**：以前它是「协议 + 记忆」的预留，
   * 但 system 里本来就含这两样（buildSystemPrompt 会把记忆一起拼进去）→ 等于扣两遍。
   * 现在只当纯余量：覆盖各层标题与少量未计入 system 的内容，默认 400。
   */
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
  /**
   * 设定层来源（A 档）：项目原始资料 / 背景设定 / 两者。
   * 见 types.PlotContextSource —— 选 digest 能省下约 2400 字设定层开销，全还给对话历史。
   */
  contextSource: PlotContextSource
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
   * （2.1.0 这里曾是「默认『我演』的角色」，**已废弃**。）
   *
   * 它把「用户本人是谁」与「这次演谁」混成一个字段，现在拆成两处：
   *   · 用户本人是谁 → 全局的 `profile`（我的档案，跨项目）
   *   · 这次演谁     → 新建对话时每个位置的「由谁演」下拉
   * 老库里残留的 `defaultUserCharId` 由 `upgradeLegacyDefaults` 主动删除 ——
   * mergeDeep 对「默认值里已经没有的键」是**照抄进去**的，不删它会一直躺在库里被反复写回。
   */
  /** 聊天向风格提示（默认沿用原 TONE_HINT.chat） */
  styleHint: string
  /**
   * 客观描写档位（沉浸感）：只靠对白与动作，画面是空的 ——
   * 这一项决定要不要、以及多密地写「她穿什么、屋里什么光、外面什么天气」。
   * 默认 standard；关掉即回到「只写对白与动作」的旧行为。
   */
  sceneDescription: SceneDescLevel
  /** 自由对话专属补充要求 */
  extraPrompt: string
  /** 记忆软上限（字）：超过就在界面上提醒 */
  softLimit: number
  /** 记忆硬上限（字）：超过就按序压缩 */
  hardLimit: number
  /** 「长期摘要」单栏字数上限 */
  longTermLimit: number
  /** 「最近日记」保留天数 */
  diaryDays: number
  /** 整理锁的有效期（分钟）：上次跑到一半崩了，超过它可被接管 */
  summaryLockTtlMin: number
  /** 日常状态推进间隔（小时）—— 距上次活跃超过它才补写「这几天的生活」 */
  dailyAdvanceHours: number
  /** 日常「这几天的生活」保留条数 */
  dailyLogKeep: number
}

// 🚫 已废除（2026-09-16，老大拍板）：`triggerMessages`（触发整理的条数阈值）
//    与 `summaryMinIntervalMin`（两次自动整理的最小间隔）。
//    项目不再有任何「自动整理」—— 两种模式都由作者手动触发，所以这两个旋钮拧了没有任何效果。
//    老库里残留的值由 `upgradeLegacyDefaults` 主动删除（mergeDeep 否则会照抄回来）。

/**
 * 「我的档案」——**用户本人**是谁。全局生效（跨项目、跨会话，与控制面板其余设置同域）。
 *
 * 【它替代了什么】
 * 2.1.0 曾在「自由对话控制」里放一个「默认『我演』的角色」（选一张卡预填成「我演」）。
 * 那个设计把两件事混在一起：用户**自己**是谁（人），与他这次**想演哪个角色**（戏）。
 * 拆开后：档案只描述屏幕后面这个人，演谁由每次新建对话的槽位决定。
 * 于是「我演」留空时，AI 不再是「不知道在跟谁说话」，而是**知道你是谁** —— 称呼与距离有据可依。
 *
 * 【为什么只有三个字段】
 * 档案**每轮都进 system**，越长越挤占历史额度。名字 + 称呼 + 一句话自我设定，
 * 足以让 AI 叫对人、拿对语气；人物细节交给角色卡与记忆。
 * 头像是图片（不占字数），与角色头像共用同一套上传组件（批次 8 已落地）。
 */
export type TavernProfile = {
  /** 你的名字 */
  name: string
  /** 希望被怎么称呼（留空 = 直呼名字） */
  address: string
  /** 一句话自我设定：身份、年纪、与对方的关系……越短越有效 */
  persona: string
  /**
   * 头像（dataURL，已压缩到 256px）。**不进提示词** —— 它只决定界面上代表你的那张小图。
   * 空 = 用名字首字代替。
   */
  avatar: string
}

/** 出厂档案：空。**空档案整段不注入**，行为与「没有这一层」完全一致 */
export const DEFAULT_TAVERN_PROFILE: TavernProfile = {
  name: '',
  address: '',
  persona: '',
  avatar: '',
}

/**
 * 本场变量（C2 第二步）的设置 —— 与角色卡/记忆都无关，是「这一场」的运行参数。
 *
 * 默认**开着**：老大点名要做这个功能，默认关掉等于让人去找开关。
 * 它只在自由对话里生效（剧情推演以「诊断角色反应」为目的，不该引入数值游戏）。
 */
export type TavernVarsSettings = {
  /** 总开关（关掉 = 提示词里一个字都不出现） */
  enabled: boolean
  /** 逐项**关闭**的变量（把「不要好感度」这种场合留给作者） */
  off: VarKey[]
  /** 单次变化幅度上限（默认 ±5，越界按上限走） */
  maxStep: number
}

export const DEFAULT_TAVERN_VARS: TavernVarsSettings = {
  enabled: true,
  off: [],
  maxStep: 5,
}

export type TavernSettings = {
  common: TavernCommonSettings
  /** 我的档案：用户本人是谁（全局，跨项目） */
  profile: TavernProfile
  plot: TavernPlotSettings
  free: TavernFreeSettings
  /** 本场变量（C2 第二步）：自由对话专用 */
  vars: TavernVarsSettings
  /** 扮演协议全文（两种模式共用，钉在 system 末尾）。默认 = 内置常量 */
  protocol: string
  /**
   * 输出后处理规则（B3）：生成后**按顺序**跑一遍再落库（半角括号、markdown 星号、行首说话人标签…）。
   * 与协议同域放全局：它管的是「模型输出格式」，不随项目走。
   * 顺序有意义 —— 出厂列表里「去 markdown」必须排在「星号动作」之前。
   */
  postRules: PostRule[]
  /** 总开关：关掉就完全不跑规则（排查格式问题时用） */
  postRulesEnabled: boolean
  /** 命中规则时是否在对话页提示一句（关掉 = 静默修正） */
  postRuleNotice: boolean
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
 * 老数据升级：把「存的就是旧版内置文本」的那一份换成新版。**一律全等比对**，
 * 用户自己改过的一个字都不动。两处要比：
 *   ① `common.extraPrompt` —— 默认文本改过排版（一句话被硬折成 4 行那次）；
 *   ② `protocol` —— 协议从 v1.1 升 v1.2（三类标记重划 + 代词中性化）。
 *      ⚠️ 协议是可编辑的，所以改内置常量**对存过设置的用户无效**，必须在这里升级；
 *      历史版本全文见 protocol.ts 的 `LEGACY_PROTOCOLS`。
 *   ③ `free.defaultUserCharId` —— 已废弃的键，**直接删**（这不是"升级默认值"，是清场）。
 * 将来再有默认文本/协议变更，按同样方式在这里追加比对，别去动用户已保存的值。
 */
/** 库里那四条输出后处理规则是不是「原封未动的旧出厂值」（只看关键字段，忽略 flags/note 的差异） */
function isLegacyPostRules(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length !== LEGACY_DEFAULT_POST_RULES.length) return false
  return LEGACY_DEFAULT_POST_RULES.every((old, i) => {
    const r = raw[i] as Partial<PostRule> | undefined
    return !!r && r.id === old.id && r.pattern === old.pattern && r.replacement === old.replacement
  })
}


function upgradeLegacyDefaults(raw: Partial<TavernSettings> | null): Partial<TavernSettings> | null {
  if (!raw || typeof raw !== 'object') return raw
  let out = raw
  // ④ 输出后处理：旧版 `pr-star-action` 正则会把「*(动作)*」产出成 （（动作））双层括号。
  //    🔴 只替换「作者的的确确没动过」的库（与旧出厂**全等**）—— 改过顺序 / 开关 / 正则的一律不碰。
  if (isLegacyPostRules(out.postRules)) {
    out = { ...out, postRules: DEFAULT_POST_RULES.map(r => ({ ...r })) }
  }
  if (out.common && out.common.extraPrompt === LEGACY_DEFAULT_COMMON_EXTRA) {
    out = { ...out, common: { ...out.common, extraPrompt: DEFAULT_COMMON_EXTRA } }
  }
  if (typeof out.protocol === 'string' && LEGACY_PROTOCOLS.includes(out.protocol)) {
    out = { ...out, protocol: PROTOCOL_CORE }
  }
  // ⑤ 出厂参数放宽（2026-09-15）：上下文预算 / 超时 / 采样面 / 记忆三档上限整体上移。
  //    🔴 与上面各条同一条纪律：**只升级「还等于旧出厂值」的字段**，手动调过的一个都不动。
  //    不加这段的话，改默认值对存过设置的机器完全无效（mergeDeep 只会用库里的旧值）。
  {
    const cur = out.common
    if (cur) {
      const next = { ...cur }
      let dirty = false
      if (next.contextBudget === 16000) { next.contextBudget = 24000; dirty = true }
      if (next.timeoutSec === 180) { next.timeoutSec = 300; dirty = true }
      if (dirty) out = { ...out, common: next }
    }
    const p = out.plot
    if (p) {
      const next = { ...p }
      let dirty = false
      if (next.temperature === 0.85) { next.temperature = 0.9; dirty = true }
      if (next.topP === 0.9) { next.topP = 0.92; dirty = true }
      if (next.topK === 40) { next.topK = 60; dirty = true }
      if (next.presencePenalty === 0.4) { next.presencePenalty = 0.5; dirty = true }
      if (dirty) out = { ...out, plot: next }
    }
    const f = out.free
    if (f) {
      const next = { ...f }
      let dirty = false
      if (next.temperature === 0.9) { next.temperature = 0.95; dirty = true }
      if (next.topP === 0.9) { next.topP = 0.92; dirty = true }
      if (next.topK === 40) { next.topK = 60; dirty = true }
      if (next.presencePenalty === 0.45) { next.presencePenalty = 0.55; dirty = true }
      if (next.softLimit === 1200) { next.softLimit = 2000; dirty = true }
      if (next.hardLimit === 2000) { next.hardLimit = 3000; dirty = true }
      if (next.longTermLimit === 350) { next.longTermLimit = 500; dirty = true }
      if (next.diaryDays === 5) { next.diaryDays = 7; dirty = true }
      if (next.dailyLogKeep === 5) { next.dailyLogKeep = 7; dirty = true }
      if (dirty) out = { ...out, free: next }
    }
  }
  // ③ `search` —— 2026-09-15 搬去了全局键 `app.search`（联网检索是全局功能，
  //    不该挂在酒馆的设置里；界面也搬到了「灵感工具 → 灵感启发」，见 searchSettings.ts）。
  //    🔴 这里必须主动删：mergeDeep 会把「默认值里已经没有的键」从旧数据/旧预设里**照抄回来**，
  //    留着它就会一直躺在库里被反复写回，将来有人搜到还会以为它有用。
  if ('search' in (out as Record<string, unknown>)) {
    const rest = { ...(out as unknown as Record<string, unknown>) }
    delete rest.search
    out = rest as Partial<TavernSettings>
  }
  // ③ `free.defaultUserCharId` —— 已废弃的字段，**主动删掉**。
  //    mergeDeep 会把「默认值里已经没有的键」照抄进来，留着它就一直躺在库里被反复写回，
  //    将来有人搜到它还会以为它有用（这类「死配置」本项目已经清过好几个）。
  if (out.free && typeof out.free === 'object' &&
      ('defaultUserCharId' in out.free || 'triggerMessages' in out.free || 'summaryMinIntervalMin' in out.free)) {
    const rest = { ...(out.free as unknown as Record<string, unknown>) }
    delete rest.defaultUserCharId
    // 2026-09-16：项目不再有任何「自动整理」—— 这两个旋钮成了死键，拧了没有任何效果。
    // 不在这里删掉的话，它们会随 mergeDeep 一直留在库里被反复写回。
    delete rest.triggerMessages
    delete rest.summaryMinIntervalMin
    out = { ...out, free: rest as unknown as TavernFreeSettings }
  }
  return out
}

/** 出厂协议（= 内置常量）。面板上的「恢复出厂协议」还原到这里 */
export const DEFAULT_PROTOCOL = PROTOCOL_CORE

/** 出厂默认：**与原硬编码值逐一对应**（不存在"顺手改过"的数） */
export const DEFAULT_TAVERN_SETTINGS: TavernSettings = {
  profile: DEFAULT_TAVERN_PROFILE,
  vars: DEFAULT_TAVERN_VARS,
  common: {
    defaultProviderId: '',
    contextBudget: TAVERN_DEFAULTS.free.contextBudget,
    fixedOverheadChars: FIXED_OVERHEAD_CHARS,
    timeoutSec: 300, // 本地模型首字慢 + 生成长，2026-09-15 由 180 提到 300（guide 推荐段上限）
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
    contextSource: 'both', // = 加开关之前的行为，老用户升级后一个字都不会变
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
    styleHint: TONE_HINT.chat,
    // 默认 standard：这是本轮**刻意新增**的行为（不是照抄旧硬编码值）——
    // 老大要的沉浸感：出场写穿着/姿态、转场补环境、情绪落到外在细节上。
    // 嫌吵或嫌占字数就在面板上降到 light / 关掉。
    sceneDescription: 'standard',
    extraPrompt: '',
    softLimit: MEMORY_SOFT_LIMIT,
    hardLimit: MEMORY_HARD_LIMIT,
    longTermLimit: MEMORY_LONGTERM_LIMIT,
    diaryDays: MEMORY_DIARY_DAYS,
    summaryLockTtlMin: Math.round(SUMMARY_LOCK_TTL_MS / 60000),
    dailyAdvanceHours: Math.round(DAILY_ADVANCE_MS / 3600000),
    dailyLogKeep: DAILY_LOG_KEEP,
  },
  protocol: DEFAULT_PROTOCOL,
  // 出厂四条全开 —— 四条都是「把违规写法掰回协议」，不会误伤正常输出（见 postRules.ts 的说明）
  postRules: DEFAULT_POST_RULES.map(r => ({ ...r })),
  postRulesEnabled: true,
  postRuleNotice: true,
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
    const merged = mergeDeep(DEFAULT_TAVERN_SETTINGS, upgradeLegacyDefaults(raw))
    // 后处理规则是数组（mergeDeep 整段替换），老数据或手改过的 JSON 可能缺字段 → 归一化一遍
    return { ...merged, postRules: normalizePostRules(merged.postRules) }
  } catch {
    return DEFAULT_TAVERN_SETTINGS
  }
}

export async function saveTavernSettings(next: TavernSettings): Promise<TavernSettings> {
  const merged = mergeDeep(DEFAULT_TAVERN_SETTINGS, next)
  // 写入侧也要剔一次旧键：老预设（存着旧结构的 TavernSettings）一经应用，
  // 里面的 search 会被 mergeDeep 原样带进来 —— 读取侧虽然也会删，但没必要先脏一次库。
  const clean = { ...(merged as unknown as Record<string, unknown>) }
  delete clean.search
  const out = clean as unknown as TavernSettings
  await db.setMeta(K_TAVERN_SETTINGS, out)
  return out
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

/** 与引擎**逐字相同**的参数叠层顺序（会话 → 模式 → 通用）。改这里要同步 `engine.ts` 的四处调用 */
export function resolveParamsOf(mode: 'plot' | 'free', s: TavernSettings, sessionParams?: TavernParams) {
  return resolveParams(mode, commonParamsLayer(s.common), modeParamsLayer(mode, s), sessionParams)
}

/**
 * 这次请求真正会用到的上下文预算。
 *
 * 🔴 存在的唯一理由：**同一个数不能在两处各算一遍**。
 * 反馈 #1 的原话是「控制面板把预算改成 32000，用量明细里的总额度还是 24000」——
 * 查下来设置本身是生效的（引擎走 `resolveParams`，控制面板的通用层压过会话层），
 * 但明细那边直接读 `session.params.contextBudget`、空了就回落硬编码常量，
 * 于是它永远显示内置默认值。抽成这一个函数给界面用，就不会再有第二次分叉。
 */
export function effectiveContextBudget(
  mode: 'plot' | 'free',
  s: TavernSettings,
  sessionParams?: TavernParams,
): number {
  return resolveParamsOf(mode, s, sessionParams).contextBudget
}

/** 记忆与日常的阈值（自由对话用） */
export type TavernMemoryLimits = {
  softLimit: number
  hardLimit: number
  longTermLimit: number
  diaryDays: number
  dailyAdvanceMs: number
  /** 整理锁有效期（毫秒） */
  lockTtlMs: number
  /** 日常「这几天的生活」保留条数 */
  dailyLogKeep: number
}

export function memoryLimitsOf(s: TavernSettings): TavernMemoryLimits {
  const f = s.free
  return {
    softLimit: f.softLimit,
    hardLimit: f.hardLimit,
    longTermLimit: f.longTermLimit,
    diaryDays: f.diaryDays,
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
