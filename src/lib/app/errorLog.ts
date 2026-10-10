/**
 * 运行期错误留痕（2026-10-06 补 · 可观测性第二半）
 *
 * 目的：让「复制诊断信息」里能带上一句「最近出过什么错」，而不是用户只能说「它报错了」。
 *
 * 🔴 三条设计取舍（与 `diagnostics.ts` 的红线同源，**改前必读**）：
 *   ① **只在内存里留痕**（环形缓冲，刷新即清）—— 不落盘、不外发。
 *      错误消息常会夹带数据片段（如 `JSON.parse` 失败的原文），落盘就等于多一处
 *      可能被同步 / 备份带走的隐私；而用户反馈时软件通常还开着，内存里这几条足够定位。
 *   ② **消息必须截断、来源只留文件名** —— 见下面 `MSG_MAX` 与 `shortSource()` 的注释。
 *   ③ **只记不弹** —— 除了已有的渲染期错误边界，其余错误不打扰用户（F12 里照旧有完整堆栈）。
 *
 * 消费者：`lib/diagnostics.ts`（拼进诊断文本）、`components/ErrorBoundary`（渲染期错误）。
 */
export type ErrorKind = 'render' | 'window' | 'unhandled'

export interface ErrorRecord {
  /** 时间戳（毫秒） */
  at: number
  kind: ErrorKind
  /** 消息（已截断到 200 字、已压掉换行） */
  message: string
  /** 来源「文件名:行」（**只留 basename**，绝不带目录 —— 目录里含系统用户名） */
  source: string
}

/** 留痕上限：够定位最近一次，又不至于把诊断文本撑长 */
const MAX = 10
/**
 * 消息截断长度。
 * 🔴 只留前 200 字是**刻意的隐私取舍**：错误消息可能是「解析 X 失败：<整段正文>」，
 *    全留着就会随诊断信息一起被复制出去。
 */
const MSG_MAX = 200

const buf: ErrorRecord[] = []
let installed = false

/** 从任意 throw 出来的值里取一句可读消息（Error / string / 任意对象都要兜住） */
export function messageOf(e: unknown): string {
  let raw: string
  if (e instanceof Error) raw = e.message || e.name || 'Error'
  else if (typeof e === 'string') raw = e
  else {
    try { raw = JSON.stringify(e) ?? String(e) } catch { raw = String(e) }
  }
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > MSG_MAX ? one.slice(0, MSG_MAX) + '…' : one
}

/**
 * 把「URL / 绝对路径 / 相对路径」压成 `文件名:行`。
 * 🔴 只取 basename：完整路径会暴露系统用户名（`C:\Users\<名>\...`），也会把诊断文本撑长。
 */
export function shortSource(raw?: string | null, line?: number): string {
  if (!raw) return ''
  // 去掉查询串与哈希，再按两种分隔符取最后一段
  const clean = String(raw).split(/[?#]/)[0]
  const base = clean.split(/[\\/]/).filter(Boolean).pop() ?? ''
  if (!base) return ''
  return line && line > 0 ? `${base}:${line}` : base
}

/** 记一条（环形：超出上限丢最旧的） */
export function recordError(kind: ErrorKind, e: unknown, source?: string): void {
  buf.push({ at: Date.now(), kind, message: messageOf(e), source: source ?? '' })
  while (buf.length > MAX) buf.shift()
}

/** 取最近错误（**新的在前**，便于诊断文本直接按序展示） */
export function recentErrors(): ErrorRecord[] {
  return [...buf].reverse()
}

/** 清空（测试与「重置」用） */
export function clearErrors(): void {
  buf.length = 0
}

/**
 * 装全局钩子：`error`（脚本错误 / 资源加载失败）+ `unhandledrejection`（未处理的 Promise 拒绝）。
 * 启动时调一次即可；重复调用**无副作用**（内部有标记）。
 * 非浏览器环境（Node 测试）安全 no-op。
 */
export function installGlobalErrorHooks(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  installed = true

  window.addEventListener('error', (ev: ErrorEvent) => {
    // 资源加载失败（img/script）也会走到这里，但那时 ev.error 为空、message 为空
    // —— 用 filename 兜一句，否则会记下一条什么都不含的空记录
    const src = shortSource(ev.filename, ev.lineno)
    const err = ev.error ?? ev.message ?? (src ? `资源加载失败：${src}` : '未知脚本错误')
    recordError('window', err, src)
  })

  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    recordError('unhandled', ev.reason, '')
  })
}
