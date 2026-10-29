// ============ 手册内容 · 开书定位与世界构建（补充） ============
//
// 事实来源（2026-10-29 人工核对）：`schemaTabs/part1.ts` 与 `part2.ts` 里各页签的 description、
// 世界设定 / 力量体系的母子结构说明、地图编辑的绘制与层级归属规则。
// 🔴 母子结构（母级永远发给 AI、只有「活跃」子项参与）这类规则最容易写错，一律按源码原话写。
import type { HelpArticle } from '@/lib/help/types'

export const WORLD_EXTRA_ARTICLES: HelpArticle[] = [
  {
    id: 'world-base-power',
    revision: 1,
    title: '世界设定与力量体系：两层结构与「活跃」状态',
    summary: '这两页都有母级与子项两层；只有标为「活跃」的子项才会发给 AI。',
    aliases: ['世界观', '等级表', '境界', '子世界', '子体系'],
    keywords: ['世界设定', '力量体系', '母级', '子世界', '子体系', '活跃', '境界', '等级'],
    group: '开书定位与大纲',
    tabIds: ['worldbase', 'power'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'two-layers',
        heading: '母级 + 子项，两个层次',
        body: [
          '【全书统一（母级）】只有一份，**永远**发给 AI —— 世界观顶层写在母级：世界总览、底层法则、社会文明、成长地图、限制禁忌、剧情钩子。',
          '下面可以建多个【子世界】（副本 / 世界线 / 剧本），每个子世界有一套完整设定；力量体系同理，可建多个【子体系】。',
          '🔴 只有标为「活跃」的子项才会发给 AI。写了一堆子世界但没标活跃，模型是看不到的 —— 这是「为什么 AI 不知道我的设定」最常见的原因。',
        ],
      },
      {
        id: 'writing',
        heading: '三层填法的建议',
        body: [
          '建议：底层法则（定了不改）→ 社会文明（前十章展开）→ 细节（随写随补）。世界观是舞台不是字典，不必一次写满。',
          '力量体系的等级表是「宪法」：正文发布后尽量不改。定稿前先写三章试水，检验数值会不会膨胀。',
        ],
      },
    ],
    related: ['world-institutions', 'positioning-guide'],
    actions: [{ label: '打开世界设定', tabId: 'worldbase' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'world-institutions',
    revision: 1,
    title: '制度四页签：政治、经济、信仰、司法',
    summary: '四页并列着建，一个政权 / 教派 / 地区一条；与世界设定是「展开」与「一语带过」的分工。',
    aliases: ['政治架构', '经济基础', '宗教信仰', '司法制度', '制度'],
    keywords: ['政治', '经济', '宗教', '信仰', '司法', '律法', '制度', '货币', '政体'],
    group: '开书定位与大纲',
    tabIds: ['politics', 'economy', 'belief', 'justice'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'split',
        heading: '和《世界设定》怎么分工',
        body: [
          '《世界设定》写「世界长什么样」，这四页写「它怎么运转」：政体与权力结构、货币与贸易、神系与教团、律法与刑罚。',
          '世界设定里「经济与货币」是一语带过的那一句；要展开成整套运转，就写到这里来。',
        ],
      },
      {
        id: 'parallel',
        heading: '并列着建，不是一份长文档',
        body: [
          '这四页是并列结构：一个政权 / 地区 / 教派各建一条，每条带「活跃 / 已完结」开关。不同地区的差异各写各自的，不要挤在一条里。',
          '只有「活跃」的条目会进 AI 的设定资料 —— 已完结的旧政权留档但不干扰当前剧情。',
        ],
      },
    ],
    related: ['world-base-power'],
    actions: [{ label: '打开政治架构', tabId: 'politics' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
  {
    id: 'world-misc-engine-map',
    revision: 1,
    title: '其他设定、世界引擎与地图编辑',
    summary: '没处放的设定写「其他设定」，成熟的世界抽成「世界引擎」，地理往上再叠一层格子地图。',
    aliases: ['其他设定', '世界引擎', '地图', '世界包'],
    keywords: ['其他设定', '世界引擎', '地图', '地图编辑', '世界包', '抽世界', '层级', '格子'],
    group: '角色与世界',
    tabIds: ['misc-settings', 'worlds', 'geography-map'],
    availability: 'all',
    aiRequirement: 'none',
    sections: [
      {
        id: 'misc',
        heading: '其他设定：兜底页',
        body: [
          '前面几张表没覆盖到的设定都写这里：一条一张卡，卡名就是设定名，卡内「内容」写具体说明，纯文本、不做结构校验。',
          '它同样会进 AI 的设定资料 —— 放在这儿的设定模型读得到，不会因为「没地方记」而落空。',
        ],
      },
      {
        id: 'engine',
        heading: '世界引擎：跨作品抽包',
        body: [
          '把本书的世界（世界设定 / 力量体系 / 制度四页 / 世界构建组）抽成一个世界包存起来，可封存为不可变版本，将来给别的作品引用。',
          '🔴 它是**跨作品**的：换一本书，这里的世界照样在。但改了项目里的世界，已经抽出来的世界**不会自动更新** —— 要新的就再抽一份。',
        ],
      },
      {
        id: 'map',
        heading: '地图编辑：手绘格子',
        body: [
          '在地理风物之上叠一层手绘格子地图：点「绘制地图」选一个范围，左键涂格、右键退出，形状与格子数完全由你定；按「层级归属」分层叠色，只要求子范围完全画在父范围之内（无飞地）。',
          '地图不是独立页签的数据表：它挂在「地理风物」上，可叠加伏笔 / 角色 / 时间线的关联（按「地理位置」字段精确联动）。',
        ],
      },
    ],
    related: ['atlas-guide'],
    actions: [{ label: '打开其他设定', tabId: 'misc-settings' }, { label: '打开世界引擎', tabId: 'worlds' }],
    verifiedAgainst: '3.3.1',
    reviewedAt: '2026-10-29',
  },
]
