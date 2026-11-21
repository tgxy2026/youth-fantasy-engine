// ============ AI 质量度量（3.6.2 · W5）============
//
// 【要回答什么】"这个功能到底有没有用"。规划 G4 的口径是：换模型 / 改提示词前后，
// 能拿同一套指标对比 —— 而不是凭感觉说"好像顺了点"。
//
// 【只记什么】事件与功能名，**不记内容**：
//   `{ at, feature, event }` 三个字段，没有正文、没有提示词、没有模型输出。
//   所以它既不占空间，也不可能把作品带出去 —— 这是能"默认开着"的前提。
//
// 🔴 三条口径：
//   ① **只存本机**（`meta` 全局键，不进项目、不进云同步、不上传）。换账号 = 换库 = 另一份。
//   ② **环形上限 2000**：度量是"近期手感"，不是审计日志。留太多会让每次写都变慢。
//   ③ **失败一律静默**：记不下来就不记，绝不让埋点把写作流程弄卡或弹出错误。
//      `recordAiMetric` 因此是**同步返回**的（调用方不必 await），落库在后台串行进行。
//
// ⚠️ 已知取舍：进程被强杀时，最后几条可能没落盘（内存缓冲未 flush）。
//    度量数据丢几条不影响趋势判断，换来的是"点击零延迟"。
import { getMeta, setMeta } from '@/lib/db/meta'

/** 存储键（全局 meta，**不带项目 id** —— 跨项目共用同一份语义） */
export const AI_METRICS_KEY = 'ai.metrics.v1'
/** 环形上限 */
export const AI_METRICS_MAX = 2000

/**
 * 功能名。只收这几个固定值，**不接受自由字符串** ——
 * 否则半年后会看到 `candidate` / `candidates` / `Candidate` 三种写法各占一列。
 */
export type AiMetricFeature = 'candidate' | 'proofread' | 'postprocess' | 'reference' | 'other'

/**
 * 事件五类。对应"展示 → 采纳/放弃 → 重生成 → 撤回"的完整链路。
 * 🔴 `undone`（撤回）单独记：采纳后又撤回，说明"看着能用、用了不对"，
 *    这和直接放弃是两种不同的失败，混在一起就看不出问题在哪。
 */
export type AiMetricEvent = 'shown' | 'accepted' | 'rejected' | 'regenerated' | 'undone'

export interface AiMetricEntry {
  /** 时间戳（毫秒） */
  at: number
  feature: AiMetricFeature
  event: AiMetricEvent
}

export interface AiMetricSummary {
  feature: AiMetricFeature
  shown: number
  accepted: number
  rejected: number
  regenerated: number
  undone: number
  /** 采纳率 = accepted / shown；`shown = 0` 时为 null（不是 0，别把"没展示过"算成 0%） */
  acceptanceRate: number | null
}

const FEATURES: readonly AiMetricFeature[] = ['candidate', 'proofread', 'postprocess', 'reference', 'other']
const EVENTS: readonly AiMetricEvent[] = ['shown', 'accepted', 'rejected', 'regenerated', 'undone']

/* ---------------- 纯函数（可单测） ---------------- */

/** 是否是认识的 feature / event（坏数据在入口就被挡掉，别让它污染统计） */
export function isValidFeature(v: unknown): v is AiMetricFeature {
  return typeof v === 'string' && (FEATURES as readonly string[]).includes(v)
}
export function isValidEvent(v: unknown): v is AiMetricEvent {
  return typeof v === 'string' && (EVENTS as readonly string[]).includes(v)
}

/**
 * 把存储里读出来的任意值洗成合法条目数组。
 * 🔴 坏数据（非数组 / 元素缺字段 / 类型不对）**逐条丢弃**，不让一条脏数据把整份度量毁掉。
 */
export function sanitizeEntries(raw: unknown): AiMetricEntry[] {
  if (!Array.isArray(raw)) return []
  const out: AiMetricEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const at = typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0 ? r.at : 0
    if (!at) continue
    if (!isValidFeature(r.feature) || !isValidEvent(r.event)) continue
    out.push({ at, feature: r.feature, event: r.event })
  }
  return out
}

/** 追加一条并保持环形上限（超出丢最旧的） */
export function appendRing(list: readonly AiMetricEntry[], entry: AiMetricEntry, max = AI_METRICS_MAX): AiMetricEntry[] {
  const next = [...list, entry]
  return next.length > max ? next.slice(next.length - max) : next
}

/**
 * 汇总（纯函数）。按 feature 分列，`since` 之前的条目不计入。
 *
 * @param since 起始时间戳（含）；传 0 表示全部
 */
export function summarizeEntries(entries: readonly AiMetricEntry[], since = 0): AiMetricSummary[] {
  const map = new Map<AiMetricFeature, AiMetricSummary>()
  for (const f of FEATURES) {
    map.set(f, { feature: f, shown: 0, accepted: 0, rejected: 0, regenerated: 0, undone: 0, acceptanceRate: null })
  }
  for (const e of entries) {
    if (e.at < since) continue
    const row = map.get(e.feature)
    if (!row) continue
    row[e.event] += 1
  }
  const out: AiMetricSummary[] = []
  for (const row of map.values()) {
    row.acceptanceRate = row.shown > 0 ? row.accepted / row.shown : null
    // 全零的功能不占一行（界面上一堆 0 只会让人以为坏了）
    if (row.shown + row.accepted + row.rejected + row.regenerated + row.undone === 0) continue
    out.push(row)
  }
  return out
}

/* ---------------- 存储层（内存缓冲 + 串行落库） ---------------- */

let cache: AiMetricEntry[] | null = null
/** 落库串行链：避免两次点击各自读-改-写互相覆盖（与 dailyStats 的队列同一个理由） */
let writeChain: Promise<void> = Promise.resolve()

async function load(): Promise<AiMetricEntry[]> {
  if (cache) return cache
  try {
    cache = sanitizeEntries(await getMeta<unknown>(AI_METRICS_KEY, []))
  } catch {
    cache = []
  }
  return cache
}

/**
 * 记一次事件（**同步返回**，落库在后台按顺序进行）。
 *
 * 🔴 永不抛：埋点失败绝不能影响用户正在做的事。
 *
 * 🔴 为什么整个「读-追加-写」都要排队（2026-11-21 实测的 bug）：
 *    最初写成了 `void (async () => { const list = await load(); cache = append(list) })()`，
 *    五次连续点击几乎同时进入 ⇒ 五次都拿到同一个旧 cache、各自 append 一次，
 *    最后只剩**最后一条**（前四条被吞）。改成排进 `writeChain` 后逐条执行，计数才对得上。
 *    代价只是"点击后要等前一条写库"，而度量本来就是非关键路径。
 */
export function recordAiMetric(feature: AiMetricFeature, event: AiMetricEvent): void {
  const entry: AiMetricEntry = { at: Date.now(), feature, event }
  writeChain = writeChain.then(async () => {
    try {
      const list = await load()
      cache = appendRing(list, entry)
      await setMeta(AI_METRICS_KEY, cache)
    } catch { /* 记不下来就算了：埋点不该影响写作 */ }
  })
}

/** 等待落库完成（测试与"清空前先等一等"用） */
export async function flushAiMetrics(): Promise<void> {
  await writeChain.catch(() => {})
}

/** 汇总最近 `days` 天（默认 30） */
export async function summarizeAiMetrics(opts?: { days?: number; now?: number }): Promise<AiMetricSummary[]> {
  const days = Math.max(1, Math.floor(opts?.days ?? 30))
  const now = opts?.now ?? Date.now()
  const since = now - days * 24 * 60 * 60 * 1000
  const list = await load()
  return summarizeEntries(list, since)
}

/** 清空（界面上的「清空统计」；清完立即落库，避免下次启动又冒出来） */
export async function clearAiMetrics(): Promise<void> {
  cache = []
  writeChain = writeChain.then(async () => {
    try { await setMeta(AI_METRICS_KEY, []) } catch { /* 同上 */ }
  })
  await flushAiMetrics()
}

/** 测试用：把内存缓存与写队列复位（避免用例之间互相污染） */
export function __resetAiMetricsCache(): void {
  cache = null
  writeChain = Promise.resolve()
}
