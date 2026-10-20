/**
 * 3.2.0 · T3：一个页签的**当前显示名**（存储键 → 作者看到的名字）。
 *
 * 为什么要这一层：AI 上下文长期直接印 schema 里的字面字段名。作者把「世界名称」
 * 改名成「世界称呼」之后，界面跟着变了，提示词却还在说「世界名称」——
 * 模型按旧名理解、按旧名回填，作者会以为改名没生效（方案 §3.12）。
 *
 * 🔴 优先级：**采用快照的 label > 轻量定义 > 别名 > schema 原名**。
 *    采用快照后结构由作者自己维护，模板里的名字就是当前名字；轻量定义是尚未采用模板的
 *    页签的改名 / 说明 / 确认落点；别名是老项目的改名通道。三者都只影响**显示**。
 * 🔴 存储键一个字节都不动：返回值只用于渲染，取值 / 回填 / 检索仍按 `sourceKey`。
 * 🔴 读失败 ⇒ 空表（调用方退回 schema 原名），绝不因为改名功能把上下文搞崩。
 */
import type { TabDef } from '@/lib/types'
import { getCurrentProjectId } from '@/lib/db'
import { loadAliases } from '@/lib/settings/fieldAlias'
import { defaultLabelOf, sanitizeAliases } from '@/lib/settings/aliasCore'
import { loadTemplateDef } from './store'
import { resolveTemplateCached } from './cache'
import { loadFieldDefinitions, overrideLabelsOf } from './fieldDefinition'
import { storageKeysOf } from './schemaKeys'

/**
 * 把显示名叠到「存储键 + 显示名」的字段清单上（AI 补全 / 对话引导用）。
 * 🔴 只换 `label`，`key` 与其它属性原样保留 —— 回填仍按稳定键。空表 ⇒ 原样返回同一个数组。
 */
export function applyFieldLabels<T extends { key: string; label: string }>(
  fields: readonly T[],
  labels: Record<string, string>,
): readonly T[] {
  if (!Object.keys(labels).length) return fields
  return fields.map(f => (labels[f.key] ? { ...f, label: labels[f.key] } : f))
}

export interface FieldGating {
  /** 当前显示名（只含真正改过名的字段；其余回退原名） */
  labels: Record<string, string>
  /**
   * 含义未确认的字段（方案 §3.12.3.3）。
   * 🔴 AI 读取 / 索引 / 回填目标一律跳过这些键；界面照常显示名称与内容。
   */
  pending: Set<string>
}

/** 当前项目下这个页签的显示名与待确认字段；读取失败 ⇒ 空表 / 空集（用原名） */
export async function loadFieldGating(tab: TabDef): Promise<FieldGating> {
  try {
    // 不校验 pid 是否为空：`loadAliases` 沿用既有口径（无项目时按空表处理），
    // 这里多一道空判会让「项目尚未建立」的调用方拿到与旧行为不同的结果。
    const pid = getCurrentProjectId()
    const def = await loadTemplateDef(pid, tab.id).catch(() => null)
    if (def) {
      // export 口径：不受展示开关限制，拿到作者维护的完整字段名（归档字段不计）
      const tpl = resolveTemplateCached(tab, { def, purpose: 'export', ignoreAppliesTo: true }, pid)
      const labels: Record<string, string> = {}
      const pending = new Set<string>()
      for (const f of tpl.fields) {
        labels[f.sourceKey] = f.label
        if (f.meaningStatus === 'pending') pending.add(f.sourceKey)
      }
      return { labels, pending }
    }
    const keys = storageKeysOf(tab)
    const [aliases, doc] = await Promise.all([
      loadAliases(tab.id).catch(() => ({})),
      loadFieldDefinitions(pid, tab.id).catch(() => null),
    ])
    // 与界面同一份清洗：不存在的键、撞名、超长一律丢弃（两条通道口径一致）
    const aliasLabels = sanitizeAliases(keys, aliases)
    const overrideLabels = overrideLabelsOf(doc, keys)
    const empty: FieldGating = { labels: {}, pending: new Set() }
    if (!Object.keys(aliasLabels).length && !Object.keys(overrideLabels).length) return empty
    // 取解析结果里的最终名称：轻量定义 > 别名，且只收真正改过名的字段（其余回退原名）
    const renamed = new Set([...Object.keys(aliasLabels), ...Object.keys(overrideLabels)])
    const tpl = resolveTemplateCached(tab, {
      purpose: 'export',
      ignoreAppliesTo: true,
      ...(Object.keys(aliasLabels).length ? { aliases } : {}),
      ...(doc ? { fieldDefinitions: doc } : {}),
    }, pid)
    const labels: Record<string, string> = {}
    const pending = new Set<string>()
    for (const f of tpl.fields) {
      if (f.meaningStatus === 'pending') pending.add(f.sourceKey)
      // 只有真的和原名不同才需要叠加：轻量定义可以「只改说明」或「恢复原名」，
      // 那两种情况都该让调用方回退 schema 原名（别再被旧别名顶回来）。
      if (renamed.has(f.sourceKey) && f.label && f.label !== defaultLabelOf(f.sourceKey)) {
        labels[f.sourceKey] = f.label
      }
    }
    return { labels, pending }
  } catch {
    return { labels: {}, pending: new Set() }
  }
}

/** 当前项目下这个页签的显示名表；没有改名 / 读取失败 ⇒ 空表（用原名） */
export async function loadFieldLabels(tab: TabDef): Promise<Record<string, string>> {
  return (await loadFieldGating(tab)).labels
}

/** 只取「含义未确认」的存储键（AI 读取 / 索引 / 回填的屏蔽清单） */
export async function loadPendingFieldKeys(tab: TabDef): Promise<Set<string>> {
  return (await loadFieldGating(tab)).pending
}
