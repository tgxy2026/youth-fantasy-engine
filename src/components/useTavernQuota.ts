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
import { useMemo } from 'react'

import { useTavernReady } from './useTavernReady'
import { quotaProfileOf, type QuotaProfile } from '../lib/tavern/quotas'

export interface TavernQuota extends QuotaProfile {
  /** 当前模型是否就绪（没就绪时额度仍是兜底值，界面该提示「先配模型」） */
  ready: boolean
  /** 当前模型的简短标识（用于「按 <模型> 的窗口算」这行说明） */
  modelLabel: string
}

/**
 * @param sessionProviderId 会话自己指定的模型 id（空 = 跟随面板默认 / 全局）
 * @param panelProviderId   控制面板的默认模型 id（空 = 跟随全局活动模型）
 * @param dynamicPct        控制面板里的动态层百分比（5~35）；不传用默认 15
 */
export function useTavernQuota(
  sessionProviderId?: string,
  panelProviderId?: string,
  dynamicPct?: number,
): TavernQuota {
  const info = useTavernReady(sessionProviderId, panelProviderId)
  return useMemo(() => {
    const p = quotaProfileOf(info.windowTokens, dynamicPct)
    return { ...p, ready: info.ready, modelLabel: info.label }
  }, [info.windowTokens, info.ready, info.label, dynamicPct])
}

/**
 * 不带订阅的同步版本 —— 给**非组件**（如对话框内部已有 ready 信息）用。
 * 组件里请用 `useTavernQuota`，别自己调这个再手写 useEffect。
 */
export function quotaFromWindow(windowTokens: number | null | undefined, dynamicPct?: number): QuotaProfile {
  return quotaProfileOf(windowTokens, dynamicPct)
}
