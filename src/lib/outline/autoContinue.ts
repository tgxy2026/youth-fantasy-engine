/**
 * 逐章连写 + 设定补完 编排逻辑（纯逻辑，无 React 依赖）。
 *
 * 归属（2026-09-19 起）：「AI 一键续写 + 设定补完」已并入「创意写作」，本文件是那条流水线里
 * **逐章连写**与**设定补完**的执行体 —— `aiWorkflow.runCreativeWriting` 的两个起点（从零创作 /
 * 接着已有内容写）都调它，所以它自己不认识"起点"，只管"接着库里的最后一章往下写一章"。
 * 单章流程：读上下文 → 续写初稿 → 字数校准 →（可选）去 AI 味儿 → 作者裁决 → 编辑自检 → 落库 → 抽取补登设定。
 *
 * 设计红线（详见 docs/一键续写与设定补完功能方案.md）：
 * - 生成与落盘分离：正文是纯字符串只进 Chapter.content；设定是另一条结构化通道。
 * - 每章独立 uid()，saveChapter 按 id upsert，绝不写到别的章；顺序由 chapterSeq 派生，永不解析标题。
 * - 设定补登：classify 三档判重 + commitEntities 只写安全字段（名称/描述/首现章/编号），其余留空。
 * - 编辑自检单轮改写（≤2 轮约束内），接受不完美退出，杜绝 self-refine 死循环。
 * - 章节数 1–5、字数 2000–8000 汉字；成品必须落在「目标 ± WORD_TOLERANCE」区间（既补也压）。
 * - ⚠️ 落库硬闸门：正文汉字数不达 minValidWords 一律丢弃重生成，绝不落库
 *   （历史 bug：stripThink 对未闭合 <think> 会「从标签起全部丢弃」，若对累加文本反复剥离，
 *    先前攒的正文会被整段砍掉只剩残余标点 —— 故 ① 只对单次返回剥离 ② 落库前必校验字数）。
 * - 每章初稿先交作者裁决（采纳/重写/中止），采纳后才进入审查修正与设定补登。
 */
import * as db from '@/lib/db'
import { writerBudgetFor } from '@/lib/ai/aiWriterBudget'
import { uid } from '@/lib/app/id'
import { countWords } from '@/lib/editor/textStats'
import { requireProviderFor, isCancelled, stripThink } from '@/lib/ai'
import type { CallRequestContext } from '@/lib/ai/callTracking'
// 3.2.0 · W3 种子：把「候选产出/采纳/丢弃」记进运行账本（此前 AiRun.candidates 无生产者）
import { noteCandidate } from '@/lib/ai/aiRunLedger'
// 3.2.0 · WQ6：批次/步骤总请求预算（补字循环 + 自检 + 设定整理一起计入）
import { createAttemptBudget, CHAPTER_ATTEMPT_BUDGET, type AttemptBudget } from '@/lib/ai/requestLedger'
// 3.2.0 · W4（A 策略）：有实质发现的检查才落库，双闸淘汰（每任务 5 份 / 每项目 200 份 / 32 MiB）
import { persistCheckReports, type CheckRunLike } from '@/lib/revision/checkReports'
import { hashOf } from '@/lib/semantic/chunk'
// 3.2.0 · WQ8：抽取证据的原文核验（编造的证据比没有证据更糟）
import { checkEntityEvidence, describeEvidence } from '@/lib/ai/evidenceCheck'
import { withAiAssist } from '@/lib/ai/aiAssist'
// 🔴 「补写 / 压缩到目标字数」的校准逻辑已抽到 `lib/wordRange.ts`（整章改写侧也要用它，
//    而那边不能 import 本文件 —— 会与 aiTasks 门面形成循环）。这里再导出一次常量，
//    只为**保持既有 import 路径可用**（面板仍从本文件取 `WORD_TOLERANCE`）。
import { ask, askSoft, enforceWordRange, WORD_TOLERANCE, type Cfg } from '@/lib/editor/wordRange'
export { WORD_TOLERANCE }
import { parseObjectArrayDetailed, asText } from '@/lib/ai/aiParse'
import { authorBlock, newAuthorFence } from '@/lib/ai/promptGuard'
import { buildProjectContext, type ProjectContextResult } from '@/lib/ai/aiContext'
import {
  aiExtractSettingEntitiesWithStatus,
  aiContinuityAuditWithStatus, aiOocCheckWithStatus, aiForeshadowReviewWithStatus,
  aiRewritePassage, aiChapterSummary, cleanChapterOutput,
} from '@/lib/ai/aiTasks'
import type { Coverage, StepExecutionResult, StepResultState } from '@/lib/revision/revisionTypes'
import { classify, commitEntities, loadRegistry, normName, type LedgerItem } from '@/lib/settings/settingLedger'
import { sortChapters, chapterSeqOf } from '@/lib/outline/chapterSeq'
import { loadDraftMappingContexts, type DraftMappingContext } from '@/lib/flow/draftMapping'
import { resolveSemanticWrite } from '@/lib/templates/semanticWrite'
import { deAiGenerateRule, deAiPolishClause } from '@/lib/ai/deAiStyle'
import { activeFingerprintNote } from '@/lib/ai/styleFingerprint'
import { syncChapterMaster } from '@/lib/outline/chapterMaster'
import type { Chapter } from '@/lib/types'
import { registerPrompt } from '@/lib/ai/promptSettings'

/** 「设定更新侦测」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_setting_update_detect = `你是设定更新侦探。对比本章正文与已有设定，找出"对已有设定实体的新信息/状态变化"（如角色修为提升、关系变化、物品被获得或损毁、地点状态改变等）。
返回 JSON 数组，元素形如 {"name":"实体名(必须与已登记名完全一致)","note":"一句话描述变化，如 修为提升至凝气四层"}。
只报确有文本依据的，最多 10 条，没有则返回 []。只输出 JSON 数组，不要解释、不要 markdown 代码块。`

/** 已有设定更新策略（创建任务时由用户选择） */
export type ContinueStrategy = 'add-only' | 'confirm' | 'auto-update'

/** 同一章初稿最多尝试次数（作者重写 + 异常重生成共用此上限） */
const MAX_DRAFT_ATTEMPTS = 8
/** 落库硬闸门：低于此汉字数视为模型异常返回，丢弃重生成 */
function minValidWords(target: number): number {
  return Math.min(600, Math.max(200, Math.round(target * 0.2)))
}

/**
 * 去 AI 味儿：内置的润色提示词库（即"网络上常见的去味儿 skill"的内置化版本）。
 * 每条都是纯提示词模板，运行时由 AI 接口执行；用户可在续写面板选择其一，或粘贴自定义提示词。
 * 这样就把外网的"去 AI 味儿 skill"以「提示词库」的形式内置进程序，随版本发布、可切换、可扩展。
 */
export interface DeAiTemplate { id: string; label: string; desc: string; prompt: string }
export const DEAI_TEMPLATES: DeAiTemplate[] = [
  {
    id: 'natural', label: '口语化', desc: '去套路、加生活感，像人写的',
    prompt: '把正文改得更自然、更像活人顺手写下来的网文：\n1. 砍掉「眸中闪过一丝 / 嘴角勾起一抹 / 心中暗道 / 缓缓 / 微微 / 不禁」这类神态与副词模板；成片的「突然 / 瞬间 / 霎时」砍掉六成。\n2. 拆掉对称排比与成语堆砌（连续三句同结构必改；三条并列砍成一条，或加到四条）。\n3. 「他感到…」「她意识到…」改成动作、身体感受或一句台词 —— 情绪要演出来，不要贴标签。\n4. 打散段落节奏：有的段一两句、有的七八句；长句短句错开，别每段都是三到五句。\n5. 加一点「无意义但真实」的生活细节与细碎体感（触觉、气味、耳边杂音），删掉空洞的心理独白。\n6. 段末不要总结升华，收在一个具体动作或一句台词上。\n保持情节、人设、视角、章末钩子完全不变。',
  },
  {
    id: 'webnovel', label: '网文化', desc: '明快、对话推动、钩子更勾',
    prompt: '把正文改得更像成熟网文：\n1. 节奏明快，多用短句与对话推进，减少大段说明性叙述与冗长的环境铺陈。\n2. 对话加省略、停顿、半句话、口头禅与潜台词 —— 真人说话不会句句滴水不漏。\n3. 强化冲突与信息差，让每屏都有「接下来会怎样」；去掉「就在这时 / 然而下一刻」这种套路转折，换成情节本身的反转。\n4. 章末钩子更利落、更勾人，别用「这一切，才刚刚开始」这类套话收尾。\n5. 每 300 字至少有一处五感细节，别只给概括。\n6. 去除 AI 常见的平衡工整表达，让文字带点作者个人脾气。\n保持人设与情节结构不变。',
  },
  {
    id: 'literary', label: '去套路', desc: '保留文采但去陈词滥调',
    prompt: '在保留原有文采的前提下去除 AI 套路：\n1. 替换陈词滥调与网络烂梗（「像刀子一样锋利」「仿佛能穿透一切一般」），换成与人物背景相关的新鲜意象。\n2. 减少「仿佛 / 似乎 / 宛如」等廉价比况的堆叠 —— 一段里出现两次以上必改。\n3. 「带着一丝…」式万能状语、「这一刻他终于明白…」式段末升华，能删就删。\n4. 避免每段都用相同的递进结构；偶尔插一句题外话或自我修正，让叙述像真人在想事。\n5. 让叙述视角更稳、语气更统一，把情绪藏进动作与细节里。\n⚠️ 这是「候选清单」不是删除令：确有必要、换了反而伤文风的词句照旧保留。\n保持情节结构不变。',
  },
  { id: 'custom', label: '自定义', desc: '粘贴你自己的去味儿提示词', prompt: '' },
]

/** 每章初稿快照，交作者裁决 */
export interface ChapterDraft {
  index: number
  total: number
  attempt: number
  body: string
  words: number
  target: number
}
export type DraftDecision = 'accept' | 'rewrite' | 'abort'

export interface ContinueCallbacks {
  onPhase?: (p: string) => void
  onBodyToken?: (delta: string) => void
  /** 正文经字数校准/改写后整体替换预览（流式增量已失真时用它纠正） */
  onBodyReplace?: (full: string) => void
  onChapterSaved?: (ch: { id: string; title: string; no: number }) => void
  /** 每章初稿完成后征询作者：采纳 / 重写 / 中止。不提供则自动采纳 */
  onChapterDraft?: (d: ChapterDraft) => Promise<DraftDecision>
  /** B 策略：返回用户勾选的待补登项；返回 null 表示跳过本次补登 */
  onSettingsCandidates?: (cands: LedgerItem[]) => Promise<LedgerItem[] | null>
  /**
   * 「创意写作」用：给出指定章号的细纲文本（来自大纲阶段落库的《章节细纲》）。
   * 有则注入本章 prompt 末段，让逐章连写「按大纲走」而不是自由发挥。
   * 不传 = 一键续写的老行为（完全不受影响）。
   */
  outlineFor?: (chapterNo: number) => string | undefined
  /**
   * 「创意写作」用（2.5.2 · A2）：本批选中的**作者灵感**（来自灵感夹，启动时快照的文本数组）。
   * 有则以「作者灵感」段注入本章 prompt（细纲段**之前**——细纲钉在末段权重最高）。
   * 🔴 口径：灵感是作者手记，段头明确「供参考、不要求全部体现、与细纲冲突以细纲为准」，
   *    防止模型机械硬凑灵感原文（与 2.5.1 A3「融合≠拼接」同源的风险）。
   * 不传 / 返回空 = 完全不注入（老行为不受影响）。
   */
  inspirationsFor?: () => string[]
  /**
   * 「创意写作」长篇分批用：给出**第几章**该落进哪个卷（卷记录 id）。
   *
   * 🔴 为什么必须由调用方给：`createChapterAfter` 默认把新章塞进**锚点所在的卷** ——
   *    大纲排了卷一（第1-20章）与卷二（第21-40章），写到第 21 章时它仍会留在卷一，
   *    卷归属与大纲对不上（2026-09-20 修）。
   *    返回 undefined = 该章没有对应的卷范围 → 退回旧行为（不瞎猜）。
   */
  volumeIdFor?: (chapterNo: number) => string | undefined
  onLog?: (msg: string) => void
  signal?: AbortSignal
  /** 请求归属（3.2.0 · WQ7）：每章 3~8 次模型调用，是全项目调用量最大的链路 */
  request?: CallRequestContext
}

interface SettingUpdate { name: string; note: string }
// 「单次问答 ask / 软失败 askSoft」与 `Cfg` 类型已迁到 `lib/wordRange.ts`
// （它们服务于字数校准，而校准是两个模块共用的，见那边的模块说明）。

// ============ 提示词 ============

function buildSysPrompt(target: number, chapterNo?: number, fpNote?: string): string {
  const lo = target - WORD_TOLERANCE
  const hi = target + WORD_TOLERANCE
  /** 范围表述：带章号时明确「第 N 章」，否则泛指「这一章」（一键续写等无章号场景） */
  const scope = chapterNo ? `第 ${chapterNo} 章` : '这一章'
  return [
    '你是长篇网络小说的续写助手。请基于作者已有的世界观、角色与剧情，续写下一章正文。',
    '硬性约束：',
    `1. 篇幅必须落在 ${lo}~${hi} 个汉字之间（按汉字个数计，不含标点与英文单词）。写得过长与过短同样视为不合格，请自行规划详略与场景数量：先估算要写几个场景，再分配篇幅。`,
    '2. 必须严格承接【上一章结尾】的场景、时间、地点、人物位置与情绪，从紧接着的下一刻写起。不得跳场景、不得另起新线、不得重述前情、不得写"数日后/数月后"这类大跨度跳跃（除非作者在续写意图中明确要求）。',
    '3. 严格贴合已写章节的叙事视角、人称、文风与人设，保持既有爽文节奏；章末留一个能勾住读者的钩子，但**只留悬念、不写下一章的内容**。',
    '4. 只输出正文本身。不要任何解说、不要小标题、不要章节号、不要"以下是续写"之类的开场白，也不要输出思考过程。',
    '5. 若作者给了【续写意图】则优先沿其推进；未给则严格沿着上一章结尾的既有走向自然延续，聚焦当前尚未解决的冲突与悬念，不要凭空引入与前文无关的新地图、新势力或新金手指。',
    // 🔴 6 这条是 2026-10-03 社区反馈（「只让写第 1 章，AI 却把第 2 章细纲的内容写了进来」）
    //    的**预防性加固**：原先 5 条硬约束里没有一条限制章节边界，而第 3 条还在鼓励
    //    「留个勾住读者点下一章的钩子」—— 模型在钩子处往前迈一步是迟早的事。
    //    实机 4 轮（DeepSeek-V3.2 / Qwen3.5-35B-A3B，各 2 轮）**未能复现**越界，
    //    但提示词缺护栏本身就是隐患：约束要写在明处，不能靠模型自觉。
    `6. 🔴 本次只写${scope}：「写完本章就收尾」。不得写出下一章的任何内容 —— 不写下一章的开头、不提前展开下一章的事件 / 场景 / 人物动作、不让本章结尾的冲突直接跨进下一章。篇幅不够时，用本章内的场景展开、对话、细节与心理描写补足，绝不靠「推进下一章情节」来凑字数。`,
    // 🔴 文风档（#015）插在去 AI 味纪律**之前**（deAi 必须钉在最末）。
    //    空档时不塞这一段（数组里连空串都没有），初稿 system 与改造前逐字一致。
    ...(fpNote ? ['', fpNote] : []),
    // 🔴 去 AI 味纪律钉在最末（埋中段效果约等于 0）。它挂在**初稿**而不只是后置润色：
    //    先写出一股 AI 腔再去洗，不如一开始就按人的写法写（2.6.4 社区反馈「去味儿效果不理想」的主因）。
    '',
    deAiGenerateRule('full'),
  ].join('\n')
}

// ============ 去 AI 味儿（生成初稿后的语言润色） ============

const DEAI_SYS = [
  '你是资深文字润色编辑，专门把 AI 生成的小说正文改得更自然、更有人味、更像职业网文作者手笔。',
  '原则（必须严格遵守）：',
  '1. 保持原文的人物、情节、对话、结构、视角、人称、章末钩子完全不变，只做语言层面的润色，绝不增删情节、不改结局。',
  '2. 保持原文字数规模基本不变（允许 ±10% 浮动），不要注水也不要过度压缩。',
  '3. 只输出润色后的正文本身，不要任何解释、不要小标题、不要开场白。',
  '',
  // 去 AI 味判据（与上面三条原则同等重要）—— 单一真源在 lib/deAiStyle.ts
  '【去 AI 味判据】',
  deAiPolishClause(),
].join('\n')

async function deAiFlavor(o: {
  cfg: Cfg
  body: string
  instruction: string
  signal?: AbortSignal
  onToken?: (d: string) => void
  onBodyReplace?: (s: string) => void
  request?: CallRequestContext
}): Promise<string> {
  return askSoft(o.cfg,
    `${DEAI_SYS}\n\n【本次润色侧重点】\n${o.instruction}`,
    ['【待润色正文】', authorBlock(newAuthorFence(), o.body)].join('\n'),
    {
      signal: o.signal, onToken: o.onToken,
      ...(o.request ? { request: o.request } : {}),
    })
}

// ============ 单章生成 ============

async function generateOneChapter(opts: {
  ctx: ProjectContextResult
  prevTail: string
  intent?: string
  /** 最近 3 章的章节摘要（title+字数+summary 拼接），供 AI 把握整体剧情走向 */
  recentSummaries?: string
  targetWords: number
  /** 本次要写的章号（写进提示词做范围限定；不传则只说「这一章」）。 */
  chapterNo?: number
  signal?: AbortSignal
  request?: CallRequestContext
  /** 本章请求预算（3.2.0 · WQ6）：补字/压缩循环到上限就停，不嵌套追加 */
  budget?: AttemptBudget
  onToken?: (d: string) => void
  onPhase?: (p: string) => void
  onBodyReplace?: (s: string) => void
  onLog?: (s: string) => void
}): Promise<string> {
  const cfg = await requireProviderFor('create')
  const sys = buildSysPrompt(opts.targetWords, opts.chapterNo, await activeFingerprintNote())
  const lo = opts.targetWords - WORD_TOLERANCE
  const hi = opts.targetWords + WORD_TOLERANCE
  // 作者内容是「不可信文本」：统一用同一边界语言包裹（内容一字不改，见 promptGuard 头部说明）
  const fenceId = newAuthorFence()
  const user = [
    '【作品设定资料】',
    opts.ctx.text ? authorBlock(fenceId, opts.ctx.text) : '（暂无设定资料，按通用网文逻辑续写）',
    '',
    '【上一章结尾】（必须从这里紧接着往下写）',
    opts.prevTail ? authorBlock(fenceId, opts.prevTail) : '（本项目还没有正文，这是开篇第一章）',
    '',
    '【近期章节概要】（最近 3 章，供把握整体剧情走向，非续写对象）',
    opts.recentSummaries || '（暂无）',
    '',
    '【续写意图】',
    opts.intent?.trim() || '（作者未指定：请严格沿着上一章结尾的既有走向自然延续，聚焦当前尚未解决的冲突与悬念，不要开新线）',
    '',
    `请续写下一章正文，篇幅 ${lo}~${hi} 汉字。` +
    (opts.chapterNo
      ? `\n🔴 本次只写第 ${opts.chapterNo} 章，写完这一章就收尾 —— 下一章的内容一个字都不要写。`
      : '\n🔴 本次只写这一章，写完就收尾 —— 不要写出下一章的内容。'),
  ].join('\n')

  let body = await ask(cfg, sys, user, {
    signal: opts.signal, onToken: opts.onToken,
    ...(opts.request ? { request: opts.request } : {}),
  })
  opts.budget?.consume(1)

  // 异常返回（模型抽风 / 思维链剥离后只剩残片）→ 静默重试一次，不再流式以免污染预览
  if (countWords(body) < 50) {
    opts.onLog?.(`模型返回异常（仅 ${countWords(body)} 汉字），正在重试`)
    opts.onBodyReplace?.('')
    body = await askSoft(cfg, sys, user, {
      signal: opts.signal, ...(opts.request ? { request: opts.request } : {}),
    })
    opts.budget?.consume(1)
    opts.onBodyReplace?.(body)
  }

  return (await enforceWordRange({
    cfg, body, target: opts.targetWords, sys, chapterNo: opts.chapterNo,
    signal: opts.signal, onToken: opts.onToken,
    ...(opts.request ? { request: opts.request } : {}),
    onPhase: opts.onPhase, onBodyReplace: opts.onBodyReplace,
  })).trim()
}

/** 编辑自检：连续性 / 人设崩坏 / 伏笔 三类检查，命中严重/中等则单轮改写后接受不完美退出 */
/**
 * WQ1-2（3.2.0）：连写自检的结果形状。
 *
 * 🔴 `selfCheck.state !== 'completed'` 时调用方**必须暂停后续自动应用**：
 *    三项审校是「本次已启用且承诺执行的必选项」，请求失败 / 解析失败 /
 *    取消都不是"审了没问题"。草稿保留在编辑器，由作者重试或明确跳过。
 */
export interface SelfRefineResult {
  body: string
  selfCheck: StepExecutionResult<RefineFinding[]>
}

/** 自检三项的共同 Finding 形状（只按 level 过滤，其余字段原样带过） */
type RefineFinding = { level?: string }

/**
 * WQ1-2 纯汇总：把三项审校的运行结果压成一条（可单测，无 IO）。
 *
 * 规则（§16.2）：
 *   · 全部 completed（**含合法空 findings**）⇒ completed —— 空也是"审了没问题"；
 *   · 任一 cancelled ⇒ cancelled（作者取消立即传播，不当成通过）；
 *   · 全部 failed ⇒ failed；部分失败 ⇒ partial —— 都不得显示"自检通过"。
 */
export function summarizeSelfCheck(
  runs: readonly StepExecutionResult<RefineFinding[]>[],
): StepExecutionResult<RefineFinding[]> {
  const requested = runs.length
  const completed = runs.filter(r => r.state === 'completed').length
  const failed = runs.filter(r => r.state === 'failed').length
  const cancelled = runs.filter(r => r.state === 'cancelled').length
  const coverage: Coverage = { requested, completed, failed, skipped: 0 }
  const bad = runs.filter(r => r.state !== 'completed')
  const issues = bad.map(r => `${r.sourceId ?? '检查'}:${r.errorCode ?? r.state}`)
  if (cancelled > 0) {
    return { state: 'cancelled', coverage, issues, errorCode: 'cancelled' }
  }
  if (failed === 0) {
    return { state: 'completed', coverage, sourceId: 'self-refine' }
  }
  if (failed === requested) {
    return { state: 'failed', coverage, issues, errorCode: runs[0]?.errorCode ?? 'all-checks-failed', retryable: true }
  }
  return { state: 'partial', coverage, issues, errorCode: 'some-checks-failed', retryable: true }
}

async function selfRefine(
  body: string, ctx: ProjectContextResult, signal?: AbortSignal,
  onPhase?: (p: string) => void, request?: CallRequestContext,
  budget?: AttemptBudget,
  /**
   * 计划章号（W4：检查报告要按章挂在工单上）。
   * 🔴 用章号而不是章 id：自检发生在 `createChapterAfter` **之前**，那时新章还没有 id。
   */
  chapterNo?: number,
): Promise<SelfRefineResult> {
  if (!ctx.text.trim() || countWords(body) < 200) {
    return { body, selfCheck: { state: 'completed', coverage: { requested: 0, completed: 0, failed: 0, skipped: 0 }, sourceId: 'self-refine-skipped' } }
  }
  // 3.2.0 · WQ6：三项自检 = 三次逻辑调用，先记账再发（预算耗尽时这里就该被上层拦住）
  budget?.consume(3)
  onPhase?.('AI 编辑自检（连续性 / 人设 / 伏笔）')
  const findings: RefineFinding[] = []
  const push = (arr: readonly RefineFinding[]) => {
    for (const f of arr) if (f && (f.level === '严重' || f.level === '中等')) findings.push(f)
  }
  // WQ1-2：三项都走**带状态**版本 —— 旧写法 `.catch(() => [])` 把请求失败
  // 吞成"无问题"，是 Q1 登记病灶（自检失败却显示通过）的直接成因。
  const runs = await Promise.all([
    aiContinuityAuditWithStatus(ctx.text, body, { signal, ...(request ? { request } : {}) }),
    aiOocCheckWithStatus(ctx.text, body, { signal, ...(request ? { request } : {}) }),
    aiForeshadowReviewWithStatus(ctx.text, { signal, ...(request ? { request } : {}) }),
  ])
  const selfCheck = summarizeSelfCheck(runs)
  // 3.2.0 · W4：检查报告落库（A 策略）—— 只存有「严重 / 中等」发现的；
  // 没有 taskId/projectId 时（老调用、无账本场景）**不硬塞**：挂不到任务上的报告没人看得到。
  // 🔴 旁路，绝不打断创作：`persistCheckReports` 内部不抛，这里再兜一层。
  if (request?.taskId && request.projectId) {
    await persistCheckReports({
      projectId: String(request.projectId),
      jobId: request.taskId,
      ...(chapterNo !== undefined ? { chapterNo } : {}),
      reports: [
        { checkId: 'continuity', source: '章节自检 · 连续性', run: runs[0] as unknown as CheckRunLike },
        { checkId: 'ooc', source: '章节自检 · 人设', run: runs[1] as unknown as CheckRunLike },
        { checkId: 'foreshadow', source: '章节自检 · 伏笔', run: runs[2] as unknown as CheckRunLike },
      ],
    }).catch(() => null)
  }
  if (selfCheck.state !== 'completed') {
    // 必选项失败/取消：不当成通过、不进入改写分支；调用方据此暂停连写
    onPhase?.(`编辑自检未完成（${selfCheck.issues?.join('；') || selfCheck.state}），本章不自动修正`)
    return { body, selfCheck }
  }
  for (const r of runs) push(r.result?.data ?? [])
  if (!findings.length) {
    onPhase?.('编辑自检通过，未发现严重问题')
    return { body, selfCheck }
  }
  onPhase?.(`根据 ${findings.length} 条审读问题改写修正`)
  const instr = findings.map(f => `- ${(f as { title?: string }).title || '问题'}：${(f as { detail?: string }).detail || ''}`).join('\n')
  // 2.9.2 · ②：`aiRewritePassage` 收 `RewriteAsk` 对象（编辑区传 5 个动作词，这里传自由文本）
  const res = await aiRewritePassage(body, { instruction: `修正以下审读问题，保持剧情与文风一致，不要改变原意：\n${instr}` }, '', { signal }).catch(() => null)
  const rw = res?.rewritten ? stripThink(res.rewritten).trim() : ''
  // 安全阀：改写结果显著缩水（不足原文 60%）视为模型偷懒或被截断，保留原文
  if (!rw || countWords(rw) < countWords(body) * 0.6) return { body, selfCheck }
  return { body: rw, selfCheck }
}

async function suggestTitle(body: string, signal?: AbortSignal, request?: CallRequestContext): Promise<string> {
  const cfg = await requireProviderFor('create').catch(() => null)
  if (!cfg) return '未命名章节'
  const snippet = body.slice(0, 1500)
  const sys = '你是网文编辑。请给这一章起一个简洁、有吸引力、不剧透的章节标题。要求：不含"第N章"前缀，不超过 15 个汉字，只输出标题本身，不要标点、不要引号、不要解释。'
  const t = await askSoft(cfg, sys, `【本章正文（节选）】\n${snippet}`, {
    signal, ...(request ? { request } : {}),
  })
  const clean = t.replace(/[「」"'》>、。！？\s]/g, '').slice(0, 15)
  return clean || '未命名章节'
}

// ============ 建章（顺序/台账同步，绝不手填卷章号） ============

async function createChapterAfter(
  anchorId: string | null, title: string, content: string, summary = '', volumeId?: string,
): Promise<Chapter> {
  const pid = db.getCurrentProjectId()
  const vols = await db.getAllVolumes()
  const chs = await db.getAllChapters()
  const anchor = anchorId ? chs.find(c => c.id === anchorId) : undefined
  // 🔴 优先用调用方指定的卷（长篇按大纲切卷：第 21 章必须进卷二）。
  //    先校验它**真实存在** —— 指定一个幽灵卷会把正文写进不存在的卷（数据事故）。
  const forced = volumeId && vols.some(v => v.id === volumeId) ? volumeId : undefined
  const targetVolId = forced ?? anchor?.volumeId ?? vols[vols.length - 1]?.id
  if (!targetVolId) throw new Error('项目中还没有卷，请先到「正文写作」创建至少一个卷再续写。')
  const volChs = chs.filter(c => c.volumeId === targetVolId)
  const order = volChs.length
  // 🔴 B3（2.4.1）：整章正文由 AI 续写产出 —— 记账（纯函数返回新对象，后续改 title 不受影响）
  const ch: Chapter = withAiAssist({
    id: uid(), projectId: pid, volumeId: targetVolId, order,
    title: title || '未命名章节', content, summary,
    status: '草稿', wordCount: countWords(content),
    createdAt: Date.now(), updatedAt: Date.now(),
  }, 'continued', countWords(content))
  // 派生本章序号并写入标题，使 AI 取的章名自动延续编号（如「第12章 风云突变」）；
  // 防御：先剥离 AI 可能自带的前导「第X章」，避免双重编号
  const no = chapterSeqOf(vols, [...chs, ch], ch.id)
  const cleanTitle = (title || '未命名章节').replace(/^第\s*\d+\s*章\s*/, '')
  ch.title = `第${no}章 ${cleanTitle}`
  await db.saveChapter(ch) // upsert by id，绝不覆盖别的章
  const [lv, lc] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
  await syncChapterMaster(ch, chapterSeqOf(lv, lc, ch.id))
  return ch
}

// ============ 设定抽取与补登（按策略） ============

/**
 * 抽取本章新设定并按策略补登 / 更新。
 *
 * 对外导出（2026-09-19）：整章改写改「最新章」后也要跑这套 —— 最新章后面还没正文，
 * 它的改动必须同步进设定表，否则下一次「接着写」会读到旧设定。
 */
export async function extractAndCommitSettings(
  body: string, title: string, strategy: ContinueStrategy,
  onConfirm?: (cands: LedgerItem[]) => Promise<LedgerItem[] | null>,
  signal?: AbortSignal,
  /**
   * 请求归属（3.2.0 · WQ7）。放在**末尾可选位**：改写侧（`chapterPostProcess` /
   * `optimizeTicket`）还是老调用，不传就是兼容归属，行为零变化。
   */
  request?: CallRequestContext,
  /**
   * 本步骤的请求预算（3.2.0 · WQ6）。
   * 🔴 设定整理也是逻辑调用：抽取 1 次、变化检测再 1 次。到上限就**跳过并如实说明**，
   *    不嵌套追加；不传 ⇒ 与改造前逐字一致。
   */
  budget?: AttemptBudget,
): Promise<{ created: number; failed: string[]; errors?: string[] }> {
  if (budget?.exhausted) {
    return {
      created: 0, failed: [],
      errors: [`${budget.label}的模型请求已达上限（${budget.used}/${budget.max}），设定整理已跳过`],
    }
  }
  // WQ1-4：解析失败/请求失败与"本章无新实体"分开 —— 失败要经 errors 上报，
  // 不再静默 return { created: 0 } 让 UI 显示"新增 0 条"像正常一样
  budget?.consume(1)
  const entRun = await aiExtractSettingEntitiesWithStatus(body, title, { signal, ...(request ? { request } : {}) })
  if (entRun.state !== 'completed') {
    return { created: 0, failed: [], errors: ['设定实体抽取未完整完成（' + (entRun.errorCode ?? entRun.state) + '）'] }
  }
  const entities = entRun.result?.data ?? []
  if (!entities.length) return { created: 0, failed: [] }
  // 3.2.0 · WQ8：核验「原文原句证据」是否真在正文里。
  // 🔴 只报告不丢弃：模型可能把两句合并转述，丢掉会丢真信息；但**编造的证据**必须让作者看见。
  const evidenceNote = describeEvidence(checkEntityEvidence(entities, body))
  const reg = await loadRegistry().catch(() => null)
  if (!reg) return { created: 0, failed: [] }
  const items = classify(entities, reg)
  const empty = { created: 0, failed: [] as string[] }
  // 3.2.0 · WT2：补登落点按**有效模板**解析（作者改名/同义自建字段后仍写对字段）。
  // 不传 pid 则沿用旧中文列名口径，所以这里必须把当前项目带上。
  const pid = db.getCurrentProjectId()

  if (strategy === 'add-only') {
    // 仅限新增：只补登新实体，绝不碰已登记设定
    const news = items.filter(i => i.status === 'new')
    const r = await commitEntities(news, title, { pid }).catch(() => empty)
    return {
      created: r.created, failed: r.failed,
      ...(evidenceNote ? { errors: [evidenceNote] } : {}),
    }
  }
  if (strategy === 'auto-update') {
    // 自动更新：新实体自动补登 + 对已登记实体的变化做安全写回（追加到备注类字段，绝不覆盖属性列）
    const news = items.filter(i => i.status === 'new')
    const r = await commitEntities(news, title, { pid }).catch(() => empty)
    // 变化检测是第二次逻辑调用：预算到顶就跳过，不硬打
    let w: { applied: number; state: StepResultState } = { applied: 0, state: 'failed' }
    let skippedByBudget = false
    if (budget?.exhausted) {
      skippedByBudget = true
    } else {
      budget?.consume(1)
      w = await applySettingUpdates(body, title, signal, request)
    }
    const errs = [
      ...(r.failed.length ? [] : []),
      ...(w.state === 'failed'
        ? [skippedByBudget ? '设定变化检测因请求预算到上限已跳过' : '设定变化检测失败（解析或请求异常）']
        : []),
      ...(evidenceNote ? [evidenceNote] : []),
    ]
    return { created: r.created, failed: r.failed, ...(errs.length ? { errors: errs } : {}) }
  }
  // confirm：把新实体与疑似重复项交给用户勾选
  const cands = items.filter(i => i.status === 'new' || i.status === 'duplicate')
  if (!cands.length) return empty
  const chosen = await onConfirm?.(cands)
  if (chosen && chosen.length) {
    const r = await commitEntities(chosen, title, { pid }).catch(() => empty)
    return {
      created: r.created, failed: r.failed,
      ...(evidenceNote ? { errors: [evidenceNote] } : {}),
    }
  }
  return evidenceNote ? { ...empty, errors: [evidenceNote] } : empty
}

// ============ C 策略：对已登记实体的变化做安全写回 ============

async function extractSettingUpdates(body: string, title: string, signal?: AbortSignal, request?: CallRequestContext): Promise<{ updates: SettingUpdate[]; state: StepResultState }> {
  const cfg = await requireProviderFor('create')
  const sys = P_setting_update_detect
  const text = await askSoft(cfg, sys, `【章节】${title || '（未命名章节）'}\n【本章正文】\n${body.trim() || '（空白）'}`, {
    signal, output: 'json-object', reasoning: 'off', ...(request ? { request } : {}),
  })
  // 统一走 aiParse：旧实现是裸 JSON.parse——不剥代码块、不切最外层，
  // 模型只要在 JSON 外套一句解释或 ```json 围栏，整条更新就被静默丢弃。
  // WQ1-4：三态 —— invalid（JSON 坏了）与合法空（无变化）分开上报。
  const parsed = parseObjectArrayDetailed(text)
  if (parsed.outcome === 'invalid') return { updates: [], state: 'failed' }
  const updates = parsed.data
    .filter(x => asText(x.name))
    .map(x => ({ name: asText(x.name), note: asText(x.note) }))
  return { updates, state: parsed.outcome === 'valid' ? 'completed' : 'partial' }
}

function pickNoteCol(data: Record<string, string>): string | null {
  for (const k of ['备注', '描述', '小传', '近况', '简介']) if (k in data) return k
  return null
}
function appendNote(existing: string | undefined, note: string): string {
  return (existing ? existing + '\n' : '') + note
}

/**
 * 备注落点（3.2.0 · WT2 §3.11「章后整理」）—— 把「续写备注」写到**真实字段**。
 *
 * 优先按**有效模板**的语义槽位解析（`note`＝命名备注，退而取 `desc`＝一句话描述），
 * 拿到的是模板给出的存储键；解析不到 / 没采用模板 ⇒ 沿用旧的「备注类列名」口径，
 * 老项目与老测试行为一个字节不变。
 *
 * 🔴 卡片（`char-*`）不套用 `desc` 槽位：那会把「续写备注」塞进「身份定位」这类语义栏，
 *    旧行为也从不写卡片备注列 —— 故只在模板显式绑定 `note` 槽位时才写卡片。
 */
function resolveNoteKey(
  ctx: DraftMappingContext | undefined, tabId: string, data: Record<string, string>, noteText: string,
): string | null {
  if (ctx) {
    const order = tabId.startsWith('char-') ? ['note'] : ['note', 'desc']
    for (const slot of order) {
      const wr = resolveSemanticWrite(ctx.template, ctx.plan, ctx.slots, { [slot]: noteText })
      const hit = wr.accepted.find(a => a.slot === slot)
      if (hit) return hit.fieldKey
    }
  }
  return pickNoteCol(data)
}
function findRegistered(reg: Awaited<ReturnType<typeof loadRegistry>>, name: string): { tabId: string; id: string } | null {
  const target = normName(name)
  if (!target) return null
  for (const list of Object.values(reg)) {
    for (const e of list) {
      if (normName(e.name) === target) return { tabId: e.tabId, id: e.id }
      if (e.aliases?.some(a => normName(a) === target)) return { tabId: e.tabId, id: e.id }
    }
  }
  return null
}

async function applySettingUpdates(
  body: string, title: string, signal?: AbortSignal, request?: CallRequestContext,
): Promise<{ applied: number; state: StepResultState }> {
  // WQ1-4：解析失败（JSON 坏）不再静默 return —— 调用方（auto-update 分支）记录到日志
  let run: { updates: SettingUpdate[]; state: StepResultState }
  try {
    run = await extractSettingUpdates(body, title, signal, request)
  } catch {
    return { applied: 0, state: 'failed' }
  }
  const updates = run.updates
  if (!updates.length) return { applied: 0, state: run.state }
  const reg = await loadRegistry().catch(() => null)
  if (!reg) return { applied: 0, state: run.state }
  // 有效模板映射上下文：按「本条实际写到的页签」惰性读一次并缓存（读失败 ⇒ 该页签沿用旧口径）
  const ctxCache = new Map<string, DraftMappingContext | null>()
  const ctxOf = async (tabId: string): Promise<DraftMappingContext | undefined> => {
    if (ctxCache.has(tabId)) return ctxCache.get(tabId) ?? undefined
    const map = await loadDraftMappingContexts(db.getCurrentProjectId(), [tabId]).catch(() => new Map<string, DraftMappingContext>())
    const ctx = map.get(tabId) ?? null
    ctxCache.set(tabId, ctx)
    return ctx ?? undefined
  }
  for (const u of updates) {
    const hit = findRegistered(reg, u.name)
    if (!hit) continue
    try {
      if (hit.tabId.startsWith('char-')) {
        const recs = await db.getCardRecords(hit.tabId)
        const rec = recs.find(r => r.id === hit.id)
        if (rec) {
          const line = `[续写·${title}] ${u.note}`
          const col = resolveNoteKey(await ctxOf(hit.tabId), hit.tabId, rec.data, line)
          if (col) { rec.data[col] = appendNote(rec.data[col], line); await db.saveCardRecord(rec) }
        }
      } else {
        const rows = await db.getTableRows(hit.tabId)
        const row = rows.find(r => r.id === hit.id)
        if (row) {
          const line = `[续写·${title}] ${u.note}`
          const col = resolveNoteKey(await ctxOf(hit.tabId), hit.tabId, row.data, line)
          if (col) { row.data[col] = appendNote(row.data[col], line); await db.saveTableRow(row) }
        }
      }
    } catch { /* 单条失败不影响整体 */ }
  }
  return { applied: updates.length, state: run.state }
}

// ============ 顶层编排（L2 多章循环） ============

/**
 * 「作者灵感」注入段（2.5.2 · A2）——**纯函数**，单测直接喂字符串。
 *
 * 段头口径是产品决定：灵感是作者手记，注入时明确「供参考、不要求全部体现、
 * 与细纲冲突以细纲为准」——防模型机械硬凑（与 2.5.1 A3「融合≠拼接」同源风险）。
 * 空数组 / 全空串 → 返回空串（整段不出现，不产生空标题）。
 */
export function inspirationBlock(inspirations: string[]): string {
  const items = inspirations.map(s => (s ?? '').trim()).filter(Boolean)
  if (items.length === 0) return ''
  return `\n【作者灵感（供参考，不要求全部体现；与本章细纲冲突时以细纲为准）】\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
}

export async function runAutoContinue(
  opts: {
    chapters: number; targetWords: number; strategy: ContinueStrategy; intent?: string;
    /** 去 AI 味儿：生成初稿后自动润色一遍再去弹窗交作者裁决；enabled=false 或 prompt 为空则跳过 */
    deAi?: { enabled: boolean; prompt: string }
    /**
     * 🔴 **正文缺口优先**：开写新章之前，先把**最后一章**补到目标字数（2026-09-20）。
     *
     * 【为什么】长篇是分批写的：上一批可能因模型收尾过早只落库 2200 字（目标 4000）。
     * 直接往下写新章的话，这一章会永久停在"没写完"的状态，作者在第 22 章就撞上情绪断层。
     *
     * 🔴 只补**最后一章**（＝最新章）—— 项目纪律「最新章可放开、历史章冻结」
     *    （见 docs/2.2.1-续排细纲*）：改历史章会污染设定与已写正文，绝不碰。
     * 🔴 只动 `content` / `wordCount` / `updatedAt` 三个字段，标题、顺序、卷归属一概不动。
     * 不传＝完全不检查（一键续写的老行为一字不变）。
     */
    topUpLast?: {
      /** 容许的字数偏差（默认 `WORD_TOLERANCE`）：低于 `targetWords - tolerance` 才算欠字 */
      tolerance?: number
      /** 补写轮数上限（默认 6）—— 每轮都是**增量拼接**，不重写已有内容 */
      maxExpand?: number
    }
  },
  cb: ContinueCallbacks = {},
): Promise<{ created: { id: string; title: string; no: number }[] }> {
  await requireProviderFor('create') // 提前校验，无模型直接抛中文提示
  const vols = await db.getAllVolumes()
  const ordered = sortChapters(vols, await db.getAllChapters())
  const last = ordered.length ? ordered[ordered.length - 1] : null
  // ⚠️ 必须以库里真实的最后一章为起点，否则第一章会失去衔接、一上来就跑偏
  let anchorId: string | null = last?.id ?? null
  let lastBody = last?.content ?? ''
  let lastTitle = last?.title ?? ''
  const created: { id: string; title: string; no: number }[] = []
  const minWords = minValidWords(opts.targetWords)
  let memory = ''
  let aborted = false
  /** WQ1-2：编辑自检未完成 ⇒ 暂停连写（与 aborted 分开：作者没喊停，是必选项没过） */
  let paused = false

  // 最近 3 章的章节摘要（title+字数+summary 裁剪），作为续写时的整体剧情走向参考
  const recentSummaries = ordered.length
    ? ordered.slice(-3).map(c => {
        const w = c.wordCount || countWords(c.content || '')
        const s = (c.summary || '').trim().slice(0, 400)
        return `· 《${c.title || '未命名章节'}》(${w}字)${s ? '：' + s : ''}`
      }).join('\n')
    : ''

  // ---- 🔴 正文缺口优先：先把**最后一章**补到目标字数，再往下写新章（2026-09-20）----
  //   🔴 只补最后一章（＝最新章）：项目纪律「最新章可放开、历史章冻结」——
  //      改历史章会污染设定与已写正文（详规 docs/2.2.1-续排细纲*）。
  //   🔴 只动 content / wordCount / updatedAt；标题、顺序、卷归属一概不动。
  if (opts.topUpLast && last) {
    const tol = opts.topUpLast.tolerance ?? WORD_TOLERANCE
    const floor = Math.max(1, opts.targetWords - Math.max(0, tol))
    const w0 = last.wordCount || countWords(last.content || '')
    if (w0 < floor) {
      cb.onLog?.(`最后一章《${last.title}》只有 ${w0} 汉字（目标 ${opts.targetWords}），先补齐它再往下写`)
      cb.onPhase?.(`补齐最后一章（${w0} → ${opts.targetWords} 汉字）…`)
      try {
        const filled = cleanChapterOutput(await enforceWordRange({
          cfg: await requireProviderFor('create'),
          body: last.content || '',
          target: opts.targetWords,
          sys: buildSysPrompt(opts.targetWords, undefined, await activeFingerprintNote()),
          ...(cb.signal ? { signal: cb.signal } : {}),
          ...(cb.request ? { request: cb.request } : {}),
          onPhase: p => cb.onPhase?.(`补齐最后一章：${p}`),
          onBodyReplace: cb.onBodyReplace,
          ...(cb.onLog ? { onLog: cb.onLog } : {}),
          maxExpand: opts.topUpLast.maxExpand ?? 6,
          // 🔴 补字场景**绝不压缩**：原文若已比目标长，保持原样（作者可能有意写短章）
          maxShrink: 0,
        }))
        const w1 = countWords(filled)
        // 安全阀：没补进去（或反而变短）就保持原样 —— 宁可不补，也不能把正文改坏
        if (w1 > w0) {
          last.content = filled
          last.wordCount = w1
          last.updatedAt = Date.now()
          // 🔴 B3：AI 补字同样属于辅助产出，增量 = 真正补进去的那部分（w1 − w0）。
          //    `withAiAssist` 返回**新对象**；这里 assign 回 `last` 是为了让后面的
          //    `syncChapterMaster(last, …)` 等代码一行都不用改（保持原引用，改动面最小）。
          Object.assign(last, withAiAssist(last, 'continued', w1 - w0))
          await db.saveChapter(last)
          lastBody = filled // 供下一章承接（第 22 章要接着补完的结尾写）
          await syncChapterMaster(last, chapterSeqOf(vols, await db.getAllChapters(), last.id))
          cb.onBodyReplace?.(filled)
          cb.onLog?.(`《${last.title}》已补齐（${w0} → ${w1} 汉字）`)
        } else {
          cb.onLog?.(`《${last.title}》补齐无效（${w0} → ${w1} 汉字），已保持原样`)
        }
      } catch (e) {
        if (isCancelled(e)) throw e
        cb.onLog?.(`补齐最后一章失败：${(e as Error).message}（继续往下写新章）`)
      }
    }
  }

  for (let i = 0; i < opts.chapters; i++) {
    if (cb.signal?.aborted) break
    const tag = `第 ${i + 1}/${opts.chapters} 章`
    try {
      cb.onPhase?.(`${tag}：组装上下文`)
      const ctx = await buildProjectContext({ focusChapterId: anchorId ?? undefined, budget: await writerBudgetFor('auto-continue') })
        .catch(() => ({ text: '', sections: [], dropped: [], chars: 0 }) as ProjectContextResult)
      const prevTail = [
        lastTitle ? `（上一章标题：《${lastTitle}》）` : '',
        lastBody.slice(-1200) || '（本项目还没有正文，这是开篇第一章）',
        memory ? `\n【本轮已写前序章节摘要（供衔接）】\n${memory}` : '',
        // 「创意写作」按大纲写：细纲钉在**末段**（越靠后的指令权重越高，与"反重复提示词只钉
        // system 末尾有效"同一道理）。不传 outlineFor 时这段为空，一键续写的老行为不受影响。
        (() => {
          // 🔴 2026-10-03：原来取不到就整块消失 —— 模型与作者都不知道「本次没有细纲」，
          //    于是模型自由发挥，用户看到的就是「AI 没按细纲写 / 写了后面章节的内容」。
          //    现在两种情况都**如实说明**（不传 outlineOf 时本就没有细纲，不加这句）。
          if (!cb.outlineFor) return ''
          const o = cb.outlineFor(ordered.length + i + 1)
          return o
            ? `\n【本章细纲（按此写，不要自行改主线）】\n${o}`
            : '\n【本章细纲】**本次没读到本章细纲**（细纲卡缺失，或卡名不是「第N章」这类格式而无法识别章号）。' +
              '请只依据上文的既有内容自然续写，不要凭空另起主线，也不要替作者规划后面的章节。'
        })(),
        // 2.5.2 · A2：作者灵感段（细纲**之前**——细纲仍是最末、权重最高）。空则整段不出现。
        (() => {
          const ins = cb.inspirationsFor?.() ?? []
          return inspirationBlock(ins)
        })(),
      ].filter(Boolean).join('\n')

      // ---- 初稿：生成 →（可选）作者裁决采纳 / 重写 / 中止 ----
      // 3.2.0 · WQ6：**每章一份**预算（补字/压缩/自检/设定整理/重试全计入）。
      // 🔴 按章而不是按任务：一章正常 6~12 次调用，40 次的上限只拦真失控
      //（例如补写循环一直"补了但不够"），不会误伤长章。
      const budget = createAttemptBudget({
        label: `第 ${ordered.length + i + 1} 章`,
        max: CHAPTER_ATTEMPT_BUDGET,
      })
      let body = ''
      let decision: DraftDecision = 'accept'
      for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
        if (cb.signal?.aborted) { decision = 'abort'; break }
        cb.onBodyReplace?.('')
        cb.onPhase?.(`${tag}：AI 续写正文${attempt > 1 ? `（第 ${attempt} 稿）` : ''}`)
        body = await generateOneChapter({
          ctx, prevTail, intent: opts.intent, recentSummaries, targetWords: opts.targetWords,
          chapterNo: ordered.length + i + 1, // 🔴 范围限定：只写这一章，别把下一章的内容带进来（社区反馈）
          signal: cb.signal, onToken: cb.onBodyToken,
          ...(cb.request ? { request: cb.request } : {}),
          budget,
          onPhase: p => cb.onPhase?.(`${tag}：${p}`),
          onBodyReplace: cb.onBodyReplace,
          onLog: cb.onLog,
        })
        // 🔴 剥掉正文里的 markdown 标记（`**粗体**` / 行首 `#` / 整行 `---`）——
        //    模型偶尔把正文当文档写，落库后作者在「正文编辑」里看到的是星号而不是强调
        //    （实测 2026-09-20：`**"第九脉，已至。"**` 进了正文）。
        //    放在**字数闸门之前**：先净化再量字数，免得把标记也算成有效字数。
        body = cleanChapterOutput(body)
        const w = countWords(body)
        // 落库硬闸门：内容异常（只剩残片/标点）一律丢弃重生成，绝不落库
        if (w < minWords) {
          cb.onLog?.(`${tag}第 ${attempt} 稿内容异常（仅 ${w} 汉字，低于 ${minWords} 下限），已丢弃`)
          noteCandidate(cb.request?.taskId, { target: 'chapter:new', fingerprint: hashOf(body), state: 'discarded' })
          if (attempt >= MAX_DRAFT_ATTEMPTS) throw new Error('模型连续返回异常内容，已中止本章')
          continue
        }

        // 去 AI 味儿（可选）：初稿生成并校准后，再润色一遍，然后才去弹窗交作者裁决。
        // 写在弹窗之前 → 作者看到的就是润色后的稿子；重写时整稿重生成会重新走本环节。
        let shownBody = body
        let shownWords = w
        if (opts.deAi?.enabled && opts.deAi.prompt.trim()) {
          cb.onPhase?.(`${tag}：去除 AI 味儿`)
          cb.onBodyReplace?.('')
          // 去 AI 味儿也是模型产出，同样可能带回 markdown 标记 —— 一并净化后再量字数
          const def = cleanChapterOutput(await deAiFlavor({
            cfg: await requireProviderFor('create'), body, instruction: opts.deAi.prompt,
            signal: cb.signal, ...(cb.request ? { request: cb.request } : {}), onToken: cb.onBodyToken, onBodyReplace: cb.onBodyReplace,
          }).catch(() => ''))
          budget.consume(1)
          const dw = countWords(def)
          // 安全阀：润色结果显著缩水（不足原文 60%）视为模型偷懒/截断，保留原稿
          if (def && dw >= w * 0.6) {
            shownBody = def
            shownWords = dw
            cb.onBodyReplace?.(shownBody)
            cb.onLog?.(`${tag}已去除 AI 味儿（${w} → ${dw} 汉字）`)
          } else {
            cb.onLog?.(`${tag}去 AI 味儿结果异常（${dw} 字），已保留原稿`)
          }
        }
        body = shownBody // 进入后续采纳/自检/落库的，是润色后的稿子（或异常时退回原稿）

        if (!cb.onChapterDraft) break
        cb.onPhase?.(`${tag}：等待作者确认初稿（${shownWords} 汉字）`)
        decision = await cb.onChapterDraft({
          index: i + 1, total: opts.chapters, attempt,
          body: shownBody, words: shownWords, target: opts.targetWords,
        })
        if (decision !== 'rewrite') break
        cb.onLog?.(`${tag}第 ${attempt} 稿已弃用，重新生成`)
      }
      if (decision === 'abort') {
        cb.onLog?.(`${tag}已由作者中止，任务结束`)
        aborted = true
        break
      }

      // ---- 采纳后：编辑自检 → 修正 → 二次字数校准 ----
      // WQ1-2：自检三项是必选项 —— 失败/取消/未完成都暂停连写，本章不落库，
      // 稿子经 onBodyReplace 留给作者审阅（B3 完整检查点属 W2，见 3.2.0 方案 §9）
      const refined = await selfRefine(body, ctx, cb.signal, p => cb.onPhase?.(`${tag}：${p}`), cb.request, budget, ordered.length + i + 1)
      body = refined.body
      if (refined.selfCheck.state !== 'completed') {
        const sc = refined.selfCheck
        cb.onLog?.(
          `${tag}编辑自检未完成（${sc.state}${sc.issues?.length ? '：' + sc.issues.join('；') : ''}），已暂停连写；`
          + `本章未保存，稿子在编辑器里，审阅后可重试或明确跳过`,
        )
        cb.onBodyReplace?.(body)
        paused = true
        break
      }
      body = await enforceWordRange({
        cfg: await requireProviderFor('create'), body, target: opts.targetWords,
        sys: buildSysPrompt(opts.targetWords, undefined, await activeFingerprintNote()), signal: cb.signal,
        ...(cb.request ? { request: cb.request } : {}),
        onPhase: p => cb.onPhase?.(`${tag}：${p}`), onBodyReplace: cb.onBodyReplace,
        ...(cb.onLog ? { onLog: cb.onLog } : {}),
        maxExpand: 2, maxShrink: 2,
      })
      // 🔴 自检修正与字数校准同样是模型产出 —— 落库前最后净化一次，
      //    保证进 Chapter.content 的字面里没有任何 markdown 标记（见 cleanChapterOutput）。
      body = cleanChapterOutput(body)
      cb.onBodyReplace?.(body)

      // 二次闸门：改写/压缩后再校验一次，异常则本章不落库
      const finalWords = countWords(body)
      if (finalWords < minWords) {
        cb.onLog?.(`${tag}修正后内容异常（仅 ${finalWords} 汉字），本章未保存`)
        continue
      }

      cb.onPhase?.(`${tag}：生成标题并保存`)
      // 3.2.0 · WQ6：标题与摘要是本章第 2 个步骤的两条逻辑调用，同样计入预算。
      // 🔴 预算到顶就跳过（标题退回占位、摘要留空），**不追加**请求。
      let title = '未命名章节'
      if (!budget.exhausted) {
        title = await suggestTitle(body, cb.signal, cb.request)
        budget.consume(1)
      }
      // 生成约 1/10 的章节压缩摘要：存入本章 summary（供后续续写参考），并复用于滚动 memory
      const sum = budget.exhausted ? '' : await aiChapterSummary(body, { signal: cb.signal }).catch(() => '')
      if (!budget.exhausted) budget.consume(1)
      // 🔴 本章的**计划章号** ＝ 库里已有章数 + 本轮第几章（与上面取细纲的 `ordered.length + i + 1` 同一个数）。
      //    按它问调用方"这一章该落进哪一卷" —— 长篇跨卷时第 21 章要进卷二，而不是留在锚点所在的卷一。
      const plannedNo = ordered.length + i + 1
      const ch = await createChapterAfter(anchorId, title, body, sum, cb.volumeIdFor?.(plannedNo))
      const [lv, lc] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
      const no = chapterSeqOf(lv, lc, ch.id)
      // 3.2.0 · W3 种子：走到这里＝作者已裁决采纳并落库，账本记一条「已采纳」候选引用。
      // 🔴 只存指纹与落点，不存正文 —— 账本随正文膨胀会拖慢整库保存。
      noteCandidate(cb.request?.taskId, {
        target: `chapter:${ch.id}`, fingerprint: hashOf(body), state: 'adopted',
      })
      cb.onChapterSaved?.({ id: ch.id, title: ch.title, no })
      created.push({ id: ch.id, title: ch.title, no })
      anchorId = ch.id
      lastBody = body
      lastTitle = ch.title

      cb.onPhase?.(`${tag}：抽取并补登设定`)
      // 设定整理计入本章预算：由 `extractAndCommitSettings` 按**实际逻辑调用**逐次记账
      //（抽取 1 次；auto-update 再 +1 次变化检测），不再在这里笼统扣 1 次
      const r = await extractAndCommitSettings(body, ch.title, opts.strategy, cb.onSettingsCandidates, cb.signal, cb.request, budget)
      const dev = finalWords - opts.targetWords
      cb.onLog?.(
        `${tag}《${ch.title}》已保存（${finalWords} 汉字，${dev >= 0 ? '+' : ''}${dev}）；设定新增 ${r.created} 条`
        + (r.failed.length ? `，失败：${r.failed.join('、')}` : '')
        + (r.errors?.length ? `；${r.errors.join('；')}` : ''),
      )
      // 滚动摘要回灌（应对多章记忆滚雪球），复用刚刚生成的 1/10 摘要
      if (sum) memory = (memory ? memory + '\n' : '') + `· 第${no}章《${ch.title}》：${sum.replace(/\s+/g, ' ').slice(0, 200)}`
    } catch (e) {
      if (isCancelled(e) || cb.signal?.aborted) {
        cb.onLog?.(`${tag}已停止`)
        aborted = true
        break
      }
      cb.onLog?.(`${tag}失败：${e instanceof Error ? e.message : String(e)}`)
      break
    }
  }
  cb.onPhase?.(
    created.length
      ? `✓ ${aborted ? '已停止' : paused ? '自检未过已暂停' : '续写完成'}，共新增 ${created.length} 章`
      : (aborted ? '已停止，未生成章节' : paused ? '自检未完成，已暂停（稿子已留在编辑器，审阅后可重试）' : '未生成章节（请检查模型配置或查看日志）'),
  )
  return { created }
}

// —— AI 提示词登记（必须放在文件末尾：上面这些 let 已全部初始化，避免 TDZ）——
registerPrompt({ id: 'setting-update-detect', group: '设定与资料', name: '设定更新侦测', note: '对比本章正文与已有设定，找出状态变化。' }, () => P_setting_update_detect, t => { P_setting_update_detect = t })
