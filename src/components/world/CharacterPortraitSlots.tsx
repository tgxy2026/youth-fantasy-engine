/**
 * 角色立绘两格（3.2.0 从 `CharacterSheet` 拆出）
 *
 * 【为什么单独成文件】结构闸 ①：单文件不得超过 1200 行。加拖拽上传时 `CharacterSheet`
 * 已经顶到 1215 行 —— 与其删注释凑行数，不如把这块**自成一体**的 UI 挪出来：
 * 两格竖向排列 + 各自的上传/移除/体积显示，本来就不该和整张卡的表单逻辑挤在一起。
 *
 * 【拖拽口径】3.2.0 起每一格都是落点：图片直接拖进虚线框即上传。
 * 仍然复用父级的 `onPick`（＝ `updatePortrait`），压缩、体积上限、toast 全走同一条通路；
 * 拖拽只负责"把 File 交过去"。
 */
import { useRef } from 'react'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { Button } from '@/components/common/Button'
import { useImageDrop, DropOverlay } from '@/components/common/ImageDropZone'
import { dataUrlBytes, PORTRAIT_ACCEPT } from '@/lib/media/imagePortrait'
import { PORTRAIT_HINT_SPEC } from '@/lib/media/portraitSpec'

interface Props {
  /** 角色名（只用于 img 的 alt） */
  name: string
  portrait?: string
  portrait2?: string
  /** 处理中（压缩是异步的）—— 期间禁止再传，也禁止拖入 */
  busy: boolean
  compact?: boolean
  /** Empty chooser changes are ignored; removal is explicit via onRemove. */
  onPick: (file: File | null, slot: 1 | 2) => void
  onRemove: (slot: 1 | 2) => void
}

export default function CharacterPortraitSlots({ name, portrait, portrait2, busy, compact = false, onPick, onRemove }: Props) {
  const input1 = useRef<HTMLInputElement>(null)
  const input2 = useRef<HTMLInputElement>(null)
  // 🔴 必须两次独立调用（不能在 map 里调 —— 两个格子的 hook 数量会随渲染变化）
  const drop1 = useImageDrop({ accept: PORTRAIT_ACCEPT, disabled: busy, onFile: f => onPick(f, 1) })
  const drop2 = useImageDrop({ accept: PORTRAIT_ACCEPT, disabled: busy, onFile: f => onPick(f, 2) })

  return (
    <div className={`min-h-0 flex gap-3 ${compact ? 'flex-wrap' : 'flex-1 flex-col items-center'}`}>
      {([1, 2] as const).map(slot => {
        const src = slot === 2 ? portrait2 : portrait
        const drop = slot === 2 ? drop2 : drop1
        const input = slot === 2 ? input2 : input1
        return (
          <div key={slot} className={`min-h-0 flex flex-col items-center ${compact ? 'w-32' : 'flex-1 w-full'}`}>
            {/* Real button keeps upload available to keyboard users; drag/drop shares the same callback. */}
            <div
              {...drop.dropProps}
              className={`relative block min-h-0 self-center max-w-full rounded-lg border border-dashed overflow-hidden transition-colors ${compact ? 'h-24 w-full' : 'flex-1 w-full'} ${
                drop.dragging
                  ? 'border-amber bg-amber/5'
                  : busy ? 'border-ink-600 opacity-60' : 'border-ink-600 hover:border-amber/60'
              }`}
              style={compact ? undefined : { aspectRatio: '9 / 16' }}
              title={PORTRAIT_HINT_SPEC}
            >
              <input
                ref={input}
                type="file"
                accept={PORTRAIT_ACCEPT}
                className="hidden"
                disabled={busy}
                onChange={e => {
                  const f = e.target.files?.[0]
                  // Cancelling the picker must not erase an existing portrait.
                  if (f) onPick(f, slot)
                  e.currentTarget.value = ''   // 允许连续选同一张
                }}
              />
              {src ? (
                <img src={src} alt={`${name} 的立绘 ${slot}`} className="w-full h-full object-contain" />
              ) : (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-ink-500">
                  {busy ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
                  <span className="text-10">{busy ? '处理中…' : '点击或拖入图片'}</span>
                </span>
              )}
              <button type="button" className="absolute inset-0 cursor-pointer disabled:cursor-wait" aria-label={`${src ? '更换' : '上传'}立绘 ${slot}`} disabled={busy} onClick={() => input.current?.click()} />
              {drop.dragging && <DropOverlay label="松开即可放这里" />}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 w-full shrink-0">
              <span className="text-10 text-ink-500 tabular-nums">
                {src ? `${Math.round(dataUrlBytes(src) / 1024)}KB` : `立绘 ${slot}`}
              </span>
              {src && (
                <Button
                  variant="icon-danger" iconOnly size="xs"
                  title={`移除立绘 ${slot}`} aria-label={`移除立绘 ${slot}`}
                  className="ml-auto shrink-0"
                  disabled={busy}
                  onClick={() => onRemove(slot)}
                >
                  <X size={11} />
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
