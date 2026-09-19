/**
 * 酒馆控制面板的**字段原子件** —— 从 `TavernControl.tsx` 拆出来的（2026-09-19）。
 *
 * 这些是「长得像表单、但不含任何业务」的通用件：分组外壳（Section）、单项排版（Field）、
 * 数值输入 + 分段说明表（NumField / RangeGuide）、文本（TextField）、下拉（SelectField）、开关（ToggleField）。
 *
 * 【为什么单独一个文件】
 *   · 它们**不带任何 store / 设置耦合** —— 全靠 props，所以拆出去零风险、零行为变化；
 *   · 右列（`TavernControlModes.tsx`）拆出去后要用同一套件，留在这里就得反过来 import 主组件（成环）；
 *   · 24 个数值项 × 一张分段表，光这部分就占了原文件两成篇幅，混在业务里没人看得清主干。
 *
 * 🔴 `ShowBands` 是 **context 实例本身**（不是新建一个）—— 表格原子件从这里 useContext，
 *    父组件的 `<ShowBands.Provider>` 必须用同一个对象，否则开关会静默失效。
 */
import { createContext, useContext, useEffect, useState } from 'react'
import AutoTextarea from './AutoTextarea'
import { Button } from './Button'
import { bandOf, type ParamGuide } from '../lib/tavern/paramGuide'

/** 输入框外观（不含字号——字号由 AutoTextarea 的 textClass / input 自己带，避免两处各写一个 size 类打架） */
export const BOX = 'bg-ink-900 border border-ink-700 rounded-md px-2 py-1.5 text-ink-100 outline-none focus:border-amber/50'
export const NUM = `${BOX} w-full`

/**
 * 段内数值组。
 *
 * ⚠️ **只用 2 列，不再有 3 列**：每个数值项下面都挂一张「取值范围 + 分段影响」表（见 RangeGuide），
 * 3 列时每格只有约 226px，长一点的说明会被挤成七八行，反而看不清。2 列约 345px 才读得顺。
 */
export const GRID2 = 'grid grid-cols-1 gap-4 sm:grid-cols-2'

/**
 * 「是否展开每个数值项下面的分段说明」。
 * 24 个数值项全摊开会把页面拉到 3000px 以上，所以页头给了一个总开关（默认展开 —— 说明本来就该先看到）。
 * 用 context 而不是逐项传 prop：开关是**全局的**，24 处各传一遍只会多出 24 个噪音。
 */
export const ShowBands = createContext(true)

/**
 * 分组外壳。
 * `className` / `bodyClassName` 是给「需要被拉伸到与对侧等高的那一段」用的（扮演协议）：
 * 外层网格默认 `align-items: stretch`，两列等高；协议段作为左列最后一个子项吃满剩余高度，
 * 内容区（pre）再 `flex-1` 跟着长 —— 否则左列会比右列短一大截。
 */
export function Section({ title, desc, children, className = '', bodyClassName = '' }: {
  title: string; desc: string; children: React.ReactNode
  className?: string; bodyClassName?: string
}) {
  return (
    <section className={`rounded-lg border border-ink-800 bg-ink-850/30 ${className}`}>
      <div className="shrink-0 px-4 py-3 border-b border-ink-800">
        <h3 className="text-13 text-amber">{title}</h3>
        <p className="mt-0.5 text-11 text-ink-500 leading-relaxed">{desc}</p>
      </div>
      <div className={`p-4 space-y-4 ${bodyClassName}`}>{children}</div>
    </section>
  )
}

/**
 * 单项：标题 → 输入区 → 说明。
 * 说明放下面（不是中间），长短不一时输入框仍然对齐。
 */
export function Field({ label, hint, footer, children }: {
  label: React.ReactNode; hint?: string; footer?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-11 text-ink-200 leading-5">{label}</div>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-10 text-ink-500 leading-relaxed">{hint}</p>}
      {footer}
    </div>
  )
}

/**
 * 数值项的「取值范围 + 分段影响」表，**高亮当前值落在的那一段**。
 *
 * 【为什么要有它】以前每个框旁边只有一句「通常 1.05」—— 用户知道了默认值，却不知道**这一段意味着什么**，
 * 想按自己的需求微调时无从下手。这里把区间摊开分段，写清每一段对模型输入输出的影响。
 *
 * 【为什么数字也在这张表里出】范围与文案收在 `paramGuide.ts`，min/max/step 也由它给 ——
 * 说明与输入框范围若各写一份，日子久了就会对不上，而**说明写错比没写更坏**（测试锁了分段完整性）。
 */
export function RangeGuide({ guide, value }: { guide: ParamGuide; value: number }) {
  const show = useContext(ShowBands)
  if (!show) return null
  const cur = bandOf(guide, value)
  return (
    <div className="mt-2 overflow-hidden rounded-md border border-ink-800 bg-ink-900/40">
      <div className="border-b border-ink-800 px-2 py-1 text-10 text-ink-600">
        取值范围 {guide.min} ~ {guide.max}{guide.unit ? `（${guide.unit}）` : ''} · 步进 {guide.step}
      </div>
      <ul>
        {guide.bands.map(b => {
          const on = b.from === cur.from && b.to === cur.to
          return (
            <li
              key={`${b.from}-${b.to}`}
              className={`border-t border-ink-800/60 px-2 py-1.5 text-10 leading-relaxed first:border-t-0 ${
                on ? 'bg-amber/10' : ''
              }`}
            >
              <span className={`tabular-nums ${on ? 'text-amber' : 'text-ink-500'}`}>
                {b.from === b.to ? b.from : `${b.from} ~ ${b.to}`}
              </span>
              <span className={`ml-1.5 ${on ? 'text-amber' : 'text-ink-300'}`}>{b.name}</span>
              {b.recommended && <span className="ml-1 text-9 text-ink-600">默认</span>}
              <span className={`ml-1.5 ${on ? 'text-ink-200' : 'text-ink-500'}`}>{b.effect}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 数值输入：本地留着正在输入的字，避免「打成 0.」时被立刻纠正。
 *
 * `guide` 同时给出 min / max / step / 单位与分段说明 —— **上界下界与说明同源**，
 * 不会出现「表里说 0~2、输入框只让填到 1」这种自相矛盾（见 paramGuide.ts 顶部注释）。
 */
export function NumField({ label, hint, guide, value, onCommit, recommend }: {
  label: string; hint?: string; guide: ParamGuide
  value: number; onCommit: (v: number) => void
  /**
   * 当前模型下的推荐值（随模型变）。给出时标题右侧多一个可点的「建议 N」：
   * 与当前值不同 → 琥珀色（提示"这里还能再调"），点了即采用；相同 → 灰字 + ✓。
   * 不传 = 这一项没有动态推荐，行为与改造前完全一致。
   */
  recommend?: number | null
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const band = bandOf(guide, value)
  const stale = typeof recommend === 'number' && recommend !== value
  return (
    <Field
      label={
        <span className="flex items-baseline justify-between gap-2">
          <span>{guide.unit ? `${label}（${guide.unit}）` : label}</span>
          <span className="flex shrink-0 items-baseline gap-1.5">
            {typeof recommend === 'number' && (
              <Button variant="bare" type="button"
                onClick={() => onCommit(recommend)}
                className={`h-auto px-1 py-0 rounded text-10 tabular-nums transition-colors ${stale ? 'text-amber hover:bg-amber/10' : 'text-ink-600'}`}
                title={stale
                  ? `当前模型下的推荐值 ${recommend}${guide.unit ? ' ' + guide.unit : ''} —— 点击采用`
                  : `已与当前模型的推荐值一致（${recommend}${guide.unit ? ' ' + guide.unit : ''}）`}>
                建议 {recommend}{stale ? ' ↺' : ' ✓'}
              </Button>
            )}
            <span className="tabular-nums text-10 text-ink-600">{guide.min} ~ {guide.max}</span>
          </span>
        </span>
      }
      hint={hint}
      footer={<RangeGuide guide={guide} value={value} />}
    >
      <input
        type="number" min={guide.min} max={guide.max} step={guide.step} value={draft} className={NUM}
        onChange={e => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (e.target.value.trim() !== '' && Number.isFinite(n)) {
            onCommit(Math.min(guide.max, Math.max(guide.min, n)))
          }
        }}
        onBlur={() => setDraft(String(value))}
      />
      {/* 这一行**常驻**（表格收起时它是唯一线索）：当前值 → 落在哪一段、那一段的范围 */}
      <div className="mt-1 text-10 text-ink-600">
        当前 {value} → <span className="text-amber">{band.name}</span>
        <span className="tabular-nums">（{band.from === band.to ? band.from : `${band.from} ~ ${band.to}`}）</span>
      </div>
    </Field>
  )
}

/** 多行文字输入（自动延展） */
export function TextField({ label, hint, value, minRows = 3, placeholder, onChange }: {
  label: string; hint?: string; value: string; minRows?: number; placeholder?: string
  onChange: (v: string) => void
}) {
  return (
    <Field label={label} hint={hint}>
      <AutoTextarea
        className={BOX} textClass="text-12" minRows={minRows} maxHeight={420}
        placeholder={placeholder} value={value} onChange={onChange}
      />
    </Field>
  )
}

/** 下拉选择。`emptyLabel` 不传就不渲染那个空选项（用于「每一档都是真值」的档位选择） */
export function SelectField({ label, hint, footer, value, options, emptyLabel, onChange }: {
  label: string; hint?: string; footer?: React.ReactNode; value: string
  options: { id: string; label: string }[]; emptyLabel?: string
  onChange: (v: string) => void
}) {
  return (
    <Field label={label} hint={hint} footer={footer}>
      <select value={value} className={`${NUM} w-full`} onChange={e => onChange(e.target.value)}>
        {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </Field>
  )
}

/** 开关 */
export function ToggleField({ label, hint, value, onChange }: {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void
}) {
  return (
    <Field label={label} hint={hint}>
      <Button
        variant="toggle" size="md" selected={value}
        className="w-full" onClick={() => onChange(!value)}
      >
        {value ? '已开启' : '已关闭'}
      </Button>
    </Field>
  )
}
