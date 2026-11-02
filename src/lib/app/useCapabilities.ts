// ============ C4 · 能力契约的界面消费层（3.3.4 · P1 骨架）============
//
// 规划 §6 要求「界面控制与手册提示共用同一份解析结果」：入口、设置、手册都从这里取，
// 而不是各自 `import { WEB }` 再各写一遍平台判断。
//
// 🔴 本模块只做两件事：① 读一次信号 → 解析；② 在**会改变结论的运行时事件**上重读。
//    · 解析仍是 `capabilities.ts` 的纯函数（不碰 window、可伪造输入单测）；
//    · 信号仍是 `capabilitySignals.ts` 的唯一取值层（不新增第二张平台判断表）。
//
// 🔴 为什么要订阅而不是只在挂载时算一次：登录 / 退出、断网 / 回网、全屏进出、老板键
//    重新申请，都会让某项能力从 supported 变成 conditional 或反过来。只算一次的话，
//    设置页会一直显示上一次的结论 —— 这正是规划 §6「消费者保持一致」要消灭的状态漂移。
import { useCallback, useEffect, useState } from 'react'
import { resolveCapabilities, type CapabilityMap, type CapabilitySignals } from '@/lib/app/capabilities'
import { readCapabilitySignals } from '@/lib/app/capabilitySignals'
import { BOSS_PREF_CHANGED_EVENT } from '@/lib/app/bossKey'

export interface CapabilitySnapshot {
  signals: CapabilitySignals
  caps: CapabilityMap
}

/** 改变能力结论的运行时事件（不是"所有事件都重算"，避免无谓重渲染） */
const RUNTIME_EVENTS = [
  'online', 'offline',          // 联网状态 → 保存落盘 / 冷启动
  'focus', 'pageshow',          // 从后台回来、从 bfcache 恢复 → 账号与视口可能都变了
  'visibilitychange',
  'fullscreenchange', 'fullscreenerror', // 外部退出全屏（Esc / 系统）
] as const

/** 无 window 环境下也能调用（`readCapabilitySignals` 自己兜底），便于测试直接读快照 */
export function readCapabilitySnapshot(): CapabilitySnapshot {
  const signals = readCapabilitySignals()
  return { signals, caps: resolveCapabilities(signals) }
}

/**
 * 订阅式快照。`overrides` 仅供已知更多信息的调用点补充（例：同步面板知道自己选的是
 * 云盘目录还是 WebDAV）。传对象时请保持引用稳定，否则会每次渲染都重算。
 */
export function useCapabilities(overrides: Partial<CapabilitySignals> = {}): CapabilitySnapshot & { refresh: () => void } {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot>(() => readCapabilitySnapshot())
  // 用值而不是对象做依赖：调用方写内联字面量也不会触发无限重算
  const overrideKey = JSON.stringify(overrides)

  const refresh = useCallback(() => {
    const signals = readCapabilitySignals(JSON.parse(overrideKey) as Partial<CapabilitySignals>)
    setSnapshot({ signals, caps: resolveCapabilities(signals) })
  }, [overrideKey])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (typeof window === 'undefined') return
    for (const event of RUNTIME_EVENTS) window.addEventListener(event, refresh)
    window.addEventListener(BOSS_PREF_CHANGED_EVENT, refresh)
    return () => {
      for (const event of RUNTIME_EVENTS) window.removeEventListener(event, refresh)
      window.removeEventListener(BOSS_PREF_CHANGED_EVENT, refresh)
    }
  }, [refresh])

  return { ...snapshot, refresh }
}