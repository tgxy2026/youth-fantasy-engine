/**
 * 酒馆模式 · 快捷指令条
 *
 * 把最常用的几种「推一下」做成按钮，省得每次手打一遍。
 *
 * 【为什么不用改引擎】
 * 协议 R4 定义了**导演指令**通道：用「」括起来的句子 = 照做，然后继续演。
 * 所以「补一段环境」「推进时间」这类动作用户本来就能手打；这里只是把它做成按钮。
 * 走这条通道的好处是它**不污染"角色说过的话"**这层语义（不会被当成用户/角色的台词记进记忆）。
 */
import { Button } from './Button'

export type QuickAction = {
  key: string
  label: string
  /** 悬停说明：写清它会做什么，别让作者猜 */
  hint: string
  run: () => void
}

export function TavernQuickBar({ actions, disabled, className = '' }: {
  actions: QuickAction[]
  disabled?: boolean
  className?: string
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {actions.map(a => (
        <Button
          key={a.key}
          variant="ghost"
          size="sm"
          className="!px-2 !text-[11px]"
          disabled={disabled}
          title={a.hint}
          onClick={a.run}
        >
          {a.label}
        </Button>
      ))}
    </div>
  )
}

export default TavernQuickBar
