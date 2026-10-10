// ============ 存储层 · 元数据（meta / 项目设置 / 每日码字统计）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import { todayKey } from '@/lib/app/date'
import { ops, currentProjectId } from '@/lib/db/core'

// ============ Meta ============
export async function getMeta<T>(key: string, def: T): Promise<T> {
  const rec = await ops.get<{ key: string; value: T }>('meta', key)
  return rec?.value ?? def
}
export async function setMeta(key: string, value: unknown) {
  await ops.put('meta', { key, value })
}

// ============ 每日码字统计 ============
export interface DailyStat { key: string; projectId: string; date: string; words: number }

/** 累加当日字数增量（可为负，最低 0） */
export async function addDailyWords(delta: number) {
  if (!currentProjectId || !delta) return
  const key = `${currentProjectId}::${todayKey()}`
  const rec = await ops.get<DailyStat>('dailyStats', key)
  const words = Math.max(0, (rec?.words ?? 0) + delta)
  await ops.put('dailyStats', { key, projectId: currentProjectId, date: todayKey(), words })
}
/** 获取当前项目全部每日统计 */
export async function getDailyStats(): Promise<DailyStat[]> {
  const all = await ops.getAll<DailyStat>('dailyStats')
  return all.filter(s => s.projectId === currentProjectId).sort((a, b) => a.date.localeCompare(b.date))
}
/** 直接写入某日统计（种子数据用，不累加） */
export async function putDailyStat(date: string, words: number) {
  await ops.put('dailyStats', { key: `${currentProjectId}::${date}`, projectId: currentProjectId, date, words } as DailyStat)
}

// ============ 项目设置（自定义敏感词 / 取名收藏） ============
export async function getSetting<T>(key: string, def: T): Promise<T> {
  const rec = await ops.get<{ key: string; value: T }>('settingsKV', `${currentProjectId}::${key}`)
  return rec?.value ?? def
}
export async function setSetting(key: string, value: unknown) {
  await ops.put('settingsKV', { key: `${currentProjectId}::${key}`, value })
}

/**
 * 按**指定项目 id**读写项目设置（3.0 · 题材开关）。
 *
 * 🔴 为什么不能拿上面两个顶替：它们拼的是 `currentProjectId`（当前打开的那一本）。
 *    在「项目管理页」编辑**另一本**项目的设置时，那会被写到当前打开的书上 ——
 *    表现是"改了 A 的开关，B 的行为变了"，且极难定位。凡是"要改的不是当前项目"的场合
 *    （项目管理页的编辑卡片 / 批量操作 / 导入后的补写）一律走这两个。
 */
export async function getSettingFor<T>(pid: string, key: string, def: T): Promise<T> {
  const rec = await ops.get<{ key: string; value: T }>('settingsKV', `${pid}::${key}`)
  return rec?.value ?? def
}

export async function setSettingFor(pid: string, key: string, value: unknown) {
  await ops.put('settingsKV', { key: `${pid}::${key}`, value })
}
