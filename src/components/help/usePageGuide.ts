// ============ 页签引导的触发控制（3.3.1 · P2） ============
//
// 规划 §3.5 的状态机：待页面就绪 → 可启动 → 讲解中 → 完成 / 跳过 / 中断。
//   · 「页面就绪」由页面**显式**告诉本 hook（`ready`），不靠固定延时猜；
//   · 已完成 / 已跳过 ⇒ 不再自动弹；主动「本页指引」随时可看；
//   · 因切页 / 弹窗 / 目标失效中断 ⇒ **不写完成记录**，且本次停留不再自动重启
//     （否则会变成「关一次弹一次」的骚扰）。
//
// 🔴 不抢焦点：用户已经在输入 / 有未保存编辑时（`busy`）不自动弹出。
// 🔴 绑定运行标识：`tabId` 变了就当作新页面，中断记忆清空、状态归位。
import { useCallback, useEffect, useRef, useState } from 'react'
import { getPageGuide, guideRecordKey, type PageGuide } from '@/lib/help/guides'
import {
  hasGuideRecord, isGuideAutoEnabled, markGuideDone, markGuideSkipped, setGuideAutoEnabled,
} from '@/lib/settings/guidePrefs'
import type { GuideCloseReason } from '@/components/help/GuideOverlay'

/** 关闭原因只有三种：完成 / 跳过 / 中断 —— 定义在聚焦层，这里复用同一份，避免两处漂移 */
export type { GuideCloseReason }

interface Options {
  /** 当前页签稳定 id */
  tabId: string
  /** 页面数据真的就绪（不是固定延时） */
  ready: boolean
  /** 作者正在输入 / 有未保存改动 ⇒ 不自动弹（显示「本页指引」仍可点） */
  busy?: boolean
}

interface PageGuideState {
  guide: PageGuide | null
  running: boolean
  /** 从第几步开始（每次都从 0 开始；重看与新看一致） */
  startStep: number
  start: () => void
  close: (reason: GuideCloseReason) => void
  disableAuto: () => void
}

export function usePageGuide({ tabId, ready, busy = false }: Options): PageGuideState {
  const guide = getPageGuide(tabId)
  const [running, setRunning] = useState(false)
  /** 本次停留里被中断过的引导：不再自动重启，但作者点「本页指引」仍能看 */
  const interrupted = useRef<Set<string>>(new Set())

  // 换页签 = 换上下文：中断记忆与运行状态一起清掉
  useEffect(() => {
    interrupted.current.clear()
    setRunning(false)
  }, [tabId])

  const key = guide ? guideRecordKey(guide) : ''

  useEffect(() => {
    if (!guide || !key) return
    if (!ready || busy || running) return
    if (!isGuideAutoEnabled()) return
    if (hasGuideRecord(key)) return
    if (interrupted.current.has(key)) return
    // 等一帧再起：让页面先画出真实布局，避免卡片定位在骨架屏上
    const timer = window.setTimeout(() => setRunning(true), 120)
    return () => window.clearTimeout(timer)
  }, [guide, key, ready, busy, running])

  const start = useCallback(() => {
    if (!guide) return
    interrupted.current.delete(guideRecordKey(guide))
    setRunning(true)
  }, [guide])

  const close = useCallback((reason: GuideCloseReason) => {
    if (guide) {
      const record = guideRecordKey(guide)
      if (reason === 'done') markGuideDone(record)
      else if (reason === 'skip') markGuideSkipped(record)
      // 中断：只记在本次停留内，不写持久记录 —— 下次进来还能重看
      else interrupted.current.add(record)
    }
    setRunning(false)
  }, [guide])

  const disableAuto = useCallback(() => {
    setGuideAutoEnabled(false)
    // 关掉自动以后，本次这条也按「跳过」记下来；设置里可恢复自动与重置记录
    if (guide) markGuideSkipped(guideRecordKey(guide))
    setRunning(false)
  }, [guide])

  return { guide, running: running && !!guide, startStep: 0, start, close, disableAuto }
}
