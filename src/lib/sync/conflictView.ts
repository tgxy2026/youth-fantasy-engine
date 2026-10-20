/**
 * 同步冲突中心 · **展示层纯逻辑**（3.1.1 · 冲突中心优化）
 *
 * 【为什么单独一个叶子模块】
 * 面板要算的东西 —— 体积口径、类型标签、筛选、统计、保留期判定 —— 全是纯函数，
 * 与 React 无关。抽出来才能被单测钉住（尤其是「体积口径」：改一个字，
 * 作者看到的占用数就会与数据文件实际增量对不上，而这种偏差在界面上看不出来）。
 *
 * 【体积口径（🔴 改之前先读这段）】
 * `conflictBytes()` 量的是该冲突在**本机数据文件里占用的字节数**：
 * meta 行 `{ key, value }` 的紧凑 JSON 经 UTF-8 编码后的长度 ——
 * 与 `syncCore` 计算同步载荷、以及整库导出的口径一致（都是 `TextEncoder(JSON.stringify(...))`）。
 *
 * 可解释的差异：面板里「导出双方完整数据」写的是**缩进版** JSON（`null, 2`），
 * 会比这里显示的数略大；这不是 bug，是格式差异（缩进与换行）。
 *
 * 【保留期限与大小上限：**只定义、只展示，不自动删**】
 * 下面四个常量是给界面提示用的「建议线」。自动清理属不可逆操作，
 * 必须主人单独确认后才谈 —— 本模块**不提供任何删除入口**。
 */
import type { StoredSyncConflict } from '@/lib/db/syncConflicts'

/** 每批渲染条数（与「资料提及」面板同范式：`PAGE=50` + 「显示更多」） */
export const CONFLICT_PAGE = 50

/** 已处理副本的建议保留期（天）—— 超期只在界面上提示「可清理」，绝不自动删 */
export const CONFLICT_RETENTION_DAYS = 90

/** 单条副本体积告警线（字节）：超过它，这一条自己就明显撑大了数据文件 */
export const CONFLICT_SIZE_WARN_BYTES = 8 * 1024 * 1024

/** 冲突数据合计体积告警线（字节）：超过它，顶部给出醒目提示 */
export const CONFLICT_TOTAL_WARN_BYTES = 32 * 1024 * 1024

const DAY_MS = 86_400_000

/**
 * store 名 → 中文标签。
 * 名单与 `syncCore.SYNC_STORES` 对齐；认不出的 store **原样显示**（不吞成「未知」），
 * 这样将来新增参与同步的 store 时，面板不会静默显示错误名字。
 */
const STORE_LABELS: Record<string, string> = {
  projects: '项目',
  volumes: '分卷',
  chapters: '章节',
  formData: '设定表单',
  tableRows: '表格设定',
  cardRecords: '角色卡',
  meta: '其他数据',
  snapshots: '章节快照',
  dailyStats: '每日字数',
  settingsKV: '本机设置',
  trash: '回收站',
  tavernReports: '推演报告',
  aiRuns: 'AI 记录',
  worlds: '世界包',
  revisionJobs: '修订任务',
}

export function conflictStoreLabel(store: string): string {
  return STORE_LABELS[store] ?? (store || '未知类型')
}

const enc = new TextEncoder()

/**
 * 一条冲突在本机数据文件里占用的字节数（UTF-8）。
 * 口径见文件头注释 —— 与同步载荷 / 整库导出一致。
 */
export function conflictBytes(c: StoredSyncConflict): number {
  const value: Record<string, unknown> = {
    store: c.store, key: c.key, at: c.at, local: c.local, server: c.server,
  }
  if (typeof c.resolvedAt === 'number') value.resolvedAt = c.resolvedAt
  return enc.encode(JSON.stringify({ key: c.metaKey, value })).length
}

/** 字节数 → 人类可读（B / KB / MB）。面板与状态条共用，避免两处各写一套刻度。 */
export function formatConflictBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/** 处理状态筛选：全部 / 待处理 / 已处理 */
export type ConflictStatusFilter = 'all' | 'open' | 'resolved'

export interface ConflictFilterState {
  /** 'all' 或不限；否则为 store 名 */
  store: string
  status: ConflictStatusFilter
}

/** 记录里**实际出现过**的类型（去重 + 按中文标签排序），供筛选下拉 —— 不写死名单，永不过期 */
export function conflictStores(list: readonly StoredSyncConflict[]): string[] {
  const seen = new Set<string>()
  for (const c of list) if (c.store) seen.add(c.store)
  return Array.from(seen).sort((a, b) => conflictStoreLabel(a).localeCompare(conflictStoreLabel(b), 'zh'))
}

export function filterConflicts(
  list: readonly StoredSyncConflict[],
  f: ConflictFilterState,
): StoredSyncConflict[] {
  return list.filter(c =>
    (f.store === 'all' || c.store === f.store)
    && (f.status === 'all' || (f.status === 'resolved' ? !!c.resolvedAt : !c.resolvedAt)))
}

export interface ConflictStats {
  total: number
  unresolved: number
  resolved: number
  /** 合计占用（字节） */
  bytes: number
  /** 已处理且超过建议保留期的条数 */
  expired: number
  /** metaKey → 单条字节数（渲染时直接查，避免每次 render 重新序列化大正文） */
  sizes: Map<string, number>
}

export function conflictStats(list: readonly StoredSyncConflict[], now = Date.now()): ConflictStats {
  const sizes = new Map<string, number>()
  let bytes = 0, unresolved = 0, expired = 0
  for (const c of list) {
    const b = conflictBytes(c)
    sizes.set(c.metaKey, b)
    bytes += b
    if (c.resolvedAt) { if (isConflictExpired(c, now)) expired++ }
    else unresolved++
  }
  return { total: list.length, unresolved, resolved: list.length - unresolved, bytes, expired, sizes }
}

/** 已处理、且已超过 {@link CONFLICT_RETENTION_DAYS} 天 ⇒ 界面上提示「可清理」（不自动删） */
export function isConflictExpired(c: StoredSyncConflict, now = Date.now()): boolean {
  return typeof c.resolvedAt === 'number' && now - c.resolvedAt > CONFLICT_RETENTION_DAYS * DAY_MS
}
