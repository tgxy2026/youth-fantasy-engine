// ============ 手册内容 · 酒馆模式 ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs` 里酒馆八页的 description（控制面板 / 背景设定 /
// 剧情推演 / 推演报告 / 自由对话 / 跑团互动 / 故事剧本 / 角色卡片）。
// 🔴 酒馆与「正文写作」是两套东西：额度、提示词、扮演协议各自独立，不能混着讲。
import type { HelpArticle } from '@/lib/help/types'

export const TAVERN_ARTICLES: HelpArticle[] = [
  {
    id: 'tavern-overview',
    revision: 1,
    title: '酒馆模式：控制面板与背景设定',
    summary: '一页管参数与提示词，一页管「模型知道多少背景」；两页都不动正文。',
    aliases: ['酒馆', '控制面板', '背景设定', '扮演协议'],
    keywords: ['酒馆', '控制面板', '背景设定', '提示词', '预设', '扮演协议', '数值', '注入'],
    group: '酒馆模式',
    tabIds: ['tavern-control', 'tavern-world'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['已配置可用模型'],
    sections: [
      {
        id: 'control',
        heading: '控制面板：全局参数',
        body: [
          '通用设置 / 我的档案 / 预设方案 / 输出后处理 / 扮演协议 / 剧情推演 / 自由对话 / 本场数值 —— 改完保存即生效。',
          '🔴 酒馆的额度与扮演协议**不在这里之外的「模型设置」里**：两边各管各的，互不冲突。找额度别去模型设置翻。',
        ],
      },
      {
        id: 'world',
        heading: '背景设定：按需注入',
        body: [
          '把项目资料（或你填的基础信息）提炼成一份精简背景，**命中关键词才注入** —— 不必每轮都喂一大堆。',
          '所以「模型好像不知道我的世界」时，先看这里的关键词有没有覆盖到你问的内容。',
        ],
      },
    ],
    related: ['tavern-session', 'tavern-free'],
    actions: [{ label: '打开控制面板', tabId: 'tavern-control' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tavern-session',
    revision: 1,
    title: '剧情推演、推演报告与跑团互动',
    summary: '推演是「试演一场看角色反应」，报告挑矛盾，跑团让 AI 当 KP 主持一局。',
    aliases: ['推演', '跑团', 'KP', '试演'],
    keywords: ['剧情推演', '推演报告', '跑团', 'KP', '检定', '线索', '存档', '回滚', '合理性'],
    group: '酒馆模式',
    tabIds: ['tavern-plot', 'tavern-report', 'tavern-run'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['已配置可用模型；推演前先选好叙事锚点与角色'],
    sections: [
      {
        id: 'plot',
        heading: '剧情推演',
        body: [
          '选叙事锚点、分配角色，试演一场戏，看角色反应是否合理 —— 它是「排练」不是「写正文」，产出不会自动进章节。',
        ],
      },
      {
        id: 'report',
        heading: '推演报告',
        body: [
          '推演产出的合理性报告：矛盾 / 漏洞 / 存疑三类，可定位到具体条目。看完自己判断要不要改设定。',
        ],
      },
      {
        id: 'run',
        heading: '跑团互动',
        body: [
          'AI 当 KP（守秘人）主持一局：你写行动，系统掷检定，KP 照结果演 —— 有线索板、同伴、秘密与结局，可存档回滚。',
          '它适合试「如果这样走会怎样」，不适合直接产出成稿；觉得好的走向自己写进大纲。',
        ],
      },
    ],
    related: ['tavern-overview'],
    actions: [{ label: '打开剧情推演', tabId: 'tavern-plot' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tavern-free',
    revision: 1,
    title: '自由对话与角色卡片',
    summary: '长期对话有记忆与日记；角色卡只写「角色与设定的关系」，世界观由故事提供。',
    aliases: ['自由对话', '角色卡', '记忆', '日记'],
    keywords: ['自由对话', '角色卡片', '记忆', '日记', '故事', '关系', '示例对话'],
    group: '酒馆模式',
    tabIds: ['tavern-free', 'tavern-card'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['角色卡必须归属一个故事（世界观由故事提供）'],
    sections: [
      {
        id: 'free',
        heading: '自由对话',
        body: [
          '与自建角色的长期对话：有记忆、有日记、有本场状态，也可以选一份剧本开一场戏。',
          '🔴 记忆只在点「结束本轮对话」时整理 —— 聊天过程不会被打断，但也意味着中途的记忆还没落盘。',
        ],
      },
      {
        id: 'card',
        heading: '角色卡片',
        body: [
          '每张卡归属一个故事，卡里只写「角色与设定的关系」；第 2、3 章按小项分条填，第 4 章的示例对话决定模型怎么说话。',
          '卡下方能看 AI 整理出的记忆与每场对话的日记 —— 觉得演得不像，先回来看示例对话是不是写得太笼统。',
        ],
      },
    ],
    related: ['tavern-script'],
    actions: [{ label: '打开自由对话', tabId: 'tavern-free' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tavern-script',
    revision: 1,
    title: '故事剧本：先建故事，再写剧本',
    summary: '故事与剧本是一对多父子结构；两者都能 AI 起草或跟着对话引导填。',
    aliases: ['剧本', '故事', '开场'],
    keywords: ['故事剧本', '故事', '剧本', '父子', '起草', '对话引导'],
    group: '酒馆模式',
    tabIds: ['tavern-script'],
    availability: 'all',
    aiRequirement: 'model',
    sections: [
      {
        id: 'structure',
        heading: '两层结构',
        body: [
          '先创建「故事」（这个世界的基本设定），再在其下写「剧本」（这一场发生什么事）。一个故事可以有多个剧本。',
          '两者都能让 AI 起草，也可以用对话引导一步步填 —— 引导过程不会自动写入，确认后才存。',
        ],
      },
    ],
    related: ['tavern-free'],
    actions: [{ label: '打开故事剧本', tabId: 'tavern-script' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
