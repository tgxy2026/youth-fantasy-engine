/**
 * 酒馆模式 · 类型定义
 *
 * 来源：《酒馆模式_完整落地方案.md》第 3.3 节。
 * 本文件**只有类型与常量**，不含任何逻辑（读写见 tavernStore.ts，提示词见 tavernPrompt.ts）。
 *
 * 两条线的数据归属（方案 3.1）：
 *   · 剧情模式 —— 归属当前小说项目（项目级 settingsKV）；推演报告落 `tavernReports` 表
 *   · 自由模式 —— **全局**（全局 meta），不绑任何项目，删项目也不会跟着没
 */

// ==================== 通用 ====================

export type TavernMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  /** 自由模式多角色同场时，标记这句是谁说的（角色卡 id）；用户为 undefined */
  speakerId?: string
  content: string
  at: number
  /** 被编辑过（用于 UI 标记） */
  edited?: boolean
  /** 多候选回复：同一位置的其他版本 */
  alternatives?: { id: string; content: string; at: number }[]
}

export type TavernModelRef = {
  /** 引用项目既有 provider 列表里的 id（见 ai.ts 的 AIProvider）——不复制一份模型配置 */
  providerId: string
}

export type TavernParams = {
  temperature?: number
  topP?: number
  topK?: number
  repeatPenalty?: number
  presencePenalty?: number
  numCtx?: number
  /** 上下文总预算（字符） */
  contextBudget?: number
}

/** 协议档位：叙事向（剧情默认）/ 聊天向（自由默认）。见方案 5.3 */
export type TavernTone = 'narrative' | 'chat'

/** 记忆水位线：已总结到哪一条消息（关机/失败/中途退出都不丢不重） */
export type TavernWatermark = { messageId: string; at: number }

// ==================== 剧情模式 ====================

export type CastRole = 'user' | 'ai' | 'silent'
export type TavernMode = 'immersive' | 'director'   // 沉浸 / 导演

export type TavernCast = {
  cardId: string        // 小说项目里 CardRecord 的 id
  role: CastRole
  /** 该角色所处的页签（char-main / char-secondary / char-npc），用于事实边界过滤 */
  tabId: string
  /** 冗余存角色名：卡片被删后列表仍可读 */
  name: string
}

export type TavernSession = {
  id: string
  title: string
  mode: TavernMode
  /** 叙事锚点：章节 id。之后的内容一律不带入上下文 */
  anchorChapterId: string
  /** 冗余存章标题，列表展示用（章被删也不变空白） */
  anchorChapterLabel: string
  cast: TavernCast[]
  /** 开场：轻表单 + 自由描述 */
  scene: {
    place: string
    time: string
    present: string[]      // 在场人物名
    description: string    // 自由描述
  }
  messages: TavernMessage[]
  model: TavernModelRef
  params: TavernParams
  /** 记忆总结水位线：已总结到哪一条消息 id */
  watermark?: TavernWatermark
  /** 是否继承上一次推演的记忆（见方案 5.4 / 6.9） */
  inheritMemoryFrom?: string
  /** 本场推演的六栏记忆（会话级） */
  memory?: string
  createdAt: number
  updatedAt: number
}

/** 扮演设定：给 AI 演「像」用的，塞行为不塞设定（方案 6.4） */
export type CastSetting = {
  /** 口吻：她怎么说话 */
  voice: string
  /** 称呼你的方式 */
  address: string
  /** 知识边界：哪些事她不知道 */
  unknown: string
  /** 禁忌与底线：碰了会怎样 */
  taboo: string
  /** 在意的事：软肋 */
  care: string
  /** 绝不会做的事：防 OOC */
  never: string
}

/** 扮演设定的空值（UI 表单初值 / store 兜底，单一真源） */
export const EMPTY_CAST_SETTING: CastSetting = {
  voice: '', address: '', unknown: '', taboo: '', care: '', never: '',
}

/** 六栏是否填过任何内容（UI 显示「已设定」标记用） */
export function hasCastSetting(cs?: Partial<CastSetting> | null): boolean {
  return !!cs && Object.values(cs).some(v => typeof v === 'string' && v.trim())
}

export type TavernFindingLevel = '矛盾' | '漏洞' | '存疑'

export type TavernFinding = {
  id: string
  level: TavernFindingLevel
  /** 指向哪张表：'char-main' | 'relations' | 'timeline' | 'worldbase' | ... */
  targetTabId: string
  /** 指向具体行/卡片。找不到就降级成 level='存疑' 并留空 */
  targetRecordId?: string
  /** 冗余存名字，便于展示 */
  targetLabel?: string
  detail: string
  suggestion?: string
}

export type TavernReport = {
  id: string
  projectId: string
  sessionId: string
  sessionTitle: string
  anchorChapterId: string
  anchorChapterLabel: string
  cast: TavernCast[]
  mode: TavernMode
  /** 概览：这场戏成不成立，三五句话 */
  overview: string
  findings: TavernFinding[]
  createdAt: number
}

// ==================== 自由模式 ====================

export type FreeCharacter = {
  id: string
  name: string
  avatar?: string          // dataURL
  // ── 角色卡正文：四章分块（第 0 章不要，协议已是内置常量）──
  /** 第 1 章 · 世界 */
  world: string
  /** 第 2 章 · 人物档案 */
  profile: {
    externals: string      // 2.1 外在
    core: string           // 2.2 内核
    speech: string         // 2.3 语言特征
    relations: string      // 2.4 关系
    cannot: string         // 2.5 做不到的事
    knowledge: string      // 2.6 知识边界
  }
  /** 第 3 章 · 行为规范 */
  conduct: {
    perspective: string    // 视角与人称
    bottomLine: string     // 底线清单
    paceLock: string       // 进度锁
    rating: string         // 尺度
  }
  /** 第 4 章 · 示例对话 */
  examples: string
  /** 来自哪张小说角色卡（单向桥溯源用） */
  importedFrom?: { projectId: string; cardId: string; at: number }
  createdAt: number
  updatedAt: number
}

export type FreeSession = {
  id: string
  charIds: string[]        // 支持多角色同场；v1 至少 1 个
  title: string
  messages: TavernMessage[]
  model: TavernModelRef
  params: TavernParams
  watermark?: TavernWatermark
  lastActiveAt: number
  createdAt: number
  updatedAt: number
}

/** 六栏记忆（方案 4.5）。注意六栏行为不同：会缩 / 只增 / 重写 */
export type FreeMemory = {
  charId: string
  /** 一、长期摘要（会缩，≤350 字） */
  longTerm: string
  /** 二、关键事实（只增不改） */
  facts: string
  /** 三、关系状态（每次重写；情绪并入此栏） */
  relation: string
  /** 四、未爆的雷（只增不改） */
  mines: string
  /** 五、纪念日 / 待办 */
  anniversaries: string
  /** 六、最近日记（保留最近五天，倒序） */
  diaries: string
  updatedAt: number
}

export type DailyState = {
  charId: string
  /** 上次活跃时间：下次打开时按 (now - lastActiveAt) 推进她的「生活」 */
  lastActiveAt: number
  /** 最近几天的生活轨迹（生成后累积） */
  log: { date: string; text: string }[]
  /** 当前心情（并入记忆的关系状态展示，单独存原值便于 UI 显示） */
  mood?: string
}

// ==================== 列表索引项 ====================
// 索引与分条分开存（方案 3.2）：索引只放列表要显示的字段，避免列表页把全部会话内容读进内存。

export type TavernSessionIndexItem = {
  id: string
  title: string
  mode: TavernMode
  /** 参演角色名摘要，列表直接用（不必回读会话） */
  castBrief: string
  anchorTitle: string
  updatedAt: number
}

export type TavernCharIndexItem = {
  id: string
  name: string
  avatar?: string
  updatedAt: number
}

export type TavernReportIndexItem = {
  id: string
  sessionId: string
  sessionTitle: string
  anchorChapterLabel: string
  /** 三档计数，列表直接显示，不必读全量 findings */
  counts: Record<TavernFindingLevel, number>
  createdAt: number
}

/** 自由模式会话索引项（按角色分组展示用） */
export type FreeSessionIndexItem = {
  id: string
  title: string
  charIds: string[]
  lastActiveAt: number
  updatedAt: number
}

// ==================== 默认值 ====================

/** 模式级默认参数（方案 4.9）：继承式覆盖 —— 会话参数 → 角色参数 → 模式默认 → 全局默认 */
export const TAVERN_DEFAULTS: {
  plot: Required<Pick<TavernParams, 'temperature' | 'topP' | 'topK' | 'repeatPenalty' | 'presencePenalty' | 'numCtx' | 'contextBudget'>>
  free: Required<Pick<TavernParams, 'temperature' | 'topP' | 'topK' | 'repeatPenalty' | 'presencePenalty' | 'numCtx' | 'contextBudget'>>
} = {
  plot: {
    temperature: 0.85, topP: 0.9, topK: 40,
    repeatPenalty: 1.05, presencePenalty: 0.4,
    numCtx: 32768, contextBudget: 8000,
  },
  free: {
    temperature: 0.9, topP: 0.9, topK: 40,
    repeatPenalty: 1.05, presencePenalty: 0.45,
    numCtx: 32768, contextBudget: 8000,
  },
}

/** 记忆字数约束（方案 4.5）：软上限 1200，硬截断 2000 */
export const MEMORY_SOFT_LIMIT = 1200
export const MEMORY_HARD_LIMIT = 2000
/** 「长期摘要」单独的字数上限 */
export const MEMORY_LONGTERM_LIMIT = 350
/** 「最近日记」保留天数（硬性滚动） */
export const MEMORY_DIARY_DAYS = 5

/** 触发自动总结的新消息条数阈值（方案 4.6 ①） */
export const SUMMARY_TRIGGER_MESSAGES = 6
/** 日常状态推进阈值：间隔 ≥ 8 小时才生成「这几天的生活」（方案 4.7） */
export const DAILY_ADVANCE_MS = 8 * 60 * 60 * 1000
/**
 * 记忆总结防重复（三层保险，数值照搬手册「记忆引擎」的实测默认值）：
 *   ① 时间节流 —— 两次自动总结至少间隔这么久（手册 auto_interval = 600 秒）
 *   ② 跨实例锁 —— 避免同时开两个窗口跑两遍
 *   ③ 锁 TTL 兜底 —— 上次跑到一半崩了的情况（手册 auto_lock_ttl = 1800 秒）
 */
export const SUMMARY_MIN_INTERVAL_MS = 600 * 1000
/** 总结锁的 TTL：超过这么久视为陈旧锁，可被接管 */
export const SUMMARY_LOCK_TTL_MS = 1800 * 1000
