
import { useEffect, useRef, useState } from 'react'
import { Modal, Z } from './Modal'
import { Button } from './Button'

interface Props {
  open: boolean
  title: string
  label?: string
  defaultValue?: string
  placeholder?: string
  /** 密码模式：输入框 type=password（备份迁移包密码等场景） */
  password?: boolean
  /** 输入即转大写展示（邀请码 / 同步码场景，让用户当场看到规范大写） */
  transformUppercase?: boolean
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
  transformUppercase = false,
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
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={380}
      layer={Z.prompt}
      footer={
        <>
          <Button onClick={onCancel} variant="secondary" size="md" className="text-12">
            {cancelText}
          </Button>
          <Button onClick={submit}
            disabled={!allowEmpty && !val.trim()} variant="primary" size="md" className="text-12">
            {confirmText}
          </Button>
        </>
      }
    >
      {label && <div className="text-11 text-ink-400 leading-relaxed mb-1.5">{label}</div>}
      <input
        ref={inputRef}
        autoFocus
        type={password ? 'password' : 'text'}
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder={placeholder}
        style={transformUppercase ? { textTransform: 'uppercase' } : undefined}
        className="w-full bg-ink-900 border border-ink-600 rounded-lg px-3 py-2 text-13 text-ink-100 outline-none focus:border-amber/60 placeholder:text-ink-500 mb-4"
      />
    </Modal>
  )
}
