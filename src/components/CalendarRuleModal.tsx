/**
 * 「历法规则」编辑弹窗（2.4.4 起；2.7.2 收拢历法清单）。
 *
 * 2.7.2：历法的**全部设置**都收进这一个弹窗 ——
 *   ① 历法清单：名称 / 数值（新增、改名、删除）
 *   ② 历法规则：一年几个月、每月几天
 * 表单里的「历法」列随之只剩**只选**（见 `CalendarSelect`），不再就地新增 / 改名 / 删除。
 *
 * 【为什么必须收成一处】
 *   原先两处都能改：弹窗改规则、单元格下拉改清单。作者的困惑很具体（「我到底在哪加的历法」），
 *   更麻烦的是**改名散在单元格里改** —— 别处引用同一个历法的行不会跟着变，下拉里于是多出
 *   一个谁也没在用、又确实存在的孤儿值。收成一处后，改名才可能连带更新已引用的行。
 *
 * 🔴 保存语义（2026-10-02 主人哥哥定版）：
 *   · 弹窗内先改**草稿**，点「保存」一次性提交「规则 + 清单」；点「取消」不生效。
 *   · **改名**要连带更新已引用旧名的行（历史事件 / 时间脉络）—— 不留孤儿。
 *   · **删除**只把历法从清单移除，已填的行**保留旧名文本**（不销毁数据，作者可自行改）。
 *   · 规则数值的说明必须写清**影响范围**：改了它之后，已经填好的日期不会自动换算
 *     （12 月 × 30 天时填的「12月30日」，改成 20 月 × 40 天后仍是那串字，只是它在新规则下
 *      变成了「第 12 月第 30 天」—— 月份的**序号**变了但数字没变）。
 *      不写清楚，作者会以为引擎偷偷改了他的数据。
 */
import { useMemo, useState } from 'react'
import { RotateCcw, Plus, Trash2 } from 'lucide-react'
import type { CalendarDef, CalendarRule } from '../lib/types'
import {
  DAYS_PER_MONTH_MAX, DEFAULT_CALENDAR_RULE, MONTHS_PER_YEAR_MAX,
  clampCalendarRule, daysPerYear,
} from '../lib/storyDate'
import { uid } from '../lib/id'
import { Modal } from './Modal'
import { Button } from './Button'
import NumberField from './NumberField'

/** 草稿行：`orig` 有值＝来自已保存的历法（用于识别"改名"），无值＝本次新增 */
interface RowDraft {
  id: string
  name: string
  value: number
  orig?: string
}

interface Props {
  open: boolean
  rule: CalendarRule
  calendars: CalendarDef[]
  /**
   * 保存：规则 + 历法清单一次性提交。
   * `renames` 供上层把已引用旧名的行改成新名（历史事件 / 时间脉络）。
   */
  onSave: (next: { rule: CalendarRule; calendars: CalendarDef[]; renames: Array<{ from: string; to: string }> }) => void
  onClose: () => void
}

export default function CalendarRuleModal({ open, rule, calendars, onSave, onClose }: Props) {
  const [months, setMonths] = useState(rule.monthsPerYear)
  const [days, setDays] = useState(rule.daysPerMonth)
  const [rows, setRows] = useState<RowDraft[]>(() =>
    calendars.map(c => ({ id: uid(), name: c.name, value: c.value, orig: c.name })),
  )
  const [error, setError] = useState<string | null>(null)

  const clean = clampCalendarRule({ monthsPerYear: months, daysPerMonth: days })
  const ruleChanged = clean.monthsPerYear !== rule.monthsPerYear || clean.daysPerMonth !== rule.daysPerMonth

  /** 改名：草稿里有 orig、且名字变了（trim 后比较） */
  const renames = useMemo(
    () => rows
      .filter(r => r.orig !== undefined && r.name.trim() !== r.orig)
      .map(r => ({ from: r.orig as string, to: r.name.trim() }))
      .filter(r => r.to.length > 0),
    [rows],
  )
  /** 被移除的历法（原来是已保存的，现在草稿里没了） */
  const removed = useMemo(
    () => calendars.filter(c => !rows.some(r => r.orig === c.name)).map(c => c.name),
    [calendars, rows],
  )
  const addedCount = rows.filter(r => r.orig === undefined).length
  const dirty = ruleChanged || renames.length > 0 || removed.length > 0 || addedCount > 0

  const addRow = () => setRows(prev => [...prev, { id: uid(), name: '', value: prev.length }])
  const patchRow = (id: string, patch: Partial<RowDraft>) =>
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)))
  const removeRow = (id: string) => setRows(prev => prev.filter(r => r.id !== id))

  const save = () => {
    const named = rows.map(r => ({ ...r, name: r.name.trim() }))
    if (named.some(r => !r.name)) { setError('历法名称不能为空（不想保留就点右侧的删除）。'); return }
    const dup = named.map(r => r.name).find((n, i, arr) => arr.indexOf(n) !== i)
    if (dup) { setError(`历法名称重复：「${dup}」—— 名字要唯一，否则下拉里分不清。`); return }
    setError(null)
    onSave({
      rule: clean,
      calendars: named.map(r => ({ name: r.name, value: Number.isFinite(r.value) ? r.value : 0 })),
      renames,
    })
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="历法规则" width={560} bodyClassName="p-4 space-y-4">
      <p className="text-11 leading-relaxed text-ink-400">
        架空世界不必照搬地球公历。历法的<b className="text-ink-200">全部设置</b>都收在这里：
        上面定历法的名称与先后数值，下面定「一年几个月、每月几天」。
        表格里的「历法」列只做<b className="text-ink-200">选择</b>，不再就地新增。
      </p>

      {/* ============ ① 历法清单 ============ */}
      <section>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="flex-1 text-12 font-medium text-ink-200">历法清单</span>
          <span className="w-24 text-10 text-ink-500">数值（越小越早）</span>
          <span className="w-6" />
        </div>

        {rows.length === 0 && (
          <div className="text-11 text-ink-500 py-2">暂无历法 —— 点下方「新增历法」加一个。没有历法时，「历法」列就只能留空。</div>
        )}

        <div className="space-y-1.5">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-2">
              <input
                value={r.name}
                onChange={e => patchRow(r.id, { name: e.target.value })}
                placeholder="历法名称，如 灵历 / 上古历"
                className="flex-1 min-w-0 !py-1.5 text-12"
              />
              <div className="w-24 shrink-0">
                {/* 历法数值可负、可大（表示跨历法先后），故不给 min/max；只要别把 NaN 传下去 */}
                <NumberField
                  value={r.value}
                  onChange={v => patchRow(r.id, { value: v ?? 0 })}
                  className="w-full !py-1.5 text-12"
                />
              </div>
              <Button variant="icon-danger" type="button" size="xs" title="删除这个历法" onClick={() => removeRow(r.id)}>
                <Trash2 size={11} />
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-2">
          <Button variant="secondary" size="xs" onClick={addRow} className="flex items-center gap-1.5">
            <Plus size={11} /> 新增历法
          </Button>
        </div>

        <div className="mt-2 rounded-lg border border-ink-700 bg-ink-850/50 px-3 py-2 text-10 leading-relaxed text-ink-400">
          数值用于<b className="text-ink-200">跨历法的先后顺序与延续性判断</b>：时间轴先按数值排序，再按发生时间。
          如「上古历 = -1」早于「灵历 = 0」。
          <div className="mt-1">
            🔴 <b className="text-ink-200">改名</b>会连带更新已引用旧名的行（历史事件 / 时间脉络），不留孤儿值；
            <b className="text-ink-200">删除</b>只把历法从清单移除，已填的行保留旧名文本（不会清空你的数据）。
          </div>
        </div>
      </section>

      {/* ============ ② 历法规则 ============ */}
      <section className="pt-1 border-t border-ink-700">
        <div className="text-12 font-medium text-ink-200 mb-1.5 mt-3">一年几个月 / 每月几天</div>
        <div className="flex items-start gap-3">
          <label className="flex-1">
            <span className="block text-11 text-ink-300 mb-1">一年几个月</span>
            <NumberField
              value={months}
              onChange={v => setMonths(v ?? DEFAULT_CALENDAR_RULE.monthsPerYear)}
              min={1}
              max={MONTHS_PER_YEAR_MAX}
              className="w-full !py-1.5 text-13"
            />
          </label>
          <label className="flex-1">
            <span className="block text-11 text-ink-300 mb-1">每月几天</span>
            <NumberField
              value={days}
              onChange={v => setDays(v ?? DEFAULT_CALENDAR_RULE.daysPerMonth)}
              min={1}
              max={DAYS_PER_MONTH_MAX}
              className="w-full !py-1.5 text-13"
            />
          </label>
        </div>

        <div className="mt-2 rounded-lg border border-ink-700 bg-ink-850/50 px-3 py-2 text-11 leading-relaxed text-ink-300">
          当前：一年 <b className="text-ink-100">{clean.monthsPerYear}</b> 个月 × 每月{' '}
          <b className="text-ink-100">{clean.daysPerMonth}</b> 天 ＝{' '}
          <b className="text-amber">{daysPerYear(clean)}</b> 天/年。
          <div className="mt-1 text-ink-400">
            ⚠️ 改这项「不会改写已填的日期」：格子里的数字原样保留，只是月份 / 日期的候选范围变了。
            若某个已填日期超出了新范围（如原本填了「12月31日」而新规则每月只有 30 天），
            该格会显示旧值、重新选择时才会落到新范围内。
          </div>
        </div>
      </section>

      {/* 待生效摘要 */}
      {(dirty || renames.length > 0 || removed.length > 0) && (
        <div className="rounded-lg border border-amber/20 bg-amber/5 px-3 py-2 text-10 leading-relaxed text-amber/90">
          {ruleChanged && <div>· 历法规则已改（记得点「保存」）。</div>}
          {addedCount > 0 && <div>· 新增 {addedCount} 个历法。</div>}
          {renames.length > 0 && (
            <div>· 改名 {renames.length} 个：{renames.map(r => `「${r.from}」→「${r.to}」`).join('、')}，保存后会同步到已引用的行。</div>
          )}
          {removed.length > 0 && (
            <div>· 移除 {removed.length} 个：{removed.map(n => `「${n}」`).join('、')}，已填这些历法的行会保留旧名文本。</div>
          )}
        </div>
      )}

      {error && <div className="text-11 text-danger">{error}</div>}

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={save} variant="primary" size="md">保存</Button>
        <Button
          onClick={() => { setMonths(DEFAULT_CALENDAR_RULE.monthsPerYear); setDays(DEFAULT_CALENDAR_RULE.daysPerMonth) }}
          variant="secondary" size="md" className="flex items-center gap-1.5"
          title="只把「一年几个月 / 每月几天」恢复为默认（12 月 × 30 天），不动历法清单"
        >
          <RotateCcw size={12} /> 规则恢复默认
        </Button>
        <Button onClick={onClose} variant="secondary" size="md" className="ml-auto">取消</Button>
      </div>
    </Modal>
  )
}
