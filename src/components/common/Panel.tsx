import type { HTMLAttributes, ReactNode } from 'react'

/**
 * 通用面板容器（2026-10-03 六维审计 U4）
 *
 * 【为什么有它】`bg-ink-850 border border-ink-700 rounded-xl p-5` 这一串「卡片」样式，
 * 此前在 7 个文件里被手写了 16 次 —— 改样式要改 16 处，且必然演化出细微差异。
 * 收敛到这里做**单一真源**。
 *
 * 【两种用法】
 * · 语义上是「一节内容」→ 用组件 `<Panel className="mb-6">…</Panel>`（渲染成 `<section>`）。
 * · 语义上只是「一个盒子」（如 MaterialLibrary 的 BlockView 外壳，不宜升级成 section）→
 *   用常量 `<div className={PANEL_CLS}>…</div>`，保留原标签。
 *
 * ⚠️ 间距（`mb-6` / `mt-6` 等）一律由调用方经 `className` 追加 —— 不在这里内置，
 *    否则每个调用点都要和默认值打架。
 */
export const PANEL_CLS = 'bg-ink-850 border border-ink-700 rounded-xl p-5'

export default function Panel({ className = '', children, ...rest }: HTMLAttributes<HTMLElement> & { children?: ReactNode }) {
  return (
    <section className={`${PANEL_CLS}${className ? ' ' + className : ''}`} {...rest}>
      {children}
    </section>
  )
}
