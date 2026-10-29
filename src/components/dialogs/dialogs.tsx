// ============ 应用内确认弹窗 + 轻提示条（v1.6） ============
// 替代浏览器原生 confirm() / alert() —— 三端（网页/便携/桌面）行为一致、样式跟随主题。
// Electron 桌面端：prompt 未实现（点了没反应）；confirm/alert 虽能用但是原生样式且阻塞交互。
// 约定：项目内禁止再使用 window.prompt / confirm / alert，统一走本模块。
import { foldVh } from '@/lib/settings/theme'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Info, AlertTriangle } from 'lucide-react'
import { Modal, Z } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import { getActiveOverlayScope } from '@/lib/app/overlayScope'

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
    <span className="text-danger">
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
          {/* 🔴 弹窗内的按钮统一走 md（h-9），别再手写 px-3 py-1.5 ——
              手写字面量会让这一对按钮约 30px 高，比面板主操作（sm=32px）矮、
              又比 PromptModal 的按钮（md=36px）矮，三种高度并存（2026-09-19 修）。
              口径：弹窗内 = md ／ 面板主操作 = sm ／ 面板工具 = xs。 */}
          <Button variant="secondary" size="md"
            onClick={() => onResult(false)}
          >
            {cancelText}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} size="md"
            onClick={() => onResult(true)}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="text-12 text-ink-400 leading-relaxed whitespace-pre-line">{message}</div>
    </Modal>
  )
}

// ============ 轻提示条（Toast，自动消失） ============

export type ToastType = 'success' | 'error' | 'info'

let toastRoot: HTMLDivElement | null = null
function ensureToastRoot() {
  if (!toastRoot) {
    toastRoot = document.createElement('div')
    // 只设 class，层级由 style.zIndex 从 zLayer 真源取（Tailwind 的任意值 class 无法引用常量）
    toastRoot.className = 'fixed top-5 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none'
    toastRoot.style.zIndex = String(Z.toast)
    // 结构锚点：通知也是界面，探针/读屏都要能定位它（文案会变，锚点不变）
    toastRoot.dataset.toast = ''
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

/**
 * 复制文本并提示（2026-09-14 从 AboutPage 上移，做**唯一一份**）。
 *
 * 剪贴板 API 在非安全上下文（http 局域网直连、file:// 的某些情况）下不可用，
 * 故保留 execCommand 兜底；两者都失败时提示用户手动复制 —— **绝不静默失败**
 * （点了没反应，用户只会以为功能坏了）。
 *
 * ⚠️ 别再在组件里各写一份：本项目已多次踩「同一套交互写两遍、改一处忘一处」。
 *
 * @param options.silent 不弹 toast，由调用方自己给行内反馈（例如按钮变「已复制」）。
 *   即便静默，失败也一定要让调用方拿到 `false` —— 静默的是提示，不是失败。
 * @returns 是否真的写进了剪贴板
 */
export async function copyText(text: string, okMsg: string, options: { silent?: boolean } = {}): Promise<boolean> {
  const notify = (message: string, type: ToastType = 'success') => { if (!options.silent) showToast(message, type) }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      notify(okMsg)
      return true
    } catch {
      // 浏览器暴露了 API 仍可能拒绝写入；尝试一次旧接口，失败仍由调用方处理。
    }
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const ta = document.createElement('textarea')
  try {
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    // 处于模态层时，body 的其他子节点可能被 inert 隔离；临时输入框必须属于当前弹窗。
    ;(getActiveOverlayScope()?.panel.current ?? document.body).appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    notify(ok ? okMsg : '复制失败，请手动选中复制', ok ? 'success' : 'error')
    return ok
  } catch {
    notify('复制失败，请手动选中复制', 'error')
    return false
  } finally {
    ta.remove()
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  }
}

function ToastItem({ message, type }: { message: string; type: ToastType }) {
  const icon: ReactNode =
    type === 'success' ? <CheckCircle2 size={14} /> : type === 'error' ? <AlertCircle size={14} /> : <Info size={14} />
  const cls =
    type === 'success'
      ? 'text-success border-success/30 bg-success/10'
      : type === 'error'
        ? 'text-danger border-danger/30 bg-danger/10'
        : 'text-info border-info/30 bg-info/10'
  return (
    <div className={`pointer-events-auto flex items-center gap-2 px-4 py-2 rounded-lg border shadow-2xl text-12 ${cls} animate-[fadeInUp_0.2s_ease]`}>
      {icon}
      <span style={{ maxWidth: foldVh('70vw') }}>{message}</span>
    </div>
  )
}
