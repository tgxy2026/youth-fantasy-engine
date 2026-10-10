/**
 * 历法规则（一年几个月 / 每月几天）的项目级读写 + 组件态。
 *
 * 为什么单独抽一个 hook：需要它的地方有四处（表格页 / 表格行 / 设定检索 / 时间轴），
 * 各自写一遍「useEffect 里 getSetting、setState」就会出现**某一处忘了读**——
 * 表现是"这页下拉还是 12 个月，那页已经变成 20 个月"，而且谁也说不清哪边是对的。
 *
 * 🔴 口径：**项目级统一**（见 `types.ts` 的 CalendarRule 注释）。
 */
import { useCallback, useEffect, useState } from 'react'
import type { CalendarRule } from '@/lib/types'
import {
  DEFAULT_CALENDAR_RULE, clampCalendarRule, loadCalendarRule, saveCalendarRule as persist,
} from '@/lib/storyDate'

export function useCalendarRule(): {
  rule: CalendarRule
  setRule: (next: CalendarRule) => void
} {
  const [rule, setRuleState] = useState<CalendarRule>(DEFAULT_CALENDAR_RULE)

  useEffect(() => {
    let alive = true
    void loadCalendarRule().then(r => { if (alive) setRuleState(r) })
    return () => { alive = false }
  }, [])

  const setRule = useCallback((next: CalendarRule) => {
    const clean = clampCalendarRule(next)
    setRuleState(clean)
    void persist(clean)
  }, [])

  return { rule, setRule }
}
