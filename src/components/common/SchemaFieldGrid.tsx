/**
 * schema 驱动的字段网格（按模块分组渲染字段输入框）。
 *
 * 从 `FormSheet` 抽出来（C10 · 2.4.2）—— 因为「世界设定 / 力量体系」改成**母子结构**后，
 * 母级表单与每个子世界表单要渲染的是**同一套字段**（同一个 `tab.modules`）。
 * 抽出来共用，就不会出现「母级能填、子级样式不一样」或「一边改了另一边没改」的漂移。
 *
 * 🔴 纯搬家：JSX 与 class 一字未改，只把 `setField` 换成外部传入的 `onFieldChange`。
 */
import { useMemo } from 'react'
import { Info } from 'lucide-react'
import AutoTextarea from '@/components/common/AutoTextarea'
import type { TabDef } from '@/lib/types'
import { useFieldDisplayLabels } from '@/lib/templates/useFieldRenames'

interface Props {
  /** schema 的模块清单 */
  modules: NonNullable<TabDef['modules']>
  /** 字段值（键为 `模块名::字段名`） */
  data: Record<string, string>
  /** 字段改动回调（键为 `模块名::字段名`） */
  onFieldChange: (key: string, value: string) => void
  /**
   * 宽屏两列。
   * 开书定位 / 大纲规划 这类「字段多、屏幕宽」的页签开；嵌在窄栏里（如母级表单）时关掉。
   */
  twoColumn?: boolean
  /**
   * 所属页签 id：**传了才启用字段显示名**（2.7.3）。
   * 别名只改界面上这行字，取值仍走 `模块名::字段名` 这个存储键 —— 已填数据不受影响。
   */
  tabId?: string
}

export default function SchemaFieldGrid({ modules, data, onFieldChange, twoColumn = false, tabId }: Props) {
  /** 字段显示名（2.7.3）：母级表单、子世界、制度四页签都走这里，传 tabId 即自动生效 */
  const keys = useMemo(
    () => modules.flatMap(m => m.fields.map(f => `${m.name}::${f.name}`)),
    [modules],
  )
  const aliasLabels = useFieldDisplayLabels(tabId ?? '', keys)
  return (
    <div className={`@container/fields ${twoColumn
      ? 'grid grid-cols-1 xl:grid-cols-2 gap-5 items-start'
      : 'grid grid-cols-1 2xl:grid-cols-2 gap-5 items-start'}`}>
      {modules.map(mod => (
        <section key={mod.name} className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden h-full">
          <div className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
            <span className="w-1 h-3.5 rounded-full bg-amber/70" />
            <h2 className="text-13 font-semibold text-ink-100">{mod.name}</h2>
            <span className="text-10 text-ink-500 ml-auto">{mod.fields.length} 项</span>
          </div>
          <div className="divide-y divide-ink-700/60">
            {mod.fields.map(field => {
              const key = `${mod.name}::${field.name}`
              const val = data[key] ?? ''
              return (
                <div key={key} className="px-3 py-3 grid grid-cols-1 @min-[32rem]/fields:grid-cols-[160px_minmax(0,1fr)] gap-2 @min-[32rem]/fields:gap-4 hover:bg-ink-800/40 transition-colors">
                  <div>
                    <div
                      className="text-13 font-medium text-ink-100"
                      title={aliasLabels[key] === field.name ? undefined : `${field.name}（存储键不变，AI 按当前名称理解）`}
                    >{aliasLabels[key]}</div>
                    {field.desc && <div className="field-desc mt-1">{field.desc}</div>}
                  </div>
                  <div>
                    <AutoTextarea
                      value={val}
                      onChange={v => onFieldChange(key, v)}
                      placeholder="点击填写…"
                      textClass="text-13"
                      minHeight={36}
                    />
                    {!val && field.example && (
                      <div className="field-example flex items-start gap-1 mt-1">
                        <Info size={10} className="mt-0.5 shrink-0" />
                        <span>示例：{field.example}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
