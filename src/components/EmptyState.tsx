/**
 * 统一的「下拉/列表内空态」占位（空态收敛 · 2026-09-17 审计）。
 *
 * 背景：`CustomSelect` / `CalendarSelect` / `TableRefSelect` 三处各写了一模一样的
 * `<div className="px-2.5 py-2 text-[11px] text-ink-500">…</div>`，只有文案不同。
 * 想统一调字号/间距就得改三遍，且必漏。
 *
 * ⚠️ 与 `LoadingState` 同一条纪律：**刻意只收「这一种形状」**（下拉弹层内部的单行空态）。
 *    项目里另有七十多处空态是别的排版 —— 整页居中、卡片内、带图标或带「去新建」按钮的，
 *    排版与语义确实不同，强行统一会制造抽象泄漏（参见 MEMORY 的「抽象泄漏判据」）。
 *    那些请继续各自内联，**不要往本组件堆 variant**。
 */
export function EmptyState({ text }: { text: string }) {
  return <div className="px-2.5 py-2 text-[11px] text-ink-500">{text}</div>
}
