/**
 * AI 功能「会读哪些项目数据」的**单一数据源**。
 *
 * 【为什么要有这个文件】
 * 作者在界面上能看到每个 AI 功能"输出什么"，但看不到"输入什么" —— 于是常有两个误解：
 *   ① 以为某个功能读了它其实没读的资料（如「参照本项目世界观」实际只取 3 张表的少数关键字段）；
 *   ② 反过来担心它读了不该读的（如把结局、伏笔真相整篇发出去）。
 * 这份表把每个功能的**实际读入项**写在一处，由 `AIDataSourceNote` 渲染进各功能的问号气泡，
 * 从而做到"界面说明"与"prompt 拼装"不至于各说各话。
 *
 * 🔴 【维护约定】改 prompt 的数据来源时**必须同步改这里**，并跑 `tests/aiDataSources.test.ts`：
 *    · 该测试会检查「每个 id 都至少被某个界面引用」—— 防止表里堆了一堆没人挂的条目；
 *    · 也会检查每个功能的 sources 非空 —— 防止漏写。
 *
 * 【怎么描述才对作者有用】
 *  · `group` 用作者认识的名字（页签名 / 资料名），不要用表 id；
 *  · `items` 只在"能列清楚"时列，列了就代表**确实会把这些发出去**；
 *  · `note` 写**边界**（按预算裁剪、可关、关键词命中才注入…）—— 作者最需要知道的往往是边界；
 *  · `excludes` 写"明确不读什么"，用于消除误解，不确定就不要写。
 */
export interface SourceBlock {
  /** 分组名（概括行用它），如「项目设定资料」 */
  group: string
  /** 展开明细时列出的具体条目；空数组表示这组无需展开 */
  items: string[]
  /** 该组的边界说明（可选），如「按预算裁剪，超出部分不发送」 */
  note?: string
}

export interface AIFeatureSources {
  /** 展示名，与界面上的入口名一致，便于按名字搜到 */
  label: string
  sources: SourceBlock[]
  /** 明确**不读**的内容（可选） */
  excludes?: string[]
}

/** 项目设定表里最常被读到的几类（多为 `PRIORITY` 靠前的资料型页签） */
const CORE_TABLES = ['作品定位', '世界观设定', '力量体系', '主要角色', '次要角色', 'NPC 角色', '人物关系', '术语表']
/** 按预算裁剪的统一说明 */
const BY_BUDGET = '按当前上下文预算裁剪，装不下的部分不发送（并在发送内容里注明被略过）'

export const AI_DATA_SOURCES: Record<string, AIFeatureSources> = {
  // ==================== 正文写作 ====================
  'inline-suggest': {
    label: 'AI 伴写',
    sources: [
      { group: '光标前约 2000 字正文', items: [], note: '最准的风格样本' },
      { group: '精选设定（4 类）', items: ['作品定位', '世界观设定', '主要角色', '术语表'], note: '约 900 字预算，且不含章节目录' },
      { group: '《写作规范》', items: ['坏习惯清单', '标点规范', '视角切换规则'], note: '可在伴写弹窗里关掉' },
      { group: '文风补充', items: [], note: '你在伴写弹窗里手写的那一句' },
    ],
    excludes: ['除上面 4 类之外的设定表（势力 / 地理 / 器物等）', '其它章节的正文'],
  },
  'chapter-summary': {
    label: '章节压缩摘要',
    sources: [{
      group: '本章正文',
      items: [],
      note: '压成约 1/10 长度的连贯摘要（保留关键情节 / 人物 / 伏笔 / 转折 / 设定）',
    }],
    excludes: ['任何设定表 —— 它只压缩你让它压的那一章'],
  },
  'auto-continue': {
    label: 'AI 一键续写',
    sources: [
      { group: '项目设定资料', items: CORE_TABLES, note: BY_BUDGET + '；含相关章节召回' },
      { group: '上一章结尾', items: [], note: '约 1200 字' },
      { group: '最近 3 章摘要', items: ['章节压缩摘要（约原文 1/10）'] },
      { group: '全书滚动摘要', items: ['续写过程中积累的滚动摘要'] },
    ],
    excludes: ['除上一章结尾之外的其它章节原文（那些走摘要）'],
  },
  'proofread': {
    label: 'AI 深度校对',
    sources: [
      { group: '本章正文', items: [] },
      { group: '项目设定资料', items: CORE_TABLES, note: '约 6000 字预算（' + BY_BUDGET + '）' },
    ],
  },
  'foreshadow-review': {
    label: '伏笔闭环 AI 审查',
    sources: [
      { group: '伏笔追踪表', items: ['编号', '名称', '状态', '埋设章 / 回收章'] },
      { group: '章节总表', items: ['章节标题', '埋设伏笔编号', '回收伏笔编号'] },
      { group: '时间脉络表', items: [] },
    ],
    excludes: ['角色卡与世界观设定 —— 它只判"伏笔有没有回收"这一类闭环问题'],
  },
  'continuity-audit': {
    label: '连续性校验',
    sources: [
      { group: '项目设定资料', items: CORE_TABLES, note: '约 12000 字预算（' + BY_BUDGET + '）' },
      { group: '最近 6 章正文', items: [], note: '用来比对"设定写的 vs 正文写的"' },
    ],
  },
  'style-check': {
    label: '文风体检（AI 版）',
    sources: [
      { group: '《写作规范》全表', items: ['每个字段各截前 200 字'] },
      { group: '本章正文', items: [] },
    ],
  },
  'project-diagnose': {
    label: '创作健康诊断',
    sources: [
      { group: '项目设定资料', items: CORE_TABLES, note: '约 12000 字预算（' + BY_BUDGET + '）' },
      { group: '项目统计', items: ['卷数 / 章节数 / 累计字数', '未回收伏笔数', '闲置灵感数'] },
    ],
  },

  // ==================== 颉文姬（编辑助手）各模式 ====================
  'jiewenji-panel': {
    label: '颉文姬（各模式总览）',
    sources: [
      { group: '本章正文', items: ['校对 / 诊断 / 编辑意见 / OOC / 续写方向 / 爽点毒点 / 黄金三章 / 写作简报'], note: '诊断模式可改喂「本章压缩摘要」省 token' },
      { group: '项目设定资料', items: CORE_TABLES, note: '各模式预算 6000~10000 字不等（OOC 读角色卡最全）；都带叙事锚点 —— **只带到本章为止**' },
      { group: '《写作规范》', items: ['文风体检全表（每字段截 200 字）', '选区改稿：全表'], note: '只在「文风体检」与「选区改稿」两个模式读' },
      { group: '设定补登模式（例外）', items: ['AI 只读本章正文'], note: '「是否已登记」由程序读全部设定表精确比对，**不把设定表发给 AI**，所以它不会编造' },
    ],
  },
  'jiewenji-proofread': {
    label: '颉文姬 · 深度校对',
    sources: [
      { group: '本章正文', items: [] },
      { group: '项目设定资料', items: CORE_TABLES, note: '约 6000 字预算，带锚点（只到本章）' },
    ],
  },
  'jiewenji-diagnosis': {
    label: '颉文姬 · 综合诊断',
    sources: [
      { group: '本章正文（或本章压缩摘要）', items: [], note: '由你在面板上选"喂全文还是喂摘要"' },
      { group: '项目设定资料', items: CORE_TABLES, note: '约 8000 字预算，带锚点（只到本章）' },
    ],
  },
  'jiewenji-rewrite': {
    label: '颉文姬 · 选区改稿',
    sources: [
      { group: '你选中的那一段', items: [] },
      { group: '《写作规范》', items: ['各字段各截前 200 字'] },
      { group: '你的改写指令', items: [] },
    ],
    excludes: ['设定表与其它章节 —— 改稿只看这一段 + 写作规范'],
  },
  'jiewenji-review': {
    label: '颉文姬 · 章节编辑意见',
    sources: [
      { group: '本章正文', items: [] },
      { group: '项目设定资料', items: CORE_TABLES, note: '约 8000 字预算，带锚点（只到本章）' },
    ],
  },
  'jiewenji-ooc': {
    label: '颉文姬 · OOC 人设检查',
    sources: [
      { group: '本章正文', items: [] },
      { group: '角色卡与设定资料', items: ['主要角色', '次要角色', 'NPC 角色', '人物关系', '世界观设定', '术语表'], note: '约 10000 字预算 —— 颉文姬各模式里**读角色卡最全**的一项' },
    ],
  },
  'jiewenji-advice': {
    label: '颉文姬 · 续写方向',
    sources: [
      { group: '本章正文', items: [] },
      { group: '项目设定资料', items: CORE_TABLES, note: '约 8000 字预算，带锚点（只到本章）' },
    ],
  },
  'jiewenji-pleasure': {
    label: '颉文姬 · 爽点 / 毒点',
    sources: [
      { group: '本章正文', items: [] },
      { group: '项目设定资料', items: CORE_TABLES, note: '约 8000 字预算，带锚点（只到本章）' },
    ],
  },
  'jiewenji-opening': {
    label: '颉文姬 · 黄金三章',
    sources: [
      { group: '开头三章正文', items: [] },
      { group: '项目设定资料', items: CORE_TABLES, note: '约 8000 字预算，带锚点（只到本章）' },
    ],
  },
  'jiewenji-brief': {
    label: '颉文姬 · 本章写作简报',
    sources: [
      { group: '本章正文', items: [] },
      { group: '项目设定资料', items: ['未回收伏笔', '出场角色状态', '世界观设定', '术语表'], note: '约 8000 字预算，带锚点（只到本章）' },
    ],
  },
  'jiewenji-ledger': {
    label: '颉文姬 · 设定补登',
    sources: [
      { group: '本章正文', items: [], note: 'AI 只负责"从正文里抽出专名实体"' },
      { group: '已登记条目（程序比对，不发给 AI）', items: ['全部设定表的名称与别称'], note: '"是否已登记"由程序精确比对，AI 不会凭空编造' },
    ],
  },

  // ==================== 表格 / 卡片 ====================
  'organize-rows': {
    label: 'AI 整理（批量补条目）',
    sources: [
      { group: '你选的章节正文', items: [], note: '一档；选太多章会超上下文，建议 1~3 章' },
      { group: '项目设定资料', items: CORE_TABLES, note: '约 9000 字预算；**会排除本表**（避免拿本表自己的内容去补本表）' },
      { group: '本表已登记条目', items: [], note: '用于判重，模型不会重复生成已有的' },
    ],
  },
  'fill-template': {
    label: 'AI 补全（设定 / 角色卡）',
    sources: [
      { group: '世界观上下文（3 张表的关键字段）', items: ['作品定位：书名 / 类型赛道 / 核心卖点 / 一句话简介', '世界观设定：世界名称 / 一句话世界观 / 文明程度 / 当前时代 / 核心规则', '力量体系：体系名称 / 类型 / 力量来源 / 限制规则'], note: '范围**仅此三表**，不是全部设定' },
      { group: '字段清单与已填内容', items: [], note: '已填的字段会锁定、不被覆盖' },
      { group: '外部素材（可选）', items: ['联网检索结果', '你粘贴的参考材料'] },
    ],
  },
  'feedback-ai': {
    label: '读者反馈 AI 分析',
    sources: [{ group: '读者反馈表（本表 7 列）', items: ['数据周期 / 日期', '追读', '均订', '留存', '高频吐槽', '流失点章节', '流失原因分析'] }],
    excludes: ['其它任何表 —— 它只分析这张反馈表'],
  },
  'term-dedup': {
    label: '术语 AI 查重归一',
    sources: [{ group: '术语表（本表 3 列）', items: ['名称', '类别', '定义（一句话）'] }],
    excludes: ['其它任何表 —— 它只扫术语表'],
  },
  'sensitive-check': {
    label: '敏感词 AI 检测',
    sources: [{ group: '命中词 + 该词附近约 120 字的上下文', items: [], note: '只发命中的片段，不发全篇' }],
    excludes: ['项目设定表 —— 它只判断"这个词在当前语境里是否有风险"'],
  },
  'name-suggest': {
    label: 'AI 取名',
    sources: [{ group: '项目设定资料', items: ['作品定位', '世界观设定', '力量体系'], note: '约 3000 字预算' }],
  },
  'ai-assist': {
    label: 'AI 辅助规划（脑暴）',
    sources: [{ group: '项目设定资料', items: CORE_TABLES, note: '约 4000 字预算；**勾选「带入项目资料」才发送**，不勾就是纯对话' }],
  },
  'plot-canvas': {
    label: '情节推演画布',
    sources: [
      { group: '项目设定资料', items: ['未回收伏笔', '出场角色状态', '世界观设定', '术语表'], note: '约 6000 字预算' },
      { group: '你勾选章节的上下文', items: [] },
    ],
  },

  // ==================== 酒馆模式 ====================
  'tavern-plot': {
    label: '剧情推演',
    sources: [
      { group: '项目设定资料', items: ['作品定位', '世界观设定', '力量体系', '主要角色', '次要角色', 'NPC 角色', '人物关系', '术语表', '势力', '地理', '历史事件', '时间脉络', '伏笔追踪'], note: '按「设定层占比」从上下文预算里切一块；带叙事锚点 —— **只带到锚点章为止**' },
      { group: '本场背景设定', items: [], note: '你会话里那份；**关键词命中才注入**，不是每轮都带' },
      { group: '本场记忆', items: ['六栏：剧情进度 / 人物状态 / 关系变化 / 已知信息 / 待办伏笔 / 备注'], note: '手动整理才更新，不会自动滚动' },
      { group: '角色卡扮演设定', items: ['参演角色各自的卡面'], note: '谁演谁由你在开场时指定' },
      { group: '你的档位与补充要求', items: ['风格提示', '本场额外提示'] },
    ],
    excludes: ['🔒 沉浸档下会**排除作者侧页签**（结局走向 / 真相 / 未来剧情等约 13 类）与"未来向"字段，避免 AI 剧透给你；导演档才全给。'],
  },
  'tavern-memory': {
    label: '本场记忆整理',
    sources: [
      { group: '水位线（上次整理）之后的全部对话', items: [] },
      { group: '现有本场记忆', items: [], note: '与新增内容合并，不是重写' },
      { group: '参演角色卡', items: ['角色卡四章全文'] },
    ],
  },
  'tavern-report': {
    label: '推演报告',
    sources: [
      { group: '本场推演记录', items: ['叙事锚点', '参演角色', '场景', '信息边界', '对话记录'], note: '上限约 12000 字' },
      { group: '可回填的表名清单', items: [], note: '**只给表名、不给表内容** —— 报告只提示"这条可以写回哪张表"，不会读到你的设定内容' },
    ],
  },
  'tavern-free': {
    label: '自由对话',
    sources: [
      { group: '角色卡', items: ['角色卡四章全文'] },
      { group: '按角色的记忆', items: ['六栏记忆（跨会话共享）'] },
      { group: '故事世界设定', items: [], note: '你为该故事写的背景' },
      { group: '剧本', items: [], note: '选了剧本才带' },
      { group: '你的档案与档位', items: ['称呼 / 自我设定 / 场景描写档位'] },
    ],
    excludes: ['🔒 **不读小说项目的设定表** —— 自由对话不绑项目，换一本书角色卡与记忆照样在。'],
  },
  'tavern-round-end': {
    label: '结束本轮对话',
    sources: [
      { group: '水位线之后的全部对话', items: [] },
      { group: '每个参演角色的角色卡', items: ['四章全文'] },
      { group: '现有记忆与角色卡备注', items: [] },
      { group: '剧本目标', items: [] },
    ],
    excludes: ['小说项目的设定表（自由对话不绑项目）'],
  },
  'tavern-card-draft': {
    label: '角色卡 AI 起草',
    sources: [
      { group: '你写的一句话设定', items: [] },
      { group: '现有卡面内容', items: [], note: '当作"补完"起点 —— 已写好的栏位不会被动' },
      { group: '外部素材（可选）', items: ['联网检索结果'] },
    ],
    excludes: ['小说项目的设定表 —— 角色卡起草只依据你给的想法与素材'],
  },
  'tavern-world-draft': {
    label: '背景设定 AI 起草',
    sources: [{ group: '项目设定资料', items: ['世界观设定', '势力', '主要角色', '术语表'], note: '约 8000 字预算；AI 只做精简整合，不会把资料原样搬过来' }],
  },
}

/** 取某个功能的数据来源声明；未登记返回 null（调用方自行决定是否报错） */
export function sourcesOf(feature: string): AIFeatureSources | null {
  return AI_DATA_SOURCES[feature] ?? null
}

/** 概括行：「项目设定资料（8 项） + 本章正文」这种，供界面一行显示 */
export function summarizeSources(f: AIFeatureSources): string {
  return f.sources
    .map(s => (s.items.length > 1 ? `${s.group}（${s.items.length} 项）` : s.group))
    .join(' + ')
}
