/**
 * 创作参考 · 读取与拼块（3.6.0 · C）
 *
 * 把「纯逻辑」(`reference.ts`) 与「存储」连起来，供写作入口在**启动时**快照一次。
 *
 * 🔴 读不到成果时**不发**（宁可不带参考，也不能假装带了）。
 *    带空参考比带错参考安全：后者会让模型把别人的情节当本项目的写法依据。
 */
import { loadArtefacts } from '@/lib/artefacts/store'
import { getCurrentProjectId } from '@/lib/db/core'
import { buildReferenceBlock, referenceCardsOf, type ReferenceBlock, type ReferenceBudget } from './reference'

export const EMPTY_REFERENCE_BLOCK: ReferenceBlock = { text: '', usedIds: [], dropped: [], chars: 0 }

/** 按成果 id 取参考并拼块；没有选择 / 读失败 ⇒ 空块 */
export async function referenceBlockForIds(
  ids: readonly string[], budget: ReferenceBudget = {}, projectId = getCurrentProjectId(),
): Promise<ReferenceBlock> {
  if (!ids.length || !projectId) return EMPTY_REFERENCE_BLOCK
  const loaded = await loadArtefacts(projectId).catch(() => null)
  if (!loaded || loaded.error) return EMPTY_REFERENCE_BLOCK
  return buildReferenceBlock(referenceCardsOf(loaded.store), ids, budget)
}
