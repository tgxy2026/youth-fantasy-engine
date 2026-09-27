
import React from 'react'
import { Button } from './Button'

/**
 * 生产级错误边界：渲染期任何组件抛错都会被这里兜住，
 * 显示可读错误堆栈而不是整页白屏。配色走主题令牌（ink 刻度随主题反转），深浅主题自适应。
 */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 同时打到控制台，方便开发者在 F12 里看到完整链路
    console.error('[YFE] 渲染期错误被边界捕获：', error, info)
  }

  handleReload = () => {
    this.setState({ error: null })
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const stack = String(error.stack || error.message || error)
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-ink-950 p-6">
        <div className="w-full max-w-2xl rounded-xl border border-danger/30 bg-ink-900 shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-danger/20 bg-danger/10">
            <span className="text-danger font-semibold text-sm">⚠ 页面渲染出错</span>
          </div>
          <div className="px-4 py-3">
            <p className="text-12 text-ink-300 leading-relaxed mb-3">
              某个组件在渲染时抛出了异常，已被安全捕获，未造成数据丢失。
              可点击下方按钮重新加载；若反复出现，请把下方错误堆栈截图反馈给开发者。
            </p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/40 border border-ink-700 p-3 text-11 leading-relaxed text-red-200 font-mono">
{stack}
            </pre>
            <div className="mt-4 flex gap-2">
              <Button onClick={this.handleReload} variant="primary" solid size="md" className="text-12">
                重新加载页面
              </Button>
              <Button variant="bare"
                onClick={() => this.setState({ error: null })}
                className="px-3 py-1.5 rounded-md border border-ink-700 text-ink-300 text-12 hover:text-ink-100 hover:border-ink-500 transition-colors"
              >
                尝试原地恢复
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
