/**
 * 剧情推演 · **本场记忆整理**（从 `TavernPlot.tsx` 拆出来的，2026-09-19 D4-3）。
 *
 * 【定位】剧情记忆是**会话级**的：记的是"这一场推演发生了什么"，随会话走，
 *   也随检查点 / 回滚 / 分支一起还原（见 store 的 rollbackToCheckpoint、branchSession）。
 *   与自由模式的**角色级**记忆（按角色存、跨会话共享）是两条线，别混。
 *
 * 🔴 只有两个手动入口，**没有自动整理**（2026-09-16 起「攒够条数自动整理」整层废除）：
 *   自由模式「结束本轮对话」、剧情模式就是这里的「整理本场记忆」。
 *   所以这里没有 `manual` 开关、也不看条数阈值 —— 作者点了就该跑。
 *
 * 🔴 两条不能丢：
 *   · 失败 / 被中止**都保留旧档案**，绝不写入半截结果（与自由模式同一原则）；
 *   · 记忆被判「整份退化」时照样如实说（档案已回退旧值，不能报「已更新」）。
 */
import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { showToast } from './dialogs'
import * as store from '../lib/tavern/store'
import { splitCast } from '../lib/tavern/engine'
import { getTavernSettings, type TavernSettings } from '../lib/tavern/settings'
import { summarizeMemory } from '../lib/tavern/summarize'
import {
  messagesAfterWatermark, nextWatermark, memoryToText, parseMemoryText,
  limitsOf, acquireSummaryLock, releaseSummaryLock,
} from '../lib/tavern/memory'
import type { TavernSession } from '../lib/tavern/types'

/**
 * 本场背景（喂给总结提示词）。
 * 不给的话模型只能凭对话臆断这是哪一场、在哪、要干什么 —— 与自由模式「不给角色背景就漂移」同理。
 */
function plotCharContext(s: TavernSession): string {
  return [
    s.title && `本场推演：${s.title}`,
    s.anchorChapterLabel && `叙事锚点：接在「第 ${s.anchorChapterLabel} 章」之后`,
    s.scene?.place && `地点：${s.scene.place}`,
    s.scene?.time && `时间：${s.scene.time}`,
    s.scene?.description && `开场情形：${s.scene.description}`,
  ].filter(Boolean).join('\n')
}

type PlotSummaryArgs = {
  /** 会话状态写回（整理成功后界面要跟着更新；切了会话则不动） */
  setSession: Dispatch<SetStateAction<TavernSession | null>>
}

export function usePlotSummary({ setSession }: PlotSummaryArgs) {
  const [summarizing, setSummarizing] = useState(false)
  /** 整理记忆的取消把手（2026-09-19 六维审计 P2-7：`signal` 早就下传了，只是从没接过） */
  const sumCtlRef = useRef<AbortController | null>(null)

  // ---------- 本场记忆整理 ----------
  /**
   * 整理「本场记忆」。
   *
   * 🔴 剧情记忆是**会话级**的：记的是"这一场推演发生了什么"，随会话走，
   *    也随检查点 / 回滚 / 分支一起还原（见 store 的 rollbackToCheckpoint、branchSession）。
   *    与自由模式的**角色级**记忆（按角色存、跨会话共享）是两条线，别混。
   *
   * 🔴 **只由作者手动触发**（2026-09-16 起；原先还有一条「攒够条数自动整理」，已整层废除）。
   *    所以这里没有 `manual` 开关、也不看条数阈值 —— 作者点了就该跑。
   *    参数沿用控制面板里那一组记忆参数，不另开设置项。
   */
  const runPlotSummary = useCallback(async (s: TavernSession) => {
    const pending = messagesAfterWatermark(s.messages, s.watermark)
    if (pending.length === 0) {
      showToast('还没有新内容可整理', 'info')
      return
    }
    let st: TavernSettings
    try {
      st = await getTavernSettings()
    } catch {
      showToast('读设置失败，无法整理记忆', 'error')
      return
    }
    if (!acquireSummaryLock(Date.now(), st.free.summaryLockTtlMin * 60_000)) {
      showToast('另一个窗口正在整理记忆', 'info')
      return
    }
    const ctl = new AbortController()
    sumCtlRef.current = ctl
    setSummarizing(true)
    try {
      // 记忆被判「整份退化」时照样如实说：档案已回退旧值，不能报「已更新」
      const degraded: string[] = []
      const aiNames = splitCast(s.cast).ai.map(c => c.name)
      const mem = await summarizeMemory({
        charId: s.id,
        charName: aiNames.length === 1 ? aiNames[0] : '本场角色',
        // 旧档案：session.memory 存的是六栏文本，先反解析回结构（解析不出就当没有旧档案）
        prev: s.memory ? parseMemoryText(s.memory, s.id, null) : null,
        messages: pending,
        charContext: plotCharContext(s),
        providerId: st.free.summaryProviderId || undefined,
        // hardLimit 一并传：否则剧情推演这边也永远走内置 3000（审计 P1-1）
        limits: limitsOf({ longTermLimit: st.free.longTermLimit, diaryDays: st.free.diaryDays, hardLimit: st.free.hardLimit }),
        onDegraded: (reason: string) => degraded.push(reason),
        signal: ctl.signal,
      })
      const wm = nextWatermark(s)
      const updated: TavernSession = {
        ...s,
        memory: memoryToText(mem),
        watermark: wm ?? s.watermark,
        updatedAt: Date.now(),
      }
      await store.saveSession(updated)
      setSession(cur => (cur && cur.id === updated.id ? updated : cur))
      showToast(
        degraded.length
          ? `本场记忆未更新：${degraded[0]}`
          : `本场记忆已更新（${(updated.memory ?? '').length} 字）`,
        degraded.length ? 'info' : 'success',
      )
    } catch (e) {
      // 总结失败 / 被中止**都保留旧档案**：绝不写入半截结果（与自由模式同一原则）
      const aborted = /取消|abort/i.test(e instanceof Error ? e.message : String(e))
      showToast(
        aborted ? '已中止整理 —— 本场记忆保持原样' : '整理本场记忆失败：' + (e instanceof Error ? e.message : String(e)),
        aborted ? 'info' : 'error',
      )
    } finally {
      sumCtlRef.current = null
      releaseSummaryLock()
      setSummarizing(false)
    }
  }, [setSession])

  /** 中止整理（旧档案保持原样，不写入半截结果） */
  const stopSummary = useCallback(() => { sumCtlRef.current?.abort() }, [])

  return { summarizing, runPlotSummary, stopSummary }
}
