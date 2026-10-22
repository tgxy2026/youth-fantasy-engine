// ============ 改完复检结论备忘（3.2.1 · T-11） ============
//
// 【为什么需要它】
//   改完复检（五个本地引擎，零额度）的结论此前**只活在任务中心**：
//   `OptimizeTicketPanel` 从 `exe.result` / `task.resume` 取，刷新即消失。
//   而 `persistCheckReports` 还有一道闸 `isWorthPersisting` —— 只有存在「严重 / 中等」发现才落档，
//   于是**最理想的情况「复检后原问题已清」恰恰不会留痕**。作者第二天回来只能看到一片空白，
//   回答不了「上次改完到底改好没有」。
//
// 【做法】
//   项目级 `settingsKV`（`db.getSetting/setSetting` 自带 `<pid>::` 前缀）存**每章最近一条**结论：
//   · 体积小（只有计数 + 未解决标题，不存全文）⇒ 不用另建 store，也不进独立 IDB；
//   · 随项目走（同步 / 备份 / 导出都带着），桌面·便携·网页云端三端一致；
//   · 上限 {@link MAX_MEMOS} 章，超出淘汰最旧的（复检结论只服务「最近改过哪几章」）。
//
// 🔴 三态口径（界面必须分开说，别混）：
//   · `done`   → 有结论（原问题已清 / N 条没解决）；
//   · `failed` → 跑过但没跑成（正文已落库，复检是旁路）；
//   · 没有记录 → **未运行**，界面不显示，绝不写成「已清」。
import * as db from '@/lib/db'

/** settingsKV 键（`getSetting/setSetting` 会自动拼 `<pid>::`，这里不要再拼项目 id） */
const SETTING_KEY = 'recheckMemo'
/** 最多记多少章：够回答「最近改过的那几章后来怎样了」即可，不做无限增长 */
export const MAX_MEMOS = 60
/** 存储版本：将来加字段时用它分支，读到不认识的版本按空处理 */
const STORE_VERSION = 1

export interface RecheckMemo {
  chapterId: string
  chapterNo?: number
  /** 落档那一刻的章名快照（之后改名不影响历史记录，同 T3-06 口径） */
  chapterTitle?: string
  at: number
  /** `done` 有结论 ／ `failed` 跑过但没跑成 */
  state: 'done' | 'failed'
  /** 复检后仍需动手的问题数（提示级不计） */
  findings?: number
  /** 其中冲突级 */
  critical?: number
  /** 改前工单里仍然存在的问题标题 */
  stillOpen?: string[]
  /** 改前工单里已经解决掉的条数 */
  resolved?: number
  /** 复检报告是否留档成功（留档是旁路，失败不影响正文） */
  saved?: boolean
  /** `failed` 时的人话原因 */
  error?: string
}

interface Store {
  v: number
  items: RecheckMemo[]
}

/** 校验一条记录是否可用（历史数据 / 手改过的 JSON 都可能缺字段） */
export function isMemo(x: unknown): x is RecheckMemo {
  if (!x || typeof x !== 'object') return false
  const m = x as Record<string, unknown>
  return typeof m.chapterId === 'string' && m.chapterId.length > 0
    && typeof m.at === 'number' && Number.isFinite(m.at)
    && (m.state === 'done' || m.state === 'failed')
}

/**
 * 插入或替换（**同章只留最新**），并按上限淘汰最旧的。
 *
 * 纯函数，导出供单测。`at` 相同的两条按入参顺序决定新旧（后者更新）——
 * 同一毫秒连着复检多章是常态，不能靠 `at` 单独排序。
 */
export function upsertMemo(
  items: readonly RecheckMemo[],
  memo: RecheckMemo,
  max: number = MAX_MEMOS,
): RecheckMemo[] {
  const kept = items.filter(m => m.chapterId !== memo.chapterId)
  const next = [...kept, memo]
  // 稳定排序：`Array.prototype.sort` 在 V8 上稳定，同 `at` 保持插入顺序（后者在后 ⇒ 更"新"）
  next.sort((a, b) => a.at - b.at)
  const limit = Math.max(1, max)
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** 解析存储值（历史 / 损坏 / 未来版本 ⇒ 空数组，绝不抛） */
export function parseStore(raw: unknown): RecheckMemo[] {
  if (!raw || typeof raw !== 'object') return []
  const store = raw as Partial<Store>
  if (store.v !== STORE_VERSION) return []
  if (!Array.isArray(store.items)) return []
  return store.items.filter(isMemo)
}

/** 一句话结论（界面直接用，避免各处各写一套措辞） */
export function memoText(m: RecheckMemo): string {
  if (m.state === 'failed') return '复检没跑成' + (m.error ? `（${m.error}）` : '')
  const open = m.stillOpen?.length ?? 0
  if (open > 0) return `${open} 条没解决`
  const rest = m.findings ?? 0
  return rest > 0 ? `原问题已清，还剩 ${rest} 个` : '原问题已清'
}

/** 时间的人话（今天 08:12 / 昨天 21:40 / 10-20 19:02） */
export function memoWhen(m: RecheckMemo, now: number = Date.now()): string {
  const d = new Date(m.at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = new Date(now)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return `今天 ${hm}`
  const y = new Date(now - 86400000)
  if (sameDay(d, y)) return `昨天 ${hm}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

/**
 * 读回当前项目的复检备忘，按章索引。
 * 🔴 任何失败都返回空表（旁路数据，读不到就当没有，绝不打断面板渲染）。
 */
export async function loadRecheckMemos(): Promise<Map<string, RecheckMemo>> {
  const map = new Map<string, RecheckMemo>()
  try {
    const raw = await db.getSetting<Store | null>(SETTING_KEY, null)
    for (const m of parseStore(raw)) map.set(m.chapterId, m)
  } catch {
    // 读不到就当没有
  }
  return map
}

/**
 * 记账（覆盖同章旧记录）。
 * 🔴 全程不抛：复检是旁路，备忘写不进去只遗憾，绝不能让已落库的正文报成失败。
 */
export async function saveRecheckMemo(memo: RecheckMemo): Promise<boolean> {
  try {
    const raw = await db.getSetting<Store | null>(SETTING_KEY, null)
    const items = upsertMemo(parseStore(raw), memo)
    await db.setSetting(SETTING_KEY, { v: STORE_VERSION, items } satisfies Store)
    return true
  } catch {
    return false
  }
}

/** 清空（项目删除 / 测试用；失败不报错，下次写入自然覆盖） */
export async function clearRecheckMemos(): Promise<void> {
  try {
    await db.setSetting(SETTING_KEY, { v: STORE_VERSION, items: [] })
  } catch {
    // 清不掉不报错
  }
}
