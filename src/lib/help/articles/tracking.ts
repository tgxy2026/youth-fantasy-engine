// ============ 手册内容 · 创作与维护（连载台账） ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs/part2.ts` / `part3.ts` 里伏笔、时间脉络、爽点、
// 写作进度、支线、知情权限、设定变更、写作规范、灵感素材、读者反馈的 description。
// 🔴 这些表都是「一行一条」，条目会自动进 AI 设定资料 —— 写错一条就会污染后续所有生成。
import type { HelpArticle } from '@/lib/help/types'

export const TRACKING_ARTICLES: HelpArticle[] = [
  {
    id: 'tracking-foreshadow',
    revision: 1,
    title: '伏笔与知情权限：防「吃书」的两本账',
    summary: '埋一条登记一条、知道一个人登记一个；这两本账不记，几十万字后必翻车。',
    aliases: ['伏笔', '填坑', '知情', '谁知道'],
    keywords: ['伏笔', '回收', '前置条件', '重要度', '知情', '秘密', '泄密', '吃书'],
    group: '创作与维护',
    tabIds: ['foreshadow', 'secrets'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'foreshadow',
        heading: '伏笔追踪',
        body: [
          '埋一条登记一条：记录含「重要度」与「回收前置条件」—— 前置没铺就强行回收，效果会打折。',
          '全书级伏笔每卷末点检一次，防止烂尾。编辑器工具栏的「伏笔闭环看板」是同一份数据的总账视图（埋设中 / 进行中 / 已回收 / 孤儿）。',
        ],
      },
      {
        id: 'secrets',
        heading: '知情权限',
        body: [
          '谁知道主角的秘密、谁知道哪个真相，一条一条登记。「读者对谁知道了什么，记得比你牢」—— 这是泄密穿帮的重灾区。',
          '每当有角色知悉新的秘密，当天补一条，不要攒着。',
        ],
      },
    ],
    related: ['tracking-timeline'],
    actions: [{ label: '打开伏笔追踪', tabId: 'foreshadow' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tracking-timeline',
    revision: 1,
    title: '时间脉络与历史事件：两条时间线',
    summary: '一条是「正文实际流逝的时间」，一条是「世界过去发生了什么」，别混着写。',
    aliases: ['时间线', '编年史', '大事记', '倒推'],
    keywords: ['时间脉络', '历史事件', '编年史', '倒推', '时间线', '双版本', '上级'],
    group: '创作与维护',
    tabIds: ['timeline', 'history'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'timeline',
        heading: '时间脉络：正文时间',
        body: [
          '每章一行，记录正文里实际流逝的时间，防时间线崩坏。写完一章立刻登记，发现冲突立刻改。',
          '连续性校验（编辑器「工具」里）会读它来查时间倒流这类问题。',
        ],
      },
      {
        id: 'history',
        heading: '历史事件：世界过去',
        body: [
          '编年史台账，建议用倒推法填：从大结局倒推到开篇。含「民间流传版本 vs 真相」双版本 —— 传说与事实的落差本身就是剧情的燃料。',
          '支持「上级」隶属：填本表其它事件的名称即可形成上下级树，可折叠、可新增子条目。',
        ],
      },
    ],
    related: ['tracking-foreshadow'],
    actions: [{ label: '打开时间脉络', tabId: 'timeline' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tracking-pacing',
    revision: 1,
    title: '爽点、进度与支线：连载的节奏感',
    summary: '爽点排期、每日字数、多线进度 —— 三张表回答「这一段读者会不会觉得闷」。',
    aliases: ['爽点', '节奏', '码字统计', '支线'],
    keywords: ['爽点', '钩子', '节奏', '间隔', '写作进度', '字数', '支线', '汇合', '断线'],
    group: '创作与维护',
    tabIds: ['hookpoints', 'progress', 'subplots'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'hookpoints',
        heading: '爽点节奏',
        body: [
          '每章的爽点 / 钩子 / 间隔记录在这一页。建议写章节细纲时就排好，间隔超过 3 章就该插一个爽点。',
          '这是「排期表」，不是评分表：它帮你在写之前看见「这一段太平了」。',
        ],
      },
      {
        id: 'progress',
        heading: '写作进度',
        body: [
          '每日字数流水账：无论写了多少都记，底部自动统计产量。写作面板的码字日历与今日字数用的是同一份数据。',
        ],
      },
      {
        id: 'subplots',
        heading: '支线剧情',
        body: [
          '感情线 / 身世线 / 暗线等多线并行：记起点、关键节点、与主线汇合点。哪条线断了，进度一眼看出来。',
        ],
      },
    ],
    related: ['dashboard-overview'],
    actions: [{ label: '打开爽点节奏', tabId: 'hookpoints' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tracking-changelog',
    revision: 1,
    title: '设定变更与写作规范：改之前先立法',
    summary: '改设定先登记影响范围与补丁方案；文风靠一份「宪法」压住百万字漂移。',
    aliases: ['设定变更', '吃书', '补丁', '写作规范', '文风'],
    keywords: ['设定变更', '补丁', '冲突', '影响范围', '写作规范', '人称', '视角', '坏习惯', '文风'],
    group: '创作与维护',
    tabIds: ['changelog', 'style'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'changelog',
        heading: '设定变更：连载的闸门',
        body: [
          '改设定先登记：旧值、新值、影响范围、已发布章节里是否冲突、补丁方案。',
          '🔴 红色冲突未处理前不要发布后续章节。这一页是「已经发布的内容和你现在的设定打架」的登记处，也是唯一能提前发现这类问题的地方。',
        ],
      },
      {
        id: 'style',
        heading: '写作规范：文风宪法',
        body: [
          '人称视角、句式偏好、标点格式、个人坏习惯清单写在这一页。百万字连载文风漂移是大概率事件，先立法后写作。',
          '文风体检（编辑器「工具」里）读的就是这里的坏习惯词与视角规则。',
        ],
      },
    ],
    related: ['tracking-foreshadow', 'editor-tools'],
    actions: [{ label: '打开设定变更', tabId: 'changelog' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tracking-ideas',
    revision: 1,
    title: '灵感素材与读者反馈：一进一出',
    summary: '灵感当天入库，差评当最便宜的编辑意见；两本账都在「运营维护」。',
    aliases: ['灵感素材', '点子', '读者反馈', '差评', '数据'],
    keywords: ['灵感', '素材', '点子', '桥段', '金句', '读者反馈', '追读', '留存', '均订', '差评'],
    group: '创作与维护',
    tabIds: ['ideas', 'feedback'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'ideas',
        heading: '灵感素材',
        body: [
          '平时攒点子 / 桥段 / 金句 / 场景描写，写细纲卡壳时先翻这里再硬编。灵感出现的当天就登记，过了当晚会忘。',
        ],
      },
      {
        id: 'feedback',
        heading: '读者反馈',
        body: [
          '追读 / 留存 / 均订数据与章评吐槽的复盘台账。差评是最便宜的编辑意见 —— 记下来再判断，别只在情绪里看一遍。',
          '这一页有 AI 分析入口（需模型）：读你登记的数据做流失归因与建议，但结论要自己判断。',
        ],
      },
    ],
    related: ['tracking-pacing'],
    actions: [{ label: '打开灵感素材', tabId: 'ideas' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
