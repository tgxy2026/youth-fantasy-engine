// ============ 应用内确认弹窗 + 轻提示条（v1.6） ============
// 替代浏览器原生 confirm() / alert() —— 三端（网页/便携/桌面）行为一致、样式跟随主题。
// Electron 桌面端：prompt 未实现（点了没反应）；confirm/alert 虽能用但是原生样式且阻塞交互。
// 约定：项目内禁止再使用 window.prompt / confirm / alert，统一走本模块。
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react'
import { Modal, Z } from './Modal'

// ============ 确认弹窗（Promise 化，await 即可） ============

export interface ConfirmOptions {
  title: string
  /** 支持 \n 换行（whitespace-pre-line） */
  message: string
  confirmText?: string
  cancelText?: string
  /** 破坏性操作：确认按钮用红色警示 */
  danger?: boolean
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    const close = (r: boolean) => {
      root.unmount()
      el.remove()
      resolve(r)
    }
    root.render(<ConfirmView {...opts} onResult={close} />)
  })
}

function ConfirmView({ title, message, confirmText = '确定', cancelText = '取消', danger = false, onResult }: ConfirmOptions & { onResult: (r: boolean) => void }) {
  const icon = danger ? (
    <span className="text-red-400">
      <AlertTriangle size={18} />
    </span>
  ) : (
    <span className="text-amber">
      <AlertCircle size={18} />
    </span>
  )
  return (
    <Modal
      open
      onClose={() => onResult(false)}
      title={title}
      icon={icon}
      width={420}
      layer={Z.prompt}
      footer={
        <>
          <button
            onClick={() => onResult(false)}
            className="px-3 py-1.5 rounded-lg text-[12px] text-ink-300 border border-ink-600 hover:border-ink-500 transition-colors"
          >
            {cancelText}
          </button>
          <button
            onClick={() => onResult(true)}
            className={`px-3 py-1.5 rounded-lg text-[12px] border transition-colors ${
              danger
                ? 'bg-red-500/15 text-red-300 border-red-500/40 hover:bg-red-500/25'
                : 'bg-amber/15 text-amber border-amber/30 hover:bg-amber/25'
            }`}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <div className="text-[12px] text-ink-400 leading-relaxed whitespace-pre-line">{message}</div>
    </Modal>
  )
}

// ============ 轻提示条（Toast，自动消失） ============

export type ToastType = 'success' | 'error' | 'info'

let toastRoot: HTMLDivElement | null = null
function ensureToastRoot() {
  if (!toastRoot) {
    toastRoot = document.createElement('div')
    toastRoot.className = 'fixed top-5 left-1/2 -translate-x-1/2 z-[10000] flex flex-col items-center gap-2 pointer-events-none'
    document.body.appendChild(toastRoot)
  }
  return toastRoot
}

export function showToast(message: string, type: ToastType = 'success', duration = 2800) {
  const el = document.createElement('div')
  ensureToastRoot().appendChild(el)
  const root = createRoot(el)
  const remove = () => {
    root.unmount()
    el.remove()
  }
  root.render(<ToastItem message={message} type={type} />)
  setTimeout(remove, duration)
}

function ToastItem({ message, type }: { message: string; type: ToastType }) {
  const icon: ReactNode =
    type === 'success' ? <CheckCircle2 size={14} /> : type === 'error' ? <AlertCircle size={14} /> : <Info size={14} />
  const cls =
    type === 'success'
      ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
      : type === 'error'
        ? 'text-red-300 border-red-500/30 bg-red-500/10'
        : 'text-sky-300 border-sky-500/30 bg-sky-500/10'
  return (
    <div className={`pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-lg border shadow-2xl text-[12px] ${cls} animate-[fadeInUp_0.2s_ease]`}>
      {icon}
      <span className="max-w-[70vw]">{message}</span>
    </div>
  )
}
