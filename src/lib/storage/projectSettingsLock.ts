/** Same-origin tab coordination only; remote devices still require sync conflict handling. */
export function withProjectSettingsLock<T>(projectId: string, key: string, operation: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request<Promise<T>>(`yfe-project-setting:${projectId}:${key}`, { mode: 'exclusive' }, operation).then(value => value)
  }
  if (typeof window !== 'undefined') return Promise.reject(new Error('当前环境不支持跨窗口写入保护，已停止保存'))
  return operation()
}
