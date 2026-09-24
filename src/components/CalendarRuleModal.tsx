/**
 * 「历法规则」编辑弹窗（2.4.4）：一年几个月、一个月几天。
 *
 * 为什么单独一个文件而不是塞进 TableSheet：表头那一排按钮已经很挤，
 * 再把两个数字输入 + 说明 + 复位逻辑摊进去，会把「页面骨架」和「一处设置」混在一起。
 *
 * 🔴 说明文案里必须写清**影响范围**：改了它之后，已经填好的日期不会自动换算
 *    （比如 12 月 × 30 天时填的「3024年12月30日」，改成 20 月 × 40 天后仍是那串字，
 *    只是它在新规则下变成了「第 12 月第 30 天」—— 月份的**序号**变了但数字没变）。
 *    不写清楚，作者会以为引擎偷偷改了他的数据。
 */
import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { CalendarRule } from '../lib/types'
import {
  DAYS_PER_MONTH_MAX, DEFAULT_CALENDAR_RULE, MONTHS_PER_YEAR_MAX,
  clampCalendarRule, daysPerYear,
} from '../lib/storyDate'
import { Modal } from './Modal'
import { Button } from './Button'
import NumberField from './NumberField'

interface Props {
  open: boolean
  rule: CalendarRule
  onSave: (next: CalendarRule) => void
  onClose: () => void
}

export default function CalendarRuleModal({ open, rule, onSave, onClose }: Props) {
  const [months, setMonths] = useState(rule.monthsPerYear)
  const [days, setDays] = useState(rule.daysPerMonth)

  const clean = clampCalendarRule({ monthsPerYear: months, daysPerMonth: days })
  const changed = clean.monthsPerYear !== rule.monthsPerYear || clean.daysPerMonth !== rule.daysPerMonth

  const save = () => {
    onSave(clean)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="历法规则" width={420} bodyClassName="p-4 space-y-3">
      <p className="text-11 leading-relaxed text-ink-400">
        架空世界不必照搬地球公历。这里定下「一年几个月、每月几天」，表格里月份与日期的下拉、
        以及时间轴的持续时长都按它来算。
      </p>

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

      <div className="rounded-lg border border-ink-700 bg-ink-850/50 px-3 py-2 text-11 leading-relaxed text-ink-300">
        当前：一年 <b className="text-ink-100">{clean.monthsPerYear}</b> 个月 × 每月{' '}
        <b className="text-ink-100">{clean.daysPerMonth}</b> 天 ＝{' '}
        <b className="text-amber">{daysPerYear(clean)}</b> 天/年。
        <div className="mt-1 text-ink-400">
          ⚠️ 改这项「不会改写已填的日期」：格子里的数字原样保留，只是月份 / 日期的候选范围变了。
          若某个已填日期超出了新范围（如原本填了「12月31日」而新规则每月只有 30 天），
          该格会显示旧值、重新选择时才会落到新范围内。
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button onClick={save} variant="primary" size="md" className="text-13">保存</Button>
        <Button
          onClick={() => { setMonths(DEFAULT_CALENDAR_RULE.monthsPerYear); setDays(DEFAULT_CALENDAR_RULE.daysPerMonth) }}
          variant="secondary" size="md" className="flex items-center gap-1.5 text-13"
          title="恢复默认：一年 12 个月、每月 30 天（共 360 天）"
        >
          <RotateCcw size={12} /> 恢复默认
        </Button>
        <Button onClick={onClose} variant="secondary" size="md" className="ml-auto text-13">取消</Button>
      </div>
      {changed && (
        <div className="text-10 text-amber">改完记得保存。</div>
      )}
    </Modal>
  )
}
