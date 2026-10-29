// ============ 手册内容 · 开书定位与大纲 ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs/part1.ts` 的作品信息与大纲四表定义、
// `getVolumeTabs()` 的动态分卷页、`GuidePage` 的推荐填写顺序说明。
// 🔴 顺序是「经过验证的流程」，但在正文里必须写成建议，不能写成软件强制前提。
import type { HelpArticle } from '@/lib/help/types'

export const PLAN_ARTICLES: HelpArticle[] = [
  {
    id: 'positioning-guide',
    revision: 1,
    title: '作品信息：动笔前先把商业定位想清楚',
    summary: '赛道、平台、读者、卖点 —— 五组字段，决定后面每一页怎么填。',
    aliases: ['作品定位', '定位', '赛道', '卖点'],
    keywords: ['作品信息', '定位', '赛道', '平台', '读者', '卖点', '简介', '题材'],
    group: '开书定位与大纲',
    tabIds: ['positioning'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'groups',
        heading: '五组字段',
        body: [
          '一、基本信息：书名、类型赛道、预计篇幅、更新节奏。',
          '二、平台与读者：目标平台、读者画像、对标作品。',
          '三、卖点与差异化：核心卖点、差异化亮点、开篇钩子。',
          '四、简介与物料：一句话简介、正式简介、书封创意。',
          '五、风险预案：切书线、备选方向。',
        ],
      },
      {
        id: 'ai-scope',
        heading: '哪些内容会发给 AI',
        body: [
          '这一页的字段会作为设定资料随请求发出，所以「类型赛道」填在这里最直接；而新建项目时选的「作品题材」默认不发给 AI，它只决定各页签字段名与说明怎么显示。',
          '正式简介这类长文本也是设定资料的一部分，写的时候当作会被 AI 读到来对待。',
        ],
      },
    ],
    related: ['outline-guide'],
    actions: [{ label: '打开作品信息', tabId: 'positioning' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'outline-guide',
    revision: 1,
    title: '大纲四件套：总纲、分卷、章节总表、细纲',
    summary: '从「这本书讲什么」一路细到「这一章发生什么」，四张表逐层收窄。',
    aliases: ['大纲', '总纲', '细纲', '分卷', '章节表'],
    keywords: ['大纲', '全书总纲', '分卷大纲', '章节总表', '章节细纲', '分卷', '章号', '规划'],
    group: '开书定位与大纲',
    tabIds: ['master', 'volume-outline', 'chapter-master', 'chapter-outline'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'four-tables',
        heading: '四张表各管一层',
        body: [
          '· 全书总纲：主线一句话、大结局、分卷规划 —— 定方向，改一次全书都跟着动。',
          '· 分卷大纲：每卷的目标、冲突升级、卷末高潮。',
          '· 章节总表：一章一行，标题、状态、一句话事件；正文摘要会自动回填这一列。',
          '· 章节细纲：卡片式，一章一张，写清这一章要发生什么；正文右侧「本章细纲」直达当前章。',
        ],
      },
      {
        id: 'volume-tabs',
        heading: '动态分卷页',
        body: [
          '每新建一个卷，侧栏会多出这个卷自己的台账页（章节清单）。它是按卷自动生成的，不需要手动创建；删卷时对应页也会消失。',
        ],
      },
      {
        id: 'suggested-order',
        heading: '建议的推进顺序',
        body: [
          '建议：定位 → 世界底层 → 主角与核心配角 → 历史事件（可倒推）→ 总纲 → 分卷 → 章节总表 → 细纲，然后开写。每卷开写前补一轮，写完一卷回看修订一轮。',
          '这只是经验顺序，不是软件前提：任何一张表都可以随时回来补。',
        ],
      },
    ],
    related: ['positioning-guide', 'editor-tools'],
    actions: [{ label: '打开全书总纲', tabId: 'master' }, { label: '打开章节细纲', tabId: 'chapter-outline' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
