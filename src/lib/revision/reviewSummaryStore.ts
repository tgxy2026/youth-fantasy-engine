/**
 * 连写自检 · 运行摘要读写（3.6.0 · D 包）
 *
 * 落点：`settingsKV` 的 `<projectId>::reviewSummaries`（滚动最近 50 条）。
 * 纯逻辑在 `reviewSummary.ts`，这里只负责 IO —— 便于两边各自单测。
 *
 * 🔴 读失败/损坏都**不抛**：摘要只用于解释「这次到底查没查」，
 *    它坏掉不该让连写失败；但也不能伪造成空列表而不留痕（返回 error 由界面显示）。
 */
import { getSettingFor, setSettingFor } from '@/lib/db/meta'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import {
  REVIEW_SUMMARY_KEY, REVIEW_SUMMARY_LIMIT, bindSummaryChapter, parseReviewSummaries,
  withAppendedSummary, type ReviewRunSummary,
} from './reviewSummary'

export interface LoadedReviewSummaries {
  list: ReviewRunSummary[]
  error?: string
}

export async function loadReviewSummaries(
  projectId: string, owner?: OwnedOperation,
): Promise<LoadedReviewSummaries> {
  try {
    const raw = await getSettingFor<unknown>(projectId, REVIEW_SUMMARY_KEY, null, owner)
    if (raw === null || raw === undefined) return { list: [] }
    if (!Array.isArray(raw)) return { list: [], error: '运行摘要的结构不合法（不是数组）' }
    return { list: parseReviewSummaries(raw) }
  } catch (e) {
    return { list: [], error: `运行摘要读取失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

async function write(projectId: string, list: ReviewRunSummary[], owner?: OwnedOperation): Promise<void> {
  await setSettingFor(projectId, REVIEW_SUMMARY_KEY, list.slice(0, REVIEW_SUMMARY_LIMIT), owner)
}

/**
 * 追加一条（读 → 去重 → 头插 → 截断 → 写）。
 * ⚠️ 读改写不是事务：两个任务**同时**写可能丢一条（连写是串行的，正常路径不会并发）。
 *    摘要属运行记录，可容忍；真需要强一致时再引入锁。
 */
export async function appendReviewSummary(
  projectId: string, summary: ReviewRunSummary, owner?: OwnedOperation,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { list } = await loadReviewSummaries(projectId, owner)
    await write(projectId, withAppendedSummary(list, summary), owner)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `运行摘要写入失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * 把真实 chapterId 补绑到摘要上（自检时只有计划章号）。
 * 校验不过就**保留未绑定**，不按章号猜归属。
 */
export async function bindReviewSummaryChapter(
  projectId: string, summaryId: string, chapterId: string,
  expect: { chapterNo?: number; taskId?: string }, owner?: OwnedOperation,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { list } = await loadReviewSummaries(projectId, owner)
    const res = bindSummaryChapter(list, summaryId, chapterId, expect)
    if (!res.ok) return { ok: false, reason: res.reason }
    await write(projectId, res.list, owner)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `运行摘要绑定失败：${e instanceof Error ? e.message : String(e)}` }
  }
}
