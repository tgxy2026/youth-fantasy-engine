// ============ 内置使用手册 · 内容契约（3.3.1 · P1） ============
//
// 规划 §2.2：一份内置帮助内容注册表，提供三种呈现 —— 页签聚焦引导、手册文章、AI 检索片段。
// 本文件只定义**数据结构**，不写内容；内容是人工核对过的事实，按功能组落在 `articles/`。
//
// 🔴 三条纪律（决定这些字段为什么长这样）：
//   ① 文章身份用稳定英文 id，**不用中文标题** —— 标题会改，id 一改就等于新文章，
//      作者的「已看过/已跳过」记录与 AI 回答里的来源引用都会断。
//   ② `tabIds` / `actions` 只存稳定页签名，显示名在渲染时从 `schema.ts` 读 ——
//      题材模板会改页签显示名（见 schemaTemplates），帮助内容不能跟着各写一份。
//   ③ `verifiedAgainst` 与 `reviewedAt` 是**维护字段**：内容对不对是随软件版本变的，
//      没有这两个字段就无法判断某篇文章是不是还成立（规划 §4.3）。
//
// 适用范围（`availability`）只描述「这条操作在哪些运行形态下存在」，
// 不描述「作者的项目有没有启用这个功能」—— 后者由 `tabVisible()` 在渲染时判断。

/** 手册栏目 —— 与规划 §4.2 的目录一致；作者不必先懂产品术语就能找到入口 */
export type HelpGroup =
  | '快速开始'
  | '工作面板与正文'
  | '开书定位与大纲'
  | '角色与世界'
  | '创作与维护'
  | '灵感工具'
  | '酒馆模式'
  | '模型与 AI'
  | '数据与界面'
  | '常见问题与任务教程'

/** 运行形态：桌面版 / 便携版 / 网页版（云端与游客） */
export type HelpAvailability = 'all' | 'desktop' | 'web'

/** 这条操作要不要模型。`model` 只表示「需要已配置的模型」，不表示「一定能用」 */
export type HelpAiRequirement = 'none' | 'model'

/** 文章段落 —— 检索按段落返回，作者点结果直接落到这一段 */
export interface HelpSection {
  /** 段内稳定 id（同一文章内唯一），用于来源引用与锚点 */
  id: string
  heading: string
  /** 段落正文，一段一条；渲染时按段落分开，避免一坨长文本 */
  body: string[]
}

/** 文章里的「前往功能」动作：只允许跳页签，路径永远从注册表解析，不让内容写 URL */
export interface HelpAction {
  label: string
  /** 目标页签稳定 id（如 `char-main`、`editor`） */
  tabId: string
}

/** 一篇功能文章（规划 §4.3 的字段，按项目习惯收口） */
export interface HelpArticle {
  /** 稳定身份：英文小写连字符，**永不复用** */
  id: string
  /** 内容修订号：只在「操作步骤真有变化」时 +1，纯文案润色不动它 */
  revision: number
  title: string
  /** 一句话说清这页解决什么问题（列表与搜索结果里显示） */
  summary: string
  /** 作者常用的其他叫法，检索用（如「人物卡」「角色卡」都指向主要角色） */
  aliases: string[]
  /** 检索关键词（短词，不写句子） */
  keywords: string[]
  group: HelpGroup
  /** 关联页签；动态分卷页统一归到 `chapter-master` 等功能族，不逐个登记 */
  tabIds: string[]
  /** 页内子功能（编辑器工具、诊室各模式等）；没有子功能的页留空 */
  featureIds?: string[]
  availability: HelpAvailability
  aiRequirement: HelpAiRequirement
  /** 操作前提（需要先选章节、需要先有记录…）。不写「建议」，建议写进正文并标明是建议 */
  prerequisites?: string[]
  sections: HelpSection[]
  /** 相关文章 id */
  related?: string[]
  /** 「前往功能」按钮；失效时渲染成禁用并说明，不猜目标 */
  actions?: HelpAction[]
  /** 内容最近核对的软件版本 */
  verifiedAgainst: string
  /** 最近人工核对日期（YYYY-MM-DD） */
  reviewedAt: string
}

/** 检索索引项：按段落切分，保留来源与加权所需的元信息 */
export interface HelpIndexEntry {
  articleId: string
  articleTitle: string
  sectionId: string
  heading: string
  /** 段落正文拼接（检索与摘要共用） */
  text: string
  /** 标题 + 别名 + 关键词，一起参与加权 */
  titleText: string
  keywordText: string
  group: HelpGroup
  tabIds: string[]
  /**
   * 生成这条索引时的手册内容版本（`CONTENT_VERSION`）。
   * 🔴 用途是「回答可追溯到当时的目录/正文版本」：会话里的旧回答要能说明自己基于哪一版，
   *    而不是悄悄跟着新版本指向别的原文（规划 §4.4 末句）。
   */
  contentVersion: number
}

/** 一次检索命中的片段 */
export interface HelpHit {
  articleId: string
  articleTitle: string
  sectionId: string
  heading: string
  group: HelpGroup
  tabIds: string[]
  /** 命中分（仅用于排序，不对外承诺具体含义） */
  score: number
  /** 摘出的上下文（已按查询词居中截断） */
  excerpt: string
}
