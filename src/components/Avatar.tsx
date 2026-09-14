/**
 * 头像（批次 8）—— **有图用图，没图用名字首字**。
 *
 * 抽成共用件的原因和 TavernMessage 一样：角色卡片列表、自由对话气泡、在场者一览、
 * 状态栏、我的档案都要同一个头像，各写一份必然在圆角/尺寸/回退字符上慢慢分叉。
 *
 * ⚠️ 尺寸走 inline style 而不是 Tailwind 类：边长是变量（24 / 28 / 36 / 64），
 *    类名穷举不了；而且这里写的是**数值 px**，不涉及从 DOM 读尺寸回设（那条 zoom 红线管不到）。
 */
import { avatarInitial } from '../lib/imageAvatar'

export default function Avatar({ src, name, size = 24, className = '', title }: {
  src?: string
  name: string
  /** CSS 像素边长（正方形） */
  size?: number
  className?: string
  /** 悬停提示（默认用名字） */
  title?: string
}) {
  const box = { width: `${size}px`, height: `${size}px` }

  if (src) {
    return (
      <img
        src={src}
        alt=""
        title={title ?? name}
        style={box}
        className={`shrink-0 rounded-full object-cover bg-ink-800 ${className}`}
      />
    )
  }

  return (
    <span
      title={title ?? name}
      style={{ ...box, fontSize: `${Math.max(10, Math.round(size * 0.43))}px` }}
      className={`shrink-0 rounded-full bg-ink-700 text-ink-200 flex items-center justify-center select-none ${className}`}
    >
      {avatarInitial(name)}
    </span>
  )
}
