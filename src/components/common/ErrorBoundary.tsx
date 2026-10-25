import React from 'react'
import { Button } from '@/components/common/Button'
import FailureNotice from '@/components/common/FailureNotice'
import { recordError } from '@/lib/app/errorLog'

/** Root render failures stay visible without making claims about an unconfirmed save. */
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: unknown }
> {
  state: { hasError: boolean; error: unknown } = { hasError: false, error: undefined }
  static getDerivedStateFromError(error: unknown) { return { hasError: true, error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[YFE] 渲染期错误被边界捕获：', error, info)
    recordError('render', error)
  }
  render() {
    const { error, hasError } = this.state
    if (!hasError) return this.props.children
    return <FailureNotice title="页面渲染出错" error={error}
      description="页面出现异常。已保存内容以实际存储结果为准，未提交的修改可能需要恢复。"
      actions={<>
        <Button variant="primary" solid size="md" onClick={() => this.setState({ hasError: false, error: undefined })}>重试当前页面</Button>
        <Button variant="secondary" size="md" onClick={() => window.location.reload()}>重新加载工作台</Button>
      </>}>
      重试会重新挂载页面，重新加载会重启整个工作台；两种操作都不能保证保留内存中的未提交修改。反复出现时，可先保留技术摘要再反馈。
    </FailureNotice>
  }
}
