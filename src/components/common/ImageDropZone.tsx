/**
 * 图片拖拽上传 · React 接线（3.2.0）
 *
 * 用法（三步，不改动原有「点按钮选图」的任何一行）：
 *   1. `const drop = useImageDrop({ accept, onFile, disabled })`
 *   2. 把 `{...drop.dropProps}` 摊到**那块矩形区域**上（图 / 虚线框 / 画布容器）
 *   3. 区域内放 `{drop.dragging && <DropOverlay label="松开即可上传" />}`，容器加 `relative`
 *
 * 【三个必须这么写的点】
 *   · **只在带文件时 preventDefault**：章节树拖拽调序、正文拖动选区都不是文件，
 *     一律拦会把它们弄坏（判断在 `lib/media/imageDrop.hasFilePayload`）。
 *   · **进出计数**：`dragenter/dragleave` 在子元素上会反复触发（鼠标划过图片本身也算离开父容器），
 *     只用布尔量会出现"边框疯狂闪"。这里用 depth 计数，归零才算真的离开。
 *   · **drop 时 stopPropagation**：弹窗里的图片区嵌在整页容器里，不拦住会被外层再处理一次。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { showToast } from '@/components/dialogs/dialogs'
import { Z } from '@/lib/app/zLayer'
import { hasDroppedFilePayload, hasFilePayload, planImageDrop } from '@/lib/media/imageDrop'

export interface ImageDropOptions {
  /** 该处接受的图片格式（沿用各模块已有的 ACCEPT 常量，别另写一份） */
  accept: string
  /** 收到一张合格的图。通常是既有的 `pickXxx(file)` —— 校验 / 压缩 / 落库都由它负责 */
  onFile: (file: File) => void | Promise<void>
  /** 处理中 / 无可用目标（如没选地图）时置 true：仍然拦下浏览器默认行为，但不收文件 */
  disabled?: boolean
  /** 自定义拒绝提示；传 `null` 表示不出声（如看板娘弹窗自己有错误行） */
  onReject?: ((reason: string) => void) | null
}

export interface ImageDropApi {
  /** 是否正有文件悬停在这块区域上（用来加边框高亮 / 显示覆盖层） */
  dragging: boolean
  /** 摊到容器上：`<div {...drop.dropProps}>` */
  dropProps: {
    onDragEnter: (e: DragEvent<HTMLElement>) => void
    onDragOver: (e: DragEvent<HTMLElement>) => void
    onDragLeave: (e: DragEvent<HTMLElement>) => void
    onDrop: (e: DragEvent<HTMLElement>) => void
  }
}

export function useImageDrop(opts: ImageDropOptions): ImageDropApi {
  const { accept, onFile, disabled, onReject } = opts
  const [dragging, setDragging] = useState(false)
  // 进入层数（不是布尔）：子元素间的 enter/leave 会让布尔量抖动
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setDragging(false)
  }, [])

  /**
   * 兜底复位：拖拽在**窗口外**结束（拖出去松手、中途按 Esc、拖到系统托盘）时收不到 `dragleave`，
   * 覆盖层会一直挂着。`dragend` / 全局 `drop` 都要能把状态清干净 —— 宁可多清一次（幂等），
   * 也不要留一块"永远在闪的虚线框"让作者以为卡了。
   */
  useEffect(() => {
    const clear = () => reset()
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [reset])

  const onDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
    if (!hasFilePayload(e.dataTransfer?.types)) return
    e.preventDefault()
    depth.current += 1
    if (!disabled) setDragging(true)
  }, [disabled])

  const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    if (!hasFilePayload(e.dataTransfer?.types)) return
    // 🔴 不 preventDefault 就不会触发 drop（浏览器认为此区域不接收）
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback(() => {
    // 🔴 这里**不能**再用 `hasFilePayload` 过滤：实测（Chrome/Edge）`dragleave` 的
    //    `dataTransfer.types` 可能是**空数组**（尤其拖出窗口边界时）⇒ 按 types 判会把这次离开
    //    当成"与文件无关"直接 return，计数永不归零，覆盖层就卡在屏幕上不走。
    //    改看计数：既然进来时加过 1，离开时就得减 1；没进过（depth=0）说明是别的拖拽，忽略。
    if (depth.current === 0) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback((e: DragEvent<HTMLElement>) => {
    if (!hasDroppedFilePayload(e.dataTransfer?.types, e.dataTransfer?.files.length ?? 0)) return
    e.preventDefault()
    e.stopPropagation()
    reset()
    if (disabled) return

    const plan = planImageDrop(Array.from(e.dataTransfer?.files ?? []), accept)
    if (plan.kind === 'reject') {
      if (onReject === null) return
      const say = onReject ?? ((reason: string) => showToast(reason, 'error'))
      say(plan.reason)
      return
    }
    if (plan.extra > 0) {
      showToast(`一次只放一张，已用「${plan.file.name}」`, 'info')
    }
    // 出图函数可能 reject（读不出 / 超限 / 画布不可用）—— 交给它自己的 catch 报错，
    // 这里只兜住"没人接"的情况，避免变成未处理的 Promise 拒绝。
    void Promise.resolve(onFile(plan.file)).catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : '这张图没能读进来，换一张试试', 'error')
    })
  }, [accept, disabled, onFile, onReject, reset])

  return { dragging, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}

/**
 * 拖拽悬停时的覆盖层。放在 `relative` 容器里、`inset-0` 铺满。
 * `pointer-events-none` 是硬要求 —— 否则鼠标一进入覆盖层就触发父容器的 dragleave，
 * 覆盖层自己把自己"闪"没了（判定处已用计数兜住，但这里也别添乱）。
 */
export function DropOverlay({ label = '松开即可上传', radius = 'rounded-lg', compact = false }: {
  label?: string
  /** 与所在容器的圆角对齐（立绘格用 rounded-lg，卡片封面用 rounded-md） */
  radius?: string
  /**
   * 窄容器专用（88px 的封面位实测会把「松开即可用作封面」折成三行、盖住整块）：
   * 缩小字号与内边距，并强制不换行。文字本身也该换成短句（如「松开上传」）。
   */
  compact?: boolean
}): ReactNode {
  // 层号走 Z 真源（页内层，远低于弹窗/角标）：写裸 z-10 会与「页内层级统一收口」的约定冲突
  const style: CSSProperties = { zIndex: Z.pageHandle }
  return (
    <div
      className={`pointer-events-none absolute inset-0 flex items-center justify-center ${radius} border-2 border-dashed border-amber bg-amber/10`}
      style={style}
    >
      <span
        className={`whitespace-nowrap rounded-full bg-ink-900/90 font-medium text-amber shadow-lg ${
          compact ? 'px-1.5 py-0.5 text-10' : 'px-2.5 py-1 text-11'
        }`}
      >
        {label}
      </span>
    </div>
  )
}
