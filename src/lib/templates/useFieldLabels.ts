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
import { loadFieldLabels } from './labels'

export function useFieldLabels(tabId?: string): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({})
  const aliasRev = useAliasRevision()

  useEffect(() => {
    const tab = tabId ? TABS.find(t => t.id === tabId) : undefined
    if (!tab) {
      setLabels({})
      return
    }
    let alive = true
    const load = () => {
      void loadFieldLabels(tab)
        .then(m => { if (alive) setLabels(m) })
        .catch(() => { if (alive) setLabels({}) })
    }
    load()
    const offTemplate = subscribeTemplateStore(load)
    const offDefs = subscribeFieldDefinitions(load)
    return () => {
      alive = false
      offTemplate()
      offDefs()
    }
    // aliasRev 只作为「有人改了别名」的信号：真实数据由 loadFieldLabels 重读
  }, [tabId, aliasRev])

  return labels
}
