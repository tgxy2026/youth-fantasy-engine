import { Button } from '@/components/common/Button'
import { usePersistedEnum } from '@/lib/settings/uiPrefs'
import { DENSITIES, DENSITY_PREF } from '@/lib/settings/density'

/**
 * 界面密度：紧凑 / 舒适。
 *
 * 🔴 两种排布（主人 2026-10-29 要求）：
 *   · 默认（`inline=false`）—— 带标题与说明的整块，两个开关并列，用在项目管理的「数据坞」里；
 *   · `inline` —— **单键切换**，塞进「界面缩放」那一行的右侧（侧栏底部）。
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
    // 🔴 侧栏最窄 224px（内容区 200px）里，「缩放胶囊 + 两个密度开关」放不下 ⇒ 会折成两行
    //    （主人 2026-10-29 复现并要求「别变成两行」）。这里改成**一枚切换键**：显示当前档，
    //    点一下切另一档，宽度只相当于原来一个开关；外壳仍与缩放胶囊同一套（同 border/bg/py-1
    //    ⇒ 同为 32px 高、上下对齐）。
    const next = density === 'compact' ? 'comfortable' : 'compact'
    const label = density === 'compact' ? '紧凑' : '舒适'
    const nextLabel = next === 'compact' ? '紧凑' : '舒适'
    return (
      <div className="flex shrink-0 items-center rounded-lg border border-ink-700 bg-ink-800/40 px-1 py-1" role="group" aria-label="界面密度">
        <Button
          variant="toggle" size="xs" selected
          className="!px-1 !text-11"
          aria-pressed={density === 'comfortable'}
          aria-label={`界面密度：当前${label}，点击切到${nextLabel}`}
          title={`界面密度：当前「${label}」—— 点一下切到「${nextLabel}」（只调整控件与面板间距，正文字号与排版不变）`}
          onClick={() => setDensity(next)}
        >
          {label}
        </Button>
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
