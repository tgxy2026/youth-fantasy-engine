/**
 * 「来源上下文」的 React 绑定（UX05）。纯逻辑在 `navigationHistory.ts`，这里只做订阅与重渲染。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createNavigationHistory, type HistoryEntry, type NavigationHistory } from './navigationHistory'
import type { WorkspaceTarget } from './navigation'

export interface NavigationHistoryBinding {
  history: NavigationHistory
  canGoBack: boolean
  top: HistoryEntry | null
  /** 记下离开前的原位（只由「关联跳转」调用；侧栏普通导航不记） */
  record: (from: WorkspaceTarget, label: string) => void
  /** 取走栈顶 —— 调用方先自己校验目标是否还可见，失败可用 `restore` 放回 */
  takeBack: () => HistoryEntry | null
  restore: (entry: HistoryEntry) => void
  clear: () => void
}

/**
 * `scopeKey` 一变（切项目 / 换存储上下文）整个来源栈就作废：
 * 跨项目、跨身份的返回没有意义，留着只会在别的书里跳来跳去。
 */
export function useNavigationHistory(scopeKey: string): NavigationHistoryBinding {
  // A new scope renders an empty store immediately; old callbacks can only touch the old instance.
  const owned = useMemo(() => ({ key: scopeKey, history: createNavigationHistory() }), [scopeKey])
  const history = owned.history
  const [version, setVersion] = useState(0)

  useEffect(() => history.subscribe(() => setVersion(v => v + 1)), [history])
  useEffect(() => () => history.clear(), [history])

  const record = useCallback((from: WorkspaceTarget, label: string) => { history.push(from, label) }, [history])
  const takeBack = useCallback(() => history.pop(), [history])
  const restore = useCallback((entry: HistoryEntry) => history.restore(entry), [history])
  const clear = useCallback(() => history.clear(), [history])

  void version // 订阅靠它触发重渲染
  return { history, canGoBack: history.size() > 0, top: history.top(), record, takeBack, restore, clear }
}
