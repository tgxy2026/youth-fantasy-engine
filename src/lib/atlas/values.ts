/**
 * 图鉴（3.1.3）· **自定义字段取值层**（纯函数，无 IO，可单测）。
 *
 * 依据：`docs/3.1.3-图鉴与自定义字段-具体实施方案-2026-10-18.md` §4.2。
 *
 * 🔴 三条口径（写错任意一条，后面搜索 / AI / CSV 全都会漂移）：
 *   1. 值一律存**字符串**（沿用 `TableRow.data: Record<string, string>`），不引第二套结构；
 *   2. `'0'` 与 `'false'` **不是空值** —— 判定空只看「去掉首尾空白后长度为 0」；
 *   3. 数字保留用户原串（`'3.50'` 不擅自变成 `'3.5'`），格式与比较另走函数。
 */
import type { CustomFieldType } from './types'

/** 空值判定：只认空串。`0` / `false` / `[]` 都是有内容的真实值 */
export function isEmptyValue(raw: string | undefined | null): boolean {
  return (raw ?? '').trim().length === 0
}

/** 多选的存储形态：JSON 字符串数组。解析失败一律当空（不抛、不猜） */
export function parseMultiSelectValues(raw: string | undefined | null): string[] {
  const s = (raw ?? '').trim()
  if (!s) return []
  try {
    const v: unknown = JSON.parse(s)
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/** 多选写回：保持用户选择顺序（方案 §4.4）。空数组存空串，不留 `[]` */
export function formatMultiSelectValues(values: readonly string[]): string {
  return values.length === 0 ? '' : JSON.stringify(values)
}

/** 布尔显示名：只有明确的 true/false 才翻译，脏值原样透出（不静默当「否」） */
export function formatBooleanValue(raw: string | undefined | null): string {
  const s = (raw ?? '').trim()
  if (s === 'true') return '是'
  if (s === 'false') return '否'
  return s
}

/**
 * 字段值的**显示文本**（表格单元格 / 图鉴详情 / 搜索结果共用同一份口径）。
 * `unit` 只拼在非空值后面 —— 空值不该显示「年」这种孤零零的单位。
 */
export function formatCustomValue(
  type: CustomFieldType,
  raw: string | undefined | null,
  unit?: string,
): string {
  const s = (raw ?? '').trim()
  if (!s) return ''
  if (type === 'boolean') return formatBooleanValue(s)
  if (type === 'multiSelect') {
    const vals = parseMultiSelectValues(s)
    // 解析不出来就退回原串：宁可显示难看，也不静默吞掉作者写的内容
    return vals.length > 0 ? vals.join('、') : s
  }
  if (type === 'number') return unit ? `${s} ${unit}` : s
  return s
}

/**
 * 把**显示形态**的值还原成**存储形态**（3.1.3 · R09）。
 *
 * 🔴 为什么需要它：CSV 导出的是给人看的（多选→「怕火、怕水」、布尔→「是 / 否」、
 *    带单位数字→「18 级」），而库里存的不是这些（分别是 JSON 数组 / `true` / `18`）。
 *    修复前导入端只 `trim()` ⇒ 导出去再导回来，多选变成一串顿号文本、布尔变成"是"、
 *    带单位的变成"18 级" —— 控件全部回显不出来，作者只会觉得"导入坏了"。
 *
 * @param field 目标字段定义（拿不到就当纯文本，绝不猜）
 */
export function parseTypedImportValue(
  raw: string,
  field?: { customType?: CustomFieldType; unit?: string },
): string {
  const s = (raw ?? '').trim()
  const type = field?.customType
  if (!type || !s) return s
  if (type === 'boolean') {
    if (s === '是' || s === 'true' || s === 'TRUE' || s === '有' || s === 'yes') return 'true'
    if (s === '否' || s === 'false' || s === 'FALSE' || s === '无' || s === 'no') return 'false'
    return s
  }
  if (type === 'multiSelect') {
    // 已经是存储形态（JSON 数组）⇒ 归一化后原样返回，不二次拆分
    const asJson = parseMultiSelectValues(s)
    if (asJson.length > 0) return formatMultiSelectValues(asJson)
    const parts = s.split(/[、,，;；]/).map(x => x.trim()).filter(Boolean)
    return parts.length > 0 ? formatMultiSelectValues(parts) : s
  }
  if (type === 'number') {
    // 剥掉单位后缀与千分位空格：'18 级' / '18级' ⇒ '18'
    const unit = (field?.unit ?? '').trim()
    let t = s
    if (unit && t.endsWith(unit)) t = t.slice(0, -unit.length).trim()
    t = t.replace(/\s+/g, '')
    return /^-?\d+(\.\d+)?$/.test(t) ? t : s
  }
  return s
}

/** 按类型写回存储串（供后续配置 UI / AI 回填使用） */
export function serializeCustomValue(
  type: CustomFieldType,
  value: string | number | boolean | readonly string[],
): string {
  if (type === 'boolean') return value === true || value === 'true' ? 'true' : 'false'
  if (type === 'multiSelect') return formatMultiSelectValues(Array.isArray(value) ? value.map(String) : [])
  return String(value ?? '').trim()
}

/** 校验结果：要么给出可落库的存储串，要么说明为什么丢（方案 §7.3「不合法值列入错误，不能静默写入」） */
export type CoerceResult = { ok: true; value: string } | { ok: false; reason: string }

/** 长度上限（方案 §4.4）：短文本 200 / 长文本 10000 */
export const MAX_TEXT_LEN = 200
export const MAX_LONG_TEXT_LEN = 10000

/**
 * 把 AI 返回的任意值**收敛成该字段合法的存储串**。
 *
 * 🔴 这是 AI 回填的最后一道闸：
 *   · 数字必须是有限数值，`'很多'` 这种直接拒（否则排序 / 图表会出现 NaN）；
 *   · 单选必须命中选项，模型自创的选项一律拒（不是"顺手加进选项表"——那会让配置静默长草）；
 *   · 布尔接受 `true/false/是/否`，其它拒（**不**默认成否，那等于替作者下结论）；
 *   · 多选只保留命中选项的项；一项都不剩则整体拒；
 *   · 文本按类型截断（超长是"超限"，截断比整条丢掉更有用，且会在预览里可见）。
 */
export function coerceAiValue(
  def: {
    /** 字段定义里的类型（`AtlasFieldDefinition.type`） */
    type?: CustomFieldType
    /** 解析后的字段类型（`ResolvedAtlasField.customType`）—— 两个入口都收，免得调用方各写一次转换 */
    customType?: CustomFieldType
    options?: string[]
    label: string
  },
  raw: unknown,
): CoerceResult {
  const label = def.label || '字段'
  const type = def.customType ?? def.type ?? 'text'

  // 空值合法：AI 明确回答"不知道/没提到"时应该留空，而不是被当成错误
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, value: '' }
  }

  if (type === 'boolean') {
    if (raw === true || raw === 'true' || raw === '是') return { ok: true, value: 'true' }
    if (raw === false || raw === 'false' || raw === '否') return { ok: true, value: 'false' }
    return { ok: false, reason: `${label} 需要「是 / 否」` }
  }

  if (type === 'number') {
    // 字符串形态的合法数字**保留原写法**（`'3.50'` 不被改写成 `'3.5'` —— 与表格同口径）
    if (typeof raw === 'string') {
      const s = raw.trim()
      if (!Number.isFinite(Number(s))) return { ok: false, reason: `${label} 不是有效数字` }
      return { ok: true, value: s }
    }
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) return { ok: false, reason: `${label} 不是有效数字` }
    return { ok: true, value: String(n) }
  }

  const options = def.options ?? []

  if (type === 'select') {
    const v = String(raw).trim()
    if (options.length > 0 && !options.includes(v)) {
      return { ok: false, reason: `${label} 的「${v}」不在候选值里` }
    }
    return { ok: true, value: v }
  }

  if (type === 'multiSelect') {
    const list = Array.isArray(raw)
      ? raw.map(x => String(x).trim())
      : String(raw).split(/[、,，;；]/).map(s => s.trim())
    const kept = list.filter(Boolean).filter(v => options.length === 0 || options.includes(v))
    if (kept.length === 0) return { ok: false, reason: `${label} 没有命中任何候选值` }
    return { ok: true, value: formatMultiSelectValues([...new Set(kept)]) }
  }

  const text = typeof raw === 'string' ? raw.trim() : String(raw).trim()
  const max = type === 'longText' ? MAX_LONG_TEXT_LEN : MAX_TEXT_LEN
  return { ok: true, value: text.length > max ? text.slice(0, max) : text }
}
