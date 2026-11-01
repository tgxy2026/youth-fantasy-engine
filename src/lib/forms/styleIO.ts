/**
 * 3.3.3 · B4：写作规范（style）的**导入 / 导出**适配（纯函数）。
 *
 * 【为什么单独一层】原结构是 FormSheet 的 `模块名::字段名 → 字符串`，AI 反推、导入、导出三条路
 * 都要把外来的键映射回这份结构。映射写三遍必然漂移（一处认 `模块::字段`、一处只认字段名，
 * 结果"导入成功但界面全空"）。这里只提供一份映射与往返校验。
 *
 * 🔴 未知字段：**忽略并如实列出**，不能整批失败，也不能静默塞进一个不存在的键。
 * 🔴 空值/多行/中文：原样往返；导出保留**已知字段的空值**，避免"清空"这个事实在往返中丢失。
 * 🔴 导入不直接写库：返回合并后的草稿，由作者保存（取消即不写）。
 */
import type { TabDef } from '@/lib/types'

export const STYLE_SHEET_KIND = 'yfe-style-sheet'
export const STYLE_SHEET_VERSION = 1

export interface StyleFieldDef {
  /** 存储键：`模块名::字段名` */
  key: string
  label: string
  module: string
}

export interface StyleSheetFile {
  app: 'youth-fantasy-engine'
  kind: typeof STYLE_SHEET_KIND
  version: number
  tabId: string
  tabName: string
  /** 已知字段 → 原值（含空字符串） */
  fields: Record<string, string>
}

export function styleFieldDefs(tab: TabDef): StyleFieldDef[] {
  const out: StyleFieldDef[] = []
  for (const m of tab.modules ?? []) {
    for (const f of m.fields) out.push({ key: `${m.name}::${f.name}`, label: f.name, module: m.name })
  }
  return out
}

/** 导出：只写已知字段（未知/历史残留键不带走），**包含空值** */
export function exportStyleSheet(tab: TabDef, data: Record<string, string>): StyleSheetFile {
  const fields: Record<string, string> = {}
  for (const d of styleFieldDefs(tab)) fields[d.key] = String(data[d.key] ?? '')
  return {
    app: 'youth-fantasy-engine', kind: STYLE_SHEET_KIND, version: STYLE_SHEET_VERSION,
    tabId: tab.id, tabName: tab.name, fields,
  }
}

export interface ParsedStyleSheet {
  ok: boolean
  reason: string
  /** 已知字段的导入值（原值，含空串） */
  values: Record<string, string>
  /** 文件里有、本页没有的键（已忽略） */
  unknown: string[]
  /** 值不是字符串 / 结构不合法而被跳过的键 */
  invalid: string[]
}

/** 解析导入文件：只认本页已知键；未知键忽略并回报；结构不对整批拒绝 */
export function parseStyleSheet(raw: unknown, tab: TabDef): ParsedStyleSheet {
  const out: ParsedStyleSheet = { ok: false, reason: '', values: {}, unknown: [], invalid: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    out.reason = '文件内容不是一份写作规范（应为 JSON 对象）'
    return out
  }
  const o = raw as Record<string, unknown>
  if (o.kind !== undefined && o.kind !== STYLE_SHEET_KIND) {
    out.reason = '这不是写作规范的导出文件（kind 不符）'
    return out
  }
  if (o.tabId !== undefined && o.tabId !== tab.id) {
    out.reason = `这份文件属于「${String(o.tabName ?? o.tabId)}」，不能导入到「${tab.name}」`
    return out
  }
  const src = o.fields
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    out.reason = '文件里没有 fields 对象'
    return out
  }
  const known = new Map(styleFieldDefs(tab).map(d => [d.key, d]))
  // 兼容：只给了「字段名」（没有 `模块::`）时，若全页字段名唯一，也能认
  const byLabel = new Map<string, string>()
  for (const d of known.values()) {
    if (byLabel.has(d.label)) byLabel.set(d.label, '') // 重名 ⇒ 不猜
    else byLabel.set(d.label, d.key)
  }
  for (const [rawKey, v] of Object.entries(src as Record<string, unknown>)) {
    const key = known.has(rawKey) ? rawKey : (byLabel.get(rawKey) || '')
    if (!key) { out.unknown.push(rawKey); continue }
    if (typeof v !== 'string') { out.invalid.push(rawKey); continue }
    out.values[key] = v
  }
  out.ok = true
  return out
}

export interface StyleDiffItem {
  key: string
  label: string
  from: string
  to: string
}

/** 预览差异：只列"导入值非空且与当前不同"的字段；空值不覆盖当前（避免误清空） */
export function diffStyleValues(
  current: Record<string, string>,
  imported: Record<string, string>,
  tab: TabDef,
): { changed: StyleDiffItem[]; unchanged: number; skippedEmpty: number } {
  const changed: StyleDiffItem[] = []
  let unchanged = 0
  let skippedEmpty = 0
  for (const d of styleFieldDefs(tab)) {
    const to = String(imported[d.key] ?? '')
    if (!to) { if (String(current[d.key] ?? '') !== '') skippedEmpty++; continue }
    const from = String(current[d.key] ?? '')
    if (from === to) { unchanged++; continue }
    changed.push({ key: d.key, label: d.label, from, to })
  }
  return { changed, unchanged, skippedEmpty }
}

/** 采用选中（或全部）建议：只改这些键，其它字段保持当前值 */
export function applyStyleValues(
  current: Record<string, string>,
  values: Record<string, string>,
  keys?: readonly string[],
): Record<string, string> {
  const next = { ...current }
  const list = keys ?? Object.keys(values)
  for (const k of list) if (k in values) next[k] = values[k]
  return next
}

// ── AI 反推结果的结构校验（纯函数，不放 aiTasks 里：测试不必拉起模型链路） ──
export interface StyleSuggestion {
  key: string
  value: string
  reason: string
  quote: string
}

/**
 * 解析模型输出：只保留**已知 key**、去重、空值丢弃。
 * 🔴 模型编出来的字段名一律丢弃（否则会写进一个界面上不存在的键）；
 * 🔴 不做"尽量修"式猜测：形状不对就当没有建议，由作者重试。
 */
export function parseStyleSuggestions(raw: unknown, knownKeys: readonly string[]): StyleSuggestion[] {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return []
    try { obj = JSON.parse(s.slice(a, b + 1)) } catch { return [] }
  }
  if (!obj || typeof obj !== 'object') return []
  const rec = obj as Record<string, unknown>
  const list = Array.isArray(rec.suggestions) ? rec.suggestions
    : Array.isArray(rec['建议']) ? rec['建议'] : []
  const known = new Set(knownKeys)
  const out: StyleSuggestion[] = []
  const seen = new Set<string>()
  for (const it of list) {
    if (!it || typeof it !== 'object') continue
    const row = it as Record<string, unknown>
    const key = typeof row.key === 'string' ? row.key.trim() : ''
    const value = typeof row.value === 'string' ? row.value.trim() : ''
    if (!key || !value || !known.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push({
      key, value,
      reason: typeof row.reason === 'string' ? row.reason.trim().slice(0, 200) : '',
      quote: typeof row.quote === 'string' ? row.quote.trim().slice(0, 80) : '',
    })
  }
  return out
}