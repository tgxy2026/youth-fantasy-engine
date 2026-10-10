// ============ 存储层 · 酒馆模式推演报告 ============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
// 🔴 报告是**项目级**数据：随项目走 —— 导出项目时一并带走、删项目时一并清理（见 docs/酒馆模式-工程红线.md）。
import type { TavernReport } from '@/lib/tavern/types'
import { ops } from '@/lib/db/core'

// ============ 酒馆模式 · 推演报告 ============
// 报告是**项目级**数据（方案 §3.1）：随项目走，导出项目时一并带走，删项目时一并清理。
export async function getReport(id: string): Promise<TavernReport | undefined> {
  return ops.get<TavernReport>('tavernReports', id)
}

/** 某项目的全部报告（走 projectId 索引，避免全表扫） */
export async function listProjectReports(projectId: string): Promise<TavernReport[]> {
  return ops.getAllByIndex<TavernReport>('tavernReports', 'projectId', projectId)
}

export async function saveReport(r: TavernReport): Promise<void> {
  await ops.put('tavernReports', r)
}

export async function deleteReport(id: string): Promise<void> {
  await ops.del('tavernReports', id)
}
