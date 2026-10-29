// ============ 手册内容 · 常见问题 ============
//
// 事实来源（2026-10-29 人工核对）：`AI_DISABLED_HINT`、`NovelEditor` 底部状态栏、
// `Sidebar` 的「界面缩放」说明、`CopyProofText` 与 3.3.1 新增的校对「定位原文」实现。
// 🔴 只写当前已交付的行为；未交付的（如多义引文的候选位置选择）不写进事实段。
import type { HelpArticle } from '@/lib/help/types'

export const FAQ_ARTICLES: HelpArticle[] = [
  {
    id: 'faq-model-gray',
    revision: 1,
    title: '为什么 AI 按钮是灰的',
    summary: '按钮禁用通常只有一个原因：这个项目还没有可用模型。',
    aliases: ['按钮点不动', '灰色按钮', 'AI 不可用'],
    keywords: ['灰色', '禁用', '模型', '不可用', '按钮'],
    group: '常见问题与任务教程',
    tabIds: ['model-settings'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'why',
        heading: '先看提示，再查模型',
        body: [
          '把鼠标停在被禁用的按钮上：如果提示「需先接入 AI 模型：到『模型设置 → 模型配置』添加本地 Ollama 或联网模型即可启用」，那就是没配模型，与本页数据无关。网页版这句会写成「添加联网模型」—— 网页版不支持连接本机模型。',
          '配好模型后回到原页面点一次即可，不需要重启软件、也不需要重建项目。',
          '另有少数按钮是因为「还缺前置条件」而禁用，例如校对需要本章有正文、替换需要这条结果属于「替换类」—— 这些按钮的提示会直接说明缺什么。',
        ],
      },
    ],
    related: ['start-without-ai'],
    actions: [{ label: '打开模型设置', tabId: 'model-settings' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'faq-save-state',
    revision: 1,
    title: '「已保存」和「正在写入」有什么区别',
    summary: '状态栏说的每一句话都对应当前真实落盘状态，不要只看有没有红字。',
    aliases: ['保存了吗', '没保存', '写入失败'],
    keywords: ['保存', '状态', '写入', '磁盘', '失败'],
    group: '常见问题与任务教程',
    tabIds: ['editor'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'states',
        heading: '四种状态',
        body: [
          '· 自动保存已开启：还没到写盘点，改动只在编辑区里。',
          '· 正在写入：正在落盘，稍等即可。',
          '· 已保存：这次写入真的成功了。',
          '· 未写入磁盘（红字）：这次没写成。点保存重试；仍失败时先导出备份，再排查磁盘或权限。',
        ],
      },
      {
        id: 'draft-safety',
        heading: '切页、切章不会丢稿',
        body: [
          '离开页签或切换章节时，软件会先等当前草稿写盘成功再走；写失败就留在原页，草稿和滚动位置都不动，可以直接重试。',
        ],
      },
    ],
    related: ['start-first-chapter'],
    actions: [{ label: '去正文编辑', tabId: 'editor' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'faq-zoom',
    revision: 1,
    title: '字太小 / 太大怎么调',
    summary: '左下角「界面缩放」：自动跟随窗口，也可以手动指定 80%～160%。',
    aliases: ['放大界面', '界面变大', '字太小', '字太大', '字号', '缩小'],
    keywords: ['缩放', '放大', '缩小', '字号', '界面', '字体', '自动'],
    group: '数据与界面',
    tabIds: ['dashboard'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'how',
        heading: '怎么调',
        body: [
          '第一行是标题「界面缩放」，下面一排是：左边「自动」按钮，右边「− 百分比 +」。',
          '点「自动」= 跟随窗口：按窗口宽度自动取一个舒适值，窗口变化时自动重算。',
          '用 +/− 或直接输入百分比 = 手动指定，此后不再自动适配；想恢复自动，点一下「自动」即可。',
          '范围是 80%～160%，设置保存在本机，下次打开沿用；它与主题、界面密度互相独立。',
        ],
      },
    ],
    related: ['faq-save-state'],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'faq-proofread-actions',
    revision: 1,
    title: '校对结果：定位、替换、复制分别做什么',
    summary: '三条互不替代：定位只带你看原文，替换才会改正文，复制只把文本放进剪贴板。',
    aliases: ['校对怎么用', '定位原文', '替换此条', '复制建议'],
    keywords: ['校对', '定位', '替换', '复制', '建议', '原文', '返回'],
    group: '常见问题与任务教程',
    tabIds: ['editor'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['需要先跑过一次 AI 校对（本章）；本地错别字结果是词频汇总，不提供逐条定位'],
    sections: [
      {
        id: 'three-actions',
        heading: '三个动作的区别',
        body: [
          '· 定位原文：只把正文滚到那句话并选中，**不改正文**、不触发保存、也不把问题标成已修复。你看完可以自己改。',
          '· 替换此条：只有「替换类」结果才有，点了会真的改正文；改完另一块结果的坐标会跟着位移，改不到的位置会标成失效。',
          '· 复制替换文本 / 复制建议：只把文字放进剪贴板，绝不动正文。建议类只能复制或定位，不能替换。',
        ],
      },
      {
        id: 'locate-flow',
        heading: '定位之后怎么回到结果列表',
        body: [
          '在「校对（本章）」弹窗里点定位，弹窗会先收起（它盖着正文，不收起你看不到跳转效果），正文顶部会出现一条「已定位到第 N / M 条校对结果」，点「返回校对结果」就回到列表，并且列表会滚到刚才那一条。结果都在，不会重新跑模型。',
          '在颉文姬诊室里点定位，面板不会收起（正文在左侧仍可见）；如果那句话正好被面板挡住，先点面板右上角收起即可。',
        ],
      },
      {
        id: 'blocked',
        heading: '定位按钮什么时候是灰的',
        body: [
          '结果已失效（正文被改过、或别的替换动过这段）、正文里找不到原句、或者这句在正文里出现多处而无法确定是哪一处时，定位按钮禁用并在条目下写明原因。这时请重新校对，不要凭猜测去改。',
        ],
      },
    ],
    related: ['faq-copy-failed'],
    actions: [{ label: '去正文编辑', tabId: 'editor' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'faq-copy-failed',
    revision: 1,
    title: '点复制没反应 / 复制失败怎么办',
    summary: '两种复制方式都失败时，界面会直接给你一段可手动复制的文本。',
    aliases: ['复制不了', '复制没反应', '剪贴板'],
    keywords: ['复制', '剪贴板', '失败', '手动'],
    group: '常见问题与任务教程',
    tabIds: ['editor'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'what-happens',
        heading: '软件做了什么',
        body: [
          '点复制时先走浏览器标准剪贴板接口，失败会自动再试一次兼容接口（只试一次，不会反复弹权限）。',
          '两种都失败时，条目下方会出现一段只读文本，聚焦即全选，你可以用 Ctrl+C（macOS 用 Cmd+C）或系统长按复制。',
          '复制成功会显示「已复制」；没成功就不会假装成功。',
        ],
      },
      {
        id: 'why',
        heading: '常见原因',
        body: [
          '剪贴板权限被浏览器或系统拒绝、页面不在安全上下文（网页版 http 访问时容易出现）、或当前处在某些受限窗口。换用桌面版通常可以直接复制。',
        ],
      },
    ],
    related: ['faq-proofread-actions'],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
