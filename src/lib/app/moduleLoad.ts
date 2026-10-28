/**
 * 按需加载的页面模块（`lazy(() => import(...))`）加载失败 —— 判定与安全摘要（UX13）。
 *
 * 【它解决什么】
 *   页面代码是分包懒加载的：网络断了、或刚更新过版本而旧分包文件已被替换时，`import()` 会失败。
 *   这类失败在一个地方可以**真重试**（重新发一次请求），而页面内部的渲染错误重试只是重挂载 ——
 *   两者给作者的下一步完全不同，所以必须先能分辨。
 *
 * 【三条红线】
 *   ① **不冒充「重试一定能好」**：本模块只负责判定与标记，是否真能恢复由调用方的重试路径决定；
 *   ② **对外不带原始消息**：`import()` 的报错里通常含分包地址、构建哈希与查询串，
 *      一律压成固定文案，技术摘要仍走 `summarizeFailure` 的白名单口径；
 *   ③ **判定不能被恶意对象带崩**：错误值的 getter 可能抛，读 `name` / `message` 必须兜住。
 */

/** 动态 import 失败时各浏览器 / 打包器给出的特征（判定只用于内部，不进界面文案） */
const PATTERNS: readonly RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading chunk [\w-]+ failed/i,
  /chunkloaderror/i,
  /unable to preload css/i,
]

/** 对外可见的固定文案：不带原始消息、不带地址 */
export const MODULE_FAILURE_MESSAGE = '模块文件未能加载'

/**
 * 被包装后的模块加载失败。
 * `cause` 只留作本机排查，界面与技术摘要都不会原样展示它。
 */
export class ModuleLoadError extends Error {
  readonly kind = 'module-load'
  readonly cause: unknown
  constructor(cause: unknown) {
    super(MODULE_FAILURE_MESSAGE)
    // ⚠️ name 保持 'Error'：它要经过 summarizeFailure 的白名单，自定义 name 也只会退化成 'Error'
    this.name = 'Error'
    this.cause = cause
  }
}

/** 把任意抛值规范成模块加载失败（已经是就原样返回，保证幂等） */
export function moduleLoadFailure(cause: unknown): ModuleLoadError {
  return cause instanceof ModuleLoadError ? cause : new ModuleLoadError(cause)
}

function readString(value: unknown, key: 'name' | 'message'): string {
  try {
    if (!value || typeof value !== 'object') return ''
    const raw = (value as Record<string, unknown>)[key]
    return typeof raw === 'string' ? raw : ''
  } catch {
    return ''
  }
}

/**
 * 这个错误是不是「页面代码文件没拿到」。
 * 既认自己包装过的，也认未包装就冒上来的（如跨源脚本、打包器直接抛的情形）。
 */
export function isModuleLoadFailure(error: unknown): boolean {
  if (error instanceof ModuleLoadError) return true
  const text = readString(error, 'name') + '\n' + readString(error, 'message')
  if (!text.trim()) return false
  return PATTERNS.some(pattern => pattern.test(text))
}
