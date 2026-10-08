// ============ 体检结果台账（2.9.1） ============
//
// 为什么要有它（见 docs/2.9.0-功能全景与数据复用机会梳理-2026-10-08.html 的 B 档）：
//   ① **结果算完即弃** —— 连续性校验 / 伏笔看板 / 本章体检的结果此前全活在组件 `useState` 里，
//      切页签就重跑、关软件就蒸发。作者因此回答不了「这一章的问题比上周是变好还是变坏」。
//   ② **同一批引擎被多个入口重复计算** —— 检查工具页 / 稿件体检面板 / 编辑器弹窗 /
//      本章体检聚合各自重跑一遍，彼此不共享结果。既是 CPU 浪费，
//      也是「同一份数据四个口径可能漂移」的隐患。
//
// 做法两条：
//   · **落库**：每次真跑完记一条快照（只有统计值 + 前若干条标题），存 settingsKV。
//     🔴 刻意**不记全文** —— 体检结果若全文落库会变成"第二个数据源"，
//     而它的价值只在于趋势与回看，不在于可编辑。
//   · **缓存**：以 `project.updatedAt` 作数据版本，同一版本内复用引擎结果。
//     ⚠️ 已知取舍：若某个写路径没有 touch 项目时间戳，缓存要到下次任意编辑才失效 ——
//     代价仅是"体检提示晚一轮刷新"，**不影响任何数据**（这些引擎本身只读不写）。
//
// 📌 消费者：`components/AuditModals.tsx`（伏笔看板 / 连续性校验）、
//    `components/ManuscriptCheckPanel.tsx`、`lib/chapterCheck.ts`（本章体检聚合）。
import * as db from './db'
import type { AuditIssue } from './audit'
import { auditContinuity } from './continuityCheck'
import { auditForeshadow, type ForeshadowResult } from './foreshadowEngine'
import type { Observation } from './manuscriptCheck'

export type CheckEngine = 'continuity' | 'foreshadow' | 'manuscript'

export interface CheckSnapshot {
  ts: number
  engine: CheckEngine
  scope: string
  total: number
  error: number
  warn: number
  info: number
  /** 前若干条 issue 标题（供「上次报了什么」回看；不含详情，避免台账臃肿） */
  titles: string[]
}

/** settingsKV 键 —— `db.getSetting/setSetting` 自带 `<pid>::` 前缀，这里不必再拼 */
const SETTING_KEY = 'checkLog'
/** 台账上限：够看趋势即可，不做无限增长 */
const MAX_SNAPSHOTS = 240
/** 单条快照最多记几条标题 */
const MAX_TITLES = 12
/** 全局作用域（各项检查都是全项目范围；保留字段是为了将来能按章分片） */
const GLOBAL_SCOPE = 'global'

type CacheEntry = { rev: number; result: unknown }
let cache = new Map<string, CacheEntry>()
let lastPid = ''

/**
 * 当前数据版本。用项目时间戳（任何写操作都会 `touchProject`）——
 * ⚠️ 取不到（返回 0）时调用方**必须跳过缓存**，否则 0 === 0 会让缓存永不失效。
 */
async function revisionOf(): Promise<number> {
  const pid = db.getCurrentProjectId()
  if (pid !== lastPid) { cache = new Map(); lastPid = pid }   // 换项目必须清缓存（否则上一本书的结果串味）
  try {
    const p = (await db.getProject(pid)) as { updatedAt?: number } | undefined
    return p?.updatedAt ?? 0
  } catch {
    return 0
  }
}

async function loadLog(): Promise<CheckSnapshot[]> {
  try {
    const arr = await db.getSetting<CheckSnapshot[]>(SETTING_KEY, [])
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/** 记一条快照。🔴 落库失败**绝不能**让体检本身失败（体检是主功能，台账是附属） */
async function logSnapshot(engine: CheckEngine, scope: string, issues: AuditIssue[]): Promise<void> {
  try {
    const log = await loadLog()
    log.push({
      ts: Date.now(),
      engine,
      scope,
      total: issues.length,
      error: issues.filter(i => i.severity === 'error').length,
      warn: issues.filter(i => i.severity === 'warn').length,
      info: issues.filter(i => i.severity === 'info').length,
      titles: issues.slice(0, MAX_TITLES).map(i => i.title),
    })
    await db.setSetting(SETTING_KEY, log.slice(-MAX_SNAPSHOTS))
  } catch {
    // 记不上就算了 —— 宁可没有台账，也不能让体检报错
  }
}

/** 共用外壳：查缓存 → 未命中则真跑 → 记台账 */
async function cachedRun<T>(
  engine: CheckEngine,
  scope: string,
  fn: () => Promise<T>,
  toIssues: (r: T) => AuditIssue[],
): Promise<T> {
  const rev = await revisionOf()
  const ck = `${engine}::${scope}`
  if (rev > 0) {
    const hit = cache.get(ck)
    if (hit && hit.rev === rev) return hit.result as T
  }
  const result = await fn()
  if (rev > 0) cache.set(ck, { rev, result })
  await logSnapshot(engine, scope, toIssues(result))
  return result
}

/** 连续性校验（带缓存与落库）—— 替代直接调用 `auditContinuity()` */
export async function continuityLogged(): Promise<AuditIssue[]> {
  return cachedRun('continuity', GLOBAL_SCOPE, () => auditContinuity(), r => r)
}

/** 伏笔闭环看板（带缓存与落库）—— 替代直接调用 `auditForeshadow()` */
export async function foreshadowLogged(): Promise<ForeshadowResult> {
  return cachedRun('foreshadow', GLOBAL_SCOPE, () => auditForeshadow(), r => r.issues)
}

/**
 * 投稿前自检（行文分布 · 2.9.2）—— 把观察项记一条台账，做「这一章比上次」的趋势。
 *
 * 🔴 与上面两个 engine 的三点不同：
 *   ① **不做缓存** —— 行文指纹是纯统计、算得很快，缓存没有意义；
 *   ② **不区分 error** —— 观察项不是「问题」：`notable`（落在参考区间之外）计 `warn`、
 *      其余计 `info`，**只为让趋势行有「变多 / 变少」可算**，绝不代表「有 N 个问题」；
 *   ③ **`scope` 用章节 id** —— 行文指纹是按章算的，趋势要「这一章比上次」，不是全书混算。
 */
export async function manuscriptLogged(scope: string, obs: Observation[]): Promise<void> {
  const issues: AuditIssue[] = obs.map((o, i) => ({
    id: `M${i + 1}`,
    severity: o.notable ? 'warn' : 'info',
    category: '投稿前自检',
    title: o.label,
    detail: `${o.value} · ${o.hint}`,
  }))
  await logSnapshot('manuscript', scope, issues)
}

export interface CheckTrend {
  engine: CheckEngine
  scope: string
  /** 上一次快照；只有一条时返回 null */
  prev: CheckSnapshot | null
  cur: CheckSnapshot
}

/**
 * 取某引擎最近两次快照，供界面显示「比上次 多 / 少 N 条」。
 * 没有任何快照时返回 null（界面据此整行不渲染）。
 */
export async function trendOf(engine: CheckEngine, scope = GLOBAL_SCOPE): Promise<CheckTrend | null> {
  const log = (await loadLog()).filter(s => s.engine === engine && s.scope === scope)
  if (!log.length) return null
  const cur = log[log.length - 1]
  return { engine, scope, prev: log.length >= 2 ? log[log.length - 2] : null, cur }
}

/** 把时间戳说成「刚刚 / N 分钟前 / N 小时前 / N 天前」（纯展示，避免各处自己拼） */
export function humanAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 清空台账与缓存（供「重置体检台账」入口） */
export async function clearCheckLog(): Promise<void> {
  cache = new Map()
  try {
    await db.setSetting(SETTING_KEY, [])
  } catch {
    // 清不掉也不报错 —— 下次记录会覆盖
  }
}
