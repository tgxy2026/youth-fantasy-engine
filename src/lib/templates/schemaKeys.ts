/**
 * 页签在 schema 里的全部**存储键**（列名 / `模块名::字段名`）。
 *
 * 别名清洗、轻量字段定义迁移与显示名解析都要这份清单 —— 各处自己拼一遍，
 * 但凡漏掉 columns 或 modules，改名就会被静默丢弃。
 */
import type { TabDef } from '@/lib/types'

export function storageKeysOf(tab: TabDef): string[] {
  const keys = (tab.columns ?? []).map(c => c.name)
  for (const m of tab.modules ?? []) {
    for (const f of m.fields) keys.push(`${m.name}::${f.name}`)
  }
  return keys
}
