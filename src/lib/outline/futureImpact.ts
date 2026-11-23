// ============ 未来影响分析（W2-1 · 未来演化边界） ============
//
// 为什么有它（见 docs/归档/3.0/3.0-开发方案.md §10.3 #3）：
//   「未来演化边界」—— 已写历史保持稳定；上游（已写正文 / 设定）一变，
//   开书时定下的「未来计划」（章纲卡里对**尚未开写**章节的规划）就可能已过时。
//   若不提示，作者会拿着过期计划往下写（与 `chapterMaster.backfillOutlineEvent`
//   注释里说的「拿着过期的计划去写新章」是同一个病）。
//
// 本项目落地口径（**只做章号维度的确定性标记，不做语义分析**）：
//   · 「未来计划」＝ 章纲卡（chapter-outline）中 **章号 > 上游变化章号** 的条目；
//   · 上游变化（正文被改写 / 设定被改）⇒ 这些条目标记「待重审」；
//   · 🔴 **只标记 + 提示，绝不自动改章纲内容**（沿用「AI 只辅助」红线）。
//
// 存储：项目级 `settingsKV`，键 `futureImpact`（`db.getSetting/setSetting` 自带 `<pid>::` 前缀）。
//   刻意只存「章号 + 原因 + 时间」这几十字节 —— 价值在于提醒作者「这几章的计划要重看一眼」，
//   不在于变成一个可编辑的第二数据源（与 `checkLog` 的取舍同口径）。
//
// 📌 触发点：`chapterRewrite.applyChapterRewrite` 成功后（唯一会覆盖作者正文的路径，
//    与 W1-1 版本保护同处）+ 章后整理确认后（W2-1b）。
import * as db from '@/lib/db'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import { OUTLINE_TAB_ID, chapterNoOf } from '@/lib/outline/outlineCard'
import { chapterSeqMap, chapterSeqOf } from '@/lib/outline/chapterSeq'
import type { ChangeEvidence } from '@/lib/revision/changeEvents'

/** settingsKV 键 —— `db.getSetting/setSetting` 自带 `<pid>::` 前缀，这里不必再拼 */
const SETTING_KEY = 'futureImpact'
/** 3.7.0 · W1：「已写章节建议复核」清单（总纲 / 卷纲变更会波及已写正文，只列清单、不打标） */
const SUGGEST_KEY = 'outlineReviewSuggest'
/** 标记上限：够提醒即可，不做无限增长（每章最多一条，500 够写 500 章） */
const MAX_MARKS = 500

export interface ImpactMark {
  /** 受影响的未来章号（章纲卡里的章号） */
  chapterNo: number
  /** 因哪一章的变化而失效 */
  fromChapterNo: number
  /** 原因（正文改写 / 设定变化 / 章后整理） */
  reason: string
  /** 打标时间 */
  at: number
  /**
   * 3.6.1 · 证据层：变化处的「改前 → 改后」引用（各 ≤300 字）。
   * 🔴 可选：3.6.1 之前打的标记没有这一项，界面要如实说明「这条没留下引用」，
   *    不能假装有依据。改动处置状态机不在此列（本版刻意不接）。
   */
  evidence?: ChangeEvidence
  /**
   * 3.7.0 · W1：来源的可读描述（总纲 / 卷纲变更时没有「某一章」可指，用它代替
   * `fromChapterNo` 的叙述）。缺省时界面仍显示「因第 N 章……」——旧标记不受影响。
   */
  origin?: string
}

/** 章号是否可用（正整数才参与计算；章纲卡解析不出章号时 `chapterNoOf` 返 0） */
function usableNo(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

/**
 * 纯函数：给定「上游变化的章号」「未来章纲章号列表」→ 产出受影响标记。
 *
 * 🔴 只用 `> fromNo`（严格大于）：**变化章本身不属于「未来计划」**，
 *   它是已写历史的一部分（上游），不该被自己标记。
 */
export function planImpact(
  fromNo: number, futureNos: number[], reason: string, at: number, evidence?: ChangeEvidence,
): ImpactMark[] {
  if (!usableNo(fromNo)) return []
  const uniq = [...new Set(futureNos.filter(usableNo).filter(n => n > fromNo))].sort((a, b) => a - b)
  return uniq.map(n => ({ chapterNo: n, fromChapterNo: fromNo, reason, at, ...(evidence ? { evidence } : {}) }))
}

/**
 * 纯函数：把新标记并入旧标记。
 * 同一章号**以新标记为准**（最近一次上游变化才是作者该关注的），并按章号排序。
 */
export function mergeMarks(old: ImpactMark[], news: ImpactMark[]): ImpactMark[] {
  const map = new Map<number, ImpactMark>()
  for (const m of old) if (usableNo(m.chapterNo)) map.set(m.chapterNo, m)
  for (const m of news) if (usableNo(m.chapterNo)) map.set(m.chapterNo, m)
  return [...map.values()].sort((a, b) => a.chapterNo - b.chapterNo).slice(-MAX_MARKS)
}

// ==================== 3.7.0 · W1：三类大纲变更的批量影响计划 ====================
//
// 为什么新增这一层（见规划 §3 W1.2）：
//   · 细纲变更 → 以「变化章号」为上界（> 该章的**未开写**章）；
//   · 卷纲变更 → 该卷章号范围内的未开写章（卷纲没有「某一章」，用范围换算）；
//   · 总纲变更 → 全部未开写章；**已写章只列「建议复核」清单，不自动打标**
//     （已写章受不受影响是语义判断，确定性规则判不了，如实呈现给作者）。
//   · 批量写（AI 整理 / 导入 / MCP）会连发几十上百条事实 —— 这里一次算完、一次落库。

export interface ImpactRequest {
  kind: 'chapter' | 'volume' | 'master'
  /** chapter：变化章章号 */
  chapterNo?: number
  /** volume：该卷章号范围（由「本卷章号范围」解析） */
  range?: { from: number; to: number }
  reason: string
  /** 来源可读描述（如「全书总纲」「《风起云州》」「第 3 章」） */
  origin: string
  evidence?: ChangeEvidence
}

/** 已写章节的「建议复核」条目（只提示、不打标、不改章纲） */
export interface ReviewSuggestion {
  chapterNo: number
  reason: string
  origin: string
  at: number
}

export interface ImpactPlan {
  marks: ImpactMark[]
  suggestions: ReviewSuggestion[]
}

/**
 * 纯函数：把三类变更请求算成「打标 + 建议复核」两份清单。
 *
 * 🔴 未开写 = 该章号没有一篇有正文的章节（见 `writtenChapterNos`）；
 *    已写章不进入「待重审」标记 —— W1 验收明确要求「已写章不误标」。
 */
export function planImpactRequests(
  reqs: ImpactRequest[], outlineNos: number[], writtenNos: readonly number[], at: number,
): ImpactPlan {
  const written = new Set(writtenNos.filter(usableNo))
  const nos = [...new Set(outlineNos.filter(usableNo))].sort((a, b) => a - b)
  const markMap = new Map<number, ImpactMark>()
  const suggestMap = new Map<number, ReviewSuggestion>()
  for (const req of reqs) {
    if (!req || !req.origin) continue
    let targets: number[] = []
    let fromNo = 0
    if (req.kind === 'chapter') {
      if (!usableNo(req.chapterNo)) continue
      targets = nos.filter(n => n > req.chapterNo!)
      fromNo = req.chapterNo!
    } else if (req.kind === 'volume') {
      const r = req.range
      if (!r || !usableNo(r.from) || !usableNo(r.to) || r.to < r.from) continue
      targets = nos.filter(n => n >= r.from && n <= r.to)
      fromNo = r.from
    } else if (req.kind === 'master') {
      targets = nos
    } else continue
    for (const n of targets) {
      if (written.has(n)) {
        // 细纲变更的影响面本来就限定在「该章之后」，已写的后章不在此列
        if (req.kind === 'chapter') continue
        suggestMap.set(n, { chapterNo: n, reason: req.reason, origin: req.origin, at })
        continue
      }
      markMap.set(n, {
        chapterNo: n, fromChapterNo: fromNo, reason: req.reason, origin: req.origin, at,
        ...(req.evidence ? { evidence: req.evidence } : {}),
      })
    }
  }
  return {
    marks: [...markMap.values()].sort((a, b) => a.chapterNo - b.chapterNo).slice(-MAX_MARKS),
    suggestions: [...suggestMap.values()].sort((a, b) => a.chapterNo - b.chapterNo).slice(-MAX_MARKS),
  }
}

/** 纯函数：建议清单按章号合并（最近的变更覆盖旧的），并按章号排序 */
export function mergeSuggestions(old: ReviewSuggestion[], news: ReviewSuggestion[]): ReviewSuggestion[] {
  const map = new Map<number, ReviewSuggestion>()
  for (const s of old) if (usableNo(s?.chapterNo)) map.set(s.chapterNo, s)
  for (const s of news) if (usableNo(s?.chapterNo)) map.set(s.chapterNo, s)
  return [...map.values()].sort((a, b) => a.chapterNo - b.chapterNo).slice(-MAX_MARKS)
}

/** 读「已写章节建议复核」清单（损坏一律返回空数组） */
export async function readReviewSuggestions(owner?: OwnedOperation): Promise<ReviewSuggestion[]> {
  try {
    const raw = owner
      ? await db.getSettingFor<ReviewSuggestion[]>(owner.projectId, SUGGEST_KEY, [], owner)
      : await db.getSetting<ReviewSuggestion[]>(SUGGEST_KEY, [])
    if (!Array.isArray(raw)) return []
    return raw.filter(s => s && usableNo(s.chapterNo))
  } catch {
    return []
  }
}

/** 作者处理完后清「建议复核」清单：传章号清单条，不传清全部 */
export async function clearReviewSuggestions(chapterNo?: number): Promise<void> {
  try {
    if (!usableNo(chapterNo)) { await db.setSetting(SUGGEST_KEY, []); return }
    await db.setSetting(SUGGEST_KEY, (await readReviewSuggestions()).filter(s => s.chapterNo !== chapterNo))
  } catch {
    // 同上：静默（提示功能不配让主流程失败）
  }
}

/** 已写章的章号清单：有正文（trim 后非空）且占号（`excludeFromNumbering` / 自由卷不占号） */
async function writtenChapterNos(owner?: OwnedOperation): Promise<number[]> {
  const vols = owner ? await db.getAllVolumes(owner) : await db.getAllVolumes()
  const chs = owner ? await db.getAllChapters(owner) : await db.getAllChapters()
  const seq = chapterSeqMap(vols, chs)
  const nos: number[] = []
  for (const c of chs) {
    if (!(c.content ?? '').trim()) continue
    const n = seq.get(c.id) ?? 0
    if (usableNo(n)) nos.push(n)
  }
  return [...new Set(nos)]
}

/**
 * 批量落库：一次读章纲、一次算计划、一次写标记 —— 消费者按项目防抖合并后调它。
 *
 * 🔴 全程 try/catch 静默：打标是旁路，任何异常都不能让保存失败（保存早已完成）。
 */
export async function applyImpactRequests(
  reqs: ImpactRequest[], at = Date.now(), owner?: OwnedOperation,
): Promise<ImpactPlan> {
  const empty: ImpactPlan = { marks: [], suggestions: [] }
  if (!reqs.length) return empty
  try {
    const cards = owner
      ? await db.getCardRecordsFor(owner.projectId, OUTLINE_TAB_ID, owner)
      : await db.getCardRecords(OUTLINE_TAB_ID)
    const written = await writtenChapterNos(owner)
    const plan = planImpactRequests(reqs, cards.map(c => chapterNoOf(c.name)), written, at)
    if (!plan.marks.length && !plan.suggestions.length) return plan
    owner?.assertCurrent()
    try {
      if (plan.marks.length) {
        const merged = mergeMarks(await readImpact(owner), plan.marks)
        if (owner) await db.setSettingFor(owner.projectId, SETTING_KEY, merged, owner)
        else await db.setSetting(SETTING_KEY, merged)
      }
      if (plan.suggestions.length) {
        const merged = mergeSuggestions(await readReviewSuggestions(owner), plan.suggestions)
        if (owner) await db.setSettingFor(owner.projectId, SUGGEST_KEY, merged, owner)
        else await db.setSetting(SUGGEST_KEY, merged)
      }
    } catch {
      return empty
    }
    return plan
  } catch {
    return empty
  }
}

/**
 * 章后整理（3.7.0 · W1 兑现 `futureImpact` 旧注释承诺）：按章 id 现算叙事序号再打标。
 * 此路径不经 changeBus（整理落库是 `applyPostProcess` 内部多次写，逐条发射会风暴）。
 */
export async function analyzeChapterFutureImpact(
  chapterId: string, reason: string, owner?: OwnedOperation, evidence?: ChangeEvidence,
): Promise<ImpactMark[]> {
  try {
    const vols = owner ? await db.getAllVolumes(owner) : await db.getAllVolumes()
    const chs = owner ? await db.getAllChapters(owner) : await db.getAllChapters()
    const seq = chapterSeqOf(vols, chs, chapterId)
    if (!usableNo(seq)) return []
    return await analyzeFutureImpact(seq, reason, Date.now(), owner, evidence)
  } catch {
    return []
  }
}

/** 读当前全部标记（读不到 / 数据损坏一律返回空数组，绝不抛） */
export async function readImpact(owner?: OwnedOperation): Promise<ImpactMark[]> {
  try {
    const raw = owner ? await db.getSettingFor<ImpactMark[]>(owner.projectId, SETTING_KEY, [], owner) : await db.getSetting<ImpactMark[]>(SETTING_KEY, [])
    if (!Array.isArray(raw)) return []
    return raw.filter(m => m && usableNo(m.chapterNo))
  } catch {
    return []
  }
}

/**
 * 取「未来计划」章号列表：章纲卡中章号 > fromNo 的那些。
 * 章纲卡由作者手建（`outlineCardName(no, title)` 生成、章号可从卡名解析）。
 */
async function futureOutlineNos(fromNo: number, owner?: OwnedOperation): Promise<number[]> {
  if (!usableNo(fromNo)) return []
  try {
    const cards = owner ? await db.getCardRecordsFor(owner.projectId, OUTLINE_TAB_ID, owner) : await db.getCardRecords(OUTLINE_TAB_ID)
    const nos: number[] = []
    for (const c of cards) {
      const n = chapterNoOf(c.name)
      if (usableNo(n) && n > fromNo) nos.push(n)
    }
    return [...new Set(nos)].sort((a, b) => a - b)
  } catch {
    return []
  }
}

/**
 * 分析并落标记：上游第 `fromChapterNo` 章变化 ⇒ 找出受影响的未来计划并打标。
 *
 * @returns 本次新打上的标记（可能为空 —— 该项目还没写章纲、或变化的是最后一章）
 */
export async function analyzeFutureImpact(
  fromChapterNo: number, reason: string, at = Date.now(), owner?: OwnedOperation, evidence?: ChangeEvidence,
): Promise<ImpactMark[]> {
  if (!usableNo(fromChapterNo)) return []
  const futureNos = await futureOutlineNos(fromChapterNo, owner)
  owner?.assertCurrent()
  const news = planImpact(fromChapterNo, futureNos, reason, at, evidence)
  if (!news.length) return []
  try {
    const merged = mergeMarks(await readImpact(owner), news)
    owner?.assertCurrent()
    if (owner) await db.setSettingFor(owner.projectId, SETTING_KEY, merged, owner)
    else await db.setSetting(SETTING_KEY, merged)
  } catch {
    // 打标失败静默 —— 它只是提醒，绝不能因此让改写 / 章后整理失败
    return []
  }
  return news
}

/** 作者处置后清标记：传章号清单条，不传清全部 */
export async function clearImpact(chapterNo?: number): Promise<void> {
  try {
    if (!usableNo(chapterNo)) {
      await db.setSetting(SETTING_KEY, [])
      return
    }
    const left = (await readImpact()).filter(m => m.chapterNo !== chapterNo)
    await db.setSetting(SETTING_KEY, left)
  } catch {
    // 同上：静默
  }
}
