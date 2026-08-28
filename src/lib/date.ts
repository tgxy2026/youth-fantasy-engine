/** 今日日期 key（yyyy-mm-dd）：每日码字统计 / 每日自动备份逻辑共用，确保口径一致 */
export function todayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
