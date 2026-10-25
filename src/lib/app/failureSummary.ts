/** Public error reports omit arbitrary messages, directories, query strings and function arguments. */
export function summarizeFailure(error: unknown): string {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'QuotaExceededError', 'SecurityError', 'InvalidStateError', 'NotAllowedError', 'AbortError', 'NotFoundError', 'UnknownError'])
  let name = 'Error', stack = ''
  try {
    if (error && typeof error === 'object') {
      const value = error as { name?: unknown; stack?: unknown }
      if (typeof value.name === 'string' && names.has(value.name)) name = value.name
      if (typeof value.stack === 'string') stack = value.stack.slice(0, 20000)
    }
  } catch { /* A throwing custom accessor must not break the fallback screen. */ }
  const frames = new Set<string>()
  for (const line of stack.split('\n').slice(1, 60)) {
    const match = /[/\\]([A-Za-z0-9_.-]{1,100}\.(?:tsx?|[cm]?js))(?::(\d{1,7}))?(?::(\d{1,7}))?/.exec(line)
    if (!match) continue
    frames.add(match[1] + (match[2] ? ':' + match[2] : '') + (match[3] ? ':' + match[3] : ''))
    if (frames.size >= 8) break
  }
  return [`错误类型：${name}`, frames.size ? `文件位置：\n${[...frames].map(frame => '  ' + frame).join('\n')}` : '文件位置：未取得', '此摘要不含原始错误消息、目录与请求参数。'].join('\n')
}
