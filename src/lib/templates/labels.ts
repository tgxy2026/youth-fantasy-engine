/**
 * 3.2.0 · T3：一个页签的**当前显示名**（存储键 → 作者看到的名字）。
 *
 * 为什么要这一层：AI 上下文长期直接印 schema 里的字面字段名。作者把「世界名称」
 * 改名成「世界称呼」之后，界面跟着变了，提示词却还在说「世界名称」——
 * 模型按旧名理解、按旧名回填，作者会以为改名没生效（方案 §3.12）。
 *
 * 🔴 优先级：**采用快照的 label > 别名 > schema 原名**。
 *    采用快照后结构由作者自己维护，模板里的名字就是当前名字；别名是尚未采用模板的
 *    老项目的改名通道。两者都只影响**显示**。
 * 🔴 存储键一个字节都不动：返回值只用于渲染，取值 / 回填 / 检索仍按 `sourceKey`。
 * 🔴 读失败 ⇒ 空表（调用方退回 schema 原名），绝不因为改名功能把上下文搞崩。
 */
import type { TabDef } from '@/lib/types'
import { getCurrentProjectId } from '@/lib/db'
import { loadAliases } from '@/lib/settings/fieldAlias'
import { sanitizeAliases } from '@/lib/settings/aliasCore'
import { loadTemplateDef } from './store'
import { resolveTemplateCached } from './cache'

/** 页签在 schema 里的全部存储键（列名 / `模块名::字段名`） */
function storageKeysOf(tab: TabDef): string[] {
  const keys = (tab.columns ?? []).map(c => c.name)
  for (const m of tab.modules ?? []) {
    for (const f of m.fields) keys.push(`${m.name}::${f.name}`)
  }
  return keys
}

/** 当前项目下这个页签的显示名表；没有改名 / 读取失败 ⇒ 空表（用原名） */
export async function loadFieldLabels(tab: TabDef): Promise<Record<string, string>> {
  try {
    // 不校验 pid 是否为空：`loadAliases` 沿用既有口径（无项目时按空表处理），
    // 这里多一道空判会让「项目尚未建立」的调用方拿到与旧行为不同的结果。
    const pid = getCurrentProjectId()
    const def = await loadTemplateDef(pid, tab.id).catch(() => null)
    if (def) {
      // export 口径：不受展示开关限制，拿到作者维护的完整字段名（归档字段不计）
      const tpl = resolveTemplateCached(tab, { def, purpose: 'export', ignoreAppliesTo: true }, pid)
      const out: Record<string, string> = {}
      for (const f of tpl.fields) out[f.sourceKey] = f.label
      return out
    }
    const aliases = await loadAliases(tab.id).catch(() => ({}))
    if (!Object.keys(aliases).length) return {}
    // 与界面同一份清洗：不存在的键、撞名、超长一律丢弃
    return sanitizeAliases(storageKeysOf(tab), aliases)
  } catch {
    return {}
  }
}
