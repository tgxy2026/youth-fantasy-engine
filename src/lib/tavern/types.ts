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

/**
 * 剧情推演的「设定层来源」（老大 2026-09-14 选 A 档）。
 *
 * 起因：项目资料每轮全量注入（示范项目实测 4662 字、丢 11 段），加上协议 3244 字，
 * 默认预算被吃满 → 留给对话历史的额度算出来是 0（21 条消息只剩开场一条）。
 * 而后端已经有「背景设定」（world.ts）—— 作者提炼过的精简稿（≤1800 字、可开关）。
 * 所以给出这一档开关，让作者自己决定「用原始资料还是用提炼稿」。
 *
 *   · 'both'   —— 项目原始资料 + 本场背景设定（**默认**，= 加开关之前的行为）
 *   · 'digest' —— 设定层只留骨架（作品概览 + 章节清单），世界交给背景设定
 *   · 'raw'    —— 只用项目原始资料，不注入背景设定
 */
export type PlotContextSource = 'both' | 'digest' | 'raw'

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

/**
 * 临时导演指令（B2，老大 2026-09-14 接受）。
 *
 * 与「本场补充要求」的区别：那个是设置层里的一条常驻规则（每轮都进 system，离生成点很远）；
 * 这个是**会按深度插进对话历史**的一次性指令（ST 的 depth prompt / author's note 思路）——
 * 「越靠近生成点影响越大」是实测结论，所以插历史比塞 system 管用。
 *
 * 内容按协议的 R4 元指令通道包装（`「…」`），模型照做后继续演，不当成角色说过的话。
 */
export type TavernDirectorNote = {
  /** 指令正文（不用自己加「」，注入时会包） */
  text: string
  /** 插在倒数第几条**之前**：1 = 紧贴生成点。默认 4（贴死末尾会盖过用户刚说的那句） */
  depth: number
  /** 还剩几轮生效：成功产出一次减 1，扣到 0 自动清除 */
  turnsLeft: number
}

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
  /** 临时导演指令（B2）：按深度插进历史，只影响接下来 N 轮 */
  directorNote?: TavernDirectorNote
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
  /**
   * **内置示范数据**的来源标记（值＝种子里那张卡原本的名字，如 `'洛汐'`）。
   *
   * 为什么需要它（2026-09-14 老大问「删掉示范项目重建会不会覆盖我改的东西」）：
   * 原先「播种 / 格式升级 / 恢复内置版本」全都**按名字**认卡 —— 作者一改名，
   * 系统就再也不认识它了：重建示范项目会**再播一张原名卡**（看着像改动被种回来），
   * 而且那张卡再也拿不到格式升级。改成按来源认，改名后依然认得。
   *
   * 🔴 **不进导出文件**（`toCardFile` 会剔除）：它只是本机的溯源标记。
   *    否则别人导入你的示范卡后，他那边也会把它当内置卡去改。
   */
  seededFrom?: string
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
/**
 * 角色设定里「可被 AI 建议修改」的字段（2026-09-14，设定更新功能）。
 *
 * **不含 name**：改名会牵动索引、记忆键与会话，而且没人希望 AI 给自己改名。
 * 这里只是白名单 + 读写工具；提示词与界面**共用同一份**（见 revise.ts 与 TavernRevisionDialog）。
 */
export type CardFieldPath =
  | 'world'
  | 'profile.externals' | 'profile.core' | 'profile.speech' | 'profile.relations' | 'profile.cannot' | 'profile.knowledge'
  | 'conduct.perspective' | 'conduct.bottomLine' | 'conduct.paceLock' | 'conduct.rating'
  | 'examples'

/**
 * 字段清单。`when` 会**原样进提示词** —— 告诉模型「什么情况下才该动这一栏」，
 * 比只给字段名有效得多（否则它会把所有栏都改一遍以显得勤快）。
 */
export const CARD_FIELDS: { path: CardFieldPath; label: string; when: string }[] = [
  { path: 'profile.relations', label: '2.4 关系', when: '关系**定称**变了：在一起 / 分手 / 决裂 / 结盟 / 反目（写定义，不写经过）' },
  { path: 'profile.knowledge', label: '2.6 知识边界', when: '知道了原本不知道的事（秘密被揭开、身份暴露）' },
  { path: 'profile.core', label: '2.2 内核', when: '心境或立场被事件真正改变，Ta 已不是原来那个人' },
  { path: 'profile.externals', label: '2.1 外在', when: '外貌、穿着、身体状况变了（受伤、换发型、换常穿的衣服）' },
  { path: 'profile.speech', label: '2.3 语言特征', when: '说话方式变了（改口、不再叫昵称、不再用某种口癖）' },
  { path: 'profile.cannot', label: '2.5 做不到的事', when: '原本做不到的事做到了，或反过来做不到了' },
  { path: 'world', label: '1 世界', when: '身份 / 职业 / 处境 / 常去的地点发生变动（升职、失业、搬走、断亲）' },
  { path: 'conduct.paceLock', label: '3 进度锁', when: '关系阶段已经推进（或倒退），原来的锁不再适用' },
  { path: 'conduct.bottomLine', label: '3 底线清单', when: '底线被事件改写（新长出来的雷区）' },
  { path: 'conduct.rating', label: '3 尺度', when: '这段关系的尺度需要调整（很少见）' },
  { path: 'conduct.perspective', label: '3 视角与人称', when: '人称或视角需要改（极少见，多数情况别动）' },
  { path: 'examples', label: '4 示例对话', when: '口吻已变，现有示例不再代表 Ta 现在怎么说话' },
]

const FIELD_LABEL = new Map(CARD_FIELDS.map(f => [f.path as string, f.label]))

/** 字段路径 → 给人看的中文名（认不出就原样返回，别抛） */
export function fieldLabel(path: string): string {
  return FIELD_LABEL.get(path) ?? path
}

/** 这个路径是不是可改字段（解析模型输出时的白名单闸门） */
export function isCardField(path: string): path is CardFieldPath {
  return FIELD_LABEL.has(path)
}

/** 读一个字段的当前值 */
export function readCardField(c: FreeCharacter, path: CardFieldPath): string {
  switch (path) {
    case 'world': return c.world ?? ''
    case 'examples': return c.examples ?? ''
    case 'profile.externals': return c.profile?.externals ?? ''
    case 'profile.core': return c.profile?.core ?? ''
    case 'profile.speech': return c.profile?.speech ?? ''
    case 'profile.relations': return c.profile?.relations ?? ''
    case 'profile.cannot': return c.profile?.cannot ?? ''
    case 'profile.knowledge': return c.profile?.knowledge ?? ''
    case 'conduct.perspective': return c.conduct?.perspective ?? ''
    case 'conduct.bottomLine': return c.conduct?.bottomLine ?? ''
    case 'conduct.paceLock': return c.conduct?.paceLock ?? ''
    case 'conduct.rating': return c.conduct?.rating ?? ''
  }
}

/**
 * 写一个字段（返回新对象，不改原卡）。**整段替换** ——
 * AI 给出的 `after` 就是完整的新文本，不做"追加/拼接"（那会随着次数增长而累积成垃圾）。
 */
export function writeCardField(c: FreeCharacter, path: CardFieldPath, value: string): FreeCharacter {
  switch (path) {
    case 'world': return { ...c, world: value }
    case 'examples': return { ...c, examples: value }
    case 'profile.externals': return { ...c, profile: { ...c.profile, externals: value } }
    case 'profile.core': return { ...c, profile: { ...c.profile, core: value } }
    case 'profile.speech': return { ...c, profile: { ...c.profile, speech: value } }
    case 'profile.relations': return { ...c, profile: { ...c.profile, relations: value } }
    case 'profile.cannot': return { ...c, profile: { ...c.profile, cannot: value } }
    case 'profile.knowledge': return { ...c, profile: { ...c.profile, knowledge: value } }
    case 'conduct.perspective': return { ...c, conduct: { ...c.conduct, perspective: value } }
    case 'conduct.bottomLine': return { ...c, conduct: { ...c.conduct, bottomLine: value } }
    case 'conduct.paceLock': return { ...c, conduct: { ...c.conduct, paceLock: value } }
    case 'conduct.rating': return { ...c, conduct: { ...c.conduct, rating: value } }
  }
}

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
  /** 临时导演指令（B2）：按深度插进历史，只影响接下来 N 轮 */
  directorNote?: TavernDirectorNote
  /**
   * 本场变量（C2 第二步）：好感 / 信任 / 剧情进度 / 心情 / 当前地点。
   * 由 AI 每隔 N 轮给一次增量，作者也可手改。**会话级**，见 TavernVars 的说明。
   */
  vars?: TavernVars
  /**
   * 这一场用的剧本（自由对话专用）。`scriptId` 只用于溯源与"再开一场同一剧本"，
   * 真正进上下文的是 `script` 这份**快照** —— 作者后来改了剧本，这一场不会跟着变。
   */
  scriptId?: string
  script?: ScriptSnapshot
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

// ==================== 变量（C2 第二步：变量 + AI 输出增量）====================

/** 内置变量键（白名单 —— 提示词、解析、界面三处共用这一份，别各写各的） */
export const VAR_KEYS = ['affection', 'trust', 'progress', 'mood', 'place'] as const
export type VarKey = (typeof VAR_KEYS)[number]

export type VarDef = {
  key: VarKey
  /** 中文名：提示词里用它、解析时也按它认（模型看到的就是这个名字） */
  label: string
  kind: 'num' | 'text'
  min: number
  max: number
  /** 文本变量的字数上限 */
  maxLen?: number
  init: number | string
}

/**
 * **只有这五个**（老大 2026-09-14 定：内置 + 可逐项关闭，不开放自定义）。
 *
 * 为什么不开自定义：变量要**进提示词**（不告诉模型有哪些数、什么范围，它就没法给有意义的增量），
 * 而自定义数值没有语义 —— 模型不知道「金钱 320」算多算少。开放自定义等于让作者去写协议，
 * 与「少参数、好默认值」的取向相反。作者真正要控制的是**开/关**与**初始值**。
 */
export const VAR_DEFS: VarDef[] = [
  { key: 'affection', label: '好感', kind: 'num', min: 0, max: 100, init: 50 },
  { key: 'trust', label: '信任', kind: 'num', min: 0, max: 100, init: 50 },
  { key: 'progress', label: '剧情进度', kind: 'num', min: 0, max: 100, init: 0 },
  { key: 'mood', label: '心情', kind: 'text', min: 0, max: 0, maxLen: 12, init: '' },
  { key: 'place', label: '当前地点', kind: 'text', min: 0, max: 0, maxLen: 12, init: '' },
]

export function varDefOf(key: string): VarDef | undefined {
  return VAR_DEFS.find(d => d.key === key)
}

export type VarValue = number | string
export type VarValues = Partial<Record<VarKey, VarValue>>

/** 解析出来的一个操作（还没应用、没夹取） */
export type VarOp =
  | { key: VarKey; label: string; kind: 'delta'; num: number }
  | { key: VarKey; label: string; kind: 'set'; num: number }
  | { key: VarKey; label: string; kind: 'text'; text: string }

/** 实际发生的一次变化（已夹取，界面据此显示差量） */
export type VarChange = {
  key: VarKey
  label: string
  from: VarValue
  to: VarValue
  /** 数值变量的差量（文本变量没有） */
  delta?: number
}

/**
 * 会话级变量块。**不是角色级** —— 换一场戏本来就该重新开始。
 * 🔴 它必须与消息、记忆水位线**一起**被检查点 / 回滚 / 重说带走：
 *    漏一处就会出现"回到那一刻了、数值还是未来的"（与当年"记忆没跟着回滚"同类，已吃过一次）。
 */
export type TavernVars = {
  values: VarValues
  /** 最后一次更新时的轮次（状态栏回看用） */
  turnSeq: number
  /** 变动历史（状态栏回看用，只留最近若干条）。旧数据的 source/turnSeq 可能没有 */
  log: { at: number; changes: VarChange[]; source?: VarSource; turnSeq?: number }[]
}

/** 这次变化是谁改的：模型给的增量 / 作者手改 */
export type VarSource = 'ai' | 'manual'

// ==================== 剧本（自由对话专用：把「对话内容」单独拿出来做成一份可复用的戏） ====================

/**
 * 一份「简单剧本」＝ 六栏（老大 2026-09-14 定，见 docs/剧本与变量-设计方案-讨论稿.md §2）。
 *
 * 解决的是「角色卡只给了人、没给戏」：卡里有身份与性格，却没有「此刻在哪、这一场想干嘛」。
 * 与 SillyTavern 的 `scenario` + `first_mes` 同构，另加「目标 / 边界」两栏 —— 一场戏得有意图，
 * 否则模型只会描述气氛、戏不往前走。
 *
 * 🔴 **归属：全局（meta，跨项目）** —— 与角色卡同性质，是「玩法模板」，不绑某一本书。
 * 🔴 会话里存**快照**而非只存 id：剧本可编辑，只存引用的话作者改一次，所有历史会话都会被悄悄改写。
 */
export type TavernScript = {
  id: string
  /** 1 · 名称（列表展示用，不进上下文） */
  name: string
  /** 2 · 情境：此刻在哪、为什么在这儿、刚发生了什么。**刻意只管此刻**，背景交给角色卡与背景设定 */
  situation: string
  /** 3 · 开场白：Ta 说的第一句。渲染成对话第一条消息，**不进 system** */
  opening: string
  /** 4 · 你的位置：你在这一场里是谁、与 Ta 的关系、你想做什么 */
  playerRole: string
  /** 5 · 这一场的目标：给方向，不锁死（变量「剧情进度」就是它的完成度） */
  goal: string
  /** 6 · 不要发生：这一场不该出现什么 */
  taboo: string
  /** 上次 AI 起草的时间（0 = 从没跑过） */
  draftedAt: number
  createdAt: number
  updatedAt: number
}

/** 剧本列表项（只放列表要显示的字段，别把全文读进内存） */
export type TavernScriptIndexItem = {
  id: string
  name: string
  /** 目标那一栏的首句 —— 列表里一眼看出这场戏要干嘛 */
  goalBrief: string
  updatedAt: number
}

/** 会话上的剧本**快照**：加载那一刻的样子，此后与我改不改那份剧本无关 */
export type ScriptSnapshot = {
  /** 来源剧本 id（可能已被删除 —— 只是溯源用，不影响这一场） */
  scriptId: string
  name: string
  situation: string
  opening: string
  playerRole: string
  goal: string
  taboo: string
  /** 快照时间 */
  at: number
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
  // contextBudget 2026-09-14 由 8000 提到 16000（老大选 C 档）：旧值下「协议 3244 + 项目资料 4662
  // + 重复预留 2600」已把 8000 吃满，历史额度算出来是 0。汉字大致一字≈一词元（不同分词器有出入），
  // 16000 字约 16k 词元 —— numCtx 32768 还留了约一半给回复，别再往上顶。
  plot: {
    temperature: 0.85, topP: 0.9, topK: 40,
    repeatPenalty: 1.05, presencePenalty: 0.4,
    numCtx: 32768, contextBudget: 16000,
  },
  free: {
    temperature: 0.9, topP: 0.9, topK: 40,
    repeatPenalty: 1.05, presencePenalty: 0.45,
    numCtx: 32768, contextBudget: 16000,
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
