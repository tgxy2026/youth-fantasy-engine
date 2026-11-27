/**
 * 3.7.5 · Q-01：四档语义表面的**类名常量**（单一真源）。
 *
 * 【为什么要有这个文件】
 *   此前全站容器背景各写各的 alpha（统计到 57 种，`bg-ink-900/40` 一种就出现 125 次），
 *   于是「小窗口透明度」看起来是随机的。现在容器级背景只允许四档，取值在 index.css 的
 *   各主题里定义（暗色 0.55 / 0.82 / 0.90 / 0.96；浅色四主题单独调高；mono 收为实色）。
 *
 * 【层级语义】同页相邻两层 alpha 差必须 ≥ 0.06（硬约束，见 index.css 注释）
 *   - L1 `container`  页面大区 / 侧栏 / 抽屉外壳（不加磨砂）
 *   - L2 `card`       内容卡（磨砂 8px）
 *   - L3 `block`      卡内块（不叠磨砂）
 *   - L4 `overlay`    弹窗 / 浮窗（磨砂 16px）；`overlaySoft` 是沿用 ink-850 底色的变体
 *
 * 【不适用范围】chip / 输入框 / 徽标 / 进度条等点缀，以及表格 sticky 表头（必须实色，
 *   否则滚动时下面的行会透出来）。
 *
 * 用法：`<div className={`${SURFACE.card} border border-ink-700/75 rounded-xl p-4`}>`
 */

export const SURFACE = {
  container: 'yfe-surface-1',
  card: 'yfe-surface-2',
  block: 'yfe-surface-3',
  overlay: 'yfe-surface-4',
  overlaySoft: 'yfe-surface-4-soft',
} as const