import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/common/Button'
import { StyleProfileDialog } from '@/components/settings/StyleProfileDialog'
import {
  loadFingerprints, loadActiveFingerprintId, saveActiveFingerprintId, type StyleProfile,
} from '@/lib/ai/styleFingerprint'

/**
 * 「文风档」选择器（2.8.0 · 台账 #015）—— 伴写设置窗与创意写作面板**共用同一条实现**。
 *
 * 🔴 只有这一处实现：两处各写一份必然漂移（一处改了另一处不生效，本项目为此吃过亏）。
 * 🔴 文风档**按项目存**（`settingsKV` 的 `<pid>::styleFingerprints` / `activeStyleFingerprint`，
 *    内存缓存带 pid 比对 ⇒ 切项目自动失效），不进组件的 value / inputs —— 换书各用各的，由作者自己决定要不要换。
 *    本组件的读取时机＝挂载时（切页签＝卸载组件＝重挂载，所以跨面板也是新的），
 *    本组件自己触发的变更（换档 / 提炼 / 删除）即时同步。
 */
export function StyleProfilePicker({ ownerTab, hint, boxed = true }: {
  /** 发起「提炼文风档」任务的页签 id（结果归属与「点回去看」靠它） */
  ownerTab: string
  /** 说明文案（缺省用通用一句） */
  hint?: string
  /** 是否自带边框卡片；false 则由调用方提供容器（外层已有一层框时用） */
  boxed?: boolean
}) {
  const [profiles, setProfiles] = useState<StyleProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [manageOpen, setManageOpen] = useState(false)

  const reload = useCallback(async () => {
    const [ls, id] = await Promise.all([loadFingerprints(), loadActiveFingerprintId()])
    setProfiles(ls)
    setActiveId(id)
  }, [])

  useEffect(() => { void reload() }, [reload])

  const change = async (id: string) => {
    await saveActiveFingerprintId(id)
    setActiveId(id)
  }

  return (
    <div data-style-picker className={boxed ? 'space-y-1.5 rounded-lg border border-ink-700 bg-ink-800/40 p-2.5' : 'space-y-1.5'}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-ink-200 text-12 shrink-0">文风档</span>
        <span className="text-ink-500 text-10">{hint ?? '按你提炼的文风落笔；与其它设置互不覆盖'}</span>
      </div>
      <div className="flex items-center gap-2">
        {/* 下拉与右侧按钮**同高同字号**（h-8 / text-12）：2026-10-14 主人反馈按钮原来的 xs 档
            （h-6 · text-11）比下拉矮一截、文字挤出格，故两侧对齐到 sm 档基线。
            🔴 不在这里叠 h-* / px-* / text-* —— SIZE 基线已含尺寸，叠了就是开盲盒（见 Button.tsx U-2）。 */}
        <select
          value={profiles.some(p => p.id === activeId) ? activeId : ''}
          onChange={e => void change(e.target.value)}
          className="h-8 flex-1 bg-ink-800 border border-ink-700 rounded px-2 text-12 text-ink-100 outline-none focus:border-amber/40"
        >
          <option value="">（不使用文风档）</option>
          {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Button variant="secondary" size="sm" className="shrink-0 whitespace-nowrap" onClick={() => setManageOpen(true)}>
          管理文风档…
        </Button>
      </div>
      {!profiles.length && (
        <div className="text-ink-500 text-10 leading-relaxed">
          还没有文风档 —— 点「管理文风档…」，粘贴一段参考文本就能生成一份。
        </div>
      )}
      <StyleProfileDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        ownerTab={ownerTab}
        onChanged={() => void reload()}
      />
    </div>
  )
}
