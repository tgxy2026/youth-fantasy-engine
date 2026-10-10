// 酒馆侧「模型就绪」Hook（2026-09-22 六维审计 F1）
//
// 🔴🔴 **不要用全局的 `useAIReady` 给酒馆的按钮加守卫。**
//
//   两者的判据根本不同：
//     · `useAIReady`         → 只看**全局活动模型**（`getActiveProvider`）；
//     · 酒馆真实调用链       → 「会话 model → 面板 `defaultProviderId` → 全局活动模型」
//                              （`resolveTavernProvider`，见 lib/tavern/provider.ts）。
//
//   作者完全可以把全局活动模型留空、只在酒馆控制面板里指定一个可用的模型。
//   那种配置下全局判据说「未就绪」，拿它去禁用发送键，就把一个**本来跑得好好的**
//   场景禁掉了 —— 比不加守卫更糟（用户会以为功能坏了）。
//   `tests/uiUxGuards.test.ts` 专门钉住了「这两处不许出现 useAIReady」，就是防这个。
//
// 本 hook 只是给那条**同源**的异步解析链套一个订阅壳：模型配置一改 / 换了面板默认模型 /
// 换了会话，就重新算一次。判据全在 `checkTavernReady` 里，界面层不重复实现。
import { useEffect, useState } from 'react'

import { checkTavernReady, type TavernReadyInfo } from '@/lib/tavern/provider'
import { subscribeAIReady } from '@/lib/ai'

const NOT_READY: TavernReadyInfo = { ready: false, label: '', fellBack: true }

/**
 * @param sessionProviderId 会话自己指定的模型 id（空 = 跟随面板默认 / 全局）
 * @param panelProviderId   控制面板的默认模型 id（空 = 跟随全局活动模型）
 *
 * 依赖变化即重算；异步竞态用 `cancelled` 标记丢弃过期结果（与项目其余 hook 同范式）。
 */
export function useTavernReady(
  sessionProviderId?: string,
  panelProviderId?: string,
): TavernReadyInfo {
  const [info, setInfo] = useState<TavernReadyInfo>(NOT_READY)

  useEffect(() => {
    let cancelled = false
    const ref = sessionProviderId ? { providerId: sessionProviderId } : undefined

    const run = () => {
      void checkTavernReady(ref).then(next => {
        if (!cancelled) setInfo(next)
      })
    }

    run()
    // 全局模型配置变更（新增 / 编辑 / 删除 / 切换活动模型）也要重算：
    // 上面那三层兜底链的最后一层正是全局活动模型。
    const unsub = subscribeAIReady(run)
    return () => { cancelled = true; unsub() }
  }, [sessionProviderId, panelProviderId])

  return info
}
