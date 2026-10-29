// ============ 手册内容 · 其余单页（创作轨迹 / 名词术语 / 关于打赏 / 使用指南） ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs` 里创作轨迹、名词术语、关于打赏、使用指南的 description。
// 🔴 创作轨迹的导出说明只在桌面形态成立（桌面一键存 PDF），网页版不能这么写。
import type { HelpArticle } from '@/lib/help/types'

export const MISC_PAGE_ARTICLES: HelpArticle[] = [
  {
    id: 'page-trajectory',
    revision: 1,
    title: '创作轨迹：这一章是怎么写出来的',
    summary: '细纲 → 各次改动 → 当前稿；可导出可打印的证据包，投稿时用来自证创作过程。',
    aliases: ['创作记录', '证据包', '写作过程', '轨迹'],
    keywords: ['创作轨迹', '细纲', '改动', '证据包', '导出', 'HTML', 'PDF', '投稿', '字数分布'],
    group: '创作与维护',
    tabIds: ['trajectory'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'what',
        heading: '按章回看',
        body: [
          '每一章都能回看「怎么长成现在这样」：细纲 → 各次改动 → 当前稿，附写作日期与字数分布。',
          '它是只读视图：看得到历史，改不了正文 —— 要回滚版本请用编辑器的「时光机」。',
        ],
      },
      {
        id: 'export',
        heading: '导出证据包',
        body: [
          '可导出可打印的 HTML 证据包，以及机器可核验的 JSON；桌面版还能一键存 PDF（网页版只有 HTML / JSON）。',
          '投稿时用它自证创作过程：什么时候写的、改了几稿、每章多少字，都有据可查。',
        ],
      },
    ],
    related: ['editor-tools'],
    actions: [{ label: '打开创作轨迹', tabId: 'trajectory' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'page-terms',
    revision: 1,
    title: '名词术语：一本书只能有一个名字',
    summary: '所有专有名词进术语表，防止「同一事物两个名字」；支持上下级树。',
    aliases: ['术语', '专有名词', '名词表', '查重'],
    keywords: ['名词术语', '术语', '专有名词', '别名', '查重', '上级', '树'],
    group: '角色与世界',
    tabIds: ['terms'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'why',
        heading: '为什么要单独一张表',
        body: [
          '同一套功法你在第 3 章叫「雷纹诀」、第 40 章叫「雷纹心法」，读者会以为是两样东西。把所有专有名词登记进来，是最便宜的防矛盾手段。',
          '支持「上级」隶属：填本表其它术语名称即形成上下级树，可折叠、可新增子条目（例如「雷纹诀」下挂它的几层境界）。',
        ],
      },
      {
        id: 'dedup',
        heading: '查重',
        body: [
          '这一页有 AI 查重入口（需模型）：找同义 / 重复的术语并建议合并归一。',
          '合并前自己过一遍：有些"重复"其实是刻意区分的近义词。',
        ],
      },
    ],
    related: ['atlas-guide', 'tracking-changelog'],
    actions: [{ label: '打开名词术语', tabId: 'terms' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'page-about',
    revision: 1,
    title: '关于打赏：作者页与致谢名单',
    summary: '介绍本作与作者、支持方式与致谢；网页版不做版本检查。',
    aliases: ['关于', '打赏', '致谢', '作者页'],
    keywords: ['关于打赏', '打赏', '致谢', '作者', '收款码', '支持'],
    group: '创作与维护',
    tabIds: ['about'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'content',
        heading: '这一页放什么',
        body: [
          '关于作者与本作、友情链接，以及支持作者的方式（微信 / 支付宝收款码）。致谢名单按打赏时间排序，随打赏持续更新。',
          '页面图文与链接都是内置静态资源；网页版不做任何版本检查，也不会弹出更新提示。',
        ],
      },
    ],
    related: ['start-first-project'],
    actions: [{ label: '打开关于打赏', tabId: 'about' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'page-guide',
    revision: 1,
    title: '使用指南：手册、引导与推荐顺序',
    summary: '卡壳时先来这里搜一句；分步引导的开关与重置也在这页下面。',
    aliases: ['帮助', '指南', '说明书', '手册'],
    keywords: ['使用指南', '手册', '帮助', '搜索', '引导', '开关', '重置', '推荐顺序'],
    group: '数据与界面',
    tabIds: ['guide'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'manual',
        heading: '内置手册（不用模型）',
        body: [
          '最上面是手册：输入「字太小」「怎么保存」这类问题，直接给出手册里的相关段落。全部本地检索，不联网、不调用模型。',
          '手册标题行写着「已收录 N 篇 · 覆盖 M 个页签」—— 没写到的功能会明确标出来，不会假装完整。',
        ],
      },
      {
        id: 'guide-settings',
        heading: '分步引导的开关',
        body: [
          '不想每次进新页签都弹介绍，在下面的「分步引导」里关掉；关掉后仍可从页头或侧栏的「本页指引」随时重看，也能一键重置记录（只影响引导，不动项目数据）。',
        ],
      },
    ],
    related: ['faq-zoom', 'start-first-chapter'],
    actions: [{ label: '回到写作面板', tabId: 'dashboard' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
