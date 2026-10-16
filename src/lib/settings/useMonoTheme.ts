/**
 * 「是否处于纯黑白主题」的响应式读取（3.1.1 第 3 项）
 *
 * 【为什么需要它】主题变量由 `index.css` 的 `[data-theme='mono']` 驱动，而
 * **图表里的语义数据色是内联 SVG 属性**（`fill={hex}` / `stroke={hex}`）—— CSS 够不到，
 * 也没法从色值反推「该改用哪种线型 / 形状」。所以必须让组件**知道当前是不是 mono**。
 *
 * 【为什么用 MutationObserver 而不是自定义事件】
 * 主题落点是 `document.documentElement.dataset.theme`，写入路径不止 `applyTheme()` 一处
 * （自定义主题预览 `applyCustomTheme` 也直接写 dataset）。观察属性变化能把所有路径一网打尽，
 * 包括实机脚本里直接 `document.documentElement.dataset.theme = 'mono'` 这种旁路。
 *
 * ⚠️ 这也顺手修掉了规划里点名的问题：「渲染时取值的固定 hex，主题切换不触发重渲染」。
 */
import { useEffect, useState } from 'react'

function readMono(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.theme === 'mono'
}

/** 当前是否「纯黑白」主题；主题切换（含直接改 dataset）会触发重渲染 */
export function useMonoTheme(): boolean {
  const [mono, setMono] = useState(readMono)
  useEffect(() => {
    setMono(readMono())
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => setMono(readMono()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return mono
}
