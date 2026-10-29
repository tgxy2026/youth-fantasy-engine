import { Button } from '@/components/common/Button'
import { usePersistedEnum } from '@/lib/settings/uiPrefs'
import { DENSITIES, DENSITY_PREF } from '@/lib/settings/density'

/**
 * 界面密度：紧凑 / 舒适。
 *
 * 🔴 两种排布（主人 2026-10-29 要求）：
 *   · 默认（`inline=false`）—— 带标题与说明的整块，用在左下数据坞里；
 *   · `inline` —— 只留两个开关，塞进「界面缩放」那一行的右侧空白处（侧栏底部）。
 *     外观设置里因此**不再**出现密度（那里只留主题 / 字体 / 背景）。
 */
export default function DensityControl({ inline = false }: { inline?: boolean }) {
  const [density, setDensity] = usePersistedEnum(DENSITY_PREF, DENSITIES, 'compact')
  const toggles = (
    <>
      <Button variant="toggle" size="xs" selected={density === 'compact'} aria-pressed={density === 'compact'}
        onClick={() => setDensity('compact')} title="紧凑：控件与面板间距更小，一屏看到更多">紧凑</Button>
      <Button variant="toggle" size="xs" selected={density === 'comfortable'} aria-pressed={density === 'comfortable'}
        onClick={() => setDensity('comfortable')} title="舒适：控件与面板之间留更多呼吸感">舒适</Button>
    </>
  )
  if (inline) {
    return (
      // 🔴 与左侧「缩放胶囊」同一套外壳（同样的 border/bg/px-2/py-1 ⇒ 同为 32px 高），
      //    否则两个开关只有 24px，和胶囊并排会显得矮一截、上下不齐（主人 2026-10-29 特别提醒）。
      <div className="flex shrink-0 items-center gap-1 rounded-lg border border-ink-700 bg-ink-800/40 px-2 py-1" role="group" aria-label="界面密度"
        title="界面密度：调整控件与面板间距（正文字号与排版保持不变）">
        {toggles}
      </div>
    )
  }
  return (
    <div className="space-y-1.5" data-density-control>
      <div className="text-12 text-ink-300">界面密度</div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="界面密度">
        {toggles}
      </div>
      <p className="text-11 text-ink-400 leading-relaxed">调整控件和面板间距，正文字号与排版保持不变。</p>
    </div>
  )
}
