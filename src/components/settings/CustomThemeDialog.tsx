/**
 * 自定义主题弹窗（2.5.0 · C1）—— 母版 + 强调色 + 色相偏移，三参数实时预览。
 *
 * 🔴 预览与生效分离：
 *    · 拖参数 → applyCustomTheme 即时生效（内联变量 + CUSTOM_KEY 参数落盘）；
 *    · yfe-theme 只在点「应用」时才落盘为 'custom'；
 *    · 关闭（未应用）→ 回滚到打开前状态：
 *        打开前就是 custom → 用打开时的参数快照重放（applyCustomTheme 会把 CUSTOM_KEY 写回旧值）；
 *        打开前不是 custom → 删参数、applyTheme 回原主题（顺带清全部内联变量）。
 *    · 快照必须在**打开时**存下 —— 预览已经把 CUSTOM_KEY 覆盖了，关闭时再读只能读到预览值。
 *
 * 🔴 首次打开（无已存参数）不立即预览：中性参数的恒等派生有取整级色差，
 *    没必要让用户一打开弹窗就看到界面「闪」一下；改第一个参数才开始预览。
 */
import { useEffect, useRef, useState } from 'react'
import { Palette } from 'lucide-react'
import { Modal } from '@/components/dialogs/Modal'
import { Button } from '@/components/common/Button'
import {
  THEMES, applyTheme, applyCustomTheme, getStoredCustomTheme, getStoredTheme,
  type CustomThemeParams, type CustomThemeBaseId, type ThemeId, type CustomThemeVars,
} from '@/lib/settings/theme'

type BaseId = CustomThemeBaseId

// 🔴 mono（纯黑白）是严格二值预制，不进派生链（见 theme.ts 的 CustomThemeBaseId 注释）
const BASE_THEMES = THEMES.filter(t => t.id !== 'custom' && t.id !== 'mono') as Array<{ id: BaseId; name: string; desc: string }>

/** accent 为空时拾色器的占位色（暗夜母版的 amber，仅展示用途，不代表当前生效值） */
const ACCENT_PLACEHOLDER = '#d9a04a'

interface Props {
  open: boolean
  /** 关闭（未应用）：弹窗内部已先回滚，父组件只需同步主题 state */
  onClose: () => void
  /** 已应用：yfe-theme 已落盘为 'custom'，父组件同步 state 即可 */
  onApplied: () => void
}

export default function CustomThemeDialog({ open, onClose, onApplied }: Props) {
  const [baseId, setBaseId] = useState<BaseId>('eye-care')
  const [accent, setAccent] = useState('')
  const [hueShift, setHueShift] = useState(0)
  /** 打开时的参数快照：回滚依据 + 「清除自定义」按钮显隐 */
  const [saved, setSaved] = useState<CustomThemeParams | null>(null)
  const prevThemeRef = useRef<ThemeId>('eye-care')
  const rafRef = useRef(0)
  /** 最近一次派生是否触发了强调色守卫微调（提示用） */
  const [adjusted, setAdjusted] = useState(false)

  useEffect(() => {
    if (!open) return
    const snap = getStoredCustomTheme()
    setSaved(snap)
    prevThemeRef.current = getStoredTheme()
    if (snap) {
      setBaseId(snap.baseId)
      setAccent(snap.accent)
      setHueShift(snap.hueShift)
    } else {
      const cur = getStoredTheme()
      // custom（无参数可载）与 mono（不进派生链）都不能当母版 → 回默认护眼母版
      const base: BaseId = cur === 'custom' || cur === 'mono' ? 'eye-care' : cur
      setBaseId(base)
      setAccent('')
      setHueShift(0)
    }
    setAdjusted(false)
  }, [open])

  /** 实时预览：raf 节流 —— 拖滑杆时 input 事件频率高，每帧最多派生一次 */
  const preview = (p: CustomThemeParams) => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const r: CustomThemeVars | null = applyCustomTheme(p)
      setAdjusted(!!r?.accentAdjusted)
    })
  }

  const update = (patch: Partial<CustomThemeParams>) => {
    const next: CustomThemeParams = { baseId, accent, hueShift, ...patch }
    setBaseId(next.baseId)
    setAccent(next.accent)
    setHueShift(next.hueShift)
    preview(next)
  }

  /** 回滚到打开前状态（取消 / Esc / 遮罩关闭共用） */
  const rollback = () => {
    cancelAnimationFrame(rafRef.current)
    if (prevThemeRef.current === 'custom' && saved) {
      applyCustomTheme(saved) // 重放旧参数（CUSTOM_KEY 一并写回旧值）
    } else {
      // prev 不是 custom：删掉预览期间写入的参数、切回原主题。
      // （prev === 'custom' 但 saved 为空属脏状态：applyTheme('custom') 内部会兜底回 eye-care）
      try { localStorage.removeItem('yfe-custom-theme') } catch { /* 忽略隐私模式 */ }
      applyTheme(prevThemeRef.current)
    }
  }

  const handleClose = () => {
    rollback()
    onClose()
  }

  const handleApply = () => {
    cancelAnimationFrame(rafRef.current)
    applyTheme('custom') // 内部读 CUSTOM_KEY（最后一次预览已写入）重算并落 yfe-theme
    onApplied()
  }

  /** 清除自定义：删参数并离开 custom；打开前就是 custom 则回「母版原色」 */
  const handleClear = () => {
    cancelAnimationFrame(rafRef.current)
    try { localStorage.removeItem('yfe-custom-theme') } catch { /* 忽略隐私模式 */ }
    const target: ThemeId = prevThemeRef.current === 'custom' && saved ? saved.baseId : prevThemeRef.current
    applyTheme(target)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="自定义主题"
      icon={<Palette size={15} />}
      width="md"
      footer={
        <div className="flex w-full items-center justify-between">
          <div>
            {saved && (
              <Button variant="secondary" size="sm" onClick={handleClear} title="删除自定义主题参数，回到母版原色">
                清除自定义
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={handleClose}>取消</Button>
            <Button variant="primary" size="sm" onClick={handleApply}>应用</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* 母版 */}
        <div>
          <div className="text-13 text-ink-200 mb-1.5">母版主题</div>
          <select
            value={baseId}
            onChange={e => update({ baseId: e.target.value as BaseId })}
            className="w-full rounded border border-ink-700 bg-ink-950 px-2 py-1.5 text-13 text-ink-200 outline-none focus:border-amber"
          >
            {BASE_THEMES.map(t => (
              <option key={t.id} value={t.id}>{t.name}（{t.desc}）</option>
            ))}
          </select>
          <p className="text-11 text-ink-400 mt-1">自定义在母版的基础上派生：先选一套基调，再调下面两个参数。</p>
        </div>

        {/* 强调色 */}
        <div>
          <div className="text-13 text-ink-200 mb-1.5">强调色</div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={accent || ACCENT_PLACEHOLDER}
              onChange={e => update({ accent: e.target.value })}
              className="h-7 w-10 rounded border border-ink-700 bg-ink-950 cursor-pointer p-0.5"
              title="选择强调色"
              aria-label="选择强调色"
            />
            <Button variant="toggle" size="xs" selected={!accent} onClick={() => update({ accent: '' })}
              title={accent ? '放弃自选色，改用母版自带的强调色' : '当前正使用母版自带的强调色'}>
              跟随母版
            </Button>
            <span className="text-11 text-ink-400 truncate">
              {accent ? '自选色参与色相偏移' : '使用母版自带的强调色'}
            </span>
          </div>
          {adjusted && (
            <p className="text-11 text-amber mt-1">强调色明度已自动微调，以保证与背景的可读性</p>
          )}
        </div>

        {/* 色相偏移 */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-13 text-ink-200">色相偏移</span>
            <span className="text-12 text-ink-300 tabular-nums">{hueShift > 0 ? `+${hueShift}` : hueShift}°</span>
          </div>
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={hueShift}
            onChange={e => update({ hueShift: Number(e.target.value) })}
            className="w-full"
            style={{ accentColor: 'var(--amber)' }}
            aria-label="色相偏移角度"
          />
          <div className="flex justify-between text-11 text-ink-400">
            <span>−180°</span>
            <span>0°（不偏移）</span>
            <span>+180°</span>
          </div>
        </div>

        {/* 说明 */}
        <div className="rounded border border-ink-700 bg-ink-900/50 px-3 py-2 text-11 text-ink-400 leading-relaxed">
          参数改动会实时预览：满意点「应用」保存，未应用直接关闭会自动还原到打开前的主题。
          这里只保存三个参数，以后升级派生算法时，你的配色会自动跟着变好看。
        </div>
      </div>
    </Modal>
  )
}
