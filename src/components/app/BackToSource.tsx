/**
 * 「返回来源」入口（UX05）。
 *
 * 【为什么做成浮层而不是加一行】
 *   页面主内容区高度被很多布局按「整块撑满」算（编辑器、地图、推演…），
 *   多插一行会把短窗/160% 缩放下的正文区再压掉一块（3.3.0 已经为这类问题修过一次）。
 *   所以它**绝对定位**在内容区右上角，不占布局高度，任何页面都不用改结构。
 *
 * 🔴 只在真的有关联跳转来源时出现；普通侧栏切换不产生来源，也就不会冒出来。
 */
export default function BackToSource({ label, onBack }: { label: string; onBack: () => void }) {
  const text = label.trim() ? `返回：${label.trim()}` : '返回上一页'
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-30 max-w-[min(24rem,60%)]">
      <button
        type="button"
        onClick={onBack}
        title={`${text}（回到你跳转前所在的位置）`}
        className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-850/95 px-2.5 py-1 text-11 text-ink-200 shadow-lg backdrop-blur transition-colors hover:border-amber/50 hover:text-amber"
      >
        <span aria-hidden>←</span>
        <span className="truncate">{text}</span>
      </button>
    </div>
  )
}
