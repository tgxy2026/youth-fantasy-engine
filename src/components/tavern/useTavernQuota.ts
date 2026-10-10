// 酒馆侧「注入额度」Hook（2026-10-05 · 世界书额度体系）
//
// 把「当前生效模型的窗口 → 固定层 / 动态层额度」收成一处，供三个消费方用：
//   · `TavernWorld.tsx` / `TavernScript.tsx` —— 界面显示「上限多少、超没超、超了怎么办」
//   · `TavernUsageDialog.tsx` —— 用量明细里标注被取舍掉的条目
//
// 🔴 **判据唯一**：窗口来自 `useTavernReady()`（内部走 `checkTavernReady` → `resolveTavernProvider`），
//    与引擎 `runPlotTurn` / `runFreeTurn` 用的是同一条解析链；额度计算全在 `lib/tavern/quotas.ts`，
//    本 hook 只把两者接起来。界面**不许**自己再写一份 8% / 15% 的算术。
//
// ⚠️ 窗口没填（老库里的模型配置）时 `quotas` 会兜底到 32K 档，`windowFallback` 为 true ——
//    界面据此提示「模型没填窗口，额度按 32K 估」。这不是错，是保守。
import { useEffect, useMemo, useState } from 'react'

import { useTavernReady } from '@/components/tavern/useTavernReady'
import { quotaProfileOf, type QuotaProfile } from '@/lib/tavern/quotas'
import { getTavernSettings } from '@/lib/tavern/settings'

export interface TavernQuota extends QuotaProfile {
  /** 当前模型是否就绪（没就绪时额度仍是兜底值，界面该提示「先配模型」） */
  ready: boolean
  /** 当前模型的简短标识（用于「按 <模型> 的窗口算」这行说明） */
  modelLabel: string
}

/**
 * @param sessionProviderId 会话自己指定的模型 id（空 = 跟随面板默认 / 全局）
 * @param panelProviderId   控制面板的默认模型 id（空 = 跟随全局活动模型）
 * @param dynamicPct        控制面板里的动态层百分比（5~35）；**不传 = 自动读当前酒馆设置**
 *                         —— 调用方不必记得传，避免「界面按 15% 显示、引擎按作者设的 30% 注入」
 */
export function useTavernQuota(
  sessionProviderId?: string,
  panelProviderId?: string,
  dynamicPct?: number,
): TavernQuota {
  const info = useTavernReady(sessionProviderId, panelProviderId)

  // 🔴 百分比自己读，不靠调用方传：三个消费方都只关心「窗口 → 额度」，
  //    若让它们各记得传一次，早晚会漏 —— 漏了就是「界面按 15% 显示并卡保存，引擎却按作者设的 30% 注入」。
  //    显式传参仍优先（给「按某个特定比例算」的场景）。切页签会卸载组件 ⇒ 重进必读最新值。
  const [pct, setPct] = useState<number | undefined>(dynamicPct)

  useEffect(() => {
    if (dynamicPct !== undefined) { setPct(dynamicPct); return }
    let cancelled = false
    void getTavernSettings()
      .then(st => { if (!cancelled) setPct(st.dynamicQuotaPct) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [dynamicPct])

  return useMemo(() => {
    const p = quotaProfileOf(info.windowTokens, pct)
    return { ...p, ready: info.ready, modelLabel: info.label }
  }, [info.windowTokens, info.ready, info.label, pct])
}
