/**
 * 图鉴自定义字段的**单元格编辑器**（3.1.3 · F3）。
 *
 * 只被 `TableSheetRow` 在 `col.atlasField` 存在时调用 ⇒ 内置列的老控件一个都没换，
 * "改一处、所有表跟着变"的风险被关在两个页签里（方案 §10 F3 的取向）。
 *
 * 六种类型的落地口径（方案 §4.2「值一律存字符串」）：
 *   · text / longText → CellTextarea，原文写回；
 *   · number          → NumberField，规范化数字转字符串（空 → 空串）；
 *   · select          → 原生下拉（**不用** CustomSelect：那会把 cf_xxx 当成内置列名去写自定义选项）；
 *   · boolean         → 是/否 下拉，存 `'true'` / `'false'`；
 *   · multiSelect     → 文本编辑 + 分隔符切分，存 JSON 字符串数组（保持输入顺序）。
 */
import type { ResolvedAtlasField } from '@/lib/atlas/types'
import { formatMultiSelectValues, parseMultiSelectValues } from '@/lib/atlas/values'
import NumberField from '@/components/common/NumberField'
import { CellTextarea } from '@/components/sheets/tableSheetShared'

interface Props {
  field: ResolvedAtlasField
  /** 存储串（drafts 优先，已由 `cellVal` 合并） */
  value: string
  onChange: (v: string) => void
}

/** 多选文本 → JSON 数组串：中文顿号 / 中英文逗号 / 分号都当分隔符，去空保序 */
function splitMulti(raw: string): string {
  const parts = raw
    .split(/[、,，;；]/)
    .map(s => s.trim())
    .filter(Boolean)
  return formatMultiSelectValues(parts)
}

export default function AtlasCellInput({ field, value, onChange }: Props) {
  const type = field.customType ?? 'text'

  if (type === 'multiSelect') {
    const opts = field.options ?? []
    const selected = parseMultiSelectValues(value)

    // 没配候选值时退化成文本（否则作者完全没法填）；配了就优先用勾选
    if (opts.length === 0) {
      return (
        <CellTextarea
          value={selected.join('、')}
          onChange={v => onChange(splitMulti(v))}
          title={`${field.label}（多个值用「、」或逗号分隔）`}
        />
      )
    }

    const toggle = (o: string) => {
      // 🔴 保持用户选择顺序（方案 §4.4）：新勾的追加到末尾，取消的原地移除
      const next = selected.includes(o) ? selected.filter(x => x !== o) : [...selected, o]
      onChange(formatMultiSelectValues(next))
    }

    return (
      <div className="w-full min-w-0">
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selected.map(s => (
              <span key={s} className="text-10 px-1.5 py-0.5 rounded bg-amber/15 text-amber border border-amber/30">
                {s}
              </span>
            ))}
          </div>
        )}
        <details className="mt-0.5">
          <summary className="text-10 text-ink-500 hover:text-amber cursor-pointer select-none">
            {selected.length > 0 ? '修改' : '选择…'}
          </summary>
          <div className="mt-1 rounded-lg border border-ink-700 bg-ink-900 p-1.5 space-y-0.5 max-h-40 overflow-y-auto">
            {opts.map(o => (
              <label key={o} className="flex items-center gap-1.5 text-11 text-ink-200 px-1 py-0.5 rounded hover:bg-ink-800 cursor-pointer">
                <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
                <span className="truncate">{o}</span>
              </label>
            ))}
          </div>
        </details>
      </div>
    )
  }

  if (type === 'number') {
    return (
      <NumberField
        value={Number.isFinite(Number(value)) && value !== '' ? Number(value) : undefined}
        onChange={v => onChange(v === undefined ? '' : String(v))}
        allowEmpty
        precision={2}
        className="!py-1 text-12 w-full bg-ink-900 border border-ink-700 rounded px-2 outline-none focus:border-amber/50"
      />
    )
  }

  if (type === 'select' || type === 'boolean') {
    const opts = type === 'boolean' ? ['true', 'false'] : (field.options ?? [])
    return (
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full text-12 py-1 px-1.5 rounded bg-ink-900/60 border border-ink-700 text-ink-100 outline-none focus:border-amber/40"
        title={field.description || field.label}
      >
        <option value="">—</option>
        {opts.map(o => (
          <option key={o} value={o}>
            {type === 'boolean' ? (o === 'true' ? '是' : '否') : o}
          </option>
        ))}
      </select>
    )
  }

  // text / longText（以及未来未知类型）一律按文本处理 —— 不执行任何表达式或 HTML
  return (
    <CellTextarea
      value={value}
      onChange={onChange}
      title={field.description || field.label}
    />
  )
}

/** 供配置面板复用的空值判定（与表格同口径：`0` / `false` 都不算空） */
export function atlasCellHasValue(field: ResolvedAtlasField, raw: string): boolean {
  if (field.customType === 'multiSelect') return parseMultiSelectValues(raw).length > 0
  return (raw ?? '').trim().length > 0
}
