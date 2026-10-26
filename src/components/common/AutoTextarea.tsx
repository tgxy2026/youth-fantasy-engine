import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'

/**
 * 窗口尺寸变化时的重测订阅（**模块级单例**）。
 *
 * 🔴 为什么需要：本组件靠「量 scrollHeight」定高度，而**行数会随宽度变**。界面缩放
 *    （`theme.ts` 的 applyZoom，尤其「跟随窗口」档）会重排文字 ⇒ 不重测就会留着旧高度：
 *    内容变高时冒出内部滚动条、变矮时留一片空白，直到下次编辑才纠正。
 * 🔴 为什么是单例而不是每个实例各挂一个：本组件全项目几十处在用，
 *    各挂一个监听器会让同一次 resize 被处理几十遍。
 */
const resizers = new Set<() => void>()
let resizerBound = false
function subscribeResize(fn: () => void): () => void {
  resizers.add(fn)
  if (!resizerBound && typeof window !== 'undefined') {
    resizerBound = true
    window.addEventListener('resize', () => { for (const f of resizers) f() })
  }
  return () => { resizers.delete(fn) }
}

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  /**
   * 最小显示行数。按**实际计算出的行高**换算成像素，所以换字号也不用改这里。
   * 不给则回落到 minHeight（默认 32px，与历史行为一致）。
   */
  minRows?: number
  /** 最小高度（px），保证空字段也有合适的点击区域。给了它就以它为准，忽略 minRows */
  minHeight?: number
  /**
   * 最大高度（px），超过后内部滚动，避免超长文本把页面撑得过长。
   * **传 0 = 不设上限**：框子随文本一路长高，永不出现内部滚动条
   * （「设定草稿箱」这类"想到多少写多少"的场合要的就是这个手感）。
   */
  maxHeight?: number
  /**
   * 字号类。默认 12px —— 需要别的字号时**从这里传**，别塞进 className：
   * Tailwind 同类工具类谁生效取决于生成顺序，两处各写一个字号就成了开盲盒。
   */
  textClass?: string
  disabled?: boolean
  /** 拼写检查。中文场景建议传 `false` —— 否则浏览器会给中文划红波浪线 */
  spellCheck?: boolean
  autoFocus?: boolean
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  title?: string
  ariaLabel?: string
  /**
   * 外部 ref：需要程序化聚焦 / 选中一段文本时传（酒馆的快捷指令预填要用 ——
   * 预填后把「该改的那一段」选中，作者直接改就行）。
   */
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>
}

/**
 * 自动撑高的多行文本框：随内容增高，到 maxHeight 后转为内部滚动。
 * 用于表单型 / 卡片型页签的字段输入，解决"长文本被写死行高截断、需手动滚滑条"的问题。
 *
 * 默认最小高度刻意保持 32px（历史行为）—— 想要「至少 3 行」的输入框请传 `minRows={3}`，
 * 这样已有的几十处调用一个都不会因此变形。
 */
export default function AutoTextarea({
  value, onChange, placeholder, className = '',
  minRows, minHeight, maxHeight = 360, textClass = 'text-12',
  disabled, spellCheck, autoFocus, onKeyDown, title, ariaLabel, inputRef,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  const measure = useCallback(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    // 行高取**计算值**而不是写死 20px —— 换字号/主题后依然算得准
    const cs = getComputedStyle(ta)
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 12) * 1.5
    const box = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
    const min = minHeight ?? (minRows ? Math.round(lh * minRows + box) : 32)
    // maxHeight=0 ⇒ 不封顶（见 props 注释）
    const cap = maxHeight > 0 ? maxHeight : Number.MAX_SAFE_INTEGER
    ta.style.height = Math.max(min, Math.min(ta.scrollHeight, cap)) + 'px'
  }, [minRows, minHeight, maxHeight])

  // 内容 / 字号档变化时重测
  useEffect(() => { measure() }, [measure, value, textClass])
  // 窗口尺寸（含界面缩放）变化时重测 —— 宽度变了行数就变，旧高度会失真
  useEffect(() => subscribeResize(measure), [measure])
  // Opening a collapsed group or resizing its parent can change width without a window resize.
  // Observe width only so writing the measured height cannot trigger a feedback loop.
  useEffect(() => {
    const ta = ref.current
    if (!ta || typeof ResizeObserver === 'undefined') return
    let width = ta.clientWidth
    const observer = new ResizeObserver(() => {
      if (ta.clientWidth === width) return
      width = ta.clientWidth
      if (width > 0) measure()
    })
    observer.observe(ta)
    return () => observer.disconnect()
  }, [measure])

  return (
    <textarea
      ref={el => { ref.current = el; if (inputRef) inputRef.current = el }}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={1}
      disabled={disabled}
      spellCheck={spellCheck}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      title={title}
      aria-label={ariaLabel}
      style={minHeight ? { minHeight } : undefined}
      className={`w-full leading-relaxed resize-none overflow-y-auto ${textClass} ${className}`}
    />
  )
}
