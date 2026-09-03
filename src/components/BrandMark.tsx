/**
 * 品牌图标：悬锋斜笔（毛笔）——替代原 lucide `Feather`，用于品牌位：
 * 项目中心标题上方（26px）、侧栏左上角（16px）、便携版入口页（26px）。
 *
 * 造型要点：斜置毛笔（笔杆左上 → 笔锋右下），笔尖悬着一滴墨（「悬锋」）。
 * 跟随 lucide 线条规范：viewBox 24、currentColor、strokeWidth 1.75、圆角端点，
 * 颜色经 currentColor 继承外层 className（如 text-amber），8 套主题自动适配。
 */
export default function BrandMark({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <g transform="translate(12 12) scale(0.95) translate(-12 -12)">
        {/* 笔杆（竹管，左上 → 右下） */}
        <path d="M1.6 3.4 11.1 12.9l1.8-1.8L3.4 1.6Z" />
        {/* 笔箍（金属环，略宽于杆） */}
        <path d="M10.8 13.2l2 2 2.4-2.4-2-2Z" />
        {/* 笔锋（锥形笔头，收于尖） */}
        <path d="M12.9 15.1 18.8 18.8 15.1 12.9Z" />
        {/* 悬锋墨滴（笔尖延长线上，将落未落） */}
        <circle cx="20.9" cy="20.9" r="0.95" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}
