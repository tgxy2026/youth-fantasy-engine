// ============ 引导设置（3.3.1 · P2） ============
//
// 规划 §3.3：「首步提供关闭自动引导，之后可在帮助设置恢复」「提供重置本页与重置全部引导记录，
// 不影响业务数据和缩放等其他偏好」。这里就是那个「恢复 / 重置」的地方。
//
// 🔴 只动引导偏好，绝不动项目数据、缩放、主题、折叠状态。
// 🔴 重置要确认：清空后所有页签会重新自动弹，属于「会被立刻感知」的操作，不能一键静默执行。
import { useCallback, useEffect, useState } from 'react'
import { Compass, RotateCcw } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { confirmDialog, showToast } from '@/components/dialogs/dialogs'
import {
  guideRecordCount, guideStorageScope, isGuideAutoEnabled, resetAllGuides, setGuideAutoEnabled,
  subscribeGuidePrefs,
} from '@/lib/settings/guidePrefs'

export function GuideSettings() {
  const [auto, setAuto] = useState(() => isGuideAutoEnabled())
  const [count, setCount] = useState(() => guideRecordCount())
  const scope = guideStorageScope()

  // 同窗口改开关（引导卡片首步的「以后不再自动弹出」）与跨窗口改动都要同步到这里
  useEffect(() => subscribeGuidePrefs(() => {
    setAuto(isGuideAutoEnabled())
    setCount(guideRecordCount())
  }), [])

  const toggle = useCallback((next: boolean) => {
    setGuideAutoEnabled(next)
    setAuto(next)
    showToast(next ? '已开启自动引导：进入还没看过的页签会自动分步介绍' : '已关闭自动引导：随时可从页头「本页指引」重新查看', 'info')
  }, [])

  const reset = useCallback(async () => {
    const ok = await confirmDialog({
      title: '重置引导记录',
      message: '清空「已看过 / 已跳过」记录后，进入各页签时会重新自动分步介绍。\n\n只影响引导记录，不影响任何项目数据、界面缩放与主题。',
    })
    if (!ok) return
    resetAllGuides()
    setCount(0)
    showToast('已重置引导记录', 'success')
  }, [])

  return (
    <section data-guide-settings="" className="bg-ink-850 rounded-xl border border-ink-700 overflow-hidden">
      <header className="px-5 py-3 bg-ink-800 border-b border-ink-700 flex items-center gap-2">
        <Compass size={14} className="text-amber" />
        <h2 className="text-13 font-semibold text-ink-100">分步引导</h2>
        <span className="text-10 text-ink-500">首次进入页签时的聚焦介绍</span>
      </header>
      <div className="p-5 space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-12 text-ink-200 flex-1 min-w-0">
            进入还没看过的页签时，自动分步介绍这一页怎么用
          </span>
          <Button variant="toggle" size="sm" selected={auto} onClick={() => toggle(!auto)}
            aria-pressed={auto} aria-label="自动分步引导">
            {auto ? '已开启' : '已关闭'}
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-11 text-ink-400 flex-1 min-w-0">
            已记录 {count} 个页签{scope === 'session' ? '（当前网页版没有稳定的账号标识，记录只在本次打开有效）' : ''}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void reset()} className="flex items-center gap-1.5">
            <RotateCcw size={11} /> 重置引导记录
          </Button>
        </div>
        <p className="text-11 text-ink-500 leading-relaxed">
          引导只做说明：它不会替你新建记录、填写正文或调用模型。看过的页签不会重复弹出，随时可以点页头的「本页指引」重看。
        </p>
      </div>
    </section>
  )
}
