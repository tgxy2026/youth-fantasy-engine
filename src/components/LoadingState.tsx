/**
 * 统一的「加载中」占位（P2-3 · 空态/加载态收敛）。
 *
 * 背景：NovelEditor / TableSheet / Dashboard / CharacterSheet / OutlineSheet / FormSheet
 * 六处各写了完全相同的 `<div className="p-8 text-ink-400 text-sm">加载中…</div>`，
 * 想统一调样式（加 spinner、改字号、改文案）得改六遍，且容易漏。
 *
 * ⚠️ 刻意只收「这一种形状」。项目里另有若干加载态写法与本组件不同——
 *   · App.tsx 的 Suspense fallback（整屏居中）
 *   · ProjectHub（居中 + Loader2 旋转图标）
 *   · CharacterDistribution / WritingGoals（py-8 居中 + text-12）
 *   · BackupManager（行内小字）
 * 它们排版/语义确实不一样，强行统一会制造抽象泄漏（参见 MEMORY 中「抽象泄漏判据」）。
 * 需要那些排版请继续各自内联，不要往本组件堆 variant。
 */
export function LoadingState({ text = '加载中…' }: { text?: string } = {}) {
  return <div className="p-8 text-ink-400 text-sm">{text}</div>
}
