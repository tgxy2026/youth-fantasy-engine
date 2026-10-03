// ============ AI 任务层 · 审校与诊断六件套 ============
// 2026-09-19 结构优化 D1：自 aiTasks.ts 拆出（原 #7–#12 段）。
// 收编：连续性自查 / 读者反馈分析 / 项目健康诊断 / 伏笔闭环 / 术语去重 / 文风体检。
// ⚠️ #9 项目诊断用到 #7 的 `ContinuityFinding` 类型 —— 同文件内引用，不再跨模块。
// ⚠️ 六条提示词各自就地声明；注册顺序由门面的 PROMPT_ORDER 决定，**别在这里调整顺序**。
import { chat, requireActiveProvider, CHAT_TIMEOUT_MS, composeSystemPrompt } from '../ai'
import { parseObjectArray, asText, humanText } from '../aiParse'
import { newAuthorFence, authorBlock } from '../promptGuard'
import type { PromptDef } from '../promptSettings'

/** 「文风体检」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_style_audit = `你是文风编辑。作者提供了《写作规范》（个人坏习惯清单 / 标点规范 / 视角规则）和本章正文，请对照规范体检本章文风。

规则：
1. 返回 JSON 数组，元素形如 {"type":"坏习惯词|视角|标点|节奏|其他","quote":"命中原文（可空）","issue":"问题","suggestion":"建议","level":"严重|中等|提示"}。
2. 坏习惯词：本章出现《写作规范》里列出的坏习惯词，逐一指出并给上下文。
3. 视角：若正文疑似出现非当前 POV 的越界描写，指出。
4. 标点：中英文标点混用、滥用省略号"..."代替"……"、引号不成对等。
5. 节奏：长段落密、对话与叙述失衡等可优化点（提示级）。
6. 没有问题就返回 []。宁可少报不可误报。不要 markdown 代码块标记。`

/** 「术语去重」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_term_dedup = `你是小说专有名词管理助手。作者给出了一份「名词术语」，其中可能存在同义重复（同一概念两种写法，如"灵气/灵元""剑修/剑士"）或完全重复。请把它们聚类成"应合并"的组。

规则：
1. 只把「确为同义 / 同一事物不同叫法 / 明显重复」的归为一组；措辞不同但指不同事物的不要归并。
2. 跨类别重复也要识别（如"境界类·灵气"与"物品类·灵元"指向同一物）。
3. 每组给出 reason（为什么认为是同义/重复）和 suggestion（建议统一成的标准术语名）。
4. 没有重复项时返回 groups: []。
5. 返回 JSON：{"groups":[{"terms":["名1","名2"],"reason":"…","suggestion":"标准名"}]}，不要 markdown 代码块标记。`

/** 「伏笔闭环审查」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_foreshadow_review = `你是长篇伏笔管理专家。作者提供了「伏笔追踪」与「章节总表」（含每章埋设/回收的伏笔编号）。
请对照两张表，从 AI 视角审视伏笔闭环健康度，重点指出：
1. 跨度过大：某伏笔埋设到回收跨越太多章节，读者早已忘记（建议提前铺陈或加快回收）。
2. 悬空伏笔：埋了但始终没回收、或追踪表有但总表从未登记的"孤儿"。
3. 埋设/回收失衡：某段章节疯狂挖坑却零回收，烂尾预警。
4. 节奏：连章密集埋设或回收，缺乏呼吸感。

规则：
- 返回 JSON 数组，元素形如 {"level":"严重|中等|提示","title":"一句话结论","detail":"具体哪条伏笔、跨几章、为什么有问题","where":"涉及的伏笔编号或章节"}。
- 没问题时返回 []。只报有据可查的判断。
- 不要 markdown 代码块标记。`

/** 「项目健康诊断」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_project_diagnosis = `你是网络小说创作项目的健康诊断助手。作者提供了当前项目的设定资料、章节清单与几项关键统计。请综合判断项目健康度，给出：
1. 健康分（0~100 的整数，越高越健康）。
2. 总体诊断（一句话 + 2~3 句展开）。
3. 风险清单：按严重程度列出最该马上处理的问题（最多 6 条），每条含 level（严重/中等/提示）、title、detail、where。
4. 下一步建议：作者接下来最该做的 3~5 件事（数组）。

规则：
- 只基于【项目资料】里的事实判断，不要编造设定。
- 风险与建议要具体、可操作，不要空话。
- 返回 JSON：{"score":int,"summary":"…","risks":[{"level","title","detail","where"}],"nextSteps":["…"]}，不要 markdown 代码块标记。`

/** 「读者反馈分析」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_feedback_analysis = `你是网络小说连载运营分析助手。作者提供了一段时间的「读者反馈 / 运营数据」记录（追读、均订、留存、章评吐槽、流失点与原因）。请站在责编视角做三件事：
1. 总体诊断：数据趋势与读者情绪的整体判断。
2. 流失归因：把"流失点章节 + 流失原因 + 吐槽"交叉分析，指出最可能导致读者跑路的根因（节奏拖沓 / 毒点 / 水文 / 设定崩坏 / 人设崩等）。
3. 应对建议：可落地的下一步动作（调节奏 / 回收伏笔 / 加戏 / 改设定），每条一句话。

规则：
- 只做分析，不创作剧情。
- 没有数据时明确说"暂无可分析数据"，不要编造数字或吐槽。
- 返回 JSON：{"summary":"总体诊断","churnAttribution":"流失归因","suggestions":"应对建议"}，不要 markdown 代码块标记。`

/** 「连续性校验」的可编辑正文（出厂默认；作者可在「模型设置 → AI 提示词」里改） */
let P_continuity_audit = `你是长篇网络小说的设定校对与连续性审查专家。请对照作者的设定资料，找出正文中的"前后矛盾/设定冲突/逻辑硬伤"。

规则：
1. 返回 JSON 数组，元素形如 {"level":"严重|中等|提示","title":"一句话结论","detail":"具体冲突在哪、和哪条设定对不上","where":"涉及的章节或设定项"}。
2. 只报「有据可查」的冲突：必须能指出资料/正文中的具体依据。不要报"建议加强描写"之类的写作建议。
3. level 判定：影响读者理解或明显崩设定 = 严重；细节对不上 = 中等；疑似但不确定 = 提示。
4. 最多返回 12 条，按严重程度排序。没发现问题就返回 []。
5. 只输出 JSON 数组，不要解释、不要 markdown 代码块标记。`

// ---------- 一致性深度自查 ----------

export interface ContinuityFinding {
  /** 严重 / 中等 / 提示 */
  level: string
  title: string
  detail: string
  /** 涉及位置（章节名 / 设定项） */
  where: string
}

export async function aiContinuityAudit(
  projectContext: string,
  chapterText: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ContinuityFinding[]> {
  const cfg = await requireActiveProvider()
  // 🔴 作者资料与正文都是**不可信文本**：包裹成边界块（内容一字不改，见 promptGuard 文件头）
  const fence = newAuthorFence()
  const sys = P_continuity_audit
  const user = `【设定资料】
${projectContext.trim() ? authorBlock(fence, projectContext.trim()) : '（无）'}

【待审查正文】
${chapterText.trim() ? authorBlock(fence, chapterText.trim()) : '（作者未指定正文，请仅在设定资料内部查找互相矛盾之处）'}

请返回问题清单。`
  const text = await chat(cfg, [{ role: 'system', content: composeSystemPrompt(sys, cfg) }, { role: 'user', content: user }], {
    json: true,
    timeoutMs: CHAT_TIMEOUT_MS,
    signal: opts?.signal,
    onToken: opts?.onToken,
  })
  const out: ContinuityFinding[] = []
  for (const it of parseObjectArray(text)) {
    const title = asText(it.title ?? it['结论'] ?? it['问题'])
    if (!title) continue
    out.push({
      level: asText(it.level ?? it['级别']) || '提示',
      title,
      detail: asText(it.detail ?? it['详情'] ?? it['说明']),
      where: asText(it.where ?? it['位置'] ?? it['涉及']),
    })
    if (out.length >= 12) break
  }
  return out
}

// ============ 读者反馈 AI 分析（任务1） ============
//
// 把连载运营台账（数据 + 吐槽 + 流失点）交给模型做编辑视角诊断。
// 纯增强：未配模型不调用；无数据时模型如实说"暂无可分析数据"，不编造。

export interface FeedbackEntry {
  /** 数据周期（如「第 3 周」） */
  period: string
  /** 追读 / 均订 / 留存等核心指标摘要 */
  metrics: string
  /** 高频吐槽（章评原声） */
  complaints: string
  /** 流失点章节 */
  churnChapter: string
  /** 作者填写的流失原因分析 */
  churnReason: string
}

export interface FeedbackAnalysis {
  /** 总体诊断 */
  summary: string
  /** 流失归因（根因分析） */
  churnAttribution: string
  /** 可落地的应对建议 */
  suggestions: string
}

export async function aiAnalyzeFeedback(
  entries: FeedbackEntry[],
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<FeedbackAnalysis> {
  const cfg = await requireActiveProvider()
  const list = entries.length
    ? entries
        .map((e, i) => {
          const lines = [
            `${i + 1}. 周期【${e.period || '—'}】`,
            `   数据：${e.metrics || '—'}`,
            `   高频吐槽：${e.complaints || '—'}`,
            `   流失点：${e.churnChapter || '—'}`,
            `   流失原因：${e.churnReason || '—'}`,
          ]
          return lines.join('\n')
        })
        .join('\n')
    : '（暂未登记任何读者反馈记录）'

  const fence = newAuthorFence()
  const sys = P_feedback_analysis

  const user = `【读者反馈记录】
${entries.length ? authorBlock(fence, list) : list}

请给出诊断。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const objs = parseObjectArray(text)
  const obj = objs[0] ?? {}
  return {
    summary: asText(obj.summary) || humanText(text),
    churnAttribution: asText(obj.churnAttribution) || '（模型未单独给出流失归因）',
    suggestions: asText(obj.suggestions) || '（模型未单独给出应对建议）',
  }
}

// ============ 写作面板 AI 健康诊断（任务2） ============
//
// 替换 Dashboard 原来写死的风险清单文案：读项目实际资料 + 关键统计，
// 输出健康分 + 风险清单 + 下一步建议。未配模型时 Dashboard 不调用、沿用静态提示。

export interface ProjectDiagnosis {
  /** 0~100 健康分 */
  score: number
  /** 总体诊断 */
  summary: string
  /** 风险清单（复用 ContinuityFinding 结构） */
  risks: ContinuityFinding[]
  /** 下一步建议 */
  nextSteps: string[]
}

export async function aiDiagnoseProject(
  projectContext: string,
  stats: { chapters: number; words: number; volumes: number; unf: number; unusedIdeas: number },
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ProjectDiagnosis> {
  const cfg = await requireActiveProvider()
  const fence = newAuthorFence()
  const sys = P_project_diagnosis

  const user = `【关键统计】
- 卷数：${stats.volumes}　章节数：${stats.chapters}　累计字数：${stats.words}
- 未回收伏笔：${stats.unf} 条　闲置灵感素材：${stats.unusedIdeas} 条

【项目资料】
${projectContext.trim() ? authorBlock(fence, projectContext.trim()) : '（无）'}

请给出诊断。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const objs = parseObjectArray(text)
  const obj = objs[0] ?? {}
  const risks = (Array.isArray(obj.risks) ? obj.risks : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map(x => ({
      level: asText(x.level) || '提示',
      title: asText(x.title ?? x['结论']) || '',
      detail: asText(x.detail ?? x['详情']),
      where: asText(x.where ?? x['位置']),
    }))
    .filter(r => r.title)
  const nextSteps = (Array.isArray(obj.nextSteps) ? obj.nextSteps : [])
    .map(asText)
    .filter(Boolean) as string[]
  const scoreNum = Number(obj.score)
  return {
    score: Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : 0,
    summary: asText(obj.summary) || humanText(text),
    risks: risks.slice(0, 6),
    nextSteps: nextSteps.slice(0, 5),
  }
}

// ============ 伏笔闭环 AI 增强（任务6） ============
//
// 在本地确定性「伏笔闭环看板」之外，提供一版 AI 视角的伏笔健康审查：
// 跨度节奏、悬空伏笔、埋设回收失衡等。未配模型不调用，本地看板照常可用。

export interface ForeshadowReviewFinding {
  level: string
  title: string
  detail: string
  where: string
}

export async function aiForeshadowReview(
  projectContext: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<ForeshadowReviewFinding[]> {
  const cfg = await requireActiveProvider()
  const fence = newAuthorFence()
  const sys = P_foreshadow_review

  const user = `【项目资料（含伏笔追踪与章节总表）】
${projectContext.trim() ? authorBlock(fence, projectContext.trim()) : '（无）'}

请审查伏笔闭环健康度。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const out: ForeshadowReviewFinding[] = []
  for (const it of parseObjectArray(text)) {
    const title = asText(it.title ?? it['结论'] ?? it['问题'])
    if (!title) continue
    out.push({
      level: asText(it.level ?? it['级别']) || '提示',
      title,
      detail: asText(it.detail ?? it['详情'] ?? it['说明']),
      where: asText(it.where ?? it['位置'] ?? it['涉及']),
    })
    if (out.length >= 12) break
  }
  return out
}

// ============ 名词术语 AI 查重归一（任务5） ============
//
// 对现有术语做同义 / 重复聚类，建议合并归一。未配模型不调用，手动录入不受影响。

export interface TermDupGroup {
  /** 被判定为同义 / 重复的术语名 */
  terms: string[]
  /** 为什么认为它们重复 / 同义 */
  reason: string
  /** 建议统一成的标准写法 */
  suggestion: string
}

export async function aiDedupTerms(
  terms: { term: string; category: string; definition: string }[],
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<{ groups: TermDupGroup[] }> {
  const cfg = await requireActiveProvider()
  const fence = newAuthorFence()
  const list = terms
    .map((t, i) => `${i + 1}. ${t.term}${t.category ? `（${t.category}）` : ''}：${t.definition || '—'}`)
    .join('\n')
  const sys = P_term_dedup

  const user = `【名词术语】
${list.trim() ? authorBlock(fence, list) : '（空）'}

请找出应合并的重复 / 同义术语。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const objs = parseObjectArray(text)
  const obj = objs[0] ?? {}
  const groups = (Array.isArray(obj.groups) ? obj.groups : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    .map(x => ({
      terms: Array.isArray(x.terms) ? x.terms.map(asText).filter(Boolean) : [],
      reason: asText(x.reason),
      suggestion: asText(x.suggestion),
    }))
    .filter(g => g.terms.length >= 2)
  return { groups }
}

// ============ 文风体检 AI 增强（任务8） ============
//
// 在本地《写作规范》静态体检之外，提供一版 AI 文风体检：对照作者写的规范
// （坏习惯词 / 视角 / 标点），审本章文风。未配模型不调用，本地体检照常可用。

export interface StyleCheckFinding {
  /** 坏习惯词 / 视角 / 标点 / 节奏 / 其他 */
  type: string
  /** 命中原文（可空） */
  quote: string
  /** 问题描述 */
  issue: string
  /** 修改建议 */
  suggestion: string
  /** 严重 / 中等 / 提示 */
  level: string
}

export async function aiStyleCheck(
  chapterText: string,
  styleContext: string,
  opts?: { signal?: AbortSignal; onToken?: (delta: string) => void },
): Promise<StyleCheckFinding[]> {
  const cfg = await requireActiveProvider()
  const fence = newAuthorFence()
  // ⚠️【写作规范】是模型要**遵守**的规则（不是待处理素材），刻意不包裹；只有正文需要边界保护
  const sys = P_style_audit

  const user = `【写作规范】
${styleContext.trim() || '（作者尚未填写写作规范）'}

【本章正文】
${chapterText.trim() ? authorBlock(fence, chapterText.trim()) : '（空）'}

请体检本章文风。`

  const text = await chat(
    cfg,
    [
      { role: 'system', content: composeSystemPrompt(sys, cfg) },
      { role: 'user', content: user },
    ],
    { timeoutMs: CHAT_TIMEOUT_MS, signal: opts?.signal, onToken: opts?.onToken, json: true },
  )

  const out: StyleCheckFinding[] = []
  for (const it of parseObjectArray(text)) {
    const issue = asText(it.issue ?? it['问题'])
    if (!issue) continue
    out.push({
      type: asText(it.type ?? it['类型']) || '其他',
      quote: asText(it.quote ?? it['原文']),
      issue,
      suggestion: asText(it.suggestion ?? it['建议']),
      level: asText(it.level ?? it['级别']) || '提示',
    })
    if (out.length >= 20) break
  }
  return out
}

/**
 * 本域可编辑提示词（就地声明在上方）。
 * 🔴 **注册顺序由门面 `PROMPT_ORDER` 决定 = 设置页显示顺序**，数组内的先后不影响界面。
 */
export const AUDIT_PROMPTS: PromptDef[] = [
  {
    meta: { id: 'continuity-audit', group: '编辑与审校', name: '连续性校验', note: '对照设定资料，找正文里的前后矛盾与设定冲突。' },
    read: () => P_continuity_audit,
    write: t => { P_continuity_audit = t },
  },
  {
    meta: { id: 'feedback-analysis', group: '项目诊断', name: '读者反馈分析', note: '把追读 / 均订 / 章评吐槽交叉分析，给出应对建议。' },
    read: () => P_feedback_analysis,
    write: t => { P_feedback_analysis = t },
  },
  {
    meta: { id: 'project-diagnosis', group: '项目诊断', name: '项目健康诊断', note: '从设定资料与章节清单看项目整体健康度。' },
    read: () => P_project_diagnosis,
    write: t => { P_project_diagnosis = t },
  },
  {
    meta: { id: 'foreshadow-review', group: '设定与资料', name: '伏笔闭环审查', note: '查悬空伏笔、跨度失衡、埋设与回收失衡。' },
    read: () => P_foreshadow_review,
    write: t => { P_foreshadow_review = t },
  },
  {
    meta: { id: 'term-dedup', group: '设定与资料', name: '术语去重', note: '找出同义重复的专有名词并给合并建议。' },
    read: () => P_term_dedup,
    write: t => { P_term_dedup = t },
  },
  {
    meta: { id: 'style-audit', group: '编辑与审校', name: '文风体检', note: '按《写作规范》查坏习惯词、标点、视角规则。' },
    read: () => P_style_audit,
    write: t => { P_style_audit = t },
  },
]
