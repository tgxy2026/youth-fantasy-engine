/**
 * 3.2.0 · T3：字段改名 + 含义确认的组件侧入口（`FieldAliasButton` 用）。
 *
 * 与 `useFieldAliases` 的区别：
 *   · 显示名按 **轻量定义 > 别名 > 原名** 合并（与 AI 上下文同一口径）；
 *   · 历史别名的改名会先被迁移成「待确认」的轻量定义，作者在这里逐项选
 *     「含义不变 / 含义已改变」并把说明写清楚；
 *   · 保存写**轻量定义**，不再给同一个字段同时写旧别名和新定义（方案 §3.12.3.5）。
 *
 * 🔴 未确认的改名照常显示（界面不能因为「没确认」就装作没改过），
 *    但它是否进入 AI / 索引由消费层按 `meaningStatus` 决定（见 T3-B3）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentProjectId } from '@/lib/db'
import { defaultLabelOf, labelMapOf, sanitizeAliases, type AliasMap } from '@/lib/settings/aliasCore'
import { loadAliases, saveAliases, useAliasRevision } from '@/lib/settings/fieldAlias'
import {
  applyDefinitionEditsToTemplate, loadFieldDefinitions, overrideLabelsOf,
  sanitizeFieldDefinitionDoc, saveFieldDefinition, subscribeFieldDefinitions,
  type FieldDefinitionDoc, type FieldDefinitionEdit,
} from './fieldDefinition'
import { loadTemplateDef, saveTemplateDef, subscribeTemplateStore } from './store'
import type { TemplateDef } from './definition'

/** 待确认的一条改名（来自历史别名迁移） */
export interface PendingRename {
  label: string
  defaultLabel?: string
  description?: string
}

/** 作者对「这条改名含义变没变」的选择；`changed` 必须带新含义说明 */
export interface MeaningDecision {
  status: 'unchanged' | 'changed'
  description?: string
}

export interface FieldRenames {
  /** 当前显示名（存储键 → 名字；未改名的也在表里，值为原名） */
  labels: Record<string, string>
  /** 只有改过名的字段（弹窗初值 / 角标用） */
  renamed: AliasMap
  /** 待确认含义的改名（存储键 → 旧名 / 新名 / 现有说明） */
  pending: Record<string, PendingRename>
  /**
   * 保存：`next` 是改后的显示名（空 = 恢复原名），`meanings` 只给待确认项。
   * 🔴 待确认项没有选择 ⇒ 抛错（调用方显示原因），绝不替作者默认「含义不变」。
   * 🔴 已采用页签：写入**模板快照**，不再写 `fieldDefinition32`（避免被快照遮蔽）。
   */
  save: (next: AliasMap, meanings: Record<string, MeaningDecision>) => Promise<void>
  /** 该页签已采用完整模板：显示名与确认状态以快照为准，保存也落在快照上 */
  adopted: boolean
}

export function useFieldRenames(tabId: string, keys: string[]): FieldRenames {
  const pid = getCurrentProjectId()
  const aliasRev = useAliasRevision()
  const [aliasMap, setAliasMap] = useState<AliasMap>({})
  const [doc, setDoc] = useState<FieldDefinitionDoc | null>(null)
  const [def, setDef] = useState<TemplateDef | null>(null)
  const keysRef = useRef(keys)
  keysRef.current = keys
  // 分隔符用转义写法：源码里不出现控制字符（否则扫描器会把文件当 binary，见 fieldAlias 的教训）
  const keysKey = keys.join('\u0000')

  useEffect(() => {
    let alive = true
    const load = () => {
      void Promise.all([
        loadAliases(tabId).catch(() => ({})),
        loadFieldDefinitions(pid, tabId).catch(() => null),
        loadTemplateDef(pid, tabId).catch(() => null),
      ]).then(([a, d, t]) => {
        if (!alive) return
        setAliasMap(a)
        setDoc(d)
        setDef(t)
      })
    }
    load()
    // 确认 / 改说明都会 emit；别名变化由 aliasRev 触发本 effect 重跑
    const off = subscribeFieldDefinitions(load)
    const offDef = subscribeTemplateStore(load)
    return () => {
      alive = false
      off()
      offDef()
    }
  }, [pid, tabId, aliasRev])

  const clean = useMemo(
    () => sanitizeFieldDefinitionDoc(doc, keysRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, keysKey],
  )

  const labels = useMemo(() => {
    const base = labelMapOf(keysRef.current, aliasMap)
    // 🔴 快照优先（与解析层 / loadFieldGating 同口径）：采用后名称由模板维护，
    //    轻量定义与旧别名都只是历史来源，不能反过来把名字顶回去。
    if (def) {
      const byKey = new Map(def.fields.map(f => [f.sourceKey, f.label]))
      for (const key of keysRef.current) {
        const label = byKey.get(key)
        if (label) base[key] = label
      }
      return base
    }
    const defined = clean?.fields ?? {}
    // 轻量定义接管的字段不再回退到旧别名：否则作者在弹窗里「恢复原名」会被别名顶回来
    for (const key of Object.keys(defined)) base[key] = defaultLabelOf(key)
    for (const [key, label] of Object.entries(overrideLabelsOf(clean, keysRef.current))) base[key] = label
    return base
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aliasMap, clean, def, keysKey])

  const renamed = useMemo(() => {
    const out: AliasMap = {}
    for (const key of keysRef.current) {
      const label = labels[key] ?? defaultLabelOf(key)
      if (label !== defaultLabelOf(key)) out[key] = label
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, keysKey])

  const pending = useMemo(() => {
    const out: Record<string, PendingRename> = {}
    // 已采用页签的待确认状态在快照里（采用时已吸收）——这里漏读会让确认清单凭空少一项
    if (def) {
      const wanted = new Set(keysRef.current)
      for (const f of def.fields) {
        if (f.meaningStatus !== 'pending' || !wanted.has(f.sourceKey)) continue
        out[f.sourceKey] = {
          label: f.label,
          ...(f.defaultLabel ? { defaultLabel: f.defaultLabel } : {}),
          ...(f.description ? { description: f.description } : {}),
        }
      }
      return out
    }
    for (const [key, ov] of Object.entries(clean?.fields ?? {})) {
      if (ov.meaningStatus !== 'pending' || !ov.label) continue
      out[key] = {
        label: ov.label,
        ...(ov.defaultLabel ? { defaultLabel: ov.defaultLabel } : {}),
        ...(ov.description ? { description: ov.description } : {}),
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clean, def, keysKey])

  const save = useCallback(async (next: AliasMap, meanings: Record<string, MeaningDecision>) => {
    const tabKeys = keysRef.current
    const cleanNext = sanitizeAliases(tabKeys, next)

    // 已采用模板：语义修改写进快照（方案 §3.12.3.4「停止旧覆盖的可写入口」）
    if (def) {
      const edits: Record<string, FieldDefinitionEdit> = {}
      for (const key of tabKeys) {
        const desired = (cleanNext[key] ?? '').trim()
        const current = labels[key] ?? defaultLabelOf(key)
        const decision = meanings[key]
        if (decision) {
          if (!desired) {
            // 清空输入框 = 恢复原名：改名与说明一并清掉
            edits[key] = { label: null, description: null, meaningStatus: null }
            continue
          }
          if (decision.status === 'changed' && !decision.description?.trim()) {
            throw new Error(`「${current}」标为「含义已改变」时，请写明它现在是什么意思`)
          }
          edits[key] = {
            label: desired,
            ...(decision.status === 'changed' ? { description: decision.description!.trim() } : {}),
            meaningStatus: 'confirmed',
          }
          continue
        }
        if (desired === current) continue
        edits[key] = { label: desired || null }
      }
      const edited = applyDefinitionEditsToTemplate(def, edits)
      if (edited === def) return
      const saved = await saveTemplateDef(pid, {
        ...edited,
        revision: def.revision + 1,
        updatedAt: Date.now(),
      })
      if (!saved.ok) throw new Error(saved.violations.map(v => v.detail).join('；'))
      return
    }

    const aliasesToDrop = new Set<string>()

    for (const key of tabKeys) {
      const desired = (cleanNext[key] ?? '').trim()
      const current = labels[key] ?? defaultLabelOf(key)
      const decision = meanings[key]

      if (decision) {
        // 清空输入框 = 恢复原名：这条待确认的改名不再存在，说明一并清掉。
        // （若仍保留旧名字，作者会以为「恢复默认」没生效。）
        if (!desired) {
          await saveFieldDefinition(pid, tabId, key, { label: null, description: null })
          aliasesToDrop.add(key)
          continue
        }
        if (decision.status === 'changed' && !decision.description?.trim()) {
          throw new Error(`「${current}」标为「含义已改变」时，请写明它现在是什么意思`)
        }
        await saveFieldDefinition(pid, tabId, key, {
          label: desired,
          ...(decision.status === 'changed' ? { description: decision.description!.trim() } : {}),
          meaningStatus: 'confirmed',
        })
        aliasesToDrop.add(key)
        continue
      }

      if (desired === current) continue
      // 改名 / 恢复原名都写成轻量定义；原先的别名在同一次保存里删掉，避免双写后各说各话。
      // 🔴 清空时也必须删别名：否则定义里没有名字，旧别名又会把名字顶回来（保存像没反应）。
      await saveFieldDefinition(pid, tabId, key, { label: desired || null })
      aliasesToDrop.add(key)
    }

    if (aliasesToDrop.size) {
      const rest: AliasMap = { ...aliasMap }
      for (const key of aliasesToDrop) delete rest[key]
      await saveAliases(tabId, tabKeys, rest)
    }
  }, [aliasMap, def, labels, pid, tabId])

  return { labels, renamed, pending, save, adopted: !!def }
}

/** 轻量定义变更信号（设定检索这类「一次读多张表」的组件用） */
export function useFieldDefinitionRevision(): number {
  const [rev, setRev] = useState(0)
  useEffect(() => subscribeFieldDefinitions(() => setRev(r => r + 1)), [])
  return rev
}

/**
 * 只要显示名时的入口（表格 / 表单 / 卡片的界面标签用）。
 * 🔴 必须与 AI 上下文同一口径（定义 > 别名）：作者在弹窗里保存后旧别名会被收走，
 *    界面若还只读别名，名字就会当场「变回原名」。
 */
export function useFieldDisplayLabels(tabId: string, keys: string[]): AliasMap {
  return useFieldRenames(tabId, keys).labels
}
