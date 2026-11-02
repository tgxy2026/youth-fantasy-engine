// ============ C2 · 2 证据包的打印页（3.3.4）============
//
// 规划 §4.2：网页 / 便携版没有主进程 PDF 通道 ⇒ 复用**同一份** EvidencePack 生成的
// 自包含 HTML，在用户点击时**先**打开打印页、再写入内容，避免用户激活消失后弹窗被拦。
//
// 🔴 纪律（规划 §10.1）：
//   ① 只写**本机刚生成的导出文档**（`renderDoc(..., 'html')` 的返回值，转义已在导出层做完），
//      不接受外部 HTML、不读远程正文 / 凭据；
//   ② 打开后立刻把 `opener` 置空，不持有可操作原窗口的通道；
//   ③ 打印对话框由用户控制 —— 这里只负责把打印页打开并唤起 `print()`，
//      不报「PDF 已保存」，也不猜测用户是否真的保存了；
//   ④ 被拦 / 不支持一律返回明确结果，由调用方退回「下载 HTML」并给打开步骤。
//
// ⚠️ 没有用 Blob URL：写入后立即 revoke 会让页面空白（规划 §4.2 点名过这个坑）；
//    直接 `document.write` 到新窗口则不存在 URL 生命周期问题。

export type PrintOutcome = 'opened' | 'blocked' | 'unsupported'

/**
 * 打开打印页并写入 `html`。
 * @param html 已生成的**自包含** HTML（同一份证据快照，不做二次拼接）
 * @param delayMs 唤起打印对话框前的等待：让新窗口完成一次排版（默认 250ms）
 */
export function openPrintPage(html: string, delayMs = 250): PrintOutcome {
  if (typeof window === 'undefined') return 'unsupported'
  const w = window.open('', '_blank')
  if (!w) return 'blocked'
  try {
    // ② 断开双向引用：打印页不能反过来操作原窗口
    try { w.opener = null } catch { /* 部分浏览器只读，忽略 */ }
    w.document.open()
    w.document.write(html)
    w.document.close()
  } catch {
    // 写入失败（极少数策略下 about:blank 不可写）⇒ 关掉这张空白页，让调用方走下载回退
    try { w.close() } catch { /* ignore */ }
    return 'unsupported'
  }
  // ③ 只唤起打印对话框：成功与否由用户在对话框里决定，界面不得报「已保存 PDF」
  printWhenReady(w, delayMs)
  return 'opened'
}

/**
 * 等新窗口把文档排完再唤起打印。
 *
 * 🔴 固定延时不够：长篇证据包有几十页、还要加载中文字体，250ms 时可能仍在排版 ——
 *    这时 `print()` 会打出空白页或截断内容（S-11 要求"正文/分页/内容完整"）。
 * 做法：先等一个 `delayMs` 让 `document.write` 生效，再轮询 `readyState === 'complete'`，
 * 最多等 `maxWaitMs`（超时也照样打印，避免用户点了没反应）。
 */
function printWhenReady(w: Window, delayMs: number, maxWaitMs = 3000): void {
  const start = Date.now()
  const attempt = () => {
    try {
      if (w.closed) return
      const ready = w.document.readyState === 'complete'
      if (!ready && Date.now() - start < maxWaitMs) {
        window.setTimeout(attempt, 100)
        return
      }
      w.focus()
      w.print()
    } catch {
      // 打印被浏览器拒绝时，打印页仍开着，用户可以自己按 Ctrl+P
    }
  }
  window.setTimeout(attempt, delayMs)
}