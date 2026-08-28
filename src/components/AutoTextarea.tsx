import { useEffect, useRef } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  /** 最小高度（px），保证空字段也有合适的点击区域 */
  minHeight?: number
  /** 最大高度（px），超过后内部滚动，避免超长文本把页面撑得过长 */
  maxHeight?: number
}

/**
 * 自动撑高的多行文本框：随内容增高，到 maxHeight 后转为内部滚动。
 * 用于表单型 / 卡片型页签的字段输入，解决"长文本被写死行高截断、需手动滚滑条"的问题。
 */
export default function AutoTextarea({ value, onChange, placeholder, className = '', minHeight = 32, maxHeight = 360 }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.max(minHeight, Math.min(ta.scrollHeight, maxHeight)) + 'px'
  }, [value, minHeight, maxHeight])
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={1}
      style={{ minHeight }}
      className={`w-full text-[12px] leading-relaxed resize-none overflow-y-auto ${className}`}
    />
  )
}
