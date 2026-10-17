/**
 * 应用图标切换（3.1.2）—— 桌面 / 开始菜单快捷方式的图标换成本机预置的三套之一。
 *
 * 【边界，先说清楚（界面上也照实写）】
 *   · **只改快捷方式**（`.lnk` 的 IconLocation）：桌面那条 + 开始菜单那条，一起改。
 *   · **不改程序自身**：`YouthFantasyEngine.exe` 的图标是 PE 资源，改它要重写二进制
 *     （并会让主 exe 体积偏离基线）⇒ 这一版明确不做。
 *   · **升级会自动补回**：覆盖安装时 NSIS 会重建快捷方式（图标回默认），下次启动主进程自愈。
 *   · 非 Windows / 便携版没有 `.lnk` ⇒ 入口只在支持的形态下出现（由 `appIconSupported()` 决定）。
 *
 * 【存储】偏好由**主进程**保管（`<userData>/app-icon.json`）—— 因为启动自愈发生在渲染层起来之前。
 *   本弹窗每次打开都向主进程查询当前生效值，不自己缓存一套（避免两份真源打架）。
 */
import { useEffect, useState } from 'react'
import { Check, Image as ImageIcon, Loader2, RotateCcw } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import HelpPopover from '@/components/common/HelpPopover'
import { showToast } from '@/components/dialogs/dialogs'
import {
  applyAppIcon, currentAppIcon, listAppIconPresets, resetAppIcon, type AppIconPreset,
} from '@/lib/app/desktop'

export default function AppIconDialog({ onClose }: { onClose: () => void }) {
  const [presets, setPresets] = useState<AppIconPreset[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    ;(async () => {
      const [list, cur] = await Promise.all([listAppIconPresets(), currentAppIcon()])
      if (!alive) return
      setPresets(list)
      setActiveKey(cur.key)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [])

  const apply = async (key: string) => {
    if (busyKey) return
    setErr('')
    setBusyKey(key)
    try {
      const r = key === 'default' ? await resetAppIcon() : await applyAppIcon(key)
      if (!r.ok) {
        setErr(r.error || '切换失败')
        return
      }
      setActiveKey(r.key ?? key)
      // 部分成功（比如开始菜单那条被占用）如实说，别只报「成功」
      if (r.failed?.length) {
        showToast(`已应用，但有 ${r.failed.length} 处未写入：${r.failed.join('；')}`, 'info', 6000)
      } else {
        showToast('桌面图标已切换（桌面 / 开始菜单同时生效）', 'success')
      }
    } finally {
      setBusyKey(null)
    }
  }

  const labelOf = (k: string | null) => presets.find(p => p.key === k)?.label ?? '（未知）'

  return (
    <Modal
      open
      onClose={onClose}
      title="应用图标"
      icon={<ImageIcon size={15} />}
      width={520}
      footerAlign="end"
      footer={<Button onClick={onClose} variant="secondary" size="md">完成</Button>}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-1.5 text-11 text-ink-400 leading-relaxed">
          <span className="flex-1">
            选择桌面快捷方式的图标（桌面与开始菜单同时生效）。当前：
            <span className="text-ink-200">{loading ? '读取中…' : labelOf(activeKey)}</span>
          </span>
          {/* 设置类说明窗：按 HelpPopover 的约定传 pin（鼠标移出不关，只有再点/点外/Esc 才关） */}
          <HelpPopover title="这个开关改的是什么" pin>
            <div className="space-y-1.5 leading-relaxed">
              <p>· 只改**桌面与开始菜单的快捷方式**图标，随时可以换回来；</p>
              <p>· **程序自身的图标不变** —— 那属于程序文件的一部分，改装它要重写二进制，本版不做；</p>
              <p>· 覆盖安装新版本后快捷方式会被重建，本程序**下次启动会自动把图标补回**；</p>
              <p>· 这些图标都在本机，不上传、不联网。</p>
            </div>
          </HelpPopover>
        </div>

        {err && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-11 text-danger">{err}</div>
        )}

        <div className="grid grid-cols-3 gap-3">
          {loading && (
            <div className="col-span-3 flex items-center gap-2 text-11 text-ink-400">
              <Loader2 size={12} className="animate-spin" /> 正在读取内置图标…
            </div>
          )}
          {presets.map(p => {
            const active = p.key === activeKey
            const busy = busyKey === p.key
            return (
              <button
                key={p.key}
                type="button"
                disabled={!!busyKey}
                onClick={() => void apply(p.key)}
                title={active ? `当前使用：${p.label}` : `切换为「${p.label}」`}
                className={
                  'group flex flex-col items-center gap-2 rounded-xl border px-3 py-3 transition-colors disabled:opacity-60 ' +
                  (active
                    ? 'border-amber/60 bg-amber/10'
                    : 'border-ink-700 bg-ink-850 hover:border-amber/40 hover:bg-ink-800')
                }
              >
                <span className="relative flex h-16 w-16 items-center justify-center">
                  {p.preview
                    ? <img src={p.preview} alt={p.label} className="h-16 w-16 rounded-lg" draggable={false} />
                    : <span className="flex h-16 w-16 items-center justify-center rounded-lg border border-ink-700 text-10 text-ink-500">无预览</span>}
                  {busy && (
                    <span className="absolute inset-0 flex items-center justify-center rounded-lg bg-ink-950/60">
                      <Loader2 size={14} className="animate-spin text-amber" />
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1 text-11">
                  {active && <Check size={11} className="text-amber" />}
                  <span className={active ? 'text-amber' : 'text-ink-300'}>{p.label}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
          <span className="text-11 text-ink-500">想回到出厂状态？把图标指回程序自身的那个。</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!!busyKey || activeKey === 'default'}
            onClick={() => void apply('default')}
            className="shrink-0"
          >
            <RotateCcw size={12} /> 恢复默认
          </Button>
        </div>
      </div>
    </Modal>
  )
}
