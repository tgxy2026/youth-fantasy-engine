// ============ 「已定位，可返回校对结果」提示条（3.3.1 · P7） ============
//
// 为什么必须有这条：
//   工具校对弹窗盖着正文，点「定位原文」只能先收起弹窗（否则滚动与选中都作用在被遮住的元素上）。
//   收起之后如果没留一个明确的返回入口，作者就回不到结果列表了 —— 规划 §7.3 第 4 条要求
//   「保留会话内结果、当前条目、已处理状态及列表位置」。这条提示条就是那个入口。
//
// 只读：不写正文、不触发保存；关掉提示条只是收起提示，不影响刚选中的正文位置。
import { CornerDownRight, X } from 'lucide-react'
import { Button } from '@/components/common/Button'

export function ProofLocateReturnBar({ index, total, quote, onReturn, onDismiss }: {
  /** 第几条（1 起） */
  index: number
  total: number
  /** 定位到的那句原文，回显出来让作者确认跳的是哪一条 */
  quote: string
  onReturn: () => void
  onDismiss: () => void
}) {
  return (
    <div
      data-proof-locate-bar=""
      role="status"
      className="shrink-0 flex items-center gap-2 px-5 py-1.5 border-b border-amber/25 bg-amber/10 text-11 text-ink-100"
    >
      <CornerDownRight size={12} className="text-amber shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        已定位到第 {index} / {total} 条校对结果「{quote}」—— 可直接修改正文
      </span>
      <Button variant="bare" onClick={onReturn}
        className="shrink-0 px-2 py-1 bg-amber/15 text-amber border border-amber/30 rounded text-11 hover:bg-amber/25 transition-colors"
        title="回到校对结果列表，定位在原地（不会重新调用模型）">
        返回校对结果
      </Button>
      <Button variant="icon-muted" onClick={onDismiss} className="p-1 shrink-0" title="关闭提示" aria-label="关闭定位提示">
        <X size={13} />
      </Button>
    </div>
  )
}
