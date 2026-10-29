/**
 * 图片加载失败时的**可见降级 + 手动重试**（UX13）。
 *
 * 【它解决什么】
 *   图鉴主图 / 角色立绘 / 项目封面都是作者自己的图（dataURL 或本地文件），
 *   一旦解码失败或文件被移走，浏览器只会画一个破图标 —— 作者看不出「是图坏了还是软件坏了」，
 *   也没有任何入口再试一次。
 *
 * 【做法】
 *   `onError` 记下失败，换成**可读的占位**（结构锚点 `data-image-failure`）：
 *   「图片没能加载」+ 重试按钮。重试靠**换一个新的 `<img>` 节点**（`key` 递增）重新走一次加载，
 *   不是把同一个失败节点重挂壳子。
 *
 * 【红线】
 *   ① 不假装加载成功：失败就明说，不拿空白冒充图片，也不偷偷换成别人的图；
 *   ② 不抢布局：占位沿用调用方给的同一套 className（通常就是 img 上那套 `absolute inset-0 w-full h-full`），
 *      有图无图盒子尺寸一致，列表不会跳动；
 *   ③ `alt` 照旧传给 img；失败时占位用 `role="img"` + `aria-label` 把「没能加载」也读出来。
 */
import { useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'

export interface SafeImageProps {
  src: string
  alt: string
  /** 同时用于 `<img>` 与失败占位，保证有图无图尺寸一致 */
  className?: string
  title?: string
  loading?: 'lazy' | 'eager'
  decoding?: 'sync' | 'async' | 'auto'
  /** 是否给重试入口（很小的缩略图里给按钮反而挤，传 false） */
  retry?: boolean
}

export default function SafeImage({ src, alt, className = '', title, loading, decoding, retry = true }: SafeImageProps) {
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  // 换图（或同一槽位重新上传）要清掉上一次的失败态，否则新图永远显示占位
  useEffect(() => { setFailed(false); setAttempt(0) }, [src])

  if (!failed) {
    return <img
      key={`${src}#${attempt}`}
      src={src}
      alt={alt}
      title={title}
      loading={loading}
      decoding={decoding}
      className={className}
      onError={() => setFailed(true)}
    />
  }

  return <div
    data-image-failure=""
    role="img"
    aria-label={`${alt || '图片'}：没能加载`}
    title={title ?? '图片没能加载'}
    className={`${className} flex flex-col items-center justify-center gap-1 overflow-hidden bg-ink-900/70 text-ink-500`}
  >
    <ImageOff size={16} aria-hidden="true" />
    <span className="text-10 leading-tight text-center px-1">图片没能加载</span>
    {retry && <button
      type="button"
      className="text-10 leading-tight underline decoration-dotted text-amber/90 hover:text-amber cursor-pointer"
      onClick={() => { setFailed(false); setAttempt(current => current + 1) }}
    >重试</button>}
  </div>
}
