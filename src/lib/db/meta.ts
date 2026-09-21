// ============ 存储层 · 元数据（meta / 项目设置 / 每日码字统计）============
// 2026-09-19 结构优化 D2：自 db.ts 拆出。
import { todayKey } from '../date'
import { ops, currentProjectId } from './core'

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
