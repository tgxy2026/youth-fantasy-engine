// ============ 页签聚焦引导 · 内容与模板（3.3.1 · P2/P3） ============
//
// 规划 §3：首次进入某个页签时，用淡化背景 + 描边高亮 + 说明卡片讲「这里做什么、从哪开始、结果在哪」。
// 一个页签 3～5 步；简单页 1～2 步；不为凑步数重复说明。
//
// 🔴 两层结构（规划 §3.5）：
//   · **页签认识**（本文件）：这一页是干什么的、主要分成哪几块。共享组件（表单 / 表格 / 主从卡片）
//     用模板生成，专用页手写；
//   · **页内操作帮助**（`lib/help/articles`）：具体子功能怎么用。模板不冒充子功能教程。
//
// 🔴 身份与版本（规划 §3.3）：
//   · 记录用稳定 `id` + `revision`，不用中文标题；真正新增操作才 +1。
//   · 手写内容与模板共用同一批 `data-guide` 锚点，锚点缺失时聚焦层降级为居中说明。
import { getTab } from '@/lib/schema'
import { isParallelSetTab, isWorldSetTab } from '@/lib/world/worldSets'
import { getHelpArticle } from '@/lib/help/registry'
import type { TabDef } from '@/lib/types'

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
  /** 引导修订号：新增操作时 +1，老用户可看到「了解新功能」入口（尚未实现） */
  revision: number
  /** 适用页签稳定 id */
  tabId: string
  /** 关联手册文章：卡片上的「查看完整手册」直达 */
  articleId?: string
  steps: GuideStep[]
}

/** 手写引导（有独有入口、或需要更具体说明的页签） */
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
    id: 'dashboard-basics',
    revision: 1,
    tabId: 'dashboard',
    articleId: 'dashboard-overview',
    steps: [
      {
        id: 'summary',
        anchor: 'dashboard-summary',
        title: '先看今天写了多少',
        body: '这一块是当前进度：今日码字、章节状态与接下来能做的事。它只读，不会改动任何数据。',
      },
      {
        id: 'stats',
        anchor: 'dashboard-stats',
        title: '统计与日历',
        body: '往下是码字统计（按天累计、固定「只算汉字」口径）。想换字数口径去设置里切，历史增量不会被重算。',
      },
    ],
  },
  {
    id: 'guide-basics',
    revision: 1,
    tabId: 'guide',
    articleId: 'start-first-chapter',
    steps: [
      {
        id: 'manual',
        anchor: 'guide-manual',
        title: '先搜一句试试',
        body: '这里是内置使用手册：输入「字太小」「怎么保存」这类问题，会直接给出手册里的相关段落。不需要配置模型，也不联网。',
      },
      {
        id: 'settings',
        anchor: 'guide-settings',
        title: '引导的开关在下面',
        body: '不想每次进入页签都弹分步介绍，在这里关掉；关掉之后还能从页头的「本页指引」随时重看，也能一键重置记录。',
      },
    ],
  },
  {
    id: 'model-settings-basics',
    revision: 1,
    tabId: 'model-settings',
    articleId: 'start-without-ai',
    steps: [
      {
        id: 'models',
        anchor: 'settings-models',
        title: '先配一个模型',
        body: 'AI 增强功能都要先有可用模型：本地 Ollama 或任一 OpenAI 兼容服务。没配也能写作，只是 AI 按钮会禁用。',
      },
      {
        id: 'rest',
        anchor: 'settings-header',
        title: '其余几块按需调',
        body: '消耗统计、网络代理、写作额度、联网检索、提示词都在这一页往下排。默认值可用，先不用逐项研究。',
      },
    ],
  },
  {
    id: 'table-empty-start',
    revision: 1,
    tabId: 'foreshadow',
    // 表格页签的通用模板会接管其余表；这一条单独手写，因为「空态」是最容易让人以为出错的状态。
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

/**
 * 共享组件型页签的模板步骤。
 *
 * 🔴 只写「一定为真」的话：用途取 `TabDef.description`（题材模板会改它，这里读的就是改后的那份），
 *    操作方式按类型固定（表单＝填+保存 / 表格＝一行一条 / 主从＝左选右填）。
 *    不编造这个页签独有的按钮 —— 那属于逐页核对（P3 后续）与手册文章的活儿。
 */
function templateSteps(tab: TabDef): GuideStep[] | null {
  const purpose = tab.description?.trim() || `这一页用来登记「${tab.name}」相关内容。`
  if (tab.type === 'form') {
    // 母子结构（世界设定 / 力量体系）与并列结构（政治 / 经济 / 信仰 / 司法）走主从目录
    if (isWorldSetTab(tab.id) || isParallelSetTab(tab.id)) {
      return [
        { id: 'overview', anchor: 'master-detail', title: `这一页是《${tab.name}》`, body: purpose },
        {
          id: 'list',
          anchor: 'master-list',
          title: '左边挑一条',
          body: '左边是条目目录：可以搜索、切换。这里存的是「一条条独立记录」，不是一份长文档。',
        },
        {
          id: 'fill',
          title: '右边填这一条',
          body: '选中后右边是该条目的字段，逐项填；改完按 Ctrl+S 或页面上的保存按钮落库。切换条目前会先保存当前这条。',
        },
      ]
    }
    return [
      { id: 'purpose', anchor: 'form-header', title: `这一页是《${tab.name}》`, body: purpose },
      {
        id: 'fields',
        anchor: 'form-fields',
        title: '一栏一栏填',
        body: '左边字段名与说明、右边直接输入；没填的地方会给示例。不必一次填满，随写随补。',
      },
      {
        id: 'save',
        anchor: 'form-save',
        title: '改完保存',
        body: '按 Ctrl+S（macOS 用 Cmd+S）或点保存按钮。右下角出现浮动保存按钮，就说明还有没保存的改动。',
      },
    ]
  }
  if (tab.type === 'table') {
    return [
      { id: 'purpose', anchor: 'table-body', title: `这一页是《${tab.name}》`, body: purpose },
      {
        id: 'rows',
        anchor: 'table-new',
        title: '一行一条记录',
        body: '点这里新增一行；表格里直接点单元格就能改，改完保存。空表说明还没登记，不是出错。',
      },
      {
        id: 'save',
        title: '保存与筛选',
        body: '有未保存的改动时，底部会出现「保存 N 行修改」。列头可以筛选与排序；表头能冻结，横向滚动看后面的列。',
      },
    ]
  }
  if (tab.type === 'card') {
    return [
      { id: 'purpose', anchor: 'master-detail', title: `这一页是《${tab.name}》`, body: purpose },
      {
        id: 'list',
        anchor: 'master-list',
        title: '左边是目录',
        body: '一张卡一个对象，可以在目录里搜索、切换；↑ / ↓ 也能直接换下一条。',
      },
      {
        id: 'detail',
        title: '右边是这一条的详情',
        body: '逐项填完后保存。有未保存的改动时切走会先等落库；写失败会留在原页并提示。',
      },
    ]
  }
  return null
}

/** 专用页（不在共享组件里）的兜底：一条居中说明，只讲「这页做什么」，不编按钮 */
function fallbackSteps(tab: TabDef): GuideStep[] {
  const purpose = tab.description?.trim() || `这一页用来处理「${tab.name}」相关内容。`
  return [{
    id: 'purpose',
    title: `这一页是《${tab.name}》`,
    body: `${purpose}\n\n这一页的操作入口较多，鼠标停在按钮上会显示说明；需要更细的步骤可以到「使用指南」里搜这个功能名。`,
  }]
}

/**
 * 取某个页签的引导：先用手写，再用类型模板，最后兜底一条说明。
 * 动态分卷页（`chapter-vol-*`）由 `getTab` 解析成 table 型，自动落到表格模板。
 */
export function getPageGuide(tabId: string): PageGuide | null {
  const manual = PAGE_GUIDES.find(guide => guide.tabId === tabId)
  if (manual) return manual
  const tab = getTab(tabId)
  if (!tab) return null
  const steps = templateSteps(tab)
  if (steps) return { id: `auto-${tab.id}`, revision: 1, tabId: tab.id, steps }
  return { id: `page-${tab.id}`, revision: 1, tabId: tab.id, steps: fallbackSteps(tab) }
}

/**
 * 由**页面组件自己**托管引导的页签（它们知道数据何时真正就绪）。
 *
 * 🔴 为什么要有这个名单：其余页签的引导统一在 `App` 层托管（一次覆盖几十页，不必逐页改组件）；
 *    名单里的页如果 App 层再托管一次，就会出现两层卡片同时弹。两处托管必须互斥。
 */
export const SELF_MANAGED_GUIDE_TABS: ReadonlySet<string> = new Set(['positioning', 'editor', 'foreshadow'])

/** 该页签的引导是否由 App 层统一托管（侧栏「本页指引」按钮据此决定是否显示） */
export function guideHostedAtAppLevel(tabId: string): boolean {
  return !SELF_MANAGED_GUIDE_TABS.has(tabId)
}

/** 记录键：`id@revision` —— 修订号变了就等于一门新课，老用户会被重新邀请看一次 */
export function guideRecordKey(guide: PageGuide): string {
  return `${guide.id}@${guide.revision}`
}

/** 卡片上「查看完整手册」的文章；没有关联或文章已不存在时返回 null（按钮隐藏，不跳空） */
export function guideArticle(guide: PageGuide) {
  return guide.articleId ? getHelpArticle(guide.articleId) : null
}
