/**
 * 全书优化工单 + 逐章自动修订（2.8.0 · 台账 #016）。
 *
 * 【要解决的问题】完稿之后，「哪一章有问题」散在五个本地引擎 + 八支 AI 审读里，
 * 作者得一个面板一个面板地翻，看到第 30 章的问题时已经忘了第 3 章写了什么。
 * 本模块把**散落的问题汇总成一张可勾选的工单**，并复用既有的整章改写链把它逐章改掉，
 * 改完给出**修改前后对照**。定位＝「完稿后的闭环」，与既有「诊断 + 手动改」互补，不替代。
 *
 * 🔴 四条执行纪律（本模块的核心价值，别为了"自动"破它们）：
 *   ① **逐章串行**：改完一章落库再动下一章；**同章多条合并成一次改写**（见 `runTicketChapter`）——
 *      否则 N 条建议会把同一章反复覆写 N 次，快照上限 12/章当场打满。
 *   ② **同一套历史/最新分治**：`isLatest` 判据与 `creativeSession.startChapterRewrite` **逐字同源**
 *      （候选列表按真实叙事序排，最后一个即最新章）。历史章只允许 `polish` / `condense`
 *      这两档「不改设定」的动作，其余来源一律降级成 `manual`（见 `resolveAction`）。
 *   ③ **改完最新章补跑设定同步**：`extractAndCommitSettings(..., 'add-only')` —— 无交互场景下
 *      `confirm` 策略没有勾选界面，降级为只新增最稳（与 `applyRewrite` 同口径）。
 *   ④ **可审可跳可中止**：中止后条目**保持 pending**（不是 failed）—— 作者只是按了暂停，
 *      回头还要接着执行；标成 failed 会让人以为"这条修不了"。
 *
 * 🔴 不新写落库逻辑：正文覆盖一律走 `applyChapterRewrite`（它已含「先留快照、只动
 *    content/wordCount/updatedAt、同步章节台账」）。本模块只负责「挑章、拼要求、串起来」。
 *
 * ⚠️ 本轮**只做本地诊断源**（五个引擎，零 AI 成本）。AI 深度检查（编辑意见 / OOC / 爽点毒点）
 *    作为独立一批加进来 —— 那部分要发明细估算与勾选范围，不在这里静默半个。
 */
import type { IssueSeverity } from '@/lib/audit/audit'
import { SEVERITY_ORDER } from '@/lib/audit/audit'
import type { ChapterCheckReport } from '@/lib/outline/chapterCheck'
import { runChapterCheck } from '@/lib/outline/chapterCheck'
import type { ChapterRewriteAction } from '@/lib/ai/aiTasks'
import { CHAPTER_REWRITE_META, aiRewriteChapter } from '@/lib/ai/aiTasks'
import {
  applyChapterRewrite, listRewriteCandidates,
  type RewriteCandidate,
} from '@/lib/editor/chapterRewrite'
import { extractAndCommitSettings } from '@/lib/outline/autoContinue'
// 3.2.0 · WQ7：工单改写也进运行账本 —— 此前只有创意写作建账，改写花的额度完全查不到
import { createRun, finishRun, computeBasis, pickContextSnapshot, noteCandidate } from '@/lib/ai/aiRunLedger'
import { lastContextAssembly } from '@/lib/ai/aiContext'
import * as db from '@/lib/db'
import type { CallRequestContext } from '@/lib/ai/callTracking'
import { hashOf } from '@/lib/semantic/chunk'
import { isCancelled } from '@/lib/ai'
// 3.2.0 · WQ8 文本守卫（方案 A：登记实体 + 只报告不判定）
import { checkFactRetention, type FactGuardReport } from '@/lib/ai/factGuard'
import { loadRegistry } from '@/lib/settings/settingLedger'
// 3.2.0 · WQ6：改写步骤自带预算（主改写 / 补写 / 压缩 / 设定整理都计入），到上限暂停
import {
  createAttemptBudget, isRequestBudgetExhausted,
  REWRITE_ATTEMPT_BUDGET, type AttemptBudgetSnapshot,
} from '@/lib/ai/requestLedger'
// 3.2.0 · W4：「加入工单」—— 把已落库的 AI 检查结论挂到按章的工单上
import { joinCheckReportsToTicket, type ChapterRef } from '@/lib/revision/ticketIntake'
// 3.2.0 · W4：本地诊断也要留档 —— 此前只有连写自检（AI 侧）的报告会落库，
//    作者「一键诊断」出的问题当天看得见、隔天查不到，链条缺一环。
import {
  chapterReportToFindings, chapterReportToRun, evidenceOfFindings, LOCAL_TICKET_JOB_ID,
} from '@/lib/revision/checkAdapters'
import { persistCheckReports, type CheckRunLike, type PersistCheckReportsResult } from '@/lib/revision/checkReports'
import type { TicketEvidence } from '@/lib/revision/findingAdapters'
// 3.2.0 · WQ1：检查项状态列表 —— 某章检查抛错时不再被吞成「诊断完成、没有问题」
import {
  calculateCoverage, type CheckItemResult, type CheckSummary,
} from '@/lib/aiTasks/reviewFindings'

/** 工单条目的来源分类 */
export type TicketSource =
  | 'continuity' | 'foreshadow' | 'style' | 'typo' | 'sensitive'
  | 'ai-review' | 'ai-ooc' | 'ai-pleasure'

/** 条目状态（`skipped` = 作者主动跳过；`manual` 不是状态而是 action，见下） */
type TicketStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

/** 界面上怎么称呼这些来源 */
export const SOURCE_LABEL: Record<TicketSource, string> = {
  continuity: '连续性',
  foreshadow: '伏笔',
  style: '文风',
  typo: '错别字',
  sensitive: '敏感词',
  'ai-review': 'AI 编辑意见',
  'ai-ooc': 'AI 人设检查',
  'ai-pleasure': 'AI 爽点毒点',
}

/** 排序用的来源次序（与 `SOURCE_LABEL` 的声明序一致，避免两处漂移） */
export const SOURCE_ORDER: TicketSource[] = Object.keys(SOURCE_LABEL) as TicketSource[]

/**
 * 各来源默认走哪一档改写动作。
 * `manual` = **不调 AI**，提示作者自己处理 —— 用于「改正文也未必解决」的类别：
 *   连续性与伏笔冲突的根子多在设定表里（某人已死却出场），让模型去糊正文只会掩盖矛盾。
 */
const DEFAULT_ACTION: Record<TicketSource, ChapterRewriteAction | 'manual'> = {
  continuity: 'manual',
  foreshadow: 'manual',
  style: 'polish',
  typo: 'polish',
  sensitive: 'rewrite',
  'ai-review': 'polish',
  'ai-ooc': 'rewrite',
  'ai-pleasure': 'expand',
}

/**
 * 🔴 历史章允许的动作 —— 只有这两档「不改设定」的文字加工。
 * `expand`（可能新增设定）、`continue`（那是续写不是修订）、`rewrite`（创造性改写）一律不放。
 * 这样即便作者在别的入口手动改了工单里的 action，执行时也会被 `pickAction` 再夹一次。
 */
export const HISTORY_ACTIONS: ChapterRewriteAction[] = ['polish', 'condense']

/** 动作"份量"：同章多条合并时取最重的那档 */
const ACTION_WEIGHT: Record<ChapterRewriteAction, number> = {
  polish: 1, condense: 2, continue: 3, expand: 4, rewrite: 5,
}

export interface TicketItem {
  /** 稳定 id（`章节 + 来源 + 标题` 的 FNV-1a）—— 同一问题重复生成必须得到同一个 id，否则去重失效 */
  id: string
  chapterId: string
  chapterTitle: string
  /** 全局叙事序号（0 = 序章 / 番外这类不计号的） */
  chapterNo: number
  source: TicketSource
  severity: IssueSeverity
  title: string
  detail: string
  /** 给模型的修改指令（没有就退回用 detail） */
  suggestion?: string
  /** `manual` ⇒ 界面禁掉「执行」，只提示作者自己改 */
  action: ChapterRewriteAction | 'manual'
  status: TicketStatus
  error?: string
}

/**
 * 定序的 FNV-1a：只求稳定与短，不用于安全场景。
 * 🔴 **必须稳定**（同一问题重复生成得到同一个 id），否则 `sortAndDedup` 的去重形同虚设。
 * 导出只为单测钉住这条稳定性（与 `chapterRewrite` 的 `expectedRewriteWords` 同类取舍）。
 */
export function ticketId(chapterId: string, source: TicketSource, title: string): string {
  const s = `${chapterId}|${source}|${title}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * 由「来源 + 是否最新章」定出这一条走哪档动作。
 * 🔴 历史章里凡落到 `expand` / `rewrite` 的来源（敏感词 / 人设）一律降成 `manual`：
 *    宁可让作者手动改两处，也不拿"自动"当借口破了历史章设定冻结的红线。
 */
export function resolveAction(source: TicketSource, isLatest: boolean): ChapterRewriteAction | 'manual' {
  const want = DEFAULT_ACTION[source]
  if (want === 'manual') return 'manual'
  if (isLatest) return want
  return HISTORY_ACTIONS.includes(want) ? want : 'manual'
}

/** 界面显示用：动作名（`manual` 单独给一句人话，不要写成 "manual"） */
export function actionLabelOf(a: ChapterRewriteAction | 'manual'): string {
  return a === 'manual' ? '需手动处理' : CHAPTER_REWRITE_META[a].label
}

interface BuildTicketOpts {
  /** 只查这些章（不传＝全部章）。用于「只诊断勾选的那几章」 */
  chapterIds?: string[]
  signal?: AbortSignal
  /** 进度回调（已查章数 / 总章数） */
  onProgress?: (done: number, total: number) => void
}

/** 一次诊断的完整结果（条目 + 检查项状态 + 留档情况） */
export interface TicketDiagnose {
  items: TicketItem[]
  /**
   * 每章一个检查项。
   * 🔴 粒度是**章**不是引擎：`runChapterCheck` 内部把五个引擎的失败各自 `.catch(() => [])`，
   *    外层无法区分「连续性引擎挂了」和「这一章真没问题」—— 所以不假装知道，只如实记到章。
   */
  checks: CheckItemResult[]
  /** 覆盖率与计数（与 `checks` 同源，供界面一句话说清） */
  summary: CheckSummary
  /** 报告留档结果（A 策略：只有严重 / 中等发现才写） */
  persisted: PersistCheckReportsResult
}

/**
 * 跑一遍诊断、汇总成工单。**只读不写**（五个引擎全是本地确定性检查，零 AI 请求、零成本）。
 * 结果按「章序 → 严重度 → 来源」排序并去重。
 *
 * 🔴 「只读」指的是**不碰正文**：检查报告会留档（旁路写 `revisionPayloads`），但那不是作品数据，
 *    且全程不抛（写不进去只记 error，工单照出）。
 */
export async function buildTicket(opts: BuildTicketOpts = {}): Promise<TicketItem[]> {
  return (await buildTicketDetailed(opts)).items
}

/** 与 `buildTicket` 同一条流程，额外给出检查项状态与留档结果（3.2.0 · W4 / WQ1） */
export async function buildTicketDetailed(opts: BuildTicketOpts = {}): Promise<TicketDiagnose> {
  const cands = await listRewriteCandidates()
  // 🔴 最新章判据与 creativeSession 同源：候选列表是按真实叙事序排的，最后一个就是最新章
  const latestId = cands.length ? cands[cands.length - 1].chapter.id : ''
  const want = opts.chapterIds?.length ? new Set(opts.chapterIds) : null
  const targets = want ? cands.filter(c => want.has(c.chapter.id)) : cands

  const out: TicketItem[] = []
  const checks: CheckItemResult[] = []
  /** 待留档的报告（攒到最后一次落库 —— 逐章各调一遍会把全项目载荷反复列出来，大书会明显变慢） */
  const pending: {
    checkId: string
    source: string
    run: CheckRunLike
    evidence?: TicketEvidence[]
    chapterId: string
    chapterNo: number
    chapterTitle: string
  }[] = []
  let done = 0
  for (const c of targets) {
    if (opts.signal?.aborted) break
    const title = c.chapter.title || '（未命名）'
    // 空章跳过（没正文没什么可诊断的），但仍然计入进度 —— 记为 skipped，不装作"检过且没问题"
    if (!(c.chapter.content ?? '').trim()) {
      checks.push({ id: c.chapter.id, name: title, status: 'skipped', findings: 0, critical: 0, finishedAt: Date.now() })
      done++
      opts.onProgress?.(done, targets.length)
      continue
    }
    const rep = await runChapterCheck(c.chapter).catch(e => {
      // 🔴 别静默吞：某章检查抛错时该章被跳过，工单会呈现成「诊断完成、没有问题」而掩盖漏检。
      //    但一次读失败不该让整张工单中断 —— 记一行日志，继续诊断其余章。
      console.warn(`[optimizeTicket] 一章诊断失败（已跳过）：${c.chapter.title}`, e)
      return null
    })
    if (!rep) {
      checks.push({
        id: c.chapter.id, name: title, status: 'failed', findings: 0, critical: 0,
        error: '这一章没检成（引擎读库失败），等于没查 —— 请重新诊断这一章',
        finishedAt: Date.now(),
      })
      done++
      opts.onProgress?.(done, targets.length)
      continue
    }
    out.push(...issuesOf(c, rep, c.chapter.id === latestId))
    const findings = chapterReportToFindings(rep)
    // 计数只算"需要动手"的（提示级不算问题）—— 与工单条目口径一致
    const actionable = findings.filter(f => f.level !== '提示').length
    const critical = findings.filter(f => f.level === '严重').length
    checks.push({
      id: c.chapter.id, name: title, status: 'done',
      findings: actionable, critical, finishedAt: Date.now(),
    })
    pending.push({
      checkId: 'chapter-check', source: 'local', run: chapterReportToRun(rep),
      // 证据快照：按**被检查的正文**定位一次（工单侧之后按当前正文再定位，两件事都要如实）
      evidence: evidenceOfFindings(findings, c.chapter.content ?? ''),
      chapterId: c.chapter.id, chapterNo: c.no, chapterTitle: c.chapter.title,
    })
    done++
    opts.onProgress?.(done, targets.length)
  }

  // 🔴 中止时剩下的章如实记为 pending：不记就会让覆盖率变成「30/30 = 100%」，
  //    作者会以为全书都查过了 —— 这正是 WQ1 登记的病灶。
  for (let i = done; i < targets.length; i++) {
    const c = targets[i]
    checks.push({ id: c.chapter.id, name: c.chapter.title || '（未命名）', status: 'pending', findings: 0, critical: 0 })
  }

  // 留档：A 策略（有实质发现才存 + 指纹去重 + 双闸淘汰）。全程不抛。
  const persisted: PersistCheckReportsResult = pending.length
    ? await persistCheckReports({
      projectId: db.getCurrentProjectId() ?? '',
      jobId: LOCAL_TICKET_JOB_ID,
      reports: pending,
    })
    : { saved: 0, skipped: 0, pruned: 0 }

  // 3.2.0 · W4（「加入工单」）：把检查报告里**有实质发现**的条目并进工单。
  // 🔴 本地确定性检查（错别字/敏感词/文风）先出，AI 检查结论后并 —— 同类问题以本地结论为准，
  //    再按去重键合并，已有条目状态不被覆盖（作者标过的 skipped/done 不会被打回 pending）。
  const refs: ChapterRef[] = targets.map(c => ({
    id: c.chapter.id, title: c.chapter.title, no: c.no, body: c.chapter.content ?? '',
  }))
  const joined = await joinCheckReportsToTicket(db.getCurrentProjectId() ?? '', refs, sortAndDedup(out))
  return {
    items: sortAndDedup(joined.items),
    checks,
    summary: calculateCoverage(checks),
    persisted,
  }
}

/** 一章的体检报告 → 工单条目 */
function issuesOf(c: RewriteCandidate, rep: ChapterCheckReport, isLatest: boolean): TicketItem[] {
  const mk = (
    source: TicketSource, severity: IssueSeverity, title: string, detail: string, suggestion?: string,
  ): TicketItem => ({
    id: ticketId(c.chapter.id, source, title),
    chapterId: c.chapter.id,
    chapterTitle: c.chapter.title,
    chapterNo: c.no,
    source,
    severity,
    title,
    detail,
    ...(suggestion ? { suggestion } : {}),
    action: resolveAction(source, isLatest),
    status: 'pending',
  })

  const out: TicketItem[] = []
  for (const i of rep.continuity) out.push(mk('continuity', i.severity, i.title, i.detail))
  for (const i of rep.foreshadow.issues) out.push(mk('foreshadow', i.severity, i.title, i.detail))
  for (const i of rep.style) {
    // 「没问题 / 没填写作规范」这类提示不该变成待办 —— 与 countActionable 的口径一致
    if (i.id === 's-ok' || i.id === 's-empty' || i.id === 's-style-missing') continue
    out.push(mk('style', i.severity, i.title, i.detail))
  }
  for (const h of rep.typos) {
    out.push(mk('typo', 'warn', `错别字：${h.word} → ${h.suggest}`,
      `${h.count} 处；例如：${h.context}`, `把「${h.word}」改成「${h.suggest}」`))
  }
  for (const h of rep.sensitive) {
    out.push(mk('sensitive', 'error', `敏感词：${h.word}`,
      `${h.count} 处；例如：${h.context}`, `改写含「${h.word}」的表述，换一个不敏感的说法`))
  }
  return out
}

/** 去重（同 id 只留一条）+ 排序（章序 → 严重度 → 来源 → 标题） */
export function sortAndDedup(items: TicketItem[]): TicketItem[] {
  const seen = new Set<string>()
  const uniq: TicketItem[] = []
  for (const it of items) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    uniq.push(it)
  }
  return uniq.sort((a, b) =>
    a.chapterNo - b.chapterNo
    || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source)
    || a.title.localeCompare(b.title))
}

interface TicketChapterGroup {
  chapterId: string
  chapterNo: number
  chapterTitle: string
  items: TicketItem[]
}

/** 按章分组（保持章序）—— 界面按章渲染、执行也按章走 */
export function groupByChapter(items: TicketItem[]): TicketChapterGroup[] {
  const map = new Map<string, TicketChapterGroup>()
  for (const it of items) {
    let g = map.get(it.chapterId)
    if (!g) {
      g = { chapterId: it.chapterId, chapterNo: it.chapterNo, chapterTitle: it.chapterTitle, items: [] }
      map.set(it.chapterId, g)
    }
    g.items.push(it)
  }
  return [...map.values()].sort((a, b) => a.chapterNo - b.chapterNo)
}

/** 一个「问题类型」及其出现在哪些章（2.9.2） */
interface TicketIssueGroup {
  /** `${source}::${title}` —— 归并键，也是界面 `key` */
  key: string
  source: TicketSource
  /** 该类型下**最重**的那一档（同类型在不同章可能被判成不同严重度） */
  severity: IssueSeverity
  title: string
  action: ChapterRewriteAction | 'manual'
  /** 出现的章（按章序排好，供界面直接渲染） */
  chapters: { id: string; no: number; title: string }[]
  /** 出现章数（＝ `chapters.length`，单独给字段便于排序与显示） */
  count: number
}

/**
 * 按**问题类型**聚合（2.9.2）—— 回答「哪类问题在全书里最普遍」。
 *
 * 🔴 与 `groupByChapter` 的分工：后者服务「按章合并改写」这个**执行流**，**不该动**；
 *    本函数服务「看全局」。两者是同一批条目的两种视图，不是替代关系。
 * 🔴 排序口径（**刻意不引入加权公式**）：**严重度分档 → 出现章数降序 → 标题**。
 *    「严重度 × 频次」那种加权会让作者无法预判顺序；分档 + 频次一眼就懂。
 */
export function groupByIssue(items: TicketItem[]): TicketIssueGroup[] {
  const map = new Map<string, TicketIssueGroup>()
  for (const it of items) {
    const key = `${it.source}::${it.title}`
    let g = map.get(key)
    if (!g) {
      g = {
        key, source: it.source, severity: it.severity, title: it.title,
        action: it.action, chapters: [], count: 0,
      }
      map.set(key, g)
    }
    g.chapters.push({ id: it.chapterId, no: it.chapterNo, title: it.chapterTitle })
    g.count += 1
    // 同类型在不同章可能被判成不同严重度 ⇒ 取**最重**的（`SEVERITY_ORDER` 越小越严重）
    if (SEVERITY_ORDER[it.severity] < SEVERITY_ORDER[g.severity]) g.severity = it.severity
    // 动作同理取「**最可执行**」的：`resolveAction` 对历史章给 `manual`、对最新章给可自动动作，
    // 同一类问题只要有一章能自动改，汇总视图就该显示能自动 —— 取第一个会让它显示「需手动处理」，
    // 与按章视图的口径打架（2026-10-09 审计修）。
    if (g.action === 'manual' && it.action !== 'manual') g.action = it.action
  }
  for (const g of map.values()) g.chapters.sort((a, b) => a.no - b.no)
  return [...map.values()].sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || b.count - a.count
    || a.title.localeCompare(b.title))
}

interface RunTicketOpts {
  signal?: AbortSignal
  /** 改写过程的提示（字数校准没生效之类）—— 由调用方转成界面提示 */
  onLog?: (msg: string) => void
  /**
   * 由上层指定归属（3.2.0 · WQ7）：批量执行多章时，上层可以把它们记在**同一个任务**上。
   * 不传 ⇒ 本函数自己建一条 `rewrite` 任务（一章一条，作者能看出每章花了多少）。
   */
  request?: CallRequestContext
}

interface RunTicketResult {
  chapterId: string
  /** 本章条目执行后的状态（`manual` 条目原样保留 pending） */
  items: TicketItem[]
  /** 改前正文（成功时给出，供上层做前后对照） */
  beforeText?: string
  afterText?: string
  error?: string
  /** 改完复检（3.2.0 · W4 闭环：本地引擎，零额度；没跑成就没有这个字段） */
  recheck?: RunRecheck
  /**
   * 实体保留自检（3.2.0 · WQ8 方案 A：只报告不判定）。
   * 🔴 只在**真有话要说**时才带（`summary` 非空）—— 一切正常就不占字段，
   *    界面也不会多出一行"0 个丢失"的废话。
   */
  facts?: FactGuardReport
  /**
   * 本章改写的请求预算快照（3.2.0 · WQ6）。
   * 🔴 界面据此如实显示「预计范围 / 上限 / 实际花了多少」—— 作者事前能看见量级，
   *    事后能核对额度有没有被循环偷偷吃掉。
   */
  budget?: AttemptBudgetSnapshot
}

/** 改完复检的结论 */
export interface RunRecheck {
  /** 复检后仍需动手的问题数（提示级不计） */
  findings: number
  /** 其中冲突级 */
  critical: number
  /** 🔴 改前工单里**仍然存在**的问题 —— 标 done 只是"改过了"，不等于"解决了" */
  stillOpen: string[]
  /** 改前工单里已经解决掉的条数 */
  resolved: number
  /** 复检报告是否留档成功（留档是旁路，失败不影响正文） */
  saved: boolean
}

/**
 * 复检前后比对（纯函数，导出供单测）。
 *
 * 🔴 按**标题**比对而不是按正文片段：正文已被改写，拿片段比对没有意义；
 *    工单条目与复检发现出自同一套引擎措辞（含「错别字：X → Y」这类），标题是可比的。
 */
export function recheckDelta(
  beforeTitles: readonly string[],
  afterFindings: readonly { level?: string; title?: string }[],
): { stillOpen: string[]; resolved: number } {
  const after = new Set(
    afterFindings
      .filter(f => f.level !== '提示')
      .map(f => (f.title ?? '').trim())
      .filter(Boolean),
  )
  const stillOpen = beforeTitles.filter(t => after.has(t))
  return { stillOpen, resolved: beforeTitles.length - stillOpen.length }
}

/** 把所有非 manual、且在被处理集合里的条目标成同一状态 */
function markAll(items: TicketItem[], ids: Set<string>, status: TicketStatus, error: string): TicketItem[] {
  return items.map(i => (!ids.has(i.id) || i.action === 'manual' ? i : { ...i, status, error }))
}

/** 同章多条合并时取"最重"的那档动作（历史章再夹一次，防手动改过 action）。导出供单测。 */
export function pickAction(items: TicketItem[], isLatest: boolean): ChapterRewriteAction {
  const pool = items
    .map(i => i.action)
    .filter((a): a is ChapterRewriteAction => a !== 'manual')
    .filter(a => isLatest || HISTORY_ACTIONS.includes(a))
  if (!pool.length) return 'polish'
  return pool.reduce((best, a) => (ACTION_WEIGHT[a] > ACTION_WEIGHT[best] ? a : best), pool[0])
}

/** 把本章的条目拼成一段「修订清单」，让模型一次改完 */
function requirementOf(items: TicketItem[]): string {
  const lines = items.map((i, n) => {
    const tail = i.suggestion || i.detail
    return `${n + 1}. 【${SOURCE_LABEL[i.source]}】${i.title}${tail ? '：' + tail : ''}`
  })
  return [
    '本章需要按下面这份修订清单处理。只改清单里点到的地方，其余一字不动：',
    ...lines,
  ].join('\n')
}

interface RewriteLedgerHandle { id: string; request: CallRequestContext }

/**
 * 建一条 `rewrite` 任务账。
 * 🔴 静默失败：账本是旁路，**绝不能**因为它写不进去而拦住改写。
 */
async function startRewriteLedger(title: string): Promise<RewriteLedgerHandle | null> {
  try {
    const run = await createRun({
      projectId: db.getCurrentProjectId() ?? '',
      kind: 'rewrite',
      title: `整章改写 · ${title || '（未命名章节）'}`,
      // 基准口径只有一处（别手搓字面量）
      basis: computeBasis([], null),
    })
    return {
      id: run.id,
      request: {
        scope: 'project',
        projectId: run.projectId,
        taskId: run.id,
        taskType: 'rewrite',
      },
    }
  } catch {
    return null
  }
}

/** 收尾账本（静默）：成功 done / 中止 aborted / 异常 failed */
async function settleRewriteLedger(
  h: RewriteLedgerHandle | null,
  status: 'done' | 'aborted' | 'failed',
  err?: unknown,
): Promise<void> {
  if (!h) return
  try {
    const context = pickContextSnapshot(lastContextAssembly(), 0)
    if (status === 'failed') {
      await finishRun(h.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err ?? '改写失败'),
        context,
      })
    } else if (status === 'aborted') {
      await finishRun(h.id, { status: 'aborted', context })
    } else {
      await finishRun(h.id, { status: 'done', outcome: { created: 0, updated: 1, skipped: 0, failed: [] }, context })
    }
  } catch { /* 静默：账本不是关键路径 */ }
}

/**
 * 按章执行：把这一章的待处理条目**合并成一次改写**，落库，最新章再补一轮设定同步。
 *
 * 🔴 为什么必须按章合并：`applyChapterRewrite` 每次都会 cover 整章正文。逐条执行 ⇒ 同一章被覆写 N 次，
 *    不但浪费额度，还会把 12 条/章的快照上限当场打满、把更早的旧稿挤掉。
 */
export async function runTicketChapter(items: TicketItem[], opts: RunTicketOpts = {}): Promise<RunTicketResult> {
  const chapterId = items[0]?.chapterId ?? ''
  const todo = items.filter(i => (i.status === 'pending' || i.status === 'failed') && i.action !== 'manual')
  // 没有可执行的（全 manual / 已处理过）⇒ 原样返回，不算失败
  if (!chapterId || !todo.length) return { chapterId, items }
  const ids = new Set(todo.map(i => i.id))

  const cands = await listRewriteCandidates()
  const idx = cands.findIndex(c => c.chapter.id === chapterId)
  if (idx < 0) {
    return { chapterId, items: markAll(items, ids, 'failed', '这一章已经不在项目里了'), error: '这一章已经不在项目里了' }
  }
  const hit = cands[idx]
  const body = hit.chapter.content ?? ''
  if (!body.trim()) {
    return { chapterId, items: markAll(items, ids, 'failed', '这一章还没有正文'), error: '这一章还没有正文' }
  }
  const isLatest = idx === cands.length - 1
  const prevTail = idx > 0 ? (cands[idx - 1].chapter.content ?? '').trim() : ''

  // 3.2.0 · WQ7：本次改写独占一条任务账（上层已指定归属就沿用，批量执行才好合并）
  const ledger = opts.request ? { id: opts.request.taskId ?? '', request: opts.request } : await startRewriteLedger(hit.chapter.title)
  const request = ledger?.request
  // 3.2.0 · WQ6：**每章一份**改写预算（不是全局单例）—— 并行任务各记各的，到上限暂停不嵌套追加。
  // 🔴 与连写侧同口径：主改写、补写、压缩、最新章设定整理都从这一份里扣。
  const budget = createAttemptBudget({ label: `第 ${hit.no} 章改写`, max: REWRITE_ATTEMPT_BUDGET })

  let text = ''
  try {
    text = await aiRewriteChapter({
      title: hit.chapter.title,
      body,
      action: pickAction(todo, isLatest),
      requirement: requirementOf(todo),
      isLatest,
      ...(prevTail ? { contextTail: prevTail } : {}),
      signal: opts.signal,
      onLog: opts.onLog,
      ...(request ? { request } : {}),
      budget,
    })
  } catch (e) {
    // 🔴 中止 ⇒ 条目**保持 pending**，不是 failed（见文件头纪律 ④）
    if (isCancelled(e) || opts.signal?.aborted) {
      await settleRewriteLedger(ledger, 'aborted')
      return { chapterId, items, budget: budget.snapshot() }
    }
    // 🔴 预算耗尽也是**暂停**：标 failed 会让人以为"这条修不了"，重试还会继续烧额度
    if (isRequestBudgetExhausted(e)) {
      const msg = e instanceof Error ? e.message : '模型请求已达上限'
      opts.onLog?.(msg)
      await settleRewriteLedger(ledger, 'aborted')
      return { chapterId, items, error: msg, budget: budget.snapshot() }
    }
    const msg = e instanceof Error ? e.message : String(e)
    await settleRewriteLedger(ledger, 'failed', e)
    return { chapterId, items: markAll(items, ids, 'failed', msg), error: msg, budget: budget.snapshot() }
  }

  if (!text.trim()) {
    const msg = '模型没有返回可用正文，可以再试一次'
    await settleRewriteLedger(ledger, 'failed', msg)
    return { chapterId, items: markAll(items, ids, 'failed', msg), error: msg }
  }

  try {
    // 🔴 落库只走这条既有链：先留快照、只动三字段、同步章节台账（本模块不复制这套逻辑）
    await applyChapterRewrite(chapterId, text, 'rewritten')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await settleRewriteLedger(ledger, 'failed', e)
    return { chapterId, items: markAll(items, ids, 'failed', msg), error: msg }
  }

  // 最新章才补跑设定同步（历史章的设定类内容按纪律整体冻结，它不产生新设定）
  if (isLatest) {
    if (budget.exhausted) {
      // 🔴 预算到顶就**暂停**，不嵌套追加：正文已落库，设定整理留待作者手动补（如实说）
      opts.onLog?.(`${budget.describe()} —— 设定整理已跳过（正文已落库，可去设定表手动补）`)
    } else {
      try {
        // 设定整理也计入本章预算（抽取 1 次；auto-update 策略的变化检测同样从这份里扣）
        await extractAndCommitSettings(text, hit.chapter.title, 'add-only', undefined, opts.signal, request, budget)
      } catch (e) {
        // 🔴 别静默吞：正文已落库（不回滚），但「改完最新章却没同步出新设定」会让作者以为设定齐了。
        //    至少留一行日志 —— 作者可去设定表手动补。
        console.warn('[optimizeTicket] 最新章改写后设定同步失败（正文已落库，可去设定表手动补）：', e)
      }
    }
  }

  // 3.2.0 · W3/WQ7：改写采纳也是一条候选（指纹取改后正文），账本里能看到「改了几稿、各是什么」
  if (ledger?.id) {
    noteCandidate(ledger.id, { target: `chapter:${chapterId}`, fingerprint: hashOf(text), state: 'adopted' })
  }

  // 3.2.0 · W4 闭环：**改完复检**（五个本地引擎，零额度）。
  // 🔴 条目标 `done` 只代表"这一章改过了"，不代表"问题解决了" —— 不复检，作者看到的就是
  //    「执行完一片绿」，而错别字/敏感词可能一个没动。复检免费，所以没有不做的理由。
  let recheck: RunRecheck | undefined
  let facts: FactGuardReport | undefined
  if (!opts.signal?.aborted) {
    try {
      const after = await runChapterCheck({ ...hit.chapter, content: text })
      const findings = chapterReportToFindings(after)
      const delta = recheckDelta(todo.map(i => i.title), findings)
      const saved = await persistCheckReports({
        projectId: db.getCurrentProjectId() ?? '',
        jobId: LOCAL_TICKET_JOB_ID,
        reports: [{
          checkId: 'chapter-check',
          source: 'local-recheck',
          run: chapterReportToRun(after),
          // 证据快照按**改后的正文**定位（这才是复检看到的正文）
          evidence: evidenceOfFindings(findings, text),
          chapterId,
          chapterNo: hit.no,
          chapterTitle: hit.chapter.title,
        }],
      })
      recheck = {
        findings: findings.filter(f => f.level !== '提示').length,
        critical: findings.filter(f => f.level === '严重').length,
        stillOpen: delta.stillOpen,
        resolved: delta.resolved,
        saved: saved.saved > 0,
      }
    } catch (e) {
      // 🔴 复检是**旁路**：跑了更好，跑不成也不该把已落库的正文报成失败 ——
      //    只是这一章没有「改完到底改好没」的记录，界面会如实说"复检没跑成"。
      console.warn('[optimizeTicket] 改完复检没跑成（正文已落库）：', e)
    }

    // 3.2.0 · WQ8 文本守卫（方案 A：只报告不判定）—— 登记实体改写后还在不在。
    // 🔴 同样全程不抛：宁可没有这份自检，也不能因为它把已落库的正文说成有问题。
    try {
      facts = await checkFactRetention(await loadRegistry(), body, text)
    } catch (e) {
      console.warn('[optimizeTicket] 实体保留自检没跑成（正文已落库）：', e)
    }
  }

  await settleRewriteLedger(ledger, 'done')
  return {
    chapterId, items: markAll(items, ids, 'done', ''), beforeText: body, afterText: text,
    ...(recheck ? { recheck } : {}),
    ...(facts?.summary ? { facts } : {}),
    budget: budget.snapshot(),
  }
}
