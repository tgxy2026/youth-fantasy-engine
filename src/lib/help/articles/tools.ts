// ============ 手册内容 · 灵感工具 ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs/part3.ts` 里灵感启发 / 一键拆书 / 创意写作 /
// 检查工具 / 素材资料的 description，以及创意写作「两阶段流水线」的起点判定与续排规则。
// 🔴 创意写作最容易被误解成「一键成书」—— 这里必须写清它是分批、可中止、断点续跑。
import type { HelpArticle } from '@/lib/help/types'

export const TOOLS_ARTICLES: HelpArticle[] = [
  {
    id: 'tools-inspire',
    revision: 1,
    title: '灵感启发：取名与脑暴',
    summary: '随机取名不用模型；AI 辅助规划是对话式脑暴，结论要自己落地到设定表。',
    aliases: ['取名', '起名', '脑暴', '随机名字'],
    keywords: ['灵感启发', '取名', '名字', '门派', '功法', '地名', '脑暴', '对话'],
    group: '灵感工具',
    tabIds: ['inspire-tools'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'generator',
        heading: '随机取名：不需要模型',
        body: [
          '人名 / 门派 / 功法 / 地名等类别的随机生成器，点一下出一批，挑中意的复制走即可。它不写入任何项目数据。',
        ],
      },
      {
        id: 'ai',
        heading: 'AI 辅助规划：对话式脑暴',
        body: [
          '多轮对话讨论剧情 / 人物 / 世界观 / 一致性自查（需模型）。它给的是**建议**，不会自动写进设定表 —— 觉得有用就自己回表登记。',
          '这里的对话与创作无关的软件答疑是两件事：问「这个功能怎么用」请到「使用指南」里的手册检索。',
        ],
      },
    ],
    related: ['start-without-ai'],
    actions: [{ label: '打开灵感启发', tabId: 'inspire-tools' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tools-bookbreak',
    revision: 1,
    title: '一键拆书：把别人的书拆成设定草稿',
    summary: '粘原文 → 逐章抽人物/势力/地点/术语 → 勾选后写入自己的项目表，不会直接覆盖。',
    aliases: ['拆书', '拆解', '扒设定'],
    keywords: ['拆书', '一键拆书', '抽取', '人物', '势力', '地点', '术语', '草稿', '导入'],
    group: '灵感工具',
    tabIds: ['bookbreak'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['已配置可用模型（原文会发给你当前选定的模型）'],
    sections: [
      {
        id: 'flow',
        heading: '三步走',
        body: [
          '粘贴或导入整本小说原文 → AI 逐章抽出人物 / 势力 / 地点 / 种族 / 物品 / 术语 → 整理成草稿，你勾选后再写入项目设定表。',
          '🔴 写入是「你勾选之后」才发生的；草稿不勾选就等于没发生，不会悄悄改你的库。',
        ],
      },
      {
        id: 'privacy',
        heading: '原文去哪了',
        body: [
          '原文只发给你当前选定的模型：本地模型不出本机，云端服务商会收到。拆别人的书之前先想清楚这一点。',
        ],
      },
    ],
    related: ['tools-creative-writing'],
    actions: [{ label: '打开一键拆书', tabId: 'bookbreak' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tools-creative-writing',
    revision: 1,
    title: '创意写作：先排大纲，再生成正文',
    summary: '两阶段流水线，分批跑、可随时中止、断点续跑；起点由 AI 按项目现状判定。',
    aliases: ['批量写作', '一键成书', '流水线', '自动写'],
    keywords: ['创意写作', '大纲规划', '生成正文', '分批', '续跑', '中止', '断点', '补登'],
    group: '灵感工具',
    tabIds: ['creative-writing'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['已配置可用模型；建议先填好世界设定与全书总纲'],
    sections: [
      {
        id: 'two-stage',
        heading: '两个阶段分开跑',
        body: [
          '· 只做大纲规划：按「本批几卷 × 每卷几章」分批把分卷大纲与章节细纲排完。库里还没有时先做设定奠基、从第 1 卷第 1 章起排；已有则接着往下排。',
          '· 只生成正文：按大纲逐章写，从正文最后一章 + 1 接着写。开写新章前若最后一章明显欠字，会先把它补到目标字数（只补最后一章，历史章不动）。',
          '短篇可以选「大纲 + 正文」一次跑完。起点由 AI 按项目现状自动判定，不需要你手选。',
        ],
      },
      {
        id: 'resume',
        heading: '没排满的卷会优先补齐',
        body: [
          '例：规划每卷 10 章，只排到第 21 章 → 下一批先补第 22-30 章，不另开新卷；该卷卷大纲若还只有骨架会一并补上。',
          '每章写完都会抽取本章设定并按所选策略补登（默认「只新增，不动已登记」），另做字数校准。长任务跑起来可以切页签，不会中断。',
          '🔴 它不是「一次点完就等成书」：分批跑、可随时中止、断点续跑，成果要自己读一遍。',
        ],
      },
    ],
    related: ['tools-bookbreak', 'outline-guide'],
    actions: [{ label: '打开创意写作', tabId: 'creative-writing' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tools-check',
    revision: 1,
    title: '检查工具：敏感词、一致性与数据体检',
    summary: '三件事合成一页：发布前的敏感词、AI 深度自查、以及项目数据本身的体检。',
    aliases: ['检查', '敏感词', '一致性检查', '数据体检'],
    keywords: ['检查工具', '敏感词', '一致性', '自查', '数据体检', '冲突'],
    group: '灵感工具',
    tabIds: ['check-tools'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'modules',
        heading: '三块内容',
        body: [
          '· 敏感词检测：逐章查命中词，命中列表可跳转到章节处理（发布前跑一遍）。',
          '· AI 一致性深度自查：跨章节检查设定冲突、时间线问题（需模型）。',
          '· 数据体检：查项目数据本身的问题（孤立记录、引用失效等），不需要模型。',
        ],
      },
      {
        id: 'reading',
        heading: '结论怎么读',
        body: [
          '检查结果是「提示」，不是判决：AI 自查会有误报，数据体检报的多是结构问题。逐条判断后再改，不要一键全改。',
        ],
      },
    ],
    related: ['editor-tools', 'tracking-changelog'],
    actions: [{ label: '打开检查工具', tabId: 'check-tools' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'tools-material',
    revision: 1,
    title: '素材资料：只读的写作参考库',
    summary: '内置的参考素材（人物设计等），供阅读借鉴，不支持编辑。',
    aliases: ['素材库', '参考素材', '人物设计'],
    keywords: ['素材', '素材资料', '参考', '只读', '人物设计'],
    group: '灵感工具',
    tabIds: ['material-library'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'how',
        heading: '怎么用',
        body: [
          '内置只读素材库：翻到有用的段落自己复制走，再改写成自己的东西。它不能编辑、也不会写入项目数据。',
          '要存自己攒的素材，用「创作管理 → 灵感素材」（那是你的表，可编辑、可被 AI 读到）。',
        ],
      },
    ],
    related: ['tracking-ideas'],
    actions: [{ label: '打开素材资料', tabId: 'material-library' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
