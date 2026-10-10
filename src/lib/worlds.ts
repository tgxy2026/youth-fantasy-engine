/**
 * 世界引擎 · 业务层（3.0 · W4-1b）
 *
 * 三件事：
 *   ① **抽**：从当前项目抽一个世界包存进世界引擎（草稿，尚无版本）；
 *   ② **封存**：把当前草稿固化成一份**不可变版本**（`versions[]` 只增不改）；
 *   ③ **编辑草稿**：改了要生效必须**再封一次** —— 这就是方案 §10.3 #8 的「不可变世界版本」。
 *
 * 存储走 `db/worlds.ts`，形状来自 `worldTypes.ts`（那个文件无依赖，避免 db ↔ worldPack 成环）。
 */
import * as db from './db'
import { collectWorldPack, worldPackFingerprint } from './worldPack'
import type { WorldStoredRecord, WorldVersion, WorldPackTable } from './worldTypes'

/** 从**当前项目**抽包并存进世界引擎（草稿＝抽包结果，`versions` 为空） */
export async function createWorldFromCurrentProject(
  name: string,
  projectName?: string,
): Promise<WorldStoredRecord> {
  const pack = await collectWorldPack({ name, projectName })
  const now = Date.now()
  const rec: WorldStoredRecord = {
    id: pack.id,
    name: pack.name,
    origin: pack.origin,
    tables: pack.tables,
    activeSubs: pack.activeSubs,
    fingerprint: pack.fingerprint,
    versions: [],
    createdAt: now,
    updatedAt: now,
  }
  await db.saveWorld(rec)
  return rec
}

/**
 * 封存：把**当前草稿**固化成一份不可变版本。
 * `v` 从 1 起单调递增（`max(已有 v) + 1`）；找不回记录返回 `null`（不抛）。
 */
export async function freezeWorld(id: string, note?: string): Promise<WorldStoredRecord | null> {
  const rec = await db.getWorld(id)
  if (!rec) return null
  const versions = rec.versions ?? []
  const version: WorldVersion = {
    v: versions.reduce((m, x) => Math.max(m, x.v ?? 0), 0) + 1,
    at: Date.now(),
    fingerprint: rec.fingerprint,
    tables: rec.tables,
    activeSubs: rec.activeSubs,
    ...(note && note.trim() ? { note: note.trim() } : {}),
  }
  const next: WorldStoredRecord = { ...rec, versions: [...versions, version], updatedAt: Date.now() }
  await db.saveWorld(next)
  return next
}

/**
 * 更新草稿（改完**重算指纹**）。
 * 🔴 只动草稿 —— 已封存的版本一个字节都不碰（不可变性由「版本存的是当时那份 tables 副本」保证）。
 */
export async function updateWorldDraft(
  id: string,
  tables: WorldPackTable[],
  activeSubs: Record<string, string[]>,
): Promise<WorldStoredRecord | null> {
  const rec = await db.getWorld(id)
  if (!rec) return null
  const next: WorldStoredRecord = {
    ...rec,
    tables,
    activeSubs,
    fingerprint: worldPackFingerprint({ tables, activeSubs }),
    updatedAt: Date.now(),
  }
  await db.saveWorld(next)
  return next
}

/** 重命名（只动展示名，不影响内容与版本） */
export async function renameWorld(id: string, name: string): Promise<WorldStoredRecord | null> {
  const rec = await db.getWorld(id)
  if (!rec) return null
  const next: WorldStoredRecord = { ...rec, name: name.trim() || rec.name, updatedAt: Date.now() }
  await db.saveWorld(next)
  return next
}

/**
 * 草稿与**最新封存版本**是否不一致（＝有未封存的改动）。
 * 没有任何版本时：只要草稿非空就算「未封存」。
 */
export function draftDiffers(rec: WorldStoredRecord): boolean {
  const versions = rec.versions ?? []
  const last = versions[versions.length - 1]
  if (!last) return rec.tables.length > 0
  return last.fingerprint !== rec.fingerprint
}
