// ============ App 层引导托管（3.3.1 · P3） ============
//
// 为什么放在 App 层：55 个页签里只有 3 个由页面组件自己托管（它们知道数据何时真正就绪），
// 其余页签如果逐页加 hook + 按钮 + 卡片，就是几十处重复代码。这里统一托管，
// 页面只需要在自己的关键区块上标 `data-guide`，没有锚点也会降级成一条居中说明。
//
// 🔴 就绪判定：这里只能判「页面已经挂载并完成首帧布局」（连续两帧），拿不到每页的数据加载状态。
//    所以这是**挂载级就绪**，不是数据级就绪 —— 真需要「数据加载完再讲」的页签仍应回到组件内托管
//    （见 `SELF_MANAGED_GUIDE_TABS`）。这一条必须写进进度文档，不能当成数据就绪。
import { useEffect, useState } from 'react'
import { usePageGuide } from '@/components/help/usePageGuide'
import { guideHostedAtAppLevel } from '@/lib/help/guides'

/** 页签 / 项目变化后连续两帧视为「页面挂上来了」 */
export function usePageMounted(key: string): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(false)
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setMounted(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [key])
  return mounted
}

/** App 层的引导托管：只有「在项目内」且「该页签不由页面自己托管」时才启用 */
export function useAppLevelGuide(activeTab: string, inProject: boolean) {
  const mounted = usePageMounted(`${activeTab}`)
  return usePageGuide({
    tabId: activeTab,
    ready: mounted,
    enabled: inProject && guideHostedAtAppLevel(activeTab),
  })
}
