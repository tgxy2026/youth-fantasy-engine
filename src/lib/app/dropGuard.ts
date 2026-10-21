// ============ 全局 · 拖文件离手时别把页面"带走"（3.2.0） ============
//
// 【为什么必须有】给图片区加了拖拽上传之后，作者会**习惯性**地拖图。
// 只要有一次没落进那块区域（差 20px、拖到标题栏、松手太快），浏览器默认行为就是
// **用这个文件替换当前页面** —— 在桌面版里等于整页跳走、未保存的正文当场没了。
// 这个坑不是"万一"，是拖拽上线后几乎必然发生的事故，所以在装拖拽的同时就把它堵掉。
//
// 【只在拖文件时拦】章节树拖拽调序用自定义 types、正文拖动选区用 text/plain，
// 一律 preventDefault 会把这两条交互一起弄坏 —— 判定交给 `hasFilePayload`（唯一真源）。
//
// 【不提示"没放对位置"】落点判断在具体区域里（`useImageDrop`），这里只兜浏览器默认行为。
// 额外弹一句"请拖到图片区域"反而会盖住正常操作时的 toast。

import { hasDroppedFilePayload, hasFilePayload } from '@/lib/media/imageDrop'

let installed = false

export function installFileDropGuard() {
  if (installed) return
  if (typeof window === 'undefined') return
  installed = true

  const block = (e: DragEvent) => {
    const isFile = e.type === 'drop'
      ? hasDroppedFilePayload(e.dataTransfer?.types, e.dataTransfer?.files.length ?? 0)
      : hasFilePayload(e.dataTransfer?.types)
    if (!isFile) return
    e.preventDefault()
  }
  // dragover 不拦 ⇒ 落点不会亮；drop 不拦 ⇒ 浏览器拿这个文件导航。
  // 两个都走冒泡阶段的 window 监听：区域自己的处理器先跑（target→父级），
  // 所以**不会**抢掉图片区的上传。
  window.addEventListener('dragover', block)
  window.addEventListener('drop', block)
}
