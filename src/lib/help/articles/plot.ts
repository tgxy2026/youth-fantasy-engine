// ============ 手册内容 · 情节推演（plot-canvas） ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs` 里 plot-canvas 的 description / tips，
// 以及 `components/outline/PlotCanvas.tsx` 的实际行为（推演密度、按模板铺节点、自动落库）。
// 🔴 不写「导出图片」「多人协作」这类源码里没有的能力。
import type { HelpArticle } from '@/lib/help/types'

export const PLOT_ARTICLES: HelpArticle[] = [
  {
    id: 'page-plot-canvas',
    revision: 1,
    title: '情节推演：把一章的写作要点摆成一张图',
    summary: '多选章节 → 生成推演卡片（待办伏笔 / 钩子爽点 / 角色状态 / 下一章衔接）→ 拖动排布、连成推演链。',
    aliases: ['推演', '卡片推演', '推演链', '情节演示', '节拍铺节点'],
    keywords: ['情节推演', '推演', '卡片', '连线', '伏笔', '爽点', '角色状态', '节拍', '模板', '信息密度'],
    group: '创作与维护',
    tabIds: ['plot-canvas'],
    availability: 'all',
    aiRequirement: 'model',
    sections: [
      {
        id: 'what',
        heading: '它是什么',
        body: [
          '情节推演是「本章写作简报」的可视化版本：同样是让 AI 读章节内容，出一张结构化卡片 —— 待办伏笔 / 钩子与爽点 / 角色状态 / 下一章衔接，只是结果以卡片形式摆在画布上，可以拖着排、可以连成链。',
          '它和简报共用同一套 AI 管线，不是另做的一套判断，所以两处看到的要点是一致的。',
        ],
      },
      {
        id: 'generate',
        heading: '生成推演卡片',
        body: [
          '① 在左侧勾选要推演的章节（可多选）；',
          '② 点「生成推演」；需要先配置可用的 AI 模型，未配置时按钮不可用；',
          '③ 生成过程约 30～90 秒，卡片会接在已有卡片的右侧排布，不会压住旧推演。',
          '「推演信息密度」有两档：完整 = 章节全要素，准但慢、费 token；简略 = 只喂「章节压缩摘要」（约原文十分之一），快且省。',
          '如果某一章没填「章节压缩摘要」，简略档下会用完整要素推演，并给出提示 —— 不会静默跳过那一章。',
        ],
      },
      {
        id: 'arrange',
        heading: '拖动与连线',
        body: [
          '卡片可以自由拖动排布；切到连接模式后，点两张卡就连成一条推演链 —— 用它标出「这一章埋的伏笔，第几章回收」这类走向。',
          '画布上的改动会自动存进本书，切换页签或重开项目都还在，不需要另外保存。',
        ],
      },
      {
        id: 'template',
        heading: '不用 AI 也能先铺骨架',
        body: [
          '「按模板铺节点」是纯本地操作，不调用模型：选一个结构模板，把它的节拍直接铺成卡片。',
          '常见用法是先铺骨架 → 手动连出全书走向 → 再对照着排章节细纲。骨架卡和 AI 推演卡可以混排、可以互相连线。',
        ],
      },
    ],
    related: ['editor-tools', 'outline-guide'],
    actions: [{ label: '打开情节推演', tabId: 'plot-canvas' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
