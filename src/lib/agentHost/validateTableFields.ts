import type { CardRecord, TableRow, TabDef } from '@/lib/types'
import type { OwnedOperation } from '@/lib/storage/ownedOperation'
import { resolveOptions } from '@/lib/settings/customOptions'
import { parseStoryDateParts, clampCalendarRule } from '@/lib/app/storyDate'
import { DEFAULT_CALENDAR_RULE, type CalendarDef, type CalendarRule } from '@/lib/types'

/** 校验 Agent 写入的列；未实现的结构化列失败关闭。 */
export async function validateTableFields(owner: OwnedOperation, tab: TabDef, fields: Record<string, string>): Promise<string | null> {
  for (const [key, value] of Object.entries(fields)) {
    if (!value.trim()) continue
    const column = tab.columns?.find(item => item.name === key)
    if (!column || column.hidden || key === '编号') return `不可写或未知的字段：${key}`
    if (column.calendar) {
      const saved = await owner.store.get<{ value?: CalendarDef[] }>('settingsKV', `${owner.projectId}::calendars`)
      const legacy = await owner.store.get<{ value?: string }>('settingsKV', `${owner.projectId}::calendarName`)
      const names = Array.isArray(saved?.value) && saved.value.length
        ? saved.value.map(item => item?.name).filter((name): name is string => typeof name === 'string')
        : [typeof legacy?.value === 'string' && legacy.value.trim() ? legacy.value.trim() : '灵历']
      if (!names.includes(value)) return `字段 ${key} 必须使用当前项目已有的历法。`
    } else if (column.type === 'date') {
      const saved = await owner.store.get<{ value?: CalendarRule }>('settingsKV', `${owner.projectId}::calendarRule`)
      const rule = clampCalendarRule(saved?.value ?? DEFAULT_CALENDAR_RULE)
      const date = parseStoryDateParts(value)
      if (!date || !Number.isSafeInteger(date.y) || (date.m !== undefined && (date.m < 1 || date.m > rule.monthsPerYear)) || (date.d !== undefined && (date.d < 1 || date.d > rule.daysPerMonth))) return `字段 ${key} 的故事日期不符合当前历法规则。`
    } else if (column.type === 'calendar') {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      if (!match) return `字段 ${key} 必须使用 YYYY-MM-DD 日期。`
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
      const date = new Date(0)
      date.setUTCFullYear(year, month - 1, day)
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return `字段 ${key} 不是有效日期。`
    } else if (column.type === 'number') {
      if (!/^-?\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value))) return `字段 ${key} 必须是最多两位小数的数字。`
    } else if (column.type === 'select') {
      let allowed = column.options ?? []
      if (!column.fixedOptions) {
        const stored = await owner.store.get<{ value?: { items?: unknown; hidden?: unknown; renamed?: Record<string, string> } }>('settingsKV', `customOption::${owner.projectId}::${tab.id}::${key}`)
        const raw = stored?.value
        const payload = {
          items: Array.isArray(raw?.items) ? raw.items.filter((x): x is string => typeof x === 'string') : [],
          hidden: Array.isArray(raw?.hidden) ? raw.hidden.filter((x): x is string => typeof x === 'string') : [],
          renamed: raw?.renamed,
        }
        allowed = resolveOptions(allowed, payload).map(option => option.name)
      }
      if (!allowed.includes(value)) return `字段 ${key} 的值不在当前可用选项中。`
    } else if (column.type === 'tableRef') {
      if (!column.refTab || !column.refCol) return `字段 ${key} 缺少引用定义。`
      const rows = await owner.store.getAllByIndex<TableRow>('tableRows', 'tabId', column.refTab)
      const allowed = new Set(rows.filter(row => row.projectId === owner.projectId).map(row => row.data[column.refCol!]).filter(Boolean))
      const supplied = column.multiValue ? value.split(/[，,]/).map(item => item.trim()).filter(Boolean) : [value.trim()]
      if (supplied.some(item => !allowed.has(item))) return `字段 ${key} 引用了不存在的条目。`
    } else if (column.type === 'character' || column.type === 'characters') {
      const cards = await owner.store.getAll<CardRecord>('cardRecords')
      const names = new Set(cards.filter(card => card.projectId === owner.projectId && ['char-main', 'char-secondary', 'char-npc'].includes(card.tabId)).map(card => card.name))
      const supplied = column.type === 'characters' ? value.split(/[，,]/).map(item => item.trim()).filter(Boolean) : [value.trim()]
      if (supplied.some(name => !names.has(name))) return `字段 ${key} 引用了不存在的角色。`
    } else if (column.type && column.type !== 'text' && column.type !== 'textarea') {
      return `字段 ${key} 的类型暂不支持。`
    }
  }
  return null
}
