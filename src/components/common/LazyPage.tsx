/**
 * 懒加载页面的**可重试外壳**（UX13）。
 *
 * 【它解决什么】
 *   页面按需分包加载。旧的 `lazy(() => import(...))` 一旦失败，React 会把那次 rejected
 *   结果**永久缓存**在组件类型上 —— 之后无论如何重挂载，同一个实例都只会立刻重抛，
 *   于是「重试当前页面」对模块加载失败是一句假话（只能整页刷新）。
 *
 * 【做法】
 *   失败后**换一个新的 lazy 实例**再挂一次（`useState` 里带着实例一起换代），
 *   这样重试是真的重新发一次 `import()`。外壳自带的边界只接「模块没拿到」这一类，
 *   其它渲染错误原样抛回上层的页面边界 —— 保持既有「页面渲染出错」入口不变。
 *
 * 【红线】
 *   ① 不承诺保存结果：这里只说「页面没能加载」，绝不提数据是否安全（页面压根没挂载过）；
 *   ② 不抢焦点：标题 focus 由 FailureNotice 负责，和既有故障页一致；
 *   ③ 不动布局契约：外壳仍是 `w-full`，交给既有 `main > .workspace-content` 排版。
 */
import { Component, Suspense, lazy, useState, type ComponentType, type ErrorInfo, type FunctionComponent, type ReactNode } from 'react'
import FailureNotice from '@/components/common/FailureNotice'
import { Button } from '@/components/common/Button'
import { foldVh } from '@/lib/settings/theme'
import { recordError } from '@/lib/app/errorLog'
import { isModuleLoadFailure, moduleLoadFailure } from '@/lib/app/moduleLoad'

type Loader<P> = () => Promise<{ default: ComponentType<P> }>

/** 新开一个 lazy 实例；失败立刻打上标记，让边界能认出「这是模块没拿到」而不是页面自己炸了 */
function create<P extends object>(loader: Loader<P>): FunctionComponent<P> {
  // 断言只是为了让泛型属性可以原样透传（JSX 展开泛型形参时 TS 认不出 `PropsWithRef` 的包装）
  return lazy(() => loader().catch(cause => { throw moduleLoadFailure(cause) })) as unknown as FunctionComponent<P>
}

/** 只接模块加载失败的边界；其它错误原样上抛给页面级边界 */
class ModuleBoundary extends Component<{ name: string; onRetry: () => void; children: ReactNode }, { failed: boolean; error: unknown }> {
  state: { failed: boolean; error: unknown } = { failed: false, error: undefined }
  static getDerivedStateFromError(error: unknown) { return { failed: true, error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[YFE] 「${this.props.name}」页面模块加载失败：`, error, info)
    recordError('render', error)
  }
  private retry = () => this.props.onRetry()
  render() {
    if (!this.state.failed) return this.props.children
    const { error } = this.state
    // 🔴 页面自身的渲染错误交给上层（日志已记），这条边界只负责「代码文件没拿到」
    if (!isModuleLoadFailure(error)) throw error
    return <div data-module-failure="" className="w-full">
      <FailureNotice embedded title={`「${this.props.name}」没能加载出来`} error={error}
        description="这个页面的代码文件没有取到。常见原因是网络中断，或刚更新过版本、旧文件已被替换；工作台其它页面不受影响。"
        actions={<>
          <Button variant="primary" onClick={this.retry}>重新加载这个页面</Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>重新加载工作台</Button>
        </>}>
        重新加载会再请求一次该页面的代码文件，其它页面的状态不受影响；若刚更新过版本仍失败，请用「重新加载工作台」。
      </FailureNotice>
    </div>
  }
}

/**
 * 生成一个可重试的懒加载页面组件。用法与 `lazy()` 一致，但多一个给人看的中文页面名：
 *
 * ```ts
 * const CheckTools = lazyPage(() => import('@/components/audit/CheckTools'), '检查工具')
 * ```
 */
export function lazyPage<P extends object>(loader: Loader<P>, name: string): ComponentType<P> {
  function LazyPage(props: P) {
    // 🔴 实例必须跟着代号一起换代：同一个 lazy 实例已把失败缓存住了，重挂载也只会重抛
    const [slot, setSlot] = useState(() => ({ attempt: 0, Page: create(loader) }))
    const Page = slot.Page
    return <ModuleBoundary key={slot.attempt} name={name}
      onRetry={() => setSlot(current => ({ attempt: current.attempt + 1, Page: create(loader) }))}>
      <Suspense fallback={<div role="status" className="w-full flex items-center justify-center text-ink-500 text-sm" style={{ minHeight: foldVh('50vh') }}>加载中…</div>}>
        <Page {...props} />
      </Suspense>
    </ModuleBoundary>
  }
  return LazyPage
}
