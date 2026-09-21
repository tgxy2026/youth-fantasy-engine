/**
 * 命中点的上下文片段 —— 把「第几个字命中」变成一段能显示在单行 UI 里的摘录。
 *
 * 统一口径（2026-09-17 审计 · 老大拍板）：
 * 本项目原有四份各自实现 —— `sensitiveWords` / `typoWords` / `styleAudit` / `EditorModals`。
 * 前三者窗口与省略号写法本就一致；差异集中在「尾省略号」：
 *   · `typoWords` / `styleAudit` 从不补 → 截到一半也不提示，读者会以为这句就是全文
 *   · `EditorModals` 恒补（且窗口 −15/+15）→ 截到文末还补，暗示后面还有
 * 此处取唯一「不撒谎」的写法：**前边还有内容才补前省略号，后边还有内容才补后省略号**。
 *
 * ⚠️ 换行统一压成空格（片段要显示在单行 UI 里）。
 */
export function contextSnippet(text: string, index: number, len: number, pad = 12): string {
  const start = Math.max(0, index - pad)
  const end = index + len + pad
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\n/g, ' ') + (end < text.length ? '…' : '')
}
