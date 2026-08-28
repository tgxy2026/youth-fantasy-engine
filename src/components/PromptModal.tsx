import { useEffect, useRef, useState } from 'react'

interface Props {
  open: boolean
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  /** 密码模式：输入框 type=password（备份迁移包密码等场景） */
  password?: boolean
  /** 允许空值提交（如"留空 = 不加密"的场景），默认 false */
  allowEmpty?: boolean
  confirmText?: string
  cancelText?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}

/**
 * 应用内单行输入弹窗（v1.6）
 * 替代浏览器原生 window.prompt —— Electron 桌面端不实现 prompt（点击毫无反应），
 * 便携版/网页版则与整体主题脱节。统一改用本组件，三端行为一致。
 * 默认空值不可提交（回车/按钮均无效）；Esc 或点遮罩取消。
 */
export default function PromptModal({
  open, title, label, defaultValue = '', placeholder, password = false, allowEmpty = false,
  confirmText = '确定', cancelText = '取消', onSubmit, onCancel,
}: Props) {
  const [val, setVal] = useState(defaultValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setVal(defaultValue)
      // 弹起后聚焦并全选，便于直接输入覆盖
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [open, defaultValue])

  if (!open) return null

  const submit = () => {
    if (allowEmpty) onSubmit(val)
    else {
      const v = val.trim()
      if (!v) return
      onSubmit(v)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 backdrop-blur-[2px]"
      onMouseDown={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        className="w-[380px] max-w-[90vw] bg-ink-850 border border-ink-600 rounded-2xl shadow-2xl p-5"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="text-[14px] font-semibold text-ink-100 mb-3">{title}</div>
        {label && <div className="text-[11px] text-ink-400 leading-relaxed mb-1.5">{label}</div>}
        <input
          ref={inputRef}
          autoFocus
          type={password ? 'password' : 'text'}
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
          placeholder={placeholder}
          className="w-full bg-ink-900 border border-ink-600 rounded-lg px-3 py-2 text-[13px] text-ink-100 outline-none focus:border-amber/60 placeholder:text-ink-500 mb-4"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-[12px] text-ink-300 border border-ink-600 hover:border-ink-500 transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={submit}
            disabled={!allowEmpty && !val.trim()}
            className="px-3 py-1.5 rounded-lg text-[12px] bg-amber/15 text-amber border border-amber/30 hover:bg-amber/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
