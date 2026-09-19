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
import * as db from './db'
import { writerBudgetFor } from './aiWriterBudget'
import { uid } from './id'
import { countWords } from './textStats'
import { chat, requireActiveProvider, stripThink, isCancelled } from './ai'
import { parseObjectArray, asText } from './aiParse'
import { authorBlock, newAuthorFence } from './promptGuard'
import { buildProjectContext, type ProjectContextResult } from './aiContext'
import {
  aiExtractSettingEntities, aiContinuityAudit, aiOocCheck, aiForeshadowReview,
  aiRewritePassage, aiChapterSummary, type ExtractedEntity,
} from './aiTasks'
import { classify, commitEntities, loadRegistry, normName, type LedgerItem } from './settingLedger'
import { sortChapters, chapterSeqOf } from './chapterSeq'
import { syncChapterMaster } from './chapterMaster'
import type { Chapter } from './types'
import { registerPrompt } from './promptSettings'

/** 「设定更新侦测」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_setting_update_detect = `你是设定更新侦探。对比本章正文与已有设定，找出"对已有设定实体的新信息/状态变化"（如角色修为提升、关系变化、物品被获得或损毁、地点状态改变等）。
返回 JSON 数组，元素形如 {"name":"实体名(必须与已登记名完全一致)","note":"一句话描述变化，如 修为提升至凝气四层"}。
只报确有文本依据的，最多 10 条，没有则返回 []。只输出 JSON 数组，不要解释、不要 markdown 代码块。`

/** 已有设定更新策略（创建任务时由用户选择） */
export type ContinueStrategy = 'add-only' | 'confirm' | 'auto-update'

/** 成品字数容差（汉字）：落在 目标±300 视为达标 */
export const WORD_TOLERANCE = 300
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
    prompt: '把正文改得更自然、更口语、更像活人写的网文：\n1. 删掉「首先/其次/最后」「值得注意的是」「在……之前」「总而言之」「毋庸置疑」这类说明性套话。\n2. 减少对称对仗的排比句与成语堆砌，让句子长短错落。\n3. 破折号、省略号不要滥用。\n4. 少做空泛的升华与总结，多给具体画面、动作、感官细节。\n5. 心理活动写得更像真实念头，而非工整的议论。\n保持情节、人设、视角、章末钩子完全不变。',
  },
  {
    id: 'webnovel', label: '网文化', desc: '明快、对话推动、钩子更勾',
    prompt: '把正文改得更像成熟网文：\n1. 节奏明快，多用短句和对话推进，减少大段说明性叙述。\n2. 砍掉冗长的环境铺陈与心理独白注水。\n3. 强化冲突与信息差，让每屏都有「接下来会怎样」的悬念。\n4. 章末钩子更利落、更勾人。\n5. 去除 AI 常见的平衡工整表达，让文字带点作者个人脾气。\n保持人设与情节结构不变。',
  },
  {
    id: 'literary', label: '去套路', desc: '保留文采但去陈词滥调',
    prompt: '在保留原有文采的前提下去除 AI 套路：\n1. 替换陈词滥调与网络烂梗，用更精准新鲜的意象。\n2. 减少「仿佛」「似乎」「宛如」等廉价比况的堆叠。\n3. 避免每段都用相同的递进结构。\n4. 让叙述视角更稳、语气更统一。\n5. 删去空泛的哲理性感慨，把情绪藏进动作与细节里。\n保持情节结构不变。',
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
  onLog?: (msg: string) => void
  signal?: AbortSignal
}

interface SettingUpdate { name: string; note: string }
type Cfg = Awaited<ReturnType<typeof requireActiveProvider>>

// ============ 单次问答（剥思维链只作用于本次返回，绝不重复剥累加体） ============

async function ask(
  cfg: Cfg, sys: string, user: string,
  opts: { signal?: AbortSignal; onToken?: (d: string) => void; json?: boolean } = {},
): Promise<string> {
  const raw = await chat(cfg, [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ], opts)
  return stripThink(raw).trim()
}

/** 非致命问答：取消向上抛，其它异常吞成空串由调用方按字数判定 */
async function askSoft(
  cfg: Cfg, sys: string, user: string,
  opts: { signal?: AbortSignal; onToken?: (d: string) => void; json?: boolean } = {},
): Promise<string> {
  try {
    return await ask(cfg, sys, user, opts)
  } catch (e) {
    if (isCancelled(e)) throw e
    return ''
  }
}

// ============ 提示词 ============

function buildSysPrompt(target: number): string {
  const lo = target - WORD_TOLERANCE
  const hi = target + WORD_TOLERANCE
  return [
    '你是长篇网络小说的续写助手。请基于作者已有的世界观、角色与剧情，续写下一章正文。',
    '硬性约束：',
    `1. 篇幅必须落在 ${lo}~${hi} 个汉字之间（按汉字个数计，不含标点与英文单词）。写得过长与过短同样视为不合格，请自行规划详略与场景数量：先估算要写几个场景，再分配篇幅。`,
    '2. 必须严格承接【上一章结尾】的场景、时间、地点、人物位置与情绪，从紧接着的下一刻写起。不得跳场景、不得另起新线、不得重述前情、不得写"数日后/数月后"这类大跨度跳跃（除非作者在续写意图中明确要求）。',
    '3. 严格贴合已写章节的叙事视角、人称、文风与人设，保持既有爽文节奏，章末留一个能勾住读者点下一章的钩子。',
    '4. 只输出正文本身。不要任何解说、不要小标题、不要章节号、不要"以下是续写"之类的开场白，也不要输出思考过程。',
    '5. 若作者给了【续写意图】则优先沿其推进；未给则严格沿着上一章结尾的既有走向自然延续，聚焦当前尚未解决的冲突与悬念，不要凭空引入与前文无关的新地图、新势力或新金手指。',
  ].join('\n')
}

// ============ 字数区间校准（既补也压） ============

async function enforceWordRange(o: {
  cfg: Cfg
  body: string
  target: number
  sys: string
  signal?: AbortSignal
  onToken?: (d: string) => void
  onPhase?: (p: string) => void
  onBodyReplace?: (s: string) => void
  maxExpand?: number
  maxShrink?: number
}): Promise<string> {
  const lo = o.target - WORD_TOLERANCE
  const hi = o.target + WORD_TOLERANCE
  let body = o.body
  let words = countWords(body)

  // ① 偏短：紧接上文分幕补写（增量单独剥思维链后再拼，避免砍掉已写正文）
  const maxExpand = o.maxExpand ?? 4
  for (let r = 0; r < maxExpand && words < lo; r++) {
    o.onPhase?.(`补足篇幅（${words} → ${lo}~${hi} 汉字）`)
    const gap = Math.max(0, o.target - words)
    const add = await askSoft(o.cfg, o.sys, [
      '【本章已写部分】',
      body,
      '',
      `当前已写 ${words} 个汉字，距目标还差约 ${gap} 个汉字。请紧接着上文继续往下写，使全章总量落在 ${lo}~${hi} 汉字之间。`,
      '要求：不要重复或重述已写内容、不要重新开头、不要用形容词与心理独白注水；情节要实质推进；若剧情已近章末，则收束到章末钩子。只输出新增的正文片段。',
    ].join('\n'), { signal: o.signal, onToken: o.onToken })
    if (countWords(add) < 30) break // 无效增量：停止空转，接受偏短
    body = body.trimEnd() + '\n\n' + add
    words = countWords(body)
    o.onBodyReplace?.(body)
  }

  // ② 偏长：精简压缩到区间。安全阀：压出来过短视为模型偷懒/截断，保留原文（宁可超字也不丢情节）
  const maxShrink = o.maxShrink ?? 2
  for (let r = 0; r < maxShrink && words > hi; r++) {
    o.onPhase?.(`压缩篇幅（${words} → ${lo}~${hi} 汉字）`)
    const out = await askSoft(o.cfg,
      '你是资深网文编辑，擅长在不损失任何情节的前提下精简文字。只输出精简后的正文本身。',
      [
        `请把下面这一章正文精简到 ${lo}~${hi} 个汉字（按汉字个数计，不含标点）。`,
        '要求：',
        '1. 保留全部关键情节、转折、对话要点与章末钩子，不得删除任何情节线，不得删掉结尾。',
        '2. 只删冗余环境描写、重复铺陈、可有可无的心理独白与形容词堆砌。',
        '3. 保持原有叙事视角、人称与文风，不得改写成摘要、大纲或提要。',
        '4. 只输出精简后的完整正文，不要任何说明文字。',
        '',
        `【原文（${words} 汉字）】`,
        body,
      ].join('\n'),
      { signal: o.signal })
    const ow = countWords(out)
    if (!out || ow < lo * 0.85) break
    body = out
    words = ow
    o.onBodyReplace?.(body)
  }
  return body
}

// ============ 去 AI 味儿（生成初稿后的语言润色） ============

const DEAI_SYS = [
  '你是资深文字润色编辑，专门把 AI 生成的小说正文改得更自然、更有人味、更像职业网文作者手笔。',
  '原则（必须严格遵守）：',
  '1. 保持原文的人物、情节、对话、结构、视角、人称、章末钩子完全不变，只做语言层面的润色，绝不增删情节、不改结局。',
  '2. 保持原文字数规模基本不变（允许 ±10% 浮动），不要注水也不要过度压缩。',
  '3. 只输出润色后的正文本身，不要任何解释、不要小标题、不要开场白。',
].join('\n')

async function deAiFlavor(o: {
  cfg: Cfg
  body: string
  instruction: string
  signal?: AbortSignal
  onToken?: (d: string) => void
  onBodyReplace?: (s: string) => void
}): Promise<string> {
  return askSoft(o.cfg,
    `${DEAI_SYS}\n\n【本次润色侧重点】\n${o.instruction}`,
    ['【待润色正文】', authorBlock(newAuthorFence(), o.body)].join('\n'),
    { signal: o.signal, onToken: o.onToken })
}

// ============ 单章生成 ============

async function generateOneChapter(opts: {
  ctx: ProjectContextResult
  prevTail: string
  intent?: string
  /** 最近 3 章的章节摘要（title+字数+summary 拼接），供 AI 把握整体剧情走向 */
  recentSummaries?: string
  targetWords: number
  signal?: AbortSignal
  onToken?: (d: string) => void
  onPhase?: (p: string) => void
  onBodyReplace?: (s: string) => void
  onLog?: (s: string) => void
}): Promise<string> {
  const cfg = await requireActiveProvider()
  const sys = buildSysPrompt(opts.targetWords)
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
    `请续写下一章正文，篇幅 ${lo}~${hi} 汉字。`,
  ].join('\n')

  let body = await ask(cfg, sys, user, { signal: opts.signal, onToken: opts.onToken })

  // 异常返回（模型抽风 / 思维链剥离后只剩残片）→ 静默重试一次，不再流式以免污染预览
  if (countWords(body) < 50) {
    opts.onLog?.(`模型返回异常（仅 ${countWords(body)} 汉字），正在重试`)
    opts.onBodyReplace?.('')
    body = await askSoft(cfg, sys, user, { signal: opts.signal })
    opts.onBodyReplace?.(body)
  }

  return (await enforceWordRange({
    cfg, body, target: opts.targetWords, sys,
    signal: opts.signal, onToken: opts.onToken,
    onPhase: opts.onPhase, onBodyReplace: opts.onBodyReplace,
  })).trim()
}

/** 编辑自检：连续性 / 人设崩坏 / 伏笔 三类检查，命中严重/中等则单轮改写后接受不完美退出 */
async function selfRefine(body: string, ctx: ProjectContextResult, signal?: AbortSignal, onPhase?: (p: string) => void): Promise<string> {
  if (!ctx.text.trim() || countWords(body) < 200) return body
  onPhase?.('AI 编辑自检（连续性 / 人设 / 伏笔）')
  const findings: Array<{ level?: string; title?: string; detail?: string }> = []
  /** 三类审查产出的**共同形状**：自检只按 `level` 过滤，其余字段原样带过（不为每个 Finding 单写一套类型） */
  type RefineFinding = { level?: string }
  const push = (arr: readonly RefineFinding[]) => {
    for (const f of arr) if (f && (f.level === '严重' || f.level === '中等')) findings.push(f)
  }
  push(await aiContinuityAudit(ctx.text, body, { signal }).catch(() => [] as RefineFinding[]))
  push(await aiOocCheck(ctx.text, body, { signal }).catch(() => [] as RefineFinding[]))
  push(await aiForeshadowReview(ctx.text, { signal }).catch(() => [] as RefineFinding[]))
  if (!findings.length) {
    onPhase?.('编辑自检通过，未发现严重问题')
    return body
  }
  onPhase?.(`根据 ${findings.length} 条审读问题改写修正`)
  const instr = findings.map(f => `- ${f.title || '问题'}：${f.detail || ''}`).join('\n')
  const res = await aiRewritePassage(body, `修正以下审读问题，保持剧情与文风一致，不要改变原意：\n${instr}`, '', { signal }).catch(() => null)
  const rw = res?.rewritten ? stripThink(res.rewritten).trim() : ''
  // 安全阀：改写结果显著缩水（不足原文 60%）视为模型偷懒或被截断，保留原文
  if (!rw || countWords(rw) < countWords(body) * 0.6) return body
  return rw
}

async function suggestTitle(body: string, signal?: AbortSignal): Promise<string> {
  const cfg = await requireActiveProvider().catch(() => null)
  if (!cfg) return '未命名章节'
  const snippet = body.slice(0, 1500)
  const sys = '你是网文编辑。请给这一章起一个简洁、有吸引力、不剧透的章节标题。要求：不含"第N章"前缀，不超过 15 个汉字，只输出标题本身，不要标点、不要引号、不要解释。'
  const t = await askSoft(cfg, sys, `【本章正文（节选）】\n${snippet}`, { signal })
  const clean = t.replace(/[「」"'》>、。！？\s]/g, '').slice(0, 15)
  return clean || '未命名章节'
}

// ============ 建章（顺序/台账同步，绝不手填卷章号） ============

async function createChapterAfter(anchorId: string | null, title: string, content: string, summary = ''): Promise<Chapter> {
  const pid = db.getCurrentProjectId()
  const vols = await db.getAllVolumes()
  const chs = await db.getAllChapters()
  const anchor = anchorId ? chs.find(c => c.id === anchorId) : undefined
  const targetVolId = anchor?.volumeId ?? vols[vols.length - 1]?.id
  if (!targetVolId) throw new Error('项目中还没有卷，请先到「正文写作」创建至少一个卷再续写。')
  const volChs = chs.filter(c => c.volumeId === targetVolId)
  const order = volChs.length
  const ch: Chapter = {
    id: uid(), projectId: pid, volumeId: targetVolId, order,
    title: title || '未命名章节', content, summary,
    status: '草稿', wordCount: countWords(content),
    createdAt: Date.now(), updatedAt: Date.now(),
  }
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
): Promise<{ created: number; failed: string[] }> {
  const entities = await aiExtractSettingEntities(body, title, { signal }).catch(() => [] as ExtractedEntity[])
  if (!entities.length) return { created: 0, failed: [] }
  const reg = await loadRegistry().catch(() => null)
  if (!reg) return { created: 0, failed: [] }
  const items = classify(entities, reg)
  const empty = { created: 0, failed: [] as string[] }

  if (strategy === 'add-only') {
    // 仅限新增：只补登新实体，绝不碰已登记设定
    const news = items.filter(i => i.status === 'new')
    const r = await commitEntities(news, title).catch(() => empty)
    return { created: r.created, failed: r.failed }
  }
  if (strategy === 'auto-update') {
    // 自动更新：新实体自动补登 + 对已登记实体的变化做安全写回（追加到备注类字段，绝不覆盖属性列）
    const news = items.filter(i => i.status === 'new')
    const r = await commitEntities(news, title).catch(() => empty)
    await applySettingUpdates(body, title, signal).catch(() => {})
    return { created: r.created, failed: r.failed }
  }
  // confirm：把新实体与疑似重复项交给用户勾选
  const cands = items.filter(i => i.status === 'new' || i.status === 'duplicate')
  if (!cands.length) return empty
  const chosen = await onConfirm?.(cands)
  if (chosen && chosen.length) {
    const r = await commitEntities(chosen, title).catch(() => empty)
    return { created: r.created, failed: r.failed }
  }
  return empty
}

// ============ C 策略：对已登记实体的变化做安全写回 ============

async function extractSettingUpdates(body: string, title: string, signal?: AbortSignal): Promise<SettingUpdate[]> {
  const cfg = await requireActiveProvider()
  const sys = P_setting_update_detect
  const text = await askSoft(cfg, sys, `【章节】${title || '（未命名章节）'}\n【本章正文】\n${body.trim() || '（空白）'}`, { signal, json: true })
  // 统一走 aiParse：旧实现是裸 JSON.parse——不剥代码块、不切最外层，
  // 模型只要在 JSON 外套一句解释或 ```json 围栏，整条更新就被静默丢弃。
  return parseObjectArray(text)
    .filter(x => asText(x.name))
    .map(x => ({ name: asText(x.name), note: asText(x.note) }))
}

function pickNoteCol(data: Record<string, string>): string | null {
  for (const k of ['备注', '描述', '小传', '近况', '简介']) if (k in data) return k
  return null
}
function appendNote(existing: string | undefined, note: string): string {
  return (existing ? existing + '\n' : '') + note
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

async function applySettingUpdates(body: string, title: string, signal?: AbortSignal) {
  const updates = await extractSettingUpdates(body, title, signal).catch(() => [] as SettingUpdate[])
  if (!updates.length) return
  const reg = await loadRegistry().catch(() => null)
  if (!reg) return
  for (const u of updates) {
    const hit = findRegistered(reg, u.name)
    if (!hit) continue
    try {
      if (hit.tabId.startsWith('char-')) {
        const recs = await db.getCardRecords(hit.tabId)
        const rec = recs.find(r => r.id === hit.id)
        if (rec) {
          const col = pickNoteCol(rec.data)
          if (col) { rec.data[col] = appendNote(rec.data[col], `[续写·${title}] ${u.note}`); await db.saveCardRecord(rec) }
        }
      } else {
        const rows = await db.getTableRows(hit.tabId)
        const row = rows.find(r => r.id === hit.id)
        if (row) {
          const col = pickNoteCol(row.data)
          if (col) { row.data[col] = appendNote(row.data[col], `[续写·${title}] ${u.note}`); await db.saveTableRow(row) }
        }
      }
    } catch { /* 单条失败不影响整体 */ }
  }
}

// ============ 顶层编排（L2 多章循环） ============

export async function runAutoContinue(
  opts: {
    chapters: number; targetWords: number; strategy: ContinueStrategy; intent?: string;
    /** 去 AI 味儿：生成初稿后自动润色一遍再去弹窗交作者裁决；enabled=false 或 prompt 为空则跳过 */
    deAi?: { enabled: boolean; prompt: string }
  },
  cb: ContinueCallbacks = {},
): Promise<{ created: { id: string; title: string; no: number }[] }> {
  await requireActiveProvider() // 提前校验，无模型直接抛中文提示
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

  // 最近 3 章的章节摘要（title+字数+summary 裁剪），作为续写时的整体剧情走向参考
  const recentSummaries = ordered.length
    ? ordered.slice(-3).map(c => {
        const w = c.wordCount || countWords(c.content || '')
        const s = (c.summary || '').trim().slice(0, 400)
        return `· 《${c.title || '未命名章节'}》(${w}字)${s ? '：' + s : ''}`
      }).join('\n')
    : ''

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
          const o = cb.outlineFor?.(ordered.length + i + 1)
          return o ? `\n【本章细纲（按此写，不要自行改主线）】\n${o}` : ''
        })(),
      ].filter(Boolean).join('\n')

      // ---- 初稿：生成 →（可选）作者裁决采纳 / 重写 / 中止 ----
      let body = ''
      let decision: DraftDecision = 'accept'
      for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt++) {
        if (cb.signal?.aborted) { decision = 'abort'; break }
        cb.onBodyReplace?.('')
        cb.onPhase?.(`${tag}：AI 续写正文${attempt > 1 ? `（第 ${attempt} 稿）` : ''}`)
        body = await generateOneChapter({
          ctx, prevTail, intent: opts.intent, recentSummaries, targetWords: opts.targetWords,
          signal: cb.signal, onToken: cb.onBodyToken,
          onPhase: p => cb.onPhase?.(`${tag}：${p}`),
          onBodyReplace: cb.onBodyReplace,
          onLog: cb.onLog,
        })
        const w = countWords(body)
        // 落库硬闸门：内容异常（只剩残片/标点）一律丢弃重生成，绝不落库
        if (w < minWords) {
          cb.onLog?.(`${tag}第 ${attempt} 稿内容异常（仅 ${w} 汉字，低于 ${minWords} 下限），已丢弃`)
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
          const def = await deAiFlavor({
            cfg: await requireActiveProvider(), body, instruction: opts.deAi.prompt,
            signal: cb.signal, onToken: cb.onBodyToken, onBodyReplace: cb.onBodyReplace,
          }).catch(() => '')
          const dw = countWords(def)
          // 安全阀：润色结果显著缩水（不足原文 60%）视为模型偷懒/截断，保留原稿
          if (def && dw >= w * 0.6) {
            shownBody = def.trim()
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
      body = await selfRefine(body, ctx, cb.signal, p => cb.onPhase?.(`${tag}：${p}`))
      body = await enforceWordRange({
        cfg: await requireActiveProvider(), body, target: opts.targetWords,
        sys: buildSysPrompt(opts.targetWords), signal: cb.signal,
        onPhase: p => cb.onPhase?.(`${tag}：${p}`), onBodyReplace: cb.onBodyReplace,
        maxExpand: 2, maxShrink: 2,
      })
      cb.onBodyReplace?.(body)

      // 二次闸门：改写/压缩后再校验一次，异常则本章不落库
      const finalWords = countWords(body)
      if (finalWords < minWords) {
        cb.onLog?.(`${tag}修正后内容异常（仅 ${finalWords} 汉字），本章未保存`)
        continue
      }

      cb.onPhase?.(`${tag}：生成标题并保存`)
      const title = await suggestTitle(body, cb.signal)
      // 生成约 1/10 的章节压缩摘要：存入本章 summary（供后续续写参考），并复用于滚动 memory
      const sum = await aiChapterSummary(body, { signal: cb.signal }).catch(() => '')
      const ch = await createChapterAfter(anchorId, title, body, sum)
      const [lv, lc] = await Promise.all([db.getAllVolumes(), db.getAllChapters()])
      const no = chapterSeqOf(lv, lc, ch.id)
      cb.onChapterSaved?.({ id: ch.id, title: ch.title, no })
      created.push({ id: ch.id, title: ch.title, no })
      anchorId = ch.id
      lastBody = body
      lastTitle = ch.title

      cb.onPhase?.(`${tag}：抽取并补登设定`)
      const r = await extractAndCommitSettings(body, ch.title, opts.strategy, cb.onSettingsCandidates, cb.signal)
      const dev = finalWords - opts.targetWords
      cb.onLog?.(
        `${tag}《${ch.title}》已保存（${finalWords} 汉字，${dev >= 0 ? '+' : ''}${dev}）；设定新增 ${r.created} 条`
        + (r.failed.length ? `，失败：${r.failed.join('、')}` : ''),
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
      ? `✓ ${aborted ? '已停止' : '续写完成'}，共新增 ${created.length} 章`
      : (aborted ? '已停止，未生成章节' : '未生成章节（请检查模型配置或查看日志）'),
  )
  return { created }
}

// —— AI 提示词登记（必须放在文件末尾：上面这些 let 已全部初始化，避免 TDZ）——
registerPrompt({ id: 'setting-update-detect', group: '设定与资料', name: '设定更新侦测', note: '对比本章正文与已有设定，找出状态变化。' }, () => P_setting_update_detect, t => { P_setting_update_detect = t })
