/**
 * 数值输入框 —— **允许自由输入，超范围在提交时钳制到最近的边界**。
 *
 * 为什么不能像原来那样在 `onChange` 里直接 clamp：
 * - **打不出超范围的值**：上限 60 时想输入 100，第一位 `1` 就被改写、再拼成 `10` 又可能被裁，
 *   用户永远到不了自己想要的数（老大实测：`max=8` 的「卷数」连 `10` 都输不进去）；
 * - **清空不了**：`Number('') || 1` 会把空串立刻填回 1，退格重输变成打仗。
 *
 * 本组件的规矩：
 * - 输入中：只更新文本框；**若解析出的值本来就在范围内，立刻同步给父组件**
 *   （推荐值、耗时估算这类联动保持"边打边变"的手感）；
 * - 提交时机：失焦、回车。此时解析 → 钳到 `[min, max]` → 同步；非法文本回退旧值。
 *   ⚠️ 点按钮会先触发 blur，所以"改完直接点开始"也能带上新值，不会漏。
 * - `min` / `max` 都可以不给：不给就不钳制那一侧（如"每日目标字数"没有上限）。
 */
import { useEffect, useState } from 'react'

interface Props {
  /** 允许 `undefined`＝"留空"（如"上下文窗口：留空则按模型名自动识别"那类输入） */
  value: number | undefined
  onChange: (v: number | undefined) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  className?: string
  title?: string
  placeholder?: string
  /** 允许清空成"未填"。开启后空格提交会回调 `onChange(undefined)`；否则回退旧值 */
  allowEmpty?: boolean
  /** 提交时若发生了钳制，回调一次（界面可据此提示"已改为上限/下限"） */
  onClamped?: (v: number, dir: 'min' | 'max') => void
  /** 提交完成（失焦/回车）后回调一次 —— 需要"改写就持久化"的场景用它，别在 onChange 里存盘 */
  onCommit?: () => void
}

export default function NumberField({
  value, onChange, min, max, step, disabled, className, title, placeholder, allowEmpty, onClamped, onCommit,
}: Props) {
  const textOf = (v: number | undefined) => (v === undefined ? '' : String(v))
  const [text, setText] = useState(textOf(value))
  /** 编辑中：外部值变化（如「采用推荐值」按钮）不打断用户正在打的字 */
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!editing) setText(textOf(value))
  }, [value, editing])

  const clamp = (n: number): { v: number; dir: 'min' | 'max' | null } => {
    let v = Math.round(n)
    let dir: 'min' | 'max' | null = null
    if (min !== undefined && v < min) { v = min; dir = 'min' }
    if (max !== undefined && v > max) { v = max; dir = 'max' }
    return { v, dir }
  }

  const onInput = (raw: string) => {
    setText(raw)
    const n = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(n)) return // 中间态：不动父值
    const { v, dir } = clamp(n)
    // 只有本来就在范围内才即时同步；超范围的等提交时再钳（否则就是"边打边裁"的老毛病）
    if (!dir && v !== value) onChange(v)
  }

  const commit = () => {
    setEditing(false)
    const raw = text.trim()
    if (raw === '') {
      if (allowEmpty) { onChange(undefined); onCommit?.(); return }
      setText(textOf(value)); onCommit?.(); return
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) { setText(textOf(value)); onCommit?.(); return }
    const { v, dir } = clamp(n)
    setText(String(v))
    if (v !== value) onChange(v)
    if (dir) onClamped?.(v, dir)
    onCommit?.()
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      value={text}
      {...(min !== undefined ? { min } : {})}
      {...(max !== undefined ? { max } : {})}
      {...(step !== undefined ? { step } : {})}
      disabled={disabled}
      {...(title ? { title } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onChange={e => onInput(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
      className={className}
    />
  )
}
