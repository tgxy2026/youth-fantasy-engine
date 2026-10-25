import { Button } from '@/components/common/Button'
import { usePersistedEnum } from '@/lib/settings/uiPrefs'
import { DENSITIES, DENSITY_PREF } from '@/lib/settings/density'

export default function DensityControl() {
  const [density, setDensity] = usePersistedEnum(DENSITY_PREF, DENSITIES, 'compact')
  return (
    <div className="space-y-1.5" data-density-control>
      <div className="text-12 text-ink-300">界面密度</div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="界面密度">
        <Button variant="toggle" size="xs" selected={density === 'compact'} aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>紧凑</Button>
        <Button variant="toggle" size="xs" selected={density === 'comfortable'} aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}>舒适</Button>
      </div>
      <p className="text-11 text-ink-400 leading-relaxed">调整控件和面板间距，正文字号与排版保持不变。</p>
    </div>
  )
}
