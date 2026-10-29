/** Allowlisted recovery language; never echo arbitrary transport errors, paths or credentials. */
export function storageFailureReason(error: unknown): { code: string; description: string } {
  const text = typeof error === 'string' ? error : ''
  if (/SESSION_REPLACED|已在别处登录/i.test(text)) return { code: 'session-replaced', description: '账号已在别处登录，本次会话已失效，修改尚未确认保存。请先保留或复制当前草稿，再重新登录。' }
  if (/登录.*过期|SESSION_EXPIRED|HTTP 401|AUTH_REQUIRED/i.test(text)) return { code: 'session-expired', description: '登录已过期，修改尚未确认保存。请先保留或复制当前草稿，再重新登录。' }
  if (/HTTP 413|QUOTA_EXCEEDED|配额|容量.*超/i.test(text)) return { code: 'quota', description: '存储配额不足，修改尚未确认保存。请保留草稿，查看存储区用量和处理入口后重试。' }
  if (/EPERM|EACCES|EROFS|只读|写.*权限/i.test(text)) return { code: 'permissions', description: '数据文件暂时无法写入。请保留当前页面，查看存储区的写入权限说明后重试。' }
  if (/Failed to fetch|NetworkError|HTTP 50[234]|超时|timeout/i.test(text)) return { code: 'network', description: '存储连接失败或请求超时，修改尚未确认保存。请保留当前草稿，检查连接后重试。' }
  return { code: 'generic', description: '本次写入未确认成功。请保留当前页面，查看存储区的错误说明后重试。' }
}
