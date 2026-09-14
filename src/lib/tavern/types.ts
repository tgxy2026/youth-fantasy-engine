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
  /**
   * 已隐藏：**不进上下文**（组装时跳过），但界面仍显示（灰显）、可随时恢复。
   * 长对话里「这段先别让 Ta 记得」用它。
   * ⚠️ 排除的唯一出口在 prompt.ts 的 toChatMessages 与 memory.ts 的水位线，别在别处再判一次。
   */
  hidden?: boolean
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

/**
 * 「客观描写」档位（自由对话）：沉浸感靠对白之外的东西撑起来 ——
 * Ta出场时的穿着与姿态、环境的光线与声音、情绪落到手上的小动作。
 *
 * 为什么做成档位而不是写死：聊天向默认要短句快节奏，硬塞描写会盖过对白；
 * 而有些场景（约会、初见、久别重逢）作者就是想要那份「看得见」的质感。
 */
export type SceneDescLevel = 'off' | 'light' | 'standard' | 'rich'

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

/**
 * 检查点：场内的一个「路标」，之后无论聊成什么样都能一键回到那一刻。
 *
 * 🔴 **连记忆一起存** —— 回滚要还原的是「那一刻的完整状态」。只把消息截回去、记忆不动的话，
 *    记忆里会留着被截掉那段「未来」，模型就会引用还没发生的事（现象是"它怎么知道这个"，
 *    很难反推回原因）。
 */
export type TavernCheckpoint = {
  id: string
  /** 用户起的名字（留空则界面显示「第 N 条」） */
  label: string
  /** 存点时的消息条数：回到这里 = 截到这里 */
  messageCount: number
  watermark?: TavernWatermark
  /** 存点时的本场记忆（见上：必须一起存） */
  memory?: string
  at: number
}

/** 回滚前的自动备份（**只留一层**）—— 让「回滚」可一键撤销，而不是不可逆 */
export type TavernRollbackUndo = {
  messages: TavernMessage[]
  watermark?: TavernWatermark
  memory?: string
  at: number
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
  /** 开场：轻表单 + 自由描述（两种模式共用同一套字段） */
  scene: TavernScene
  messages: TavernMessage[]
  model: TavernModelRef
  params: TavernParams
  /** 记忆总结水位线：已总结到哪一条消息 id */
  watermark?: TavernWatermark
  /** 是否继承上一次推演的记忆（见方案 5.4 / 6.9） */
  inheritMemoryFrom?: string
  /** 本场推演的六栏记忆（会话级） */
  memory?: string
  /** 场内的检查点（回到这里 = 消息截回去 + 记忆与水位线一并还原） */
  checkpoints?: TavernCheckpoint[]
  /** 回滚前的自动备份：存在就说明可以「撤销上次回滚」 */
  undoSnapshot?: TavernRollbackUndo
  /** 在场调度（A6）：健谈度与静音。语义见 CastDirection，两模式共用同一套 */
  muted?: string[]
  talkativity?: Record<string, number>
  createdAt: number
  updatedAt: number
}

/** 扮演设定：给 AI 演「像」用的，塞行为不塞设定（方案 6.4） */
export type CastSetting = {
  /** 口吻：Ta怎么说话 */
  voice: string
  /** 称呼你的方式 */
  address: string
  /** 知识边界：哪些事Ta不知道 */
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

/**
 * 角色卡的稳定短码（4 位，取自 id 尾部）。
 *
 * 用途**只有一个**：同场出现**同名**角色卡时，让提示词里有一套模型能对照的标记
 * （`【角色卡 · 洛汐 #A1B2】`）。数据层从来以 `id` 为准 —— 记忆、发言归属都不依赖名字，
 * 所以同名卡彼此不会串档；会串的只有「模型读到的两段设定/记忆都叫洛汐」这一件事。
 *
 * ⚠️ 不要拿它当业务主键，也不要指望它对用户有含义 —— 它只是给人读的消歧标记。
 */
export function charTag(id: string): string {
  const s = String(id ?? '').replace(/[^0-9a-z]/gi, '').toUpperCase()
  return s.slice(-4).padStart(4, '0')
}

/**
 * 开场设定（轻表单 + 自由描述）。
 * 剧情模式必填（并配一个叙事锚点）；自由模式可选 —— 它没有锚点，但同样值得给第一轮一个场景。
 */
export type TavernScene = {
  place: string
  time: string
  /** 在场人物名 */
  present: string[]
  /** 自由描述 */
  description: string
}

export type FreeSession = {
  id: string
  /** 参演角色（**含**用户扮演的那个，如果有）；发言轮转与设定层会自动把他摘出去 */
  charIds: string[]
  /**
   * 用户扮演的角色 id（可选）。不填 = 用户演他自己（旧行为）。
   *
   * 填了之后有两处变化：
   *   · AI 的身份层会写明「用户扮演：X」，于是它知道自己在**跟谁**对话，而不是跟一个默认角色；
   *   · X 由用户掌控 —— AI 不代写他的言行，也不再把他当自己的位子去轮转。
   */
  userCharId?: string
  title: string
  /**
   * 开场设定（可选）。自由模式**没有叙事锚点**，但同样值得给第一轮一个场景：
   * 新建对话时填的地点/时间/在场/描述会渲染成开场第一条消息（`buildOpeningMessage`），
   * 这里留一份原件，方便界面回看与二次编辑。旧数据没有这个字段 —— 可选，不做迁移。
   */
  scene?: TavernScene
  messages: TavernMessage[]
  model: TavernModelRef
  params: TavernParams
  watermark?: TavernWatermark
  /** 在场调度（A6）：健谈度与静音。语义见 CastDirection，两模式共用同一套 */
  muted?: string[]
  talkativity?: Record<string, number>
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
  /** 上次活跃时间：下次打开时按 (now - lastActiveAt) 推进Ta的「生活」 */
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

/**
 * 新角色卡的空白初值（UI 新建、AI 转换草稿、导入兜底都用这一份）。
 * 放在 types 而不是 store：与 EMPTY_CAST_SETTING 同理 —— 纯默认值属类型层，
 * 放在 store 会让「只想要默认值」的纯逻辑模块（如 import.ts）反向依赖存储层。
 */
export function emptyFreeCharacter(): Omit<FreeCharacter, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '',
    world: '',
    profile: { externals: '', core: '', speech: '', relations: '', cannot: '', knowledge: '' },
    conduct: { perspective: '', bottomLine: '', paceLock: '', rating: '' },
    examples: '',
  }
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
/**
 * 在场调度（2026-09-14，路线图第 4 批 A6）：**两种模式共用**的一套字段与语义。
 *
 * 健谈度与静音只影响**提示词怎么写**，不改变数据归属、也不删记忆 ——
 * 静音的角色依然在场：别人可以提到 Ta，六栏记忆里发生过的照旧算数，只是这一场不开口。
 */
export type CastDirection = {
  /** 在场但**不发言**的角色 id（临时开关，随时可取消） */
  muted?: string[]
  /** 0–100 健谈度，越大越常开口；缺省 = DEFAULT_TALKATIVITY（均衡） */
  talkativity?: Record<string, number>
}

/** 健谈度默认值：均衡。缺省即此值，不写进会话记录 */
export const DEFAULT_TALKATIVITY = 50

/**
 * 健谈度分档 —— 提示词与界面**共用同一份**。
 * 两处各写一份文案必然漂移，而「说明与实现不一致」比没有说明更坏（与 paramGuide 同一条纪律）。
 */
export const TALK_BANDS = [
  { min: 0, max: 19, name: '很安静', line: '基本不主动开口，只在被点名时才应声' },
  { min: 20, max: 39, name: '偏静', line: '偶尔插一句，多数时候在听' },
  { min: 40, max: 59, name: '均衡', line: '跟其他人差不多，轮到就说' },
  { min: 60, max: 79, name: '健谈', line: '明显更常开口，会主动起话头' },
  { min: 80, max: 100, name: '话很多', line: '几乎每回合都想接，会抢着说' },
] as const

/** 取健谈度所在档（越界与非法值一律按默认档处理） */
export function talkBandOf(v: number) {
  const n = Number.isFinite(v) ? v : DEFAULT_TALKATIVITY
  return TALK_BANDS.find(b => n >= b.min && n <= b.max) ?? TALK_BANDS[2]
}

/** 这个角色是否被静音（在场但不发言） */
export function isMuted(dir: CastDirection | null | undefined, id: string): boolean {
  return !!dir?.muted?.includes(id)
}

/** 取健谈度（缺省即默认值） */
export function talkativityOf(dir: CastDirection | null | undefined, id: string): number {
  const v = dir?.talkativity?.[id]
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_TALKATIVITY
}

/**
 * 挑出**偏离默认**的健谈度行 —— 全默认时返回空数组。
 * 调用方据此整段不注入：满场都是「均衡」时写进提示词只是白占上下文。
 */
export function talkativityRowsOf(
  list: { id: string; name: string }[],
  dir: CastDirection | null | undefined,
): { name: string; value: number }[] {
  return list
    .map(c => ({ name: c.name, value: talkativityOf(dir, c.id) }))
    .filter(r => r.value !== DEFAULT_TALKATIVITY)
}

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
 * 日常「这几天的生活」保留条数（按天一条，与记忆里「最近日记」的天数对齐）。
 * 📌 放在 types 而不是 daily.ts：settings.ts 要用它当默认值，而 daily.ts 反向依赖 engine.ts，
 *    settings 若从 daily 取常量就会形成 settings → daily → engine → settings 的循环。
 */
export const DAILY_LOG_KEEP = 5
/**
 * 记忆总结防重复（三层保险，数值照搬手册「记忆引擎」的实测默认值）：
 *   ① 时间节流 —— 两次自动总结至少间隔这么久（手册 auto_interval = 600 秒）
 *   ② 跨实例锁 —— 避免同时开两个窗口跑两遍
 *   ③ 锁 TTL 兜底 —— 上次跑到一半崩了的情况（手册 auto_lock_ttl = 1800 秒）
 */
export const SUMMARY_MIN_INTERVAL_MS = 600 * 1000
/** 总结锁的 TTL：超过这么久视为陈旧锁，可被接管 */
export const SUMMARY_LOCK_TTL_MS = 1800 * 1000
