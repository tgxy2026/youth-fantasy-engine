// ============ 手册内容 · 3.7.3 版本变化（2026-11-25） ============
//
// 单独成文件，避免 version.ts 越过「纯字面量文件 200 行」的结构闸阈值。
import type { HelpArticle } from '@/lib/help/types'

export const VERSION_373_ARTICLES: HelpArticle[] = [
  {
    id: 'whats-new-373',
    revision: 1,
    title: '3.7.3：不用 API 的 WCP 网页资料包',
    summary: '新增第 4 种离线接力模式：把设定、角色、细纲与前文打包给 Gemini / Claude 网页版，再把双段式回复粘回来；正文入章、变动勾选入库，不占后台在线模式。',
    aliases: ['更新说明', '新功能', '3.7.3', 'WCP', '网页资料包'],
    keywords: ['3.7.3', 'WCP', '网页资料包', '底包', '增量包', '双段输出', 'JSON', 'Markdown 清单', '网页模型'],
    group: '快速开始',
    tabIds: ['model-settings', 'editor', 'chapter-outline', 'check-tools', 'char-bio'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'fourth-mode',
        heading: '第 4 个运行模式：WCP 模式',
        body: [
          '「模型设置 → 运行模式」在 API / MCP / ACP 之后新增 WCP 模式（网页资料包）。它不需要 API Key，也不占用那三种模式的运行状态；即使后台模式正在切换或提示不可用，WCP 页签仍可打开。',
          'WCP 是独立的本地视图，不会替你切换后台在线模式。',
        ],
      },
      {
        id: 'three-packs',
        heading: '三档资料包：底包 / 增量 / 完整',
        body: [
          '常驻底包放长期设定，适合放进 Gemini Gem 或 Claude Project；只装你勾选的模块，不掺当前章草稿。底包涉及的世界观或角色改动后，管理页会提示「设定已更新，建议重导」。',
          '增量包按场景就近导出：正文续写、片段润色 / 去 AI 味、大纲细纲推演、连续性找茬、角色小传整理。完整包会把底包与增量合成一份自洽上下文。',
          '每份包都带区块目录与各段字数，并如实标注「完整 / 裁剪 / 省略」；超出单包字符预算的段落不会被静默丢弃。',
        ],
      },
      {
        id: 'dual-segment',
        heading: '双段回复：正文与变动分开',
        body: [
          '网页模型按约定输出两段：第一部分是纯净正文（或润色稿 / 细纲 / 审校报告 / 小传），第二部分是变动摘要。正文可复制、追加、替换整章或替换选中片段；变动摘要经库内比对后，只有你勾选的条目才写入，且只追加不覆盖。',
          '默认 JSON 摘要支持 6 类变动：新登场设定、角色状态、物品流转、伏笔推进、关系变化、人物里程碑。未登记的伏笔 / 关系 / 物品 / 小传只提示，不会凭空建条目。',
          '若网页模型返回的 JSON 不完整，正文仍完整保留，并可一键切换为固定 Markdown 清单模式。',
        ],
      },
      {
        id: 'storage-isolation',
        heading: '设置分开存：偏好全局，底包按书',
        body: [
          '默认后缀、默认包形态、摘要格式、前文章数 / 摘要数与字符预算跨项目共用；底包勾选模块、上次导出时间与源数据指纹按项目单独保存。切换作品不会把一本的「底包已过期」提示带到另一本。',
        ],
      },
      {
        id: 'no-score',
        heading: '连续性找茬仍然只列事实',
        body: [
          'WCP 找茬包要求模型逐条列出「矛盾描述 / 设定依据 / 正文原句」，没有矛盾就写「未发现事实矛盾」。这个场景不评分、不排名、不评级，也不评判文笔。',
        ],
      },
    ],
    related: ['wcp-relay'],
    actions: [{ label: '打开模型设置', tabId: 'model-settings' }],
    verifiedAgainst: '3.7.3',
    reviewedAt: '2026-11-25',
  },
]