// ============ 页签聚焦引导 · 内容模型与首批步骤（3.3.1 · P2） ============
//
// 规划 §3：首次进入某个页签时，用淡化背景 + 描边高亮 + 说明卡片讲「这里做什么、从哪开始、结果在哪」。
// 一个页签 3～5 步；简单页 1～2 步；不为凑步数重复说明。
//
// 🔴 身份与版本（规划 §3.3）：
//   · 记录用稳定 `id` + `revision`，**不用中文标题**、不用 DOM 序号 ——
//     标题改一个字不该让所有人重看一遍；真正**新增了操作**才 +1，纯文案润色不动。
//   · 内容与手册文章同源：`articleId` 指向 `lib/help/articles` 里那篇，
//     卡片上的「查看完整手册」就用它，不另写一份说明书。
//
// 🔴 锚点必须落在**真实可见元素**上（`data-guide="…"`），不按中文文字或第几个按钮找。
//   目标缺失时由聚焦层降级为「无高亮的居中说明」，不无限等待不存在的锚点（规划 §3.4）。
import { getHelpArticle } from '@/lib/help/registry'

/** 一个引导步骤 */
export interface GuideStep {
  id: string
  /** `data-guide` 锚点名；省略 = 居中说明（无高亮），用于空态或整页级说明 */
  anchor?: string
  title: string
  body: string
}

/** 一个页签的聚焦引导 */
export interface PageGuide {
  /** 稳定英文 id（永不复用） */
  id: string
  /** 引导修订号：新增操作时 +1，老用户可看到「了解新功能」入口（P3 再接） */
  revision: number
  /** 适用页签稳定 id */
  tabId: string
  /** 关联手册文章：卡片上的「查看完整手册」直达 */
  articleId?: string
  steps: GuideStep[]
}

/** 首批三个样板：普通表单页、正文编辑、表格空态（规划 P2 的交付条件要求各有样板） */
export const PAGE_GUIDES: PageGuide[] = [
  {
    id: 'positioning-basics',
    revision: 1,
    tabId: 'positioning',
    articleId: 'positioning-guide',
    steps: [
      {
        id: 'why',
        anchor: 'form-header',
        title: '这一页是开书前的商业档案',
        body: '赛道、平台、读者、卖点 —— 这几栏决定后面所有页面怎么填。想不清楚就先写个大概，动笔前回来改一轮。',
      },
      {
        id: 'fields',
        anchor: 'form-fields',
        title: '一栏一栏填，不用一次填满',
        body: '左边是字段名与说明，右边直接输入；没填的地方会给出示例，照着改成你自己的设定即可。顶部进度条只表示填了多少项，不是及格线。',
      },
      {
        id: 'save',
        anchor: 'form-save',
        title: '改完记得保存',
        body: '按 Ctrl+S（macOS 用 Cmd+S）或点这个按钮落库。右下角出现浮动按钮，就说明还有没保存的改动。',
      },
    ],
  },
  {
    id: 'editor-basics',
    revision: 1,
    tabId: 'editor',
    articleId: 'editor-tools',
    steps: [
      {
        id: 'chapters',
        anchor: 'chapter-tree',
        title: '左边是章节目录',
        body: '没有卷就先建卷，再在卷下建章。建好点进去就能写；← → 切换上一章 / 下一章，切章前会先保存当前草稿。',
      },
      {
        id: 'body',
        anchor: 'body-editor',
        title: '中间这块就是正文',
        body: '直接打字即可，默认自动保存，也可以随时 Ctrl+S 立即保存。底部会显示本章字数、今日码字量与保存状态。',
      },
      {
        id: 'tools',
        anchor: 'editor-toolbar',
        title: '工具都在这一行',
        body: '排版与缩进、敏感词检测、校对（本章）、时光机（版本历史）、回收站、全文检索都从这里进。不确定哪个是哪个，鼠标停上去有说明。',
      },
      {
        id: 'jiewenji',
        anchor: 'jiewenji-entry',
        title: '需要 AI 时找颉文姬',
        body: '这个按钮打开右侧的 AI 助手：校对、改稿、审读、简报、补登都在里面。没配模型时它照常显示，但 AI 按钮会禁用。',
      },
    ],
  },
  {
    id: 'table-empty-start',
    revision: 1,
    tabId: 'foreshadow',
    // 表格类页签还没有手册文章（P1 覆盖缺口）⇒ 不挂 articleId，卡片上就不出「查看完整手册」，
    // 而不是跳到一个不相关的页面去。
    steps: [
      {
        id: 'empty',
        anchor: 'table-empty',
        title: '这张表现在是空的',
        body: '空表不是出错，是还没登记。这类表都是「一行一条记录」，想到一条就加一条，不用按顺序。',
      },
      {
        id: 'new',
        anchor: 'table-new',
        title: '从这里加第一条',
        body: '点右上角「新增一行」，填好格子后保存。也可以在编辑器里从正文整理出条目（需要模型），但手动加永远可用。',
      },
    ],
  },
]

/** 页签 → 引导；没有的返回 null（不硬凑一个通用引导冒充已覆盖） */
export function getPageGuide(tabId: string): PageGuide | null {
  return PAGE_GUIDES.find(guide => guide.tabId === tabId) ?? null
}

/** 记录键：`id@revision` —— 修订号变了就等于一门新课，老用户会被重新邀请看一次 */
export function guideRecordKey(guide: PageGuide): string {
  return `${guide.id}@${guide.revision}`
}

/** 卡片上「查看完整手册」的文章；没有关联或文章已不存在时返回 null（按钮隐藏，不跳空） */
export function guideArticle(guide: PageGuide) {
  return guide.articleId ? getHelpArticle(guide.articleId) : null
}
