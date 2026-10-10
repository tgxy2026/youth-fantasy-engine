/**
 * 跑团互动 · 数据契约（3.0 · W4-3）
 *
 * 【它是什么】长在酒馆模式上的一次**有始有终的互动** —— AI 当 KP（守秘人）主持，
 * 玩家行动，有检定、有线索、有同伴、有秘密与结局。三种互动各司其职：
 *   · 剧情推演（TavernSession）＝ 试演一场戏，看角色反应是否合理；
 *   · 自由对话（FreeSession）＝ 与自建角色的**长期陪伴**；
 *   · 跑团（RunSession）＝ 一次**可玩、可分叉、可复盘**的冒险。
 *
 * 【复用而非另起炉灶】§10.3 #11 的落地纪律是「基于既有酒馆模式扩展，**不照抄**对方独立产品线」：
 *   `messages` / `checkpoints` / `vars` 直接沿用酒馆那套类型（见下 import），
 *   本文件只定义跑团**专有**的语义：世界版本引用、同伴、线索、秘密、结局、行动流水。
 *
 * 【叶子约束】🔴 本文件只依赖 `tavern/types`（其自身零 import，是叶子），
 *   **不许** import 业务层 / db —— 否则 `runTypes → db → run/store → runTypes` 成环。
 *   （与 `worldTypes.ts` 同款约束，W4-1b 踩过。）
 */
import type {
  TavernMessage, TavernCheckpoint, TavernVars,
  TavernModelRef, TavernParams, TavernScene,
} from '../tavern/types'

// ==================== 世界版本引用（D4=A · 复用 W4-1 世界包）====================

/**
 * 引用某一份世界包的**某一封存版**（§10.3 #11 原文「引用冻结的世界版本」）。
 *
 * 🔴 只存 id + 版本号 ＋ 冗余名字，**不复制内容** —— 引用是「知道用了哪一版」，
 *    不是「把世界搬过来」。要改内容才走 W4-1c 的**显式引入**（那是派生，会留溯源）。
 */
export interface RunWorldRef {
  worldId: string
  /** 0 = 草稿；≥1 = 某个封存版本 */
  version: number
  /** 冗余存世界名：世界被删了也能看出「这一局引过谁」（列表展示用，不进上下文） */
  worldName?: string
}

// ==================== 同伴（§10.3 #11「同伴」）====================

/**
 * 同伴：随行的 NPC，各有立场与**知晓边界**。
 *
 * 🔴 「知晓边界」复用本项目独门「知情权限」思路：`knows` 里没写的事，AI 不许让他「知道」——
 *    这是防 OOC 的关键（同伴忽然说出他没参与的密谈，比说错话更出戏）。
 */
export interface RunCompanion {
  charId: string
  /** 冗余存名字：角色卡被删也不空白（与 TavernCast 同款用意） */
  name: string
  /** 立场 / 关系（一句话，如「欠你一条命但嘴硬」） */
  stance: string
  /** 知晓的事（少写 = 他知道得少，不是「什么都知道」） */
  knows: string[]
  /** 是否能在检定里帮忙（搭把手 / 提供线索） */
  canHelp: boolean
}

// ==================== 行动与检定（D2=A · 内置轻量检定）====================

/** 行动类型：观察 / 交谈 / 取证（§10.3 #11 原文三样）＋ 兜底 */
export type RunActionKind = '观察' | '交谈' | '取证' | '其他'

/** 检定结果档（四档，与 TRPG 习惯对齐） */
export type RunOutcome = '大成功' | '成功' | '擦边' | '失败'

/**
 * 一次行动 ＋ 检定 ＋ 结果 —— **「可记录的后果」**的载体。
 * 不同玩家 / 不同分支各有自己的 actions 流水，于是「独立经历」有据可查、可复盘。
 */
export interface RunAction {
  id: string
  at: number
  /** 玩家这一轮的输入（也可以是「观察四周」这类简短指令） */
  text: string
  kind: RunActionKind
  /** 难度（0–100）；缺省 = 这一动不必检定（纯叙事） */
  difficulty?: number
  /** 掷值（0–100） */
  roll?: number
  outcome?: RunOutcome
  /** AI 裁判给出的简短结论（这一动的后果，一句话） */
  consequence?: string
}

// ==================== 线索板（§10.3 #11「调查」）====================

export type RunClueSource = RunActionKind

/** 线索：获取即入板、可回看、可关联秘密 */
export interface RunClue {
  id: string
  text: string
  source: RunClueSource
  /** 是否已掌握（未掌握 = 已埋、待发现；界面上作「未解」呈现） */
  acquired: boolean
  /** 关联秘密 id：拿到这条线索 = 解开某个秘密的前置之一 */
  linksSecretId?: string
  at: number
}

// ==================== 秘密与结局（D3=A · 结构化表单 + 条件判定）====================

/**
 * 秘密：满足条件即**揭露**。
 * 🔴 结构化（而非纯叙事）的理由：只有条件可判，「不同玩家 / 不同分支拥有独立经历」才可复现。
 */
export interface RunSecret {
  id: string
  text: string
  unlocked: boolean
  /** 解锁条件：已获线索 id 交集（任一命中即解锁） / 剧情 flag */
  revealOn?: {
    clueIds?: string[]
    flags?: string[]
  }
}

/** 结局触发条件：三样都可空，空表示「不约束这一维度」 */
export interface RunEndingCondition {
  /** 需**全部**已揭露的秘密 id */
  secretIds?: string[]
  /** 需**全部**已获线索 id */
  clueIds?: string[]
  /** 需变量档位：键 → 最小值（如 `{ trust: 20 }`） */
  varMin?: Partial<Record<string, number>>
}

export interface RunEnding {
  id: string
  name: string
  condition: RunEndingCondition
  /** 是否已达成（由判定纯函数写回，见 endings.ts） */
  reached: boolean
}

// ==================== 检查点（存档）====================

/**
 * 跑团专用检查点：在酒馆那套（`TavernCheckpoint`：消息条数 / 水位线 / 记忆）之上，
 * **额外**存「行动流水条数 ＋ 线索 / 秘密 / 结局快照」。
 *
 * 🔴 为什么要多存这几个：跑团里「行动流水」与「已获线索 / 已揭秘密」也是进度的一部分 ——
 *    只截 messages 会让「回到那一刻」变成「话少了但线索还在」的**错位状态**。
 */
export interface RunCheckpoint extends TavernCheckpoint {
  /** 当时已有多少条行动流水（回滚按条数截回） */
  actionCount: number
  /** 当时的线索 / 秘密 / 结局快照（深拷贝，之后改动不动它） */
  clues: RunClue[]
  secrets: RunSecret[]
  endings: RunEnding[]
  /** 当时的剧情 flag 快照 */
  flags: string[]
}

// ==================== 跑团局（RunSession）====================

/**
 * 一局跑团。🔴 **随项目**（D1=A）—— 与「剧情推演」同类，跟着某本书走、导出项目一并带走。
 * （自由对话是全局 meta —— 那是「陪伴」，不绑书；跑团不是。）
 */
export interface RunSession {
  id: string
  /** 契约版本，用于将来迁移（照 worldPack.schema 的做法） */
  schema: 1
  title: string

  // —— 模组来源（可空 = 纯即兴）——
  storyId?: string
  scriptId?: string
  /** 引用哪一份世界包的哪一版（D4=A；可空 = 用当前项目） */
  worldRef?: RunWorldRef

  // —— 玩家与同伴 ——
  /** 玩家扮演的角色 id（复用角色卡；可空 = 玩家演自己） */
  playerCharId?: string
  companions: RunCompanion[]

  // —— 跑团四件 ——
  clues: RunClue[]
  secrets: RunSecret[]
  endings: RunEnding[]
  /** 行动流水（按时间顺序，可复盘） */
  actions: RunAction[]
  /**
   * 剧情 flag（如「已被通缉」「拿到铜钥匙」）—— 秘密 / 结局条件的一种判据。
   * 与线索互补：线索是**玩家找到的**，flag 是**剧情发生的**（可能玩家没「发现」也发生了）。
   */
  flags?: string[]

  // —— 复用酒馆的会话底盘 ——
  messages: TavernMessage[]
  checkpoints?: RunCheckpoint[]
  vars: TavernVars

  // —— 与既有引擎对接所需 ——
  scene?: TavernScene
  model: TavernModelRef
  params: TavernParams
  /** 记忆水位线 / 本场记忆（复用自由模式的整理机制） */
  watermark?: { messageId: string; at: number }
  memory?: string

  createdAt: number
  updatedAt: number
}

/** 索引项：列表展示用，**不含** messages / actions 等大字段（与 TavernSessionIndexItem 同款用意） */
export interface RunIndexItem {
  id: string
  title: string
  storyId?: string
  /** 世界引用摘要（如「雾港 v2」）；无引用则空 */
  worldBrief?: string
  /** 同伴摘要（「A、B」） */
  companionBrief: string
  /** 已获线索数 / 总线索数 */
  clueCount: number
  /** 已达成结局名（无则空） */
  reachedEnding?: string
  updatedAt: number
}
