// ============ 手册内容 · 工作面板与正文 ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs/part3.ts` 的写作面板与模型设置描述、
// `NovelEditor` 工具栏与 HelpPopover 速查、`JieWenJi.tsx` 的六个模式标签。
// 🔴 工具清单按界面上真实的按钮顺序与名称写；不确定的功能不列。
import type { HelpArticle } from '@/lib/help/types'

export const EDITOR_ARTICLES: HelpArticle[] = [
  {
    id: 'dashboard-overview',
    revision: 1,
    title: '写作面板：一屏看清今天该干什么',
    summary: '今日写作、章节进度、伏笔清点与快捷入口都在这页，不动笔也能用来复盘。',
    aliases: ['首页', '工作台', '今日写作', '进度'],
    keywords: ['写作面板', '统计', '字数', '进度', '伏笔', '快捷入口', '口径'],
    group: '工作面板与正文',
    tabIds: ['dashboard'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'what-it-shows',
        heading: '这页看什么',
        body: [
          '今日写作量、章节进度、伏笔清点与各类快捷入口集中在这里 —— 它是「打开软件先看一眼」的落点，不写正文也不影响任何数据。',
          '「字数口径」（只算汉字 / 汉字+标点）在这里切换，正文底部的实时字数会跟着一起变；已记录的今日码字量按固定口径累计，不会因为换口径被重算。',
        ],
      },
      {
        id: 'shortcuts',
        heading: '快捷入口',
        body: [
          '面板上的「继续写作」直接进正文的当前章；其他卡片分别跳到章节总表、伏笔追踪、写作进度等页面。',
          '新项目第一次进来时这里是空的，先按「使用指南」的推荐顺序填几张表，再回来看就有内容了。',
        ],
      },
    ],
    related: ['editor-tools', 'start-first-chapter'],
    actions: [{ label: '打开使用指南', tabId: 'guide' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'editor-tools',
    revision: 1,
    title: '正文编辑：工具栏每个按钮做什么',
    summary: '从排版、校对到时光机与小黑屋，一页说清正文页的全部工具与保存规则。',
    aliases: ['工具栏', '编辑工具', '排版', '敏感词', '时光机', '回收站', '小黑屋'],
    keywords: ['正文', '工具', '排版', '缩进', '敏感词', '校对', '版本', '回收站', '检索', '替换', '引用', '小黑屋'],
    group: '工作面板与正文',
    tabIds: ['editor'],
    featureIds: ['format', 'sensitive', 'proofread', 'history', 'trash', 'search', 'replace', 'lock'],
    availability: 'all',
    aiRequirement: 'none',
    prerequisites: ['本章已有正文'],
    sections: [
      {
        id: 'toolbar',
        heading: '工具栏按钮',
        body: [
          '· 撤销 / 恢复：与 Ctrl+Z / Ctrl+Y 同一个原生撤销栈，AI 插入、一键排版、缩进都能整体撤销。',
          '· 敏感词检测（本章）：命中可直接替换；· 排版与缩进：可设缩进单位，一键排版默认保留你已有的缩进。',
          '· 校对（本章）：本地错别字立即查；AI 校对分「查错别字与语病」「查逻辑与设定矛盾」两块，可分别跑。',
          '· 伏笔闭环看板、连续性校验、文风体检：审计类工具，仅完整项目可见。',
          '· 时光机：按时间点回滚本章历史版本；回收站：恢复误删的卷 / 章。',
          '· 全文检索（Ctrl/Cmd+K）：搜章节正文、角色、设定；全书搜索替换：一次改全文。',
          '· 本章资料、引用名高亮：把本章提到的角色与设定调出来看。',
        ],
      },
      {
        id: 'more',
        heading: '「工具」菜单里的其他项',
        body: [
          '排版与缩进、敏感词检测、校对（本章）也在「工具」菜单中；此外还有 AI 伴写开关（默认关闭）、本章细纲、全书搜索替换与小黑屋强制码字。',
          'AI 伴写开启后停笔会在光标处透出一句浅灰续写建议，Ctrl+Enter 才落进正文；继续打字 / Esc / 移动光标即忽略，正文不会被改。',
        ],
      },
      {
        id: 'saving-rules',
        heading: '保存与离页',
        body: [
          '正文自动保存；Ctrl+S 立即保存。切章、切页签、退出项目前都会先等草稿落盘，写失败就留在原页并提示，不会静默丢稿。',
          '导出在左侧「章节」栏右上角的导出图标里：本章 / 全本 TXT / Markdown / EPUB / DOCX / 平台粘贴版 / 按卷 / 按章节逐一导出。',
        ],
      },
    ],
    related: ['jiewenji-modes', 'faq-proofread-actions', 'faq-save-state'],
    actions: [{ label: '去正文编辑', tabId: 'editor' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'jiewenji-modes',
    revision: 1,
    title: '颉文姬：六个模式分别干什么',
    summary: '诊室、编辑、审读、简报、补登、整理 —— 各管一段，别指望一个按钮全包。',
    aliases: ['AI 编辑', '颉文姬', '诊室', '补登', '审读'],
    keywords: ['颉文姬', '诊室', '编辑', '审读', '简报', '补登', '整理', 'AI'],
    group: '工作面板与正文',
    tabIds: ['editor'],
    featureIds: ['clinic', 'edit', 'review', 'brief', 'ledger', 'post'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['已配置可用模型'],
    sections: [
      {
        id: 'modes',
        heading: '六个模式',
        body: [
          '· 诊室：AI 校对（文字层 / 逻辑层）与综合诊断。校对结果可定位原文、替换或复制。',
          '· 编辑：选中一段正文，让 AI 按指令改稿并生成建议，采纳后才写进正文。',
          '· 审读：章节编辑意见、OOC 人设检查、续写方向、爽点毒点、黄金三章。',
          '· 简报：开写前的本章写作简报，把设定与上一章结尾串成提示。',
          '· 补登：抽出本章新出现的设定实体，与已有设定比对后勾选登记。',
          '· 整理：把本章散落的信息整理成可入库的条目。',
        ],
      },
      {
        id: 'how-to-open',
        heading: '怎么打开',
        body: [
          '编辑器工具栏的魔杖图标（颉文姬）打开 / 收起右侧面板；屏保右下角的 Q 版精灵也能唤起。',
          '面板只影响显示，不影响正在运行的 AI 任务：收起面板不会取消任务，也不会重复发请求。',
        ],
      },
    ],
    related: ['editor-tools', 'faq-proofread-actions'],
    actions: [{ label: '去正文编辑', tabId: 'editor' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
