// ============ 按章一致性审计 · 留痕与失效（W2-2 · §10.3 #4）============
//
// 为什么有它：
//   「本章体检」（`chapterCheck.runChapterCheck`）的五个引擎早就齐了，但结果只活在组件
//   `useState` 里 —— 关掉面板就没了；更要命的是**它不记得自己是针对哪一版正文跑的**。
//   作者改完正文再回到面板，看到的还是改之前那份报告，等于**拿旧报告给新稿盖章**。
//
// 做法两条（沿用方案 C「不常驻 / 静默跑 / 只报数」口径）：
//   · **留痕**：跑完记「章 + 正文指纹 + 计数 + 时间」进 settingsKV。
//     🔴 刻意**不存问题全文** —— 存了就会变成「第二个数据源」，而它的价值只在于
//     「这份结果还作不作数」，不在于可回看可编辑（与 `checkLog` 的取舍同口径）。
//   · **失效**：读的时候拿当前章正文重算一次指纹比对；不符 ⇒ 标「已过期，需重跑」。
//     🔴 **绝不自动重跑**（§10.3 #4 首条：显式触发、非后台自动跑）—— 只标注，作者自己决定。
//
// 📌 消费者：`components/ChapterCheckPanel.tsx`（本章体检）。
import * as db from '@/lib/db'
import { chapterFingerprint } from '@/lib/ai/aiRunLedger'
import type { Chapter } from '@/lib/types'
import type { ChapterCheckReport } from '@/lib/outline/chapterCheck'

/** settingsKV 键 —— `db.getSetting/setSetting` 自带 `<pid>::` 前缀，这里不必再拼 */
const SETTING_KEY = 'chapterAudit'
/** 留痕上限：够记住最近体检过的章即可，不做无限增长（超出按时间淘汰最旧） */
const MAX_RECORDS = 300

/** 五类计数（与 `ChapterCheckReport` 的分组一一对应） */
export interface ChapterAuditCounts {
  continuity: number
  foreshadow: number
  sensitive: number
  typos: number
  style: number
}

export interface ChapterAuditRecord {
  chapterId: string
  chapterTitle: string
  /** 🔴 结果绑定的正文指纹（复用 W1-1 的 `chapterFingerprint`，不另发明一套） */
  fingerprint: string
  /** 本次体检时刻 */
  at: number
  /** 只报数，不存全文 */
  counts: ChapterAuditCounts
  /** 待处理条数（与面板顶栏 `countActionable` 同口径） */
  actionables: number
}

/** 结果有效性 */
export interface AuditFreshness {
  fresh: boolean
  reason: string
  /** 有留痕时的记录（无记录为 null） */
  record: ChapterAuditRecord | null
}

/** 参与指纹计算的章节字段（与 `chapterFingerprint` 的入参一致） */
type Fingerprintable = Pick<Chapter, 'title' | 'content' | 'wordCount' | 'updatedAt'>

/**
 * 纯函数：这份留痕对「当前正文」还作不作数。
 *
 * 判据只有一条 —— **指纹是否一致**（`chapterFingerprint` 已把 标题/正文/字数/最后改动时刻
 * 一起哈希，见那里的说明）。指纹含 `updatedAt`：作者把一段改坏又改回原样，内容虽相同
 * 也**算改过**，该重跑一次。宁严勿松。
 *
 * @returns `fresh=false` 一律给**能读懂的原因**（面板直接展示，不另做映射）
 */
export function checkAuditFresh(
  record: ChapterAuditRecord | null | undefined,
  ch: Fingerprintable,
): { fresh: boolean; reason: string } {
  if (!record) return { fresh: false, reason: '还没有体检过' }
  if (!record.fingerprint) return { fresh: false, reason: '这份体检记录不完整，需重新体检' }
  if (chapterFingerprint(ch) !== record.fingerprint) {
    return { fresh: false, reason: '正文在上次体检后改过' }
  }
  return { fresh: true, reason: '' }
}

/** 把报告折算成留痕（**纯函数**，好测） */
export function toAuditRecord(
  report: ChapterCheckReport, ch: Fingerprintable, at = Date.now(),
): ChapterAuditRecord {
  return {
    chapterId: report.chapterId,
    chapterTitle: report.chapterTitle || ch.title || '',
    fingerprint: chapterFingerprint(ch),
    at,
    counts: {
      continuity: report.continuity.length,
      foreshadow: report.foreshadow.issues.length,
      sensitive: report.sensitive.reduce((s, h) => s + h.count, 0),
      typos: report.typos.reduce((s, h) => s + h.count, 0),
      style: report.style.length,
    },
    actionables: 0, // 由调用方以 countActionable 口径填入（避免本模块反向依赖面板口径）
  }
}

/** 读全部留痕（读不到 / 数据损坏一律返回空对象，绝不抛） */
async function readAll(): Promise<Record<string, ChapterAuditRecord>> {
  try {
    const raw = await db.getSetting<Record<string, ChapterAuditRecord>>(SETTING_KEY, {})
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, ChapterAuditRecord> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && typeof (v as ChapterAuditRecord).chapterId === 'string') {
        out[k] = v as ChapterAuditRecord
      }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 留痕一条体检结果。**失败静默** —— 绝不能因为写不进台账而让「体检」本身失败。
 */
export async function saveChapterAudit(
  report: ChapterCheckReport, ch: Fingerprintable, actionables: number,
): Promise<void> {
  try {
    const all = await readAll()
    all[report.chapterId] = { ...toAuditRecord(report, ch), actionables }
    // 上限淘汰：按 at 升序砍掉最旧的
    const keys = Object.keys(all)
    if (keys.length > MAX_RECORDS) {
      keys.sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0))
      for (const k of keys.slice(0, keys.length - MAX_RECORDS)) delete all[k]
    }
    await db.setSetting(SETTING_KEY, all)
  } catch {
    // 静默：留痕只是提醒，不该连累体检
  }
}

/** 读某一章的留痕（无则 null） */
async function readChapterAudit(chapterId: string): Promise<ChapterAuditRecord | null> {
  if (!chapterId) return null
  const all = await readAll()
  return all[chapterId] ?? null
}

/**
 * 一次取「留痕 + 是否还有效」—— 面板打开 / 切章时调这个。
 * 章的正文拿不到（已删除等）⇒ 按「需重新体检」处理，不炸。
 */
export async function loadChapterAuditStatus(
  chapterId: string, ch: Fingerprintable | null | undefined,
): Promise<AuditFreshness> {
  const record = await readChapterAudit(chapterId)
  if (!ch) return { fresh: false, reason: record ? '这一章已经不在项目里了' : '还没有体检过', record }
  const { fresh, reason } = checkAuditFresh(record, ch)
  return { fresh, reason, record }
}

/** 人类可读的「多久之前」（面板文案用；负数 / 异常一律按「刚刚」） */
export function humanAgo(ts: number, now = Date.now()): string {
  const d = now - ts
  if (!Number.isFinite(d) || d < 60_000) return '刚刚'
  const m = Math.floor(d / 60_000)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
