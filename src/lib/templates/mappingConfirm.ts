/**
 * 3.2.0 · WT2：**语义映射的确认与保存**
 *
 * 方案 §3.10.2：
 *   · 空白/外来模板先用标签、类型与现有目录给**建议**（`buildMappingPlan` 的 exact/alias）；
 *   · 作者一次确认后**按模板版本保存**，分享时一起带走；
 *   · 不明确的字段仍作为普通扩展资料进入允许的 AI 阅读。
 *
 * 所以这里只做两件事：
 *   1. 把作者的选择规整成可存进 `TemplateDef.bindings` 的最小集合（只有一个真理源）；
 *   2. 保存时**只动绑定**，不重算字段语义摘要、不迁移值 —— 映射不是字段含义。
 *
 * 🔴 保存前逐条核对字段是否仍在模板里且未归档：
 *    绑定到已归档字段等于把内容写进「常规使用不出现」的栏位，而作者看不见。
 *    全部目标都失效时写成空数组（明确不绑定），**绝不回落到派生匹配** ——
 *    回落就可能写进另一个同名字段，正是要防的静默错位。
 */
import type { TemplateDef } from './definition'
import type { LimitViolation } from './limits'
import { blockingMigrationOf } from './migrationLog'
import { loadTemplateDef, saveTemplateDef } from './store'
import type { DeclaredBindings } from './mappingPlan'
import { slotsForTab, type SemanticSlotDef } from './semanticSlots'

/** 一份模板最多确认多少个槽位（槽位目录远小于此，上限只防外来 JSON 撑爆） */
export const MAPPING_MAX_SLOTS = 64
/** 一个槽位最多绑定多少个字段（声明多字段＝合成用途，写回一律人工指定） */
export const MAPPING_MAX_FIELDS = 8

/**
 * 形状清洗（**不校验字段是否存在**）：供库/模板包这种「只有 JSON、没有页签上下文」的场景用。
 *
 * 🔴 空数组保留：它是「明确不绑定」的合法声明，不是脏数据。
 * 🔴 超限的槽位整条丢弃而不是截断 —— 截断后的绑定会悄悄改掉作者的组合意图。
 */
export function normalizeBindingsShape(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let count = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const slot = key.trim()
    if (!slot || slot.length > 64 || count >= MAPPING_MAX_SLOTS) continue
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null
    if (!list) continue
    const ids = [...new Set(
      list
        .filter((x): x is string => typeof x === 'string')
        .map(x => x.trim())
        .filter(x => x.length > 0 && x.length <= 128),
    )]
    // 空 = 明确不绑定；非空但超过上限 = 无法无损表达，整条不要
    if (ids.length > MAPPING_MAX_FIELDS) continue
    out[slot] = ids
    count++
  }
  return out
}

/** 规范化文本：用于「有没有变化」与内容摘要；键与字段 ID 都排序 */
export function canonicalBindingText(bindings: DeclaredBindings | undefined): string {
  const shape = normalizeBindingsShape(bindings ?? {})
  return Object.keys(shape)
    .sort()
    .map(k => `${k}=${[...shape[k]].sort().join(',')}`)
    .join('|')
}

/**
 * 按一份具体模板规整绑定：只保留该页签的槽位、仍存在且未归档的字段。
 *
 * @returns `bindings` 可直接写入 `TemplateDef`；`dropped` 列出被丢弃的槽位（界面提示用）
 */
export function normalizeBindingsForDef(
  def: TemplateDef,
  slotDefs: readonly SemanticSlotDef[],
  raw: DeclaredBindings | undefined,
): { bindings: Record<string, string[]>; dropped: string[] } {
  const active = new Set(def.fields.filter(f => !f.archived).map(f => f.id))
  const known = new Set(slotDefs.map(d => d.slot))
  const shape = normalizeBindingsShape(raw ?? {})
  const bindings: Record<string, string[]> = {}
  const dropped: string[] = []

  for (const [slot, ids] of Object.entries(shape)) {
    if (!known.has(slot)) {
      dropped.push(slot)
      continue
    }
    if (ids.length === 0) {
      bindings[slot] = []
      continue
    }
    const valid = ids.filter(id => active.has(id))
    if (valid.length !== ids.length) dropped.push(slot)
    // 全失效 ⇒ 保持「明确不绑定」，不回落到派生匹配（回落可能写进另一栏）
    bindings[slot] = valid
  }
  return { bindings, dropped }
}

export type SaveBindingsResult =
  | { ok: true; def: TemplateDef; changed: boolean; dropped: string[] }
  | {
      ok: false
      code: 'invalid' | 'no-template' | 'blocked' | 'save-failed'
      detail: string
      violations?: LimitViolation[]
    }

/**
 * 保存作者确认的映射。
 *
 * 🔴 只写 `TemplateDef.bindings` 与修订号：不重算 `semanticDigest`（字段含义没变），
 *    也不触发迁移（没有值需要搬）。索引与候选的失效由映射自己的 `plan.digest` 负责。
 * 🔴 迁移阻断期间拒绝写入：此时模板与值都可能处于半切换状态，保存映射会让人误以为已确认。
 */
export async function saveDeclaredBindings(
  pid: string,
  tabId: string,
  raw: DeclaredBindings,
): Promise<SaveBindingsResult> {
  if (!pid || !tabId) return { ok: false, code: 'invalid', detail: '缺少项目或页签标识，无法保存映射' }

  const def = await loadTemplateDef(pid, tabId)
  if (!def) {
    return {
      ok: false,
      code: 'no-template',
      detail: '该页签还没有采用模板：先采用一份模板，确认结果才能随项目保存',
    }
  }
  const blocking = await blockingMigrationOf(pid, tabId)
  if (blocking) {
    return {
      ok: false,
      code: 'blocked',
      detail: `该页签的模板迁移尚未恢复（${blocking.state}），请先恢复到迁移前再确认映射`,
    }
  }

  const { bindings, dropped } = normalizeBindingsForDef(def, slotsForTab(tabId), raw)
  const changed = canonicalBindingText(def.bindings) !== canonicalBindingText(bindings)
  if (!changed) return { ok: true, def, changed: false, dropped }

  const next: TemplateDef = {
    ...def,
    revision: def.revision + 1,
    updatedAt: Date.now(),
  }
  if (Object.keys(bindings).length) next.bindings = bindings
  else delete next.bindings

  const saved = await saveTemplateDef(pid, next)
  if (!saved.ok) {
    return {
      ok: false,
      code: 'save-failed',
      detail: saved.violations.map(v => v.detail).join('；'),
      violations: saved.violations,
    }
  }
  return { ok: true, def: next, changed: true, dropped }
}
