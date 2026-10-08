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
import type { IssueSeverity } from './audit'
import { SEVERITY_ORDER } from './audit'
import type { ChapterCheckReport } from './chapterCheck'
import { runChapterCheck } from './chapterCheck'
import type { ChapterRewriteAction } from './aiTasks'
import { CHAPTER_REWRITE_META, aiRewriteChapter } from './aiTasks'
import {
  applyChapterRewrite, listRewriteCandidates,
  type RewriteCandidate,
} from './chapterRewrite'
import { extractAndCommitSettings } from './autoContinue'
import { isCancelled } from './ai'

/** 工单条目的来源分类 */
export type TicketSource =
  | 'continuity' | 'foreshadow' | 'style' | 'typo' | 'sensitive'
  | 'ai-review' | 'ai-ooc' | 'ai-pleasure'

/** 条目状态（`skipped` = 作者主动跳过；`manual` 不是状态而是 action，见下） */
export type TicketStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

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

export interface BuildTicketOpts {
  /** 只查这些章（不传＝全部章）。用于「只诊断勾选的那几章」 */
  chapterIds?: string[]
  signal?: AbortSignal
  /** 进度回调（已查章数 / 总章数） */
  onProgress?: (done: number, total: number) => void
}

/**
 * 跑一遍诊断、汇总成工单。**只读不写**（五个引擎全是本地确定性检查，零 AI 请求、零成本）。
 * 结果按「章序 → 严重度 → 来源」排序并去重。
 */
export async function buildTicket(opts: BuildTicketOpts = {}): Promise<TicketItem[]> {
  const cands = await listRewriteCandidates()
  // 🔴 最新章判据与 creativeSession 同源：候选列表是按真实叙事序排的，最后一个就是最新章
  const latestId = cands.length ? cands[cands.length - 1].chapter.id : ''
  const want = opts.chapterIds?.length ? new Set(opts.chapterIds) : null
  const targets = want ? cands.filter(c => want.has(c.chapter.id)) : cands

  const out: TicketItem[] = []
  let done = 0
  for (const c of targets) {
    if (opts.signal?.aborted) break
    // 空章跳过（没正文没什么可诊断的），但仍然计入进度
    if ((c.chapter.content ?? '').trim()) {
      const rep = await runChapterCheck(c.chapter).catch(e => {
        // 🔴 别静默吞：某章检查抛错时该章被跳过，工单会呈现成「诊断完成、没有问题」而掩盖漏检。
        //    但一次读失败不该让整张工单中断 —— 记一行日志，继续诊断其余章。
        console.warn(`[optimizeTicket] 一章诊断失败（已跳过）：${c.chapter.title}`, e)
        return null
      })
      if (rep) out.push(...issuesOf(c, rep, c.chapter.id === latestId))
    }
    done++
    opts.onProgress?.(done, targets.length)
  }
  return sortAndDedup(out)
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

export interface TicketChapterGroup {
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
export interface TicketIssueGroup {
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
  }
  for (const g of map.values()) g.chapters.sort((a, b) => a.no - b.no)
  return [...map.values()].sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || b.count - a.count
    || a.title.localeCompare(b.title))
}

export interface RunTicketOpts {
  signal?: AbortSignal
  /** 改写过程的提示（字数校准没生效之类）—— 由调用方转成界面提示 */
  onLog?: (msg: string) => void
}

export interface RunTicketResult {
  chapterId: string
  /** 本章条目执行后的状态（`manual` 条目原样保留 pending） */
  items: TicketItem[]
  /** 改前正文（成功时给出，供上层做前后对照） */
  beforeText?: string
  afterText?: string
  error?: string
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
    })
  } catch (e) {
    // 🔴 中止 ⇒ 条目**保持 pending**，不是 failed（见文件头纪律 ④）
    if (isCancelled(e) || opts.signal?.aborted) return { chapterId, items }
    const msg = e instanceof Error ? e.message : String(e)
    return { chapterId, items: markAll(items, ids, 'failed', msg), error: msg }
  }

  if (!text.trim()) {
    const msg = '模型没有返回可用正文，可以再试一次'
    return { chapterId, items: markAll(items, ids, 'failed', msg), error: msg }
  }

  try {
    // 🔴 落库只走这条既有链：先留快照、只动三字段、同步章节台账（本模块不复制这套逻辑）
    await applyChapterRewrite(chapterId, text, 'rewritten')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { chapterId, items: markAll(items, ids, 'failed', msg), error: msg }
  }

  // 最新章才补跑设定同步（历史章的设定类内容按纪律整体冻结，它不产生新设定）
  if (isLatest) {
    try {
      await extractAndCommitSettings(text, hit.chapter.title, 'add-only', undefined, opts.signal)
    } catch (e) {
      // 🔴 别静默吞：正文已落库（不回滚），但「改完最新章却没同步出新设定」会让作者以为设定齐了。
      //    至少留一行日志 —— 作者可去设定表手动补。
      console.warn('[optimizeTicket] 最新章改写后设定同步失败（正文已落库，可去设定表手动补）：', e)
    }
  }

  return { chapterId, items: markAll(items, ids, 'done', ''), beforeText: body, afterText: text }
}
