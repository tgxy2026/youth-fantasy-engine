/**
 * 「页签显示」控件（2.7.1 · B 案）—— 让**完整项目**也能手动开启被题材矩阵隐藏的页签。
 *
 * ## 为什么需要它
 * 完整项目按题材矩阵（`schemaTemplates.packShowsTab`）决定六个受题材页签的显隐。
 * `东方修真` 把四个制度页签**全关**、无超自然三包把 `power` 也**关掉**（换来老项目 /
 * 示范项目界面零变更）——
 * 可作者若真写了修真文却想要「政治架构」，此前**毫无入口**：`tabVisible` 里只有
 * **自定义项目**才按 `features` 勾选，完整项目没有功能勾选 UI。本控件补上这个口子。
 *
 * ## 两条硬约定
 * ① **复用 `Project.features`**：在完整项目里它只承载「手动补开的页签 id」这一种含义，
 *    与自定义项目里那份「功能全集」同字段不同语义 —— `tabVisible` 按 `ctx.type` 分流，永不混读。
 *    （ProjectHub 的功能勾选按钮只在 `projectType === 'custom'` 下渲染，故这份数据不会被污染。）
 * ② **只补开、不关闭**：题材矩阵给了哪些就留哪些，本控件只往里加。
 *    `tabVisible` 用 `矩阵 || features` 实现；「关掉矩阵给的页签」不在本轮范围。
 *
 * ## 落库与联动
 * 落库（`updateProject`）后派发 `yfe:tabs-changed`，由 App 重读 features 更新 `visCtx`
 * 并 bump `refreshKey` —— 同 `yfe:pack-changed` 的既有范式（入口在页签组件内，状态在 App）。
 */
import { useCallback, useEffect, useState } from 'react'
import { ListChecks } from 'lucide-react'
import * as db from '../lib/db'
import { PACK_TAB_IDS, packShowsTab, type GenrePack } from '../lib/schemaTemplates'
import { getTab } from '../lib/schema'
import { Z } from '../lib/zLayer'
import { Button } from './Button'
import { showToast } from './dialogs'

/** 本控件管辖的六个受题材驱动页签（与 `tabVisible` 的题材维度同一作用域） */
const MANAGED: readonly string[] = PACK_TAB_IDS

export default function TabVisibilityControl({ pack }: { pack: GenrePack }) {
  const [open, setOpen] = useState(false)
  /** 已手动补开的页签 id（= 完整项目 features 里属于 MANAGED 的那部分） */
  const [extra, setExtra] = useState<string[]>([])
  /** null = 还没读到项目 —— 先不渲染，免得在自定义项目里闪一下再消失 */
  const [isFull, setIsFull] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const pid = db.getCurrentProjectId?.()
    if (!pid) { setIsFull(null); return }
    const p = await db.getProject(pid).catch(() => undefined)
    if (!p) { setIsFull(null); return }
    setIsFull((p.projectType ?? 'full') !== 'custom')
    setExtra((p.features ?? []).filter(id => MANAGED.includes(id)))
  }, [])

  useEffect(() => { void load() }, [load])

  async function toggle(id: string, on: boolean) {
    const pid = db.getCurrentProjectId?.()
    if (!pid || busy) return
    setBusy(true)
    try {
      const p = await db.getProject(pid)
      // 保底：features 里若混入不属于本控件管辖的项，原样保留（只动这六个页签的开关）
      const base = (p?.features ?? []).filter(x => !MANAGED.includes(x))
      const next = on ? [...new Set([...extra, id])] : extra.filter(x => x !== id)
      await db.updateProject({ id: pid, features: [...base, ...next] })
      setExtra(next)
      window.dispatchEvent(new CustomEvent('yfe:tabs-changed', { detail: next }))
      const name = getTab(id)?.name ?? id
      showToast(on ? `已开启「${name}」页签` : `已隐藏「${name}」页签`, 'success')
    } catch {
      showToast('页签显示设置保存失败，请重试', 'error')
    } finally {
      setBusy(false)
    }
  }

  // 自定义项目走它自己的「功能模块」勾选，本控件不插手
  if (isFull !== true) return null

  /** 当前题材下被隐藏的受题材页签 = 可补开的候选 */
  const hidden = PACK_TAB_IDS.filter(id => !packShowsTab(pack, id))

  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(o => !o)}
        title="手动开启被当前题材隐藏的页签（只补开、不影响已有内容）"
      >
        <ListChecks size={12} /> 页签{extra.length > 0 ? ` +${extra.length}` : ''}
      </Button>

      {open && (
        <>
          {/* 点击遮罩：点空白处收起（页内层，避免盖住弹窗） */}
          <div className="fixed inset-0" style={{ zIndex: Z.pagePanel }} onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 top-full mt-1.5 w-[20rem] rounded-lg border border-ink-700 bg-ink-850 shadow-xl p-3"
            style={{ zIndex: Z.pagePanelTop }}
          >
            <div className="text-11 text-ink-300 mb-1">
              当前题材：<b className="text-amber">{pack}</b>
            </div>
            <div className="text-10 text-ink-500 leading-relaxed mb-2">
              {hidden.length > 0
                ? '下面这些页签被这个题材默认隐藏，可单独打开 —— 只补开、不动你已填的内容。'
                : '这个题材已默认显示全部相关页签，无需补开。'}
            </div>

            {hidden.map(id => {
              const on = extra.includes(id)
              return (
                <label
                  key={id}
                  className="flex items-center gap-2 px-1.5 py-1.5 rounded-md hover:bg-ink-800 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy}
                    onChange={e => void toggle(id, e.target.checked)}
                  />
                  <span className="text-12 text-ink-100">{getTab(id)?.name ?? id}</span>
                  <span className={`ml-auto text-10 ${on ? 'text-amber' : 'text-ink-500'}`}>
                    {on ? '已开启' : '隐藏中'}
                  </span>
                </label>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
