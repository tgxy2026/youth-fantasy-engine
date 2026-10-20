/**
 * 组件侧读取「当前显示名」的小钩子（3.2.0 · T3）。
 *
 * 与 `loadFieldLabels` 同一口径：采用模板 > 轻量定义 > 别名 > schema 原名。
 * 别名保存（`fieldAlias` 的订阅）、轻量定义确认（`fieldDefinition` 的订阅）与
 * 模板采用 / 恢复（`templateStore`）都会触发重读，否则作者刚改完名，
 * 已经打开的 AI 弹窗仍按旧名发提示词。
 */
import { useEffect, useState } from 'react'
import { TABS } from '@/lib/schema'
import { useAliasRevision } from '@/lib/settings/fieldAlias'
import { subscribeTemplateStore } from './store'
import { subscribeFieldDefinitions } from './fieldDefinition'
import { loadFieldGating, type FieldGating } from './labels'

const EMPTY: FieldGating = { labels: {}, pending: new Set() }

/**
 * 显示名 + 待确认字段（AI 弹窗用）。
 * 🔴 `pending` 里的键不得发给模型 / 写回：按方案 §3.12.3.3，未确认的改名既不按旧名解释、
 *    也不推断新义，先整项屏蔽，作者确认后再恢复。
 */
export function useFieldGating(tabId?: string): FieldGating {
  const [gating, setGating] = useState<FieldGating>(EMPTY)
  const aliasRev = useAliasRevision()

  useEffect(() => {
    const tab = tabId ? TABS.find(t => t.id === tabId) : undefined
    if (!tab) {
      setGating(EMPTY)
      return
    }
    let alive = true
    const load = () => {
      void loadFieldGating(tab)
        .then(g => { if (alive) setGating(g) })
        .catch(() => { if (alive) setGating(EMPTY) })
    }
    load()
    const offTemplate = subscribeTemplateStore(load)
    const offDefs = subscribeFieldDefinitions(load)
    return () => {
      alive = false
      offTemplate()
      offDefs()
    }
    // aliasRev 只作为「有人改了别名」的信号：真实数据由 loadFieldGating 重读
  }, [tabId, aliasRev])

  return gating
}

export function useFieldLabels(tabId?: string): Record<string, string> {
  return useFieldGating(tabId).labels
}
