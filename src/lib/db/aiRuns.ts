// ============ 存储层 · AI 运行账本（3.0 · W1-1）============
//
// 「这本书的 AI 是怎么被调用的」持久化记录 —— 支撑 §10.3 #1「统一运行账本」。
// 与 `aiTaskCenter` 的分工：
//   · aiTaskCenter —— **内存态**长任务状态（running / 进度 / 可中止），关窗即失，够用就好；
//   · aiRuns       —— **持久化**运行账本（任务定义 / 版本基准 / 候选 / 调用 / 验收回执），
//                     跨会话仍在，供「回看这次 AI 干了什么」「哪段内容老被拒」。
//
// 🔴 与 §10.3 #6「AI 消耗统计」**共用同一份调用账**：`calls[]` 记 model / ms / tokens /
//    finishReason（后者同时是 §14 拒答感知的判据来源）。一处记录、多处消费。
//
// 🔴 与 §10.3 #1「版本保护」同源：`basis` 记「候选产出时基准长什么样」；
//    采纳前比对当前状态，任一指纹不符 ⇒ 候选失效，**拒绝静默覆盖作者编辑**。
//
// 项目级数据：随项目走 —— 导出项目时一并带走、删项目时一并清理（同 tavernReports 口径）。
import type { AiRun } from '../aiRunTypes'
import { ops } from './core'

export async function getAiRun(id: string): Promise<AiRun | undefined> {
  return ops.get<AiRun>('aiRuns', id)
}

/** 某项目的全部运行记录（走 projectId 索引，避免全表扫） */
export async function listProjectAiRuns(projectId: string): Promise<AiRun[]> {
  return ops.getAllByIndex<AiRun>('aiRuns', 'projectId', projectId)
}

/**
 * 最近 N 条运行记录（跨项目，供账本总览）。
 * ⚠️ 用全表读 + 内存排序而非索引：账本是**追加型**记录、单库规模有限（百级），
 *    而 startedAt 索引取「最近 N」需要游标反向遍历，复杂度不划算。
 */
export async function listRecentAiRuns(limit = 50): Promise<AiRun[]> {
  const all = await ops.getAll<AiRun>('aiRuns')
  return all.sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(0, limit))
}

export async function saveAiRun(r: AiRun): Promise<void> {
  await ops.put('aiRuns', r)
}

export async function deleteAiRun(id: string): Promise<void> {
  await ops.del('aiRuns', id)
}

/** 删项目级联：清掉该项目的全部运行记录（由 db/projects.ts 的 deleteProject 调用） */
export async function deleteProjectAiRuns(projectId: string): Promise<void> {
  const rows = await listProjectAiRuns(projectId)
  if (rows.length) await ops.bulkDel('aiRuns', rows.map(r => r.id))
}
