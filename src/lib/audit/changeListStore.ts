/**
 * 3.3.3 · A2：变化清单的**本机缓存与「我不认同」记录**。
 *
 * 🔴 不进云同步 / 项目包（`syncPullOp` 同款理由）：报告带章节字符区间与模型名，
 *    换台设备后正文 id 与指纹都对不上；"我不认同"更是本机阅读偏好。
 * 🔴 缓存键含章 id，且报告自带章正文指纹：正文一变，界面必须提示重跑，不能拿旧结论顶替。
 * 🔴 迟到结果不得覆盖新报告：保存前由调用方比对"当前章 id + 指纹"（见 `isReportCurrent`）。
 */
import { ops } from '@/lib/db/core'
import type { StoreOps } from '@/lib/storage/storeOps'
import { dissentKeyOf, fingerprintText, type ChangeItem, type ChangeListReport } from '@/lib/audit/changeList'

export const CHANGE_CACHE_PREFIX = 'auditChange::'
export const CHANGE_DISSENT_PREFIX = 'auditChangeDissent::'

const cacheKeyOf = (pid: string, chapterId: string) => `${CHANGE_CACHE_PREFIX}${pid}::${chapterId}`
const dissentKeyOfProject = (pid: string) => `${CHANGE_DISSENT_PREFIX}${pid}`

async function readValue<T>(key: string, store: StoreOps): Promise<T | null> {
  try {
    const rec = await store.get<{ key: string; value?: T }>('meta', key)
    return rec?.value ?? null
  } catch {
    return null
  }
}

async function writeValue(key: string, value: unknown, store: StoreOps): Promise<void> {
  await store.put('meta', { key, value })
}

export async function loadChangeList(projectId: string, chapterId: string, store: StoreOps = ops): Promise<ChangeListReport | null> {
  if (!projectId || !chapterId) return null
  return readValue<ChangeListReport>(cacheKeyOf(projectId, chapterId), store)
}

/** 保存前必须检查"报告仍是当前这一章、正文没变" —— 由调用方负责（见 `isReportCurrent`） */
export async function saveChangeList(projectId: string, report: ChangeListReport, store: StoreOps = ops): Promise<void> {
  if (!projectId || !report.chapterId) return
  await writeValue(cacheKeyOf(projectId, report.chapterId), report, store)
}

export async function clearChangeList(projectId: string, chapterId: string, store: StoreOps = ops): Promise<void> {
  await store.del('meta', cacheKeyOf(projectId, chapterId)).catch(() => {})
}

/** 报告是否仍对应当前章与当前正文（迟到回包 / 改文后复用都要经过它） */
export function isReportCurrent(report: ChangeListReport, chapterId: string, chapterText: string): boolean {
  return report.chapterId === chapterId && report.inputFingerprint === fingerprintText(chapterText)
}

export interface DissentRecord {
  key: string
  chapterId: string
  itemId: string
  /** 原文短引用（供作者回看"我否掉的是哪一条"） */
  quote: string
  at: number
}

export async function loadDissent(projectId: string, store: StoreOps = ops): Promise<DissentRecord[]> {
  const list = await readValue<DissentRecord[]>(dissentKeyOfProject(projectId), store)
  return Array.isArray(list) ? list : []
}

/** 「我不认同」只记录、不改正文；可清除 */
export async function addDissent(projectId: string, chapterId: string, item: ChangeItem, store: StoreOps = ops): Promise<DissentRecord[]> {
  const list = await loadDissent(projectId, store)
  const key = dissentKeyOf(chapterId, item)
  const next = list.filter(x => x.key !== key)
  next.push({ key, chapterId, itemId: item.id, quote: item.quote.slice(0, 60), at: Date.now() })
  await writeValue(dissentKeyOfProject(projectId), next, store)
  return next
}

export async function removeDissent(projectId: string, key: string, store: StoreOps = ops): Promise<DissentRecord[]> {
  const list = await loadDissent(projectId, store)
  const next = list.filter(x => x.key !== key)
  await writeValue(dissentKeyOfProject(projectId), next, store)
  return next
}