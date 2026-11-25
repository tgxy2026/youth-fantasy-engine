// ============ WCP 网页资料包 · 5 大场景模板（3.7.3 · W1）============
//
// 一份注册表驱动全部场景（规划 D8）：
//   · 场景元信息（名称 / 挂载页 / 推荐形态 / 取材提示）⇒ 管理页与导出弹窗直接读；
//   · 任务指令 ⇒ `<wcp_task>` 段；
//   · 输出契约 ⇒ `<wcp_output_contract>` 段（JSON 默认 / Markdown 清单备选）。
//
// 🔴 纯函数模块：不读库、不碰 UI、不依赖 store —— 单测可逐字断言。
// 🔴 「连续性找茬」的立场红线（规划 §2.2）：只列事实矛盾与正文引文，
//    **不评分、不排名、不评级、不评判文笔**。任务指令与输出契约两处都写死，别删。
import type { WcpPackKind, WcpSceneId, WcpSummaryFormat } from '@/lib/wcp/wcpTypes'

/** 双段式输出的标准起止标记（解析器与契约共用同一份常量） */
export const WCP_BODY_START = '<<<WCP_BODY_START>>>'
export const WCP_BODY_END = '<<<WCP_BODY_END>>>'
export const WCP_CHANGES_START = '<<<WCP_CHANGES_START>>>'
export const WCP_CHANGES_END = '<<<WCP_CHANGES_END>>>'

/** 任务指令的上下文（缺项由模板自行省略） */
export interface WcpTaskContext {
  projectName: string
  chapterNo?: number
  chapterTitle?: string
  /** 场景焦点文本：角色名（小传）/ 片段名（润色）等 */
  focus?: string
  /** 作者附加说明（勾选「附带作者备注」时才有） */
  extraInstruction?: string
}

/** 一个场景的完整定义 */
export interface WcpScenario {
  id: WcpSceneId
  /** 界面名称 */
  name: string
  /** 短名（按钮 / 文件名用，避免过长） */
  shortName: string
  /** 真实承载页面（帮助文档与自检脚本据此核对，不用猜） */
  mount: string
  /** 默认推荐包形态 */
  recommendedKind: WcpPackKind
  /** 是否注入去 AI 味规则（仅创作 / 润色场景） */
  injectDeAi: boolean
  /** 是否必须在场常驻底包（完整包会自动合体） */
  needsBase: boolean
  /** 取材范围提示（导出弹窗里如实告诉作者「会带什么」） */
  materialHint: string
  /** 结果怎么用（回流弹窗的说明文案） */
  outputHint: string
  /** 任务指令 */
  task: (ctx: WcpTaskContext) => string
}

function chapterLabel(ctx: WcpTaskContext): string {
  if (!ctx.chapterNo || ctx.chapterNo <= 0) return '当前章'
  return `第 ${ctx.chapterNo} 章${ctx.chapterTitle ? `「${ctx.chapterTitle}」` : ''}`
}

function withExtra(base: string, extra?: string): string {
  const note = (extra ?? '').trim()
  return note ? `${base}\n\n【作者附加说明】\n${note}` : base
}

export const WCP_SCENARIOS: readonly WcpScenario[] = [
  {
    id: 'chapter-continue',
    name: '正文续写',
    shortName: '续写',
    mount: 'src/components/editor/NovelEditor.tsx',
    recommendedKind: 'delta',
    injectDeAi: true,
    needsBase: false,
    materialHint: '本章细纲 + 前文摘要/末尾正文 + 本章草稿 + 出场角色当前状态 + 物品与未回收伏笔',
    outputHint: '第一部分是接续正文，可插入 / 追加 / 替换；第二部分是变动摘要，勾选后才写入资料库。',
    task: ctx => withExtra(
      `这是《${ctx.projectName}》${chapterLabel(ctx)}的接续任务。\n` +
      '请只依据下方资料，从【本章已写草稿】的末尾自然接续，写出后续正文（约 1500～2500 字）。\n' +
      '- 严格沿用人物口吻、称谓、已经发生的事实与当前状态；资料里没有的设定不要凭空发明。\n' +
      '- 不写章节标题，不写「好的」「以下是」之类的说明，不要总结前文。\n' +
      '- 若资料之间出现冲突，以【当前章快照】为准。\n' +
      '- 文风遵守 <wcp_rules> 里的写作规范与去 AI 味红线。',
      ctx.extraInstruction,
    ),
  },
  {
    id: 'chapter-polish',
    name: '片段润色 / 去 AI 味',
    shortName: '润色',
    mount: 'src/components/editor/NovelEditor.tsx',
    recommendedKind: 'delta',
    injectDeAi: true,
    needsBase: false,
    materialHint: '待润色片段 + 本章上下文 + 写作规范 + 去 AI 味规则 + 激活的文风指纹',
    outputHint: '第一部分是润色后的片段，可对照后替换选中文字；第二部分只记微调说明。',
    task: ctx => withExtra(
      `这是《${ctx.projectName}》${chapterLabel(ctx)}的片段润色任务${ctx.focus ? `（${ctx.focus}）` : ''}。\n` +
      '请润色【待润色片段】：保留原意、事件顺序与人物口吻，去掉 AI 腔、空泛形容词与重复句式。\n' +
      '- 不要扩写剧情、不要新增设定、不要改变人称与叙事视角。\n' +
      '- 只输出润色后的片段正文，不要解释改了哪里（微调说明放第二部分）。',
      ctx.extraInstruction,
    ),
  },
  {
    id: 'outline-expand',
    name: '大纲 / 细纲推演',
    shortName: '推演',
    mount: 'src/components/outline/OutlineSheet.tsx',
    recommendedKind: 'full',
    injectDeAi: false,
    needsBase: true,
    materialHint: '全书总纲 + 当前分卷定位/卷纲 + 前后章细纲 + 相关核心角色与未回收伏笔',
    outputHint: '第一部分是可采纳的章纲/细纲文本，可复制或填入细纲草稿；不会自动覆盖已有细纲。',
    task: ctx => withExtra(
      `这是《${ctx.projectName}》的大纲 / 细纲推演任务（当前定位：${chapterLabel(ctx)}）。\n` +
      '请结合总纲、卷纲、相邻章细纲、核心角色与未回收伏笔，推演并给出本章可执行的细纲。\n' +
      '输出内容依次为：章节标题、本章一句话事件、本章功能、出场人物、分场景（3～5 个，每个 1～2 句）、章末钩子。\n' +
      '- 只给细纲文本，不写正文。\n' +
      '- 不要声称已经修改项目数据；是否采纳由作者决定。',
      ctx.extraInstruction,
    ),
  },
  {
    id: 'continuity-audit',
    name: '连续性找茬',
    shortName: '找茬',
    mount: 'src/components/audit/CheckTools.tsx',
    recommendedKind: 'full',
    injectDeAi: false,
    needsBase: true,
    materialHint: '待检正文 + 世界观红线 + 角色按章状态 + 物品流转 + 伏笔台账',
    outputHint: '第一部分是矛盾清单，可一键复制留存；本模式不打分、不排名、不评级。',
    task: ctx => withExtra(
      `这是《${ctx.projectName}》${chapterLabel(ctx)}的连续性找茬任务。\n` +
      '请逐条列出【待检正文】与下方设定资料之间的事实矛盾。\n' +
      '每条只写三样：矛盾描述 / 设定依据（资料中的原句或字段）/ 正文原句。\n' +
      '🔴 不要评分、不要排名、不要评级、不要评判文笔好坏、不要给修改建议；\n' +
      '   没有发现事实矛盾就明确写「未发现事实矛盾」。',
      ctx.extraInstruction,
    ),
  },
  {
    id: 'bio-organize',
    name: '角色小传整理',
    shortName: '小传',
    mount: 'src/components/world/CharacterBioPage.tsx',
    recommendedKind: 'delta',
    injectDeAi: false,
    needsBase: false,
    materialHint: '指定角色卡 + 既有小传正文/节点 + 出场章节片段 + 按章状态演变',
    outputHint: '第一部分是小传正文（可整篇替换或复制）；第二部分里程碑节点去重后勾选追加。',
    task: ctx => withExtra(
      `这是《${ctx.projectName}》的角色小传整理任务${ctx.focus ? `（角色：${ctx.focus}）` : ''}。\n` +
      '请依据角色卡、既有小传、出场章节与状态演变，整理该角色的人物小传正文，并提炼可追加的里程碑节点。\n' +
      '- 第一部分：完整小传正文，按时间顺序客观叙述，不编造资料之外的事件。\n' +
      '- 第二部分：只列**本次新增**的里程碑节点（已有节点不要重复）。\n' +
      '- 不要修改角色卡上的既有字段；是否采纳由作者逐条勾选。',
      ctx.extraInstruction,
    ),
  },
]

const SCENE_MAP = new Map<WcpSceneId, WcpScenario>(WCP_SCENARIOS.map(s => [s.id, s]))

export function getWcpScenario(id: WcpSceneId): WcpScenario {
  return SCENE_MAP.get(id) ?? WCP_SCENARIOS[0]
}

/** 渲染 `<wcp_task>` 段正文 */
export function renderTaskPrompt(id: WcpSceneId, ctx: WcpTaskContext): string {
  return getWcpScenario(id).task(ctx)
}

/**
 * 常驻底包的任务段。
 *
 * 🔴 底包不是「一次任务」，而是给 Gemini Gem / Claude Project 的长期背景；
 *   若沿用续写任务，网页模型会把每一次普通对话都当成「接着写第 N 章」。
 */
export function renderBaseTask(projectName: string): string {
  return `这是《${projectName || '未命名作品'}》的常驻设定资料包。\n` +
    '请把它当作本对话的长期背景资料保存；之后每个具体任务会另附「增量包」与明确指令。\n' +
    '- 资料中的设定、人物状态与物品持有关系，以最新一次增量包为准；若与本底包冲突，以增量包为准。\n' +
    '- 不要仅凭本包自行续写正文；请等待作者给出具体任务。'
}

/** 底包的输出契约：明确「本包不含输出任务」，避免模型误触发双段格式 */
export const WCP_BASE_CONTRACT =
  '本包不含具体输出任务，不需要按双段格式回答。\n' +
  '收到后续任务包（含 <wcp_task> 与 <wcp_output_contract>）时，按那个包的契约执行。\n' +
  '在只收到本包时，如作者提问，请只回答与作品设定相关的问题，不要自行扩写正文。'

// ---------- 输出契约 ----------

const JSON_CONTRACT = [
  '第一段（Part 1）放在 <<<WCP_BODY_START>>> 与 <<<WCP_BODY_END>>> 之间：只放纯净结果正文，不要夹带寒暄或解释。',
  '第二段（Part 2）放在 <<<WCP_CHANGES_START>>> 与 <<<WCP_CHANGES_END>>> 之间：只放一个严格 JSON 对象。',
  '',
  'JSON 结构（没有内容的数组给空数组 []，不要省略字段）：',
  '{',
  '  "entities": [{"name": "条目名", "type": "人物|地点|物品|势力|制度|其他", "summary": "一句话事实", "evidence": "正文原句"}],',
  '  "statusChanges": [{"character": "角色名", "before": "原状态", "after": "新状态", "quote": "正文原句"}],',
  '  "resourceTransfers": [{"item": "物品名", "from": "原持有者", "to": "新持有者", "action": "获得|失去|转移|消耗", "quote": "正文原句"}],',
  '  "foreshadows": [{"code": "伏笔编号（未知留空）", "action": "埋设|回收", "content": "伏笔内容"}],',
  '  "relations": [{"charA": "人物A", "charB": "人物B", "change": "关系变化说明", "quote": "正文原句"}],',
  '  "bioNodes": [{"character": "角色名", "title": "节点标题", "summary": "事件经过", "tag": "成长突破|关系转折|高光时刻|重大失去|身份变化|前传背景|其他", "evidence": "正文原句"}]',
  '}',
  '',
  '🔴 evidence / quote 必须逐字摘自 Part 1 或本次提供的正文；本地会做引文核验，对不上的条目不会入库。',
  '🔴 只列资料与正文里真实发生的变动；没有变化就给空数组，不要为了凑格式虚构。',
]

const MARKDOWN_CONTRACT = [
  '第一段（Part 1）放在 <<<WCP_BODY_START>>> 与 <<<WCP_BODY_END>>> 之间：只放纯净结果正文。',
  '第二段（Part 2）放在 <<<WCP_CHANGES_START>>> 与 <<<WCP_CHANGES_END>>> 之间：用下面的固定三级标题分块。',
  '没有内容的分块保留标题、下方写「（无）」，不要删标题。',
  '',
  '### 新登场设定',
  '- 名称（类型）：一句话事实｜依据：「正文原句」',
  '',
  '### 角色状态变动',
  '- 角色：原状态 → 新状态｜依据：「正文原句」',
  '',
  '### 物品流转',
  '- 物品：动作（从 → 到）｜依据：「正文原句」',
  '',
  '### 伏笔推进',
  '- [埋设/回收] 编号（未知留空）· 内容',
  '',
  '### 关系与里程碑',
  '- 人物A × 人物B：关系变化｜依据：「正文原句」',
  '- 里程碑：角色 · 节点标题（节点类型）：事件经过｜依据：「正文原句」',
  '',
  '🔴 依据里的引文必须逐字摘自 Part 1 或本次提供的正文；只列真实发生的变动。',
]

/**
 * 渲染 `<wcp_output_contract>` 段正文。
 *
 * `scene` 目前只用于「审校 / 推演」这类无设定变更场景的措辞微调；
 * 保留参数是为了以后按场景收窄 JSON 字段，而不是每个场景各抄一份契约。
 */
export function renderOutputContract(format: WcpSummaryFormat, scene: WcpSceneId = 'chapter-continue'): string {
  const head = format === 'json'
    ? '【输出格式：双段式 + JSON 变动摘要】'
    : '【输出格式：双段式 + 固定 Markdown 清单】'
  const lines = format === 'json' ? JSON_CONTRACT : MARKDOWN_CONTRACT
  const tail = scene === 'continuity-audit'
    ? '\n\n🔴 本任务只列事实矛盾；不评分、不排名、不评级。'
    : scene === 'outline-expand'
      ? '\n\n🔴 第一部分只给细纲文本，不要自动宣称已写入项目。'
      : ''
  return `${head}\n${lines.join('\n')}${tail}`
}

/** 双段标记的完整示例（管理页「试解析台」的占位提示用） */
export function wcpContractSample(format: WcpSummaryFormat): string {
  return format === 'json'
    ? `${WCP_BODY_START}\n（这里放纯净结果正文）\n${WCP_BODY_END}\n\n${WCP_CHANGES_START}\n{"entities":[],"statusChanges":[],"resourceTransfers":[],"foreshadows":[],"relations":[],"bioNodes":[]}\n${WCP_CHANGES_END}`
    : `${WCP_BODY_START}\n（这里放纯净结果正文）\n${WCP_BODY_END}\n\n${WCP_CHANGES_START}\n### 新登场设定\n- （无）\n\n### 角色状态变动\n- （无）\n\n### 物品流转\n- （无）\n\n### 伏笔推进\n- （无）\n\n### 关系与里程碑\n- （无）\n${WCP_CHANGES_END}`
}