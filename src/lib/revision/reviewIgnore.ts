/**
 * 检查报告 · 「忽略并说明」记录（3.6.0 · D）
 *
 * 存 `meta` 的 `reviewIgnore::<项目id>`，并登记为**本机专属前缀**（同 `auditIgnore:`）：
 * 忽略是**本机阅读偏好**，而且记录的是「某份报告的第 N 条」——报告会被配额淘汰，
 * 若跨设备同步，另一台机器只会看到一条指向已不存在报告的记录。
 *
 * 只记理由与定位，不复制问题正文（正文在报告载荷里，报告删了记录也就只剩个名字）。
 */
import { ops } from '@/lib/db/core'
import type { StoreOps } from '@/lib/storage/storeOps'

export const REVIEW_IGNORE_PREFIX = 'reviewIgnore::'

/** 上限：本机项目级忽略记录（超出淘汰最旧的；忽略是偏好，不是作者成果） */
export const REVIEW_IGNORE_LIMIT = 500

export interface ReviewIgnoreRecord {
  reportId: string
  /** 该报告内第几条发现（报告载荷不可变，下标稳定） */
  index: number
  /** 问题标题快照（报告被淘汰后仍能看出作者忽略过什么） */
  title?: string
  /** 作者说明（可为空，但界面建议填） */
  reason: string
  at: number
}

const projectKeyOf = (pid: string) => `${REVIEW_IGNORE_PREFIX}${pid}`
const recordKeyOf = (reportId: string, index: number) => `${reportId}::${index}`

/** 读本项目的忽略记录；读失败返回空（本机偏好，不阻塞阅读） */
export async function loadReviewIgnores(
  projectId: string, store: StoreOps = ops,
): Promise<ReviewIgnoreRecord[]> {
  if (!projectId) return []
  try {
    const rec = await store.get<{ key: string; value?: ReviewIgnoreRecord[] }>('meta', projectKeyOf(projectId))
    const list = rec?.value
    if (!Array.isArray(list)) return []
    return list.filter(r => r && typeof r.reportId === 'string' && typeof r.index === 'number')
  } catch {
    return []
  }
}

/** 写入/覆盖一条（同报告同下标只留一条，理由以最后一次为准） */
export async function setReviewIgnore(
  projectId: string, record: ReviewIgnoreRecord, store: StoreOps = ops,
): Promise<void> {
  if (!projectId) return
  const list = await loadReviewIgnores(projectId, store)
  const key = recordKeyOf(record.reportId, record.index)
  const rest = list.filter(r => recordKeyOf(r.reportId, r.index) !== key)
  const next = [record, ...rest].slice(0, REVIEW_IGNORE_LIMIT)
  await store.put('meta', { key: projectKeyOf(projectId), value: next })
}

/** 撤销忽略 */
export async function clearReviewIgnore(
  projectId: string, reportId: string, index: number, store: StoreOps = ops,
): Promise<void> {
  if (!projectId) return
  const list = await loadReviewIgnores(projectId, store)
  const key = recordKeyOf(reportId, index)
  const next = list.filter(r => recordKeyOf(r.reportId, r.index) !== key)
  await store.put('meta', { key: projectKeyOf(projectId), value: next })
}

/** 把记录折成便于界面查询的 Map（键 = `reportId::index`） */
export function ignoreIndex(list: readonly ReviewIgnoreRecord[]): Map<string, ReviewIgnoreRecord> {
  const map = new Map<string, ReviewIgnoreRecord>()
  for (const r of list) map.set(recordKeyOf(r.reportId, r.index), r)
  return map
}

/** 复制的「修订要求」文本（粘贴给编辑器里的 AI 面板；不自动跨页跳转） */
export function revisionRequestOf(input: {
  chapterName?: string
  level?: string
  title?: string
  detail?: string
  where?: string
}): string {
  const head = `【修订要求】${input.chapterName ? input.chapterName + ' · ' : ''}${input.level ?? '问题'}：${input.title ?? '（无标题）'}`
  const lines = [head]
  if (input.detail) lines.push(`问题说明：${input.detail}`)
  if (input.where) lines.push(`原文位置：${input.where}`)
  lines.push('请只改上述问题，保持剧情与文风一致，不要改变原意。')
  return lines.join('\n')
}
