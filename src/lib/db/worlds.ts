/**
 * 世界引擎 · 存储层（3.0 · W4-1b）
 *
 * 🔴 与其它 store 的**关键差异**：`worlds` **不是项目级数据** ——
 *   世界可被多个作品引用（方案 §10.3 #8），所以：
 *     · **不建 `projectId` 索引**、读取**不按项目过滤**（同 `projects` 的口径：全局可读）；
 *     · **删项目时不清理** —— 世界记的是「来源 origin」，不是「归属」。
 *   它随整库同步 / 备份走（已登记进 `syncCore.SYNC_STORES`）。
 *
 * 【读写分工】本文件只管**存取**；「抽包 / 指纹 / 封存」在 `lib/worldPack.ts`（业务层），
 *   之所以分开：`worldPack` 依赖 db 门面，若本文件反向 import 它就会成环
 *   （形状因此集中在 `lib/worldTypes.ts`）。
 */
import type { WorldStoredRecord } from '../worldTypes'
import { ops, touchProject, currentProjectId } from './core'

/** 全部世界（按最近改动倒序 —— 世界引擎列表就是这个顺序） */
export async function listWorlds(): Promise<WorldStoredRecord[]> {
  const all = await ops.getAll<WorldStoredRecord>('worlds')
  return all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export async function getWorld(id: string): Promise<WorldStoredRecord | null> {
  const rec = await ops.get<WorldStoredRecord>('worlds', id)
  return rec ?? null
}

/** 新建或更新（`updatedAt` 由本函数统一写，调用方不必自己维护） */
export async function saveWorld(rec: WorldStoredRecord): Promise<void> {
  await ops.put('worlds', { ...rec, updatedAt: Date.now() })
  touchProject(currentProjectId)
}

/**
 * 删除一个世界（**连它的版本历史一起** —— 版本只活在记录内，不另存）。
 * ⚠️ 与删子项同理：走 `ops.del` 才会挂上云盘同步的墓碑（漏了就「删了会复活」）。
 */
export async function deleteWorld(id: string): Promise<void> {
  await ops.del('worlds', id)
  touchProject(currentProjectId)
}
