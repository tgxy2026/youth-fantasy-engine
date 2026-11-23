// ============ 变更监视：把 db 变更事实接到「影响标记 / 主动过期」（3.7.0 · W1）============
//
// 为什么有它（见规划 §3 W1.2 / R1）：
//   保存路径不止一条（手填 / 草稿合并 / AI 写入 / 导入 / MCP），钩子挂在 db 收口点；
//   db 层只发事实（`db/changeBus`），**判断哪条事实意味着什么**在这里：
//     · 总纲（`master`，form）/ 卷纲（`volume-outline`）/ 细纲（`chapter-outline`）
//       → 未来章「待重审」标记（W1）；
//     · 正文（`saveChapter` / `patchChapter`）/ 细纲 / 设定 → 候选与报告过期（W2）。
//
// 🔴 三个纪律：
//   ① **批量合并**：导入 / AI 整理 / MCP 会连发几十上百条事实，按项目 300ms 防抖，
//      合并成一次分析（不是逐条跑）；
//   ② **旁路**：这里任何异常都在内部吞掉，保存结果不受影响；
//   ③ **空变更不打标**：消费者比对前后值（含卡名），一致就跳过。
import {
  onDbChange, type DbChangeFact, type DbChangePayload,
} from '@/lib/db/changeBus'
import {
  applyImpactRequests, type ImpactRequest, type ImpactPlan, type ReviewSuggestion,
} from '@/lib/outline/futureImpact'
import {
  OUTLINE_TAB_ID, VOLUME_OUTLINE_TAB_ID, chapterNoOf, parseChapterRange, volumeBoundTextsOf,
} from '@/lib/outline/outlineCard'
import { buildChangeEvidence, type ChangeEvidence } from '@/lib/revision/changeEvents'
import { captureOwnedOperation, type OwnedOperation } from '@/lib/storage/ownedOperation'
import { expireRevisionCandidatesForChapter, expireRevisionCandidatesForProject } from '@/lib/revision/candidateExpiry'
import { refreshPlotCandidateStaleness } from '@/lib/creative/plotCandidateStore'
import { chapterSeqMap } from '@/lib/outline/chapterSeq'
import * as db from '@/lib/db'

/** 全书总纲：唯一的大纲**表单**页签（`src/lib/schemaTabs/part1.ts:96`） */
export const MASTER_TAB_ID = 'master'

/** 批量写合并窗口：300ms 内同项目的全部事实合成一次分析 */
export const WATCH_DEBOUNCE_MS = 300

/** 可注入的时钟（测试用假时钟断言防抖；生产用全局 setTimeout） */
export interface WatchClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const defaultClock: WatchClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown,
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

let clock: WatchClock = defaultClock

/** 注入时钟（**仅测试用**；传 null 恢复默认） */
export function setWatchClock(next: WatchClock | null): void {
  clock = next ?? defaultClock
}

/** 监视器运行统计（诊断 / 测试断言「100 条只分析一次」） */
export const watchStats = { flushes: 0, analyses: 0, skippedNoRange: 0, errors: 0 }

export function resetWatchStats(): void {
  watchStats.flushes = 0
  watchStats.analyses = 0
  watchStats.skippedNoRange = 0
  watchStats.errors = 0
}

/** 待处理事实：pid → (kind:tab:record → 合并后的一条)。后发覆盖前发，但保留最早的改前值 */
const pending = new Map<string, Map<string, DbChangeFact>>()
const timers = new Map<string, unknown>()
const running = new Set<Promise<void>>()

let unsubscribe: (() => void) | null = null

/**
 * 注册消费者（应用启动时调一次；重复调用返回同一个退订函数）。
 *
 * `main.tsx` 里注册；测试里注册后记得退订 + `clearDbChangeListeners()`。
 */
export function registerChangeWatch(): () => void {
  if (unsubscribe) return unsubscribe
  const off = onDbChange(fact => { accept(fact) })
  unsubscribe = () => {
    off()
    unsubscribe = null
    for (const handle of timers.values()) clock.clearTimeout(handle)
    timers.clear()
    pending.clear()
  }
  return unsubscribe
}

function accept(fact: DbChangeFact): void {
  if (!fact || !fact.pid) return
  const key = `${fact.kind}:${fact.tabId}:${fact.recordId}`
  let map = pending.get(fact.pid)
  if (!map) { map = new Map(); pending.set(fact.pid, map) }
  const prev = map.get(key)
  // 同一记录在窗口内被写多次（正文自动保存）：改前值取最早的，改后值取最新的
  map.set(key, prev ? { ...fact, before: prev.before ?? fact.before } : fact)
  schedule(fact.pid)
}

function schedule(pid: string): void {
  const existing = timers.get(pid)
  if (existing !== undefined) clock.clearTimeout(existing)
  const handle = clock.setTimeout(() => {
    timers.delete(pid)
    track(flushProject(pid))
  }, WATCH_DEBOUNCE_MS)
  timers.set(pid, handle)
}

function track(task: Promise<void>): void {
  running.add(task)
  void task.catch(() => undefined).finally(() => running.delete(task))
}

/** 等手上这批分析跑完（测试 / 收尾断言用；生产不需要调） */
export async function whenIdle(): Promise<void> {
  while (running.size) await Promise.allSettled([...running])
}

async function flushProject(pid: string): Promise<void> {
  const facts = [...(pending.get(pid)?.values() ?? [])]
  pending.delete(pid)
  if (!facts.length) return
  watchStats.flushes++
  const requests: ImpactRequest[] = []
  const changedChapters = new Set<string>()
  const outlineCards: { cardId: string; chapterNo: number }[] = []
  let settingsTouched = false
  for (const fact of facts) {
    const req = impactRequestOf(fact)
    if (req) {
      requests.push(req)
      if (req.kind === 'chapter' && fact.tabId === OUTLINE_TAB_ID && typeof req.chapterNo === 'number') {
        outlineCards.push({ cardId: fact.recordId, chapterNo: req.chapterNo })
      }
      continue
    }
    if (fact.kind === 'chapter') {
      if (fact.contentChanged) changedChapters.add(fact.recordId)
      continue
    }
    // 大纲收口点空变更（保存未改值）：既不打标、也不算“分析过一次”
    if (fact.tabId === MASTER_TAB_ID || fact.tabId === VOLUME_OUTLINE_TAB_ID || fact.tabId === OUTLINE_TAB_ID) continue
    // 其余 form/row/card 都是设定类写入
    settingsTouched = true
  }
  if (!requests.length && !changedChapters.size && !outlineCards.length && !settingsTouched) return
  watchStats.analyses++
  const owner: OwnedOperation = captureOwnedOperation(pid)
  try { owner.assertCurrent() } catch { watchStats.errors++; return }
  // ① 大纲影响标记（W1）：一次算完、一次落库
  if (requests.length) {
    try {
      const plan: ImpactPlan = await applyImpactRequests(requests, Date.now(), owner)
      void plan
    } catch { watchStats.errors++ }
  }
  // ② 候选 / 剧情候选过期（W2）：正文与细纲的变更各自记账
  try {
    const chapters = changedChapters.size || outlineCards.length ? await db.getAllChapters(owner) : []
    const seq = chapters.length ? chapterSeqMap(await db.getAllVolumes(owner), chapters) : new Map<string, number>()
    const chapterIdOfNo = (no: number) => chapters.find(c => (seq.get(c.id) ?? 0) === no)?.id
    for (const chapterId of changedChapters) {
      await expireRevisionCandidatesForChapter(chapterId, owner)
      const no = seq.get(chapterId) ?? 0
      if (no > 0) await refreshPlotCandidateStaleness(pid, { chapterNo: no })
    }
    for (const card of outlineCards) {
      const chapterId = chapterIdOfNo(card.chapterNo)
      if (chapterId) await expireRevisionCandidatesForChapter(chapterId, owner)
      await refreshPlotCandidateStaleness(pid, { cardId: card.cardId, ...(card.chapterNo ? { chapterNo: card.chapterNo } : {}) })
    }
    // 设定变更没有“哪一章”可指 ⇒ 按项目扫还挂着的候选（防抖已把批量写合并）
    if (settingsTouched) await expireRevisionCandidatesForProject(pid, owner)
  } catch (error) {
    // 旁路：保存早已完成；这里失败只影响提示，不影响数据
    watchStats.errors++
    void error
  }
}

/** 一条事实 → 一条影响分析请求；不是大纲收口点 / 空变更 / 无法定范围 → null */
function impactRequestOf(fact: DbChangeFact): ImpactRequest | null {
  if (fact.kind !== 'form' && fact.kind !== 'row' && fact.kind !== 'card') return null
  const evidence = outlineEvidenceOf(fact)
  const after = fact.after
  if (!after || !evidence) return null // 空变更（保存未改值）不打标
  if (fact.tabId === MASTER_TAB_ID) {
    return { kind: 'master', reason: '总纲变更', origin: '全书总纲', evidence }
  }
  if (fact.tabId === VOLUME_OUTLINE_TAB_ID) {
    const range = volumeRangeOf(fact)
    if (!range) { watchStats.skippedNoRange++; return null }
    return {
      kind: 'volume', range, reason: '卷纲变更',
      origin: after.name ? `《${after.name}》` : `第${range.from}-${range.to}章卷`, evidence,
    }
  }
  if (fact.tabId === OUTLINE_TAB_ID) {
    const no = chapterNoOf(after.name ?? '')
    if (!(no > 0)) return null
    return { kind: 'chapter', chapterNo: no, reason: '细纲变更', origin: `第${no}章`, evidence }
  }
  return null
}

/** 卷纲的章号范围：优先「本卷章号范围」结构化字段，其次自由文本 */
function volumeRangeOf(fact: DbChangeFact): { from: number; to: number } | null {
  const after = fact.after
  if (!after) return null
  const data = after.data ?? {}
  const texts = volumeBoundTextsOf({ data })
  /**
   * 兜底（确定性）：schema 尚未加载时 `resolveSlot` 取不到真键，此时按字段名后缀现找 ——
   * 否则「卷纲变更」会静默变成「不定范围」，把影响面整卷丢掉。
   */
  if (!texts.length) {
    for (const [key, value] of Object.entries(data)) {
      if (/(^|::)本卷章号(范围|数预估)$/.test(key) && typeof value === 'string' && value.trim()) texts.push(value)
    }
  }
  for (const text of texts) {
    const range = parseChapterRange(text)
    if (range) return range
  }
  return null
}

/**
 * 改前 / 改后的字段级差异（只取真正变了的值）。
 * 返回 null ＝ 没有可用的改前快照或**一字未变**（新建也算没有改前）。
 */
export function describeOutlineChange(
  before: DbChangePayload | undefined, after: DbChangePayload | undefined,
): { beforeText: string; afterText: string } | null {
  if (!before || !after) return null
  const beforeParts: string[] = []
  const afterParts: string[] = []
  const beforeName = before.name ?? ''
  const afterName = after.name ?? ''
  if (beforeName !== afterName) {
    beforeParts.push(`卡名：${beforeName || '（空）'}`)
    afterParts.push(`卡名：${afterName || '（空）'}`)
  }
  const keys = [...new Set([...Object.keys(before.data ?? {}), ...Object.keys(after.data ?? {})])]
  for (const key of keys) {
    const a = before.data?.[key] ?? ''
    const b = after.data?.[key] ?? ''
    if (a === b) continue
    beforeParts.push(`${key}：${a || '（空）'}`)
    afterParts.push(`${key}：${b || '（空）'}`)
  }
  if (!beforeParts.length) return null
  return { beforeText: beforeParts.join('\n'), afterText: afterParts.join('\n') }
}

/** 一条大纲变更的「改前 → 改后」依据；空变更 → undefined */
function outlineEvidenceOf(fact: DbChangeFact): ChangeEvidence | undefined {
  const diff = describeOutlineChange(fact.before, fact.after)
  if (!diff) return undefined
  return buildChangeEvidence({
    type: 'outline-change',
    sourceRef: `${fact.kind}:${fact.tabId}:${fact.recordId}`,
    before: diff.beforeText,
    after: diff.afterText,
    reason: '大纲变更',
  })
}

/** 已写章节「建议复核」清单的读取（供 UI 直接调用，避免 UI 引 db） */
export type { ReviewSuggestion }