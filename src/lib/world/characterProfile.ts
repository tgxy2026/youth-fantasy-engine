import { buildMappingPlan, type DeclaredBindings } from '@/lib/templates/mappingPlan'
import { slotsForTab } from '@/lib/templates/semanticSlots'
import type { EffectiveField, EffectiveTemplate } from '@/lib/templates/types'

// UI facts reuse the template's semantic bindings. Author visibility is distinct from AI permission.
export function characterProfileFields(template: EffectiveTemplate, declared: DeclaredBindings = {}, pending: ReadonlySet<string> = new Set()): EffectiveField[] {
  const visible = template.fields.filter(field => !field.archived && field.permissions.detail
    && field.meaningStatus !== 'pending' && !pending.has(field.sourceKey))
  // An explicitly bound field becoming hidden/pending must not silently select another field.
  const ids = new Set(visible.map(field => field.id))
  const allowedBindings = Object.fromEntries(Object.entries(declared).map(([slot, value]) => [slot,
    (Array.isArray(value) ? value : [value]).filter(id => ids.has(id)),
  ]))
  const plan = buildMappingPlan({ ...template, fields: visible }, slotsForTab(template.tabId), allowedBindings)
  const seen = new Set<string>()
  return ['identity', 'alias', 'realm', 'faction', 'desc'].flatMap(slot => {
    const binding = plan.bindings.find(item => item.slot === slot)
    return (binding?.fieldIds ?? []).flatMap(id => {
      const field = visible.find(item => item.id === id)
      if (!field || seen.has(field.sourceKey)) return []
      seen.add(field.sourceKey)
      return [field]
    })
  })
}

export interface CharacterProfileFact { key: string; label: string; value: string }
export function characterProfileFacts(fields: readonly Pick<EffectiveField, 'sourceKey' | 'label'>[], data: Readonly<Record<string, unknown>>): CharacterProfileFact[] {
  return fields.flatMap(field => {
    const value = data[field.sourceKey]
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) return []
    const text = String(value)
    return text.trim() ? [{ key: field.sourceKey, label: field.label, value: text }] : []
  })
}
