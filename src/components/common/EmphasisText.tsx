/**
 * 纯文本里的 `**强调**` 渲染成加粗（其余照原样，含换行）。
 *
 * 用法：放在原本直接渲染字符串的纯文本容器里（`whitespace-pre-wrap` / `whitespace-pre-line`）。
 * 只服务**帮助文案**这类「我们自己写的说明书」；作者正文、AI 产出、通用对话框不走这里
 * （它们的格式语义不同，见 `lib/text/emphasis.ts` 的判据说明）。
 */
import { Fragment } from 'react'
import { splitEmphasis } from '@/lib/text/emphasis'

export default function EmphasisText({ text }: { text: string }) {
  const parts = splitEmphasis(text)
  if (parts.length === 1 && !parts[0].strong) return <>{text}</>
  return <>{parts.map((part, index) => part.strong
    ? <strong key={index} className="font-semibold">{part.text}</strong>
    : <Fragment key={index}>{part.text}</Fragment>)}</>
}
