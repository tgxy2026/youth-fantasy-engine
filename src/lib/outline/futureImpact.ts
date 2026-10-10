// ============ 未来影响分析（W2-1 · 未来演化边界） ============
//
// 为什么有它（见 docs/3.0-开发方案.md §10.3 #3）：
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
import { OUTLINE_TAB_ID, chapterNoOf } from '@/lib/outline/outlineCard'

/** settingsKV 键 —— `db.getSetting/setSetting` 自带 `<pid>::` 前缀，这里不必再拼 */
const SETTING_KEY = 'futureImpact'
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
  fromNo: number, futureNos: number[], reason: string, at: number,
): ImpactMark[] {
  if (!usableNo(fromNo)) return []
  const uniq = [...new Set(futureNos.filter(usableNo).filter(n => n > fromNo))].sort((a, b) => a - b)
  return uniq.map(n => ({ chapterNo: n, fromChapterNo: fromNo, reason, at }))
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

/** 读当前全部标记（读不到 / 数据损坏一律返回空数组，绝不抛） */
export async function readImpact(): Promise<ImpactMark[]> {
  try {
    const raw = await db.getSetting<ImpactMark[]>(SETTING_KEY, [])
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
async function futureOutlineNos(fromNo: number): Promise<number[]> {
  if (!usableNo(fromNo)) return []
  try {
    const cards = await db.getCardRecords(OUTLINE_TAB_ID)
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
  fromChapterNo: number, reason: string, at = Date.now(),
): Promise<ImpactMark[]> {
  if (!usableNo(fromChapterNo)) return []
  const futureNos = await futureOutlineNos(fromChapterNo)
  const news = planImpact(fromChapterNo, futureNos, reason, at)
  if (!news.length) return []
  try {
    const merged = mergeMarks(await readImpact(), news)
    await db.setSetting(SETTING_KEY, merged)
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
