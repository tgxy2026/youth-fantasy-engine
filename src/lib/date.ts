/**
 * 日期 → `YYYY-MM-DD`（本地时区，补零）。
 *
 * 🔴 **全项目唯一实现**（2026-09-17 审计合并）：每日码字统计、每日自动备份、
 * 云端同步的「每日备份」、酒馆日记都走这里 —— 口径要改只改这一处。
 * 原先 `syncCore.ts:155` 与 `tavern/summarize.ts:27` 各有一份逐字符相同的拷贝，
 * 而本文件的注释却写着「确保口径一致」—— 那份「一致」其实没人管。
 */
export function formatDate(d: Date | number = new Date()): string {
  const t = d instanceof Date ? d : new Date(d)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}

/** 今日日期 key（yyyy-mm-dd）。语义等同 `formatDate()`，保留旧名以免大范围改名。 */
export function todayKey(d: Date = new Date()): string {
  return formatDate(d)
}
