// ============ 手册内容 · 成果记录 / 创作参考 / 审读记录（3.6.1 补写）============
//
// 为什么单独成篇：3.6.0 把「作品分析 → 创作参考 → 审读」串成一条链，产物不再只活在当次界面里，
// 但手册一直没写过这三件事 —— 作者看不到"分析结果存哪了、会不会被发出去、失败算什么状态"。
//
// 事实来源：`docs/归档/3.6/3.6.0-更新说明-2026-11-18.md`（A / C / D 三节）与
// `src/lib/artefacts/*`、`src/lib/creative/*`、`src/lib/revision/*` 的既有行为。
// 🔴 只写"已经能跑的事"；能力边界照实写（未配置模型时不可用、来源过期一条都不发）。
import type { HelpArticle } from '@/lib/help/types'

export const ARTEFACT_ARTICLES: HelpArticle[] = [
  {
    id: 'artefact-records',
    revision: 1,
    title: '成果记录：分析结果存在哪、怎么才会被用上',
    summary: '拆书分析与参考卡可以存成成果，保留 / 草稿 / 已排除三态，标了排除就不会被发出去。',
    aliases: ['成果', '成果列表', '分析结果', '已排除'],
    keywords: ['成果', '成果记录', '拆书', '参考卡', '排除', '草稿', '保留', '导出', '失效'],
    group: '创作与维护',
    tabIds: ['bookbreak', 'creative-writing'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['API 模式下配置可用模型，或在支持的桌面构建中连接 ACP Agent'],
    sections: [
      {
        id: 'what',
        heading: '什么会变成成果',
        body: [
          '分析类产出（例如一键拆书的分析结果、创作参考里的参考卡）不再只留在当次界面里：可以保存为成果，之后在成果列表回看。',
          '成果分三种状态：保留 / 草稿 / 已排除。它们只是你给这份产出的态度，不改原作品内容。',
        ],
      },
      {
        id: 'excluded',
        heading: '「已排除」是决定，不是还没审',
        body: [
          '标为「已排除」的成果**不会被发送**给模型 —— 排除是你明确否定过的内容，不该被当成"还没看过"照发。已排除的参考也不会被勾选。',
        ],
      },
      {
        id: 'export',
        heading: '跟着项目走，缺章不静默丢弃',
        body: [
          '导出 / 导入项目时成果随项目一起走。若某条成果指向的章节已经不存在，会标「失效」并降为草稿 —— 不会悄悄删掉，也不会假装还有效。',
        ],
      },
      {
        id: 'limit',
        heading: '边界',
        body: [
          '生成或重新分析需要模型可用；只看已存的成果不需要。未配置模型时相关按钮会禁用并说明原因，不会假装完成。',
        ],
      },
    ],
    related: ['creative-reference', 'review-log'],
    actions: [{ label: '打开一键拆书', tabId: 'bookbreak' }],
    verifiedAgainst: '3.6.1',
    reviewedAt: '2026-11-18',
  },
  {
    id: 'creative-reference',
    revision: 1,
    title: '创作参考：只发你勾选的那几张',
    summary: '参考卡按预算裁剪、标明「别照搬」，来源过期就一条都不发。',
    aliases: ['参考卡', '创作参考', '参考'],
    keywords: ['创作参考', '参考卡', '预算', '裁剪', '过期', '勾选', '排除', '别的作品'],
    group: '创作与维护',
    tabIds: ['creative-writing'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['API 模式下配置可用模型，或在支持的桌面构建中连接 ACP Agent'],
    sections: [
      {
        id: 'budget',
        heading: '按预算裁剪，不塞满上下文',
        body: [
          '参考卡按预算发送：最多 12 张、约 2400 字。超出就先裁掉，而不是把整库塞给模型 —— 上下文越乱，写出来的东西越像拼盘。',
          '发给模型时会明确写清「这是别的作品的写法，不要照搬情节与人名」，避免它把你的参考当成同一本书的设定。',
        ],
      },
      {
        id: 'stale',
        heading: '来源过期：一条都不发',
        body: [
          '参考卡引用的来源被删或读不到时，这次一条都不发，并在界面上说明原因。宁可这次不用参考，也不拿一份不知出处的文本去影响正文。',
        ],
      },
      {
        id: 'excluded',
        heading: '已排除的不参与',
        body: [
          '你标为「已排除」的参考不会被勾选，也不会被发送。排除是作者的否定决定，不会被"顺手带上"。',
        ],
      },
    ],
    related: ['artefact-records'],
    actions: [{ label: '打开创意写作', tabId: 'creative-writing' }],
    verifiedAgainst: '3.6.1',
    reviewedAt: '2026-11-18',
  },
  {
    id: 'review-log',
    revision: 1,
    title: '审读记录：跑过什么、结果在哪看',
    summary: '审读会留下摘要记录，可在创作轨迹回看；失败如实呈现，不生成空记录。',
    aliases: ['审读', '审读记录', '创作轨迹'],
    keywords: ['审读', '审读记录', '创作轨迹', '摘要', '失败', '回看'],
    group: '创作与维护',
    tabIds: ['trajectory'],
    availability: 'all',
    aiRequirement: 'model',
    prerequisites: ['API 模式下配置可用模型，或在支持的桌面构建中连接 ACP Agent'],
    sections: [
      {
        id: 'where',
        heading: '记录在哪',
        body: [
          '审读运行结束后会留下一条摘要记录，在「创作轨迹」里能翻回来看：这次审的哪一章、什么时候跑的、结论概要是什么。',
        ],
      },
      {
        id: 'failure',
        heading: '失败不冒充成功',
        body: [
          '审读失败或没跑完会如实呈现，**不会**生成一条空记录冒充"审过了、没问题"。看到失败就重跑或先检查模型配置，别把它当成结论。',
        ],
      },
    ],
    related: ['artefact-records', 'jiewenji-modes'],
    actions: [{ label: '打开创作轨迹', tabId: 'trajectory' }],
    verifiedAgainst: '3.6.1',
    reviewedAt: '2026-11-18',
  },
]
