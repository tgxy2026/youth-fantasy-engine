// ============ 备份可恢复性演练（3.6.2 · W3）============
//
// 【要回答的问题】作者点「恢复备份」之前，最该知道的是：**这些备份里，哪些现在真能恢复？**
// 备份列表只显示"创建时间 + 体积"——体积正常、载荷却已经读不出来的情况是存在的
// （外置载荷文件被清理工具删掉、迁移中断、磁盘坏块）。等到真去恢复才发现，往往已经晚了。
//
// 🔴 本模块**只读**，一条写入都没有：
//   · 不创建备份、不改元数据、不删任何东西；
//   · 不做恢复试跑（真跑一次恢复会覆盖当前项目，那是"演练"而不是"体检"）。
//   想真正验证"能恢复"，正确做法是导出那份备份到别处再导入 —— 那是作者的手动动作，
//   本模块只负责把"可疑的那几份"指出来。
//
// ⚠️ 代价：为了判断"载荷是否完整"，窗口内的载荷会被读进内存一次。
//   默认窗口 7 天、最多 24 份（按时间倒序截断），避免在几十份备份上跑出几百 MB 峰值。
import {
  listBackups,
  verifyBackupPayload,
  getBackupPayload,
  type BackupKind,
  type BackupMeta,
  type BackupPayload,
} from '@/lib/db/backups'
import { ops } from '@/lib/db/core'
import type { StoreOps } from '@/lib/storage/storeOps'

/** 默认回看窗口（天） */
export const DRILL_WINDOW_DAYS = 7
/** 单次演练最多检查多少份（防止在大项目上把内存吃满） */
export const DRILL_MAX_POINTS = 24

export interface DrillPoint {
  id: string
  createdAt: number
  kind: BackupKind
  label: string
  /** 元数据里记的体积（不是本次读出来的） */
  bytes: number
  /** 现在能不能恢复 */
  restorable: boolean
  /** 不能恢复时的可读原因（**不含路径与正文**） */
  reason?: string
}

export interface DrillResult {
  /** 回看的窗口天数 */
  windowDays: number
  /** 本次检查时刻 */
  checkedAt: number
  /** 窗口内的备份（按时间倒序） */
  points: DrillPoint[]
  restorableCount: number
  brokenCount: number
  /**
   * 因为超出 `DRILL_MAX_POINTS` 而没检查的份数。
   * 🔴 必须如实带出来：把"没检查"说成"没问题"是这类体检最容易犯的错。
   */
  skipped: number
}

/**
 * 检查一份备份是否可恢复（只读）。
 *
 * 判据三层，从便宜到贵：
 *   ① 元数据本身要像样（有 id / createdAt）；
 *   ② 分片引用指向的载荷要**读得到**；
 *   ③ 载荷结构要完整（复用 `verifyBackupPayload`，与恢复前那道校验同一份判据）。
 */
async function inspectOne(meta: BackupMeta, store: StoreOps): Promise<DrillPoint> {
  const base = {
    id: meta.id,
    createdAt: meta.createdAt,
    kind: meta.kind,
    label: meta.label,
    bytes: meta.bytes,
  }
  if (!meta.id || !meta.createdAt) return { ...base, restorable: false, reason: '备份记录不完整' }

  const textId = meta.shards?.textPayloadId ?? meta.id
  const raw = await store.get<BackupPayload>('backupPayloads', textId).catch(() => undefined)
  if (raw) {
    const verdict = verifyBackupPayload(raw)
    if (!verdict.ok) return { ...base, restorable: false, reason: verdict.reason }
  }
  /**
   * `raw` 为空有两种可能，**不能一概判坏**：
   *   · v11 之前的老库：载荷与元数据同条，`backupPayloads` 里本来就没有记录；
   *   · 真的丢了载荷。
   * 用 `getBackupPayload` 的兼容分支来区分：它能读到 bundle 就是老库，读不到才是丢了。
   */
  const bundle = await getBackupPayload(meta.id, store).catch(() => undefined)
  if (!bundle) return { ...base, restorable: false, reason: '数据载荷已丢失（元数据还在）' }
  return { ...base, restorable: true }
}

/**
 * 跑一次可恢复性演练（**只读**）。
 *
 * @param projectId 要检查的项目
 * @param opts.days  回看窗口（默认 7 天）
 * @param opts.now   注入"现在"，便于单测（默认 Date.now()）
 */
export async function runBackupDrill(
  projectId: string,
  opts?: { days?: number; now?: number; store?: StoreOps; maxPoints?: number },
): Promise<DrillResult> {
  const store = opts?.store ?? ops
  const days = Math.max(1, Math.floor(opts?.days ?? DRILL_WINDOW_DAYS))
  const maxPoints = Math.max(1, Math.floor(opts?.maxPoints ?? DRILL_MAX_POINTS))
  const now = opts?.now ?? Date.now()
  const since = now - days * 24 * 60 * 60 * 1000

  const all = await listBackups(projectId, store)
  // `listBackups` 已按 createdAt 倒序；这里只截窗口
  const inWindow = all.filter(b => b.createdAt >= since)
  const picked = inWindow.slice(0, maxPoints)

  const points: DrillPoint[] = []
  for (const meta of picked) {
    points.push(await inspectOne(meta, store))
  }

  const restorableCount = points.filter(p => p.restorable).length
  return {
    windowDays: days,
    checkedAt: now,
    points,
    restorableCount,
    brokenCount: points.length - restorableCount,
    skipped: inWindow.length - picked.length,
  }
}

/**
 * 给界面用的一句话结论。
 *
 * 🔴 措辞原则：宁可说得保守。`skipped > 0` 时必须点明"还有没检查的"，
 *    否则作者会把"检查过的那几份都没问题"读成"全部都没问题"。
 */
export function drillSummary(r: DrillResult): string {
  if (r.points.length === 0) return `最近 ${r.windowDays} 天没有备份可检查`
  if (r.brokenCount > 0) {
    return `最近 ${r.windowDays} 天有 ${r.points.length} 份备份，其中 ${r.brokenCount} 份已无法恢复`
  }
  const tail = r.skipped > 0 ? `（另有 ${r.skipped} 份未检查）` : ''
  return `最近 ${r.windowDays} 天有 ${r.points.length} 份备份，全部可恢复${tail}`
}
