/**
 * 酒馆模式 · 快捷指令条
 *
 * 把最常用的几种「推一下」做成按钮，省得每次手打一遍。
 *
 * 【为什么不用改引擎】
 * 协议 R4 定义了**导演指令**通道：用「」括起来的句子 = 照做，然后继续演。
 * 所以「补一段环境」「推进时间」这类动作用户本来就能手打；这里只是把它做成按钮。
 * 走这条通道的好处是它**不污染"角色说过的话"**这层语义（不会被当成用户/角色的台词记进记忆）。
 *
 * 🔴 点击**只把预制文本填进输入框，不直接发送**（2026-09-15 改）：
 *    这些指令几乎都需要作者改一处（推进多久、补哪个方向），直接发出去等于替作者作了决定。
 *    带 slot 的按钮会把那一段**选中**，作者直接改就行。
 */
import { Button } from '@/components/common/Button'

export type QuickAction = {
  key: string
  label: string
  /** 悬停说明：写清它会做什么，别让作者猜 */
  hint: string
  /** 点击后**填进输入框**的预制文本（不直接发送，作者可先改）。给了它就忽略 run。 */
  text?: string
  /** text 里要**选中**的那一段（如「半小时」）—— 填完直接改这一处即可 */
  slot?: string
  /** 没有 text 时的直接动作；可返回 Promise（如「润色/自动回复」：点下去要异步生成再回写输入框） */
  run?: () => void | Promise<void>
  /** 单独的禁用条件（如「用户没扮演角色 / 首轮禁用的润色·自动回复」）；与外层 disabled 取或 */
  disabled?: boolean
}

export function TavernQuickBar({ actions, disabled, onFill, className = '' }: {
  actions: QuickAction[]
  disabled?: boolean
  /** 点击带 text 的按钮时回调（把预制文本填进输入框） */
  onFill?: (text: string, slot?: string) => void
  className?: string
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`}>
      {actions.map(a => (
        <Button
          key={a.key}
          variant="secondary"
          size="xs"
          disabled={disabled || a.disabled}
          title={a.hint}
          onClick={() => { if (a.text !== undefined) onFill?.(a.text, a.slot); else void a.run?.() }}
        >
          {a.label}
        </Button>
      ))}
    </div>
  )
}

export default TavernQuickBar
